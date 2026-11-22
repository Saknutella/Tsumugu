// E09: playback queue and per-work playback position.
//
// Queue/position are business state in SQLite, not cache. Only stable IDs are
// stored; no blob URLs, absolute media URLs or machine paths. Reads tolerate
// deleted/missing work/entry/track and surface explicit missing markers rather
// than silently dropping rows.
const QUEUE_ID = 'current';
const POSITION_PRECISION_MS = 1;
const DEFAULT_MAX_ROLLBACK_SECONDS = 5;

function now() {
    return new Date().toISOString();
}

function stableId(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        const error = new Error(`${label} must be a non-empty stable ID`);
        error.code = 'EQUEUEINVALID';
        throw error;
    }
    const text = value.trim();
    if (/^(blob:|https?:|file:|\/|[A-Za-z]:[\\/])/i.test(text) || text.includes('\\')) {
        const error = new Error(`${label} must not be a URL or absolute path`);
        error.code = 'EQUEUEINVALID';
        throw error;
    }
    return text;
}

function roundSeconds(seconds) {
    if (!Number.isFinite(seconds)) {
        const error = new Error('playback seconds must be finite');
        error.code = 'EPOSITIONINVALID';
        throw error;
    }
    if (seconds < 0) {
        const error = new Error('playback seconds must be >= 0');
        error.code = 'EPOSITIONINVALID';
        throw error;
    }
    return Math.round(seconds * 1000) / 1000;
}

function sortQueueItems(items) {
    const withPositions = items.every((item) => Number.isInteger(item.position) || Number.isInteger(item.sortOrder));
    if (!withPositions) return [...items];
    return [...items].sort((a, b) => {
        const left = Number.isInteger(a.position) ? a.position : Number(a.sortOrder);
        const right = Number.isInteger(b.position) ? b.position : Number(b.sortOrder);
        return left - right;
    });
}

function readState(library) {
    return library.db.prepare('SELECT * FROM queue_state WHERE queue_id = ?').get(QUEUE_ID) || null;
}

function missingFor(library, item) {
    const missing = [];
    const work = library.db.prepare('SELECT work_id, deleted_at FROM work WHERE work_id = ?').get(item.work_id);
    if (!work) missing.push('work');
    const track = library.db.prepare('SELECT track_id, work_id FROM track WHERE track_id = ?').get(item.track_id);
    if (!track) missing.push('track');
    else if (work && track.work_id !== item.work_id) missing.push('track-work');
    const entry =
        library.db.prepare('SELECT entry_id, work_id FROM entry WHERE stable_entry_id = ? OR entry_id = ?').all(item.entry_id, item.entry_id);
    const matched = entry.find((row) => row.work_id === item.work_id) || entry[0] || null;
    if (!matched) missing.push('entry');
    else if (work && matched.work_id !== item.work_id) missing.push('entry-work');
    return {
        missing,
        workDeleted: Boolean(work?.deleted_at),
        workExists: Boolean(work),
        trackExists: Boolean(track),
        entryExists: Boolean(matched),
    };
}

/**
 * Replace the single library playback queue. Input order is preserved unless
 * every item has a numeric position/sortOrder, in which case that order wins.
 */
export function saveQueue(library, items, options = {}) {
    if (!Array.isArray(items)) throw new Error('queue items must be an array');
    const prepared = sortQueueItems(items).map((item, index) => {
        if (!item || typeof item !== 'object') {
            const error = new Error(`queue item ${index} must be an object`);
            error.code = 'EQUEUEINVALID';
            throw error;
        }
        return {
            position: index,
            workId: stableId(item.workId, 'workId'),
            trackId: stableId(item.trackId, 'trackId'),
            entryId: stableId(item.entryId, 'entryId'),
        };
    });
    const previous = readState(library);
    const requestedIndex = options.currentIndex ?? previous?.current_index ?? 0;
    const currentIndex = prepared.length
        ? Math.max(0, Math.min(prepared.length - 1, Math.trunc(Number(requestedIndex) || 0)))
        : 0;
    const timestamp = now();
    library._tx(() => {
        library.db.prepare('DELETE FROM queue_item WHERE queue_id = ?').run(QUEUE_ID);
        library.db
            .prepare(
                `INSERT INTO queue_state(queue_id, current_index, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(queue_id) DO UPDATE SET current_index = excluded.current_index, updated_at = excluded.updated_at`
            )
            .run(QUEUE_ID, currentIndex, timestamp);
        const insert = library.db.prepare(
            'INSERT INTO queue_item(queue_id, position, work_id, track_id, entry_id) VALUES (?, ?, ?, ?, ?)'
        );
        for (const item of prepared) {
            insert.run(QUEUE_ID, item.position, item.workId, item.trackId, item.entryId);
        }
    });
    return getQueue(library);
}

