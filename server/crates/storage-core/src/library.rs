//! Storage core API (`library.mjs`).
//!
//! One `Library` owns one SQLite connection and one root lease. The Node
//! implementation is synchronous too (`node:sqlite` `DatabaseSync`), so the port
//! keeps the same shape: the HTTP layer wraps this in a mutex and runs it on a
//! blocking thread. That is what makes `BEGIN IMMEDIATE` sufficient — there is
//! never a second writer connection inside the process, and the OS lease excludes
//! other processes.
//!
//! Transaction rule: every multi-statement mutation runs inside `BEGIN IMMEDIATE`.
//! A deferred transaction would allow two writers to both read and then have one
//! fail at COMMIT under WAL, which surfaces as a spurious 500 instead of a retry.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Row as SqlRow};
use serde_json::{json, Map, Value};

use crate::error::{abort_error, Error, Result};
use crate::layout;
use crate::fsutil;
use crate::hash::{self, sha256_text};
use crate::jsonutil::{
    manifest_entries, merge_objects, now_iso, parse_object, parse_string_array, trimmed,
    unique_trimmed,
};
use crate::paths;
use crate::schema;
use crate::snapshot::{self, SnapshotFault, SnapshotModel};

/// Metadata keys `updateWorkMetadata()` is allowed to write into `user_meta_json`.
///
/// This is a whitelist, not a filter of convenience: `user_meta_json` is a JSON
/// column that both the host and the frontend round-trip, so an un-whitelisted key
/// would be a silent way to write arbitrary state that no migration knows about.
const METADATA_KEYS: &[&str] = &[
    "tags",
    "rating",
    "ratingCount",
    "price",
    "currency",
    "release",
    "ageCategory",
    "nsfw",
    "sourceCode",
    "editionLang",
    "editionLabel",
    "originalCode",
    "manual",
    "editionCodes",
    "durations",
    "sourceUrl",
    "pageUrl",
    "partial",
    "manifest",
    "artists",
    "trueCircle",
    // The frontend round-trips these through `persistRemoteMetadata()` and reads
    // them back from `userMeta`; Node's list omitted them, so the value was
    // written and then silently dropped on the next reload (D18).
    "translators",
];

/// One validated source entry.
#[derive(Debug, Clone)]
pub struct SourceEntry {
    pub stable_entry_id: String,
    pub logical_path: String,
    pub kind: String,
    pub mime: String,
    pub source_path: String,
    /// Absolute path to open while importing, when the producer knows one.
    ///
    /// WHY it is separate from `source_path`: layout v2 stores `sourcePath`
    /// relative to the source root, so the record survives a moved library, but the
    /// import still has to hash the real bytes before anything is written. The
    /// ingest layer therefore passes both — the stored form and the absolute path
    /// it validated. Callers that only know one form (a source-only fixture,
    /// `sourcePath` written absolutely before phase 2a) leave this empty and the
    /// stored value is read as-is.
    pub absolute_path: Option<String>,
    pub display_title: String,
    pub track_key: String,
    pub format: String,
    /// Set during import once the bytes have been hashed.
    pub asset: Option<PublishedAsset>,
}

impl SourceEntry {
    /// Path to open when hashing: the producer's validated absolute path when it
    /// supplied one, else the stored value.
    pub fn read_path(&self) -> &str {
        self.absolute_path
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.source_path)
    }
}

#[derive(Debug, Clone)]
pub struct PublishedAsset {
    pub asset_id: String,
    pub sha256: String,
    pub bytes: u64,
    pub mime: String,
    pub rel_path: String,
}

/// A normalized source record (`normalizeSource`).
#[derive(Debug, Clone)]
pub struct SourceRecord {
    pub provider: String,
    pub source_code: String,
    pub title: String,
    pub circle: String,
    pub cvs: Vec<String>,
    pub family_id: Option<String>,
    pub language: String,
    pub role: String,
    pub entries: Vec<SourceEntry>,
}

impl SourceRecord {
    /// Build from the JSON shape the scanner/ingest layer produces.
    pub fn from_json(value: &Value) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| Error::new("sourceRecord must be an object"))?;
        let provider = trimmed(object.get("provider"), "");
        let source_code = trimmed(object.get("sourceCode"), "");
        let title = trimmed(object.get("title"), "");
        if provider.is_empty() {
            return Err(Error::new("source.provider is required"));
        }
        if source_code.is_empty() {
            return Err(Error::new("source.sourceCode is required"));
        }
        if title.is_empty() {
            return Err(Error::new("source.title is required"));
        }
        let raw_entries = object
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::new("source.entries must be an array"))?;
        let mut entries = Vec::with_capacity(raw_entries.len());
        for (index, entry) in raw_entries.iter().enumerate() {
            entries.push(validate_entry(entry, index)?);
        }
        let mut stable_ids = Vec::new();
        let mut logical_paths = Vec::new();
        for entry in &entries {
            if stable_ids.contains(&entry.stable_entry_id) {
                return Err(Error::new(format!("duplicate entryId: {}", entry.stable_entry_id)));
            }
            if logical_paths.contains(&entry.logical_path) {
                return Err(Error::new(format!("duplicate logicalPath: {}", entry.logical_path)));
            }
            stable_ids.push(entry.stable_entry_id.clone());
            logical_paths.push(entry.logical_path.clone());
        }
        let edition = object.get("edition").and_then(Value::as_object);
        Ok(Self {
            provider,
            source_code,
            title,
            circle: trimmed(object.get("circle"), ""),
            cvs: object
                .get("cvs")
                .and_then(Value::as_array)
                .map(|items| items.iter().map(crate::jsonutil::string_of).collect())
                .unwrap_or_default(),
            family_id: object
                .get("familyId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            language: trimmed(edition.and_then(|value| value.get("language")), ""),
            role: trimmed(edition.and_then(|value| value.get("role")), ""),
            entries,
        })
    }

    /// JSON stored in `source_ref.snapshot_json`: Node stores the whole
    /// normalized record (`JSON.stringify({ sourceRecord: source })`), including
    /// `displayTitle` and, once published, each entry's `asset`.
    pub fn to_json(&self) -> Value {
        json!({
            "provider": self.provider,
            "sourceCode": self.source_code,
            "title": self.title,
            "circle": self.circle,
            "cvs": self.cvs,
            "familyId": self.family_id,
            "edition": { "language": self.language, "role": self.role },
            "entries": self.entries.iter().map(|entry| {
                let mut object = json!({
                    "stableEntryId": entry.stable_entry_id,
                    "logicalPath": entry.logical_path,
                    "kind": entry.kind,
                    "mime": entry.mime,
                    "sourcePath": entry.source_path,
                    "displayTitle": entry.display_title,
                    "trackKey": entry.track_key,
                    "format": entry.format,
                });
                if let Some(asset) = &entry.asset {
                    object["asset"] = json!({
                        "assetId": asset.asset_id,
                        "sha256": asset.sha256,
                        "bytes": asset.bytes,
                        "mime": asset.mime,
                        "relPath": asset.rel_path,
                    });
                }
                object
            }).collect::<Vec<_>>(),
        })
    }

    /// Idempotency plan hash, byte-identical to Node's `planHashFor`.
    ///
    /// It deliberately omits `displayTitle` and `asset`: a job written by one
    /// backend must hash the same in the other, or replaying its key raises a
    /// false `EIDEMPOTENCYCONFLICT`.
    pub fn plan_hash(&self) -> String {
        let plan = json!({
            "provider": self.provider,
            "sourceCode": self.source_code,
            "title": self.title,
            "circle": self.circle,
            "cvs": self.cvs,
            "familyId": self.family_id,
            "edition": { "language": self.language, "role": self.role },
            "entries": self.entries.iter().map(|entry| json!({
                "stableEntryId": entry.stable_entry_id,
                "logicalPath": entry.logical_path,
                "kind": entry.kind,
                "mime": entry.mime,
                "sourcePath": entry.source_path,
                "trackKey": entry.track_key,
                "format": entry.format,
            })).collect::<Vec<_>>(),
        });
        sha256_text(&serde_json::to_string(&plan).unwrap_or_default())
    }
}

fn validate_entry(entry: &Value, index: usize) -> Result<SourceEntry> {
    let object = entry
        .as_object()
        .ok_or_else(|| Error::new(format!("entry[{index}] must be an object")))?;
    let stable_entry_id = trimmed(object.get("entryId"), "");
    if stable_entry_id.is_empty() {
        return Err(Error::new(format!("entry[{index}] entryId is required")));
    }
    let logical_path = paths::validate_logical_path(&trimmed(object.get("logicalPath"), ""))?;
    let kind = {
        let value = trimmed(object.get("kind"), "file");
        if value.is_empty() { "file".to_string() } else { value }
    };
    let source_path = trimmed(object.get("sourcePath"), "");
    if source_path.is_empty() {
        return Err(Error::new(format!("entry[{index}] sourcePath is required")));
    }
    // Optional companion of a relative `sourcePath`: the absolute path the
    // producer validated, used only to open the bytes. Never stored.
    let absolute_path = {
        let value = trimmed(object.get("absolutePath"), "");
        if value.is_empty() { None } else { Some(value) }
    };
    let mime = {
        let value = trimmed(object.get("mime"), "application/octet-stream");
        if value.is_empty() { "application/octet-stream".to_string() } else { value }
    };
    let display_title = {
        let value = trimmed(object.get("title"), "");
        if value.is_empty() {
            logical_path.split('/').next_back().unwrap_or(&logical_path).to_string()
        } else {
            value
        }
    };
    Ok(SourceEntry {
        stable_entry_id,
        logical_path,
        kind,
        mime,
        source_path,
        absolute_path,
        display_title,
        track_key: trimmed(object.get("trackKey"), ""),
        format: trimmed(object.get("format"), ""),
        asset: None,
    })
}

/// Options for [`open_library`].
#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    pub create: bool,
    /// Allow a library root outside the experiment root. The host passes `true`
    /// (its data root is the user's real MonochromeData); tests keep `false`.
    pub allow_outside_root: bool,
    /// `.cache/storage-lab` equivalent. Required when `allow_outside_root` is false.
    pub experiment_root: Option<PathBuf>,
    /// Inject a snapshot fault into every publication (test hook, C79-03).
    pub snapshot_fault: Option<SnapshotFault>,
}

