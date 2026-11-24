// E11: resumable download core. Bytes are staged in a task-owned .part file,
// hashed incrementally, and only published to CAS after commit validates size and
// SHA-256. No final asset/ref exists on cancel, early EOF or network failure.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathExists } from './fs.mjs';
import { fsyncFile } from './fs.mjs';
import { hashFile } from './hash.mjs';

const TERMINAL = new Set(['completed', 'cancelled']);

function now() {
    return new Date().toISOString();
}

function normalizeVersion(value) {
    return String(value || '').replace(/^W\//, '').replace(/^"|"$/g, '');
}

function isInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveEntry(library, entryId) {
    const internal = library.db.prepare('SELECT * FROM entry WHERE entry_id = ?').get(String(entryId));
    if (internal) return internal;
    const rows = library.db.prepare('SELECT * FROM entry WHERE stable_entry_id = ? LIMIT 2').all(String(entryId));
    return rows.length === 1 ? rows[0] : null;
}

function sidecarPath(partPath) {
    return `${partPath}.meta.json`;
}

async function writeMeta(task) {
    await writeFile(
        sidecarPath(task.partPath),
        `${JSON.stringify(
            {
                taskId: task.taskId,
                entryId: task.entryId,
                sourceUrl: task.sourceUrl,
                sourceVersion: task.sourceVersion,
                etag: task.etag,
                lastModified: task.lastModified,
                expectedBytes: task.expectedBytes,
                updatedAt: now(),
            },
            null,
            2
        )}\n`,
        'utf8'
    );
}

async function readMeta(partPath) {
    try {
        return JSON.parse(await readFile(sidecarPath(partPath), 'utf8'));
    } catch {
        return null;
    }
}

async function updateTask(task, patch) {
    const current = task.db.prepare('SELECT * FROM download_task WHERE task_id = ?').get(task.taskId);
    if (!current) return;
    task.db
        .prepare(
            `UPDATE download_task SET
                status = ?, source_version = ?, part_path = ?, progress = ?,
                expected_bytes = ?, final_sha256 = ?, updated_at = ?
             WHERE task_id = ?`
        )
        .run(
            patch.status ?? current.status,
            patch.sourceVersion ?? current.source_version,
            patch.partPath ?? current.part_path,
            patch.progress ?? current.progress,
            patch.expectedBytes ?? current.expected_bytes,
            patch.finalSha256 ?? current.final_sha256,
            now(),
            task.taskId
        );
}

class DownloadTask {
    constructor({ library, row, meta, hash, partHandle = null }) {
        this.library = library;
        this.db = library.db;
        this.taskId = row.task_id;
        this.entryId = row.entry_id;
        this.sourceUrl = meta?.sourceUrl || '';
        this.sourceVersion = row.source_version || meta?.sourceVersion || '';
        this.etag = meta?.etag || '';
        this.lastModified = meta?.lastModified || '';
        this.expectedBytes = Number(row.expected_bytes || meta?.expectedBytes || 0) || null;
        this.progress = Number(row.progress || 0);
        this.partPath = row.part_path || join(library.dataRoot, 'tmp', `download-${this.taskId}.part`);
        this.status = row.status;
        this.finalSha = row.final_sha256 || null;
        this.hash = hash || createHash('sha256');
        this.partHandle = partHandle;
        this.busy = false;
        this.abortController = null;
        this.signal = null;
        this.paused = false;
        this.restarted = false;
        this.restartReason = null;
        this.incomplete = false;
        this.assetId = row.final_sha256 || null;
    }

    get state() {
        return this.status;
    }

    get complete() {
        return this.status === 'completed';
    }

    async pause() {
        if (TERMINAL.has(this.status)) return this;
        this.paused = true;
        this.status = 'paused';
        await updateTask(this, { status: 'paused', progress: this.progress });
        this.abortController?.abort();
        return this;
    }

    async _ensureHashForExisting() {
        if (this.progress > 0 && this.hash.digest) {
            // digest already consumed; caller should have supplied a hash.
        }
    }

    async _writeChunk(chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!buffer.length) return 0;
        if (this.expectedBytes != null && this.progress + buffer.length > this.expectedBytes) {
            const error = new Error(`download exceeds expectedBytes (${this.progress}+${buffer.length}>${this.expectedBytes})`);
            error.code = 'ESIZE';
            throw error;
        }
        if (!this.partHandle) {
            this.partHandle = await open(this.partPath, 'a+');
        }
        await this.partHandle.write(buffer, 0, buffer.length, this.progress);
        this.hash.update(buffer);
        this.progress += buffer.length;
        await updateTask(this, { status: 'in_progress', progress: this.progress });
        return buffer.length;
    }

    async append(chunk) {
        if (TERMINAL.has(this.status)) throw new Error(`task is ${this.status}`);
        this.busy = true;
        try {
            const written = await this._writeChunk(chunk);
            this.status = this.expectedBytes != null && this.progress >= this.expectedBytes ? 'ready' : 'in_progress';
            await updateTask(this, { status: this.status, progress: this.progress });
            return written;
        } finally {
            this.busy = false;
        }
    }

    async _resetPart() {
        if (this.partHandle) {
            await this.partHandle.close().catch(() => {});
            this.partHandle = null;
        }
        await rm(this.partPath, { force: true }).catch(() => {});
        await mkdir(dirname(this.partPath), { recursive: true });
        this.progress = 0;
        this.hash = createHash('sha256');
        this.partHandle = await open(this.partPath, 'w');
        this.status = 'in_progress';
        await updateTask(this, { status: this.status, progress: 0, finalSha256: null });
    }

    _headersForResume() {
        const headers = { 'Accept-Encoding': 'identity' };
        if (this.progress > 0) {
            headers.Range = `bytes=${this.progress}-`;
            if (this.etag) headers['If-Range'] = this.etag;
            else if (this.lastModified) headers['If-Range'] = this.lastModified;
        }
        return headers;
    }

    async _fetchFrom(start, { retried = false } = {}) {
        let response;
        try {
            response = await fetch(this.sourceUrl, {
                method: 'GET',
                headers: this._headersForResume(),
                signal: this.signal,
                redirect: 'follow',
            });
        } catch (error) {
            if (this.paused || error?.name === 'AbortError') {
                this.status = 'paused';
                await updateTask(this, { status: 'paused', progress: this.progress });
                return { bytes: this.progress, status: 'paused' };
            }
            this.status = 'error';
            await updateTask(this, { status: 'error', progress: this.progress });
            throw error;
        }
        const etag = response.headers.get('etag') || '';
        const lastModified = response.headers.get('last-modified') || '';
        const contentRange = response.headers.get('content-range') || '';
        const contentLengthHeader = response.headers.get('content-length');
        const totalMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
        const responseTotal =
            response.status === 206 && totalMatch
                ? Number(totalMatch[3])
                : response.status === 200 && contentLengthHeader != null
                  ? Number(contentLengthHeader)
                  : null;
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (this.paused) {
                this.status = 'paused';
                await updateTask(this, { status: 'paused', progress: this.progress });
                return { bytes: this.progress, status: 'paused' };
            }
            this.status = 'error';
            await updateTask(this, { status: 'error', progress: this.progress });
            const error = new Error(`download HTTP ${response.status}`);
            error.code = response.status === 416 ? 'ERANGE' : 'EHTTP';
            throw error;
        }

        const incomingVersion = normalizeVersion(etag) || normalizeVersion(lastModified);
        const expectedVersion = normalizeVersion(this.sourceVersion);
        const previousVersion = normalizeVersion(this.etag) || normalizeVersion(this.lastModified);
        if (start > 0 && previousVersion && incomingVersion && previousVersion !== incomingVersion) {
            await response.body?.cancel().catch(() => {});
            if (!retried) {
                this.restarted = true;
                this.restartReason = 'version-changed';
                await this._resetPart();
                this.etag = etag || this.etag;
                this.lastModified = lastModified || this.lastModified;
                if (responseTotal != null) this.expectedBytes = responseTotal;
                this.sourceVersion = incomingVersion || this.sourceVersion;
                return this._fetchFrom(0, { retried: true });
            }
            const error = new Error('source version changed during resume');
            error.code = 'ESOURCE_CHANGED';
            this.status = 'error';
            await updateTask(this, { status: 'error', progress: this.progress });
            throw error;
        }
        if (expectedVersion && incomingVersion && expectedVersion !== incomingVersion) {
            await response.body?.cancel().catch(() => {});
            if (start > 0 && !retried) {
                this.restarted = true;
                this.restartReason = 'version-changed';
                await this._resetPart();
                this.etag = etag || this.etag;
                this.lastModified = lastModified || this.lastModified;
                if (responseTotal != null) this.expectedBytes = responseTotal;
                this.sourceVersion = incomingVersion;
                return this._fetchFrom(0, { retried: true });
            }
            const error = new Error(`source version mismatch: expected ${this.sourceVersion}, got ${incomingVersion}`);
            error.code = 'ESOURCE_CHANGED';
            this.status = 'error';
            await updateTask(this, { status: 'error', progress: this.progress });
            throw error;
        }
        if (this.expectedBytes != null && responseTotal != null && responseTotal !== this.expectedBytes) {
            await response.body?.cancel().catch(() => {});
            const error = new Error(`source size changed: expected ${this.expectedBytes}, server ${responseTotal}`);
            error.code = 'ESOURCE_CHANGED';
            this.status = 'error';
            await updateTask(this, { status: 'error', progress: this.progress });
            throw error;
        }
        if (start > 0 && response.status === 206) {
            if (!totalMatch || Number(totalMatch[1]) !== start) {
                await response.body?.cancel().catch(() => {});
                if (!retried) {
                    this.restarted = true;
                    this.restartReason = 'invalid-resume-range';
                    await this._resetPart();
                    return this._fetchFrom(0, { retried: true });
                }
                const error = new Error('server returned an invalid resume range');
                error.code = 'ERANGE';
                this.status = 'error';
                await updateTask(this, { status: 'error', progress: this.progress });
                throw error;
            }
        }
        if (start > 0 && response.status === 200) {
            // Ignored Range: restart safely from zero, never append a full body.
            this.restarted = true;
            this.restartReason = 'server-ignored-range';
            await this._resetPart();
            start = 0;
        }
        this.etag = etag || this.etag;
        this.lastModified = lastModified || this.lastModified;
        if (responseTotal != null && this.expectedBytes == null) this.expectedBytes = responseTotal;
        await writeMeta(this);
        if (!this.partHandle) this.partHandle = await open(this.partPath, this.progress > 0 ? 'a+' : 'w');
        let received = 0;
        try {
            for await (const chunk of response.body) {
                await this._writeChunk(chunk);
                received += chunk.length;
            }
        } catch (error) {
            if (this.paused || error?.name === 'AbortError') {
                this.status = 'paused';
                await updateTask(this, { status: 'paused', progress: this.progress });
                return { bytes: this.progress, status: 'paused' };
            }
            if (this.expectedBytes != null && this.progress < this.expectedBytes) {
                error.code = 'EEARLYEOF';
                this.status = 'incomplete';
                this.incomplete = true;
                await updateTask(this, { status: 'incomplete', progress: this.progress });
                throw error;
            }
            this.status = 'error';
            await updateTask(this, { status: 'error', progress: this.progress });
            throw error;
        }
        if (this.expectedBytes != null && this.progress < this.expectedBytes) {
            const error = new Error(`early EOF: ${this.progress}/${this.expectedBytes} bytes`);
            error.code = 'EEARLYEOF';
            this.status = 'incomplete';
            this.incomplete = true;
            await updateTask(this, { status: 'incomplete', progress: this.progress });
            throw error;
        }
        this.status = this.expectedBytes != null ? 'ready' : 'ready';
        await updateTask(this, { status: this.status, progress: this.progress });
        return { bytes: this.progress, status: this.status };
    }

    async resume(options = {}) {
        if (this.status === 'completed') return this;
        if (this.status === 'cancelled') throw new Error('task was cancelled');
        this.paused = false;
        this.abortController = new AbortController();
        if (options.signal) {
            if (options.signal.aborted) this.abortController.abort();
            else options.signal.addEventListener('abort', () => this.abortController?.abort(), { once: true });
        }
        this.signal = this.abortController.signal;
        await mkdir(dirname(this.partPath), { recursive: true });
        if (await pathExists(this.partPath)) {
            const info = await stat(this.partPath);
            this.progress = Number(info.size);
            if (this.progress > 0) {
                const hashed = await hashFile(this.partPath);
                this.hash = createHash('sha256');
                this.hash.update(await readFile(this.partPath));
                this.progress = hashed.bytes;
                if (this.partHandle) await this.partHandle.close().catch(() => {});
                this.partHandle = await open(this.partPath, 'r+');
            }
        }
        this.busy = true;
        try {
            await this._fetchFrom(this.progress);
            return this;
        } finally {
            this.busy = false;
            if (this.partHandle) {
                await this.partHandle.sync().catch(() => {});
                await this.partHandle.close().catch(() => {});
                this.partHandle = null;
            }
        }
    }

    async commit() {
        if (this.status === 'completed') return this;
        if (this.status === 'cancelled') throw new Error('task was cancelled');
        const partExists = await pathExists(this.partPath);
        if (!partExists) throw new Error('download part is missing');
        const info = await stat(this.partPath);
        const bytes = Number(info.size);
        if (this.expectedBytes != null && bytes !== this.expectedBytes) {
            const error = new Error(`download size mismatch: ${bytes} != ${this.expectedBytes}`);
            error.code = 'ESIZE';
            throw error;
        }
        const hashed = await hashFile(this.partPath);
        const sha256 = hashed.sha256;
        const entry = resolveEntry(this.library, this.entryId);
        if (!entry) throw new Error('entry not found for download commit');
        const relPath = `assets/sha256/${sha256.slice(0, 2)}/${sha256}`;
        const destination = join(this.library.dataRoot, ...relPath.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        if (await pathExists(destination)) {
            const existing = await hashFile(destination);
            if (existing.sha256 !== sha256 || existing.bytes !== bytes) throw new Error('CAS collision/corruption');
            await rm(this.partPath, { force: true });
        } else {
            await fsyncFile(this.partPath);
            await this._closePart();
            await (await import('node:fs/promises')).rename(this.partPath, destination);
        }
        const timestamp = now();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db
                .prepare(
                    `INSERT OR IGNORE INTO asset(asset_id, sha256, bytes, mime, rel_path, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(sha256, sha256, bytes, entry.mime || 'application/octet-stream', relPath, timestamp);
            this.db
                .prepare(
                    `INSERT OR IGNORE INTO asset_ref(asset_ref_id, work_id, entry_id, asset_id, role)
                     VALUES (?, ?, ?, ?, 'primary')`
                )
                .run(`${this.taskId}:ref`, entry.work_id, entry.entry_id, sha256);
            this.db
                .prepare(
                    `UPDATE download_task SET
                        status = 'completed', progress = ?, expected_bytes = ?, final_sha256 = ?,
                        part_path = ?, updated_at = ?
                     WHERE task_id = ?`
                )
                .run(bytes, this.expectedBytes, sha256, this.partPath, timestamp, this.taskId);
            this.db.exec('COMMIT');
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                /* no active tx */
            }
            throw error;
        }
        this.status = 'completed';
        this.progress = bytes;
        this.finalSha = sha256;
        this.assetId = sha256;
        await rm(sidecarPath(this.partPath), { force: true }).catch(() => {});
        return this;
    }

    async _closePart() {
        if (this.partHandle) {
            await this.partHandle.close().catch(() => {});
            this.partHandle = null;
        }
    }

    async cancel() {
        if (this.status === 'completed') throw new Error('completed task cannot be cancelled');
        this.status = 'cancelled';
        await this._closePart();
        await updateTask(this, { status: 'cancelled', progress: this.progress });
        await rm(this.partPath, { force: true }).catch(() => {});
        await rm(sidecarPath(this.partPath), { force: true }).catch(() => {});
        return this;
    }
}

async function taskFromRow(library, row, meta = null) {
    let hash = createHash('sha256');
    let partHandle = null;
    let progress = Number(row.progress || 0);
    if (row.part_path && (await pathExists(row.part_path))) {
        const info = await stat(row.part_path);
        if (info.isFile()) {
            progress = Number(info.size);
            hash = createHash('sha256');
            const handle = await open(row.part_path, 'r');
            try {
                for await (const chunk of handle.createReadStream()) hash.update(chunk);
            } finally {
                await handle.close();
            }
        }
    }
    return new DownloadTask({ library, row: { ...row, progress }, meta, hash, partHandle });
}

export async function beginDownload(library, entryId, options = {}) {
    if (!library || !library.db) throw new Error('a storage-lab Library instance is required');
    if (!options.sourceUrl) throw new Error('sourceUrl is required');
    const entry = resolveEntry(library, entryId);
    if (!entry) throw new Error('entry not found');
    const taskId = String(options.taskId || `download-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
    const partPath = join(library.dataRoot, 'tmp', `${taskId}.part`);
    if (!isInside(join(library.dataRoot, 'tmp'), partPath)) throw new Error('invalid download temp path');
    await mkdir(dirname(partPath), { recursive: true });
    await rm(partPath, { force: true }).catch(() => {});
    const timestamp = now();
    library.db
        .prepare(
            `INSERT INTO download_task(
                task_id, entry_id, source_version, part_path, progress,
                expected_bytes, final_sha256, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, NULL, 'pending', ?, ?)`
        )
        .run(taskId, entry.entry_id, options.sourceVersion != null ? String(options.sourceVersion) : null, partPath, options.expectedBytes ?? null, timestamp, timestamp);
    const row = library.db.prepare('SELECT * FROM download_task WHERE task_id = ?').get(taskId);
    const task = await taskFromRow(library, row, {
        sourceUrl: options.sourceUrl,
        sourceVersion: options.sourceVersion != null ? String(options.sourceVersion) : '',
        etag: '',
        lastModified: '',
        expectedBytes: options.expectedBytes ?? null,
    });
    await writeMeta(task);
    return task;
}

export async function appendDownload(task, chunk) {
    if (!task || typeof task.append !== 'function') throw new Error('download task is required');
    return task.append(chunk);
}

export async function commitDownload(task) {
    if (!task || typeof task.commit !== 'function') throw new Error('download task is required');
    return task.commit();
}

export async function cancelDownload(task) {
    if (!task || typeof task.cancel !== 'function') throw new Error('download task is required');
    return task.cancel();
}

export async function resumeDownload(taskOrLibrary, taskId) {
    let task = taskOrLibrary;
    if (taskOrLibrary && typeof taskOrLibrary.resume !== 'function') {
        const library = taskOrLibrary;
        const row = library.db.prepare('SELECT * FROM download_task WHERE task_id = ?').get(String(taskId));
        if (!row) throw new Error('download task not found');
        task = await loadDownload(library, row.task_id);
    }
    return task.resume();
}

export async function loadDownload(library, taskId) {
    const row = library.db.prepare('SELECT * FROM download_task WHERE task_id = ?').get(String(taskId));
    if (!row) return null;
    const meta = row.part_path ? await readMeta(row.part_path) : null;
    return taskFromRow(library, row, meta);
}

export async function getDownloadTask(library, taskId) {
    return loadDownload(library, taskId);
}