export function getQueue(library) {
    const state = readState(library);
    const rows = library.db
        .prepare('SELECT * FROM queue_item WHERE queue_id = ? ORDER BY position')
        .all(QUEUE_ID);
    const items = rows.map((row) => {
        const missing = missingFor(library, row);
        return {
            position: Number(row.position),
            sortOrder: Number(row.position),
            workId: row.work_id,
            trackId: row.track_id,
            entryId: row.entry_id,
            ...missing,
        };
    });
    const queue = items;
    queue.currentIndex = state ? Number(state.current_index) : 0;
    queue.updatedAt = state?.updated_at || null;
    Object.defineProperty(queue, 'items', { value: queue, enumerable: false });
    queue.missing = items.flatMap((item) =>
        item.missing.map((field) => ({ position: item.position, field, workId: item.workId }))
    );
    return queue;
}

export function savePlaybackPosition(library, workId, payload = {}, options = {}) {
    const work = stableId(workId, 'workId');
    const seconds = roundSeconds(Number(payload.seconds));
    const entryId = payload.entryId == null || payload.entryId === '' ? null : stableId(payload.entryId, 'entryId');
    const updatedAt = payload.updatedAt ? String(payload.updatedAt) : now();
    const timestamp = Number.isNaN(Date.parse(updatedAt)) ? now() : new Date(updatedAt).toISOString();
    const existing = getPlaybackPosition(library, work);
    const maxRollback = options.maxRollbackSeconds === undefined ? DEFAULT_MAX_ROLLBACK_SECONDS : Number(options.maxRollbackSeconds);
    if (existing && !options.allowRollback) {
        const tooOld = existing.updatedAt && timestamp < existing.updatedAt;
        const tooFarBack = Number.isFinite(maxRollback) && seconds < existing.seconds - maxRollback;
        if (tooOld || tooFarBack) {
            return {
                ...existing,
                ignored: true,
                reason: tooOld ? 'stale-timestamp' : 'rollback-exceeds-max',
                requestedSeconds: seconds,
            };
        }
    }
    library._tx(() => {
        library.db
            .prepare(
                `INSERT INTO playback_position(work_id, entry_id, seconds, precision_ms, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(work_id) DO UPDATE SET
                    entry_id = excluded.entry_id,
                    seconds = excluded.seconds,
                    precision_ms = excluded.precision_ms,
                    updated_at = excluded.updated_at`
            )
            .run(work, entryId, seconds, POSITION_PRECISION_MS, timestamp);
    });
    return getPlaybackPosition(library, work);
}

export function getPlaybackPosition(library, workId) {
    const work = String(workId || '');
    if (!work) return null;
    const row = library.db.prepare('SELECT * FROM playback_position WHERE work_id = ?').get(work);
    if (!row) return null;
    const workRow = library.db.prepare('SELECT work_id, deleted_at FROM work WHERE work_id = ?').get(work);
    let entryMissing = false;
    if (row.entry_id) {
        const entry = library.db
            .prepare('SELECT entry_id, work_id FROM entry WHERE stable_entry_id = ? OR entry_id = ?')
            .all(row.entry_id, row.entry_id);
        entryMissing = !entry.some((candidate) => candidate.work_id === work);
    }
    return {
        workId: row.work_id,
        entryId: row.entry_id,
        seconds: Number(row.seconds),
        precisionMs: Number(row.precision_ms || POSITION_PRECISION_MS),
        precisionSeconds: 0.001,
        updatedAt: row.updated_at,
        workExists: Boolean(workRow),
        workDeleted: Boolean(workRow?.deleted_at),
        entryMissing,
        ignored: false,
    };
}

export { POSITION_PRECISION_MS, DEFAULT_MAX_ROLLBACK_SECONDS, QUEUE_ID };
