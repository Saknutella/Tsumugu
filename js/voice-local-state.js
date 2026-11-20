// Per-work local-download state for Kikoeru/remote voice works.
//
// File-storage imports are local by definition; remote works become "partial"
// when only some audio hashes were downloaded and "full" when all of them were.
// This is deliberately separate from ordinary tags and from the file tree.
const STORAGE_KEY = 'monochrome-voice-local-downloads-v1';

function readAll() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeAll(value) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
        /* private mode/quota: derived tag is best-effort */
    }
}

export function getDownloadedVoiceHashes(workId) {
    const entry = readAll()[String(workId || '')];
    return new Set(Array.isArray(entry?.hashes) ? entry.hashes.filter(Boolean).map(String) : []);
}

export function recordVoiceDownloads(workId, hashes) {
    const id = String(workId || '');
    if (!id) return;
    const all = readAll();
    const current = new Set(Array.isArray(all[id]?.hashes) ? all[id].hashes.map(String) : []);
    for (const hash of hashes || []) {
        if (hash) current.add(String(hash));
    }
    all[id] = { hashes: [...current], updatedAt: new Date().toISOString() };
    writeAll(all);
}

export function clearVoiceDownloads(workId) {
    const all = readAll();
    delete all[String(workId || '')];
    writeAll(all);
}

/** Remove only the hashes that were actually deleted from the host. */
export function clearVoiceDownloadHashes(workId, hashes) {
    const id = String(workId || '');
    if (!id) return;
    const all = readAll();
    const entry = all[id];
    if (!entry || !Array.isArray(entry.hashes)) return;
    const remove = new Set(Array.from(hashes || []).map(String));
    const next = entry.hashes.filter((hash) => !remove.has(String(hash)));
    if (next.length === entry.hashes.length) return;
    if (next.length) all[id] = { ...entry, hashes: next, updatedAt: new Date().toISOString() };
    else delete all[id];
    writeAll(all);
}


/** Keep only hashes that still exist in the host slice for this work. */
export function pruneVoiceDownloadHashes(workId, hashes) {
    const id = String(workId || '');
    if (!id) return;
    const all = readAll();
    const entry = all[id];
    if (!entry || !Array.isArray(entry.hashes)) return;
    const keep = new Set(Array.from(hashes || []).map(String));
    const next = entry.hashes.filter((hash) => keep.has(String(hash)));
    if (next.length === entry.hashes.length) return;
    if (next.length) all[id] = { ...entry, hashes: next, updatedAt: new Date().toISOString() };
    else delete all[id];
    writeAll(all);
}
