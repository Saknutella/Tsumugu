// Creation posts are a separate local library from voice works: they keep
// Pawchive/Patreon metadata in SQLite and store their downloaded files in the
// same library root, without polluting the voice /api/works work tree.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isInside } from './paths.mjs';

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function postKey(postId) {
    return createHash('sha256').update(String(postId)).digest('hex');
}

export function createCreationStore({ db, root }) {
    const now = () => new Date().toISOString();

    function postRow(postId) {
        return db
            .prepare('SELECT post_id, title, source_url, data_json, created_at, updated_at FROM creation_post WHERE post_id = ? AND deleted_at IS NULL')
            .get(String(postId));
    }

    function assetRow(assetId) {
        return db
            .prepare('SELECT asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path FROM creation_asset WHERE asset_id = ?')
            .get(String(assetId));
    }

    return {
        savePost(post) {
            const postId = text(post?.id).trim();
            if (!postId) {
                const error = new Error('creation post id is required');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const timestamp = now();
            const title = text(post?.title).trim() || postId;
            const sourceUrl = text(post?.sourceUrl || post?.importedFrom);
            db.prepare(
                `INSERT INTO creation_post(post_id, title, source_url, data_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(post_id) DO UPDATE SET
                    title = excluded.title,
                    source_url = excluded.source_url,
                    data_json = excluded.data_json,
                    revision = revision + 1,
                    deleted_at = NULL,
                    updated_at = excluded.updated_at`
            ).run(postId, title, sourceUrl, JSON.stringify(post), timestamp, timestamp);
            return { postId, title, sourceUrl, updatedAt: timestamp };
        },

        listPosts() {
            const rows = db
                .prepare('SELECT * FROM creation_post WHERE deleted_at IS NULL ORDER BY created_at, post_id')
                .all();
            return rows.map((row) => {
                let post = {};
                try {
                    post = JSON.parse(row.data_json || '{}');
                } catch {
                    post = {};
                }
                const assets = db
                    .prepare('SELECT * FROM creation_asset WHERE post_id = ? ORDER BY created_at, attachment_id, role')
                    .all(row.post_id)
                    .map((asset) => ({
                        assetId: asset.asset_id,
                        attachmentId: asset.attachment_id,
                        role: asset.role,
                        name: asset.name,
                        mime: asset.mime,
                        bytes: Number(asset.bytes),
                        sha256: asset.sha256,
                        mediaPath: `/api/creations/media/${encodeURIComponent(asset.asset_id)}`,
                    }));
                return {
                    ...post,
                    id: row.post_id,
                    title: text(post.title, row.title),
                    sourceUrl: text(post.sourceUrl, row.source_url),
                    hostAssets: assets,
                    hostUpdatedAt: row.updated_at,
                };
            });
        },

        async saveAsset({ postId, attachmentId, role = 'original', bytes, mime = 'application/octet-stream', name = '' }) {
            const id = text(postId).trim();
            const key = text(attachmentId).trim();
            if (!id || !key) {
                const error = new Error('postId and attachmentId are required');
                error.code = 'EBADREQUEST';
                throw error;
            }
            if (!postRow(id)) {
                const error = new Error('creation post not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
            const sha256 = createHash('sha256').update(buffer).digest('hex');
            const previous = db
                .prepare('SELECT asset_id, rel_path FROM creation_asset WHERE post_id = ? AND attachment_id = ? AND role = ?')
                .get(id, key, text(role, 'original'));
            if (previous) {
                await rm(resolve(root, previous.rel_path), { force: true }).catch(() => {});
                db.prepare('DELETE FROM creation_asset WHERE asset_id = ?').run(previous.asset_id);
            }
            const assetId = randomUUID();
            const relativePath = join('data', 'creations', postKey(id), assetId);
            const target = resolve(root, relativePath);
            if (!isInside(resolve(root, 'data'), target)) {
                const error = new Error('creation asset path escapes the library');
                error.code = 'EPATHDENIED';
                throw error;
            }
            await mkdir(resolve(root, 'data', 'creations', postKey(id)), { recursive: true });
            await writeFile(target, buffer);
            db.prepare(
                `INSERT INTO creation_asset(asset_id, post_id, attachment_id, role, name, mime, bytes, sha256, rel_path, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(assetId, id, key, text(role, 'original'), text(name, key), text(mime, 'application/octet-stream'), buffer.length, sha256, relativePath, now());
            db.prepare('UPDATE creation_post SET updated_at = ? WHERE post_id = ?').run(now(), id);
            return {
                assetId,
                attachmentId: key,
                role: text(role, 'original'),
                name: text(name, key),
                mime: text(mime, 'application/octet-stream'),
                bytes: buffer.length,
                sha256,
                mediaPath: `/api/creations/media/${encodeURIComponent(assetId)}`,
            };
        },

        async readAsset(assetId) {
            const row = assetRow(assetId);
            if (!row) return null;
            const target = resolve(root, row.rel_path);
            if (!isInside(resolve(root, 'data'), target)) return null;
            return { ...row, path: target, buffer: await readFile(target) };
        },

        async deleteAsset(assetId) {
            const row = assetRow(assetId);
            if (!row) return false;
            await rm(resolve(root, row.rel_path), { force: true }).catch(() => {});
            db.prepare('DELETE FROM creation_asset WHERE asset_id = ?').run(row.asset_id);
            return true;
        },

        async deletePost(postId) {
            const id = text(postId);
            const row = postRow(id);
            if (!row) return false;
            const assets = db.prepare('SELECT rel_path FROM creation_asset WHERE post_id = ?').all(id);
            db.prepare('DELETE FROM creation_asset WHERE post_id = ?').run(id);
            db.prepare('DELETE FROM creation_post WHERE post_id = ?').run(id);
            for (const asset of assets) await rm(resolve(root, asset.rel_path), { force: true }).catch(() => {});
            await rm(resolve(root, 'data', 'creations', postKey(id)), { recursive: true, force: true }).catch(() => {});
            return true;
        },
    };
}
