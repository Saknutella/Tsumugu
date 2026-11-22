// Storage-lab core: real SQLite, real files, exclusive root lock, committed
// import jobs, snapshot outbox, verify/rebuild/soft-delete primitives.
import { DatabaseSync } from 'node:sqlite';
import { copyFile, lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applySchema, enablePragmas, SCHEMA_VERSION } from './schema.mjs';
import {
    assertInsideExperiment,
    assertReadableSource,
    assertSafeDirectory,
    isInside,
    normalizeAllowedSourceRoots,
    resolveRoot,
    validateLogicalPath,
} from './paths.mjs';
import { atomicWriteJson, acquireLock, ensureDir, pathExists, readJson } from './fs.mjs';
import { copyToTempAndHash, hashFile, sha256Text, throwIfAborted } from './hash.mjs';
import { readSnapshotPair, snapshotPaths, writeSnapshotPair } from './snapshot.mjs';
import { listLogicalTracks as listTracksForWork, resolveTrackMedia as resolveTrackMediaForWork, playbackSequence as playbackSequenceForWork } from './tracks.mjs';
import { saveQueue as saveQueueState, getQueue as getQueueState, savePlaybackPosition as savePlaybackPositionState, getPlaybackPosition as getPlaybackPositionState } from './playback.mjs';

const ROOT_FILE = 'root.json';

const now = () => new Date().toISOString();
const id = () => randomUUID();

