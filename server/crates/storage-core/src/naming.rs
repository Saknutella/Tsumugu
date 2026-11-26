//! Human-readable folder names for post categories (`creations/…`, `videos/…`).
//!
//! WHY this lives in `storage-core` and not next to the host code: two writers
//! need the exact same rule. The v8 post importer (host) names the folder it
//! stores in `post.root_path`, and the older creation tables
//! (`creation_post`/`creation_asset`) now put their attachments into the same
//! source tree. If each kept its own sanitiser, a title with `:` would land in
//! `a_b` on one path and `a?b` (refused) on the other, and the two folder
//! conventions would drift apart.
//!
//! The rule itself is deliberately one function: every segment must be a fixed
//! point of [`segment`], which is what makes [`validated_post_root`] able to
//! recognise "a folder this host named" from a stored path.

use crate::error::{Error, Result};
use crate::paths;

/// Characters Windows refuses in a path segment, plus the separators.
///
/// Replacing rather than rejecting keeps a post importable: a title with `?` or
/// a creator whose name contains `/` must still land somewhere, and the `[id]`
/// suffix keeps the folder unique after the substitution.
pub fn segment(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if (ch as u32) < 0x20 => '_',
            ch => ch,
        })
        .collect();
    // Win32 strips *every* trailing dot and space, so `"x. "` must lose both,
    // not just the last one; and the trim repeats after truncation because a
    // cut can expose a new trailing space. Repeating it makes `segment` a fixed
    // point (`segment(segment(x)) == segment(x)`), which is exactly what
    // [`validated_post_root`] checks a stored folder against.
    let trimmed = trim_tail(cleaned.trim_start());
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let reserved_safe = reject_reserved(trimmed);
    // Windows caps a component at 255 UTF-16 units, and a readable folder plus
    // the `[id]` suffix must still fit under MAX_PATH. 200 characters keeps both
    // without splitting a multi-byte scalar.
    let truncated: String = reserved_safe.chars().take(MAX_SEGMENT_CHARS).collect();
    let truncated = trim_tail(&truncated);
    if truncated.is_empty() {
        fallback.to_string()
    } else {
        truncated.to_string()
    }
}

/// Strip trailing whitespace and dots until neither is left.
fn trim_tail(value: &str) -> &str {
    let mut rest = value.trim_end();
    while let Some(stripped) = rest.strip_suffix('.') {
        rest = stripped.trim_end();
    }
    rest
}

/// Longest component this module writes; see [`segment`].
pub const MAX_SEGMENT_CHARS: usize = 200;

/// Dash a Windows device name instead of refusing the post.
///
/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` cannot be a file name
/// on Windows at all (`NUL.txt` included), so a creator literally called `nul`
/// has to land under a different but recognisable name rather than fail the
/// import.
fn reject_reserved(value: &str) -> String {
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = value.split('.').next().unwrap_or(value);
    if RESERVED.iter().any(|reserved| stem.eq_ignore_ascii_case(reserved)) {
        format!("_{value}")
    } else {
        value.to_string()
    }
}

/// `<categoryRoot>/<Provider>/<creator>/<YYYY-MM-DD> <title> [<id>]`
///
/// Order is `date title [id]` so a plain directory listing sorts chronologically,
/// and the id suffix is what makes two posts with the same title distinct.
pub fn post_folder(
    category_root: &str,
    provider: &str,
    creator: &str,
    date: &str,
    title: &str,
    source_id: &str,
) -> String {
    // Take characters, not bytes: a malformed date must not panic on a
    // multi-byte boundary. Anything shorter than a full day is unusable, so it
    // becomes an obvious sentinel that sorts first instead of a guessed date.
    let date: String = if date.chars().count() >= 10 {
        segment(&date.chars().take(10).collect::<String>(), "0000-00-00")
    } else {
        "0000-00-00".to_string()
    };
    // The leaf is one path component, so it has to fit the same 200-character
    // cap as every other segment or `validated_post_root` would refuse the
    // folder this function just named. The id is what keeps the folder unique,
    // so it is kept whole (up to 64 chars) and the title absorbs the cut.
    let id: String = segment(source_id, "unknown").chars().take(64).collect();
    let id = trim_tail(&id);
    let id = if id.is_empty() { "unknown".to_string() } else { id.to_string() };
    let title_budget = MAX_SEGMENT_CHARS.saturating_sub(date.chars().count() + id.chars().count() + 4);
    let title: String = segment(title, &id).chars().take(title_budget).collect();
    let title = trim_tail(&title);
    let title = if title.is_empty() { id.as_str() } else { title };
    format!(
        "{}/{}/{}/{} {} [{}]",
        category_root,
        segment(provider, "Unknown"),
        segment(creator, "Unknown"),
        date,
        title,
        id
    )
}

pub const CATEGORY_CREATION: &str = "creations";
pub const CATEGORY_VIDEO: &str = "videos";

/// Root directory for a post category, relative to the source root.
///
/// Returns a `&'static str` on purpose: the caller stores it in `project.json`
///-style records and must not be able to invent a third top-level category.
pub fn category_root(category: &str) -> Result<&'static str> {
    match category {
        "creation" => Ok(CATEGORY_CREATION),
        "video" => Ok(CATEGORY_VIDEO),
        _ => Err(Error::bad_request("category must be creation or video")),
    }
}

