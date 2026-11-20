import { getVoiceDownloadSettings } from './voice-settings.js';

// 音声打包下载:不生成 ZIP 中间文件,直接把文件流写入用户选择的目录。
// 浏览器只提供 File System Access API 时才启用;其他环境仍由调用方回退到 ZIP。
//
// 这里把计划生成和实际写入分开:计划是纯数据,可在 Node 中测试;
// runVoiceDownload() 只依赖一个小型目录句柄接口,便于用假文件系统验证断点续传。

// 默认 2 个文件并发、每个文件 2 个 Range 线程，均可在设置中调整。
export const VOICE_DOWNLOAD_CONCURRENCY = 2;
export const VOICE_DOWNLOAD_MAX_CONCURRENCY = 8;
export const VOICE_DOWNLOAD_THREADS_PER_FILE = 2;
export const VOICE_DOWNLOAD_RETRIES = 3;

const MAX_SEGMENT_LENGTH = 120;

function safeUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(value, globalThis.location?.origin || 'https://example.invalid/');
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

// 与 js/voice-album.js 的 coverUrl、js/voices.js 的 coverSource 同一套本地开发判定。
const LOCAL_COVER_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * 把作品封面 URL 换成下载时浏览器真正能取到的地址。
 *
 * 为什么不能直接 fetch 原始封面:开发环境页面在 localhost/127.0.0.1 上,Kikoeru 的
 * `/api/cover/` 封面来自 api.asmr.one,跨域 fetch 会被 CORS/Cloudflare 拦下并静默失败,
 * 下载目录里就没有 folder.jpg。播放器显示封面走的是 Vite 同源代理 `/__kikoeru_cover`,
 * 下载必须用同一个代理 URL 才能拿到同一张图。生产域名不做代理,保持原 URL;取不到时由
 * runVoiceDownload 记录诊断,不阻塞音频。
 *
 * `options.origin` 只用于测试(以及在非浏览器环境明确指定 origin);缺省取页面 origin,
 * 没有 origin 时原样返回,不凭空造出代理路径。
 */
export function voiceCoverDownloadUrl(value, options = {}) {
    if (!value) return '';
    try {
        const origin = options.origin || globalThis.location?.origin || '';
        // 没有 origin(Node 纯函数/测试)时只做绝对化,不猜代理。
        const cover = new URL(String(value), origin || 'https://example.invalid/');
        if (!['http:', 'https:'].includes(cover.protocol)) return '';
        if (!origin) return cover.href;
        if (!LOCAL_COVER_HOSTS.has(new URL(origin).hostname)) return cover.href;
        if (!cover.pathname.startsWith('/api/cover/')) return cover.href;
        return new URL(`/__kikoeru_cover?url=${encodeURIComponent(cover.href)}`, origin).href;
    } catch {
        return '';
    }
}

export function sanitizeVoicePathSegment(value, fallback = 'file') {
    const invalid = new Set(['<', '>', ':', '"', '/', '|', '?', '*', String.fromCharCode(92)]);
    let name = Array.from(String(value ?? ''))
        .map((character) => (character.charCodeAt(0) < 32 || invalid.has(character) ? '_' : character))
        .join('')
        .replace(/[. ]+$/g, '')
        .trim();
    if (!name || /^[.]+$/.test(name) || name.startsWith('..')) return fallback;
    // Windows 目录名/文件名上限为 255 字符;音声标题常常很长,提前截断避免下载到一半失败。
    if (name.length > MAX_SEGMENT_LENGTH) {
        const dot = name.lastIndexOf('.');
        const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
        name = name.slice(0, MAX_SEGMENT_LENGTH - extension.length) + extension;
    }
    return name;
}

export function voiceDownloadRootName(work) {
    const code = sanitizeVoicePathSegment(work?.code || work?.sourceCode || '', '');
    const circle = sanitizeVoicePathSegment(work?.trueCircle || work?.circle || '', '');
    const title = sanitizeVoicePathSegment(work?.title || '', 'voice');
    const cvs = Array.isArray(work?.artists) ? work.artists.filter(Boolean) : [];
    let name = code ? `[${code}] ` : '';
    if (circle) name += `[${circle}] `;
    name += title;
    if (cvs.length) name += ` (CV ${cvs.join(' ')})`;
    return sanitizeVoicePathSegment(name.trim(), 'voice');
}

