//! SQLite DDL, migrations and pragmas (`schema.mjs`).
//!
//! The database file is the compatibility surface: an existing Node library must
//! open here unchanged, and a library created here must open in Node. That means
//! the DDL text, `PRAGMA user_version`, table/column/index names and the
//! migration order are all part of the contract — do not "tidy" them.

use rusqlite::{Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::jsonutil::now_iso;

/// Must equal `SCHEMA_VERSION` in `verify/storage-lab/lib/schema.mjs`.
///
/// v8 adds the four post tables (`creator`/`post`/`post_file`/`post_tag`) that
/// back creations and videos; the audio tables are unchanged. The Node host stays
/// on v7, so it refuses a v8 database — that is deliberate: it keeps an old Node
/// build from writing a library whose post tables it cannot maintain (see
/// `docs/handoff/343`). Bump this in lockstep with `schema.mjs` once the host
/// learns v8.
///
/// v7 → v8 只新增 post 表，不迁移 creation_post；创作在前端改造前继续走旧表
/// (`/api/creations*` reads `creation_post`/`creation_asset`; copying them into
/// `post` would store every creation twice and let a delete through one API
/// leave the other copy behind).
pub const SCHEMA_VERSION: i64 = 8;

/// Import-job statuses accepted by the `import_job.status` CHECK constraint.
const IMPORTS_JOB_STATUSES: &str = "'created','scanning','preview_ready','staging','publishing_assets','committing','committed','snapshot_pending','snapshot_failed','completed','failed_precommit','cancelled_precommit'";

/// The DDL, byte-for-byte equivalent to `DDL` in `schema.mjs`.
///
/// `CREATE TABLE IF NOT EXISTS` means this is also the upgrade path for older
/// roots; column additions that `IF NOT EXISTS` cannot express are handled by
/// [`apply_schema`].
pub fn ddl() -> String {
    format!(
        r#"
CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library (
    library_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS family (
    family_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work (
    work_id TEXT PRIMARY KEY,
    family_id TEXT REFERENCES family(family_id),
    title TEXT NOT NULL,
    user_title TEXT,
    user_meta_json TEXT NOT NULL DEFAULT '{{}}',
    circle TEXT NOT NULL DEFAULT '',
    cv_json TEXT NOT NULL DEFAULT '[]',
    language TEXT,
    role TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_ref (
    source_ref_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    source_code TEXT NOT NULL,
    source_url TEXT,
    snapshot_json TEXT NOT NULL DEFAULT '{{}}',
    fetched_at TEXT,
    UNIQUE (work_id, provider, source_code)
);

CREATE TABLE IF NOT EXISTS entry (
    entry_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    stable_entry_id TEXT NOT NULL,
    logical_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT,
    display_title TEXT,
    original_path TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    track_key TEXT,
    UNIQUE (work_id, stable_entry_id),
    UNIQUE (work_id, logical_path)
);

CREATE TABLE IF NOT EXISTS track (
    track_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    track_key TEXT NOT NULL,
    title TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (work_id, track_key)
);

CREATE TABLE IF NOT EXISTS track_rendition (
    rendition_id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES track(track_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL UNIQUE REFERENCES entry(entry_id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    mime TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset (
    asset_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    mime TEXT,
    rel_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_ref (
    asset_ref_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entry(entry_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES asset(asset_id),
    role TEXT NOT NULL DEFAULT 'primary',
    UNIQUE (entry_id, asset_id, role)
);

CREATE TABLE IF NOT EXISTS user_state (
    work_id TEXT PRIMARY KEY REFERENCES work(work_id) ON DELETE CASCADE,
    notes TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
    playback_position REAL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_document (
    work_id TEXT PRIMARY KEY REFERENCES work(work_id) ON DELETE CASCADE,
    intro_text TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    source_revision TEXT NOT NULL DEFAULT '',
    media_state TEXT NOT NULL DEFAULT 'not_requested',
    document_revision INTEGER NOT NULL DEFAULT 0,
    asset_manifest_json TEXT NOT NULL DEFAULT '[]',
    last_idempotency_key TEXT,
    last_plan_hash TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_asset_ref (
    document_asset_ref_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES asset(asset_id),
    resource_id TEXT NOT NULL,
    logical_path TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'body',
    mime TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL,
    UNIQUE (work_id, resource_id)
);

CREATE TABLE IF NOT EXISTS creation_post (
    post_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{{}}',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creation_asset (
    asset_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES creation_post(post_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'original',
    name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    sha256 TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (post_id, attachment_id, role)
);

CREATE INDEX IF NOT EXISTS idx_creation_asset_post ON creation_asset(post_id);

-- v8: creations (Patreon/Pawchive) and videos (YouTube). These are deliberately
-- separate from work/entry/asset: audio entries are identity-by-provider+source
-- and file-driven, while a post is one remote item with many role-tagged files
-- that may be offline-only. Post identity is (category, provider, source_id) so
-- the same numeric source id can exist once as a creation and once as a video.
CREATE TABLE IF NOT EXISTS creator (
    creator_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    avatar_sha256 TEXT NOT NULL DEFAULT '',
    avatar_rel_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, source_id)
);

CREATE TABLE IF NOT EXISTS post (
    post_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('creation', 'video')),
    provider TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    source_url TEXT NOT NULL DEFAULT '',
    creator_id TEXT REFERENCES creator(creator_id) ON DELETE SET NULL,
    root_path TEXT NOT NULL DEFAULT '',
    body_sha256 TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{{}}',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (category, provider, source_id)
);

CREATE TABLE IF NOT EXISTS post_file (
    file_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES post(post_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('attachment', 'inline', 'thumbnail', 'cover', 'video', 'subtitle')),
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    remote_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'local' CHECK (status IN ('local', 'remote', 'missing')),
    created_at TEXT NOT NULL,
    UNIQUE (post_id, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_post_category ON post(category, deleted_at);
CREATE INDEX IF NOT EXISTS idx_post_source ON post(provider, source_id);
CREATE INDEX IF NOT EXISTS idx_post_file_role ON post_file(post_id, role);

CREATE TABLE IF NOT EXISTS post_tag (
    post_id TEXT NOT NULL REFERENCES post(post_id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (post_id, tag)
);

CREATE TABLE IF NOT EXISTS subtitle_binding (
    binding_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    entry_id TEXT REFERENCES entry(entry_id) ON DELETE SET NULL,
    asset_id TEXT REFERENCES asset(asset_id),
    language TEXT,
    offset_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_job (
    job_id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES library(library_id),
    batch_id TEXT,
    idempotency_key TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ({statuses})),
    committed_work_id TEXT REFERENCES work(work_id),
    committed_at TEXT,
    committed_revision INTEGER,
    snapshot_status TEXT,
    snapshot_error TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (library_id, idempotency_key),
    CHECK (
        (committed_work_id IS NULL AND committed_at IS NULL AND committed_revision IS NULL)
        OR
        (committed_work_id IS NOT NULL AND committed_at IS NOT NULL AND committed_revision IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS import_batch (
    batch_id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES library(library_id),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Durable progress for a batch; the UI polls this while the worker runs.
CREATE TABLE IF NOT EXISTS import_batch_progress (
    batch_id TEXT PRIMARY KEY REFERENCES import_batch(batch_id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES library(library_id),
    status TEXT NOT NULL DEFAULT 'running',
    phase TEXT NOT NULL DEFAULT 'queued',
    current_candidate INTEGER NOT NULL DEFAULT 0,
    total_candidates INTEGER NOT NULL DEFAULT 0,
    candidate_id TEXT,
    current_entry INTEGER NOT NULL DEFAULT 0,
    total_entries INTEGER NOT NULL DEFAULT 0,
    bytes_done INTEGER NOT NULL DEFAULT 0,
    bytes_total INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batch_event (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES import_batch(batch_id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{{}}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_outbox (
    library_id TEXT NOT NULL REFERENCES library(library_id),
    work_id TEXT NOT NULL REFERENCES work(work_id) ON DELETE CASCADE,
    target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
    published_revision INTEGER NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','retry_wait','ready')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (library_id, work_id)
);

CREATE TABLE IF NOT EXISTS queue_state (
    queue_id TEXT PRIMARY KEY,
    current_index INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_item (
    queue_id TEXT NOT NULL REFERENCES queue_state(queue_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    work_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    PRIMARY KEY (queue_id, position)
);

-- Playback queue and positions are business state, not cache; no cache/GC path
-- deletes these tables. Only stable IDs are stored (no URLs/blob references).
CREATE TABLE IF NOT EXISTS playback_position (
    work_id TEXT PRIMARY KEY,
    entry_id TEXT,
    seconds REAL NOT NULL CHECK (seconds >= 0),
    precision_ms INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS download_task (
    task_id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES entry(entry_id) ON DELETE SET NULL,
    source_version TEXT,
    part_path TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    expected_bytes INTEGER,
    final_sha256 TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_import (
    import_id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES library(library_id),
    idempotency_key TEXT NOT NULL,
    bundle_json TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    source TEXT,
    status TEXT NOT NULL,
    counts_json TEXT NOT NULL DEFAULT '{{}}',
    errors_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (library_id, idempotency_key),
    UNIQUE (library_id, bundle_hash)
);

CREATE TABLE IF NOT EXISTS legacy_media_ref (
    media_ref_id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES legacy_import(import_id) ON DELETE CASCADE,
    work_id TEXT REFERENCES work(work_id) ON DELETE CASCADE,
    entry_id TEXT REFERENCES entry(entry_id) ON DELETE CASCADE,
    legacy_kind TEXT NOT NULL,
    legacy_id TEXT,
    old_id TEXT,
    url TEXT NOT NULL,
    mime TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (entry_id, url)
);

CREATE TABLE IF NOT EXISTS legacy_staged_payload (
    import_id TEXT NOT NULL REFERENCES legacy_import(import_id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (import_id, domain)
);

CREATE TABLE IF NOT EXISTS legacy_id_map (
    old_kind TEXT NOT NULL,
    old_id TEXT NOT NULL,
    new_kind TEXT NOT NULL,
    new_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (old_kind, old_id)
);

-- Derived only. rebuildDerivedIndex() may delete/refill this table; business
-- tables must never be touched by that operation.
CREATE TABLE IF NOT EXISTS work_search (
    work_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    circle TEXT NOT NULL,
    cv TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entry_work ON entry(work_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_asset_ref_work ON asset_ref(work_id);
CREATE INDEX IF NOT EXISTS idx_asset_ref_asset ON asset_ref(asset_id);
CREATE INDEX IF NOT EXISTS idx_import_job_committed ON import_job(committed_work_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON snapshot_outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_work_deleted ON work(deleted_at);
CREATE INDEX IF NOT EXISTS idx_track_work ON track(work_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rendition_track ON track_rendition(track_id, priority);
CREATE INDEX IF NOT EXISTS idx_queue_item_order ON queue_item(queue_id, position);
"#,
        statuses = IMPORTS_JOB_STATUSES
    )
}

/// Apply the pragmas `library.mjs` relies on.
///
/// `synchronous = FULL` is deliberate: the host survives hard power loss by
/// refusing to acknowledge an import before the WAL is durable. Do not relax it
/// to `NORMAL` for speed without revisiting the import-job recovery contract.
pub fn enable_pragmas(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(())
}

fn user_version(connection: &Connection) -> i64 {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = Vec::new();
    for row in rows {
        names.push(row?);
    }
    Ok(names)
}

/// Track format inference shared by the migration and import paths.
///
/// Extension wins over MIME because a `.wav` renamed to `.mp3` should still be
/// grouped as the container the user actually has on disk.
pub fn entry_format(logical_path: &str, mime: Option<&str>) -> String {
    let extension = logical_path.rsplit('.').next().unwrap_or("").to_lowercase();
    const AUDIO: &[&str] = &["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff", "aif"];
    if AUDIO.contains(&extension.as_str()) {
        return if extension == "aif" { "aiff".to_string() } else { extension };
    }
    let mime = mime.unwrap_or("").to_lowercase();
    if mime.contains("mpeg") {
        return "mp3".to_string();
    }
    if mime.contains("wav") {
        return "wav".to_string();
    }
    if mime.contains("flac") {
        return "flac".to_string();
    }
    if mime.contains("aac") {
        return "aac".to_string();
    }
    if mime.contains("mp4") {
        return "m4a".to_string();
    }
    if mime.contains("ogg") {
        return "ogg".to_string();
    }
    if mime.contains("opus") {
        return "opus".to_string();
    }
    "unknown".to_string()
}

/// Backfill `track`/`track_rendition` rows for entries that predate E04.
fn migrate_tracks(connection: &Connection) -> Result<()> {
    let timestamp = now_iso();
    let mut statement = connection.prepare(
        "SELECT e.entry_id, e.work_id, e.stable_entry_id, e.logical_path, e.display_title,
                e.sort_order, e.mime, e.track_key
         FROM entry e
         LEFT JOIN track_rendition r ON r.entry_id = e.entry_id
         WHERE r.entry_id IS NULL",
    )?;
    let mut rows = statement.query([])?;
    let mut pending = Vec::new();
    while let Some(row) = rows.next()? {
        pending.push((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            row.get::<_, i64>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ));
    }
    drop(rows);
    drop(statement);
    for (entry_id, work_id, stable_entry_id, logical_path, display_title, sort_order, mime, track_key) in pending {
        let key = track_key.filter(|value| !value.is_empty()).unwrap_or_else(|| stable_entry_id.clone());
        let track_id = format!("track-{work_id}-{entry_id}");
        connection.execute(
            "INSERT OR IGNORE INTO track(track_id, work_id, track_key, title, sort_order, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![track_id, work_id, key, display_title, sort_order, timestamp],
        )?;
        let resolved_track: Option<String> = connection
            .query_row(
                "SELECT track_id FROM track WHERE work_id = ? AND track_key = ?",
                rusqlite::params![work_id, key],
                |row| row.get(0),
            )
            .optional()?;
        let Some(resolved_track) = resolved_track else { continue };
        connection.execute(
            "INSERT OR IGNORE INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                format!("rendition-{entry_id}"),
                resolved_track,
                entry_id,
                entry_format(&logical_path, mime.as_deref()),
                mime,
                sort_order,
                timestamp
            ],
        )?;
        connection.execute(
            "UPDATE entry SET track_key = ? WHERE entry_id = ?",
            rusqlite::params![key, entry_id],
        )?;
    }
    Ok(())
}

/// Create/migrate the schema inside one `BEGIN IMMEDIATE` transaction.
///
/// A database newer than [`SCHEMA_VERSION`] is refused rather than "upgraded" by
/// guesswork: a newer writer may have added semantics this build would silently
/// drop.
pub fn apply_schema(connection: &Connection, library_id: &str) -> Result<()> {
    let version = user_version(connection);
    if version > SCHEMA_VERSION {
        return Err(Error::new(format!(
            "database schema {version} is newer than supported {SCHEMA_VERSION}"
        )));
    }
    connection.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<()> {
        connection.execute_batch(&ddl())?;
        // v2 roots already have work_document; CREATE TABLE IF NOT EXISTS cannot
        // add columns, so add them in place without rebuilding the table.
        let document_columns = table_columns(connection, "work_document")?;
        let additions: [(&str, &str); 7] = [
            ("source_url", "TEXT NOT NULL DEFAULT ''"),
            ("source_revision", "TEXT NOT NULL DEFAULT ''"),
            ("media_state", "TEXT NOT NULL DEFAULT 'not_requested'"),
            ("document_revision", "INTEGER NOT NULL DEFAULT 0"),
            ("asset_manifest_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("last_idempotency_key", "TEXT"),
            ("last_plan_hash", "TEXT"),
        ];
        for (name, definition) in additions {
            if !document_columns.iter().any(|column| column == name) {
                connection.execute_batch(&format!("ALTER TABLE work_document ADD COLUMN {name} {definition}"))?;
            }
        }
        if !table_columns(connection, "work")?.iter().any(|column| column == "user_meta_json") {
            connection.execute_batch("ALTER TABLE work ADD COLUMN user_meta_json TEXT NOT NULL DEFAULT '{}'")?;
        }
        if !table_columns(connection, "entry")?.iter().any(|column| column == "track_key") {
            connection.execute_batch("ALTER TABLE entry ADD COLUMN track_key TEXT")?;
        }
        migrate_tracks(connection)?;
        let now = now_iso();
        connection.execute(
            "INSERT OR IGNORE INTO schema_migration(version, applied_at) VALUES (?, ?)",
            rusqlite::params![SCHEMA_VERSION, now],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO library(library_id, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?)",
            rusqlite::params![library_id, SCHEMA_VERSION, now, now],
        )?;
        connection.execute(
            "UPDATE library SET schema_version = ?, updated_at = ? WHERE library_id = ?",
            rusqlite::params![SCHEMA_VERSION, now, library_id],
        )?;
        connection.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        Ok(())
    })();
    match outcome {
        Ok(()) => {
            connection.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        enable_pragmas(&connection).unwrap();
        connection
    }

    #[test]
    fn schema_matches_node_version_and_is_idempotent() {
        let connection = memory();
        apply_schema(&connection, "lib-1").unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        // Re-applying must be a no-op, because the host calls this on every start.
        apply_schema(&connection, "lib-1").unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);

        let columns = table_columns(&connection, "work").unwrap();
        assert!(columns.contains(&"user_meta_json".to_string()));
        let entry_columns = table_columns(&connection, "entry").unwrap();
        assert!(entry_columns.contains(&"track_key".to_string()));
        let library_row: (String, i64) = connection
            .query_row("SELECT library_id, schema_version FROM library LIMIT 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(library_row, ("lib-1".to_string(), SCHEMA_VERSION));
    }

    #[test]
    fn newer_schema_is_refused() {
        let connection = memory();
        connection.execute_batch("PRAGMA user_version = 99").unwrap();
        let error = apply_schema(&connection, "lib-1").unwrap_err();
        assert!(error.message.contains("newer than supported"));
    }

    #[test]
    fn format_prefers_extension_then_mime() {
        assert_eq!(entry_format("a/AIF.aif", None), "aiff");
        assert_eq!(entry_format("a/A.MP3", Some("audio/mpeg")), "mp3");
        assert_eq!(entry_format("a/A.bin", Some("audio/x-wav")), "wav");
        assert_eq!(entry_format("a/A.bin", None), "unknown");
    }

    #[test]
    fn v8_adds_post_tables() {
        let connection = Connection::open_in_memory().unwrap();
        enable_pragmas(&connection).unwrap();
        apply_schema(&connection, "lib").unwrap();
        assert_eq!(user_version(&connection), 8);
        for table in ["post", "creator", "post_file", "post_tag"] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
                    rusqlite::params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table} is missing");
        }
    }

    #[test]
    fn post_source_is_unique_per_category_and_provider() {
        let connection = Connection::open_in_memory().unwrap();
        enable_pragmas(&connection).unwrap();
        apply_schema(&connection, "lib").unwrap();
        let insert = |category: &str| {
            connection.execute(
                "INSERT INTO post(post_id, category, provider, source_id, title, root_path,
                     body_sha256, meta_json, created_at, updated_at)
                 VALUES (?, ?, 'youtube', 'abc', 't', 'Videos/YouTube/x', '', '{}', 'now', 'now')",
                rusqlite::params![format!("{category}-1"), category],
            )
        };
        insert("video").unwrap();
        assert!(insert("video").is_err(), "same source_id in one category must collide");
        insert("creation").unwrap();
    }

    fn table_exists(connection: &Connection, table: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
                rusqlite::params![table],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            == 1
    }

    #[test]
    fn v7_library_upgrades_without_losing_audio_or_creations() {
        use crate::{creations, posts};

        let connection = memory();
        // Build a v7 library by taking today's schema and removing exactly what
        // v8 added. v7 → v8 only introduced these four tables (no column changes
        // to existing tables), so this is structurally the same file a v7 build
        // leaves on disk — and unlike a hand-copied v7 DDL it cannot drift from
        // the tables the rest of the schema still shares with v7.
        apply_schema(&connection, "lib-v7").unwrap();
        connection
            .execute_batch(
                "DROP TABLE post_tag;
                 DROP TABLE post_file;
                 DROP TABLE post;
                 DROP TABLE creator;
                 DELETE FROM schema_migration WHERE version = 8;
                 INSERT INTO schema_migration(version, applied_at) VALUES (7, '2026-01-01T00:00:00.000Z');
                 UPDATE library SET schema_version = 7;
                 PRAGMA user_version = 7;",
            )
            .unwrap();
        for table in ["post", "creator", "post_file", "post_tag"] {
            assert!(!table_exists(&connection, table), "fixture must not contain v8 table {table}");
        }

        // Data a real v7 user has: one creation (old creation API) and one voice work.
        let creation = serde_json::json!({
            "id": "patreon-123",
            "title": "Old creation",
            "sourceUrl": "https://example.invalid/posts/123",
            "tags": ["kept"],
        });
        creations::save_post(&connection, &creation).unwrap();
        let before = creations::list_posts(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO work(work_id, title, created_at, updated_at)
                 VALUES ('work-rj1', 'Voice work', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();

        apply_schema(&connection, "lib-v7").unwrap();

        assert_eq!(user_version(&connection), 8);
        for table in ["post", "creator", "post_file", "post_tag"] {
            assert!(table_exists(&connection, table), "{table} was not created on upgrade");
        }
        let library_version: i64 = connection
            .query_row("SELECT schema_version FROM library WHERE library_id = 'lib-v7'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(library_version, 8);

        // The old creation survives byte-for-byte: the frontend creation page still
        // reads `/api/creations` from `creation_post`, so any change here is user-visible.
        let after = creations::list_posts(&connection).unwrap();
        assert_eq!(after, before);
        assert_eq!(after.as_array().unwrap().len(), 1);
        assert_eq!(after[0]["title"], "Old creation");
        assert_eq!(after[0]["tags"], serde_json::json!(["kept"]));

        let work_title: String = connection
            .query_row("SELECT title FROM work WHERE work_id = 'work-rj1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(work_title, "Voice work");

        // No implicit migration: copying creation_post into post would store each
        // creation twice, and deleting it through one API would leave the other copy.
        assert_eq!(posts::list_posts_by_category(&connection, "creation").unwrap(), serde_json::json!([]));
        assert_eq!(posts::list_posts_by_category(&connection, "video").unwrap(), serde_json::json!([]));

        // The new table is writable and does not bleed into the old creation API.
        let video = serde_json::json!({
            "category": "video",
            "provider": "youtube",
            "sourceId": "abc",
            "title": "New video",
        });
        posts::upsert_post(&connection, &video, "sha", "2026-11-17T00:00:00.000Z").unwrap();
        assert_eq!(posts::list_posts_by_category(&connection, "video").unwrap().as_array().unwrap().len(), 1);
        assert_eq!(creations::list_posts(&connection).unwrap(), before);
    }

    #[test]
    fn schema_one_version_ahead_is_refused() {
        // The nearest future version, not just an absurd one: a v9 writer is the
        // realistic case, and it must not be silently "upgraded" back to v8.
        let connection = memory();
        connection.execute_batch("PRAGMA user_version = 9").unwrap();
        let error = apply_schema(&connection, "lib-1").unwrap_err();
        assert!(error.message.contains("newer than supported"));
        assert_eq!(user_version(&connection), 9, "a refused database must not be rewritten");
    }

    #[test]
    fn apply_schema_is_idempotent_at_v8() {
        // The host applies the schema on every start; a duplicate migration row
        // would make the history claim v8 was applied twice.
        let connection = memory();
        apply_schema(&connection, "lib-1").unwrap();
        apply_schema(&connection, "lib-1").unwrap();
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migration WHERE version = 8", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        let libraries: i64 = connection
            .query_row("SELECT COUNT(*) FROM library", [], |row| row.get(0))
            .unwrap();
        assert_eq!(libraries, 1);
    }
}
