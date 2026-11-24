// S6: self-contained, real-file work export.
//
// The export is a plain folder under the caller's exports parent:
//   <parent>/<friendly-name>/monochrome/{manifest.json,COMPLETE,cover.ext}
//   <parent>/<friendly-name>/content/<original logical tree>
// It is a copy, never a hardlink/symlink into CAS. No UI/Tauri/online calls.
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertInsideExperiment, validateLogicalPath } from './paths.mjs';
import { atomicWrite, atomicWriteJson, ensureDir, pathExists, readJson } from './fs.mjs';
import { copyToTempAndHash, hashFile, sha256Text } from './hash.mjs';

export const EXPORT_FORMAT = 'monochrome-storage-lab-export';
export const EXPORT_FORMAT_VERSION = 1;
const COVER_RE = /^(cover|folder|front|jacket|package)$/i;
const MIME_EXTENSION = {
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'text/vtt': '.vtt',
    'application/x-subrip': '.srt',
    'text/x-ssa': '.ass',
    'application/zip': '.zip',
};

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

async function regularFile(path, label) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} is a symlink/junction`);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    return info;
}

function sourceCodeOf(work) {
    for (const source of work.sourceRefs || []) {
        const match = String(source.sourceCode || '').match(/\bRJ\d{5,8}\b/i);
        if (match) return match[0].toUpperCase();
    }
    for (const source of work.sourceRefs || []) {
        if (source.sourceCode) return String(source.sourceCode).toUpperCase();
    }
    return null;
}

function cleanComponent(name) {
    let value = String(name || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    value = value.replace(/^[. ]+|[. ]+$/g, '');
    if (!value) value = 'untitled';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) value = `_${value}`;
    if (value.length > 180) value = value.slice(0, 180).replace(/[. ]+$/g, '');
    return value;
}

function autoFriendlyName(work) {
    const sourceCode = sourceCodeOf(work);
    const title = work.userTitle || work.title || 'Untitled';
    const circle = work.circle || '';
    const cvs = Array.isArray(work.cvs) ? work.cvs.filter(Boolean) : [];
    const head = sourceCode ? `[${sourceCode}]` : '[Local]';
    const circlePart = circle ? `[${circle}]` : '';
    const cvPart = cvs.length ? ` (${cvs.join(', ')})` : '';
    return cleanComponent(`${head}${circlePart} ${title}${cvPart}`);
}

function coverEntryOf(work) {
    const entries = work.entries || [];
    const explicit = entries.find((entry) => String(entry.kind || '').toLowerCase() === 'cover');
    if (explicit) return explicit;
    return (
        entries.find((entry) => {
            if (String(entry.kind || '').toLowerCase() !== 'image') return false;
            const stem = basename(String(entry.logicalPath || ''), extname(String(entry.logicalPath || '')));
            return COVER_RE.test(stem);
        }) || null
    );
}

function coverExtension(entry, asset) {
    // Prefer recorded MIME so a mislabeled source name does not force a fake extension.
    const mime = String(asset.mime || '').toLowerCase();
    if (MIME_EXTENSION[mime]) return MIME_EXTENSION[mime];
    const extension = extname(String(entry.logicalPath || '')).toLowerCase();
    return extension || '.bin';
}

function entryAsset(entry) {
    const assets = Array.isArray(entry.assets) ? entry.assets : [];
    return assets.find((asset) => String(asset.role || 'primary') === 'primary') || assets[0] || null;
}

function assetSourcePath(library, asset) {
    const normalized = slash(asset.relPath);
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
        throw new Error(`invalid asset relPath: ${asset.relPath}`);
    }
    return join(library.root, 'data', ...normalized.split('/'));
}

async function copyAsset(library, asset, target) {
    const source = assetSourcePath(library, asset);
    await assertNoReparse(source);
    await regularFile(source, source);
    const temp = `${target}.${process.pid}.${Date.now()}.part`;
    const copied = await copyToTempAndHash(source, temp);
    if (copied.sha256 !== asset.sha256 || Number(copied.bytes) !== Number(asset.bytes)) {
        await rm(copied.tempPath, { force: true }).catch(() => {});
        throw new Error(`export asset failed hash/size verification: ${asset.relPath}`);
    }
    await ensureDir(join(target, '..'));
    await rename(copied.tempPath, target);
    return { bytes: Number(copied.bytes), sha256: copied.sha256 };
}

function validateContentLogicalPath(logicalPath) {
    const normalized = validateLogicalPath(logicalPath);
    return normalized.replace(/\\/g, '/');
}

/**
 * Export one work as a self-contained folder. `destination` is the exports parent;
 * a sanitized friendly-name child is created below it. Collisions fail.
 */
export async function exportWork(library, workId, destination, options = {}) {
    if (!library || !library.db) throw new Error('a storage-lab Library instance is required');
    const parent = resolve(String(destination || ''));
    assertInsideExperiment(parent);
    await assertNoReparse(parent);
    if (parent === resolve(library.root) || isSameOrInside(library.dataRoot, parent)) {
        const error = new Error('export destination must not overlap the library root/data');
        error.code = 'EEXPORTDEST';
        throw error;
    }
    const work = library.getWork(String(workId));
    if (!work) throw new Error(`work not found: ${workId}`);
    const requestedName = options.friendlyName && options.friendlyName !== 'auto'
        ? cleanComponent(options.friendlyName)
        : autoFriendlyName(work);
    if (!requestedName) throw new Error('friendlyName is empty after sanitization');
    const exportDir = join(parent, requestedName);
    if (await pathExists(exportDir)) {
        const error = new Error(`export destination already exists: ${exportDir}`);
        error.code = 'EEXPORTEXISTS';
        throw error;
    }
    await ensureDir(parent);
    const tempDir = join(parent, `.${requestedName}.tmp-${process.pid}-${Date.now()}`);
    await mkdir(tempDir, { recursive: false });

    try {
        const monochromeDir = join(tempDir, 'monochrome');
        const contentDir = join(tempDir, 'content');
        await mkdir(monochromeDir, { recursive: true });
        await mkdir(contentDir, { recursive: true });

        const files = [];
        const usedPaths = new Set();
        for (const entry of work.entries || []) {
            const logicalPath = validateContentLogicalPath(entry.logicalPath);
            if (usedPaths.has(logicalPath)) throw new Error(`duplicate logical path: ${logicalPath}`);
            usedPaths.add(logicalPath);
            const asset = entryAsset(entry);
            if (!asset) {
                const error = new Error(`entry has no managed asset and cannot be a self-contained export: ${logicalPath}`);
                error.code = 'EEXPORTNOASSET';
                throw error;
            }
            const target = join(contentDir, ...logicalPath.split('/'));
            await ensureDir(join(target, '..'));
            const facts = await copyAsset(library, asset, target);
            files.push({
                logicalPath,
                path: `content/${logicalPath}`,
                sha256: facts.sha256,
                bytes: facts.bytes,
                kind: entry.kind,
                mime: asset.mime || entry.mime || 'application/octet-stream',
            });
        }

        const coverEntry = coverEntryOf(work);
        let cover = null;
        if (coverEntry) {
            const asset = entryAsset(coverEntry);
            if (!asset) throw new Error(`cover entry has no managed asset: ${coverEntry.logicalPath}`);
            const extension = coverExtension(coverEntry, asset);
            const coverPath = `monochrome/cover${extension}`;
            const target = join(tempDir, ...coverPath.split('/'));
            const facts = await copyAsset(library, asset, target);
            cover = {
                logicalPath: coverEntry.logicalPath,
                path: coverPath,
                sha256: facts.sha256,
                bytes: facts.bytes,
                mime: asset.mime || 'application/octet-stream',
                format: extension.replace(/^\./, ''),
            };
        }

        const manifest = {
            format: EXPORT_FORMAT,
            formatVersion: EXPORT_FORMAT_VERSION,
            libraryId: library.libraryId,
            workId: work.workId,
            revision: work.revision,
            friendlyName: requestedName,
            createdAt: now(),
            completedAt: now(),
            work: {
                title: work.title,
                userTitle: work.userTitle,
                circle: work.circle,
                cvs: work.cvs,
                language: work.language,
                role: work.role,
            },
            sourceRefs: (work.sourceRefs || []).map((source) => ({
                provider: source.provider,
                sourceCode: source.sourceCode,
                sourceUrl: source.sourceUrl,
            })),
            files,
            cover,
            counts: {
                files: files.length,
                assets: files.length,
                totalBytes: files.reduce((total, file) => total + file.bytes, 0),
            },
        };
        const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
        await atomicWrite(join(monochromeDir, 'manifest.json'), manifestText);
        await atomicWrite(
            join(monochromeDir, 'COMPLETE'),
            `${JSON.stringify(
                {
                    manifestSha256: sha256Text(manifestText),
                    completedAt: now(),
                    format: EXPORT_FORMAT,
                },
                null,
                2
            )}\n`
        );
        await rename(tempDir, exportDir);
        return {
            dir: exportDir,
            exportDir,
            path: exportDir,
            exportPath: exportDir,
            friendlyName: requestedName,
            manifest,
            complete: true,
        };
    } catch (error) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

function issue(issues, code, detail) {
    issues.push({ code, detail });
}

async function collectActualFiles(root) {
    const result = [];
    const walk = async (directory) => {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const absolute = join(directory, entry.name);
            const relativePath = slash(relative(root, absolute));
            let info;
            try {
                info = await lstat(absolute);
            } catch (error) {
                result.push({ path: relativePath, unreadable: true, error: String(error?.message || error) });
                continue;
            }
            if (info.isSymbolicLink()) {
                result.push({ path: relativePath, symlink: true });
            } else if (info.isDirectory()) {
                await walk(absolute);
            } else if (info.isFile()) {
                result.push({ path: relativePath, symlink: false });
            } else {
                result.push({ path: relativePath, other: true });
            }
        }
    };
    await walk(root);
    return result;
}

/**
 * Verify a self-contained export without touching its source library.
 */
export async function verifyExport(exportDir) {
    const dir = resolve(String(exportDir || ''));
    const issues = [];
    try {
        assertInsideExperiment(dir);
        const manifestPath = join(dir, 'monochrome', 'manifest.json');
        const completePath = join(dir, 'monochrome', 'COMPLETE');
        const manifest = await readJson(manifestPath, null);
        if (!manifest) return { ok: false, dir, issues: [{ code: 'manifest-missing', detail: manifestPath }], manifest: null };
        if (manifest.format !== EXPORT_FORMAT) issue(issues, 'manifest-format', manifest.format);
        if (Number(manifest.formatVersion) !== EXPORT_FORMAT_VERSION) issue(issues, 'manifest-version', manifest.formatVersion);
        if (!manifest.libraryId) issue(issues, 'manifest-library-id', 'libraryId missing');
        if (!manifest.workId) issue(issues, 'manifest-work-id', 'workId missing');
        if (!(await pathExists(completePath))) {
            issue(issues, 'missing-complete', 'COMPLETE marker missing');
        } else {
            try {
                const marker = JSON.parse(await readFile(completePath, 'utf8'));
                const manifestRaw = await readFile(manifestPath, 'utf8');
                if (marker.manifestSha256 !== sha256Text(manifestRaw)) {
                    issue(issues, 'complete-manifest-hash', 'COMPLETE does not match manifest.json');
                }
            } catch (error) {
                issue(issues, 'complete-unreadable', String(error?.message || error));
            }
        }
        for (const file of manifest.files || []) {
            const relativePath = slash(file.path);
            if (!relativePath.startsWith('content/') || relativePath.includes('/../') || relativePath.startsWith('../')) {
                issue(issues, 'file-path', file.path);
                continue;
            }
            const path = join(dir, ...relativePath.split('/'));
            try {
                await assertNoReparse(path);
                const info = await regularFile(path, file.path);
                if (Number(info.nlink || 1) > 1) issue(issues, 'file-hardlink', file.path);
                const hashed = await hashFile(path);
                if (Number(info.size) !== Number(file.bytes) || hashed.sha256 !== file.sha256) {
                    issue(issues, 'file-hash-mismatch', file.path);
                }
            } catch (error) {
                issue(issues, 'file-unreadable', { path: file.path, error: String(error?.message || error) });
            }
        }
        if (manifest.cover) {
            const coverPath = slash(manifest.cover.path);
            if (!coverPath.startsWith('monochrome/')) issue(issues, 'cover-path', manifest.cover.path);
            else {
                const path = join(dir, ...coverPath.split('/'));
                try {
                    await assertNoReparse(path);
                    const info = await regularFile(path, manifest.cover.path);
                    if (Number(info.nlink || 1) > 1) issue(issues, 'cover-hardlink', manifest.cover.path);
                    const hashed = await hashFile(path);
                    if (Number(info.size) !== Number(manifest.cover.bytes) || hashed.sha256 !== manifest.cover.sha256) {
                        issue(issues, 'cover-hash-mismatch', manifest.cover.path);
                    }
                } catch (error) {
                    issue(issues, 'cover-unreadable', { path: manifest.cover.path, error: String(error?.message || error) });
                }
            }
        }
        // The manifest is the truth for a self-contained export. Walk the actual
        // tree, not just manifest entries, so an unlisted file cannot be smuggled in.
        const expected = new Set();
        for (const file of manifest.files || []) expected.add(slash(file.path));
        expected.add('monochrome/manifest.json');
        expected.add('monochrome/COMPLETE');
        if (manifest.cover?.path) expected.add(slash(manifest.cover.path));
        const actualFiles = await collectActualFiles(dir);
        for (const actual of actualFiles) {
            if (!expected.has(actual.path)) {
                issue(issues, 'extra-file', {
                    path: actual.path,
                    reason: actual.symlink ? 'symlink-not-in-manifest' : 'not-in-manifest',
                });
            }
        }

        return {
            ok: issues.length === 0,
            dir,
            issues,
            manifest,
            libraryId: manifest.libraryId,
            workId: manifest.workId,
        };
    } catch (error) {
        issue(issues, 'verify-error', String(error?.message || error));
        return { ok: false, dir, issues, manifest: null };
    }
}

export { cleanComponent, autoFriendlyName };
