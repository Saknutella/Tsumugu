//! Self-contained, real-file work export (port of `export.mjs`, S6).
//!
//! Layout (Node's, byte-compatible manifest keys):
//!   `<parent>/<friendly-name>/monochrome/{manifest.json,COMPLETE,cover.ext}`
//!   `<parent>/<friendly-name>/content/<original logical tree>`
//! Always a copy, never a hardlink/symlink into CAS. Built in a temp dir and
//! renamed into place, so a crash never leaves a half export under the final name.
//!
//! Deviation D15 (same root cause as D14): a source-only asset's `relPath` is
//! the virtual `source/<sha256>`, so Node copied `data/source/<sha>`, hit ENOENT
//! and could not export *any* work of a source-only library. Here such an asset
//! is read from the entry's `originalPath` (the user's file) and still verified
//! against the recorded sha256/bytes before it is published.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::error::{Error, Result};
use crate::fsutil::{atomic_write, ensure_dir, path_exists, read_json};
use crate::hash::{copy_to_temp_and_hash, hash_file, sha256_text};
use crate::jsonutil::now_iso;
use crate::library::Library;
use crate::paths;

pub const EXPORT_FORMAT: &str = "monochrome-storage-lab-export";
pub const EXPORT_FORMAT_VERSION: i64 = 1;

fn mime_extension(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "audio/mpeg" => ".mp3",
        "audio/wav" => ".wav",
        "audio/flac" => ".flac",
        "audio/mp4" => ".m4a",
        "audio/aac" => ".aac",
        "audio/ogg" => ".ogg",
        "audio/opus" => ".opus",
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "text/vtt" => ".vtt",
        "application/x-subrip" => ".srt",
        "text/x-ssa" => ".ass",
        "application/zip" => ".zip",
        _ => return None,
    })
}

/// Windows-safe single path component (`cleanComponent`).
pub fn clean_component(name: &str) -> String {
    let normalized: String = name.nfkc().collect();
    let replaced: String = normalized
        .chars()
        .map(|ch| if (ch as u32) < 0x20 || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { ch })
        .collect();
    let mut value = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    value = value.trim_matches(|ch| ch == '.' || ch == ' ').to_string();
    if value.is_empty() {
        value = "untitled".to_string();
    }
    let stem = value.split('.').next().unwrap_or("").to_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        value = format!("_{value}");
    }
    if value.chars().count() > 180 {
        // JS `slice(0, 180)` counts UTF-16 code units; for the BMP text these
        // names are made of, chars and code units coincide.
        value = value.chars().take(180).collect::<String>();
        value = value.trim_end_matches(|ch| ch == '.' || ch == ' ').to_string();
    }
    value
}

fn source_code_of(work: &Value) -> Option<String> {
    let refs = work["sourceRefs"].as_array().cloned().unwrap_or_default();
    for source in &refs {
        if let Some(code) = source["sourceCode"].as_str().and_then(word_rj) {
            return Some(code);
        }
    }
    refs.iter()
        .filter_map(|source| source["sourceCode"].as_str())
        .find(|code| !code.is_empty())
        .map(str::to_uppercase)
}

/// `\bRJ\d{5,8}\b`, case-insensitive.
fn word_rj(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut index = 0;
    while index + 2 <= bytes.len() {
        let left_ok = index == 0 || !word(bytes[index - 1]);
        if left_ok && bytes[index].eq_ignore_ascii_case(&b'r') && bytes.get(index + 1).map(|b| b.eq_ignore_ascii_case(&b'j')).unwrap_or(false) {
            let digits = bytes[index + 2..].iter().take_while(|byte| byte.is_ascii_digit()).count();
            let end = index + 2 + digits;
            if (5..=8).contains(&digits) && (end == bytes.len() || !word(bytes[end])) {
                return Some(format!("RJ{}", &text[index + 2..end]));
            }
        }
        index += 1;
    }
    None
}

/// `[RJ…][circle] title (cv, cv)` (`autoFriendlyName`).
pub fn auto_friendly_name(work: &Value) -> String {
    let head = source_code_of(work).map(|code| format!("[{code}]")).unwrap_or_else(|| "[Local]".to_string());
    let title = work["userTitle"].as_str().filter(|v| !v.is_empty()).or_else(|| work["title"].as_str().filter(|v| !v.is_empty())).unwrap_or("Untitled");
    let circle = work["circle"].as_str().filter(|v| !v.is_empty()).map(|c| format!("[{c}]")).unwrap_or_default();
    let cvs: Vec<&str> = work["cvs"].as_array().map(|items| items.iter().filter_map(Value::as_str).filter(|v| !v.is_empty()).collect()).unwrap_or_default();
    let cv_part = if cvs.is_empty() { String::new() } else { format!(" ({})", cvs.join(", ")) };
    clean_component(&format!("{head}{circle} {title}{cv_part}"))
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(index) if index > 0 => name[..index].to_string(),
        _ => name.to_string(),
    }
}

