// S3: bridge a read-only S2 candidate/preview into the S1 library.
//
// The scanner never writes or hashes. This adapter is the first layer allowed to
// call library.importWork(), which re-validates every source path and streams bytes
// into CAS. Archives stay archives; only an explicit cover/folder/front/jacket/
// package image is promoted to a cover entry. No online metadata, no extraction.
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXPERIMENT_ROOT, isInside, normalizeAllowedSourceRoots, validateLogicalPath } from './paths.mjs';
import { selectCover, selectExplicitNameFallback } from './cover.mjs';

const COVER_STEMS = ['cover', 'folder', 'front', 'jacket', 'package'];
const COVER_RE = /^(cover|folder|front|jacket|package)$/i;

const MIME_BY_EXTENSION = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wma': 'audio/x-ms-wma',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff',
    '.srt': 'application/x-subrip',
    '.vtt': 'text/vtt',
    '.ass': 'text/x-ssa',
    '.ssa': 'text/x-ssa',
    '.lrc': 'text/plain',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.nfo': 'text/plain',
};

function mimeFor(pathOrName) {
    return MIME_BY_EXTENSION[extname(String(pathOrName || '')).toLowerCase()] || 'application/octet-stream';
}

function slash(value) {
    return String(value || '').replace(/\\/g, '/');
}

function isSameOrInside(parent, child) {
    const relPath = relative(resolve(parent), resolve(child));
    return relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath));
}

function deterministicEntryId(logicalPath) {
    // Deterministic from the logical path, never from an array index. S1 uses the
    // entry id in temp file names, so it must be short and Windows-safe: a hash of
    // the path avoids colon/Japanese/overlong-component failures in .part paths.
    const digest = createHash('sha1').update(String(logicalPath), 'utf8').digest('hex');
    return `local-entry-${digest.slice(0, 24)}`;
}

function candidateCoverList(candidate) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.coverCandidates)) return candidate.coverCandidates;
    return [];
}

function coverStem(name) {
    return basename(String(name || ''), extname(String(name || ''))).normalize('NFKC').trim();
}

/**
 * Select one local explicit cover candidate. The S3 rule is deliberately
 * narrower than the scanner's hints: only cover/folder/front/jacket/package
 * stems qualify; arbitrary images/CG are never silently selected.
 */
export function selectLocalCover(candidate) {
    const covers = candidateCoverList(candidate);
    const eligible = covers
        .filter((cover) => cover && (cover.path || cover.absolutePath))
        .filter((cover) => {
            const source = String(cover.source || '').toLowerCase();
            if (source && !['local', 'folder', 'folder-name', 'front', 'jacket', 'package'].includes(source)) return false;
            const name = cover.name || basename(String(cover.path || cover.absolutePath));
            return COVER_RE.test(coverStem(name)) && COVER_STEMS.includes(coverStem(name).toLowerCase());
        });
    if (!eligible.length) return null;
    const rank = (cover) => {
        const name = coverStem(cover.name || basename(String(cover.path || cover.absolutePath))).toLowerCase();
        return COVER_STEMS.indexOf(name);
    };
    eligible.sort((a, b) => rank(a) - rank(b) || String(a.path || a.absolutePath).localeCompare(String(b.path || b.absolutePath)));
    return eligible[0];
}

function candidateEntryPath(entry) {
    return entry?.absolutePath || entry?.path || null;
}

function normalizeLogical(value) {
    return validateLogicalPath(slash(value));
}

function stableLocalCode(candidate) {
    if (candidate?.sourceCode) return String(candidate.sourceCode);
    // The selected folder is the identity, not the scan root. Upload-single and
    // source-root batch modes produce different candidateIds for the same folder,
    // so using candidateId here creates duplicate works for one directory.
    const folder = basename(String(candidate?.rootPath || candidate?.relativeRoot || candidate?.folderTitle || 'work'));
    const rj = folder.match(/RJ\d{5,8}/i)?.[0]?.toUpperCase();
    return rj || `local:${folder}`;
}

