// Atomic file primitives and the exclusive root lock.
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export async function ensureDir(path) {
    await mkdir(path, { recursive: true });
    return path;
}

export async function fsyncFile(path) {
    const handle = await open(path, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function tempName(target) {
    const suffix = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    return join(dirname(target), `.${randomBytes(6).toString('hex')}.${suffix}.tmp`);
}

/**
 * Write text/JSON to a same-directory temp file, flush, then rename over target.
 * On Windows Node rename uses MoveFileEx REPLACE; same-volume is required.
 */
export async function atomicWrite(target, data) {
    await mkdir(dirname(target), { recursive: true });
    const temp = tempName(target);
    try {
        await writeFile(temp, data, { mode: 0o600 });
        await fsyncFile(temp);
        await rename(temp, target);
    } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

export async function atomicWriteJson(target, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await atomicWrite(target, text);
}

export async function readJson(path, fallback = null) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch {
        return fallback;
    }
}

export async function pathExists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Root lock. A lock file contains {pid, createdAt, host}; a second live process
 * must fail. A stale lock whose pid is gone may be reclaimed once.
 */
const LOCK_WAIT_MS = 500;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

function lockFailure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function readLockPayload(lockPath) {
    let raw;
    try {
        raw = await readFile(lockPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return { raw: null, payload: null, missing: true };
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Number.isInteger(Number(parsed.pid)) || !parsed.random) {
            return { raw, payload: null, invalid: true };
        }
        return { raw, payload: parsed };
    } catch {
        // Empty/partial files are the initialization window, not a stale lock.
        return { raw, payload: null, invalid: true };
    }
}

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function lockPayload() {
    return {
        pid: process.pid,
        ppid: process.ppid,
        host: process.env.COMPUTERNAME || process.env.HOSTNAME || '',
        createdAt: new Date().toISOString(),
        random: randomBytes(16).toString('hex'),
    };
}

function namedPipePath(root) {
    // Windows named pipes are an OS-exclusive lease: the first listener owns the
    // pipe, every other listener gets EADDRINUSE. The path is derived from the
    // normalized library root so unrelated libraries never contend.
    const normalized = resolve(root).replaceAll('\\', '/').toLowerCase();
    const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
    return String.fromCharCode(92, 92, 46, 92) + 'pipe' + String.fromCharCode(92) + `monochrome-storage-${digest}`;
}

function closeLease(server) {
    return new Promise((resolveClose) => {
        if (!server) return resolveClose();
        try {
            server.close(() => resolveClose());
        } catch {
            resolveClose();
        }
    });
}

async function acquireWindowsLease(root, options = {}) {
    const lockPath = join(root, '.lock');
    const pipePath = namedPipePath(root);
    const lease = await new Promise((resolveLease, rejectLease) => {
        const server = net.createServer((socket) => socket.destroy());
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                try {
                    server.close();
                } catch {
                    /* not listening */
                }
                resolveLease({ busy: true });
                return;
            }
            rejectLease(error);
        });
        server.listen(pipePath, () => resolveLease({ server }));
    });
    if (lease.busy) {
        // The lease owner may still be initializing its .lock metadata. Never
        // reclaim that path: the OS says another owner is active.
        const observed = await readLockPayload(lockPath);
        if (observed.invalid || observed.missing) {
            throw lockFailure('ELOCKED', 'root lock is held by an initializing process');
        }
        const pid = Number(observed.payload.pid);
        throw lockFailure('ELOCKED', `root is locked by pid ${pid}`);
    }

    const server = lease.server;
    const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : LOCK_WAIT_MS;
    const payload = lockPayload();
    const deadline = Date.now() + waitMs;
    try {
        for (;;) {
            const observed = await readLockPayload(lockPath);
            if (observed.missing) {
                await atomicWriteJson(lockPath, payload);
                break;
            }
            if (observed.invalid) {
                if (Date.now() >= deadline) throw lockFailure('ELOCKINIT', 'root lock is empty or not initialized');
                await sleep(LOCK_RETRY_MS);
                continue;
            }
            const pid = Number(observed.payload.pid);
            if (processAlive(pid)) {
                throw lockFailure('ELOCKED', `root is locked by pid ${pid}`);
            }
            // We still hold the exclusive OS lease, so a dead PID in .lock cannot
            // be a live lease owner: the OS already released that listener. Replace
            // immediately instead of waiting for a timer. Force-kill recovery is
            // therefore bounded by OS lease release, not by the 30s stale window.
            await atomicWriteJson(lockPath, payload);
            break;
        }
    } catch (error) {
        await closeLease(server);
        throw error;
    }
    return {
        path: lockPath,
        token: payload.random,
        lease: pipePath,
        async release() {
            // Delete metadata while the OS lease is still held, so a competing
            // acquirer cannot create a new owner between token check and rm.
            let current = null;
            try {
                current = JSON.parse(await readFile(lockPath, 'utf8'));
            } catch {
                current = null;
            }
            if (current && current.random === payload.random && Number(current.pid) === process.pid) {
                await rm(lockPath, { force: true }).catch(() => {});
            }
            await closeLease(server);
        },
    };
}

