//! Bridge scan candidates into the library (`ingest.mjs`, S3).
//!
//! The scanner never writes or hashes. This is the first layer allowed to call
//! `Library::import_work`, which re-validates every source path and hashes the
//! bytes. Archives stay archives; only an explicit cover/folder/front/jacket/
//! package image is promoted to a `kind=cover` entry. No online metadata, no
//! extraction.
//!
//! Every validation here exists because the alternative is a path escape or a
//! second physical copy: `validate_entry_file` refuses entries outside the
//! candidate root and any reparse point on the way, and the cover entry gets a
//! synthetic `cover/<name>` logical path so it cannot collide with a scanned file.

use std::io::Read;
use std::path::{Path, PathBuf};

use storage_core::error::{Error, Result};
use storage_core::hash::sha256_text;
use storage_core::jsonutil::now_iso;
use storage_core::layout;
use storage_core::library::{ImportOutcome, Library, MergeOutcome, SourceRecord};
use storage_core::paths;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

const MAX_CHARSET_SNIFF_BYTES: usize = 64 * 1024;

/// Text/subtitle MIME types whose bytes may need a `charset=` parameter so
/// browsers do not default legacy Shift-JIS/GBK files to UTF-8 (docs/22 §A1).
fn is_text_charset_mime(base: &str) -> bool {
    matches!(
        base,
        "text/plain" | "text/vtt" | "text/x-ssa" | "text/markdown" | "application/x-subrip"
    )
}

/// Detect the character encoding of a text/subtitle prefix.
///
/// Returns `None` when the sample is empty, contains non-BOM NUL bytes (likely
/// binary), or `chardetng` is not confident — guessing a wrong charset is harder
/// to debug than leaving the MIME bare.
pub fn detect_charset(sample: &[u8], truncated: bool) -> Option<String> {
    if sample.is_empty() {
        return None;
    }
    if let Some((encoding, _)) = encoding_rs::Encoding::for_bom(sample) {
        return Some(encoding.name().to_ascii_lowercase());
    }
    if sample.contains(&0) {
        return None;
    }
    // ISO-2022-JP uses ESC (0x1B) sequences inside 7-bit ASCII bytes, which
    // `std::str::from_utf8` would falsely accept as UTF-8.
    if !sample.contains(&0x1b) {
        match std::str::from_utf8(sample) {
            Ok(_) => return Some("utf-8".to_string()),
            Err(error) if truncated && error.error_len().is_none() && error.valid_up_to() > 0 => {
                return Some("utf-8".to_string());
            }
            Err(_) => {}
        }
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, !truncated);
    let (encoding, confident) = detector.guess_assess(None, true);
    if !confident {
        return None;
    }
    if !truncated {
        let (_, had_errors) = encoding.decode_without_bom_handling(sample);
        if had_errors {
            return None;
        }
    }
    // chardetng 0.1.17 initializes `max = 0` in `guess_assess` and falls back to
    // `WINDOWS_1252` with `confident = true` when all candidates reject or score <= 0.
    // `encoding_rs::WINDOWS_1252` passes C1 bytes through without error, so reject
    // the 5 bytes unmapped in Windows-1252 (`class == 255` in chardetng itself).
    if encoding == encoding_rs::WINDOWS_1252
        && sample
            .iter()
            .any(|&b| matches!(b, 0x81 | 0x8d | 0x8f | 0x90 | 0x9d))
    {
        return None;
    }
    Some(encoding.name().to_ascii_lowercase())
}

