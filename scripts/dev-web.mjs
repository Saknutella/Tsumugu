#!/usr/bin/env node
// Start the file-library host (Rust), optionally alongside the Vite dev server.
//
// The host is a compiled binary, not an interpreted script: `npm run build:server`
// has to run once before this can start. Everything else mirrors the Node variant —
// fixed host port, `/storage` proxy the frontend already probes, one Ctrl+C.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value && !value.startsWith('--') ? value : fallback;
};
const has = (name) => process.argv.includes(name);

const appPort = Number(arg('--port', '5173'));
const hostPort = Number(arg('--host-port', '5174'));
const dataRoot = resolve(arg('--data', join(root, 'data')));
const serverOnly = has('--server-only');
const noToken = has('--no-token');
const token = noToken ? null : arg('--token', randomBytes(16).toString('hex'));

const storageDir = join(dataRoot, 'storage');
const libraryDir = join(dataRoot, 'library');
mkdirSync(storageDir, { recursive: true });
mkdirSync(libraryDir, { recursive: true });

// cargo emits into `<manifest-dir>/target/release/`; the manifest dir is `server/`.
const exeName = process.platform === 'win32' ? 'monochrome-storage-host.exe' : 'monochrome-storage-host';
const hostBin = resolve(arg('--bin', join(root, 'server', 'target', 'release', exeName)));
if (!existsSync(hostBin)) {
    console.error(`[dev] host binary missing: ${hostBin}`);
    console.error('[dev] build it first:  npm run build:server');
    process.exit(3);
}

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!serverOnly && !existsSync(viteBin)) {
    console.error(`[dev] vite is not installed: ${viteBin}`);
    console.error('[dev] run: npm install');
    process.exit(3);
}

const children = new Set();
let shuttingDown = false;
let restarting = false;
const RESTART_LIMIT = 5;
let restarts = 0;
let fatal = null;

const label = (text) => `\u001b[36m[dev]\u001b[0m ${text}`;

function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        try {
            child.kill();
        } catch {
            /* already gone */
        }
    }
    setTimeout(() => process.exit(code), 150);
}
process.on('SIGINT', () => {
    console.log(`\n${label('stopping')}`);
    shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

let hostUrl = `http://127.0.0.1:${hostPort}`;

function startHost() {
    fatal = null;
    const env = {
        ...process.env,
        MONOCHROME_DATA: storageDir,
        MONOCHROME_SOURCE: libraryDir,
        MONOCHROME_BIND: '127.0.0.1',
        MONOCHROME_PORT: String(hostPort),
    };
    if (token) env.MONOCHROME_TOKEN = token;
    else delete env.MONOCHROME_TOKEN;

    const child = spawn(hostBin, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);

    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            // The first JSON line is the startup contract; the rest is host logging we
            // keep visible because "why did my request 401" usually lives there.
            if (line.startsWith('{') && line.includes('"url"')) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.ok === false) {
                        fatal = parsed.error?.message || line;
                        console.error(label(`host failed: ${fatal}`));
                        continue;
                    }
                    hostUrl = parsed.url || hostUrl;
                    printStatus(parsed);
                    continue;
                } catch {
                    /* not the startup line */
                }
            }
            console.log(`\u001b[90m[host]\u001b[0m ${line}`);
        }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`\u001b[31m[host]\u001b[0m ${chunk}`));
    child.on('exit', (code) => {
        children.delete(child);
        if (shuttingDown || restarting) return;
        if (fatal) {
            console.error(label(`host refused to start: ${fatal}`));
            if (/schema \d+ is newer than supported/i.test(fatal)) {
                console.error(label('this data dir was created by an older host build; point --data at a fresh directory'));
            }
            console.error(label('not retrying; fix the error above, then restart'));
            return;
        }
        restarts += 1;
        if (restarts > RESTART_LIMIT) {
            console.error(label(`host exited (code ${code}) and ${RESTART_LIMIT} restarts failed; giving up`));
            return;
        }
        console.log(label(`host exited (code ${code}) → restarting (${restarts}/${RESTART_LIMIT})`));
        restarting = true;
        setTimeout(() => {
            if (shuttingDown) return;
            startHost();
            restarting = false;
        }, 1500);
    });
    return child;
}

function printStatus(startup) {
    if (serverOnly) {
        console.log(JSON.stringify({ ok: true, url: hostUrl, data: storageDir, library: libraryDir, auth: startup?.auth }));
        return;
    }
    console.log('');
    console.log('  \u001b[1mfile library host (rust)\u001b[0m');
    console.log(`  app      \u001b[36mhttp://localhost:${appPort}/\u001b[0m`);
    console.log(`  host     ${hostUrl}  (auth: ${startup?.auth || (token ? 'bearer' : 'none')})`);
    console.log(`  proxied  /storage → ${hostUrl}`);
    console.log(`  data     ${storageDir}`);
    console.log(`  library  ${libraryDir}`);
    console.log('');
    console.log('  \u001b[90mCtrl+C stops both\u001b[0m');
    console.log('');
}

console.log(label(`starting host on 127.0.0.1:${hostPort}`));
startHost();

if (!serverOnly) {
    const vite = spawn(process.execPath, [viteBin, '--port', String(appPort), '--strictPort'], {
        cwd: root,
        env: {
            ...process.env,
            MONOCHROME_DEV_STORAGE_TARGET: hostUrl,
            VITE_STORAGE_URL: '/storage',
            ...(token ? { VITE_STORAGE_TOKEN: token } : {}),
        },
        stdio: 'inherit',
    });
    children.add(vite);
    vite.on('exit', (code) => {
        children.delete(vite);
        if (!shuttingDown) {
            console.log(label(`dev server exited (code ${code})`));
            shutdown(code ?? 0);
        }
    });
}