function acquireFallback(root, options = {}) {
    // Non-Windows fallback keeps the previous file protocol. It is documented as
    // best-effort: only Windows gets the OS-exclusive named-pipe lease here.
    return acquireLockFileFallback(root, options);
}

async function acquireLockFileFallback(root, options = {}) {
    const lockPath = join(root, '.lock');
    const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : LOCK_WAIT_MS;
    const staleMs = Number.isFinite(Number(options.staleMs)) ? Math.max(0, Number(options.staleMs)) : LOCK_STALE_MS;
    const payload = lockPayload();
    const payloadText = JSON.stringify(payload);
    const tryCreate = async () => {
        let handle;
        try {
            handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        } catch (error) {
            if (error.code === 'EEXIST') return null;
            throw error;
        }
        try {
            await handle.writeFile(payloadText, 'utf8');
            await handle.sync();
            return handle;
        } catch (error) {
            await handle.close().catch(() => {});
            await rm(lockPath, { force: true }).catch(() => {});
            throw error;
        }
    };
    const makeLock = (handle) => ({
        path: lockPath,
        token: payload.random,
        async release() {
            let current = null;
            try {
                current = JSON.parse(await readFile(lockPath, 'utf8'));
            } catch {
                current = null;
            }
            await handle.close().catch(() => {});
            if (current && current.random === payload.random && Number(current.pid) === process.pid) {
                await rm(lockPath, { force: true }).catch(() => {});
            }
        },
    });
    const deadline = Date.now() + waitMs;
    let lastCode = 'ELOCKINIT';
    let lastMessage = 'root lock is initializing';
    for (;;) {
        const handle = await tryCreate();
        if (handle) return makeLock(handle);
        const observed = await readLockPayload(lockPath);
        if (observed.missing) continue;
        if (observed.invalid) {
            lastCode = 'ELOCKINIT';
            lastMessage = 'root lock is empty or not initialized';
        } else {
            const pid = Number(observed.payload.pid);
            if (processAlive(pid)) throw lockFailure('ELOCKED', `root is locked by pid ${pid}`);
            const createdAt = Date.parse(observed.payload.createdAt || '');
            const age = Number.isFinite(createdAt) ? Date.now() - createdAt : -1;
            if (Number(observed.payload.ppid) === process.pid || age >= staleMs) {
                const current = await readLockPayload(lockPath);
                if (current.missing) continue;
                if (current.invalid || current.raw !== observed.raw) continue;
                await rm(lockPath, { force: true }).catch(() => {});
                continue;
            }
            lastCode = 'ELOCKED';
            lastMessage = `root lock owner pid ${pid} is not alive but lock is not old enough to reclaim`;
        }
        if (Date.now() >= deadline) throw lockFailure(lastCode, lastMessage);
        await sleep(LOCK_RETRY_MS);
    }
}

/**
 * Exclusive root lock. On Windows the OS named-pipe lease is the source of truth;
 * the .lock file is metadata for diagnostics/compatibility. Both stale reclaim
 * and owner replacement happen only while holding that lease, eliminating the
 * check-delete-create race. Other platforms use the legacy bounded file fallback.
 */
export async function acquireLock(root, options = {}) {
    await mkdir(root, { recursive: true });
    if (process.platform === 'win32') return acquireWindowsLease(root, options);
    return acquireFallback(root, options);
}

export async function removeWithRetry(path, attempts = 4) {
    let lastError = null;
    for (let index = 0; index < attempts; index += 1) {
        try {
            await rm(path, { recursive: true, force: true });
            return;
        } catch (error) {
            lastError = error;
            await sleep(80 * (index + 1));
        }
    }
    throw lastError;
}
