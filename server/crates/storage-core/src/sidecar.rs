//! `.monochrome/info.json` — the one sidecar a content folder carries.
//!
//! WHY a sidecar at all: the database is the authority for everything the app
//! shows, but a folder that leaves the library (copied to a backup drive, mailed
//! to a friend, restored after a lost library) has to be able to say what it is.
//! The sidecar is that sentence. It is written **once**, on first import, and
//! never rewritten afterwards — a file that is always in sync is a second write
//! path that can disagree with the database, which is exactly the bug that made
//! voice `metadata.json` get removed (docs/16 §2.6).
//!
//! Adoption, the other direction: when a folder is imported and its row does not
//! exist yet, the sidecar is read as the starting metadata. The database wins from
//! then on. A human who edits the file sets `"manual": true`; that flag makes the
//! sidecar win over the import request and stops the host from overwriting it.
//!
//! The shape is deliberately flat and human-editable:
//!
//! ```json
//! {
//!   "schema": "monochrome-info/1",
//!   "manual": false,
//!   "title": "…",
//!   "circle": "…",
//!   "sourceCode": "RJ01234567",
//!   "cvs": ["…"],
//!   "tags": ["…"],
//!   "publishedAt": "2026-01-01T00:00:00.000Z",
//!   "originalRoot": "voices/[RJ01234567] …"
//! }
//! ```
//!
//! `originalRoot` is what lets a folder be put back where it came from; it is
//! recorded here rather than inferred, because the folder's own name can change
//! and the source tree is layered by type.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::Result;
use crate::fsutil;

pub const DIR: &str = ".monochrome";
pub const INFO: &str = "info.json";
pub const SCHEMA: &str = "monochrome-info/1";

/// Upper bound on what is read. A sidecar is a few hundred bytes; anything at
/// this size is a media file someone renamed, and reading it whole would blow
/// the scanner's memory budget.
pub const MAX_BYTES: u64 = 256 * 1024;

pub fn path(folder: &Path) -> PathBuf {
    folder.join(DIR).join(INFO)
}

/// Read the sidecar, tolerating absence, a UTF-8 BOM, and junk.
///
/// A malformed file is not an error: the folder is still importable, and failing
/// here would make one bad byte hide every file next to it.
pub fn read(folder: &Path) -> Option<Value> {
    let file = path(folder);
    let metadata = std::fs::symlink_metadata(&file).ok()?;
    if metadata.len() > MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(&file).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str(text).ok().filter(Value::is_object)
}

/// `manual: true` means a human edited this file; it outranks the import request.
pub fn is_manual(value: &Value) -> bool {
    value.get("manual").and_then(Value::as_bool).unwrap_or(false)
}

/// Write the sidecar unless one already exists.
///
/// Returns `true` when this call created it. Never overwrites: the first import
/// owns the file, and a later re-import must not replace a seed a human may have
/// corrected (or the `originalRoot` that restore depends on).
pub fn write_if_absent(folder: &Path, value: &Value) -> Result<bool> {
    let file = path(folder);
    if fsutil::path_exists(&file) {
        return Ok(false);
    }
    fsutil::ensure_dir(&folder.join(DIR))?;
    fsutil::atomic_write_json(&file, value)?;
    Ok(true)
}

/// A short text field, trimmed. Used by callers merging a seed into an import.
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("")
}

/// Build the seed a voice work writes on first import.
///
/// Voice works read this file (the scanner prefers it over a stray
/// `metadata.json`) but until now nothing wrote it, so a folder whose database was
/// lost could only say what it was if a downloader had left a `metadata.json`
/// behind. Creations and videos already wrote theirs; this closes the asymmetry.
///
/// Only identity and human-facing fields go in. Ratings, prices and tags are
/// deliberately left out: they change without the folder changing, and a seed
/// that goes stale is worse than a seed that says less.
pub fn voice_seed(metadata: &Map<String, Value>, original_root: &str) -> Value {
    let field = |key: &str| metadata.get(key).cloned().unwrap_or(Value::Null);
    let mut seed = serde_json::Map::new();
    seed.insert("schema".to_string(), serde_json::json!(SCHEMA));
    seed.insert("manual".to_string(), serde_json::json!(false));
    seed.insert("kind".to_string(), serde_json::json!("voice"));
    for key in ["title", "circle", "sourceCode"] {
        let value = field(key);
        if value.as_str().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }
        seed.insert(key.to_string(), value);
    }
    let cvs = metadata
        .get("cvs")
        .or_else(|| metadata.get("artists"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !cvs.is_empty() {
        seed.insert("cvs".to_string(), Value::Array(cvs));
    }
    for key in ["release", "sourceUrl"] {
        let value = field(key);
        if value.as_str().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }
        seed.insert(key.to_string(), value);
    }
    if !original_root.is_empty() {
        seed.insert("originalRoot".to_string(), serde_json::json!(original_root));
    }
    Value::Object(seed)
}

/// A list of non-empty strings, used for `cvs`/`tags`.
pub fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("mono-sidecar-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn read_tolerates_a_bom_and_rejects_junk() {
        let folder = temp_dir("read");
        std::fs::create_dir_all(folder.join(DIR)).unwrap();
        std::fs::write(path(&folder), "\u{feff}{\"title\":\"t\"}").unwrap();
        assert_eq!(read(&folder).unwrap()["title"], "t");
        std::fs::write(path(&folder), "not json").unwrap();
        assert!(read(&folder).is_none());
    }

    #[test]
    fn write_if_absent_never_replaces_an_existing_file() {
        let folder = temp_dir("write");
        assert!(write_if_absent(&folder, &json!({ "title": "first" })).unwrap());
        // A human edits the file between imports; the second write is refused.
        std::fs::write(path(&folder), "{\"title\":\"edited\",\"manual\":true}").unwrap();
        assert!(!write_if_absent(&folder, &json!({ "title": "second" })).unwrap());
        assert_eq!(read(&folder).unwrap()["title"], "edited");
        assert!(is_manual(&read(&folder).unwrap()));
    }
}
