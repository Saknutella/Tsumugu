// File-storage backed voice library.
//
// The sidecar owns SQLite + CAS; this module only maps host works into the shape
// the existing Voices UI renders and points audio entries at the host media URLs.
// Browser builds (no Tauri) never show the entry.
import { fetchDlsiteWorkMetadata } from './dlsite-metadata.js';
import { fetchKikoeruWork } from './kikoeru-api.js';
import { mergeBrowserLocalWorks, mergeFileStorageWorks } from './voices.js';
import { getVoiceDownloadSettings } from './voice-settings.js';
import { Player } from './player.js';
import { mergeVoiceMetadata } from './voice-metadata.js';
import { pruneVoiceDownloadHashes } from './voice-local-state.js';
import { voicePublishedCircle, voiceTranslatorList } from './voice-circle.js';

const invoke = window.__TAURI_INTERNALS__?.invoke;
const nativeFetch = window.__monochromeDemoNativeFetch || window.fetch.bind(window);
const state = { mode: 'none', url: null, token: null, source: null, starting: null, statusEl: null, button: null, worksSignature: null, pollTimer: null };
function webStorageConfig() {
    const injected = globalThis.__MONOCHROME_STORAGE__ || {};
    const query = new URLSearchParams(location.search);
    const env = import.meta.env || {};
    const rawUrl =
        injected.url ||
        globalThis.__MONOCHROME_STORAGE_URL ||
        query.get('storage') ||
        env.VITE_STORAGE_URL ||
        '';
    const rawToken =
        injected.token ||
        globalThis.__MONOCHROME_STORAGE_TOKEN ||
        query.get('storageToken') ||
        env.VITE_STORAGE_TOKEN ||
        '';
    return {
        url: String(rawUrl || '').replace(/\/+$/, ''),
        token: rawToken ? String(rawToken) : null,
    };
}

async function probeWebBackend(url, token) {
    if (!url) return false;
    try {
        const response = await nativeFetch(`${url}/health`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) return false;
        const json = await response.json().catch(() => ({}));
        return json?.ok === true;
    } catch {
        return false;
    }
}

async function connectWebBackend() {
    const config = webStorageConfig();
    const candidates = [...new Set([config.url, '/storage'].filter(Boolean))];
    for (const candidate of candidates) {
        if (await probeWebBackend(candidate, config.token)) {
            state.mode = 'web';
            state.url = candidate.replace(/\/+$/, '');
            state.token = config.token;
            return true;
        }
    }
    return false;
}

let readyResolve;
let readySettled = false;
const readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
});
const settleReady = () => {
    if (readyResolve) {
        readySettled = true;
        readyResolve();
        readyResolve = null;
    }
};

function setStatus(text, isError = false) {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
    state.statusEl.dataset.state = isError ? 'error' : 'ready';
}

async function api(path, body) {
    if (!state.url) throw new Error('storage host is not running');
    const response = await nativeFetch(`${state.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = json?.error?.message || json?.message || response.statusText;
        throw new Error(`${path}: ${message}`);
    }
    return json;
}

async function startHost(source) {
    if (state.mode === 'web') return { url: state.url, token: state.token };
    // In a browser there is no Tauri runtime, so `invoke` is undefined and calling it
    // throws "invoke is not a function" — which says nothing about the real problem.
    // That message only ever appears when `connectWebBackend()` failed (dev host not
    // running, wrong port), so name that instead of blaming Tauri.
    if (typeof invoke !== 'function') {
        throw new Error('文件库后端未连接（dev 代理 /storage 无法访问 storage host），请确认 host 正在运行');
    }
    state.mode = 'tauri';
    const startup = await invoke('start_storage', { source: source || null });
    state.url = startup.url;
    state.token = startup.token || null;
    state.source = source || null;
    return startup;
}

function entryTitle(entry) {
    const path = entry.logicalPath || entry.displayTitle || entry.entryId;
    return path.split('/').pop() || path;
}

function mediaUrl(hostUrl, mediaPath) {
    return `${hostUrl}${mediaPath}`;
}

function trackTypeForEntry(entry) {
    if (entry.kind === 'audio') return 'audio';
    if (entry.kind === 'subtitle') return 'text';
    if (entry.kind === 'image' || entry.kind === 'cover') return 'image';
    if (entry.kind === 'archive') return 'other';
    if (entry.kind === 'video') return 'video';
    return 'other';
}

const durationCache = new Map();
const MAX_MEDIA_ELEMENT_PROBE_BYTES = 64 * 1024 * 1024;
const WAV_PROBE_BYTES = 64 * 1024;

function totalTrackDuration(nodes) {
    // mp3/wav/flac folders are renditions of the same recording. Sum one
    // duration per base title; otherwise the album total doubles.
    const byTitle = new Map();
    const visit = (entries) => {
        for (const node of entries || []) {
            if (node.type === 'folder') {
                visit(node.children);
            } else if (node.type === 'audio') {
                const title = String(node.title || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
                const key = title || node.hash;
                const duration = Number(node.duration) || 0;
                if (duration > (byTitle.get(key) || 0)) byTitle.set(key, duration);
            }
        }
    };
    visit(nodes);
    return [...byTitle.values()].reduce((sum, duration) => sum + duration, 0);
}

function probeMediaDuration(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!url || typeof Audio !== 'function') {
            resolve(0);
            return;
        }
        const audio = new Audio();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            audio.removeAttribute('src');
            audio.load?.();
            resolve(Number.isFinite(value) && value > 0 ? value : 0);
        };
        const timer = setTimeout(() => finish(0), timeoutMs);
        audio.preload = 'metadata';
        audio.addEventListener('loadedmetadata', () => finish(audio.duration), { once: true });
        audio.addEventListener('error', () => finish(0), { once: true });
        audio.src = url;
    });
}

async function probeLargeWavDuration(url, fileBytes) {
    const response = await nativeFetch(url, {
        headers: { Range: `bytes=0-${WAV_PROBE_BYTES - 1}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
    });
    const length = Number(response.headers.get('content-length'));
    if (response.status !== 206 || length < 12 || length > WAV_PROBE_BYTES ||
        response.headers.get('content-range') !== `bytes 0-${length - 1}/${fileBytes}`) {
        await response.body?.cancel().catch(() => {});
        return 0;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== length) return 0;
    const header = new DataView(bytes.buffer);
    const decoder = new TextDecoder();
    const tag = (start) => decoder.decode(bytes.subarray(start, start + 4));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0;

    let byteRate = 0;
    for (let offset = 12; offset + 8 <= length;) {
        const chunk = tag(offset);
        const size = header.getUint32(offset + 4, true);
        const data = offset + 8;
        if (chunk === 'fmt ' && size >= 16 && data + 16 <= length) {
            let format = header.getUint16(data, true);
            if (format === 0xfffe && size >= 40 && data + 40 <= length) {
                format = header.getUint32(data + 24, true);
            }
            if (format === 1 || format === 3) byteRate = header.getUint32(data + 8, true);
        }
        if (chunk === 'data') return byteRate && data + size <= fileBytes ? size / byteRate : 0;
        offset = data + size + (size % 2);
    }
    return 0;
}

async function hydrateLocalDurations(localWorks, hostWorks = []) {
    let changed = false;
    const durationUpdates = new Map();
    const pending = [];
    const visit = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') visit(node.children);
            else if (node.type === 'audio' && node.hash) {
                if (durationCache.has(node.hash)) {
                    if (Number(node.duration) <= 0) {
                        node.duration = durationCache.get(node.hash);
                        changed = true;
                    }
                } else if (Number(node.duration) <= 0) {
                    pending.push(node);
                }
            }
        }
    };
    for (const work of localWorks || []) visit(work.tracks);
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
            const node = queue.shift();
            // Chromium's metadata-only audio load can allocate for a large
            // file even when it cancels the network request after the header.
            const bytes = Number(node.bytes);
            // Large WAVs get a bounded header-only parser. Large MP3s can still
            // use the media element metadata probe: Chromium only needs the
            // container header, and returning 0 here made every >64 MiB MP3
            // permanently show "--:--" even though its WAV twin had a duration.
            const isWav = /\.wav$/i.test(node.title);
            const duration = isWav && bytes > MAX_MEDIA_ELEMENT_PROBE_BYTES
                ? await probeLargeWavDuration(node.mediaStreamUrl, bytes).catch(() => 0)
                : await probeMediaDuration(node.mediaStreamUrl);
            durationCache.set(node.hash, duration);
            if (duration > 0) {
                node.duration = duration;
                changed = true;
            }
        }
    });
    await Promise.all(workers);
    // Persist probed durations into host user_meta so a restart does not need
    // to probe/range-read the same files again (the common "refresh a few
    // times before durations appear" symptom).
    const hostById = new Map((hostWorks || []).map((work) => [work.workId, work]));
    for (const work of localWorks || []) {
        const hostWork = hostById.get(work.storageWorkId);
        if (!hostWork) continue;
        const existing = hostWork.userMeta?.durations && typeof hostWork.userMeta.durations === 'object'
            ? hostWork.userMeta.durations
            : {};
        const next = { ...existing };
        let added = false;
        const visitPersist = (nodes) => {
            for (const node of nodes || []) {
                if (node.type === 'folder') visitPersist(node.children);
                else if (node.hash && Number(node.duration) > 0 && next[node.hash] === undefined) {
                    next[node.hash] = Number(node.duration);
                    added = true;
                }
            }
        };
        visitPersist(work.tracks);
        if (added) durationUpdates.set(hostWork.workId, next);
    }
    await Promise.all([...durationUpdates].map(([workId, durations]) =>
        api('/api/works/metadata', { workId, metadata: { durations } }).catch((error) => {
            console.warn('persist voice durations failed:', error?.message || error);
        }),
    ));
    if (changed) {
        for (const work of localWorks || []) {
            // Prefer remote/DLsite duration: summing mp3 + wav renditions doubles
            // the runtime. Only fall back to the local sum when no remote total exists.
            if (!(Number(work.duration) > 0)) work.duration = totalTrackDuration(work.tracks);
        }
        mergeFileStorageWorks(localWorks);
    }
}

