import { getVoiceFileType } from './voice-file-types.js';
// 「音声」页:独立的 Kikoeru / asmr.one 作品库。
//
// 数据只存元数据与文件树;音频/文本通过 Kikoeru 的 mediaStreamUrl 播放,
// 下载走 mediaDownloadUrl。与创作页的本地附件存储相互独立。
//
// 筛选设计:声优与社团是两个独立 facet。
//   · 同一 facet 内多选 = OR(看这些声优 / 这些社团)
//   · 两个 facet 同时生效 = AND(某社团里的某声优作品)
// 这样"声优和社团可以同时筛选"有明确定义,也不需要把筛选做成跳转后丢失的临时状态。
import { t } from './i18n.js';
import { navigate } from './router.js';
import { Player } from './player.js';
import { showNotification } from './downloads.js';
import { fetchKikoeruWork, fetchKikoeruWorkById } from './kikoeru-api.js';
import { fetchDlsiteWorkMetadata } from './dlsite-metadata.js';
import { mergeVoiceMetadata } from './voice-metadata.js';
import { voiceDisplayCircle, voiceTranslatorList } from './voice-circle.js';
import { createImportOptions } from './import-options.js';
import { setUiState } from './ui-state.js';
import { backgroundSettings } from './storage.js';
import { bindCoverTheme } from './cover-theme.js';
import { adaptVoiceWork, getVoiceAlbum, getVoiceTrack, getVoicePlaybackTracks, getVoicePlaybackFormats, getVoiceDefaultFormat, getVoiceTrackFormat } from './voice-album.js';
import { createVoiceAttachmentViewer } from './voice-attachment-viewer.js';
import { mountVoiceAlbumSplit } from './voice-album-layout.js';
import { openVoiceMetadataEditor } from './voice-metadata-editor.js';
import { loadVoiceAttachmentText } from './voice-attachment-text.js';
import { animateVoiceFolders } from './voice-folder-animation.js';
import { createVoiceDownloadPlan, createVoiceSelectedDownloadPlan, runVoiceDownload } from './voice-download.js';
import { createVoiceDownloadPanel } from './voice-download-panel.js';
import { bindVoiceFileSelection } from './voice-file-selection.js';
import { trackDataStore } from './utils.js';
import { db } from './db.js';
import { SVG_DOWNLOAD, SVG_FOLDER_OPEN, SVG_HEART, SVG_HEART_FILLED, SVG_LINK, SVG_MENU, SVG_PLUS } from './icons.js';
import { queryVoiceLibrary } from './voice-library-query.js';
import { createVoiceLibraryFilters } from './voice-library-filters.js';
import { createLibraryGridRenderer } from './library-grid.js';
import { deriveWorkSubtitles, normalizeSubtitleStem } from './voice-subtitles.js';
import { renderDlsiteIntro } from './dlsite-intro.js';
import { getVoiceInitialPath, expandPathPrefixes } from './voice-smart-path.js';
import { clearVoiceDownloadHashes, clearVoiceDownloads, getDownloadedVoiceHashes, pruneVoiceDownloadHashes, recordVoiceDownloads } from './voice-local-state.js';
import { getVoiceDownloadSettings, voicePathSettings } from './voice-settings.js';
import { fetchJson as fetchVoiceEndpointJson, isAsmrFamilyBase, selectBase as selectVoiceBase } from './voice-endpoints.js';
import { startVoiceStreamRefresh } from './voice-stream-refresh.js';
import '../voices-library.css';
import '../library-management.css';

function voiceAlbumPath(id) {
    return `/album/${encodeURIComponent(id)}`;
}

function safeFileUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(value, window.location.origin);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

const VOICES_STORAGE_KEY = 'monochrome-voices-imported-v1';
const VOICES_OPTIONS_KEY = 'monochrome-voices-import-options-v1';
// Listening state for host-backed works must not drag the whole work into localStorage.
const VOICES_FILE_STATUS_KEY = 'monochrome-voices-file-listen-status-v1';
function updateVoiceFavoriteButton(button, favorite) {
    if (!button) return;
    const liked = Boolean(favorite);
    button.setAttribute('aria-pressed', String(liked));
    button.title = t(liked ? 'voices.unfavorite' : 'voices.favorite');
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('is-active', liked);
    button.innerHTML = liked ? SVG_HEART_FILLED(18) : SVG_HEART(18);
}

let works = [];
let currentWorkId = null;
let currentVoiceAlbum = null;
// Which folders the user has open, per work. Re-rendering the tracklist (every
// host refresh, every download) used to derive the expansion from the configured
// initial path, so any opened folder collapsed under the user. Recording the DOM
// state here lets the next render restore exactly what was open.
const voiceAlbumOpenFolders = new Map();
let importOptions = null;
const activeArtists = new Set();
const activeCircles = new Set();
const activeTags = new Set();
const activeAges = new Set();
const activeListenStatuses = new Set();
const activeSubtitles = new Set();
const activeTranslators = new Set();
const activeLocal = new Set();
// Listening state is intentionally a small fixed vocabulary; it is stored on the work, not injected into tags.
const LISTEN_STATUSES = Object.freeze([
    { value: 'want', labelKey: 'voices.listenStatus.want' },
    { value: 'listening', labelKey: 'voices.listenStatus.listening' },
    { value: 'listened', labelKey: 'voices.listenStatus.listened' },
    { value: 'relisten', labelKey: 'voices.listenStatus.relisten' },
    { value: 'shelved', labelKey: 'voices.listenStatus.shelved' },
]);
const LISTEN_STATUS_VALUES = new Set(LISTEN_STATUSES.map((status) => status.value));
const selectedIds = new Set();
let voiceImportOpen = null;
let libraryQuery = '';
let librarySort = 'added';
let voiceLibraryFilters = null;

function visibleVoiceWorks() {
    return queryVoiceLibrary(works.filter(matchesFilters), { query: libraryQuery, sort: librarySort });
}