function uniquePath(used, segments) {
    const next = [...segments];
    const filename = next.pop();
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : '';
    let candidate = [...next, filename];
    let suffix = 2;
    while (used.has(candidate.join('/'))) {
        candidate = [...next, `${stem} (${suffix})${extension}`];
        suffix += 1;
    }
    return candidate;
}

function findFolder(nodes, path) {
    let current = nodes || [];
    let found = null;
    for (const name of path || []) {
        found = current.find((node) => node.type === 'folder' && node.title === name);
        if (!found) return null;
        current = found.children || [];
    }
    return found;
}

function collectPlanFiles(nodes, path, used, output) {
    for (const node of nodes || []) {
        if (node.type === 'folder') {
            collectPlanFiles(node.children, [...path, sanitizeVoicePathSegment(node.title, 'folder')], used, output);
            continue;
        }
        const url = safeUrl(node.localMediaDownloadUrl || node.localMediaStreamUrl || node.mediaDownloadUrl || node.mediaStreamUrl);
        if (!url) continue;
        const segments = uniquePath(used, [...path, sanitizeVoicePathSegment(node.title, 'file')]);
        used.add(segments.join('/'));
        output.push({
            node,
            name: segments[segments.length - 1],
            segments,
            url,
            remoteUrl: safeUrl(node.remoteMediaDownloadUrl || node.remoteMediaStreamUrl),
            // Kikoeru nodes use size; host/download-manifest nodes use bytes.
            size: Number(node.size) || Number(node.bytes) || 0,
        });
    }
}

/**
 * 生成一次打包下载计划。folderPath 为空表示整部作品;否则只下载该目录及其子项。
 * 根目录固定为 [RJ号]-标题,目录内保留源文件树,不生成 ZIP。
 *
 * `options.origin` 透传给 voiceCoverDownloadUrl,只影响开发环境的封面代理判定。
 */
async function resolveDownloadUrl(file) {
    if (!file.fileStorage || typeof globalThis.__monochromeFileStorage?.resolveTrackUrl !== 'function') return file.url;
    const fresh = await globalThis.__monochromeFileStorage
        .resolveTrackUrl(file.voiceWorkId, file.voiceHash)
        .catch(() => null);
    return fresh || file.remoteUrl || file.url;
}

export function createVoiceDownloadPlan(work, folderPath = [], options = {}) {
    const folder = folderPath.length ? findFolder(work?.tracks, folderPath) : null;
    if (folderPath.length && !folder) return { rootName: voiceDownloadRootName(work), files: [], totalSize: 0 };
    const path = folder ? [sanitizeVoicePathSegment(folder.title, 'folder')] : [];
    const files = [];
    collectPlanFiles(folder ? folder.children : work?.tracks, path, new Set(), files);
    for (const file of files) {
        const hostWorkId = file.node?.hostWorkId;
        const hostEntryId = file.node?.hostEntryId;
        file.fileStorage = Boolean(hostEntryId) || Boolean(work?.fileStorage);
        file.voiceWorkId = hostEntryId ? hostWorkId : work?.id;
        file.voiceHash = hostEntryId || file.node?.hash;
    }
    if (work?.fileStorage) {
        for (const file of files) {
            file.fileStorage = true;
            if (!file.node?.hostEntryId) {
                file.voiceWorkId = work.id;
                file.voiceHash = file.node?.hash;
            }
        }
    }
    const cover = voiceCoverDownloadUrl(work?.thumbnail || work?.cover, options);
    return {
        rootName: voiceDownloadRootName(work),
        folderPath: folder ? [...folderPath] : [],
        files,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        cover: cover ? { url: cover, name: 'folder.jpg', fileStorage: Boolean(work?.fileStorage), voiceWorkId: work?.id } : null,
    };
}

/**
 * 明确勾选的节点按源文件树顺序下载。先生成完整计划再筛选,保证勾选变化不会改变重名编号。
 * 使用节点对象身份而非 hash/文件名,避免不同目录或不同格式的勾选被合并。
 */