/// An open library: one connection, one lease, one data root.
#[derive(Debug)]
pub struct Library {
    pub root: PathBuf,
    pub library_id: String,
    pub data_root: PathBuf,
    pub connection: Connection,
    /// Held for the lifetime of the library; dropping it releases the OS lease.
    lease: Option<fsutil::RootLease>,
    allow_outside_root: bool,
    snapshot_fault: Option<SnapshotFault>,
    /// Same-key concurrent imports share one operation (P1-2).
    active_imports: HashMap<String, String>,
    closed: bool,
}

impl Library {
    /// Open (and optionally create) a library root.
    pub fn open(root: impl AsRef<Path>, options: OpenOptions) -> Result<Self> {
        let raw = root.as_ref();
        let absolute = paths::resolve_lexical(raw);
        if !options.allow_outside_root {
            let experiment = options
                .experiment_root
                .clone()
                .or_else(|| std::env::var("MONOCHROME_EXPERIMENT_ROOT").ok().map(PathBuf::from))
                .ok_or_else(|| {
                    Error::outside_root(format!(
                        "root must be below the experiment root; none configured for {}",
                        absolute.display()
                    ))
                })?;
            if !paths::is_inside(&experiment, &absolute) || paths::resolve_lexical(&experiment) == absolute {
                return Err(Error::outside_root(format!(
                    "root must be below {}",
                    experiment.display()
                )));
            }
        }
        // A missing root is acceptable only when creating it.
        fsutil::ensure_dir(&absolute)?;
        paths::assert_no_reparse(&absolute, false)?;

        // Layout v1 kept everything under `<root>/data/`. Convert the files before
        // opening the database: on Windows an open SQLite handle cannot be renamed,
        // and doing it first keeps an interrupted migration resumable — the next
        // open finds a flat database and only has rows left to rewrite.
        //
        // Runs regardless of `create`: the host always opens with `create: true`
        // (it does not know yet whether the root is new), and gating on that flag
        // meant a v1 root was never converted — the host instead created a second,
        // empty database beside it. `migrate_files` is a no-op when there is
        // nothing to move.
        crate::layout::migrate_files(&absolute)?;

        let data_root = absolute.clone();
        if options.create {
            for directory in crate::layout::directories(&absolute) {
                fsutil::ensure_dir(&directory)?;
            }
        } else if !fsutil::path_exists(&data_root.join(crate::layout::LIBRARY_SQLITE)) {
            return Err(Error::coded(
                "ENOLIBRARY",
                format!("no storage-lab library at {}", absolute.display()),
            ));
        }

        let lease = fsutil::acquire_lock(&absolute, None).map_err(|error| {
            // The lease error carries ELOCKED; keep the code so the CLI can print it.
            error
        })?;

        let root_path = absolute.join("root.json");
        let existing_root = fsutil::read_json(&root_path, None);
        if existing_root.is_none() && !options.create {
            return Err(Error::new("missing root.json"));
        }
        let mut library_id = existing_root
            .as_ref()
            .and_then(|value| value.get("libraryId"))
            .and_then(Value::as_str)
            .map(str::to_string);

        let database_path = data_root.join("library.sqlite");
        let connection = Connection::open(&database_path)?;
        schema::enable_pragmas(&connection)?;
        let provisional_id = library_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        schema::apply_schema(&connection, &provisional_id)?;
        // Stored paths from a v1 root still use the old directory names. Every
        // statement is a prefix replacement that matches nothing once applied, so
        // this runs unconditionally instead of trusting a version marker — a root
        // migrated by an older build can still carry unmigrated rows.
        // `entry.original_path` needs the source root, which only the host knows;
        // it repeats this call from `Host::open`.
        crate::layout::migrate_rows(&connection, None)?;

        let library_row: Option<(String, i64)> = connection
            .query_row("SELECT library_id, schema_version FROM library LIMIT 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        let Some((row_library_id, _version)) = library_row else {
            return Err(Error::new("library row missing after schema migration"));
        };
        if let Some(existing) = &library_id {
            if existing != &row_library_id {
                return Err(Error::new("root.json libraryId does not match library.sqlite"));
            }
        }
        library_id = Some(row_library_id);
        let library_id = library_id.expect("set above");

        write_root_metadata(&absolute, &library_id, options.create)?;
        if options.create {
            connection.execute(
                "UPDATE library SET updated_at = ? WHERE library_id = ?",
                rusqlite::params![now_iso(), library_id],
            )?;
        }
        // A previous process cannot have a live worker: we hold the lease. Any
        // outbox row still marked running was interrupted by that death.
        connection.execute(
            "UPDATE snapshot_outbox SET status = 'pending' WHERE library_id = ? AND status = 'running'",
            rusqlite::params![library_id],
        )?;

        Ok(Self {
            root: absolute,
            library_id,
            data_root,
            connection,
            lease: Some(lease),
            allow_outside_root: options.allow_outside_root,
            snapshot_fault: options.snapshot_fault,
            active_imports: HashMap::new(),
            closed: false,
        })
    }

    pub fn allow_outside_root(&self) -> bool {
        self.allow_outside_root
    }

    pub(crate) fn assert_open(&self) -> Result<()> {
        if self.closed {
            return Err(Error::new("library is closed"));
        }
        Ok(())
    }