function buildTracks(work, hostUrl) {
    const root = [];
    const folders = new Map();
    for (const entry of work.entries || []) {
        if (!entry.mediaPath || !entry.logicalPath) continue;
        const parts = String(entry.logicalPath).split('/').filter(Boolean);
        if (parts.length === 0) continue;
        if (parts[0] === '.monochrome') continue;
        const fileName = String(parts[parts.length - 1]).toLowerCase();
        // folder.jpg/folder.* is cover material, not user-facing audio or file
        // content. Synthetic `cover` entries are hidden for the same reason.
        if (entry.kind === 'cover' || /^folder\.(jpe?g|png|webp|avif)$/i.test(fileName)) continue;
        const title = parts.pop();
        let parent = root;
        let prefix = '';
        for (const folder of parts) {
            prefix = prefix ? `${prefix}/${folder}` : folder;
            let node = folders.get(prefix);
            if (!node) {
                node = { type: 'folder', title: folder, children: [] };
                folders.set(prefix, node);
                parent.push(node);
            }
            parent = node.children;
        }
        parent.push({
            type: trackTypeForEntry(entry),
            hash: entry.entryId,
            // Keep the host's real logical path: tree display may rewrite/merge
            // folder labels, but deletion must match entry.logical_path exactly.
            logicalPath: entry.logicalPath,
            title,
            mediaStreamUrl: mediaUrl(hostUrl, entry.mediaPath),
            mediaDownloadUrl: mediaUrl(hostUrl, entry.mediaPath),
            duration: Number(entry.duration) || Number(work.userMeta?.durations?.[entry.entryId]) || durationCache.get(entry.entryId) || 0,
            mime: entry.mime || '',
            bytes: entry.bytes,
        });
    }
    // Keep directory order stable and readable: folders first, then files.
    const sort = (nodes) => {
        nodes.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true });
        });
        for (const node of nodes) if (node.children) sort(node.children);
    };
    sort(root);
    return root;
}

function manifestEntries(work) {
    const raw = work?.userMeta?.manifest;
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    return entries.filter((entry) => entry && entry.logicalPath);
}

/**
 * Canonical source RJ of a work (docs/16 §2.3, §16.3).
 *
 * A translated edition is its own work/files, but the code shown on the card, the
 * cover badge and the grouping key must be the Japanese original's RJ. The
 * edition list already records which one is `isOriginal` (Kikoeru's
 * `translation_info.original_workno` / the `jpn` row), so we derive from it
 * instead of trusting whichever code a folder or DLsite page happens to carry:
 * DLsite's translation pages report a *sibling* translation as `sourceCode`
 * (RJ01506849 → RJ01506848), never the Japanese original.
 */
function sourceCodeFromEditions(editions) {
    const list = Array.isArray(editions) ? editions : [];
    const explicit = list.find((edition) => edition?.isOriginal)?.code;
    const japanese = list.find((edition) => String(edition?.lang || '').toLowerCase() === 'jpn')?.code;
    return String(explicit || japanese || '').toUpperCase();
}

function buildTracksFromManifest(work, hostUrl, manifestOverride = null) {
    const root = [];
    const folders = new Map();
    const entriesByPath = new Map((work.entries || []).map((entry) => [String(entry.logicalPath), entry]));
    const entriesByHash = new Map();
    for (const entry of work.entries || []) {
        if (entry.sha256 && entry.mediaPath && !entriesByHash.has(String(entry.sha256))) entriesByHash.set(String(entry.sha256), entry);
    }
    // Callers that derive a manifest from the host entries pass it explicitly;
    // re-reading `userMeta.manifest` here would throw that derivation away and
    // render an empty tree for a work with no sidecar manifest yet.
    const allManifestEntries = Array.isArray(manifestOverride) ? manifestOverride : manifestEntries(work);
    const editionCode = String(work.userMeta?.editionCode || work.source?.sourceCode || work.sourceCode || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
    const scopedEntries = editionCode && allManifestEntries.some((entry) => entry.editionCode)
        ? allManifestEntries.filter((entry) => !entry.editionCode || String(entry.editionCode).toUpperCase() === editionCode)
        : allManifestEntries;
    for (const entry of scopedEntries) {
        const parts = String(entry.logicalPath).split('/').filter(Boolean);
        if (!parts.length) continue;
        if (parts[0] === '.monochrome') continue;
        const fileName = parts[parts.length - 1].toLowerCase();
        if (/^folder\.(jpe?g|png|webp|avif)$/i.test(fileName)) continue;
        const title = parts.pop();
        let parent = root;
        let prefix = '';
        for (const folder of parts) {
            prefix = prefix ? `${prefix}/${folder}` : folder;
            let node = folders.get(prefix);
            if (!node) {
                node = { type: 'folder', title: folder, children: [] };
                folders.set(prefix, node);
                parent.push(node);
            }
            parent = node.children;
        }
        const hostEntry = entriesByPath.get(String(entry.logicalPath)) ||
            (entry.hash ? entriesByHash.get(String(entry.hash)) : null);
        const local = entry.status === 'local' && Boolean(hostEntry?.mediaPath);
        const node = {
            type: ['audio', 'video', 'image', 'text', 'subtitle', 'archive', 'link', 'file'].includes(entry.kind)
                ? entry.kind : trackTypeForEntry(hostEntry || entry),
            hash: entry.hash || hostEntry?.entryId,
            logicalPath: entry.logicalPath,
            title,
            mediaStreamUrl: local ? mediaUrl(hostUrl, hostEntry.mediaPath) : (entry.mediaStreamUrl || ''),
            mediaDownloadUrl: local ? mediaUrl(hostUrl, hostEntry.mediaPath) : (entry.mediaDownloadUrl || entry.mediaStreamUrl || ''),
            duration: Number(entry.duration) || Number(work.userMeta?.durations?.[entry.hash || hostEntry?.entryId]) || 0,
            mime: entry.mime || hostEntry?.mime || '',
            bytes: Number(entry.bytes) || hostEntry?.bytes,
            local,
            status: local ? 'local' : 'remote',
        };
        parent.push(node);
    }
    const sort = (nodes) => {
        nodes.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true });
        });
        for (const node of nodes) if (node.children) sort(node.children);
    };
    sort(root);
    return root;
}

const metadataCache = new Map();

