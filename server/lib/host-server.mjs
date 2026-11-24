// S5 isolated host HTTP server + minimal static UI.
//
// This is deliberately small: it serves an explicit allow-list of static files
// and an explicit JSON API backed by the already-created S5 host adapter. It
// never serves arbitrary paths, never opens a second storage layer and never
// exposes absolute filesystem paths to the browser.
import http from 'node:http';
import { mkdir, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { handleMediaRequest } from './media.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_UI_ROOT = join(MODULE_DIR, '..', 'ui');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STATIC_FILES = new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);
const API_ROUTES = new Set(['/api/scan', '/api/import', '/api/import/status', '/api/move', '/api/import/file', '/api/import-temp/cleanup', '/api/works/open', '/api/works/normalize-root', '/api/works/delete-files', '/api/works/delete', '/api/works/metadata', '/api/voices/bundle', '/api/voices/reconcile', '/api/works/cover', '/api/upload', '/api/creations/upload', '/api/creations/import', '/api/creations/delete', '/api/creations/delete-asset', '/api/creations', '/api/cleanup/preview', '/api/cleanup', '/api/works', '/api/backup', '/api/restore', '/api/export', '/api/verify', '/api/download']);

function loopbackHost(value, allowNonLoopback = false) {
    const host = String(value || '127.0.0.1');
    if (['127.0.0.1', '::1', 'localhost'].includes(host)) return host === 'localhost' ? '127.0.0.1' : host;
    if (allowNonLoopback) return host;
    const error = new Error('host must be a loopback address');
    error.code = 'ELOOPBACK';
    throw error;
}

function isLoopbackAddress(address) {
    const value = String(address || '');
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function redactText(value, roots) {
    let text = String(value ?? '');
    const ordered = [...roots].filter(Boolean).sort((a, b) => String(b).length - String(a).length);
    for (const root of ordered) {
        text = text.split(String(root)).join('<root>');
        const slashed = String(root).replaceAll('\\', '/');
        if (slashed !== String(root)) text = text.split(slashed).join('<root>');
    }
    // Absolute Windows/POSIX filesystem tokens must never reach the browser.
    text = text.replace(/[A-Za-z]:[\\/][^\s"'<>]*/g, '<path>');
    text = text.replace(/(^|[\s("'=])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g, '$1<path>');
    return text;
}

function redactValue(value, roots) {
    if (typeof value === 'string') return redactText(value, roots);
    if (Array.isArray(value)) return value.map((item) => redactValue(item, roots));
    if (value && typeof value === 'object') {
        const clone = {};
        for (const [key, item] of Object.entries(value)) clone[key] = redactValue(item, roots);
        return clone;
    }
    return value;
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relative-Path, X-Upload-Offset, X-Creation-Post, X-Creation-Attachment, X-Creation-Role, X-Creation-Name',
    'Access-Control-Max-Age': '600',
};

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function sendError(res, status, code, message, extra = null) {
    sendJson(res, status, { ok: false, error: { code, message }, ...(extra || {}) });
}

// Read and discard a request body we are about to reject.
//
// WHY: Node resets the socket of a request whose body was never consumed, so the
// client saw `ECONNRESET` and the JSON error vanished — a rejected chunk looked
// like a dead connection instead of a retryable offset mismatch. Capped so a
// client streaming gigabytes at a rejected path cannot hold the connection.
const UPLOAD_DRAIN_LIMIT = 64 * 1024 * 1024;
async function drainRequest(req, limit = UPLOAD_DRAIN_LIMIT) {
    if (req.readableEnded || req.destroyed) return;
    let seen = 0;
    await new Promise((resolve) => {
        const done = () => {
            req.off('data', onData);
            req.off('end', done);
            req.off('error', done);
            resolve();
        };
        const onData = (chunk) => {
            seen += chunk.length;
            if (seen >= limit) {
                req.destroy();
                done();
            }
        };
        req.on('data', onData);
        req.on('end', done);
        req.on('error', done);
        req.resume();
    });
}

function errorStatus(error) {
    const code = String(error?.code || '');
    if (['ENOENT', 'ECONFLICT', 'EIDEMPOTENCYCONFLICT', 'EOUTSIDE', 'EOUTSIDEROOT', 'EPATHDENIED', 'ELOOPBACK', 'EBADREQUEST', 'EBADJSON'].includes(code)) {
        return code === 'ECONFLICT' || code === 'EIDEMPOTENCYCONFLICT' ? 409 : 400;
    }
    return 500;
}

async function readBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
            const error = new Error('request body too large');
            error.code = 'EBADREQUEST';
            throw error;
        }
        chunks.push(chunk);
    }
    if (!bytes) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const error = new Error('JSON body must be an object');
            error.code = 'EBADREQUEST';
            throw error;
        }
        return parsed;
    } catch (error) {
        if (error.code === 'EBADREQUEST') throw error;
        const invalid = new Error('invalid JSON request body');
        invalid.code = 'EBADJSON';
        throw invalid;
    }
}

function requireString(value, name) {
    if (typeof value !== 'string' || !value.trim()) {
        const error = new Error(`${name} is required`);
        error.code = 'EBADREQUEST';
        throw error;
    }
    return value;
}

/**
 * Browser folder import writes the selected files into the host's configured
 * source root before the normal scan/import path runs. This keeps one import
 * pipeline for desktop native pickers and browser uploads; only the transfer
 * mechanism differs.
 */
async function handleUpload(req, res, host, roots) {
    // Every rejection below drains the body first — see `drainRequest`.
    const reject = async (status, code, message, extra) => {
        await drainRequest(req);
        sendError(res, status, code, message, extra);
    };
    if (!host.sourceRoot) {
        await reject(400, 'EPATHDENIED', 'source is not configured on this host');
        return;
    }
    const rawHeader = String(req.headers['x-relative-path'] || '');
    let relative;
    try {
        relative = decodeURIComponent(rawHeader).replaceAll('\\', '/');
    } catch {
        await reject(400, 'EBADREQUEST', 'X-Relative-Path is not valid percent encoding');
        return;
    }
    if (!relative || relative.startsWith('/') || isAbsolute(relative) || relative.split('/').includes('..')) {
        await reject(400, 'EPATHDENIED', 'relative path is not allowed');
        return;
    }
    const sourceRoot = resolve(host.sourceRoot);
    const target = resolve(sourceRoot, relative);
    if (target !== sourceRoot && !target.startsWith(sourceRoot + sep)) {
        await reject(400, 'EPATHDENIED', 'relative path escapes the source root');
        return;
    }
    const declared = Number(req.headers['content-length'] || 0);
    const maxBytes = 8 * 1024 * 1024 * 1024;
    if (Number.isFinite(declared) && declared > maxBytes) {
        await reject(413, 'ETOOLARGE', 'upload exceeds the 8 GiB limit');
        return;
    }
    const offset = req.headers['x-upload-offset'] === undefined
        ? 0
        : Number(req.headers['x-upload-offset']);
    if (!Number.isInteger(offset) || offset < 0) {
        await reject(400, 'EBADREQUEST', 'X-Upload-Offset must be a non-negative integer');
        return;
    }
    if (offset > 0) {
        try {
            const existing = await stat(target);
            if (!existing.isFile() || existing.size !== offset) {
                // `size` lets the client resume from where the file really ends
                // instead of restarting a multi-gigabyte upload.
                await reject(409, 'ECONFLICT', 'upload offset does not match the file size', {
                    size: existing.isFile() ? existing.size : 0,
                });
                return;
            }
        } catch {
            await reject(409, 'ECONFLICT', 'upload offset has no existing file', { size: 0 });
            return;
        }
    }
    await mkdir(dirname(target), { recursive: true });
    let bytes = 0;
    try {
        await pipeline(
            req,
            async function* count(chunks) {
                for await (const chunk of chunks) {
                    bytes += chunk.length;
                    if (bytes + offset > maxBytes) {
                        const error = new Error('upload exceeds the 8 GiB limit');
                        error.code = 'ETOOLARGE';
                        throw error;
                    }
                    yield chunk;
                }
            },
            createWriteStream(target, { flags: offset > 0 ? 'a' : 'w' }),
        );
    } catch (error) {
        // Only remove a freshly-started file; a failed later chunk must keep the
        // prefix so a retry can continue from the same offset.
        if (offset === 0) await unlink(target).catch(() => {});
        throw error;
    }
    sendJson(res, 200, {
        ok: true,
        result: { relativePath: relative, bytes, offset },
    });
}

function createApi(host, roots, state) {
    return async function handleApi(req, res, pathname) {
        if (pathname === '/api/works' && req.method === 'GET') {
            const works = await host.listWorks();
            sendJson(res, 200, { ok: true, result: { works } });
            return;
        }
        if (pathname === '/api/creations' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, result: { posts: host.listCreationPosts() } });
            return;
        }
        if (pathname === '/api/creations/upload') {
            if (req.method !== 'POST') {
                sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
                return;
            }
            const chunks = [];
            let bytes = 0;
            const maxBytes = 1024 * 1024 * 1024;
            try {
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > maxBytes) {
                        const error = new Error('creation upload exceeds the 1 GiB limit');
                        error.code = 'ETOOLARGE';
                        throw error;
                    }
                    chunks.push(chunk);
                }
                const postId = String(req.headers['x-creation-post'] || '');
                const attachmentId = String(req.headers['x-creation-attachment'] || '');
                const role = String(req.headers['x-creation-role'] || 'original');
                const name = decodeURIComponent(String(req.headers['x-creation-name'] || ''));
                const mime = String(req.headers['content-type'] || 'application/octet-stream');
                const uploaded = await host.saveCreationAsset({ postId, attachmentId, role, bytes: Buffer.concat(chunks), mime, name });
                sendJson(res, 200, { ok: true, result: uploaded });
            } catch (error) {
                sendError(res, errorStatus(error), error.code || 'EBADREQUEST', redactText(error.message, roots));
            }
            return;
        }
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
            return;
        }
        let body;
        try {
            body = await readBody(req);
        } catch (error) {
            sendError(res, errorStatus(error), error.code || 'EBADREQUEST', redactText(error.message, roots));
            return;
        }
        try {
            let payload;
            if (pathname === '/api/creations/import') {
                payload = host.saveCreationPost(body.post && typeof body.post === 'object' ? body.post : {});
                sendJson(res, 200, { ok: true, result: payload });
                return;
            }
            if (pathname === '/api/creations/delete') {
                const postIds = Array.isArray(body.postIds) ? body.postIds.map(String) : [];
                const deleted = [];
                for (const postId of postIds) deleted.push({ postId, deleted: await host.deleteCreationPost(postId) });
                sendJson(res, 200, { ok: true, result: { deleted } });
                return;
            }
            if (pathname === '/api/creations/delete-asset') {
                const assetId = String(body.assetId || '');
                sendJson(res, 200, { ok: true, result: { assetId, deleted: await host.deleteCreationAsset(assetId) } });
                return;
            }
            if (pathname === '/api/voices/reconcile') {
                payload = await host.reconcileWork(requireString(body.workId, 'workId'));
                sendJson(res, 200, { ok: true, result: payload });
                return;
            }
            if (pathname === '/api/voices/bundle') {
                payload = await host.saveVoiceBundle({
                    rootName: body.rootName ? String(body.rootName) : '',
                    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
                    manifest: body.manifest && typeof body.manifest === 'object' ? body.manifest : null,
                    coverUrl: body.coverUrl ? String(body.coverUrl) : '',
                });
                sendJson(res, 200, { ok: true, result: payload });
                return;
            }
            if (pathname === '/api/works/cover') {
                const workId = requireString(body.workId, 'workId');
                const url = requireString(body.url, 'url');
                payload = await host.cacheWorkCover(workId, url);
                sendJson(res, 200, { ok: true, result: payload });
                return;
            }
            if (pathname === '/api/works/metadata') {
                const workId = requireString(body.workId, 'workId');
                payload = await host.updateWorkMetadata(workId, body.metadata && typeof body.metadata === 'object' ? body.metadata : {});
                sendJson(res, 200, { ok: true, result: payload });
                return;
            }
            if (pathname === '/api/scan') {
                const requestedSource = body.source;
                if (requestedSource !== undefined) {
                    if (!host.sourceRoot) {
                        const error = new Error('source is not configured on this host');
                        error.code = 'EPATHDENIED';
                        throw error;
                    }
                    if (resolve(requireString(requestedSource, 'source')) !== resolve(host.sourceRoot)) {
                        const error = new Error('source is outside the host source root policy');
                        error.code = 'EPATHDENIED';
                        throw error;
                    }
                }
                const mode = body.mode === undefined ? 'single' : String(body.mode);
                if (!['single', 'batch'].includes(mode)) {
                    const error = new Error('mode must be single or batch');
                    error.code = 'EBADREQUEST';
                    throw error;
                }
                payload = await host.scan({ mode, relativeRoot: body.relativeRoot ? String(body.relativeRoot) : undefined });
                state.preview = payload;
            } else if (pathname === '/api/import') {
                const preview = body.preview || state.preview;
                if (!preview) {
                    const error = new Error('scan preview is required before import');
                    error.code = 'EBADREQUEST';
                    throw error;
                }
                if (!Array.isArray(body.candidateIds) || body.candidateIds.length === 0) {
                    // Import is never implicit: the UI must select candidates.
                    const error = new Error('candidateIds must be a non-empty array');
                    error.code = 'EBADREQUEST';
                    throw error;
                }
                payload = await host.importCandidates(preview, {
                    candidateIds: body.candidateIds.map(String),
                    idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
                    batchId: body.batchId ? String(body.batchId) : undefined,
                    async: body.async === true,
                });
            } else if (pathname === '/api/move') {
                const sourceRoot = host.sourceRoot;
                if (!sourceRoot) {
                    const error = new Error('source is not configured on this host');
                    error.code = 'EPATHDENIED';
                    throw error;
                }
                const from = resolve(sourceRoot, requireString(body.from, 'from'));
                const to = resolve(sourceRoot, requireString(body.to, 'to'));
                for (const target of [from, to]) {
                    if (target !== sourceRoot && !target.startsWith(sourceRoot + sep)) {
                        const error = new Error('move target is outside the source root');
                        error.code = 'EPATHDENIED';
                        throw error;
                    }
                }
                if (from === to) {
                    const error = new Error('move source and target are identical');
                    error.code = 'EBADREQUEST';
                    throw error;
                }
                await mkdir(dirname(to), { recursive: true });
                try {
                    await rename(from, to);
                } catch (error) {
                    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
                    // Windows rename does not replace an existing file; the staging
                    // file is complete, so replace the old target only at commit time.
                    await unlink(to).catch(() => {});
                    await rename(from, to);
                }
                // Staging directories live under <work>/tmp/import-*; once the
                // last part has moved out they are empty and should not linger in
                // the managed source tree.
                let stagingParent = dirname(from);
                while (stagingParent !== sourceRoot && stagingParent.startsWith(sourceRoot + sep)) {
                    if (basename(stagingParent) !== 'tmp' && !stagingParent.includes(sep + 'tmp' + sep)) break;
                    try {
                        await rmdir(stagingParent);
                    } catch {
                        break;
                    }
                    stagingParent = dirname(stagingParent);
                }
                payload = { from: body.from, to: body.to };
            } else if (pathname === '/api/import-temp/cleanup') {
                payload = await host.cleanupImportTemps(body.workRoot ? String(body.workRoot) : '');
            } else if (pathname === '/api/import/file') {
                payload = await host.importFile({
                    relativePath: requireString(body.relativePath, 'relativePath'),
                    workRoot: body.workRoot ? String(body.workRoot) : '',
                    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
                });
            } else if (pathname === '/api/works/open') {
                payload = await host.openWorkLocation(requireString(body.workId, 'workId'));
            } else if (pathname === '/api/works/normalize-root') {
                payload = await host.normalizeWorkRoot(
                    requireString(body.workId, 'workId'),
                    requireString(body.rootName, 'rootName'),
                );
            } else if (pathname === '/api/works/delete-files') {
                payload = await host.deleteWorkFiles(
                    requireString(body.workId, 'workId'),
                    Array.isArray(body.paths) ? body.paths.map(String) : [],
                );
            } else if (pathname === '/api/works/delete') {
                payload = await host.deleteWorks(body.workIds);
            } else if (pathname === '/api/cleanup') {
                payload = host.cleanupWorks(body.workIds);
            } else if (pathname === '/api/backup') {
                payload = await host.backup(requireString(body.destination, 'destination'), {
                    includeMedia: body.includeMedia !== false,
                });
            } else if (pathname === '/api/restore') {
                payload = await host.restore(requireString(body.backup || body.backupDir, 'backup'), requireString(body.destination, 'destination'));
            } else if (pathname === '/api/export') {
                payload = await host.exportWork(requireString(body.workId, 'workId'), requireString(body.destination, 'destination'), {
                    friendlyName: body.friendlyName ? String(body.friendlyName) : 'auto',
                });
            } else if (pathname === '/api/verify') {
                payload = await host.verify();
            } else if (pathname === '/api/download') {
                if (typeof host.download !== 'function') {
                    const error = new Error('download is not available on this host');
                    error.code = 'EBADREQUEST';
                    throw error;
                }
                const expectedBytes = body.expectedBytes === undefined || body.expectedBytes === null || body.expectedBytes === ''
                    ? undefined
                    : Number(body.expectedBytes);
                if (expectedBytes !== undefined && (!Number.isInteger(expectedBytes) || expectedBytes < 0)) {
                    const error = new Error('expectedBytes must be a non-negative integer');
                    error.code = 'EBADREQUEST';
                    throw error;
                }
                payload = await host.download(requireString(body.entryId, 'entryId'), {
                    sourceUrl: requireString(body.sourceUrl, 'sourceUrl'),
                    expectedBytes,
                    sourceVersion: body.sourceVersion === undefined ? undefined : String(body.sourceVersion),
                });
            }
            const safe = redactValue(payload, roots);
            const bodyOut = { ok: true, result: safe, ...safe };
            if (pathname === '/api/scan') {
                bodyOut.preview = safe;
                bodyOut.candidates = safe.candidates || [];
                bodyOut.sourceRoot = safe.sourceRoot || '.';
            }
            sendJson(res, 200, bodyOut);
        } catch (error) {
            const status = errorStatus(error);
            sendError(res, status, error?.code || 'EINTERNAL', redactText(error?.message || error, roots));
        }
    };
}