function setVoiceImportOpen(open, focus = false) {
    voiceImportOpen = open;
    const panel = document.getElementById('voices-import-panel');
    if (panel) panel.hidden = !open;
    document.getElementById('voices-import-toggle')?.setAttribute('aria-expanded', String(open));
    if (focus) document.getElementById(open ? 'voices-import-input' : 'voices-import-toggle')?.focus();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function leafCount(nodes) {
    let count = 0;
    for (const node of nodes || []) {
        if (node.type === 'folder') count += leafCount(node.children);
        else count += 1;
    }
    return count;
}

function countTree(nodes, type) {
    let count = 0;
    for (const node of nodes || []) {
        if (getVoiceFileType(node) === type) count += 1;
        if (node.children) count += countTree(node.children, type);
    }
    return count;
}

function coverSource(url) {
    if (!url || !/^https?:/i.test(url)) return url;
    try {
        const parsed = new URL(url);
        if (!parsed.pathname.startsWith('/api/cover/')) return url;
        if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return url;
        // 播放器会给封面加 crossorigin="anonymous";api.asmr.one 不允许本机 origin,
        // 所以开发环境走同源封面代理,避免播放条出现破图。
        return new URL(`/__kikoeru_cover?url=${encodeURIComponent(url)}`, window.location.origin).href;
    } catch {
        return url;
    }
}

function workCounts(work) {
    return {
        fileCount: leafCount(work.tracks || []),
        audioCount: countTree(work.tracks || [], 'audio'),
        tagCount: Array.isArray(work.tags) ? work.tags.length : 0,
    };
}

function readFileListenStatuses() {
    try {
        const value = JSON.parse(localStorage.getItem(VOICES_FILE_STATUS_KEY) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

function writeFileListenStatuses(statuses) {
    try {
        localStorage.setItem(VOICES_FILE_STATUS_KEY, JSON.stringify(statuses));
    } catch (error) {
        console.error('Failed to persist file voice listen status:', error);
    }
}

function stripRuntimeVoiceMedia(nodes) {
    return (nodes || []).map((node) => {
        const next = { ...node };
        delete next.localMediaStreamUrl;
        delete next.localMediaDownloadUrl;
        delete next.remoteMediaStreamUrl;
        delete next.remoteMediaDownloadUrl;
        delete next.hostWorkId;
        delete next.hostEntryId;
        delete next.hostEntrySha;
        if (next.children) next.children = stripRuntimeVoiceMedia(next.children);
        return next;
    });
}

function loadWorks() {
    try {
        const stored = JSON.parse(localStorage.getItem(VOICES_STORAGE_KEY) || '[]');
        const localWorks = (Array.isArray(stored) ? stored : [])
            .filter((work) => work && work.id && !work.fileStorage && !work.browserLocal)
            // 旧版本可能存过错误的 fileCount/audioCount;渲染时按文件树重算,顺手修补。
            .map((work) => {
                const next = stripLegacyAgeTags({ ...work, ...workCounts(work) });
                delete next.localFileStorageState;
                delete next.__voicePartial;
                next.storageKind = 'online';
                next.presentationMode = 'online';
                if (Array.isArray(next.tracks)) next.tracks = stripRuntimeVoiceMedia(next.tracks);
                const subtitleInfo = deriveWorkSubtitles(next);
                return {
                    ...next,
                    hasSubtitle: Boolean(next.hasSubtitle || next.has_subtitle || subtitleInfo.hasSubtitle),
                };
            });
        // Album extras call loadWorks(); preserve the host-backed slice so that
        // action is not mistaken for a request to drop SQLite/CAS works.
        const fileWorks = Array.isArray(globalThis.__monochromeFileStorageWorks)
            ? globalThis.__monochromeFileStorageWorks.filter((work) => !work.__voicePartial)
            : [];
        const browserWorks = Array.isArray(globalThis.__monochromeBrowserLocalWorks)
            ? globalThis.__monochromeBrowserLocalWorks
            : [];
        works = [...browserWorks, ...localWorks, ...fileWorks];
    } catch (error) {
        console.error('Failed to load voice works:', error);
        works = [];
    }
}

const VOICE_RATING_CACHE_KEY = 'monochrome-voices-rating-cache-v1';
let ratingHydrationRunning = false;
const ratingHydrationCodes = new Set();

function readVoiceRatingCache() {
    try {
        const value = JSON.parse(localStorage.getItem(VOICE_RATING_CACHE_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

function writeVoiceRatingCache(cache) {
    try {
        localStorage.setItem(VOICE_RATING_CACHE_KEY, JSON.stringify(cache));
    } catch {
        /* quota/private mode: hydration is best effort */
    }
}

function applyVoiceRating(work, rating, ratingCount) {
    const value = Number(rating) || 0;
    if (value <= 0 || Number(work.rating) > 0) return false;
    work.rating = value;
    work.ratingCount = Number(ratingCount) || 0;
    return true;
}

/**
 * Kikoeru list rows frequently omit rate_average_2dp even though the work detail
 * has it. Hydrate only zero-rating rows, with a small concurrency limit and a
 * persistent cache, so cards show the source rating without a request storm.
 */
function voiceRatingLookupCodes(work) {
    const values = [
        work?.sourceCode,
        work?.code,
        work?.originalCode,
        ...(Array.isArray(work?.editionCodes) ? work.editionCodes.map((edition) => edition?.code) : []),
    ];
    return [...new Set(values
        .map((value) => String(value || '').toUpperCase().match(/RJ\d{5,8}/)?.[0])
        .filter(Boolean))]
        .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

async function hydrateVoiceRatings() {
    if (ratingHydrationRunning) return;
    const cache = readVoiceRatingCache();
    // A previous failed request must not pin a 0 rating forever; only positive
    // values are cacheable. Negative results are retried on the next visit.
    for (const [code, entry] of Object.entries(cache)) {
        if (!Number(entry?.rating)) delete cache[code];
    }
    let changed = false;
    for (const work of works) {
        if (work.fileStorage || work.browserLocal || !work.code || Number(work.rating) > 0) continue;
        const cached = voiceRatingLookupCodes(work).map((code) => cache[code]).find((entry) => Number(entry?.rating) > 0);
        if (cached) changed = applyVoiceRating(work, cached.rating, cached.ratingCount) || changed;
    }
    if (changed) {
        persistWorks();
        renderList();
    }
    const pending = works.filter((work) =>
        !work.fileStorage && !work.browserLocal && work.code && Number(work.rating) <= 0 &&
        !ratingHydrationCodes.has(String(work.code || '').toUpperCase()) &&
        !voiceRatingLookupCodes(work).some((code) => Number(cache[code]?.rating) > 0),
    );
    if (!pending.length) return;
    ratingHydrationRunning = true;
    const queue = [...pending];
    const worker = async () => {
        while (queue.length) {
            const work = queue.shift();
            const code = String(work.code || '').toUpperCase();
            if (!code) continue;
            ratingHydrationCodes.add(code);
            const candidates = voiceRatingLookupCodes(work);
            try {
                // A translated edition often reports rating 0. Try the oldest
                // known RJ code first, matching the source-work fallback rule.
                let rating = 0;
                let ratingCount = 0;
                let ratingCode = code;
                let fresh = null;
                if (work.workId) {
                    fresh = await fetchKikoeruWorkById(work.workId, { backendBase: work.backendBase }).catch(() => null);
                }
                if (!fresh?.rating) {
                    for (const candidate of candidates) {
                        fresh = await fetchKikoeruWork(candidate, {
                            signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(3500) : undefined,
                        }).catch(() => null);
                        if (fresh?.rating) {
                            ratingCode = candidate;
                            break;
                        }
                    }
                }
                rating = Number(fresh?.rating) || 0;
                ratingCount = Number(fresh?.ratingCount) || 0;
                if (rating <= 0) {
                    for (const candidate of candidates) {
                        const dlsite = await fetchDlsiteWorkMetadata(candidate, { timeoutMs: 8000 }).catch(() => null);
                        if (dlsite?.rating) {
                            rating = Number(dlsite.rating) || 0;
                            ratingCount = Number(dlsite.ratingCount) || 0;
                            ratingCode = candidate;
                            break;
                        }
                    }
                }
                if (rating > 0) {
                    cache[ratingCode] = { rating, ratingCount, at: Date.now() };
                    writeVoiceRatingCache(cache);
                }
                const currentWork = works.find((entry) => {
                    const entryCodes = voiceRatingLookupCodes(entry);
                    return entryCodes.includes(code) || entryCodes.includes(ratingCode);
                }) || work;
                if (rating > 0 && applyVoiceRating(currentWork, rating, ratingCount)) {
                    persistWorks();
                    renderList();
                    const albumPage = document.getElementById('page-album');
                    if (albumPage?.dataset.voiceWorkId === currentWork.id && albumPage.classList.contains('active')) {
                        renderAlbumExtras(currentWork);
                    }
                }
            } catch (error) {
                console.warn('Voice rating hydration failed:', code, error?.message || error);
            }
        }
    };
    try {
        await Promise.all([worker(), worker(), worker()]);
    } finally {
        ratingHydrationRunning = false;
    }
}

const VOICE_WORK_JSON_KEY = 'monochrome-voice-work-json-v1';
// Works the user explicitly deleted from the file library. Persisted because the
// resurrection happens on the *next* load: the online record survives in
// localStorage, so the background bundle migration would see "an online work with
// no host row" and quietly recreate the folder. `voiceHostForWork()` is truthy
// before the delete, so the identity never entered `onlineBundleAttempted` either.
const VOICE_DELETED_KEY = 'monochrome-voices-deleted-v1';

function voiceDeletedIdentities() {
    try {
        const raw = JSON.parse(localStorage.getItem(VOICE_DELETED_KEY) || '[]');
        return new Set(Array.isArray(raw) ? raw.filter((value) => typeof value === 'string') : []);
    } catch {
        return new Set();
    }
}

function writeVoiceDeletedIdentities(identities) {
    try {
        localStorage.setItem(VOICE_DELETED_KEY, JSON.stringify([...identities]));
    } catch {
        /* private mode/quota: the tombstone is best-effort */
    }
}

/**
 * Every RJ code this record can be identified by.
 *
 * Deliberately excludes `workId`: `voiceWorkCodeSet` carries it, but a host record
 * has one while the online record does not, so any set built from the full helper
 * would never compare equal across the two.
 */
function voiceBundleCodes(work) {
    const codes = new Set();
    const candidates = [
        work?.code,
        work?.sourceCode,
        work?.originalCode,
        work?.source?.sourceCode,
        work?.userMeta?.sourceCode,
        ...(Array.isArray(work?.editionCodes) ? work.editionCodes.map((edition) => edition?.code) : []),
        ...(Array.isArray(work?.userMeta?.editionCodes) ? work.userMeta.editionCodes.map((edition) => edition?.code) : []),
    ];
    for (const value of candidates) {
        const code = String(value || '').toUpperCase().match(/RJ\d{5,8}/)?.[0];
        if (code) codes.add(code);
    }
    return [...codes].sort();
}

/** Identity used by `ensureOnlineWorkBundles` to decide "already handled". */
function voiceBundleIdentity(work) {
    return voiceBundleCodes(work).join('|');
}

// The tombstone stores individual codes, not one joined identity: a host record can
// carry more edition codes than the online record does, and comparing the two sets
// for equality would miss. "Any code overlaps" is the relation that survives that.
function markVoiceDeleted(work) {
    const codes = voiceBundleCodes(work);
    if (!codes.length) return;
    const identities = voiceDeletedIdentities();
    for (const code of codes) identities.add(code);
    writeVoiceDeletedIdentities(identities);
}

function clearVoiceDeleted(work) {
    const codes = voiceBundleCodes(work);
    if (!codes.length) return;
    const identities = voiceDeletedIdentities();
    let changed = false;
    for (const code of codes) {
        if (identities.delete(code)) changed = true;
    }
    if (changed) writeVoiceDeletedIdentities(identities);
}

function isVoiceDeleted(work, identities) {
    return voiceBundleCodes(work).some((code) => identities.has(code));
}

function voiceWorkManifestSnapshot(work) {
    if (Array.isArray(work?.manifest)) return { version: 1, entries: work.manifest };
    const localHashes = getDownloadedVoiceHashes(work.id);
    const local = Boolean(work?.fileStorage || work?.browserLocal);
    const entries = [];
    const walk = (nodes, path = []) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') {
                walk(node.children, [...path, node.title]);
                continue;
            }
            const logicalPath = String(node.logicalPath || [...path, node.title].join('/'));
            entries.push({
                logicalPath,
                title: String(node.title || logicalPath.split('/').pop() || ''),
                kind: node.type || 'file',
                hash: node.hash || '',
                status: local || localHashes.has(String(node.hash)) ? 'local' : 'remote',
                mediaStreamUrl: node.mediaStreamUrl || '',
                mediaDownloadUrl: node.mediaDownloadUrl || '',
                duration: Number(node.duration) || 0,
                mime: node.mime || '',
                bytes: Number(node.bytes) || 0,
            });
        }
    };
    walk(work?.tracks);
    return { version: 1, entries };
}

function persistVoiceWorkJsonSnapshots() {
    try {
        const previous = JSON.parse(localStorage.getItem(VOICE_WORK_JSON_KEY) || '{}');
        const next = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
        const liveIds = new Set(works.map((work) => String(work?.id || '')).filter(Boolean));
        if (liveIds.size) {
            for (const id of Object.keys(next)) {
                if (!liveIds.has(id)) delete next[id];
            }
        }
        for (const work of works) {
            if (!work?.id) continue;
            const metadata = {
                id: work.id,
                code: work.code || '',
                sourceCode: work.sourceCode || '',
                title: work.title || '',
                circle: work.circle || '',
                trueCircle: work.trueCircle || '',
                artists: Array.isArray(work.artists) ? work.artists : [],
                tags: Array.isArray(work.tags) ? work.tags : [],
                rating: Number(work.rating) || 0,
                ratingCount: Number(work.ratingCount) || 0,
                release: work.release || '',
                sourceUrl: work.sourceUrl || '',
                pageUrl: work.pageUrl || '',
                editionLang: work.editionLang || '',
                editionLabel: work.editionLabel || '',
                editionCodes: Array.isArray(work.editionCodes) ? work.editionCodes : [],
                duration: Number(work.duration) || 0,
                importedAt: work.importedAt || '',
                localFileStorageState: work.localFileStorageState || '',
                fileStorage: Boolean(work.fileStorage),
            };
            next[String(work.id)] = {
                version: 1,
                updatedAt: new Date().toISOString(),
                metadata,
                manifest: voiceWorkManifestSnapshot(work),
            };
        }
        localStorage.setItem(VOICE_WORK_JSON_KEY, JSON.stringify(next));
    } catch {
        /* private mode/quota: per-work snapshots are best-effort */
    }
}

function persistWorks() {
    try {
        // File-storage works belong to SQLite/CAS; a legacy save path must not
        // duplicate them (or their stale media URLs) into localStorage.
        localStorage.setItem(
            VOICES_STORAGE_KEY,
            JSON.stringify(
                works
                    .filter((work) => !work.fileStorage && !work.browserLocal)
                    .map(({ localFileStorageState, __voicePartial, ...work }) => ({
                        ...work,
                        // A signed `/media/<id>?expires=…&sig=…` URL dies with the
                        // TTL; persisting it left the album header blank on the
                        // next launch. The host re-signs one every session and
                        // `readWorks` lends it back, so store nothing here.
                        cover: /\/media\/[^/?#]+/.test(String(work.cover || '')) ? undefined : work.cover,
                        storageKind: 'online',
                        presentationMode: work.presentationMode === 'partial' ? 'online' : (work.presentationMode || 'online'),
                        storageOwner: undefined,
                        tracks: stripRuntimeVoiceMedia(work.tracks),
                    })),
            ),
        );
    } catch (error) {
        console.error('Failed to persist voice works:', error);
    }
    persistVoiceWorkJsonSnapshots();
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function flattenAudio(nodes, output = []) {
    for (const node of nodes || []) {
        if (getVoiceFileType(node) === 'audio') output.push(node);
        if (node.children) flattenAudio(node.children, output);
    }
    return output;
}

const EDITION_DISPLAY_ORDER = ['chi_hans', 'chi_hant', 'jpn'];

function displayVoiceTitle(work) {
    return String(work?.title || '')
        .replace(/^\s*(?:【(?:简体中文版|繁体中文版|簡体中文版|繁體中文版|中文版|English|英语版)】|\((?:简体中文版|繁体中文版|中文版|English)\))\s*/i, '')
        .trim();
}

function voiceGroupSourceCode(work) {
    return String(work?.sourceCode || work?.code || work?.id || '');
}

function voiceEditionShortLabel(lang, fallback = '') {
    const normalized = String(lang || '').toLowerCase();
    if (normalized === 'chi_hans' || normalized === 'zh_hans' || normalized === 'zh-cn') return '中';
    if (normalized === 'chi_hant' || normalized === 'zh_hant' || normalized === 'zh-tw') return '繁';
    if (normalized === 'jpn' || normalized === 'ja' || normalized === 'jp') return '日';
    if (normalized === 'eng' || normalized === 'en') return '英';
    return fallback;
}

function voiceGroupDisplayEdition(group) {
    const priority = (work) => {
        const index = EDITION_DISPLAY_ORDER.indexOf(String(work.editionLang || '').toLowerCase());
        return index < 0 ? EDITION_DISPLAY_ORDER.length : index;
    };
    return [...group.editions].sort(
        (a, b) => priority(a) - priority(b) || String(b.importedAt || '').localeCompare(String(a.importedAt || '')),
    )[0];
}

function voiceGroupsFor(worksList = works) {
    const map = new Map();
    for (const work of worksList) {
        if (!work?.id) continue;
        const sourceCode = voiceGroupSourceCode(work);
        const key = sourceCode || work.id;
        let group = map.get(key);
        if (!group) {
            group = { key, sourceCode, editions: [], trueCircle: '', translators: [] };
            map.set(key, group);
        }
        group.editions.push(work);
        if (Array.isArray(work.translators)) group.translators.push(...work.translators);
        if (work.code === sourceCode && (work.trueCircle || work.circle)) {
            group.trueCircle = work.trueCircle || work.circle;
        }
    }
    for (const group of map.values()) {
        group.displayWork = voiceGroupDisplayEdition(group);
        group.trueCircle = group.trueCircle || group.displayWork?.trueCircle || '';
        group.translators = voiceFilterUnique(group.translators);
    }
    return [...map.values()];
}

function voiceGroupForWork(work) {
    return voiceGroupsFor().find((group) => group.editions.some((edition) => edition.id === work.id)) || null;
}

function coverOverlayHtml(work, sourceCode = work?.code) {
    return `
        ${sourceCode ? `<span class="voice-cover-badge voice-cover-badge--code">${escapeHtml(sourceCode)}</span>` : ''}
        ${work.release ? `<span class="voice-cover-badge voice-cover-badge--release">${escapeHtml(work.release)}</span>` : ''}`;
}

const AGE_TAG_NAMES = new Set(['r-15', 'r-18']);
function voiceAgeValue(work) {
    const category = String(work.ageCategory || work.ageCategoryString || '').toLowerCase();
    if (category === 'r15') return 'r15';
    if (category === 'r18' || category === 'adult') return 'adult';
    if (category === 'unrated' || category === 'unknown') return 'unrated';
    return work.nsfw ? 'adult' : 'all';
}
function voiceAgeLabel(value) {
    if (value === 'r15') return t('voices.age.r15');
    if (value === 'adult') return t('voices.age.adult');
    if (value === 'unrated') return t('voices.age.unrated');
    return t('voices.age.all');
}
function ageTagHtml(work) {
    const value = voiceAgeValue(work);
    const label = voiceAgeLabel(value);
    return `<span class="voice-age-tag is-${value}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}
// Remove the old synthetic R-15/R-18 normal tags from already persisted works:
// they now live in the age dimension, not in the ordinary tag list.
function stripLegacyAgeTags(work) {
    if (!Array.isArray(work.tags)) return work;
    const derived = new Set([...AGE_TAG_NAMES, '本地文件', '部分本地']);
    const tags = work.tags.filter((tag) => !derived.has(String(tag).trim().toLowerCase()));
    return tags.length === work.tags.length ? work : { ...work, tags };
}

function voiceAudioHashes(work) {
    const result = new Set();
    const visit = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') visit(node.children);
            else if (node.type === 'audio' && node.hash) result.add(String(node.hash));
        }
    };
    visit(work?.tracks);
    return result;
}

function voiceStorageKind(work) {
    return work?.storageKind || (work?.fileStorage ? 'host' : 'online');
}

function voicePresentationMode(work) {
    return work?.presentationMode
        || (work?.fileStorage
            ? 'local'
            : work?.localFileStorageState === 'partial' ? 'partial' : 'online');
}

function voiceNodeStreamUrl(node) {
    return node?.localMediaStreamUrl || node?.mediaStreamUrl || '';
}

function voiceNodeDownloadUrl(node) {
    return node?.localMediaDownloadUrl || node?.localMediaStreamUrl || node?.mediaDownloadUrl || node?.mediaStreamUrl || '';
}

function voiceHostForWork(work) {
    if (!work || work.browserLocal) return null;
    return (globalThis.__monochromeFileStorageWorks || []).find(
        (entry) => voiceWorkCodesOverlap(entry, work),
    ) || null;
}

function voicePartialHostFor(work) {
    if (!work || work.browserLocal || voiceStorageKind(work) === 'host' || voicePresentationMode(work) === 'local') return null;
    const host = voiceHostForWork(work);
    if (!host) return null;
    if (!voiceHostHasLocalContent(host)) return null;
    if (host.__voicePartial) return host;
    const complete =
        fileNodeCount(host) >= fileNodeCount(work) &&
        audioNodeCount(host) >= audioNodeCount(work) &&
        (Boolean(host.hasLocalCover) || !work.cover);
    return complete ? null : host;
}

function voiceHostHasLocalContent(host) {
    const manifest = Array.isArray(host?.manifest) ? host.manifest : [];
    return manifest.some((entry) => {
        if (entry?.status !== 'local') return false;
        const logical = String(entry.logicalPath || '');
        return !/^\.monochrome\//i.test(logical) && !/(^|\/)folder\.(jpe?g|png|webp|avif)$/i.test(logical);
    });
}

function voiceLocalAvailability(work) {
    if (Array.isArray(work?.manifest)) return work.localFileStorageState || '';
    if (work?.localFileStorageState === 'partial') return 'partial';
    const partialHost = voicePartialHostFor(work);
    if (partialHost) return 'partial';
    if (work?.fileStorage || work?.browserLocal) {
        if (work?.browserLocal) return 'full';
        return work.localFileStorageState || '';
    }
    // A download journal is only trustworthy when this work has a host slice.
    // Pure online cards with no host must not inherit stale partial hashes from
    // an old download/import.
    if (!voiceHostForWork(work)) return '';
    const total = voiceAudioHashes(work);
    if (total.size === 0) return '';
    const downloaded = getDownloadedVoiceHashes(work.id);
    const matched = [...total].filter((hash) => downloaded.has(hash)).length;
    if (matched === 0) return '';
    return matched >= total.size ? 'full' : 'partial';
}

function voiceLocalBadgeHtml(work) {
    const state = voiceLocalAvailability(work);
    if (!state) return '';
    const label = t(state === 'full' ? 'voices.localAvailability.full' : 'voices.localAvailability.partial');
    return `<button type="button" class="voice-tag-chip voice-tag-chip--local voice-local-badge is-${state}${activeLocal.has(state) ? ' is-active' : ''}" data-filter-local="${state}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
}
function subtitleChipHtml(work) {
    if (!work.hasSubtitle) return '';
    return `<button type="button" class="voice-tag voice-tag-chip voice-tag-chip--subtitle${activeSubtitles.has('with') ? ' is-active' : ''}" data-filter-subtitle="with">${escapeHtml(t('voices.subtitle.badge'))}</button>`;
}
function normalTagChipsHtml(tags, limit = Infinity) {
    return tags
        .slice(0, limit)
        .map(
            (tag) => `<button type="button" class="voice-tag voice-tag-chip voice-tag-chip--tag${activeTags.has(tag) ? ' is-active' : ''}" data-filter-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`,
        )
        .join('');
}
function creatorRowsHtml(work, showLabels = false, inline = false, displayCircle = undefined, extraHtml = '') {
    const artists = work.artists || [];
    const circle = displayCircle === undefined ? work.circle || '' : displayCircle;
    const artistButtons = artists
        .map(
            (name) => `<button type="button" class="voice-creator-row voice-tag-chip voice-tag-chip--artist${activeArtists.has(name) ? ' is-active' : ''}" data-filter-artist="${escapeHtml(
                name,
            )}" title="${escapeHtml(t('voices.filter.artist'))}">${escapeHtml(name)}</button>`,
        )
        .join('');
    const circleButton = circle
        ? `<button type="button" class="voice-creator-row voice-tag-chip voice-tag-chip--circle${activeCircles.has(circle) ? ' is-active' : ''}" data-filter-circle="${escapeHtml(
              circle,
          )}" title="${escapeHtml(t('voices.filter.circle'))}">${escapeHtml(circle)}</button>`
        : '';
    if (inline) {
        return `<div class="voice-creators voice-creators--inline">${circleButton}${artistButtons}${extraHtml}</div>`;
    }
    return `
        <div class="voice-creators">
            ${
                circle
                    ? `<div class="voice-circle-row">
                        ${showLabels ? `<span class="voice-creator-label">${escapeHtml(t('voices.circle'))}</span>` : ''}
                        ${circleButton}
                    </div>`
                    : ''
            }
            ${
                artists.length
                    ? `<div class="voice-artist-row">
                        ${showLabels ? `<span class="voice-creator-label">${escapeHtml(t('voices.artist'))}</span>` : ''}
                        ${artistButtons}
                    </div>`
                    : ''
            }
        </div>`;
}
const VOICE_URL_TTL_MS = 5 * 60 * 1000;
// 自适应版会把 raw work 复制成多种视图；只在模块内再记一层，避免每次点不同 part
// 都因为视图对象没有 urlsResolvedAt 而重新探测/拉 tracks。
const voiceUrlRefreshCache = new Map();

function isOnlineAsmrVoiceWork(work) {
    return Boolean(work) && isAsmrFamilyBase(work.backendBase);
}

function mergeFreshTrackUrls(work, nodes) {
    let changed = false;
    const byHash = new Map();
    const index = (list) => {
        for (const node of list || []) {
            if (!node) continue;
            if (node.type === 'folder') index(node.children);
            else if (node.hash) byHash.set(node.hash, node);
        }
    };
    index(nodes);
    const apply = (list) => {
        for (const node of list || []) {
            if (!node) continue;
            if (node.type === 'folder') {
                apply(node.children);
                continue;
            }
            const fresh = node.hash ? byHash.get(node.hash) : null;
            if (!fresh) continue;
            if (fresh.mediaStreamUrl && fresh.mediaStreamUrl !== node.mediaStreamUrl) {
                node.mediaStreamUrl = fresh.mediaStreamUrl;
                changed = true;
            }
            if (fresh.mediaDownloadUrl && fresh.mediaDownloadUrl !== node.mediaDownloadUrl) {
                node.mediaDownloadUrl = fresh.mediaDownloadUrl;
                changed = true;
            }
            if (fresh.streamLowQualityUrl && fresh.streamLowQualityUrl !== node.streamLowQualityUrl) {
                node.streamLowQualityUrl = fresh.streamLowQualityUrl;
                changed = true;
            }
        }
    };
    apply(work.tracks);
    return changed;
}

/**
 * 在线 asmr 音声在播放前刷新文件树 URL。
 * 只对 asmr 系列 base 生效:自建 Kikoeru 与 demo 本地 fixture 不探测、不改写。
 * 导入时已拉过 tracks 并记录了 urlsResolvedAt,TTL 内直接复用,不额外发请求。
 */
async function ensureVoiceWorkUrls(work) {
    if (!isOnlineAsmrVoiceWork(work) || !work.workId) return;
    const resolvedAt = Math.max(Number(work.urlsResolvedAt || 0), Number(voiceUrlRefreshCache.get(work.id) || 0));
    if (Date.now() - resolvedAt <= VOICE_URL_TTL_MS) return;
    try {
        const preferredBase = await selectVoiceBase({ family: 'asmr' }).catch(() => '');
        const { json, base } = await fetchVoiceEndpointJson(
            `/api/tracks/${encodeURIComponent(work.workId)}?v=2`,
            { family: 'asmr', base: preferredBase || undefined }
        );
        mergeFreshTrackUrls(work, json);
        // 即使 URL 没变,也要记录刷新时间,否则 TTL 过期后会每次播放都重复请求。
        work.backendBase = base || work.backendBase;
        work.urlsResolvedAt = Date.now();
        voiceUrlRefreshCache.set(work.id, work.urlsResolvedAt);
        persistWorks();
    } catch (error) {
        console.warn('Failed to refresh voice work URLs:', error);
    }
}

async function playVoiceFile(work, node, format = getVoiceTrackFormat(node)) {
    if (getVoiceFileType(node) !== 'audio') return;
    // 播放不能被在线 URL 刷新阻塞：导入时 URL 已经解析过；这里后台补刷新，
    // 当前队列先立即开始，5s 预取也会在下一首前再校正。
    void ensureVoiceWorkUrls(work);
    const queue = getVoicePlaybackTracks(work, format);
    // A conservative duplicate decision must never make the explicitly clicked file inaccessible.
    if (!queue.some((entry) => entry.voiceHash === node.hash)) {
        const clicked = adaptVoiceWork(work).tracks.find((entry) => entry.voiceHash === node.hash);
        if (clicked) queue.push(clicked);
    }
    const index = Math.max(0, queue.findIndex((entry) => entry.voiceHash === node.hash));
    try {
        const player = Player.instance;
        await player.setQueue(queue, index);
        await player.playTrackFromQueue();
        const active = player.activeElement;
        if (active && !active.src && node.mediaStreamUrl) {
            active.src = node.mediaStreamUrl;
            active.load();
            await active.play().catch(() => {});
        }
        showNotification(`${t('voices.playing')}: ${node.title}`);
    } catch (error) {
        console.error('Failed to play voice file:', error);
        showNotification(t('voices.playFailed'));
    }
}

async function playVoiceWork(work, format = getVoiceDefaultFormat(work)) {
    void ensureVoiceWorkUrls(work);
    const first = getVoicePlaybackTracks(work, format)[0];
    if (!first) return;
    const node = flattenAudio(work.tracks).find((entry) => entry.hash === first.voiceHash);
    if (node) await playVoiceFile(work, node, format);
}

function findVoiceFile(nodes, hash) {
    for (const node of nodes || []) {
        if (node.type === 'folder') {
            const found = findVoiceFile(node.children, hash);
            if (found) return found;
        } else if (node.hash === hash) {
            return { node, images: nodes.filter((entry) => getVoiceFileType(entry) === 'image') };
        }
    }
    return null;
}

async function refreshVoiceAttachmentUrl(work, node) {
    if (!work?.workId || !node?.hash || !isAsmrFamilyBase(work.backendBase)) return '';
    try {
        const base = await selectVoiceBase({ family: 'asmr', maxAgeMs: 5 * 60 * 1000 }).catch(() => null);
        const result = await fetchVoiceEndpointJson(`/api/tracks/${encodeURIComponent(work.workId)}?v=2`, {
            family: 'asmr',
            base: base || undefined,
        });
        const tree = result?.json?.tree || result?.json?.tracks || result?.json?.data || [];
        const found = findVoiceFile(tree, node.hash);
        const fresh = safeFileUrl(found?.node?.mediaStreamUrl || found?.node?.mediaDownloadUrl);
        if (!fresh) return '';
        node.mediaStreamUrl = fresh;
        node.mediaDownloadUrl = safeFileUrl(found?.node?.mediaDownloadUrl) || fresh;
        const subtitle = deriveWorkSubtitles({ tracks: work.tracks, has_subtitle: work.has_subtitle });
        work.hasSubtitle = subtitle.hasSubtitle;
        return fresh;
    } catch {
        return '';
    }
}

function workCardHtml(work, group = voiceGroupForWork(work)) {
    const totalDuration = Number(work.duration) || voiceTotalDuration(work);
    const sourceCode = group?.sourceCode || voiceGroupSourceCode(work);
    const displayTitle = displayVoiceTitle(work);
    const trueCircle = group?.trueCircle || (work.code === sourceCode ? work.circle : '');
    const tags = work.tags || [];
    const shownTags = tags.slice(0, 3);
    const restTags = tags.length - shownTags.length;
    const selected = selectedIds.has(work.id);
    const listenStatus = voiceListenStatus(work);
    const listenDot = listenStatus
        ? `<span class="voice-card-listen-dot" data-listen-status="${escapeHtml(listenStatus)}" title="${escapeHtml(t('voices.listenStatus.current', { status: voiceListenLabel(listenStatus) }))}" aria-label="${escapeHtml(t('voices.listenStatus.current', { status: voiceListenLabel(listenStatus) }))}" role="img"></span>`
        : '';
    return `
        <article class="voice-card voice-card--selectable${selected ? ' voice-card--selected' : ''}" data-voice-id="${escapeHtml(work.id)}" data-voice-source="${escapeHtml(sourceCode)}" data-adult="${work.nsfw ? 'true' : 'false'}" tabindex="0" role="button">
            <div class="voice-card-cover-wrap">
                <button type="button" class="creation-select-check voice-select-check" data-select-voice-id="${escapeHtml(
                    work.id,
                )}" aria-pressed="${selected}" title="${escapeHtml(t('voices.library.selectWork', { title: work.title }))}"
                    aria-label="${escapeHtml(t('voices.library.selectWork', { title: work.title }))}">
                    <span aria-hidden="true">${selected ? '✓' : ''}</span>
                </button>
                <img class="voice-card-cover" src="${escapeHtml(coverSource(work.cover))}" alt="" referrerpolicy="no-referrer" loading="lazy" />
                ${coverOverlayHtml(work, sourceCode)}
                <span class="voice-card-age">${ageTagHtml(work)}</span>
            </div>
            <div class="voice-card-body">
                <h2 title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</h2>
                ${creatorRowsHtml(work, false, true, trueCircle)}
                <div class="voice-card-stats">
                    <span class="voice-rating">★ ${escapeHtml(Number(work.rating || 0).toFixed(2))}</span>
                    <span>${escapeHtml(formatDuration(totalDuration))}</span>
                    ${voiceLocalBadgeHtml(work)}${subtitleChipHtml(work)}
                </div>
                <div class="voice-card-tags">
                    ${listenDot}${normalTagChipsHtml(shownTags)}
                    ${restTags > 0 ? `<span class="voice-tag-more" tabindex="0" data-voice-tags="${escapeHtml(JSON.stringify(tags))}" title="${escapeHtml(t('voices.tagPopoverTitle'))}">+${restTags}</span>` : ''}
                </div>
            </div>
        </article>`;
}

function voiceListenStatus(work) {
    const value = work?.listenStatus;
    return LISTEN_STATUS_VALUES.has(value) ? value : '';
}

function voiceListenLabel(value) {
    const status = LISTEN_STATUSES.find((entry) => entry.value === value);
    return status ? t(status.labelKey) : '';
}

function voiceCircleValue(work) {
    const group = voiceGroupForWork(work);
    // A translated edition may carry the translator in `circle`; that is not a
    // circle and must not show up as a facet value (see js/voice-circle.js).
    return group?.trueCircle || voiceDisplayCircle(work) || '';
}

function matchesFilters(work, exclude = '') {
    const artistOk =
        exclude === 'artist' ||
        activeArtists.size === 0 ||
        (work.artists || []).some((name) => activeArtists.has(name));
    const circleOk = exclude === 'circle' || activeCircles.size === 0 || activeCircles.has(voiceCircleValue(work));
    const tagOk =
        exclude === 'tag' || activeTags.size === 0 || (work.tags || []).some((tag) => activeTags.has(tag));
    const ageOk = exclude === 'age' || activeAges.size === 0 || activeAges.has(voiceAgeValue(work));
    const localOk =
        exclude === 'local' || activeLocal.size === 0 || activeLocal.has(voiceLocalAvailability(work));
    const subtitleOk =
        exclude === 'subtitle' || activeSubtitles.size === 0 || (activeSubtitles.has('with') && work.hasSubtitle);
    const translatorOk =
        exclude === 'translator' ||
        activeTranslators.size === 0 ||
        (work.translators || []).some((name) => activeTranslators.has(name));
    const listenOk =
        exclude === 'listen' ||
        activeListenStatuses.size === 0 ||
        activeListenStatuses.has(voiceListenStatus(work));
    return artistOk && circleOk && tagOk && ageOk && localOk && subtitleOk && translatorOk && listenOk;
}

function updateSelectionUi(filtered) {
    const bar = document.getElementById('voices-selection-bar');
    const count = document.getElementById('voices-selected-count');
    const selectAll = document.getElementById('voices-select-all');
    const deleteButton = document.getElementById('voices-delete-selected');
    const clearAll = document.getElementById('voices-clear-all');
    const grid = document.getElementById('voices-grid');
    const hasSelection = selectedIds.size > 0;
    if (bar) bar.hidden = !hasSelection;
    if (clearAll) clearAll.hidden = works.length === 0 || hasSelection;
    const manage = document.getElementById('voices-manage');
    if (manage) {
        manage.hidden = works.length === 0 || hasSelection;
        if (manage.hidden) manage.open = false;
    }
    if (grid) grid.classList.toggle('is-selecting', hasSelection);
    if (count) count.textContent = t('selection.selectedCount', { count: selectedIds.size });
    if (selectAll) {
        const allSelected = filtered.length > 0 && filtered.every((work) => selectedIds.has(work.id));
        selectAll.textContent = t(allSelected ? 'voices.library.unselectResults' : 'voices.library.selectResults');
        selectAll.disabled = filtered.length === 0;
    }
    if (deleteButton) deleteButton.disabled = selectedIds.size === 0;
}

function toggleVoiceSelection(id) {
    const restoreFocus = document.activeElement?.matches('[data-select-voice-id]');
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    renderList();
    if (restoreFocus) [...document.querySelectorAll('[data-select-voice-id]')]
        .find((button) => button.dataset.selectVoiceId === id)?.focus({ preventScroll: true });
}

function toggleSelectAllVoices() {
    const filtered = visibleVoiceWorks();
    if (filtered.length > 0 && filtered.every((work) => selectedIds.has(work.id))) {
        filtered.forEach((work) => selectedIds.delete(work.id));
    } else {
        filtered.forEach((work) => selectedIds.add(work.id));
    }
    renderList();
}

function clearVoiceSelection() {
    selectedIds.clear();
    renderList();
}

async function deleteVoices(ids, singleTitle = '') {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const selectedWorks = works.filter((work) => idSet.has(work.id));
    const fileWorks = selectedWorks.filter((work) => work.fileStorage);
    const localKey = fileWorks.length > 0;
    const message =
        ids.length === 1 && singleTitle
            ? t(localKey ? 'selection.deleteSingleConfirmLocal' : 'selection.deleteSingleConfirm', { title: singleTitle })
            : t(localKey ? 'selection.deleteSelectedConfirmLocal' : 'selection.deleteSelectedConfirm', { count: ids.length });
    if (!window.confirm(message)) return;
    // Ask the file library for every selected work, not just the ones flagged
    // `fileStorage`: the flag lives on the merged work and a plain online entry
    // for a work that *is* in the library would otherwise be dropped from the UI
    // while its folder and row stayed behind. The bridge resolves ids against the
    // host's own list and is a no-op for works it does not own.
    const bridge = globalThis.__monochromeFileStorage;
    let folderLeft = 0;
    let unresolved = [];
    let deletedIds = [];
    if (typeof bridge?.deleteWorks === 'function') {
        try {
            const result = await bridge.deleteWorks(ids.map((id) => {
                const work = selectedWorks.find((entry) => entry.id === id);
                return work?.storageWorkId || id;
            }));
            folderLeft = Number(result?.folderLeft) || 0;
            unresolved = Array.isArray(result?.unresolved) ? result.unresolved : [];
            deletedIds = Array.isArray(result?.ids) ? result.ids : [];
        } catch (error) {
            console.error('file storage delete failed', error);
            showNotification(`文件库删除失败: ${error?.message || error}`);
            return;
        }
    } else if (fileWorks.length > 0) {
        showNotification('文件库删除不可用');
        return;
    }
    if (unresolved.length > 0 && unresolved.length === ids.length) {
        // Nothing matched a library row: removing the card here would make the work
        // reappear on the next refresh, which reads as "delete did nothing".
        console.error('voice delete: no file-library row matched', unresolved);
        showNotification(`未找到对应的文件库记录（${unresolved.join(', ')}），未删除任何内容`);
        return;
    }
    if (folderLeft > 0) {
        // The row is gone; only the folder survived a locked file. Saying nothing
        // left the user staring at a work that still had a folder in the library.
        showNotification(`已从库中移除，但 ${folderLeft} 个文件夹未能删除（文件被占用），请关闭后重试`);
    }
    // Tombstone first: the online record stays in localStorage, so the background
    // bundle migration would otherwise recreate the folder on the next load and the
    // work would come back with a cover-only directory.
    for (const work of selectedWorks) markVoiceDeleted(work);
    works = works.filter((work) => !idSet.has(work.id));
    if (!works.length) voiceImportOpen = null;
    for (const id of ids) {
        selectedIds.delete(id);
        clearVoiceDownloads(id);
    }
    persistWorks();
    if (document.getElementById('page-album')?.dataset.voiceWorkId || document.getElementById('voices-detail-view')?.hidden === false) navigate('/voices');
    else renderList();
    offerTrashUndo(deletedIds, selectedWorks);
}

/**
 * Tell the user the works are recoverable, and make that a real button.
 *
 * Deleting now moves the folder to `trash/` and only soft-deletes the row, so an
 * undo is a rename back — but the card is already gone from this view, and an
 * undo the user has to look up in a terminal is not an undo. The tombstone has to
 * be cleared too, otherwise the next bundle migration would treat the restored
 * work as deleted again.
 */
function offerTrashUndo(deletedIds, deletedWorks) {
    const bridge = globalThis.__monochromeFileStorage;
    if (!Array.isArray(deletedIds) || deletedIds.length === 0 || typeof bridge?.restoreWorks !== 'function') {
        showNotification(t('selection.deleted'));
        return;
    }
    showNotification(t('selection.deleted'), {
        action: {
            label: t('selection.undo'),
            onClick: async () => {
                const result = await bridge.restoreWorks(deletedIds);
                if ((Number(result?.restored) || 0) === 0) {
                    showNotification(t('selection.restoreFailed'));
                    return;
                }
                for (const work of deletedWorks || []) clearVoiceDeleted(work);
                // `restoreWorks` refreshed the host slice; rebuild this list from it
                // so the cards come back without a page reload.
                loadWorks();
                renderList();
                persistWorks();
                showNotification(t('selection.restored'));
            },
        },
    });
}

function deleteSelectedVoices() {
    deleteVoices([...selectedIds]);
}

async function clearAllVoices() {
    if (works.length === 0) return;
    const fileWorks = works.filter((work) => work.fileStorage);
    const confirmKey = fileWorks.length > 0 ? 'selection.deleteAllConfirmLocal' : 'selection.deleteAllConfirm';
    if (!window.confirm(t(confirmKey, { count: works.length }))) return;
    let deletedIds = [];
    if (fileWorks.length > 0) {
        const bridge = globalThis.__monochromeFileStorage;
        if (typeof bridge?.deleteWorks !== 'function') {
            showNotification('文件库删除不可用');
            return;
        }
        try {
            const result = await bridge.deleteWorks(fileWorks.map((work) => work.storageWorkId || work.id));
            deletedIds = Array.isArray(result?.ids) ? result.ids : [];
        } catch (error) {
            console.error('file storage clear failed', error);
            showNotification(`文件库删除失败: ${error?.message || error}`);
            return;
        }
    }
    for (const work of works) clearVoiceDownloads(work.id);
    works = [];
    selectedIds.clear();
    activeArtists.clear();
    activeCircles.clear();
    activeAges.clear();
    activeSubtitles.clear();
    activeTranslators.clear();
    activeLocal.clear();
    activeTags.clear();
    activeListenStatuses.clear();
    libraryQuery = '';
    voiceImportOpen = null;
    writeVoiceFiltersToUrl();
    persistWorks();
    renderList();
    // Clear-all does not tombstone (it empties the view, it does not hide the
    // online records), so the undo only has to restore the host rows.
    offerTrashUndo(deletedIds, []);
}

function voiceFilterUnique(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ja'));
}

function voiceFilterFacets() {
    const searched = queryVoiceLibrary(works, { query: libraryQuery, sort: librarySort });
    const count = (kind, predicate, value) =>
        searched.filter((work) => predicate(work, value) && matchesFilters(work, kind)).length;
    const groups = [];
    const circles = voiceFilterUnique(works.map((work) => voiceCircleValue(work)));
    if (circles.length) {
        groups.push({
            kind: 'circle',
            label: t('voices.filter.circle'),
            values: circles.map((value) => ({
                value,
                label: value,
                count: count('circle', (work, entry) => voiceCircleValue(work) === entry, value),
            })),
        });
    }
    const artists = voiceFilterUnique(works.flatMap((work) => work.artists || []));
    if (artists.length) {
        groups.push({
            kind: 'artist',
            label: t('voices.filter.artist'),
            values: artists.map((value) => ({
                value,
                label: value,
                count: count('artist', (work, entry) => (work.artists || []).includes(entry), value),
            })),
        });
    }
    if (works.length) {
        groups.push({
            kind: 'listen',
            label: t('voices.filter.listen'),
            values: LISTEN_STATUSES.map((status) => ({
                value: status.value,
                label: t(status.labelKey),
                count: count('listen', (work, entry) => voiceListenStatus(work) === entry, status.value),
            })),
        });
    }
    if (works.some((work) => voiceLocalAvailability(work))) {
        groups.push({
            kind: 'local',
            label: t('voices.filter.local'),
            values: [
                {
                    value: 'full',
                    label: t('voices.localAvailability.full'),
                    count: count('local', (work, entry) => voiceLocalAvailability(work) === entry, 'full'),
                },
                {
                    value: 'partial',
                    label: t('voices.localAvailability.partial'),
                    count: count('local', (work, entry) => voiceLocalAvailability(work) === entry, 'partial'),
                },
            ],
        });
    }
    groups.push({
        kind: 'age',
        label: t('voices.filter.age'),
        values: [
            {
                value: 'all',
                label: voiceAgeLabel('all'),
                count: count('age', (work, entry) => voiceAgeValue(work) === entry, 'all'),
            },
            {
                value: 'r15',
                label: voiceAgeLabel('r15'),
                count: count('age', (work, entry) => voiceAgeValue(work) === entry, 'r15'),
            },
            {
                value: 'adult',
                label: voiceAgeLabel('adult'),
                count: count('age', (work, entry) => voiceAgeValue(work) === entry, 'adult'),
            },
            {
                value: 'unrated',
                label: voiceAgeLabel('unrated'),
                count: count('age', (work, entry) => voiceAgeValue(work) === entry, 'unrated'),
            },
        ],
    });
    const translators = voiceFilterUnique(works.flatMap((work) => work.translators || []));
    if (translators.length) {
        groups.push({
            kind: 'translator',
            label: t('voices.filter.translator'),
            values: translators.map((value) => ({
                value,
                label: value,
                count: count('translator', (work, entry) => (work.translators || []).includes(entry), value),
            })),
        });
    }
    if (works.some((work) => work.hasSubtitle)) {
        groups.push({
            kind: 'subtitle',
            label: t('voices.filter.subtitle'),
            values: [
                {
                    value: 'with',
                    label: t('voices.subtitle.badge'),
                    count: count('subtitle', (work) => work.hasSubtitle, 'with'),
                },
            ],
        });
    }
    const tags = voiceFilterUnique(works.flatMap((work) => work.tags || []));
    if (tags.length) {
        groups.push({
            kind: 'tag',
            label: t('voices.filter.tag'),
            values: tags.map((value) => ({
                value,
                label: value,
                count: count('tag', (work, entry) => (work.tags || []).includes(entry), value),
            })),
        });
    }
    return groups;
}

function voiceFilterLabel(kind, value) {
    if (kind === 'listen') return voiceListenLabel(value);
    if (kind === 'age') return voiceAgeLabel(value);
    if (kind === 'local') return value === 'full' ? t('voices.localAvailability.full') : t('voices.localAvailability.partial');
    if (kind === 'subtitle') return t('voices.subtitle.badge');
    return value;
}

function voiceFilterSelected() {
    const selected = [];
    for (const value of activeCircles) selected.push({ kind: 'circle', value });
    for (const value of activeArtists) selected.push({ kind: 'artist', value });
    for (const value of activeListenStatuses) selected.push({ kind: 'listen', value });
    for (const value of activeAges) selected.push({ kind: 'age', value });
    for (const value of activeLocal) selected.push({ kind: 'local', value });
    for (const value of activeSubtitles) selected.push({ kind: 'subtitle', value });
    for (const value of activeTranslators) selected.push({ kind: 'translator', value });
    for (const value of activeTags) selected.push({ kind: 'tag', value });
    return selected;
}

function setVoicePageBackground(url) {
    const bg = document.getElementById('page-background');
    if (!bg) return;
    if (url && backgroundSettings.isEnabled()) {
        bg.style.backgroundImage = `url('${url}')`;
        bg.classList.add('active');
        document.body.classList.add('has-page-background');
    } else {
        bg.classList.remove('active');
        document.body.classList.remove('has-page-background');
    }
}
const renderVoiceGrid = createLibraryGridRenderer('data-voice-id');

function renderList() {
    const list = document.getElementById('voices-list-view');
    const detail = document.getElementById('voices-detail-view');
    if (!list || !detail) return;
    list.hidden = false;
    detail.hidden = true;
    setVoicePageBackground(null);
    const grid = document.getElementById('voices-grid');
    const empty = document.getElementById('voices-empty');
    if (!grid || !empty) return;
    const filtered = visibleVoiceWorks();
    const groups = voiceGroupsFor(filtered);
    const allGroups = voiceGroupsFor(works);
    renderVoiceGrid(
        grid,
        groups.map((group) => workCardHtml(group.displayWork, group)).join(''),
        groups.map((group) => group.displayWork.id),
    );
    empty.hidden = groups.length > 0;
    const total = document.getElementById('voices-library-total');
    if (total) total.textContent = t('voices.library.total', { count: allGroups.length });
    const status = document.getElementById('voices-library-status');
    const activeCount =
        activeArtists.size +
        activeCircles.size +
        activeTags.size +
        activeAges.size +
        activeLocal.size +
        activeSubtitles.size +
        activeTranslators.size +
        activeListenStatuses.size;
    if (status) status.textContent = t('voices.library.results', { shown: groups.length, total: allGroups.length }) +
        (activeCount ? ` · ${t('voices.library.activeFilters', { count: activeCount })}` : '');
    const search = document.getElementById('voices-library-search');
    if (search && search.value !== libraryQuery) search.value = libraryQuery;
    const sort = document.getElementById('voices-library-sort');
    if (sort) sort.value = librarySort;
    document.getElementById('voices-empty-title').textContent = t(works.length ? 'voices.library.noMatches' : 'voices.emptyTitle');
    document.getElementById('voices-empty-hint').textContent = t(works.length ? 'voices.library.noMatchesHint' : 'voices.emptyHint');
    document.getElementById('voices-manage').hidden = !works.length;
    if (voiceImportOpen === null) voiceImportOpen = works.length === 0;
    setVoiceImportOpen(voiceImportOpen);
    voiceLibraryFilters?.render();
    updateSelectionUi(filtered);
}

function treeNodeHtml(node) {
    if (node.type === 'folder') {
        const files = leafCount(node.children);
        return `<details class="voice-folder" open>
            <summary class="voice-tree-summary">
                <span class="voice-tree-caret" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="m9 18 6-6-6-6" />
                    </svg>
                </span>
                <span class="voice-tree-name">${escapeHtml(node.title)}</span>
                <span class="voice-tree-count">${files} ${escapeHtml(t('voices.files'))}</span>
            </summary>
            <div class="voice-folder-children">${(node.children || []).map(treeNodeHtml).join('')}</div>
        </details>`;
    }
    const type = getVoiceFileType(node);
    const label = t(`voices.fileType.${type}`);
    const downloadUrl = safeFileUrl(voiceNodeDownloadUrl(node));
    const streamUrl = safeFileUrl(voiceNodeStreamUrl(node));
    const download = downloadUrl
        ? `<a class="btn btn-secondary voice-file-download" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(node.title)}" target="_blank" rel="noreferrer" title="${escapeHtml(t('voices.download'))}" aria-label="${escapeHtml(t('voices.download'))}">${SVG_DOWNLOAD(16)}</a>`
        : '';
    const play =
        getVoiceFileType(node) === 'audio' && streamUrl
            ? `<button type="button" class="btn btn-secondary voice-file-play" data-voice-hash="${escapeHtml(node.hash)}">${escapeHtml(t('voices.play'))}</button>`
            : '';
    const duration =
        getVoiceFileType(node) === 'audio' && Number(node.duration) > 0
            ? `<span class="voice-file-duration">${escapeHtml(formatDuration(node.duration))}</span>`
            : '';
    const open =
        getVoiceFileType(node) !== 'audio' && streamUrl
            ? `<a class="voice-file-open" href="${escapeHtml(streamUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t('voices.open'))}</a>`
            : '';
    return `<div class="voice-file voice-tree-leaf" data-voice-hash="${escapeHtml(node.hash)}">
        <span class="voice-tree-branch" aria-hidden="true"></span>
        <span class="voice-file-type" data-type="${type}">${escapeHtml(label)}</span>
        <span class="voice-file-title">${escapeHtml(node.title)}</span>
        ${duration}
        ${play}${open}${download}
    </div>`;
}

// 音频列表和主操作由原生专辑页负责;来源特有的信息与非音频附件在这里补充。
function normalizeVoiceLocalName(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function voiceAlbumHierarchyHtml(nodes, path = [], counter = { index: 0, folderIndex: 0 }, openKeys = null, localNames = null, localHashes = null) {
    return (nodes || [])
        .map((node) => {
            if (node.type === 'folder') {
                const children = node.children || [];
                const folderPath = [...path, node.title];
                const folderIndex = counter.folderIndex++;
                const open = openKeys ? openKeys.has(JSON.stringify(folderPath)) : true;
                return `<details class="voice-album-folder"${open ? ' open' : ''} style="--voice-depth:${path.length}" data-voice-depth="${path.length}" data-voice-folder-path="${escapeHtml(JSON.stringify(folderPath))}">
                    <summary class="voice-album-folder-row" data-voice-depth="${path.length}">
                        <label class="voice-folder-selector"><input type="checkbox" class="voice-folder-select voice-native-checkbox" data-voice-select-folder="${folderIndex}" aria-label="${escapeHtml(t('voices.selectFolder', { title: node.title }))}" /></label>
                        <span class="voice-folder-main">
                            <svg class="voice-album-folder-caret" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
                            <svg class="voice-album-folder-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                            <span class="voice-album-folder-name">${escapeHtml(node.title)}</span>
                            <span class="voice-album-folder-count">${leafCount(children)} ${escapeHtml(t('voices.files'))}</span>
                            <button type="button" class="voice-album-folder-menu" data-voice-folder-path="${escapeHtml(JSON.stringify(folderPath))}" title="${escapeHtml(t('voices.folderActions'))}" aria-label="${escapeHtml(t('voices.folderActions'))}" aria-haspopup="menu">${SVG_MENU(16)}</button>
                        </span>
                    </summary>
                    <div class="voice-album-folder-children">${voiceAlbumHierarchyHtml(children, [...path, node.title], counter, openKeys, localNames, localHashes)}</div>
                </details>`;
            }
            const index = ++counter.index;
            const type = getVoiceFileType(node);
            const nodeTitle = String(node.title || '');
            const isLocal = Boolean(localNames?.has(normalizeVoiceLocalName(nodeTitle)) || localHashes?.has(String(node.hash)));
            const notLocal = Boolean(localNames) && !isLocal;
            const voicePath = [...path, nodeTitle].join('/');
            const streamUrl = safeFileUrl(voiceNodeStreamUrl(node));
            const downloadUrl = safeFileUrl(voiceNodeDownloadUrl(node));
            const queue = getVoiceFileType(node) === 'audio'
                ? `<button type="button" class="btn btn-secondary voice-file-queue" data-voice-queue-hash="${escapeHtml(node.hash)}" title="${escapeHtml(t('voices.queueSelected'))}" aria-label="${escapeHtml(t('voices.queueSelected'))}">${SVG_PLUS(16)}</button>`
                : '';
            const download = downloadUrl
                ? `<a class="btn btn-secondary voice-file-download" data-voice-download-hash="${escapeHtml(node.hash)}" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(node.title)}" target="_blank" rel="noreferrer" title="${escapeHtml(t('voices.download'))}" aria-label="${escapeHtml(t('voices.download'))}">${SVG_DOWNLOAD(16)}</a>`
                : '';
            const duration =
                getVoiceFileType(node) === 'audio' ? (Number(node.duration) > 0 ? formatDuration(node.duration) : '--:--') : '';
            const subline = path.length ? path.join(' / ') : t('voices.fileType.' + type);
            const menu = getVoiceFileType(node) === 'audio'
                ? `<button type="button" class="track-menu-btn" title="${escapeHtml(t('voices.actions'))}">${SVG_MENU(18)}</button>`
                : `<button type="button" class="voice-file-menu-btn" title="${escapeHtml(t('voices.actions'))}" aria-label="${escapeHtml(t('voices.actions'))}" aria-haspopup="menu">${SVG_MENU(18)}</button>`;
            // 附件保留统一行外观，但不能注册为音轨，否则链接/右键/多选会误入播放器委托。
            const trackAttributes = type === 'audio' ? `data-track-id="${escapeHtml(node.hash)}" data-type="track"` : '';
            const fileAttributes = type !== 'audio' && streamUrl ? `role="button" tabindex="0" aria-label="${escapeHtml(t('voices.open') + ' ' + node.title)}"` : '';
            return `<div class="voice-album-row-hitbox" data-voice-depth="${path.length}" style="--voice-depth:${path.length}"><label class="voice-row-selector"><input type="checkbox" class="voice-file-select voice-native-checkbox" data-voice-select-index="${index - 1}" data-voice-local="${isLocal ? '1' : '0'}" aria-label="${escapeHtml(t('voices.selectFile', { title: node.title }))}" /></label><div class="${type === 'audio' ? 'track-item' : 'voice-album-file-row'} voice-album-track-row" ${trackAttributes} ${fileAttributes} data-voice-hash="${escapeHtml(node.hash)}" data-voice-type="${type}" data-voice-path="${escapeHtml(node.logicalPath || voicePath)}" data-voice-local="${isLocal ? '1' : '0'}">
                <div class="track-number">${index}</div>
                <div class="track-item-info">
                    <div class="track-item-details">
                        <div class="title"><span class="voice-album-type" data-type="${type}">${escapeHtml(t('voices.fileType.' + type))}</span>${escapeHtml(node.title)}${notLocal ? `<span class="voice-file-local-state is-missing">${escapeHtml(t('voices.notDownloaded'))}</span>` : ''}</div>
                        <div class="artist">${escapeHtml(subline)}</div>
                    </div>
                </div>
                <div class="track-item-duration">${escapeHtml(duration)}</div>
                <div class="track-item-actions">${queue}${download}${menu}</div>
            </div></div>`;
        })
        .join('');
}

function voiceArchiveName(value) {
    const name = String(value ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
    // 文件夹名不能把 ZIP 条目变成 ../ 路径;保留正常的源文件名与扩展名。
    return !name || /^\.+$/.test(name) ? 'file' : name;
}

/** 原生菜单也使用音声源文件,避免把 voice ID 交给在线曲库的元数据下载器。 */
export async function downloadVoiceItem(item, type = 'track') {
    try {
        if (type === 'album') {
            await downloadVoiceAlbum(getVoiceAlbum(item.id).work, document.createElement('button'));
            return;
        }
        const track = getVoiceTrack(item.id);
        let url = safeFileUrl(track.downloadUrl || track.audioUrl);
        if (track.fileStorage && typeof globalThis.__monochromeFileStorage?.resolveTrackUrl === 'function') {
            url = await globalThis.__monochromeFileStorage
                .resolveTrackUrl(track.voiceWorkId, track.voiceHash)
                .catch(() => null) || url;
        }
        if (!url) throw new Error('Voice download URL is unavailable');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = voiceArchiveName(track.title);
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
        console.error('Failed to download voice item:', error);
        showNotification(t('voices.downloadAlbumFailed'));
    }
}

let activeVoiceDownload = null;
const voiceDownloadPanel = createVoiceDownloadPanel();
let voiceFolderMenuCleanup = null;

function setVoiceDownloadButtonBusy(button, busy) {
    if (!button) return;
    button.toggleAttribute('data-voice-download-busy', busy);
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
}

function closeVoiceFolderMenu() {
    voiceFolderMenuCleanup?.();
    voiceFolderMenuCleanup = null;
}

function openVoiceDownloadDestinationMenu(anchor, work, folderPath = [], nodes = null) {
    closeVoiceFolderMenu();
    const menu = document.createElement('div');
    menu.className = 'voice-folder-menu voice-download-destination-menu';
    menu.setAttribute('role', 'menu');
    const add = (label, destination) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'voice-folder-menu-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
            void startVoiceDownload(work, folderPath, anchor, nodes, destination);
        });
        menu.append(item);
    };
    const selectedCount = Array.isArray(nodes) ? nodes.length : 0;
    const fileLabel = selectedCount
        ? t('voices.downloadSelectionFiles', { count: selectedCount })
        : folderPath.length
            ? t('voices.downloadFolder')
            : t('voices.downloadAlbum');
    add(fileLabel, 'folder');
    if (!work.fileStorage) add(t('voices.saveToLibrary'), 'storage');
    document.body.append(menu);

    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;

    const close = () => {
        menu.remove();
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeydown);
    };
    const onDocumentClick = (event) => {
        if (menu.contains(event.target) || anchor.contains(event.target)) return;
        close();
    };
    const onKeydown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            anchor.focus();
        }
    };
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeydown);
    menu.querySelector('button')?.focus();
}

function voiceStorageHostFor(work) {
    if (work?.fileStorage && work.storageWorkId) return work;
    const partial = voicePartialHostFor(work);
    if (partial) return partial;
    // The album page can hand us the *online* record (no `storageWorkId`), which
    // made "delete from library" bail out with a notification and do nothing. The
    // merged list still holds the host slice for the same work, so resolve it the
    // same way by code overlap.
    if (!work || work.browserLocal) return null;
    const match = (works || []).find((entry) =>
        entry?.fileStorage && entry.storageWorkId && entry.id !== work.id && voiceWorkCodesOverlap(entry, work));
    return match || null;
}

function voiceRowNode(work, row) {
    return findVoiceFile(work?.tracks, row?.dataset.voiceHash)?.node || null;
}

function voiceStorageActionLabel(isLocal) {
    return isLocal ? t('voices.deleteFromLibrary') : t('voices.downloadToLibrary');
}

async function deleteVoiceLocalFiles(work, paths, anchor = null, hashes = []) {
    const host = voiceStorageHostFor(work);
    const bridge = globalThis.__monochromeFileStorage;
    if (typeof bridge?.deleteFiles !== 'function') {
        showNotification(t('voices.deleteFromLibraryFailed'));
        return;
    }
    // When the merged list has no host slice for this work, still ask the bridge:
    // it resolves the id against `/api/works` itself. Sending the raw id used to be
    // a hard failure here, which is why "delete from library" claimed the work was
    // not in the library while the album was showing files from it.
    const targetId = host?.storageWorkId || work?.storageWorkId || work?.id || work?.code || '';
    if (!window.confirm(t('voices.deleteFilesConfirm', { count: paths.length }))) return;
    if (anchor) setVoiceDownloadButtonBusy(anchor, true);
    try {
        if (Array.isArray(hashes) && hashes.length) {
            const byHash = new Map();
            const walk = (nodes) => {
                for (const node of nodes || []) {
                    if (node.type === 'folder') walk(node.children);
                    else if (node.hash && node.logicalPath) byHash.set(String(node.hash), String(node.logicalPath));
                }
            };
            walk(host?.tracks || work?.tracks);
            paths = [...new Set([
                ...paths,
                ...hashes.map((hash) => byHash.get(String(hash))).filter(Boolean),
            ])];
        }
        // An empty list makes `deleteStorageFiles` return {count: 0} without ever
        // calling the host, which then reads as "no matching entry". Say what
        // actually happened: the row carried no path.
        if (!paths.length) {
            console.error('voice delete: the row carried no logical path', { id: work?.id, hashes });
            showNotification('从文件库删除失败：该行没有可删除的路径');
            return;
        }
        const result = await bridge.deleteFiles(targetId, paths);
        if (result?.unresolved) {
            console.error('voice delete: the library holds no work for this record', {
                targetId,
                id: work?.id,
                code: work?.code,
                storageWorkId: host?.storageWorkId,
            });
            showNotification(`未找到该作品在文件库中的记录（${work?.code || work?.id || '?'}），无法删除文件`);
            return;
        }
        clearVoiceDownloadHashes(work.id, hashes);
        const count = Number(result?.count ?? result?.deleted?.length) || 0;
        const aliases = Number(result?.aliases) || 0;
        // Refresh even when the host reports missing paths: the open album may
        // still be showing rows from an earlier successful delete.
        await globalThis.__monochromeFileStorage?.refresh?.();
        const current = works.find((entry) => entry.id === work.id) ||
            works.find((entry) => voiceWorkCodesOverlap(entry, work)) || work;
        refreshVoiceAlbumAfterDownload(current);
        if (aliases > 0) {
            const aliasMissing = (result?.missing || []).find((item) => item?.reason === 'alias');
            const edge = voiceGroupForWork(work);
            const canonicalEdition = (edge?.editions || []).find(
                (entry) => String(entry.code || '').toUpperCase() === String(aliasMissing?.canonicalEditionCode || '').toUpperCase(),
            );
            const editionName = ({
                chi_hans: '中文版',
                zh_hans: '中文版',
                chi_hant: '繁體中文版',
                zh_hant: '繁體中文版',
                jpn: '日文版',
                eng: '英文版',
            })[String(canonicalEdition?.editionLang || '').toLowerCase()]
                || `${canonicalEdition?.editionLabel || aliasMissing?.canonicalEditionCode || '原'}版`;
            const canonicalTitle = String(aliasMissing?.canonicalTitle || aliasMissing?.aliasOf || '')
                .split('/')
                .pop()
                .replace(/\.[^.]+$/, '');
            showNotification(t('voices.aliasDeleteHint', {
                edition: editionName,
                title: canonicalTitle || '?',
            }));
        } else if (count > 0) {
            showNotification(t('voices.deletedFromLibrary', { count }));
        } else {
            // The host answered but deleted nothing. Its `missing` list says why
            // ("entry not found" = the path is not a row of this work; "invalid
            // path" = the frontend built something unusable), and that distinction
            // is the whole diagnosis — collapsing it into "删除失败" is what left
            // this unreported for two rounds.
            const missing = Array.isArray(result?.missing) ? result.missing : [];
            const reason = missing[0]?.reason || 'no matching entry';
            console.error('voice delete: host deleted nothing', { workId: targetId, paths, missing });
            showNotification(`从文件库删除失败：${reason}${missing.length > 1 ? ` 等 ${missing.length} 项` : ''}`);
        }
    } catch (error) {
        // A rejected request (404 work not found, 500, host down) lands here and used
        // to show the same unexplained message as "matched nothing". Keep the reason.
        console.error('Failed to delete voice files from library:', error);
        showNotification(`从文件库删除失败：${error?.message || error}`);
    } finally {
        if (anchor) setVoiceDownloadButtonBusy(anchor, false);
    }
}

async function toggleVoiceRowStorage(work, row, anchor = null) {
    if (!row) return;
    if (voiceRowIsLocal(work, row)) {
        await deleteVoiceLocalFiles(work, [row.dataset.voicePath].filter(Boolean), anchor, [row.dataset.voiceHash]);
        return;
    }
    const node = voiceRowNode(work, row);
    if (!node) return;
    await startVoiceDownload(work, [], anchor, [node], 'storage');
}

function openVoiceFileStorageMenu(button, work, row) {
    closeVoiceFolderMenu();
    const isLocal = voiceRowIsLocal(work, row);
    const menu = document.createElement('div');
    menu.className = 'voice-folder-menu voice-file-storage-menu';
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `voice-folder-menu-item${isLocal ? ' is-danger' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.textContent = voiceStorageActionLabel(isLocal);
    item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeVoiceFolderMenu();
        void toggleVoiceRowStorage(work, row, button);
    });
    menu.append(item);
    document.body.append(menu);
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;
    const close = () => {
        menu.remove();
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeydown);
    };
    const onDocumentClick = (event) => {
        if (menu.contains(event.target) || button.contains(event.target)) return;
        close();
    };
    const onKeydown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            button.focus();
        }
    };
    setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
    document.addEventListener('keydown', onKeydown);
    voiceFolderMenuCleanup = close;
    menu.querySelector('button')?.focus();
}

let pendingVoiceMenuState = null;

function voiceRowIsLocal(work, row) {
    // The rendered badge is authoritative: it already accounts for partial
    // host entries, while dataset.voiceLocal can lag until the next render.
    if (row?.querySelector('.voice-file-local-state.is-missing')) return false;
    if (row?.dataset.voiceLocal === '1') return true;
    return Boolean(work?.fileStorage);
}

function appendVoiceStorageActionToContextMenu(work, row, isLocal = voiceRowIsLocal(work, row)) {
    const menu = document.getElementById('context-menu');
    if (!menu || menu.style.display === 'none' || !menu.querySelector('ul')) return;
    menu.querySelector('.voice-storage-action')?.remove();
    // The row download/queue buttons are the direct entries now; keep the
    // context menu focused on library state.
    menu.querySelector('li[data-action="download"]')?.remove();
    menu.querySelector('li[data-action="add-to-queue"]')?.remove();
    const item = document.createElement('li');
    item.className = `voice-storage-action${isLocal ? ' is-danger' : ''}`;
    item.textContent = voiceStorageActionLabel(isLocal);
    item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        menu.style.display = 'none';
        void toggleVoiceRowStorage(work, row);
    });
    menu.querySelector('ul').append(item);
}

function voiceFolderFileEntries(work, path) {
    let nodes = work?.tracks || [];
    for (const segment of path) {
        const folder = (nodes || []).find((node) => node.type === 'folder' && node.title === segment);
        if (!folder) return [];
        nodes = folder.children || [];
    }
    const entries = [];
    const walk = (items, prefix) => {
        for (const node of items || []) {
            if (node.type === 'folder') walk(node.children, [...prefix, node.title]);
            else if (node.title) entries.push({ node, path: node.logicalPath || [...prefix, node.title].join('/'), title: String(node.title) });
        }
    };
    walk(nodes, path);
    return entries;
}

function voiceFolderIsLocal(work, path) {
    if (work?.fileStorage) return true;
    const host = voicePartialHostFor(work);
    if (!host) return false;
    const localTitles = new Set();
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') walk(node.children);
            else if (node.title) localTitles.add(String(node.title));
        }
    };
    walk(host.tracks);
    const entries = voiceFolderFileEntries(work, path);
    return entries.length > 0 && entries.every((entry) => localTitles.has(entry.title));
}

function openVoiceFolderMenu(button, work) {
    closeVoiceFolderMenu();
    let path = [];
    try {
        path = JSON.parse(button.dataset.voiceFolderPath || '[]');
    } catch {
        return;
    }
    const menu = document.createElement('div');
    menu.className = 'voice-folder-menu';
    menu.setAttribute('role', 'menu');
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'voice-folder-menu-item';
    download.setAttribute('role', 'menuitem');
    download.textContent = t('voices.downloadFolder');
    menu.append(download);
    const storage = document.createElement('button');
    storage.type = 'button';
    storage.className = 'voice-folder-menu-item';
    storage.setAttribute('role', 'menuitem');
    const folderLocal = voiceFolderIsLocal(work, path);
    storage.textContent = folderLocal ? t('voices.deleteFromLibrary') : t('voices.saveToLibrary');
    storage.classList.toggle('is-danger', folderLocal);
    menu.append(storage);
    document.body.append(menu);

    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;

    const close = () => {
        menu.remove();
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeydown);
        voiceFolderMenuCleanup = null;
    };
    const onDocumentClick = (event) => {
        if (menu.contains(event.target) || button.contains(event.target)) return;
        close();
    };
    const onKeydown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            button.focus();
        }
    };
    download.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
        void startVoiceDownload(work, path, button);
    });
    storage.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
        if (folderLocal) {
            const entries = voiceFolderFileEntries(work, path);
            void deleteVoiceLocalFiles(work, entries.map((entry) => entry.path), button, entries.map((entry) => entry.node.hash));
        } else {
            void startVoiceDownload(work, path, button, null, 'storage');
        }
    });
    setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
    document.addEventListener('keydown', onKeydown);
    voiceFolderMenuCleanup = close;
}

function ensureVoiceDownloadPanel(plan) {
    voiceDownloadPanel.start(plan, { onCancel: () => activeVoiceDownload?.controller.abort() });
}

function updateVoiceDownloadPanel(event) {
    voiceDownloadPanel.update(event);
}

function markVoiceDownloadRowsLocal(work, hashes) {
    const page = document.getElementById('page-album');
    if (!page || page.dataset.voiceWorkId !== work.id || !page.classList.contains('active')) return;
    const wanted = new Set([...hashes].map(String));
    for (const row of page.querySelectorAll('.voice-album-track-row[data-voice-hash]')) {
        if (!wanted.has(String(row.dataset.voiceHash))) continue;
        row.dataset.voiceLocal = '1';
        row.querySelector('.voice-file-local-state.is-missing')?.remove();
        row.closest('.voice-album-row-hitbox')?.querySelector('.voice-file-select')?.setAttribute('data-voice-local', '1');
    }
}

const partialOnlineHydration = new Set();

/**
 * A partial host work may be opened before the online catalog record exists in
 * `works` (for example after a restart, or when the host work is the only card).
 * Fetch the online tree on album open only, then re-merge so the full remote
 * file list and remote badges are available. Startup refresh is still host-only.
 */
function manifestFromOnlineWork(online, host) {
    const localHashes = new Set();
    const localPaths = new Set();
    const walkHost = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') walkHost(node.children);
            else {
                if (node.hash) localHashes.add(String(node.hash));
                if (node.logicalPath) localPaths.add(String(node.logicalPath));
            }
        }
    };
    walkHost(host?.tracks);
    const entries = [];
    const walkOnline = (nodes, path = []) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') {
                walkOnline(node.children, [...path, node.title]);
                continue;
            }
            const logicalPath = String(node.logicalPath || [...path, node.title].join('/'));
            const local = localHashes.has(String(node.hash)) || localPaths.has(logicalPath);
            entries.push({
                logicalPath,
                title: String(node.title || logicalPath.split('/').pop() || ''),
                kind: node.type || 'file',
                hash: node.hash || '',
                status: local ? 'local' : 'remote',
                mediaStreamUrl: node.mediaStreamUrl || '',
                mediaDownloadUrl: node.mediaDownloadUrl || '',
                duration: Number(node.duration) || 0,
                mime: node.mime || '',
                bytes: Number(node.bytes) || 0,
            });
        }
    };
    walkOnline(online.tracks);
    return entries.length ? { version: 1, generatedAt: new Date().toISOString(), entries } : null;
}

async function hydratePartialOnlineWork(work) {
    // A host work whose online record is gone (restart, cleared storage) is
    // exactly the case where the full remote tree gets lost. The old guard only
    // allowed `partial`, so a work without a manifest looked `full` and never
    // went back to Kikoeru. Allow any host work with local content here; the
    // fetch below is still gated on an RJ code, so purely local works never
    // touch the network.
    if (!work?.fileStorage) return;
    if (works.some((entry) => !entry.fileStorage && !entry.browserLocal && voiceWorkCodesOverlap(entry, work))) return;
    if (!voiceHostHasLocalContent(work)) return;
    const key = String(work.id || work.storageWorkId || '');
    if (!key || partialOnlineHydration.has(key)) return;
    partialOnlineHydration.add(key);
    const primaryCode = String(work.code || work.sourceCode || '').toUpperCase();
    const codes = [...voiceWorkCodeSet(work)].sort((left, right) => {
        if (left === primaryCode) return -1;
        if (right === primaryCode) return 1;
        return 0;
    });
    // `voiceWorkCodeSet` only keeps RJ codes; an empty set means a local folder
    // with nothing to look up, so do not issue a request for it.
    if (!codes.length) return;
    for (const code of codes) {
        try {
            const online = await fetchKikoeruWork(code, {
                retries: 1,
                signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(6000) : undefined,
            });
            if (!online || !Array.isArray(online.tracks) || online.tracks.length === 0) continue;
            const host = voiceHostForWork(work);
            const manifest = manifestFromOnlineWork(online, host);
            if (host?.storageWorkId && manifest) {
                await globalThis.__monochromeFileStorage?.updateMetadata?.(host.storageWorkId, { manifest });
                await globalThis.__monochromeFileStorage?.refresh?.();
            }
            if (!works.some((entry) => entry.id === online.id)) {
                works = [online, ...works];
                persistWorks();
            }
            mergeFileStorageWorks(globalThis.__monochromeFileStorageWorks || []);
            const current = works.find((entry) => entry.id === online.id) || online;
            refreshVoiceAlbumAfterDownload(current);
            return;
        } catch {
            // try the next edition/code; failures are non-fatal
        }
    }
}

function refreshVoiceAlbumAfterDownload(work) {
    renderList();
    const current = works.find((entry) => entry.id === work.id) || work;
    const page = document.getElementById('page-album');
    if (page?.dataset.voiceWorkId === current.id && page.classList.contains('active')) {
        renderAlbumExtras(current);
    }
}

async function downloadVoiceZipPlan(plan, signal) {
    let completed = 0;
    let current = -1;
    let loaded = 0;
    let total = 0;
    let fileDone = false;
    try {
        const { downloadZip } = await import('client-zip');
        const entries = async function* () {
            for (const [index, file] of plan.files.entries()) {
                current = index;
                loaded = 0;
                fileDone = false;
                const fresh = file.fileStorage && typeof globalThis.__monochromeFileStorage?.resolveTrackUrl === 'function'
                    ? await globalThis.__monochromeFileStorage.resolveTrackUrl(file.voiceWorkId, file.voiceHash).catch(() => null)
                    : null;
                const response = await fetch(fresh || file.url, { signal });
                if (!response.ok) throw new Error(`${response.status} ${file.segments.join('/')}`);
                total = Number(response.headers.get('content-length')) || file.size || 0;
                updateVoiceDownloadPanel({ type: 'file', index, state: 'downloading', loaded, total });
                let input = response;
                if (response.body && typeof TransformStream === 'function') {
                    input = new Response(response.body.pipeThrough(new TransformStream({
                        transform(chunk, controller) {
                            loaded += chunk.byteLength;
                            updateVoiceDownloadPanel({ type: 'file', index, state: 'downloading', loaded, total });
                            controller.enqueue(chunk);
                        }
                    })), { headers: response.headers });
                }
                yield { name: file.segments.join('/'), input };
                fileDone = true;
                completed++;
                updateVoiceDownloadPanel({ type: 'file', index, state: 'done', loaded: loaded || total, total: total || loaded });
                updateVoiceDownloadPanel({ type: 'job', state: 'progress', total: plan.files.length, completed, failed: 0 });
            }
        };
        const zip = downloadZip(entries());
        const plannedBytes = plan.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
        // A ZIP fallback must never materialize a multi-hundred-MB archive in
        // renderer memory. When File System Access can stream to a chosen file,
        // pipe the ZIP response directly to disk; <256 MiB keeps the old Blob path.
        if (plannedBytes > 256 * 1024 * 1024 && typeof window.showSaveFilePicker === 'function') {
            let handle;
            try {
                handle = await window.showSaveFilePicker({
                    suggestedName: `${plan.rootName}.zip`,
                    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
                });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                handle = null;
            }
            if (handle && zip.body) {
                const writable = await handle.createWritable();
                await zip.body.pipeTo(writable, { signal });
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                updateVoiceDownloadPanel({ type: 'job', state: 'done', total: plan.files.length, completed, failed: 0 });
                return { completed, failed: 0, canceled: false };
            }
        }
        const blob = await zip.blob();
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `${plan.rootName}.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        updateVoiceDownloadPanel({ type: 'job', state: 'done', total: plan.files.length, completed, failed: 0 });
        return { completed, failed: 0, canceled: false };
    } catch (error) {
        const canceled = signal.aborted;
        if (current >= 0 && !fileDone) updateVoiceDownloadPanel({ type: 'file', index: current, state: canceled ? 'canceled' : 'error', loaded, total, error: canceled ? '' : error.message });
        updateVoiceDownloadPanel({ type: 'job', state: canceled ? 'canceled' : 'error', total: plan.files.length, completed, failed: canceled ? 0 : 1 });
        throw error;
    }
}

async function startVoiceDownload(work, folderPath = [], button = null, selectedNodes = null, destination = 'folder') {
    if (activeVoiceDownload) {
        voiceDownloadPanel.expand();
        showNotification(t('voices.downloadAlreadyRunning'));
        return;
    }
    const plan = selectedNodes === null ? createVoiceDownloadPlan(work, folderPath) : createVoiceSelectedDownloadPlan(work, selectedNodes);
    if (!plan.files.length) {
        showNotification(t('voices.noFiles'));
        return;
    }
    const controller = new AbortController();
    // Reserve the job before awaiting the picker, so two buttons cannot start competing global tasks.
    activeVoiceDownload = { controller, plan };
    setVoiceDownloadButtonBusy(button, true);
    if (destination === 'storage') {
        try {
            ensureVoiceDownloadPanel(plan);
            const bridge = globalThis.__monochromeFileStorage;
            if (typeof bridge?.importVoicePlan !== 'function') throw new Error('storage host is not running');
            const result = await bridge.importVoicePlan(plan, work, {
                signal: controller.signal,
                onProgress: updateVoiceDownloadPanel,
            });
            updateVoiceDownloadPanel({ type: 'job', state: 'done', total: plan.files.length, completed: plan.files.length, failed: 0 });
            recordVoiceDownloads(work.id, (result.hashes || []).filter(Boolean));
            await bridge.refresh?.();
            // Re-render the album from refreshed host state so local badges and
            // row menus update immediately instead of waiting for a manual reload.
            // Do NOT dispatch `popstate` here: that re-runs the whole route and
            // rebuilds the page, which collapses the folder the user had open.
            refreshVoiceAlbumAfterDownload(work);
            showNotification(t('voices.savedToLibrary', { count: result.uploaded ?? result.total ?? plan.files.length }));
        } catch (error) {
            if (controller.signal.aborted) {
                updateVoiceDownloadPanel({ type: 'job', state: 'canceled', total: plan.files.length, completed: 0, failed: 0 });
            } else {
                console.error('Kikoeru -> storage import failed:', error);
                updateVoiceDownloadPanel({ type: 'job', state: 'error', total: plan.files.length, completed: 0, failed: 1 });
                showNotification(t('voices.saveToLibraryFailed'));
            }
            // A cancelled partial pipeline must re-merge the host slice so the
            // online card stays intact and the badge becomes "部分本地".
            await globalThis.__monochromeFileStorage?.refresh?.();
            try {
                await globalThis.__monochromeFileStorage?.cleanupImportTemps?.(plan.rootName);
            } catch {
                /* old hosts do not expose the staging cleanup endpoint */
            }
        } finally {
            activeVoiceDownload = null;
            setVoiceDownloadButtonBusy(button, false);
        }
        return;
    }
    let parentHandle;
    try {
        if (typeof window.showDirectoryPicker === 'function') {
            try {
                parentHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'monochrome-voice-download' });
            } catch (error) {
                if (error?.name !== 'AbortError') {
                    console.error('Failed to choose voice download directory:', error);
                    showNotification(t('voices.downloadFolderFailed'));
                }
                return;
            }
        } else showNotification(t('voices.downloadFolderUnsupported'));
        ensureVoiceDownloadPanel(plan);
        const downloadSettings = getVoiceDownloadSettings();
        // Directory downloads know exactly when a file has been written, so
        // clear that row's remote badge while the rest of the job continues.
        // The storage path must wait for the host import scan before marking.
        const onDirectoryEvent = (event) => {
            updateVoiceDownloadPanel(event);
            if (!parentHandle || event.type !== 'file' || !['done', 'skipped'].includes(event.state)) return;
            const hash = event.file?.voiceHash;
            if (!hash) return;
            recordVoiceDownloads(work.id, [hash]);
            markVoiceDownloadRowsLocal(work, [hash]);
        };
        const result = parentHandle ? await runVoiceDownload(plan, {
            parentHandle,
            signal: controller.signal,
            concurrency: downloadSettings.fileConcurrency,
            threadsPerFile: downloadSettings.threadsPerFile,
            segmented: true,
            onEvent: onDirectoryEvent
        }) : await downloadVoiceZipPlan(plan, controller.signal);
        const completedHashes = parentHandle
            ? (Array.isArray(result.completedFiles) ? result.completedFiles.map((file) => file.voiceHash) : [])
            : (result.failed === 0 ? plan.files.map((file) => file.voiceHash) : []);
        if (completedHashes.length > 0) {
            recordVoiceDownloads(work.id, completedHashes.filter(Boolean));
        }
        refreshVoiceAlbumAfterDownload(work);
        if (result.failed) showNotification(t('voices.downloadPartial'));
        else if (result.canceled) showNotification(t('voices.downloadCanceled'));
        else showNotification(t(selectedNodes !== null ? 'voices.downloadedSelection' : plan.folderPath.length ? 'voices.downloadFolderFinished' : 'voices.downloadedAlbum', { count: plan.files.length }));
    } catch (error) {
        if (!controller.signal.aborted) {
            console.error('Failed to stream voice download:', error);
            updateVoiceDownloadPanel({ type: 'job', state: 'error', total: plan.files.length, error: error.message });
            showNotification(t('voices.downloadAlbumFailed'));
        }
    } finally {
        activeVoiceDownload = null;
        setVoiceDownloadButtonBusy(button, false);
    }
}