function dlsitePageUrl(code) {
    const value = String(code || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase();
    return value ? `https://www.dlsite.com/maniax/work/=/product_id/${value}.html` : '';
}

function voiceOriginalCode(work) {
    return String(
        work?.originalCode ||
        work?.userMeta?.originalCode ||
        (Array.isArray(work?.editionCodes) ? work.editionCodes.find((edition) => edition?.isOriginal)?.code : '') ||
        (Array.isArray(work?.userMeta?.editionCodes) ? work.userMeta.editionCodes.find((edition) => edition?.isOriginal)?.code : '') ||
        work?.sourceCode ||
        work?.code ||
        ''
    ).match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
}

function dlsiteCoverUrl(code) {
    const value = String(code || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase();
    if (!value) return '';
    const number = Number(value.slice(2));
    if (!Number.isFinite(number)) return '';
    const block = String(Math.ceil(number / 1000) * 1000).padStart(8, '0');
    return `https://img.dlsite.jp/modpub/images2/work/doujin/RJ${block}/${value}_img_main.webp`;
}

function workRjCode(work) {
    const raw = String(work?.source?.sourceCode || work?.sourceCode || '');
    return raw.match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
}



async function remoteMetadataFor(work) {
    const code = workRjCode(work);
    if (!code) return null;
    if (metadataCache.has(code)) return metadataCache.get(code);
    const request = (async () => {
        const timedOptions = (timeoutMs = 8000) => {
            const options = {};
            if (typeof AbortSignal?.timeout === 'function') options.signal = AbortSignal.timeout(timeoutMs);
            return options;
        };
        // Kikoeru is a convenience cache of already-scraped metadata; DLsite is
        // the authoritative source. Try Kikoeru first with a bounded wait, then
        // fall back to DLsite when it is slow/unreachable.
        const kikoeruPromise = fetchKikoeruWork(code, timedOptions(8000)).catch((error) => {
            console.warn('Kikoeru metadata unavailable', code, error?.message || error);
            return null;
        });
        const dlsitePromise = fetchDlsiteWorkMetadata(code, timedOptions(6000)).catch((error) => {
            console.warn('DLsite metadata unavailable', code, error?.message || error);
            return null;
        });
        const kikoeru = await Promise.race([
            kikoeruPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (kikoeru?.title) {
            const dlsite = await dlsitePromise;
            return mergeVoiceMetadata(kikoeru, dlsite);
        }
        // DLsite fallback often has rating/price but no CV/tags. Do not return
        // that partial record while the richer Kikoeru request is still running:
        // wait for both and merge instead of picking whichever won the race.
        const [dlsite, lateKikoeru] = await Promise.all([dlsitePromise, kikoeruPromise]);
        return mergeVoiceMetadata(lateKikoeru, dlsite) || dlsite || lateKikoeru;
    })();
    metadataCache.set(code, request);
    return request;
}

async function persistRemoteMetadata(work, remote) {
    if (!remote?.title || work?.userMeta?.manual) return false;
    const meta = work.userMeta || {};
    const localCvs = Array.isArray(work.cvs) ? work.cvs.filter(Boolean) : [];
    const localTags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
    const localEditions = Array.isArray(meta.editionCodes) ? meta.editionCodes : [];
    const remoteCvs = Array.isArray(remote.artists) ? remote.artists.filter(Boolean) : [];
    const remoteTags = Array.isArray(remote.tags) ? remote.tags.filter(Boolean) : [];
    const remoteEditions = Array.isArray(remote.editionCodes) ? remote.editionCodes : [];
    const patch = {
        title: remote.title || work.userTitle || work.title,
        circle: remote.trueCircle || remote.circle || ((remote.translators || []).length ? '' : work.circle || ''),
        // Persist the identity behind the display circle: `circle` alone loses
        // the original circle of a translated edition (asmr.one puts the
        // translator there), and every later metadata fetch would have to
        // re-derive it from the network.
        trueCircle: remote.trueCircle || meta.trueCircle || '',
        translators: voiceTranslatorList(remote).length ? voiceTranslatorList(remote) : voiceTranslatorList(meta),
        // A DLsite-only fallback has no CV/tags. Never let that partial fetch
        // erase the richer Kikoeru data already persisted in the host.
        cvs: remoteCvs.length ? remoteCvs : localCvs,
        tags: remoteTags.length ? remoteTags : localTags,
        rating: Number(remote.rating) || Number(meta.rating) || 0,
        ratingCount: Number(remote.ratingCount) || Number(meta.ratingCount) || 0,
        release: remote.release || meta.release || '',
        price: Number(remote.price) || Number(meta.price) || 0,
        currency: remote.currency || meta.currency || 'JPY',
        ageCategory: remote.ageCategory && remote.ageCategory !== 'unrated'
            ? remote.ageCategory
            : meta.ageCategory || remote.ageCategory || 'unrated',
        nsfw: Boolean(remote.nsfw || meta.nsfw),
        sourceCode: remote.sourceCode || '',
        editionLang: remote.editionLang || '',
        editionLabel: remote.editionLabel || '',
        editionCodes: remoteEditions.length ? remoteEditions : localEditions,
        sourceUrl: remote.sourceUrl || meta.sourceUrl || dlsitePageUrl(remote.sourceCode || work.source?.sourceCode),
        pageUrl: remote.pageUrl || meta.pageUrl || dlsitePageUrl(remote.sourceCode || work.source?.sourceCode),
    };
    const same =
        String(work.userTitle || work.title || '') === String(patch.title || '') &&
        String(work.circle || '') === patch.circle &&
        String(meta.trueCircle || '') === patch.trueCircle &&
        JSON.stringify(meta.translators || []) === JSON.stringify(patch.translators) &&
        JSON.stringify(work.cvs || []) === JSON.stringify(patch.cvs) &&
        JSON.stringify(meta.tags || []) === JSON.stringify(patch.tags) &&
        Number(meta.rating || 0) === patch.rating &&
        Number(meta.ratingCount || 0) === patch.ratingCount &&
        String(meta.release || '') === patch.release &&
        Number(meta.price || 0) === patch.price &&
        String(meta.currency || 'JPY') === patch.currency &&
        String(meta.ageCategory || 'unrated') === patch.ageCategory &&
        Boolean(meta.nsfw) === patch.nsfw &&
        String(meta.sourceCode || '') === patch.sourceCode &&
        String(meta.editionLang || '') === patch.editionLang &&
        String(meta.editionLabel || '') === patch.editionLabel &&
        JSON.stringify(meta.editionCodes || []) === JSON.stringify(patch.editionCodes);
    if (same) return false;
    await api('/api/works/metadata', { workId: work.workId, metadata: patch });
    return true;
}

function toVoiceWork(work, hostUrl, remote = null) {
    const localCode = work.source?.sourceCode || work.workId;
    const userMeta = work.userMeta && typeof work.userMeta === 'object' ? work.userMeta : {};
    // Rule (docs/16 §16.3): the displayed/grouping RJ is always the Japanese
    // source work, never the edition a folder happens to be named after. A folder
    // imported as `[RJ01506849] ... 简体中文版` carries that code as its identity,
    // but `editionCodes` already knows RJ01497456 is `isOriginal`; using the
    // folder code made the card show the translation number and split one work
    // into two cards.
    const editionCandidates = [...(userMeta.editionCodes || remote?.editionCodes || [])];
    const sourceCode = sourceCodeFromEditions(editionCandidates)
        || userMeta.sourceCode
        || remote?.sourceCode
        || remote?.code
        || localCode;
    const editionCode = localCode;
    const editionCodes = editionCandidates;
    if (editionCode && !editionCodes.some((edition) => String(edition.code || '').toUpperCase() === String(editionCode).toUpperCase())) {
        editionCodes.push({ code: editionCode, lang: userMeta.editionLang || remote?.editionLang || '', label: userMeta.editionLabel || remote?.editionLabel || '', isOriginal: false });
    }
    const localArtists = Array.isArray(work.cvs) ? work.cvs : [];
    const artists = localArtists.length
        ? localArtists
        : Array.isArray(userMeta.artists) && userMeta.artists.length
            ? userMeta.artists
            : Array.isArray(remote?.artists) ? remote.artists : [];
    // CVs have their own creator rows; do not duplicate them into normal tags.
    const tags = [...new Set(userMeta.tags?.length ? userMeta.tags : remote?.tags || [])];
    const created = work.createdAt || new Date().toISOString();
    const localCover = work.coverMediaPath ? mediaUrl(hostUrl, work.coverMediaPath) : undefined;
    // The cover on disk wins over a remote URL. The remote one is a DLsite CDN
    // link that hotlink protection can refuse at any time, and the record in the
    // library is exactly the copy the user already has — preferring the network
    // left the album header blank whenever that request failed.
    const cover = localCover || remote?.cover;
    // The host's `entries` are the files that are actually on disk in the user's
    // folder, so they are authoritative when no sidecar manifest has been written
    // yet (a fresh folder upload, or any host that only indexes files). Without
    // this fallback every row of a just-imported local work was classified as
    // remote and the card lost its full/partial local badge.
    const storedManifest = manifestEntries(work);
    const manifest = storedManifest.length ? storedManifest : (manifestFromHostWork(work)?.entries || []);
    const localTracks = manifest.length ? buildTracksFromManifest(work, hostUrl, manifest) : buildTracks(work, hostUrl);
    const localManifestCount = manifest.filter((entry) => entry.status === 'local').length;
    const manifestLocalState = manifest.length
        ? (localManifestCount === manifest.length ? 'full' : localManifestCount > 0 ? 'partial' : '')
        : undefined;
    const hasLocalSubtitle = (work.entries || []).some((entry) => entry.kind === 'subtitle');
    const publicCode = String(localCode).startsWith('local:')
        ? `local-${String(localCode).slice(6).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'work'}`
        : String(localCode).replace(/^voice-/, '');
    // A translated host may store the Japanese source title in userTitle while
    // the canonical sidecar title carries 【简体中文版】. Prefer the explicitly
    // localized title so a partial card cannot inherit the Japanese title.
    const titleCandidates = [work.userTitle, remote?.title, work.title].filter(Boolean);
    const localizedTitle = titleCandidates.find((title) => /简体|简中|繁体|繁體|中文版/.test(String(title))) || '';
    const localizedLang = localizedTitle
        ? (/繁體|繁体/.test(localizedTitle) ? 'chi_hant' : 'chi_hans')
        : '';
    return {
        id: `voice-${publicCode}`,
        code: editionCode,
        sourceCode,
        title: localizedTitle || work.userTitle || remote?.title || work.title,
        circle: work.circle || remote?.circle || '本地文件',
        // `circle` may carry the translator of a translated edition (asmr.one),
        // so the original circle must come from trueCircle only. Falling back to
        // `work.circle` here is what put 漁貓 in the circle facet.
        trueCircle: work.trueCircle || userMeta.trueCircle || '',
        artists,
        tags,
        rating: Number(userMeta.rating) || Number(remote?.rating) || 0,
        ratingCount: Number(userMeta.ratingCount) || Number(remote?.ratingCount) || 0,
        reviewCount: Number(remote?.reviewCount) || 0,
        soldCount: Number(remote?.soldCount) || 0,
        sourceUrl: remote?.sourceUrl || work.userMeta?.sourceUrl || dlsitePageUrl(sourceCode),
        pageUrl: remote?.pageUrl || work.userMeta?.pageUrl || dlsitePageUrl(sourceCode),
        price: Number(userMeta.price ?? remote?.price) || 0,
        currency: userMeta.currency || remote?.currency || 'JPY',
        duration: Number(remote?.duration) || totalTrackDuration(localTracks),
        release: userMeta.release || remote?.release || created.slice(0, 10),
        importedAt: created,
        ageCategory: userMeta.ageCategory && userMeta.ageCategory !== 'unrated'
            ? userMeta.ageCategory
            : remote?.ageCategory || userMeta.ageCategory || 'unrated',
        nsfw: Boolean(userMeta.nsfw || remote?.nsfw),
        editionLang: localizedLang || userMeta.editionLang || remote?.editionLang || '',
        editionLabel: userMeta.editionLabel || remote?.editionLabel || '',
        editionCodes,
        translators: Array.isArray(userMeta.translators) ? userMeta.translators : [],
        has_subtitle: Boolean(remote?.hasSubtitle || hasLocalSubtitle),
        hasSubtitle: Boolean(remote?.hasSubtitle || hasLocalSubtitle),
        cover,
        hasLocalCover: Boolean(work.coverMediaPath),
        tracks: localTracks,
        fileStorage: true,
        // Host keeps a tombstone for files removed from the library so the card
        // can stay partial instead of reverting to a misleading full badge.
        // `userMeta.partial` wins over the manifest: importVoicePlan writes it
        // when it could not enumerate the online tree, and in that case an
        // all-local manifest would otherwise look "complete" and hide the
        // missing remote tracks.
        localFileStorageState: userMeta.partial
            ? 'partial'
            : manifestLocalState !== undefined ? manifestLocalState : undefined,
        // Whether the manifest came from the sidecar / user_meta rather than
        // being guessed from the host entries. voices.js needs this to tell a
        // verified work from one whose completeness is simply unknown.
        hasStoredManifest: storedManifest.length > 0,
        manifest,
        // Sidecar manifest entries know the local/alias status but not the
        // signed media path; keep the host entries so an online card can
        // resolve its local rows against the same work.
        entries: Array.isArray(work.entries) ? work.entries : [],
        storageWorkId: work.workId,
        storageKind: 'host',
        presentationMode: userMeta.partial || manifestLocalState === 'partial'
            ? 'partial'
            : manifestLocalState === 'full'
                ? 'local'
                : Number(localManifestCount) > 0
                    ? 'partial'
                    : 'online',
        storageOwner: work.workId,
        hostUrl,
    };
}

function entryForTrack(works, workId, hash) {
    const wanted = String(workId || '').replace(/^voice-/, '');
    const requested = String(workId || '');
    const work = works.find((entry) => entry.workId === wanted || entry.workId === requested) ||
        (globalThis.__monochromeFileStorageWorks || []).find((entry) => entry.id === requested || entry.storageWorkId === wanted);
    if (!work) return null;
    return (work.entries || []).find((entry) => entry.entryId === hash)
        || (work.entries || []).find((entry) => entry.sha256 === hash && entry.mediaPath)
        || null;
}

/**
 * Resolve a file-library track against the current sidecar. Queue entries keep
 * stable voiceWorkId/voiceHash; signed media URLs expire, so resolve at play time.
 */
export async function resolveTrackUrl(workId, hash) {
    if ((typeof invoke !== 'function' && state.mode !== 'web') || !workId || !hash) return null;
    const load = async () => {
        await syncHostFromTauri();
        await ensureHost();
        const response = await api('/api/works');
        const entry = entryForTrack(response.result?.works || [], workId, hash);
        return entry?.mediaPath ? `${state.url}${entry.mediaPath}` : null;
    };
    try {
        return await load();
    } catch (error) {
        // Another window may have restarted the sidecar on a new port. Rebind once.
        console.warn('file storage URL resolve failed; restarting sidecar', error);
        state.url = null;
        state.token = null;
        return await load().catch(() => null);
    }
}

export async function isFileWorkAsync(workId) {
    // Queue restore can race the first /api/works response. Known-remote tracks
    // skip this call entirely; only unknown (legacy) tracks wait.
    if (!readySettled) {
        const outcome = await Promise.race([
            readyPromise.then(() => 'ready'),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
        ]);
        if (outcome === 'timeout') return 'unknown';
    }
    return isFileWork(workId) ? 'file' : 'remote';
}

export function isFileWork(workId) {
    if (!workId) return false;
    const works = globalThis.__monochromeFileStorageWorks || [];
    return works.some((work) => work.id === workId || work.storageWorkId === workId || work.storageWorkId === String(workId).replace(/^voice-/, ''));
}

export async function resolveCoverUrl(workId) {
    if ((typeof invoke !== 'function' && state.mode !== 'web') || !workId) return null;
    const load = async () => {
        await syncHostFromTauri();
        await ensureHost();
        const response = await api('/api/works');
        const works = response.result?.works || [];
        const wanted = String(workId).replace(/^voice-/, '');
        const work = works.find((entry) => entry.workId === wanted || entry.workId === String(workId));
        return work?.coverMediaPath ? `${state.url}${work.coverMediaPath}` : null;
    };
    try {
        return await load();
    } catch {
        state.url = null;
        state.token = null;
        return await load().catch(() => null);
    }
}

async function refresh({ silent = false } = {}) {
    await syncHostFromTauri();
    if (!state.url) return 0;
    const response = await api('/api/works');
    const hostWorks = response.result?.works || [];
    const signature = JSON.stringify(hostWorks.map((work) => [work.workId, work.revision, work.updatedAt]));
    if (silent && signature === state.worksSignature) return 0;
    state.worksSignature = signature;
    const localMapped = hostWorks.map((work) => toVoiceWork(work, state.url)).filter((work) => work.tracks.length > 0);
    // Prune the online download journal for every host work, including works
    // with zero remaining tracks. Otherwise a deleted/never-downloaded row can
    // keep a stale local hash and hide its remote badge.
    for (const hostWork of hostWorks) {
        const hashes = new Set();
        for (const entry of hostWork.entries || []) if (entry.sha256) hashes.add(String(entry.sha256));
        const manifest = Array.isArray(hostWork.userMeta?.manifest)
            ? hostWork.userMeta.manifest
            : Array.isArray(hostWork.userMeta?.manifest?.entries) ? hostWork.userMeta.manifest.entries : [];
        for (const entry of manifest) if (entry.status === 'local' && entry.hash) hashes.add(String(entry.hash));
        const sourceCode = String(hostWork.source?.sourceCode || hostWork.userMeta?.sourceCode || '').toUpperCase();
        const keys = [hostWork.workId, `voice-${sourceCode}`, sourceCode].filter(Boolean);
        for (const key of keys) pruneVoiceDownloadHashes(key, hashes);
    }
    const count = mergeFileStorageWorks(localMapped);
    void hydrateLocalDurations(localMapped, hostWorks);
    // Count what the grid shows, not the raw row count. `/api/works` can still
    // return rows whose folder is gone (an import whose directory was removed
    // outside the app); the merge above drops those, so counting `hostWorks.length`
    // printed "3 个作品" above a grid that said "显示 2 / 2".
    const storageCount = count;
    setStatus(storageCount ? `文件库 · ${storageCount} 个作品` : '文件库 · 空');
    // Remote metadata is an import-time snapshot, persisted in host user_meta.
    // Startup refresh must not refetch every work (expensive and can overwrite
    // manually corrected/imported metadata with a partial fallback).
    return count;
}

function startWorksPolling() {
    if (state.pollTimer) return;
    // The host is authoritative and may be changed by another window, the Tauri
    // import flow, or the CLI. Keep the browser UI in sync without a reload.
    state.pollTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        refresh({ silent: true }).catch(() => {});
    }, 5000);
}

async function syncHostFromTauri() {
    if (state.mode === 'web' || typeof invoke !== 'function') return false;
    try {
        const status = await invoke('storage_status');
        if (status?.running && status.url && status.token) {
            state.url = status.url;
            state.token = status.token;
            return true;
        }
    } catch {
        /* command unavailable in non-Tauri contexts */
    }
    return false;
}

async function ensureHost() {
    if (state.mode === 'web') return state.url;
    if (state.starting) return state.starting;
    state.starting = (async () => {
        if (state.url) return state.url;
        const startup = await startHost(null);
        return startup.url;
    })();
    try {
        return await state.starting;
    } finally {
        state.starting = null;
    }
}

export async function importPath(source) {
    if (!source) return 0;
    setStatus('导入中…');
    try {
        await startHost(source);
        const previewResponse = await api('/api/scan', {});
        const candidates = (previewResponse.result?.candidates || []).filter(
            (candidate) => (candidate.entries || []).length > 0 || Number(candidate.counts?.entries) > 0,
        );
        if (candidates.length === 0) {
            // The host restarted on the new source; refresh so existing cards use
            // the current dynamic media port before reporting the empty scan.
            await refresh();
            setStatus('未找到可导入作品', true);
            return 0;
        }
        const importResponse = await api('/api/import', {
            candidateIds: candidates.map((candidate) => candidate.candidateId),
        });
        const imported = Number(importResponse.result?.imported) || 0;
        const failed = Number(importResponse.result?.failed) || 0;
        const count = await refresh();
        if (imported === 0) {
            setStatus(`本次导入 0 个${failed ? `，失败 ${failed} 个` : ''}`, true);
        } else if (failed > 0) {
            setStatus(`本次导入 ${imported} 个，失败 ${failed} 个`, true);
        } else {
            setStatus(`本次导入 ${imported} 个 · 文件库 ${count} 个作品`);
        }
        return imported;
    } catch (error) {
        console.error('file storage import failed', error);
        // A failed scan/import can still have changed the host port; keep existing
        // cards playable by resolving them against the current host.
        await refresh().catch(() => {});
        setStatus(`导入失败: ${error?.message || error}`, true);
        throw error;
    }
}

async function pickAndImport() {
    if (typeof invoke !== 'function') return;
    const source = await invoke('pick_source_folder');
    if (!source) return;
    await importPath(source);
}

function bindMediaRefresh() {
    const audio = document.getElementById('audio-player');
    if (!audio || audio.dataset.fileStorageRefreshBound === 'true') return;
    audio.dataset.fileStorageRefreshBound = 'true';
    const refresh = async () => {
        const track = Player.instance?.currentTrack;
        if (!track?.voiceWorkId || !track.voiceHash || state.resolving) return;
        if (track.fileStorage === false) return;
        if (track.fileStorage !== true) {
            if (!isFileWork(track.voiceWorkId)) return;
            track.fileStorage = true;
        }
        if (Date.now() - Number(track._fileResolvedAt || 0) < 60_000) return;
        const requestedId = track.id;
        const sequence = Player.instance.playbackSequence;
        state.resolving = true;
        try {
            const fresh = await resolveTrackUrl(track.voiceWorkId, track.voiceHash);
            // The user may have switched tracks while the resolver was in flight.
            if (
                !fresh ||
                Player.instance.currentTrack?.id !== requestedId ||
                Player.instance.playbackSequence !== sequence ||
                Player.instance.activeElement !== audio ||
                fresh === audio.currentSrc ||
                fresh === audio.src
            ) {
                return;
            }
            const time = audio.currentTime;
            const wasPlaying = !audio.paused;
            track._fileResolvedAt = Date.now();
            track.audioUrl = fresh;
            audio.src = fresh;
            audio.load();
            audio.addEventListener(
                'loadedmetadata',
                () => {
                    if (
                        Player.instance.currentTrack?.id !== requestedId ||
                        Player.instance.playbackSequence !== sequence ||
                        Player.instance.activeElement !== audio ||
                        (audio.currentSrc || audio.src) !== fresh
                    ) {
                        return;
                    }
                    try {
                        audio.currentTime = Math.min(time, audio.duration || time);
                    } catch {
                        /* metadata may already be gone */
                    }
                    if (wasPlaying) void audio.play().catch(() => {});
                },
                { once: true }
            );
        } catch (error) {
            console.warn('file storage media refresh failed', error);
        } finally {
            state.resolving = false;
        }
    };
    audio.addEventListener('play', refresh);
    audio.addEventListener('seeking', refresh);
}

const BROWSER_AUDIO_RE = /\.(wav|mp3|flac|m4a|aac|ogg|opus|aiff?|wma|webm|mp4)$/i;

function browserWorkFromFiles(files) {
    const list = [...(files || [])];
    const audio = list.filter((file) => BROWSER_AUDIO_RE.test(file.name));
    if (audio.length === 0) return null;
    const firstPath = list.find((file) => file.webkitRelativePath)?.webkitRelativePath || '';
    const rootName = firstPath ? firstPath.split('/')[0] : '本地音声';
    const code = rootName.match(/RJ\d{5,8}/i)?.[0] || '';
    const cover = list.find((file) => /^image\//.test(file.type));
    const importedAt = new Date().toISOString();
    const workId = `voice-web-${Date.now()}`;
    const tracks = [{
        type: 'folder',
        title: '音声本体',
        children: audio.map((file, index) => {
            const objectUrl = URL.createObjectURL(file);
            return {
                type: 'audio',
                hash: `web-${Date.now()}-${index}`,
                title: file.name,
                mediaStreamUrl: objectUrl,
                mediaDownloadUrl: objectUrl,
                duration: 0,
                mime: file.type || '',
            };
        }),
    }];
    return {
        id: workId,
        code: code || 'LOCAL',
        sourceCode: code,
        title: rootName,
        circle: '本地文件',
        trueCircle: '本地文件',
        artists: [],
        tags: [],
        rating: 0,
        duration: 0,
        release: importedAt.slice(0, 10),
        importedAt,
        ageCategory: 'unrated',
        nsfw: false,
        has_subtitle: false,
        hasSubtitle: false,
        cover: cover ? URL.createObjectURL(cover) : undefined,
        tracks,
        browserLocal: true,
    };
}

function createFolderInput() {
    const input = document.createElement('input');
    input.id = 'web-local-input';
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.hidden = true;
    document.body.append(input);
    return input;
}

function setupBrowserLocalImport(button, status) {
    const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
    status.textContent = zh ? '本地文件库' : 'Local file library';
    status.dataset.state = 'idle';
    const input = createFolderInput();
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        const work = browserWorkFromFiles(input.files);
        input.value = '';
        if (!work) {
            status.textContent = zh ? '没有找到音频文件' : 'No audio files found';
            status.dataset.state = 'error';
            return;
        }
        mergeBrowserLocalWorks([work]);
        status.textContent = zh
            ? `本地作品 · ${work.tracks[0].children.length} 个音频`
            : `Local work · ${work.tracks[0].children.length} tracks`;
        status.dataset.state = 'ready';
    });
}

const IMPORT_BATCH_STORAGE_KEY = 'monochrome-import-batch-v1';

async function waitForImportBatch(batchId) {
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
        const response = await api(`/api/import/status?batchId=${encodeURIComponent(batchId)}`);
        const progress = response.result || response;
        const current = Number(progress.currentCandidate) || 0;
        const total = Number(progress.totalCandidates) || 0;
        const detail = progress.message ? ` · ${progress.message}` : '';
        if (current || total) setStatus(`导入中… ${current}/${total}${detail}`);
        if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(String(progress.status))) return progress;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('import batch timed out');
}

