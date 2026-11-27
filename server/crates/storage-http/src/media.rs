//! Media serving with byte ranges (`media.mjs`, E10).
//!
//! Resolution is `entry → asset_ref → file`, never a client-supplied path. The
//! audio element needs `Range` support with an exact `Content-Range`: the
//! frontend's large-WAV duration probe rejects anything but `206` plus
//! `bytes 0-<n>/<total>`, so a sloppy header here turns every >64 MiB WAV into
//! `--:--` forever.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde_json::json;

use storage_core::paths;

/// One resolved byte source for a media request.
pub struct ResolvedAsset {
    pub entry_id: String,
    pub stable_entry_id: String,
    pub path: PathBuf,
    pub size: u64,
    pub mime: String,
    pub sha256: Option<String>,
}

/// Resolve an entry id (internal or stable) to a readable file.
///
/// Accepts both id forms because the frontend resolves media by stable entry id
/// while `/api/works` signs by internal id; a stable id that matches several works
/// is treated as ambiguous and not guessed.
pub fn resolve_asset(
    connection: &Connection,
    data_root: &Path,
    source_root: Option<&Path>,
    entry_id: &str,
) -> Option<ResolvedAsset> {
    let entry: Option<(String, String, String, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT entry_id, stable_entry_id, kind, mime, original_path FROM entry WHERE entry_id = ?",
            rusqlite::params![entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .ok()
        .flatten()
        .or_else(|| {
            let mut statement = connection
                .prepare("SELECT entry_id, stable_entry_id, kind, mime, original_path FROM entry WHERE stable_entry_id = ? LIMIT 2")
                .ok()?;
            let rows: Vec<(String, String, String, Option<String>, Option<String>)> = statement
                .query_map(rusqlite::params![entry_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
                })
                .ok()?
                .filter_map(Result::ok)
                .collect();
            if rows.len() == 1 {
                rows.into_iter().next()
            } else {
                None
            }
        });
    let (internal_id, stable_entry_id, _kind, entry_mime, original_path) = match entry {
        Some(found) => found,
        // Not an audio entry id: try a post file. One opaque id space keeps
        // `sign_media_path`'s single-segment rule intact for both kinds.
        None => return resolve_post_file(connection, source_root, entry_id),
    };

    let asset: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT a.sha256, a.rel_path, a.mime FROM asset_ref r
             JOIN asset a ON a.asset_id = r.asset_id
             WHERE r.entry_id = ?
             ORDER BY CASE WHEN r.role = 'primary' THEN 0 ELSE 1 END, r.asset_ref_id
             LIMIT 1",
            rusqlite::params![internal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();

    // Source-only mode: a `source/<sha>` virtual asset means the file lives at the
    // entry's original path. Containment against the source root is enforced here
    // (deviation D4): Node served `original_path` unchecked, which let a crafted
    // DB row read any file the host process could reach.
    let virtual_source = asset
        .as_ref()
        .map(|(_, rel_path, _)| rel_path.starts_with("source/"))
        .unwrap_or(false);
    let source_only = original_path
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
        && (asset.is_none() || virtual_source);

    let file = if source_only {
        let original = original_path.as_deref().unwrap_or("");
        // Layout v2 stores source paths relative to the source root; older rows may
        // still be absolute — the resolver accepts both.
        let Some(path) = storage_core::layout::resolve_stored_path(source_root.as_deref(), original) else {
            return None;
        };
        match source_root {
            Some(root) if paths::is_inside(root, &path) => path,
            _ => return None,
        }
    } else {
        let rel_path = asset.as_ref().map(|(_, rel, _)| rel.clone()).unwrap_or_default();
        if rel_path.is_empty() || rel_path.contains("..") {
            return None;
        }
        let file = data_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !paths::is_inside(data_root, &file) {
            return None;
        }
        file
    };

    let info = std::fs::symlink_metadata(&file).ok()?;
    if info.file_type().is_symlink() || !info.is_file() {
        return None;
    }
    // Node: `ref?.mime || entry.mime || 'application/octet-stream'`. `||` treats ''
    // as absent, so an asset row with an empty mime must fall through to the entry
    // mime; `Option::or` alone kept the empty string and served a blank
    // `Content-Type`, which some players refuse.
    //
    // Also prefer `entry.mime` when it carries a detected `charset=` parameter
    // and an older shared `asset` row only kept the bare essence (`text/plain`).
    let asset_mime = asset
        .as_ref()
        .and_then(|(_, _, mime)| mime.clone())
        .filter(|value| !value.is_empty());
    let entry_mime = entry_mime.filter(|value| !value.is_empty());
    let mime = match (&asset_mime, &entry_mime) {
        (Some(a), Some(e)) if !has_charset_param(a) && has_charset_param(e) && same_base_mime(a, e) => e.clone(),
        (Some(a), _) => a.clone(),
        (None, Some(e)) => e.clone(),
        (None, None) => "application/octet-stream".to_string(),
    };
    Some(ResolvedAsset {
        entry_id: internal_id,
        stable_entry_id,
        path: file,
        size: info.len(),
        mime,
        sha256: asset.map(|(sha, _, _)| sha),
    })
}

fn has_charset_param(mime: &str) -> bool {
    mime.split(';')
        .skip(1)
        .any(|part| part.trim().to_ascii_lowercase().starts_with("charset="))
}

fn same_base_mime(left: &str, right: &str) -> bool {
    let base = |value: &str| value.split(';').next().unwrap_or(value).trim().to_ascii_lowercase();
    base(left) == base(right)
}

/// Resolve a post file id to a readable file under the source root.
///
/// The row's `root_path`/`rel_path` are data, not trusted paths: both joins are
/// re-checked for containment (folder inside the source root, file inside the
/// folder), and symlinks are refused like audio assets, so a crafted row cannot
/// turn `/media/<id>` into a read of an arbitrary file.
fn resolve_post_file(connection: &Connection, source_root: Option<&Path>, file_id: &str) -> Option<ResolvedAsset> {
    let source_root = source_root?;
    let (category, root_path, rel_path, mime, sha256) =
        storage_core::posts::find_file_by_id(connection, file_id).ok().flatten()?;
    // Same four-segment rule as the write paths: a row whose folder is `''` or
    // `'.'` would otherwise serve any file directly under the source root.
    let root_path = storage_host::posts::validated_post_root(&category, &root_path).ok()?;
    let folder = paths::resolve_lexical(&source_root.join(root_path.replace('/', std::path::MAIN_SEPARATOR_STR)));
    if !paths::is_inside(source_root, &folder) {
        return None;
    }
    let path = storage_host::posts::resolve_in(&folder, &rel_path).ok()?;
    if !paths::is_inside(&folder, &path) {
        return None;
    }
    let info = std::fs::symlink_metadata(&path).ok()?;
    if info.file_type().is_symlink() || !info.is_file() {
        return None;
    }
    Some(ResolvedAsset {
        entry_id: file_id.to_string(),
        stable_entry_id: file_id.to_string(),
        path,
        size: info.len(),
        mime: if mime.is_empty() { "application/octet-stream".to_string() } else { mime },
        sha256: Some(sha256).filter(|value| !value.is_empty()),
    })
}

/// Parsed `Range` header decision, mirroring `parseRange` exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeDecision {
    /// No header: serve the whole representation with 200.
    Full,
    /// Closed interval, inclusive `end`.
    Partial { start: u64, end: u64 },
    /// Start beyond the representation: 416.
    Unsatisfiable,
    /// Malformed/multi-range: 416 with a distinct code.
    Invalid,
}

/// Parse a `Range` header against a known size.
///
/// Multi-range and non-`bytes=` units are rejected rather than partially honoured:
/// a media element always sends a single range, and a partially honoured
/// multi-range would produce a body the caller cannot assemble.
pub fn parse_range(value: Option<&str>, size: u64) -> RangeDecision {
    let Some(value) = value else { return RangeDecision::Full };
    let text = value.trim();
    let Some(spec) = text.strip_prefix("bytes=").or_else(|| {
        let lower = text.to_lowercase();
        lower.strip_prefix("bytes=").map(|_| &text[6..])
    }) else {
        return RangeDecision::Invalid;
    };
    let spec = spec.trim();
    if spec.is_empty() || spec.contains(',') {
        return RangeDecision::Invalid;
    }
    let Some((start_text, end_text)) = spec.split_once('-') else {
        return RangeDecision::Invalid;
    };
    if !start_text.chars().all(|ch| ch.is_ascii_digit()) || !end_text.chars().all(|ch| ch.is_ascii_digit()) {
        return RangeDecision::Invalid;
    }
    if start_text.is_empty() && end_text.is_empty() {
        return RangeDecision::Invalid;
    }
    if start_text.is_empty() {
        let Ok(suffix) = end_text.parse::<u64>() else { return RangeDecision::Invalid };
        if suffix == 0 {
            return RangeDecision::Invalid;
        }
        let start = size.saturating_sub(suffix);
        if size == 0 {
            return RangeDecision::Unsatisfiable;
        }
        return RangeDecision::Partial { start, end: size - 1 };
    }
    let Ok(start) = start_text.parse::<u64>() else { return RangeDecision::Invalid };
    let end = if end_text.is_empty() {
        size.saturating_sub(1)
    } else {
        match end_text.parse::<u64>() {
            Ok(value) => value,
            Err(_) => return RangeDecision::Invalid,
        }
    };
    if end < start {
        return RangeDecision::Invalid;
    }
    if start >= size {
        return RangeDecision::Unsatisfiable;
    }
    RangeDecision::Partial { start, end: end.min(size.saturating_sub(1)) }
}

/// CORS headers shared by media responses.
pub fn media_cors_headers() -> Vec<(&'static str, String)> {
    vec![
        ("Access-Control-Allow-Origin", "*".to_string()),
        (
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length".to_string(),
        ),
    ]
}

/// JSON error body for media routes (no `ok` envelope, matching `media.mjs`).
pub fn media_error(code: &str, message: &str) -> serde_json::Value {
    json!({ "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_matches_node_shapes() {
        assert_eq!(parse_range(None, 100), RangeDecision::Full);
        assert_eq!(parse_range(Some("bytes=0-3"), 100), RangeDecision::Partial { start: 0, end: 3 });
        assert_eq!(parse_range(Some("bytes=0-65535"), 100), RangeDecision::Partial { start: 0, end: 99 });
        assert_eq!(parse_range(Some("bytes=50-"), 100), RangeDecision::Partial { start: 50, end: 99 });
        assert_eq!(parse_range(Some("bytes=-10"), 100), RangeDecision::Partial { start: 90, end: 99 });
        assert_eq!(parse_range(Some("bytes=-500"), 100), RangeDecision::Partial { start: 0, end: 99 });
    }

    #[test]
    fn invalid_and_unsatisfiable_are_distinct() {
        // Both map to 416, but with different codes; the frontend shows the message.
        assert_eq!(parse_range(Some("items=0-1"), 100), RangeDecision::Invalid);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), RangeDecision::Invalid);
        assert_eq!(parse_range(Some("bytes=5-1"), 100), RangeDecision::Invalid);
        assert_eq!(parse_range(Some("bytes=abc-def"), 100), RangeDecision::Invalid);
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeDecision::Invalid);
        assert_eq!(parse_range(Some("bytes=100-200"), 100), RangeDecision::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), RangeDecision::Unsatisfiable);
    }

    #[test]
    fn case_insensitive_unit_is_accepted() {
        assert_eq!(parse_range(Some("BYTES=0-1"), 10), RangeDecision::Partial { start: 0, end: 1 });
    }

    /// Library + source root with one video post whose folder holds `v.mp4`.
    ///
    /// `escape.mp4` sits exactly where `../escape.mp4` lands relative to the post
    /// folder, so a missing containment check would really serve it: the test
    /// then fails on the boundary, not on "file not found".
    fn post_fixture(tag: &str) -> (Connection, PathBuf, PathBuf, String) {
        let root = std::env::temp_dir().join(format!("mono-media-{tag}-{}", uuid::Uuid::new_v4()));
        let rel_folder = "videos/YouTube/c/2026-01-01 v [abc]";
        let folder = root.join(rel_folder.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("v.mp4"), b"0123456789").unwrap();
        std::fs::write(folder.parent().unwrap().join("escape.mp4"), b"secret").unwrap();
        let data_root = root.join("lib").join("data");
        std::fs::create_dir_all(&data_root).unwrap();

        let connection = Connection::open_in_memory().unwrap();
        storage_core::schema::enable_pragmas(&connection).unwrap();
        storage_core::schema::apply_schema(&connection, "lib").unwrap();
        connection
            .execute(
                "INSERT INTO post(post_id, category, provider, source_id, root_path, created_at, updated_at)
                 VALUES ('p1', 'video', 'youtube', 'abc', ?, 'now', 'now')",
                rusqlite::params![rel_folder],
            )
            .unwrap();
        let file_id = storage_core::posts::insert_file(
            &connection,
            "p1",
            &json!({ "role": "video", "relPath": "v.mp4", "bytes": 10, "mime": "video/mp4" }),
            "now",
        )
        .unwrap();
        (connection, root, data_root, file_id)
    }

    #[test]
    fn post_file_resolves_by_opaque_id_and_never_escapes_its_folder() {
        let (connection, root, data_root, file_id) = post_fixture("resolve");
        // Single path segment: `sign_media_path` only signs `/media/<one id>`.
        assert!(!file_id.contains('/'), "{file_id}");

        let asset = resolve_asset(&connection, &data_root, Some(&root), &file_id).expect("post file resolves");
        assert_eq!(asset.size, 10);
        assert_eq!(asset.mime, "video/mp4");
        assert_eq!(asset.entry_id, file_id);
        assert_eq!(asset.stable_entry_id, file_id);
        assert!(asset.sha256.is_none(), "empty sha256 must not become an ETag");

        assert!(resolve_asset(&connection, &data_root, Some(&root), "not-a-file-id").is_none());
        // No source root configured: post files are unreachable, not guessed.
        assert!(resolve_asset(&connection, &data_root, None, &file_id).is_none());

        let escape_id = storage_core::posts::insert_file(
            &connection,
            "p1",
            &json!({ "role": "video", "relPath": "../escape.mp4", "mime": "video/mp4" }),
            "now",
        )
        .unwrap();
        assert!(resolve_asset(&connection, &data_root, Some(&root), &escape_id).is_none());
        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn post_file_with_an_unvalidated_root_path_is_not_served() {
        // A pre-fix row can hold `root_path = ''`; with the bare containment
        // check, `/media/<id>` then served any file directly under the source
        // root (here: an audio track) by registering its name as `rel_path`.
        let (connection, root, data_root, _file_id) = post_fixture("bad-root");
        std::fs::create_dir_all(root.join("RJ000001")).unwrap();
        std::fs::write(root.join("RJ000001").join("track01.mp3"), b"audio").unwrap();
        connection
            .execute(
                "INSERT INTO post(post_id, category, provider, source_id, root_path, created_at, updated_at)
                 VALUES ('p2', 'video', 'youtube', 'empty', '', 'now', 'now')",
                [],
            )
            .unwrap();
        let leak_id = storage_core::posts::insert_file(
            &connection,
            "p2",
            &json!({ "role": "video", "relPath": "RJ000001/track01.mp3", "mime": "audio/mpeg" }),
            "now",
        )
        .unwrap();
        assert!(resolve_asset(&connection, &data_root, Some(&root), &leak_id).is_none());
        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn soft_deleted_post_file_is_not_served() {
        let (connection, root, data_root, file_id) = post_fixture("deleted");
        assert!(resolve_asset(&connection, &data_root, Some(&root), &file_id).is_some());
        assert!(storage_core::posts::soft_delete_post(&connection, "p1", "later").unwrap());
        assert!(resolve_asset(&connection, &data_root, Some(&root), &file_id).is_none());
        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_asset_preserves_entry_charset_when_asset_mime_is_bare() {
        let root = std::env::temp_dir().join(format!("mono-media-charset-{}", uuid::Uuid::new_v4()));
        let source_root = root.join("source");
        let work_dir = source_root.join("voices").join("w1");
        std::fs::create_dir_all(&work_dir).unwrap();
        std::fs::write(work_dir.join("notes.txt"), b"sjis-bytes").unwrap();
        std::fs::write(work_dir.join("readme.txt"), b"sjis-bytes-2").unwrap();
        let data_root = root.join("lib");
        std::fs::create_dir_all(&data_root).unwrap();

        let connection = Connection::open_in_memory().unwrap();
        storage_core::schema::enable_pragmas(&connection).unwrap();
        storage_core::schema::apply_schema(&connection, "lib").unwrap();
        connection
            .execute(
                "INSERT INTO work(work_id, title, created_at, updated_at) VALUES ('w1', 'W', 'now', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO entry(entry_id, work_id, stable_entry_id, logical_path, kind, mime, original_path)
                 VALUES ('e1', 'w1', 's1', 'notes.txt', 'text', 'text/plain; charset=shift_jis', 'voices/w1/notes.txt'),
                        ('e2', 'w1', 's2', 'readme.txt', 'text', 'text/plain; charset=shift_jis', 'voices/w1/readme.txt')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                 VALUES ('a1', 'sha1', 10, 'text/plain; charset=shift_jis', 'source/sha1', 'now'),
                        ('a2', 'sha2', 12, 'text/plain', 'source/sha2', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                 VALUES ('r1', 'w1', 'e1', 'a1', 'primary'),
                        ('r2', 'w1', 'e2', 'a2', 'primary')",
                [],
            )
            .unwrap();

        let first = resolve_asset(&connection, &data_root, Some(&source_root), "e1").unwrap();
        assert_eq!(first.mime, "text/plain; charset=shift_jis");
        let second = resolve_asset(&connection, &data_root, Some(&source_root), "e2").unwrap();
        assert_eq!(second.mime, "text/plain; charset=shift_jis");
        drop(connection);
        let _ = std::fs::remove_dir_all(root);
    }
}
