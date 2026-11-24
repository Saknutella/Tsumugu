// S4b: staged legacy migration. This layer preserves the immutable legacy bundle,
// maps old voice/track IDs to new rows, and records remote URLs as legacy_media_ref
// placeholders. It never downloads media, fabricates CAS assets, deletes the old
// bundle, or touches any source outside the supplied bundle object.
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

const OLD_VOICE_KIND = 'voice';
const OLD_TRACK_KIND = 'track';

function faultMatches(fault, point) {
    if (!fault) return false;
    const value = String(fault).toLowerCase();
    const target = String(point).toLowerCase();
    if (value === target) return true;
    if (target === 'f6' && value.startsWith('after-voice')) return true;
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

function now() {
    return new Date().toISOString();
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stable object-key order so semantically identical bundles hash consistently. */
function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isObject(value)) {
        const result = {};
        for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
        return result;
    }
    return value;
}

function bundleHashOf(bundle) {
    return createHash('sha256').update(JSON.stringify(canonicalize(bundle))).digest('hex');
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

function mimeForUrl(url, fallback = 'application/octet-stream') {
    const extension = extname(String(url || '').split('?')[0]).toLowerCase();
    return (
        {
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.flac': 'audio/flac',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.ogg': 'audio/ogg',
            '.opus': 'audio/opus',
            '.srt': 'application/x-subrip',
            '.vtt': 'text/vtt',
            '.ass': 'text/x-ssa',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.zip': 'application/zip',
        }[extension] || fallback
    );
}

function remoteUrlOf(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

function normalizeBundle(bundle) {
    if (!isObject(bundle)) throw new Error('legacy bundle must be an object');
    if (Number(bundle.schema) !== 1) throw new Error('only legacy bundle schema 1 is supported');
    if (!Array.isArray(bundle.voices)) throw new Error('legacy bundle.voices must be an array');
    const source = text(bundle.source, 'monochrome-legacy-export');
    return {
        schema: 1,
        exportedAt: text(bundle.exportedAt),
        source,
        voices: bundle.voices,
        favorites: isObject(bundle.favorites) ? bundle.favorites : {},
        history: list(bundle.history),
        playlists: list(bundle.playlists),
        settings: isObject(bundle.settings) ? bundle.settings : {},
    };
}

function voiceKey(voice, index) {
    return text(voice.id || voice.workId || voice.uuid || voice.sourceCode || voice.code, `voice-${index}`);
}

function legacyMap(db, oldKind, oldId) {
    return db.prepare('SELECT * FROM legacy_id_map WHERE old_kind = ? AND old_id = ?').get(oldKind, String(oldId));
}

function insertMap(db, oldKind, oldId, newKind, newId) {
    db.prepare(
        'INSERT OR IGNORE INTO legacy_id_map(old_kind, old_id, new_kind, new_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(oldKind, String(oldId), newKind, String(newId), now());
    return legacyMap(db, oldKind, oldId);
}

function insertMediaRef(db, importId, workId, entryId, legacyKind, legacyId, url) {
    const normalized = remoteUrlOf(url);
    if (!normalized) return false;
    db.prepare(
        `INSERT OR IGNORE INTO legacy_media_ref(
            media_ref_id, import_id, work_id, entry_id, legacy_kind, legacy_id, old_id, url, mime, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), importId, workId || null, entryId || null, legacyKind, legacyId || null, legacyId || null, normalized, mimeForUrl(normalized), now());
    return true;
}

function flattenTracks(tracks, parentPath = '') {
    const result = [];
    for (const track of list(tracks)) {
        if (!isObject(track)) continue;
        const title = text(track.title || track.name, 'Untitled track');
        const logicalPath = parentPath ? `${parentPath}/${title}` : title;
        const childTracks = list(track.tracks);
        const children = flattenTracks(childTracks, logicalPath);
        if (children.length) {
            result.push(...children);
            if (track.id) result.push({ folderId: String(track.id) });
            continue;
        }
        const urls = [
            remoteUrlOf(track.mediaStreamUrl),
            remoteUrlOf(track.mediaDownloadUrl),
            remoteUrlOf(track.url),
            remoteUrlOf(track.streamUrl),
        ].filter(Boolean);
        const type = text(track.type, urls.length ? 'audio' : 'file');
        if (urls.length || type !== 'folder') {
            result.push({ track, title, logicalPath, url: urls[0] || null, urls, type });
        }
    }
    return result;
}

function trackKey(track, voiceKeyValue, logicalPath, index) {
    return text(track.id || track.entryId || track.trackId || track.uuid, `${voiceKeyValue}:${logicalPath}:${index}`);
}

function stagedPayloadRows(bundle) {
    const rows = [];
    const add = (domain, payload, count) => {
        rows.push({ domain, payload, count });
    };
    add('favorites', bundle.favorites, Object.keys(bundle.favorites || {}).length);
    add('history', bundle.history, bundle.history.length);
    add('playlists', bundle.playlists, bundle.playlists.length);
    add('settings', bundle.settings, Object.keys(bundle.settings || {}).length);
    return rows;
}

function insertStagedPayloads(db, importId, bundle) {
    const timestamp = now();
    for (const row of stagedPayloadRows(bundle)) {
        db.prepare(
            `INSERT OR IGNORE INTO legacy_staged_payload(import_id, domain, payload_json, item_count, created_at)
             VALUES (?, ?, ?, ?, ?)`
        ).run(importId, row.domain, JSON.stringify(row.payload), row.count, timestamp);
    }
}

function existingImportByKey(db, libraryId, key) {
    return db.prepare('SELECT * FROM legacy_import WHERE library_id = ? AND idempotency_key = ?').get(libraryId, String(key));
}

function existingImportByHash(db, libraryId, hash) {
    return db.prepare('SELECT * FROM legacy_import WHERE library_id = ? AND bundle_hash = ?').get(libraryId, String(hash));
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function summaryOf(row, extra = {}) {
    const counts = parseJson(row.counts_json, {});
    const errors = parseJson(row.errors_json, []);
    const result = {
        importId: row.import_id,
        legacyImportId: row.import_id,
        libraryId: row.library_id,
        idempotencyKey: row.idempotency_key,
        bundleHash: row.bundle_hash,
        status: row.status,
        counts,
        worksCreated: counts.worksCreated ?? 0,
        worksMapped: counts.worksMapped ?? 0,
        entriesCreated: counts.entriesCreated ?? 0,
        mediaRefsCreated: counts.mediaRefsCreated ?? 0,
        errors,
    };
    Object.defineProperties(result, {
        idempotent: { value: extra.idempotent === true, enumerable: false },
        resumed: { value: extra.resumed === true, enumerable: false },
        faulted: { value: extra.faulted === true, enumerable: false },
    });
    return result;
}

function createImportRow(db, libraryId, key, bundle, hash) {
    const timestamp = now();
    const importId = randomUUID();
    db.prepare(
        `INSERT INTO legacy_import(
            import_id, library_id, idempotency_key, bundle_hash, bundle_json,
            schema_version, source, status, counts_json, errors_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', '{}', '[]', ?, ?)`
    ).run(
        importId,
        libraryId,
        String(key),
        hash,
        JSON.stringify(bundle),
        Number(bundle.schema),
        text(bundle.source),
        timestamp,
        timestamp
    );
    insertStagedPayloads(db, importId, normalizeBundle(bundle));
    return db.prepare('SELECT * FROM legacy_import WHERE import_id = ?').get(importId);
}

function processVoice(db, libraryId, importId, voice, index, resultCounts) {
    const oldId = voiceKey(voice, index);
    const timestamp = now();
    let workMap = legacyMap(db, OLD_VOICE_KIND, oldId);
    let workId;
    let createdWork = false;
    if (workMap?.new_kind === 'work') {
        workId = workMap.new_id;
        const existing = db.prepare('SELECT work_id FROM work WHERE work_id = ?').get(workId);
        if (!existing) {
            db.prepare(
                `INSERT INTO work(work_id, family_id, title, circle, cv_json, language, role, revision, created_at, updated_at)
                 VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`
            ).run(workId, text(voice.title, oldId), text(voice.circle), JSON.stringify(list(voice.cvs)), text(voice.language), text(voice.role), timestamp, timestamp);
            createdWork = true;
        }
    } else {
        workId = randomUUID();
        const familyId = randomUUID();
        db.prepare('INSERT INTO family(family_id, created_at) VALUES (?, ?)').run(familyId, timestamp);
        db.prepare(
            `INSERT INTO work(work_id, family_id, title, circle, cv_json, language, role, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(
            workId,
            familyId,
            text(voice.title, oldId),
            text(voice.circle),
            JSON.stringify(list(voice.cvs)),
            text(voice.language),
            text(voice.role),
            timestamp,
            timestamp
        );
        insertMap(db, OLD_VOICE_KIND, oldId, 'work', workId);
        resultCounts.worksCreated += 1;
        createdWork = true;
    }
    if (!createdWork) resultCounts.worksMapped += 1;

    const provider = text(voice.provider, 'legacy');
    const sourceCode = text(voice.sourceCode || voice.code, oldId);
    db.prepare(
        `INSERT OR IGNORE INTO source_ref(
            source_ref_id, work_id, provider, source_code, source_url, snapshot_json, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
        randomUUID(),
        workId,
        provider,
        sourceCode,
        text(voice.sourceUrl),
        JSON.stringify({ legacyVoice: voice, oldVoiceId: oldId }),
        now()
    );

    db.prepare(
        `INSERT OR IGNORE INTO user_state(work_id, notes, favorite, playback_position, updated_at)
         VALUES (?, ?, ?, NULL, ?)`
    ).run(workId, text(voice.notes), voice.favorite ? 1 : 0, timestamp);

    // Remote cover URLs are references only, never CAS assets.
    for (const cover of [
        voice.coverUrl,
        voice.cover,
        ...(Array.isArray(voice.covers) ? voice.covers : []),
    ]) {
        if (insertMediaRef(db, importId, workId, null, 'cover', oldId, cover)) resultCounts.mediaRefsCreated += 1;
    }

    const tracks = flattenTracks(voice.tracks || voice.entries || voice.files || []);
    for (const [trackIndex, leaf] of tracks.entries()) {
        if (leaf.folderId) {
            if (!legacyMap(db, OLD_TRACK_KIND, leaf.folderId)) {
                insertMap(db, OLD_TRACK_KIND, leaf.folderId, 'work', workId);
            }
            continue;
        }
        const oldTrackId = trackKey(leaf.track, oldId, leaf.logicalPath, trackIndex);
        const mapped = legacyMap(db, OLD_TRACK_KIND, oldTrackId);
        if (mapped?.new_kind === 'entry') {
            resultCounts.entriesMapped += 1;
            continue;
        }
        const entryId = randomUUID();
        const kind = leaf.type || 'audio';
        db.prepare(
            `INSERT INTO entry(
                entry_id, work_id, stable_entry_id, logical_path, kind, mime,
                display_title, original_path, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            entryId,
            workId,
            String(oldTrackId),
            leaf.logicalPath,
            kind,
            leaf.url ? mimeForUrl(leaf.url) : 'application/octet-stream',
            leaf.title,
            text(leaf.track.path || leaf.track.originalPath),
            trackIndex
        );
        insertMap(db, OLD_TRACK_KIND, oldTrackId, 'entry', entryId);
        resultCounts.entriesCreated += 1;
        for (const mediaUrl of leaf.urls || (leaf.url ? [leaf.url] : [])) {
            if (insertMediaRef(db, importId, workId, entryId, 'media', oldTrackId, mediaUrl)) {
                resultCounts.mediaRefsCreated += 1;
            }
        }
        for (const subtitle of list(leaf.track.subtitles)) {
            const subtitleUrl = typeof subtitle === 'string' ? subtitle : subtitle?.url;
            if (insertMediaRef(db, importId, workId, entryId, 'subtitle', oldTrackId, subtitleUrl)) {
                resultCounts.mediaRefsCreated += 1;
            }
        }
    }
}

function updateImport(db, importId, { status, counts, errors, completed = false }) {
    db.prepare(
        `UPDATE legacy_import SET
            status = ?, counts_json = ?, errors_json = ?, updated_at = ?,
            completed_at = CASE WHEN ? THEN ? ELSE completed_at END
         WHERE import_id = ?`
    ).run(status, JSON.stringify(counts), JSON.stringify(errors), now(), completed ? 1 : 0, now(), importId);
}

/**
 * Migrate a normalized legacy export bundle into the new library.
 *
 * Staged behavior:
 * - raw bundle stored immutably in legacy_import.bundle_json;
 * - voices -> work/source_ref/entry + user_state;
 * - remote URLs -> legacy_media_ref only (no asset/asset_ref, no downloads);
 * - old IDs -> legacy_id_map; favorites/history/playlists/settings -> staged payloads.
 *
 * `options.fault = 'after-voice:N'` commits N voices then stops as partial. Retry
 * the same bundle/key (without fault) resumes; committed maps/works are reused.
 */
export async function migrateLegacyBundle(library, bundle, options = {}) {
    if (!library || !library.db) throw new Error('a storage-lab Library instance is required');
    const normalized = normalizeBundle(bundle);
    // Preserve the caller's raw shape for the immutable payload, but validate the
    // normalized top-level fields above.
    const raw = bundle;
    const hash = bundleHashOf(normalized);
    const key = String(options.idempotencyKey || `legacy:bundle:${hash}`);
    const existingByKey = existingImportByKey(library.db, library.libraryId, key);
    if (existingByKey) {
        if (existingByKey.bundle_hash !== hash) {
            const error = new Error(
                `legacy idempotency key reused with a changed bundle/plan: ${existingByKey.bundle_hash} != ${hash}`
            );
            error.code = 'ELEGACYCONFLICT';
            throw error;
        }
        if (existingByKey.status === 'completed') return summaryOf(existingByKey, { idempotent: true });
        // partial/processing: resume below
        return resumeImport(library, existingByKey, normalized, options);
    }
    const existingByHash = existingImportByHash(library.db, library.libraryId, hash);
    if (existingByHash) {
        // Same immutable bundle under another key is the same migration, not a
        // second set of works.
        return summaryOf(existingByHash, { idempotent: true });
    }

    let row;
    try {
        library.db.exec('BEGIN IMMEDIATE');
        row = createImportRow(library.db, library.libraryId, key, raw, hash);
        library.db.exec('COMMIT');
    } catch (error) {
        try {
            library.db.exec('ROLLBACK');
        } catch {
            /* no active tx */
        }
        throw error;
    }
    return runImport(library, row, normalized, options);
}

function runImport(library, row, bundle, options, priorCounts = null) {
    const counts = priorCounts || {
        voices: bundle.voices.length,
        worksCreated: 0,
        worksMapped: 0,
        entriesCreated: 0,
        entriesMapped: 0,
        mediaRefsCreated: 0,
    };
    const errors = [];
    const fault = Number(options.afterVoice || 0) > 0
        ? Number(options.afterVoice)
        : parseFault(options.fault) || (String(options.fault).toUpperCase() === 'F6' ? 1 : null);
    const faultExitRequested =
        String(options.fault).toUpperCase() === 'F6' ||
        typeof options.onFault === 'function' ||
        options.faultExit === true;
    let faulted = false;
    for (const [index, voice] of bundle.voices.entries()) {
        if (faulted) break;
        try {
            library.db.exec('BEGIN IMMEDIATE');
            processVoice(library.db, library.libraryId, row.import_id, voice, index, counts);
            library.db.exec('COMMIT');
        } catch (error) {
            try {
                library.db.exec('ROLLBACK');
            } catch {
                /* no active tx */
            }
            errors.push({ voiceId: voiceKey(voice, index), error: String(error?.message || error) });
        }
        if (fault !== null && index + 1 >= fault) {
            if (faultExitRequested) {
                triggerFault(
                    {
                        ...options,
                        fault: String(options.fault).toUpperCase() === 'F6' ? 'F6' : options.fault,
                    },
                    'F6',
                    {
                        importId: row.import_id,
                        libraryId: library.libraryId,
                        voiceIndex: index,
                        committedVoices: index + 1,
                        counts,
                    }
                );
            }
            faulted = true;
            errors.push({ fault: `after-voice:${fault}`, error: 'injected migration fault' });
        }
    }
    const status = errors.length === 0 ? 'completed' : 'partial';
    if (!faulted) {
        try {
            library.db.exec('BEGIN IMMEDIATE');
            // Refresh staged payloads only if absent; raw bundle is immutable.
            insertStagedPayloads(library.db, row.import_id, bundle);
            library.db.exec('COMMIT');
        } catch (error) {
            errors.push({ stage: 'staged-payload', error: String(error?.message || error) });
        }
    }
    updateImport(library.db, row.import_id, {
        status: errors.length === 0 ? 'completed' : 'partial',
        counts,
        errors,
        completed: errors.length === 0,
    });
    const updated = library.db.prepare('SELECT * FROM legacy_import WHERE import_id = ?').get(row.import_id);
    return summaryOf(updated, { idempotent: false, resumed: priorCounts !== null, faulted });
}

function parseFault(fault) {
    if (!fault) return null;
    if (typeof fault === 'number' && Number.isInteger(fault) && fault > 0) return fault;
    const match = String(fault).match(/^(?:after-)?(?:voice|work)[:\-]?(\d+)$/i);
    if (match) return Number(match[1]);
    return null;
}

function resumeImport(library, row, bundle, options) {
    const parsed = parseJson(row.counts_json, {});
    const counts = {
        voices: Number(parsed.voices) || bundle.voices.length,
        worksCreated: Number(parsed.worksCreated) || 0,
        worksMapped: Number(parsed.worksMapped) || 0,
        entriesCreated: Number(parsed.entriesCreated) || 0,
        entriesMapped: Number(parsed.entriesMapped) || 0,
        mediaRefsCreated: Number(parsed.mediaRefsCreated) || 0,
    };
    // Mark processing but keep the immutable bundle untouched.
    library.db.prepare('UPDATE legacy_import SET status = ?, updated_at = ? WHERE import_id = ?').run(
        'processing',
        now(),
        row.import_id
    );
    return runImport(library, row, bundle, options, counts);
}