async function downloadVoiceAlbum(work, button, signal) {
    await startVoiceDownload(work, [], button);
}

async function downloadVoiceFolder(work, path, button) {
    await startVoiceDownload(work, path, button);
}

let voiceMoreMode = 'circle';

function renderVoiceMoreSection(work) {
    const layout = document.getElementById('album-detail-tracklist')?.parentElement;
    if (!layout) return;
    layout.querySelector('.voice-album-more')?.remove();

    const currentGroup = voiceGroupForWork(work);
    const allGroups = voiceGroupsFor(works);
    const byArtist = voiceMoreMode === 'artist';
    const byTranslator = voiceMoreMode === 'translator';
    const currentArtists = new Set(
        (currentGroup?.editions || []).flatMap((edition) => edition.artists || []),
    );
    const currentTranslators = new Set(currentGroup?.translators || []);
    const targetCircle =
        currentGroup?.trueCircle || (work.code === currentGroup?.sourceCode ? work.circle : '') || '';

    const related = allGroups
        .filter((group) => group.key !== currentGroup?.key)
        .filter((group) => {
            if (byArtist) {
                return group.editions.some((edition) =>
                    (edition.artists || []).some((name) => currentArtists.has(name)),
                );
            }
            if (byTranslator) {
                return group.editions.some((edition) =>
                    (edition.translators || []).some((name) => currentTranslators.has(name)),
                );
            }
            return Boolean(targetCircle && group.trueCircle === targetCircle);
        })
        .slice(0, 8);
    const name = byArtist
        ? [...currentArtists].join(' / ')
        : byTranslator
          ? [...currentTranslators].join(' / ')
          : targetCircle || '';

    const section = document.createElement('section');
    section.className = 'voice-album-more';
    const cards = related.length
        ? related
              .map((group) => {
                  const entry = group.displayWork;
                  return `<div class="card voice-album-more-card" data-voice-more-id="${escapeHtml(entry.id)}" data-href="${escapeHtml(voiceAlbumPath(entry.id))}" tabindex="0" role="button">
                        <div class="card-image-wrapper">
                            <img class="card-image" src="${escapeHtml(coverSource(entry.cover))}" alt="" loading="lazy" referrerpolicy="no-referrer" />
                        </div>
                        <div class="card-info">
                            <h3 class="card-title">${escapeHtml(displayVoiceTitle(entry))}</h3>
                            <p class="card-subtitle">${escapeHtml(group.trueCircle || entry.circle || '')} • ${escapeHtml(entry.release || '')}</p>
                        </div>
                    </div>`;
              })
              .join('')
        : `<p class="voice-album-more-empty">${escapeHtml(t('voices.moreEmpty'))}</p>`;
    section.innerHTML = `<div class="voice-album-more-head">
            <h2 class="section-title">${escapeHtml(t('voices.moreFrom', { name }))}</h2>
            <div class="voice-album-more-switch" role="group" aria-label="${escapeHtml(t('voices.moreGroup'))}">
                <button type="button" data-voice-more-mode="circle" class="${byArtist || byTranslator ? '' : 'is-active'}">${escapeHtml(t('voices.circle'))}</button>
                <button type="button" data-voice-more-mode="artist" class="${byArtist ? 'is-active' : ''}">${escapeHtml(t('voices.artist'))}</button>
                <button type="button" data-voice-more-mode="translator" class="${byTranslator ? 'is-active' : ''}" ${currentTranslators.size ? '' : 'disabled'}>${escapeHtml(t('voices.translator'))}</button>
            </div>
        </div>
        <div class="card-grid">${cards}</div>`;
    layout.append(section);
    section.querySelectorAll('[data-voice-more-mode]').forEach((button) => {
        button.addEventListener('click', () => {
            if (voiceMoreMode === button.dataset.voiceMoreMode) return;
            voiceMoreMode = button.dataset.voiceMoreMode;
            renderVoiceMoreSection(work);
        });
    });
    section.querySelectorAll('[data-voice-more-id]').forEach((card) => {
        card.addEventListener('click', () => navigate(voiceAlbumPath(card.dataset.voiceMoreId)));
    });
}

