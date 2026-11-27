//! Host adapter (`host.mjs`): the surface `host-server.mjs` calls.
//!
//! This module orchestrates the core; it does not own storage logic. Every method
//! here maps to one Node method with the same name, and the JSON shapes are the
//! wire contract the frontend consumes — `listWorks()` in particular is polled
//! every 5 s and its field names are load-bearing.
//!
//! Deliberate deviations from Node are listed in `docs/18-server.md`. The
//! two that touch this file: `listWorks()` emits `duration`/`workRoot` (which the
//! frontend reads but Node never sent), and cover detection only accepts a root
//! `folder.*` or an explicit `kind=cover` entry (D3).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use storage_core::error::{Error, Result};
use storage_core::hash;
use storage_core::jsonutil::{manifest_entries, now_iso, parse_object};
use storage_core::library::{Library, OpenOptions};
use storage_core::snapshot::SnapshotFault;
use storage_core::paths;


use crate::ingest::{self, Candidate, CandidateEntry, CoverCandidate};

/// Root-directory cover names the host accepts (`folder.*`).
fn is_root_folder_cover(logical_path: &str) -> bool {
    // Root means "no directory part": `mp3/folder.jpg` is a per-format copy,
    // not the work cover. The sidecar cover written by `cache_work_cover` is
    // also authoritative, so `.monochrome/folder.*` counts as root.
    let normalized = logical_path.replace('\\', "/");
    let rest = normalized.strip_prefix(".monochrome/").unwrap_or(&normalized);
    !rest.contains('/') && is_folder_cover_name(rest)
}

/// `folder.{jpg,jpeg,png,webp,avif}`, case-insensitive (Node's regex set).
fn is_folder_cover_name(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "folder.jpg" | "folder.jpeg" | "folder.png" | "folder.webp" | "folder.avif"
    )
}

/// `folder.*` anywhere (used by delete/reconcile, which tolerate legacy layouts).
fn is_any_folder_cover(logical_path: &str) -> bool {
    let normalized = logical_path.replace('\\', "/");
    is_folder_cover_name(normalized.rsplit('/').next().unwrap_or(&normalized))
}

/// `.monochrome/folder.jpg` — the canonical cover location.
fn is_sidecar_cover(logical_path: &str) -> bool {
    logical_path.starts_with(".monochrome/folder.") || logical_path.contains("/.monochrome/folder.")
}

/// Paths that are cover artifacts, not user content (`isCoverPath`).
fn is_cover_path(logical_path: &str) -> bool {
    let normalized = logical_path.replace('\\', "/");
    is_any_folder_cover(&normalized)
        || normalized.contains("/cover/")
        || normalized.starts_with("cover/")
        || is_sidecar_cover(&normalized)
}

/// JavaScript truthiness for a JSON value (`if (value)`).
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0 && !n.is_nan()).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Options for opening a host.
#[derive(Debug, Clone)]
pub struct HostOptions {
    pub library_root: PathBuf,
    pub source_root: Option<PathBuf>,
    pub allowed_source_roots: Vec<PathBuf>,
    pub allow_outside_root: bool,
    pub experiment_root: Option<PathBuf>,
    pub snapshot_fault: Option<SnapshotFault>,
}

/// One open host: a library plus the source-root authorization it was opened with.
pub struct Host {
    pub library: Library,
    pub source_root: Option<PathBuf>,
    pub allowed_source_roots: Vec<PathBuf>,
    /// Whether the library root may live outside the experiment root (the
    /// production host passes `true`). Kept for callers that report it.
    pub allow_outside_root: bool,
    /// Experiment root (`<project>/.cache/storage-lab` in Node). Backup, restore
    /// and export destinations must lie below it; `None` refuses them all.
    pub experiment_root: Option<PathBuf>,
    /// Root used by the last scan, needed to re-anchor redacted preview paths.
    last_scan_root: Option<PathBuf>,
    /// Redacted preview from the last `/api/scan`, consumed by `/api/import`.
    pub preview: Option<Value>,
}

impl Host {
    /// Open a host (`createHost`).
    pub fn open(options: HostOptions) -> Result<Self> {
        let allowed = normalize_allowed_roots(&options.allowed_source_roots)?;
        let source_root = options.source_root.clone().map(|path| paths::resolve_lexical(&path));
        let experiment = options
            .experiment_root
            .clone()
            .or_else(|| std::env::var("MONOCHROME_EXPERIMENT_ROOT").ok().filter(|value| !value.is_empty()).map(PathBuf::from))
            .map(|path| paths::resolve_lexical(&path));
        if let Some(source) = &source_root {
            // The source is an authorization decision: it must be named explicitly
            // and must be a real directory, never a symlink/junction. Like Node,
            // anything under the experiment root is implicitly allowed (tests).
            let inside_experiment = experiment.as_ref().map(|root| paths::is_inside(root, source)).unwrap_or(false);
            let authorized = inside_experiment || allowed.iter().any(|root| paths::is_inside(root, source));
            if !authorized {
                return Err(Error::outside(
                    "sourceRoot is outside the experiment root and not in allowedSourceRoots",
                ));
            }
        }
        let library = Library::open(
            &options.library_root,
            OpenOptions {
                create: true,
                allow_outside_root: options.allow_outside_root,
                experiment_root: experiment.clone(),
                snapshot_fault: options.snapshot_fault,
            },
        )?;

        // `entry.original_path` is absolute, and layout v2 puts source folders one
        // level deeper (`voices/<work>`). Only the host knows the source root, so
        // the library's own migration could not rewrite it. Idempotent.
        // Layout v2 splits the source root by content type. Move the folders before
        // rewriting `entry.original_path`, so the rewrite describes a tree that
        // already exists. Both steps are idempotent.
        if let Some(source) = &source_root {
            storage_core::layout::migrate_source_dirs(source, Some(&library.root))?;
        }
        storage_core::layout::migrate_rows(&library.connection, source_root.as_deref())?;
        // Creation attachments are user content kept under the old library-root
        // tree; they move into the source root's readable folders once, before
        // any request can address them. Only the host knows the source root.
        if let Some(source) = &source_root {
            storage_core::layout::migrate_creation_assets(&library.connection, &library.root, source)?;
        }
        // Backfill detected `charset=` on pre-existing text/subtitle rows so
        // Shift-JIS/GBK files imported by earlier builds also decode cleanly.
        ingest::migrate_text_charsets(&library.connection, &library.data_root, source_root.as_deref())?;

        // A previous host process cannot have a live worker: we hold the lease.
        // Mark its unfinished batches interrupted so the UI does not poll forever.
        let timestamp = now_iso();
        let _ = library.connection.execute(
            "UPDATE import_batch SET status = 'interrupted', updated_at = ? WHERE status = 'running'",
            rusqlite::params![timestamp],
        );
        let _ = library.connection.execute(
            "UPDATE import_batch_progress SET status = 'interrupted', phase = 'interrupted',
                message = 'host restarted before the batch finished', updated_at = ?
             WHERE status = 'running'",
            rusqlite::params![timestamp],
        );

        Ok(Self {
            library,
            source_root,
            allowed_source_roots: allowed,
            allow_outside_root: options.allow_outside_root,
            experiment_root: experiment,
            last_scan_root: None,
            preview: None,
        })
    }

    /// Confine a backup/restore/export path to the experiment root
    /// (`assertInsideExperiment`). The root itself is refused, like Node.
    pub fn confine_to_experiment(&self, path: &Path) -> Result<PathBuf> {
        let absolute = paths::resolve_lexical(path);
        match &self.experiment_root {
            Some(root) if paths::is_inside(root, &absolute) && paths::resolve_lexical(root) != absolute => Ok(absolute),
            _ => Err(Error::outside(format!("path escapes experiment root: {}", path.display()))),
        }
    }

    pub fn library_id(&self) -> &str {
        &self.library.library_id
    }

    pub fn data_root(&self) -> &Path {
        &self.library.data_root
    }