async function validateCandidateRoot(candidate) {
    if (!candidate || typeof candidate !== 'object') throw new Error('candidate is required');
    if (!candidate.rootPath) throw new Error('candidate.rootPath is required');
    const root = resolve(candidate.rootPath);
    if (!isAbsolute(candidate.rootPath)) throw new Error('candidate.rootPath must be absolute');
    const info = await lstat(root);
    if (info.isSymbolicLink()) throw new Error('candidate.rootPath must not be a symlink/junction');
    if (!info.isDirectory()) throw new Error('candidate.rootPath must be a directory');
    if (!Array.isArray(candidate.entries)) throw new Error('candidate.entries must be an array');
    return root;
}

async function assertNoReparseAncestors(root, absolutePath) {
    const rel = relative(root, absolutePath);
    if (!rel || rel.startsWith('..')) return;
    let current = root;
    for (const part of rel.split(sep)) {
        current = join(current, part);
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error(`entry path contains a symlink/junction: ${absolutePath}`);
    }
}

async function validateEntryFile(root, absolutePath, logicalPath) {
    if (typeof absolutePath !== 'string' || !absolutePath) throw new Error(`entry path is required for ${logicalPath}`.trim());
    if (!isAbsolute(absolutePath)) throw new Error(`entry path must be absolute: ${absolutePath}`);
    const absolute = resolve(absolutePath);
    if (!isSameOrInside(root, absolute)) throw new Error(`entry escapes candidate root: ${absolutePath}`);
    await assertNoReparseAncestors(root, absolute);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`entry is a symlink/junction: ${absolutePath}`);
    if (!info.isFile()) throw new Error(`entry is not a regular file: ${absolutePath}`);
    return { absolute, size: info.size };
}

function coverAbsolutePath(root, cover) {
    const value = String(cover.path || cover.absolutePath || '');
    return isAbsolute(value) ? resolve(value) : join(root, value);
}

function logicalFromCover(root, cover) {
    const absolute = coverAbsolutePath(root, cover);
    if (!isSameOrInside(root, absolute)) throw new Error(`cover escapes candidate root: ${cover.path || cover.absolutePath}`);
    return slash(relative(root, absolute));
}

/**
 * Map a scan candidate to the S1 synthetic sourceRecord. This is pure except for
 * read-only lstat validation; it does not copy or hash bytes. The returned cover
 * entry reuses the existing logical entry when the scanner already listed it.
 */
function displayTitleFromFolder(title) {
    let text = String(title || '').trim();
    text = text.replace(/^\[RJ\d{5,8}\]\s*/i, '');
    const circle = text.match(/^\[[^\]]+\]\s*(.*)$/);
    if (circle) text = circle[1];
    text = text.replace(/\s*\((?:CV|cv)\s*[^)]*\)\s*$/, '').trim();
    text = text.replace(/\s*【\s*CV[.．:：]?[^】]*】/gi, '').replace(/\s*【\s*[Cc][Vv][^】]*】/g, '').trim();
    return text || String(title || '').trim();
}