function voiceTotalDuration(work) {
    // Formats (mp3/wav/flac) are renditions of the same recording; count one
    // duration per base title or the album total doubles.
    const byTitle = new Map();
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') {
                walk(node.children);
            } else if (getVoiceFileType(node) === 'audio') {
                const title = String(node.title || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
                const key = title || node.hash || node.id;
                const duration = Number(node.duration) || 0;
                if (duration > (byTitle.get(key) || 0)) byTitle.set(key, duration);
            }
        }
    };
    walk(work.tracks);
    const total = [...byTitle.values()].reduce((sum, duration) => sum + duration, 0);
    return total || Number(work.duration) || 0;
}

function showVoiceCoverLightbox(url) {
    if (!url) return;
    let overlay = document.getElementById('voice-cover-lightbox');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'voice-cover-lightbox';
        overlay.className = 'voice-cover-lightbox';
        overlay.hidden = true;
        overlay.innerHTML = '<img alt="" />';
        document.body.append(overlay);
        overlay.addEventListener('click', () => {
            overlay.hidden = true;
            document.body.classList.remove('voice-cover-lightbox-open');
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !overlay.hidden) {
                overlay.hidden = true;
                document.body.classList.remove('voice-cover-lightbox-open');
            }
        });
    }
    const image = overlay.querySelector('img');
    if (image) image.src = url;
    overlay.hidden = false;
    document.body.classList.add('voice-cover-lightbox-open');
}

