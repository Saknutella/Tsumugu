//! Consistent full backup, verification and restore (port of `backup.mjs`, S4a).
//!
//! The database snapshot uses SQLite's online backup API, never a raw copy of a
//! live DB/WAL pair. Only CAS assets referenced by that snapshot are copied, and
//! every copied byte is re-hashed against the snapshot's asset row. `COMPLETE` is
//! the last file written and is only valid when the DB and every copied asset
//! verify. Layout and manifest keys are Node's, so a backup made by either
//! backend restores with the other.
//!
//! Deviation D14: in source-only mode an asset row's `rel_path` is the virtual
//! marker `source/<sha256>`; the bytes live in the user's read-only source tree
//! (`entry.original_path`), not under `data/`. Node tried to copy
//! `data/source/<sha>`, failed with ENOENT, and therefore marked *every* backup
//! of a source-only library `partial` (never restorable). Here those assets are
//! listed under `externalAssets` (sha/bytes/relPath, not copied), excluded from
//! `assets`, and skipped by verify. A restore re-points to the same source files.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::fsutil::{atomic_write, atomic_write_json, ensure_dir, path_exists};
use crate::hash::{copy_to_temp_and_hash, hash_file, sha256_text};
use crate::jsonutil::now_iso;
use crate::library::{Library, OpenOptions};
use crate::paths;
use crate::schema::SCHEMA_VERSION;

pub const BACKUP_FORMAT: &str = "monochrome-storage-lab-backup";
pub const BACKUP_FORMAT_VERSION: i64 = 1;
pub const COMPLETE: &str = "COMPLETE";
pub const COMPLETE_METADATA: &str = "COMPLETE-METADATA";
pub const MANIFEST: &str = "manifest.json";
const DB_REL: &str = "data/library.sqlite";
const TABLE_COUNT_NAMES: &[&str] = &[
    "work",
    "entry",
    "asset",
    "asset_ref",
    "source_ref",
    "user_state",
    "work_document",
    "subtitle_binding",
    "import_job",
    "snapshot_outbox",
];
const REFERENCED_ASSETS_SQL: &str = "SELECT DISTINCT a.sha256, a.bytes, a.rel_path, a.mime
     FROM asset a JOIN asset_ref r ON r.asset_id = a.asset_id
     UNION
     SELECT DISTINCT a.sha256, a.bytes, a.rel_path, a.mime
     FROM asset a JOIN document_asset_ref d ON d.asset_id = a.asset_id
     ORDER BY sha256";

fn coded(code: &'static str, message: impl Into<String>) -> Error {
    Error::coded(code, message)
}

/// `data/<relPath>` with traversal refused (`dataPath`).
/// Where an asset lives in the **live** library: `<root>/<relPath>`.
///
/// `rel_path` already carries its own directory (`derived/sha256/ab/hash`, or the
/// virtual `source/<sha>`), so the layout decides the path, not this function.
fn live_asset_path(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let normalized = validate_asset_rel(rel_path)?;
    let path = normalized.split('/').fold(root.to_path_buf(), |path, part| path.join(part));
    if !paths::is_inside(root, &path) {
        return Err(Error::new(format!("asset path escapes root: {rel_path}")));
    }
    Ok(path)
}

/// Where an asset lives inside a **backup archive**: `<dir>/data/<relPath>`.
///
/// The archive keeps its own `data/` level even though the live library no longer
/// has one: backups written before layout v2 store their database there, and a
/// restore must keep working for them. The archive format is versioned separately
/// from the live layout for exactly this reason.
fn archive_asset_path(dir: &Path, rel_path: &str) -> Result<PathBuf> {
    let normalized = validate_asset_rel(rel_path)?;
    let data = dir.join("data");
    let path = normalized.split('/').fold(data.clone(), |path, part| path.join(part));
    if !paths::is_inside(&data, &path) {
        return Err(Error::new(format!("asset path escapes root: {rel_path}")));
    }
    Ok(path)
}