export async function sourceRecordFromCandidate(candidate, options = {}) {
    const root = await validateCandidateRoot(candidate);
    const allowedRoots = await normalizeAllowedSourceRoots(options.allowedSourceRoots);
    if (!isInside(EXPERIMENT_ROOT, root) && !allowedRoots.some((allowed) => isInside(allowed, root))) {
        const error = new Error(`candidate root is outside the experiment root and not authorized: ${root}`);
        error.code = 'EOUTSIDE';
        throw error;
    }
    const seenLogical = new Set();
    const entries = [];

    for (const [index, candidateEntry] of candidate.entries.entries()) {
        if (!candidateEntry || typeof candidateEntry !== 'object') throw new Error(`entry[${index}] must be an object`);
        const logicalPath = normalizeLogical(candidateEntry.logicalPath);
        if (!logicalPath) throw new Error(`entry[${index}] logicalPath is required`);
        if (seenLogical.has(logicalPath)) throw new Error(`duplicate logical path in candidate: ${logicalPath}`);
        seenLogical.add(logicalPath);
        const absolutePath = candidateEntryPath(candidateEntry);
        const validated = await validateEntryFile(root, absolutePath, logicalPath);
        const kind = String(candidateEntry.kind || 'file');
        entries.push({
            entryId: deterministicEntryId(logicalPath),
            logicalPath,
            kind,
            sourcePath: validated.absolute,
            mime: mimeFor(candidateEntry.name || absolutePath || logicalPath),
            ...(candidateEntry.trackKey ? { trackKey: String(candidateEntry.trackKey) } : {}),
            ...(candidateEntry.format ? { format: String(candidateEntry.format) } : {}),
        });
    }

    let cover = null;
    try {
        cover = await selectCover(candidate, options);
    } catch (error) {
        // Manual paths are an explicit override: an invalid manual image must
        // surface, not silently fall back to another cover.
        if (options.manualPath || error?.code === 'ECOVER_TEMPDIR' || error?.code === 'ECOVER_INVALID') throw error;
        cover = null;
    }
    if (!cover) {
        const fallback = selectExplicitNameFallback(candidate);
        if (fallback) {
            let head = Buffer.alloc(0);
            try {
                const handle = await open(fallback.path, 'r');
                try {
                    head = Buffer.alloc(8);
                    const { bytesRead } = await handle.read(head, 0, 8, 0);
                    head = head.subarray(0, bytesRead);
                } finally {
                    await handle.close();
                }
            } catch {
                head = Buffer.alloc(0);
            }
            const png = head.length >= 8 && head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG';
            const jpeg = head.length >= 2 && head[0] === 0xff && head[1] === 0xd8;
            if (!png && !jpeg) cover = fallback;
        }
    }
    if (cover && cover.source === 'embedded' && cover.data) {
        if (!options.coverTempDir) {
            const error = new Error('coverTempDir is required to materialize an embedded cover');
            error.code = 'ECOVER_TEMPDIR';
            throw error;
        }
        const tempDir = resolve(String(options.coverTempDir));
        await mkdir(tempDir, { recursive: true });
        const extension = cover.format === 'png' ? 'png' : 'jpg';
        const tempPath = join(tempDir, 'embedded-cover.' + extension);
        await writeFile(tempPath, cover.data);
        cover = {
            ...cover,
            path: tempPath,
            absolutePath: tempPath,
            materialized: true,
            embedded: true,
        };
    }
    if (cover) {
        const coverPath = coverAbsolutePath(root, cover);
        let validatedCover;
        if (cover.manual || cover.materialized || cover.external) {
            // A manual override may live outside the candidate root; validate it as
            // a real, non-reparse regular file before S1 copies it.
            const info = await lstat(coverPath);
            if (info.isSymbolicLink()) throw new Error(`cover is a symlink/junction: ${coverPath}`);
            if (!info.isFile()) throw new Error(`cover is not a regular file: ${coverPath}`);
            validatedCover = { absolute: coverPath, size: info.size };
        } else {
            validatedCover = await validateEntryFile(root, coverPath, basename(coverPath));
        }
        // Keep every scanned entry (including the image that happens to be a cover),
        // then add one explicit cover entry. S1 entry.logical_path is unique, so the
        // cover entry gets a deterministic synthetic path; both entries can reference
        // the same CAS asset and no source file is duplicated on disk.
        const originalLogical = (cover.materialized || cover.external || cover.manual)
            ? basename(coverPath)
            : logicalFromCover(root, cover);
        const coverBase = `cover/${basename(coverPath)}`;
        let coverLogical = normalizeLogical(coverBase);
        let suffix = 2;
        while (seenLogical.has(coverLogical) || coverLogical === normalizeLogical(originalLogical)) {
            const extension = extname(coverBase);
            const stem = basename(coverBase, extension);
            coverLogical = normalizeLogical(`cover/${stem}-${suffix}${extension}`);
            suffix += 1;
        }
        seenLogical.add(coverLogical);
        entries.push({
            entryId: deterministicEntryId(coverLogical),
            logicalPath: coverLogical,
            kind: 'cover',
            sourcePath: validatedCover.absolute,
            mime: cover.format === 'png' ? 'image/png' : cover.format === 'jpeg' ? 'image/jpeg' : mimeFor(coverPath),
        });
    }

    const metadata = candidate.metadata || null;
    const rawTitle = String(metadata?.title || candidate.folderTitle || candidate.title || basename(root)).trim() || basename(root);
    const title = displayTitleFromFolder(rawTitle);
    // Never derive circle/CV from the filename. Local imports carry only an RJ
    // code; metadata is fetched from Kikoeru/DLsite and persisted separately.
    const circle = String(candidate.circle || '').trim();
    const cvs = Array.isArray(candidate.cvs) ? candidate.cvs.map((cv) => String(cv).trim()).filter(Boolean) : [];
    const sourceCode = stableLocalCode(candidate);
    const sourceRecord = {
        provider: /^RJ\d{5,8}$/i.test(sourceCode) ? 'dlsite' : 'local',
        sourceCode,
        title,
        circle,
        cvs,
        familyId: candidate.familyId || null,
        edition: {
            language: String(metadata?.language || ''),
            role: String(metadata?.role || ''),
        },
        entries,
    };
    return sourceRecord;
}