let albumExtrasController = null;
let albumExtrasRestorers = [];
let albumCoverTheme = null;
let voiceAttachmentViewer = null;

// 原生专辑 DOM 会复用;撤销音声专属改动,避免闭包和隐藏样式跨作品泄漏。
export function cleanupVoiceAlbumExtras() {
    closeVoiceFolderMenu();
    closeVoiceListenStatusMenu();
    voiceAttachmentViewer?.dispose();
    voiceAttachmentViewer = null;
    albumCoverTheme?.dispose();
    albumCoverTheme = null;
    albumExtrasController?.abort();
    albumExtrasController = null;
    for (const restore of albumExtrasRestorers) restore();
    albumExtrasRestorers = [];
    const page = document.getElementById('page-album');
    page?.removeAttribute('data-voice-work-id');
    page?.querySelector('[data-cover-theme-controls]')?.removeAttribute('data-cover-theme-controls');
    page?.querySelectorAll('#voice-album-extras, #voice-album-files, #voice-dlsite-intro, .voice-album-more, .voice-album-split-resizer, [data-voice-album-action]').forEach((element) => element.remove());
    const albumLayout = page?.querySelector('.album-content-layout');
    albumLayout?.classList.remove('is-dragging-split');
    albumLayout?.style.removeProperty('--voice-track-share');
    page?.querySelectorAll('.voice-album-cover-wrap').forEach((wrapper) => {
        const image = wrapper.querySelector('.detail-header-image');
        if (image) wrapper.before(image);
        wrapper.remove();
    });
    const lightbox = document.getElementById('voice-cover-lightbox');
    if (lightbox) lightbox.hidden = true;
    document.body.classList.remove('voice-cover-lightbox-open');
}

function preserveAlbumStyle(element, property, value) {
    const previous = element.style[property];
    albumExtrasRestorers.push(() => { element.style[property] = previous; });
    element.style[property] = value;
}

let voiceListenMenuCleanup = null;

function closeVoiceListenStatusMenu() {
    voiceListenMenuCleanup?.();
    voiceListenMenuCleanup = null;
}

function updateVoiceListenStatusButton(button, work) {
    if (!button) return;
    const status = voiceListenStatus(work);
    const label = button.querySelector('.voice-listen-status-label');
    if (label) label.textContent = voiceListenLabel(status);
    button.dataset.listenStatus = status || 'none';
    button.classList.toggle('has-listen-status', Boolean(status));
    const markText = status
        ? t('voices.listenStatus.current', { status: voiceListenLabel(status) })
        : t('voices.listenStatus.mark');
    button.title = markText;
    button.setAttribute('aria-label', markText);
}

function setVoiceListenStatus(work, status) {
    const target = works.find((entry) => entry.id === work.id);
    if (!target) return;
    if (LISTEN_STATUS_VALUES.has(status)) target.listenStatus = status;
    else delete target.listenStatus;
    work.listenStatus = target.listenStatus;
    if (target.fileStorage) {
        const statuses = readFileListenStatuses();
        const key = target.storageWorkId || target.id;
        if (target.listenStatus) statuses[key] = target.listenStatus;
        else delete statuses[key];
        writeFileListenStatuses(statuses);
    } else {
        persistWorks();
    }
}

function openVoiceListenStatusMenu(button, work) {
    closeVoiceListenStatusMenu();
    const menu = document.createElement('div');
    menu.className = 'voice-listen-menu';
    menu.setAttribute('role', 'menu');
    const current = voiceListenStatus(work);
    const items = [
        ...LISTEN_STATUSES.map((status) => ({
            value: status.value,
            label: t(status.labelKey),
            active: current === status.value,
        })),
        { value: '', label: t('voices.listenStatus.clear'), active: !current, clear: true },
    ];
    menu.innerHTML = `<div class="voice-listen-menu-title">${escapeHtml(t('voices.listenStatus.heading'))}</div>${items
        .map(
            (item) => `<button type="button" class="voice-listen-menu-item${item.active ? ' is-active' : ''}${item.clear ? ' is-clear' : ''}" data-listen-value="${escapeHtml(item.value)}" role="menuitemradio" aria-checked="${item.active}">
                ${item.clear ? '' : `<span class="voice-listen-dot" data-status="${escapeHtml(item.value)}" aria-hidden="true"></span>`}
                <span>${escapeHtml(item.label)}</span>
                ${item.active ? '<span class="voice-listen-check" aria-hidden="true">✓</span>' : ''}
            </button>`,
        )
        .join('')}`;
    document.body.append(menu);
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;

    const close = () => {
        menu.remove();
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeydown);
        voiceListenMenuCleanup = null;
    };
    const onDocumentClick = (event) => {
        if (menu.contains(event.target) || button.contains(event.target)) return;
        close();
    };
    const onKeydown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            button.focus();
        }
    };
    menu.querySelectorAll('[data-listen-value]').forEach((item) => {
        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setVoiceListenStatus(work, item.dataset.listenValue);
            updateVoiceListenStatusButton(button, work);
            close();
            button.focus();
        });
    });
    setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
    document.addEventListener('keydown', onKeydown);
    voiceListenMenuCleanup = close;
    menu.querySelector('[data-listen-value].is-active')?.focus();
}

