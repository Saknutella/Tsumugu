// 在线音声结束前 5s 的下一首 URL 刷新。
//
// 为什么单独做:
//   · Player 的预加载(js/player.js:618-631)对 `track.audioUrl && !track.isLocal`
//     直接 continue(:655-656),音声永远不会被预加载;
//   · ended 后 playNext 直接读下一首对象的 audioUrl(js/player.js:2117-2140),
//     所以只要在 5s 窗口内修改队列里"下一首对象",切歌就会用新 URL。
//
// 约束:
//   · 只处理在线音声(provider='voices' 且来源是 asmr 系列),自建 Kikoeru/本地 fixtur 不动;
//   · 只改"下一首",绝不碰当前播放中的 <audio>/track,避免打断播放;
//   · 用媒体 <audio> 的 timeupdate 而不是 setInterval:后台播放时前者不会被降频。

import { fetchJson, isAsmrFamilyBase, noteMediaHost, probeMediaUrl, selectBase } from './voice-endpoints.js';

const LEAD_SECONDS = 5;
const URL_TTL_MS = 5 * 60 * 1000;
const REPEAT_ONE = 2;
const DONE_LIMIT = 500;

const inflight = new Set();
const done = new Set();
let started = false;

export function isAsmrVoiceWork(work) {
    return Boolean(work) && isAsmrFamilyBase(work.backendBase);
}

/**
 * 纯判定,便于测试:当前歌剩余 <=5s、下一首也是在线音声、且还没处理过。
 */
export function shouldRefreshNextVoiceTrack({
    currentTrack,
    nextTrack,
    repeatMode,
    remainingSeconds,
    completed = false,
} = {}) {
    if (!currentTrack || currentTrack.provider !== 'voices') return false;
    if (repeatMode === REPEAT_ONE) return false;
    if (!(Number(remainingSeconds) > 0 && Number(remainingSeconds) <= LEAD_SECONDS)) return false;
    if (!nextTrack || nextTrack.provider !== 'voices' || nextTrack.isLocal) return false;
    if (completed) return false;
    return true;
}

function findNodeByHash(nodes, hash) {
    for (const node of nodes || []) {
        if (!node) continue;
        if (node.type === 'folder') {
            const found = findNodeByHash(node.children, hash);
            if (found) return found;
        } else if (node.hash === hash) {
            return node;
        }
    }
    return null;
}

function treeNodes(json) {
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.tree)) return json.tree;
    if (Array.isArray(json?.tracks)) return json.tracks;
    if (Array.isArray(json?.data)) return json.data;
    return [];
}

function resolveDeps(deps = {}) {
    return {
        selectBase: deps.selectBase || selectBase,
        fetchJson: deps.fetchJson || fetchJson,
        probeMediaUrl: deps.probeMediaUrl || probeMediaUrl,
        noteMediaHost: deps.noteMediaHost || noteMediaHost,
    };
}

/**
 * 刷新单条下一首音声的 URL。
 * @returns {Promise<boolean>} 是否真的改写了 audioUrl
 */
export async function refreshVoiceTrack(track, { player, io = {}, deps = {} } = {}) {
    if (!track || track.provider !== 'voices' || track.isLocal) return false;
    const work = io.getWork?.(track.voiceWorkId);
    if (!work || !isAsmrVoiceWork(work) || !work.workId) return false;

    const resolved = resolveDeps(deps);
    const base = await resolved.selectBase({ family: 'asmr', maxAgeMs: 5 * 60 * 1000 }).catch(() => null);
    if (track.localMedia) return false;
    const mediaOk = await resolved.probeMediaUrl(track.audioUrl);
    const stale =
        !track.audioUrl ||
        !mediaOk ||
        (base && track._voiceResolvedBase && track._voiceResolvedBase !== base) ||
        Date.now() - Number(track._voiceResolvedAt || 0) > URL_TTL_MS;
    if (!stale) return false;

    const path = `/api/tracks/${encodeURIComponent(work.workId)}?v=2`;
    const result = await resolved.fetchJson(path, { family: 'asmr', base: base || undefined });
    const node = findNodeByHash(treeNodes(result?.json), track.voiceHash);
    if (!node?.mediaStreamUrl) return false;

    const previous = track.audioUrl;
    track.audioUrl = node.mediaStreamUrl;
    track.downloadUrl = node.mediaDownloadUrl || node.mediaStreamUrl;
    track._voiceResolvedAt = Date.now();
    track._voiceResolvedBase = result.base || base || '';
    if (node.streamLowQualityUrl) track.streamLowQualityUrl = node.streamLowQualityUrl;

    io.updateTrackUrls?.(work.id, track.voiceHash, node, track._voiceResolvedBase);
    resolved.noteMediaHost(node.mediaStreamUrl);
    await player?.saveQueueState?.();
    return previous !== track.audioUrl;
}

function rememberDone(key) {
    done.add(key);
    if (done.size > DONE_LIMIT) done.clear();
}

function onTimeUpdate(player, element, io) {
    if (!player || player.activeElement !== element) return;
    const currentTrack = player.currentTrack;
    const nextTrack = player.getNextTrack?.();
    const key = `${player.currentQueueIndex}:${nextTrack?.id || ''}`;
    const should = shouldRefreshNextVoiceTrack({
        currentTrack,
        nextTrack,
        repeatMode: player.repeatMode,
        remainingSeconds: (element.duration || 0) - (element.currentTime || 0),
        completed: inflight.has(key) || done.has(key),
    });
    if (!should) return;

    inflight.add(key);
    refreshVoiceTrack(nextTrack, { player, io })
        .catch((error) => console.warn('[voices] failed to refresh next track URL:', error))
        .finally(() => {
            inflight.delete(key);
            rememberDone(key);
        });
}

/**
 * 在 Player 初始化之后调用(js/app.js 在 initializePlayerEvents 之后)。
 * @returns {() => void} 解绑函数
 */
export function startVoiceStreamRefresh(player, io = {}) {
    if (!player || !Array.isArray(player.audioElements)) return () => {};
    if (started) return () => {};
    started = true;
    const listeners = [];
    for (const element of player.audioElements) {
        const handler = () => onTimeUpdate(player, element, io);
        element.addEventListener('timeupdate', handler);
        listeners.push(() => element.removeEventListener('timeupdate', handler));
    }
    return () => {
        listeners.forEach((off) => off());
        started = false;
    };
}

export function resetVoiceStreamRefreshStateForTests() {
    inflight.clear();
    done.clear();
    started = false;
}