function childKey(batchId, candidateId) {
    return `local:ingest:${batchId}:${candidateId}`;
}

function assertLibrary(library) {
    if (!library || typeof library.importWork !== 'function' || !library.db) {
        throw new Error('a storage-lab Library instance is required');
    }
}

function updateJobBatch(library, idempotencyKey, batchId) {
    if (!batchId) return;
    library.db
        .prepare('UPDATE import_job SET batch_id = ? WHERE library_id = ? AND idempotency_key = ?')
        .run(batchId, library.libraryId, idempotencyKey);
}

function ensureBatch(library, batchId) {
    const timestamp = new Date().toISOString();
    library.db
        .prepare(
            `INSERT OR IGNORE INTO import_batch(batch_id, library_id, status, created_at, updated_at)
             VALUES (?, ?, 'running', ?, ?)`
        )
        .run(batchId, library.libraryId, timestamp, timestamp);
    return timestamp;
}

function setBatchStatus(library, batchId, status) {
    library.db
        .prepare('UPDATE import_batch SET status = ?, updated_at = ? WHERE batch_id = ? AND library_id = ?')
        .run(status, new Date().toISOString(), batchId, library.libraryId);
}

function ensureBatchProgress(library, batchId, totalCandidates = 0) {
    const timestamp = new Date().toISOString();
    library.db
        .prepare(
            `INSERT OR IGNORE INTO import_batch_progress(
                batch_id, library_id, status, phase, current_candidate,
                total_candidates, updated_at
            ) VALUES (?, ?, 'running', 'queued', 0, ?, ?)`
        )
        .run(batchId, library.libraryId, totalCandidates, timestamp);
}

function updateBatchProgress(library, batchId, patch = {}) {
    const current = library.db
        .prepare('SELECT * FROM import_batch_progress WHERE batch_id = ? AND library_id = ?')
        .get(batchId, library.libraryId);
    if (!current) return;
    const values = {
        status: patch.status ?? current.status,
        phase: patch.phase ?? current.phase,
        current_candidate: patch.currentCandidate ?? current.current_candidate,
        total_candidates: patch.totalCandidates ?? current.total_candidates,
        candidate_id: patch.candidateId ?? current.candidate_id,
        current_entry: patch.currentEntry ?? current.current_entry,
        total_entries: patch.totalEntries ?? current.total_entries,
        bytes_done: patch.bytesDone ?? current.bytes_done,
        bytes_total: patch.bytesTotal ?? current.bytes_total,
        imported: patch.imported ?? current.imported,
        updated: patch.updated ?? current.updated,
        skipped: patch.skipped ?? current.skipped,
        failed: patch.failed ?? current.failed,
        message: patch.message ?? current.message,
        updated_at: new Date().toISOString(),
    };
    library.db
        .prepare(
            `UPDATE import_batch_progress SET
                status = ?, phase = ?, current_candidate = ?, total_candidates = ?,
                candidate_id = ?, current_entry = ?, total_entries = ?,
                bytes_done = ?, bytes_total = ?, imported = ?, updated = ?,
                skipped = ?, failed = ?, message = ?, updated_at = ?
             WHERE batch_id = ? AND library_id = ?`
        )
        .run(
            values.status,
            values.phase,
            values.current_candidate,
            values.total_candidates,
            values.candidate_id,
            values.current_entry,
            values.total_entries,
            values.bytes_done,
            values.bytes_total,
            values.imported,
            values.updated,
            values.skipped,
            values.failed,
            values.message,
            values.updated_at,
            batchId,
            library.libraryId
        );
}