function renderAlbumExtras(work, album = currentVoiceAlbum) {
    cleanupVoiceAlbumExtras();
    if (album?.id) currentVoiceAlbum = album;
    albumExtrasController = new AbortController();
    const { signal } = albumExtrasController;
    const page = document.getElementById('page-album');
    // A stuck `data-voice-download-busy` makes the button pulse forever (1.1 s
    // infinite CSS animation) even after the job died — the attribute lives on the
    // element and survives innerHTML rewrites. Nobody is downloading ⇒ clear it.
    if (!activeVoiceDownload) {
        for (const element of page?.querySelectorAll('[data-voice-download-busy]') || []) {
            setVoiceDownloadButtonBusy(element, false);
        }
    }
    const info = page?.querySelector('.detail-header-info');
    const tracklist = document.getElementById('album-detail-tracklist');
    if (!page || !info || !tracklist) return;
    loadWorks();
    const group = voiceGroupForWork(work);
    const sourceCode = group?.sourceCode || work.code || '';
    currentWorkId = work.id;
    page.dataset.voiceWorkId = work.id;
    page.dataset.adult = work.nsfw ? 'true' : 'false';
    const counts = workCounts(work);
    const totalDuration = Number(work.duration) || voiceTotalDuration(work);
    for (const selector of ['#add-album-to-playlist-btn', '#like-album-btn']) {
        const button = page.querySelector(selector);
        if (button) preserveAlbumStyle(button, 'display', 'none');
    }
    const playAlbumButton = page.querySelector('#play-album-btn');
    playAlbumButton?.addEventListener(
        'click',
        (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            void playVoiceWork(work);
        },
        { capture: true, signal },
    );
    const downloadButton = page.querySelector('#download-album-btn');
    downloadButton?.addEventListener(
        'click',
        (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            openVoiceDownloadDestinationMenu(downloadButton, work);
        },
        { capture: true, signal },
    );
    if (downloadButton) {
        const disabled = downloadButton.disabled;
        albumExtrasRestorers.push(() => { downloadButton.disabled = disabled; });
    }
    page.querySelectorAll('.ratings').forEach((element) => {
        preserveAlbumStyle(element, 'display', 'none');
    });
    const producer = page.querySelector('#album-detail-producer');
    if (producer) preserveAlbumStyle(producer, 'display', 'none');
    const meta = page.querySelector('#album-detail-meta');
    if (meta) {
        const otherFiles = Math.max(0, counts.fileCount - counts.audioCount);
        const parts = [`${counts.audioCount} tracks`];
        if (otherFiles > 0) parts.push(`${otherFiles} files`);
        parts.push(formatDuration(totalDuration));
        if (voiceLocalBadgeHtml(work)) parts.push(voiceLocalBadgeHtml(work));
        if (subtitleChipHtml(work)) parts.push(subtitleChipHtml(work));
        parts.push(
            `<span class="voice-rating">★ ${escapeHtml(Number(work.rating || 0).toFixed(2))} (${escapeHtml(work.ratingCount || 0)})</span>`,
        );
        parts.push(`¥${escapeHtml(Number(work.price || 0).toLocaleString('ja-JP'))}`);
        meta.innerHTML = parts.join(' • ');
        if (Array.isArray(group?.editions)) {
            const editions = new Map();
            for (const edition of work.editionCodes || []) {
                editions.set(String(edition.code || '').toUpperCase(), {
                    code: String(edition.code || '').toUpperCase(),
                    lang: edition.lang || '',
                    label: edition.label || '',
                });
            }
            for (const edition of group.editions) {
                const code = String(edition.code || '').toUpperCase();
                if (!code) continue;
                const existing = editions.get(code);
                const rawLabel = edition.editionLabel || existing?.label || '';
                const label = voiceEditionShortLabel(edition.editionLang || existing?.lang, rawLabel);
                editions.set(code, { code, lang: edition.editionLang || existing?.lang || '', label, work: edition });
            }
            const currentCode = String(work.code || '').toUpperCase();
            if (currentCode && !editions.has(currentCode)) {
                editions.set(currentCode, { code: currentCode, label: work.editionLabel || '', work });
            }
            if (editions.size > 1) {
                const options = [...editions.values()]
                    .map((edition) => {
                        const registered = edition.work || group.editions.find((entry) => String(entry.code || '').toUpperCase() === edition.code);
                        const selected = edition.code === currentCode;
                        const unavailable = !registered && !selected;
                        const label = `${edition.code}(${edition.label || '?'})${unavailable ? ' 暂无' : ''}`;
                        const value = registered?.id || `code:${edition.code}`;
                        return `<option value="${escapeHtml(value)}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                    })
                    .join('');
                const selector = document.createElement('span');
                selector.className = 'voice-edition-switcher';
                selector.innerHTML = `<label>${escapeHtml(t('voices.edition.label'))}
                    <select id="voice-edition-select" aria-label="${escapeHtml(t('voices.edition.label'))}">${options}</select>
                </label>`;
                meta.append(' • ', selector);
                selector.querySelector('select')?.addEventListener('change', async (event) => {
                    const value = event.target.value;
                    let target = works.find((edition) => edition.id === value);
                    if (!target && value.startsWith('code:')) {
                        const code = value.slice(5);
                        try {
                            target = await fetchKikoeruWork(code, {
                                retries: 1,
                                signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(6000) : undefined,
                            });
                            // Keep the edition/code union on the newly fetched
                            // edition so host identity matching works on download.
                            target.editionCodes = mergeVoiceEditionCodes(
                                target.editionCodes,
                                work.editionCodes,
                                target.code,
                                work.code,
                            );
                            target.sourceCode = target.sourceCode || work.sourceCode;
                            const fetchedTarget = target;
                            editionRefreshCache.set(code.toUpperCase(), { at: Date.now(), work: fetchedTarget });
                            const existing = works.findIndex((edition) => edition.id === target.id);
                            if (existing >= 0) target = works[existing];
                            else works = [target, ...works];
                            persistWorks();
                            void ensureImportedVoiceBundle(target);
                        } catch (error) {
                            console.error('Failed to import edition:', error);
                            showNotification(t('voices.edition.importFailed'));
                            return;
                        }
                    }
                    if (target && target.id !== work.id) {
                        // Navigate immediately. The online edition refresh is a
                        // stale-while-revalidate job; it must never block the
                        // user's language switch on endpoint probes/Kikoeru.
                        navigate(voiceAlbumPath(target.id));
                        void refreshEditionInBackground(target);
                    }
                });
            }
        }
    }
    const coverImage = page.querySelector('.detail-header-image');
    if (coverImage && !coverImage.closest('.voice-album-cover-wrap')) {
        const coverWrap = document.createElement('div');
        coverWrap.className = 'voice-album-cover-wrap';
        coverImage.before(coverWrap);
        coverWrap.append(coverImage);
        coverWrap.insertAdjacentHTML('beforeend', coverOverlayHtml(work, sourceCode));
    }
    const voiceCover = page.querySelector('.voice-album-cover-wrap .detail-header-image');
    if (voiceCover) {
        voiceCover.dataset.adult = work.nsfw ? 'true' : 'false';
        voiceCover.closest('.voice-album-cover-wrap')?.setAttribute('data-adult', work.nsfw ? 'true' : 'false');
        preserveAlbumStyle(voiceCover, 'cursor', 'zoom-in');
        voiceCover.addEventListener('click', () => showVoiceCoverLightbox(coverSource(work.cover)), { signal });
    }
    document.getElementById('voice-album-extras')?.remove();
    document.getElementById('voice-album-files')?.remove();

    const detail = document.createElement('div');
    detail.id = 'voice-album-extras';
    const tags = `${ageTagHtml(work)}${normalTagChipsHtml(work.tags || [])}`;
    const sourceUrl = safeFileUrl(work.sourceUrl);
    const currentTranslators =
        work.code === sourceCode
            ? []
            : work.translators?.length
              ? work.translators
              : group?.translators || [];
    const translatorChips = currentTranslators
        .map(
            (name) => `<button type="button" class="voice-tag voice-tag-chip voice-tag-chip--translator" data-filter-translator="${escapeHtml(name)}">${escapeHtml(name)}</button>`,
        )
        .join('');
    const translatorRow = translatorChips
        ? `<div class="voice-translator-row"><span class="voice-creator-label">${escapeHtml(t('voices.translator'))}</span>${translatorChips}</div>`
        : '';
    detail.innerHTML = `
        ${creatorRowsHtml(work, true, false, group?.trueCircle || (work.code === sourceCode ? work.circle : ''))}
        ${translatorRow}
        <div class="voice-hero-tags">${tags}</div>
`;
    info.querySelector('.detail-header-actions')?.before(detail);
    detail.addEventListener('click', handleFilterClick);

    const nativeActions = info.querySelector('.detail-header-actions');
    nativeActions?.setAttribute('data-cover-theme-controls', '');
    const formats = getVoicePlaybackFormats(work);
    if (playAlbumButton && formats.length > 1 && nativeActions) {
        const arrow = document.createElement('button');
        arrow.id = 'voice-play-format-toggle';
        arrow.type = 'button';
        arrow.className = 'voice-play-format-toggle';
        arrow.dataset.voiceAlbumAction = 'format-toggle';
        arrow.textContent = '▾';
        arrow.title = t('voices.choosePlaybackFormat');
        arrow.setAttribute('aria-label', arrow.title);
        arrow.setAttribute('aria-haspopup', 'menu');
        arrow.setAttribute('aria-expanded', 'false');
        const menu = document.createElement('div');
        menu.id = 'voice-play-format-menu';
        menu.className = 'voice-play-format-menu';
        menu.dataset.voiceAlbumAction = 'format-menu';
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        const closeMenu = () => { menu.hidden = true; arrow.setAttribute('aria-expanded', 'false'); };
        for (const format of formats) {
            const option = document.createElement('button');
            option.type = 'button';
            option.dataset.voicePlayFormat = format;
            option.setAttribute('role', 'menuitem');
            option.textContent = t('voices.playFormat', { format: format.toUpperCase() });
            option.addEventListener('click', () => { closeMenu(); void playVoiceWork(work, format); }, { signal });
            menu.append(option);
        }
        arrow.addEventListener('click', () => {
            menu.hidden = !menu.hidden;
            arrow.setAttribute('aria-expanded', String(!menu.hidden));
            if (!menu.hidden) menu.querySelector('button')?.focus();
        }, { signal });
        document.addEventListener('click', (event) => {
            if (!menu.contains(event.target) && !arrow.contains(event.target)) closeMenu();
        }, { signal });
        menu.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); arrow.focus(); }
        }, { signal });
        playAlbumButton.after(arrow, menu);
        preserveAlbumStyle(playAlbumButton, 'borderTopRightRadius', '0');
        preserveAlbumStyle(playAlbumButton, 'borderBottomRightRadius', '0');
    }
    if (playAlbumButton) {
        const oldTitle = playAlbumButton.getAttribute('title');
        albumExtrasRestorers.push(() => {
            if (oldTitle === null) playAlbumButton.removeAttribute('title');
            else playAlbumButton.setAttribute('title', oldTitle);
        });
        playAlbumButton.title = t('voices.playFormat', { format: getVoiceDefaultFormat(work).toUpperCase() });
    }
    const nativeMenu = nativeActions?.querySelector('#album-menu-btn');
    if (nativeActions && nativeMenu && (work.fileStorage || Array.isArray(work.manifest) || Boolean(voiceHostForWork(work)))) {
        const reconcileButton = document.createElement('button');
        reconcileButton.type = 'button';
        reconcileButton.id = 'voice-reconcile';
        reconcileButton.className = 'btn btn-secondary';
        reconcileButton.dataset.voiceAlbumAction = 'reconcile';
        reconcileButton.title = t('voices.reconcileFiles');
        reconcileButton.setAttribute('aria-label', t('voices.reconcileFiles'));
        reconcileButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>';
        reconcileButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const bridge = globalThis.__monochromeFileStorage;
            if (typeof bridge?.reconcileVoice !== 'function') return;
            const host = voiceStorageHostFor(work) || voiceHostForWork(work);
            const targetWorkId = host?.storageWorkId || work.storageWorkId;
            if (!targetWorkId) {
                showNotification(t('voices.reconcileFailed'));
                return;
            }
            reconcileButton.disabled = true;
            reconcileButton.setAttribute('aria-busy', 'true');
            try {
                const result = await bridge.reconcileVoice(targetWorkId);
                await globalThis.__monochromeFileStorage?.refresh?.();
                const current = works.find((entry) => entry.id === work.id) || work;
                refreshVoiceAlbumAfterDownload(current);
                showNotification(t('voices.reconcileDone', {
                    added: Number(result?.added) || 0,
                    renamed: Number(result?.renamed) || 0,
                    removed: Number(result?.removed) || 0,
                }));
            } catch (error) {
                console.error('Voice source reconcile failed:', error);
                showNotification(t('voices.reconcileFailed'));
            } finally {
                reconcileButton.disabled = false;
                reconcileButton.removeAttribute('aria-busy');
            }
        }, { signal });
        nativeMenu.before(reconcileButton);
    }
    if (nativeActions && nativeMenu && sourceUrl) {
        const sourceButton = document.createElement('a');
        sourceButton.className = 'btn btn-secondary voice-album-source-link';
        sourceButton.dataset.voiceAlbumAction = 'dlsite';
        sourceButton.href = sourceUrl;
        sourceButton.target = '_blank';
        sourceButton.rel = 'noreferrer';
        sourceButton.title = t('voices.dlsite');
        sourceButton.setAttribute('aria-label', t('voices.dlsite'));
        sourceButton.innerHTML = SVG_LINK(18);
        nativeMenu.before(sourceButton);
    }
    const localVoiceFileEntries = (() => {
        const host = voiceHostForWork(work) || (work.fileStorage ? work : null);
        const nodes = work.fileStorage && Array.isArray(work.manifest) ? work.tracks : host?.tracks;
        const entries = [];
        const walk = (items) => {
            for (const node of items || []) {
                if (node.type === 'folder') { walk(node.children); continue; }
                if (!node.logicalPath || node.local === false) continue;
                entries.push({ path: node.logicalPath, hash: node.hash });
            }
        };
        walk(nodes);
        return entries;
    })();
    if (nativeActions && nativeMenu) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'btn btn-secondary';
        deleteButton.id = 'voice-remove-local';
        deleteButton.dataset.voiceAlbumAction = 'remove-local';
        deleteButton.title = t('voices.removeLocalFiles');
        deleteButton.setAttribute('aria-label', t('voices.removeLocalFiles'));
        deleteButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
        deleteButton.disabled = localVoiceFileEntries.length === 0;
        deleteButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!localVoiceFileEntries.length) return;
            await deleteVoiceLocalFiles(
                work,
                localVoiceFileEntries.map((entry) => entry.path),
                deleteButton,
                localVoiceFileEntries.map((entry) => entry.hash),
            );
        });
        nativeMenu.before(deleteButton);
    }
    if (nativeActions && nativeMenu) {
        const favoriteButton = document.createElement('button');
        favoriteButton.type = 'button';
        favoriteButton.id = 'voice-album-favorite';
        favoriteButton.className = 'btn btn-secondary voice-album-favorite';
        favoriteButton.dataset.voiceAlbumAction = 'favorite';
        const favoriteAlbum = currentVoiceAlbum;
        if (favoriteAlbum?.id) {
            favoriteButton.disabled = true;
            void db.isFavorite('album', favoriteAlbum.id).then((liked) => {
                favoriteButton.disabled = false;
                updateVoiceFavoriteButton(favoriteButton, liked);
            }).catch(() => {
                favoriteButton.disabled = false;
            });
            favoriteButton.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    const added = await db.toggleFavorite('album', favoriteAlbum);
                    updateVoiceFavoriteButton(favoriteButton, added);
                    showNotification(t(added ? 'voices.favoriteAdded' : 'voices.favoriteRemoved'));
                } catch (error) {
                    console.error('Failed to toggle voice favorite:', error);
                    showNotification(t('voices.favoriteFailed'));
                }
            }, { signal });
        } else {
            favoriteButton.hidden = true;
        }
        nativeMenu.before(favoriteButton);
    }
    if (nativeActions && nativeMenu) {
        const listenButton = document.createElement('button');
        listenButton.type = 'button';
        listenButton.className = 'btn btn-secondary voice-listen-status-btn';
        listenButton.dataset.voiceAlbumAction = 'listen-status';
        listenButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg><span class="voice-listen-status-label"></span>';
        updateVoiceListenStatusButton(listenButton, work);
        listenButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openVoiceListenStatusMenu(listenButton, work);
        }, { signal });
        nativeMenu.before(listenButton);
    }
    info.querySelector('.detail-header-actions')?.before(detail);
    detail.addEventListener('click', handleFilterClick);

    const partialHost = voicePartialHostFor(work);
    page.dataset.voicePartialState = partialHost ? 'partial' : 'full';
    const hostForTree = voiceHostForWork(work);
    // The online card may not carry the manifest itself; its host slice does.
    // Host manifest is the live truth. An online card can still carry a stale
    // localStorage snapshot; never let that snapshot hide a newly downloaded
    // edition/alias. Also union sibling host slices so an edition whose code
    // match is not exact still sees the shared alias manifest.
    const allHostSlices = globalThis.__monochromeFileStorageWorks || [];
    const hostSlices = allHostSlices.filter((host) => voiceWorkCodesOverlap(host, work));
    const hostManifestEntries = hostSlices.flatMap((host) => Array.isArray(host.manifest) ? host.manifest : []);
    // Last-resort content-status check: an online edition can have a code set
    // that does not overlap the host slice (translated/original mismatch). In
    // that case the local alias still lives in another host manifest, so use
    // all host manifests rather than the stale localStorage snapshot.
    const fallbackHostManifestEntries = allHostSlices.flatMap((host) => Array.isArray(host.manifest) ? host.manifest : []);
    const statusManifest = hostManifestEntries.length
        ? hostManifestEntries
        : fallbackHostManifestEntries.length
            ? fallbackHostManifestEntries
            : Array.isArray(hostForTree?.manifest)
                ? hostForTree.manifest
                : Array.isArray(work.manifest) ? work.manifest : null;
    const localNamesForTree = (() => {
        // An empty manifest is not evidence that nothing is local: `toVoiceWork`
        // used to emit `manifest: []` for a host work with no sidecar manifest,
        // and treating that as authoritative marked every row of a freshly
        // imported local work as remote. Fall through to the host track tree,
        // which is the actual on-disk content of a file-library work.
        if (Array.isArray(statusManifest) && statusManifest.length) {
            return new Set(statusManifest
                .filter((entry) => entry.status === 'local')
                .map((entry) => normalizeVoiceLocalName(String(entry.logicalPath || '').split('/').pop()))
                .filter(Boolean));
        }
        // The host keeps the authoritative local names; a pure online work has
        // no host slice, so only hashes recorded by completed downloads mark
        // rows local. Checking only partialHost made a completed host look fully
        // remote after the host work replaced the online work.
        if (!hostForTree && !work.fileStorage) return new Set();
        const names = new Set();
        const walk = (nodes) => {
            for (const node of nodes || []) {
                if (node.type === 'folder') walk(node.children);
                else if (node.title) names.add(normalizeVoiceLocalName(String(node.title).split('/').pop()));
            }
        };
        walk(hostForTree ? hostForTree.tracks : work.tracks);
        return names;
    })();
    const hostHashesForTree = (() => {
        // Same guard as `localNamesForTree`: an empty manifest must not shadow
        // the host track hashes of a work that is entirely on disk.
        if (Array.isArray(statusManifest) && statusManifest.length) {
            return new Set(statusManifest
                .filter((entry) => entry.status === 'local' && entry.hash)
                .map((entry) => String(entry.hash)));
        }
        if (!hostForTree) return null;
        const hashes = new Set();
        const walkHashes = (nodes) => {
            for (const node of nodes || []) {
                if (node.type === 'folder') walkHashes(node.children);
                else if (node.hash) hashes.add(String(node.hash));
            }
        };
        walkHashes(hostForTree.tracks);
        return hashes;
    })();
    const recordedLocalHashes = getDownloadedVoiceHashes(work.id);
    const localHashesForTree = hostHashesForTree
        ? new Set([...recordedLocalHashes].filter((hash) => hostHashesForTree.has(hash)))
        : recordedLocalHashes;
    const initialPath = getVoiceInitialPath(work.tracks, { ...voicePathSettings.get(), localFileTree: Boolean(work.fileStorage) });
    const openKeys = new Set(
        voiceAlbumOpenFolders.get(work.id) || expandPathPrefixes(initialPath),
    );
    tracklist.innerHTML = `<div class="creation-attachment-toolbar voice-selection-toolbar" data-empty="true" data-voice-album-action="selection">
        <label class="voice-select-all-label"><input id="voice-select-all" type="checkbox" class="voice-native-checkbox" />${escapeHtml(t('voices.selectAllFiles'))}</label>
        <span id="voice-selection-count" role="status" aria-live="polite"></span>
        <span class="creation-local-count" data-local-count aria-hidden="true"></span>
        <div class="creation-attachment-actions voice-selection-actions">
            <button id="voice-selection-queue" type="button" class="btn btn-secondary" disabled>${escapeHtml(t('voices.queueSelected'))}</button>
            <button id="voice-selection-download" type="button" class="btn btn-secondary" disabled>${escapeHtml(t('voices.downloadSelected'))}</button>
            <button id="voice-selection-delete-local" type="button" class="btn btn-secondary creation-delete-btn" disabled>${escapeHtml(t('voices.deleteSelectedLocal'))}</button>
            <button id="voice-selection-clear" type="button" class="btn btn-secondary creation-delete-btn" disabled>${escapeHtml(t('voices.clearSelection'))}</button>
        </div>
    </div><div class="track-list-header">
        <span class="voice-tree-heading"><span class="voice-tree-heading-index" aria-hidden="true">#</span>${escapeHtml(t('voices.albumList'))}</span><span class="duration-header">${escapeHtml(t('voices.duration'))}</span><span>${escapeHtml(t('voices.actions'))}</span>
    </div><div class="voice-album-hierarchy">${voiceAlbumHierarchyHtml(work.tracks, [], { index: 0, folderIndex: 0 }, openKeys, localNamesForTree, localHashesForTree)}</div>`;
    if (work.fileStorage) {
        // WebView2 can turn a cross-origin <a download> into a native download
        // before the page sees the click. Use a button trigger so the delegated
        // handler can re-sign and fetch a Blob.
        tracklist.querySelectorAll('a.voice-file-download[data-voice-download-hash]').forEach((link) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = link.className;
            button.dataset.voiceDownloadHash = link.dataset.voiceDownloadHash;
            button.dataset.voiceDownloadName = link.getAttribute('download') || '';
            button.innerHTML = link.innerHTML;
            button.title = link.getAttribute('title') || t('voices.download');
            button.setAttribute('aria-label', link.getAttribute('aria-label') || button.title);
            link.replaceWith(button);
        });
    }
    document.addEventListener('click', async (event) => {
        const link = event.target.closest?.('.voice-file-download[data-voice-download-hash]');
        if (!link || typeof globalThis.__monochromeFileStorage?.resolveTrackUrl !== 'function') return;
        const node = flattenAudio(work.tracks).find((entry) => entry.hash === link.dataset.voiceDownloadHash);
        if (!node) return;
        const hostEntryId = node.hostEntryId || '';
        if (!hostEntryId && !work.fileStorage) return;
        event.preventDefault();
        const fallback = node.remoteMediaDownloadUrl || node.remoteMediaStreamUrl || '';
        const fresh = (await globalThis.__monochromeFileStorage
            .resolveTrackUrl(hostEntryId ? node.hostWorkId : work.id, hostEntryId || node.hash)
            .catch(() => null)) || fallback;
        if (!fresh) {
            showNotification(t('voices.downloadAlbumFailed'));
            return;
        }
        try {
            // Cross-origin <a download> navigates instead of downloading; fetch
            // into a blob first so the album page stays put.
            const response = await fetch(fresh, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const objectUrl = URL.createObjectURL(await response.blob());
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = link.dataset.voiceDownloadName || link.download || node?.title || 'voice-file';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (error) {
            console.error('Failed to download voice file:', error);
            showNotification(t('voices.downloadAlbumFailed'));
        }
    }, { signal, capture: true });
    // Experimental: append below the audio/file list so the width matches the list
    // exactly (at >=1200px the list itself is a 55% floated column).
    const introHost = document.createElement('section');
    introHost.id = 'voice-dlsite-intro';
    tracklist.append(introHost);
    void renderDlsiteIntro(work, introHost);

    bindVoiceFileSelection(tracklist, work, {
        signal,
        onQueue: async (tracks) => {
            try {
                const fresh = adaptVoiceWork(work).tracks;
                const byHash = new Map(fresh.map((track) => [track.voiceHash, track]));
                const queued = tracks.map((track) => byHash.get(track.voiceHash) || track);
                await Player.instance.addToQueue(queued, { autoPlay: false });
                void ensureVoiceWorkUrls(work);
                showNotification(t('voices.queuedSelected', { count: queued.length }));
            } catch (error) {
                console.error('Failed to queue selected voice files:', error);
                showNotification(t('voices.playFailed'));
            }
        },
        onDownload: (nodes, button) => openVoiceDownloadDestinationMenu(button, work, [], nodes),
        onDeleteLocal: (paths, button, hashes) => deleteVoiceLocalFiles(work, paths, button, hashes)
    });
    animateVoiceFolders(tracklist, signal);
    // `toggle` on <details> does not bubble, so record each folder individually.
    // Only real user toggles end up here (the initial `open` attribute is set in
    // the markup), which keeps the stored set honest.
    tracklist.querySelectorAll('details.voice-album-folder').forEach((folder) => {
        folder.addEventListener('toggle', () => {
            const path = folder.dataset.voiceFolderPath;
            if (!path) return;
            const open = voiceAlbumOpenFolders.get(work.id) || new Set();
            if (folder.open) open.add(path);
            else open.delete(path);
            voiceAlbumOpenFolders.set(work.id, open);
        }, { signal });
    });
    tracklist.querySelectorAll('.voice-album-folder-menu').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openVoiceFolderMenu(button, work);
        }, { signal });
    });
    tracklist.querySelectorAll('.voice-file-menu-btn').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const row = button.closest('.voice-album-track-row');
            if (row) openVoiceFileStorageMenu(button, work, row);
        }, { signal });
    });
    // Resolve the badge before the native context menu opens. This keeps the
    // library action from changing while the pointer moves between rows.
    const rememberVoiceMenuState = (row) => {
        pendingVoiceMenuState = row ? { row, isLocal: voiceRowIsLocal(work, row) } : null;
    };
    const decorateStorageMenu = (row) => {
        const state = pendingVoiceMenuState?.row === row ? pendingVoiceMenuState : { row, isLocal: voiceRowIsLocal(work, row) };
        appendVoiceStorageActionToContextMenu(work, row, state.isLocal);
        setTimeout(() => appendVoiceStorageActionToContextMenu(work, row, state.isLocal), 60);
    };
    tracklist.addEventListener('pointerdown', (event) => {
        const button = event.target.closest?.('.track-menu-btn');
        const row = button?.closest('.voice-album-track-row');
        if (row) rememberVoiceMenuState(row);
    }, { signal });
    tracklist.addEventListener('click', (event) => {
        const button = event.target.closest?.('.track-menu-btn');
        const row = button?.closest('.voice-album-track-row');
        if (row) {
            rememberVoiceMenuState(row);
            decorateStorageMenu(row);
        }
    }, { signal });
    tracklist.addEventListener('contextmenu', (event) => {
        const row = event.target.closest?.('.voice-album-track-row');
        if (row) {
            rememberVoiceMenuState(row);
            decorateStorageMenu(row);
        }
    }, { signal });
    voiceAttachmentViewer = createVoiceAttachmentViewer({
        loadText: async (url, options = {}) => {
            try {
                return await loadVoiceAttachmentText(url, options);
            } catch (error) {
                // Kikoeru media URLs are short-lived. If a saved VTT URL expired,
                // refresh the work's track tree once and retry before showing the
                // attachment as broken.
                const fresh = await refreshVoiceAttachmentUrl(work, options.node);
                if (!fresh) throw error;
                return await loadVoiceAttachmentText(fresh, options);
            }
        },
        onVideoPlay: () => Player.instance?.activeElement?.pause()
    });
    tracklist.querySelectorAll('.voice-album-file-row[role="button"]').forEach((row) => {
        row.addEventListener('keydown', (event) => {
            if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            row.click();
        }, { signal });
    });
    tracklist.querySelectorAll('.voice-file-queue').forEach((button) => {
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                // Queue from the already rendered track tree first. Refreshing
                // online asmr URLs can take seconds and used to make adding the
                // second album look like it did nothing.
                let track = adaptVoiceWork(work).tracks.find((entry) => entry.voiceHash === button.dataset.voiceQueueHash);
                if (!track) {
                    await ensureVoiceWorkUrls(work);
                    track = adaptVoiceWork(work).tracks.find((entry) => entry.voiceHash === button.dataset.voiceQueueHash);
                }
                if (!track) return;
                await Player.instance.addToQueue([track], { autoPlay: false });
                void ensureVoiceWorkUrls(work);
                showNotification(t('voices.queuedSelected', { count: 1 }));
            } catch (error) {
                console.error('Failed to queue voice file:', error);
                showNotification(t('voices.playFailed'));
            }
        });
    });
    tracklist.querySelectorAll('.voice-file-play').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const node = flattenAudio(work.tracks).find((entry) => entry.hash === button.dataset.voiceHash);
            if (node) void playVoiceFile(work, node);
        });
    });
    const adaptedTracks = adaptVoiceWork(work).tracks;
    const adaptedByHash = new Map(adaptedTracks.map((track) => [track.voiceHash, track]));
    tracklist.querySelectorAll('.voice-album-track-row[data-voice-type="audio"]').forEach((row) => {
        const track = adaptedByHash.get(row.dataset.voiceHash);
        if (track) {
            row.dataset.trackId = track.id;
            trackDataStore.set(row, track);
        }
    });
    renderVoiceMoreSection(work);
    const splitLayout = page.querySelector('.album-content-layout');
    if (splitLayout) albumExtrasRestorers.push(mountVoiceAlbumSplit(splitLayout, albumExtrasController.signal));
    void hydratePartialOnlineWork(work);
    albumCoverTheme = bindCoverTheme(page, {
        coverUrl: coverSource(work.cover),
        isCurrent: () => page.dataset.voiceWorkId === work.id && page.classList.contains('active')
    });
}

function toggleFilter(kind, value) {
    if (!value) return;
    const set =
        kind === 'artist'
            ? activeArtists
            : kind === 'circle'
              ? activeCircles
              : kind === 'age'
                ? activeAges
                : kind === 'local'
                  ? activeLocal
                  : kind === 'subtitle'
                    ? activeSubtitles
                  : kind === 'translator'
                    ? activeTranslators
                    : kind === 'listen'
                      ? activeListenStatuses
                      : activeTags;
    if (set.has(value)) set.delete(value);
    else set.add(value);
    // 详情页点名字后回列表;卡片上点名字则留在列表原地更新。
    if (document.getElementById('page-album')?.classList.contains('active') || document.getElementById('voices-detail-view')?.hidden === false) {
        navigate(`/voices${voiceFilterQuery()}`);
    } else {
        writeVoiceFiltersToUrl();
        renderList();
    }
}

// ------------------------------------------------------------ 卡片 +N 标签悬停
// +N 只展示“还有多少标签”，不占卡片空间；悬停/聚焦 450ms 后再打开浮层，
// 避免鼠标划过去就把所有 tag 全部渲染。浮层挂在 body 上，使用 fixed 定位，
// 不受卡片 overflow 裁剪，也不会在列表中插入额外高度。
let voiceTagMoreTimer = null;
let voiceTagMoreHideTimer = null;
let voiceTagMoreAnchor = null;
let voiceTagMorePopover = null;

function ensureVoiceTagMorePopover() {
    if (voiceTagMorePopover) return voiceTagMorePopover;
    const popover = document.createElement('div');
    popover.id = 'voice-tag-more-popover';
    popover.className = 'voice-tag-more-popover';
    popover.setAttribute('role', 'tooltip');
    popover.hidden = true;
    document.body.appendChild(popover);
    popover.addEventListener('pointerenter', () => {
        clearTimeout(voiceTagMoreHideTimer);
        voiceTagMoreHideTimer = null;
    });
    popover.addEventListener('pointerleave', () => scheduleVoiceTagMoreHide(120));
    popover.addEventListener('click', (event) => {
        const chip = event.target instanceof Element ? event.target.closest('[data-filter-tag]') : null;
        if (!chip) return;
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('tag', chip.dataset.filterTag);
        hideVoiceTagMorePopover();
    });
    voiceTagMorePopover = popover;
    return popover;
}

function hideVoiceTagMorePopover() {
    clearTimeout(voiceTagMoreTimer);
    voiceTagMoreTimer = null;
    if (!voiceTagMorePopover) return;
    voiceTagMorePopover.hidden = true;
    voiceTagMorePopover.style.visibility = 'hidden';
    voiceTagMoreAnchor = null;
}

function scheduleVoiceTagMoreHide(delay = 160) {
    clearTimeout(voiceTagMoreHideTimer);
    voiceTagMoreHideTimer = setTimeout(hideVoiceTagMorePopover, delay);
}

function showVoiceTagMorePopover(anchor) {
    if (!anchor) return;
    let tags = [];
    try {
        tags = JSON.parse(anchor.dataset.voiceTags || '[]');
    } catch {
        tags = [];
    }
    if (!Array.isArray(tags) || tags.length === 0) return;
    const popover = ensureVoiceTagMorePopover();
    voiceTagMoreAnchor = anchor;
    popover.innerHTML = `<div class="voice-tag-more-popover-title">${escapeHtml(t('voices.tagPopoverTitle'))}</div><div class="voice-tag-more-popover-list">${tags.map((tag) => `<button type="button" class="voice-tag voice-tag-chip voice-tag-chip--tag${activeTags.has(tag) ? ' is-active' : ''}" data-filter-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}</div>`;
    popover.hidden = false;
    popover.style.visibility = 'hidden';
    popover.style.left = '0px';
    popover.style.top = '0px';
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const margin = 10;
    const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
    const playerBar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--player-bar-occupied')) || 0;
    const bottomLimit = window.innerHeight - playerBar - margin;
    let top = rect.top - height - 8;
    if (top < margin) top = rect.bottom + 8;
    top = Math.max(margin, Math.min(Math.max(top, margin), bottomLimit - height));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.visibility = 'visible';
}

function scheduleVoiceTagMoreShow(anchor) {
    clearTimeout(voiceTagMoreHideTimer);
    voiceTagMoreHideTimer = null;
    if (voiceTagMoreAnchor === anchor && voiceTagMorePopover && !voiceTagMorePopover.hidden) return;
    clearTimeout(voiceTagMoreTimer);
    voiceTagMoreTimer = setTimeout(() => showVoiceTagMorePopover(anchor), 450);
}

function initializeVoiceTagMorePopover() {
    if (document.body.dataset.voiceTagMoreReady === '1') return;
    document.body.dataset.voiceTagMoreReady = '1';
    const target = (event) => (event.target?.closest ? event.target.closest('.voice-tag-more') : null);
    document.addEventListener('pointerover', (event) => {
        if (event.pointerType === 'touch') return;
        const anchor = target(event);
        if (!anchor || anchor.contains(event.relatedTarget)) return;
        scheduleVoiceTagMoreShow(anchor);
    });
    document.addEventListener('pointerout', (event) => {
        if (event.pointerType === 'touch') return;
        const anchor = target(event);
        if (!anchor || anchor.contains(event.relatedTarget)) return;
        scheduleVoiceTagMoreHide();
    });
    document.addEventListener('focusin', (event) => {
        const anchor = target(event);
        if (anchor) scheduleVoiceTagMoreShow(anchor);
    });
    document.addEventListener('focusout', (event) => {
        if (target(event)) scheduleVoiceTagMoreHide();
    });
    document.addEventListener('scroll', () => {
        if (voiceTagMorePopover && !voiceTagMorePopover.hidden) hideVoiceTagMorePopover();
    }, true);
    document.addEventListener(
        'click',
        (event) => {
            const anchor = target(event);
            if (!anchor) return;
            // 触屏没有 hover;鼠标点击 +N 也直接打开。先于卡片导航捕获,
            // 避免点 +N 被当成打开作品。
            event.preventDefault();
            event.stopPropagation();
            clearTimeout(voiceTagMoreTimer);
            showVoiceTagMorePopover(anchor);
        },
        true,
    );
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.voice-tag-more, #voice-tag-more-popover')) hideVoiceTagMorePopover();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && voiceTagMorePopover && !voiceTagMorePopover.hidden) hideVoiceTagMorePopover();
    });
    window.addEventListener('resize', () => {
        if (voiceTagMorePopover && !voiceTagMorePopover.hidden) hideVoiceTagMorePopover();
    });
}

initializeVoiceTagMorePopover();

function handleFilterClick(event) {
    const artist = event.target.closest('[data-filter-artist]');
    if (artist) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('artist', artist.dataset.filterArtist);
        return true;
    }
    const circle = event.target.closest('[data-filter-circle]');
    if (circle) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('circle', circle.dataset.filterCircle);
        return true;
    }
    const age = event.target.closest('[data-filter-age]');
    if (age) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('age', age.dataset.filterAge);
        return true;
    }
    const local = event.target.closest('[data-filter-local]');
    if (local) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('local', local.dataset.filterLocal);
        return true;
    }
    const subtitle = event.target.closest('[data-filter-subtitle]');
    if (subtitle) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('subtitle', subtitle.dataset.filterSubtitle);
        return true;
    }
    const translator = event.target.closest('[data-filter-translator]');
    if (translator) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('translator', translator.dataset.filterTranslator);
        return true;
    }
    const listen = event.target.closest('[data-filter-listen]');
    if (listen) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('listen', listen.dataset.filterListen);
        return true;
    }
    const tag = event.target.closest('[data-filter-tag]');
    if (tag) {
        event.preventDefault();
        event.stopPropagation();
        toggleFilter('tag', tag.dataset.filterTag);
        return true;
    }
    return false;
}

function readVoiceFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    libraryQuery = params.get('q') || '';
    librarySort = ['added', 'release', 'rating', 'title'].includes(params.get('sort')) ? params.get('sort') : 'added';
    for (const [set, key] of [
        [activeArtists, 'artist'],
        [activeCircles, 'circle'],
        [activeTags, 'tag'],
        [activeAges, 'age'],
        [activeLocal, 'local'],
        [activeSubtitles, 'subtitle'],
        [activeTranslators, 'translator'],
        [activeListenStatuses, 'listen'],
    ]) {
        set.clear();
        for (const value of params.getAll(key)) set.add(value);
    }
}

function voiceFilterQuery() {
    const params = new URLSearchParams();
    if (libraryQuery.trim()) params.set('q', libraryQuery.trim());
    if (librarySort !== 'added') params.set('sort', librarySort);
    for (const [set, key] of [
        [activeArtists, 'artist'],
        [activeCircles, 'circle'],
        [activeTags, 'tag'],
        [activeAges, 'age'],
        [activeLocal, 'local'],
        [activeSubtitles, 'subtitle'],
        [activeTranslators, 'translator'],
        [activeListenStatuses, 'listen'],
    ]) {
        for (const value of set) params.append(key, value);
    }
    const query = params.toString();
    return query ? `?${query}` : '';
}

function writeVoiceFiltersToUrl() {
    const params = new URLSearchParams(window.location.search);
    params.delete('q');
    params.delete('sort');
    for (const key of ['artist', 'circle', 'tag', 'age', 'local', 'subtitle', 'translator', 'listen']) params.delete(key);
    for (const [key, value] of new URLSearchParams(voiceFilterQuery())) params.append(key, value);
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
}
function openVoices(id) {
    loadWorks();
    if (!id) {
        currentWorkId = null;
        readVoiceFiltersFromUrl();
        renderList();
        return;
    }
    voiceLibraryFilters?.close();
    const decoded = decodeURIComponent(id);
    const work = works.find((entry) => entry.id === decoded);
    if (!work) {
        renderList();
        return;
    }
    // 旧书签仍可进入,并替换成原生专辑 URL,避免后退时多出一次中转。
    window.history.replaceState(null, '', voiceAlbumPath(work.id));
    window.dispatchEvent(new PopStateEvent('popstate'));
}

let editionMigrationRunning = false;

/**
 * Old imports only stored source_id. Re-read the Kikoeru metadata once and
 * copy the edition/translator fields without replacing tracks or attachments.
 */
async function migrateVoiceEditions() {
    if (editionMigrationRunning) return;
    const pending = works.filter((work) => work?.code && work.sourceUrl && !work.sourceCode && !work.editionCheckedAt);
    if (!pending.length) return;
    editionMigrationRunning = true;
    try {
        for (const work of pending) {
            try {
                const fresh = await fetchKikoeruWork(work.code);
                Object.assign(work, {
                    sourceCode: fresh.sourceCode,
                    editionCodes: fresh.editionCodes,
                    editionLang: fresh.editionLang,
                    editionLabel: fresh.editionLabel,
                    translators: fresh.translators,
                    trueCircle: fresh.trueCircle || work.trueCircle || '',
                    editionCheckedAt: new Date().toISOString(),
                });
            } catch (error) {
                console.warn('Failed to migrate voice edition metadata:', work.code, error);
                work.editionCheckedAt = new Date().toISOString();
            }
        }
        persistWorks();
        renderList();
    } finally {
        editionMigrationRunning = false;
    }
}

function mergeVoiceEditionCodes(left, right, leftCode, rightCode) {
    const values = new Map();
    for (const edition of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
        const code = String(edition?.code || '').toUpperCase();
        if (code) values.set(code, edition);
    }
    for (const code of [leftCode, rightCode].filter(Boolean)) {
        const upper = String(code).toUpperCase();
        if (!values.has(upper)) values.set(upper, { code: upper, lang: '', label: '', isOriginal: false });
    }
    return [...values.values()];
}

const editionRefreshCache = new Map();

function applyEditionRefresh(previous, fresh) {
    if (!fresh?.tracks?.length) return null;
    fresh.editionCodes = mergeVoiceEditionCodes(
        fresh.editionCodes,
        previous?.editionCodes,
        fresh.code,
        previous?.code,
    );
    fresh.importedAt = previous?.importedAt || fresh.importedAt;
    fresh.userTitle = previous?.userTitle || fresh.userTitle;
    fresh.listenStatus = previous?.listenStatus || fresh.listenStatus;
    if (previous?.id && previous.id !== fresh.id) {
        works = works.filter((edition) => edition.id !== previous.id);
    }
    const index = works.findIndex((edition) => edition.id === fresh.id);
    if (index >= 0) works[index] = fresh;
    else works = [fresh, ...works];
    persistWorks();
    mergeFileStorageWorks(globalThis.__monochromeFileStorageWorks || []);
    return fresh;
}

async function refreshEditionInBackground(target) {
    const code = String(target?.code || target?.sourceCode || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
    if (!code) return false;
    const cached = editionRefreshCache.get(code);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        const current = applyEditionRefresh(target, cached.work);
        if (current && document.getElementById('page-album')?.dataset.voiceWorkId === target.id) {
            refreshVoiceAlbumAfterDownload(works.find((entry) => entry.id === current.id) || current);
        }
        return true;
    }
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(6000) : undefined;
    try {
        const fresh = await fetchKikoeruWork(code, { retries: 1, signal });
        if (!fresh?.tracks?.length) return false;
        editionRefreshCache.set(code, { at: Date.now(), work: fresh });
        const current = applyEditionRefresh(target, fresh);
        if (current && document.getElementById('page-album')?.dataset.voiceWorkId === target.id) {
            refreshVoiceAlbumAfterDownload(works.find((entry) => entry.id === current.id) || current);
        }
        return true;
    } catch (error) {
        console.warn('Background edition refresh skipped:', code, error?.message || error);
        return false;
    }
}

async function ensureImportedVoiceBundle(work) {
    const bridge = globalThis.__monochromeFileStorage;
    if (!work?.id || typeof bridge?.saveVoiceBundle !== 'function') return false;
    try {
        await bridge.saveVoiceBundle(work);
        return true;
    } catch (error) {
        console.warn('Manually imported voice bundle skipped:', work?.code, error?.message || error);
        return false;
    }
}

let manualVoiceImportRunning = false;

async function importVoice() {
    const input = document.getElementById('voices-import-input');
    const button = document.getElementById('voices-import-button');
    const status = document.getElementById('voices-import-status');
    const value = input?.value?.trim() ?? '';
    if (!value) return;
    if (button) button.disabled = true;
    manualVoiceImportRunning = true;
    setUiState(status, 'loading', t('voices.importing'));
    try {
        const work = await fetchKikoeruWork(value);
        // Manual import: Kikoeru gives the tree, DLsite fills price/cover/age and
        // authoritative fields. Merge both before persisting the work/bundle.
        const manualCode = String(work.code || work.sourceCode || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
        if (manualCode) {
            const dlsite = await fetchDlsiteWorkMetadata(manualCode).catch(() => null);
            if (dlsite) {
                const merged = mergeVoiceMetadata(work, dlsite);
                for (const key of ['title', 'circle', 'trueCircle', 'artists', 'tags', 'rating', 'ratingCount', 'price', 'currency', 'release', 'ageCategory', 'nsfw', 'editionCodes', 'translators', 'editionLang', 'editionLabel', 'cover', 'sourceCode', 'sourceUrl']) {
                    if (merged?.[key] !== undefined && merged[key] !== null) work[key] = merged[key];
                }
            }
        }
        const exact = works.findIndex((entry) => entry.id === work.id);
        const overlapping = works.find((entry) =>
            entry.id !== work.id && voiceWorkCodesOverlap(entry, work));
        if (exact >= 0 && importOptions && !importOptions.get('overwriteExisting')) {
            void ensureImportedVoiceBundle(works[exact]);
            setUiState(status, 'success', t('importOptions.keptExisting'));
            return;
        }
        if (overlapping) {
            // The same work in another edition is already in the library. Do not
            // create a second independent card: expose the new edition in the
            // existing group's edition selector and return to that album.
            overlapping.editionCodes = mergeVoiceEditionCodes(
                overlapping.editionCodes,
                work.editionCodes,
                overlapping.code,
                work.code,
            );
            work.editionCodes = overlapping.editionCodes;
            work.sourceCode = overlapping.sourceCode || work.sourceCode;
            const incomingIndex = works.findIndex((entry) => entry.id === work.id);
            if (incomingIndex >= 0) works[incomingIndex] = { ...work, importedAt: works[incomingIndex].importedAt || work.importedAt };
            else works = [work, ...works];
            selectedIds.clear();
            persistWorks();
            if (input) input.value = '';
            setUiState(status, 'success', t('voices.imported'));
            voiceImportOpen = false;
            ratingHydrationCodes.delete(String(work.code || '').toUpperCase());
            void hydrateVoiceRatings();
            void ensureImportedVoiceBundle(work);
            navigate(voiceAlbumPath(overlapping.id));
            return;
        }
        if (exact >= 0) works[exact] = { ...work, importedAt: works[exact].importedAt || work.importedAt };
        else works = [work, ...works];
        selectedIds.clear();
        void ensureImportedVoiceBundle(work);
        persistWorks();
        if (input) input.value = '';
        setUiState(status, 'success', t('voices.imported'));
        voiceImportOpen = false;
        ratingHydrationCodes.delete(String(work.code || '').toUpperCase());
        void hydrateVoiceRatings();
        navigate(voiceAlbumPath(work.id));
    } catch (error) {
        console.error('Failed to import voice work:', error);
        setUiState(status, 'error', `${t('voices.importFailed')}: ${error?.message ?? error}`);
    } finally {
        manualVoiceImportRunning = false;
        if (button) button.disabled = false;
    }
}

export function initializeVoicesPage() {
    const page = document.getElementById('page-voices');
    if (!page) return;
    loadWorks();
    voiceLibraryFilters = createVoiceLibraryFilters({
        getFacets: voiceFilterFacets,
        getSelected: voiceFilterSelected,
        getLabel: voiceFilterLabel,
        getResultCount: () => visibleVoiceWorks().length,
        onToggle: (kind, value) => toggleFilter(kind, value),
        onClear: () => {
            activeArtists.clear();
            activeCircles.clear();
            activeTags.clear();
            activeAges.clear();
            activeSubtitles.clear();
            activeTranslators.clear();
            activeListenStatuses.clear();
            writeVoiceFiltersToUrl();
            renderList();
        },
    });
    renderList();
    setTimeout(() => { void hydrateVoiceRatings(); }, 400);
    initializeVoiceTagMorePopover();
    void migrateVoiceEditions();
    globalThis.__monochromeEnsureVoiceBundles = ensureOnlineWorkBundles;
    setTimeout(() => { void ensureOnlineWorkBundles(); }, 1500);
    importOptions = createImportOptions({
        storageKey: VOICES_OPTIONS_KEY,
        container: '#voices-import-options',
        labelKey: 'importOptions.label',
        items: [
            {
                id: 'overwriteExisting',
                elementId: 'voice-option-overwrite-existing',
                labelKey: 'importOptions.overwriteExisting',
            },
        ],
        defaults: { overwriteExisting: true },
        noteKey: 'importOptions.metadataOnly',
    });
    document.getElementById('voices-import-toggle')?.addEventListener('click', () => setVoiceImportOpen(!voiceImportOpen, true));
    document.getElementById('voices-import-close')?.addEventListener('click', () => setVoiceImportOpen(false, true));
    document.getElementById('voices-library-search')?.addEventListener('input', (event) => {
        libraryQuery = event.target.value;
        writeVoiceFiltersToUrl();
        renderList();
    });
    document.getElementById('voices-library-sort')?.addEventListener('change', (event) => {
        librarySort = event.target.value;
        writeVoiceFiltersToUrl();
        renderList();
    });
    page.addEventListener('keydown', (event) => {
        const manage = document.getElementById('voices-manage');
        if (event.key === 'Escape' && manage?.open) {
            manage.open = false;
            manage.querySelector('summary')?.focus();
        }
        if (event.target.closest('.voices-library-toolbar, .voices-management, #voices-import-panel, #voices-import-toggle, #voices-grid button, #voices-selection-bar')) event.stopPropagation();
        const card = event.target.closest('.voice-card');
        if (card && event.target === card && ['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            navigate(voiceAlbumPath(card.dataset.voiceId));
        }
    });
    document.getElementById('voices-import-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        void importVoice();
    });
    const grid = document.getElementById('voices-grid');
    grid?.addEventListener('click', (event) => {
        const select = event.target.closest('[data-select-voice-id]');
        if (select) {
            event.preventDefault();
            event.stopPropagation();
            toggleVoiceSelection(select.dataset.selectVoiceId);
            return;
        }
        if (handleFilterClick(event)) return;
        const card = event.target.closest('[data-voice-id]');
        if (card) navigate(voiceAlbumPath(card.dataset.voiceId));
    });
    document.addEventListener('click', (event) => {
        const manage = document.getElementById('voices-manage');
        if (manage?.open && !manage.contains(event.target)) manage.open = false;
    });
    document.addEventListener('keydown', (event) => {
        const manage = document.getElementById('voices-manage');
        if (event.key === 'Escape' && manage?.open) {
            manage.open = false;
            manage.querySelector('summary')?.focus();
        }
    });
    document.getElementById('voices-select-all')?.addEventListener('click', () => {
        toggleSelectAllVoices();
    });
    document.getElementById('voices-delete-selected')?.addEventListener('click', () => {
        deleteSelectedVoices();
    });
    document.getElementById('voices-cancel-selection')?.addEventListener('click', () => {
        clearVoiceSelection();
    });
    document.getElementById('voices-clear-all')?.addEventListener('click', () => {
        clearAllVoices();
    });
    const detail = document.getElementById('voices-detail');
    detail?.addEventListener('click', (event) => {
        handleFilterClick(event);
    });
    document.addEventListener('monochrome:voices-open', (event) => {
        openVoices(event.detail?.id ?? null);
    });
    document.addEventListener(
        'click',
        (event) => {
            const page = document.getElementById('page-album');
            if (!page?.dataset.voiceWorkId || !page.classList.contains('active')) return;
            // The visual row shrinks while pressed; the stable wrapper must still receive an edge click.
            const row = event.target.closest('.voice-album-track-row') ||
                event.target.closest('.voice-album-row-hitbox')?.querySelector('.voice-album-track-row');
            if (!row || event.target.closest('a, button, input, label')) return;
            const work = works.find((entry) => entry.id === page.dataset.voiceWorkId);
            if (!work) return;
            event.preventDefault();
            event.stopPropagation();
            const file = findVoiceFile(work.tracks, row.dataset.voiceHash);
            if (!file) return;
            if (getVoiceFileType(file.node) === 'audio') void playVoiceFile(work, file.node);
            else voiceAttachmentViewer?.open(file);
        },
        true,
    );
    document.addEventListener('monochrome:album-render-start', cleanupVoiceAlbumExtras);
    document.addEventListener('monochrome:voice-album-rendered', (event) => {
        currentVoiceAlbum = event.detail?.album || currentVoiceAlbum;
        if (event.detail?.work) renderAlbumExtras(event.detail.work, currentVoiceAlbum);
    });
    window.addEventListener('voice-settings-changed', (event) => {
        if (event.detail?.key !== 'initialPath') return;
        const page = document.getElementById('page-album');
        if (!page?.dataset.voiceWorkId || !page.classList.contains('active')) return;
        const work = works.find((entry) => entry.id === page.dataset.voiceWorkId);
        if (work) renderAlbumExtras(work);
    });
}

/**
 * 由 app.js 在 Player 初始化后调用一次;io 把 5s 刷新写回 voices 模块的 works,
 * 避免 voice-stream-refresh.js 反向 import voices.js 形成循环。
 */
/**
 * Replace the file-storage slice of the voice library with host-backed works.
 * These are not written to localStorage: the sidecar SQLite/CAS is authoritative.
 */
function voiceWorkCodeSet(work) {
    const values = [
        work?.code,
        work?.sourceCode,
        work?.source?.sourceCode,
        work?.userMeta?.sourceCode,
        work?.originalCode,
        String(work?.id || '').replace(/^voice-/, ''),
        work?.workId,
        ...(Array.isArray(work?.editionCodes) ? work.editionCodes.map((edition) => edition?.code) : []),
    ];
    return new Set(
        values
            .map((value) => String(value || '').toUpperCase().match(/RJ\d{5,8}/)?.[0])
            .filter(Boolean),
    );
}

function voiceWorkCode(work) {
    return [...voiceWorkCodeSet(work)][0] || '';
}

function voiceWorkCodesOverlap(left, right) {
    const leftCodes = voiceWorkCodeSet(left);
    if (!leftCodes.size) return false;
    for (const code of voiceWorkCodeSet(right)) {
        if (leftCodes.has(code)) return true;
    }
    return false;
}

function fileNodeCount(work) {
    let count = 0;
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') walk(node.children);
            else count += 1;
        }
    };
    walk(work?.tracks);
    return count;
}

function audioNodeCount(work) {
    let count = 0;
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') walk(node.children);
            else if (node.type === 'audio') count += 1;
        }
    };
    walk(work?.tracks);
    return count;
}

function applyHostDisplayMetadataToOnline(online, host) {
    const hostTitle = String(host?.title || '').trim();
    const genericTitle = !hostTitle || /^untitled local work$/i.test(hostTitle);
    if (!genericTitle) online.title = host.userTitle || hostTitle || online.title;
    online.userTitle = host.userTitle || online.userTitle;
    // The host `circle` may be the translator of a translated edition. Keep the
    // online circle in that case: overwriting it made the facet list 漁貓 as a
    // circle. trueCircle below is the authoritative original circle.
    const hostCircle = String(host.circle || '');
    if (hostCircle && !voiceTranslatorList(host).includes(hostCircle)) online.circle = hostCircle;
    if (Array.isArray(host.artists) && host.artists.length) online.artists = host.artists;
    if (Array.isArray(host.tags) && host.tags.length) online.tags = host.tags;
    if (Array.isArray(host.translators) && host.translators.length) online.translators = host.translators;
    online.cover = host.cover || online.cover;
    online.editionCodes = host.editionCodes || online.editionCodes;
    const edition = (host.editionCodes || []).find(
        (entry) => String(entry.code || '').toUpperCase() === String(online.code || '').toUpperCase(),
    );
    const localizedLang = /繁體|繁体/.test(hostTitle)
        ? 'chi_hant'
        : /简体|简中|中文版/.test(hostTitle) ? 'chi_hans' : '';
    online.editionLang = localizedLang || edition?.lang || online.editionLang;
    online.editionLabel = edition?.label || host.editionLabel || online.editionLabel;
    // Metadata editor writes these to host. The partial card keeps the online
    // tree, so it must also overlay the editable host fields; otherwise saving
    // rating/price/release/age appears to have no effect.
    online.rating = Number(host.rating) || online.rating || 0;
    online.ratingCount = Number(host.ratingCount) || online.ratingCount || 0;
    online.reviewCount = Number(host.reviewCount) || online.reviewCount || 0;
    online.soldCount = Number(host.soldCount) || online.soldCount || 0;
    online.price = Number(host.price) || online.price || 0;
    online.currency = host.currency || online.currency;
    online.release = host.release || online.release;
    online.duration = Number(host.duration) || online.duration || 0;
    const hostAgeCategory = host.ageCategory && host.ageCategory !== 'unrated'
        ? host.ageCategory
        : '';
    online.ageCategory = hostAgeCategory || online.ageCategory;
    // The editor folds NSFW into ageCategory (r18). OR-ing the online flag here
    // would make switching an R-18 partial card back to all/r15 a silent no-op.
    online.nsfw = hostAgeCategory
        ? hostAgeCategory === 'r18' || Boolean(host.nsfw)
        : Boolean(online.nsfw || host.nsfw);
    online.trueCircle = host.trueCircle || online.trueCircle;
    online.hasSubtitle = Boolean(host.hasSubtitle || online.hasSubtitle);
    online.sourceUrl = host.sourceUrl || online.sourceUrl;
    online.pageUrl = host.pageUrl || online.pageUrl;
}