    /// The real work root on disk, or `None` when it cannot be recovered.
    ///
    /// Prefers the source snapshot's absolute entry path (authoritative at import
    /// time) and falls back to the first entry's `original_path`. Entry logical
    /// paths are relative to the work root, so the root is whatever remains after
    /// walking up one component per logical segment.
    pub fn work_root_for_work(&self, work_id: &str) -> Result<Option<PathBuf>> {
        let exists: Option<i64> = self
            .library
            .connection
            .query_row(
                "SELECT 1 FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(None);
        }
        let snapshot_json: Option<String> = self
            .library
            .connection
            .query_row(
                "SELECT snapshot_json FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(text) = snapshot_json {
            if let Ok(snapshot) = serde_json::from_str::<Value>(&text) {
                if let Some(first) = snapshot
                    .get("sourceRecord")
                    .and_then(|record| record.get("entries"))
                    .and_then(Value::as_array)
                    .and_then(|entries| entries.first())
                {
                    let source_path = first.get("sourcePath").and_then(Value::as_str).unwrap_or("");
                    let logical = first
                        .get("logicalPath")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // The snapshot is written by the ingest layer, which stores the
                    // path source-root relative since phase 2a; older snapshots are
                    // absolute. Resolve instead of assuming one shape.
                    let resolved = storage_core::layout::resolve_stored_path(self.source_root.as_deref(), source_path);
                    if let Some(mut current) = resolved {
                        if !logical.is_empty() {
                            for _ in logical.split('/').filter(|part| !part.is_empty()) {
                                match current.parent() {
                                    Some(parent) => current = parent.to_path_buf(),
                                    None => break,
                                }
                            }
                            let inside = match &self.source_root {
                                Some(root) => paths::is_inside(root, &current),
                                None => false,
                            };
                            if inside && current.exists() {
                                return Ok(Some(current));
                            }
                        }
                    }
                }
            }
        }
        let entry: Option<(String, String)> = self
            .library
            .connection
            .query_row(
                "SELECT original_path, logical_path FROM entry WHERE work_id = ? LIMIT 1",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((original_path, logical)) = entry {
            // Layout v2 stores this relative to the source root; older rows are
            // absolute. The resolver accepts both, and a path it cannot place is
            // "unknown work root", not a guess.
            if let Some(mut current) = storage_core::layout::resolve_stored_path(self.source_root.as_deref(), &original_path) {
                for _ in logical.split('/').filter(|part| !part.is_empty()) {
                    match current.parent() {
                        Some(parent) => current = parent.to_path_buf(),
                        None => break,
                    }
                }
                if let Some(root) = &self.source_root {
                    if paths::is_inside(root, &current) {
                        return Ok(Some(current));
                    }
                }
            }
        }
        Ok(None)
    }

    /// `listWorks()`: the complete, signed-ready work projection.
    ///
    /// Field names and order are the wire contract, checked against Node by
    /// `verify/storage-lab/rust-diff.mjs`. `entryId`/`mediaPath` use the row's
    /// `entry_id` (what `/media/<id>` resolves), not the stable id. Durations are
    /// not projected: the frontend reads them from `userMeta.durations`.
    pub fn list_works(&self) -> Result<Value> {
        let mut statement = self.library.connection.prepare(
            "SELECT * FROM work WHERE deleted_at IS NULL ORDER BY created_at, work_id",
        )?;
        let works: Vec<(String, String, Option<String>, String, String, String, Option<String>, Option<String>, i64, String, String)> =
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>("work_id")?,
                        row.get::<_, String>("title")?,
                        row.get::<_, Option<String>>("user_title")?,
                        row.get::<_, String>("user_meta_json")?,
                        row.get::<_, String>("circle")?,
                        row.get::<_, String>("cv_json")?,
                        row.get::<_, Option<String>>("language")?,
                        row.get::<_, Option<String>>("role")?,
                        row.get::<_, i64>("revision")?,
                        row.get::<_, String>("created_at")?,
                        row.get::<_, String>("updated_at")?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);

        let mut result = Vec::with_capacity(works.len());
        for (
            work_id,
            title,
            user_title,
            user_meta_json,
            circle,
            cv_json,
            language,
            role,
            revision,
            created_at,
            updated_at,
        ) in works
        {
            let work_root = self
                .work_root_for_work(&work_id)?
                .and_then(|root| {
                    self.source_root
                        .as_ref()
                        .map(|source| paths::relative_slash(source, &root))
                        .filter(|relative| !relative.is_empty())
                })
                .unwrap_or_default();

            let mut entry_statement = self.library.connection.prepare(
                "SELECT e.entry_id, e.stable_entry_id, e.logical_path, e.kind, e.mime,
                        e.display_title, e.sort_order, a.asset_id, a.sha256, a.bytes,
                        a.rel_path, a.mime AS asset_mime
                 FROM entry e
                 LEFT JOIN asset_ref r ON r.entry_id = e.entry_id
                 LEFT JOIN asset a ON a.asset_id = r.asset_id
                 WHERE e.work_id = ?
                 ORDER BY e.sort_order, e.entry_id",
            )?;
            struct EntryRow {
                entry_id: String,
                stable_entry_id: String,
                logical_path: String,
                kind: String,
                mime: Option<String>,
                display_title: Option<String>,
                asset_id: Option<String>,
                sha256: Option<String>,
                bytes: Option<i64>,
                asset_mime: Option<String>,
            }
            let rows: Vec<EntryRow> = entry_statement
                .query_map(rusqlite::params![work_id], |row| {
                    Ok(EntryRow {
                        entry_id: row.get(0)?,
                        stable_entry_id: row.get(1)?,
                        logical_path: row.get(2)?,
                        kind: row.get(3)?,
                        mime: row.get(4)?,
                        display_title: row.get(5)?,
                        asset_id: row.get(7)?,
                        sha256: row.get(8)?,
                        bytes: row.get(9)?,
                        asset_mime: row.get(11)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(entry_statement);

            // Cover (D3): Node takes the first entry in sort order matching any of
            // `kind=cover`, root/sidecar `folder.*`, or a nested `folder.*`, so a
            // per-format `mp3/folder.jpg` sorting first beat the explicit cover.
            // Rust prefers authoritative covers and keeps the nested match only as
            // a fallback, so no work loses a cover Node would have shown. An
            // arbitrary image is never a cover in either backend.
            let cover = rows
                .iter()
                .find(|entry| {
                    entry.asset_id.is_some()
                        && (entry.kind == "cover"
                            || (entry.kind == "image" && is_root_folder_cover(&entry.logical_path)))
                })
                .or_else(|| {
                    rows.iter().find(|entry| {
                        entry.asset_id.is_some() && entry.kind == "image" && is_any_folder_cover(&entry.logical_path)
                    })
                });

            let source: Option<(String, String, Option<String>)> = self
                .library
                .connection
                .query_row(
                    "SELECT provider, source_code, source_url FROM source_ref
                     WHERE work_id = ? ORDER BY source_ref_id LIMIT 1",
                    rusqlite::params![work_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;

            let user_meta = parse_object(Some(&user_meta_json));

            let entries: Vec<Value> = rows
                .iter()
                .map(|entry| {
                    // `entryId` is the row id, not the stable id: `/media/<id>`
                    // resolves by entry_id and the frontend matches tracks by it.
                    json!({
                        "entryId": entry.entry_id,
                        "stableEntryId": entry.stable_entry_id,
                        "logicalPath": entry.logical_path,
                        "kind": entry.kind,
                        // Same as Node's `entry.mime || entry.asset_mime || null`:
                        // an empty string is "absent", not a value.
                        "mime": entry.mime.clone().filter(|value| !value.is_empty()).or_else(|| entry.asset_mime.clone()),
                        "displayTitle": entry.display_title,
                        "bytes": entry.bytes,
                        "sha256": entry.sha256,
                        "mediaPath": entry
                            .asset_id
                            .as_ref()
                            .map(|_| format!("/media/{}", percent_encode(&entry.entry_id))),
                    })
                })
                .collect();

            result.push(json!({
                "workId": work_id,
                "workRoot": work_root,
                "title": title,
                "userTitle": user_title,
                "userMeta": user_meta,
                "circle": circle,
                "cvs": storage_core::jsonutil::parse_string_array(Some(&cv_json)),
                "language": language,
                "role": role,
                "revision": revision,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "source": source.map(|(provider, source_code, source_url)| json!({
                    "provider": provider,
                    "sourceCode": source_code,
                    "sourceUrl": source_url.unwrap_or_default(),
                })),
                "coverMediaPath": cover.map(|entry| format!("/media/{}", percent_encode(&entry.entry_id))),
                "entries": entries,
            }));
        }
        Ok(Value::Array(result))
    }

    /// Import one already-downloaded source file (`importFile`).
    ///
    /// The Kikoeru pipeline calls this once per completed file; it must not
    /// rescan or rehash the whole work. Metadata patches are applied after the
    /// ingest so a stale plan conflict cannot lose the newest title/edition data.
    pub fn import_file(&mut self, input: &Value) -> Result<Value> {
        let source_root = self
            .source_root
            .clone()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        // Clients speak bare source-relative paths; the layout decides the type
        // directory (`voices/`). Already-prefixed paths pass through unchanged, so
        // a caller that scanned first is unaffected.
        let relative_path = storage_core::layout::normalize_source_relative(&normalize_relative(
            require_string(input, "relativePath")?.to_string(),
        ));
        let work_root = {
            let raw = input.get("workRoot").and_then(Value::as_str).unwrap_or("");
            if raw.is_empty() {
                // `<type>/<work>`: the work root is the first two segments.
                let mut parts = relative_path.split('/');
                let type_dir = parts.next().unwrap_or("");
                match parts.next() {
                    Some(work) if !work.is_empty() => format!("{type_dir}/{work}"),
                    _ => type_dir.to_string(),
                }
            } else {
                storage_core::layout::normalize_source_relative(&normalize_relative(raw.to_string()))
            }
        };
        if relative_path.is_empty() || work_root.is_empty() {
            return Err(Error::bad_request("relativePath and workRoot are required"));
        }
        let root = paths::resolve_lexical(&source_root.join(work_root.replace('/', std::path::MAIN_SEPARATOR_STR)));
        let absolute = paths::resolve_lexical(&source_root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR)));
        if !paths::is_inside(&source_root, &root) || !paths::is_inside(&root, &absolute) {
            return Err(Error::path_denied("import file is outside the work root"));
        }
        let info = std::fs::metadata(&absolute)?;
        if !info.is_file() {
            return Err(Error::bad_request("import file must be a regular file"));
        }
        // Symlink check on the final component and every ancestor within the root.
        if std::fs::symlink_metadata(&absolute)?.file_type().is_symlink() {
            return Err(Error::bad_request("import file must be a regular file"));
        }

        let logical_path = paths::relative_slash(&root, &absolute);
        let extension = absolute
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let kind = match extension.as_str() {
            ".mp3" | ".wav" | ".flac" | ".aac" | ".m4a" | ".ogg" | ".opus" | ".wma" | ".aiff" | ".aif" => "audio",
            ".srt" | ".vtt" | ".ass" | ".ssa" | ".lrc" | ".sub" => "subtitle",
            ".jpg" | ".jpeg" | ".png" | ".webp" | ".gif" | ".bmp" | ".avif" => "image",
            ".zip" | ".rar" | ".7z" | ".tar" | ".gz" => "archive",
            _ => "text",
        };

        let target_work_id = input
            .get("workId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let target_source_code: Option<String> = match &target_work_id {
            Some(work_id) => self
                .library
                .connection
                .query_row(
                    "SELECT w.work_id,
                        (SELECT source_code FROM source_ref WHERE work_id = w.work_id ORDER BY source_ref_id LIMIT 1) AS source_code
                     FROM work w WHERE w.work_id = ? AND w.deleted_at IS NULL",
                    rusqlite::params![work_id],
                    |row| row.get(1),
                )
                .optional()?
                .flatten(),
            None => None,
        };
        let metadata = input.get("metadata").and_then(Value::as_object);
        let candidate_source_code = target_source_code
            .clone()
            .or_else(|| metadata.and_then(|map| map.get("sourceCode")).and_then(Value::as_str).map(str::to_string))
            .and_then(|value| extract_rj(&value))
            .unwrap_or_default();

        let candidate = Candidate {
            candidate_id: format!("local:{work_root}"),
            relative_root: work_root.clone(),
            root_path: root.clone(),
            folder_title: metadata
                .and_then(|map| map.get("title"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    root.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| work_root.clone())
                }),
            circle: metadata
                .and_then(|map| map.get("circle"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            cvs: metadata
                .and_then(|map| map.get("cvs"))
                .and_then(Value::as_array)
                .map(|items| items.iter().map(storage_core::jsonutil::string_of).collect())
                .unwrap_or_default(),
            source_code: candidate_source_code.clone(),
            family_id: None,
            metadata: metadata.cloned(),
            cover: None,
            entries: vec![CandidateEntry {
                logical_path,
                absolute_path: absolute.clone(),
                name: absolute
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                kind: kind.to_string(),
                track_key: None,
                format: None,
            }],
        };

        let file_key = format!(
            "local:file:{relative_path}:{}:{}:{}:{}",
            info.len(),
            info.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            candidate_source_code.to_uppercase(),
            target_work_id.clone().unwrap_or_default()
        );
        let outcome = match ingest::ingest_candidate(&mut self.library, &candidate, Some(&file_key), &self.allowed_source_roots, &source_root) {
            Ok(value) => value,
            Err(error) if error.code == Some("EIDEMPOTENCYCONFLICT") => {
                // A downloaded file can be retried with newer metadata while the
                // same path keeps an older job. Do not surface a stale plan
                // conflict for file imports.
                let retry_key = format!("{file_key}:retry:{}", storage_core::jsonutil::now_iso());
                ingest::ingest_candidate(&mut self.library, &candidate, Some(&retry_key), &self.allowed_source_roots, &source_root)?
            }
            Err(error) => return Err(error),
        };

        let work_id = outcome
            .work
            .get("workId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        if !work_id.is_empty() {
            // Same patch Node builds: truthy title/circle, array cvs, then the
            // pass-through keys (sourceCode only when no target work pins it).
            let empty = Map::new();
            let meta = metadata.unwrap_or(&empty);
            let mut patch = Map::new();
            if let Some(code) = &target_source_code {
                patch.insert("sourceCode".to_string(), json!(code));
            }
            for key in ["title", "circle"] {
                if let Some(value) = meta.get(key).filter(|value| js_truthy(value)) {
                    patch.insert(key.to_string(), json!(storage_core::jsonutil::string_of(value)));
                }
            }
            if let Some(value) = meta.get("cvs").filter(|value| value.is_array()) {
                patch.insert("cvs".to_string(), value.clone());
            }
            for key in [
                "tags", "rating", "ratingCount", "price", "currency", "release", "ageCategory", "nsfw",
                "editionLang", "editionLabel", "sourceUrl", "pageUrl", "manifest", "sourceCode",
                // `translators` belongs next to `trueCircle`: a translated
                // edition carries its translator in `circle`, so the original
                // circle and the translator must both survive the import.
                "originalCode", "editionCodes", "artists", "trueCircle", "translators",
            ] {
                if key == "sourceCode" && target_source_code.is_some() {
                    continue;
                }
                // `undefined` is skipped in Node; JSON has no undefined, so any
                // present key (including null) is forwarded, as JSON.parse would.
                if let Some(value) = meta.get(key) {
                    // The download pipeline sends `ageCategory: ''` when it has no
                    // rating, and an empty string must not erase a stored one
                    // (`save_voice_bundle` already skips it).
                    if key == "ageCategory" && value.as_str().map(str::trim).unwrap_or("").is_empty() {
                        continue;
                    }
                    patch.insert(key.to_string(), value.clone());
                }
            }
            if !patch.is_empty() {
                let _ = self.library.update_work_metadata(&work_id, &patch);
            }
            let _ = self.dedupe_work_content(&work_id);
        }
        Ok(outcome.to_json())
    }

    /// One physical file per sha256 inside a work (`dedupeWorkContent`).
    ///
    /// A second edition often contains byte-identical audio under another logical
    /// path. Keep the first file and mark the duplicate manifest entry `aliasOf`
    /// so the UI still shows the edition path while the player reuses one file.
    ///
    /// Deviation from Node (D5): before removing a physical file we check that no
    /// *other active work* also references that path. Node removes it
    /// unconditionally, which can delete a file another work still lists.
    pub fn dedupe_work_content(&mut self, work_id: &str) -> Result<usize> {
        let meta_json: Option<String> = self
            .library
            .connection
            .query_row(
                "SELECT user_meta_json FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(meta_json) = meta_json else { return Ok(0) };
        let mut meta = parse_object(Some(&meta_json));
        let Some(mut manifest) = manifest_entries(&meta) else { return Ok(0) };

        /// A file the host actually indexed for this work. `rowid` is the
        /// insertion order of the entry row, i.e. which copy arrived first.
        #[derive(Clone)]
        struct HostFile {
            entry_id: String,
            original: String,
            sha256: Option<String>,
            rowid: i64,
        }
        let entries: Vec<(String, HostFile)> = {
            let mut statement = self.library.connection.prepare(
                "SELECT e.entry_id, e.logical_path, e.original_path,
                    (SELECT a.sha256 FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id
                     WHERE r.entry_id = e.entry_id LIMIT 1) AS sha256,
                    e.rowid
                 FROM entry e WHERE e.work_id = ?",
            )?;
            let rows = statement.query_map(rusqlite::params![work_id], |row| {
                    Ok((
                        row.get::<_, String>(1)?.replace('\\', "/"),
                        HostFile {
                            entry_id: row.get(0)?,
                            original: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            sha256: row.get(3)?,
                            rowid: row.get(4)?,
                        },
                    ))
                })?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let by_logical: HashMap<String, HostFile> = entries.into_iter().collect();
        let logical_of = |entry: &Value| -> String {
            entry.get("logicalPath").and_then(Value::as_str).unwrap_or("").replace('\\', "/")
        };
        let mut changed = false;

        // Deviation D19 (dynamic dedupe). Node compares the manifest's `hash`
        // field, which for a freshly downloaded row is still the Kikoeru track id
        // (`1506849/1725`), not a sha256. The per-file import therefore never
        // matched and duplicates survived until a manual/terminal reconcile
        // rewrote the hashes from disk. The host already knows the real sha256 of
        // every indexed file, so a row whose path is a live host entry takes that
        // sha256 (and is local) before comparing.
        for entry in manifest.iter_mut() {
            let logical = logical_of(entry);
            let Some(sha) = by_logical.get(&logical).and_then(|file| file.sha256.clone()) else { continue };
            let Some(object) = entry.as_object_mut() else { continue };
            if object.get("hash").and_then(Value::as_str) != Some(sha.as_str()) {
                object.insert("hash".to_string(), json!(sha));
                changed = true;
            }
            if object.get("status").and_then(Value::as_str) != Some("local") {
                object.insert("status".to_string(), json!("local"));
                changed = true;
            }
        }

        // One logical path can arrive as several rows: the frontend builds a row
        // per edition (`edition::path` key) and a synthetic row with no
        // `editionCode` from the host entries. They describe the same file, so
        // they must collapse to a single row or the loop below would alias them
        // to each other and delete the only copy.
        //
        // Which row survives matters for the UI: `editionCode` decides which
        // edition's track list shows the row, so the survivor must keep the
        // edition that actually claims this path — a translated edition whose
        // row was dropped renders its track as missing even though the bytes are
        // there. The alias/local state of the dropped rows is carried over
        // because the host writes it on the row it created, not necessarily on
        // the row the frontend rewrote last.
        struct PathGroup {
            logical: String,
            /// Editions in appearance order; empty when only anonymous rows.
            editions: Vec<String>,
            /// Edition of the first row that does not carry `aliasOf`. That row
            /// is the one an edition track list owns this path through; host-made
            /// alias rows (tagged with the original edition by reconcile) must not
            /// take the path away from it.
            owner: Option<String>,
            alias: Option<String>,
            hash: Option<String>,
        }
        let mut groups: Vec<PathGroup> = Vec::new();
        for entry in manifest.iter() {
            let logical = logical_of(entry);
            let edition = entry.get("editionCode").and_then(Value::as_str).unwrap_or("").to_string();
            let alias = entry.get("aliasOf").and_then(Value::as_str).map(str::to_string);
            let hash = entry.get("hash").and_then(Value::as_str).filter(|h| !h.is_empty()).map(str::to_string);
            let index = match groups.iter().position(|group| group.logical == logical) {
                Some(index) => index,
                None => {
                    groups.push(PathGroup {
                        logical: logical.clone(),
                        editions: Vec::new(),
                        owner: None,
                        alias: None,
                        hash: None,
                    });
                    groups.len() - 1
                }
            };
            let group = &mut groups[index];
            if !edition.is_empty() && !group.editions.contains(&edition) {
                group.editions.push(edition.clone());
            }
            if group.owner.is_none() && !edition.is_empty() && alias.is_none() {
                group.owner = Some(edition);
            }
            if group.alias.is_none() {
                group.alias = alias;
            }
            // A downloaded row starts with the Kikoeru track id as `hash`; only a
            // 64-hex value is the content hash that lets the UI find the file.
            let better = |candidate: &str, current: &Option<String>| match current {
                None => true,
                Some(current) => candidate.len() == 64 && current.len() != 64,
            };
            if let Some(candidate) = hash {
                if better(&candidate, &group.hash) {
                    group.hash = Some(candidate);
                }
            }
        }
        let survivor_edition: HashMap<String, String> = groups
            .iter()
            .filter(|group| !group.editions.is_empty())
            .map(|group| {
                let owner = group
                    .owner
                    .clone()
                    .filter(|edition| group.editions.contains(edition))
                    .unwrap_or_else(|| group.editions[0].clone());
                (group.logical.clone(), owner)
            })
            .collect();
        for group in &groups {
            let Some(edition) = survivor_edition.get(&group.logical) else { continue };
            let Some(entry) = manifest
                .iter_mut()
                .find(|entry| logical_of(entry) == group.logical
                    && entry.get("editionCode").and_then(Value::as_str) == Some(edition.as_str()))
            else { continue };
            let Some(object) = entry.as_object_mut() else { continue };
            if let Some(alias) = &group.alias {
                if object.get("aliasOf").is_none() {
                    object.insert("aliasOf".to_string(), json!(alias));
                    changed = true;
                }
            }
            if let Some(hash) = &group.hash {
                if object.get("hash").and_then(Value::as_str).map(|current| current.len()) != Some(hash.len()) {
                    object.insert("hash".to_string(), json!(hash));
                    object.insert("status".to_string(), json!("local"));
                    changed = true;
                }
            }
        }
        let before = manifest.len();
        // Keep exactly one row per path: the edition-tagged survivor when there is
        // one, otherwise the first anonymous row.
        let mut seen_paths: HashSet<String> = HashSet::new();
        manifest.retain(|entry| {
            let logical = logical_of(entry);
            if let Some(edition) = survivor_edition.get(&logical) {
                if entry.get("editionCode").and_then(Value::as_str) != Some(edition.as_str()) {
                    return false;
                }
            }
            seen_paths.insert(logical)
        });
        changed |= manifest.len() != before;

        // A file that was just imported may have no manifest row at all: the
        // download pipeline writes the merged manifest (with the other edition's
        // rows) only after every file of the plan has been imported. Without a
        // row the loop below never sees the file, so the duplicate survived until
        // that final write + reconcile.
        //
        // Only files whose bytes some manifest row already claims get a row here.
        // A row is the frontend's statement of what this work contains, and
        // inventing rows for every indexed file would change the manifest shape
        // Node returns (an import of a work with no manifest would gain entries).
        // The duplicate being deduped always has a same-sha256 row for its copy.
        let claimed_hashes: HashSet<String> = manifest
            .iter()
            .filter(|entry| entry.get("status").and_then(Value::as_str) == Some("local"))
            .filter_map(|entry| entry.get("hash").and_then(Value::as_str).map(str::to_string))
            .filter(|hash| hash.len() == 64)
            .collect();
        let listed: HashSet<String> = manifest.iter().map(|entry| logical_of(entry)).collect();
        let mut unlisted: Vec<(&String, &HostFile)> = by_logical
            .iter()
            .filter(|(logical, file)| {
                file.sha256.as_ref().is_some_and(|sha| claimed_hashes.contains(sha))
                    && !listed.contains(*logical)
                    && !logical.starts_with(".monochrome/")
                    && !is_any_folder_cover(logical)
            })
            .collect();
        unlisted.sort_by_key(|(_, file)| file.rowid);
        for (logical, file) in unlisted {
            let title = logical.rsplit('/').next().unwrap_or(logical);
            manifest.push(json!({
                "logicalPath": logical,
                "title": title,
                "kind": "file",
                "hash": file.sha256.clone().unwrap_or_default(),
                "status": "local",
            }));
            changed = true;
        }

        // Canonical copy per sha256 = the oldest physical file (smallest entry
        // rowid). Node kept whichever row came first in the manifest, which for a
        // work first imported as a translated edition deleted the copy the user
        // had downloaded earlier and kept the new one.
        let mut canonical_by_hash: HashMap<String, (i64, usize, String)> = HashMap::new();
        for (index, entry) in manifest.iter().enumerate() {
            if entry.get("status").and_then(Value::as_str) != Some("local") || entry.get("aliasOf").is_some() {
                continue;
            }
            let Some(hash) = entry.get("hash").and_then(Value::as_str) else { continue };
            let logical = logical_of(entry);
            let rank = by_logical.get(&logical).map(|file| file.rowid).unwrap_or(i64::MAX);
            let candidate = (rank, index, logical);
            match canonical_by_hash.get(hash) {
                Some(current) if (current.0, current.1) <= (candidate.0, candidate.1) => {}
                _ => {
                    canonical_by_hash.insert(hash.to_string(), candidate);
                }
            }
        }

        let mut aliases = 0usize;
        let mut removed = 0usize;
        let mut to_delete: Vec<HostFile> = Vec::new();
        for entry in manifest.iter_mut() {
            if entry.get("status").and_then(Value::as_str) != Some("local") {
                continue;
            }
            let Some(hash) = entry.get("hash").and_then(Value::as_str).map(str::to_string) else {
                continue;
            };
            let logical = logical_of(entry);
            let duplicate = by_logical.get(&logical).cloned();
            if let Some(alias_of) = entry.get("aliasOf").and_then(Value::as_str).map(str::to_string) {
                // An alias normally has no host entry. If a later download wrote the
                // path again, remove the duplicate file/entry but keep the alias row.
                if alias_of.replace('\\', "/") != logical {
                    if let Some(file) = duplicate {
                        to_delete.push(file);
                        removed += 1;
                    }
                }
                continue;
            }
            let Some((_, _, canonical)) = canonical_by_hash.get(&hash) else { continue };
            // Another edition row for the very same path is the same file, not
            // a duplicate of it.
            if *canonical == logical {
                continue;
            }
            if let Some(file) = duplicate {
                to_delete.push(file);
            }
            if let Some(object) = entry.as_object_mut() {
                object.insert("aliasOf".to_string(), json!(canonical));
            }
            aliases += 1;
            removed += 1;
        }

        // Delete files only when no other active work references the same path,
        // then prune the directories the duplicate leaves empty (a translated
        // edition usually lives in its own subtree, e.g. `…_本体/音声文件/mp3`).
        let work_root = if to_delete.is_empty() { None } else { self.work_root_for_work(work_id)? };
        for file in &to_delete {
            // Stored values are source-relative in layout v2 (absolute in older
            // rows); resolve before touching the filesystem, and skip when it cannot
            // be placed — deleting "the relative path as if absolute" would remove
            // something under the process cwd.
            let resolved = storage_core::layout::resolve_stored_path(self.source_root.as_deref(), &file.original);
            if let Some(path) = resolved {
                if !self.path_shared_with_other_work(work_id, &file.original)? {
                    let _ = std::fs::remove_file(&path);
                if let (Some(root), Some(parent)) = (&work_root, path.parent()) {
                    let mut current = parent.to_path_buf();
                    while current != *root && paths::is_inside(root, &current) {
                        if std::fs::remove_dir(&current).is_err() {
                            break;
                        }
                        match current.parent() {
                            Some(next) => current = next.to_path_buf(),
                            None => break,
                        }
                    }
                }
                }
            }
            self.delete_entry_and_assets(&file.entry_id)?;
        }

        if aliases > 0 || removed > 0 || changed {
            let next_manifest = json!({
                "version": 2,
                "generatedAt": now_iso(),
                "entries": manifest,
            });
            meta.insert("manifest".to_string(), next_manifest.clone());
            let patch = json!({ "manifest": next_manifest });
            if let Some(object) = patch.as_object() {
                let _ = self.library.update_work_metadata(work_id, object);
            }
        }
        Ok(aliases)
    }

    /// True when another live work has an entry pointing at `original_path`.
    fn path_shared_with_other_work(&self, work_id: &str, original_path: &str) -> Result<bool> {
        let count: i64 = self.library.connection.query_row(
            "SELECT COUNT(*) FROM entry e JOIN work w ON w.work_id = e.work_id
             WHERE e.work_id <> ? AND w.deleted_at IS NULL AND e.original_path = ?",
            rusqlite::params![work_id, original_path],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Manual rescan of one work against its files on disk (`reconcileWork`).
    pub fn reconcile_work(&mut self, work_id: &str) -> Result<Value> {
        let source_root = self
            .source_root
            .clone()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let row: Option<(String, String)> = self
            .library
            .connection
            .query_row(
                "SELECT title, user_meta_json FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((title, meta_json)) = row else {
            return Err(Error::not_found("work not found"));
        };
        let source_code = self
            .library
            .connection
            .query_row(
                "SELECT source_code FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1",
                rusqlite::params![work_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| extract_rj(&value))
            .unwrap_or_default();
        let root = self
            .work_root_for_work(work_id)?
            .ok_or_else(|| Error::not_found("work root not found"))?;
        let mut meta = parse_object(Some(&meta_json));
        let mut manifest = manifest_entries(&meta).unwrap_or_default();
        let original_code = meta
            .get("originalCode")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                meta.get("editionCodes")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items
                            .iter()
                            .find(|item| item.get("isOriginal").and_then(Value::as_bool) == Some(true))
                            .or_else(|| items.first())
                    })
                    .and_then(|item| item.get("code"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| source_code.clone())
            .to_uppercase();
        for entry in manifest.iter_mut() {
            if entry.get("editionCode").and_then(Value::as_str).unwrap_or("").is_empty() {
                let code = if entry.get("aliasOf").is_some() { &original_code } else { &source_code };
                if let Some(object) = entry.as_object_mut() {
                    object.insert("editionCode".to_string(), json!(code));
                }
            }
        }

        let db_entries: Vec<(String, String, String, Option<i64>, Option<String>)> = {
            let mut statement = self.library.connection.prepare(
                "SELECT e.entry_id, e.logical_path, e.original_path,
                    (SELECT a.bytes FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id
                     WHERE r.entry_id = e.entry_id LIMIT 1) AS bytes,
                    (SELECT a.sha256 FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id
                     WHERE r.entry_id = e.entry_id LIMIT 1) AS sha256
                 FROM entry e WHERE e.work_id = ?",
            )?;
            let rows = statement.query_map(rusqlite::params![work_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
                })?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let by_path: HashMap<String, (Option<i64>, Option<String>)> = db_entries
            .iter()
            .map(|(_, logical, _, bytes, sha)| (logical.replace('\\', "/"), (*bytes, sha.clone())))
            .collect();

        // Walk the real tree, skipping sidecars and covers. Pre-order like
        // Node's recursive readdir (a directory is entered as soon as it is
        // met), because new manifest entries are appended in walk order. No
        // sort: both runtimes return the OS directory order (NTFS: name order),
        // and sorting by code unit would disagree with it on case.
        fn walk_tree(directory: &Path, out: &mut Vec<PathBuf>) {
            let Ok(children) = std::fs::read_dir(directory) else { return };
            for child in children.flatten() {
                let Ok(kind) = child.file_type() else { continue };
                if kind.is_dir() {
                    if !child.file_name().to_string_lossy().starts_with('.') {
                        walk_tree(&child.path(), out);
                    }
                } else if kind.is_file() {
                    out.push(child.path());
                }
            }
        }
        let mut files = Vec::new();
        walk_tree(&root, &mut files);
        let mut actual: Vec<(PathBuf, String, String, u64)> = Vec::new();
        for absolute in files {
            let relative_path = paths::relative_slash(&root, &absolute);
            let lower = relative_path.to_lowercase();
            // Node: `/(^|\/)cover\//i`.
            if relative_path == "folder.jpg" || lower.starts_with("cover/") || lower.contains("/cover/") {
                continue;
            }
            let Ok(info) = std::fs::metadata(&absolute) else { continue };
            let sha = match by_path.get(&relative_path) {
                Some((Some(bytes), Some(sha))) if *bytes == info.len() as i64 => sha.clone(),
                _ => hash::hash_file(&absolute)?.0,
            };
            actual.push((absolute, relative_path, sha, info.len()));
        }

        let actual_paths: HashSet<String> = actual.iter().map(|(_, path, _, _)| path.clone()).collect();
        let actual_hashes: HashSet<String> = actual.iter().map(|(_, _, sha, _)| sha.clone()).collect();
        let mut next_manifest: Vec<Value> = manifest.iter().map(|entry| (*entry).clone()).collect();
        let mut manifest_by_path: HashMap<String, usize> = HashMap::new();
        let mut manifest_by_hash: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, entry) in next_manifest.iter().enumerate() {
            let logical = entry.get("logicalPath").and_then(Value::as_str).unwrap_or("").replace('\\', "/");
            manifest_by_path.insert(logical, index);
            if let Some(hash) = entry.get("hash").and_then(Value::as_str) {
                manifest_by_hash.entry(hash.to_string()).or_default().push(index);
            }
        }
        let mut used: HashSet<usize> = HashSet::new();
        let mut added = 0usize;
        let mut renamed = 0usize;
        let mut removed = 0usize;

        for (_, relative_path, sha, bytes) in &actual {
            let found = manifest_by_path
                .get(relative_path)
                .copied()
                .filter(|index| !used.contains(index))
                .or_else(|| {
                    manifest_by_hash.get(sha).and_then(|candidates| {
                        candidates.iter().copied().find(|index| {
                            if used.contains(index) {
                                return false;
                            }
                            let logical = next_manifest[*index]
                                .get("logicalPath")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .replace('\\', "/");
                            !actual_paths.contains(&logical)
                        })
                    })
                });
            match found {
                Some(index) => {
                    used.insert(index);
                    let entry = &mut next_manifest[index];
                    let previous = entry.get("logicalPath").and_then(Value::as_str).unwrap_or("").to_string();
                    if previous != *relative_path {
                        renamed += 1;
                    }
                    let object = entry.as_object_mut().expect("manifest entries are objects");
                    object.insert("logicalPath".to_string(), json!(relative_path));
                    object.insert(
                        "title".to_string(),
                        json!(relative_path.rsplit('/').next().unwrap_or(relative_path)),
                    );
                    object.insert("hash".to_string(), json!(sha));
                    object.insert("bytes".to_string(), json!(bytes));
                    object.insert("status".to_string(), json!("local"));
                    // A physically present path is canonical again; an old alias
                    // must not make dedupe remove the only remaining copy.
                    object.remove("aliasOf");
                }
                None => {
                    let extension = relative_path.rsplit('.').next().unwrap_or("").to_lowercase();
                    let kind = if ["mp3", "wav", "flac", "m4a", "ogg", "opus"].contains(&extension.as_str()) {
                        "audio"
                    } else {
                        "file"
                    };
                    next_manifest.push(json!({
                        "logicalPath": relative_path,
                        "title": relative_path.rsplit('/').next().unwrap_or(relative_path),
                        "kind": kind,
                        "hash": sha,
                        "editionCode": source_code,
                        "status": "local",
                        "mediaStreamUrl": "",
                        "mediaDownloadUrl": "",
                        "duration": 0,
                        "mime": "",
                        "bytes": bytes,
                    }));
                    used.insert(next_manifest.len() - 1);
                    added += 1;
                }
            }
            if !by_path.contains_key(relative_path) {
                let work_root = paths::relative_slash(&source_root, &root);
                let _ = self.import_file(&json!({
                    "relativePath": format!("{work_root}/{relative_path}"),
                    "workRoot": work_root,
                    "metadata": { "title": title },
                }));
            }
        }

        let alias_local_hashes: HashSet<String> = next_manifest
            .iter()
            .filter(|entry| entry.get("aliasOf").is_some())
            .filter_map(|entry| entry.get("hash").and_then(Value::as_str).map(str::to_string))
            .filter(|hash| actual_hashes.contains(hash))
            .collect();
        for entry in next_manifest.iter_mut() {
            let logical = entry.get("logicalPath").and_then(Value::as_str).unwrap_or("").replace('\\', "/");
            let status = entry.get("status").and_then(Value::as_str).unwrap_or("");
            let hash = entry.get("hash").and_then(Value::as_str).unwrap_or("").to_string();
            if status == "local" && !actual_paths.contains(&logical) && !alias_local_hashes.contains(&hash) {
                if let Some(object) = entry.as_object_mut() {
                    object.insert("status".to_string(), json!("missing"));
                }
                removed += 1;
            }
        }

        // Host entries whose files are gone are removed; the manifest stays the
        // authoritative full list and records their missing state.
        for (entry_id, logical, _, _, _) in &db_entries {
            let normalized = logical.replace('\\', "/");
            if normalized.starts_with(".monochrome/") {
                continue;
            }
            if is_any_folder_cover(&normalized) {
                continue;
            }
            if actual_paths.contains(&normalized) {
                continue;
            }
            self.library
                .connection
                .execute("DELETE FROM entry WHERE entry_id = ?", rusqlite::params![entry_id])?;
        }

        let timestamp = now_iso();
        self.library.connection.execute(
            "UPDATE work SET updated_at = ? WHERE work_id = ?",
            rusqlite::params![timestamp, work_id],
        )?;
        let reconciled = json!({
            "version": 2,
            "generatedAt": timestamp,
            "entries": next_manifest,
        });
        meta.insert("manifest".to_string(), reconciled.clone());
        let patch = json!({ "manifest": reconciled });
        if let Some(object) = patch.as_object() {
            let _ = self.library.update_work_metadata(work_id, object);
        }
        let _ = self.dedupe_work_content(work_id);
        let _ = absolute_unused(&actual);
        Ok(json!({
            "workId": work_id,
            "added": added,
            "renamed": renamed,
            "removed": removed,
            "files": actual.len(),
        }))
    }

    /// Move works to the trash (`deleteWorks`).
    ///
    /// Deleting used to unlink the bytes. It now renames the work folder into
    /// `<data>/trash/<work id>/` and soft-deletes the row; the slot manifest
    /// records the source-relative origin, so [`Self::restore_works`] is a
    /// rename back — nothing to re-import and no metadata to lose.
    ///
    /// A folder shared with another live work is never moved: moving it would
    /// take the survivor's files with it. That work is only soft-deleted, and
    /// its manifest says `moved: false` so restore knows there is nothing to
    /// put back.
    pub fn delete_works(&mut self, work_ids: &[String]) -> Result<Value> {
        if work_ids.is_empty() {
            return Err(Error::bad_request("workIds must be a non-empty array"));
        }
        let mut unique: Vec<String> = Vec::new();
        for id in work_ids {
            if !unique.contains(id) {
                unique.push(id.clone());
            }
        }
        let mut results = Vec::new();
        for work_id in unique {
            match self.trash_one_work(&work_id) {
                Ok(entry) => results.push(json!({
                    "workId": work_id,
                    "ok": true,
                    "deleted": true,
                    "trashed": true,
                    // The frontend reads `folderRemoved: false` to warn that the
                    // folder survived a locked file. With a trash slot the folder
                    // is gone from the source root; a shared root is the only
                    // case where it legitimately stays.
                    "folderRemoved": entry.moved,
                    "moved": entry.moved,
                    "files": entry.files,
                    "bytes": entry.bytes,
                    "originalRoot": entry.original_root,
                    "deletedAt": entry.deleted_at,
                })),
                Err(error) if error.code == Some("ENOTFOUND") => results.push(json!({
                    // Node answers `ok: true, deleted: false` for an id it does
                    // not own: the request succeeded, there was nothing to do.
                    // A work that is already trashed is that same case.
                    "workId": work_id,
                    "ok": true,
                    "deleted": false,
                    "folderRemoved": true,
                })),
                Err(error) => results.push(json!({
                    "workId": work_id,
                    "ok": false,
                    "error": error.message,
                    "code": error.code,
                })),
            }
        }
        let deleted = results
            .iter()
            .filter(|result| result.get("ok").and_then(Value::as_bool) == Some(true))
            .count();
        Ok(json!({ "works": results, "deleted": deleted }))
    }

    /// Soft-delete one work and move its folder into the trash.
    fn trash_one_work(&mut self, work_id: &str) -> Result<storage_core::trash::Entry> {
        let title: Option<String> = self
            .library
            .connection
            .query_row(
                "SELECT title FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(title) = title else {
            return Err(Error::not_found("work not found"));
        };
        let work_root = self.work_root_for_work(work_id)?;
        // Same rule as the old hard delete: a path another live work still
        // references is not ours to move.
        let other_originals: Vec<String> = {
            let mut statement = self.library.connection.prepare(
                "SELECT e.original_path FROM entry e JOIN work w ON w.work_id = e.work_id
                 WHERE e.work_id <> ? AND w.deleted_at IS NULL AND e.original_path IS NOT NULL",
            )?;
            let rows = statement
                .query_map(rusqlite::params![work_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let resolve = |stored: &str| storage_core::layout::resolve_stored_path(self.source_root.as_deref(), stored);
        let shared_root = match (&work_root, &self.source_root) {
            (Some(root), Some(_)) => other_originals
                .iter()
                .filter_map(|other| resolve(other))
                .any(|other| paths::is_inside(root, &other)),
            _ => false,
        };
        let data_root = self.library.data_root.clone();
        let original = match (&work_root, &self.source_root) {
            (Some(root), Some(source)) if paths::is_inside(source, root) && root != source => {
                storage_core::layout::stored_source_path(source, root)
            }
            // Outside the source root, or no source configured: there is no
            // relative path to record, and an absolute one would let a later
            // restore write anywhere. Record nothing.
            _ => String::new(),
        };
        let entry = match (&work_root, &self.source_root) {
            (Some(root), Some(source))
                if paths::is_inside(source, root) && root != source && !shared_root && root.exists() =>
            {
                storage_core::trash::move_into(&data_root, work_id, root, &original, &title)?
            }
            _ => storage_core::trash::record_without_move(&data_root, work_id, &original, &title)?,
        };
        self.library.soft_delete_work(work_id)?;
        Ok(entry)
    }

    /// Restore works from the trash (`restoreWorks`).
    ///
    /// Two cases share one entry point: a slot this host wrote (move the folder
    /// back, then clear `deleted_at`) and a row `/api/cleanup` soft-deleted
    /// without moving anything (clear `deleted_at`, no folder to move).
    pub fn restore_works(&mut self, work_ids: &[String]) -> Result<Value> {
        if work_ids.is_empty() {
            return Err(Error::bad_request("workIds must be a non-empty array"));
        }
        let mut unique: Vec<String> = Vec::new();
        for id in work_ids {
            if !unique.contains(id) {
                unique.push(id.clone());
            }
        }
        let mut results = Vec::new();
        for work_id in unique {
            match self.restore_one_work(&work_id) {
                Ok(payload) => results.push(payload),
                Err(error) => results.push(json!({
                    "workId": work_id,
                    "ok": false,
                    "error": error.message,
                    "code": error.code,
                })),
            }
        }
        let restored = results
            .iter()
            .filter(|result| result.get("ok").and_then(Value::as_bool) == Some(true))
            .count();
        Ok(json!({ "works": results, "restored": restored }))
    }

    fn restore_one_work(&mut self, work_id: &str) -> Result<Value> {
        let data_root = self.library.data_root.clone();
        let slot = storage_core::trash::slot(&data_root, work_id)?;
        let entry = storage_core::trash::read_manifest(&slot);
        let deleted: Option<Option<String>> = self
            .library
            .connection
            .query_row(
                "SELECT deleted_at FROM work WHERE work_id = ?",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        let row_exists = deleted.is_some();
        let row_deleted = matches!(deleted, Some(Some(_)));
        match entry {
            Some(entry) => {
                let mut restored_to = Value::Null;
                if entry.moved {
                    let source = self
                        .source_root
                        .clone()
                        .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
                    let target = storage_core::trash::restore(&data_root, &source, &entry)?;
                    restored_to = json!(target.to_string_lossy());
                }
                if row_deleted {
                    self.library.restore_work(work_id)?;
                }
                storage_core::trash::remove_slot(&data_root, work_id)?;
                Ok(json!({
                    "workId": work_id,
                    "ok": true,
                    "restored": true,
                    "moved": entry.moved,
                    "rootPath": restored_to,
                }))
            }
            None if row_deleted => {
                self.library.restore_work(work_id)?;
                Ok(json!({
                    "workId": work_id,
                    "ok": true,
                    "restored": true,
                    "moved": false,
                    "rootPath": Value::Null,
                }))
            }
            None if row_exists => Err(Error::new("work is not in the trash")),
            None => Err(Error::not_found("work not found")),
        }
    }

    /// What the trash holds, newest first (`listTrash`).
    ///
    /// Two kinds of entry share the list because both are "deleted, not yet
    /// purged" and both are restorable: a slot the delete route moved bytes into,
    /// and a row `/api/cleanup` only soft-deleted (its files were already gone, so
    /// there is nothing to move). Leaving the second kind out would make the
    /// cleanup action permanently invisible — the row is hidden from `/api/works`
    /// and, without an entry here, unreachable from the UI.
    pub fn list_trash(&self) -> Result<Value> {
        let data_root = &self.library.data_root;
        let mut entries: Vec<Value> = storage_core::trash::list(data_root)
            .into_iter()
            .map(|(slot, entry)| entry.to_json(&slot))
            .collect();
        let slotted: HashSet<String> = entries
            .iter()
            .filter_map(|entry| entry.get("workId").and_then(Value::as_str).map(str::to_string))
            .collect();
        let rows: Vec<(String, String, String)> = {
            let mut statement = self.library.connection.prepare(
                "SELECT work_id, title, deleted_at FROM work WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
            )?;
            let mapped = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            mapped
        };
        for (work_id, title, deleted_at) in rows {
            if slotted.contains(&work_id) {
                continue;
            }
            entries.push(json!({
                "workId": work_id,
                "title": title,
                "originalRoot": "",
                "deletedAt": deleted_at,
                "files": 0,
                "bytes": 0,
                "moved": false,
                "slot": "",
            }));
        }
        entries.sort_by(|left, right| {
            let key = |value: &Value| value.get("deletedAt").and_then(Value::as_str).unwrap_or("").to_string();
            key(right).cmp(&key(left))
        });
        let bytes: u64 = entries.iter().filter_map(|entry| entry.get("bytes").and_then(Value::as_u64)).sum();
        let files: u64 = entries.iter().filter_map(|entry| entry.get("files").and_then(Value::as_u64)).sum();
        Ok(json!({ "entries": entries, "total": entries.len(), "bytes": bytes, "files": files }))
    }

    /// Empty the trash (`purgeTrash`).
    ///
    /// With `work_ids` empty every slot and every soft-deleted work is purged;
    /// afterwards the bytes are unrecoverable. With ids, only those.
    pub fn purge_trash(&mut self, work_ids: &[String]) -> Result<Value> {
        let mut targets: Vec<String> = Vec::new();
        if work_ids.is_empty() {
            for (_, entry) in storage_core::trash::list(&self.library.data_root) {
                if !targets.contains(&entry.work_id) {
                    targets.push(entry.work_id);
                }
            }
            let soft: Vec<String> = {
                let mut statement = self
                    .library
                    .connection
                    .prepare("SELECT work_id FROM work WHERE deleted_at IS NOT NULL")?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for work_id in soft {
                if !targets.contains(&work_id) {
                    targets.push(work_id);
                }
            }
        } else {
            for id in work_ids {
                if !targets.contains(id) {
                    targets.push(id.clone());
                }
            }
        }
        let mut results = Vec::new();
        for work_id in targets {
            match self.purge_one_work(&work_id) {
                Ok(()) => results.push(json!({ "workId": work_id, "ok": true })),
                Err(error) => results.push(json!({
                    "workId": work_id,
                    "ok": false,
                    "error": error.message,
                    "code": error.code,
                })),
            }
        }
        let purged = results
            .iter()
            .filter(|result| result.get("ok").and_then(Value::as_bool) == Some(true))
            .count();
        Ok(json!({ "works": results, "purged": purged }))
    }

    /// Remove a trashed work's rows and any asset no other work references.
    ///
    /// A live work is refused: purge is the one irreversible action, and a
    /// mistaken id must not erase a work that is still in the library.
    fn purge_one_work(&mut self, work_id: &str) -> Result<()> {
        let deleted: Option<Option<String>> = self
            .library
            .connection
            .query_row(
                "SELECT deleted_at FROM work WHERE work_id = ?",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(None) = deleted {
            return Err(Error::new("work is not in the trash"));
        }
        let entries: Vec<Option<String>> = {
            let mut statement = self
                .library
                .connection
                .prepare("SELECT original_path FROM entry WHERE work_id = ?")?;
            let rows = statement.query_map(rusqlite::params![work_id], |row| row.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let assets: Vec<(String, String)> = {
            let mut statement = self.library.connection.prepare(
                "SELECT DISTINCT a.asset_id, a.rel_path FROM asset a
                 JOIN asset_ref r ON r.asset_id = a.asset_id WHERE r.work_id = ?",
            )?;
            let rows = statement.query_map(rusqlite::params![work_id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let other_originals: Vec<String> = {
            let mut statement = self.library.connection.prepare(
                "SELECT e.original_path FROM entry e JOIN work w ON w.work_id = e.work_id
                 WHERE e.work_id <> ? AND w.deleted_at IS NULL AND e.original_path IS NOT NULL",
            )?;
            let rows = statement
                .query_map(rusqlite::params![work_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        // Import-job history references committed_work_id without a cascade.
        self.library.connection.execute(
            "UPDATE import_job SET committed_work_id = NULL, committed_at = NULL,
                committed_revision = NULL WHERE committed_work_id = ?",
            rusqlite::params![work_id],
        )?;
        // Hard purge: FK cascade removes entries/refs/source_ref/user_state. A
        // soft-deleted ghost would keep showing up in cleanup/stale listings.
        self.library
            .connection
            .execute("DELETE FROM work WHERE work_id = ?", rusqlite::params![work_id])?;

        for (asset_id, rel_path) in assets {
            let refs: i64 = self.library.connection.query_row(
                "SELECT COUNT(*) FROM asset_ref WHERE asset_id = ?",
                rusqlite::params![asset_id],
                |row| row.get(0),
            )?;
            if refs > 0 {
                continue;
            }
            if !rel_path.is_empty() && !rel_path.starts_with("source/") {
                let asset_path = self.library.data_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                if paths::is_inside(&self.library.data_root, &asset_path) {
                    let _ = std::fs::remove_file(asset_path);
                }
            }
            self.library
                .connection
                .execute("DELETE FROM asset WHERE asset_id = ?", rusqlite::params![asset_id])?;
        }

        storage_core::trash::remove_slot(&self.library.data_root, work_id)?;

        // The work folder itself is already in `trash/` (or never moved). An
        // entry the user relocated elsewhere in the source root is not, and
        // purge is the one action that means "gone for good" — the old hard
        // delete swept these too. A path another live work still references is
        // left alone, exactly as before.
        let resolve = |stored: &str| storage_core::layout::resolve_stored_path(self.source_root.as_deref(), stored);
        for original in entries.into_iter().flatten() {
            if original.is_empty() {
                continue;
            }
            let Some(source) = resolve(&original) else { continue };
            let inside = match &self.source_root {
                Some(root) => paths::is_inside(root, &source),
                None => false,
            };
            if !inside {
                continue;
            }
            if other_originals
                .iter()
                .filter_map(|other| resolve(other))
                .any(|other| other == source)
            {
                continue;
            }
            let _ = std::fs::remove_file(&source);
        }
        Ok(())
    }

    /// Delete selected files from one work (`deleteWorkFiles`).
    ///
    /// The manifest entry stays and only its `status` changes: the file list is the
    /// truth about what the work contains, and shrinking it would make the album
    /// look like it never had those tracks.
    pub fn delete_work_files(&mut self, work_id: &str, logical_paths: &[String]) -> Result<Value> {
        if logical_paths.is_empty() {
            return Err(Error::bad_request("logicalPaths must be a non-empty array"));
        }
        // `title` is needed for the same fallback Node uses when an entry has no
        // `original_path`: the file is assumed to live under <source>/<work title>/.
        let work: Option<(String, String)> = self
            .library
            .connection
            .query_row(
                "SELECT user_meta_json, title FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((meta_json, work_title)) = work else {
            return Err(Error::not_found("work not found"));
        };
        let mut manifest = manifest_entries(&parse_object(Some(&meta_json)));
        let mut deleted: Vec<String> = Vec::new();
        let mut missing: Vec<Value> = Vec::new();
        let mut aliases = 0usize;
        let mut removed_sources: HashSet<String> = HashSet::new();
        let mut unique: Vec<String> = Vec::new();
        for path in logical_paths {
            if !unique.contains(path) {
                unique.push(path.clone());
            }
        }

        for logical_path in unique {
            let normalized = logical_path
                .replace('\\', "/")
                .trim_start_matches('/')
                .to_string();
            if normalized.is_empty() || normalized.split('/').any(|part| part == "..") {
                missing.push(json!({ "path": logical_path, "reason": "invalid path" }));
                continue;
            }
            let entry: Option<(String, Option<String>)> = self
                .library
                .connection
                .query_row(
                    "SELECT entry_id, original_path FROM entry WHERE work_id = ? AND logical_path = ?",
                    rusqlite::params![work_id, normalized],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((entry_id, original_path)) = entry else {
                // An alias has no host entry and no file: informative failure, not a
                // successful removal. Report the canonical target and keep the row.
                let manifest_entry = manifest.as_ref().and_then(|entries| {
                    entries
                        .iter()
                        .find(|item| item.get("logicalPath").and_then(Value::as_str) == Some(normalized.as_str()))
                        .cloned()
                });
                if let Some(alias_of) = manifest_entry
                    .as_ref()
                    .and_then(|entry| entry.get("aliasOf"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    aliases += 1;
                    let canonical_edition = manifest
                        .as_ref()
                        .and_then(|entries| {
                            entries
                                .iter()
                                .find(|item| item.get("logicalPath").and_then(Value::as_str) == Some(alias_of.as_str()))
                        })
                        .and_then(|entry| entry.get("editionCode"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_uppercase();
                    missing.push(json!({
                        "path": logical_path,
                        "reason": "alias",
                        "aliasOf": alias_of,
                        "canonicalEditionCode": canonical_edition,
                    }));
                } else {
                    missing.push(json!({ "path": logical_path, "reason": "entry not found" }));
                }
                continue;
            };

            // Duplicate imports can point at the same file; remove every entry row
            // for that source, otherwise the file stays alive and the folder still
            // looks present in the library.
            let duplicates: Vec<(String, Option<String>)> = match &original_path {
                Some(original) if !original.is_empty() => {
                    let mut statement = self.library.connection.prepare(
                        "SELECT entry_id, original_path FROM entry
                         WHERE original_path = ? AND entry_id <> ?",
                    )?;
                    let rows = statement.query_map(rusqlite::params![original, entry_id], |row| {
                            Ok((row.get(0)?, row.get(1)?))
                        })?.collect::<rusqlite::Result<Vec<_>>>()?;
                    rows
                }
                _ => Vec::new(),
            };

            if let Some(entries) = manifest.as_mut() {
                mark_manifest_remote(entries, &normalized);
            }
            self.delete_entry_and_assets(&entry_id)?;
            for (duplicate_id, _) in duplicates {
                self.delete_entry_and_assets(&duplicate_id)?;
            }

            let source = match &original_path {
                // Layout v2 stores this relative to the source root; older rows are
                // absolute. `unwrap_or_default()` keeps the "cannot place it" case
                // empty, which the `inside` check below refuses.
                Some(original) if !original.is_empty() => storage_core::layout::resolve_stored_path(
                    self.source_root.as_deref(),
                    original,
                )
                .unwrap_or_default(),
                // Same assumption as Node: without an `original_path` the file is
                // <source root>/<work title>/<logical path>. Using only the logical
                // path deleted nothing (and still reported success) for such rows.
                _ => self
                    .source_root
                    .as_ref()
                    .map(|root| {
                        let mut path = root.join(&work_title);
                        for segment in normalized.split('/').filter(|part| !part.is_empty()) {
                            path.push(segment);
                        }
                        path
                    })
                    .unwrap_or_default(),
            };
            let inside = match &self.source_root {
                Some(root) => !source.as_os_str().is_empty() && paths::is_inside(root, &source),
                None => false,
            };
            if inside && !removed_sources.contains(&source.to_string_lossy().to_string()) {
                removed_sources.insert(source.to_string_lossy().to_string());
                let _ = std::fs::remove_file(&source);
                if let (Some(root), Some(parent)) = (&self.source_root, source.parent()) {
                    let mut current = parent.to_path_buf();
                    while current != *root && paths::is_inside(root, &current) {
                        if std::fs::remove_dir(&current).is_err() {
                            break;
                        }
                        match current.parent() {
                            Some(parent) => current = parent.to_path_buf(),
                            None => break,
                        }
                    }
                }
            }
            deleted.push(normalized);
        }

        let manifest_snapshot = manifest.clone();
        if let Some(entries) = manifest {
            let patch = json!({ "manifest": { "version": 2, "entries": entries } });
            if let Some(object) = patch.as_object() {
                let _ = self.library.update_work_metadata(work_id, object);
            }
        }
        self.refresh_work_state(work_id, manifest_snapshot.as_deref())?;
        Ok(json!({
            "deleted": deleted,
            "missing": missing,
            "aliases": aliases,
            "count": deleted.len(),
        }))
    }

    fn delete_entry_and_assets(&self, entry_id: &str) -> Result<()> {
        let assets: Vec<(String, String)> = {
            let mut statement = self.library.connection.prepare(
                "SELECT a.asset_id, a.rel_path FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id
                 WHERE r.entry_id = ?",
            )?;
            let rows = statement.query_map(rusqlite::params![entry_id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        self.library
            .connection
            .execute("DELETE FROM entry WHERE entry_id = ?", rusqlite::params![entry_id])?;
        for (asset_id, rel_path) in assets {
            let refs: i64 = self.library.connection.query_row(
                "SELECT COUNT(*) FROM asset_ref WHERE asset_id = ?",
                rusqlite::params![asset_id],
                |row| row.get(0),
            )?;
            if refs > 0 {
                continue;
            }
            if !rel_path.is_empty() && !rel_path.starts_with("source/") {
                let path = self.library.data_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                if paths::is_inside(&self.library.data_root, &path) {
                    let _ = std::fs::remove_file(path);
                }
            }
            self.library
                .connection
                .execute("DELETE FROM asset WHERE asset_id = ?", rusqlite::params![asset_id])?;
        }
        Ok(())
    }

    /// After a file delete: mark partial, or retire a work that only has covers.
    fn refresh_work_state(&self, work_id: &str, manifest: Option<&[Value]>) -> Result<()> {
        let remaining: Vec<String> = {
            let mut statement = self
                .library
                .connection
                .prepare("SELECT logical_path FROM entry WHERE work_id = ?")?;
            let rows = statement.query_map(rusqlite::params![work_id], |row| row.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        if let Some(entries) = manifest {
            if entries.iter().any(|entry| entry.get("status").and_then(Value::as_str) != Some("local")) {
                let patch = json!({ "partial": true });
                if let Some(object) = patch.as_object() {
                    let _ = self.library.update_work_metadata(work_id, object);
                }
                return Ok(());
            }
        }
        if !remaining.iter().any(|path| !is_cover_path(path)) {
            // Only cover artifacts remain: this is no longer a partial local work.
            // Retire it so the online card returns as a normal remote result.
            let timestamp = now_iso();
            self.library.connection.execute(
                "UPDATE work SET deleted_at = ?, updated_at = ? WHERE work_id = ?",
                rusqlite::params![timestamp, timestamp, work_id],
            )?;
            return Ok(());
        }
        let patch = json!({ "partial": true });
        if let Some(object) = patch.as_object() {
            let _ = self.library.update_work_metadata(work_id, object);
        }
        Ok(())
    }

    /// Delete abandoned `<work>/tmp/import-*` staging directories.
    pub fn cleanup_import_temps(&self, work_root: &str) -> Result<Value> {
        let Some(source) = &self.source_root else {
            return Ok(json!({ "removed": 0, "works": 0 }));
        };
        // Same rule as every other source-relative input: a bare work root maps
        // under its type directory, an already-prefixed one passes through.
        let requested = storage_core::layout::normalize_source_relative(&normalize_relative(work_root.to_string()));
        let mut roots: Vec<PathBuf> = Vec::new();
        if !requested.is_empty() {
            let root = paths::resolve_lexical(&source.join(requested.replace('/', std::path::MAIN_SEPARATOR_STR)));
            if root != *source && !paths::is_inside(source, &root) {
                return Err(Error::path_denied("workRoot is outside the source root"));
            }
            roots.push(root);
        } else if let Ok(children) = std::fs::read_dir(source) {
            for child in children.flatten() {
                if !child.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    continue;
                }
                // Layout v2 keeps works one level down (`voices/<work>`); the
                // category containers themselves are not works and have no staging.
                let name = child.file_name().to_string_lossy().to_string();
                if [storage_core::layout::VOICES, storage_core::layout::VIDEOS, storage_core::layout::CREATIONS]
                    .contains(&name.as_str())
                {
                    if let Ok(type_children) = std::fs::read_dir(child.path()) {
                        for nested in type_children.flatten() {
                            if nested.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                                roots.push(nested.path());
                            }
                        }
                    }
                    continue;
                }
                roots.push(child.path());
            }
        }
        let mut removed = 0usize;
        let mut works = 0usize;
        for root in roots {
            let tmp = root.join("tmp");
            let Ok(entries) = std::fs::read_dir(&tmp) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Only this pipeline's `import-*` staging dirs are ours; a user's
                // unrelated tmp files must never be deleted.
                if !name.starts_with("import-") {
                    continue;
                }
                let _ = std::fs::remove_dir_all(entry.path());
                removed += 1;
            }
            // Windows can briefly keep the directory handle open after the last
            // staging file is removed; retry before leaving it behind.
            for _ in 0..3 {
                if std::fs::remove_dir(&tmp).is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            works += 1;
        }
        Ok(json!({ "removed": removed, "works": works }))
    }

    /// Works whose recorded source files are all gone (`cleanupPreview`).
    pub fn cleanup_preview(&self) -> Result<Value> {
        let mut statement = self.library.connection.prepare(
            "SELECT work_id, title FROM work WHERE deleted_at IS NULL ORDER BY created_at, work_id",
        )?;
        let works: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut stale = Vec::new();
        for (work_id, title) in works {
            let snapshot: Option<String> = self
                .library
                .connection
                .query_row(
                    "SELECT snapshot_json FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1",
                    rusqlite::params![work_id],
                    |row| row.get(0),
                )
                .optional()?;
            let paths_list: Vec<String> = snapshot
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| value.get("sourceRecord").cloned())
                .and_then(|record| record.get("entries").cloned())
                .and_then(|entries| entries.as_array().cloned())
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(|entry| entry.get("sourcePath").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            // Snapshot paths are source-root relative since phase 2a (absolute in
            // older snapshots). Testing the raw string made every work look stale:
            // a relative path is resolved against the process cwd, which never
            // holds the file.
            let missing = paths_list
                .iter()
                .filter(|path| {
                    storage_core::layout::resolve_stored_path(self.source_root.as_deref(), path)
                        .map(|resolved| !resolved.exists())
                        .unwrap_or(true)
                })
                .count();
            if !paths_list.is_empty() && missing == paths_list.len() {
                stale.push(json!({
                    "workId": work_id,
                    "title": title,
                    "missing": missing,
                    "total": paths_list.len(),
                }));
            }
        }
        Ok(json!({ "works": stale, "total": stale.len() }))
    }

    /// Soft-delete works for cleanup (`cleanupWorks`).
    pub fn cleanup_works(&self, work_ids: &[String]) -> Result<Value> {
        if work_ids.is_empty() {
            return Err(Error::bad_request("workIds must be a non-empty array"));
        }
        let mut results = Vec::new();
        let mut unique: Vec<String> = Vec::new();
        for id in work_ids {
            if !unique.contains(id) {
                unique.push(id.clone());
            }
        }
        for work_id in unique {
            match self.library.soft_delete_work(&work_id) {
                Ok(_) => results.push(json!({ "workId": work_id, "ok": true, "deleted": true })),
                Err(error) => results.push(json!({
                    "workId": work_id,
                    "ok": false,
                    "error": error.message,
                    "code": error.code,
                })),
            }
        }
        let deleted = results
            .iter()
            .filter(|result| result.get("ok").and_then(Value::as_bool) == Some(true))
            .count();
        Ok(json!({ "works": results, "deleted": deleted }))
    }

    /// Create/merge a voice work from an online bundle (`saveVoiceBundle`).
    ///
    /// The cover fetch is best-effort by design: a missing cover must not fail a
    /// library import. No `metadata.json`/`manifest.json` sidecar is written — the
    /// database is the only authority (docs/16 §2.6); a human-readable export is a
    /// separate explicit action rather than a second copy kept in sync.
    pub fn save_voice_bundle(&mut self, input: &Value) -> Result<Value> {
        let source_root = self
            .source_root
            .clone()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let metadata = input.get("metadata").and_then(Value::as_object).cloned().unwrap_or_default();
        let root_name = input
            .get("rootName")
            .and_then(Value::as_str)
            .map(|value| value.replace('\\', "/").trim_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| metadata.get("rootName").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        if root_name.is_empty() || root_name.split('/').any(|part| part == "..") {
            return Err(Error::bad_request("rootName is invalid"));
        }
        // Every other write into the source root maps a bare path under its type
        // directory (`import_file`, upload, move, the bundle download). This one
        // did not, so a client that sent a bare `[RJ…] Title` created the work at
        // `<source>/[RJ…] Title` while the same work downloaded file-by-file
        // landed in `<source>/voices/[RJ…] Title` — two folders for one work, and
        // the second import reported a work the first could not see. Already
        // prefixed paths pass through unchanged, so the normal path is unaffected.
        let root_name = storage_core::layout::normalize_source_relative(&root_name);
        let root = paths::resolve_lexical(&source_root.join(root_name.replace('/', std::path::MAIN_SEPARATOR_STR)));
        if !paths::is_inside(&source_root, &root) || root == source_root {
            return Err(Error::path_denied("voice root is outside the source root"));
        }
        // Only the cover lives beside the work. `metadata.json`/`manifest.json`
        // were never read back (the scanner skips `.monochrome`, and the UI only
        // skips it), so all they added was a second write path that could drift
        // from the tables — which is exactly how `circle` went missing. The
        // database is the single authority now.
        let sidecar = root.join(".monochrome");
        std::fs::create_dir_all(&sidecar)?;

        // Cover: an explicit URL first, then the deterministic DLsite CDN path.
        let mut candidates: Vec<String> = Vec::new();
        if let Some(url) = input.get("coverUrl").and_then(Value::as_str).filter(|url| !url.is_empty()) {
            candidates.push(url.to_string());
        }
        let original_cover_code = metadata
            .get("editionCodes")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("isOriginal").and_then(Value::as_bool) == Some(true))
            })
            .and_then(|item| item.get("code"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| metadata.get("originalCode").and_then(Value::as_str).map(str::to_string))
            .or_else(|| metadata.get("sourceCode").and_then(Value::as_str).map(str::to_string))
            .or_else(|| metadata.get("code").and_then(Value::as_str).map(str::to_string))
            .and_then(|value| extract_rj(&value));
        if let Some(code) = original_cover_code {
            let number: u64 = code.trim_start_matches("RJ").parse().unwrap_or(0);
            let block = (((number + 999) / 1000) * 1000).to_string();
            let block = format!("{block:0>8}");
            candidates.push(format!(
                "https://img.dlsite.jp/modpub/images2/work/doujin/RJ{block}/{code}_img_main.webp"
            ));
        }
        for candidate in candidates {
            if let Some(bytes) = fetch_https(&candidate, 20 * 1024 * 1024) {
                if !bytes.is_empty() {
                    let _ = std::fs::write(sidecar.join("folder.jpg"), bytes);
                    break;
                }
            }
        }

        let mut entries = Vec::new();
        // Only the cover lives in `.monochrome`; the json sidecars are gone, so a
        // stale one left by an older build is not indexed either.
        for relative in [".monochrome/folder.jpg"] {
            let absolute = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if std::fs::metadata(&absolute).is_err() {
                continue;
            }
            let kind = if is_any_folder_cover(relative) { "image" } else { "text" };
            entries.push(CandidateEntry {
                logical_path: relative.to_string(),
                absolute_path: absolute,
                name: relative.rsplit('/').next().unwrap_or(relative).to_string(),
                kind: kind.to_string(),
                track_key: None,
                format: None,
            });
        }

        let cover_absent = entries.len() < 3;
        let candidate = Candidate {
            candidate_id: format!("local:{root_name}"),
            relative_root: root_name.clone(),
            root_path: root.clone(),
            folder_title: metadata
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| root_name.clone()),
            circle: metadata.get("circle").and_then(Value::as_str).unwrap_or("").to_string(),
            cvs: metadata
                .get("cvs")
                .or_else(|| metadata.get("artists"))
                .and_then(Value::as_array)
                .map(|items| items.iter().map(storage_core::jsonutil::string_of).collect())
                .unwrap_or_default(),
            source_code: metadata
                .get("sourceCode")
                .or_else(|| metadata.get("code"))
                .and_then(Value::as_str)
                .and_then(extract_rj)
                .unwrap_or_default(),
            family_id: None,
            metadata: Some(metadata.clone()),
            cover: if cover_absent {
                None
            } else {
                Some(CoverCandidate {
                    path: sidecar.join("folder.jpg"),
                    format: None,
                })
            },
            entries,
        };
        let outcome = ingest::ingest_candidate(
            &mut self.library,
            &candidate,
            Some(&format!("local:bundle:{root_name}")),
            &self.allowed_source_roots,
            &source_root,
        )?;
        let work_id = outcome
            .work
            .get("workId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        if !work_id.is_empty() {
            let mut patch = Map::new();
            // Same key set as `import_file`'s patch plus the two edition fields the
            // frontend puts on every bundle (`voiceImportMetadata`). Leaving them
            // out made a work created through `/api/voices/bundle` lose its language
            // and edition label while the same work imported file-by-file kept them.
            for key in [
                "title", "circle", "cvs", "tags", "rating", "ratingCount", "price", "currency",
                "release", "ageCategory", "nsfw", "sourceCode", "editionCodes", "editionLang",
                "editionLabel", "sourceUrl", "pageUrl", "manifest", "originalCode", "artists",
                "trueCircle", "translators",
            ] {
                if let Some(value) = metadata.get(key) {
                    if key == "ageCategory" && value.as_str().map(str::trim).unwrap_or("").is_empty() {
                        continue;
                    }
                    patch.insert(key.to_string(), value.clone());
                }
            }
            // Node persists the top-level `manifest` argument, not `metadata.manifest`:
            // `saveVoiceBundle()` passes `{ rootName, metadata, manifest, coverUrl }`,
            // so the file list lives in `input.manifest`. Copying it only into the
            // sidecar left `user_meta_json.manifest` empty, and a bundle work whose
            // on-disk entries are only `.monochrome/*` (an online work imported
            // before its audio is downloaded) then had zero tracks and was dropped
            // by `refresh()`'s `tracks.length > 0` filter — the card vanished.
            if !metadata.contains_key("manifest") {
                if let Some(value) = input.get("manifest").filter(|value| value.is_object()) {
                    patch.insert("manifest".to_string(), value.clone());
                }
            }
            if !patch.is_empty() {
                let _ = self.library.update_work_metadata(&work_id, &patch);
            }
        }
        // Seed `.monochrome/info.json` from the request's metadata. Write-once: a
        // re-import must not replace a seed a human may have corrected, and the
        // database stays the authority for everything the app displays.
        let _ = storage_core::sidecar::write_if_absent(
            &root,
            &storage_core::sidecar::voice_seed(&metadata, &root_name),
        );
        Ok(outcome.to_json())
    }

    /// Download a remote cover into `.monochrome/folder.jpg` and index it
    /// (`cacheWorkCover`).
    pub fn cache_work_cover(&mut self, work_id: &str, remote_url: &str) -> Result<Value> {
        let source_root = self
            .source_root
            .clone()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let url = remote_url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(Error::bad_request("cover URL must be http(s)"));
        }
        // `user_title` is nullable: a work imported without a user-specified title
        // has NULL there, and reading it as String failed with "Invalid column type
        // Null", so every cover cache returned 500 for freshly imported works.
        let work: Option<(String, Option<String>, String)> = self
            .library
            .connection
            .query_row(
                "SELECT title, user_title, circle FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((title, user_title, circle)) = work else {
            return Err(Error::not_found("work not found"));
        };
        let user_title = user_title.unwrap_or_default();
        let root = self.work_root_for_work(work_id)?;
        let Some(root) = root else {
            return Err(Error::bad_request("work has no source root"));
        };
        let root_name = paths::relative_slash(&source_root, &root);
        if root_name.is_empty() {
            return Err(Error::bad_request("work has no source root"));
        }
        // Same checks and messages as Node: HTTP status, image content type,
        // 0 < size <= 20 MiB. The cap is enforced while reading.
        let fetched = match crate::net::get_bounded(url, 20 * 1024 * 1024, crate::net::COVER_TIMEOUT) {
            Ok(fetched) => fetched,
            Err(error) if error.code == Some("ETOOLARGE") => return Err(Error::new("cover image has an invalid size")),
            Err(error) => return Err(error),
        };
        if !(200..300).contains(&fetched.status) {
            return Err(Error::new(format!("cover download failed: HTTP {}", fetched.status)));
        }
        if !fetched.content_type.is_empty() && !fetched.content_type.to_lowercase().starts_with("image/") {
            return Err(Error::new(format!("cover URL is not an image: {}", fetched.content_type)));
        }
        let body = fetched.body;
        if body.is_empty() {
            return Err(Error::new("cover image has an invalid size"));
        }
        let sidecar = root.join(".monochrome");
        std::fs::create_dir_all(&sidecar)?;
        std::fs::write(sidecar.join("folder.jpg"), &body)?;
        let cvs = self
            .library
            .connection
            .query_row(
                "SELECT cvs FROM (SELECT cv_json AS cvs FROM work WHERE work_id = ?)",
                rusqlite::params![work_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|text| storage_core::jsonutil::parse_string_array(Some(&text)))
            .unwrap_or_default();
        let _ = self.import_file(&json!({
            "relativePath": format!("{root_name}/.monochrome/folder.jpg"),
            "workRoot": root_name,
            "workId": work_id,
            "metadata": {
                "title": if user_title.is_empty() { title } else { user_title },
                "circle": circle,
                "cvs": cvs,
            },
        }));
        Ok(json!({
            "logicalPath": format!("{root_name}/.monochrome/folder.jpg"),
            "bytes": body.len(),
        }))
    }

    /// Rename/merge a work root to the canonical `[RJ][circle] title (CV ...)`
    /// (`normalizeWorkRoot`).
    ///
    /// Deviation from Node (D2): the legacy-folder match uses correct escapes.
    /// Node's `/^[[^]]+]s*/` and `/s*(CV[^)]*)s*$/i` were missing backslashes and
    /// never matched, so a legacy `<RJ>-title` folder was never merged.
    pub fn normalize_work_root(&mut self, work_id: &str, target_root: &str) -> Result<Value> {
        let source_root = self
            .source_root
            .clone()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let row: Option<(String, Option<String>)> = self
            .library
            .connection
            .query_row(
                "SELECT title, (SELECT source_code FROM source_ref WHERE work_id = w.work_id
                    ORDER BY source_ref_id LIMIT 1) AS source_code
                 FROM work w WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((source_name, source_code)) = row else {
            return Err(Error::not_found("work not found"));
        };
        let target_name = target_root.trim();
        if target_name.is_empty() {
            return Ok(json!({ "changed": false, "title": source_name }));
        }
        let mut source = paths::resolve_lexical(&source_root.join(&source_name));
        let target = paths::resolve_lexical(&source_root.join(target_name));
        if !paths::is_inside(&source_root, &source)
            || !paths::is_inside(&source_root, &target)
            || source == source_root
            || target == source_root
        {
            return Err(Error::path_denied("normalize target is outside the source root"));
        }
        let mut source_is_dir = std::fs::metadata(&source).map(|info| info.is_dir()).unwrap_or(false);

        // Find a legacy folder for the same work: `<RJ>-title`, `[RJ] title`, or a
        // dir containing the RJ code / title stem.
        let code = source_code.unwrap_or_default().to_uppercase();
        let title_stem = strip_title_prefix(&source_name);
        if let Ok(children) = std::fs::read_dir(&source_root) {
            for child in children.flatten() {
                if !child.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = child.file_name().to_string_lossy().to_string();
                let upper = name.to_uppercase();
                if paths::resolve_lexical(&child.path()) == target {
                    continue;
                }
                let matches_code = !code.is_empty()
                    && (upper.starts_with(&format!("{code}-"))
                        || upper.starts_with(&format!("[{code}]"))
                        || upper.contains(&code));
                let matches_title = title_stem.chars().count() > 4 && name.contains(&title_stem);
                if matches_code || matches_title {
                    let candidate = child.path();
                    if std::fs::metadata(&candidate).map(|info| info.is_dir()).unwrap_or(false) {
                        source = paths::resolve_lexical(&candidate);
                        source_is_dir = true;
                        break;
                    }
                }
            }
        }

        if source_is_dir && source != target {
            let target_is_dir = std::fs::metadata(&target).map(|info| info.is_dir()).unwrap_or(false);
            if !target_is_dir {
                std::fs::rename(&source, &target)?;
            } else {
                merge_directory(&source, &target)?;
                let _ = std::fs::remove_dir_all(&source);
            }
        }
        // A rename must rewrite every entry/source-snapshot path, or
        // delete/restore/reconcile still points at the old folder. The rewrite goes
        // through the layout helper so a v1 absolute row comes out in the v2
        // relative form instead of re-pinning the folder it just left.
        if source != target {
            let entries: Vec<(String, String)> = {
                let mut statement = self
                    .library
                    .connection
                    .prepare("SELECT entry_id, original_path FROM entry WHERE work_id = ?")?;
                let rows = statement.query_map(rusqlite::params![work_id], |row| {
                        Ok((row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default()))
                    })?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for (entry_id, original) in entries {
                let Some(next) = storage_core::layout::relocated_stored_path(&source_root, &original, &source, &target) else {
                    continue;
                };
                self.library.connection.execute(
                    "UPDATE entry SET original_path = ? WHERE entry_id = ?",
                    rusqlite::params![next, entry_id],
                )?;
            }
            let refs: Vec<(String, String)> = {
                let mut statement = self
                    .library
                    .connection
                    .prepare("SELECT source_ref_id, snapshot_json FROM source_ref WHERE work_id = ?")?;
                let rows = statement.query_map(rusqlite::params![work_id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for (reference_id, snapshot_json) in refs {
                let Ok(mut snapshot) = serde_json::from_str::<Value>(&snapshot_json) else { continue };
                let Some(entries) = snapshot
                    .get_mut("sourceRecord")
                    .and_then(|record| record.get_mut("entries"))
                    .and_then(Value::as_array_mut)
                else {
                    continue;
                };
                for entry in entries.iter_mut() {
                    let Some(path) = entry.get("sourcePath").and_then(Value::as_str) else { continue };
                    let Some(next) = storage_core::layout::relocated_stored_path(&source_root, path, &source, &target) else {
                        continue;
                    };
                    if let Some(object) = entry.as_object_mut() {
                        object.insert("sourcePath".to_string(), json!(next));
                    }
                }
                self.library.connection.execute(
                    "UPDATE source_ref SET snapshot_json = ? WHERE source_ref_id = ?",
                    rusqlite::params![serde_json::to_string(&snapshot).unwrap_or_default(), reference_id],
                )?;
            }
        }
        // Root name and display title are separate: the folder keeps
        // `[RJ][circle] ... (CV ...)`, the card shows the plain work title.
        let current_title: String = self
            .library
            .connection
            .query_row(
                "SELECT title FROM work WHERE work_id = ?",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let display_title = if current_title.trim().is_empty() { target_name.to_string() } else { current_title };
        self.library.connection.execute(
            "UPDATE work SET title = ?, updated_at = ? WHERE work_id = ?",
            rusqlite::params![display_title, now_iso(), work_id],
        )?;
        Ok(json!({
            "changed": true,
            "title": display_title,
            "source": paths::relative_slash(&source_root, &source),
            "target": target_name,
        }))
    }

    /// Open a work folder in the OS file manager (`openWorkLocation`).
    ///
    /// The path is resolved server-side; the frontend never builds an absolute
    /// path (docs/16 §6). Returns the path relative to the source root.
    pub fn open_work_location(&self, work_id: &str) -> Result<Value> {
        let source_root = self
            .source_root
            .clone()
            .ok_or_else(|| Error::path_denied("source is not configured on this host"))?;
        let row: Option<(String, Option<String>)> = self
            .library
            .connection
            .query_row(
                "SELECT w.title, (SELECT source_code FROM source_ref WHERE work_id = w.work_id
                    ORDER BY source_ref_id LIMIT 1) AS source_code
                 FROM work w WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((title, source_code)) = row else {
            return Err(Error::not_found("work not found"));
        };
        let mut target = paths::resolve_lexical(&source_root.join(&title));
        if !paths::is_inside(&source_root, &target) {
            target = source_root.clone();
        }
        let mut is_dir = std::fs::metadata(&target).map(|info| info.is_dir()).unwrap_or(false);
        // Remote metadata can replace the display title; prefer a top-level folder
        // whose name contains the source code (our canonical root).
        if !is_dir {
            if let Some(code) = source_code {
                let code = code.to_uppercase();
                if let Ok(children) = std::fs::read_dir(&source_root) {
                    for child in children.flatten() {
                        let name = child.file_name().to_string_lossy().to_uppercase();
                        if child.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                            && name.contains(&code)
                        {
                            target = paths::resolve_lexical(&child.path());
                            is_dir = true;
                            break;
                        }
                    }
                }
            }
        }
        if !is_dir {
            target = source_root.clone();
        }
        // Spawning the file manager is best-effort: a headless host (tests, CI)
        // has none, and failing here would make the endpoint depend on the desktop.
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("explorer.exe").arg(&target).spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open").arg(&target).spawn();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let _ = std::process::Command::new("xdg-open").arg(&target).spawn();
        }
        let relative = if target == source_root {
            ".".to_string()
        } else {
            paths::relative_slash(&source_root, &target)
        };
        Ok(json!({ "opened": true, "path": relative }))
    }

    /// Import selected candidates from a preview (`importCandidates`).
    pub fn import_candidates(&mut self, preview: &Value, candidate_ids: &[String]) -> Result<Value> {
        self.import_candidates_with(preview, candidate_ids, &ImportOptions::default())
    }

    /// Batch id an import will use: the caller's, else `batch:web:<ms>-<pid>`
    /// (Node). Public so the async route can reply with it before the worker runs.
    pub fn import_batch_id(options: &ImportOptions) -> String {
        options
            .batch_id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("batch:web:{}-{}", chrono::Utc::now().timestamp_millis(), std::process::id()))
    }

    /// Create the batch rows up front, so the first `/api/import/status` poll of
    /// an async import finds the batch instead of a 404.
    pub fn ensure_import_batch(&self, batch_id: &str) -> Result<()> {
        self.progress(batch_id).ensure(0)
    }

    /// Node's `promise.catch` for async imports: mark the batch failed.
    pub fn fail_import_batch(&self, batch_id: &str, message: &str) {
        let timestamp = now_iso();
        let _ = self.library.connection.execute(
            "UPDATE import_batch SET status = 'failed', updated_at = ? WHERE batch_id = ?",
            rusqlite::params![timestamp, batch_id],
        );
        let _ = self.library.connection.execute(
            "UPDATE import_batch_progress SET status = 'failed', phase = 'failed', message = ?, updated_at = ? WHERE batch_id = ?",
            rusqlite::params![message, timestamp, batch_id],
        );
    }

    /// `importCandidates(preview, { candidateIds, idempotencyKey, batchId })`.
    pub fn import_candidates_with(&mut self, preview: &Value, candidate_ids: &[String], options: &ImportOptions) -> Result<Value> {
        let candidates = preview
            .get("candidates")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::new("preview.candidates is required"))?;
        let batch_id = Self::import_batch_id(options);
        let mut requested: Vec<String> = Vec::new();
        for id in candidate_ids {
            if !requested.contains(id) {
                requested.push(id.clone());
            }
        }
        let find = |id: &str| candidates.iter().find(|candidate| candidate.get("candidateId").map(storage_core::jsonutil::string_of).as_deref() == Some(id));
        let selected: Vec<&Value> = requested.iter().filter_map(|id| find(id)).collect();
        let missing: Vec<&String> = requested.iter().filter(|id| find(id).is_none()).collect();
        self.progress(&batch_id).ensure(selected.len())?;
        self.progress(&batch_id).update(&json!({
            "status": "running",
            "phase": "scanning",
            "totalCandidates": selected.len(),
            "message": format!("扫描到 {} 个候选作品", selected.len()),
        }))?;
        self.progress(&batch_id).event(&format!("batch started: {} candidates", selected.len()), &json!({ "total": selected.len() }))?;

        let mut results: Vec<Value> = Vec::new();
        for (child_index, candidate_value) in selected.iter().enumerate() {
            let candidate_id = candidate_value
                .get("candidateId")
                .or_else(|| candidate_value.get("relativeRoot"))
                .map(storage_core::jsonutil::string_of)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "work".to_string());
            let key = ingest::child_key(&batch_id, &candidate_id);
            let entry_total = candidate_value.get("entries").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            self.progress(&batch_id).update(&json!({
                "phase": "candidate",
                "currentCandidate": child_index + 1,
                "candidateId": candidate_id,
                "currentEntry": 0,
                "totalEntries": entry_total,
                "message": format!("处理 {candidate_id}"),
            }))?;
            self.progress(&batch_id).event(&format!("candidate started: {candidate_id}"), &json!({ "candidateId": candidate_id }))?;
            // The stored entry paths are source-root relative, so a host without a
            // source root cannot say where the candidate's files belong; report it
            // per candidate instead of guessing a root (a wrong one would either
            // pin machine paths again or relativise against the data folder).
            let source_root = self.source_root.clone();
            let outcome = match (candidate_from_preview(candidate_value, self.last_scan_root.as_deref()), source_root) {
                (Some(candidate), Some(source_root)) => ingest::ingest_candidate(
                    &mut self.library,
                    &candidate,
                    Some(&key),
                    &self.allowed_source_roots,
                    &source_root,
                ),
                (Some(_), None) => Err(Error::path_denied("source is not configured on this host")),
                (None, _) => Err(Error::new("candidate is not importable (missing root/entries)")),
            };
                match outcome {
                Ok(outcome) => {
                    let _ = self.library.connection.execute(
                        "UPDATE import_job SET batch_id = ? WHERE library_id = ? AND idempotency_key = ?",
                        rusqlite::params![batch_id, self.library.library_id, key],
                    );
                    let merge = outcome.merge.as_ref();
                    let status = match merge {
                        Some(merge) if merge.changed => "updated",
                        Some(_) => "skipped",
                        None => "completed",
                    };
                    let entry_count = outcome
                        .work
                        .get("entries")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(outcome.source_entry_count);
                    results.push(json!({
                        "candidateId": candidate_id,
                        "ok": true,
                        "cancelled": false,
                        "status": status,
                        "workId": outcome.work.get("workId").cloned(),
                        "jobId": outcome.job_id,
                        "revision": outcome.work.get("revision").cloned(),
                        "idempotent": outcome.idempotent,
                        "merge": merge.map(|value| value.to_json()),
                        "entryCount": entry_count,
                    }));
                    self.progress(&batch_id).update(&json!({
                        "phase": "candidate-done",
                        "candidateId": candidate_id,
                        "message": if status == "skipped" { format!("跳过 {candidate_id}") } else { format!("完成 {candidate_id}") },
                    }))?;
                    self.progress(&batch_id).event(&format!("candidate {status}: {candidate_id}"), &json!({ "candidateId": candidate_id, "status": status }))?;
                }
                Err(error) => {
                    let _ = self.library.connection.execute(
                        "UPDATE import_job SET batch_id = ? WHERE library_id = ? AND idempotency_key = ?",
                        rusqlite::params![batch_id, self.library.library_id, key],
                    );
                    let cancelled = error.is_aborted();
                    results.push(json!({
                        "candidateId": candidate_id,
                        "ok": false,
                        "cancelled": cancelled,
                        "skipped": false,
                        "status": if cancelled { "cancelled_precommit" } else { "failed" },
                        "error": error.message,
                        "code": error.code,
                        "jobId": Value::Null,
                        "key": key,
                    }));
                    self.progress(&batch_id).update(&json!({
                        "phase": "candidate-failed",
                        "candidateId": candidate_id,
                        "message": format!("失败 {candidate_id}: {}", error.message),
                    }))?;
                    self.progress(&batch_id).event(&format!("candidate failed: {candidate_id}"), &json!({ "candidateId": candidate_id, "error": error.message }))?;
                }
            }
        }
        for candidate_id in &missing {
            results.push(json!({
                "candidateId": candidate_id,
                "ok": false,
                "cancelled": false,
                "skipped": true,
                "status": "missing",
                "error": "candidate not found in preview",
                "code": "ECANDIDATENOTFOUND",
            }));
        }
        let count = |ok: bool, test: &dyn Fn(&Value) -> bool| {
            results.iter().filter(|result| result.get("ok").and_then(Value::as_bool) == Some(ok) && test(result)).count()
        };
        let status_is = |wanted: &'static str| move |result: &Value| result.get("status").and_then(Value::as_str) == Some(wanted);
        let is_cancelled = |result: &Value| result.get("cancelled").and_then(Value::as_bool) == Some(true);
        let imported = count(true, &status_is("completed"));
        let updated = count(true, &status_is("updated"));
        let skipped = count(true, &status_is("skipped"));
        let cancelled = count(false, &is_cancelled);
        let failed = count(false, &|result| !is_cancelled(result));
        let status = if cancelled > 0 {
            if imported + updated > 0 { "partial" } else { "cancelled" }
        } else if failed == 0 {
            "completed"
        } else if imported + updated > 0 {
            "partial"
        } else {
            "failed"
        };
        self.library.connection.execute(
            "UPDATE import_batch SET status = ?, updated_at = ? WHERE batch_id = ? AND library_id = ?",
            rusqlite::params![status, now_iso(), batch_id, self.library.library_id],
        )?;
        self.progress(&batch_id).update(&json!({
            "status": status,
            "phase": "done",
            "imported": imported,
            "updated": updated,
            "skipped": skipped,
            "failed": failed,
            "message": format!("完成：新增 {imported}，更新 {updated}，跳过 {skipped}，失败 {failed}"),
        }))?;
        self.progress(&batch_id).event(&format!("batch {status}"), &json!({ "imported": imported, "updated": updated, "skipped": skipped, "failed": failed }))?;
        let selected_ids: Vec<String> = selected
            .iter()
            .map(|candidate| {
                candidate
                    .get("candidateId")
                    .or_else(|| candidate.get("relativeRoot"))
                    .map(storage_core::jsonutil::string_of)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "work".to_string())
            })
            .collect();
        Ok(json!({
            "batchId": batch_id,
            "libraryId": self.library.library_id,
            "status": status,
            "candidateIds": selected_ids,
            "imported": imported,
            "updated": updated,
            "failed": failed,
            "cancelled": cancelled,
            "skipped": skipped,
            "total": results.len(),
            "results": results,
            "children": results,
        }))
    }

    fn progress<'a>(&'a self, batch_id: &'a str) -> BatchProgress<'a> {
        BatchProgress { connection: &self.library.connection, library_id: &self.library.library_id, batch_id }
    }

    /// Batch progress for `/api/import/status`.
    pub fn batch_progress(&self, batch_id: &str) -> Result<Option<Value>> {
        let batch: Option<(String, String, String)> = self
            .library
            .connection
            .query_row(
                "SELECT status, created_at, updated_at FROM import_batch WHERE batch_id = ? AND library_id = ?",
                rusqlite::params![batch_id, self.library.library_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((batch_status, created_at, batch_updated)) = batch else {
            return Ok(None);
        };
        let progress: Option<Value> = self
            .library
            .connection
            .query_row(
                "SELECT * FROM import_batch_progress WHERE batch_id = ? AND library_id = ?",
                rusqlite::params![batch_id, self.library.library_id],
                |row| {
                    Ok(json!({
                        "status": row.get::<_, String>("status")?,
                        "phase": row.get::<_, Option<String>>("phase")?,
                        "currentCandidate": row.get::<_, i64>("current_candidate")?,
                        "totalCandidates": row.get::<_, i64>("total_candidates")?,
                        "candidateId": row.get::<_, Option<String>>("candidate_id")?,
                        "currentEntry": row.get::<_, i64>("current_entry")?,
                        "totalEntries": row.get::<_, i64>("total_entries")?,
                        "bytesDone": row.get::<_, i64>("bytes_done")?,
                        "bytesTotal": row.get::<_, i64>("bytes_total")?,
                        "imported": row.get::<_, i64>("imported")?,
                        "updated": row.get::<_, i64>("updated")?,
                        "skipped": row.get::<_, i64>("skipped")?,
                        "failed": row.get::<_, i64>("failed")?,
                        "message": row.get::<_, Option<String>>("message")?.unwrap_or_default(),
                        "updatedAt": row.get::<_, String>("updated_at")?,
                    }))
                },
            )
            .optional()?;
        let progress = progress.unwrap_or_else(|| json!({}));
        // Last 50 events, oldest first (Node: ORDER BY event_id DESC LIMIT 50, reversed).
        let mut statement = self.library.connection.prepare(
            "SELECT event_id, level, message, payload_json, created_at FROM import_batch_event
             WHERE batch_id = ? ORDER BY event_id DESC LIMIT 50",
        )?;
        let mut events: Vec<Value> = statement
            .query_map(rusqlite::params![batch_id], |row| {
                let payload: String = row.get(3)?;
                Ok(json!({
                    "eventId": row.get::<_, i64>(0)?,
                    "level": row.get::<_, String>(1)?,
                    "message": row.get::<_, String>(2)?,
                    "payload": serde_json::from_str::<Value>(&payload).unwrap_or_else(|_| json!({})),
                    "createdAt": row.get::<_, String>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        events.reverse();
        Ok(Some(json!({
            "batchId": batch_id,
            "status": progress.get("status").cloned().unwrap_or(json!(batch_status)),
            "phase": progress.get("phase").cloned().unwrap_or(Value::Null),
            "currentCandidate": progress.get("currentCandidate").cloned().unwrap_or(json!(0)),
            "totalCandidates": progress.get("totalCandidates").cloned().unwrap_or(json!(0)),
            "candidateId": progress.get("candidateId").cloned().unwrap_or(Value::Null),
            "currentEntry": progress.get("currentEntry").cloned().unwrap_or(json!(0)),
            "totalEntries": progress.get("totalEntries").cloned().unwrap_or(json!(0)),
            "bytesDone": progress.get("bytesDone").cloned().unwrap_or(json!(0)),
            "bytesTotal": progress.get("bytesTotal").cloned().unwrap_or(json!(0)),
            "imported": progress.get("imported").cloned().unwrap_or(json!(0)),
            "updated": progress.get("updated").cloned().unwrap_or(json!(0)),
            "skipped": progress.get("skipped").cloned().unwrap_or(json!(0)),
            "failed": progress.get("failed").cloned().unwrap_or(json!(0)),
            "message": progress.get("message").cloned().unwrap_or(json!("")),
            "events": events,
            "createdAt": created_at,
            "updatedAt": progress.get("updatedAt").cloned().unwrap_or(json!(batch_updated)),
        })))
    }

    /// Set the root the next preview's relative paths resolve against.
    /// Scan the configured source (`host.mjs::scan`) and return the redacted
    /// preview. `relativeRoot` narrows the scan to a subfolder and may not escape.
    pub fn scan(&mut self, options: &Value) -> Result<Value> {
        let source = self
            .source_root
            .clone()
            .ok_or_else(|| Error::new("sourceRoot is required for scan"))?;
        let mut scan_root = source.clone();
        if let Some(relative) = options.get("relativeRoot").and_then(Value::as_str).filter(|value| !value.is_empty() && *value != ".") {
            let relative = relative.replace('\\', "/");
            if relative.starts_with('/') || relative.split('/').any(|part| part == "..") {
                return Err(Error::path_denied("relativeRoot escapes the source root"));
            }
            // The caller speaks bare paths; the layout decides the type directory.
            let relative = storage_core::layout::normalize_source_relative(&relative);
            scan_root = paths::resolve_lexical(&source.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)));
            if !paths::is_inside(&source, &scan_root) {
                return Err(Error::path_denied("relativeRoot escapes the source root"));
            }
        }
        self.last_scan_root = Some(scan_root.clone());
        let mut scan_options = crate::scan::ScanOptions::from_json(options)?;
        // Node spreads caller options *after* libraryRoot, so a caller value wins.
        if options.get("libraryRoot").and_then(Value::as_str).filter(|value| !value.is_empty()).is_none() {
            scan_options.library_root = Some(self.library.data_root.clone());
        }
        let preview = crate::scan::scan_source(&scan_root, &scan_options)?;
        Ok(crate::scan::redact_preview(&preview, &source))
    }

    pub fn set_scan_root(&mut self, root: PathBuf) {
        self.last_scan_root = Some(root);
    }

    pub fn verify(&self) -> Result<Value> {
        self.library.verify_library()
    }

    /// Close the library, releasing the root lease.
    pub fn close(mut self) -> Result<()> {
        self.library.close()
    }
}

/// Build a `Candidate` from the preview JSON the scanner produced.
///
/// Preview paths are redacted (`sourceRoot: '.'`, relative `rootPath`); they are
/// re-anchored against the scan root here, which is why the host remembers it.
fn candidate_from_preview(value: &Value, scan_root: Option<&Path>) -> Option<Candidate> {
    let object = value.as_object()?;
    let relative_root = object.get("relativeRoot").and_then(Value::as_str).unwrap_or("").to_string();
    let root_value = object.get("rootPath").and_then(Value::as_str).unwrap_or("");
    let root_path = if Path::new(root_value).is_absolute() {
        PathBuf::from(root_value)
    } else {
        let base = scan_root?;
        let relative = if root_value.is_empty() { relative_root.as_str() } else { root_value };
        paths::resolve_lexical(&base.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)))
    };
    let entries = object
        .get("entries")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| {
                    let logical_path = entry.get("logicalPath").and_then(Value::as_str)?.to_string();
                    let absolute_value = entry.get("absolutePath").and_then(Value::as_str).unwrap_or("");
                    let absolute_path = if Path::new(absolute_value).is_absolute() {
                        PathBuf::from(absolute_value)
                    } else if absolute_value.is_empty() {
                        root_path.join(logical_path.replace('/', std::path::MAIN_SEPARATOR_STR))
                    } else {
                        root_path.join(absolute_value.replace('/', std::path::MAIN_SEPARATOR_STR))
                    };
                    Some(CandidateEntry {
                        logical_path,
                        absolute_path,
                        name: entry
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default(),
                        kind: entry.get("kind").and_then(Value::as_str).unwrap_or("file").to_string(),
                        track_key: entry.get("trackKey").and_then(Value::as_str).map(str::to_string),
                        format: entry.get("format").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cover_root = root_path.clone();
    Some(Candidate {
        candidate_id: object.get("candidateId").and_then(Value::as_str).unwrap_or("").to_string(),
        relative_root,
        root_path,
        folder_title: object
            .get("folderTitle")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        circle: object.get("circle").and_then(Value::as_str).unwrap_or("").to_string(),
        cvs: object
            .get("cvs")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(storage_core::jsonutil::string_of).collect())
            .unwrap_or_default(),
        source_code: object
            .get("sourceCode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        family_id: object.get("familyId").and_then(Value::as_str).map(str::to_string),
        metadata: object.get("metadata").and_then(Value::as_object).cloned(),
        cover: select_preview_cover(value, &cover_root),
        entries,
    })
}

/// Cover for a preview candidate, as `ingest.mjs::sourceRecordFromCandidate`
/// chooses it: `selectCover` (decoded explicit covers, largest area wins),
/// else the explicit-name fallback **only when its bytes are not PNG/JPEG**.
/// That last rule looks backwards but is deliberate in Node: a real PNG/JPEG
/// that failed full decoding is truncated or corrupt and must not become the
/// cover, while webp/gif/bmp covers (which `selectCover` cannot decode) still
/// get one. Embedded covers stay off, matching the host import path.
fn select_preview_cover(candidate: &Value, root_path: &Path) -> Option<CoverCandidate> {
    let mut hydrated = candidate.clone();
    if let Some(object) = hydrated.as_object_mut() {
        object.insert("rootPath".to_string(), json!(root_path.to_string_lossy()));
    }
    if let Ok(Some(choice)) = crate::cover::select_cover(&hydrated, &crate::cover::SelectOptions::default()) {
        let format = choice.format().map(str::to_string);
        return choice.path.map(|path| CoverCandidate { path, format });
    }
    let fallback = crate::cover::select_explicit_name_fallback(&hydrated)?;
    let path = fallback.path?;
    let mut head = [0u8; 8];
    let read = std::fs::File::open(&path)
        .and_then(|mut file| std::io::Read::read(&mut file, &mut head))
        .unwrap_or(0);
    let png = read >= 8 && head[0] == 0x89 && &head[1..4] == b"PNG";
    let jpeg = read >= 2 && head[0] == 0xff && head[1] == 0xd8;
    if png || jpeg {
        return None;
    }
    Some(CoverCandidate { path, format: None })
}

/// Mark a manifest entry and its aliases remote; keeps remote media URLs.
fn mark_manifest_remote(entries: &mut [Value], logical_path: &str) {
    let target_hash = entries
        .iter()
        .find(|item| item.get("logicalPath").and_then(Value::as_str) == Some(logical_path))
        .and_then(|item| item.get("hash"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    for item in entries.iter_mut() {
        let same_path = item.get("logicalPath").and_then(Value::as_str) == Some(logical_path);
        let same_content = !target_hash.is_empty()
            && item.get("hash").and_then(Value::as_str) == Some(target_hash.as_str());
        let is_alias = item.get("aliasOf").and_then(Value::as_str) == Some(logical_path);
        if (same_path || same_content || is_alias)
            && item.get("status").and_then(Value::as_str) != Some("remote")
        {
            if let Some(object) = item.as_object_mut() {
                object.insert("status".to_string(), json!("remote"));
            }
        }
    }
}

/// `[RJ][circle] title (CV ...)` → `title`, with correct regex escapes (D2).
fn strip_title_prefix(value: &str) -> String {
    let mut text = value.trim().to_string();
    if text.starts_with("[RJ") {
        if let Some(close) = text.find(']') {
            let inside = &text[1..close];
            let digits = inside[2..].trim();
            if !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit()) {
                text = text[close + 1..].trim_start().to_string();
            }
        }
    }
    if text.starts_with('[') {
        if let Some(close) = text.find(']') {
            text = text[close + 1..].trim_start().to_string();
        }
    }
    text.trim_end().to_string()
}

/// Copy files that do not already exist in `target` (`mergeDirectory`).
fn merge_directory(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target)?;
    let Ok(entries) = std::fs::read_dir(source) else { return Ok(()) };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = target.join(entry.file_name());
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            merge_directory(&from, &to)?;
        } else if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) && !to.exists() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Normalize a relative path to `/` separators with no empty segments.
fn normalize_relative(value: String) -> String {
    value
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn require_string<'a>(input: &'a Value, name: &str) -> Result<&'a str> {
    match input.get(name).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(Error::bad_request(format!("{name} is required"))),
    }
}

/// `RJ\d{5,8}` extraction, uppercased.
fn extract_rj(value: &str) -> Option<String> {
    let upper = value.to_uppercase();
    let mut search = upper.as_str();
    while let Some(index) = search.find("RJ") {
        let rest = &search[index + 2..];
        let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if (5..=8).contains(&digits.len()) {
            return Some(format!("RJ{digits}"));
        }
        search = &rest[1.min(rest.len())..];
    }
    None
}

/// Resolve authorized source roots (`normalizeAllowedSourceRoots`).
fn normalize_allowed_roots(roots: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut values = Vec::new();
    for root in roots {
        if !root.is_absolute() {
            return Err(Error::coded(
                "EINVALIDALLOWEDROOT",
                "allowedSourceRoots entries must be explicit absolute paths",
            ));
        }
        let absolute = paths::resolve_lexical(root);
        let info = std::fs::symlink_metadata(&absolute).map_err(|_| {
            Error::coded(
                "EINVALIDALLOWEDROOT",
                format!("allowed source root does not exist: {}", absolute.display()),
            )
        })?;
        if info.file_type().is_symlink() || !info.is_dir() {
            return Err(Error::coded(
                "EINVALIDALLOWEDROOT",
                format!("allowed source root must be a real directory, not a symlink/junction: {}", absolute.display()),
            ));
        }
        if !values.contains(&absolute) {
            values.push(absolute);
        }
    }
    Ok(values)
}

/// Percent-encode a path segment like `encodeURIComponent` does for UUIDs.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

const COVER_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(200),
    std::time::Duration::from_millis(600),
];

/// Best-effort HTTPS GET used for covers.
///
/// Retries 5xx, timeout and transient transport errors with bounded backoff;
/// 4xx, size-cap (`ETOOLARGE`) and empty 2xx bodies fail immediately without
/// retrying. Returns `None` on any failure: covers are cosmetic, and a network
/// error must not fail a library operation. Only used for image downloads whose
/// URL the caller already validated as http(s).
fn fetch_https(url: &str, max_bytes: usize) -> Option<Vec<u8>> {
    fetch_https_with(url, max_bytes, crate::net::COVER_TIMEOUT, &COVER_RETRY_DELAYS)
}

fn fetch_https_with(
    url: &str,
    max_bytes: usize,
    timeout: std::time::Duration,
    retry_delays: &[std::time::Duration],
) -> Option<Vec<u8>> {
    for attempt in 0..=retry_delays.len() {
        let retryable = match crate::net::get_bounded(url, max_bytes, timeout) {
            Ok(fetched) if (200..300).contains(&fetched.status) && !fetched.body.is_empty() => {
                return Some(fetched.body);
            }
            Ok(fetched) if (500..600).contains(&fetched.status) => true,
            Ok(_) => false,
            Err(error) => error.code == Some("EHTTPTRANSIENT"),
        };
        if !retryable || attempt == retry_delays.len() {
            return None;
        }
        std::thread::sleep(retry_delays[attempt]);
    }
    None
}

fn absolute_unused(actual: &[(PathBuf, String, String, u64)]) -> usize {
    actual.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rj_extraction_is_uppercase_and_bounded() {
        assert_eq!(extract_rj("rj01678051"), Some("RJ01678051".to_string()));
        assert_eq!(extract_rj("../RJ123456/x"), Some("RJ123456".to_string()));
        assert_eq!(extract_rj("rj123"), None);
    }

    #[test]
    fn root_cover_is_stricter_than_any_folder_cover() {
        assert!(is_root_folder_cover("folder.jpg"));
        assert!(is_root_folder_cover("folder.webp"));
        assert!(!is_root_folder_cover("mp3/folder.jpg"));
        // Delete/reconcile still recognise a nested legacy cover so they do not
        // treat it as user content.
        assert!(is_any_folder_cover("mp3/folder.jpg"));
        assert!(is_cover_path(".monochrome/folder.jpg"));
        // The cached sidecar cover is authoritative; a nested sidecar is not root.
        assert!(is_root_folder_cover(".monochrome/folder.jpg"));
        assert!(is_root_folder_cover("FOLDER.PNG"));
        assert!(!is_root_folder_cover("mp3/.monochrome/folder.jpg"));
        assert!(!is_root_folder_cover("folder.gif"));
        assert!(!is_any_folder_cover("myfolder.jpg"));
    }

    #[test]
    fn title_prefix_uses_real_escapes() {
        // Node's regex was missing backslashes (`s*`, `[^]]+]`), so these never
        // stripped. The corrected behaviour is the documented intent (D2).
        assert_eq!(strip_title_prefix("[RJ01678051] [Circle] title (CV A)"), "title (CV A)");
        assert_eq!(strip_title_prefix("plain title"), "plain title");
    }

    #[test]
    fn relative_paths_are_normalised() {
        assert_eq!(normalize_relative("a\\b//c".to_string()), "a/b/c");
        assert_eq!(normalize_relative("/a/b/".to_string()), "a/b");
    }

    /// Wiring test for the layout migration: `Host::open` is the only place that
    /// knows both roots, so it is what has to move legacy creation attachments
    /// out of the library root and into the readable source tree. The storage-core
    /// test proves the move; this proves it is actually called on open.
    #[test]
    fn open_moves_legacy_creation_attachments_into_the_source_tree() {
        use storage_core::creations;

        let base = std::env::temp_dir().join(format!("mono-host-creations-{}", uuid::Uuid::new_v4()));
        let library_root = base.join("lib");
        let source = base.join("source");
        std::fs::create_dir_all(&source).unwrap();
        {
            let library = storage_core::Library::open(
                &library_root,
                storage_core::OpenOptions {
                    create: true,
                    allow_outside_root: true,
                    experiment_root: None,
                    snapshot_fault: None,
                },
            )
            .unwrap();
            creations::save_post(
                &library.connection,
                &serde_json::json!({
                    "id": "p1",
                    "title": "Old Post",
                    "provider": "Patreon",
                    "creator": "C",
                    "date": "2026-02-10"
                }),
            )
            .unwrap();
            // The pre-migration shape: an opaque post-key folder in the library
            // root, addressed by a library-root-relative `rel_path`.
            let key = storage_core::hash::sha256_text("p1");
            let folder = library.root.join("creations").join(&key);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("asset-1"), b"old").unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO creation_asset(asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path, created_at)
                     VALUES ('asset-1', 'p1', 'att-1', 'original', 'a.png', 'image/png', 3, 'x', ?1, '2026-01-01T00:00:00Z')",
                    rusqlite::params![format!("creations/{key}/asset-1")],
                )
                .unwrap();
        }

        let host = Host::open(HostOptions {
            library_root: library_root.clone(),
            source_root: Some(source.clone()),
            allowed_source_roots: vec![source.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();

        let rel: String = host
            .library
            .connection
            .query_row("SELECT rel_path FROM creation_asset WHERE asset_id = 'asset-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rel, "creations/Patreon/C/2026-02-10 Old Post [p1]/asset-1.png");
        assert_eq!(std::fs::read(source.join(&rel)).unwrap(), b"old");
        drop(host);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn backup_paths_are_confined_to_the_experiment_root() {
        let base = std::env::temp_dir().join(format!("mono-host-exp-{}", uuid::Uuid::new_v4()));
        let experiment = base.join("lab");
        let open = |experiment_root: Option<PathBuf>| {
            Host::open(HostOptions {
                library_root: base.join("lib"),
                source_root: None,
                allowed_source_roots: Vec::new(),
                allow_outside_root: true,
                experiment_root,
                snapshot_fault: None,
            })
            .unwrap()
        };
        let host = open(Some(experiment.clone()));
        assert!(host.confine_to_experiment(&experiment.join("run").join("backup")).is_ok());
        // `..` is collapsed before the check, the root itself is refused, like Node.
        let escape = experiment.join("..").join("elsewhere");
        assert_eq!(host.confine_to_experiment(&escape).unwrap_err().code, Some("EOUTSIDE"));
        assert_eq!(host.confine_to_experiment(&experiment).unwrap_err().code, Some("EOUTSIDE"));
        drop(host);
        // No experiment root configured: every destination is refused.
        if std::env::var_os("MONOCHROME_EXPERIMENT_ROOT").is_none() {
            let host = open(None);
            assert_eq!(host.confine_to_experiment(&experiment.join("x")).unwrap_err().code, Some("EOUTSIDE"));
        }
    }

    #[test]
    fn delete_works_moves_the_folder_to_the_trash_and_restore_brings_it_back() {
        // Deleting a work from the UI moves its folder out of the readable
        // library and hides the row. Both must be reversible: the folder sits
        // under `trash/<work id>/` with a manifest, and restore is a rename —
        // no re-import, no metadata loss.
        let base = std::env::temp_dir().join(format!("mono-host-del-work-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("[RJ900321] Delete Work");
        std::fs::create_dir_all(&work_root).unwrap();
        std::fs::write(work_root.join("01.wav"), b"delete-me").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({
                "relativePath": "[RJ900321] Delete Work/01.wav",
                "workRoot": "[RJ900321] Delete Work",
                "metadata": { "title": "Delete Work", "sourceCode": "RJ900321", "circle": "Circle" },
            }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();
        // The host owns the folder layout: a bare `workRoot` is stored under its
        // type directory, so the folder the test pre-created is not where the
        // work ends up. Resolve the real root through the snapshot.
        let work_root = host.work_root_for_work(&work_id).unwrap().expect("imported work has a root");
        assert!(work_root.join("01.wav").exists(), "the imported file is under the resolved root");
        let result = host.delete_works(&[work_id.clone()]).unwrap();
        assert_eq!(result["works"][0]["ok"], true, "{result}");
        assert_eq!(result["works"][0]["trashed"], true, "{result}");
        assert!(!work_root.exists(), "the readable work folder leaves the source root");
        let slot = storage_core::trash::slot(&host.library.data_root, &work_id).unwrap();
        let trashed = slot.join("[RJ900321] Delete Work").join("01.wav");
        assert!(trashed.exists(), "the bytes are in the trash slot");
        let entries = host.list_trash().unwrap();
        assert_eq!(entries["total"], 1, "{entries}");
        assert_eq!(entries["entries"][0]["originalRoot"], "voices/[RJ900321] Delete Work");
        let hidden: i64 = host
            .library
            .connection
            .query_row(
                "SELECT COUNT(*) FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hidden, 0, "the work no longer appears in the library");

        let restored = host.restore_works(&[work_id.clone()]).unwrap();
        assert_eq!(restored["restored"], 1, "{restored}");
        assert_eq!(restored["works"][0]["moved"], true, "{restored}");
        assert!(work_root.join("01.wav").exists(), "restore puts the folder back: {restored}");
        let visible: i64 = host
            .library
            .connection
            .query_row(
                "SELECT COUNT(*) FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(visible, 1, "restore clears deleted_at");
        assert_eq!(host.list_trash().unwrap()["total"], 0, "the slot is consumed");

        // Node answers `ok: true, deleted: false` for an id it does not own; the
        // request succeeded, nothing was there. The wire contract stays identical,
        // so the caller — not the host — decides whether that is an error.
        let again = host.delete_works(&[work_id]).unwrap();
        assert_eq!(again["works"][0]["ok"], true, "{again}");
        assert_eq!(again["works"][0]["deleted"], true, "{again}");
        // A second delete of an already-trashed work is the no-op case.
        let noop = host.delete_works(&[String::from("00000000-0000-0000-0000-000000000000")]).unwrap();
        assert_eq!(noop["works"][0]["ok"], true, "{noop}");
        assert_eq!(noop["works"][0]["deleted"], false, "{noop}");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// A batch import has to know the source root to store entry paths relative to
    /// it. Without one the candidate fails with EPATHDENIED instead of being
    /// imported against a guessed root — a guess would either pin machine paths or
    /// relativise against the data folder and point at nothing.
    #[test]
    fn batch_import_without_a_source_root_reports_the_candidate_instead_of_guessing() {
        let base = std::env::temp_dir().join(format!("mono-host-nosource-{}", uuid::Uuid::new_v4()));
        let work_root = base.join("work");
        std::fs::create_dir_all(&work_root).unwrap();
        std::fs::write(work_root.join("01.mp3"), b"no-source").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: None,
            allowed_source_roots: Vec::new(),
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let preview = json!({ "candidates": [{
            "candidateId": "local:work",
            "relativeRoot": "work",
            "rootPath": work_root.to_string_lossy(),
            "entries": [{ "logicalPath": "01.mp3", "absolutePath": work_root.join("01.mp3").to_string_lossy() }],
        }] });
        let result = host
            .import_candidates_with(&preview, &["local:work".to_string()], &ImportOptions::default())
            .unwrap();
        assert_eq!(result["results"][0]["ok"], false, "{result}");
        assert_eq!(result["results"][0]["code"], "EPATHDENIED", "{result}");
        let works: i64 = host
            .library
            .connection
            .query_row("SELECT COUNT(*) FROM work", [], |row| row.get(0))
            .unwrap();
        assert_eq!(works, 0, "nothing was imported");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// `cleanupPreview` decides "stale" by whether the recorded files still exist.
    /// Since phase 2a those records are source-root relative, so the check has to
    /// resolve them: testing the raw string resolved it against the process cwd and
    /// reported every work as stale.
    #[test]
    fn cleanup_preview_resolves_the_stored_source_paths() {
        let base = std::env::temp_dir().join(format!("mono-host-cleanup-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000012] Cleanup");
        std::fs::create_dir_all(&work_root).unwrap();
        std::fs::write(work_root.join("01.wav"), b"cleanup").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        host.import_file(&json!({
            "relativePath": "[RJ09000012] Cleanup/01.wav",
            "workRoot": "[RJ09000012] Cleanup",
            "metadata": { "title": "Cleanup", "sourceCode": "RJ09000012" },
        }))
        .unwrap();
        let preview = host.cleanup_preview().unwrap();
        assert_eq!(preview["total"], 0, "a work whose files exist is not stale: {preview}");

        std::fs::remove_file(work_root.join("01.wav")).unwrap();
        let preview = host.cleanup_preview().unwrap();
        assert_eq!(preview["total"], 1, "{preview}");
        assert_eq!(preview["works"][0]["missing"], 1, "{preview}");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Purge has to remove the *bytes* an entry points at, and after phase 2a that
    /// pointer is relative. A file that sits outside the work root is the case that
    /// catches a raw-path comparison. Delete alone must not touch it — delete is
    /// reversible now — so the sweep is asserted on the purge that follows.
    #[test]
    fn purge_resolves_a_relative_entry_file_outside_the_work_root() {
        let base = std::env::temp_dir().join(format!("mono-host-purge-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000011] Purge");
        std::fs::create_dir_all(&work_root).unwrap();
        std::fs::write(work_root.join("01.wav"), b"purge-me").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({
                "relativePath": "[RJ09000011] Purge/01.wav",
                "workRoot": "[RJ09000011] Purge",
                "metadata": { "title": "Purge", "sourceCode": "RJ09000011" },
            }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();
        assert_eq!(host.work_root_for_work(&work_id).unwrap().as_deref(), Some(work_root.as_path()));

        // The user moved the file out of the work folder but kept it in the source
        // root; the stored value follows (and stays relative).
        let outer = source_root.join("loose").join("01.wav");
        std::fs::create_dir_all(outer.parent().unwrap()).unwrap();
        std::fs::rename(work_root.join("01.wav"), &outer).unwrap();
        let unrelated = source_root.join("loose").join("keep.wav");
        std::fs::write(&unrelated, b"not ours").unwrap();
        host.library
            .connection
            .execute(
                "UPDATE entry SET original_path = 'loose/01.wav' WHERE work_id = ?",
                rusqlite::params![work_id],
            )
            .unwrap();

        let result = host.delete_works(&[work_id.clone()]).unwrap();
        assert_eq!(result["works"][0]["ok"], true, "{result}");
        assert!(outer.exists(), "delete is reversible: the relocated file stays");

        let purged = host.purge_trash(&[]).unwrap();
        assert_eq!(purged["purged"], 1, "{purged}");
        assert!(!outer.exists(), "purge removes the entry's file through its stored path");
        assert!(unrelated.exists(), "a file no entry points at is not swept");
        assert!(!work_root.exists(), "the work folder is not resurrected by purge");
        assert_eq!(host.list_trash().unwrap()["total"], 0, "the slot is gone");
        let rows: i64 = host
            .library
            .connection
            .query_row("SELECT COUNT(*) FROM work WHERE work_id = ?", rusqlite::params![work_id], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "purge removes the row");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn delete_without_original_path_resolves_under_the_work_title() {
        // Node falls back to <source>/<work title>/<logical path> for entries that
        // have no `original_path`. Resolving <source>/<logical path> instead found
        // no file, so the entry vanished from the library while the bytes stayed on
        // disk (and the call still reported success).
        //
        // The folder name here equals the stored title on purpose: `ingest.mjs`
        // strips a leading `[RJ…]` prefix into `work.title`, so a folder named
        // `[RJ900123] Delete Sample` would not be found by the title fallback in
        // Node either. Matching that (wrong-but-harmless) case would mean guessing
        // which sibling folder is the right one, and a wrong guess deletes another
        // work's bytes — so the fallback stays an exact title match.
        let base = std::env::temp_dir().join(format!("mono-host-del-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("Delete Sample");
        std::fs::create_dir_all(&work_root).unwrap();
        std::fs::write(work_root.join("01.wav"), b"delete-me").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({
                "relativePath": "Delete Sample/01.wav",
                "workRoot": "Delete Sample",
                "metadata": { "title": "Delete Sample", "sourceCode": "RJ900123" },
            }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();
        host.library
            .connection
            .execute("UPDATE entry SET original_path = NULL WHERE work_id = ?", rusqlite::params![work_id])
            .unwrap();
        let result = host.delete_work_files(&work_id, &["01.wav".to_string()]).unwrap();
        assert_eq!(result["count"], 1, "{result}");
        assert!(!work_root.join("01.wav").exists(), "the physical file is removed via the title fallback");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn empty_entry_mime_falls_back_to_the_asset_mime() {
        // Node: `entry.mime || entry.asset_mime || null` treats '' as absent.
        let base = std::env::temp_dir().join(format!("mono-host-mime-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        std::fs::create_dir_all(source_root.join("Mime Work")).unwrap();
        std::fs::write(source_root.join("Mime Work").join("01.wav"), b"mime").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        // `relativePath: "01.wav"` makes the work root the file's parent, which is
        // the source root itself — refused, because a work must own a directory.
        host.import_file(&json!({ "relativePath": "Mime Work/01.wav", "metadata": { "title": "Mime Work" } })).unwrap();
        host.library.connection.execute("UPDATE entry SET mime = ''", []).unwrap();
        // `list_works` returns the array itself, not `{ works: [...] }`.
        let works = host.list_works().unwrap();
        let mime = &works[0]["entries"][0]["mime"];
        assert_eq!(mime, "audio/wav", "empty entry mime falls back to the asset mime: {mime}");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// A voice work must leave a readable record of itself, the same way a
    /// creation post does. Before this, only creations and videos wrote
    /// `.monochrome/info.json`; a voice folder whose database was lost could say
    /// nothing about itself unless a downloader had happened to leave a
    /// `metadata.json` next to it.
    #[test]
    fn save_voice_bundle_seeds_info_json_once() {
        let base = std::env::temp_dir().join(format!("mono-host-voice-seed-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000200] Seeded");
        std::fs::create_dir_all(&work_root).unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let bundle = |title: &str| {
            json!({
                "rootName": "[RJ09000200] Seeded",
                "metadata": {
                    "title": title, "circle": "Seed Circle", "sourceCode": "RJ09000200",
                    "cvs": ["A", "B"], "release": "2026-01-02", "sourceUrl": "https://example.invalid/RJ09000200",
                    // Volatile fields that must NOT be frozen into the seed.
                    "rating": 4.5, "ratingCount": 12, "price": 1540, "tags": ["x"],
                },
                "manifest": { "version": 1, "entries": [] },
            })
        };
        host.save_voice_bundle(&bundle("Seeded")).unwrap();

        let seed = storage_core::sidecar::read(&work_root).expect("the seed exists");
        assert_eq!(seed["schema"], "monochrome-info/1");
        assert_eq!(seed["kind"], "voice");
        assert_eq!(seed["manual"], false);
        assert_eq!(seed["title"], "Seeded");
        assert_eq!(seed["circle"], "Seed Circle");
        assert_eq!(seed["sourceCode"], "RJ09000200");
        assert_eq!(seed["cvs"], json!(["A", "B"]));
        assert_eq!(seed["originalRoot"], "voices/[RJ09000200] Seeded");
        for volatile in ["rating", "ratingCount", "price", "tags"] {
            assert!(seed.get(volatile).is_none(), "{volatile} must not be frozen into the seed: {seed}");
        }

        // A re-import with a corrected title updates the row but not the file: the
        // seed is written once, so it cannot drift into a second write path.
        host.save_voice_bundle(&bundle("Seeded Renamed")).unwrap();
        let again = storage_core::sidecar::read(&work_root).unwrap();
        assert_eq!(again["title"], "Seeded", "the seed keeps its first-import title: {again}");
        let works = host.list_works().unwrap();
        assert_eq!(works[0]["title"], "Seeded Renamed", "the row is the authority");

        // A human correction is respected: `manual` seeds are never overwritten
        // and the scanner prefers them over a stray metadata.json.
        let mut edited = again.clone();
        edited["manual"] = json!(true);
        edited["title"] = json!("Edited By Hand");
        std::fs::write(work_root.join(".monochrome/info.json"), edited.to_string()).unwrap();
        assert!(!storage_core::sidecar::write_if_absent(&work_root, &json!({"title": "third"})).unwrap());
        assert_eq!(storage_core::sidecar::read(&work_root).unwrap()["title"], "Edited By Hand");

        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// The user's report: download track 1 from the Japanese edition, then the
    /// byte-identical track 1 from the Chinese edition. The per-file import
    /// must dedupe immediately (no manual reconcile): one file on disk — the one
    /// downloaded first — and the Chinese row recorded as an alias.
    #[test]
    fn cross_edition_download_is_deduped_by_the_per_file_import() {
        let base = std::env::temp_dir().join(format!("mono-host-dedupe-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000001] Dedupe");
        std::fs::create_dir_all(&work_root).unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        // The online bundle lists both editions; manifest `hash` values are the
        // Kikoeru track ids, never a sha256 (that is what made the old dedupe blind).
        let row = |edition: &str, path: &str, hash: &str| json!({
            "logicalPath": path, "title": path.rsplit('/').next().unwrap(), "kind": "audio",
            "hash": hash, "editionCode": edition, "status": "remote",
        });
        host.save_voice_bundle(&json!({
            "rootName": "[RJ09000001] Dedupe",
            "metadata": { "title": "Dedupe", "sourceCode": "RJ09000001" },
            "manifest": { "version": 1, "entries": [
                row("RJ09000002", "zh/mp3/01.mp3", "9000002/1"),
                row("RJ09000001", "ja/mp3/01.mp3", "9000001/1"),
            ] },
        }))
        .unwrap();

        let audio = vec![7u8; 4096];
        std::fs::create_dir_all(work_root.join("ja/mp3")).unwrap();
        std::fs::write(work_root.join("ja/mp3/01.mp3"), &audio).unwrap();
        let first = host
            .import_file(&json!({ "relativePath": "[RJ09000001] Dedupe/ja/mp3/01.mp3", "workRoot": "[RJ09000001] Dedupe" }))
            .unwrap();
        let work_id = first["workId"].as_str().unwrap().to_string();

        // Real order in the download pipeline: the edition being downloaded is
        // the *only* edition in the stored manifest until the plan finishes, so
        // the Chinese file arrives with no manifest row of its own.
        let ja_only = json!({ "manifest": { "version": 2, "entries": [
            row("RJ09000001", "ja/mp3/01.mp3", "9000001/1"),
        ] } });
        host.library.update_work_metadata(&work_id, ja_only.as_object().unwrap()).unwrap();

        std::fs::create_dir_all(work_root.join("zh/mp3")).unwrap();
        std::fs::write(work_root.join("zh/mp3/01.mp3"), &audio).unwrap();
        host.import_file(&json!({
            "relativePath": "[RJ09000001] Dedupe/zh/mp3/01.mp3", "workRoot": "[RJ09000001] Dedupe", "workId": work_id,
        }))
        .unwrap();

        assert!(work_root.join("ja/mp3/01.mp3").exists(), "the copy downloaded first is kept");
        assert!(!work_root.join("zh/mp3/01.mp3").exists(), "the duplicate is removed without a manual reconcile");
        assert!(!work_root.join("zh").exists(), "directories the duplicate leaves empty are pruned");
        let works = host.list_works().unwrap();
        let entries = works[0]["entries"].as_array().unwrap();
        let audio_entries: Vec<&str> = entries
            .iter()
            .filter(|entry| entry["kind"] == "audio")
            .map(|entry| entry["logicalPath"].as_str().unwrap())
            .collect();
        assert_eq!(audio_entries, vec!["ja/mp3/01.mp3"]);
        let manifest = works[0]["userMeta"]["manifest"]["entries"].as_array().unwrap();
        let zh = manifest.iter().find(|entry| entry["logicalPath"] == "zh/mp3/01.mp3").unwrap();
        assert_eq!(zh["aliasOf"], "ja/mp3/01.mp3", "{zh}");
        assert_eq!(zh["status"], "local");
        let ja = manifest.iter().find(|entry| entry["logicalPath"] == "ja/mp3/01.mp3").unwrap();
        assert!(ja.get("aliasOf").is_none(), "{ja}");
        assert_eq!(ja["hash"], zh["hash"], "both rows carry the real sha256");
        assert_eq!(ja["hash"].as_str().unwrap().len(), 64);
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Phase 2a, end to end through the real entry point: the row and the snapshot
    /// keep a source-root relative path (so the library survives a move), and the
    /// delete path resolves that value instead of treating it as absolute. Getting
    /// the second half wrong is silent: the call still reports success while the
    /// bytes stay on disk.
    #[test]
    fn per_file_import_stores_a_relative_path_that_delete_can_resolve() {
        let base = std::env::temp_dir().join(format!("mono-host-relative-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000010] Relative");
        std::fs::create_dir_all(work_root.join("mp3")).unwrap();
        std::fs::write(work_root.join("mp3/01.mp3"), b"relative-audio").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({
                "relativePath": "[RJ09000010] Relative/mp3/01.mp3",
                "workRoot": "[RJ09000010] Relative",
                "metadata": { "title": "Relative", "sourceCode": "RJ09000010" },
            }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();

        let original: String = host
            .library
            .connection
            .query_row("SELECT original_path FROM entry LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(original, "voices/[RJ09000010] Relative/mp3/01.mp3");
        let snapshot: String = host
            .library
            .connection
            .query_row("SELECT snapshot_json FROM source_ref LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert!(
            snapshot.contains("\"sourcePath\":\"voices/[RJ09000010] Relative/mp3/01.mp3\""),
            "{snapshot}"
        );

        // The relative value is what delete-files has to resolve; a raw
        // `Path::new("voices/…")` check fails the "inside the source root" test and
        // silently skips the unlink.
        let result = host.delete_work_files(&work_id, &["mp3/01.mp3".to_string()]).unwrap();
        assert_eq!(result["count"], 1, "{result}");
        assert!(!work_root.join("mp3/01.mp3").exists(), "the bytes are removed, not only the row");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// The edition-tagged manifest rows the frontend writes afterwards must keep
    /// the alias (not resurrect the deleted copy) and the cover must never be
    /// treated as a duplicate of anything.
    #[test]
    fn dedupe_keeps_covers_and_sidecars() {
        let base = std::env::temp_dir().join(format!("mono-host-cover-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000004] Cover");
        std::fs::create_dir_all(work_root.join("cover")).unwrap();
        std::fs::create_dir_all(work_root.join(".monochrome")).unwrap();
        // Same bytes on purpose: covers are excluded from content dedupe.
        std::fs::write(work_root.join("cover/folder.jpg"), b"jpeg").unwrap();
        std::fs::write(work_root.join(".monochrome/folder.jpg"), b"jpeg").unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({ "relativePath": "[RJ09000004] Cover/cover/folder.jpg", "workRoot": "[RJ09000004] Cover" }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();
        host.import_file(&json!({
            "relativePath": "[RJ09000004] Cover/.monochrome/folder.jpg", "workRoot": "[RJ09000004] Cover", "workId": work_id,
        }))
        .unwrap();
        host.dedupe_work_content(&work_id).unwrap();
        assert!(work_root.join("cover/folder.jpg").exists());
        assert!(work_root.join(".monochrome/folder.jpg").exists());
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// The order the download pipeline actually produces: the file is imported
    /// first, then the frontend writes the merged manifest with only the edition
    /// being downloaded tagged, and only then a second edition downloads the same
    /// bytes. The Chinese row therefore has to survive as an alias on the row
    /// that owns the path — a stale `missing` row for that edition meant the user
    /// had to press reconcile before the track showed up as local.
    #[test]
    fn manifest_write_after_first_edition_dedupes_the_second() {
        let base = std::env::temp_dir().join(format!("mono-host-manifest-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000005] Write");
        std::fs::create_dir_all(work_root.join("ja/mp3")).unwrap();
        std::fs::write(work_root.join("ja/mp3/01.mp3"), vec![5u8; 4096]).unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({ "relativePath": "[RJ09000005] Write/ja/mp3/01.mp3", "workRoot": "[RJ09000005] Write" }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();

        // What the frontend writes after the Japanese download: the Japanese row
        // still carries the Kikoeru track id, and the Chinese row is remote.
        let row = |edition: &str, path: &str, hash: &str, status: &str| json!({
            "logicalPath": path, "title": path.rsplit('/').next().unwrap(), "kind": "audio",
            "hash": hash, "editionCode": edition, "status": status,
        });
        let patch = json!({ "manifest": { "version": 2, "entries": [
            row("RJ09000006", "zh/mp3/01.mp3", "9000006/1", "remote"),
            row("RJ09000005", "ja/mp3/01.mp3", "9000005/1", "local"),
        ] } });
        host.library.update_work_metadata(&work_id, patch.as_object().unwrap()).unwrap();
        host.dedupe_work_content(&work_id).unwrap();

        // Second edition: byte-identical audio under its own path.
        std::fs::create_dir_all(work_root.join("zh/mp3")).unwrap();
        std::fs::write(work_root.join("zh/mp3/01.mp3"), vec![5u8; 4096]).unwrap();
        host.import_file(&json!({
            "relativePath": "[RJ09000005] Write/zh/mp3/01.mp3", "workRoot": "[RJ09000005] Write", "workId": work_id,
        }))
        .unwrap();
        // The frontend then rewrites the manifest with the Chinese row tagged.
        // By now the host has already replaced both rows' `hash` with the real
        // sha256 (first dedupe below), and `mergeVoiceManifestEntries` keeps that
        // value, so this is what actually reaches the endpoint.
        let sha = hash::hash_file(&work_root.join("ja/mp3/01.mp3")).unwrap().0;
        let patch = json!({ "manifest": { "version": 2, "entries": [
            row("RJ09000005", "ja/mp3/01.mp3", &sha, "remote"),
            row("RJ09000006", "zh/mp3/01.mp3", &sha, "local"),
        ] } });
        host.library.update_work_metadata(&work_id, patch.as_object().unwrap()).unwrap();
        host.dedupe_work_content(&work_id).unwrap();

        assert!(work_root.join("ja/mp3/01.mp3").exists(), "the first-downloaded copy is kept");
        assert!(!work_root.join("zh/mp3/01.mp3").exists(), "the duplicate is removed on the manifest write");
        let works = host.list_works().unwrap();
        let manifest = works[0]["userMeta"]["manifest"]["entries"].as_array().unwrap();
        assert_eq!(manifest.len(), 2, "{manifest:?}");
        let zh = manifest.iter().find(|entry| entry["editionCode"] == "RJ09000006").unwrap();
        assert_eq!(zh["logicalPath"], "zh/mp3/01.mp3");
        assert_eq!(zh["aliasOf"], "ja/mp3/01.mp3", "{zh}");
        assert_eq!(zh["status"], "local");
        assert_eq!(zh["hash"].as_str().unwrap().len(), 64, "the alias carries the real sha256");
        let ja = manifest.iter().find(|entry| entry["editionCode"] == "RJ09000005").unwrap();
        assert!(ja.get("aliasOf").is_none(), "{ja}");
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    /// A row the frontend synthesised from host entries (no `editionCode`) and the
    /// edition-tagged row for the same path are one file, not two copies.
    #[test]
    fn same_path_rows_are_not_aliased_to_each_other() {
        let base = std::env::temp_dir().join(format!("mono-host-samepath-{}", uuid::Uuid::new_v4()));
        let source_root = base.join("source");
        let work_root = source_root.join("voices").join("[RJ09000003] Same");
        std::fs::create_dir_all(work_root.join("mp3")).unwrap();
        std::fs::write(work_root.join("mp3/01.mp3"), vec![3u8; 2048]).unwrap();
        let mut host = Host::open(HostOptions {
            library_root: base.join("lib"),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();
        let imported = host
            .import_file(&json!({ "relativePath": "[RJ09000003] Same/mp3/01.mp3", "workRoot": "[RJ09000003] Same" }))
            .unwrap();
        let work_id = imported["workId"].as_str().unwrap().to_string();
        let patch = json!({ "manifest": { "version": 2, "entries": [
            { "logicalPath": "mp3/01.mp3", "hash": "entry-uuid", "status": "local" },
            { "logicalPath": "mp3/01.mp3", "hash": "9000003/1", "status": "local", "editionCode": "RJ09000003" },
        ] } });
        host.library.update_work_metadata(&work_id, patch.as_object().unwrap()).unwrap();
        host.dedupe_work_content(&work_id).unwrap();
        assert!(work_root.join("mp3/01.mp3").exists(), "the only copy survives");
        let works = host.list_works().unwrap();
        let manifest = works[0]["userMeta"]["manifest"]["entries"].as_array().unwrap();
        assert_eq!(manifest.len(), 1, "{manifest:?}");
        assert!(manifest[0].get("aliasOf").is_none());
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn open_backfills_text_charsets_idempotently() {
        let base = std::env::temp_dir().join(format!("mono-host-charset-mig-{}", uuid::Uuid::new_v4()));
        let library_root = base.join("lib");
        let source_root = base.join("source");
        let work_dir = source_root.join("voices").join("[RJ09000010] Legacy");
        std::fs::create_dir_all(&work_dir).unwrap();
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("同人音声の説明文です。テスト用に十分な長さを書きます。");
        let (gbk, _, _) = encoding_rs::GBK.encode("这是之前已迁移entry但asset未同步的简体中文文本。");
        std::fs::write(work_dir.join("notes.txt"), &sjis).unwrap();
        std::fs::write(work_dir.join("sync.txt"), &gbk).unwrap();

        {
            let library = Library::open(
                &library_root,
                OpenOptions { create: true, allow_outside_root: true, ..Default::default() },
            )
            .unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO work(work_id, title, created_at, updated_at) VALUES ('w1', 'W', 'now', 'now')",
                    [],
                )
                .unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO track(track_id, work_id, track_key, title, sort_order, created_at)
                     VALUES ('t1', 'w1', 'k1', 'notes.txt', 0, 'now'),
                            ('t2', 'w1', 'k2', 'missing.txt', 1, 'now'),
                            ('t3', 'w1', 'k3', 'sync.txt', 2, 'now')",
                    [],
                )
                .unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO entry(entry_id, work_id, stable_entry_id, logical_path, kind, mime, original_path)
                     VALUES ('e1', 'w1', 's1', 'notes.txt', 'text', 'text/plain', 'voices/[RJ09000010] Legacy/notes.txt'),
                            ('e2', 'w1', 's2', 'missing.txt', 'text', 'text/plain', 'voices/[RJ09000010] Legacy/missing.txt'),
                            ('e3', 'w1', 's3', 'sync.txt', 'text', 'text/plain; charset=gbk', 'voices/[RJ09000010] Legacy/sync.txt')",
                    [],
                )
                .unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                     VALUES ('a1', 'sha1', 10, 'text/plain', 'source/sha1', 'now'),
                            ('a3', 'sha3', 10, 'text/plain', 'source/sha3', 'now')",
                    [],
                )
                .unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                     VALUES ('ar1', 'w1', 'e1', 'a1', 'primary'),
                            ('ar3', 'w1', 'e3', 'a3', 'primary')",
                    [],
                )
                .unwrap();
            library
                .connection
                .execute(
                    "INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                     VALUES ('tr1', 't1', 'e1', 'unknown', 'text/plain', 0, 'now'),
                            ('tr2', 't2', 'e2', 'unknown', 'text/plain', 1, 'now'),
                            ('tr3', 't3', 'e3', 'unknown', 'text/plain', 2, 'now')",
                    [],
                )
                .unwrap();
        }

        let host = Host::open(HostOptions {
            library_root: library_root.clone(),
            source_root: Some(source_root.clone()),
            allowed_source_roots: vec![source_root.clone()],
            allow_outside_root: true,
            experiment_root: None,
            snapshot_fault: None,
        })
        .unwrap();

        let q = |sql: &str, id: &str| -> String {
            host.library
                .connection
                .query_row(sql, rusqlite::params![id], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(q("SELECT mime FROM entry WHERE entry_id = ?", "e1"), "text/plain; charset=shift_jis");
        assert_eq!(q("SELECT mime FROM track_rendition WHERE entry_id = ?", "e1"), "text/plain; charset=shift_jis");
        assert_eq!(q("SELECT mime FROM asset WHERE asset_id = ?", "a1"), "text/plain; charset=shift_jis");
        // Missing file stays bare instead of guessing a default.
        assert_eq!(q("SELECT mime FROM entry WHERE entry_id = ?", "e2"), "text/plain");
        // Previously migrated entry syncs bare asset & rendition without re-sniffing.
        assert_eq!(q("SELECT mime FROM track_rendition WHERE entry_id = ?", "e3"), "text/plain; charset=gbk");
        assert_eq!(q("SELECT mime FROM asset WHERE asset_id = ?", "a3"), "text/plain; charset=gbk");

        // Second run is a no-op.
        assert_eq!(
            ingest::migrate_text_charsets(&host.library.connection, &host.library.data_root, Some(&source_root)).unwrap(),
            0
        );
        drop(host);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn fetch_https_retries_transient_failures_but_not_4xx_or_cap() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        enum Step {
            Reply(Vec<u8>),
            Hang,
            Drop,
        }

        fn serve_script(steps: Vec<Step>) -> (String, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let hits = Arc::new(AtomicUsize::new(0));
            let hits_bg = Arc::clone(&hits);
            let handle = std::thread::spawn(move || {
                for step in steps {
                    let Ok((mut stream, _)) = listener.accept() else { break };
                    hits_bg.fetch_add(1, Ordering::SeqCst);
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    match step {
                        Step::Reply(bytes) => {
                            let _ = stream.write_all(&bytes);
                        }
                        Step::Hang => {
                            std::thread::spawn(move || {
                                let _hold = stream;
                                std::thread::sleep(std::time::Duration::from_millis(350));
                            });
                        }
                        Step::Drop => {
                            drop(stream);
                        }
                    }
                }
            });
            (format!("http://{addr}/cover.webp"), hits, handle)
        }

        let delays = [std::time::Duration::from_millis(10), std::time::Duration::from_millis(20)];
        let timeout = std::time::Duration::from_millis(150);

        // 1. 503 -> 502 -> 200 recovers on 3rd attempt.
        let (url, hits, handle) = serve_script(vec![
            Step::Reply(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
            Step::Reply(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
            Step::Reply(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nimg!".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 1024, timeout, &delays), Some(b"img!".to_vec()));
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        let _ = handle.join();

        // 2. 503 x 3 exhausts attempts and returns None.
        let (url, hits, handle) = serve_script(vec![
            Step::Reply(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
            Step::Reply(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
            Step::Reply(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 1024, timeout, &delays), None);
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        let _ = handle.join();

        // 3. 404 stops immediately on attempt 1.
        let (url, hits, handle) = serve_script(vec![
            Step::Reply(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 1024, timeout, &delays), None);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let _ = handle.join();

        // 4. Timeout on 1st attempt -> 200 on 2nd recovers.
        let (url, hits, handle) = serve_script(vec![
            Step::Hang,
            Step::Reply(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok!".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 1024, timeout, &delays), Some(b"ok!".to_vec()));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let _ = handle.join();

        // 5. Abrupt TCP drop on 1st attempt -> 200 on 2nd recovers.
        let (url, hits, handle) = serve_script(vec![
            Step::Drop,
            Step::Reply(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nyes".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 1024, timeout, &delays), Some(b"yes".to_vec()));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let _ = handle.join();

        // 6. ETOOLARGE and empty 200 body stop immediately without retry.
        let (url, hits, handle) = serve_script(vec![
            Step::Reply(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n0123456789".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 4, timeout, &delays), None);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let _ = handle.join();

        let (url, hits, handle) = serve_script(vec![
            Step::Reply(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
        ]);
        assert_eq!(fetch_https_with(&url, 1024, timeout, &delays), None);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let _ = handle.join();
    }
}

/// Writer for `import_batch_progress` / `import_batch_event` (ingest.mjs
/// `ensureBatchProgress` / `updateBatchProgress` / `addBatchEvent`).
///
/// `update` is a patch: only the keys present in the JSON overwrite the row,
/// exactly like Node's `patch.x ?? current.x`. `/api/import/status` reads the
/// row back, so an omitted key must keep its previous value.
struct BatchProgress<'a> {
    connection: &'a rusqlite::Connection,
    library_id: &'a str,
    batch_id: &'a str,
}

impl BatchProgress<'_> {
    fn ensure(&self, total_candidates: usize) -> Result<()> {
        let timestamp = now_iso();
        self.connection.execute(
            "INSERT OR IGNORE INTO import_batch(batch_id, library_id, status, created_at, updated_at)
             VALUES (?, ?, 'running', ?, ?)",
            rusqlite::params![self.batch_id, self.library_id, timestamp, timestamp],
        )?;
        self.connection.execute(
            "INSERT OR IGNORE INTO import_batch_progress(
                batch_id, library_id, status, phase, current_candidate, total_candidates, updated_at
             ) VALUES (?, ?, 'running', 'queued', 0, ?, ?)",
            rusqlite::params![self.batch_id, self.library_id, total_candidates as i64, timestamp],
        )?;
        Ok(())
    }

    fn update(&self, patch: &Value) -> Result<()> {
        // (json key, column, is_integer)
        const COLUMNS: &[(&str, &str, bool)] = &[
            ("status", "status", false),
            ("phase", "phase", false),
            ("currentCandidate", "current_candidate", true),
            ("totalCandidates", "total_candidates", true),
            ("candidateId", "candidate_id", false),
            ("currentEntry", "current_entry", true),
            ("totalEntries", "total_entries", true),
            ("bytesDone", "bytes_done", true),
            ("bytesTotal", "bytes_total", true),
            ("imported", "imported", true),
            ("updated", "updated", true),
            ("skipped", "skipped", true),
            ("failed", "failed", true),
            ("message", "message", false),
        ];
        let mut sets = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        for (key, column, integer) in COLUMNS {
            let Some(value) = patch.get(*key).filter(|value| !value.is_null()) else { continue };
            sets.push(format!("{column} = ?"));
            values.push(if *integer {
                rusqlite::types::Value::Integer(value.as_i64().unwrap_or(0))
            } else {
                rusqlite::types::Value::Text(storage_core::jsonutil::string_of(value))
            });
        }
        sets.push("updated_at = ?".to_string());
        values.push(rusqlite::types::Value::Text(now_iso()));
        values.push(rusqlite::types::Value::Text(self.batch_id.to_string()));
        values.push(rusqlite::types::Value::Text(self.library_id.to_string()));
        self.connection.execute(
            &format!("UPDATE import_batch_progress SET {} WHERE batch_id = ? AND library_id = ?", sets.join(", ")),
            rusqlite::params_from_iter(values),
        )?;
        Ok(())
    }

    fn event(&self, message: &str, payload: &Value) -> Result<()> {
        let level = payload.get("level").and_then(Value::as_str).unwrap_or("info");
        self.connection.execute(
            "INSERT INTO import_batch_event(batch_id, level, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![self.batch_id, level, message, payload.to_string(), now_iso()],
        )?;
        Ok(())
    }
}

/// Options for [`Host::import_candidates_with`] (the `/api/import` body).
#[derive(Debug, Default, Clone)]
pub struct ImportOptions {
    /// Caller-chosen batch id; the frontend picks one so it can resume polling
    /// after a reload.
    pub batch_id: Option<String>,
    /// Accepted for parity: Node builds the same child key
    /// (`local:ingest:<batch>:<candidate>`) with or without it.
    pub idempotency_key: Option<String>,
}