export function createVoiceSelectedDownloadPlan(work, selectedNodes = [], options = {}) {
    const selected = new Set(selectedNodes || []);
    const plan = createVoiceDownloadPlan(work, [], options);
    const files = plan.files.filter((file) => selected.has(file.node));
    return {
        ...plan,
        files,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
    };
}

function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
    if (!match) return null;
    return {
        start: Number(match[1]),
        end: Number(match[2]),
        total: match[3] === '*' ? 0 : Number(match[3]),
    };
}

function responseTotal(response, offset) {
    const range = parseContentRange(response.headers?.get?.('content-range'));
    if (range?.total) return range.total;
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > 0) return offset + length;
    return 0;
}

async function writeChunk(writable, position, data) {
    await writable.write({ type: 'write', position, data });
}

async function readBody(response, onChunk) {
    if (!response.body?.getReader) {
        const data = new Uint8Array(await response.arrayBuffer());
        await onChunk(data);
        return;
    }
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value?.byteLength) await onChunk(value);
        }
    } finally {
        reader.releaseLock?.();
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/**
 * 把计划写入目录。rootHandle 是用户选中的父目录;内部创建 plan.rootName。
 * 每个文件独立 Range 续传,多个文件通过 worker 并发;单个文件失败不阻塞其他文件。
 */
export async function runVoiceDownload(plan, options) {
    const {
        parentHandle,
        fetchImpl = globalThis.fetch,
        concurrency = getVoiceDownloadSettings().fileConcurrency,
        threadsPerFile = getVoiceDownloadSettings().threadsPerFile,
        segmented = false,
        retries = VOICE_DOWNLOAD_RETRIES,
        retryDelayMs = 600,
        signal,
        onEvent = () => {},
    } = options || {};
    if (!parentHandle) throw new Error('A destination directory is required');
    if (!plan?.files?.length) return { completed: 0, failed: 0, canceled: false };

    const rootHandle = await parentHandle.getDirectoryHandle(plan.rootName, { create: true });
    const directoryCache = new Map([['', Promise.resolve(rootHandle)]]);
    const getDirectory = (segments) => {
        const key = segments.join('/');
        if (!directoryCache.has(key)) {
            directoryCache.set(
                key,
                (async () => {
                    let handle = rootHandle;
                    for (const segment of segments) {
                        handle = await handle.getDirectoryHandle(segment, { create: true });
                    }
                    return handle;
                })(),
            );
        }
        return directoryCache.get(key);
    };

    // Windows Explorer uses folder.jpg as the folder thumbnail. Thumbnail URLs are
    // deliberately preferred over the full cover; the same small image is written once per folder.
    const folderPaths = new Map([['', []]]);
    for (const file of plan.files) {
        for (let index = 1; index < file.segments.length; index += 1) {
            const segments = file.segments.slice(0, index);
            folderPaths.set(segments.join('/'), segments);
        }
    }
    let coverBlob = null;
    let coverName = plan.cover?.name || 'folder.jpg';
    // 封面是附带产物:失败不能拖垮音频,但必须能诊断(为什么下载目录里没有 folder.jpg)。
    const coverSummary = { folders: folderPaths.size, written: 0, error: null };
    if (plan.cover?.url) {
        try {
            // referrerPolicy/credentials 与播放器里的封面 <img> 一致:减少源站按 Referer
            // 或凭据拒绝开发机请求的概率。
            const freshCover = plan.cover.fileStorage && typeof globalThis.__monochromeFileStorage?.resolveCoverUrl === 'function'
                ? await globalThis.__monochromeFileStorage.resolveCoverUrl(plan.cover.voiceWorkId).catch(() => null)
                : null;
            const response = await fetchImpl(freshCover || plan.cover.url, {
                signal,
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
            });
            if (response.ok) {
                const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
                if (type.includes('text/html') || type.startsWith('text/')) {
                    // Cloudflare/源站失败页也可能返回 200;写进 folder.jpg 只会让 Explorer
                    // 显示破图,必须当作失败记录。
                    coverSummary.error = `cover is ${type || 'text/plain'}`;
                } else {
                    const blob = await response.blob();
                    if (blob.size > 0 && blob.size <= 2 * 1024 * 1024) coverBlob = blob;
                    else coverSummary.error = `cover size ${blob.size} bytes out of range`;
                }
            } else {
                coverSummary.error = `cover HTTP ${response.status}`;
            }
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) throw error;
            // A missing thumbnail must never make the actual audio download fail.
            coverSummary.error = error?.message || String(error);
        }
        if (coverSummary.error) {
            console.warn('Voice download cover skipped:', plan.cover.url, coverSummary.error);
            onEvent({ type: 'cover', state: 'error', url: plan.cover.url, error: coverSummary.error });
        }
    }
    if (coverBlob) {
        const filesByName = new Set(plan.files.map((file) => file.segments.join('/')));
        try {
            let written = 0;
            await Promise.all(
                [...folderPaths.values()].map(async (segments) => {
                    const target = [...segments, coverName].join('/');
                    if (filesByName.has(target)) return;
                    const directory = await getDirectory(segments);
                    const handle = await directory.getFileHandle(coverName, { create: true });
                    const writable = await handle.createWritable();
                    await writable.write(coverBlob);
                    await writable.close();
                    written += 1;
                }),
            );
            coverSummary.written = written;
            onEvent({
                type: 'cover',
                state: 'done',
                url: plan.cover.url,
                folders: folderPaths.size,
                written,
            });
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) throw error;
            // Folder thumbnails are cosmetic; a failed cover must not block the files themselves.
            coverSummary.error = error?.message || String(error);
            console.warn('Voice download cover write failed:', plan.cover.url, coverSummary.error);
            onEvent({ type: 'cover', state: 'error', url: plan.cover.url, error: coverSummary.error });
        }
    }

    const result = { completed: 0, failed: 0, canceled: false, completedFiles: [] };
    const total = plan.files.length;
    let cursors = 0;
    let finished = 0;
    onEvent({ type: 'job', state: 'started', total, completed: 0, failed: 0 });

    const emitFile = (file, index, patch) => {
        onEvent({ type: 'file', file, index, ...patch });
    };

    async function downloadSegmented(file, index, writable, sourceUrl) {
        if (threadsPerFile <= 1 || signal?.aborted) return false;
        let probe;
        try {
            probe = await fetchImpl(sourceUrl, { headers: { Range: 'bytes=0-0' }, signal });
        } catch {
            return false;
        }
        const range = parseContentRange(probe.headers?.get?.('content-range'));
        probe.body?.cancel?.().catch?.(() => {});
        if (!range?.total || probe.status !== 206) return false;
        const totalBytes = range.total;
        const threads = Math.max(1, Math.min(threadsPerFile, 8));
        const segmentSize = Math.ceil(totalBytes / threads);
        let loaded = 0;
        let writeQueue = Promise.resolve();
        const write = (position, data) => {
            writeQueue = writeQueue.then(() => writeChunk(writable, position, data));
            return writeQueue;
        };
        const runSegment = async (start, end) => {
            let attempt = 0;
            for (;;) {
                if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                attempt += 1;
                try {
                    const response = await fetchImpl(sourceUrl, {
                        headers: { Range: `bytes=${start}-${end}` },
                        signal,
                    });
                    if (response.status !== 206) throw new Error('Range download is not supported');
                    let position = start;
                    await readBody(response, async (chunk) => {
                        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                        const target = position;
                        position += chunk.byteLength;
                        await write(target, chunk);
                        loaded += chunk.byteLength;
                        emitFile(file, index, { state: 'downloading', loaded, total: totalBytes, attempt });
                    });
                    if (position !== end + 1) throw new Error('Incomplete range response');
                    return;
                } catch (error) {
                    if (signal?.aborted || isAbortError(error)) throw error;
                    if (attempt > retries) throw error;
                    await sleep(retryDelayMs * attempt);
                }
            }
        };
        const segments = [];
        for (let start = 0; start < totalBytes; start += segmentSize) {
            segments.push(runSegment(start, Math.min(totalBytes - 1, start + segmentSize - 1)));
        }
        emitFile(file, index, { state: 'downloading', loaded: 0, total: totalBytes, attempt: 1 });
        await Promise.all(segments);
        await writeQueue;
        await writable.close();
        result.completed += 1;
        result.completedFiles.push(file);
        emitFile(file, index, { state: 'done', loaded: totalBytes, total: totalBytes });
        return true;
    }

    async function downloadFile(file, index) {
        let handle;
        let writable;
        let offset = 0;
        let totalBytes = file.size || 0;
        let attempt = 0;
        try {
            const directory = await getDirectory(file.segments.slice(0, -1));
            handle = await directory.getFileHandle(file.name, { create: true });
            const existing = typeof handle.getFile === 'function' ? await handle.getFile() : null;
            const existingSize = Number(existing?.size) || 0;
            offset = existingSize;
            writable = await handle.createWritable({ keepExistingData: offset > 0 });
            emitFile(file, index, { state: offset > 0 ? 'resuming' : 'queued', loaded: offset, total: totalBytes });
            if (segmented && offset === 0 && threadsPerFile > 1) {
                try {
                    const done = await downloadSegmented(file, index, writable, await resolveDownloadUrl(file));
                    if (done) {
                        writable = null;
                        return;
                    }
                } catch (error) {
                    if (signal?.aborted || isAbortError(error)) throw error;
                    await writable.truncate(0).catch(() => {});
                    offset = 0;
                }
            }

            for (;;) {
                if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                attempt += 1;
                try {
                    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
                    const sourceUrl = await resolveDownloadUrl(file);
                    const response = await fetchImpl(sourceUrl, { headers, signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const partial = response.status === 206;
                    if (offset > 0 && !partial) {
                        // 服务端忽略 Range:只能清空重下,不能把完整响应当成续传追加。
                        await writable.truncate(0);
                        offset = 0;
                    }
                    totalBytes = responseTotal(response, offset) || totalBytes;
                    emitFile(file, index, {
                        state: offset > 0 ? 'resuming' : 'downloading',
                        loaded: offset,
                        total: totalBytes,
                        attempt,
                    });
                    await readBody(response, async (chunk) => {
                        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                        await writeChunk(writable, offset, chunk);
                        offset += chunk.byteLength;
                        emitFile(file, index, {
                            state: 'downloading',
                            loaded: offset,
                            total: totalBytes,
                            attempt,
                        });
                    });
                    if (totalBytes > 0 && offset < totalBytes) {
                        throw new Error(`Incomplete response: ${offset}/${totalBytes}`);
                    }
                    await writable.close();
                    writable = null;
                    result.completed += 1;
                    result.completedFiles.push(file);
                    emitFile(file, index, { state: 'done', loaded: offset, total: totalBytes || offset });
                    return;
                } catch (error) {
                    if (signal?.aborted || isAbortError(error)) throw error;
                    if (attempt > retries) {
                        result.failed += 1;
                        emitFile(file, index, {
                            state: 'error',
                            loaded: offset,
                            total: totalBytes,
                            error: error?.message || String(error),
                        });
                        if (writable) {
                            await writable.close().catch(() => {});
                            writable = null;
                        }
                        return;
                    }
                    emitFile(file, index, {
                        state: 'retrying',
                        loaded: offset,
                        total: totalBytes,
                        attempt,
                        error: error?.message || String(error),
                    });
                    await sleep(retryDelayMs * attempt);
                }
            }
        } catch (error) {
            if (writable) await writable.abort?.().catch(() => {});
            if (signal?.aborted || isAbortError(error)) {
                result.canceled = true;
                emitFile(file, index, { state: 'canceled', loaded: offset, total: totalBytes });
                return;
            }
            result.failed += 1;
            emitFile(file, index, { state: 'error', loaded: offset, total: totalBytes, error: error?.message || String(error) });
        } finally {
            finished += 1;
            onEvent({
                type: 'job',
                state: result.canceled ? 'canceled' : 'progress',
                total,
                completed: result.completed,
                failed: result.failed,
                finished,
            });
        }
    }

    async function worker() {
        for (;;) {
            if (signal?.aborted) return;
            const index = cursors;
            cursors += 1;
            if (index >= plan.files.length) return;
            await downloadFile(plan.files[index], index);
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.max(1, Math.min(concurrency, VOICE_DOWNLOAD_MAX_CONCURRENCY, plan.files.length)) },
            () => worker(),
        ),
    );
    onEvent({
        type: 'job',
        state: result.canceled ? 'canceled' : result.failed ? 'partial' : 'done',
        total,
        completed: result.completed,
        failed: result.failed,
        finished,
    });
    return result;
}

export { parseContentRange };
