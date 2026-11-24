// Minimal Node supervisor for the storage host sidecar.
//
// The Tauri shell (or any desktop shell) needs a stable way to start the Node
// storage host, discover its loopback URL, wait for health, and stop it without
// leaving a lock behind. This module is deliberately process/HTTP only: it does
// not start Docker, does not install anything, and does not touch user data.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_START_SCRIPT = join(HERE, '..', 'host-server-start.mjs');

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    return new Promise((resolveExit) => {
        const timer = setTimeout(() => resolveExit({ code: child.exitCode, signal: child.signalCode, timeout: true }), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolveExit({ code, signal });
        });
    });
}

async function waitForHealth(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${url}/health`);
            if (response.ok) return await response.json();
            lastError = new Error(`health returned ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`storage sidecar health timed out: ${lastError?.message || 'unknown'}`);
}

/**
 * Start host-server-start.mjs as a child process and resolve once it reports its
 * loopback URL and answers /health.
 *
 * dataRoot may be outside .cache/storage-lab because host-server-start is the
 * explicit production entrypoint; sourceRoot is authorized read-only.
 */
export async function startHostSidecar(options = {}) {
    if (!options.dataRoot) throw new Error('dataRoot is required');
    const dataRoot = resolve(String(options.dataRoot));
    const sourceRoot = options.sourceRoot ? resolve(String(options.sourceRoot)) : null;
    // `binary` runs a native host (the Rust `monochrome-storage-host`) with the
    // same environment and stdout contract instead of the Node start script.
    const binary = options.binary ? resolve(String(options.binary)) : null;
    const startScript = options.startScript ? resolve(String(options.startScript)) : DEFAULT_START_SCRIPT;
    if (binary && !existsSync(binary)) throw new Error(`host binary not found: ${binary}`);
    if (!binary && !existsSync(startScript)) throw new Error(`host start script not found: ${startScript}`);
    if (sourceRoot && !existsSync(sourceRoot)) throw new Error(`sourceRoot not found: ${sourceRoot}`);

    const env = {
        ...process.env,
        MONOCHROME_DATA: dataRoot,
        MONOCHROME_BIND: String(options.host || '127.0.0.1'),
        MONOCHROME_PORT: String(options.port ?? 0),
    };
    if (sourceRoot) env.MONOCHROME_SOURCE = sourceRoot;
    else delete env.MONOCHROME_SOURCE;
    if (options.token) env.MONOCHROME_TOKEN = String(options.token);
    else delete env.MONOCHROME_TOKEN;
    if (options.mediaTtlMs) env.MONOCHROME_MEDIA_TTL_MS = String(options.mediaTtlMs);
    else delete env.MONOCHROME_MEDIA_TTL_MS;

    const child = spawn(binary || process.execPath, binary ? [] : [startScript], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const state = { stderr: '', stdoutLines: [], exit: null, child };
    child.stderr?.on('data', (chunk) => {
        state.stderr += chunk.toString();
    });
    child.once('exit', (code, signal) => {
        state.exit = { code, signal };
    });

    const startup = await new Promise((resolveStartup, rejectStartup) => {
        const timer = setTimeout(() => rejectStartup(new Error(`storage sidecar startup timed out; stderr=${state.stderr.slice(0, 500)}`)), Number(options.timeoutMs || 15000));
        const lines = createInterface({ input: child.stdout });
        const onLine = (line) => {
            if (!line.trim()) return;
            let parsed;
            try {
                parsed = JSON.parse(line);
            } catch {
                return;
            }
            state.stdoutLines.push(parsed);
            if (!parsed.ok) {
                clearTimeout(timer);
                lines.close();
                rejectStartup(new Error(`storage sidecar failed: ${parsed.error?.message || 'unknown'}`));
                return;
            }
            if (parsed.url && parsed.service === 'monochrome-storage-lab') {
                clearTimeout(timer);
                lines.close();
                resolveStartup(parsed);
            }
        };
        lines.on('line', onLine);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            rejectStartup(new Error(`storage sidecar exited before startup (code=${code}, signal=${signal}); stderr=${state.stderr.slice(0, 500)}`));
        });
    });

    const health = await waitForHealth(startup.url, Number(options.timeoutMs || 15000));
    let stopped = false;
    return {
        url: startup.url,
        healthUrl: startup.healthUrl || `${startup.url}/health`,
        libraryId: startup.libraryId,
        pid: child.pid,
        child,
        startup,
        health,
        stderr: () => state.stderr,
        async stop() {
            if (stopped) return { code: child.exitCode, signal: child.signalCode, alreadyStopped: true };
            stopped = true;
            try {
                child.kill('SIGTERM');
            } catch {
                /* already dead */
            }
            const exit = await waitForExit(child, Number(options.stopTimeoutMs || 10000));
            return exit;
        },
    };
}
