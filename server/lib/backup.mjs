// S4a: consistent full backup, verification and restore.
//
// The database snapshot uses node:sqlite's SQLite backup API, never a raw copy of
// a live DB/WAL pair. Only assets referenced by that snapshot are copied, and each
// copied byte is re-hashed against the snapshot's asset row. COMPLETE is the last
// file written and is only valid when the DB and every referenced asset verify.
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertInsideExperiment } from './paths.mjs';
import { atomicWrite, atomicWriteJson, ensureDir, fsyncFile, pathExists, readJson } from './fs.mjs';
import { copyToTempAndHash, hashFile, sha256Text } from './hash.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

export const BACKUP_FORMAT = 'monochrome-storage-lab-backup';
export const BACKUP_FORMAT_VERSION = 1;
const COMPLETE = 'COMPLETE';
const COMPLETE_METADATA = 'COMPLETE-METADATA';
const MANIFEST = 'manifest.json';
const DB_REL = 'data/library.sqlite';
const TABLE_COUNT_NAMES = [
    'work',
    'entry',
    'asset',
    'asset_ref',
    'source_ref',
    'user_state',
    'work_document',
    'subtitle_binding',
    'import_job',
    'snapshot_outbox',
];

function slash(value) {
    return String(value || '').replace(/\\/g, '/');
}

function isSameOrInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function now() {
    return new Date().toISOString();
}