async function sendStatic(req, res, pathname, uiRoot) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
        return;
    }
    const entry = STATIC_FILES.get(pathname);
    if (!entry) {
        sendError(res, 404, 'ENOTFOUND', 'not found');
        return;
    }
    try {
        // The allow-list means no path is ever joined from user input.
        const content = await readFile(join(uiRoot, entry.file));
        res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': entry.type,
            'Content-Length': content.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(content);
    } catch {
        sendError(res, 404, 'ENOTFOUND', 'not found');
    }
}

export async function createHostServer(host, options = {}) {
    if (!host || typeof host.scan !== 'function' || typeof host.importCandidates !== 'function') {
        throw new Error('a S5 host adapter is required');
    }
    // Drop abandoned <work>/tmp/import-* staging trees from interrupted
    // downloads. Only import-* children are touched; user tmp data is kept.
    await host.cleanupImportTemps?.().catch((error) => {
        console.warn('host import temp cleanup skipped:', error?.message || error);
    });
    const bindHost = loopbackHost(options.host || '127.0.0.1', options.allowNonLoopback === true);
    const uiRoot = resolve(options.uiRoot || DEFAULT_UI_ROOT);
    const authToken = options.token ? String(options.token) : null;
    // <audio>/<img> cannot attach Authorization. A short-lived HMAC URL is safer
    // than embedding the long-lived API bearer token in media history/logs.
    const mediaTtlMs = Number(options.mediaTtlMs || 10 * 60 * 1000);
    const mediaEntryFromUrl = (url) => {
        const raw = url.pathname.startsWith('/media/') ? url.pathname.slice('/media/'.length) : '';
        if (!raw || raw.includes('/') || raw.includes('\\')) return null;
        try {
            return decodeURIComponent(raw);
        } catch {
            return null;
        }
    };
    const mediaSignature = (entryId, expires) =>
        createHmac('sha256', authToken || '').update(`${entryId}
${expires}`).digest('hex');
    const signMediaPath = (mediaPath) => {
        if (!authToken || !mediaPath) return mediaPath;
        const url = new URL(mediaPath, 'http://127.0.0.1');
        const entryId = mediaEntryFromUrl(url);
        if (!entryId) return mediaPath;
        const expires = Date.now() + mediaTtlMs;
        return `${url.pathname}?expires=${expires}&sig=${mediaSignature(entryId, expires)}`;
    };
    const validMediaSignature = (url) => {
        if (!authToken) return false;
        const entryId = mediaEntryFromUrl(url);
        const expires = Number(url.searchParams.get('expires'));
        const signature = String(url.searchParams.get('sig') || '');
        if (!entryId || !Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + mediaTtlMs + 5000) return false;
        const expected = mediaSignature(entryId, expires);
        const actualBuffer = Buffer.from(signature, 'hex');
        const expectedBuffer = Buffer.from(expected, 'hex');
        return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
    };
    const isAuthorized = (req, url, media) => {
        if (!authToken) return true;
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const supplied = Buffer.from(header.slice(7));
            if (supplied.length === Buffer.byteLength(authToken) && timingSafeEqual(supplied, Buffer.from(authToken))) return true;
        }
        return media ? validMediaSignature(url) : false;
    };
    const roots = [host.root, host.libraryRoot, host.sourceRoot, host.library?.root].filter(Boolean).map(String);
    const state = { preview: null };
    const handleApi = createApi(host, roots, state);
    const server = http.createServer(async (req, res) => {
        try {
            if (options.allowNonLoopback !== true && !isLoopbackAddress(req.socket.remoteAddress)) {
                sendError(res, 403, 'ELOOPBACK', 'loopback clients only');
                return;
            }
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            const pathname = decodeURIComponent(url.pathname);
            if (req.method === 'OPTIONS') {
                res.writeHead(204, CORS_HEADERS);
                res.end();
                return;
            }
            if (pathname === '/health' || pathname === '/api/health') {
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    service: 'monochrome-storage-lab',
                    libraryId: host.libraryId || null,
                });
                return;
            }
            if ((pathname.startsWith('/api/') || pathname.startsWith('/media/')) && !isAuthorized(req, url, pathname.startsWith('/media/'))) {
                sendError(res, 401, 'EUNAUTHORIZED', 'missing or invalid storage token');
                return;
            }
            if (pathname === '/api/cleanup/preview') {
                if (req.method !== 'GET') {
                    sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
                    return;
                }
                const preview = await host.cleanupPreview();
                sendJson(res, 200, { ok: true, result: preview, ...preview });
                return;
            }
            if (pathname === '/api/import/status') {
                if (req.method !== 'GET') {
                    sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
                    return;
                }
                const batchId = url.searchParams.get('batchId');
                if (!batchId) {
                    sendError(res, 400, 'EBADREQUEST', 'batchId is required');
                    return;
                }
                const progress = host.getBatchProgress(batchId);
                if (!progress) {
                    sendError(res, 404, 'ENOTFOUND', 'import batch not found');
                    return;
                }
                sendJson(res, 200, { ok: true, result: progress, ...progress });
                return;
            }
            if (pathname === '/api/upload') {
                if (req.method !== 'POST') {
                    sendError(res, 405, 'EMETHODNOTALLOWED', 'method not allowed');
                    return;
                }
                await handleUpload(req, res, host, [host.root, host.sourceRoot]);
                return;
            }
            if (pathname === '/api/works' && req.method === 'GET') {
                const works = await host.listWorks();
                const signed = works.map((work) => ({
                    ...work,
                    coverMediaPath: signMediaPath(work.coverMediaPath),
                    entries: (work.entries || []).map((entry) => ({
                        ...entry,
                        mediaPath: signMediaPath(entry.mediaPath),
                    })),
                }));
                sendJson(res, 200, { ok: true, result: { works: signed } });
                return;
            }
            if (pathname.startsWith('/media/')) {
                await handleMediaRequest(host.library, req, res);
                return;
            }
            if (pathname.startsWith('/api/creations/media/') && req.method === 'GET') {
                const assetId = decodeURIComponent(pathname.slice('/api/creations/media/'.length));
                const asset = await host.readCreationAsset(assetId);
                if (!asset) {
                    sendError(res, 404, 'ENOTFOUND', 'creation asset not found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': asset.mime || 'application/octet-stream',
                    'Content-Length': String(asset.bytes),
                    'Cache-Control': 'private, max-age=300',
                });
                res.end(asset.buffer);
                return;
            }
            if (pathname.startsWith('/api/')) {
                if (!API_ROUTES.has(pathname)) {
                    sendError(res, 404, 'ENOTFOUND', 'not found');
                    return;
                }
                await handleApi(req, res, pathname);
                return;
            }
            await sendStatic(req, res, pathname, uiRoot);
        } catch (error) {
            console.error('monochrome host request failed', error?.code || '', error?.message || error);
            if (!res.headersSent) sendError(res, 500, 'EINTERNAL', 'internal error');
            else res.destroy();
        }
    });
    await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen({ host: bindHost, port: Number(options.port ?? 0), exclusive: true }, () => {
            server.off('error', rejectListen);
            resolveListen();
        });
    });
    const address = server.address();
    const urlHost = address.family === 'IPv6' || address.address.includes(':') ? `[${address.address}]` : address.address;
    return {
        url: `http://${urlHost}:${address.port}`,
        host: bindHost,
        port: address.port,
        server,
        close: () => new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
        }),
    };
}

export { redactText, redactValue, STATIC_FILES, API_ROUTES };
