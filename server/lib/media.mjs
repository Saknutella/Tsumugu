// E10: loopback-only media server. It resolves stable/internal entry IDs through
// SQLite to an asset_ref and serves only the referenced CAS file. MIME and byte
// ranges come from stored metadata/files; there is no directory path parameter.
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';

function isInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const MEDIA_CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
};

function sendJson(res, status, body, headers = {}) {
    const payload = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
        'Cache-Control': 'no-store',
        ...MEDIA_CORS_HEADERS,
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function errorBody(code, message) {
    return { error: { code, message } };
}

function decodeEntryId(pathname) {
    if (!pathname.startsWith('/media/')) return null;
    const raw = pathname.slice('/media/'.length);
    if (!raw || raw.includes('/')) return null;
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }
    if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
    return decoded;
}

async function resolveEntry(library, entryId) {
    // The API accepts both the globally unique internal entry_id and the stable
    // per-work entryId. If a stable ID is ambiguous across works, do not guess.
    const internal = library.db.prepare('SELECT * FROM entry WHERE entry_id = ?').get(entryId);
    if (internal) return internal;
    const rows = library.db.prepare('SELECT * FROM entry WHERE stable_entry_id = ? LIMIT 2').all(entryId);
    if (rows.length === 1) return rows[0];
    return null;
}

async function resolveAsset(library, entryId) {
    const entry = await resolveEntry(library, entryId);
    if (!entry) return null;
    const ref = library.db
        .prepare(
            `SELECT r.role, a.* FROM asset_ref r
             JOIN asset a ON a.asset_id = r.asset_id
             WHERE r.entry_id = ?
             ORDER BY CASE WHEN r.role = 'primary' THEN 0 ELSE 1 END, r.asset_ref_id
             LIMIT 1`
        )
        .get(entry.entry_id);
    const sourceOnly = Boolean(entry.original_path) && (!ref || String(ref.rel_path || '').startsWith('source/'));
    if (!ref && !sourceOnly) return null;
    const dataRoot = join(library.root, 'data');
    const file = sourceOnly
        ? resolve(entry.original_path)
        : join(dataRoot, ...String(ref.rel_path).replaceAll(String.fromCharCode(92), '/').split('/'));
    if (!sourceOnly && !isInside(dataRoot, file)) return null;
    try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) return null;
        return {
            entry,
            asset: ref || { sha256: null, mime: entry.mime },
            path: file,
            size: Number(info.size),
            mime: ref?.mime || entry.mime || 'application/octet-stream',
        };
    } catch {
        return null;
    }
}

function parseRange(value, size) {
    if (value === undefined) return { type: 'full' };
    const text = String(value).trim();
    if (!text.toLowerCase().startsWith('bytes=')) return { type: 'invalid' };
    const spec = text.slice(6).trim();
    if (!spec || spec.includes(',')) return { type: 'invalid' };
    const match = spec.match(/^(\d*)-(\d*)$/);
    if (!match) return { type: 'invalid' };
    const [, startText, endText] = match;
    if (!startText && !endText) return { type: 'invalid' };
    if (!startText) {
        const suffix = Number(endText);
        if (!Number.isInteger(suffix) || suffix <= 0) return { type: 'invalid' };
        const start = Math.max(0, size - suffix);
        return { type: 'partial', start, end: size - 1 };
    }
    const start = Number(startText);
    const end = endText ? Number(endText) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return { type: 'invalid' };
    if (start >= size) return { type: 'unsatisfiable' };
    return { type: 'partial', start, end: Math.min(end, size - 1) };
}

async function handle(library, req, res) {
    const method = String(req.method || '').toUpperCase();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', 'only GET and HEAD are supported'), {
            Allow: 'GET, HEAD',
            'Accept-Ranges': 'bytes',
        });
        return;
    }
    const entryId = decodeEntryId(url.pathname);
    if (!entryId) {
        sendJson(res, 404, errorBody('ENTRY_NOT_FOUND', 'entry not found'), { 'Accept-Ranges': 'bytes' });
        return;
    }
    const resolved = await resolveAsset(library, entryId);
    if (!resolved) {
        sendJson(res, 404, errorBody('ENTRY_NOT_FOUND', 'entry or asset not found'), { 'Accept-Ranges': 'bytes' });
        return;
    }
    const range = parseRange(req.headers.range, resolved.size);
    const headers = {
        ...MEDIA_CORS_HEADERS,
        'Content-Type': resolved.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        ...(resolved.asset.sha256 ? { ETag: `"${resolved.asset.sha256}"` } : {}),
    };
    if (range.type === 'unsatisfiable' || range.type === 'invalid') {
        sendJson(res, 416, errorBody(range.type === 'invalid' ? 'INVALID_RANGE' : 'RANGE_NOT_SATISFIABLE', 'range not satisfiable'), {
            ...headers,
            'Content-Range': `bytes */${resolved.size}`,
        });
        return;
    }
    if (range.type === 'partial') {
        const length = range.end - range.start + 1;
        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${range.start}-${range.end}/${resolved.size}`,
            'Content-Length': String(length),
        });
        if (method === 'HEAD') {
            res.end();
            return;
        }
        const stream = createReadStream(resolved.path, { start: range.start, end: range.end });
        stream.on('error', () => {
            if (!res.headersSent) sendJson(res, 500, errorBody('READ_ERROR', 'asset read failed'));
            else res.destroy();
        });
        stream.pipe(res);
        return;
    }
    res.writeHead(200, {
        ...headers,
        'Content-Length': String(resolved.size),
    });
    if (method === 'HEAD') {
        res.end();
        return;
    }
    const stream = createReadStream(resolved.path);
    stream.on('error', () => {
        if (!res.headersSent) sendJson(res, 500, errorBody('READ_ERROR', 'asset read failed'));
        else res.destroy();
    });
    stream.pipe(res);
}

/** Reuse the media handler from the combined host server (same URL/origin). */
export async function handleMediaRequest(library, req, res) {
    return handle(library, req, res);
}

/**
 * Create a loopback media server bound to the library's real SQLite/CAS.
 * Returns {url, host, port, server, close}; close is idempotent and destroys
 * lingering sockets so tests do not hang.
 */
export async function createMediaServer(library, options = {}) {
    if (!library || !library.db) throw new Error('a storage-lab Library instance is required');
    const host = String(options.host || '127.0.0.1');
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer 0..65535');
    const server = createServer((req, res) => {
        handle(library, req, res).catch(() => {
            if (!res.headersSent) sendJson(res, 500, errorBody('INTERNAL_ERROR', 'media request failed'));
            else res.destroy();
        });
    });
    await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
            server.off('error', rejectListen);
            resolveListen();
        });
    });
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    let closed = false;
    return {
        url: `http://${host}:${boundPort}`,
        host,
        port: boundPort,
        server,
        async close() {
            if (closed) return;
            closed = true;
            await new Promise((resolveClose) => {
                server.close(() => resolveClose());
                server.closeAllConnections?.();
            });
        },
    };
}
