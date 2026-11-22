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

use std::path::{Path, PathBuf};

use storage_core::error::{Error, Result};
use storage_core::hash::sha256_text;
use storage_core::jsonutil::now_iso;
use storage_core::library::{ImportOutcome, Library, MergeOutcome, SourceRecord};
use storage_core::paths;
use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

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
pub fn source_record_from_candidate(candidate: &Candidate, allowed_roots: &[PathBuf]) -> Result<SourceRecord> {
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
            "sourcePath": absolute.to_string_lossy(),
            "mime": mime_for(if entry.name.is_empty() { &logical_path } else { &entry.name }),
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
            "sourcePath": cover_path.to_string_lossy(),
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
pub fn ingest_candidate(
    library: &mut Library,
    candidate: &Candidate,
    idempotency_key: Option<&str>,
    allowed_roots: &[PathBuf],
) -> Result<IngestOutcome> {
    let record = source_record_from_candidate(candidate, allowed_roots)?;
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
        let outcome = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()]).unwrap();
        assert_eq!(outcome.work["title"], "title");
        // Identity still comes from the RJ code, never from the cleaned title.
        let code: String = library
            .connection
            .query_row("SELECT source_code FROM source_ref LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(code, "RJ01678051");
    }

    #[test]
    fn rescan_merges_instead_of_importing_twice() {
        let (mut library, source) = fixture();
        let first = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()]).unwrap();
        let work_id = first.work["workId"].as_str().unwrap().to_string();
        let second = ingest_candidate(&mut library, &candidate(&source), None, &[source.clone()]).unwrap();
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
        let error = ingest_candidate(&mut library, &bad, None, &[source.clone()]).unwrap_err();
        assert!(error.message.contains("entry escapes candidate root"), "{}", error.message);
    }

    #[test]
    fn unauthorized_root_is_rejected() {
        let (mut library, source) = fixture();
        let other = std::env::temp_dir().join(format!("mono-ingest-other-{}", uuid::Uuid::new_v4()));
        let error = ingest_candidate(&mut library, &candidate(&source), None, &[other]).unwrap_err();
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
}
