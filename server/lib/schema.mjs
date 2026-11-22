// Actual SQLite DDL for the storage-lab core. The DB is authoritative for
// business rows; JSON snapshots are derived and may lag behind it.
export const SCHEMA_VERSION = 7;

const IMPORTS_JOB_STATUSES = [
    'created',
    'scanning',
    'preview_ready',
    'staging',
    'publishing_assets',
    'committing',
    'committed',
    'snapshot_pending',
    'snapshot_failed',
    'completed',
    'failed_precommit',
    'cancelled_precommit',
]
    .map((status) => `'${status}'`)
    .join(',');

export const DDL = `
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
    user_meta_json TEXT NOT NULL DEFAULT '{}',
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
    snapshot_json TEXT NOT NULL DEFAULT '{}',
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
    data_json TEXT NOT NULL DEFAULT '{}',
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
    status TEXT NOT NULL CHECK (status IN (${IMPORTS_JOB_STATUSES})),
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
    payload_json TEXT NOT NULL DEFAULT '{}',
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
    counts_json TEXT NOT NULL DEFAULT '{}',
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
`;

function userVersion(db) {
    try {
        const row = db.prepare('PRAGMA user_version').get();
        return Number(row?.user_version ?? 0);
    } catch {
        return 0;
    }
}

function entryFormat(entry) {
    const extension = String(entry.logical_path || '').split('.').pop().toLowerCase();
    if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'aif'].includes(extension)) return extension === 'aif' ? 'aiff' : extension;
    const mime = String(entry.mime || '').toLowerCase();
    if (mime.includes('mpeg')) return 'mp3';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('flac')) return 'flac';
    if (mime.includes('aac')) return 'aac';
    if (mime.includes('mp4')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('opus')) return 'opus';
    return 'unknown';
}

function migrateTracks(db) {
    const entries = db
        .prepare(
            `SELECT e.* FROM entry e
             LEFT JOIN track_rendition r ON r.entry_id = e.entry_id
             WHERE r.entry_id IS NULL`
        )
        .all();
    for (const entry of entries) {
        const trackKey = entry.track_key || entry.stable_entry_id || entry.entry_id;
        const trackId = `track-${entry.work_id}-${entry.entry_id}`;
        db.prepare(
            `INSERT OR IGNORE INTO track(track_id, work_id, track_key, title, sort_order, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(trackId, entry.work_id, trackKey, entry.display_title || entry.logical_path, Number(entry.sort_order || 0), new Date().toISOString());
        const track = db.prepare('SELECT track_id FROM track WHERE work_id = ? AND track_key = ?').get(entry.work_id, trackKey);
        db.prepare(
            `INSERT OR IGNORE INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(`rendition-${entry.entry_id}`, track.track_id, entry.entry_id, entryFormat(entry), entry.mime, Number(entry.sort_order || 0), new Date().toISOString());
        db.prepare('UPDATE entry SET track_key = ? WHERE entry_id = ?').run(trackKey, entry.entry_id);
    }
}

export function applySchema(db, { libraryId }) {
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) {
        throw new Error(`database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(DDL);
        // v2 roots already have the old work_document table; CREATE TABLE IF NOT
        // EXISTS cannot add columns, so migrate them in place without rebuilding.
        const documentColumns = new Set(
            db.prepare('PRAGMA table_info(work_document)').all().map((column) => column.name)
        );
        const additions = [
            ['source_url', "TEXT NOT NULL DEFAULT ''"],
            ['source_revision', "TEXT NOT NULL DEFAULT ''"],
            ['media_state', "TEXT NOT NULL DEFAULT 'not_requested'"],
            ['document_revision', 'INTEGER NOT NULL DEFAULT 0'],
            ['asset_manifest_json', "TEXT NOT NULL DEFAULT '[]'"],
            ['last_idempotency_key', 'TEXT'],
            ['last_plan_hash', 'TEXT'],
        ];
        for (const [name, definition] of additions) {
            if (!documentColumns.has(name)) db.exec(`ALTER TABLE work_document ADD COLUMN ${name} ${definition}`);
        }
        const workColumns = new Set(
            db.prepare('PRAGMA table_info(work)').all().map((column) => column.name)
        );
        if (!workColumns.has('user_meta_json')) db.exec("ALTER TABLE work ADD COLUMN user_meta_json TEXT NOT NULL DEFAULT '{}'");
        const entryColumns = new Set(
            db.prepare('PRAGMA table_info(entry)').all().map((column) => column.name)
        );
        if (!entryColumns.has('track_key')) db.exec('ALTER TABLE entry ADD COLUMN track_key TEXT');
        migrateTracks(db);
        const now = new Date().toISOString();
        db.prepare('INSERT OR IGNORE INTO schema_migration(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, now);
        db.prepare(
            'INSERT OR IGNORE INTO library(library_id, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?)'
        ).run(libraryId, SCHEMA_VERSION, now, now);
        db.prepare('UPDATE library SET schema_version = ?, updated_at = ? WHERE library_id = ?').run(SCHEMA_VERSION, now, libraryId);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            /* no active transaction */
        }
        throw error;
    }
}

export function enablePragmas(db) {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA temp_store = MEMORY');
}
