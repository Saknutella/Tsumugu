#!/usr/bin/env node
// One-command dev loop for the *shared* voice layer: web UI + a local storage host.
//
// WHY THIS EXISTS
//   Packing the Tauri portable exe takes 5–10 minutes, but most of the reported
//   bugs (cover precedence, partial-work merging, delete, re-render loops) live in
//   `js/`, which Vite hot-reloads in under a second. This script removes the
//   packaging step from the loop; only genuinely Tauri-specific behaviour
//   (DLsite direct fetch, portable data root, the produced exe) still needs a build.
//
// HOW THE APP FINDS THE HOST
//   `connectWebBackend()` already probes `/storage` before anything else. The dev
//   server therefore proxies `/storage/*` to the host, and a page reload keeps
//   working — a `?storage=` query string would be dropped on the first reload,
//   which is exactly what an HMR loop does all day.
//
// WHAT RESTARTS WHAT
//   - `js/`, `styles.css`, …         → Vite HMR (nothing for this script to do)
//   - `verify/storage-lab/**`        → node host restarted automatically
//   - `server/**`              → rebuild required; not watched on purpose
//
// Ctrl+C stops the host and the dev server together.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value && !value.startsWith('--') ? value : fallback;
}
const has = (name) => process.argv.includes(name);

// A fixed host port keeps the proxy target stable across host restarts; a random
// port would invalidate the dev server's proxy config every time a host file
// changes.
const hostPort = Number(arg('--host-port', '5174'));
const appPort = Number(arg('--port', '5173'));
const dataRoot = resolve(arg('--data', join(root, 'build', 'monochrome', 'dev-web')));
const useRust = has('--rust-host');
// The one place a Rust host build is expected to land. Cargo's `<target-dir>/release/`
// layout is what the documented build command produces, so spelling it out beats
// searching: a stale binary elsewhere would be run without anyone noticing.
const rustBinary = resolve(
    arg('--rust-host-bin', join(root, 'build', 'monochrome', 'dev-host', 'release', 'monochrome-storage-host.exe')),
);
const noAuth = has('--no-token');
// A token is the production shape (media URLs are signed, `/api/*` needs a bearer).
// Removing it would hide exactly the class of bug this loop exists to reproduce.
const token = noAuth ? null : arg('--token', randomBytes(16).toString('hex'));

const storageDir = join(dataRoot, 'storage');
const libraryDir = join(dataRoot, 'library');
mkdirSync(storageDir, { recursive: true });
mkdirSync(libraryDir, { recursive: true });

// A half-installed tree is worse than no tree: `node_modules/vite/` can exist with
// only `dist/` inside, and the failure then surfaces as a bare MODULE_NOT_FOUND for
// `vite/bin/vite.js`. Check for the two files that actually matter and say what to do.
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
    const viteDir = join(root, 'node_modules', 'vite');
    const partial = existsSync(viteDir) && !existsSync(join(viteDir, 'package.json'));
    console.error(`\u001b[36m[dev-web]\u001b[0m vite is not installed: ${viteBin}`);
    console.error(
        `\u001b[36m[dev-web]\u001b[0m ${
            partial ? 'node_modules/vite exists but is incomplete (no package.json)' : 'node_modules is missing or stale'
        }`,
    );
    console.error('\u001b[36m[dev-web]\u001b[0m run: npm ci     # clean install from package-lock.json');
    process.exit(3);
}

const children = new Set();
let shuttingDown = false;
let restarting = false;
// Bounded so a host that cannot start (locked data dir, bad binary) does not spin.
const HOST_RESTART_LIMIT = 5;
let hostRestarts = 0;
// Set when the host refuses to start at all (see the `ok:false` startup line).
let hostFatal = null;

function label(text) {
    return `\u001b[36m[dev-web]\u001b[0m ${text}`;
}

function stop(child) {
    if (!child || child.killed) return;
    try {
        child.kill();
    } catch {
        /* already gone */
    }
}