function reportImportProgress(progress, count) {
    const imported = Number(progress.imported) || 0;
    const updated = Number(progress.updated) || 0;
    const skipped = Number(progress.skipped) || 0;
    const failed = Number(progress.failed) || 0;
    if (progress.status === 'interrupted') {
        setStatus(`导入任务被中断 · 文件库 ${count} 个作品`, true);
        return;
    }
    const addedText = imported > 0 ? `新增 ${imported} 个` : '';
    const updatedText = updated > 0 ? `更新 ${updated} 个` : '';
    const skippedText = skipped > 0 ? `跳过 ${skipped} 个` : '';
    const failedText = failed > 0 ? `失败 ${failed} 个` : '';
    const parts = [addedText, updatedText, skippedText, failedText].filter(Boolean);
    if (parts.length > 0) {
        setStatus(`本次导入 ${parts.join('，')} · 文件库 ${count} 个作品`, failed > 0);
    } else {
        setStatus(`没有可导入的作品 · 文件库 ${count} 个作品`, true);
    }
}

async function resumeImportBatch() {
    let batchId = null;
    try {
        batchId = localStorage.getItem(IMPORT_BATCH_STORAGE_KEY);
    } catch {
        return;
    }
    if (!batchId) return;
    try {
        const progress = await waitForImportBatch(batchId);
        const count = await refresh();
        reportImportProgress(progress, count);
    } catch {
        /* stale/corrupt batch id; drop it below */
    } finally {
        try {
            localStorage.removeItem(IMPORT_BATCH_STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }
}

function manifestFromHostWork(work) {
    const entries = [];
    for (const entry of work?.entries || []) {
        if (!entry.mediaPath || !entry.logicalPath) continue;
        const parts = String(entry.logicalPath).split('/').filter(Boolean);
        if (parts[0] === '.monochrome') continue;
        const fileName = parts[parts.length - 1].toLowerCase();
        if (entry.kind === 'cover' || /^folder\.(jpe?g|png|webp|avif)$/i.test(fileName)) continue;
        entries.push({
            logicalPath: entry.logicalPath,
            title: String(entry.logicalPath).split('/').pop(),
            kind: entry.kind || 'file',
            hash: entry.entryId || '',
            status: 'local',
            mediaStreamUrl: mediaUrl(state.url, entry.mediaPath),
            mediaDownloadUrl: mediaUrl(state.url, entry.mediaPath),
            duration: Number(entry.duration) || Number(work.userMeta?.durations?.[entry.entryId]) || 0,
            mime: entry.mime || '',
            bytes: Number(entry.bytes) || 0,
        });
    }
    return entries.length ? { version: 1, generatedAt: new Date().toISOString(), entries } : null;
}

async function hydrateHostMetadataForCandidates(candidates) {
    const codes = new Set();
    for (const candidate of candidates || []) {
        // `sourceCode` is a first-class scan field. Deriving the code only from
        // the path/title missed every folder whose display title drops the
        // `[RJ…]` prefix (the scanner's cleanFolderTitle does exactly that), and
        // metadata + the local manifest were then never written for a work the
        // user had just imported from disk.
        const raw = `${candidate.sourceCode || ''} ${candidate.relativeRoot || ''} ${candidate.candidateId || ''} ${candidate.folderTitle || ''}`;
        const code = raw.match(/RJ\d{5,8}/i)?.[0]?.toUpperCase();
        if (code) codes.add(code);
    }
    if (!codes.size) return 0;
    // Compare by code *sets*, not one primary code: a translated work keeps the
    // original RJ in `userMeta.sourceCode` while its root folder is named after
    // the edition (`RJ01706655` vs `RJ01682626`). Single-value matching skipped
    // the whole hydration pass for exactly those works, so the cover,
    // manifest and sidecar were never written.
    const candidateWork = { editionCodes: [...codes].map((code) => ({ code })) };
    const hostWorks = (await api('/api/works')).result?.works || [];
    let updated = 0;
    // Works this hydration pass is responsible for. The second pass below must
    // not touch unrelated works whose folder code was never in `codes`.
    const workIds = new Set();
    for (const work of hostWorks) {
        const meta = work.userMeta || {};
        if (!voiceCodesOverlapHost(work, candidateWork)) continue;
        const workCode = workRjCode(work) || String(meta.sourceCode || '').toUpperCase();
        workIds.add(work.workId);
        const needsMetadata = !(work.cvs?.length && meta.tags?.length && meta.release);
        const remote = await remoteMetadataFor(work);
        if (needsMetadata && remote && (await persistRemoteMetadata(work, remote))) updated += 1;
        // Always prefer the source cover at import time, even when the folder
        // already has some image; never let an arbitrary first image win.
        // DLsite's CDN filename is deterministic when og:image was unavailable.
        const coverUrl = remote?.cover || dlsiteCoverUrl(workCode);
        if (coverUrl) {
            try {
                await api('/api/works/cover', { workId: work.workId, url: coverUrl });
                updated += 1;
            } catch (error) {
                console.warn('cover cache skipped:', error?.message || error);
            }
        }
        if (!meta.manifest) {
            const manifest = manifestFromHostWork(work);
            if (manifest) {
                await api('/api/works/metadata', { workId: work.workId, metadata: { manifest } }).catch(() => {});
                updated += 1;
            }
        }
    }
    if (updated > 0) await refresh({ silent: true });
    // Second pass: a translated work stored its folder's edition code as
    // `userMeta.sourceCode` (`[RJ01506849] … 简体中文版`). Docs/16 §2.3 requires the
    // Japanese source RJ there too, but the edition list only exists after the
    // first pass wrote it, so this must re-read the host instead of reusing the
    // snapshot taken above.
    const afterWrite = (await api('/api/works')).result?.works || [];
    for (const work of afterWrite) {
        if (!workIds.has(work.workId)) continue;
        const meta = work.userMeta || {};
        // Manual identity wins (docs/16 §7): only corrected values are automatic.
        if (meta.manual) continue;
        const canonical = sourceCodeFromEditions(meta.editionCodes);
        const stored = String(meta.sourceCode || '').toUpperCase();
        if (!canonical || !stored || canonical === stored) continue;
        try {
            await api('/api/works/metadata', { workId: work.workId, metadata: { sourceCode: canonical } });
            updated += 1;
        } catch (error) {
            console.warn('source code correction skipped:', error?.message || error);
        }
    }
    return updated;
}

async function importWebCandidates(candidates, { hydrateMetadata = true } = {}) {
    const batchId = `web:${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
        localStorage.setItem(IMPORT_BATCH_STORAGE_KEY, batchId);
    } catch {
        /* private mode */
    }
    try {
        await api('/api/import', {
            candidateIds: candidates.map((candidate) => candidate.candidateId),
            batchId,
            async: true,
        });
    } catch (error) {
        try {
            localStorage.removeItem(IMPORT_BATCH_STORAGE_KEY);
        } catch {
            /* ignore */
        }
        throw error;
    }
    const progress = await waitForImportBatch(batchId);
    if (hydrateMetadata) await hydrateHostMetadataForCandidates(candidates);
    const count = await refresh();
    reportImportProgress(progress, count);
    try {
        localStorage.removeItem(IMPORT_BATCH_STORAGE_KEY);
    } catch {
        /* ignore */
    }
    return (Number(progress.imported) || 0) + (Number(progress.updated) || 0);
}

async function scanServerSource() {
    setStatus('扫描服务端源目录…');
    const preview = await api('/api/scan', { mode: 'batch' });
    let candidates = (preview.result?.candidates || []).filter(
        (candidate) => (candidate.entries || []).length > 0 || Number(candidate.counts?.entries) > 0,
    );
    // A source root can itself appear as a fallback candidate while also containing
    // separate work folders. Prefer the nested work boundaries; never import the
    // container as a second work.
    const nested = candidates.filter((candidate) => {
        const root = String(candidate.relativeRoot || candidate.candidateId?.replace(/^local:/, '') || '.');
        return root !== '.' && root !== '';
    });
    if (nested.length > 0) candidates = nested;
    if (candidates.length === 0) {
        await refresh();
        setStatus('服务端源目录没有可导入作品', true);
        return 0;
    }
    setStatus(`发现 ${candidates.length} 个作品，导入中…`);
    return importWebCandidates(candidates);
}

const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_IGNORED_RE = /^(desktop\.ini|thumbs\.db|\.ds_store|@folder-icon.*\.ico)$/i;
// A chunk failing says nothing about the file: the loopback connect can time out
// while the host is mid-import, the dev proxy can restart, an antivirus scan can
// stall a write. Losing a 600 MB file — and with it the whole folder — to that is
// unacceptable, so each chunk retries with backoff and, when the host reports the
// file is shorter than we thought, resumes from the size it reports.
const UPLOAD_MAX_ATTEMPTS = 6;
const UPLOAD_RETRY_BASE_MS = 400;
const uploadDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonicalUploadRoot(originalRoot) {
    const source = String(originalRoot || '').trim();
    const code = source.match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
    if (!code) return source;
    let title = source;
    if (title.startsWith('[')) {
        const close = title.indexOf(']');
        if (close > 0) title = title.slice(close + 1);
    } else if (title.toUpperCase().startsWith(code)) {
        title = title.slice(code.length);
    }
    title = title.replace(/^[s._-]+/, '').replace(/[\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').trim();
    return `[${code}] ${title || 'work'}`;
}

async function uploadAndImport(files) {
    const list = [...files].filter((file) =>
        file && file.size > 0 && !UPLOAD_IGNORED_RE.test(file.name),
    );
    if (list.length === 0) {
        setStatus('没有找到可上传的音频或图片文件', true);
        return 0;
    }
    const firstPath = list.find((file) => file.webkitRelativePath)?.webkitRelativePath || '';
    const originalRoot = firstPath ? firstPath.split('/')[0] : '';
    const uploadRoot = canonicalUploadRoot(originalRoot);
    setStatus(`上传中… 0/${list.length}`);
    for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        const sourceRelative = file.webkitRelativePath || file.name;
        const relative = originalRoot && uploadRoot !== originalRoot
            ? uploadRoot + sourceRelative.slice(originalRoot.length)
            : sourceRelative;
        let offset = 0;
        let attempts = 0;
        while (offset < file.size) {
            const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
            let response = null;
            let failure = null;
            try {
                response = await nativeFetch(`${state.url}/api/upload`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': file.type || 'application/octet-stream',
                        'X-Relative-Path': encodeURIComponent(relative),
                        'X-Upload-Offset': String(offset),
                        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
                    },
                    // Send the slice as a Blob, not `arrayBuffer()`: a Blob stays a
                    // handle to the file and the browser streams it from disk, so the
                    // tab never holds an 8 MiB copy. Small chunks keep the request
                    // below both the Chromium large-body abort and the Node request
                    // buffer; the server appends at X-Upload-Offset.
                    body: file.slice(offset, end),
                });
            } catch (error) {
                // fetch rejects only on transport failure (reset, timeout, refused).
                failure = error;
            }
            if (response?.ok) {
                // Drain the (tiny) response body. An unread response keeps its body
                // stream — and the request it came from — alive until GC; a 2.4 GB
                // folder is ~300 chunks, and that retention is what ran the tab out
                // of memory.
                await response.arrayBuffer().catch(() => {});
                offset = end;
                attempts = 0;
                setStatus(`上传中… ${index + 1}/${list.length} · ${Math.round((end / file.size) * 100)}%`);
                continue;
            }
            if (response) {
                const json = await response.json().catch(() => ({}));
                const size = Number(json?.size);
                if (response.status === 409 && Number.isFinite(size)) {
                    // The host appends at an exact offset, so it tells us the real
                    // size when they disagree. Resume from there instead of
                    // re-sending what it already has.
                    if (size > offset && size <= end) {
                        offset = size;
                        attempts = 0;
                        continue;
                    }
                    if (size === 0 && offset > 0) {
                        offset = 0;
                        attempts = 0;
                        continue;
                    }
                }
                failure = new Error(json?.error?.message || `upload failed: ${response.status}`);
                // Any other 4xx is this file's own problem (bad path, oversize):
                // retrying cannot change the answer, so fail now and say why.
                if (response.status < 500 && response.status !== 409) throw failure;
            }
            attempts += 1;
            if (attempts > UPLOAD_MAX_ATTEMPTS) {
                throw new Error(`上传中断（${relative}）：${failure?.message || failure}`);
            }
            setStatus(`重试中… ${index + 1}/${list.length}（第 ${attempts}/${UPLOAD_MAX_ATTEMPTS} 次）`, true);
            await uploadDelay(UPLOAD_RETRY_BASE_MS * 2 ** (attempts - 1));
        }
        setStatus(`上传中… ${index + 1}/${list.length}`);
    }
    setStatus('扫描中…');
    // Upload is a deliberate single-work selection: scan only the selected
    // folder as the candidate root. Batch/source-root discovery is reserved for
    // the separate "scan server source" flow.
    const preview = await api('/api/scan', {
        mode: 'single',
        ...(uploadRoot ? { relativeRoot: uploadRoot } : {}),
    });
    let candidates = (preview.result?.candidates || []).filter(
        (candidate) => (candidate.entries || []).length > 0 || Number(candidate.counts?.entries) > 0,
    );
    if (uploadRoot) {
        const prefix = `${uploadRoot}/`;
        const scoped = candidates.filter((candidate) =>
            (candidate.entries || []).some((entry) => String(entry.logicalPath || '').startsWith(prefix)),
        );
        if (scoped.length > 0) candidates = scoped;
    }
    if (candidates.length === 0) {
        await refresh();
        setStatus('没有找到可导入的音频文件夹', true);
        return 0;
    }
    return importWebCandidates(candidates);
}

function setupWebBackend(button, status) {
    const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
    button.textContent = zh ? '选择本地文件夹' : 'Choose folder';
    button.title = zh ? '选择本地文件夹并上传到 storage 服务端' : 'Choose a folder and upload it to the storage server';
    const scan = document.getElementById('file-storage-scan');
    if (scan) {
        scan.hidden = false;
        scan.textContent = zh ? '扫描服务端源目录' : 'Scan server source';
        scan.addEventListener('click', () => {
            scanServerSource().catch((error) => {
                console.error('web storage source scan failed', error);
                setStatus(`扫描失败: ${error?.message || error}`, true);
            });
        });
    }
    const input = createFolderInput();
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        const files = [...input.files];
        // Keep the FileList referenced until every chunk has been read. Clearing
        // the input before large async reads can invalidate lazy file handles in
        // Chromium and surfaces as "The requested file could not be read".
        uploadAndImport(files)
            .catch((error) => {
                console.error('web storage upload failed', error);
                setStatus(`导入失败: ${error?.message || error}`, true);
            })
            .finally(() => {
                input.value = '';
            });
    });
    status.dataset.state = 'ready';
}

function positionImportTail() {
    const panel = document.getElementById('voices-import-panel');
    const button = document.getElementById('voices-import-toggle');
    const tail = document.getElementById('voices-import-tail');
    if (!panel || !button || !tail || panel.hidden) return;
    const p = panel.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    if (!p.width || !b.width) return;
    const size = Math.max(20, Math.min(26, Math.round(b.height * 0.5)));
    const center = b.left + b.width / 2 - p.left - (panel.clientLeft || 0);
    const left = Math.max(10, Math.min(p.width - size - 10, center - size / 2));
    tail.style.setProperty('--bubble-tail-size', `${size}px`);
    tail.style.left = `${left}px`;
}

function bindImportTail() {
    const panel = document.getElementById('voices-import-panel');
    const button = document.getElementById('voices-import-toggle');
    if (!panel || !button || panel.dataset.importTailBound === 'true') return;
    panel.dataset.importTailBound = 'true';
    const reposition = () => requestAnimationFrame(positionImportTail);
    button.addEventListener('click', reposition);
    window.addEventListener('resize', reposition);
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(reposition);
        observer.observe(panel);
        observer.observe(button);
    }
    new MutationObserver(reposition).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    reposition();
}

export async function initializeFileStorage() {
    const button = document.getElementById('file-storage-import');
    const status = document.getElementById('file-storage-status');
    if (!button || !status) {
        settleReady();
        return;
    }
    state.button = button;
    state.statusEl = status;
    bindImportTail();
    if (typeof invoke !== 'function') {
        document.getElementById('voices-import-local')?.removeAttribute('hidden');
        if (await connectWebBackend()) {
            setupWebBackend(button, status);
            await refresh().catch((error) => {
                console.error('web storage refresh failed', error);
                setStatus(`文件库不可用: ${error?.message || error}`, true);
            });
            startWorksPolling();
            resumeImportBatch().catch(() => {});
            settleReady();
            return;
        }
        // No HTTP backend: fall back to a session-local browser folder import.
        setupBrowserLocalImport(button, status);
        settleReady();
        return;
    }
    bindMediaRefresh();
    button.addEventListener('click', () => {
        pickAndImport().catch(() => {});
    });
    window.addEventListener('monochrome:file-storage-pending', () => {
        setStatus('文件库连接中，请稍后重试', true);
    });

    // The sidecar is the authoritative store; start it once per app session so
    // previously imported works reappear after a restart.
    ensureHost()
        .then(() => {
            startWorksPolling();
            return refresh();
        })
        .catch((error) => {
            console.error('file storage start failed', error);
            setStatus(`文件库不可用: ${error?.message || error}`, true);
        })
        .finally(settleReady);
}

async function openStorageWorkLocation(work) {
    await ensureHost();
    const wantedCode = String(work?.sourceCode || work?.code || '').replace(/^voice-/, '').toUpperCase();
    const works = (await api('/api/works')).result?.works || [];
    const target = works.find((entry) =>
        (work?.storageWorkId && entry.workId === work.storageWorkId) ||
        String(hostCode(entry)).toUpperCase().includes(wantedCode),
    );
    if (!target) throw new Error('local work not found');
    const response = await api('/api/works/open', { workId: target.workId });
    return response.result || null;
}

// One host work can cover several RJ codes (`editionCodes`), and the code the
// caller knows may be an edition rather than `source.sourceCode` — the card for
// RJ01706655 (繁中版) is served by the host row whose sourceCode is RJ01682626
// (日版). Matching only `hostCode()` therefore failed and the delete reported
// "no matching record" for a work that was right there. `hostWorkCodeSet` (defined
// near `voiceCodesOverlapHost`) already collects every code the entry knows.

/**
 * Map whatever id the caller holds (host UUID, `voice-<RJ>`, or a bare edition
 * code) to the host work id. Returns null when the library holds nothing for it.
 */
function resolveHostWorkId(hostWorks, id) {
    const value = String(id || '');
    if (!value) return null;
    const bare = value.replace(/^voice-/, '').toUpperCase();
    const match = (hostWorks || []).find((entry) =>
        entry.workId === value ||
        entry.workId === bare ||
        hostWorkCodeSet(entry).has(bare));
    return match?.workId || null;
}

async function deleteStorageWorks(workIds) {
    if (!Array.isArray(workIds) || workIds.length === 0) return { count: 0, folderLeft: 0, unresolved: [] };
    await ensureHost();
    // Resolve against the host's own list instead of guessing `voice-<RJ>` → id.
    // The old guess produced a bare RJ code for any work whose `storageWorkId`
    // was missing; the host then answered `ok: false` per work and the caller
    // treated the 200 as success, so the card vanished from the UI while both the
    // row and the folder on disk stayed put.
    const hostWorks = (await api('/api/works')).result?.works || [];
    const resolved = [];
    const unresolved = [];
    for (const id of workIds) {
        const match = resolveHostWorkId(hostWorks, id);
        if (!match) {
            // Report the mismatch instead of returning 0: a work the caller believes
            // is in the library but that resolves to nothing is a bug, and silence
            // is what made a failed delete look like a successful one.
            unresolved.push(String(id));
            continue;
        }
        if (!resolved.includes(match)) resolved.push(match);
    }
    if (resolved.length === 0) {
        return { count: 0, folderLeft: 0, unresolved };
    }
    const response = await api('/api/works/delete', { workIds: resolved });
    const entries = response.result?.works || [];
    const failures = entries.filter((entry) => entry.ok !== true);
    if (failures.length > 0) {
        const first = failures[0];
        throw new Error(`host delete failed: ${first?.error || first?.code || 'unknown'}`);
    }
    // The row is gone, but the readable folder can survive a locked file. Report it
    // instead of pretending the delete was complete: an empty folder holding only
    // `.monochrome` is what the user then sees in their library.
    const folderLeft = entries.filter((entry) => entry.deleted === true && entry.folderRemoved === false).length;
    await refresh();
    return { count: resolved.length, folderLeft, unresolved };
}

async function deleteStorageFiles(workId, paths) {
    if (!workId || !Array.isArray(paths) || paths.length === 0) return { deleted: [], count: 0 };
    await ensureHost();
    // Resolve here rather than trusting the caller's id. The album hands us an online
    // record (`voice-RJ01706655`) while the host row is keyed by UUID and carries that
    // code only in `editionCodes`; sending the raw value made the host answer
    // "entry not found" for a file that was right there.
    const hostWorks = (await api('/api/works')).result?.works || [];
    const resolved = resolveHostWorkId(hostWorks, workId);
    if (!resolved) return { deleted: [], count: 0, unresolved: String(workId) };
    const response = await api('/api/works/delete-files', { workId: resolved, paths });
    await refresh();
    return response.result || { deleted: [], count: 0 };
}

export async function updateStorageWorkMetadata(workId, metadata) {
    await ensureHost();
    const id = String(workId || '').replace(/^voice-/, '');
    const response = await api('/api/works/metadata', { workId: id, metadata });
    // One write path only: `/api/works/metadata` is the database. There is no
    // `.monochrome/metadata.json` to keep in sync any more.
    await refresh({ silent: true });
    return response.result || null;
}

async function cacheStorageWorkCover(workId, url) {
    await ensureHost();
    if (!state.url || !workId || !url) return null;
    const response = await api('/api/works/cover', { workId: String(workId), url: String(url) });
    return response.result || null;
}

async function cleanupImportTemps(workRoot = '') {
    await ensureHost();
    if (!state.url) return 0;
    const response = await api('/api/import-temp/cleanup', { workRoot: String(workRoot || '') });
    return Number(response.result?.removed) || 0;
}

// Creation posts have their own host tables (SQLite + CAS-like blobs) but use
// the same sidecar/token. Keep these methods here so creation code does not
// need a second host client.
async function saveCreationPost(post) {
    await ensureHost();
    const response = await api('/api/creations/import', { post });
    return response.result || null;
}

async function listCreationPosts() {
    await ensureHost();
    const response = await api('/api/creations');
    return response.result?.posts || [];
}

async function uploadCreationAsset({ postId, attachmentId, role = 'original', blob, name = '', mime = '' }) {
    await ensureHost();
    if (!blob) throw new Error('creation asset blob is required');
    const response = await nativeFetch(`${state.url}/api/creations/upload`, {
        method: 'POST',
        headers: {
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
            'Content-Type': mime || blob.type || 'application/octet-stream',
            'X-Creation-Post': String(postId),
            'X-Creation-Attachment': String(attachmentId),
            'X-Creation-Role': role,
            'X-Creation-Name': encodeURIComponent(String(name || attachmentId)),
        },
        body: blob,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error?.message || json?.message || response.statusText);
    return json.result || null;
}

async function fetchCreationAsset(assetId) {
    await ensureHost();
    const response = await nativeFetch(`${state.url}/api/creations/media/${encodeURIComponent(assetId)}`, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    });
    if (!response.ok) throw new Error(`creation asset HTTP ${response.status}`);
    return response.blob();
}

async function deleteCreationAsset(assetId) {
    await ensureHost();
    const response = await api('/api/creations/delete-asset', { assetId: String(assetId) });
    return response.result || null;
}

async function deleteCreationPost(postId) {
    await ensureHost();
    const response = await api('/api/creations/delete', { postIds: [String(postId)] });
    return response.result || null;
}

// UI/test bridge. Native picker automation and host-backed deletes both need a
// stable entry point that does not import this module from voices.js (circular).
window.__monochromeFileStorage = {
    importPath,
    refresh,
    resolveTrackUrl,
    resolveCoverUrl,
    cleanupImportTemps,
    cacheWorkCover: cacheStorageWorkCover,
    saveVoiceBundle,
    reconcileVoice: reconcileVoiceWork,
    isFileWork,
    isFileWorkAsync,
    deleteWorks: deleteStorageWorks,
    deleteFiles: deleteStorageFiles,
    openLocation: openStorageWorkLocation,
    // Shape adapters, exposed for the browser probes: they are pure functions of
    // the host work, so a probe can assert the metadata the card and the sidecar
    // would see without opening a specific album.
    toVoiceWork,
    voiceImportMetadata,
    creation: {
        savePost: saveCreationPost,
        listPosts: listCreationPosts,
        uploadAsset: uploadCreationAsset,
        fetchAsset: fetchCreationAsset,
        deletePost: deleteCreationPost,
        deleteAsset: deleteCreationAsset,
    },
};

const SAFE_FILE_RE = /[\/:*?"<>|]/g;

function safeSegment(value, fallback = 'file') {
    const text = String(value ?? '').replace(SAFE_FILE_RE, '_').trim();
    return text && !/^\.+$/.test(text) ? text : fallback;
}

function flattenVoiceFiles(nodes, path = [], output = []) {
    for (const node of nodes || []) {
        if (node.type === 'folder') flattenVoiceFiles(node.children, [...path, safeSegment(node.title, 'folder')], output);
        else output.push({ node, segments: [...path, safeSegment(node.title, 'file')] });
    }
    return output;
}

function editionCodeValues(list) {
    if (!Array.isArray(list)) return [];
    return list.map((edition) => typeof edition === 'string' ? edition : edition?.code);
}

function hostWorkCodeSet(work) {
    const values = [
        work?.source?.sourceCode,
        work?.sourceCode,
        work?.userMeta?.sourceCode,
        work?.userMeta?.originalCode,
        work?.originalCode,
        work?.code,
        work?.workId,
        ...editionCodeValues(work?.userMeta?.editionCodes),
        ...editionCodeValues(work?.editionCodes),
    ];
    return new Set(values
        .map((value) => String(value || '').toUpperCase().match(/RJ\d{5,8}/)?.[0])
        .filter(Boolean));
}

function voiceCodesOverlapHost(host, work) {
    const incoming = hostWorkCodeSet(work);
    if (!incoming.size) return false;
    for (const code of hostWorkCodeSet(host)) if (incoming.has(code)) return true;
    return false;
}

function mergeEditionCodeLists(left, right) {
    const map = new Map();
    for (const edition of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
        const code = String(edition?.code || '').toUpperCase();
        if (code) map.set(code, edition);
    }
    return [...map.values()];
}

function hostCode(work) {
    return String(work?.source?.sourceCode || work?.sourceCode || work?.workId || '');
}

async function uploadRemoteChunks(url, relative, mime, onChunk, signal) {
    const response = await nativeFetch(url, { signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`download failed: HTTP ${response.status}`);
    }
    const type = String(mime || response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('download response does not support streaming');

    // Fetch read sizes are unrelated to upload sizes. Coalesce into one reusable
    // buffer and send a Blob snapshot so Chromium does not encode a new inline
    // binary request body for every network read.
    const buffer = new Uint8Array(UPLOAD_CHUNK_BYTES);
    let buffered = 0;
    let offset = 0;
    const flush = async () => {
        if (!buffered) return;
        const uploadResponse = await nativeFetch(`${state.url}/api/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': type,
                'X-Relative-Path': encodeURIComponent(relative),
                'X-Upload-Offset': String(offset),
                ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
            },
            body: new Blob([buffer.subarray(0, buffered)], { type }),
            signal,
        });
        const payload = await uploadResponse.json().catch(() => null);
        if (!uploadResponse.ok) {
            throw new Error(payload?.error?.message || `upload failed: ${uploadResponse.status}`);
        }
        if (payload?.result?.offset !== offset || payload.result.bytes !== buffered) {
            throw new Error('upload acknowledgement does not match the requested chunk');
        }
        offset += buffered;
        buffered = 0;
        onChunk?.(offset);
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            let start = 0;
            while (start < value.byteLength) {
                const length = Math.min(buffer.byteLength - buffered, value.byteLength - start);
                buffer.set(value.subarray(start, start + length), buffered);
                buffered += length;
                start += length;
                if (buffered === buffer.byteLength) await flush();
                onChunk?.(offset + buffered);
            }
        }
        await flush();
        onChunk?.(offset);
        return offset;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

