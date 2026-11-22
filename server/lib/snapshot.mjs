// Versioned work snapshots. Snapshot JSON is derived from committed DB rows; it
// never rolls the database back. Both files are written with temp+fsync+rename,
// and a pair is considered published only when both validate at the same revision.
import { join } from 'node:path';
import { readJson, atomicWriteJson } from './fs.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export function snapshotPaths(dataRoot, workId) {
    const directory = join(dataRoot, 'works', workId);
    return {
        directory,
        workJson: join(directory, 'work.json'),
        manifestJson: join(directory, 'manifest.json'),
    };
}

export async function writeSnapshotPair({ dataRoot, libraryId, workId, targetRevision, model, fault = null }) {
    const paths = snapshotPaths(dataRoot, workId);
    if (!Number.isInteger(targetRevision) || targetRevision < 1) throw new Error('invalid target revision');
    const createdAt = new Date().toISOString();

    const workJson = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        libraryId,
        workId,
        revision: targetRevision,
        snapshotCreatedAt: createdAt,
        work: model.work,
        sourceRefs: model.sourceRefs,
        entries: model.entries,
        userState: model.userState,
    };
    const manifestJson = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        libraryId,
        workId,
        revision: targetRevision,
        snapshotCreatedAt: createdAt,
        entries: model.entries.length,
        assets: model.assets,
    };

    await atomicWriteJson(paths.workJson, workJson);
    if (fault === 'after-work-json') {
        const error = new Error('injected snapshot fault after work.json');
        error.code = 'ESNAPSHOTFAULT';
        throw error;
    }
    await atomicWriteJson(paths.manifestJson, manifestJson);
    if (fault === 'after-manifest') {
        const error = new Error('injected snapshot fault after manifest.json');
        error.code = 'ESNAPSHOTFAULT';
        throw error;
    }

    const [workBack, manifestBack] = await Promise.all([
        readJson(paths.workJson, null),
        readJson(paths.manifestJson, null),
    ]);
    if (!workBack || !manifestBack) throw new Error('snapshot pair missing after write');
    if (
        workBack.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
        manifestBack.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
        workBack.libraryId !== libraryId ||
        manifestBack.libraryId !== libraryId ||
        workBack.workId !== workId ||
        manifestBack.workId !== workId ||
        workBack.revision !== targetRevision ||
        manifestBack.revision !== targetRevision
    ) {
        throw new Error(`snapshot pair validation failed for ${workId}`);
    }
    if (fault === 'before-mark') {
        const error = new Error('injected snapshot fault before published_revision update');
        error.code = 'ESNAPSHOTFAULT';
        throw error;
    }
    return { workJson, manifestJson, revision: targetRevision };
}

/**
 * Read both files and report whether they form a valid pair. A crash between
 * the two renames leaves one file at a different revision; callers must not
 * treat that as published.
 */
export async function readSnapshotPair(dataRoot, workId, expected = {}) {
    const paths = snapshotPaths(dataRoot, workId);
    const [workJson, manifestJson] = await Promise.all([
        readJson(paths.workJson, null),
        readJson(paths.manifestJson, null),
    ]);
    const problems = [];
    if (!workJson) problems.push('work.json missing or unparsable');
    if (!manifestJson) problems.push('manifest.json missing or unparsable');
    if (workJson && manifestJson) {
        if (workJson.revision !== manifestJson.revision) problems.push('revision pair mismatch');
        if (workJson.workId !== workId || manifestJson.workId !== workId) problems.push('workId mismatch');
        if (expected.libraryId && (workJson.libraryId !== expected.libraryId || manifestJson.libraryId !== expected.libraryId)) {
            problems.push('libraryId mismatch');
        }
        if (expected.revision && workJson.revision !== expected.revision) {
            problems.push(`expected revision ${expected.revision}, got ${workJson.revision}`);
        }
    }
    return {
        ok: problems.length === 0,
        problems,
        workJson,
        manifestJson,
        paths,
    };
}