fn cover_entry_of(work: &Value) -> Option<&Value> {
    let entries = work["entries"].as_array()?;
    entries.iter().find(|entry| entry["kind"].as_str().map(|k| k.eq_ignore_ascii_case("cover")).unwrap_or(false)).or_else(|| {
        entries.iter().find(|entry| {
            entry["kind"].as_str().map(|k| k.eq_ignore_ascii_case("image")).unwrap_or(false)
                && matches!(stem(entry["logicalPath"].as_str().unwrap_or("")).to_lowercase().as_str(), "cover" | "folder" | "front" | "jacket" | "package")
        })
    })
}

fn entry_asset(entry: &Value) -> Option<&Value> {
    let assets = entry["assets"].as_array()?;
    assets
        .iter()
        .find(|asset| asset["role"].as_str().unwrap_or("primary") == "primary")
        .or_else(|| assets.first())
}

/// Where an asset's bytes live: CAS under `data/`, or the entry's source file.
fn asset_source_path(library: &Library, entry: &Value, asset: &Value) -> Result<PathBuf> {
    let rel = asset["relPath"].as_str().unwrap_or("").replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|part| part == "..") {
        return Err(Error::new(format!("invalid asset relPath: {rel}")));
    }
    if rel.starts_with("source/") {
        let original = entry["originalPath"].as_str().filter(|value| !value.is_empty());
        let original = original.ok_or_else(|| Error::coded("EEXPORTNOASSET", format!("source-only entry has no original path: {rel}")))?;
        return Ok(PathBuf::from(original));
    }
    Ok(rel.split('/').fold(library.data_root.clone(), |path, part| path.join(part)))
}

fn regular_file(path: &Path) -> Result<std::fs::Metadata> {
    let info = std::fs::symlink_metadata(path)?;
    if info.file_type().is_symlink() {
        return Err(Error::new(format!("{} is a symlink/junction", path.display())));
    }
    if !info.is_file() {
        return Err(Error::new(format!("{} is not a regular file", path.display())));
    }
    Ok(info)
}

