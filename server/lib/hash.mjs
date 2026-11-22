// Streaming SHA-256 helpers. The CAS key is always the hash of the actual bytes.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export function sha256Text(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

export function abortError(message = 'operation cancelled') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'EABORTED';
    error.cancelled = true;
    return error;
}

export function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

export async function hashFile(path) {
    // Use direct async iteration, not stream.pipeline with only transforms: on
    // Node 24 a pipeline whose last stage is a transform and has no destination
    // can remain pending for multi-megabyte files, hanging verify/backup.
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    return { sha256: hash.digest('hex'), bytes };
}

function faultMatches(fault, point) {
    if (!fault) return false;
    const value = String(fault).toLowerCase();
    const target = String(point).toLowerCase();
    if (value === target) return true;
    if (target === 'f1' && ['f1-part-copy', 'part-copy', 'part', '1'].includes(value)) return true;
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

function writeChunk(writer, chunk) {
    return new Promise((resolve, reject) => {
        writer.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
}

/**
 * Copy source to a unique temp file while hashing in the same pass, then fsync.
 * The destination is not published until this resolves. An optional F1 test hook
 * stops after a half-written .part file; the callback is expected to exit the
 * worker, leaving the partial file for recovery assertions.
 */
export async function copyToTempAndHash(sourcePath, tempPath, options = {}) {
    throwIfAborted(options.signal);
    await mkdir(dirname(tempPath), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    const info = await stat(sourcePath);
    const total = Number(info.size);
    const half = Math.max(1, Math.floor(total / 2));
    const fault = faultMatches(options.fault, 'F1');
    const reader = createReadStream(sourcePath);
    const writer = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    try {
        for await (const chunk of reader) {
            throwIfAborted(options.signal);
            let data = chunk;
            if (fault && bytes + data.length >= half) {
                const remaining = Math.max(1, half - bytes);
                data = data.subarray(0, remaining);
            }
            if (data.length) {
                await writeChunk(writer, data);
                bytes += data.length;
                hash.update(data);
                if (typeof options.onProgress === 'function') {
                    options.onProgress({ phase: 'copy', bytes, total, chunkBytes: data.length, sourcePath, tempPath });
                }
            }
            throwIfAborted(options.signal);
            if (fault && bytes >= half) {
                await new Promise((resolve) => writer.write(Buffer.alloc(0), resolve));
                triggerFault(options, 'F1', { tempPath, sourcePath, bytes, total });
                // If a test callback returned instead of exiting, fail explicitly
                // rather than publishing a half file as complete.
                throw new Error('F1 fault callback returned without terminating the worker');
            }
        }
        await new Promise((resolve, reject) => writer.end((error) => (error ? reject(error) : resolve())));
        await new Promise((resolve, reject) => {
            writer.once('close', resolve);
            writer.once('error', reject);
        });
        const handle = await open(tempPath, 'r+');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        return { sha256: hash.digest('hex'), bytes, tempPath };
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    } finally {
        if (!writer.closed) writer.destroy();
    }
}

export async function fileSize(path) {
    try {
        const info = await stat(path);
        return info.isFile() ? info.size : null;
    } catch {
        return null;
    }
}