function voiceImportMetadata(work, prefix) {
    return {
        title: work?.title || prefix,
        // Same rule as persistRemoteMetadata: trueCircle is the original circle;
        // with translators present but no trueCircle the `circle` field cannot be
        // trusted (asmr.one stores the translator there), so publish nothing
        // rather than writing 漁貓 into the sidecar as a circle.
        circle: voicePublishedCircle(work),
        trueCircle: work?.trueCircle || '',
        translators: Array.isArray(work?.translators) ? work.translators : [],
        cvs: Array.isArray(work?.artists) && work.artists.length ? work.artists : Array.isArray(work?.cvs) ? work.cvs : [],
        sourceCode: work?.sourceCode || work?.code || '',
        tags: Array.isArray(work?.tags) ? work.tags : [],
        rating: Number(work?.rating) || 0,
        ratingCount: Number(work?.ratingCount) || 0,
        release: work?.release || '',
        price: Number(work?.price) || 0,
        currency: work?.currency || 'JPY',
        ageCategory: work?.ageCategory || '',
        nsfw: Boolean(work?.nsfw),
        editionLang: work?.editionLang || '',
        editionLabel: work?.editionLabel || '',
        editionCodes: Array.isArray(work?.editionCodes) ? work.editionCodes : [],
        sourceUrl: work?.sourceUrl || dlsitePageUrl(work?.sourceCode || work?.code),
        pageUrl: work?.pageUrl || dlsitePageUrl(work?.sourceCode || work?.code),
    };
}