function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) stop(child);
    setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => {
    console.log(`\n${label('stopping host and dev server')}`);
    shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

function startHost() {
    hostFatal = null;
    const env = {
        ...process.env,
        MONOCHROME_DATA: storageDir,
        MONOCHROME_SOURCE: libraryDir,
        MONOCHROME_BIND: '127.0.0.1',
        MONOCHROME_PORT: String(hostPort),
    };
    if (token) env.MONOCHROME_TOKEN = token;
    else delete env.MONOCHROME_TOKEN;

    // Node host 于 2026-11-25 删除，只剩 Rust 一份实现。不带 `--rust-host` 时
    // 以前会去启动 `verify/storage-lab/host-server-start.mjs`，现在那个文件不存在，
    // 结果是 `dev server 起来了、host 立刻退出`，看起来像环境坏了。直接说清楚。
    if (!useRust) {
        console.error(label('Node storage host 已删除（2026-11-25），只剩 Rust 实现'));
        console.error(label('用: npm run dev:web:rust   （或 node scripts/dev-web.mjs --rust-host）'));
        shutdown(3);
        return null;
    }

    const command = rustBinary;
    const args = [];

    if (useRust && !existsSync(rustBinary)) {
        console.error(label(`rust host binary not found: ${rustBinary}`));
        // The manifest path and target dir matter: from the project root a bare
        // `cargo build -p ...` fails with "could not find Cargo.toml".
        console.error(label('build it with:'));
        console.error(
            '    cargo build --release -p monochrome-storage-http --bin monochrome-storage-host --manifest-path server/Cargo.toml --target-dir build/monochrome/dev-host',
        );
        shutdown(1);
        return null;
    }

    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);

    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            // The startup line is the contract; everything after it is host logs we
            // keep visible because "why did my request 401" is usually in there.
            if (line.startsWith('{') && line.includes('"url"') && line.includes('"ok"')) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.ok === false) {
                        // A startup refusal is not transient: schema version mismatch,
                        // a locked data root, a bad binary. Retrying just prints the
                        // same error five times and delays the real message.
                        hostFatal = parsed.error?.message || line;
                        console.error(label(`host failed: ${hostFatal}`));
                        continue;
                    }
                    printStatus(parsed);
                    continue;
                } catch {
                    /* fall through to plain echo */
                }
            }
            console.log(`\u001b[90m[host]\u001b[0m ${line}`);
        }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`\u001b[31m[host]\u001b[0m ${chunk}`));
    child.on('exit', (code) => {
        children.delete(child);
        if (shuttingDown || restarting) return;
        if (hostFatal) {
            // Startup refused outright (schema mismatch, locked root, bad binary).
            // Restarting cannot help; say what to do instead of looping.
            console.error(label(`host refused to start: ${hostFatal}`));
            if (/schema \d+ is newer than supported/i.test(hostFatal)) {
                console.error(label('this data dir was migrated by the Rust host (schema 8); the Node host only reads schema 7'));
                console.error(label('use a separate dir for the Node host, e.g.  npm run dev:web -- --data build/monochrome/dev-web-node'));
            }
            console.error(label('not retrying; fix the error above, then restart this script'));
            return;
        }
        // A dead host leaves vite serving happily: every storage action then fails
        // with something that mentions neither the host nor the proxy (`invoke is
        // not a function` was the symptom that hid this for a whole session). Keep
        // the host alive, and say loudly when it cannot stay alive.
        hostRestarts += 1;
        if (hostRestarts > HOST_RESTART_LIMIT) {
            console.error(
                label(`host exited (code ${code}) and ${HOST_RESTART_LIMIT} restarts already failed; not retrying`),
            );
            console.error(label('fix the host error above, then restart this script'));
            return;
        }
        console.log(label(`host exited (code ${code}) → restarting (${hostRestarts}/${HOST_RESTART_LIMIT})`));
        restarting = true;
        setTimeout(() => {
            if (shuttingDown) return;
            startHost();
            restarting = false;
        }, 1500);
    });
    return child;
}

let hostUrl = `http://127.0.0.1:${hostPort}`;
let hostStarted = false;