/// The folder of a stored post, re-derived from its own `category`/`root_path`.
///
/// Trusting `root_path` because "we wrote it" is what C1 exploited: the column
/// can hold `''`, `'.'`, another post's folder or another category's folder (the
/// old `import_post` stored whatever the client sent), and `delete_post` turns
/// the result into `remove_dir_all`. Re-deriving means the only accepted shape
/// is `<Category>/<Provider>/<Creator>/<Folder>`, every segment exactly what our
/// own [`segment`] would produce, under the root of the row's own category.
pub fn validated_post_root(category: &str, root_path: &str) -> Result<String> {
    let expected_root = category_root(category)?;
    // `/` only: `\` separators are refused by `validate_component` below, so a
    // Windows-style stored path fails loudly instead of being silently rewritten
    // into a different folder.
    let parts: Vec<&str> = root_path.split('/').collect();
    if parts.len() != 4 {
        return Err(Error::path_denied(format!(
            "post folder must be <Category>/<Provider>/<Creator>/<Folder>: {root_path}"
        )));
    }
    if parts[0] != expected_root {
        return Err(Error::path_denied(format!(
            "post folder is not under {expected_root}/: {root_path}"
        )));
    }
    for part in &parts {
        validate_segment(part)?;
    }
    Ok(root_path.to_string())
}

fn validate_segment(part: &str) -> Result<()> {
    if part.is_empty() || part == "." || part == ".." {
        return Err(Error::path_denied("post folder has an empty or dot segment"));
    }
    // Every segment must be a fixed point of our own naming function: that is
    // the precise statement of "this folder was named by the host", and it
    // rejects `\`, `:`, trailing dots/spaces and device names in one rule.
    if segment(part, "") != part {
        return Err(Error::path_denied(format!("post folder segment is not a host-named segment: {part}")));
    }
    // `validate_component` on top: it owns the Windows rules (ADS, reserved
    // names, length) for the audio side too, so post folders cannot drift from
    // them. Its error is uncoded, so the code is set here.
    paths::validate_component(part).map_err(|error| Error::path_denied(error.message))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The naming rule itself, stated once: readable, unique and confined.
    #[test]
    fn folder_name_is_readable_and_stable() {
        assert_eq!(
            post_folder("creations", "Patreon", "Some Creator", "2026-02-10", "5$ ✨", "150409075"),
            "creations/Patreon/Some Creator/2026-02-10 5$ ✨ [150409075]"
        );
        // Path separators and Windows-illegal characters must not escape the tree.
        assert_eq!(
            post_folder("videos", "YouTube", "a/b", "", "x:y?z", "abc"),
            "videos/YouTube/a_b/0000-00-00 x_y_z [abc]"
        );
        // The leaf is capped so the whole folder stays a legal component; the id
        // is kept whole because it is what makes two posts distinct.
        let long = "x".repeat(400);
        let name = post_folder("creations", "p", "c", "2026-02-10", &long, "42");
        let leaf = name.rsplit('/').next().unwrap();
        assert!(leaf.chars().count() <= MAX_SEGMENT_CHARS, "{leaf}");
        assert!(leaf.ends_with("[42]"), "{leaf}");
    }

    #[test]
    fn validated_post_root_accepts_only_host_named_folders() {
        assert!(validated_post_root("creation", "creations/Patreon/C/2026-02-10 t [1]").is_ok());
        for bad in [
            "",
            ".",
            "creations",
            "creations/Patreon/C",
            "videos/Patreon/C/2026-02-10 t [1]",
            "creations//C/2026-02-10 t [1]",
            "creations/Patreon/C/../../x [1]",
            "creations/Patreon/C/nul",
            "creations/Patreon/C/trailing.",
        ] {
            assert!(validated_post_root("creation", bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn segment_is_a_fixed_point() {
        assert_eq!(segment("name...  .", "f"), "name");
        assert_eq!(segment(". . .", "f"), "f");
        assert_eq!(segment("CON", "f"), "_CON");
        assert_eq!(segment("nul.txt", "f"), "_nul.txt");
        assert_eq!(segment("com9", "f"), "_com9");
        assert_eq!(segment("console", "f"), "console");
        let long = "界".repeat(MAX_SEGMENT_CHARS + 30);
        assert_eq!(segment(&long, "f").chars().count(), MAX_SEGMENT_CHARS);
        let long_ascii = "x".repeat(MAX_SEGMENT_CHARS + 30);
        assert_eq!(segment(&long_ascii, "f").chars().count(), MAX_SEGMENT_CHARS);
    }
}