fn validate_asset_rel(rel_path: &str) -> Result<String> {
    let normalized = rel_path.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.split('/').any(|part| part == "..") {
        return Err(Error::new(format!("invalid asset path: {rel_path}")));
    }
    Ok(normalized)
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

fn file_facts(path: &Path) -> Result<(String, u64)> {
    paths::assert_no_reparse(path, false)?;
    regular_file(path)?;
    hash_file(path)
}

fn ensure_empty_destination(destination: &Path) -> Result<()> {
    if path_exists(destination) {
        let info = std::fs::symlink_metadata(destination)?;
        if info.file_type().is_symlink() {
            return Err(Error::new("destination must not be a symlink/junction"));
        }
        if !info.is_dir() {
            return Err(Error::new("destination exists and is not a directory"));
        }
        if std::fs::read_dir(destination)?.next().is_some() {
            return Err(coded("EBACKUPDEST", "backup destination must be empty"));
        }
    } else {
        std::fs::create_dir_all(destination)?;
    }
    paths::assert_no_reparse(destination, false)
}

#[derive(Debug, Clone)]
struct AssetRow {
    sha256: String,
    bytes: u64,
    rel_path: String,
    mime: String,
}

impl AssetRow {
    fn is_source_only(&self) -> bool {
        self.rel_path.starts_with("source/")
    }
    fn to_json(&self) -> Value {
        json!({ "sha256": self.sha256, "bytes": self.bytes, "relPath": self.rel_path, "mime": self.mime })
    }
}

struct DbFacts {
    integrity: Vec<String>,
    foreign_keys: usize,
    schema_version: i64,
    library_id: Option<String>,
    counts: Map<String, Value>,
}

fn read_db_facts(db: &Connection) -> Result<DbFacts> {
    let mut statement = db.prepare("PRAGMA integrity_check")?;
    let integrity = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut statement = db.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    let mut foreign_keys = 0;
    while rows.next()?.is_some() {
        foreign_keys += 1;
    }
    drop(rows);
    drop(statement);
    let schema_version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let library_id: Option<String> = db.query_row("SELECT library_id FROM library LIMIT 1", [], |row| row.get(0)).ok();
    let mut counts = Map::new();
    for table in TABLE_COUNT_NAMES {
        let count = db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).ok();
        counts.insert((*table).to_string(), count.map(Value::from).unwrap_or(Value::Null));
    }
    Ok(DbFacts { integrity, foreign_keys, schema_version, library_id, counts })
}