    /// Run `f` inside `BEGIN IMMEDIATE` / `COMMIT`, rolling back on error.
    pub fn tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.connection.execute_batch("BEGIN IMMEDIATE")?;
        match f() {
            Ok(value) => {
                self.connection.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn import_job(&self, key: &str) -> Result<Option<ImportJobRow>> {
        let mut statement = self.connection.prepare(
            "SELECT job_id, status, plan_hash, committed_work_id FROM import_job
             WHERE library_id = ? AND idempotency_key = ?",
        )?;
        let row = statement
            .query_row(rusqlite::params![self.library_id, key], |row| {
                Ok(ImportJobRow {
                    job_id: row.get(0)?,
                    status: row.get(1)?,
                    plan_hash: row.get(2)?,
                    committed_work_id: row.get(3)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    /// Import one source record under an idempotency key.
    ///
    /// Same key + same plan returns the committed work (`idempotent: true`);
    /// same key + different plan is a conflict unless the earlier attempt never
    /// committed and was cancelled.
    pub fn import_work(&mut self, source: SourceRecord, key: &str) -> Result<ImportOutcome> {
        self.assert_open()?;
        let key = key.trim().to_string();
        if key.is_empty() {
            return Err(Error::new("idempotencyKey is required"));
        }
        let plan_hash = source.plan_hash();
        if let Some(active) = self.active_imports.get(&key) {
            if active != &plan_hash {
                return Err(Error::coded(
                    "EIDEMPOTENCYCONFLICT",
                    "idempotency key reused with a different import plan",
                ));
            }
            // A concurrent call for the same plan is refused rather than queued:
            // the HTTP layer serializes imports anyway, and queueing here would
            // hide the duplicate from the caller.
            return Err(Error::conflict("import already in progress for this idempotency key"));
        }
        self.active_imports.insert(key.clone(), plan_hash.clone());
        let outcome = self.import_work_operation(source, &key, &plan_hash);
        self.active_imports.remove(&key);
        outcome
    }

    fn import_work_operation(
        &mut self,
        mut source: SourceRecord,
        key: &str,
        plan_hash: &str,
    ) -> Result<ImportOutcome> {
        if let Some(existing) = self.import_job(key)? {
            let same_plan = existing.plan_hash == plan_hash;
            if !same_plan && (existing.committed_work_id.is_some() || existing.status != "cancelled_precommit") {
                return Err(Error::coded(
                    "EIDEMPOTENCYCONFLICT",
                    "idempotency key reused with a different import plan",
                ));
            }
            if let Some(work_id) = existing.committed_work_id.clone() {
                // Deviation D11: replaying the key of a work that was soft-deleted
                // (/api/cleanup) made Node return `{ ...null, jobId, idempotent }`,
                // a "success" with no workId, so the file could never come back.
                // The same plan for the same source means the user re-added it:
                // restore the work (metadata kept) and return it.
                let deleted: Option<Option<String>> = self
                    .connection
                    .query_row("SELECT deleted_at FROM work WHERE work_id = ?", rusqlite::params![work_id], |row| row.get(0))
                    .optional()?;
                if matches!(deleted, Some(Some(_))) {
                    self.restore_work(&work_id)?;
                }
                let work = self
                    .get_work(&work_id, false)?
                    .ok_or_else(|| Error::not_found("work not found"))?;
                return Ok(ImportOutcome {
                    work,
                    job_id: existing.job_id,
                    idempotent: true,
                });
            }
            // Crash recovery: an uncommitted job may be retried. Remove only this
            // job's own temp dir, never a blind tmp prefix.
            let stale_temp = layout::staging_root(&self.data_root).join(&existing.job_id);
            let _ = std::fs::remove_dir_all(&stale_temp);
            self.tx(|| {
                self.connection.execute(
                    "DELETE FROM import_job WHERE job_id = ? AND committed_work_id IS NULL",
                    rusqlite::params![existing.job_id],
                )?;
                Ok(())
            })?;
        }

        let job_id = uuid::Uuid::new_v4().to_string();
        let job_temp_dir = layout::staging_root(&self.data_root).join(&job_id);
        fsutil::ensure_dir(&job_temp_dir)?;
        self.tx(|| {
            let timestamp = now_iso();
            self.connection.execute(
                "INSERT INTO import_job(
                    job_id, library_id, idempotency_key, plan_hash, status,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'created', ?, ?)",
                rusqlite::params![job_id, self.library_id, key, plan_hash, timestamp, timestamp],
            )?;
            Ok(())
        })?;

        let result = (|| -> Result<String> {
            // Source-only mode: hash each entry's bytes. There is no CAS copy —
            // `rel_path` is a virtual `source/<sha256>` marker, and media reads
            // resolve through `entry.original_path`.
            for (index, entry) in source.entries.iter_mut().enumerate() {
                let (sha256, bytes) = hash::hash_file(Path::new(entry.read_path()))?;
                entry.asset = Some(PublishedAsset {
                    asset_id: sha256.clone(),
                    sha256: sha256.clone(),
                    bytes,
                    mime: entry.mime.clone(),
                    rel_path: format!("source/{sha256}"),
                });
                let _ = index;
            }

            let work_id = uuid::Uuid::new_v4().to_string();
            self.tx(|| {
                let timestamp = now_iso();
                let family_id = source
                    .family_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                self.connection.execute(
                    "INSERT OR IGNORE INTO family(family_id, created_at) VALUES (?, ?)",
                    rusqlite::params![family_id, timestamp],
                )?;
                self.connection.execute(
                    "INSERT INTO work(
                        work_id, family_id, title, circle, cv_json, language, role,
                        revision, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    rusqlite::params![
                        work_id,
                        family_id,
                        source.title,
                        source.circle,
                        serde_json::to_string(&source.cvs).unwrap_or_else(|_| "[]".to_string()),
                        source.language,
                        source.role,
                        timestamp,
                        timestamp
                    ],
                )?;
                self.connection.execute(
                    "INSERT INTO source_ref(
                        source_ref_id, work_id, provider, source_code, source_url,
                        snapshot_json, fetched_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        uuid::Uuid::new_v4().to_string(),
                        work_id,
                        source.provider,
                        source.source_code,
                        "",
                        serde_json::to_string(&json!({ "sourceRecord": source.to_json() }))
                            .unwrap_or_else(|_| "{}".to_string()),
                        timestamp
                    ],
                )?;
                self.connection.execute(
                    "INSERT INTO user_state(work_id, notes, favorite, playback_position, updated_at)
                     VALUES (?, '', 0, NULL, ?)",
                    rusqlite::params![work_id, timestamp],
                )?;

                let mut tracks_by_key: HashMap<String, String> = HashMap::new();
                for (sort_order, entry) in source.entries.iter().enumerate() {
                    let entry_id = uuid::Uuid::new_v4().to_string();
                    let track_key = if entry.track_key.is_empty() {
                        entry.stable_entry_id.clone()
                    } else {
                        entry.track_key.clone()
                    };
                    let track_id = match tracks_by_key.get(&track_key) {
                        Some(id) => id.clone(),
                        None => {
                            let id = uuid::Uuid::new_v4().to_string();
                            self.connection.execute(
                                "INSERT INTO track(track_id, work_id, track_key, title, sort_order, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?)",
                                rusqlite::params![
                                    id,
                                    work_id,
                                    track_key,
                                    entry.display_title,
                                    sort_order as i64,
                                    timestamp
                                ],
                            )?;
                            tracks_by_key.insert(track_key.clone(), id.clone());
                            id
                        }
                    };
                    self.connection.execute(
                        "INSERT INTO entry(
                            entry_id, work_id, stable_entry_id, logical_path, kind, mime,
                            display_title, original_path, sort_order, track_key
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        rusqlite::params![
                            entry_id,
                            work_id,
                            entry.stable_entry_id,
                            entry.logical_path,
                            entry.kind,
                            entry.mime,
                            entry.display_title,
                            entry.source_path,
                            sort_order as i64,
                            track_key
                        ],
                    )?;
                    let asset = entry
                        .asset
                        .as_ref()
                        .ok_or_else(|| Error::new("entry asset missing after hashing"))?;
                    self.connection.execute(
                        "INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)",
                        rusqlite::params![
                            asset.asset_id,
                            asset.sha256,
                            asset.bytes as i64,
                            asset.mime,
                            asset.rel_path,
                            timestamp
                        ],
                    )?;
                    self.connection.execute(
                        "INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                         VALUES (?, ?, ?, ?, 'primary')",
                        rusqlite::params![
                            uuid::Uuid::new_v4().to_string(),
                            work_id,
                            entry_id,
                            asset.asset_id
                        ],
                    )?;
                    let format = if entry.format.is_empty() {
                        schema::entry_format(&entry.logical_path, Some(&entry.mime))
                    } else {
                        entry.format.clone()
                    };
                    self.connection.execute(
                        "INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                        rusqlite::params![
                            uuid::Uuid::new_v4().to_string(),
                            track_id,
                            entry_id,
                            format,
                            entry.mime,
                            sort_order as i64,
                            timestamp
                        ],
                    )?;
                }

                self.connection.execute(
                    "INSERT INTO snapshot_outbox(
                        library_id, work_id, target_revision, published_revision,
                        status, attempt_count, updated_at
                    ) VALUES (?, ?, 1, 0, 'pending', 0, ?)",
                    rusqlite::params![self.library_id, work_id, timestamp],
                )?;
                self.connection.execute(
                    "UPDATE import_job SET
                        status = 'committed',
                        committed_work_id = ?,
                        committed_at = ?,
                        committed_revision = 1,
                        snapshot_status = 'pending',
                        updated_at = ?
                     WHERE job_id = ? AND committed_work_id IS NULL",
                    rusqlite::params![work_id, timestamp, timestamp, job_id],
                )?;
                Ok(())
            })?;
            Ok(work_id)
        })();

        match result {
            Ok(work_id) => {
                let _ = std::fs::remove_dir_all(&job_temp_dir);
                let work = self
                    .get_work(&work_id, false)?
                    .ok_or_else(|| Error::not_found("work not found after commit"))?;
                Ok(ImportOutcome { work, job_id, idempotent: false })
            }
            Err(error) => {
                let cancelled = error.is_aborted();
                let message = error.message.clone();
                let job = job_id.clone();
                self.tx(|| {
                    let timestamp = now_iso();
                    self.connection.execute(
                        "UPDATE import_job SET status = ?, last_error = ?, updated_at = ?
                         WHERE job_id = ? AND committed_work_id IS NULL",
                        rusqlite::params![
                            if cancelled { "cancelled_precommit" } else { "failed_precommit" },
                            message,
                            timestamp,
                            job
                        ],
                    )?;
                    Ok(())
                })?;
                let _ = std::fs::remove_dir_all(&job_temp_dir);
                Err(if cancelled { abort_error() } else { error })
            }
        }
    }

    /// Merge a rescan of an existing work into the same work row
    /// (`mergeWorkSource`).
    ///
    /// The source file tree is the manifest input: unchanged paths/assets are
    /// skipped, new paths are appended, changed paths get a new asset_ref and
    /// rendition, and entries missing from the new scan are **retained** — the
    /// source may be temporarily unavailable, and dropping them would lose the
    /// only record that they ever existed.
    ///
    /// The revision is bumped only when bytes or metadata actually changed, so a
    /// no-op rescan does not churn snapshots or force every client to re-render.
    pub fn merge_work_source(
        &mut self,
        work_id: &str,
        mut source: SourceRecord,
    ) -> Result<MergeOutcome> {
        self.assert_open()?;
        let work_row: Option<(i64, String, String, String)> = self
            .connection
            .query_row(
                "SELECT revision, title, circle, cv_json FROM work WHERE work_id = ?",
                rusqlite::params![work_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((current_revision, current_title, current_circle, current_cv_json)) = work_row else {
            return Err(Error::not_found("work not found"));
        };
        let deleted: Option<Option<String>> = self
            .connection
            .query_row(
                "SELECT deleted_at FROM work WHERE work_id = ?",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        if deleted.flatten().is_some() {
            return Err(Error::not_found("work not found"));
        }

        let job_id = uuid::Uuid::new_v4().to_string();
        let job_temp_dir = layout::staging_root(&self.data_root).join(&job_id);
        fsutil::ensure_dir(&job_temp_dir)?;

        let result = (|| -> Result<MergeOutcome> {
            for entry in source.entries.iter_mut() {
                let (sha256, bytes) = hash::hash_file(Path::new(entry.read_path()))?;
                entry.asset = Some(PublishedAsset {
                    asset_id: sha256.clone(),
                    sha256: sha256.clone(),
                    bytes,
                    mime: entry.mime.clone(),
                    rel_path: format!("source/{sha256}"),
                });
            }

            let existing: Vec<(String, String, Option<String>)> = {
                let mut statement = self.connection.prepare(
                    // An entry counts as unchanged only with exactly one primary
                    // ref. After a download it can hold two (source + CAS); Node
                    // then keeps whichever join row came last, usually sees a
                    // mismatch and rewrites the refs. Treating "not exactly one"
                    // as changed gives that outcome deterministically.
                    "SELECT e.logical_path, e.entry_id,
                            CASE WHEN (SELECT COUNT(*) FROM asset_ref r
                                       WHERE r.entry_id = e.entry_id AND r.role = 'primary') = 1
                                 THEN (SELECT a.sha256 FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id
                                       WHERE r.entry_id = e.entry_id AND r.role = 'primary')
                            END AS sha
                     FROM entry e WHERE e.work_id = ? ORDER BY e.sort_order, e.entry_id",
                )?;
                // Collect inside this block: the statement borrows the connection,
                // and the map below must outlive it.
                let rows = statement
                    .query_map(rusqlite::params![work_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            let existing_by_path: HashMap<&str, &(String, String, Option<String>)> =
                existing.iter().map(|row| (row.0.as_str(), row)).collect();

            let mut new_entries: Vec<(usize, &SourceEntry)> = Vec::new();
            let mut changed: Vec<(usize, &SourceEntry, String, Option<String>)> = Vec::new();
            let mut skipped = 0usize;
            for (index, entry) in source.entries.iter().enumerate() {
                let asset_sha = entry
                    .asset
                    .as_ref()
                    .map(|asset| asset.sha256.clone())
                    .unwrap_or_default();
                match existing_by_path.get(entry.logical_path.as_str()) {
                    None => new_entries.push((index, entry)),
                    Some((_, entry_id, previous_sha)) => {
                        if previous_sha.as_deref() == Some(asset_sha.as_str()) {
                            skipped += 1;
                        } else {
                            changed.push((index, entry, entry_id.clone(), previous_sha.clone()));
                        }
                    }
                }
            }
            let missing = existing
                .iter()
                .filter(|row| !source.entries.iter().any(|entry| entry.logical_path == row.0))
                .count();

            // Deviation D7: Node uses `trimString(source.circle, work.circle)`, which
            // only falls back for non-strings, so a per-file import that carries no
            // circle/cvs (the Kikoeru pipeline, reconcile) wiped the work's circle to
            // '' and cvs to []. An empty merge source keeps the stored values here.
            let title = if source.title.trim().is_empty() { current_title.clone() } else { source.title.clone() };
            let circle = if source.circle.trim().is_empty() { current_circle.clone() } else { source.circle.clone() };
            let cvs_json = if source.cvs.is_empty() {
                current_cv_json.clone()
            } else {
                serde_json::to_string(&source.cvs).unwrap_or_else(|_| "[]".to_string())
            };
            let metadata_changed = title != current_title || circle != current_circle || cvs_json != current_cv_json;
            let changed_any = !new_entries.is_empty() || !changed.is_empty() || metadata_changed;
            let revision = if changed_any { current_revision + 1 } else { current_revision };
            let timestamp = now_iso();

            if changed_any {
                let added = new_entries.len();
                let updated = changed.len();
                self.tx(|| {
                    self.connection.execute(
                        "UPDATE work SET title = ?, circle = ?, cv_json = ?, revision = ?, updated_at = ? WHERE work_id = ?",
                        rusqlite::params![title, circle, cvs_json, revision, timestamp, work_id],
                    )?;
                    for (index, entry) in &new_entries {
                        let track_key = if entry.track_key.is_empty() {
                            entry.stable_entry_id.clone()
                        } else {
                            entry.track_key.clone()
                        };
                        let track_id: Option<String> = self
                            .connection
                            .query_row(
                                "SELECT track_id FROM track WHERE work_id = ? AND track_key = ?",
                                rusqlite::params![work_id, track_key],
                                |row| row.get(0),
                            )
                            .optional()?;
                        let track_id = match track_id {
                            Some(id) => id,
                            None => {
                                let id = uuid::Uuid::new_v4().to_string();
                                self.connection.execute(
                                    "INSERT INTO track(track_id, work_id, track_key, title, sort_order, created_at)
                                     VALUES (?, ?, ?, ?, ?, ?)",
                                    rusqlite::params![
                                        id,
                                        work_id,
                                        track_key,
                                        entry.display_title,
                                        *index as i64,
                                        timestamp
                                    ],
                                )?;
                                id
                            }
                        };
                        let entry_id = uuid::Uuid::new_v4().to_string();
                        self.connection.execute(
                            "INSERT INTO entry(
                                entry_id, work_id, stable_entry_id, logical_path, kind, mime,
                                display_title, original_path, sort_order, track_key
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            rusqlite::params![
                                entry_id,
                                work_id,
                                entry.stable_entry_id,
                                entry.logical_path,
                                entry.kind,
                                entry.mime,
                                entry.display_title,
                                entry.source_path,
                                *index as i64,
                                track_key
                            ],
                        )?;
                        let asset = entry.asset.as_ref().expect("hashed above");
                        self.connection.execute(
                            "INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                             VALUES (?, ?, ?, ?, ?, ?)",
                            rusqlite::params![
                                asset.asset_id,
                                asset.sha256,
                                asset.bytes as i64,
                                asset.mime,
                                asset.rel_path,
                                timestamp
                            ],
                        )?;
                        self.connection.execute(
                            "INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                             VALUES (?, ?, ?, ?, 'primary')",
                            rusqlite::params![uuid::Uuid::new_v4().to_string(), work_id, entry_id, asset.asset_id],
                        )?;
                        let format = if entry.format.is_empty() {
                            schema::entry_format(&entry.logical_path, Some(&entry.mime))
                        } else {
                            entry.format.clone()
                        };
                        self.connection.execute(
                            "INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)",
                            rusqlite::params![
                                uuid::Uuid::new_v4().to_string(),
                                track_id,
                                entry_id,
                                format,
                                entry.mime,
                                *index as i64,
                                timestamp
                            ],
                        )?;
                    }
                    for (index, entry, entry_id, previous_track_key) in &changed {
                        self.connection.execute(
                            "UPDATE entry SET kind = ?, mime = ?, display_title = ?, original_path = ?, sort_order = ? WHERE entry_id = ?",
                            rusqlite::params![
                                entry.kind,
                                entry.mime,
                                entry.display_title,
                                entry.source_path,
                                *index as i64,
                                entry_id
                            ],
                        )?;
                        self.connection.execute(
                            "DELETE FROM asset_ref WHERE entry_id = ?",
                            rusqlite::params![entry_id],
                        )?;
                        self.connection
                            .execute("DELETE FROM track_rendition WHERE entry_id = ?", rusqlite::params![entry_id])?;
                        let asset = entry.asset.as_ref().expect("hashed above");
                        self.connection.execute(
                            "INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                             VALUES (?, ?, ?, ?, ?, ?)",
                            rusqlite::params![
                                asset.asset_id,
                                asset.sha256,
                                asset.bytes as i64,
                                asset.mime,
                                asset.rel_path,
                                timestamp
                            ],
                        )?;
                        self.connection.execute(
                            "INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                             VALUES (?, ?, ?, ?, 'primary')",
                            rusqlite::params![uuid::Uuid::new_v4().to_string(), work_id, entry_id, asset.asset_id],
                        )?;
                        let track_key = previous_track_key
                            .clone()
                            .unwrap_or_else(|| entry.stable_entry_id.clone());
                        let format = if entry.format.is_empty() {
                            schema::entry_format(&entry.logical_path, Some(&entry.mime))
                        } else {
                            entry.format.clone()
                        };
                        self.connection.execute(
                            "INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                             SELECT ?, track_id, ?, ?, ?, ?, ? FROM track WHERE work_id = ? AND track_key = ?",
                            rusqlite::params![
                                uuid::Uuid::new_v4().to_string(),
                                entry_id,
                                format,
                                entry.mime,
                                *index as i64,
                                timestamp,
                                work_id,
                                track_key
                            ],
                        )?;
                        self.connection.execute(
                            "UPDATE track SET title = ?, sort_order = ? WHERE work_id = ? AND track_key = ?",
                            rusqlite::params![entry.display_title, *index as i64, work_id, track_key],
                        )?;
                    }
                    // Adopt the existing local identity when a rescan learns the real
                    // RJ code; otherwise one folder grows a second source_ref and looks
                    // like a duplicate in the UI.
                    let source_ref_id: Option<String> = self
                        .connection
                        .query_row(
                            "SELECT source_ref_id FROM source_ref WHERE work_id = ? AND provider = ? LIMIT 1",
                            rusqlite::params![work_id, source.provider],
                            |row| row.get(0),
                        )
                        .optional()?
                        .or(self
                            .connection
                            .query_row(
                                "SELECT source_ref_id FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1",
                                rusqlite::params![work_id],
                                |row| row.get(0),
                            )
                            .optional()?);
                    // Node's merge keeps published assets in a side map, so its
                    // snapshot has no per-entry `asset`; strip ours to match.
                    let mut snapshot_source = source.clone();
                    for entry in &mut snapshot_source.entries {
                        entry.asset = None;
                    }
                    let snapshot = serde_json::to_string(&json!({
                        "sourceRecord": snapshot_source.to_json(),
                        "refreshedAt": timestamp,
                    }))
                    .unwrap_or_else(|_| "{}".to_string());
                    match source_ref_id {
                        Some(reference_id) => {
                            self.connection.execute(
                                "UPDATE source_ref SET provider = ?, source_code = ?, snapshot_json = ? WHERE source_ref_id = ?",
                                rusqlite::params![source.provider, source.source_code, snapshot, reference_id],
                            )?;
                        }
                        None => {
                            self.connection.execute(
                                "INSERT INTO source_ref(source_ref_id, work_id, provider, source_code, source_url, snapshot_json, fetched_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                                rusqlite::params![
                                    uuid::Uuid::new_v4().to_string(),
                                    work_id,
                                    source.provider,
                                    source.source_code,
                                    "",
                                    snapshot,
                                    timestamp
                                ],
                            )?;
                        }
                    }
                    self.enqueue_snapshot(work_id, revision, &timestamp)?;
                    Ok(())
                })?;
                Ok(MergeOutcome {
                    changed: true,
                    revision,
                    added,
                    updated,
                    skipped,
                    missing,
                    job_id: Some(job_id.clone()),
                })
            } else {
                Ok(MergeOutcome {
                    changed: false,
                    revision,
                    added: 0,
                    updated: 0,
                    skipped,
                    missing,
                    job_id: Some(job_id.clone()),
                })
            }
        })();
        let _ = std::fs::remove_dir_all(&job_temp_dir);
        result
    }

    /// Read one work in the `getWork` shape.
    pub fn get_work(&self, work_id: &str, include_deleted: bool) -> Result<Option<Value>> {
        self.assert_open()?;
        let work = self
            .connection
            .query_row("SELECT * FROM work WHERE work_id = ?", rusqlite::params![work_id], |row| {
                Ok(WorkRow {
                    work_id: row.get("work_id")?,
                    family_id: row.get("family_id")?,
                    title: row.get("title")?,
                    user_title: row.get("user_title")?,
                    user_meta_json: row.get("user_meta_json")?,
                    circle: row.get("circle")?,
                    cv_json: row.get("cv_json")?,
                    language: row.get("language")?,
                    role: row.get("role")?,
                    revision: row.get("revision")?,
                    deleted_at: row.get("deleted_at")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })
            .optional()?;
        let Some(work) = work else { return Ok(None) };
        if work.deleted_at.is_some() && !include_deleted {
            return Ok(None);
        }

        let mut source_statement = self.connection.prepare(
            "SELECT * FROM source_ref WHERE work_id = ? ORDER BY provider, source_code",
        )?;
        let source_refs: Vec<Value> = source_statement
            .query_map(rusqlite::params![work.work_id], |row| {
                let snapshot_json: String = row.get("snapshot_json")?;
                Ok(json!({
                    "sourceRefId": row.get::<_, String>("source_ref_id")?,
                    "provider": row.get::<_, String>("provider")?,
                    "sourceCode": row.get::<_, String>("source_code")?,
                    "sourceUrl": row.get::<_, Option<String>>("source_url")?,
                    "fetchedAt": row.get::<_, Option<String>>("fetched_at")?,
                    "snapshot": crate::jsonutil::parse_or(Some(&snapshot_json), Value::Null),
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut entry_statement = self.connection.prepare(
            "SELECT e.*,
                (SELECT t.track_id FROM track t WHERE t.work_id = e.work_id
                 AND t.track_key = COALESCE(e.track_key, e.stable_entry_id)) AS track_id,
                (SELECT r.format FROM track_rendition r WHERE r.entry_id = e.entry_id LIMIT 1) AS rendition_format
             FROM entry e WHERE e.work_id = ? ORDER BY e.sort_order, e.logical_path",
        )?;
        let entry_rows: Vec<EntryRow> = entry_statement
            .query_map(rusqlite::params![work.work_id], |row| {
                Ok(EntryRow {
                    entry_id: row.get("entry_id")?,
                    stable_entry_id: row.get("stable_entry_id")?,
                    logical_path: row.get("logical_path")?,
                    kind: row.get("kind")?,
                    mime: row.get("mime")?,
                    display_title: row.get("display_title")?,
                    original_path: row.get("original_path")?,
                    sort_order: row.get("sort_order")?,
                    track_key: row.get("track_key")?,
                    track_id: row.get("track_id")?,
                    rendition_format: row.get("rendition_format")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut entries = Vec::with_capacity(entry_rows.len());
        let mut asset_statement = self.connection.prepare(
            "SELECT a.*, r.role FROM asset_ref r
             JOIN asset a ON a.asset_id = r.asset_id
             WHERE r.entry_id = ? ORDER BY r.role, a.asset_id",
        )?;
        for entry in entry_rows {
            let assets: Vec<Value> = asset_statement
                .query_map(rusqlite::params![entry.entry_id], |row| {
                    Ok(json!({
                        "assetId": row.get::<_, String>("asset_id")?,
                        "sha256": row.get::<_, String>("sha256")?,
                        "bytes": row.get::<_, i64>("bytes")?,
                        "mime": row.get::<_, Option<String>>("mime")?,
                        "relPath": row.get::<_, String>("rel_path")?,
                        "role": row.get::<_, String>("role")?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            entries.push(json!({
                "entryId": entry.stable_entry_id,
                "internalId": entry.entry_id,
                "logicalPath": entry.logical_path,
                "kind": entry.kind,
                "mime": entry.mime,
                "title": entry.display_title,
                "originalPath": entry.original_path,
                "sortOrder": entry.sort_order,
                "trackKey": entry.track_key,
                "trackId": entry.track_id,
                "format": entry.rendition_format,
                "assets": assets,
            }));
        }

        let user: Option<Value> = self
            .connection
            .query_row(
                "SELECT notes, favorite, playback_position FROM user_state WHERE work_id = ?",
                rusqlite::params![work.work_id],
                |row| {
                    Ok(json!({
                        "notes": row.get::<_, String>(0)?,
                        "favorite": row.get::<_, i64>(1)? != 0,
                        "playbackPosition": row.get::<_, Option<f64>>(2)?,
                    }))
                },
            )
            .optional()?;

        Ok(Some(json!({
            "id": work.work_id,
            "workId": work.work_id,
            "familyId": work.family_id,
            "title": work.title,
            "userTitle": work.user_title,
            "userMeta": parse_object(Some(&work.user_meta_json)),
            "circle": work.circle,
            "cvs": parse_string_array(Some(&work.cv_json)),
            "language": work.language,
            "role": work.role,
            "revision": work.revision,
            "deletedAt": work.deleted_at,
            "createdAt": work.created_at,
            "updatedAt": work.updated_at,
            "entries": entries,
            "sourceRefs": source_refs,
            "user": user.unwrap_or_else(|| json!({
                "notes": "",
                "favorite": false,
                "playbackPosition": null,
            })),
        })))
    }

    /// Update user-owned fields (`updateWorkMetadata`).
    pub fn update_work_metadata(&self, work_id: &str, patch: &Map<String, Value>) -> Result<Value> {
        self.assert_open()?;
        let current = self
            .connection
            .query_row(
                "SELECT * FROM work WHERE work_id = ? AND deleted_at IS NULL",
                rusqlite::params![work_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>("user_title")?,
                        row.get::<_, String>("circle")?,
                        row.get::<_, String>("cv_json")?,
                        row.get::<_, String>("user_meta_json")?,
                        row.get::<_, String>("work_id")?,
                    ))
                },
            )
            .optional()?;
        let Some((user_title, circle, cv_json, user_meta_json, current_id)) = current else {
            return Err(Error::not_found("work not found"));
        };

        let title = match patch.get("title") {
            None | Some(Value::Null) => user_title.clone(),
            Some(value) => Some(crate::jsonutil::string_of(value).trim().to_string()),
        };
        let circle = match patch.get("circle") {
            None | Some(Value::Null) => circle,
            Some(value) => crate::jsonutil::string_of(value).trim().to_string(),
        };
        let cvs: Vec<String> = match patch.get("cvs") {
            None => parse_string_array(Some(&cv_json)),
            Some(Value::Array(items)) => unique_trimmed(items.iter().map(crate::jsonutil::string_of)),
            Some(_) => Vec::new(),
        };
        let mut meta = parse_object(Some(&user_meta_json));
        for key in METADATA_KEYS {
            if let Some(value) = patch.get(*key) {
                meta.insert((*key).to_string(), value.clone());
            }
        }
        if let Some(Value::Array(tags)) = meta.get("tags").cloned() {
            let cleaned = unique_trimmed(tags.iter().map(crate::jsonutil::string_of));
            meta.insert("tags".to_string(), json!(cleaned));
        }
        let timestamp = now_iso();
        self.connection.execute(
            "UPDATE work SET user_title = ?, circle = ?, cv_json = ?, user_meta_json = ?,
                revision = revision + 1, updated_at = ? WHERE work_id = ?",
            rusqlite::params![
                title.filter(|value| !value.is_empty()),
                circle,
                serde_json::to_string(&cvs).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&Value::Object(meta)).unwrap_or_else(|_| "{}".to_string()),
                timestamp,
                current_id
            ],
        )?;
        self.get_work(work_id, false)?
            .ok_or_else(|| Error::not_found("work not found"))
    }

    pub fn list_entries(&self, work_id: &str) -> Result<Option<Value>> {
        Ok(self
            .get_work(work_id, true)?
            .and_then(|work| work.get("entries").cloned()))
    }

    /// Soft-delete or restore a work (`_setDeleted`).
    fn set_deleted(&self, work_id: &str, deleted: bool) -> Result<Value> {
        let exists: Option<i64> = self
            .connection
            .query_row(
                "SELECT revision FROM work WHERE work_id = ?",
                rusqlite::params![work_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(revision) = exists else {
            return Err(Error::not_found("work not found"));
        };
        let timestamp = now_iso();
        self.tx(|| {
            self.connection.execute(
                "UPDATE work SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE work_id = ?",
                rusqlite::params![
                    if deleted { Some(timestamp.clone()) } else { None },
                    timestamp,
                    work_id
                ],
            )?;
            self.enqueue_snapshot(work_id, revision + 1, &timestamp)?;
            Ok(())
        })?;
        self.get_work(work_id, true)?
            .ok_or_else(|| Error::not_found("work not found"))
    }

    pub fn soft_delete_work(&self, work_id: &str) -> Result<Value> {
        self.set_deleted(work_id, true)
    }

    pub fn restore_work(&self, work_id: &str) -> Result<Value> {
        self.set_deleted(work_id, false)
    }

    /// Upsert an outbox row targeting `revision`, keeping the highest target.
    pub(crate) fn enqueue_snapshot(&self, work_id: &str, revision: i64, timestamp: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO snapshot_outbox(
                library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at
            ) VALUES (?, ?, ?, 0, 'pending', 0, ?)
            ON CONFLICT(library_id, work_id) DO UPDATE SET
                target_revision = MAX(target_revision, excluded.target_revision),
                status = 'pending',
                last_error = NULL,
                updated_at = excluded.updated_at",
            rusqlite::params![self.library_id, work_id, revision, timestamp],
        )?;
        Ok(())
    }

    fn snapshot_model(&self, work_id: &str) -> Result<SnapshotModel> {
        let work = self
            .connection
            .query_row("SELECT * FROM work WHERE work_id = ?", rusqlite::params![work_id], |row| {
                Ok(WorkRow {
                    work_id: row.get("work_id")?,
                    family_id: row.get("family_id")?,
                    title: row.get("title")?,
                    user_title: row.get("user_title")?,
                    user_meta_json: row.get("user_meta_json")?,
                    circle: row.get("circle")?,
                    cv_json: row.get("cv_json")?,
                    language: row.get("language")?,
                    role: row.get("role")?,
                    revision: row.get("revision")?,
                    deleted_at: row.get("deleted_at")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })
            .optional()?
            .ok_or_else(|| Error::not_found("work not found"))?;
        let _ = &work.user_meta_json;

        let mut entry_statement = self.connection.prepare(
            "SELECT * FROM entry WHERE work_id = ? ORDER BY sort_order, logical_path",
        )?;
        let entries: Vec<Value> = entry_statement
            .query_map(rusqlite::params![work.work_id], |row| {
                Ok(json!({
                    "entryId": row.get::<_, String>("stable_entry_id")?,
                    "logicalPath": row.get::<_, String>("logical_path")?,
                    "kind": row.get::<_, String>("kind")?,
                    "mime": row.get::<_, Option<String>>("mime")?,
                    "title": row.get::<_, Option<String>>("display_title")?,
                    "sortOrder": row.get::<_, i64>("sort_order")?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut asset_statement = self.connection.prepare(
            "SELECT DISTINCT a.sha256, a.bytes, a.mime, a.rel_path
             FROM asset a JOIN asset_ref r ON r.asset_id = a.asset_id
             WHERE r.work_id = ? ORDER BY a.sha256",
        )?;
        let assets: Vec<Value> = asset_statement
            .query_map(rusqlite::params![work.work_id], |row| {
                Ok(json!({
                    "sha256": row.get::<_, String>(0)?,
                    "bytes": row.get::<_, i64>(1)?,
                    "mime": row.get::<_, Option<String>>(2)?,
                    "relPath": row.get::<_, String>(3)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut source_statement = self
            .connection
            .prepare("SELECT provider, source_code, source_url, snapshot_json FROM source_ref WHERE work_id = ?")?;
        let source_refs: Vec<Value> = source_statement
            .query_map(rusqlite::params![work.work_id], |row| {
                let snapshot_json: String = row.get(3)?;
                Ok(json!({
                    "provider": row.get::<_, String>(0)?,
                    "sourceCode": row.get::<_, String>(1)?,
                    "sourceUrl": row.get::<_, Option<String>>(2)?,
                    "snapshot": crate::jsonutil::parse_or(Some(&snapshot_json), Value::Null),
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let user_state: Option<Value> = self
            .connection
            .query_row(
                "SELECT notes, favorite, playback_position FROM user_state WHERE work_id = ?",
                rusqlite::params![work.work_id],
                |row| {
                    Ok(json!({
                        "notes": row.get::<_, String>(0)?,
                        "favorite": row.get::<_, i64>(1)? != 0,
                        "playbackPosition": row.get::<_, Option<f64>>(2)?,
                    }))
                },
            )
            .optional()?;

        let entry_count = entries.len();
        Ok(SnapshotModel {
            work: json!({
                "workId": work.work_id,
                "familyId": work.family_id,
                "title": work.title,
                "userTitle": work.user_title,
                "circle": work.circle,
                "cvs": parse_string_array(Some(&work.cv_json)),
                "language": work.language,
                "role": work.role,
                "revision": work.revision,
                "deletedAt": work.deleted_at,
                "createdAt": work.created_at,
                "updatedAt": work.updated_at,
            }),
            source_refs: Value::Array(source_refs),
            entries: Value::Array(entries),
            assets: Value::Array(assets),
            user_state: user_state.unwrap_or(Value::Null),
            entry_count,
        })
    }

    /// Publish the snapshot for one work at (at least) its current target.
    ///
    /// Reads the outbox again after writing: a revision may land while the files
    /// are being written, and only the newest target may be marked ready.
    pub fn publish_snapshot(&self, work_id: &str, requested_revision: Option<i64>) -> Result<SnapshotPublish> {
        self.assert_open()?;
        let mut request = match requested_revision {
            Some(value) => value,
            None => self
                .connection
                .query_row(
                    "SELECT target_revision FROM snapshot_outbox WHERE library_id = ? AND work_id = ?",
                    rusqlite::params![self.library_id, work_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| Error::not_found("missing-outbox"))?,
        };
        loop {
            let outbox: Option<(i64, i64)> = self
                .connection
                .query_row(
                    "SELECT target_revision, published_revision FROM snapshot_outbox
                     WHERE library_id = ? AND work_id = ?",
                    rusqlite::params![self.library_id, work_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((target_revision, published_revision)) = outbox else {
                return Ok(SnapshotPublish::skipped(work_id, "missing-outbox"));
            };
            if request < published_revision {
                return Ok(SnapshotPublish {
                    work_id: work_id.to_string(),
                    ok: true,
                    published: Some(published_revision),
                    skipped: Some("stale-revision".to_string()),
                    target: None,
                    error: None,
                });
            }
            if request < target_revision {
                if requested_revision.is_some() {
                    // An explicit revision must not be silently promoted.
                    return Ok(SnapshotPublish {
                        work_id: work_id.to_string(),
                        ok: true,
                        published: Some(published_revision),
                        skipped: Some("newer-target-pending".to_string()),
                        target: Some(target_revision),
                        error: None,
                    });
                }
                request = target_revision;
            }
            let model = self.snapshot_model(work_id)?;
            let write_revision = request;
            let written = match snapshot::write_snapshot_pair(
                &self.data_root,
                &self.library_id,
                work_id,
                write_revision,
                &model,
                self.snapshot_fault,
            ) {
                Ok(files) => files,
                Err(error) => {
                    self.mark_snapshot_failure(work_id, write_revision, &error);
                    return Err(error);
                }
            };
            let marked = self.mark_snapshot_published(work_id, write_revision)?;
            if marked.skipped.as_deref() == Some("newer-target-pending") {
                request = marked.target.unwrap_or(write_revision);
                let _ = written;
                continue;
            }
            // A revision may have arrived between the write and the mark.
            let fresh: Option<i64> = self
                .connection
                .query_row(
                    "SELECT target_revision FROM snapshot_outbox WHERE library_id = ? AND work_id = ?",
                    rusqlite::params![self.library_id, work_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(fresh_target) = fresh {
                if fresh_target > write_revision {
                    request = fresh_target;
                    continue;
                }
            }
            return Ok(SnapshotPublish {
                work_id: work_id.to_string(),
                ok: true,
                published: marked.published,
                skipped: marked.skipped,
                target: marked.target,
                error: None,
            });
        }
    }

    fn mark_snapshot_failure(&self, work_id: &str, target_revision: i64, error: &Error) -> SnapshotPublish {
        let timestamp = now_iso();
        let message = error.message.clone();
        let result = self.tx(|| {
            self.connection.execute(
                "UPDATE snapshot_outbox SET
                    status = 'retry_wait',
                    attempt_count = attempt_count + 1,
                    last_error = ?,
                    next_retry_at = ?,
                    updated_at = ?
                 WHERE library_id = ? AND work_id = ?",
                rusqlite::params![message, timestamp, timestamp, self.library_id, work_id],
            )?;
            self.connection.execute(
                "UPDATE import_job SET snapshot_status = 'failed', snapshot_error = ?, updated_at = ?
                 WHERE library_id = ? AND committed_work_id = ?",
                rusqlite::params![message, timestamp, self.library_id, work_id],
            )?;
            Ok(())
        });
        if let Err(tx_error) = result {
            return SnapshotPublish::failed(work_id, target_revision, tx_error.message);
        }
        SnapshotPublish::failed(work_id, target_revision, message)
    }

    fn mark_snapshot_published(&self, work_id: &str, target_revision: i64) -> Result<SnapshotPublish> {
        let timestamp = now_iso();
        self.tx(|| {
            let row: Option<(i64, i64)> = self
                .connection
                .query_row(
                    "SELECT target_revision, published_revision FROM snapshot_outbox
                     WHERE library_id = ? AND work_id = ?",
                    rusqlite::params![self.library_id, work_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((target_revision_row, published_revision)) = row else {
                return Ok(SnapshotPublish::skipped(work_id, "missing-outbox"));
            };
            if target_revision_row > target_revision {
                return Ok(SnapshotPublish {
                    work_id: work_id.to_string(),
                    ok: false,
                    published: Some(published_revision),
                    skipped: Some("newer-target-pending".to_string()),
                    target: Some(target_revision_row),
                    error: None,
                });
            }
            if target_revision <= published_revision {
                return Ok(SnapshotPublish {
                    work_id: work_id.to_string(),
                    ok: true,
                    published: Some(published_revision),
                    skipped: Some("already-published".to_string()),
                    target: None,
                    error: None,
                });
            }
            self.connection.execute(
                "UPDATE snapshot_outbox SET
                    published_revision = ?,
                    target_revision = MAX(target_revision, ?),
                    status = CASE WHEN target_revision > ? THEN 'pending' ELSE 'ready' END,
                    attempt_count = attempt_count + 1,
                    last_error = NULL,
                    next_retry_at = NULL,
                    updated_at = ?
                 WHERE library_id = ? AND work_id = ?",
                rusqlite::params![
                    target_revision,
                    target_revision,
                    target_revision,
                    timestamp,
                    self.library_id,
                    work_id
                ],
            )?;
            self.connection.execute(
                "UPDATE import_job SET status = 'completed', snapshot_status = 'ready',
                    snapshot_error = NULL, updated_at = ?
                 WHERE library_id = ? AND committed_work_id = ? AND committed_revision <= ?",
                rusqlite::params![timestamp, self.library_id, work_id, target_revision],
            )?;
            Ok(SnapshotPublish {
                work_id: work_id.to_string(),
                ok: true,
                published: Some(target_revision),
                skipped: None,
                target: None,
                error: None,
            })
        })
    }

    /// Process every pending/running/retry outbox row.
    pub fn flush_snapshots(&self) -> Result<Vec<SnapshotPublish>> {
        self.assert_open()?;
        let mut statement = self.connection.prepare(
            "SELECT work_id, target_revision FROM snapshot_outbox
             WHERE library_id = ? AND status IN ('pending','retry_wait','running')
             ORDER BY updated_at, work_id",
        )?;
        let rows: Vec<(String, i64)> = statement
            .query_map(rusqlite::params![self.library_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut results = Vec::with_capacity(rows.len());
        for (work_id, target_revision) in rows {
            self.connection.execute(
                "UPDATE snapshot_outbox SET status = 'running', updated_at = ? WHERE library_id = ? AND work_id = ?",
                rusqlite::params![now_iso(), self.library_id, work_id],
            )?;
            let mut result = match self.publish_snapshot(&work_id, None) {
                Ok(value) => value,
                Err(error) => SnapshotPublish::failed(&work_id, target_revision, error.message),
            };
            result.target = Some(target_revision);
            results.push(result);
        }
        Ok(results)
    }

    /// Structural verification (`verifyLibrary`).
    ///
    /// Returns warnings separately from errors: orphan assets are a warning
    /// because a crash between entry deletion and asset GC is recoverable, while a
    /// missing asset file is an error because media would 404.
    pub fn verify_library(&self) -> Result<Value> {
        self.assert_open()?;
        let mut issues: Vec<Value> = Vec::new();
        let mut counts = Map::new();
        for table in [
            "work",
            "entry",
            "asset",
            "asset_ref",
            "source_ref",
            "import_job",
            "snapshot_outbox",
            "user_state",
        ] {
            match self
                .connection
                .query_row(&format!("SELECT COUNT(*) AS n FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                }) {
                Ok(count) => {
                    counts.insert(table.to_string(), json!(count));
                }
                Err(error) => issues.push(json!({
                    "code": "missing-table",
                    "table": table,
                    "detail": error.to_string(),
                })),
            }
        }

        let mut integrity_statement = self.connection.prepare("PRAGMA integrity_check")?;
        let integrity: Vec<String> = integrity_statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for value in integrity {
            if value != "ok" {
                issues.push(json!({ "code": "sqlite-integrity", "detail": value }));
            }
        }
        let mut fk_statement = self.connection.prepare("PRAGMA foreign_key_check")?;
        let mut fk_rows = fk_statement.query([])?;
        while let Some(row) = fk_rows.next()? {
            let table: String = row.get(0)?;
            let rowid: Option<i64> = row.get(1)?;
            issues.push(json!({ "code": "foreign-key", "detail": { "table": table, "rowid": rowid } }));
        }
        drop(fk_rows);
        drop(fk_statement);

        let mut missing_refs = self.connection.prepare(
            "SELECT r.asset_ref_id, r.asset_id, r.work_id
             FROM asset_ref r LEFT JOIN asset a ON a.asset_id = r.asset_id
             WHERE a.asset_id IS NULL",
        )?;
        for row in missing_refs.query_map([], |row| {
            Ok(json!({
                "assetRefId": row.get::<_, String>(0)?,
                "assetId": row.get::<_, String>(1)?,
                "workId": row.get::<_, String>(2)?,
            }))
        })? {
            issues.push(json!({ "code": "asset-ref-missing-asset", "detail": row? }));
        }

        let mut missing_entries = self.connection.prepare(
            "SELECT r.asset_ref_id, r.entry_id FROM asset_ref r
             LEFT JOIN entry e ON e.entry_id = r.entry_id WHERE e.entry_id IS NULL",
        )?;
        for row in missing_entries.query_map([], |row| {
            Ok(json!({
                "assetRefId": row.get::<_, String>(0)?,
                "entryId": row.get::<_, String>(1)?,
            }))
        })? {
            issues.push(json!({ "code": "asset-ref-missing-entry", "detail": row? }));
        }

        // Source-only assets point at the user's work root; verify those files
        // exist and match the recorded size/hash. A mismatch means the user edited
        // the library outside the app, which reconcile is meant to report.
        let mut assets_statement = self.connection.prepare("SELECT * FROM asset ORDER BY sha256")?;
        let assets: Vec<(String, String, i64, String)> = assets_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>("sha256")?,
                    row.get::<_, String>("rel_path")?,
                    row.get::<_, i64>("bytes")?,
                    row.get::<_, String>("asset_id")?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (sha256, rel_path, bytes, _asset_id) in assets {
            if rel_path.starts_with("source/") {
                // Virtual source assets carry no second copy; the entry's
                // original_path is checked by reconcile, not here.
                continue;
            }
            let file = self
                .data_root
                .join(rel_path.split('/').collect::<Vec<_>>().join(std::path::MAIN_SEPARATOR_STR));
            match std::fs::metadata(&file) {
                Ok(info) if info.is_file() => {
                    if info.len() as i64 != bytes {
                        issues.push(json!({
                            "code": "asset-size-mismatch",
                            "detail": { "relPath": rel_path },
                        }));
                    } else if let Ok((actual, _)) = hash::hash_file(&file) {
                        if actual != sha256 {
                            issues.push(json!({
                                "code": "asset-hash-mismatch",
                                "detail": { "relPath": rel_path },
                            }));
                        }
                    }
                }
                _ => issues.push(json!({
                    "code": "asset-file-missing",
                    "detail": { "relPath": rel_path },
                })),
            }
        }

        let mut orphans = self.connection.prepare(
            "SELECT a.asset_id FROM asset a LEFT JOIN asset_ref r ON r.asset_id = a.asset_id
             WHERE r.asset_ref_id IS NULL",
        )?;
        for row in orphans.query_map([], |row| row.get::<_, String>(0))? {
            issues.push(json!({
                "code": "orphan-asset",
                "severity": "warning",
                "detail": row?,
            }));
        }

        let mut outbox_statement = self.connection
            .prepare("SELECT work_id, target_revision, published_revision FROM snapshot_outbox WHERE library_id = ?")?;
        let outbox: Vec<(String, i64, i64)> = outbox_statement
            .query_map(rusqlite::params![self.library_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (work_id, target_revision, published_revision) in outbox {
            if published_revision > target_revision {
                issues.push(json!({ "code": "snapshot-published-ahead", "detail": { "workId": work_id } }));
            }
            if published_revision > 0 {
                let check = snapshot::read_snapshot_pair(
                    &self.data_root,
                    &work_id,
                    Some(&self.library_id),
                    Some(published_revision),
                );
                if !check.ok {
                    issues.push(json!({
                        "code": "snapshot-pair-invalid",
                        "detail": { "workId": work_id, "problems": check.problems },
                    }));
                }
            }
        }

        let mut jobs = self.connection.prepare(
            "SELECT job_id, committed_work_id, committed_at, committed_revision
             FROM import_job WHERE library_id = ?
             AND status IN ('committed','snapshot_pending','snapshot_failed','completed')",
        )?;
        let job_rows: Vec<(String, Option<String>, Option<String>, Option<i64>)> = jobs
            .query_map(rusqlite::params![self.library_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (job_id, committed_work_id, committed_at, committed_revision) in job_rows {
            if committed_work_id.is_none() || committed_at.is_none() || committed_revision.is_none() {
                issues.push(json!({ "code": "committed-credential-incomplete", "detail": job_id }));
            }
        }

        let errors: Vec<&Value> = issues
            .iter()
            .filter(|issue| issue.get("severity").and_then(Value::as_str) != Some("warning"))
            .collect();
        let warnings: Vec<&Value> = issues
            .iter()
            .filter(|issue| issue.get("severity").and_then(Value::as_str) == Some("warning"))
            .collect();
        let sqlite_version: String = self
            .connection
            .query_row("SELECT sqlite_version() AS v", [], |row| row.get(0))?;
        Ok(json!({
            "ok": errors.is_empty(),
            "issues": issues,
            "warnings": warnings,
            "counts": counts,
            "sqliteVersion": sqlite_version,
        }))
    }

    /// Rebuild the derived search index only; business tables are untouched.
    pub fn rebuild_derived_index(&self) -> Result<i64> {
        self.assert_open()?;
        let timestamp = now_iso();
        self.tx(|| {
            self.connection.execute("DELETE FROM work_search", [])?;
            self.connection.execute(
                "INSERT INTO work_search(work_id, title, circle, cv, updated_at)
                 SELECT work_id, COALESCE(user_title, title), circle, cv_json, updated_at
                 FROM work WHERE deleted_at IS NULL",
                [],
            )?;
            self.connection.execute(
                "UPDATE library SET updated_at = ? WHERE library_id = ?",
                rusqlite::params![timestamp, self.library_id],
            )?;
            Ok(())
        })?;
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) AS n FROM work_search", [], |row| row.get(0))?;
        Ok(count)
    }

    /// Close the library: checkpoint the WAL, drop the connection, release the lease.
    pub fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let _ = self.connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        if let Some(lease) = self.lease.take() {
            let _ = lease.release();
        }
        Ok(())
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        // Drop must not lose the checkpoint: a half-flushed WAL is recoverable,
        // but leaving it unflushed makes the next open do recovery work.
        if !self.closed {
            let _ = self.connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        }
    }
}

struct WorkRow {
    work_id: String,
    family_id: Option<String>,
    title: String,
    user_title: Option<String>,
    user_meta_json: String,
    circle: String,
    cv_json: String,
    language: Option<String>,
    role: Option<String>,
    revision: i64,
    deleted_at: Option<String>,
    created_at: String,
    updated_at: String,
}

struct EntryRow {
    entry_id: String,
    stable_entry_id: String,
    logical_path: String,
    kind: String,
    mime: Option<String>,
    display_title: Option<String>,
    original_path: Option<String>,
    sort_order: i64,
    track_key: Option<String>,
    track_id: Option<String>,
    rendition_format: Option<String>,
}

/// `import_job` fields the host cares about.
#[derive(Debug, Clone)]
pub struct ImportJobRow {
    pub job_id: String,
    pub status: String,
    pub plan_hash: String,
    pub committed_work_id: Option<String>,
}

/// Result of [`Library::merge_work_source`].
#[derive(Debug, Clone)]
pub struct MergeOutcome {
    pub changed: bool,
    pub revision: i64,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub missing: usize,
    pub job_id: Option<String>,
}

impl MergeOutcome {
    pub fn to_json(&self) -> Value {
        json!({
            "changed": self.changed,
            "revision": self.revision,
            "added": self.added,
            "updated": self.updated,
            "skipped": self.skipped,
            "missing": self.missing,
        })
    }
}

/// Result of [`Library::import_work`].
#[derive(Debug)]
pub struct ImportOutcome {
    pub work: Value,
    pub job_id: String,
    pub idempotent: bool,
}

/// Result of one snapshot publication attempt.
#[derive(Debug, Clone)]
pub struct SnapshotPublish {
    pub work_id: String,
    pub ok: bool,
    pub published: Option<i64>,
    pub skipped: Option<String>,
    pub target: Option<i64>,
    pub error: Option<String>,
}

impl SnapshotPublish {
    fn skipped(work_id: &str, reason: &str) -> Self {
        Self {
            work_id: work_id.to_string(),
            ok: false,
            published: None,
            skipped: Some(reason.to_string()),
            target: None,
            error: None,
        }
    }

    fn failed(work_id: &str, target_revision: i64, message: String) -> Self {
        Self {
            work_id: work_id.to_string(),
            ok: false,
            published: None,
            skipped: None,
            target: Some(target_revision),
            error: Some(message),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("workId".to_string(), json!(self.work_id));
        map.insert("ok".to_string(), json!(self.ok));
        if let Some(published) = self.published {
            map.insert("published".to_string(), json!(published));
        }
        if let Some(skipped) = &self.skipped {
            map.insert("skipped".to_string(), json!(skipped));
        }
        if let Some(target) = self.target {
            map.insert("target".to_string(), json!(target));
        }
        if let Some(error) = &self.error {
            map.insert("error".to_string(), json!(error));
        }
        Value::Object(map)
    }
}

fn write_root_metadata(root: &Path, library_id: &str, create: bool) -> Result<()> {
    let path = root.join(layout::ROOT_JSON);
    if let Some(existing) = fsutil::read_json(&path, None) {
        let existing_id = existing.get("libraryId").and_then(Value::as_str);
        if existing_id != Some(library_id) && create {
            return Err(Error::new("root.json and library.sqlite libraryId mismatch"));
        }
        // The layout field is what tells the next open whether conversion is done;
        // older roots do not carry it at all (recorded_version reads that as 1).
        if layout::recorded_version(Some(&existing)) < layout::LAYOUT_VERSION {
            let mut updated = existing;
            if let Some(object) = updated.as_object_mut() {
                object.insert("layout".into(), Value::from(layout::LAYOUT_VERSION));
            }
            fsutil::atomic_write_json(&path, &updated)?;
        }
        return Ok(());
    }
    if !create {
        return Err(Error::new(format!(
            "missing root.json; run with create or openLibrary(root,{{create:true}})"
        )));
    }
    let metadata = json!({
        "schemaVersion": schema::SCHEMA_VERSION,
        "layout": layout::LAYOUT_VERSION,
        "libraryId": library_id,
        "createdAt": now_iso(),
        "app": "monochrome-storage-lab",
    });
    fsutil::atomic_write_json(&path, &metadata)
}

/// Convenience wrapper matching `openLibrary(root, options)`.
pub fn open_library(root: impl AsRef<Path>, options: OpenOptions) -> Result<Library> {
    Library::open(root, options)
}

/// Merge helper re-exported for the host layer (sidecar writes).
pub fn merge_metadata(base: &Map<String, Value>, overlay: &Map<String, Value>) -> Map<String, Value> {
    merge_objects(base, overlay)
}

/// Manifest entries of a work's `user_meta_json` (`manifestEntries`).
pub fn work_manifest(meta: &Map<String, Value>) -> Option<Vec<Value>> {
    manifest_entries(meta)
}

/// Re-export so callers do not need to import `snapshot` directly.
pub use snapshot::SnapshotFault as Fault;

/// Convert a `rusqlite::Row` column list into the JSON shape used by the CLI.
pub fn row_to_json(row: &SqlRow<'_>, columns: &[&str]) -> rusqlite::Result<Value> {
    let mut map = Map::new();
    for (index, name) in columns.iter().enumerate() {
        let value = row.get::<_, rusqlite::types::Value>(index)?;
        map.insert((*name).to_string(), sql_value_to_json(value));
    }
    Ok(Value::Object(map))
}

fn sql_value_to_json(value: rusqlite::types::Value) -> Value {
    use rusqlite::types::Value as SqlValue;
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(number) => json!(number),
        SqlValue::Real(number) => json!(number),
        SqlValue::Text(text) => json!(text),
        SqlValue::Blob(bytes) => json!(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(tag: &str) -> (Library, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("mono-lib-{tag}-{}", uuid::Uuid::new_v4()));
        let source_root = root.join("source");
        std::fs::create_dir_all(source_root.join("work")).unwrap();
        std::fs::write(source_root.join("work").join("01.mp3"), b"first").unwrap();
        std::fs::write(source_root.join("work").join("02.wav"), b"second").unwrap();
        let lib = Library::open(
            root.join("library"),
            OpenOptions {
                create: true,
                allow_outside_root: true,
                ..Default::default()
            },
        )
        .unwrap();
        (lib, root, source_root)
    }

    fn source(source_root: &Path) -> SourceRecord {
        SourceRecord::from_json(&json!({
            "provider": "dlsite",
            "sourceCode": "RJ00000001",
            "title": "Fixture work",
            "circle": "Fixture circle",
            "cvs": ["Fixture CV"],
            "edition": { "language": "ja", "role": "source" },
            "entries": [
                {
                    "entryId": "audio-1",
                    "logicalPath": "音声本体/01.mp3",
                    "kind": "audio",
                    "mime": "audio/mpeg",
                    "sourcePath": source_root.join("work").join("01.mp3").to_string_lossy(),
                    "trackKey": "track-1"
                },
                {
                    "entryId": "audio-2",
                    "logicalPath": "音声本体/02.wav",
                    "kind": "audio",
                    "mime": "audio/wav",
                    "sourcePath": source_root.join("work").join("02.wav").to_string_lossy(),
                    "trackKey": "track-2"
                }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn import_commits_work_entries_and_outbox() {
        let (mut lib, root, source_root) = library("import");
        let outcome = lib.import_work(source(&source_root), "key-1").unwrap();
        assert!(!outcome.idempotent);
        let work = &outcome.work;
        assert_eq!(work["title"], "Fixture work");
        assert_eq!(work["entries"].as_array().unwrap().len(), 2);
        let outbox: i64 = lib
            .connection
            .query_row("SELECT COUNT(*) FROM snapshot_outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox, 1);
        // Source-only: assets are virtual markers, and no CAS copy exists.
        let rel: String = lib
            .connection
            .query_row("SELECT rel_path FROM asset LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert!(rel.starts_with("source/"));
        assert!(!layout::derived_root(&lib.data_root).join("sha256").join(&rel[7..]).exists());
        let _ = root;
    }

    /// The accepted rule is one copy per work, not one copy per library: two
    /// works pointing at the same bytes must both import. Before schema v9 the
    /// second insert collided on `asset.sha256` / `asset.rel_path`; the rows now
    /// may share those values because `asset_id` is the identity.
    #[test]
    fn two_works_may_contain_the_same_file() {
        let (mut lib, root, source_root) = library("shared-file");
        let first = lib.import_work(source(&source_root), "shared-1").unwrap();
        let mut second_source = source(&source_root);
        second_source.source_code = "RJ00000002".to_string();
        second_source.title = "Second work".to_string();
        let second = lib.import_work(second_source, "shared-2").unwrap();
        assert_ne!(first.work["workId"], second.work["workId"]);

        for work in [&first.work, &second.work] {
            let work_id = work["workId"].as_str().unwrap();
            let refs: i64 = lib
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM asset_ref WHERE work_id = ?",
                    rusqlite::params![work_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(refs, 2, "{work_id} lost an entry to the shared bytes");
        }
        // Both entries of both works resolve to an asset row with the same path.
        let shared: i64 = lib
            .connection
            .query_row(
                "SELECT COUNT(*) FROM asset WHERE rel_path LIKE 'source/%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(shared, 2);
        let _ = root;
    }

    /// Layout v2 writes `sourcePath` relative to the source root; the bytes still
    /// have to be hashed from somewhere, and the snapshot keeps the relative form
    /// so the record survives a moved library. Both halves matter: getting only
    /// the first wrong fails the import, getting only the second wrong silently
    /// re-pins the machine path into the record.
    #[test]
    fn relative_source_path_is_stored_while_the_bytes_come_from_the_absolute_one() {
        let (mut lib, root, source_root) = library("read-path");
        let mut record = source(&source_root);
        for entry in record.entries.iter_mut() {
            let name = entry.logical_path.rsplit('/').next().unwrap().to_string();
            entry.absolute_path = Some(source_root.join("work").join(&name).to_string_lossy().into_owned());
            entry.source_path = format!("work/{name}");
        }
        let outcome = lib.import_work(record, "key-read-path").unwrap();
        assert_eq!(outcome.work["entries"].as_array().unwrap().len(), 2);
        let stored: Vec<String> = {
            let mut statement = lib.connection.prepare("SELECT original_path FROM entry ORDER BY logical_path").unwrap();
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows
        };
        assert_eq!(stored, vec!["work/01.mp3".to_string(), "work/02.wav".to_string()]);
        // The snapshot carries the same relative value, never the absolute one.
        let snapshot: String = lib
            .connection
            .query_row("SELECT snapshot_json FROM source_ref LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert!(snapshot.contains("\"sourcePath\":\"work/01.mp3\""), "{snapshot}");
        assert!(!snapshot.contains(&source_root.to_string_lossy().replace('\\', "\\\\")), "absolute path leaked into the snapshot");
        let _ = root;
    }

    #[test]
    fn same_key_same_plan_is_idempotent_and_different_plan_conflicts() {
        let (mut lib, _root, source_root) = library("idem");
        let first = lib.import_work(source(&source_root), "key-1").unwrap();
        let second = lib.import_work(source(&source_root), "key-1").unwrap();
        assert!(second.idempotent);
        assert_eq!(first.work["workId"], second.work["workId"]);

        let mut changed = source(&source_root);
        changed.title = "Different plan".to_string();
        let error = lib.import_work(changed, "key-1").unwrap_err();
        assert_eq!(error.code, Some("EIDEMPOTENCYCONFLICT"));
    }

    #[test]
    fn metadata_whitelist_and_revision_bump() {
        let (mut lib, _root, source_root) = library("meta");
        let work_id = lib.import_work(source(&source_root), "k").unwrap().work["workId"]
            .as_str()
            .unwrap()
            .to_string();
        let before: i64 = lib
            .connection
            .query_row("SELECT revision FROM work WHERE work_id = ?", rusqlite::params![work_id], |row| row.get(0))
            .unwrap();
        let mut patch = Map::new();
        patch.insert("rating".to_string(), json!(4.5));
        patch.insert("not_allowed".to_string(), json!("ignored"));
        patch.insert("tags".to_string(), json!([" a ", "a", ""]));
        let updated = lib.update_work_metadata(&work_id, &patch).unwrap();
        assert_eq!(updated["userMeta"]["rating"], 4.5);
        assert!(updated["userMeta"].get("not_allowed").is_none());
        assert_eq!(updated["userMeta"]["tags"], json!(["a"]));
        let after: i64 = lib
            .connection
            .query_row("SELECT revision FROM work WHERE work_id = ?", rusqlite::params![work_id], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before + 1);
    }

    #[test]
    fn soft_delete_hides_work_but_keeps_row() {
        let (mut lib, _root, source_root) = library("delete");
        let work_id = lib.import_work(source(&source_root), "k").unwrap().work["workId"]
            .as_str()
            .unwrap()
            .to_string();
        lib.soft_delete_work(&work_id).unwrap();
        assert!(lib.get_work(&work_id, false).unwrap().is_none());
        assert!(lib.get_work(&work_id, true).unwrap().is_some());
        lib.restore_work(&work_id).unwrap();
        assert!(lib.get_work(&work_id, false).unwrap().is_some());
    }

    #[test]
    fn snapshot_publish_marks_ready_and_verifies() {
        let (mut lib, _root, source_root) = library("snap");
        let work_id = lib.import_work(source(&source_root), "k").unwrap().work["workId"]
            .as_str()
            .unwrap()
            .to_string();
        let results = lib.flush_snapshots().unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok);
        assert_eq!(results[0].work_id, work_id, "the published snapshot is the imported work");
        assert_eq!(results[0].published, Some(1));
        let verify = lib.verify_library().unwrap();
        assert_eq!(verify["ok"], true, "{verify}");
        // A second flush has nothing pending.
        assert!(lib.flush_snapshots().unwrap().is_empty());
    }

    #[test]
    fn second_open_is_locked_out() {
        let (lib, root, _source_root) = library("lock");
        let second = Library::open(
            root.join("library"),
            OpenOptions { create: false, allow_outside_root: true, ..Default::default() },
        );
        assert!(second.is_err());
        assert_eq!(second.unwrap_err().code, Some("ELOCKED"));
        drop(lib);
    }
}
