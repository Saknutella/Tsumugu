// S5 Node host adapter. This is an orchestration layer only: scanning, ingest,
// backup/restore and export continue to use the existing S1-S4b modules and the
// same real SQLite/CAS files. No second storage implementation, no network.
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathExists } from './fs.mjs';
import { EXPERIMENT_ROOT, isInside, normalizeAllowedSourceRoots, resolveRoot } from './paths.mjs';
import { openLibrary } from './library.mjs';
import { scanSource } from './scan.mjs';
import { hashFile } from './hash.mjs';
import { ingestCandidate, ingestPreview } from './ingest.mjs';
import { restoreLibrary } from './backup.mjs';
import { createCreationStore } from './creations.mjs';

async function mergeDirectory(source, target) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const from = join(source, entry.name);
        const to = join(target, entry.name);
        if (entry.isDirectory()) {
            await mergeDirectory(from, to);
        } else if (entry.isFile()) {
            try {
                await stat(to);
            } catch {
                await copyFile(from, to);
            }
        }
    }
}

function isLoopbackDownloadUrl(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch {
        return false;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
}

/**
 * The README examples sometimes pass `<run>/data` to --library while S1's
 * openLibrary() root is the parent containing `data/`. Accept both spellings:
 * an existing S1 root stays untouched; a `.../data` path maps to its parent so
 * the CLI's documented `--library .../data` resolves to the same DB.
 */
async function resolveLibraryRoot(input, options = {}) {
    const absolute = resolve(String(input || ''));
    if (options.allowOutsideRoot !== true) resolveRoot(absolute);
    if (basename(absolute) === 'data') {
        const parent = dirname(absolute);
        if (await pathExists(join(parent, 'root.json'))) return parent;
        if (await pathExists(join(absolute, 'library.sqlite'))) return parent;
        // Documented CLI spelling: --library .../data => root is its parent.
        return parent;
    }
    return absolute;
}

function slash(value) {
    return String(value || '').replaceAll(String.fromCharCode(92), '/');
}

function redactPath(path, source) {
    if (!path || typeof path !== 'string') return path;
    if (!isAbsolute(path)) return slash(path);
    const rel = relative(source, path);
    return slash(rel || '.');
}

function redactPreview(preview, source) {
    const clone = structuredClone(preview);
    clone.sourceRoot = '.';
    clone.libraryRoot = '.';
    clone.rejected = (clone.rejected || []).map((item) => ({
        ...item,
        path: redactPath(item.path, source),
        relativePath: item.relativePath || redactPath(item.path, source),
    }));
    clone.candidates = (clone.candidates || []).map((candidate) => {
        const root = candidate.relativeRoot || '.';
        return {
            ...candidate,
            rootPath: root,
            entries: (candidate.entries || []).map((entry) => ({
                ...entry,
                absolutePath: entry.logicalPath,
            })),
            coverCandidates: (candidate.coverCandidates || []).map((cover) => ({
                ...cover,
                path: cover.relativePath || basename(String(cover.path || '')),
            })),
            excluded: (candidate.excluded || []).map((item) => ({
                ...item,
                path: redactPath(item.path, source),
            })),
        };
    });
    return clone;
}

function hydratePreview(preview, lastScanRoot) {
    const clone = structuredClone(preview);
    clone.candidates = (clone.candidates || []).map((candidate) => {
        const root = isAbsolute(String(candidate.rootPath || ''))
            ? candidate.rootPath
            : join(lastScanRoot, candidate.relativeRoot || candidate.rootPath || '.');
        return {
            ...candidate,
            rootPath: root,
            entries: (candidate.entries || []).map((entry) => ({
                ...entry,
                absolutePath: isAbsolute(String(entry.absolutePath || ''))
                    ? entry.absolutePath
                    : join(root, entry.logicalPath),
            })),
            coverCandidates: (candidate.coverCandidates || []).map((cover) => {
                const relativeCover = cover.relativePath || cover.path;
                return {
                    ...cover,
                    path: isAbsolute(String(cover.path || ''))
                        ? cover.path
                        : join(root, relativeCover || basename(String(cover.path || ''))),
                };
            }),
        };
    });
    return clone;
}

export async function createHost({ libraryRoot, sourceRoot, allowOutsideRoot = false, allowedSourceRoots = [] } = {}) {
    if (!libraryRoot) throw new Error('libraryRoot is required');
    const allowedRoots = await normalizeAllowedSourceRoots(allowedSourceRoots);
    const root = await resolveLibraryRoot(libraryRoot, { allowOutsideRoot });
    const source = sourceRoot ? resolve(String(sourceRoot)) : null;
    if (source) {
        const insideExperiment = isInside(EXPERIMENT_ROOT, source);
        const authorized = allowedRoots.some((allowed) => isInside(allowed, source));
        if (!insideExperiment && !authorized) {
            const error = new Error('sourceRoot is outside the experiment root and not in allowedSourceRoots');
            error.code = 'EOUTSIDE';
            throw error;
        }
    }
    const library = await openLibrary(root, { create: true, allowOutsideRoot });
    const creationStore = createCreationStore({ db: library.db, root });
    // A previous host process cannot have a live worker: the library root lock is
    // held by this process. Mark its unfinished batches interrupted so the UI does
    // not poll forever after a crash/restart.
    try {
        const timestamp = new Date().toISOString();
        library.db
            .prepare("UPDATE import_batch SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
            .run(timestamp);
        library.db
            .prepare("UPDATE import_batch_progress SET status = 'interrupted', phase = 'interrupted', message = 'host restarted before the batch finished', updated_at = ? WHERE status = 'running'")
            .run(timestamp);
    } catch {
        /* older libraries may not have the progress tables yet */
    }
    let lastScanRoot = source;
    const host = {
        library,
        root,
        libraryRoot: root,
        creationStore,
        saveCreationPost(post) {
            return creationStore.savePost(post);
        },
        listCreationPosts() {
            return creationStore.listPosts();
        },
        saveCreationAsset(input) {
            return creationStore.saveAsset(input);
        },
        deleteCreationPost(postId) {
            return creationStore.deletePost(postId);
        },
        deleteCreationAsset(assetId) {
            return creationStore.deleteAsset(assetId);
        },
        readCreationAsset(assetId) {
            return creationStore.readAsset(assetId);
        },
        sourceRoot: source,
        allowedSourceRoots: allowedRoots,
        allowOutsideRoot: allowOutsideRoot === true,
        libraryId: library.libraryId,
        async scan(options = {}) {
            if (!source) throw new Error('sourceRoot is required for scan');
            let scanRoot = source;
            if (options.relativeRoot && options.relativeRoot !== '.') {
                const relative = String(options.relativeRoot).replaceAll('\\', '/');
                if (relative.startsWith('/') || relative.split('/').includes('..')) {
                    const error = new Error('relativeRoot escapes the source root');
                    error.code = 'EPATHDENIED';
                    throw error;
                }
                scanRoot = resolve(source, relative);
                if (!isInside(source, scanRoot)) {
                    const error = new Error('relativeRoot escapes the source root');
                    error.code = 'EPATHDENIED';
                    throw error;
                }
            }
            lastScanRoot = scanRoot;
            const preview = await scanSource(scanRoot, {
                mode: 'single',
                libraryRoot: join(root, 'data'),
                ...options,
            });
            return redactPreview(preview, source);
        },
        /**
     * Import exactly one already-committed source file. Used by the Kikoeru
     * download pipeline so each completed file is validated and merged without
     * rescanning/hashing the whole work after every file.
     */
    async importFile(input = {}) {
        if (!this.sourceRoot) {
            const error = new Error('source is not configured on this host');
            error.code = 'EPATHDENIED';
            throw error;
        }
        const relativePath = String(input.relativePath || '').replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).join('/');
        const workRoot = String(input.workRoot || relativePath.split('/')[0] || '').replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).join('/');
        if (!relativePath || !workRoot) {
            const error = new Error('relativePath and workRoot are required');
            error.code = 'EBADREQUEST';
            throw error;
        }
        const root = resolve(this.sourceRoot, workRoot);
        const absolute = resolve(this.sourceRoot, relativePath);
        if (!isInside(this.sourceRoot, root) || !isInside(root, absolute)) {
            const error = new Error('import file is outside the work root');
            error.code = 'EPATHDENIED';
            throw error;
        }
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink()) {
            const error = new Error('import file must be a regular file');
            error.code = 'EBADREQUEST';
            throw error;
        }
        const logicalPath = relative(root, absolute).split(sep).join('/');
        const extension = extname(absolute).toLowerCase();
        const kind = ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.aiff', '.aif'].includes(extension)
            ? 'audio'
            : ['.srt', '.vtt', '.ass', '.ssa', '.lrc', '.sub'].includes(extension)
              ? 'subtitle'
              : ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'].includes(extension)
                ? 'image'
                : ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(extension)
                  ? 'archive'
                  : 'text';
        const targetWorkId = String(input.workId || '');
        const targetWork = targetWorkId
            ? this.library.db.prepare(`SELECT w.work_id, (SELECT source_code FROM source_ref WHERE work_id = w.work_id ORDER BY source_ref_id LIMIT 1) AS source_code
                FROM work w WHERE w.work_id = ? AND w.deleted_at IS NULL`).get(targetWorkId)
            : null;
        const candidateSourceCode = String(
            targetWork?.source_code ||
            input.metadata?.sourceCode ||
            ''
        ).match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
        const candidate = {
            candidateId: `local:${workRoot}`,
            relativeRoot: workRoot,
            rootPath: root,
            folderTitle: String(input.metadata?.title || basename(root)),
            circle: String(input.metadata?.circle || ''),
            cvs: Array.isArray(input.metadata?.cvs) ? input.metadata.cvs : [],
            sourceCode: candidateSourceCode,
            entries: [{
                logicalPath,
                absolutePath: absolute,
                name: basename(absolute),
                kind,
                size: info.size,
            }],
        };
        const fileKey = [
            'local:file',
            relativePath,
            info.size,
            Math.floor(Number(info.mtimeMs) || 0),
            String(candidateSourceCode || '').toUpperCase(),
            targetWorkId,
        ].join(':');
        let work;
        try {
            work = await ingestCandidate(this.library, candidate, {
                idempotencyKey: fileKey,
                allowedSourceRoots: this.allowedSourceRoots,
            });
        } catch (error) {
            // A downloaded file can legitimately be retried with newer metadata
            // (title/edition repair) while the same path/key has an older job.
            // Do not surface a stale idempotency-plan conflict for file imports.
            if (error?.code !== 'EIDEMPOTENCYCONFLICT') throw error;
            work = await ingestCandidate(this.library, candidate, {
                idempotencyKey: `${fileKey}:retry:${Date.now()}`,
                allowedSourceRoots: this.allowedSourceRoots,
            });
        }
        const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
        const patch = {};
        if (targetWork?.source_code) patch.sourceCode = String(targetWork.source_code);
        if (metadata.title) patch.title = String(metadata.title);
        if (metadata.circle) patch.circle = String(metadata.circle);
        if (Array.isArray(metadata.cvs)) patch.cvs = metadata.cvs;
        for (const key of ['tags', 'rating', 'ratingCount', 'price', 'currency', 'release', 'ageCategory', 'nsfw', 'editionLang', 'editionLabel', 'sourceUrl', 'pageUrl', 'manifest', 'sourceCode', 'originalCode', 'editionCodes', 'artists', 'trueCircle']) {
            if (key === 'sourceCode' && targetWork?.source_code) continue;
            if (metadata[key] !== undefined) patch[key] = metadata[key];
        }
        try {
            if (work?.workId && Object.keys(patch).length) this.library.updateWorkMetadata(work.workId, patch);
        } catch (error) {
            console.warn('host import metadata patch skipped:', error?.message || error);
        }
        if (work?.workId) await this.dedupeWorkContent(work.workId).catch(() => {});
        return work;
    },

        async workRootForWork(workId) {
            const work = this.library.db
                .prepare('SELECT work_id, title FROM work WHERE work_id = ? AND deleted_at IS NULL')
                .get(String(workId));
            if (!work) return null;
            const ref = this.library.db
                .prepare('SELECT snapshot_json FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1')
                .get(String(workId));
            try {
                const snapshot = JSON.parse(ref?.snapshot_json || '{}');
                const first = (snapshot?.sourceRecord?.entries || [])[0];
                const logicalParts = String(first?.logicalPath || '').split('/').filter(Boolean);
                if (first?.sourcePath && logicalParts.length) {
                    let current = resolve(String(first.sourcePath));
                    for (const unused of logicalParts) current = dirname(current);
                    if (isInside(this.sourceRoot, current) && await pathExists(current)) return current;
                }
            } catch {
                // fall through to entry path
            }
            const entry = this.library.db
                .prepare('SELECT original_path, logical_path FROM entry WHERE work_id = ? LIMIT 1')
                .get(String(workId));
            if (entry?.original_path) {
                let current = resolve(String(entry.original_path));
                for (const unused of String(entry.logical_path || '').split('/').filter(Boolean)) current = dirname(current);
                if (isInside(this.sourceRoot, current)) return current;
            }
            return null;
        },
        async saveVoiceBundle(input = {}) {
            if (!this.sourceRoot) {
                const error = new Error('source is not configured on this host');
                error.code = 'EPATHDENIED';
                throw error;
            }
            const rootName = String(input.rootName || input.metadata?.rootName || '').replaceAll(String.fromCharCode(92), '/').replace(/^\/+|\/+$/g, '');
            const metadata = {
                ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
                rootName,
            };
            // The manifest still belongs in the database (`user_meta.manifest`); only
            // the on-disk copy went away.
            const manifest = input.manifest && typeof input.manifest === 'object' ? input.manifest : null;
            if (!rootName || rootName.split('/').includes('..')) {
                const error = new Error('rootName is invalid');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const root = resolve(this.sourceRoot, rootName);
            if (!isInside(this.sourceRoot, root) || root === this.sourceRoot) {
                const error = new Error('voice root is outside the source root');
                error.code = 'EPATHDENIED';
                throw error;
            }
            const sidecar = join(root, '.monochrome');
            await mkdir(sidecar, { recursive: true });
            // Only the cover lives here. `metadata.json`/`manifest.json` are gone on
            // purpose (docs/16 §2.6): the database is the only authority, and the
            // copies were never read back — they only gave a second write path that
            // could drift and blank out `circle`. Rust already behaves this way;
            // this file kept writing them, so a Node-host session still produced
            // them and made the contract look inconsistent.
            const coverCandidates = [];
            if (input.coverUrl) coverCandidates.push(String(input.coverUrl));
            const originalCoverCode = Array.isArray(metadata.editionCodes)
                ? metadata.editionCodes.find((edition) => edition?.isOriginal)?.code
                : '';
            const coverCode = String(originalCoverCode || metadata.originalCode || metadata.sourceCode || metadata.code || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
            if (coverCode) {
                const number = Number(coverCode.slice(2));
                if (Number.isFinite(number)) {
                    const block = String(Math.ceil(number / 1000) * 1000).padStart(8, '0');
                    coverCandidates.push(`https://img.dlsite.jp/modpub/images2/work/doujin/RJ${block}/${coverCode}_img_main.webp`);
                }
            }
            for (const candidate of coverCandidates) {
                try {
                    const url = new URL(candidate);
                    if (!['http:', 'https:'].includes(url.protocol)) continue;
                    const response = await fetch(url, { signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined });
                    if (!response.ok) continue;
                    const buffer = Buffer.from(await response.arrayBuffer());
                    if (buffer.length > 0 && buffer.length <= 20 * 1024 * 1024) {
                        await writeFile(join(sidecar, 'folder.jpg'), buffer);
                        break;
                    }
                } catch {
                    // Try the next candidate; cover remains best-effort.
                }
            }
            const entries = [];
            for (const relative of ['.monochrome/folder.jpg']) {
                const absolute = join(root, ...relative.split('/'));
                let info;
                try {
                    info = await lstat(absolute);
                } catch {
                    continue;
                }
                entries.push({
                    logicalPath: relative,
                    absolutePath: absolute,
                    name: basename(absolute),
                    kind: /folder\.(jpe?g|png|webp|avif)$/i.test(relative) ? 'image' : 'text',
                    size: info.size,
                });
            }
            const candidate = {
                candidateId: `local:${rootName}`,
                relativeRoot: rootName,
                rootPath: root,
                folderTitle: String(metadata.title || rootName),
                circle: String(metadata.circle || ''),
                cvs: Array.isArray(metadata.cvs) ? metadata.cvs : Array.isArray(metadata.artists) ? metadata.artists : [],
                sourceCode: String(metadata.sourceCode || metadata.code || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '',
                entries,
            };
            const work = await ingestCandidate(this.library, candidate, {
                idempotencyKey: `local:bundle:${rootName}`,
                allowedSourceRoots: this.allowedSourceRoots,
            });
            const patch = {
                title: metadata.title ? String(metadata.title) : undefined,
                circle: metadata.circle ? String(metadata.circle) : undefined,
                cvs: Array.isArray(metadata.cvs) ? metadata.cvs : Array.isArray(metadata.artists) ? metadata.artists : undefined,
                tags: metadata.tags,
                rating: metadata.rating,
                ratingCount: metadata.ratingCount,
                price: metadata.price,
                currency: metadata.currency,
                release: metadata.release,
                ageCategory: metadata.ageCategory,
                nsfw: metadata.nsfw,
                sourceCode: metadata.sourceCode,
                editionCodes: metadata.editionCodes,
                sourceUrl: metadata.sourceUrl,
                pageUrl: metadata.pageUrl,
                manifest,
            };
            for (const key of Object.keys(patch)) {
                if (patch[key] === undefined) delete patch[key];
                if (key === 'ageCategory' && !String(patch[key] || '').trim()) delete patch[key];
            }
            if (work?.workId && Object.keys(patch).length) this.library.updateWorkMetadata(work.workId, patch);
            return work;
        },
        async cacheWorkCover(workId, remoteUrl) {
            if (!source) {
                const error = new Error('source is not configured on this host');
                error.code = 'EPATHDENIED';
                throw error;
            }
            let url;
            try {
                url = new URL(String(remoteUrl || ''));
            } catch {
                const error = new Error('cover URL is invalid');
                error.code = 'EBADREQUEST';
                throw error;
            }
            if (!['http:', 'https:'].includes(url.protocol)) {
                const error = new Error('cover URL must be http(s)');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const work = library.db.prepare('SELECT * FROM work WHERE work_id = ? AND deleted_at IS NULL').get(String(workId));
            if (!work) {
                const error = new Error('work not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            // Entry logical paths are relative to the work root, so the first
            // path segment is often a subfolder such as "附赠" or "mp3", not the
            // work root. Recover the real root from the source snapshot's
            // absolute entry path before writing folder.jpg there.
            const sourceRef = library.db
                .prepare('SELECT snapshot_json FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1')
                .get(work.work_id);
            let rootName = '';
            try {
                const snapshot = JSON.parse(sourceRef?.snapshot_json || '{}');
                const firstSource = (snapshot?.sourceRecord?.entries || [])[0];
                const logicalParts = String(firstSource?.logicalPath || '').split('/').filter(Boolean);
                if (firstSource?.sourcePath && logicalParts.length) {
                    let rootPath = resolve(String(firstSource.sourcePath));
                    for (let index = 0; index < logicalParts.length; index += 1) rootPath = dirname(rootPath);
                    if (isInside(source, rootPath)) {
                        const rel = relative(source, rootPath).split(sep).join('/');
                        if (rel) rootName = rel;
                    }
                }
            } catch {
                rootName = '';
            }
            if (!rootName) {
                const error = new Error('work has no source root');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const root = resolve(source, rootName);
            if (!isInside(source, root)) {
                const error = new Error('work root is outside the source root');
                error.code = 'EPATHDENIED';
                throw error;
            }
            const response = await fetch(url, { signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined });
            if (!response.ok) throw new Error(`cover download failed: HTTP ${response.status}`);
            const contentType = String(response.headers.get('content-type') || '');
            if (contentType && !contentType.toLowerCase().startsWith('image/')) {
                throw new Error(`cover URL is not an image: ${contentType}`);
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('cover image has an invalid size');
            await mkdir(root, { recursive: true });
            const target = join(root, '.monochrome', 'folder.jpg');
            await mkdir(join(root, '.monochrome'), { recursive: true });
            await writeFile(target, bytes);
            let cvs = [];
            try { cvs = JSON.parse(work.cv_json || '[]'); } catch { cvs = []; }
            await this.importFile({
                relativePath: `${rootName}/.monochrome/folder.jpg`,
                workRoot: rootName,
                metadata: { title: work.user_title || work.title, circle: work.circle, cvs },
            });
            return { logicalPath: `${rootName}/.monochrome/folder.jpg`, bytes: bytes.length };
        },

    async importCandidates(preview, options = {}) {
            if (!preview || !Array.isArray(preview.candidates)) throw new Error('preview.candidates is required');
            const batchId = String(options.batchId || `batch:web:${Date.now()}-${process.pid}`);
            const runOptions = {
                ...options,
                batchId,
                allowedSourceRoots: [...allowedRoots, ...(options.allowedSourceRoots || [])],
            };
            if (options.async === true) {
                const promise = ingestPreview(library, hydratePreview(preview, lastScanRoot), runOptions);
                promise.catch((error) => {
                    try {
                        library.db
                            .prepare("UPDATE import_batch SET status = 'failed', updated_at = ? WHERE batch_id = ?")
                            .run(new Date().toISOString(), batchId);
                        library.db
                            .prepare("UPDATE import_batch_progress SET status = 'failed', phase = 'failed', message = ?, updated_at = ? WHERE batch_id = ?")
                            .run(String(error?.message || error), new Date().toISOString(), batchId);
                    } catch {
                        /* progress is best-effort when the worker itself failed */
                    }
                });
                return { batchId, libraryId: library.libraryId, status: 'running', async: true };
            }
            return ingestPreview(library, hydratePreview(preview, lastScanRoot), runOptions);
        },
        getBatchProgress(batchId) {
            const batch = library.db
                .prepare('SELECT * FROM import_batch WHERE batch_id = ? AND library_id = ?')
                .get(String(batchId), library.libraryId);
            if (!batch) return null;
            const progress = library.db
                .prepare('SELECT * FROM import_batch_progress WHERE batch_id = ? AND library_id = ?')
                .get(batch.batch_id, library.libraryId) || null;
            const events = library.db
                .prepare('SELECT event_id, level, message, payload_json, created_at FROM import_batch_event WHERE batch_id = ? ORDER BY event_id DESC LIMIT 50')
                .all(batch.batch_id)
                .reverse()
                .map((event) => {
                    let payload = {};
                    try {
                        payload = JSON.parse(event.payload_json);
                    } catch {
                        payload = {};
                    }
                    return {
                        eventId: event.event_id,
                        level: event.level,
                        message: event.message,
                        payload,
                        createdAt: event.created_at,
                    };
                });
            return {
                batchId: batch.batch_id,
                status: progress?.status || batch.status,
                phase: progress?.phase || null,
                currentCandidate: progress?.current_candidate || 0,
                totalCandidates: progress?.total_candidates || 0,
                candidateId: progress?.candidate_id || null,
                currentEntry: progress?.current_entry || 0,
                totalEntries: progress?.total_entries || 0,
                bytesDone: progress?.bytes_done || 0,
                bytesTotal: progress?.bytes_total || 0,
                imported: progress?.imported || 0,
                updated: progress?.updated || 0,
                skipped: progress?.skipped || 0,
                failed: progress?.failed || 0,
                message: progress?.message || '',
                events,
                createdAt: batch.created_at,
                updatedAt: progress?.updated_at || batch.updated_at,
            };
        },
        /**
         * One physical file per sha256 inside a work. A second edition often
         * contains byte-identical audio under a different logical path; keep the
         * first file and turn the duplicate manifest entry into an alias so the
         * UI can still show the edition path and play the same content.
         */
        async dedupeWorkContent(workId) {
            const work = this.library.db
                .prepare('SELECT work_id, user_meta_json FROM work WHERE work_id = ? AND deleted_at IS NULL')
                .get(String(workId));
            if (!work) return { aliases: 0 };
            let meta = {};
            try { meta = JSON.parse(work.user_meta_json || '{}'); } catch { meta = {}; }
            const manifest = Array.isArray(meta.manifest) ? meta.manifest : Array.isArray(meta.manifest?.entries) ? meta.manifest.entries : null;
            if (!Array.isArray(manifest)) return { aliases: 0 };
            const dbEntries = this.library.db
                .prepare(`SELECT e.entry_id, e.logical_path, e.original_path,
                    (SELECT a.sha256 FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id WHERE r.entry_id = e.entry_id LIMIT 1) AS sha256
                    FROM entry e WHERE e.work_id = ?`)
                .all(String(workId));
            const byLogical = new Map(dbEntries.map((entry) => [String(entry.logical_path).replaceAll(String.fromCharCode(92), '/'), entry]));
            const canonicalByHash = new Map();
            let aliases = 0;
            let removed = 0;
            for (const entry of manifest) {
                if (entry.status !== 'local' || !entry.hash) continue;
                const hash = String(entry.hash);
                const logical = String(entry.logicalPath || '').replaceAll(String.fromCharCode(92), '/');
                const duplicate = byLogical.get(logical);
                // An alias entry normally has no physical host entry. If a later
                // download wrote that path again, remove the duplicate file/entry
                // while keeping the alias manifest row.
                if (entry.aliasOf) {
                    if (duplicate) {
                        if (duplicate.original_path) await rm(resolve(String(duplicate.original_path)), { force: true }).catch(() => {});
                        this.library.db.prepare('DELETE FROM entry WHERE entry_id = ?').run(duplicate.entry_id);
                        removed += 1;
                    }
                    continue;
                }
                const canonical = canonicalByHash.get(hash);
                if (!canonical) {
                    canonicalByHash.set(hash, entry);
                    continue;
                }
                if (duplicate) {
                    if (duplicate.original_path) await rm(resolve(String(duplicate.original_path)), { force: true }).catch(() => {});
                    this.library.db.prepare('DELETE FROM entry WHERE entry_id = ?').run(duplicate.entry_id);
                }
                entry.aliasOf = canonical.logicalPath;
                aliases += 1;
                removed += 1;
            }
            if (aliases > 0 || removed > 0) {
                const nextManifest = { version: 2, generatedAt: new Date().toISOString(), entries: manifest };
                this.library.updateWorkMetadata(String(workId), { manifest: nextManifest });
            }
            return { aliases };
        },
        async reconcileWork(workId) {
            if (!this.sourceRoot) throw new Error('source is not configured on this host');
            const work = this.library.db
                .prepare('SELECT work_id, title, user_meta_json FROM work WHERE work_id = ? AND deleted_at IS NULL')
                .get(String(workId));
            if (!work) {
                const error = new Error('work not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            const sourceCode = String(this.library.db
                .prepare('SELECT source_code FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1')
                .get(String(workId))?.source_code || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
            const root = await this.workRootForWork(workId);
            if (!root) {
                const error = new Error('work root not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            let meta = {};
            try { meta = JSON.parse(work.user_meta_json || '{}'); } catch { meta = {}; }
            const manifest = Array.isArray(meta.manifest) ? meta.manifest : Array.isArray(meta.manifest?.entries) ? meta.manifest.entries : [];
            const originalCode = String(meta.originalCode || (Array.isArray(meta.editionCodes) ? (meta.editionCodes.find((edition) => edition?.isOriginal)?.code || meta.editionCodes[0]?.code) : '') || sourceCode).toUpperCase();
            for (const entry of manifest) {
                if (!entry.editionCode) entry.editionCode = entry.aliasOf ? originalCode : sourceCode;
            }
            const dbEntries = this.library.db
                .prepare(`SELECT e.entry_id, e.logical_path, e.original_path, e.kind, e.mime,
                    (SELECT a.sha256 FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id WHERE r.entry_id = e.entry_id LIMIT 1) AS sha256,
                    (SELECT a.bytes FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id WHERE r.entry_id = e.entry_id LIMIT 1) AS bytes
                    FROM entry e WHERE e.work_id = ?`)
                .all(String(workId));
            const byPath = new Map(dbEntries.map((entry) => [String(entry.logical_path).replaceAll(String.fromCharCode(92), '/'), entry]));
            const actual = [];
            const walk = async (directory) => {
                let children;
                try { children = await readdir(directory, { withFileTypes: true }); } catch { return; }
                for (const child of children) {
                    const absolute = join(directory, child.name);
                    if (child.isDirectory()) {
                        if (child.name === '.monochrome' || child.name.startsWith('.')) continue;
                        await walk(absolute);
                        continue;
                    }
                    if (!child.isFile()) continue;
                    const relativePath = relative(root, absolute).split(sep).join('/');
                    if (relativePath === 'folder.jpg' || /(^|\/)cover\//i.test(relativePath)) continue;
                    const info = await stat(absolute);
                    let hashed = byPath.get(relativePath);
                    const sha256 = hashed && Number(hashed.bytes) === info.size ? hashed.sha256 : (await hashFile(absolute)).sha256;
                    actual.push({ absolute, relativePath, sha256, bytes: info.size });
                }
            };
            await walk(root);
            const actualPaths = new Set(actual.map((file) => file.relativePath));
            const actualHashes = new Set(actual.map((file) => file.sha256));
            const nextManifest = manifest.map((entry) => ({ ...entry }));
            const manifestByPath = new Map(nextManifest.map((entry) => [String(entry.logicalPath || '').replaceAll(String.fromCharCode(92), '/'), entry]));
            const manifestByHash = new Map();
            for (const entry of nextManifest) {
                if (!entry.hash) continue;
                if (!manifestByHash.has(String(entry.hash))) manifestByHash.set(String(entry.hash), []);
                manifestByHash.get(String(entry.hash)).push(entry);
            }
            const usedManifest = new Set();
            const findManifest = (file) => {
                const exact = manifestByPath.get(file.relativePath);
                if (exact && !usedManifest.has(exact)) return exact;
                const candidates = manifestByHash.get(String(file.sha256)) || [];
                return candidates.find((entry) => !usedManifest.has(entry) &&
                    !actualPaths.has(String(entry.logicalPath || '').replaceAll(String.fromCharCode(92), '/'))) || null;
            };
            let added = 0;
            let renamed = 0;
            let removed = 0;
            for (const file of actual) {
                let entry = findManifest(file);
                if (entry) {
                    usedManifest.add(entry);
                    if (entry.logicalPath !== file.relativePath) renamed += 1;
                    entry.logicalPath = file.relativePath;
                    entry.title = file.relativePath.split('/').pop();
                    entry.hash = file.sha256;
                    entry.bytes = file.bytes;
                    entry.status = 'local';
                    // A physically present path is canonical again; an old alias
                    // must not make dedupe remove the only remaining copy.
                    delete entry.aliasOf;
                } else {
                    entry = {
                        logicalPath: file.relativePath,
                        title: file.relativePath.split('/').pop(),
                        kind: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(file.relativePath.split('.').pop()?.toLowerCase()) ? 'audio' : 'file',
                        hash: file.sha256,
                        editionCode: sourceCode,
                        status: 'local',
                        mediaStreamUrl: '',
                        mediaDownloadUrl: '',
                        duration: 0,
                        mime: '',
                        bytes: file.bytes,
                    };
                    nextManifest.push(entry);
                    usedManifest.add(entry);
                    added += 1;
                }
                const dbEntry = byPath.get(file.relativePath);
                if (!dbEntry) {
                    try {
                        await this.importFile({
                            relativePath: `${relative(this.sourceRoot, root).split(sep).join('/')}/${file.relativePath}`,
                            workRoot: relative(this.sourceRoot, root).split(sep).join('/'),
                            metadata: { title: work.title },
                        });
                    } catch {
                        // Keep the manifest entry even if the host import is retried later.
                    }
                }
            }
            const aliasLocalHashes = new Set(nextManifest
                .filter((entry) => entry.aliasOf && actualHashes.has(String(entry.hash || '')))
                .map((entry) => String(entry.hash)));
            for (const entry of nextManifest) {
                const logical = String(entry.logicalPath || '').replaceAll(String.fromCharCode(92), '/');
                if (entry.status === 'local' && !actualPaths.has(logical) && !aliasLocalHashes.has(String(entry.hash || ''))) {
                    entry.status = 'missing';
                    removed += 1;
                }
            }
            // Remove host entries whose files no longer exist. The manifest stays
            // the authoritative full list and records their missing/remote state.
            for (const entry of dbEntries) {
                const logical = String(entry.logical_path || '').replaceAll(String.fromCharCode(92), '/');
                if (logical.startsWith('.monochrome/')) continue;
                if (entry.kind === 'cover' || /(^|\/)folder\.(jpe?g|png|webp|avif)$/i.test(logical)) continue;
                if (actualPaths.has(logical)) continue;
                this.library.db.prepare('DELETE FROM entry WHERE entry_id = ?').run(entry.entry_id);
            }
            this.library.db.prepare('UPDATE work SET updated_at = ? WHERE work_id = ?').run(new Date().toISOString(), String(workId));
            const reconciledManifest = { version: 2, generatedAt: new Date().toISOString(), entries: nextManifest };
            this.library.updateWorkMetadata(String(workId), { manifest: reconciledManifest });
            await this.dedupeWorkContent(workId);
            return { workId: String(workId), added, renamed, removed, files: actual.length };
        },
        async deleteWorks(workIds) {
            if (!Array.isArray(workIds) || workIds.length === 0) {
                const error = new Error('workIds must be a non-empty array');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const results = [];
            for (const workId of [...new Set(workIds.map(String))]) {
                try {
                    const work = this.library.db
                        .prepare('SELECT work_id, title FROM work WHERE work_id = ? AND deleted_at IS NULL')
                        .get(String(workId));
                    if (!work) {
                        // `folderRemoved: false` is the honest answer for "row gone but the
                        // folder survived"; Rust learned the same field, so the wire shape
                        // must match or rust-diff reports a difference.
                        results.push({ workId, ok: true, deleted: false, folderRemoved: true });
                        continue;
                    }
                    const workRoot = await this.workRootForWork(String(workId));
                    const entries = this.library.db
                        .prepare('SELECT entry_id, original_path FROM entry WHERE work_id = ?')
                        .all(String(workId));
                    const assets = this.library.db
                        .prepare(`SELECT DISTINCT a.asset_id, a.rel_path FROM asset a
                            JOIN asset_ref r ON r.asset_id = a.asset_id WHERE r.work_id = ?`)
                        .all(String(workId));
                    const roots = new Set();
                    const otherActiveEntries = this.library.db
                        .prepare(`SELECT e.original_path FROM entry e JOIN work w ON w.work_id = e.work_id
                            WHERE e.work_id <> ? AND w.deleted_at IS NULL AND e.original_path IS NOT NULL`)
                        .all(String(workId));
                    for (const entry of entries) {
                        if (!entry.original_path) continue;
                        const source = resolve(String(entry.original_path));
                        if (!this.sourceRoot || !isInside(this.sourceRoot, source)) continue;
                        if (otherActiveEntries.some((other) => resolve(String(other.original_path)) === source)) {
                            // Never delete a file/root shared by another active work.
                            continue;
                        }
                        roots.add(dirname(source));
                        await rm(source, { force: true }).catch(() => {});
                    }
                    // Import-job history references committed_work_id without a
                    // cascade; detach it before hard-deleting the work.
                    this.library.db.prepare('UPDATE import_job SET committed_work_id = NULL, committed_at = NULL, committed_revision = NULL WHERE committed_work_id = ?').run(String(workId));
                    // Hard-purge the work row; FK cascade removes entries/refs/
                    // source_ref/user_state. The work must not remain a soft-deleted
                    // ghost after the user explicitly deleted it.
                    this.library.db.prepare('DELETE FROM work WHERE work_id = ?').run(String(workId));
                    for (const asset of assets) {
                        const refs = this.library.db.prepare('SELECT COUNT(*) AS n FROM asset_ref WHERE asset_id = ?').get(asset.asset_id)?.n || 0;
                        if (refs > 0) continue;
                        if (asset.rel_path && !String(asset.rel_path).startsWith('source/')) {
                            const assetPath = join(this.library.root, 'data', ...String(asset.rel_path).split('/'));
                            if (isInside(join(this.library.root, 'data'), assetPath)) await rm(assetPath, { force: true }).catch(() => {});
                        }
                        this.library.db.prepare('DELETE FROM asset WHERE asset_id = ?').run(asset.asset_id);
                    }
                    const sharedRoot = workRoot && otherActiveEntries.some((other) => isInside(workRoot, resolve(String(other.original_path))));
                    // A recursive delete can lose a race with whatever still holds one
                    // of the files (a cover the webview is displaying, an antivirus
                    // scan). Retry before giving up, and say whether the folder is
                    // really gone: silently claiming success is how a work kept
                    // coming back as an empty folder with only `.monochrome` inside.
                    let folderRemoved = true;
                    if (workRoot && this.sourceRoot && isInside(this.sourceRoot, workRoot) && workRoot !== this.sourceRoot && !sharedRoot) {
                        folderRemoved = false;
                        for (let attempt = 0; attempt < 3 && !folderRemoved; attempt += 1) {
                            try {
                                await rm(workRoot, { recursive: true, force: true });
                                folderRemoved = true;
                            } catch {
                                await new Promise((resolve) => setTimeout(resolve, 120));
                            }
                        }
                    }
                    if (this.sourceRoot) {
                        for (const parent of roots) {
                            let current = parent;
                            while (current && current !== this.sourceRoot && isInside(this.sourceRoot, current)) {
                                try { await rmdir(current); } catch { break; }
                                current = dirname(current);
                            }
                        }
                    }
                    results.push({ workId, ok: true, deleted: true, folderRemoved });
                } catch (error) {
                    results.push({ workId, ok: false, error: String(error?.message || error), code: error?.code || null });
                }
            }
            return { works: results, deleted: results.filter((result) => result.ok).length };
        },
        /**
         * Remove selected logical files from a managed work. This is a
         * per-file delete, not a work soft-delete: source files, entry rows and
         * unreferenced CAS assets are removed so the library reflects it.
         */
        async deleteWorkFiles(workId, logicalPaths) {
            if (!Array.isArray(logicalPaths) || logicalPaths.length === 0) {
                const error = new Error('logicalPaths must be a non-empty array');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const work = this.library.db
                .prepare('SELECT work_id, title, user_meta_json FROM work WHERE work_id = ? AND deleted_at IS NULL')
                .get(String(workId));
            if (!work) {
                const error = new Error('work not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            const deleted = [];
            const missing = [];
            const removedSources = new Set();
            let aliases = 0;
            let manifest = null;
            try {
                const meta = JSON.parse(work.user_meta_json || '{}');
                manifest = Array.isArray(meta.manifest) ? meta.manifest : Array.isArray(meta.manifest?.entries) ? meta.manifest.entries : null;
            } catch {
                manifest = null;
            }
            const markManifestRemote = (logicalPath) => {
                if (!Array.isArray(manifest)) return;
                const target = manifest.find((item) => String(item?.logicalPath) === String(logicalPath));
                const targetHash = target?.hash ? String(target.hash) : '';
                let changed = false;
                for (const item of manifest) {
                    const samePath = String(item?.logicalPath) === String(logicalPath);
                    const sameContent = targetHash && String(item?.hash || '') === targetHash;
                    const isAlias = String(item?.aliasOf || '') === String(logicalPath);
                    if ((samePath || sameContent || isAlias) && item.status !== 'remote') {
                        item.status = 'remote';
                        // Keep remote media URLs: deleting a local copy must not make
                        // the online source undownloadable (plan needs a URL).
                        changed = true;
                    }
                }
                if (changed) {
                    this.library.updateWorkMetadata(String(workId), { manifest: { version: 2, entries: manifest } });
                }
            };
            const isCoverPath = (logicalPath) => {
                const normalized = String(logicalPath || '').replaceAll(String.fromCharCode(92), '/');
                const name = normalized.split('/').pop() || '';
                return /^folder\.(jpe?g|png|webp|avif)$/i.test(name) || /(^|\/)cover(\/|$)/i.test(normalized) || /(^|\/)\.monochrome\/folder\.(jpe?g|png|webp|avif)$/i.test(normalized);
            };
            const refreshWorkState = (targetWorkId) => {
                const remaining = this.library.db
                    .prepare('SELECT logical_path FROM entry WHERE work_id = ?')
                    .all(String(targetWorkId));
                if (Array.isArray(manifest) && manifest.some((entry) => entry?.status !== 'local')) {
                    try {
                        this.library.updateWorkMetadata(String(targetWorkId), { partial: true });
                    } catch {
                        // concurrent cleanup
                    }
                    return;
                }
                if (!remaining.some((entry) => !isCoverPath(entry.logical_path))) {
                    // Only cover artifacts remain: this is not a partial local
                    // work any more. Retire it so the online card can return
                    // as a normal remote result.
                    this.library.db.prepare('UPDATE work SET deleted_at = ?, updated_at = ? WHERE work_id = ?')
                        .run(new Date().toISOString(), new Date().toISOString(), String(targetWorkId));
                    return;
                }
                try {
                    this.library.updateWorkMetadata(String(targetWorkId), { partial: true });
                } catch {
                    // the work may have been removed by another concurrent cleanup
                }
            };
            const deleteEntryAndAssets = (entry) => {
                const assets = this.library.db
                    .prepare('SELECT a.asset_id, a.rel_path FROM asset_ref r JOIN asset a ON a.asset_id = r.asset_id WHERE r.entry_id = ?')
                    .all(entry.entry_id);
                this.library.db.prepare('DELETE FROM entry WHERE entry_id = ?').run(entry.entry_id);
                for (const asset of assets) {
                    const refs = this.library.db.prepare('SELECT COUNT(*) AS n FROM asset_ref WHERE asset_id = ?').get(asset.asset_id)?.n || 0;
                    if (refs > 0) continue;
                    if (asset.rel_path && !String(asset.rel_path).startsWith('source/')) {
                        const assetPath = join(this.library.root, 'data', ...String(asset.rel_path).split('/'));
                        if (isInside(join(this.library.root, 'data'), assetPath)) rm(assetPath, { force: true }).catch(() => {});
                    }
                    this.library.db.prepare('DELETE FROM asset WHERE asset_id = ?').run(asset.asset_id);
                }
                this.library.db.prepare('UPDATE work SET updated_at = ? WHERE work_id = ?')
                    .run(new Date().toISOString(), String(entry.work_id || workId));
                refreshWorkState(entry.work_id || workId);
            };
            const pruneEmptyParents = async (startPath) => {
                if (!this.sourceRoot) return;
                let current = dirname(startPath);
                while (current && current !== this.sourceRoot && isInside(this.sourceRoot, current)) {
                    try {
                        await rmdir(current);
                    } catch {
                        break;
                    }
                    current = dirname(current);
                }
            };
            for (const logicalPath of [...new Set(logicalPaths.map(String))]) {
                const normalized = logicalPath.split(String.fromCharCode(92)).join('/').replace(/^[/]+/, '');
                if (!normalized || normalized.split('/').some((part) => part === '..')) {
                    missing.push({ path: logicalPath, reason: 'invalid path' });
                    continue;
                }
                const entry = this.library.db
                    .prepare('SELECT entry_id, work_id, original_path, logical_path FROM entry WHERE work_id = ? AND logical_path = ?')
                    .get(String(workId), normalized);
                if (!entry) {
                    // An alias has no host entry and no physical file, so this
                    // request cannot delete anything: it is an informative
                    // failure, not a successful removal. Report the canonical
                    // target and leave the alias row (status/aliasOf) untouched.
                    const manifestEntry = Array.isArray(manifest)
                        ? manifest.find((item) => String(item?.logicalPath) === normalized)
                        : null;
                    if (manifestEntry?.aliasOf) {
                        const canonical = manifest.find((item) => String(item?.logicalPath) === String(manifestEntry.aliasOf));
                        aliases += 1;
                        missing.push({
                            path: logicalPath,
                            reason: 'alias',
                            aliasOf: manifestEntry.aliasOf,
                            canonicalEditionCode: canonical?.editionCode ? String(canonical.editionCode).toUpperCase() : '',
                        });
                        continue;
                    }
                    missing.push({ path: logicalPath, reason: 'entry not found' });
                    continue;
                }
                // Duplicate imports can point at the same source file. Remove all
                // entry rows for that source too, otherwise the file is kept
                // alive and the folder still looks present in the library.
                const duplicates = entry.original_path
                    ? this.library.db.prepare('SELECT entry_id, work_id, original_path, logical_path FROM entry WHERE original_path = ? AND entry_id <> ?')
                        .all(entry.original_path, entry.entry_id)
                    : [];
                const source = entry.original_path
                    ? resolve(String(entry.original_path))
                    : this.sourceRoot ? resolve(this.sourceRoot, work.title, ...normalized.split('/')) : '';
                markManifestRemote(normalized);
                deleteEntryAndAssets(entry);
                for (const duplicate of duplicates) deleteEntryAndAssets(duplicate);
                if (this.sourceRoot && isInside(this.sourceRoot, source) && !removedSources.has(source)) {
                    removedSources.add(source);
                    await rm(source, { force: true }).catch(() => {});
                    await pruneEmptyParents(source);
                }
                deleted.push(normalized);
            }
            return { deleted, missing, aliases, count: deleted.length };
        },
        async cleanupImportTemps(workRoot = '') {
            if (!source) return { removed: 0, works: 0 };
            const requested = String(workRoot || '').replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean).join('/');
            const roots = [];
            if (requested) {
                const root = resolve(source, requested);
                if (root !== source && !isInside(source, root)) {
                    const error = new Error('workRoot is outside the source root');
                    error.code = 'EPATHDENIED';
                    throw error;
                }
                roots.push(root);
            } else {
                for (const entry of await readdir(source, { withFileTypes: true })) {
                    if (entry.isDirectory()) roots.push(join(source, entry.name));
                }
            }
            let removed = 0;
            let works = 0;
            for (const root of roots) {
                const tmp = join(root, 'tmp');
                let entries;
                try {
                    entries = await readdir(tmp, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const entry of entries) {
                    // Only this pipeline's `import-<timestamp>-<random>` staging
                    // dirs are ours; never delete a user's unrelated tmp files.
                    if (!entry.name.startsWith('import-')) continue;
                    await rm(join(tmp, entry.name), { recursive: true, force: true });
                    removed += 1;
                }
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    try {
                        await rmdir(tmp);
                        break;
                    } catch {
                        // Windows can briefly keep the directory handle open after
                        // the last staging file is removed; retry before leaving it.
                        await new Promise((resolve) => setTimeout(resolve, 60));
                    }
                }
                works += 1;
            }
            return { removed, works };
        },

        async cleanupPreview() {
            const works = library.db
                .prepare('SELECT work_id, title FROM work WHERE deleted_at IS NULL ORDER BY created_at, work_id')
                .all();
            const stale = [];
            for (const work of works) {
                const source = library.db
                    .prepare('SELECT snapshot_json FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1')
                    .get(work.work_id);
                let entries = [];
                try {
                    entries = JSON.parse(source?.snapshot_json || '{}')?.sourceRecord?.entries || [];
                } catch {
                    entries = [];
                }
                const paths = entries.map((entry) => entry.sourcePath).filter(Boolean);
                let missing = 0;
                for (const sourcePath of paths) {
                    if (!(await pathExists(sourcePath))) missing += 1;
                }
                if (paths.length > 0 && missing === paths.length) {
                    stale.push({ workId: work.work_id, title: work.title, missing, total: paths.length });
                }
            }
            return { works: stale, total: stale.length };
        },
        cleanupWorks(workIds) {
            if (!Array.isArray(workIds) || workIds.length === 0) {
                const error = new Error('workIds must be a non-empty array');
                error.code = 'EBADREQUEST';
                throw error;
            }
            const results = [];
            for (const workId of [...new Set(workIds.map(String))]) {
                try {
                    const work = library.softDeleteWork(workId);
                    results.push({ workId, ok: true, deleted: Boolean(work) });
                } catch (error) {
                    results.push({ workId, ok: false, error: String(error?.message || error), code: error?.code || null });
                }
            }
            return { works: results, deleted: results.filter((result) => result.ok).length };
        },
        updateWorkMetadata(workId, metadata) {
            return library.updateWorkMetadata(workId, metadata || {});
        },
        async listWorks() {
            const works = library.db
                .prepare('SELECT * FROM work WHERE deleted_at IS NULL ORDER BY created_at, work_id')
                .all();
            return Promise.all(works.map(async (work) => {
                const workRoot = await this.workRootForWork(work.work_id);
                const entries = library.db
                    .prepare(
                        `SELECT e.entry_id, e.stable_entry_id, e.logical_path, e.kind, e.mime,
                                e.display_title, e.sort_order, a.asset_id, a.sha256, a.bytes,
                                a.rel_path, a.mime AS asset_mime
                         FROM entry e
                         LEFT JOIN asset_ref r ON r.entry_id = e.entry_id
                         LEFT JOIN asset a ON a.asset_id = r.asset_id
                         WHERE e.work_id = ?
                         ORDER BY e.sort_order, e.entry_id`
                    )
                    .all(work.work_id);
                const source = library.db
                    .prepare('SELECT provider, source_code, source_url FROM source_ref WHERE work_id = ? ORDER BY source_ref_id LIMIT 1')
                    .get(work.work_id);
                // Never use an arbitrary first image as the library cover. Only
                // an explicit cover entry or the root folder.jpg is authoritative.
                const cover = entries.find((entry) => {
                    if (!entry.asset_id) return false;
                    if (entry.kind === 'cover') return true;
                    if (entry.kind !== 'image') return false;
                    const logical = String(entry.logical_path || '');
                    return /^folder\.(jpe?g|png|webp|avif)$/i.test(logical)
                        || /(^|\/)\.monochrome\/folder\.(jpe?g|png|webp|avif)$/i.test(logical)
                        || /(^|\/)folder\.(jpe?g|png|webp|avif)$/i.test(logical);
                });
                let cvs = [];
                try {
                    cvs = JSON.parse(work.cv_json);
                } catch {
                    cvs = [];
                }
                return {
                    workId: work.work_id,
                    workRoot: workRoot && this.sourceRoot ? relative(this.sourceRoot, workRoot).split(sep).join('/') : '',
                    title: work.title,
                    userTitle: work.user_title,
                    userMeta: (() => {
                        try { return JSON.parse(work.user_meta_json || '{}'); } catch { return {}; }
                    })(),
                    circle: work.circle,
                    cvs,
                    language: work.language,
                    role: work.role,
                    revision: Number(work.revision),
                    createdAt: work.created_at,
                    updatedAt: work.updated_at,
                    source: source
                        ? { provider: source.provider, sourceCode: source.source_code, sourceUrl: source.source_url || '' }
                        : null,
                    coverMediaPath: cover ? `/media/${encodeURIComponent(cover.entry_id)}` : null,
                    entries: entries.map((entry) => ({
                        entryId: entry.entry_id,
                        stableEntryId: entry.stable_entry_id,
                        logicalPath: entry.logical_path,
                        kind: entry.kind,
                        mime: entry.mime || entry.asset_mime || null,
                        displayTitle: entry.display_title,
                        bytes: entry.bytes == null ? null : Number(entry.bytes),
                        sha256: entry.sha256 || null,
                        mediaPath: entry.asset_id ? `/media/${encodeURIComponent(entry.entry_id)}` : null,
                    })),
                };
            }));
        },
        async backup(destination, options = {}) {
            return library.backupLibrary(destination, options);
        },
        async restore(backupDir, destination) {
            return restoreLibrary(backupDir, destination);
        },
        async exportWork(workId, destination, options = {}) {
            if (typeof library.exportWork === 'function') return library.exportWork(workId, destination, options);
            const { exportWork } = await import('./export.mjs');
            return exportWork(library, workId, destination, options);
        },
        async download(entryId, options = {}) {
            if (!options.sourceUrl) throw new Error('sourceUrl is required');
            if (!isLoopbackDownloadUrl(options.sourceUrl)) {
                const error = new Error('download sourceUrl must be a loopback HTTP(S) URL');
                error.code = 'ELOOPBACK';
                throw error;
            }
            const { beginDownload } = await import('./download.mjs');
            const task = await beginDownload(library, entryId, {
                sourceUrl: String(options.sourceUrl),
                expectedBytes: options.expectedBytes == null ? undefined : Number(options.expectedBytes),
                sourceVersion: options.sourceVersion == null ? undefined : String(options.sourceVersion),
            });
            await task.resume();
            await task.commit();
            return {
                taskId: task.taskId,
                entryId: task.entryId,
                status: task.status,
                assetId: task.assetId,
                sha256: task.finalSha || task.assetId,
                bytes: task.progress,
                expectedBytes: task.expectedBytes,
                sourceVersion: task.sourceVersion,
            };
        },
        /**
         * Rename/merge a managed work root to the canonical
         * [RJ][circle] title (CV ...) name without destroying either copy.
         */
        async normalizeWorkRoot(workId, targetRoot) {
            if (!this.sourceRoot) {
                const error = new Error('source is not configured on this host');
                error.code = 'EPATHDENIED';
                throw error;
            }
            const row = this.library.db
                .prepare('SELECT w.title, (SELECT source_code FROM source_ref WHERE work_id = w.work_id ORDER BY source_ref_id LIMIT 1) AS source_code FROM work w WHERE work_id = ? AND deleted_at IS NULL')
                .get(String(workId));
            if (!row) {
                const error = new Error('work not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            const sourceName = String(row.title || '');
            const targetName = String(targetRoot || '').trim();
            if (!targetName) return { changed: false, title: sourceName };
            let source = resolve(this.sourceRoot, sourceName);
            const target = resolve(this.sourceRoot, targetName);
            if (!isInside(this.sourceRoot, source) || !isInside(this.sourceRoot, target) || source === this.sourceRoot || target === this.sourceRoot) {
                const error = new Error('normalize target is outside the source root');
                error.code = 'EPATHDENIED';
                throw error;
            }
            let sourceInfo = null;
            try { sourceInfo = await stat(source); } catch { sourceInfo = null; }
            if (true) {
                const code = String(row.source_code || '').toUpperCase();
                const titleStem = sourceName.replace(/^[[^]]+]s*/, '').replace(/s*(CV[^)]*)s*$/i, '').trim();
                const entries = await readdir(this.sourceRoot, { withFileTypes: true }).catch(() => []);
                const legacy = entries.find((entry) => {
                    if (!entry.isDirectory()) return false;
                    const name = entry.name;
                    const upper = name.toUpperCase();
                    if (resolve(this.sourceRoot, name) === target) return false;
                    return (code && (upper.startsWith(code + '-') || upper.startsWith('[' + code + ']') || upper.includes(code))) ||
                        (titleStem.length > 4 && name.includes(titleStem));
                });
                if (legacy) {
                    source = resolve(this.sourceRoot, legacy.name);
                    try { sourceInfo = await stat(source); } catch { sourceInfo = null; }
                }
            }
            if (sourceInfo?.isDirectory() && source !== target) {
                let targetInfo = null;
                try { targetInfo = await stat(target); } catch { targetInfo = null; }
                if (!targetInfo?.isDirectory()) {
                    await rename(source, target);
                } else {
                    await mergeDirectory(source, target);
                    await rm(source, { recursive: true, force: true });
                }
            }
            // A rename must also rewrite every entry/source-snapshot absolute
            // path; otherwise delete/restore/reconcile still points at the old
            // folder and the work looks un-normalized.
            if (source !== target) {
                const oldPrefix = resolve(source);
                const newPrefix = resolve(target);
                for (const entry of this.library.db.prepare('SELECT entry_id, original_path, logical_path FROM entry WHERE work_id = ?').all(String(workId))) {
                    if (!entry.original_path || !String(entry.original_path).startsWith(oldPrefix)) continue;
                    const suffix = String(entry.original_path).slice(String(oldPrefix).length).replace(/^[\/]+/, '');
                    this.library.db.prepare('UPDATE entry SET original_path = ? WHERE entry_id = ?')
                        .run(join(newPrefix, ...suffix.split(/[\/]+/).filter(Boolean)), entry.entry_id);
                }
                const refs = this.library.db.prepare('SELECT source_ref_id, snapshot_json FROM source_ref WHERE work_id = ?').all(String(workId));
                for (const ref of refs) {
                    if (!ref.snapshot_json) continue;
                    try {
                        const snapshot = JSON.parse(ref.snapshot_json);
                        for (const entry of snapshot?.sourceRecord?.entries || []) {
                            if (!entry.sourcePath || !String(entry.sourcePath).startsWith(oldPrefix)) continue;
                            const suffix = String(entry.sourcePath).slice(String(oldPrefix).length).replace(/^[\/]+/, '');
                            entry.sourcePath = join(newPrefix, ...suffix.split(/[\/]+/).filter(Boolean));
                        }
                        this.library.db.prepare('UPDATE source_ref SET snapshot_json = ? WHERE source_ref_id = ?')
                            .run(JSON.stringify(snapshot), ref.source_ref_id);
                    } catch {
                        // keep snapshot as-is if malformed
                    }
                }
            }
            // Root name and display title are separate: the folder keeps
            // [RJ][circle] ... (CV ...), the card/detail title stays the plain work title.
            const currentWork = this.library.db.prepare('SELECT title FROM work WHERE work_id = ?').get(String(workId));
            const displayTitle = String(currentWork?.title || targetName).trim() || targetName;
            this.library.db
                .prepare('UPDATE work SET title = ?, updated_at = ? WHERE work_id = ?')
                .run(displayTitle, new Date().toISOString(), String(workId));
            return { changed: true, title: displayTitle, source: relative(this.sourceRoot, source), target: targetName };
        },
        /**
         * Open a work's managed source folder in the desktop file manager.
         * Work titles are the managed root folder name; if the folder is not
         * present (legacy/CAS-only row) fall back to the source root.
         */
        async openWorkLocation(workId) {
            if (!this.sourceRoot) {
                const error = new Error('source is not configured on this host');
                error.code = 'EPATHDENIED';
                throw error;
            }
            const row = this.library.db
                .prepare('SELECT w.title, (SELECT source_code FROM source_ref WHERE work_id = w.work_id ORDER BY source_ref_id LIMIT 1) AS source_code FROM work w WHERE work_id = ? AND deleted_at IS NULL')
                .get(String(workId));
            if (!row) {
                const error = new Error('work not found');
                error.code = 'ENOTFOUND';
                throw error;
            }
            let target = resolve(this.sourceRoot, String(row.title || ''));
            if (!isInside(this.sourceRoot, target)) target = this.sourceRoot;
            let info = null;
            try { info = await stat(target); } catch { info = null; }
            // Remote metadata can replace the display title; prefer a top-level
            // folder whose name contains the source code (our canonical root).
            if (!info?.isDirectory() && row.source_code) {
                const code = String(row.source_code).toUpperCase();
                const entries = await readdir(this.sourceRoot, { withFileTypes: true }).catch(() => []);
                const match = entries.find((entry) => entry.isDirectory() && entry.name.toUpperCase().includes(code));
                if (match) {
                    target = resolve(this.sourceRoot, match.name);
                    try { info = await stat(target); } catch { info = null; }
                }
            }
            if (!info?.isDirectory()) target = this.sourceRoot;
            const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
            spawn(command, [target], { detached: true, stdio: 'ignore' }).unref();
            return { opened: true, path: target === this.sourceRoot ? '.' : relative(this.sourceRoot, target) };
        },
        async verify() {
            return library.verifyLibrary();
        },
        async close() {
            await library.close();
        },
    };
    return host;
}

export { resolveLibraryRoot, redactPreview, hydratePreview, isLoopbackDownloadUrl };