// The panel only proves the process started. A host can accept a spawn, print its
// startup line and then be unreachable (locked data root, crashed worker), which is
// exactly the state that made a whole session run against no backend. Probe /health
// and say so.
let lastHealthSignature = null;
let healthTimer = null;

async function probeHealth() {
    try {
        const response = await fetch(`${hostUrl}/health`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
        });
        const body = await response.json().catch(() => ({}));
        return { ok: response.ok && body?.ok === true, status: response.status, id: body?.libraryId || '' };
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}

async function reportHealth() {
    const result = await probeHealth();
    const signature = JSON.stringify(result);
    // Only print on change: a healthy host every 30s would bury the useful lines.
    if (signature === lastHealthSignature) return;
    lastHealthSignature = signature;
    if (result.ok) {
        console.log(`  backend  \u001b[32m✓ healthy\u001b[0m (HTTP ${result.status}, library ${String(result.id).slice(0, 8)})`);
    } else {
        console.error(`  backend  \u001b[31m✗ unreachable\u001b[0m ${result.error || `HTTP ${result.status}`}`);
        console.error(`           \u001b[90mcheck ${hostUrl}/health — file-library actions will fail until it answers\u001b[0m`);
    }
}

function startHealthWatch() {
    if (healthTimer) return;
    healthTimer = setInterval(() => void reportHealth(), 30_000);
    healthTimer.unref?.();
}

function printStatus(startup) {
    hostStarted = true;
    hostUrl = startup.url || hostUrl;
    const auth = startup.auth || (token ? 'bearer' : 'none');
    console.log('');
    console.log('  \u001b[1mmonochrome dev loop\u001b[0m');
    console.log(`  app      \u001b[36mhttp://localhost:${appPort}/\u001b[0m`);
    console.log(`  host     ${hostUrl}  (auth: ${auth})`);
    console.log(`  proxied  /storage → ${hostUrl}`);
    console.log(`  data     ${storageDir}`);
    console.log(`  library  ${libraryDir}`);
    console.log('');
    console.log('  \u001b[90medit js/ → HMR; edit verify/storage-lab/ → host restarts; Ctrl+C stops both\u001b[0m');
    void reportHealth();
    startHealthWatch();
}

function startVite() {
    const env = {
        ...process.env,
        MONOCHROME_DEV_STORAGE_TARGET: hostUrl,
        VITE_STORAGE_URL: '/storage',
    };
    if (token) env.VITE_STORAGE_TOKEN = token;
    else delete env.VITE_STORAGE_TOKEN;

    const child = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(appPort), '--strictPort'], {
        cwd: root,
        env,
        stdio: 'inherit',
    });
    children.add(child);
    child.on('exit', (code) => {
        children.delete(child);
        if (!shuttingDown) {
            console.log(label(`dev server exited (code ${code})`));
            shutdown(code ?? 0);
        }
    });
    return child;
}

// --- run ---------------------------------------------------------------------

console.log(label(`starting storage host on 127.0.0.1:${hostPort} (rust)`));
let host = startHost();

startVite();

// Restart the node host when its own sources change. The Rust host is skipped: a
// source change there needs a rebuild, and silently restarting a stale binary
// would be worse than doing nothing.
if (!useRust) {
    let timer = null;
    // Windows fires a burst of events for the directory itself right after the
    // watcher attaches; without this guard the host restarts once on every launch.
    const watchReadyAt = Date.now() + 1500;
    try {
        watch(join(root, 'verify', 'storage-lab'), { recursive: true }, (_event, file) => {
            if (!file || !/\.m?js$/.test(String(file))) return;
            if (Date.now() < watchReadyAt) return;
            clearTimeout(timer);
            // Editors write several events for one save; debounce so we restart once.
            timer = setTimeout(() => {
                if (shuttingDown) return;
                console.log(label(`host source changed (${file}) → restarting host`));
                restarting = true;
                stop(host);
                setTimeout(() => {
                    host = startHost();
                    restarting = false;
                }, 300);
            }, 250);
        });
    } catch (error) {
        console.log(label(`host watch disabled: ${error.message}`));
    }
}