function mergeVoiceHostMetadata(host, match) {
    const hostTitle = String(host?.title || '').trim();
    const genericTitle = !hostTitle || /^untitled local work$/i.test(hostTitle);
    const hostArtists = Array.isArray(host?.artists) && host.artists.length ? host.artists : host?.cvs;
    const hostTags = Array.isArray(host?.tags) && host.tags.length ? host.tags : null;
    const hostEditions = Array.isArray(host?.editionCodes) && host.editionCodes.length ? host.editionCodes : null;
    const hostTranslators = Array.isArray(host?.translators) && host.translators.length ? host.translators : null;
    return {
        ...match,
        ...host,
        title: host?.userTitle || (genericTitle ? match?.title : host?.title) || match?.title,
        circle: host?.circle || match?.circle,
        artists: Array.isArray(hostArtists) && hostArtists.length ? hostArtists : match?.artists,
        tags: hostTags || match?.tags,
        // Host rows only carry the local file identity; source metadata must not
        // be replaced by empty defaults when the online record is still present.
        rating: Number(host?.rating) || Number(match?.rating) || 0,
        ratingCount: Number(host?.ratingCount) || Number(match?.ratingCount) || 0,
        reviewCount: Number(host?.reviewCount) || Number(match?.reviewCount) || 0,
        soldCount: Number(host?.soldCount) || Number(match?.soldCount) || 0,
        price: Number(host?.price) || Number(match?.price) || 0,
        currency: host?.currency || match?.currency,
        release: host?.release || match?.release,
        duration: Number(host?.duration) || Number(match?.duration) || 0,
        sourceUrl: host?.sourceUrl || match?.sourceUrl,
        pageUrl: host?.pageUrl || match?.pageUrl,
        sourceCode: host?.source?.sourceCode || host?.sourceCode || match?.sourceCode,
        code: host?.code || match?.code,
        ageCategory: host?.ageCategory && host.ageCategory !== 'unrated' && host.ageCategory !== 'unknown'
            ? host.ageCategory
            : match?.ageCategory || host?.ageCategory,
        nsfw: Boolean(host?.nsfw || match?.nsfw),
        editionLang: host?.editionLang || match?.editionLang,
        editionLabel: host?.editionLabel || match?.editionLabel,
        editionCodes: hostEditions || match?.editionCodes,
        translators: hostTranslators || match?.translators,
        hasSubtitle: Boolean(host?.hasSubtitle || match?.hasSubtitle),
        cover: host?.cover || match?.cover,
        importedAt: host?.importedAt || match?.importedAt,
        localFileStorageState: 'full',
    };
}

function voiceTrackNumber(value) {
    // Japanese edition filenames often use full-width digits (【２】); NFKC
    // folds them to ASCII before matching so both editions key the same track.
    const text = String(value || '').normalize('NFKC');
    const strong = text.match(/【\s*(\d{1,3})\s*】/) || text.match(/第\s*(\d{1,3})\s*[話话集]/);
    if (strong) return Number(strong[1]);
    const leading = text.match(/^\s*0*(\d{1,3})[\s._\-]/);
    return leading ? Number(leading[1]) : null;
}

/**
 * Online cards keep the remote tree for hierarchy/metadata, but rows that are
 * local or aliases must actually play/preview from the host. Attach host media
 * URLs by matching the edition-specific logical path/basename. For a translated
 * edition audio alias, also map the canonical edition's local subtitle by track
 * number so the Japanese page can read the Chinese subtitle.
 */
function applyHostLocalMediaToOnline(online, host) {
    const manifest = Array.isArray(host?.manifest) ? host.manifest : [];
    const entries = Array.isArray(host?.entries) ? host.entries : [];
    if (!manifest.length || !online?.tracks) return;
    const hostUrl = String(host.hostUrl || '').replace(/\/+$/, '');
    if (!hostUrl) return;
    const hostEntries = new Map(entries.map((entry) => [String(entry.logicalPath || ''), entry]));
    const hostEntriesByHash = new Map();
    for (const entry of entries) {
        if (!entry.sha256 || !entry.mediaPath) continue;
        if (!hostEntriesByHash.has(String(entry.sha256))) hostEntriesByHash.set(String(entry.sha256), entry);
    }
    const byName = new Map();
    for (const entry of manifest) {
        const name = normalizeVoiceLocalName(String(entry.logicalPath || '').split('/').pop());
        if (name && !byName.has(name)) byName.set(name, entry);
    }
    const canonicalEntry = (entry) => (entry?.aliasOf
        ? manifest.find((candidate) => String(candidate.logicalPath) === String(entry.aliasOf)) || entry
        : entry);
    const hostEntryFor = (entry) => {
        const canonical = canonicalEntry(entry);
        return hostEntries.get(String(canonical?.logicalPath || ''))
            || (canonical?.hash ? hostEntriesByHash.get(String(canonical.hash)) : null)
            || null;
    };
    const localUrl = (entry) => {
        if (!entry || entry.status !== 'local') return '';
        // Reconcile keeps one physical host entry per sha256; prefer the path,
        // then fall back to the hash when an older manifest lost the canonical path.
        const hostEntry = hostEntryFor(entry);
        return hostEntry?.mediaPath ? `${hostUrl}${hostEntry.mediaPath}` : '';
    };
    const localSubtitles = manifest
        .filter((entry) => /\.(srt|vtt|lrc)$/i.test(String(entry.title || entry.logicalPath || '')))
        .map((entry) => ({ entry, number: voiceTrackNumber(entry.logicalPath || entry.title) }))
        .filter((item) => item.number !== null);
    // The alias target owns the canonical edition; its subtitles are the ones
    // the alias audio should read, even when both editions have a same-number
    // subtitle. Remote canonical entries are allowed when they still carry a URL.
    const subtitleFor = (number, canonical) => {
        const candidates = localSubtitles.filter((item) => item.number === number);
        const edition = String(canonical?.editionCode || '').toUpperCase();
        const preferred = edition
            ? candidates.filter((item) => String(item.entry.editionCode || '').toUpperCase() === edition)
            : [];
        return [...preferred, ...candidates].find((item) => Boolean(
            localUrl(item.entry) || item.entry.mediaStreamUrl || item.entry.mediaDownloadUrl
        )) || null;
    };
    const aliasSubtitles = {};
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') {
                walk(node.children);
                continue;
            }
            const entry = manifest.find((candidate) => String(candidate.logicalPath) === String(node.logicalPath || ''))
                || byName.get(normalizeVoiceLocalName(node.title));
            const url = localUrl(entry);
            if (!url) continue;
            if (!node.remoteMediaStreamUrl && node.mediaStreamUrl) node.remoteMediaStreamUrl = node.mediaStreamUrl;
            if (!node.remoteMediaDownloadUrl && node.mediaDownloadUrl) node.remoteMediaDownloadUrl = node.mediaDownloadUrl;
            node.localMediaStreamUrl = url;
            node.localMediaDownloadUrl = url;
            node.local = true;
            node.status = 'local';
            const hostEntry = hostEntryFor(entry);
            if (hostEntry?.entryId) {
                node.hostWorkId = host.storageWorkId || host.id;
                node.hostEntryId = hostEntry.entryId;
                node.hostEntrySha = hostEntry.sha256 || entry.hash || '';
            }
            if (!node.hash || getVoiceFileType(node) !== 'audio') continue;
            const number = voiceTrackNumber(entry.logicalPath || node.title);
            const subtitle = number === null ? null : subtitleFor(number, canonicalEntry(entry));
            if (!subtitle) continue;
            const subtitleUrl = localUrl(subtitle.entry)
                || subtitle.entry.mediaStreamUrl
                || subtitle.entry.mediaDownloadUrl
                || '';
            if (!subtitleUrl) continue;
            const subtitleHost = hostEntryFor(subtitle.entry);
            aliasSubtitles[node.hash] = {
                node: {
                    ...subtitle.entry,
                    title: String(subtitle.entry.title || '').replace(/\.(srt|vtt|lrc)$/i, ''),
                    mediaStreamUrl: subtitleUrl,
                    mediaDownloadUrl: subtitleUrl,
                    hash: subtitle.entry.hash,
                    ...(subtitleHost?.entryId ? {
                        hostWorkId: host.storageWorkId || host.id,
                        hostEntryId: subtitleHost.entryId,
                        hostEntrySha: subtitleHost.sha256 || subtitle.entry.hash || '',
                    } : {}),
                },
                format: String(subtitle.entry.title || subtitle.entry.logicalPath || '').match(/\.(srt|vtt|lrc)$/i)?.[1]?.toLowerCase() || 'vtt',
                path: [],
                stem: normalizeSubtitleStem(subtitle.entry.title || subtitle.entry.logicalPath),
            };
        }
    };
    walk(online.tracks);
    if (Object.keys(aliasSubtitles).length) {
        online.aliasSubtitlesByAudioHash = aliasSubtitles;
        online.hasSubtitle = true;
        online.has_subtitle = true;
    }
}

export function mergeFileStorageWorks(incomingWorks) {
    const statuses = readFileListenStatuses();
    const items = (Array.isArray(incomingWorks) ? incomingWorks.filter((work) => work && work.id) : []).map((work) => {
        const status = statuses[work.storageWorkId || work.id];
        return status && LISTEN_STATUS_VALUES.has(status) ? { ...work, listenStatus: status } : work;
    });
    // Album/track lookups in voice-album.js read their own library; publish the
    // host-backed slice so opening an imported card resolves its tracks.
    globalThis.__monochromeFileStorageWorks = items;
    // The download journal can outlive host files that were deleted from disk.
    // Prune it against the host slice so rows immediately regain the remote badge.
    for (const host of items) {
        const hostHashes = new Set();
        const walkHashes = (nodes) => {
            for (const node of nodes || []) {
                if (node.type === 'folder') walkHashes(node.children);
                else if (node.hash) hostHashes.add(String(node.hash));
            }
        };
        walkHashes(host.tracks);
        pruneVoiceDownloadHashes(host.id, hostHashes);
        if (host.storageWorkId && host.storageWorkId !== host.id) {
            pruneVoiceDownloadHashes(host.storageWorkId, hostHashes);
        }
    }
    // The host refresh can finish before the first loadWorks(); merge against the
    // localStorage slice explicitly so a partial host work never hides/replaces
    // the online card (and its cover) just because `works` was still empty.
    loadWorks();
    const online = works.filter((work) => !work.fileStorage && !work.browserLocal);
    const visibleHosts = [];
    const replacedOnline = new Set();
    for (const host of items) {
        const hostPrimary = String(host.code || host.source?.sourceCode || '').toUpperCase();
        const match = (hostPrimary
            ? online.find((work) => String(work.code || '').toUpperCase() === hostPrimary)
            : null)
            || online.find((work) => voiceWorkCodesOverlap(host, work)) || null;
        // A host work marked partial by a host-side deletion must never replace
        // the online record, even when the online track tree happens to be empty
        // before the album is opened. Keep the online card so its full remote
        // file tree and the derived remote badges remain available.
        const hostHasMissingRemoteUrls = (() => {
            let missing = false;
            const walk = (nodes) => {
                for (const node of nodes || []) {
                    if (node.type === 'folder') { walk(node.children); continue; }
                    if (!node.local && !node.mediaDownloadUrl && !node.mediaStreamUrl) missing = true;
                }
            };
            walk(host.tracks);
            return missing;
        })();
        // A host work can only be judged "complete" against a loaded online
        // tree. Without one (no online record, or a record whose tracks were
        // never hydrated) the old code answered `true` and the host card became
        // the only record, silently dropping the full remote track tree on the
        // next startup. Unknown completeness must read as partial.
        const onlineTreeLoaded = Array.isArray(match?.tracks) && match.tracks.length > 0;
        const hostComplete = host.localFileStorageState === 'partial'
            ? false
            : match && onlineTreeLoaded
                ? fileNodeCount(host) >= fileNodeCount(match) &&
                  audioNodeCount(host) >= audioNodeCount(match) &&
                  !hostHasMissingRemoteUrls &&
                  (Boolean(host.hasLocalCover) || !match.cover)
                : false;

        if (match && !hostComplete) {
            if (!voiceHostHasLocalContent(host)) {
                // The host only mirrored remote metadata/sidecars. Do not turn a
                // pure-online card into “partial” just because the host tree is
                // smaller than the online tree.
                match.presentationMode = 'online';
                match.storageKind = 'online';
                match.storageOwner = undefined;
                continue;
            }
            // Partial download: keep the online card (it has the full remote file
            // tree) and let the derived local badge report "partial"; the host work
            // still exists for the next incremental download.
            applyHostLocalMediaToOnline(match, host);
            // Keep the online tree, but prefer the host's localized title/cover
            // only for the host's primary edition; sibling editions keep their
            // own Kikoeru title.
            const hostPrimaryCode = String(host.code || host.source?.sourceCode || '').toUpperCase();
            if (hostPrimaryCode && String(match.code || '').toUpperCase() === hostPrimaryCode) {
                applyHostDisplayMetadataToOnline(match, host);
            }
            host.__voicePartial = true;
            match.localFileStorageState = 'partial';
            match.storageKind = 'online';
            match.presentationMode = 'partial';
            match.storageOwner = host.storageWorkId || host.id;
            continue;
        }
        if (match) {
            delete host.__voicePartial;
            replacedOnline.add(match);
            visibleHosts.push(mergeVoiceHostMetadata(host, match));
        } else {
            // No online record to compare against. Only a stored manifest that
            // declares every entry local proves completeness; anything else is
            // "unknown", and showing it as a complete local card is what made
            // the online tree disappear after a restart.
            const manifestKnown = host.hasStoredManifest && Array.isArray(host.manifest) && host.manifest.length > 0;
            if (!manifestKnown || host.localFileStorageState !== 'full') {
                host.localFileStorageState = 'partial';
                host.presentationMode = 'partial';
            }
            visibleHosts.push(host);
        }
    }
    works = [...visibleHosts, ...online.filter((work) => !replacedOnline.has(work))];
    persistVoiceWorkJsonSnapshots();
    selectedIds.clear();
    renderList();
    // Host merge replaces the work objects, so let the rating hydrator re-apply
    // cached/source ratings to the current list.
    setTimeout(() => { void hydrateVoiceRatings(); }, 300);
    document.dispatchEvent(new CustomEvent('monochrome:file-storage-works-updated'));
    setTimeout(() => { void ensureOnlineWorkBundles(); }, 1200);
    return items.length;
}

/** Browser-local folder import is session data: audio lives in object URLs, not CAS. */
export function mergeBrowserLocalWorks(incomingWorks) {
    const items = Array.isArray(incomingWorks) ? incomingWorks.filter((work) => work && work.id) : [];
    const mergedItems = items.map((local) => {
        // Folder imports from the browser are local-first, but the online record
        // is the only place that still has CV/tags/release/price. Preserve that
        // metadata exactly like the storage-host merge does.
        const candidates = works.filter((work) => work.id !== local.id && !work.browserLocal);
        // Prefer the online record: the host mirror often only has file identity.
        const match = candidates.find((work) => !work.fileStorage && voiceWorkCodesOverlap(work, local))
            || candidates.find((work) => work.fileStorage && voiceWorkCodesOverlap(work, local))
            || null;
        return match ? mergeVoiceHostMetadata(local, match) : local;
    });
    globalThis.__monochromeBrowserLocalWorks = mergedItems;
    works = [
        ...mergedItems,
        ...works.filter((work) => !mergedItems.some((item) => voiceWorkCodesOverlap(item, work))),
    ];
    selectedIds.clear();
    renderList();
    return mergedItems.length;
}

export function initializeVoiceStreamRefresh() {
    startVoiceStreamRefresh(Player.instance, {
        getWork: (workId) => works.find((entry) => entry.id === workId) || null,
        updateTrackUrls: (workId, hash, node, base) => {
            const work = works.find((entry) => entry.id === workId);
            if (!work) return false;
            const target = findVoiceFile(work.tracks, hash)?.node;
            if (!target) return false;
            if (node.mediaStreamUrl) target.mediaStreamUrl = node.mediaStreamUrl;
            if (node.mediaDownloadUrl) target.mediaDownloadUrl = node.mediaDownloadUrl;
            if (node.streamLowQualityUrl) target.streamLowQualityUrl = node.streamLowQualityUrl;
            work.backendBase = base || work.backendBase;
            work.urlsResolvedAt = Date.now();
            persistWorks();
            return true;
        },
    });
}

let onlineBundleMigrationRunning = false;
// One attempt per work identity per session. `ensureOnlineWorkBundles` is armed
// from inside every merge, and a bundle write bumps the host revision, which
// causes another merge — so a work that can never be matched back to its host row
// re-armed itself about every 1.2 s forever, and each round tore down and rebuilt
// the album action row (the visible "flicker"). Attempting once removes the loop
// while still migrating works that appear later.
const onlineBundleAttempted = new Set();

/**
 * Online cards should still have a per-work folder/manifest in the file library.
 * Create the bundle once per identity; editions sharing code/editionCodes reuse
 * the same root and never generate duplicate folders.
 */
async function ensureOnlineWorkBundles() {
    if (onlineBundleMigrationRunning || manualVoiceImportRunning) return 0;
    const bridge = globalThis.__monochromeFileStorage;
    if (typeof bridge?.saveVoiceBundle !== 'function') return 0;
    onlineBundleMigrationRunning = true;
    let created = 0;
    try {
        loadWorks();
        const deletedIdentities = voiceDeletedIdentities();
        // A work that is back in the library was re-imported on purpose; its
        // tombstone must not block a future delete.
        let tombstonesChanged = false;
        for (const work of works) {
            if (!work?.fileStorage) continue;
            for (const code of voiceBundleCodes(work)) {
                if (deletedIdentities.delete(code)) tombstonesChanged = true;
            }
        }
        if (tombstonesChanged) writeVoiceDeletedIdentities(deletedIdentities);
        const seen = new Set();
        for (const work of works) {
            if (!work || work.fileStorage || work.browserLocal) continue;
            const identity = voiceBundleIdentity(work);
            if (!identity || seen.has(identity)) continue;
            seen.add(identity);
            if (voiceHostForWork(work)) continue;
            if (onlineBundleAttempted.has(identity)) continue;
            // A work the user deleted from the library must stay deleted: the online
            // record still exists, so without this the migration rebuilds the folder
            // on the next load and the delete looks like it did nothing.
            if (isVoiceDeleted(work, deletedIdentities)) continue;
            onlineBundleAttempted.add(identity);
            let sourceWork = work;
            if (!Array.isArray(sourceWork.tracks) || sourceWork.tracks.length === 0) {
                const code = voiceWorkCode(work);
                if (!code) continue;
                try {
                    sourceWork = await fetchKikoeruWork(code);
                } catch (error) {
                    console.warn('voice bundle metadata fetch skipped:', code, error?.message || error);
                    continue;
                }
            }
            try {
                await bridge.saveVoiceBundle(sourceWork);
                created += 1;
            } catch (error) {
                console.warn('voice bundle folder migration skipped:', work?.code, error?.message || error);
            }
        }
        if (created > 0) await bridge.refresh?.();
    } finally {
        onlineBundleMigrationRunning = false;
    }
    return created;
}

async function saveVoiceToStorage(work, button) {
    await startVoiceDownload(work, [], button, null, 'storage');
}

function mountVoiceStorageButton(event) {
    const work = event?.detail?.work;
    const downloadButton = document.getElementById('download-album-btn');
    if (!work || !downloadButton || work.fileStorage) return;
    if (document.getElementById('voice-save-storage')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'voice-save-storage';
    button.className = 'btn btn-secondary voice-save-storage';
    button.textContent = t('voices.saveToLibrary');
    button.title = t('voices.saveToLibraryHint');
    button.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
        void saveVoiceToStorage(work, button);
    });
    downloadButton.after(button);
}


function mountVoiceMetadataButton(event) {
    const work = event?.detail?.work;
    const downloadButton = document.getElementById('download-album-btn');
    const host = voiceStorageHostFor(work);
    if (!host || !downloadButton || document.getElementById('voice-edit-metadata')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'voice-edit-metadata';
    button.className = 'btn btn-secondary voice-edit-metadata';
    button.textContent = t('voices.metadata.edit');
    button.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
        openVoiceMetadataEditor(host, {
            onSaved: async () => {
                await globalThis.__monochromeFileStorage?.refresh?.();
                mergeFileStorageWorks(globalThis.__monochromeFileStorageWorks || []);
                const current = works.find((entry) => entry.id === work?.id) || host;
                refreshVoiceAlbumAfterDownload(current);
            },
        });
    });
    downloadButton.after(button);
}

function mountVoiceOpenLocationButton(event) {
    const work = event?.detail?.work;
    const downloadButton = document.getElementById('download-album-btn');
    if (!work || !downloadButton || document.getElementById('voice-open-location')) return;
    const partialHost = voicePartialHostFor(work) ||
        (globalThis.__monochromeFileStorageWorks || []).find(
            (host) => voiceWorkCodesOverlap(host, work),
        );
    if (!work.fileStorage && (!partialHost || voiceLocalAvailability(work) !== 'partial')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'voice-open-location';
    button.className = 'btn btn-secondary voice-open-location';
    button.innerHTML = SVG_FOLDER_OPEN(18);
    button.title = t('voices.openLocalLocation');
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
        const target = partialHost || work;
        void globalThis.__monochromeFileStorage
            ?.openLocation?.(target)
            .catch((error) => {
                console.error('open local location failed', error);
                showNotification(t('voices.openLocalLocationFailed'));
            });
    });
    downloadButton.after(button);
}

document.addEventListener('monochrome:voice-album-rendered', (event) => {
    const work = event?.detail?.work;
    mountVoiceOpenLocationButton(event);
    // Host refresh can finish several seconds after the album's first render.
    for (const delay of [800, 2500, 5000]) {
        setTimeout(() => {
            mountVoiceOpenLocationButton(event);
            const page = document.getElementById('page-album');
            if (!work || !page?.dataset.voiceWorkId || page.dataset.voicePartialState === 'partial') return;
            if (voicePartialHostFor(work)) renderAlbumExtras(work);
        }, delay);
    }
});
document.addEventListener('monochrome:album-render-start', () => {
    document.getElementById('voice-open-location')?.remove();
    const page = document.getElementById('page-album');
    if (page) delete page.dataset.voicePartialState;
});
document.addEventListener('monochrome:file-storage-works-updated', () => {
    const page = document.getElementById('page-album');
    if (!page?.classList.contains('active') || !page.dataset.voiceWorkId) return;
    const work = works.find((entry) => entry.id === page.dataset.voiceWorkId);
    if (!work) return;
    mountVoiceOpenLocationButton({ detail: { work } });
    // The host slice changed outside this page (delete, cleanup, another
    // window). Re-render even when the work is no longer partial so rows pick
    // up their new online/remote badges immediately.
    renderAlbumExtras(work);
});

document.addEventListener('monochrome:voice-album-rendered', mountVoiceMetadataButton);
document.addEventListener('monochrome:album-render-start', () => document.getElementById('voice-edit-metadata')?.remove());

// UI/test bridge, mirroring window.__monochromeFileStorage: browser probes need
// to assert the same circle value the facet filter uses, and this module cannot
// be imported from Node (it touches window at module scope).
window.__monochromeVoices = {
    voiceCircleValue,
    voiceLocalAvailability,
};
