// 创作附件在 Web 端的本地资产层。
//
// 元数据仍由 creations.js 写 localStorage(体积小);这里只存二进制 Blob。
// 逻辑 key 固定为 `<creationId>/<attachmentId>`,将来 Tauri 文件系统实现
// 可以用同样的 key 映射到磁盘目录,避免把绝对路径写进可同步元数据。

const DB_NAME = 'monochrome-creations-v2';
const DB_VERSION = 1;
const FILE_STORE = 'files';

let databasePromise = null;

export function isCreationFileStoreAvailable() {
    return typeof indexedDB !== 'undefined';
}

function openDatabase() {
    if (!isCreationFileStoreAvailable()) return Promise.reject(new Error('IndexedDB unavailable'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(FILE_STORE)) {
                database.createObjectStore(FILE_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return databasePromise;
}

function fileKey(creationId, attachmentId) {
    return `${creationId}/${attachmentId}`;
}

function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function hostCreation() {
    return globalThis.__monochromeFileStorage?.creation || null;
}

async function putRecord(database, creationId, attachmentId, record) {
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_STORE, 'readwrite');
        transaction.objectStore(FILE_STORE).put(record, fileKey(creationId, attachmentId));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

// blob 为 null 而只有 thumbnailBlob 时是「只有缩略图」的本地预览(帖子没有原图链接,
// 例如 Pawchive post/144783018):只存缩略图,绝不把缩略图冒充原图写进 original。
export async function putLocalFile(creationId, attachment, blob, metadata = {}) {
    const database = await openDatabase();
    const { thumbnailBlob = null, thumbnailMime = '', ...rest } = metadata;
    if (!blob && !thumbnailBlob) throw new Error('creation file blob is required');
    const primary = blob || thumbnailBlob;
    const host = hostCreation();
    if (host?.uploadAsset) {
        try {
            const original = blob
                ? await host.uploadAsset({
                    postId: creationId,
                    attachmentId: attachment.id,
                    role: 'original',
                    blob,
                    name: attachment.name || '',
                    mime: blob.type || metadata.mime || '',
                })
                : null;
            const thumbnail = thumbnailBlob
                ? await host.uploadAsset({
                    postId: creationId,
                    attachmentId: attachment.id,
                    role: 'thumbnail',
                    blob: thumbnailBlob,
                    name: attachment.name || '',
                    mime: thumbnailBlob.type || thumbnailMime || '',
                })
                : null;
            const hosted = {
                blob: null,
                mime: primary.type || metadata.mime || 'application/octet-stream',
                bytes: primary.size,
                originalName: attachment.name || metadata.name || 'attachment',
                sourceUrl: attachment.sourceUrl || attachment.src || '',
                savedAt: new Date().toISOString(),
                thumbnailMime: thumbnailBlob?.type || thumbnailMime || '',
                hostAssetId: original?.assetId || '',
                thumbnailHostAssetId: thumbnail?.assetId || '',
                localKey: `host:${creationId}/${attachment.id}`,
                storage: 'host',
                ...rest,
            };
            await putRecord(database, creationId, attachment.id, hosted);
            return hosted;
        } catch (error) {
            console.warn('Failed to save creation attachment to host; falling back to IndexedDB', error?.message || error);
        }
    }
    const record = {
        blob: blob || null,
        mime: primary.type || metadata.mime || 'application/octet-stream',
        bytes: primary.size,
        originalName: attachment.name || metadata.name || 'attachment',
        sourceUrl: attachment.sourceUrl || attachment.src || '',
        savedAt: new Date().toISOString(),
        // Keep a small preview blob next to the original so a local image row
        // does not have to decode the full-size image. Older records simply
        // have no thumbnailBlob and fall back to the original.
        thumbnailBlob,
        thumbnailMime: thumbnailMime || thumbnailBlob?.type || '',
        ...rest,
    };
    await putRecord(database, creationId, attachment.id, record);
    return record;
}

export async function getLocalFile(creationId, attachmentId) {
    const database = await openDatabase();
    const record = await requestAsPromise(
        database.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(fileKey(creationId, attachmentId)),
    );
    if (!record?.hostAssetId) return record;
    try {
        const blob = await hostCreation()?.fetchAsset(record.hostAssetId);
        return blob ? { ...record, blob } : record;
    } catch {
        return record;
    }
}

export async function deleteLocalFile(creationId, attachmentId) {
    const database = await openDatabase();
    const record = await requestAsPromise(
        database.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(fileKey(creationId, attachmentId)),
    );
    const host = hostCreation();
    if (record?.hostAssetId && host?.deleteAsset) await host.deleteAsset(record.hostAssetId).catch(() => {});
    if (record?.thumbnailHostAssetId && host?.deleteAsset) await host.deleteAsset(record.thumbnailHostAssetId).catch(() => {});
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_STORE, 'readwrite');
        transaction.objectStore(FILE_STORE).delete(fileKey(creationId, attachmentId));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
}

export async function listLocalFiles(creationId) {
    const database = await openDatabase();
    const prefix = `${creationId}/`;
    const records = [];
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_STORE, 'readonly');
        const request = transaction.objectStore(FILE_STORE).openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            if (String(cursor.key).startsWith(prefix)) {
                records.push({ key: cursor.key, attachmentId: String(cursor.key).slice(prefix.length), ...cursor.value });
            }
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
    return records;
}

export async function deleteCreationFiles(creationId) {
    const database = await openDatabase();
    const prefix = `${creationId}/`;
    const keys = [];
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_STORE, 'readonly');
        const request = transaction.objectStore(FILE_STORE).openKeyCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }
            if (String(cursor.key).startsWith(prefix)) keys.push(cursor.key);
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
    if (keys.length === 0) return 0;
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_STORE, 'readwrite');
        const store = transaction.objectStore(FILE_STORE);
        keys.forEach((key) => store.delete(key));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    return keys.length;
}

export async function localFileSummary(creationId) {
    const files = await listLocalFiles(creationId);
    return {
        count: files.length,
        bytes: files.reduce((total, file) => total + (Number(file.bytes) || 0), 0),
        files,
    };
}