function addBatchEvent(library, batchId, message, payload = {}) {
    library.db
        .prepare('INSERT INTO import_batch_event(batch_id, level, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(batchId, payload.level || 'info', String(message), JSON.stringify(payload), new Date().toISOString());
}

function committedJobForKey(library, key) {
    return library.db
        .prepare('SELECT committed_work_id FROM import_job WHERE library_id = ? AND idempotency_key = ?')
        .get(library.libraryId, key);
}

function assertNoDifferentKeyDuplicate(library, record, key) {
    const existingJob = committedJobForKey(library, key);
    // Same idempotency key is the normal retry/idempotent path; let S1 validate the
    // plan and return the committed work. A different key for the same sourceRef is
    // a duplicate import request, not a second work.
    if (existingJob?.committed_work_id) return;
    const sourceRef = library.db
        .prepare('SELECT r.work_id FROM source_ref r JOIN work w ON w.work_id = r.work_id WHERE r.provider = ? AND r.source_code = ? AND w.deleted_at IS NULL LIMIT 1')
        .get(record.provider, record.sourceCode);
    if (sourceRef) {
        const error = new Error(
            `candidate already imported as work ${sourceRef.work_id}; use its existing idempotency key`
        );
        error.code = 'ECONFLICT';
        throw error;
    }
}

async function ingestOne(library, candidate, { idempotencyKey, batchId, signal, onProgress, childIndex, childTotal, allowedSourceRoots }) {
    const record = await sourceRecordFromCandidate(candidate, { allowedSourceRoots });
    const key = String(idempotencyKey || `local:import:${candidate.candidateId || candidate.relativeRoot || 'work'}`);
    const progress = typeof onProgress === 'function'
        ? (event) => onProgress({
              ...event,
              batchId: batchId || null,
              candidateId: candidate.candidateId || candidate.relativeRoot || null,
              childIndex,
              childTotal,
          })
        : undefined;
    let existing = library.db
        .prepare('SELECT r.work_id FROM source_ref r JOIN work w ON w.work_id = r.work_id WHERE r.provider = ? AND r.source_code = ? AND w.deleted_at IS NULL LIMIT 1')
        .get(record.provider, record.sourceCode);
    if (!existing?.work_id) {
        // Older imports may have been recorded as local:local:[RJ...] before the
        // folder identity was normalized. Reuse that work when the RJ code matches;
        // mergeWorkSource adopts the new provider/code on the same work row.
        const rj = String(record.sourceCode || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase();
        if (rj) {
            existing = library.db
                .prepare(
                    `SELECT r.work_id
                     FROM source_ref r JOIN work w ON w.work_id = r.work_id
                     WHERE w.deleted_at IS NULL AND UPPER(r.source_code) LIKE ?
                     ORDER BY r.source_ref_id LIMIT 1`
                )
                .get(`%${rj}%`);
        }
    }
    let work;
    let merge = null;
    let mergeJobId = null;
    if (existing?.work_id) {
        // Rescan of an already-imported source: compare the candidate manifest
        // (including real sha256 values) against the existing work and merge only
        // changed/new entries. Identical rescans return skipped, never failed.
        const merged = await library.mergeWorkSource(existing.work_id, record, {
            signal,
            onProgress: progress,
            allowedSourceRoots,
        });
        work = merged.work || library.getWork(existing.work_id);
        mergeJobId = merged.jobId || null;
        merge = {
            changed: merged.changed,
            revision: merged.revision,
            added: merged.added,
            updated: merged.updated,
            skipped: merged.skipped,
            missing: merged.missing,
        };
    } else {
        work = await library.importWork(record, key, { signal, onProgress: progress, allowedSourceRoots });
    }
    updateJobBatch(library, key, batchId);
    return {
        ...work,
        candidateId: candidate.candidateId || null,
        batchId: batchId || null,
        jobId: work.jobId || mergeJobId,
        idempotent: !merge && work.idempotent === true,
        merge,
        sourceRecord: {
            provider: record.provider,
            sourceCode: record.sourceCode,
            entryCount: record.entries.length,
            coverEntry: record.entries.some((entry) => entry.kind === 'cover'),
            archiveEntries: record.entries.filter((entry) => entry.kind === 'archive').length,
        },
    };
}

/**
 * Ingest one preview candidate through the real S1 import transaction.
 */
export async function ingestCandidate(library, candidate, options = {}) {
    assertLibrary(library);
    const batchId = options.batchId || null;
    if (batchId) ensureBatch(library, batchId);
    const result = await ingestOne(library, candidate, {
        idempotencyKey: options.idempotencyKey,
        batchId,
        signal: options.signal,
        onProgress: options.onProgress,
        childIndex: 0,
        childTotal: 1,
        allowedSourceRoots: options.allowedSourceRoots,
    });
    return result;
}

/**
 * Import selected candidates independently. A failed child does not roll back a
 * committed sibling; retry uses the same batch/candidate key and S1 idempotency.
 */
export async function ingestPreview(library, preview, options = {}) {
    assertLibrary(library);
    if (!preview || !Array.isArray(preview.candidates)) throw new Error('preview.candidates is required');
    const candidates = preview.candidates;
    const requestedIds = options.candidateIds ? [...new Set(options.candidateIds.map(String))] : null;
    const selected = requestedIds
        ? requestedIds.map((candidateId) => candidates.find((candidate) => String(candidate.candidateId) === candidateId)).filter(Boolean)
        : [...candidates];
    const missing = requestedIds
        ? requestedIds.filter((candidateId) => !candidates.some((candidate) => String(candidate.candidateId) === candidateId))
        : [];
    const batchKey = String(options.idempotencyKey || `local:batch:${Date.now()}-${process.pid}`);
    const batchId = String(options.batchId || `batch:${batchKey}`);
    ensureBatch(library, batchId);
    ensureBatchProgress(library, batchId, selected.length);
    updateBatchProgress(library, batchId, {
        status: 'running',
        phase: 'scanning',
        totalCandidates: selected.length,
        message: `扫描到 ${selected.length} 个候选作品`,
    });
    addBatchEvent(library, batchId, `batch started: ${selected.length} candidates`, { total: selected.length });

    const results = [];
    let lastProgressWrite = 0;
    const progress = (event) => {
        const nowMs = Date.now();
        if (event.phase === 'asset' && nowMs - lastProgressWrite < 200) {
            // Do not hammer SQLite for every stream chunk; the UI polls at a
            // coarser cadence anyway.
            return;
        }
        lastProgressWrite = nowMs;
        updateBatchProgress(library, batchId, {
            phase: event.phase || 'asset',
            currentCandidate: Number(event.childIndex ?? 0) + 1,
            candidateId: event.candidateId || null,
            currentEntry: Number(event.entryIndex ?? 0) + 1,
            totalEntries: Number(event.entryTotal ?? 0),
            bytesDone: Number(event.bytes ?? 0),
            bytesTotal: Number(event.totalBytes ?? event.bytes ?? 0),
            message: event.logicalPath ? `读取 ${event.logicalPath}` : '',
        });
        if (typeof options.onProgress === 'function') options.onProgress(event);
    };
    for (const [childIndex, candidate] of selected.entries()) {
        const candidateId = String(candidate.candidateId || candidate.relativeRoot || 'work');
        const key = options.idempotencyKey
            ? childKey(batchId, candidateId)
            : `local:ingest:${batchId}:${candidateId}`;
        updateBatchProgress(library, batchId, {
            phase: 'candidate',
            currentCandidate: childIndex + 1,
            candidateId,
            currentEntry: 0,
            totalEntries: Array.isArray(candidate.entries) ? candidate.entries.length : 0,
            message: `处理 ${candidateId}`,
        });
        addBatchEvent(library, batchId, `candidate started: ${candidateId}`, { candidateId });
        if (options.signal?.aborted) {
            results.push({
                candidateId,
                ok: false,
                cancelled: true,
                skipped: true,
                status: 'cancelled',
                error: 'import cancelled before this child started',
                code: 'EABORTED',
                key,
            });
            continue;
        }
        try {
            const created = await ingestOne(library, candidate, {
                idempotencyKey: key,
                batchId,
                signal: options.signal,
                onProgress: progress,
                childIndex,
                childTotal: selected.length,
                allowedSourceRoots: options.allowedSourceRoots,
            });
            const merge = created.merge || null;
            const status = merge ? (merge.changed ? 'updated' : 'skipped') : 'completed';
            results.push({
                candidateId,
                ok: true,
                cancelled: false,
                status,
                workId: created.workId,
                jobId: created.jobId,
                revision: created.revision,
                idempotent: created.idempotent,
                merge,
                entryCount: created.entries?.length ?? created.sourceRecord?.entryCount,
            });
            updateBatchProgress(library, batchId, {
                phase: 'candidate-done',
                candidateId,
                message: status === 'skipped' ? `跳过 ${candidateId}` : `完成 ${candidateId}`,
            });
            addBatchEvent(library, batchId, `candidate ${status}: ${candidateId}`, { candidateId, status });
        } catch (error) {
            // The failed/cancelled job may exist from importWork's precommit path;
            // attach it to the batch even though no work was committed.
            updateJobBatch(library, key, batchId);
            const cancelled = error?.cancelled === true || error?.code === 'EABORTED';
            results.push({
                candidateId,
                ok: false,
                cancelled,
                skipped: false,
                status: cancelled ? 'cancelled_precommit' : 'failed',
                error: String(error?.message || error),
                code: error?.code || null,
                jobId: error?.jobId || null,
                key,
            });
            updateBatchProgress(library, batchId, {
                phase: 'candidate-failed',
                candidateId,
                message: `失败 ${candidateId}: ${error?.message || error}`,
            });
            addBatchEvent(library, batchId, `candidate failed: ${candidateId}`, { candidateId, error: String(error?.message || error) });
        }
    }
    for (const candidateId of missing) {
        results.push({
            candidateId,
            ok: false,
            cancelled: false,
            skipped: true,
            status: 'missing',
            error: 'candidate not found in preview',
            code: 'ECANDIDATENOTFOUND',
        });
    }

    const imported = results.filter((result) => result.ok && result.status === 'completed').length;
    const updated = results.filter((result) => result.ok && result.status === 'updated').length;
    const skipped = results.filter((result) => result.ok && result.status === 'skipped').length;
    const cancelled = results.filter((result) => !result.ok && result.cancelled).length;
    const failed = results.filter((result) => !result.ok && !result.cancelled).length;
    let status;
    if (cancelled > 0) {
        status = imported + updated > 0 ? 'partial' : 'cancelled';
    } else {
        status = failed === 0 ? 'completed' : imported + updated > 0 ? 'partial' : 'failed';
    }
    setBatchStatus(library, batchId, status);
    updateBatchProgress(library, batchId, {
        status,
        phase: 'done',
        imported,
        updated,
        skipped,
        failed,
        message: `完成：新增 ${imported}，更新 ${updated}，跳过 ${skipped}，失败 ${failed}`,
    });
    addBatchEvent(library, batchId, `batch ${status}`, { imported, updated, skipped, failed });
    return {
        batchId,
        libraryId: library.libraryId,
        status,
        candidateIds: selected.map((candidate) => String(candidate.candidateId || candidate.relativeRoot || 'work')),
        imported,
        updated,
        failed,
        cancelled,
        skipped,
        total: results.length,
        results,
        children: results,
    };
}