function jsonArray(value) {
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function trimString(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

function assertEntrySource(entry, index) {
    if (!entry || typeof entry !== 'object') throw new Error(`entry[${index}] must be an object`);
    const stableEntryId = trimString(entry.entryId);
    if (!stableEntryId) throw new Error(`entry[${index}] entryId is required`);
    const logicalPath = validateLogicalPath(entry.logicalPath);
    const kind = trimString(entry.kind, 'file');
    if (!entry.sourcePath) throw new Error(`entry[${index}] sourcePath is required`);
    return {
        stableEntryId,
        logicalPath,
        kind,
        mime: trimString(entry.mime, 'application/octet-stream'),
        sourcePath: entry.sourcePath,
        displayTitle: trimString(entry.title, logicalPath.split('/').pop()),
        trackKey: trimString(entry.trackKey),
        format: trimString(entry.format),
    };
}

function normalizeSource(source) {
    if (!source || typeof source !== 'object') throw new Error('sourceRecord must be an object');
    const provider = trimString(source.provider);
    const sourceCode = trimString(source.sourceCode);
    const title = trimString(source.title);
    if (!provider) throw new Error('source.provider is required');
    if (!sourceCode) throw new Error('source.sourceCode is required');
    if (!title) throw new Error('source.title is required');
    if (!Array.isArray(source.entries)) throw new Error('source.entries must be an array');
    const entries = source.entries.map(assertEntrySource);
    const stableIds = new Set();
    const logicalPaths = new Set();
    for (const entry of entries) {
        if (stableIds.has(entry.stableEntryId)) throw new Error(`duplicate entryId: ${entry.stableEntryId}`);
        if (logicalPaths.has(entry.logicalPath)) throw new Error(`duplicate logicalPath: ${entry.logicalPath}`);
        stableIds.add(entry.stableEntryId);
        logicalPaths.add(entry.logicalPath);
    }
    return {
        provider,
        sourceCode,
        title,
        circle: trimString(source.circle),
        cvs: jsonArray(source.cvs),
        familyId: source.familyId ? String(source.familyId) : null,
        edition: source.edition && typeof source.edition === 'object'
            ? { language: trimString(source.edition.language), role: trimString(source.edition.role) }
            : { language: '', role: '' },
        entries,
    };
}

function formatForEntry(entry) {
    const extension = String(entry.logicalPath || '').split('.').pop().toLowerCase();
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

function planHashFor(source) {
    return sha256Text(
        JSON.stringify({
            provider: source.provider,
            sourceCode: source.sourceCode,
            title: source.title,
            circle: source.circle,
            cvs: source.cvs,
            familyId: source.familyId,
            edition: source.edition,
            entries: source.entries.map((entry) => ({
                stableEntryId: entry.stableEntryId,
                logicalPath: entry.logicalPath,
                kind: entry.kind,
                mime: entry.mime,
                sourcePath: entry.sourcePath,
                trackKey: entry.trackKey,
                format: entry.format,
            })),
        })
    );
}

async function writeRootMetadata(root, libraryId, { create }) {
    const path = join(root, ROOT_FILE);
    const existing = await readJson(path, null);
    if (existing) {
        if (existing.libraryId !== libraryId && create) {
            throw new Error('root.json and library.sqlite libraryId mismatch');
        }
        return existing;
    }
    if (!create) throw new Error(`missing ${ROOT_FILE}; run with --suite all or openLibrary(root,{create:true})`);
    const metadata = {
        schemaVersion: SCHEMA_VERSION,
        libraryId,
        createdAt: now(),
        app: 'monochrome-storage-lab',
    };
    await atomicWriteJson(path, metadata);
    return metadata;
}

function rootAssetPath(root, relPath) {
    const normalized = String(relPath).replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
        throw new Error(`invalid asset relative path: ${relPath}`);
    }
    return join(root, 'data', ...normalized.split('/'));
}

function faultMatches(fault, point) {
    if (!fault) return false;
    const value = String(fault).toLowerCase();
    const target = String(point).toLowerCase();
    if (value === target) return true;
    if (target === 'f2' && ['f2-assets', 'assets-before-db', 'assets'].includes(value)) return true;
    if (target === 'f3' && ['f3-transaction', 'transaction-before-commit', 'transaction'].includes(value)) return true;
    if (target === 'f4' && ['f4-commit', 'commit-before-snapshot', 'commit'].includes(value)) return true;
    return false;
}

function triggerFault(options, point, context) {
    if (!options || !faultMatches(options.fault, point)) return;
    if (typeof options.onFault === 'function') {
        options.onFault(point, context || {});
        return;
    }
    if (options.faultExit === true) process.exit(99);
    const error = new Error(`injected fault ${point}`);
    error.code = 'EFAULT';
    throw error;
}

export class Library {
    constructor({ root, libraryId, db, lock, snapshotFault = null, allowOutsideRoot = false }) {
        this.root = root;
        this.libraryId = libraryId;
        this.db = db;
        this.lock = lock;
        this.closed = false;
        this.snapshotFault = snapshotFault;
        this.allowOutsideRoot = allowOutsideRoot === true;
        this.dataRoot = join(root, 'data');
        this.activeImports = new Map();
        this.snapshotQueues = new Map();
    }

    _assertOpen() {
        if (this.closed) throw new Error('library is closed');
    }

    _tx(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                /* no active transaction */
            }
            throw error;
        }
    }

    _getJobByKey(key) {
        return this.db
            .prepare('SELECT * FROM import_job WHERE library_id = ? AND idempotency_key = ?')
            .get(this.libraryId, key);
    }

    getImportJob(key) {
        return this._getJobByKey(key);
    }

    async _withSnapshotLock(workId, fn) {
        const key = String(workId);
        const previous = this.snapshotQueues.get(key) || Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const chained = previous.catch(() => {}).then(() => gate);
        this.snapshotQueues.set(key, chained);
        await previous.catch(() => {});
        try {
            return await fn();
        } finally {
            release();
            if (this.snapshotQueues.get(key) === chained) this.snapshotQueues.delete(key);
        }
    }

    async _publishAsset(entry, jobTempDir, options = {}) {
        await assertReadableSource(entry.sourcePath, { allowedSourceRoots: options.allowedSourceRoots });
        const hashed = await hashFile(entry.sourcePath);
        throwIfAborted(options.signal);
        // Source-only mode: the work root is the only physical copy. We still
        // keep the content hash in the asset row for identity/dedupe, but there
        // is no second CAS copy and rel_path stays empty.
        return {
            assetId: hashed.sha256,
            sha256: hashed.sha256,
            bytes: hashed.bytes,
            mime: entry.mime,
            relPath: `source/${hashed.sha256}`, // virtual source-backed asset; no CAS copy
        };
    }

    async importWork(sourceRecord, idempotencyKey, options = {}) {
        this._assertOpen();
        const key = trimString(idempotencyKey);
        if (!key) throw new Error('idempotencyKey is required');
        const source = normalizeSource(sourceRecord);
        const planHash = planHashFor(source);

        // P1-2: concurrent calls with the same key on this Library share one
        // operation. Never let a second caller mistake the first caller's live
        // staging directory for a crash remnant.
        const active = this.activeImports.get(key);
        if (active) {
            if (active.planHash !== planHash) {
                const error = new Error('idempotency key reused with a different import plan');
                error.code = 'EIDEMPOTENCYCONFLICT';
                throw error;
            }
            return active.promise;
        }
        const activeEntry = { planHash, promise: null };
        const operation = this._importWorkOperation(source, key, options);
        activeEntry.promise = operation;
        this.activeImports.set(key, activeEntry);
        try {
            return await operation;
        } finally {
            if (this.activeImports.get(key) === activeEntry) this.activeImports.delete(key);
        }
    }

    async _importWorkOperation(source, key, options = {}) {
        // Validate authorization before creating a job row, even when the source
        // happens to be inside the experiment root.
        await normalizeAllowedSourceRoots(options.allowedSourceRoots);
        const planHash = planHashFor(source);
        const existing = this._getJobByKey(key);
        if (existing) {
            const samePlan = existing.plan_hash === planHash;
            if (!samePlan && (existing.committed_work_id || existing.status !== 'cancelled_precommit')) {
                const error = new Error('idempotency key reused with a different import plan');
                error.code = 'EIDEMPOTENCYCONFLICT';
                throw error;
            }
            if (existing.committed_work_id) {
                const work = this.getWork(existing.committed_work_id);
                return { ...work, jobId: existing.job_id, idempotent: true };
            }
            if (!existing.committed_work_id) {
                // Crash recovery: the root lock guarantees no other process is
                // actively using this library. An uncommitted job (created /
                // staging / committing after a kill) may be retried. Remove only
                // this job's own temp directory, never a blind tmp prefix.
                const staleTemp = join(this.dataRoot, 'tmp', existing.job_id);
                await rm(staleTemp, { recursive: true, force: true }).catch(() => {});
                this._tx(() => {
                    this.db.prepare('DELETE FROM import_job WHERE job_id = ? AND committed_work_id IS NULL').run(existing.job_id);
                });
            }
        }

        const jobId = id();
        const jobTempDir = join(this.dataRoot, 'tmp', jobId);
        await ensureDir(jobTempDir);
        this._tx(() => {
            const timestamp = now();
            this.db
                .prepare(
                    `INSERT INTO import_job(
                        job_id, library_id, idempotency_key, plan_hash, status,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'created', ?, ?)`
                )
                .run(jobId, this.libraryId, key, planHash, timestamp, timestamp);
        });

        try {
            const assetsBySha = new Map();
            for (const [entryIndex, entry] of source.entries.entries()) {
                throwIfAborted(options.signal);
                const asset = await this._publishAsset(entry, jobTempDir, {
                    ...options,
                    jobId,
                    entryIndex,
                    entryTotal: source.entries.length,
                });
                if (!assetsBySha.has(asset.sha256)) assetsBySha.set(asset.sha256, asset);
                entry.asset = asset;
                if (typeof options.onProgress === 'function') {
                    options.onProgress({
                        phase: 'asset',
                        jobId,
                        entryId: entry.stableEntryId,
                        entryIndex,
                        index: entryIndex,
                        entryTotal: source.entries.length,
                        total: source.entries.length,
                        logicalPath: entry.logicalPath,
                        assetId: asset.assetId,
                        sha256: asset.sha256,
                        bytes: asset.bytes,
                        assetBytes: asset.bytes,
                        assetTotalBytes: asset.bytes,
                        mime: asset.mime,
                        asset,
                    });
                }
                throwIfAborted(options.signal);
            }
            // Cancellation is a pre-commit decision: after the DB commit starts the
            // import is durable and a late abort must not be reported as cancelled.
            throwIfAborted(options.signal);
            triggerFault(options, 'F2', {
                jobId,
                key,
                libraryId: this.libraryId,
                assets: [...assetsBySha.values()].map((asset) => asset.sha256),
            });

            const result = this._tx(() => {
                const timestamp = now();
                const familyId = source.familyId || id();
                this.db.prepare('INSERT OR IGNORE INTO family(family_id, created_at) VALUES (?, ?)').run(familyId, timestamp);
                const workId = id();
                this.db
                    .prepare(
                        `INSERT INTO work(
                            work_id, family_id, title, circle, cv_json, language, role,
                            revision, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
                    )
                    .run(
                        workId,
                        familyId,
                        source.title,
                        source.circle,
                        JSON.stringify(source.cvs),
                        source.edition.language,
                        source.edition.role,
                        timestamp,
                        timestamp
                    );
                this.db
                    .prepare(
                        `INSERT INTO source_ref(
                            source_ref_id, work_id, provider, source_code, source_url,
                            snapshot_json, fetched_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
                    )
                    .run(
                        id(),
                        workId,
                        source.provider,
                        source.sourceCode,
                        '',
                        JSON.stringify({ sourceRecord: source }),
                        timestamp
                    );
                this.db
                    .prepare('INSERT INTO user_state(work_id, notes, favorite, playback_position, updated_at) VALUES (?, ?, 0, NULL, ?)')
                    .run(workId, '', timestamp);

                const tracksByKey = new Map();
                for (const [sortOrder, entry] of source.entries.entries()) {
                    const entryId = id();
                    const trackKey = entry.trackKey || entry.stableEntryId;
                    let track = tracksByKey.get(trackKey);
                    if (!track) {
                        track = { trackId: id(), trackKey, sortOrder };
                        this.db
                            .prepare(
                                `INSERT INTO track(track_id, work_id, track_key, title, sort_order, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?)`
                            )
                            .run(track.trackId, workId, trackKey, entry.displayTitle, sortOrder, timestamp);
                        tracksByKey.set(trackKey, track);
                    }
                    this.db
                        .prepare(
                            `INSERT INTO entry(
                                entry_id, work_id, stable_entry_id, logical_path, kind, mime,
                                display_title, original_path, sort_order, track_key
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(
                            entryId,
                            workId,
                            entry.stableEntryId,
                            entry.logicalPath,
                            entry.kind,
                            entry.mime,
                            entry.displayTitle,
                            entry.sourcePath,
                            sortOrder,
                            entry.trackKey || entry.stableEntryId
                        );
                    const asset = entry.asset;
                    this.db
                        .prepare(
                            `INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                             VALUES (?, ?, ?, ?, ?, ?)`
                        )
                        .run(asset.assetId, asset.sha256, asset.bytes, asset.mime, asset.relPath, timestamp);
                    this.db
                        .prepare(
                            `INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                             VALUES (?, ?, ?, ?, 'primary')`
                        )
                        .run(id(), workId, entryId, asset.assetId);
                    this.db
                        .prepare(
                            `INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(
                            id(),
                            track.trackId,
                            entryId,
                            entry.format || formatForEntry(entry),
                            entry.mime,
                            sortOrder,
                            timestamp
                        );
                }

                this.db
                    .prepare(
                        `INSERT INTO snapshot_outbox(
                            library_id, work_id, target_revision, published_revision,
                            status, attempt_count, updated_at
                        ) VALUES (?, ?, 1, 0, 'pending', 0, ?)`
                    )
                    .run(this.libraryId, workId, timestamp);
                this.db
                    .prepare(
                        `UPDATE import_job SET
                            status = 'committed',
                            committed_work_id = ?,
                            committed_at = ?,
                            committed_revision = 1,
                            snapshot_status = 'pending',
                            updated_at = ?
                         WHERE job_id = ? AND committed_work_id IS NULL`
                    )
                    .run(workId, timestamp, timestamp, jobId);
                triggerFault(options, 'F3', { jobId, key, workId, libraryId: this.libraryId });
                return { workId, jobId };
            });
            triggerFault(options, 'F4', {
                jobId,
                key,
                workId: result.workId,
                libraryId: this.libraryId,
                committedRevision: 1,
            });

            await rm(jobTempDir, { recursive: true, force: true }).catch(() => {});
            const work = this.getWork(result.workId);
            return { ...work, jobId: result.jobId, idempotent: false };
        } catch (error) {
            const cancelled = error?.cancelled === true || error?.code === 'EABORTED';
            this._tx(() => {
                const timestamp = now();
                this.db
                    .prepare(
                        `UPDATE import_job SET status = ?, last_error = ?, updated_at = ?
                         WHERE job_id = ? AND committed_work_id IS NULL`
                    )
                    .run(
                        cancelled ? 'cancelled_precommit' : 'failed_precommit',
                        String(error?.message || error),
                        timestamp,
                        jobId
                    );
            });
            await rm(jobTempDir, { recursive: true, force: true }).catch(() => {});
            if (cancelled) {
                const abort = new Error('import cancelled before commit');
                abort.name = 'AbortError';
                abort.code = 'EABORTED';
                abort.cancelled = true;
                abort.status = 'cancelled_precommit';
                abort.jobId = jobId;
                abort.cause = error;
                throw abort;
            }
            throw error;
        }
    }

    getWork(workId, { includeDeleted = false } = {}) {
        this._assertOpen();
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work) return null;
        if (work.deleted_at && !includeDeleted) return null;
        const sourceRefs = this.db
            .prepare('SELECT * FROM source_ref WHERE work_id = ? ORDER BY provider, source_code')
            .all(work.work_id)
            .map((row) => ({
                sourceRefId: row.source_ref_id,
                provider: row.provider,
                sourceCode: row.source_code,
                sourceUrl: row.source_url,
                fetchedAt: row.fetched_at,
                snapshot: (() => {
                    try {
                        return JSON.parse(row.snapshot_json);
                    } catch {
                        return null;
                    }
                })(),
            }));
        const entries = this.db
            .prepare(
                `SELECT e.*,
                    (SELECT t.track_id FROM track t WHERE t.work_id = e.work_id AND t.track_key = COALESCE(e.track_key, e.stable_entry_id)) AS track_id,
                    (SELECT r.format FROM track_rendition r WHERE r.entry_id = e.entry_id LIMIT 1) AS rendition_format
                 FROM entry e WHERE e.work_id = ? ORDER BY e.sort_order, e.logical_path`
            )
            .all(work.work_id)
            .map((row) => {
                const assets = this.db
                    .prepare(
                        `SELECT a.*, r.role FROM asset_ref r
                         JOIN asset a ON a.asset_id = r.asset_id
                         WHERE r.entry_id = ? ORDER BY r.role, a.asset_id`
                    )
                    .all(row.entry_id);
                return {
                    entryId: row.stable_entry_id,
                    internalId: row.entry_id,
                    logicalPath: row.logical_path,
                    kind: row.kind,
                    mime: row.mime,
                    title: row.display_title,
                    originalPath: row.original_path,
                    sortOrder: row.sort_order,
                    trackKey: row.track_key || null,
                    trackId: row.track_id || null,
                    format: row.rendition_format || null,
                    assets: assets.map((asset) => ({
                        assetId: asset.asset_id,
                        sha256: asset.sha256,
                        bytes: asset.bytes,
                        mime: asset.mime,
                        relPath: asset.rel_path,
                        role: asset.role,
                    })),
                };
            });
        const user = this.db.prepare('SELECT * FROM user_state WHERE work_id = ?').get(work.work_id);
        return {
            id: work.work_id,
            workId: work.work_id,
            familyId: work.family_id,
            title: work.title,
            userTitle: work.user_title,
            userMeta: (() => {
                try { return JSON.parse(work.user_meta_json || '{}'); } catch { return {}; }
            })(),
            circle: work.circle,
            cvs: (() => {
                try {
                    return JSON.parse(work.cv_json);
                } catch {
                    return [];
                }
            })(),
            language: work.language,
            role: work.role,
            revision: work.revision,
            deletedAt: work.deleted_at,
            createdAt: work.created_at,
            updatedAt: work.updated_at,
            entries,
            sourceRefs,
            user: user
                ? {
                      notes: user.notes,
                      favorite: Boolean(user.favorite),
                      playbackPosition: user.playback_position,
                  }
                : { notes: '', favorite: false, playbackPosition: null },
        };
    }

    /**
     * User-owned overrides for manually imported works. Source fields stay in
     * work/source_ref; tags/rating/price/edition metadata live in a JSON column so
     * local folders without an RJ still have editable metadata.
     */
    updateWorkMetadata(workId, patch = {}) {
        this._assertOpen();
        const current = this.db.prepare('SELECT * FROM work WHERE work_id = ? AND deleted_at IS NULL').get(String(workId));
        if (!current) throw new Error('work not found');
        const title = patch.title == null ? current.user_title : String(patch.title).trim();
        const circle = patch.circle == null ? current.circle : String(patch.circle).trim();
        let cvs = patch.cvs === undefined
            ? (() => { try { return JSON.parse(current.cv_json || '[]'); } catch { return []; } })()
            : patch.cvs;
        cvs = Array.isArray(cvs) ? [...new Set(cvs.map((value) => String(value).trim()).filter(Boolean))] : [];
        let meta = {};
        try { meta = JSON.parse(current.user_meta_json || '{}'); } catch { meta = {}; }
        // `translators`/`trueCircle` keep a translated edition's original circle
        // apart from its translator (asmr.one stores the translator in `circle`).
        // The Rust host whitelist already has both keys; this one was missing
        // `translators`, so the value was written by the caller and silently
        // dropped here (same class of bug as D18).
        for (const key of ['tags', 'rating', 'ratingCount', 'price', 'currency', 'release', 'ageCategory', 'nsfw', 'sourceCode', 'editionLang', 'editionLabel', 'originalCode', 'manual', 'editionCodes', 'durations', 'sourceUrl', 'pageUrl', 'partial', 'manifest', 'artists', 'trueCircle', 'translators']) {
            if (patch[key] !== undefined) meta[key] = patch[key];
        }
        if (Array.isArray(meta.tags)) meta.tags = [...new Set(meta.tags.map((value) => String(value).trim()).filter(Boolean))];
        const timestamp = new Date().toISOString();
        this.db.prepare(
            'UPDATE work SET user_title = ?, circle = ?, cv_json = ?, user_meta_json = ?, revision = revision + 1, updated_at = ? WHERE work_id = ?'
        ).run(title || null, circle, JSON.stringify(cvs), JSON.stringify(meta), timestamp, current.work_id);
        return this.getWork(current.work_id);
    }

    listEntries(workId) {
        const work = this.getWork(workId, { includeDeleted: true });
        return work ? work.entries : null;
    }

    /** C79-05: save work document text + local document assets. */
    async saveWorkDocument(workId, payload = {}, options = {}) {
        const { saveWorkDocument } = await import('./document.mjs');
        return saveWorkDocument(this, workId, payload, options);
    }

    /** C79-05: read document row + ready refs/missing manifest. */
    async getWorkDocument(workId) {
        const { getWorkDocument } = await import('./document.mjs');
        return getWorkDocument(this, workId);
    }

    /** E09: playback queue (business state, stable IDs only). */
    saveQueue(items, options = {}) {
        return saveQueueState(this, items, options);
    }

    getQueue() {
        return getQueueState(this);
    }

    /** E09: per-work playback position, rounded to 1 ms. */
    savePlaybackPosition(workId, payload = {}, options = {}) {
        return savePlaybackPositionState(this, workId, payload, options);
    }

    getPlaybackPosition(workId) {
        return getPlaybackPositionState(this, workId);
    }

    /** E04: logical tracks + format renditions (synchronous SQL reads). */
    listLogicalTracks(workId) {
        return listTracksForWork(this, workId);
    }

    resolveTrackMedia(workId, options = {}) {
        return resolveTrackMediaForWork(this, workId, options);
    }

    playbackSequence(workId, options = {}) {
        return playbackSequenceForWork(this, workId, options);
    }

    /**
     * E03: refresh only source-owned fields. User overrides, entries, asset refs
     * and CAS bytes are deliberately left untouched.
     */
    /**
     * Merge a rescan of an existing work into the same work row.
     *
     * The source file tree is the manifest input: unchanged paths/assets are
     * skipped, new paths are appended, changed paths get a new asset_ref and
     * rendition, and entries missing from the new scan are retained (source may
     * be temporarily unavailable). A revision is bumped only when bytes or
     * metadata actually changed.
     */
    async mergeWorkSource(workId, sourceRecord, options = {}) {
        this._assertOpen();
        const source = normalizeSource(sourceRecord);
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work || work.deleted_at) throw new Error('work not found');
        const jobId = id();
        const jobTempDir = join(this.dataRoot, 'tmp', jobId);
        await ensureDir(jobTempDir);
        const published = new Map();
        try {
            for (const [entryIndex, entry] of source.entries.entries()) {
                throwIfAborted(options.signal);
                const asset = await this._publishAsset(entry, jobTempDir, {
                    ...options,
                    jobId,
                    entryIndex,
                    entryTotal: source.entries.length,
                });
                published.set(entry.stableEntryId, { entry, asset });
                if (typeof options.onProgress === 'function') {
                    options.onProgress({
                        phase: 'asset',
                        jobId,
                        workId: work.work_id,
                        entryId: entry.stableEntryId,
                        entryIndex,
                        entryTotal: source.entries.length,
                        logicalPath: entry.logicalPath,
                        sha256: asset.sha256,
                        bytes: asset.bytes,
                    });
                }
            }
            throwIfAborted(options.signal);

            const existing = this.db
                .prepare(
                    `SELECT e.*, a.sha256 AS asset_sha256, a.bytes AS asset_bytes, a.mime AS asset_mime,
                            a.asset_id AS asset_id
                     FROM entry e
                     LEFT JOIN asset_ref r ON r.entry_id = e.entry_id AND r.role = 'primary'
                     LEFT JOIN asset a ON a.asset_id = r.asset_id
                     WHERE e.work_id = ?
                     ORDER BY e.sort_order, e.entry_id`
                )
                .all(work.work_id);
            const existingByPath = new Map(existing.map((row) => [row.logical_path, row]));
            let added = 0;
            let updated = 0;
            let skipped = 0;
            const changedPaths = [];
            const newEntries = [];
            for (const [index, entry] of source.entries.entries()) {
                const previous = existingByPath.get(entry.logicalPath);
                const publishedEntry = published.get(entry.stableEntryId);
                if (!previous) {
                    newEntries.push({ entry, asset: publishedEntry.asset, sortOrder: index });
                    continue;
                }
                if (previous.asset_sha256 === publishedEntry.asset.sha256) {
                    skipped += 1;
                    continue;
                }
                changedPaths.push({ previous, entry, asset: publishedEntry.asset, sortOrder: index });
            }
            const missing = existing.filter((row) => !source.entries.some((entry) => entry.logicalPath === row.logical_path)).length;
            const title = trimString(source.title, work.title);
            const circle = trimString(source.circle, work.circle);
            const cvsJson = JSON.stringify(jsonArray(source.cvs));
            const metadataChanged = title !== work.title || circle !== work.circle || cvsJson !== work.cv_json;
            const changed = newEntries.length > 0 || changedPaths.length > 0 || metadataChanged;
            const revision = changed ? Number(work.revision) + 1 : Number(work.revision);
            const timestamp = now();
            if (changed) {
                this._tx(() => {
                    this.db
                        .prepare('UPDATE work SET title = ?, circle = ?, cv_json = ?, revision = ?, updated_at = ? WHERE work_id = ?')
                        .run(title, circle, cvsJson, revision, timestamp, work.work_id);
                    for (const { entry, asset, sortOrder } of newEntries) {
                        const trackKey = entry.trackKey || entry.stableEntryId;
                        let track = this.db
                            .prepare('SELECT track_id FROM track WHERE work_id = ? AND track_key = ?')
                            .get(work.work_id, trackKey);
                        if (!track) {
                            track = { track_id: id() };
                            this.db
                                .prepare(
                                    `INSERT INTO track(track_id, work_id, track_key, title, sort_order, created_at)
                                     VALUES (?, ?, ?, ?, ?, ?)`
                                )
                                .run(track.track_id, work.work_id, trackKey, entry.displayTitle, sortOrder, timestamp);
                        }
                        const entryId = id();
                        this.db
                            .prepare(
                                `INSERT INTO entry(
                                    entry_id, work_id, stable_entry_id, logical_path, kind, mime,
                                    display_title, original_path, sort_order, track_key
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            )
                            .run(
                                entryId,
                                work.work_id,
                                entry.stableEntryId,
                                entry.logicalPath,
                                entry.kind,
                                entry.mime,
                                entry.displayTitle,
                                entry.sourcePath,
                                sortOrder,
                                trackKey
                            );
                        this.db
                            .prepare(
                                `INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?)`
                            )
                            .run(asset.assetId, asset.sha256, asset.bytes, asset.mime, asset.relPath, timestamp);
                        this.db
                            .prepare("INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role) VALUES (?, ?, ?, ?, 'primary')")
                            .run(id(), work.work_id, entryId, asset.assetId);
                        this.db
                            .prepare(
                                `INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`
                            )
                            .run(id(), track.track_id, entryId, entry.format || formatForEntry(entry), entry.mime, sortOrder, timestamp);
                    }
                    for (const { previous, entry, asset, sortOrder } of changedPaths) {
                        this.db.prepare('UPDATE entry SET kind = ?, mime = ?, display_title = ?, original_path = ?, sort_order = ? WHERE entry_id = ?')
                            .run(entry.kind, entry.mime, entry.displayTitle, entry.sourcePath, sortOrder, previous.entry_id);
                        this.db.prepare('DELETE FROM asset_ref WHERE entry_id = ?').run(previous.entry_id);
                        this.db.prepare('DELETE FROM track_rendition WHERE entry_id = ?').run(previous.entry_id);
                        this.db
                            .prepare("INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                            .run(asset.assetId, asset.sha256, asset.bytes, asset.mime, asset.relPath, timestamp);
                        this.db
                            .prepare("INSERT INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role) VALUES (?, ?, ?, ?, 'primary')")
                            .run(id(), work.work_id, previous.entry_id, asset.assetId);
                        this.db
                            .prepare(
                                `INSERT INTO track_rendition(rendition_id, track_id, entry_id, format, mime, priority, created_at)
                                 SELECT ?, track_id, ?, ?, ?, ?, ? FROM track WHERE work_id = ? AND track_key = ?`
                            )
                            .run(id(), previous.entry_id, entry.format || formatForEntry(entry), entry.mime, sortOrder, timestamp, work.work_id, previous.track_key);
                        this.db.prepare('UPDATE track SET title = ?, sort_order = ? WHERE work_id = ? AND track_key = ?')
                            .run(entry.displayTitle, sortOrder, work.work_id, previous.track_key);
                    }
                    let sourceRef = this.db
                        .prepare('SELECT source_ref_id FROM source_ref WHERE work_id = ? AND provider = ? LIMIT 1')
                        .get(work.work_id, source.provider);
                    if (!sourceRef) {
                        // Adopt the existing local identity when a rescan learns the
                        // real RJ code; otherwise the same folder would grow a second
                        // source_ref and look like a duplicate in the UI.
                        sourceRef = this.db
                            .prepare('SELECT source_ref_id FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1')
                            .get(work.work_id);
                    }
                    const snapshot = JSON.stringify({ sourceRecord: source, refreshedAt: timestamp });
                    if (sourceRef) {
                        this.db
                            .prepare('UPDATE source_ref SET provider = ?, source_code = ?, snapshot_json = ? WHERE source_ref_id = ?')
                            .run(source.provider, source.sourceCode, snapshot, sourceRef.source_ref_id);
                    } else {
                        this.db
                            .prepare('INSERT INTO source_ref(source_ref_id, work_id, provider, source_code, source_url, snapshot_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                            .run(id(), work.work_id, source.provider, source.sourceCode, '', snapshot, timestamp);
                    }
                    this.db
                        .prepare("INSERT INTO snapshot_outbox(library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at) VALUES (?, ?, ?, 0, 'pending', 0, ?) ON CONFLICT(library_id, work_id) DO UPDATE SET target_revision = MAX(target_revision, excluded.target_revision), status = 'pending', last_error = NULL, updated_at = excluded.updated_at")
                        .run(this.libraryId, work.work_id, revision, timestamp);
                });
                added = newEntries.length;
                updated = changedPaths.length;
            }
            return {
                work: this.getWork(work.work_id),
                jobId,
                changed,
                revision,
                added,
                updated,
                skipped,
                missing,
            };
        } finally {
            await rm(jobTempDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async refreshWorkSource(workId, sourceRecord, options = {}) {
        this._assertOpen();
        if (!sourceRecord || typeof sourceRecord !== 'object') throw new Error('sourceRecord is required');
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work) throw new Error('work not found');
        if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== Number(work.revision)) {
            const error = new Error(`revision conflict: expected ${options.expectedRevision}, current ${work.revision}`);
            error.code = 'EREVISIONCONFLICT';
            throw error;
        }
        const provider = trimString(sourceRecord.provider, 'local');
        const sourceCode = trimString(sourceRecord.sourceCode || sourceRecord.code);
        if (!sourceCode) throw new Error('sourceRecord.sourceCode is required for refresh');
        const title = trimString(sourceRecord.title, work.title);
        const circle = trimString(sourceRecord.circle, work.circle);
        const cvsJson = sourceRecord.cvs === undefined ? work.cv_json : JSON.stringify(jsonArray(sourceRecord.cvs));
        const timestamp = now();
        const revision = Number(work.revision) + 1;
        this._tx(() => {
            const existingRef = this.db
                .prepare('SELECT * FROM source_ref WHERE work_id = ? AND provider = ? ORDER BY source_ref_id LIMIT 1')
                .get(work.work_id, provider) || null;
            const previousSourceCode = existingRef?.source_code || '';
            const previousSourceUrl = existingRef?.source_url || '';
            const sourceUrl = trimString(sourceRecord.sourceUrl || sourceRecord.url || previousSourceUrl);
            this.db
                .prepare('UPDATE work SET title = ?, circle = ?, cv_json = ?, revision = ?, updated_at = ? WHERE work_id = ?')
                .run(title, circle, cvsJson, revision, timestamp, work.work_id);
            const snapshot = JSON.stringify({
                sourceRecord,
                refreshedAt: timestamp,
                previousSourceCode,
                previousSourceUrl,
            });
            if (existingRef) {
                this.db
                    .prepare("UPDATE source_ref SET source_code = ?, source_url = ?, snapshot_json = ?, fetched_at = ? WHERE source_ref_id = ?")
                    .run(sourceCode, sourceUrl, snapshot, timestamp, existingRef.source_ref_id);
            } else {
                this.db
                    .prepare("INSERT INTO source_ref(source_ref_id, work_id, provider, source_code, source_url, snapshot_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                    .run(id(), work.work_id, provider, sourceCode, sourceUrl, snapshot, timestamp);
            }
            this.db
                .prepare("INSERT INTO snapshot_outbox(library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at) VALUES (?, ?, ?, 0, 'pending', 0, ?) ON CONFLICT(library_id, work_id) DO UPDATE SET target_revision = MAX(target_revision, excluded.target_revision), status = 'pending', last_error = NULL, updated_at = excluded.updated_at")
                .run(this.libraryId, work.work_id, revision, timestamp);
        });
        return this.getWork(work.work_id);
    }

    /**
     * E05: attach a work to a stable family and edition language/role. The workId,
     * entries, asset_refs and user_state do not move.
     */
    async linkFamily(workId, familyId, options = {}) {
        this._assertOpen();
        if (!familyId) throw new Error('familyId is required');
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work) throw new Error('work not found');
        if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== Number(work.revision)) {
            const error = new Error(`revision conflict: expected ${options.expectedRevision}, current ${work.revision}`);
            error.code = 'EREVISIONCONFLICT';
            throw error;
        }
        const revision = Number(work.revision) + 1;
        const timestamp = now();
        this._tx(() => {
            this.db.prepare('INSERT OR IGNORE INTO family(family_id, created_at) VALUES (?, ?)').run(String(familyId), timestamp);
            this.db
                .prepare('UPDATE work SET family_id = ?, language = ?, role = ?, revision = ?, updated_at = ? WHERE work_id = ?')
                .run(
                    String(familyId),
                    options.language !== undefined ? trimString(options.language) : work.language,
                    options.role !== undefined ? trimString(options.role) : work.role,
                    revision,
                    timestamp,
                    work.work_id
                );
            this.db
                .prepare("INSERT INTO snapshot_outbox(library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at) VALUES (?, ?, ?, 0, 'pending', 0, ?) ON CONFLICT(library_id, work_id) DO UPDATE SET target_revision = MAX(target_revision, excluded.target_revision), status = 'pending', last_error = NULL, updated_at = excluded.updated_at")
                .run(this.libraryId, work.work_id, revision, timestamp);
        });
        return this.getWork(work.work_id);
    }

    updateUserFields(workId, patch, expectedRevision) {
        this._assertOpen();
        if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');
        const allowed = new Set(['userTitle', 'title', 'userNotes', 'notes', 'favorite', 'playbackPosition']);
        for (const key of Object.keys(patch)) {
            if (!allowed.has(key)) throw new Error(`unsupported user field: ${key}`);
        }
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work) throw new Error('work not found');
        if (Number(expectedRevision) !== Number(work.revision)) {
            const error = new Error(`revision conflict: expected ${expectedRevision}, current ${work.revision}`);
            error.code = 'EREVISIONCONFLICT';
            throw error;
        }
        const timestamp = now();
        const title = patch.userTitle ?? patch.title;
        this._tx(() => {
            this.db
                .prepare(
                    `UPDATE work SET
                        user_title = COALESCE(?, user_title),
                        revision = revision + 1,
                        updated_at = ?
                     WHERE work_id = ?`
                )
                .run(title === undefined ? null : String(title), timestamp, work.work_id);
            const currentUser = this.db.prepare('SELECT * FROM user_state WHERE work_id = ?').get(work.work_id);
            if (!currentUser) {
                this.db
                    .prepare('INSERT INTO user_state(work_id, notes, favorite, playback_position, updated_at) VALUES (?, ?, ?, ?, ?)')
                    .run(
                        work.work_id,
                        patch.userNotes ?? patch.notes ?? '',
                        patch.favorite ? 1 : 0,
                        patch.playbackPosition ?? null,
                        timestamp
                    );
            } else {
                this.db
                    .prepare(
                        `UPDATE user_state SET
                            notes = COALESCE(?, notes),
                            favorite = COALESCE(?, favorite),
                            playback_position = COALESCE(?, playback_position),
                            updated_at = ?
                         WHERE work_id = ?`
                    )
                    .run(
                        patch.userNotes ?? patch.notes ?? null,
                        patch.favorite === undefined ? null : patch.favorite ? 1 : 0,
                        patch.playbackPosition === undefined ? null : Number(patch.playbackPosition),
                        timestamp,
                        work.work_id
                    );
            }
            this.db
                .prepare(
                    `INSERT INTO snapshot_outbox(
                        library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at
                    ) VALUES (?, ?, ?, 0, 'pending', 0, ?)
                    ON CONFLICT(library_id, work_id) DO UPDATE SET
                        target_revision = MAX(target_revision, excluded.target_revision),
                        status = 'pending',
                        last_error = NULL,
                        updated_at = excluded.updated_at`
                )
                .run(this.libraryId, work.work_id, work.revision + 1, timestamp);
        });
        return this.getWork(work.work_id);
    }

    _setDeleted(workId, deleted) {
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work) throw new Error('work not found');
        const timestamp = now();
        this._tx(() => {
            this.db
                .prepare('UPDATE work SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE work_id = ?')
                .run(deleted ? timestamp : null, timestamp, work.work_id);
            this.db
                .prepare(
                    `INSERT INTO snapshot_outbox(
                        library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at
                    ) VALUES (?, ?, ?, 0, 'pending', 0, ?)
                    ON CONFLICT(library_id, work_id) DO UPDATE SET
                        target_revision = MAX(target_revision, excluded.target_revision),
                        status = 'pending',
                        last_error = NULL,
                        updated_at = excluded.updated_at`
                )
                .run(this.libraryId, work.work_id, work.revision + 1, timestamp);
        });
        return this.getWork(work.work_id, { includeDeleted: true });
    }

    softDeleteWork(workId) {
        return this._setDeleted(workId, true);
    }

    restoreWork(workId) {
        return this._setDeleted(workId, false);
    }

    _snapshotModel(workId) {
        const work = this.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
        if (!work) throw new Error('work not found');
        const entries = this.db
            .prepare('SELECT * FROM entry WHERE work_id = ? ORDER BY sort_order, logical_path')
            .all(work.work_id)
            .map((entry) => ({
                entryId: entry.stable_entry_id,
                logicalPath: entry.logical_path,
                kind: entry.kind,
                mime: entry.mime,
                title: entry.display_title,
                sortOrder: entry.sort_order,
            }));
        const assets = this.db
            .prepare(
                `SELECT DISTINCT a.sha256, a.bytes, a.mime, a.rel_path
                 FROM asset a JOIN asset_ref r ON r.asset_id = a.asset_id
                 WHERE r.work_id = ? ORDER BY a.sha256`
            )
            .all(work.work_id)
            .map((asset) => ({ sha256: asset.sha256, bytes: asset.bytes, mime: asset.mime, relPath: asset.rel_path }));
        const sourceRefs = this.db
            .prepare('SELECT provider, source_code, source_url, snapshot_json FROM source_ref WHERE work_id = ?')
            .all(work.work_id)
            .map((row) => ({
                provider: row.provider,
                sourceCode: row.source_code,
                sourceUrl: row.source_url,
                snapshot: (() => {
                    try {
                        return JSON.parse(row.snapshot_json);
                    } catch {
                        return null;
                    }
                })(),
            }));
        const user = this.db.prepare('SELECT * FROM user_state WHERE work_id = ?').get(work.work_id);
        return {
            work: {
                workId: work.work_id,
                familyId: work.family_id,
                title: work.title,
                userTitle: work.user_title,
                circle: work.circle,
                cvs: (() => {
                    try {
                        return JSON.parse(work.cv_json);
                    } catch {
                        return [];
                    }
                })(),
                language: work.language,
                role: work.role,
                revision: work.revision,
                deletedAt: work.deleted_at,
                createdAt: work.created_at,
                updatedAt: work.updated_at,
            },
            entries,
            assets,
            sourceRefs,
            userState: user
                ? { notes: user.notes, favorite: Boolean(user.favorite), playbackPosition: user.playback_position }
                : null,
        };
    }

    /**
     * Test-only hook for C79-03: publish a specific snapshot revision even when
     * the outbox target has moved on. Older-than-published revisions are rejected
     * before any file is written, matching the worker rule.
     */
    async publishSnapshotAtRevision(workId, revision, { fault = null } = {}) {
        this._assertOpen();
        const workKey = String(workId);
        const requested = Number(revision);
        return this._withSnapshotLock(workKey, async () => {
            // Re-read after acquiring the per-work lock. A caller that started at
            // revision N must never overwrite a ready snapshot for N+1.
            const row = this.db
                .prepare('SELECT * FROM snapshot_outbox WHERE library_id = ? AND work_id = ?')
                .get(this.libraryId, workKey);
            if (!row) return { workId, targetRevision: requested, ok: false, skipped: 'missing-outbox' };
            if (requested <= Number(row.published_revision)) {
                return { workId, targetRevision: requested, ok: true, skipped: 'stale-revision', published: row.published_revision };
            }
            if (requested < Number(row.target_revision)) {
                return { workId, targetRevision: requested, ok: true, skipped: 'newer-target-pending', target: row.target_revision };
            }
            const model = this._snapshotModel(workKey);
            let written;
            try {
                written = await writeSnapshotPair({
                    dataRoot: this.dataRoot,
                    libraryId: this.libraryId,
                    workId: workKey,
                    targetRevision: requested,
                    model,
                    fault,
                });
            } catch (error) {
                this._markSnapshotFailure(workKey, requested, error);
                throw error;
            }
            const marked = this._markSnapshotPublished(workKey, requested, null);
            if (marked.skipped === 'newer-target-pending') {
                return { ...marked, files: written, skipped: 'newer-target-pending' };
            }
            return { ...marked, files: written };
        });
    }

    _markSnapshotFailure(workId, targetRevision, error) {
        const timestamp = now();
        this._tx(() => {
            this.db
                .prepare(
                    `UPDATE snapshot_outbox SET
                        status = 'retry_wait',
                        attempt_count = attempt_count + 1,
                        last_error = ?,
                        next_retry_at = ?,
                        updated_at = ?
                     WHERE library_id = ? AND work_id = ?`
                )
                .run(String(error?.message || error), timestamp, timestamp, this.libraryId, workId);
            this.db
                .prepare(
                    `UPDATE import_job SET snapshot_status = 'failed', snapshot_error = ?, updated_at = ?
                     WHERE library_id = ? AND committed_work_id = ?`
                )
                .run(String(error?.message || error), timestamp, this.libraryId, workId);
        });
        return { workId, targetRevision, ok: false, error: String(error?.message || error) };
    }

    _markSnapshotPublished(workId, targetRevision, fault = null) {
        const timestamp = now();
        return this._tx(() => {
            const row = this.db
                .prepare('SELECT * FROM snapshot_outbox WHERE library_id = ? AND work_id = ?')
                .get(this.libraryId, workId);
            if (!row) return { workId, ok: false, skipped: 'missing-outbox' };
            if (row.target_revision > targetRevision) {
                return { workId, targetRevision, ok: false, skipped: 'newer-target-pending', target: row.target_revision };
            }
            if (targetRevision <= row.published_revision) {
                return { workId, targetRevision, ok: true, skipped: 'already-published', published: row.published_revision };
            }
            if (fault === 'before-mark') {
                const error = new Error('injected snapshot fault before mark');
                error.code = 'ESNAPSHOTFAULT';
                throw error;
            }
            this.db
                .prepare(
                    `UPDATE snapshot_outbox SET
                        published_revision = ?,
                        target_revision = MAX(target_revision, ?),
                        status = CASE WHEN target_revision > ? THEN 'pending' ELSE 'ready' END,
                        attempt_count = attempt_count + 1,
                        last_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                     WHERE library_id = ? AND work_id = ?`
                )
                .run(targetRevision, targetRevision, targetRevision, timestamp, this.libraryId, workId);
            this.db
                .prepare(
                    `UPDATE import_job SET status = 'completed', snapshot_status = 'ready', snapshot_error = NULL, updated_at = ?
                     WHERE library_id = ? AND committed_work_id = ? AND committed_revision <= ?`
                )
                .run(timestamp, this.libraryId, workId, targetRevision);
            return { workId, targetRevision, ok: true, published: targetRevision };
        });
    }

    async _publishSnapshot(workId, targetRevision, fault = null, { clampToTarget = true } = {}) {
        const workKey = String(workId);
        return this._withSnapshotLock(workKey, async () => {
            let request = Number(targetRevision);
            for (;;) {
                // Re-read target under the per-work publication lock. Revision
                // updates can happen while a snapshot is being written, but only
                // the latest target may end up marked ready.
                const outbox = this.db
                    .prepare('SELECT * FROM snapshot_outbox WHERE library_id = ? AND work_id = ?')
                    .get(this.libraryId, workKey);
                if (!outbox) return { workId, ok: false, skipped: 'missing-outbox' };
                if (request < Number(outbox.published_revision)) {
                    return { workId, targetRevision: request, ok: true, skipped: 'stale-revision', published: outbox.published_revision };
                }
                if (request < Number(outbox.target_revision)) {
                    if (!clampToTarget) {
                        return { workId, targetRevision: request, ok: true, skipped: 'newer-target-pending', target: outbox.target_revision };
                    }
                    request = Number(outbox.target_revision);
                }
                const writeRevision = Number(request);
                const model = this._snapshotModel(workKey);
                let written;
                try {
                    written = await writeSnapshotPair({
                        dataRoot: this.dataRoot,
                        libraryId: this.libraryId,
                        workId: workKey,
                        targetRevision: writeRevision,
                        model,
                        fault,
                    });
                } catch (error) {
                    this._markSnapshotFailure(workKey, writeRevision, error);
                    throw error;
                }
                const marked = this._markSnapshotPublished(workKey, writeRevision, null);
                if (marked.skipped === 'newer-target-pending') {
                    // A revision arrived after the file write but before the mark.
                    // Keep the old target pending and publish the newer model now.
                    request = Number(marked.target);
                    continue;
                }
                const fresh = this.db
                    .prepare('SELECT * FROM snapshot_outbox WHERE library_id = ? AND work_id = ?')
                    .get(this.libraryId, workKey);
                if (fresh && Number(fresh.target_revision) > writeRevision) {
                    request = Number(fresh.target_revision);
                    continue;
                }
                return { ...marked, files: written };
            }
        });
    }

    async flushSnapshots(options = {}) {
        this._assertOpen();
        const rows = options.workId
            ? this.db
                  .prepare(
                      `SELECT * FROM snapshot_outbox
                       WHERE library_id = ? AND work_id = ? AND status IN ('pending','retry_wait','running')
                       ORDER BY updated_at, work_id`
                  )
                  .all(this.libraryId, String(options.workId))
            : this.db
                  .prepare(
                      `SELECT * FROM snapshot_outbox
                       WHERE library_id = ? AND status IN ('pending','retry_wait','running')
                       ORDER BY updated_at, work_id`
                  )
                  .all(this.libraryId);
        const results = [];
        for (const row of rows) {
            this.db
                .prepare(`UPDATE snapshot_outbox SET status = 'running', updated_at = ? WHERE library_id = ? AND work_id = ?`)
                .run(now(), this.libraryId, row.work_id);
            const targetRevision = options.revisionOverride ?? row.target_revision;
            const fault = options.fault ?? this.snapshotFault;
            try {
                const result = await this._publishSnapshot(row.work_id, targetRevision, fault, {
                    clampToTarget: options.revisionOverride == null,
                });
                results.push({ ...result, target: row.target_revision });
            } catch (error) {
                results.push({
                    workId: row.work_id,
                    targetRevision,
                    target: row.target_revision,
                    ok: false,
                    error: String(error?.message || error),
                });
            }
        }
        const failed = results.filter((result) => !result.ok && !result.skipped).length;
        return { processed: results.length, failed, results };
    }

    async verifyLibrary() {
        this._assertOpen();
        const issues = [];
        const counts = {};
        for (const table of [
            'work',
            'entry',
            'asset',
            'asset_ref',
            'source_ref',
            'import_job',
            'snapshot_outbox',
            'user_state',
        ]) {
            try {
                counts[table] = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
            } catch (error) {
                issues.push({ code: 'missing-table', table, detail: String(error?.message || error) });
            }
        }

        const integrity = this.db.prepare('PRAGMA integrity_check').all();
        for (const row of integrity) {
            const value = row.integrity_check ?? Object.values(row)[0];
            if (value !== 'ok') issues.push({ code: 'sqlite-integrity', detail: value });
        }
        const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
        for (const row of foreignKeys) issues.push({ code: 'foreign-key', detail: row });

        const missingRefs = this.db
            .prepare(
                `SELECT r.asset_ref_id, r.asset_id, r.work_id
                 FROM asset_ref r LEFT JOIN asset a ON a.asset_id = r.asset_id
                 WHERE a.asset_id IS NULL`
            )
            .all();
        for (const row of missingRefs) issues.push({ code: 'asset-ref-missing-asset', detail: row });

        const missingEntry = this.db
            .prepare(
                `SELECT r.asset_ref_id, r.entry_id FROM asset_ref r
                 LEFT JOIN entry e ON e.entry_id = r.entry_id WHERE e.entry_id IS NULL`
            )
            .all();
        for (const row of missingEntry) issues.push({ code: 'asset-ref-missing-entry', detail: row });

        const assets = this.db.prepare('SELECT * FROM asset ORDER BY sha256').all();
        for (const asset of assets) {
            let file;
            try {
                file = rootAssetPath(this.root, asset.rel_path);
                const info = await stat(file);
                if (!info.isFile()) throw new Error('not a file');
                if (Number(info.size) !== Number(asset.bytes)) {
                    issues.push({ code: 'asset-size-mismatch', detail: { relPath: asset.rel_path } });
                }
                const hashed = await hashFile(file);
                if (hashed.sha256 !== asset.sha256) {
                    issues.push({ code: 'asset-hash-mismatch', detail: { relPath: asset.rel_path } });
                }
            } catch (error) {
                issues.push({ code: 'asset-file-missing', detail: { relPath: asset.rel_path, error: String(error?.message || error) } });
            }
        }
        const orphanAssets = this.db
            .prepare(
                `SELECT a.asset_id FROM asset a LEFT JOIN asset_ref r ON r.asset_id = a.asset_id
                 WHERE r.asset_ref_id IS NULL`
            )
            .all();
        for (const row of orphanAssets) issues.push({ code: 'orphan-asset', severity: 'warning', detail: row.asset_id });

        const outbox = this.db.prepare('SELECT * FROM snapshot_outbox WHERE library_id = ?').all(this.libraryId);
        for (const row of outbox) {
            if (row.published_revision > row.target_revision) {
                issues.push({ code: 'snapshot-published-ahead', detail: { workId: row.work_id } });
            }
            if (row.published_revision > 0) {
                const pair = await readSnapshotPair(this.dataRoot, row.work_id, {
                    libraryId: this.libraryId,
                    revision: row.published_revision,
                });
                if (!pair.ok) {
                    issues.push({ code: 'snapshot-pair-invalid', detail: { workId: row.work_id, problems: pair.problems } });
                }
            }
        }

        const committed = this.db
            .prepare(
                `SELECT job_id, committed_work_id, committed_at, committed_revision, status
                 FROM import_job WHERE library_id = ? AND status IN ('committed','snapshot_pending','snapshot_failed','completed')`
            )
            .all(this.libraryId);
        for (const job of committed) {
            if (!job.committed_work_id || !job.committed_at || !job.committed_revision) {
                issues.push({ code: 'committed-credential-incomplete', detail: job.job_id });
            }
        }

        const errors = issues.filter((issue) => issue.severity !== 'warning');
        return {
            ok: errors.length === 0,
            issues,
            warnings: issues.filter((issue) => issue.severity === 'warning'),
            counts,
            sqliteVersion: this.db.prepare('SELECT sqlite_version() AS v').get().v,
        };
    }

    rebuildDerivedIndex() {
        this._assertOpen();
        const timestamp = now();
        this._tx(() => {
            this.db.prepare('DELETE FROM work_search').run();
            this.db
                .prepare(
                    `INSERT INTO work_search(work_id, title, circle, cv, updated_at)
                     SELECT work_id, COALESCE(user_title, title), circle, cv_json, updated_at
                     FROM work WHERE deleted_at IS NULL`
                )
                .run();
            this.db.prepare('UPDATE library SET updated_at = ? WHERE library_id = ?').run(timestamp, this.libraryId);
        });
        const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM work_search').get().n);
        return { indexed: count };
    }

    /**
     * S4a: consistent backup through node:sqlite's backup API. Kept as a dynamic
     * import so the S1 core has no hard dependency on the backup module.
     */
    async backupLibrary(destination, options = {}) {
        const { backupLibrary } = await import('./backup.mjs');
        return backupLibrary(this, destination, options);
    }

    /** S6: self-contained work export (dynamic import keeps core optional). */
    async exportWork(workId, destination, options = {}) {
        const { exportWork } = await import('./export.mjs');
        return exportWork(this, workId, destination, options);
    }

    /** S4b: staged legacy bundle migration (dynamic import keeps core optional). */
    async migrateLegacyBundle(bundle, options = {}) {
        const { migrateLegacyBundle } = await import('./legacy.mjs');
        return migrateLegacyBundle(this, bundle, options);
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
            /* best effort */
        }
        try {
            this.db.close();
        } finally {
            await this.lock?.release?.();
        }
    }
}

export async function openLibrary(root, options = {}) {
    const create = options.create === true;
    const allowOutsideRoot = options.allowOutsideRoot === true;
    const absolute = resolveRoot(root, options);
    await assertSafeDirectory(absolute, { allowMissing: true, allowOutsideRoot });
    const dataRoot = join(absolute, 'data');
    if (allowOutsideRoot) {
        if (!isInside(absolute, dataRoot)) {
            const error = new Error('data root escapes the configured library root');
            error.code = 'EOUTSIDE';
            throw error;
        }
    } else {
        try {
            assertInsideExperiment(dataRoot);
        } catch {
            const error = new Error('data root escapes experiment');
            error.code = 'EOUTSIDE';
            throw error;
        }
    }

    if (create) {
        for (const directory of [
            dataRoot,
            join(dataRoot, 'assets', 'sha256'),
            join(dataRoot, 'works'),
            join(dataRoot, 'tmp'),
            join(dataRoot, 'cache'),
            join(dataRoot, 'trash'),
        ]) {
            await ensureDir(directory);
        }
        await ensureDir(join(absolute, 'quarantine'));
        await assertSafeDirectory(absolute, { allowMissing: false, allowOutsideRoot });
    } else if (!(await pathExists(join(dataRoot, 'library.sqlite')))) {
        const error = new Error(`no storage-lab library at ${absolute}`);
        error.code = 'ENOLIBRARY';
        throw error;
    }

    let lock;
    let db;
    try {
        lock = await acquireLock(absolute);
        const rootPath = join(absolute, ROOT_FILE);
        const existingRoot = await readJson(rootPath, null);
        if (!existingRoot && !create) throw new Error('missing root.json');
        let libraryId = existingRoot?.libraryId;
        db = new DatabaseSync(join(dataRoot, 'library.sqlite'));
        enablePragmas(db);
        applySchema(db, { libraryId: libraryId || id() });
        const libraryRow = db.prepare('SELECT * FROM library LIMIT 1').get();
        if (!libraryRow) throw new Error('library row missing after schema migration');
        if (libraryId && libraryRow.library_id !== libraryId) {
            throw new Error('root.json libraryId does not match library.sqlite');
        }
        libraryId = libraryRow.library_id;
        await writeRootMetadata(absolute, libraryId, { create: true });
        if (create) {
            db.prepare('UPDATE library SET updated_at = ? WHERE library_id = ?').run(now(), libraryId);
        }
        db.prepare(`UPDATE snapshot_outbox SET status = 'pending' WHERE library_id = ? AND status = 'running'`).run(libraryId);
        return new Library({
            root: absolute,
            libraryId,
            db,
            lock,
            snapshotFault: options.snapshotFault ?? null,
            allowOutsideRoot,
        });
    } catch (error) {
        try {
            db?.close();
        } catch {
            /* ignore */
        }
        await lock?.release?.();
        throw error;
    }
}