fn referenced_assets(db: &Connection) -> Result<Vec<AssetRow>> {
    let mut statement = db.prepare(REFERENCED_ASSETS_SQL)?;
    let rows = statement
        .query_map([], |row| {
            Ok(AssetRow {
                sha256: row.get(0)?,
                bytes: row.get::<_, i64>(1)?.max(0) as u64,
                rel_path: row.get::<_, Option<String>>(2)?.unwrap_or_default().replace('\\', "/"),
                mime: row.get::<_, Option<String>>(3)?.filter(|mime| !mime.is_empty()).unwrap_or_else(|| "application/octet-stream".to_string()),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn open_read_only(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?)
}

struct Staged {
    temp: PathBuf,
    target: PathBuf,
    snapshot: Value,
    assets: Vec<AssetRow>,
}

fn snapshot_database(library: &Library, destination: &Path) -> Result<Staged> {
    let target = destination.join("data").join("library.sqlite");
    ensure_dir(&destination.join("data"))?;
    let temp = destination.join("data").join(format!(
        ".library.sqlite.{}.{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let _ = std::fs::remove_file(&temp);
    // Online backup API: a consistent DB image, never the live WAL file.
    if let Err(error) = library.connection.backup(rusqlite::DatabaseName::Main, &temp, None) {
        let _ = std::fs::remove_file(&temp);
        return Err(Error::from(error));
    }
    std::fs::OpenOptions::new().write(true).open(&temp)?.sync_all()?;
    let (sha256, bytes) = file_facts(&temp)?;
    let db = open_read_only(&temp)?;
    let facts = read_db_facts(&db)?;
    if facts.integrity.iter().any(|value| value != "ok") {
        return Err(Error::new(format!("snapshot integrity_check failed: {}", facts.integrity.join(","))));
    }
    if facts.foreign_keys > 0 {
        return Err(Error::new("snapshot foreign_key_check failed"));
    }
    if facts.schema_version != SCHEMA_VERSION {
        return Err(Error::new(format!("unexpected schema version {}", facts.schema_version)));
    }
    if facts.library_id.as_deref() != Some(library.library_id.as_str()) {
        return Err(Error::new("snapshot library id mismatch"));
    }
    let assets = referenced_assets(&db)?;
    drop(db);
    // D16: the snapshot keeps the live DB's WAL journal mode, so the read-only
    // verify connection creates empty `<temp>-wal`/`-shm` files. Once the temp
    // is renamed they belong to no database; Node leaves them in every backup.
    for suffix in ["-wal", "-shm"] {
        let mut side = temp.clone().into_os_string();
        side.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(side));
    }
    if assets.iter().any(|asset| asset.rel_path.is_empty()) {
        return Err(Error::new("snapshot has asset without rel_path"));
    }
    Ok(Staged {
        temp,
        target,
        snapshot: json!({
            "file": DB_REL,
            "sha256": sha256,
            "bytes": bytes,
            "schemaVersion": facts.schema_version,
            "libraryId": facts.library_id,
            "counts": Value::Object(facts.counts),
        }),
        assets,
    })
}

fn part_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(format!(".{}.{}.part", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
    PathBuf::from(name)
}

/// Copy `source` to `target` through a `.part`, verifying size and hash first.
fn copy_verified(source: &Path, target: &Path, expected: Option<(&str, u64)>) -> Result<(String, u64)> {
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    paths::assert_no_reparse(source, false)?;
    let temp = part_path(target);
    let (sha256, bytes) = copy_to_temp_and_hash(source, &temp, false, None)?;
    if let Some((expected_sha, expected_bytes)) = expected {
        if sha256 != expected_sha || bytes != expected_bytes {
            let _ = std::fs::remove_file(&temp);
            return Err(Error::new(format!("file failed size/hash verification: {}", target.display())));
        }
    }
    std::fs::rename(&temp, target)?;
    Ok((sha256, bytes))
}

fn write_manifest_and_marker(destination: &Path, manifest: &Value, complete: bool, metadata_only: bool) -> Result<()> {
    let mut text = serde_json::to_string_pretty(manifest)?;
    text.push('\n');
    atomic_write(&destination.join(MANIFEST), text.as_bytes())?;
    if !complete {
        return Ok(());
    }
    let marker = json!({ "manifestSha256": sha256_text(&text), "completedAt": now_iso(), "includeMedia": !metadata_only });
    let mut marker_text = serde_json::to_string_pretty(&marker)?;
    marker_text.push('\n');
    atomic_write(&destination.join(if metadata_only { COMPLETE_METADATA } else { COMPLETE }), marker_text.as_bytes())
}

/// Options for [`Library::backup_library`].
#[derive(Debug, Clone)]
pub struct BackupOptions {
    pub include_media: bool,
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self { include_media: true }
    }
}

impl Library {
    /// Back up into an empty destination (`backupLibrary`).
    ///
    /// Returns a structured partial result instead of claiming COMPLETE when a
    /// CAS asset is missing or corrupt; the caller decides to retry or discard.
    pub fn backup_library(&self, destination: &Path, options: &BackupOptions) -> Result<Value> {
        self.assert_open()?;
        let dest = paths::resolve_lexical(destination);
        if dest == paths::resolve_lexical(&self.root) || paths::is_inside(&self.data_root, &dest) {
            return Err(coded("EBACKUPDEST", "backup destination must not be the library data root or inside it"));
        }
        ensure_empty_destination(&dest)?;
        let started_at = now_iso();
        let mut errors: Vec<Value> = Vec::new();
        let staged = match snapshot_database(self, &dest).and_then(|staged| {
            std::fs::rename(&staged.temp, &staged.target)?;
            Ok(staged)
        }) {
            Ok(staged) => staged,
            Err(error) => {
                errors.push(json!({ "stage": "database", "error": error.message }));
                let partial = json!({
                    "format": BACKUP_FORMAT,
                    "formatVersion": BACKUP_FORMAT_VERSION,
                    "libraryId": self.library_id,
                    "schemaVersion": SCHEMA_VERSION,
                    "createdAt": started_at,
                    "status": "partial",
                    "includeMedia": options.include_media,
                    "errors": errors,
                    "data": Value::Null,
                    "assets": [],
                });
                write_manifest_and_marker(&dest, &partial, false, false)?;
                return Ok(json!({ "dir": dest.to_string_lossy(), "complete": false, "status": "partial", "manifest": partial, "errors": partial["errors"] }));
            }
        };

        let (external, cas): (Vec<AssetRow>, Vec<AssetRow>) = staged.assets.iter().cloned().partition(AssetRow::is_source_only);
        let mut copied: Vec<Value> = Vec::new();
        let mut total_bytes = 0u64;
        if options.include_media {
            for asset in &cas {
                let result = live_asset_path(&self.root, &asset.rel_path)
                    .and_then(|source| Ok((source, archive_asset_path(&dest, &asset.rel_path)?)))
                    .and_then(|(source, target)| copy_verified(&source, &target, Some((&asset.sha256, asset.bytes))));
                match result {
                    Ok((sha256, bytes)) => {
                        let mut row = asset.to_json();
                        row["sha256"] = json!(sha256);
                        row["bytes"] = json!(bytes);
                        copied.push(row);
                        total_bytes += bytes;
                    }
                    Err(error) => errors.push(json!({
                        "stage": "asset",
                        "sha256": asset.sha256,
                        "relPath": asset.rel_path,
                        "error": error.message,
                    })),
                }
            }
        }
        let complete = errors.is_empty();
        let manifest = json!({
            "format": BACKUP_FORMAT,
            "formatVersion": BACKUP_FORMAT_VERSION,
            "libraryId": self.library_id,
            "schemaVersion": staged.snapshot["schemaVersion"],
            "createdAt": started_at,
            "completedAt": if complete { json!(now_iso()) } else { Value::Null },
            "status": if complete { if options.include_media { "complete" } else { "complete-metadata" } } else { "partial" },
            "includeMedia": options.include_media,
            "completeKind": if options.include_media { "media" } else { "metadata" },
            "data": staged.snapshot,
            "assets": if options.include_media { Value::Array(copied.clone()) } else { json!([]) },
            "externalAssets": external.iter().map(AssetRow::to_json).collect::<Vec<_>>(),
            "referencedAssetCount": staged.assets.len(),
            "assetCount": copied.len(),
            "totalAssetBytes": total_bytes,
            "errors": errors,
        });
        write_manifest_and_marker(&dest, &manifest, complete, !options.include_media)?;
        Ok(json!({
            "dir": dest.to_string_lossy(),
            "complete": complete,
            "status": manifest["status"],
            "manifest": manifest,
            "errors": manifest["errors"],
        }))
    }
}

fn issue(issues: &mut Vec<Value>, code: &str, detail: Value) {
    issues.push(json!({ "code": code, "detail": detail }));
}

fn verify_manifest_and_marker(dir: &Path, manifest: &Value, issues: &mut Vec<Value>) {
    if !manifest.is_object() {
        issue(issues, "manifest-missing", json!("manifest.json is missing or unreadable"));
        return;
    }
    if manifest["format"] != BACKUP_FORMAT {
        issue(issues, "manifest-format", manifest["format"].clone());
    }
    if manifest["formatVersion"].as_f64() != Some(BACKUP_FORMAT_VERSION as f64) {
        issue(issues, "manifest-version", manifest["formatVersion"].clone());
    }
    if manifest["libraryId"].as_str().map(str::is_empty).unwrap_or(true) {
        issue(issues, "manifest-library-id", json!("libraryId missing"));
    }
    let data = &manifest["data"];
    if data["sha256"].as_str().map(str::is_empty).unwrap_or(true) || data["bytes"].as_f64().is_none() {
        issue(issues, "manifest-db-entry", json!("database hash/size missing"));
    }
    if !manifest["assets"].is_array() {
        issue(issues, "manifest-assets", json!("assets array missing"));
    }
    if manifest["status"] == "partial" || manifest["errors"].as_array().map(|items| !items.is_empty()).unwrap_or(false) {
        issue(issues, "manifest-partial", json!("backup manifest records a partial backup"));
    }
    if manifest["includeMedia"] != Value::Bool(false) {
        let marker_path = dir.join(COMPLETE);
        if !path_exists(&marker_path) {
            issue(issues, "missing-complete", json!("COMPLETE marker missing"));
        } else {
            let marker = std::fs::read_to_string(&marker_path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
            let raw = std::fs::read_to_string(dir.join(MANIFEST)).unwrap_or_default();
            match marker {
                Some(marker) if marker["manifestSha256"] == sha256_text(&raw) => {}
                Some(_) => issue(issues, "complete-manifest-hash", json!("COMPLETE does not match manifest.json")),
                None => issue(issues, "complete-unreadable", json!("COMPLETE is not valid JSON")),
            }
        }
    } else if !path_exists(&dir.join(COMPLETE_METADATA)) {
        issue(issues, "missing-metadata-complete", json!("COMPLETE-METADATA missing"));
    }
}

/// Verify manifest, marker, snapshot DB (integrity, FKs, schema, counts) and
/// every copied asset (`verifyBackup`). A partial backup is never restorable.
pub fn verify_backup(backup_dir: &Path) -> Value {
    let dir = paths::resolve_lexical(backup_dir);
    let mut issues: Vec<Value> = Vec::new();
    let manifest_path = dir.join(MANIFEST);
    if !path_exists(&manifest_path) {
        return json!({ "ok": false, "dir": dir.to_string_lossy(), "issues": [{ "code": "manifest-missing", "detail": manifest_path.to_string_lossy() }], "manifest": Value::Null });
    }
    let manifest = crate::fsutil::read_json(&manifest_path, None).unwrap_or(Value::Null);
    verify_manifest_and_marker(&dir, &manifest, &mut issues);

    let db_path = dir.join("data").join("library.sqlite");
    let referenced: Vec<AssetRow> = match (|| -> Result<Vec<AssetRow>> {
        let (sha256, bytes) = file_facts(&db_path)?;
        if manifest["data"]["sha256"] != sha256 || manifest["data"]["bytes"].as_u64() != Some(bytes) {
            issue(&mut issues, "db-hash-mismatch", json!("database bytes do not match manifest"));
        }
        let db = open_read_only(&db_path)?;
        let facts = read_db_facts(&db)?;
        if facts.integrity.iter().any(|value| value != "ok") {
            issue(&mut issues, "db-integrity", json!(facts.integrity.join(",")));
        }
        if facts.foreign_keys > 0 {
            issue(&mut issues, "db-foreign-keys", json!(facts.foreign_keys));
        }
        if Some(facts.schema_version) != manifest["schemaVersion"].as_i64() {
            issue(&mut issues, "db-schema-version", json!(facts.schema_version));
        }
        if facts.library_id.as_deref() != manifest["libraryId"].as_str() {
            issue(&mut issues, "db-library-id", json!(facts.library_id));
        }
        if Value::Object(facts.counts.clone()) != manifest["data"]["counts"] {
            issue(&mut issues, "db-counts-mismatch", json!({ "actual": facts.counts, "expected": manifest["data"]["counts"] }));
        }
        referenced_assets(&db)
    })() {
        Ok(rows) => rows,
        Err(error) => {
            issue(&mut issues, "db-unreadable", json!(error.message));
            Vec::new()
        }
    };

    if manifest["includeMedia"] == Value::Bool(false) {
        if manifest["assets"].as_array().map(|items| !items.is_empty()).unwrap_or(false) {
            issue(&mut issues, "metadata-backup-has-assets", json!("metadata-only backup lists media assets"));
        }
    } else {
        let listed: Vec<&Value> = manifest["assets"].as_array().map(|items| items.iter().collect()).unwrap_or_default();
        for asset in referenced.iter().filter(|asset| !asset.is_source_only()) {
            let Some(entry) = listed.iter().find(|item| item["sha256"] == asset.sha256.as_str()) else {
                issue(&mut issues, "asset-missing-from-manifest", json!(asset.rel_path));
                continue;
            };
            let rel = entry["relPath"].as_str().unwrap_or("");
            if rel != asset.rel_path {
                issue(&mut issues, "asset-path-mismatch", json!({ "sha256": asset.sha256, "expected": asset.rel_path, "actual": rel }));
            }
            match archive_asset_path(&dir, rel).and_then(|path| file_facts(&path)) {
                Ok((sha256, bytes)) => {
                    if entry["sha256"] != sha256 || entry["bytes"].as_u64() != Some(bytes) {
                        issue(&mut issues, "asset-hash-mismatch", json!(rel));
                    }
                }
                Err(error) => issue(&mut issues, "asset-unreadable", json!({ "relPath": rel, "error": error.message })),
            }
        }
        for entry in &listed {
            if !referenced.iter().any(|asset| entry["sha256"] == asset.sha256.as_str()) {
                issue(&mut issues, "asset-extra-in-manifest", entry["relPath"].clone());
            }
        }
    }
    json!({
        "ok": issues.is_empty(),
        "dir": dir.to_string_lossy(),
        "issues": issues,
        "libraryId": manifest["libraryId"],
        "assetCount": manifest["assets"].as_array().map(Vec::len).unwrap_or(0),
        "manifest": manifest,
    })
}

/// Restore a verified backup into an empty directory (`restoreLibrary`).
///
/// The backup is read-only; libraryId and asset paths are preserved, and the
/// restored root is opened once to verify SQLite/FKs/schema before returning.
pub fn restore_library(backup_dir: &Path, empty_root: &Path) -> Result<Value> {
    let dir = paths::resolve_lexical(backup_dir);
    let destination = paths::resolve_lexical(empty_root);
    // Check the existing ancestor chain *before* any write: bytes must not
    // escape through a junction (Node P1-3).
    paths::assert_no_reparse(&destination, true)?;
    let check = verify_backup(&dir);
    if check["ok"] != Value::Bool(true) {
        let codes: Vec<String> = check["issues"]
            .as_array()
            .map(|items| items.iter().filter_map(|item| item["code"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        return Err(coded("EINVALIDBACKUP", format!("backup is not restorable: {}", codes.join(","))));
    }
    if paths::is_inside(&dir, &destination) || paths::is_inside(&destination, &dir) {
        return Err(coded("ERESTOREDEST", "restore destination must be outside the backup directory"));
    }
    if path_exists(&destination) {
        let info = std::fs::symlink_metadata(&destination)?;
        if !info.is_dir() || std::fs::read_dir(&destination)?.next().is_some() {
            return Err(coded("ERESTORENOTEMPTY", "restore destination must be empty"));
        }
    }
    std::fs::create_dir_all(&destination)?;
    paths::assert_no_reparse(&destination, false)?;
    let manifest = &check["manifest"];
    let db_expected = manifest["data"]["sha256"].as_str().unwrap_or("").to_string();
    let db_bytes = manifest["data"]["bytes"].as_u64().unwrap_or(0);
    // The archive keeps `<dir>/data/library.sqlite`; the live library puts the
    // database at its root. Old archives restore unchanged thanks to this split.
    copy_verified(
        &dir.join("data").join("library.sqlite"),
        &destination.join(crate::layout::LIBRARY_SQLITE),
        Some((&db_expected, db_bytes)),
    )?;
    for asset in manifest["assets"].as_array().into_iter().flatten() {
        paths::assert_no_reparse(&destination, false)?;
        let rel = asset["relPath"].as_str().unwrap_or("");
        let sha = asset["sha256"].as_str().unwrap_or("");
        let bytes = asset["bytes"].as_u64().unwrap_or(0);
        copy_verified(&archive_asset_path(&dir, rel)?, &live_asset_path(&destination, rel)?, Some((sha, bytes)))?;
    }
    atomic_write_json(
        &destination.join("root.json"),
        &json!({
            "schemaVersion": manifest["schemaVersion"],
            "libraryId": manifest["libraryId"],
            "createdAt": now_iso(),
            "app": "monochrome-storage-lab",
            "restoredFrom": "backup",
        }),
    )?;
    {
        let mut restored = Library::open(&destination, OpenOptions { create: false, allow_outside_root: true, ..Default::default() })?;
        let verification = restored.verify_library()?;
        // Restored files are kept for inspection, but success is never claimed.
        if verification["ok"] != Value::Bool(true) {
            let codes: Vec<String> = verification["issues"]
                .as_array()
                .map(|items| items.iter().filter_map(|item| item["code"].as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            return Err(Error::new(format!("restored library verification failed: {}", codes.join(","))));
        }
        restored.close()?;
    }
    Ok(json!({
        "root": destination.to_string_lossy(),
        "libraryId": manifest["libraryId"],
        "schemaVersion": manifest["schemaVersion"],
        "verified": true,
        "check": check,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::SourceRecord;

    fn fixture(tag: &str) -> (Library, PathBuf) {
        let base = std::env::temp_dir().join(format!("mono-backup-{tag}-{}", uuid::Uuid::new_v4()));
        let source = base.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("01.mp3"), b"backup-audio").unwrap();
        let mut library = Library::open(base.join("lib"), OpenOptions { create: true, allow_outside_root: true, ..Default::default() }).unwrap();
        let record = SourceRecord::from_json(&json!({
            "provider": "dlsite", "sourceCode": "RJ00000077", "title": "Backup fixture",
            "entries": [{ "entryId": "b-1", "logicalPath": "01.mp3", "kind": "audio", "mime": "audio/mpeg",
                          "sourcePath": source.join("01.mp3").to_string_lossy() }]
        }))
        .unwrap();
        library.import_work(record, "backup-key").unwrap();
        (library, base)
    }

    #[test]
    fn source_only_library_backs_up_complete_and_restores() {
        let (library, base) = fixture("roundtrip");
        let result = library.backup_library(&base.join("backup"), &BackupOptions::default()).unwrap();
        assert_eq!(result["complete"], true, "D14: source-only assets must not make the backup partial: {result}");
        let manifest = &result["manifest"];
        assert_eq!(manifest["assets"].as_array().unwrap().len(), 0);
        assert_eq!(manifest["externalAssets"].as_array().unwrap().len(), 1);
        assert!(base.join("backup").join(COMPLETE).is_file());
        // D16: only the snapshot itself, no orphan journal files of the temp copy.
        let data_files: Vec<String> = std::fs::read_dir(base.join("backup").join("data"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(data_files, vec!["library.sqlite".to_string()]);
        assert_eq!(verify_backup(&base.join("backup"))["ok"], true);

        let library_id = library.library_id.clone();
        drop(library);
        let restored = restore_library(&base.join("backup"), &base.join("restored")).unwrap();
        assert_eq!(restored["libraryId"], json!(library_id));
        let reopened = Library::open(base.join("restored"), OpenOptions { create: false, allow_outside_root: true, ..Default::default() }).unwrap();
        let works: i64 = reopened.connection.query_row("SELECT COUNT(*) FROM work", [], |row| row.get(0)).unwrap();
        assert_eq!(works, 1);
        drop(reopened);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn destination_rules_and_tamper_detection() {
        let (library, base) = fixture("rules");
        std::fs::create_dir_all(base.join("busy")).unwrap();
        std::fs::write(base.join("busy").join("x"), b"x").unwrap();
        assert_eq!(library.backup_library(&base.join("busy"), &BackupOptions::default()).unwrap_err().code, Some("EBACKUPDEST"));
        assert_eq!(library.backup_library(&library.data_root.join("nested"), &BackupOptions::default()).unwrap_err().code, Some("EBACKUPDEST"));

        library.backup_library(&base.join("backup"), &BackupOptions::default()).unwrap();
        // Tamper with the manifest: COMPLETE no longer matches it.
        let manifest = base.join("backup").join(MANIFEST);
        let text = std::fs::read_to_string(&manifest).unwrap().replace("\"complete\"", "\"complete \"");
        std::fs::write(&manifest, text).unwrap();
        let check = verify_backup(&base.join("backup"));
        assert_eq!(check["ok"], false);
        assert!(check["issues"].as_array().unwrap().iter().any(|issue| issue["code"] == "complete-manifest-hash"));
        assert_eq!(restore_library(&base.join("backup"), &base.join("restored")).unwrap_err().code, Some("EINVALIDBACKUP"));

        let metadata = library.backup_library(&base.join("meta"), &BackupOptions { include_media: false }).unwrap();
        assert_eq!(metadata["status"], "complete-metadata");
        assert!(base.join("meta").join(COMPLETE_METADATA).is_file());
        drop(library);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn restore_refuses_non_empty_destination() {
        let (library, base) = fixture("nonempty");
        library.backup_library(&base.join("backup"), &BackupOptions::default()).unwrap();
        drop(library);
        std::fs::create_dir_all(base.join("restored")).unwrap();
        std::fs::write(base.join("restored").join("keep.txt"), b"user data").unwrap();
        assert_eq!(restore_library(&base.join("backup"), &base.join("restored")).unwrap_err().code, Some("ERESTORENOTEMPTY"));
        assert_eq!(std::fs::read(base.join("restored").join("keep.txt")).unwrap(), b"user data");
        let _ = std::fs::remove_dir_all(base);
    }
}
