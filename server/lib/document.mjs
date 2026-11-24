// C79-05: work document text + local document assets.
//
// Local files are streamed into CAS exactly like work assets, but relationships
// live in document_asset_ref. One failed asset records a missing manifest entry
// and leaves successful assets/work text committed; retries skip ready resources
// and only try missing ones. No remote fetch, no UI.
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateLogicalPath } from './paths.mjs';
import { copyToTempAndHash, hashFile, sha256Text } from './hash.mjs';
import { pathExists } from './fs.mjs';

const MIME_BY_EXTENSION = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
};

function now() {
    return new Date().toISOString();
}

function isInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function trim(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function parseManifest(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function mimeFor(asset) {
    if (asset.mime) return String(asset.mime);
    return MIME_BY_EXTENSION[extname(String(asset.sourcePath || asset.logicalPath || '')).toLowerCase()] || 'application/octet-stream';
}

function resourceIdFor(asset, index) {
    return String(asset.resourceId || asset.id || asset.logicalPath || `document-asset-${index}`);
}

function mapManifest(entries) {
    return new Map(entries.map((entry) => [String(entry.resourceId), entry]));
}

function canonicalPlan(payload) {
    const assets = Array.isArray(payload?.assets)
        ? payload.assets.map((asset) => ({
              resourceId: asset?.resourceId || asset?.id || asset?.logicalPath || '',
              logicalPath: asset?.logicalPath || '',
              sourcePath: asset?.sourcePath || '',
              mime: asset?.mime || '',
              role: asset?.role || 'body',
          }))
        : null;
    return {
        introText: payload?.introText === undefined ? null : String(payload.introText),
        bodyText: payload?.bodyText === undefined ? null : String(payload.bodyText),
        sourceUrl: payload?.sourceUrl === undefined ? null : String(payload.sourceUrl),
        sourceRevision: payload?.sourceRevision === undefined ? null : String(payload.sourceRevision),
        assets,
    };
}

function planHashOf(payload) {
    return sha256Text(JSON.stringify(canonicalPlan(payload)));
}

function summaryFromDocument(row, revision, extra = {}) {
    const manifest = parseManifest(row?.asset_manifest_json);
    const missing = manifest.filter((entry) => entry.status === 'missing');
    const mediaState = row?.media_state || 'not_requested';
    return {
        workId: row.work_id,
        revision,
        documentRevision: row.document_revision,
        mediaState,
        complete: mediaState === 'complete',
        partial: mediaState === 'partial',
        assets: manifest,
        missing,
        counts: {
            ready: manifest.filter((entry) => entry.status === 'ready').length,
            missing: missing.length,
        },
        idempotent: extra.idempotent === true,
        planHash: row.last_plan_hash || null,
    };
}

async function validateSourceFile(sourcePath) {
    if (!sourcePath || typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) {
        throw new Error('sourcePath must be an absolute path');
    }
    const absolute = resolve(sourcePath);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('sourcePath is a symlink/junction');
    if (!info.isFile()) throw new Error('sourcePath is not a regular file');
    return absolute;
}

async function copyDocumentAsset(library, asset, index) {
    const resourceId = resourceIdFor(asset, index);
    const logicalPath = validateLogicalPath(asset.logicalPath || basename(String(asset.sourcePath || '')));
    const sourcePath = await validateSourceFile(asset.sourcePath);
    const temp = join(library.dataRoot, 'tmp', `document-${Date.now()}-${process.pid}-${index}.part`);
    await mkdir(dirname(temp), { recursive: true });
    const copied = await copyToTempAndHash(sourcePath, temp);
    const relPath = `assets/sha256/${copied.sha256.slice(0, 2)}/${copied.sha256}`;
    const destination = join(library.dataRoot, ...relPath.split('/'));
    if (!isInside(join(library.dataRoot, 'assets'), destination)) throw new Error('document asset escaped CAS');
    await mkdir(dirname(destination), { recursive: true });
    if (await pathExists(destination)) {
        const existing = await hashFile(destination);
        if (existing.sha256 !== copied.sha256 || existing.bytes !== copied.bytes) {
            await rm(temp, { force: true }).catch(() => {});
            throw new Error('document CAS collision/corruption');
        }
        await rm(temp, { force: true });
    } else {
        const handle = await open(temp, 'r+');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temp, destination);
    }
    return {
        resourceId,
        logicalPath,
        sourcePath,
        mime: mimeFor(asset),
        role: String(asset.role || 'body'),
        assetId: copied.sha256,
        sha256: copied.sha256,
        bytes: Number(copied.bytes),
        relPath,
        status: 'ready',
    };
}

/**
 * Save/refresh a work document. Text/source fields are preserved when omitted.
 * Assets are local only; a failed copy becomes a manifest missing item, while
 * successful assets and text remain committed. Retry passes the missing assets
 * again (or the full list) and reuses all ready refs/assets.
 */
export async function saveWorkDocument(library, workId, payload = {}, options = {}) {
    if (!library || !library.db) throw new Error('a storage-lab Library instance is required');
    const work = library.db.prepare('SELECT * FROM work WHERE work_id = ?').get(String(workId));
    if (!work) throw new Error('work not found');
    const existing = library.db.prepare('SELECT * FROM work_document WHERE work_id = ?').get(work.work_id);
    const idempotencyKey = payload.idempotencyKey ?? options.idempotencyKey ?? null;
    const planHash = planHashOf(payload);
    if (idempotencyKey && existing?.last_idempotency_key === String(idempotencyKey)) {
        if (existing.media_state !== 'partial') {
            if (existing.last_plan_hash && existing.last_plan_hash !== planHash) {
                const error = new Error('document idempotency key reused with a changed plan');
                error.code = 'EDOCUMENTCONFLICT';
                throw error;
            }
            return summaryFromDocument(existing, Number(work.revision), { idempotent: true });
        }
        // A partial document with the same key is a retry: continue below even if
        // the caller passes only the missing assets.
    }
    const requestedAssets = Array.isArray(payload.assets) ? payload.assets : null;
    const ready = [];
    const failures = [];
    if (requestedAssets) {
        for (const [index, asset] of requestedAssets.entries()) {
            try {
                const copied = await copyDocumentAsset(library, asset, index);
                ready.push(copied);
            } catch (error) {
                failures.push({
                    resourceId: resourceIdFor(asset, index),
                    logicalPath: trim(asset?.logicalPath, ''),
                    sourcePath: trim(asset?.sourcePath, ''),
                    mime: trim(asset?.mime, ''),
                    role: trim(asset?.role, 'body'),
                    status: 'missing',
                    error: String(error?.message || error),
                });
            }
        }
    }

    const existingManifest = parseManifest(existing?.asset_manifest_json);
    const merged = mapManifest(existingManifest);
    for (const asset of ready) {
        merged.set(asset.resourceId, {
            resourceId: asset.resourceId,
            logicalPath: asset.logicalPath,
            mime: asset.mime,
            role: asset.role,
            status: 'ready',
            assetId: asset.assetId,
            sha256: asset.sha256,
            bytes: asset.bytes,
            relPath: asset.relPath,
        });
    }
    for (const failure of failures) {
        // Do not downgrade a previously ready resource just because a later retry
        // did not pass it; only explicitly failed new resources become missing.
        if (!merged.has(failure.resourceId)) merged.set(failure.resourceId, failure);
    }
    const manifest = [...merged.values()].sort((a, b) => String(a.resourceId).localeCompare(String(b.resourceId)));
    const missing = manifest.filter((entry) => entry.status === 'missing');
    const mediaState = requestedAssets === null && !existing
        ? 'not_requested'
        : missing.length > 0
          ? 'partial'
          : manifest.length > 0
            ? 'complete'
            : 'not_requested';

    const timestamp = now();
    const revision = Number(work.revision) + 1;
    library._tx(() => {
        library.db
            .prepare(
                `INSERT INTO work_document(
                    work_id, intro_text, body_text, source_url, source_revision,
                    media_state, document_revision, asset_manifest_json,
                    last_idempotency_key, last_plan_hash, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(work_id) DO UPDATE SET
                    intro_text = excluded.intro_text,
                    body_text = excluded.body_text,
                    source_url = excluded.source_url,
                    source_revision = excluded.source_revision,
                    media_state = excluded.media_state,
                    document_revision = excluded.document_revision,
                    asset_manifest_json = excluded.asset_manifest_json,
                    last_idempotency_key = excluded.last_idempotency_key,
                    last_plan_hash = excluded.last_plan_hash,
                    updated_at = excluded.updated_at`
            )
            .run(
                work.work_id,
                payload.introText !== undefined ? String(payload.introText) : existing?.intro_text || '',
                payload.bodyText !== undefined ? String(payload.bodyText) : existing?.body_text || '',
                payload.sourceUrl !== undefined ? String(payload.sourceUrl) : existing?.source_url || '',
                payload.sourceRevision !== undefined ? String(payload.sourceRevision) : existing?.source_revision || '',
                mediaState,
                revision,
                JSON.stringify(manifest),
                idempotencyKey ? String(idempotencyKey) : null,
                planHash,
                timestamp
            );
        for (const asset of ready) {
            library.db
                .prepare(
                    `INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(asset.assetId, asset.sha256, asset.bytes, asset.mime, asset.relPath, timestamp);
            const current = library.db
                .prepare('SELECT * FROM document_asset_ref WHERE work_id = ? AND resource_id = ?')
                .get(work.work_id, asset.resourceId);
            if (current) {
                library.db
                    .prepare(
                        `UPDATE document_asset_ref SET asset_id = ?, logical_path = ?, role = ?, mime = ?, status = 'ready'
                         WHERE document_asset_ref_id = ?`
                    )
                    .run(asset.assetId, asset.logicalPath, asset.role, asset.mime, current.document_asset_ref_id);
            } else {
                library.db
                    .prepare(
                        `INSERT INTO document_asset_ref(
                            document_asset_ref_id, work_id, asset_id, resource_id, logical_path, role, mime, status, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`
                    )
                    .run(
                        `docref-${work.work_id}-${asset.resourceId}`,
                        work.work_id,
                        asset.assetId,
                        asset.resourceId,
                        asset.logicalPath,
                        asset.role,
                        asset.mime,
                        timestamp
                    );
            }
        }
        library.db
            .prepare('UPDATE work SET revision = ?, updated_at = ? WHERE work_id = ?')
            .run(revision, timestamp, work.work_id);
        library.db
            .prepare(
                `INSERT INTO snapshot_outbox(
                    library_id, work_id, target_revision, published_revision, status, attempt_count, updated_at
                ) VALUES (?, ?, ?, 0, 'pending', 0, ?)
                ON CONFLICT(library_id, work_id) DO UPDATE SET
                    target_revision = MAX(target_revision, excluded.target_revision),
                    status = 'pending',
                    last_error = NULL,
                    updated_at = excluded.updated_at`
            )
            .run(library.libraryId, work.work_id, revision, timestamp);
    });

    return {
        workId: work.work_id,
        revision,
        documentRevision: revision,
        mediaState,
        complete: mediaState === 'complete',
        partial: mediaState === 'partial',
        assets: manifest,
        missing,
        counts: {
            ready: manifest.filter((entry) => entry.status === 'ready').length,
            missing: missing.length,
        },
        idempotent: false,
        planHash,
    };
}

export async function getWorkDocument(library, workId) {
    const row = library.db.prepare('SELECT * FROM work_document WHERE work_id = ?').get(String(workId));
    if (!row) return null;
    const refs = library.db
        .prepare(
            `SELECT d.*, a.sha256, a.bytes, a.rel_path, a.mime AS asset_mime
             FROM document_asset_ref d JOIN asset a ON a.asset_id = d.asset_id
             WHERE d.work_id = ? ORDER BY d.resource_id`
        )
        .all(String(workId));
    return {
        ...row,
        introText: row.intro_text,
        bodyText: row.body_text,
        sourceUrl: row.source_url,
        sourceRevision: row.source_revision,
        mediaState: row.media_state,
        documentRevision: row.document_revision,
        assets: parseManifest(row.asset_manifest_json),
        refs,
    };
}