function mergeVoiceManifestEntries(existing, incoming, editionCode, presentPaths = null) {
    const entries = [];
    const byKey = new Map();
    const add = (entry, forcedEdition = '') => {
        if (!entry?.logicalPath) return;
        const edition = String(forcedEdition || entry.editionCode || '').toUpperCase();
        const key = `${edition}::${entry.logicalPath}`;
        const current = byKey.get(key);
        if (!current) {
            const next = { ...entry, ...(edition ? { editionCode: edition } : {}) };
            byKey.set(key, next);
            entries.push(next);
            return;
        }
        const merged = { ...current, ...entry, ...(edition ? { editionCode: edition } : {}) };
        if (current.aliasOf) {
            // `incoming` marks a row local from the download journal, not from
            // disk. The host's dynamic dedupe already removed this duplicate and
            // recorded the alias + real sha256; only a file that is physically
            // back at this path may turn the alias into a canonical copy again.
            if (presentPaths?.has(entry.logicalPath)) {
                delete merged.aliasOf;
            } else {
                merged.aliasOf = current.aliasOf;
                merged.hash = current.hash;
            }
        }
        byKey.set(key, merged);
        const index = entries.indexOf(current);
        if (index >= 0) entries[index] = merged;
    };
    for (const entry of existing?.entries || []) add(entry);
    for (const entry of incoming?.entries || []) add(entry, editionCode);
    return entries.length ? { version: 2, generatedAt: new Date().toISOString(), entries } : existing || null;
}

