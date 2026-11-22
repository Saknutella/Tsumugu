// E04: logical tracks and format renditions.
//
// Tracks are created only from an explicit trackKey during import (or as a
// one-entry fallback track), never by title/byte heuristics. A track has one
// rendition per entry; resolveTrackMedia collapses renditions to one playback
// item per logical track using the requested format or a stable default order.
const DEFAULT_FORMAT_ORDER = ['aac', 'm4a', 'mp3', 'opus', 'ogg', 'wav', 'flac', 'aiff', 'unknown'];

function normalizeFormat(value) {
    const text = String(value || '').toLowerCase().trim();
    if (!text) return '';
    if (text === 'lossless') return 'lossless';
    if (text.includes('/')) {
        if (text.includes('mpeg')) return 'mp3';
        if (text.includes('wav')) return 'wav';
        if (text.includes('flac')) return 'flac';
        if (text.includes('aac')) return 'aac';
        if (text.includes('mp4')) return 'm4a';
        if (text.includes('opus')) return 'opus';
        if (text.includes('ogg')) return 'ogg';
    }
    return text.replace(/^\./, '').replace(/^audio\//, '');
}

function preferredFormats(value) {
    if (value === undefined || value === null || value === '' || value === 'auto') return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map(normalizeFormat).filter(Boolean);
}

function formatMatches(rendition, format) {
    if (!format) return false;
    if (format === 'lossless') return ['wav', 'flac', 'aiff'].includes(rendition.format);
    return rendition.format === format || normalizeFormat(rendition.mime) === format;
}

function chooseRendition(renditions, requested) {
    const preferred = preferredFormats(requested);
    for (const format of preferred) {
        const match = renditions.find((rendition) => formatMatches(rendition, format));
        if (match) return { rendition: match, fallback: false, requested: preferred };
    }
    for (const format of DEFAULT_FORMAT_ORDER) {
        const match = renditions.find((rendition) => formatMatches(rendition, format));
        if (match) return { rendition: match, fallback: preferred.length > 0, requested: preferred };
    }
    return { rendition: renditions[0] || null, fallback: preferred.length > 0, requested: preferred };
}

function selectRenditions(library, workId) {
    const tracks = library.db
        .prepare('SELECT * FROM track WHERE work_id = ? ORDER BY sort_order, track_key')
        .all(String(workId));
    const result = [];
    for (const track of tracks) {
        const renditions = library.db
            .prepare(
                `SELECT r.*, e.stable_entry_id, e.logical_path, e.kind, e.display_title,
                        e.mime AS entry_mime,
                        a.asset_id, a.sha256, a.bytes, a.rel_path, a.mime AS asset_mime
                 FROM track_rendition r
                 JOIN entry e ON e.entry_id = r.entry_id
                 LEFT JOIN asset a ON a.asset_id = (
                     SELECT asset_id FROM asset_ref
                     WHERE entry_id = e.entry_id
                     ORDER BY CASE WHEN role = 'primary' THEN 0 ELSE 1 END, asset_ref_id
                     LIMIT 1
                 )
                 WHERE r.track_id = ?
                 ORDER BY r.priority, r.rendition_id`
            )
            .all(track.track_id)
            .map((rendition) => ({
                renditionId: rendition.rendition_id,
                entryId: rendition.stable_entry_id,
                internalEntryId: rendition.entry_id,
                logicalPath: rendition.logical_path,
                kind: rendition.kind,
                title: rendition.display_title,
                format: rendition.format,
                mime: rendition.asset_mime || rendition.entry_mime || rendition.mime || 'application/octet-stream',
                priority: rendition.priority,
                assetId: rendition.asset_id || null,
                sha256: rendition.sha256 || null,
                bytes: rendition.bytes == null ? null : Number(rendition.bytes),
                relPath: rendition.rel_path || null,
            }));
        result.push({
            trackId: track.track_id,
            trackKey: track.track_key,
            title: track.title,
            sortOrder: Number(track.sort_order || 0),
            renditions,
        });
    }
    return result;
}

export function listLogicalTracks(library, workId) {
    const tracks = selectRenditions(library, workId);
    const result = tracks;
    result.workId = String(workId);
    result.tracks = result;
    return result;
}

export function resolveTrackMedia(library, workId, options = {}) {
    const tracks = selectRenditions(library, workId).filter((track) =>
        track.renditions.some((rendition) => rendition.kind === 'audio')
    );
    const result = tracks.map((track) => {
        const audioRenditions = track.renditions.filter((rendition) => rendition.kind === 'audio');
        const chosen = chooseRendition(audioRenditions.length ? audioRenditions : track.renditions, options.preferredFormat);
        const selected = chosen.rendition;
        return {
            ...track,
            rendition: selected,
            selectedRendition: selected,
            fallback: chosen.fallback,
            requestedFormat: chosen.requested,
            ...(selected
                ? {
                      renditionId: selected.renditionId,
                      entryId: selected.entryId,
                      internalEntryId: selected.internalEntryId,
                      logicalPath: selected.logicalPath,
                      format: selected.format,
                      mime: selected.mime,
                      assetId: selected.assetId,
                      sha256: selected.sha256,
                      bytes: selected.bytes,
                      relPath: selected.relPath,
                  }
                : {}),
        };
    });
    result.workId = String(workId);
    result.tracks = result;
    result.sequence = result;
    return result;
}

export function playbackSequence(library, workId, options = {}) {
    return resolveTrackMedia(library, workId, options);
}

export { DEFAULT_FORMAT_ORDER, normalizeFormat };