fn copy_asset(source: &Path, asset: &Value, target: &Path) -> Result<(String, u64)> {
    paths::assert_no_reparse(source, false)?;
    regular_file(source)?;
    let mut temp = target.as_os_str().to_os_string();
    temp.push(format!(".{}.{}.part", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
    let temp = PathBuf::from(temp);
    let (sha256, bytes) = copy_to_temp_and_hash(source, &temp, false, None)?;
    if Some(sha256.as_str()) != asset["sha256"].as_str() || Some(bytes) != asset["bytes"].as_u64() {
        let _ = std::fs::remove_file(&temp);
        return Err(Error::new(format!(
            "export asset failed hash/size verification: {}",
            asset["relPath"].as_str().unwrap_or("")
        )));
    }
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    std::fs::rename(&temp, target)?;
    Ok((sha256, bytes))
}

impl Library {
    /// Export one work below `destination` (`exportWork`). Name collisions fail.
    pub fn export_work(&self, work_id: &str, destination: &Path, friendly_name: Option<&str>) -> Result<Value> {
        self.assert_open()?;
        let parent = paths::resolve_lexical(destination);
        paths::assert_no_reparse(&parent, true)?;
        if parent == paths::resolve_lexical(&self.root) || paths::is_inside(&self.data_root, &parent) {
            return Err(Error::coded("EEXPORTDEST", "export destination must not overlap the library root/data"));
        }
        let work = self.get_work(work_id, false)?.ok_or_else(|| Error::new(format!("work not found: {work_id}")))?;
        let name = match friendly_name.filter(|name| !name.is_empty() && *name != "auto") {
            Some(name) => clean_component(name),
            None => auto_friendly_name(&work),
        };
        if name.is_empty() {
            return Err(Error::new("friendlyName is empty after sanitization"));
        }
        let export_dir = parent.join(&name);
        if path_exists(&export_dir) {
            return Err(Error::coded("EEXPORTEXISTS", format!("export destination already exists: {}", export_dir.display())));
        }
        ensure_dir(&parent)?;
        let temp_dir = parent.join(format!(".{name}.tmp-{}-{}", std::process::id(), chrono::Utc::now().timestamp_millis()));
        std::fs::create_dir(&temp_dir)?;
        let outcome = (|| -> Result<Value> {
            let monochrome = temp_dir.join("monochrome");
            let content = temp_dir.join("content");
            std::fs::create_dir_all(&monochrome)?;
            std::fs::create_dir_all(&content)?;
            let mut files = Vec::new();
            let mut used = Vec::new();
            for entry in work["entries"].as_array().into_iter().flatten() {
                let logical = paths::validate_logical_path(entry["logicalPath"].as_str().unwrap_or(""))?.replace('\\', "/");
                if used.contains(&logical) {
                    return Err(Error::new(format!("duplicate logical path: {logical}")));
                }
                used.push(logical.clone());
                let asset = entry_asset(entry).ok_or_else(|| {
                    Error::coded("EEXPORTNOASSET", format!("entry has no managed asset and cannot be a self-contained export: {logical}"))
                })?;
                let target = logical.split('/').fold(content.clone(), |path, part| path.join(part));
                let (sha256, bytes) = copy_asset(&asset_source_path(self, entry, asset)?, asset, &target)?;
                files.push(json!({
                    "logicalPath": logical,
                    "path": format!("content/{logical}"),
                    "sha256": sha256,
                    "bytes": bytes,
                    "kind": entry["kind"],
                    "mime": asset["mime"].as_str().filter(|v| !v.is_empty()).or_else(|| entry["mime"].as_str().filter(|v| !v.is_empty())).unwrap_or("application/octet-stream"),
                }));
            }
            let cover = match cover_entry_of(&work) {
                Some(entry) => {
                    let asset = entry_asset(entry)
                        .ok_or_else(|| Error::new(format!("cover entry has no managed asset: {}", entry["logicalPath"].as_str().unwrap_or(""))))?;
                    let mime = asset["mime"].as_str().unwrap_or("").to_lowercase();
                    let extension = mime_extension(&mime).map(str::to_string).unwrap_or_else(|| {
                        let logical = entry["logicalPath"].as_str().unwrap_or("");
                        let name = logical.rsplit('/').next().unwrap_or(logical);
                        match name.rfind('.') {
                            Some(index) if index > 0 => name[index..].to_lowercase(),
                            _ => ".bin".to_string(),
                        }
                    });
                    let cover_path = format!("monochrome/cover{extension}");
                    let (sha256, bytes) = copy_asset(&asset_source_path(self, entry, asset)?, asset, &monochrome.join(format!("cover{extension}")))?;
                    json!({
                        "logicalPath": entry["logicalPath"],
                        "path": cover_path,
                        "sha256": sha256,
                        "bytes": bytes,
                        "mime": asset["mime"].as_str().filter(|v| !v.is_empty()).unwrap_or("application/octet-stream"),
                        "format": extension.trim_start_matches('.'),
                    })
                }
                None => Value::Null,
            };
            let total: u64 = files.iter().filter_map(|file| file["bytes"].as_u64()).sum();
            let manifest = json!({
                "format": EXPORT_FORMAT,
                "formatVersion": EXPORT_FORMAT_VERSION,
                "libraryId": self.library_id,
                "workId": work["workId"],
                "revision": work["revision"],
                "friendlyName": name,
                "createdAt": now_iso(),
                "completedAt": now_iso(),
                "work": {
                    "title": work["title"],
                    "userTitle": work["userTitle"],
                    "circle": work["circle"],
                    "cvs": work["cvs"],
                    "language": work["language"],
                    "role": work["role"],
                },
                "sourceRefs": work["sourceRefs"].as_array().map(|refs| refs.iter().map(|source| json!({
                    "provider": source["provider"],
                    "sourceCode": source["sourceCode"],
                    "sourceUrl": source["sourceUrl"],
                })).collect::<Vec<_>>()).unwrap_or_default(),
                "files": files,
                "cover": cover,
                "counts": { "files": files.len(), "assets": files.len(), "totalBytes": total },
            });
            let mut text = serde_json::to_string_pretty(&manifest)?;
            text.push('\n');
            atomic_write(&monochrome.join("manifest.json"), text.as_bytes())?;
            let marker = json!({ "manifestSha256": sha256_text(&text), "completedAt": now_iso(), "format": EXPORT_FORMAT });
            let mut marker_text = serde_json::to_string_pretty(&marker)?;
            marker_text.push('\n');
            atomic_write(&monochrome.join("COMPLETE"), marker_text.as_bytes())?;
            Ok(manifest)
        })();
        match outcome {
            Ok(manifest) => {
                std::fs::rename(&temp_dir, &export_dir)?;
                let dir = export_dir.to_string_lossy().to_string();
                Ok(json!({
                    "dir": dir, "exportDir": dir, "path": dir, "exportPath": dir,
                    "friendlyName": name, "manifest": manifest, "complete": true,
                }))
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temp_dir);
                Err(error)
            }
        }
    }
}

fn issue(issues: &mut Vec<Value>, code: &str, detail: Value) {
    issues.push(json!({ "code": code, "detail": detail }));
}

fn collect_files(root: &Path, directory: &Path, out: &mut Vec<(String, bool)>) {
    let Ok(children) = std::fs::read_dir(directory) else { return };
    for child in children.flatten() {
        let path = child.path();
        let relative = paths::relative_slash(root, &path);
        match std::fs::symlink_metadata(&path) {
            Ok(info) if info.file_type().is_symlink() => out.push((relative, true)),
            Ok(info) if info.is_dir() => collect_files(root, &path, out),
            Ok(_) => out.push((relative, false)),
            Err(_) => out.push((relative, false)),
        }
    }
}

/// Verify a self-contained export without touching its library (`verifyExport`).
pub fn verify_export(export_dir: &Path) -> Value {
    let dir = paths::resolve_lexical(export_dir);
    let mut issues = Vec::new();
    let manifest_path = dir.join("monochrome").join("manifest.json");
    let Some(manifest) = read_json(&manifest_path, None) else {
        return json!({ "ok": false, "dir": dir.to_string_lossy(), "issues": [{ "code": "manifest-missing", "detail": manifest_path.to_string_lossy() }], "manifest": Value::Null });
    };
    if manifest["format"] != EXPORT_FORMAT {
        issue(&mut issues, "manifest-format", manifest["format"].clone());
    }
    if manifest["formatVersion"].as_f64() != Some(EXPORT_FORMAT_VERSION as f64) {
        issue(&mut issues, "manifest-version", manifest["formatVersion"].clone());
    }
    if manifest["libraryId"].as_str().map(str::is_empty).unwrap_or(true) {
        issue(&mut issues, "manifest-library-id", json!("libraryId missing"));
    }
    if manifest["workId"].as_str().map(str::is_empty).unwrap_or(true) {
        issue(&mut issues, "manifest-work-id", json!("workId missing"));
    }
    let complete = dir.join("monochrome").join("COMPLETE");
    if !path_exists(&complete) {
        issue(&mut issues, "missing-complete", json!("COMPLETE marker missing"));
    } else {
        let marker = std::fs::read_to_string(&complete).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let raw = std::fs::read_to_string(&manifest_path).unwrap_or_default();
        match marker {
            Some(marker) if marker["manifestSha256"] == sha256_text(&raw) => {}
            Some(_) => issue(&mut issues, "complete-manifest-hash", json!("COMPLETE does not match manifest.json")),
            None => issue(&mut issues, "complete-unreadable", json!("COMPLETE is not valid JSON")),
        }
    }
    let check = |issues: &mut Vec<Value>, rel: &str, sha: &Value, bytes: &Value, prefix: &str| {
        let path = rel.split('/').fold(dir.clone(), |path, part| path.join(part));
        match paths::assert_no_reparse(&path, false).and_then(|_| regular_file(&path)).and_then(|info| Ok((info.len(), hash_file(&path)?.0))) {
            Ok((size, hashed)) => {
                if Some(size) != bytes.as_u64() || sha != &json!(hashed) {
                    issue(issues, &format!("{prefix}-hash-mismatch"), json!(rel));
                }
            }
            Err(error) => issue(issues, &format!("{prefix}-unreadable"), json!({ "path": rel, "error": error.message })),
        }
    };
    let mut expected = vec!["monochrome/manifest.json".to_string(), "monochrome/COMPLETE".to_string()];
    for file in manifest["files"].as_array().into_iter().flatten() {
        let rel = file["path"].as_str().unwrap_or("").replace('\\', "/");
        if !rel.starts_with("content/") || rel.contains("/../") || rel.starts_with("../") {
            issue(&mut issues, "file-path", file["path"].clone());
            continue;
        }
        check(&mut issues, &rel, &file["sha256"], &file["bytes"], "file");
        expected.push(rel);
    }
    if manifest["cover"].is_object() {
        let rel = manifest["cover"]["path"].as_str().unwrap_or("").replace('\\', "/");
        if !rel.starts_with("monochrome/") {
            issue(&mut issues, "cover-path", manifest["cover"]["path"].clone());
        } else {
            check(&mut issues, &rel, &manifest["cover"]["sha256"], &manifest["cover"]["bytes"], "cover");
            expected.push(rel);
        }
    }
    // The manifest is the truth: walk the real tree so an unlisted file cannot hide.
    let mut actual = Vec::new();
    collect_files(&dir, &dir, &mut actual);
    actual.sort();
    for (rel, symlink) in actual {
        if !expected.contains(&rel) {
            issue(&mut issues, "extra-file", json!({ "path": rel, "reason": if symlink { "symlink-not-in-manifest" } else { "not-in-manifest" } }));
        }
    }
    json!({
        "ok": issues.is_empty(),
        "dir": dir.to_string_lossy(),
        "issues": issues,
        "libraryId": manifest["libraryId"],
        "workId": manifest["workId"],
        "manifest": manifest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{OpenOptions, SourceRecord};

    #[test]
    fn component_cleaning_matches_node() {
        assert_eq!(clean_component("a<b>:c\"d/e\\f|g?h*i"), "a_b__c_d_e_f_g_h_i");
        assert_eq!(clean_component("  .hidden name.  "), "hidden name");
        assert_eq!(clean_component("CON"), "_CON");
        assert_eq!(clean_component("com1.txt"), "_com1.txt");
        assert_eq!(clean_component("com0"), "com0");
        assert_eq!(clean_component("..."), "untitled");
        assert_eq!(clean_component("ｆｕｌｌ　width"), "full width");
        assert_eq!(clean_component(&"x".repeat(200)).len(), 180);
    }

    #[test]
    fn friendly_name_uses_rj_circle_and_cvs() {
        let work = json!({
            "sourceRefs": [{ "sourceCode": "dlsite rj01234567" }],
            "title": "Title", "userTitle": "", "circle": "Circle", "cvs": ["A", "B"]
        });
        assert_eq!(auto_friendly_name(&work), "[RJ01234567][Circle] Title (A, B)");
        assert_eq!(auto_friendly_name(&json!({ "title": "x" })), "[Local] x");
    }

    #[test]
    fn source_only_work_exports_and_verifies() {
        let base = std::env::temp_dir().join(format!("mono-export-{}", uuid::Uuid::new_v4()));
        let source = base.join("source");
        std::fs::create_dir_all(source.join("mp3")).unwrap();
        std::fs::write(source.join("mp3").join("01.mp3"), b"export-audio").unwrap();
        std::fs::write(source.join("folder.png"), b"not really a png").unwrap();
        let mut library = Library::open(base.join("lib"), OpenOptions { create: true, allow_outside_root: true, ..Default::default() }).unwrap();
        let record = SourceRecord::from_json(&json!({
            "provider": "dlsite", "sourceCode": "RJ00000088", "title": "Export fixture", "circle": "Circle",
            "entries": [
                { "entryId": "e-1", "logicalPath": "mp3/01.mp3", "kind": "audio", "mime": "audio/mpeg", "sourcePath": source.join("mp3").join("01.mp3").to_string_lossy() },
                { "entryId": "e-2", "logicalPath": "folder.png", "kind": "image", "mime": "image/png", "sourcePath": source.join("folder.png").to_string_lossy() }
            ]
        }))
        .unwrap();
        let work_id = library.import_work(record, "export-key").unwrap().work["workId"].as_str().unwrap().to_string();
        let result = library.export_work(&work_id, &base.join("exports"), None).unwrap();
        assert_eq!(result["friendlyName"], "[RJ00000088][Circle] Export fixture");
        let dir = PathBuf::from(result["dir"].as_str().unwrap());
        assert_eq!(std::fs::read(dir.join("content").join("mp3").join("01.mp3")).unwrap(), b"export-audio");
        assert_eq!(result["manifest"]["cover"]["path"], "monochrome/cover.png");
        assert_eq!(verify_export(&dir)["ok"], true);
        // Collision and an unlisted file are both caught.
        assert_eq!(library.export_work(&work_id, &base.join("exports"), None).unwrap_err().code, Some("EEXPORTEXISTS"));
        std::fs::write(dir.join("content").join("smuggled.txt"), b"x").unwrap();
        assert!(verify_export(&dir)["issues"].as_array().unwrap().iter().any(|issue| issue["code"] == "extra-file"));
        // A source file changed after import must not be exported as if verified.
        std::fs::write(source.join("mp3").join("01.mp3"), b"tampered").unwrap();
        assert!(library.export_work(&work_id, &base.join("exports2"), None).is_err());
        assert!(!base.join("exports2").join("[RJ00000088][Circle] Export fixture").exists(), "failed export leaves no final dir");
        drop(library);
        let _ = std::fs::remove_dir_all(base);
    }
}
