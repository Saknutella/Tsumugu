#!/usr/bin/env node
// Production-ish storage-lab host entrypoint. Data/CAS/tmp/works remain below
// MONOCHROME_DATA; source files are read-only and must be explicitly authorized.
// The HTTP API is intentionally unauthenticated, so it binds loopback unless the
// operator explicitly supplies MONOCHROME_BIND.
import { resolve } from 'node:path';
import { createHost } from './lib/host.mjs';
import { createHostServer } from './lib/host-server.mjs';

function env(name) {
    const value = process.env[name];
    return value === undefined || value === '' ? null : String(value);
}

function parsePort(value) {
    if (value === null) return 0;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MONOCHROME_PORT must be 0..65535');
    return port;
}

function emit(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
    const data = env('MONOCHROME_DATA');
    if (!data) throw new Error('MONOCHROME_DATA is required');
    const source = env('MONOCHROME_SOURCE');
    const bindExplicit = env('MONOCHROME_BIND') !== null;
    const bind = env('MONOCHROME_BIND') || '127.0.0.1';
    const port = parsePort(env('MONOCHROME_PORT'));
    const host = await createHost({
        libraryRoot: resolve(data),
        sourceRoot: source ? resolve(source) : null,
        // This is the explicit production opt-in to a configured data root outside
        // the project experiment directory. CAS/tmp/snapshots still live under it.
        allowOutsideRoot: true,
        allowedSourceRoots: source ? [resolve(source)] : [],
    });
    const server = await createHostServer(host, {
        host: bind,
        port,
        // Non-loopback is only accepted when the operator explicitly set BIND.
        allowNonLoopback: bindExplicit,
        token: env('MONOCHROME_TOKEN'),
        mediaTtlMs: env('MONOCHROME_MEDIA_TTL_MS') ? Number(env('MONOCHROME_MEDIA_TTL_MS')) : undefined,
    });
    emit({
        ok: true,
        service: 'monochrome-storage-lab',
        url: server.url,
        health: `${server.url}/health`,
        healthUrl: `${server.url}/health`,
        libraryId: host.libraryId,
        bind,
        port: server.port,
        sourceConfigured: Boolean(source),
        auth: env('MONOCHROME_TOKEN') ? 'bearer' : 'none',
    });

    let closing = false;
    const shutdown = async (signal) => {
        if (closing) return;
        closing = true;
        try {
            await server.close();
            await host.close();
            emit({ ok: true, service: 'monochrome-storage-lab', shutdown: signal, url: server.url });
            process.exitCode = 0;
        } catch (error) {
            emit({ ok: false, service: 'monochrome-storage-lab', shutdown: signal, error: { code: error.code || null, message: String(error.message || error) } });
            process.exitCode = 1;
        }
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
    // Windows emulates only some signals; Ctrl+Break is the portable local stop.
    process.once('SIGBREAK', () => void shutdown('SIGBREAK'));
}

try {
    await main();
} catch (error) {
    emit({
        ok: false,
        service: 'monochrome-storage-lab',
        error: { code: error?.code || null, message: String(error?.message || error) },
    });
    process.exitCode = 1;
}