async function lstatRegular(path, label) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} is a symlink/junction`);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    return info;
}

async function assertNoReparse(path) {
    const absolute = resolve(path);
    const parts = absolute.split(sep);
    let current = parts[0] === '' ? sep : parts[0];
    for (let index = 1; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink()) throw new Error(`reparse point in path: ${current}`);
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
    }
}

function dataPath(root, relPath) {
    const normalized = slash(relPath);
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
        throw new Error(`invalid asset path: ${relPath}`);
    }
    const path = join(root, 'data', ...normalized.split('/'));
    if (!isSameOrInside(join(root, 'data'), path)) throw new Error(`asset path escapes root: ${relPath}`);
    return path;
}

async function fileFacts(path) {
    await assertNoReparse(path);
    const info = await lstatRegular(path, path);
    const hashed = await hashFile(path);
    return { bytes: Number(info.size), sha256: hashed.sha256 };
}

async function ensureEmptyDestination(destination) {
    if (await pathExists(destination)) {
        const info = await lstat(destination);
        if (info.isSymbolicLink()) throw new Error('destination must not be a symlink/junction');
        if (!info.isDirectory()) throw new Error('destination exists and is not a directory');
        const children = await readdir(destination);
        if (children.length > 0) {
            const error = new Error('backup destination must be empty');
            error.code = 'EBACKUPDEST';
            throw error;
        }
    } else {
        await mkdir(destination, { recursive: true });
    }
    await assertNoReparse(destination);
}

function dbCounts(db) {
    const counts = {};
    for (const table of TABLE_COUNT_NAMES) {
        try {
            counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
        } catch {
            counts[table] = null;
        }
    }
    return counts;
}

function readDbFacts(db) {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const integrityValues = integrity.map((row) => row.integrity_check ?? Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
    const library = db.prepare('SELECT * FROM library LIMIT 1').get();
    return {
        integrity: integrityValues,
        foreignKeys,
        schemaVersion: userVersion,
        libraryId: library?.library_id || null,
        counts: dbCounts(db),
    };
}

async function snapshotDatabase(library, destination) {
    const target = join(destination, DB_REL);
    await ensureDir(join(destination, 'data'));
    const temp = join(destination, 'data', `.library.sqlite.${process.pid}.${Date.now()}.tmp`);
    await rm(temp, { force: true }).catch(() => {});
    try {
        // node:sqlite's backup uses SQLite's online backup API. It reads a
        // consistent DB image and does not copy a live WAL file.
        await sqliteBackup(library.db, temp);
    } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
    }
    await fsyncFile(temp);
    const snapshotFacts = await fileFacts(temp);
    let db;
    try {
        db = new DatabaseSync(temp, { readOnly: true });
        const facts = readDbFacts(db);
        if (facts.integrity.some((value) => value !== 'ok')) {
            throw new Error(`snapshot integrity_check failed: ${facts.integrity.join(',')}`);
        }
        if (facts.foreignKeys.length > 0) throw new Error('snapshot foreign_key_check failed');
        if (facts.schemaVersion !== SCHEMA_VERSION) throw new Error(`unexpected schema version ${facts.schemaVersion}`);
        if (facts.libraryId !== library.libraryId) throw new Error('snapshot library id mismatch');
        const assets = db
            .prepare(
                `SELECT DISTINCT a.sha256, a.bytes, a.rel_path, a.mime
                 FROM asset a JOIN asset_ref r ON r.asset_id = a.asset_id
                 UNION
                 SELECT DISTINCT a.sha256, a.bytes, a.rel_path, a.mime
                 FROM asset a JOIN document_asset_ref d ON d.asset_id = a.asset_id
                 ORDER BY sha256`
            )
            .all()
            .map((asset) => ({
                sha256: asset.sha256,
                bytes: Number(asset.bytes),
                relPath: slash(asset.rel_path),
                mime: asset.mime || 'application/octet-stream',
            }));
        if (assets.some((asset) => !asset.relPath)) throw new Error('snapshot has asset without rel_path');
        return {
            temp,
            target,
            snapshot: {
                file: DB_REL,
                sha256: snapshotFacts.sha256,
                bytes: snapshotFacts.bytes,
                schemaVersion: facts.schemaVersion,
                libraryId: facts.libraryId,
                counts: facts.counts,
            },
            assets,
        };
    } finally {
        db?.close();
    }
}

async function copyAssetVerified(library, destination, asset) {
    const source = dataPath(library.root, asset.relPath);
    const target = dataPath(destination, asset.relPath);
    await ensureDir(dirname(target));
    await assertNoReparse(source);
    const copied = await copyToTempAndHash(source, `${target}.${process.pid}.${Date.now()}.part`);
    if (copied.sha256 !== asset.sha256 || Number(copied.bytes) !== Number(asset.bytes)) {
        await rm(copied.tempPath, { force: true }).catch(() => {});
        throw new Error(`referenced asset failed size/hash verification: ${asset.relPath}`);
    }
    await rename(copied.tempPath, target);
    return { bytes: Number(copied.bytes), sha256: copied.sha256 };
}

async function writeManifestAndMarker(destination, manifest, { complete, metadataOnly }) {
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await atomicWrite(join(destination, MANIFEST), manifestText);
    if (!complete) return;
    const markerPath = join(destination, metadataOnly ? COMPLETE_METADATA : COMPLETE);
    await atomicWrite(
        markerPath,
        `${JSON.stringify(
            {
                manifestSha256: sha256Text(manifestText),
                completedAt: now(),
                includeMedia: !metadataOnly,
            },
            null,
            2
        )}\n`
    );
}

function faultMatches(fault, point) {
    if (!fault) return false;
    const value = String(fault).toLowerCase();
    const target = String(point).toLowerCase();
    if (value === target) return true;
    if (target === 'f5' && ['f5-backup', 'backup-before-complete', 'before-complete'].includes(value)) return true;
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

/**
 * Back up an open library into an empty destination directory.
 * Returns a structured partial result instead of claiming COMPLETE when an asset
 * is missing/corrupt; the caller/UI decides whether to retry or discard.
 */
export async function backupLibrary(library, destination, options = {}) {
    if (!library || typeof library.db === 'undefined') throw new Error('a storage-lab Library instance is required');
    const dest = resolve(String(destination || ''));
    assertInsideExperiment(dest);
    if (dest === resolve(library.root) || isSameOrInside(library.dataRoot, dest)) {
        const error = new Error('backup destination must not be the library data root or inside it');
        error.code = 'EBACKUPDEST';
        throw error;
    }
    await ensureEmptyDestination(dest);
    const includeMedia = options.includeMedia !== false;
    const startedAt = now();
    const errors = [];
    let snapshot;
    let assets = [];
    try {
        const staged = await snapshotDatabase(library, dest);
        snapshot = staged.snapshot;
        assets = staged.assets;
        await rename(staged.temp, staged.target);
    } catch (error) {
        errors.push({ stage: 'database', error: String(error?.message || error) });
        // A failed DB snapshot is not a valid backup. Leave no marker; write a
        // partial manifest when possible so the failure is inspectable.
        const partial = {
            format: BACKUP_FORMAT,
            formatVersion: BACKUP_FORMAT_VERSION,
            libraryId: library.libraryId,
            schemaVersion: SCHEMA_VERSION,
            createdAt: startedAt,
            status: 'partial',
            includeMedia,
            errors,
            data: null,
            assets: [],
        };
        await writeManifestAndMarker(dest, partial, { complete: false, metadataOnly: false });
        return { dir: dest, complete: false, status: 'partial', manifest: partial, errors };
    }

    const copiedAssets = [];
    let totalAssetBytes = 0;
    if (includeMedia) {
        for (const asset of assets) {
            try {
                const copied = await copyAssetVerified(library, dest, asset);
                copiedAssets.push({ ...asset, bytes: copied.bytes, sha256: copied.sha256 });
                totalAssetBytes += copied.bytes;
            } catch (error) {
                errors.push({ stage: 'asset', sha256: asset.sha256, relPath: asset.relPath, error: String(error?.message || error) });
            }
        }
    }
    triggerFault(options, 'F5', {
        dir: dest,
        libraryId: library.libraryId,
        snapshot,
        assets: copiedAssets.map((asset) => asset.sha256),
    });
    const complete = includeMedia ? errors.length === 0 : errors.length === 0;
    const manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        libraryId: library.libraryId,
        schemaVersion: snapshot.schemaVersion,
        createdAt: startedAt,
        completedAt: complete ? now() : null,
        status: complete ? (includeMedia ? 'complete' : 'complete-metadata') : 'partial',
        includeMedia,
        completeKind: includeMedia ? 'media' : 'metadata',
        data: snapshot,
        assets: includeMedia ? copiedAssets : [],
        referencedAssetCount: assets.length,
        assetCount: copiedAssets.length,
        totalAssetBytes,
        errors,
    };
    await writeManifestAndMarker(dest, manifest, {
        complete,
        metadataOnly: !includeMedia,
    });
    return {
        dir: dest,
        complete,
        status: manifest.status,
        manifest,
        errors,
    };
}

function issue(issues, code, detail) {
    issues.push({ code, detail });
}

async function verifyManifestAndMarker(backupDir, manifest) {
    const issues = [];
    if (!manifest || typeof manifest !== 'object') {
        issue(issues, 'manifest-missing', 'manifest.json is missing or unreadable');
        return issues;
    }
    if (manifest.format !== BACKUP_FORMAT) issue(issues, 'manifest-format', manifest.format);
    if (Number(manifest.formatVersion) !== BACKUP_FORMAT_VERSION) issue(issues, 'manifest-version', manifest.formatVersion);
    if (!manifest.libraryId) issue(issues, 'manifest-library-id', 'libraryId missing');
    if (!manifest.data || !manifest.data.sha256 || !Number.isFinite(Number(manifest.data.bytes))) {
        issue(issues, 'manifest-db-entry', 'database hash/size missing');
    }
    if (!Array.isArray(manifest.assets)) issue(issues, 'manifest-assets', 'assets array missing');
    if (manifest.status === 'partial' || manifest.errors?.length) {
        issue(issues, 'manifest-partial', 'backup manifest records a partial backup');
    }
    if (manifest.includeMedia !== false) {
        const markerPath = join(backupDir, COMPLETE);
        if (!(await pathExists(markerPath))) {
            issue(issues, 'missing-complete', 'COMPLETE marker missing');
        } else {
            try {
                const marker = JSON.parse(await readFile(markerPath, 'utf8'));
                const manifestRaw = await readFile(join(backupDir, MANIFEST), 'utf8');
                if (marker.manifestSha256 !== sha256Text(manifestRaw)) {
                    issue(issues, 'complete-manifest-hash', 'COMPLETE does not match manifest.json');
                }
            } catch (error) {
                issue(issues, 'complete-unreadable', String(error?.message || error));
            }
        }
    } else {
        const markerPath = join(backupDir, COMPLETE_METADATA);
        if (!(await pathExists(markerPath))) issue(issues, 'missing-metadata-complete', 'COMPLETE-METADATA missing');
    }
    return issues;
}

async function verifyDatabase(backupDir, manifest, issues) {
    const dbPath = join(backupDir, DB_REL);
    let db;
    try {
        await assertNoReparse(dbPath);
        const facts = await fileFacts(dbPath);
        if (facts.sha256 !== manifest.data.sha256 || Number(facts.bytes) !== Number(manifest.data.bytes)) {
            issue(issues, 'db-hash-mismatch', 'database bytes do not match manifest');
        }
        db = new DatabaseSync(dbPath, { readOnly: true });
        const dbFacts = readDbFacts(db);
        if (dbFacts.integrity.some((value) => value !== 'ok')) issue(issues, 'db-integrity', dbFacts.integrity.join(','));
        if (dbFacts.foreignKeys.length > 0) issue(issues, 'db-foreign-keys', dbFacts.foreignKeys.slice(0, 5));
        if (dbFacts.schemaVersion !== Number(manifest.schemaVersion)) issue(issues, 'db-schema-version', dbFacts.schemaVersion);
        if (dbFacts.libraryId !== manifest.libraryId) issue(issues, 'db-library-id', dbFacts.libraryId);
        if (JSON.stringify(dbFacts.counts) !== JSON.stringify(manifest.data?.counts)) {
            issue(issues, 'db-counts-mismatch', { actual: dbFacts.counts, expected: manifest.data?.counts });
        }
        const referenced = db
            .prepare(
                `SELECT DISTINCT a.sha256, a.bytes, a.rel_path
                 FROM asset a JOIN asset_ref r ON r.asset_id = a.asset_id
                 UNION
                 SELECT DISTINCT a.sha256, a.bytes, a.rel_path
                 FROM asset a JOIN document_asset_ref d ON d.asset_id = a.asset_id
                 ORDER BY sha256`
            )
            .all();
        return { db, referenced: referenced.map((asset) => ({
            sha256: asset.sha256,
            bytes: Number(asset.bytes),
            relPath: slash(asset.rel_path),
        })) };
    } catch (error) {
        issue(issues, 'db-unreadable', String(error?.message || error));
        db?.close();
        return { db: null, referenced: [] };
    }
}

async function verifyAssets(backupDir, manifest, referenced, issues) {
    if (manifest.includeMedia === false) {
        if (manifest.assets?.length) issue(issues, 'metadata-backup-has-assets', 'metadata-only backup lists media assets');
        return;
    }
    const listed = new Map((manifest.assets || []).map((asset) => [asset.sha256, asset]));
    for (const asset of referenced) {
        const entry = listed.get(asset.sha256);
        if (!entry) {
            issue(issues, 'asset-missing-from-manifest', asset.relPath);
            continue;
        }
        if (String(entry.relPath) !== asset.relPath) {
            issue(issues, 'asset-path-mismatch', { sha256: asset.sha256, expected: asset.relPath, actual: entry.relPath });
        }
        const path = dataPath(backupDir, entry.relPath);
        try {
            await assertNoReparse(path);
            const facts = await fileFacts(path);
            if (facts.sha256 !== entry.sha256 || Number(facts.bytes) !== Number(entry.bytes)) {
                issue(issues, 'asset-hash-mismatch', entry.relPath);
            }
        } catch (error) {
            issue(issues, 'asset-unreadable', { relPath: entry.relPath, error: String(error?.message || error) });
        }
    }
    const referencedHashes = new Set(referenced.map((asset) => asset.sha256));
    for (const asset of manifest.assets || []) {
        if (!referencedHashes.has(asset.sha256)) issue(issues, 'asset-extra-in-manifest', asset.relPath);
    }
}

/**
 * Verify manifest, COMPLETE marker, snapshot DB, FKs/schema and every referenced
 * asset. A partial/missing-marker backup is never treated as restorable.
 */
export async function verifyBackup(backupDir) {
    const dir = resolve(String(backupDir || ''));
    const issues = [];
    try {
        assertInsideExperiment(dir);
        const manifestPath = join(dir, MANIFEST);
        if (!(await pathExists(manifestPath))) {
            return { ok: false, dir, issues: [{ code: 'manifest-missing', detail: manifestPath }], manifest: null };
        }
        const manifest = await readJson(manifestPath, null);
        issues.push(...(await verifyManifestAndMarker(dir, manifest)));
        const dbState = await verifyDatabase(dir, manifest, issues);
        try {
            await verifyAssets(dir, manifest, dbState.referenced, issues);
        } finally {
            dbState.db?.close();
        }
        return {
            ok: issues.length === 0,
            dir,
            issues,
            manifest,
            libraryId: manifest?.libraryId || null,
            assetCount: (manifest?.assets || []).length,
        };
    } catch (error) {
        issue(issues, 'verify-error', String(error?.message || error));
        return { ok: false, dir, issues, manifest: null };
    }
}

async function copyVerifiedFile(source, target, expected) {
    await ensureDir(dirname(target));
    await assertNoReparse(source);
    const copied = await copyToTempAndHash(source, `${target}.${process.pid}.${Date.now()}.part`);
    if (expected) {
        if (copied.sha256 !== expected.sha256 || Number(copied.bytes) !== Number(expected.bytes)) {
            throw new Error(`restored file failed verification: ${target}`);
        }
    }
    await rename(copied.tempPath, target);
    return { bytes: Number(copied.bytes), sha256: copied.sha256 };
}

/**
 * Restore a verified backup into a completely empty directory. The source backup
 * is read-only; libraryId and asset paths are preserved. The restored root is
 * opened once to validate SQLite/FKs/schema before returning.
 */
export async function restoreLibrary(backupDir, emptyRoot) {
    const dir = resolve(String(backupDir || ''));
    const destination = resolve(String(emptyRoot || ''));
    assertInsideExperiment(destination);
    // P1-3: validate the destination and its existing ancestor chain before the
    // first mkdir/write. A final openLibrary() reparse check is too late: bytes may
    // already have escaped through a junction.
    await assertNoReparse(destination);
    const check = await verifyBackup(dir);
    if (!check.ok) {
        const error = new Error(`backup is not restorable: ${check.issues.map((item) => item.code).join(',')}`);
        error.code = 'EINVALIDBACKUP';
        error.issues = check.issues;
        throw error;
    }
    if (isSameOrInside(dir, destination) || isSameOrInside(destination, dir)) {
        const error = new Error('restore destination must be outside the backup directory');
        error.code = 'ERESTOREDEST';
        throw error;
    }
    if (await pathExists(destination)) {
        const info = await lstat(destination);
        if (!info.isDirectory() || (await readdir(destination)).length > 0) {
            const error = new Error('restore destination must be empty');
            error.code = 'ERESTORENOTEMPTY';
            throw error;
        }
    }
    await mkdir(destination, { recursive: true });
    await assertNoReparse(destination);
    await mkdir(join(destination, 'data'), { recursive: true });
    await assertNoReparse(destination);
    const manifest = check.manifest;
    await copyVerifiedFile(join(dir, DB_REL), join(destination, DB_REL), {
        sha256: manifest.data.sha256,
        bytes: manifest.data.bytes,
    });
    for (const asset of manifest.assets || []) {
        await assertNoReparse(destination);
        const relativePath = slash(asset.relPath);
        const source = dataPath(dir, relativePath);
        const target = dataPath(destination, relativePath);
        await copyVerifiedFile(source, target, { sha256: asset.sha256, bytes: asset.bytes });
    }
    await atomicWriteJson(join(destination, 'root.json'), {
        schemaVersion: manifest.schemaVersion,
        libraryId: manifest.libraryId,
        createdAt: now(),
        app: 'monochrome-storage-lab',
        restoredFrom: 'backup',
    });
    let restored;
    try {
        const { openLibrary } = await import('./library.mjs');
        restored = await openLibrary(destination, { create: false });
        const verification = await restored.verifyLibrary();
        if (!verification.ok) {
            throw new Error(`restored library verification failed: ${verification.issues.map((item) => item.code).join(',')}`);
        }
        await restored.close();
    } catch (error) {
        // Keep the restored files for inspection, but never report success.
        throw error;
    }
    return {
        root: destination,
        libraryId: manifest.libraryId,
        schemaVersion: manifest.schemaVersion,
        verified: true,
        check,
    };
}

export { COMPLETE, COMPLETE_METADATA, MANIFEST };
