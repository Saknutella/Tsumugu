//! Path confinement and logical-path validation (`paths.mjs`).
//!
//! Why a hand-written `is_inside` instead of `canonicalize` + `starts_with`:
//! the Node implementation uses `path.relative()`, which on Windows compares
//! case-insensitively and normalises separators. A byte-prefix comparison would
//! reject `C:\Data\Work` when the root is recorded as `c:\data\`, and
//! `canonicalize()` would fail on paths that do not exist yet (upload targets,
//! rename destinations). So this module reproduces `path.relative()`'s lexical
//! semantics deliberately, and never touches the filesystem.
//!
//! Security note: confinement is lexical. Reparse-point (symlink/junction)
//! rejection is a separate, explicit step (`assert_no_reparse`) because it must
//! be able to fail on missing components without opening a gap.

use std::path::{Component, Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

use crate::error::{Error, Result};

/// Component names Windows refuses as file names.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Characters Windows forbids in a path component (`INVALID_COMPONENT_CHARS`).
fn has_invalid_component_char(component: &str) -> bool {
    component.chars().any(|ch| {
        matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (ch as u32) < 0x20
    })
}

/// Normalise a path for lexical comparison the way `path.resolve()` would.
///
/// `path.resolve()` makes the path absolute against the cwd and collapses `.`/`..`.
/// Callers always pass absolute inputs, so only the collapsing is needed. Keeping
/// this pure (no cwd lookup) makes the behaviour testable and deterministic.
pub fn resolve_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` above the root is clamped, like path.resolve().
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// Path components, used for the case-insensitive Windows comparison.
fn components_lower(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().to_lowercase()),
            Component::RootDir => Some(std::path::MAIN_SEPARATOR.to_string()),
            Component::Normal(part) => Some(part.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect()
}

/// True when `child` is `parent` itself or lies beneath it.
///
/// Mirrors `paths.mjs::isInside` and `media.mjs::isInside`:
/// `rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))`.
pub fn is_inside(parent: &Path, child: &Path) -> bool {
    let parent = resolve_lexical(parent);
    let child = resolve_lexical(child);
    let parent_parts = components_lower(&parent);
    let child_parts = components_lower(&child);
    if parent_parts.len() > child_parts.len() {
        return false;
    }
    parent_parts == child_parts[..parent_parts.len()]
}

/// `path.relative(base, target)` with forward slashes.
///
/// Node's `relative()` returns `''` for equal paths; the storage host relies on
/// that (e.g. `redactPath` maps the source root itself to `'.'`).
pub fn relative_slash(base: &Path, target: &Path) -> String {
    let base = resolve_lexical(base);
    let target = resolve_lexical(target);
    let base_parts = components_lower(&base);
    let target_parts = components_lower(&target);
    let common = base_parts
        .iter()
        .zip(target_parts.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<String> = Vec::new();
    for _ in common..base_parts.len() {
        parts.push("..".to_string());
    }
    // Preserve the target's original casing, not the lowercased comparison copy.
    let original: Vec<String> = target
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let cut = original.len().saturating_sub(target_parts.len() - common);
    parts.extend(original[cut..].iter().cloned());
    parts.join("/")
}

/// Validate one logical-path component (`validateComponent`).
///
/// Rejects the shapes that would let a logical path address a file outside the
/// work root on Windows: reserved device names, alternate data streams (`:`),
/// trailing dots/spaces (silently stripped by Win32, which enables alias tricks),
/// control characters, and over-long names.
pub fn validate_component(component: &str) -> Result<String> {
    if component.is_empty() {
        return Err(Error::new("empty path component"));
    }
    if component == "." || component == ".." {
        return Err(Error::new("dot path component"));
    }
    if has_invalid_component_char(component) {
        return Err(Error::new(format!("invalid path character: {component}")));
    }
    if component.ends_with('.') || component.ends_with(' ') {
        return Err(Error::new(format!("trailing dot/space: {component}")));
    }
    let stem = component.split('.').next().unwrap_or(component);
    if WINDOWS_RESERVED.iter().any(|reserved| stem.eq_ignore_ascii_case(reserved)) {
        return Err(Error::new(format!("reserved Windows name: {component}")));
    }
    if component.chars().count() > 200 {
        return Err(Error::new(format!("path component too long: {}", component.chars().count())));
    }
    // NFC: the Node version normalises so the same name written in decomposed
    // form on macOS cannot create a second entry for identical content.
    let normalized: String = component.nfc().collect();
    if normalized.chars().count() > 200 {
        return Err(Error::new("NFC path component too long"));
    }
    Ok(normalized)
}

/// Validate a full logical path and return it with `/` separators and NFC names.
pub fn validate_logical_path(value: &str) -> Result<String> {
    if value.trim().is_empty() {
        return Err(Error::new("logical path is empty"));
    }
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(Error::new("absolute/drive/UNC logical path is not allowed"));
    }
    if value.starts_with("\\\\") || value.starts_with("//") {
        return Err(Error::new("absolute/drive/UNC logical path is not allowed"));
    }
    if value.starts_with('/') || value.starts_with('\\') {
        return Err(Error::new("absolute logical path is not allowed"));
    }
    if value.chars().any(|ch| (ch as u32) < 0x20) {
        return Err(Error::new("control character in logical path"));
    }
    if value.contains(':') {
        return Err(Error::new("colon/ADS is not allowed"));
    }
    let normalized = value.replace('\\', "/");
    let mut parts = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() {
            return Err(Error::new("empty logical path segment"));
        }
        parts.push(validate_component(segment)?);
    }
    Ok(parts.join("/"))
}

/// `path.join(base, ...logical.split('/'))` after validation.
pub fn logical_to_path(base: &Path, logical_path: &str) -> Result<PathBuf> {
    let validated = validate_logical_path(logical_path)?;
    let mut path = base.to_path_buf();
    for part in validated.split('/') {
        path.push(part);
    }
    Ok(path)
}

/// Convert a native path to the `/`-separated form used in logical paths and JSON.
pub fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Replace backslashes with `/`; used for the many Node `.replaceAll('\\','/')` calls.
pub fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

/// Reject symlink/reparse components up to `path`.
///
/// `allow_missing` mirrors the Node behaviour where a not-yet-created upload
/// target is acceptable: an `ENOENT` on any component stops the walk instead of
/// failing, because a missing component cannot be a reparse point.
pub fn assert_no_reparse(path: &Path, allow_missing: bool) -> Result<()> {
    let mut current = PathBuf::new();
    for component in resolve_lexical(path).components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(Component::RootDir.as_os_str()),
            _ => current.push(component.as_os_str()),
        }
        match std::fs::symlink_metadata(&current) {
            Ok(info) => {
                if info.file_type().is_symlink() {
                    return Err(Error::new(format!("reparse point in path: {}", current.display())));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => return Ok(()),
            Err(error) => return Err(Error::from(error)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn inside_is_case_insensitive_on_windows_like_node_relative() {
        // path.relative() on win32 compares case-insensitively; a client that
        // sends `c:\data` for a root recorded as `C:\Data` must not slip past.
        let parent = win(r"N:\DataRoot");
        assert!(is_inside(&parent, &win(r"n:\dataroot\work\a.mp3")));
        assert!(is_inside(&parent, &win(r"N:\DataRoot")));
        assert!(!is_inside(&parent, &win(r"N:\DataRootX\a.mp3")));
        assert!(!is_inside(&parent, &win(r"N:\Other\a.mp3")));
    }

    #[test]
    fn parent_dir_cannot_escape() {
        let parent = win(r"N:\DataRoot");
        assert!(!is_inside(&parent, &win(r"N:\DataRoot\..\Secrets\a")));
    }

    #[test]
    fn relative_matches_node_shapes() {
        let base = win(r"N:\root");
        assert_eq!(relative_slash(&base, &win(r"N:\root")), "");
        assert_eq!(relative_slash(&base, &win(r"N:\root\a\b.mp3")), "a/b.mp3");
        assert_eq!(relative_slash(&win(r"N:\root\deep"), &win(r"N:\root\a")), "../a");
    }

    #[test]
    fn logical_path_rejects_windows_escapes() {
        assert!(validate_logical_path("../escape.mp3").is_err());
        assert!(validate_logical_path("C:/abs.mp3").is_err());
        assert!(validate_logical_path("//server/share.mp3").is_err());
        assert!(validate_logical_path("a/ads:stream").is_err());
        assert!(validate_logical_path("aux.mp3").is_err());
        assert!(validate_logical_path("trailing.").is_err());
        assert_eq!(validate_logical_path(r"mp3\01.mp3").unwrap(), "mp3/01.mp3");
    }

    #[test]
    fn logical_path_allows_rj_folder_names() {
        // docs/16 §12.2: `[RJ...]` is a legal directory name and must not be
        // mistaken for a wildcard or an escape.
        assert_eq!(
            validate_logical_path("[RJ01678051] [Circle] title (CV A)/mp3/01.mp3").unwrap(),
            "[RJ01678051] [Circle] title (CV A)/mp3/01.mp3"
        );
    }
}