function buildVoiceManifest(work, localHashes = new Set(), localPaths = new Set()) {
    const entries = [];
    const walk = (nodes, path = []) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') {
                walk(node.children, [...path, node.title]);
                continue;
            }
            const logicalPath = String(node.logicalPath || [...path, node.title].join('/'));
            const local = localHashes.has(String(node.hash)) || localPaths.has(logicalPath);
            entries.push({
                logicalPath,
                title: String(node.title || logicalPath.split('/').pop() || ''),
                kind: node.type || 'file',
                hash: node.hash || '',
                editionCode: String(work?.code || work?.sourceCode || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '',
                status: local ? 'local' : 'remote',
                mediaStreamUrl: node.mediaStreamUrl || '',
                mediaDownloadUrl: node.mediaDownloadUrl || '',
                duration: Number(node.duration) || 0,
                mime: node.mime || '',
                bytes: Number(node.bytes) || 0,
            });
        }
    };
    walk(work?.tracks);
    return entries.length ? { version: 1, generatedAt: new Date().toISOString(), entries } : null;
}

function voiceBundleRootName(work) {
    const code = String(work?.sourceCode || work?.code || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || 'RJ00000000';
    const circle = String(work?.trueCircle || work?.circle || '').replace(/[\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    const title = String(work?.title || code).replace(/[\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    const cvs = Array.isArray(work?.artists) ? work.artists.filter(Boolean) : [];
    const titleWithoutCv = title
        .replace(/\s*【\s*CV[.．:：]?[^】]*】/gi, '')
        .replace(/\s*[(（]\s*CV[^)）]*[)）]/gi, '')
        .trim();
    let name = `[${code}] `;
    if (circle) name += `[${circle}] `;
    name += titleWithoutCv || title;
    if (cvs.length) name += ` (CV ${cvs.join(' ')})`;
    return name.slice(0, 220);
}

async function reconcileVoiceWork(workId) {
    await ensureHost();
    if (!state.url || !workId) return null;
    const response = await api('/api/voices/reconcile', { workId: String(workId) });
    await refresh({ silent: true });
    return response.result || null;
}

async function saveVoiceBundle(work) {
    await ensureHost();
    if (!state.url || !work?.id) return null;
    const rootName = voiceBundleRootName(work);
    const manifest = buildVoiceManifest(work);
    const metadata = voiceImportMetadata(work, rootName);
    // Manual imports can lack age/tags/CV. Hydrate at bundle time instead of
    // persisting an empty/unrated snapshot that later becomes a wrong badge.
    if (!metadata.ageCategory || metadata.ageCategory === 'unrated' || !metadata.tags?.length) {
        const remote = await remoteMetadataFor(work).catch(() => null);
        if (remote) {
            if (!metadata.ageCategory || metadata.ageCategory === 'unrated') metadata.ageCategory = remote.ageCategory || '';
            metadata.nsfw = Boolean(metadata.nsfw || remote.nsfw);
            if (!metadata.tags?.length) metadata.tags = remote.tags || [];
            if (!metadata.circle) metadata.circle = remote.circle || '';
            if (!metadata.cvs?.length) metadata.cvs = remote.artists || [];
            if (!metadata.release) metadata.release = remote.release || '';
            if (!metadata.rating) metadata.rating = Number(remote.rating) || 0;
        }
    }
    const response = await api('/api/voices/bundle', {
        rootName,
        metadata,
        manifest,
        coverUrl: work.cover || work.thumbnail || dlsiteCoverUrl(voiceOriginalCode(work)),
    });
    await refresh({ silent: true });
    return response.result || null;
}

/**
 * Import a Kikoeru download plan into the storage host. Unlike the folder
 * downloader this owns the CAS path, so repeated downloads are incremental:
 * existing logical paths with the same size/hash are skipped.
 */
export async function importVoicePlan(plan, work, { onProgress, signal } = {}) {
    await ensureHost();
    if (!state.url) throw new Error('storage host is not running');
    const code = String(work?.code || work?.sourceCode || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
    const hostWorks = (await api('/api/works')).result?.works || [];
    // Identity is code/editionCodes only. Prefer the host whose primary source
    // code matches the edition being downloaded; fall back to sourceCode then
    // any overlap. This avoids picking a wrong duplicate root when two host
    // records accidentally share the same edition set.
    const hostCandidates = hostWorks.filter((entry) => voiceCodesOverlapHost(entry, work));
    const primaryCode = String(work?.code || '').toUpperCase();
    const sourceCode = String(work?.sourceCode || '').toUpperCase();
    const existing = hostCandidates.find((entry) => hostWorkCodeSet(entry).has(primaryCode))
        || hostCandidates.find((entry) => hostWorkCodeSet(entry).has(sourceCode))
        || hostCandidates[0] || null;
    // If the same work exists under another edition code, download into that
    // existing root and merge editions; never create a second work folder.
    // Only a real `workRoot` is trusted from the existing record — `title` is a bare
    // folder name with no `[RJ]` prefix, and falling back to it created a second
    // directory beside the canonical one. Everything else uses the same builder the
    // bundle migration uses, so both paths always agree.
    const prefix = existing?.workRoot || voiceBundleRootName(work) || plan.rootName || code || 'voice';
    const existingBySuffix = new Map();
    for (const entry of existing?.entries || []) {
        const logical = String(entry.logicalPath || '');
        const suffix = logical.startsWith(prefix + '/') ? logical.slice(prefix.length + 1) : logical;
        if (suffix) existingBySuffix.set(suffix, entry);
    }
    const files = plan.files || [];
    const hashes = [];
    let uploaded = 0;
    const downloadSettings = getVoiceDownloadSettings();
    const stagingRoot = `${prefix}/tmp/import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let importCursor = 0;
    let importError = null;
    let importChain = Promise.resolve();
    let targetWorkId = existing?.workId || '';
    const importCommittedFile = (relativePath) => {
        importChain = importChain.then(() => api('/api/import/file', {
            relativePath,
            workRoot: prefix,
            workId: targetWorkId || undefined,
            metadata: voiceImportMetadata(work, prefix),
        })).then((response) => {
            if (!targetWorkId) targetWorkId = response?.result?.workId || response?.result?.id || '';
            return response;
        });
        return importChain;
    };
    const importOne = async (index) => {
        const file = files[index];
        const suffix = file.segments.join('/');
        const target = `${prefix}/${suffix}`;
        const staging = `${stagingRoot}/${suffix}`;
        const existingEntry = existingBySuffix.get(suffix);
        const expectedHash = String(file.voiceHash || file.node?.hash || '');
        const sameHash = expectedHash.length === 64 && existingEntry?.sha256 === expectedHash;
        const sameSize = existingEntry && Number(existingEntry.bytes) === Number(file.size || file.node?.size || 0);
        if (sameHash || sameSize) {
            hashes[index] = expectedHash;
            onProgress?.({ type: 'file', index, state: 'skipped', loaded: file.size || 0, total: file.size || 0 });
            return;
        }
        onProgress?.({ type: 'file', index, state: 'downloading', loaded: 0, total: file.size || 0 });
        let written = 0;
        try {
            written = await uploadRemoteChunks(
                file.url || file.node?.mediaDownloadUrl || file.node?.mediaStreamUrl,
                staging,
                file.mime || file.node?.mime,
                (loaded) => {
                    written = loaded;
                    onProgress?.({ type: 'file', index, state: 'downloading', loaded, total: file.size || 0 });
                },
                signal,
            );
            signal?.throwIfAborted();
            await api('/api/move', { from: staging, to: target });
            await importCommittedFile(target);
        } catch (error) {
            onProgress?.({ type: 'file', index, state: 'error', loaded: written, total: file.size || 0, error: error?.message || String(error) });
            throw error;
        }
        uploaded += 1;
        hashes[index] = expectedHash;
        onProgress?.({ type: 'file', index, state: 'done', loaded: written, total: file.size || 0 });
    };
    const importWorker = async () => {
        for (;;) {
            if (signal?.aborted || importError) return;
            const index = importCursor;
            importCursor += 1;
            if (index >= files.length) return;
            try {
                await importOne(index);
            } catch (error) {
                importError = importError || error;
                return;
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(downloadSettings.fileConcurrency, 8, files.length)) }, () => importWorker()),
    );
    await importChain;
    if (importError) throw importError;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (plan.cover?.url) {
        const coverTarget = `${prefix}/.monochrome/folder.jpg`;
        if (!existingBySuffix.get('.monochrome/folder.jpg') && !existingBySuffix.get('folder.jpg')) {
            try {
                const response = await nativeFetch(plan.cover.url, { credentials: 'omit', signal });
                if (response.ok) {
                    const blob = await response.blob();
                    const bytes = new Uint8Array(await blob.arrayBuffer());
                    if (bytes.byteLength > 0) {
                        const upload = await nativeFetch(`${state.url}/api/upload`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': blob.type || 'image/jpeg',
                                'X-Relative-Path': encodeURIComponent(coverTarget),
                                'X-Upload-Offset': '0',
                                ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
                            },
                            body: bytes,
                            signal,
                        });
                        if (!upload.ok) throw new Error(`cover upload failed: ${upload.status}`);
                    }
                    await importCommittedFile(coverTarget);
                }
            } catch (error) {
                console.warn('Kikoeru cover import skipped:', error?.message || error);
            }
        }
    }
    onProgress?.({ type: 'job', state: 'scanning', uploaded, total: files.length });
    const preview = await api('/api/scan', { mode: 'single', relativeRoot: prefix });
    const allCandidates = (preview.result?.candidates || []).filter(
        (candidate) => (candidate.entries || []).length > 0 || Number(candidate.counts?.entries) > 0,
    );
    const scoped = allCandidates.filter((candidate) => {
        const root = String(candidate.relativeRoot || candidate.candidateId?.replace(/^local:/, '') || '');
        return root === prefix || root.startsWith(prefix + '/');
    });
    // In single mode the scanner reports the requested root as relativeRoot
    // '.', so every returned candidate belongs to this work.
    const candidates = scoped.length ? scoped : allCandidates;
    if (candidates.length === 0) throw new Error('storage scan found no files for this work');
    await importWebCandidates(candidates, { hydrateMetadata: false });
    // Local folders often contain only an RJ code; fetch/cache the real
    // circle/CV/tags at import time instead of scraping the filename.
    await hydrateHostMetadataForCandidates(candidates);
    // The scan/import pass rebuilds source metadata from the folder tree, which
    // has no CV/tags/rating. Re-apply the online metadata after that merge so a
    // local work keeps the same card/detail metadata as the online work.
    const currentWorks = (await api('/api/works')).result?.works || [];
    const metadataTarget = currentWorks.find((entry) => targetWorkId && entry.workId === targetWorkId)
        || currentWorks.find((entry) => {
            const entryCode = String(hostCode(entry) || '').toUpperCase();
            return code && entryCode.includes(code) || entry.title === prefix;
        });
    if (metadataTarget) {
        const localHashes = new Set((hashes || []).filter(Boolean).map(String));
        const localPaths = new Set();
        for (const entry of metadataTarget.entries || []) {
            if (entry.entryId) localHashes.add(String(entry.entryId));
            if (entry.logicalPath) localPaths.add(String(entry.logicalPath));
        }
        const builtManifest = buildVoiceManifest(work, localHashes, localPaths);
        const storedManifest = metadataTarget.userMeta?.manifest;
        const mergedManifest = mergeVoiceManifestEntries(storedManifest, builtManifest, code, localPaths);
        // `buildVoiceManifest` returns null when the online tree never loaded
        // (work.tracks empty), and an existing manifest may be missing too. The
        // host entries are then the only enumeration we have: a manifest built
        // from them still lets the sidecar, `user_meta.manifest` and the
        // full/partial badge exist. An empty manifest beats no manifest at all:
        // without it the frontend treats the host work as complete and masks the
        // online track tree.
        const manifest = mergedManifest
            || manifestFromHostWork(metadataTarget)
            || { version: 1, generatedAt: new Date().toISOString(), entries: [] };
        const metadata = voiceImportMetadata(work, prefix);
        metadata.editionCodes = mergeEditionCodeLists(
            metadataTarget.userMeta?.editionCodes,
            metadata.editionCodes,
        );
        // When we could not enumerate the online tree, the manifest only knows
        // local files. Persist that fact so the work stays "partial" after a
        // restart instead of looking complete and hiding the remote tracks; a
        // later import with a known tree clears it again.
        metadata.partial = !builtManifest;
        await api('/api/works/metadata', {
            workId: metadataTarget.workId,
            metadata: {
                ...metadata,
                manifest,
            },
        }).catch((error) => {
            console.warn('import metadata reapply skipped:', error?.message || error);
        });
        // Nothing else to persist here: the patch above already carries the
        // manifest into the database, which is the only authority. There is no
        // `metadata.json`/`manifest.json` file to keep in sync any more.
        // The manifest reapply above can reintroduce a duplicate local row after
        // importFile's per-file dedupe already ran. Run one final reconcile so
        // same-hash entries become aliases and physical duplicates are removed.
        await reconcileVoiceWork(metadataTarget.workId).catch((error) => {
            console.warn('post-import content dedupe skipped:', error?.message || error);
        });
    }
    await refresh({ silent: true });
    await cleanupImportTemps(prefix).catch((error) => {
        console.warn('import temp cleanup skipped:', error?.message || error);
    });
    return { prefix, uploaded, total: files.length, hashes };
}

window.__monochromeFileStorage.importVoicePlan = importVoicePlan;

window.__monochromeFileStorage.updateMetadata = updateStorageWorkMetadata;