fn sniff_file_charset(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::with_capacity(8192);
    file.take(MAX_CHARSET_SNIFF_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .ok()?;
    let truncated = buffer.len() > MAX_CHARSET_SNIFF_BYTES;
    let slice = if truncated {
        &buffer[..MAX_CHARSET_SNIFF_BYTES]
    } else {
        &buffer[..]
    };
    detect_charset(slice, truncated)
}

fn mime_for_file(name: &str, path: &Path) -> String {
    let base = mime_for(name);
    if !is_text_charset_mime(&base) {
        return base;
    }
    match sniff_file_charset(path) {
        Some(charset) => format!("{base}; charset={charset}"),
        None => base,
    }
}

/// Resolve the on-disk path of an existing `entry` row for startup migration,
/// mirroring `media::resolve_asset`'s containment rules.
fn resolve_entry_file_for_migration(
    data_root: &Path,
    source_root: Option<&Path>,
    original_path: Option<&str>,
    rel_path: Option<&str>,
) -> Option<PathBuf> {
    let virtual_source = rel_path.map(|value| value.starts_with("source/")).unwrap_or(false);
    let source_only = original_path.map(|value| !value.is_empty()).unwrap_or(false)
        && (rel_path.is_none() || virtual_source);

    let file = if source_only {
        let original = original_path.unwrap_or("");
        let resolved = layout::resolve_stored_path(source_root, original)?;
        match source_root {
            Some(root) if paths::is_inside(root, &resolved) => resolved,
            _ => return None,
        }
    } else {
        let rel = rel_path.unwrap_or("");
        if rel.is_empty() || rel.contains("..") {
            return None;
        }
        let candidate = data_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !paths::is_inside(data_root, &candidate) {
            return None;
        }
        candidate
    };

    let info = std::fs::symlink_metadata(&file).ok()?;
    if info.file_type().is_symlink() || !info.is_file() {
        return None;
    }
    Some(file)
}

/// Idempotently backfill `charset=` on pre-existing bare text/subtitle rows
/// across `entry`, `track_rendition`, and linked `asset` rows.
pub fn migrate_text_charsets(
    connection: &rusqlite::Connection,
    data_root: &Path,
    source_root: Option<&Path>,
) -> Result<usize> {
    struct Row {
        entry_id: String,
        entry_mime: String,
        original_path: Option<String>,
        asset_id: Option<String>,
        rel_path: Option<String>,
        asset_mime: Option<String>,
    }

    let rows: Vec<Row> = {
        let mut statement = connection.prepare(
            "SELECT e.entry_id, e.mime, e.original_path, a.asset_id, a.rel_path, a.mime
             FROM entry e
             LEFT JOIN asset_ref r ON r.entry_id = e.entry_id AND r.role = 'primary'
             LEFT JOIN asset a ON a.asset_id = r.asset_id
             WHERE e.mime IN ('text/plain', 'text/vtt', 'text/x-ssa', 'text/markdown', 'application/x-subrip')
                OR (e.mime LIKE '%; charset=%'
                    AND (a.mime IN ('text/plain', 'text/vtt', 'text/x-ssa', 'text/markdown', 'application/x-subrip')
                         OR EXISTS (
                             SELECT 1 FROM track_rendition tr
                             WHERE tr.entry_id = e.entry_id
                               AND tr.mime IN ('text/plain', 'text/vtt', 'text/x-ssa', 'text/markdown', 'application/x-subrip')
                         )))",
        )?;
        let collected = statement
            .query_map([], |row| {
                Ok(Row {
                    entry_id: row.get(0)?,
                    entry_mime: row.get(1)?,
                    original_path: row.get(2)?,
                    asset_id: row.get(3)?,
                    rel_path: row.get(4)?,
                    asset_mime: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        collected
    };

    if rows.is_empty() {
        return Ok(0);
    }

    let mut updates: Vec<(String, String, Option<String>)> = Vec::new();
    for row in rows {
        let base = row.entry_mime.split(';').next().unwrap_or(&row.entry_mime).trim();
        if !is_text_charset_mime(base) {
            continue;
        }
        if row.entry_mime.contains("charset=") {
            updates.push((row.entry_id, row.entry_mime, row.asset_id));
            continue;
        }
        let Some(file) = resolve_entry_file_for_migration(
            data_root,
            source_root,
            row.original_path.as_deref(),
            row.rel_path.as_deref(),
        ) else {
            continue;
        };
        let Some(charset) = sniff_file_charset(&file) else {
            continue;
        };
        let next_mime = format!("{base}; charset={charset}");
        let _ = row.asset_mime;
        updates.push((row.entry_id, next_mime, row.asset_id));
    }

    if updates.is_empty() {
        return Ok(0);
    }

    connection.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<usize> {
        let mut count = 0usize;
        for (entry_id, mime, asset_id) in updates {
            let entry_changed = connection.execute(
                "UPDATE entry SET mime = ?1 WHERE entry_id = ?2 AND mime != ?1",
                rusqlite::params![mime, entry_id],
            )?;
            let rendition_changed = connection.execute(
                "UPDATE track_rendition SET mime = ?1 WHERE entry_id = ?2 AND (mime IS NULL OR mime != ?1)",
                rusqlite::params![mime, entry_id],
            )?;
            let asset_changed = if let Some(asset_id) = asset_id {
                connection.execute(
                    "UPDATE asset SET mime = ?1 WHERE asset_id = ?2 AND (mime IS NULL OR mime = '' OR mime NOT LIKE '%charset=%')",
                    rusqlite::params![mime, asset_id],
                )?
            } else {
                0
            };
            if entry_changed > 0 || rendition_changed > 0 || asset_changed > 0 {
                count += 1;
            }
        }
        Ok(count)
    })();
    match outcome {
        Ok(count) => {
            connection.execute_batch("COMMIT")?;
            Ok(count)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// MIME by extension, matching `MIME_BY_EXTENSION` in `ingest.mjs`.
fn mime_for(name: &str) -> String {
    let extension = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match extension.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wma" => "audio/x-ms-wma",
        "aiff" | "aif" => "audio/aiff",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        "ass" | "ssa" => "text/x-ssa",
        "lrc" | "txt" | "nfo" => "text/plain",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "md" => "text/markdown",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

/// Deterministic stable entry id from the logical path.
///
/// Never from an array index: a rescan that adds a file in the middle must not
/// renumber every later entry, or dedupe and the frontend's host-entry mapping
/// both break. SHA-1 (not SHA-256) keeps the id short and Windows-safe — it is an
/// identifier, not a security boundary.
fn deterministic_entry_id(logical_path: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(logical_path.as_bytes());
    let digest = storage_core::hash::hex(&hasher.finalize());
    format!("local-entry-{}", &digest[..24])
}

/// Strip `[RJ...]`, a leading `[circle]` and trailing `(CV ...)` from a folder
/// title to get a display title.
///
/// Only the display title is derived here. docs/16 §17.2 forbids parsing
/// circle/CV out of names, so those stay empty until metadata is fetched.
fn display_title_from_folder(title: &str) -> String {
    let text = title.trim();
    let without_rj = strip_rj_prefix(text);
    let without_circle = strip_bracket_prefix(&without_rj);
    let without_cv = strip_cv_suffix(&without_circle);
    let without_cv_ja = strip_cv_ja(&without_cv);
    if without_cv_ja.is_empty() {
        text.to_string()
    } else {
        without_cv_ja
    }
}

fn strip_rj_prefix(value: &str) -> String {
    let upper = value.to_uppercase();
    if !upper.starts_with("[RJ") {
        return value.to_string();
    }
    let Some(close) = value.find(']') else { return value.to_string() };
    let inside = &value[1..close];
    let digits = inside[2..].trim();
    if !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit()) && (5..=8).contains(&digits.len()) {
        value[close + 1..].trim_start().to_string()
    } else {
        value.to_string()
    }
}

fn strip_bracket_prefix(value: &str) -> String {
    if !value.starts_with('[') {
        return value.to_string();
    }
    match value.find(']') {
        Some(close) => value[close + 1..].trim_start().to_string(),
        None => value.to_string(),
    }
}

/// Remove a trailing `(CV ...)` group.
fn strip_cv_suffix(value: &str) -> String {
    let trimmed = value.trim_end();
    if !trimmed.ends_with(')') {
        return trimmed.to_string();
    }
    let Some(open) = trimmed.rfind('(') else { return trimmed.to_string() };
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    let inner_upper = inner.trim_start().to_uppercase();
    if inner_upper.starts_with("CV") {
        trimmed[..open].trim_end().to_string()
    } else {
        trimmed.to_string()
    }
}

/// Remove a trailing `【CV...】` group (Japanese full-width brackets).
fn strip_cv_ja(value: &str) -> String {
    let trimmed = value.trim_end();
    if !trimmed.ends_with('】') {
        return trimmed.to_string();
    }
    let Some(open) = trimmed.rfind('【') else { return trimmed.to_string() };
    let close = trimmed.len() - '】'.len_utf8();
    if open + '【'.len_utf8() > close {
        return trimmed.to_string();
    }
    let inner = &trimmed[open + '【'.len_utf8()..close];
    let inner_upper = inner.trim_start().to_uppercase();
    if inner_upper.starts_with("CV") {
        trimmed[..open].trim_end().to_string()
    } else {
        trimmed.to_string()
    }
}

/// A scan candidate as the scanner produces it.
pub struct Candidate {
    pub candidate_id: String,
    pub relative_root: String,
    pub root_path: PathBuf,
    pub folder_title: String,
    pub circle: String,
    pub cvs: Vec<String>,
    pub source_code: String,
    pub family_id: Option<String>,
    pub entries: Vec<CandidateEntry>,
    pub metadata: Option<Map<String, Value>>,
    pub cover: Option<CoverCandidate>,
}

pub struct CandidateEntry {
    pub logical_path: String,
    pub absolute_path: PathBuf,
    pub name: String,
    pub kind: String,
    pub track_key: Option<String>,
    pub format: Option<String>,
}

pub struct CoverCandidate {
    pub path: PathBuf,
    pub format: Option<String>,
}

/// Validate the candidate root: absolute, real directory, not a symlink.
fn validate_candidate_root(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute() {
        return Err(Error::new("candidate.rootPath must be absolute"));
    }
    let resolved = paths::resolve_lexical(root);
    paths::assert_no_reparse(&resolved, false)
        .map_err(|_| Error::new("candidate.rootPath must not be a symlink/junction"))?;
    let info = std::fs::metadata(&resolved)?;
    if !info.is_dir() {
        return Err(Error::new("candidate.rootPath must be a directory"));
    }
    Ok(resolved)
}

/// Validate one entry file: inside the root, no reparse components, regular file.
fn validate_entry_file(root: &Path, absolute_path: &Path, _logical_path: &str) -> Result<(PathBuf, u64)> {
    if !absolute_path.is_absolute() {
        return Err(Error::new(format!("entry path must be absolute: {}", absolute_path.display())));
    }
    let absolute = paths::resolve_lexical(absolute_path);
    if !paths::is_inside(root, &absolute) {
        return Err(Error::new(format!(
            "entry escapes candidate root: {}",
            absolute_path.display()
        )));
    }
    // Re-check the components between root and file: the root itself is trusted,
    // a nested junction is not.
    if let Ok(relative) = absolute.strip_prefix(root) {
        let mut current = root.to_path_buf();
        for part in relative.components() {
            current.push(part.as_os_str());
            if let Ok(info) = std::fs::symlink_metadata(&current) {
                if info.file_type().is_symlink() {
                    return Err(Error::new(format!(
                        "entry path contains a symlink/junction: {}",
                        absolute_path.display()
                    )));
                }
            }
        }
    }
    let info = std::fs::metadata(&absolute)?;
    if !info.is_file() {
        return Err(Error::new(format!("entry is not a regular file: {}", absolute_path.display())));
    }
    Ok((absolute, info.len()))
}

/// Build the S1 source record from a candidate.
///
/// Pure except for read-only validation: it does not copy or hash bytes.
///
/// `source_root` decides how each entry is *stored*: inside the source root the
/// value becomes relative, so the library still resolves after the data folder is
/// moved, while the absolute path travels alongside it as `absolutePath` because
/// the import still has to open the file. See `SourceEntry::read_path`.
pub fn source_record_from_candidate(
    candidate: &Candidate,
    allowed_roots: &[PathBuf],
    source_root: &Path,
) -> Result<SourceRecord> {
    let root = validate_candidate_root(&candidate.root_path)?;
    if !allowed_roots.iter().any(|allowed| paths::is_inside(allowed, &root)) {
        return Err(Error::outside(format!(
            "candidate root is outside the authorized source roots: {}",
            root.display()
        )));
    }

    let mut seen_logical: Vec<String> = Vec::new();
    let mut entries = Vec::with_capacity(candidate.entries.len() + 1);
    for (index, entry) in candidate.entries.iter().enumerate() {
        let logical_path = paths::validate_logical_path(&entry.logical_path)?;
        if seen_logical.contains(&logical_path) {
            return Err(Error::new(format!("duplicate logical path in candidate: {logical_path}")));
        }
        seen_logical.push(logical_path.clone());
        let (absolute, _size) = validate_entry_file(&root, &entry.absolute_path, &logical_path)?;
        entries.push(json!({
            "entryId": deterministic_entry_id(&logical_path),
            "logicalPath": logical_path.clone(),
            "kind": if entry.kind.is_empty() { "file".to_string() } else { entry.kind.clone() },
            "sourcePath": layout::stored_source_path(source_root, &absolute),
            "absolutePath": absolute.to_string_lossy(),
            "mime": mime_for_file(if entry.name.is_empty() { &logical_path } else { &entry.name }, &absolute),
            "trackKey": entry.track_key,
            "format": entry.format,
        }));
        let _ = index;
    }

    if let Some(cover) = &candidate.cover {
        let cover_path = if cover.path.is_absolute() {
            paths::resolve_lexical(&cover.path)
        } else {
            paths::resolve_lexical(&root.join(&cover.path))
        };
        if !paths::is_inside(&root, &cover_path) {
            return Err(Error::new("cover escapes candidate root"));
        }
        let info = std::fs::metadata(&cover_path)?;
        if !info.is_file() {
            return Err(Error::new("cover is not a regular file"));
        }
        let base_name = cover_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "cover.jpg".to_string());
        // Synthetic path: `entry.logical_path` is unique per work, and the scanned
        // image may already be an entry. Both may point at the same file; the CAS
        // layer (here: the hash) dedupes the bytes.
        let mut cover_logical = format!("cover/{base_name}");
        let mut suffix = 2;
        while seen_logical.contains(&cover_logical) {
            let (stem, extension) = match base_name.rsplit_once('.') {
                Some((stem, extension)) => (stem.to_string(), format!(".{extension}")),
                None => (base_name.clone(), String::new()),
            };
            cover_logical = format!("cover/{stem}-{suffix}{extension}");
            suffix += 1;
        }
        seen_logical.push(cover_logical.clone());
        let cover_mime = match cover.format.as_deref() {
            Some("png") => "image/png".to_string(),
            Some("jpeg") => "image/jpeg".to_string(),
            _ => mime_for(&base_name),
        };
        entries.push(json!({
            "entryId": deterministic_entry_id(&cover_logical),
            "logicalPath": cover_logical,
            "kind": "cover",
            "sourcePath": layout::stored_source_path(source_root, &cover_path),
            "absolutePath": cover_path.to_string_lossy(),
            "mime": cover_mime,
        }));
    }

    let raw_title = candidate
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("title"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let title = candidate.folder_title.trim();
            if title.is_empty() { None } else { Some(title.to_string()) }
        })
        .or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "work".to_string());
    let title = display_title_from_folder(&raw_title);
    let source_code = if !candidate.source_code.is_empty() {
        candidate.source_code.clone()
    } else {
        let folder = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "work".to_string());
        stable_local_code(&folder)
    };
    let provider = if is_rj_code(&source_code) { "dlsite" } else { "local" };
    let language = candidate
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("language"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let role = candidate
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("role"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    SourceRecord::from_json(&json!({
        "provider": provider,
        "sourceCode": source_code,
        "title": title,
        "circle": candidate.circle.trim(),
        "cvs": candidate.cvs,
        "familyId": candidate.family_id,
        "edition": { "language": language, "role": role },
        "entries": entries,
    }))
}

/// `RJ\d{5,8}` test.
fn is_rj_code(value: &str) -> bool {
    let upper = value.to_uppercase();
    let Some(rest) = upper.strip_prefix("RJ") else { return false };
    !rest.is_empty() && rest.len() <= 8 && rest.chars().all(|ch| ch.is_ascii_digit())
}

/// Folder identity: an RJ code when present, otherwise `local:<folder>`.
///
/// The selected folder is the identity, not the scan root: upload-single and
/// batch modes produce different candidate ids for the same folder, so using the
/// candidate id here would create duplicate works for one directory.
fn stable_local_code(folder: &str) -> String {
    let upper = folder.to_uppercase();
    if let Some(index) = upper.find("RJ") {
        let candidate = &folder[index..];
        let digits: String = candidate[2..].chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if (5..=8).contains(&digits.len()) {
            return format!("RJ{digits}");
        }
    }
    format!("local:{folder}")
}

/// Find an existing live work for this source identity.
fn find_existing_work(connection: &rusqlite::Connection, record: &SourceRecord) -> Result<Option<String>> {
    let direct: Option<String> = connection
        .query_row(
            "SELECT r.work_id FROM source_ref r JOIN work w ON w.work_id = r.work_id
             WHERE r.provider = ? AND r.source_code = ? AND w.deleted_at IS NULL LIMIT 1",
            rusqlite::params![record.provider, record.source_code],
            |row| row.get(0),
        )
        .optional()?;
    if direct.is_some() {
        return Ok(direct);
    }
    if !is_rj_code(&record.source_code) {
        return Ok(None);
    }
    // Older imports may have recorded `local:local:[RJ...]` before folder identity
    // was normalised; reuse that work so one folder does not become two.
    let like = format!("%{}%", record.source_code.to_uppercase());
    let fallback: Option<String> = connection
        .query_row(
            "SELECT r.work_id FROM source_ref r JOIN work w ON w.work_id = r.work_id
             WHERE w.deleted_at IS NULL AND UPPER(r.source_code) LIKE ?
             ORDER BY r.source_ref_id LIMIT 1",
            rusqlite::params![like],
            |row| row.get(0),
        )
        .optional()?;
    Ok(fallback)
}

/// Result of ingesting one candidate.
#[derive(Debug)]
pub struct IngestOutcome {
    pub work: Value,
    pub candidate_id: Option<String>,
    pub job_id: Option<String>,
    pub idempotent: bool,
    pub merge: Option<MergeOutcome>,
    pub provider: String,
    pub source_code: String,
    pub source_entry_count: usize,
    pub cover_entry: bool,
    pub archive_entries: usize,
}

/// Ingest one candidate: merge into an existing work, or import a new one.
///
/// `source_root` is what turns an entry's absolute path into the stored relative
/// form; it is required rather than defaulted, because guessing a root would
/// either pin machine paths or (worse) relativise against the wrong tree.
pub fn ingest_candidate(
    library: &mut Library,
    candidate: &Candidate,
    idempotency_key: Option<&str>,
    allowed_roots: &[PathBuf],
    source_root: &Path,
) -> Result<IngestOutcome> {
    let record = source_record_from_candidate(candidate, allowed_roots, source_root)?;
    let key = idempotency_key
        .map(str::to_string)
        .unwrap_or_else(|| format!("local:import:{}", if candidate.candidate_id.is_empty() { &candidate.relative_root } else { &candidate.candidate_id }));
    let entry_count = record.entries.len();
    let provider = record.provider.clone();
    let source_code = record.source_code.clone();
    let cover_entry = record.entries.iter().any(|entry| entry.kind == "cover");
    let archive_entries = record.entries.iter().filter(|entry| entry.kind == "archive").count();

    let existing = find_existing_work(&library.connection, &record)?;
    let (work, idempotent, merge, job_id) = match existing {
        Some(work_id) => {
            let merged = library.merge_work_source(&work_id, record)?;
            let job_id = merged.job_id.clone();
            let work = library
                .get_work(&work_id, false)?
                .ok_or_else(|| Error::not_found("work not found after merge"))?;
            (work, false, Some(merged), job_id)
        }
        None => {
            let outcome: ImportOutcome = library.import_work(record, &key)?;
            let job_id = Some(outcome.job_id.clone());
            (outcome.work, outcome.idempotent, None, job_id)
        }
    };

    Ok(IngestOutcome {
        work,
        candidate_id: Some(candidate.candidate_id.clone()).filter(|value| !value.is_empty()),
        job_id,
        idempotent,
        merge,
        provider,
        source_code,
        source_entry_count: entry_count,
        cover_entry,
        archive_entries,
    })
}

impl IngestOutcome {
    pub fn to_json(&self) -> Value {
        let mut object = match self.work.as_object() {
            Some(map) => map.clone(),
            None => Map::new(),
        };
        object.insert(
            "candidateId".to_string(),
            json!(self.candidate_id.clone()),
        );
        object.insert("batchId".to_string(), Value::Null);
        object.insert("jobId".to_string(), json!(self.job_id.clone()));
        object.insert("idempotent".to_string(), json!(self.idempotent));
        object.insert(
            "merge".to_string(),
            self.merge.as_ref().map(MergeOutcome::to_json).unwrap_or(Value::Null),
        );
        object.insert(
            "sourceRecord".to_string(),
            json!({
                "provider": self.provider,
                "sourceCode": self.source_code,
                "entryCount": self.source_entry_count,
                "coverEntry": self.cover_entry,
                "archiveEntries": self.archive_entries,
            }),
        );
        Value::Object(object)
    }
}

/// Record a batch progress row for one candidate's completion.
///
/// Kept in the ingest layer because it must be written in the same pass as the
/// import result; the HTTP layer only reads it (`/api/import/status`).
pub fn touch_batch_progress(connection: &rusqlite::Connection, library_id: &str, batch_id: &str) -> Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO import_batch_progress(
            batch_id, library_id, status, phase, current_candidate, total_candidates, updated_at
         ) VALUES (?, ?, 'running', 'queued', 0, 0, ?)",
        rusqlite::params![batch_id, library_id, now_iso()],
    )?;
    Ok(())
}

/// Deterministic job key for a batch child (`childKey`).
pub fn child_key(batch_id: &str, candidate_id: &str) -> String {
    format!("local:ingest:{batch_id}:{candidate_id}")
}

/// Hash helper re-exported for callers that need a stable id from a path.
pub fn entry_id_for(logical_path: &str) -> String {
    deterministic_entry_id(logical_path)
}

/// Stable hash of a string, used by tests to assert determinism.
pub fn stable_hash(value: &str) -> String {
    sha256_text(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage_core::library::OpenOptions;

    fn fixture() -> (Library, PathBuf) {
        let root = std::env::temp_dir().join(format!("mono-ingest-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        std::fs::create_dir_all(source.join("[RJ01678051] [Circle] title (CV A)")).unwrap();
        std::fs::write(
            source.join("[RJ01678051] [Circle] title (CV A)").join("01.mp3"),
            b"audio-bytes",
        )
        .unwrap();
        let library = Library::open(
            root.join("library"),
            OpenOptions { create: true, allow_outside_root: true, ..Default::default() },
        )
        .unwrap();
        (library, source)
    }

    fn candidate(source: &Path) -> Candidate {
        let root = source.join("[RJ01678051] [Circle] title (CV A)");
        Candidate {
            candidate_id: format!("local:{}", root.file_name().unwrap().to_string_lossy()),
            relative_root: root.file_name().unwrap().to_string_lossy().to_string(),
            root_path: root.clone(),
            folder_title: root.file_name().unwrap().to_string_lossy().to_string(),
            circle: String::new(),
            cvs: Vec::new(),
            source_code: String::new(),
            family_id: None,
            metadata: None,
            cover: None,
            entries: vec![CandidateEntry {
                logical_path: "01.mp3".to_string(),
                absolute_path: root.join("01.mp3"),
                name: "01.mp3".to_string(),
                kind: "audio".to_string(),
                track_key: None,
                format: None,
            }],
        }
    }

    #[test]
    fn title_is_display_clean_but_identity_keeps_rj() {
        let (mut library, source) = fixture();
        let outcome = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()], &source).unwrap();
        assert_eq!(outcome.work["title"], "title");
        // Identity still comes from the RJ code, never from the cleaned title.
        let code: String = library
            .connection
            .query_row("SELECT source_code FROM source_ref LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(code, "RJ01678051");
    }

    /// Phase 2a: the row stores the path relative to the source root, so the
    /// library can be copied elsewhere, while the snapshot beside it carries the
    /// same relative value. Only the import's own `absolutePath` is machine-bound,
    /// and that one is never persisted.
    #[test]
    fn entries_are_stored_relative_to_the_source_root() {
        let (mut library, source) = fixture();
        let relative_root = "[RJ01678051] [Circle] title (CV A)";
        let outcome = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()], &source).unwrap();
        assert!(!outcome.idempotent);
        let original: String = library
            .connection
            .query_row("SELECT original_path FROM entry LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(original, format!("{relative_root}/01.mp3"));
        // The snapshot must not pin the machine path either.
        let snapshot: String = library
            .connection
            .query_row("SELECT snapshot_json FROM source_ref LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert!(snapshot.contains(&format!("\"sourcePath\":\"{relative_root}/01.mp3\"")), "{snapshot}");
    }

    /// A file outside the configured source root keeps its absolute path: the user
    /// put those bytes elsewhere, and rewriting them relative would point at
    /// nothing on the next read.
    #[test]
    fn entries_outside_the_source_root_stay_absolute() {
        let (mut library, source) = fixture();
        let elsewhere = std::env::temp_dir().join(format!("mono-ingest-elsewhere-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        let file = elsewhere.join("01.mp3");
        std::fs::write(&file, b"audio-bytes").unwrap();
        let mut outside = candidate(&source);
        // The candidate root still has to be authorized; only the file moves out
        // of the *source root* passed for storage.
        outside.entries[0].absolute_path = file.clone();
        outside.root_path = elsewhere.clone();
        outside.relative_root = "elsewhere".to_string();
        outside.candidate_id = "local:elsewhere".to_string();
        ingest_candidate(&mut library, &outside, None, &[elsewhere.clone()], &source).unwrap();
        let original: String = library
            .connection
            .query_row("SELECT original_path FROM entry LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(std::path::Path::new(&original), file.as_path());
    }

    #[test]
    fn rescan_merges_instead_of_importing_twice() {
        let (mut library, source) = fixture();
        let first = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()], &source).unwrap();
        let work_id = first.work["workId"].as_str().unwrap().to_string();
        let second = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()], &source).unwrap();
        assert_eq!(second.work["workId"], work_id);
        let merge = second.merge.expect("rescan must merge");
        assert!(!merge.changed);
        assert_eq!(merge.skipped, 1);
        let works: i64 = library
            .connection
            .query_row("SELECT COUNT(*) FROM work", [], |row| row.get(0))
            .unwrap();
        assert_eq!(works, 1);
    }

    #[test]
    fn entry_outside_root_is_rejected() {
        let (mut library, source) = fixture();
        let mut bad = candidate(&source);
        bad.entries[0].absolute_path = source.join("elsewhere.mp3");
        std::fs::write(source.join("elsewhere.mp3"), b"x").unwrap();
        let error = ingest_candidate(&mut library, &bad, None, &[source.clone()], &source).unwrap_err();
        assert!(error.message.contains("entry escapes candidate root"), "{}", error.message);
    }

    #[test]
    fn unauthorized_root_is_rejected() {
        let (mut library, source) = fixture();
        let other = std::env::temp_dir().join(format!("mono-ingest-other-{}", uuid::Uuid::new_v4()));
        let error = ingest_candidate(&mut library, &candidate(&source), None, &[other], &source).unwrap_err();
        assert_eq!(error.code, Some("EOUTSIDE"));
    }

    #[test]
    fn display_title_strips_only_display_parts() {
        assert_eq!(display_title_from_folder("[RJ01678051] [Circle] title (CV A)"), "title");
        assert_eq!(display_title_from_folder("plain title"), "plain title");
        assert_eq!(display_title_from_folder("[RJ123456] title"), "title");
    }

    #[test]
    fn entry_ids_are_stable_and_short() {
        let first = entry_id_for("mp3/01.mp3");
        assert_eq!(first, entry_id_for("mp3/01.mp3"));
        assert_ne!(first, entry_id_for("mp3/02.mp3"));
        assert!(first.starts_with("local-entry-"));
        assert_eq!(first.len(), "local-entry-".len() + 24);
    }

    #[test]
    fn detect_charset_handles_japanese_chinese_utf_bom_and_binary() {
        // UTF-8 (ASCII and Japanese)
        assert_eq!(detect_charset(b"synthetic notes\n", false).as_deref(), Some("utf-8"));
        assert_eq!(detect_charset("日本語の台本テキストです。\n".as_bytes(), false).as_deref(), Some("utf-8"));
        // UTF-8 split at a multi-byte boundary when truncated
        let utf8_jp = "あいうえお".as_bytes();
        assert_eq!(detect_charset(&utf8_jp[..7], true).as_deref(), Some("utf-8"));
        // BOMs
        assert_eq!(detect_charset(b"\xEF\xBB\xBFhello", false).as_deref(), Some("utf-8"));
        assert_eq!(detect_charset(b"\xFF\xFEh\x00i\x00", false).as_deref(), Some("utf-16le"));
        assert_eq!(detect_charset(b"\xFE\xFF\x00h\x00i", false).as_deref(), Some("utf-16be"));

        // Shift-JIS
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("同人音声の台本テキストです。第1話「はじまり」\r\nよろしくお願いします。");
        assert_eq!(detect_charset(&sjis, false).as_deref(), Some("shift_jis"));

        // EUC-JP
        let (euc_jp, _, _) = encoding_rs::EUC_JP.encode("[00:01.00]日本語の字幕テストです。\n[00:05.00]次のセリフが続きます。\n");
        assert_eq!(detect_charset(&euc_jp, false).as_deref(), Some("euc-jp"));

        // ISO-2022-JP (7-bit with ESC 0x1B)
        let (iso_jp, _, _) = encoding_rs::ISO_2022_JP.encode("日本語の台本テストです。");
        assert_eq!(detect_charset(&iso_jp, false).as_deref(), Some("iso-2022-jp"));

        // GBK
        let (gbk, _, _) = encoding_rs::GBK.encode("这是一段简体中文音声附带说明文本，用于验证GBK编码识别。");
        assert_eq!(detect_charset(&gbk, false).as_deref(), Some("gbk"));

        // Empty, NUL-containing binary, and truncated/corrupt multi-byte sequences stay None
        assert_eq!(detect_charset(b"", false), None);
        assert_eq!(detect_charset(b"abc\x00def", false), None);
        assert_eq!(detect_charset(&[0x81], false), None);
        let mut corrupt_sjis = sjis.to_vec();
        corrupt_sjis.push(0x81);
        assert_eq!(detect_charset(&corrupt_sjis, false), None);
    }

    #[test]
    fn ingest_candidate_records_detected_charset_for_text_and_subtitles() {
        let (mut library, source) = fixture();
        let work_dir = source.join("[RJ01678051] [Circle] title (CV A)");
        let (sjis_txt, _, _) = encoding_rs::SHIFT_JIS.encode("同人音声の説明ファイルです。\r\n注意事項をお読みください。");
        let (sjis_lrc, _, _) = encoding_rs::SHIFT_JIS.encode("[00:01.20]おはよう、今日もいい天気だね。\r\n[00:04.50]いっしょに出かけよう。\r\n");
        let (gbk_srt, _, _) = encoding_rs::GBK.encode("1\r\n00:00:01,000 --> 00:00:04,000\r\n这是一条简体中文字幕测试文本。\r\n");
        std::fs::write(work_dir.join("readme.txt"), &sjis_txt).unwrap();
        std::fs::write(work_dir.join("01.lrc"), &sjis_lrc).unwrap();
        std::fs::write(work_dir.join("01.srt"), &gbk_srt).unwrap();
        std::fs::write(work_dir.join("empty.txt"), b"").unwrap();

        let mut cand = candidate(&source);
        cand.entries.push(CandidateEntry {
            logical_path: "readme.txt".to_string(),
            absolute_path: work_dir.join("readme.txt"),
            name: "readme.txt".to_string(),
            kind: "text".to_string(),
            track_key: None,
            format: None,
        });
        cand.entries.push(CandidateEntry {
            logical_path: "01.lrc".to_string(),
            absolute_path: work_dir.join("01.lrc"),
            name: "01.lrc".to_string(),
            kind: "subtitle".to_string(),
            track_key: None,
            format: None,
        });
        cand.entries.push(CandidateEntry {
            logical_path: "01.srt".to_string(),
            absolute_path: work_dir.join("01.srt"),
            name: "01.srt".to_string(),
            kind: "subtitle".to_string(),
            track_key: None,
            format: None,
        });
        cand.entries.push(CandidateEntry {
            logical_path: "empty.txt".to_string(),
            absolute_path: work_dir.join("empty.txt"),
            name: "empty.txt".to_string(),
            kind: "text".to_string(),
            track_key: None,
            format: None,
        });

        let outcome = ingest_candidate(&mut library, &cand, None, &[source.clone()], &source).unwrap();
        let entries = outcome.work["entries"].as_array().unwrap();
        let mime_of = |logical: &str| -> String {
            entries
                .iter()
                .find(|e| e["logicalPath"] == logical)
                .unwrap()["mime"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(mime_of("01.mp3"), "audio/mpeg");
        assert_eq!(mime_of("readme.txt"), "text/plain; charset=shift_jis");
        assert_eq!(mime_of("01.lrc"), "text/plain; charset=shift_jis");
        assert_eq!(mime_of("01.srt"), "application/x-subrip; charset=gbk");
        assert_eq!(mime_of("empty.txt"), "text/plain");
    }
}
