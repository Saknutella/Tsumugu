// Path and root confinement for the storage lab.
//
// Every generated artifact must stay below <project>/.cache/storage-lab. The
// prototype is intentionally adversarial about Windows path syntax because the
// real MonochromeData backend will eventually run on NTFS.
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const EXPERIMENT_ROOT = join(PROJECT_ROOT, '.cache', 'storage-lab');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const INVALID_COMPONENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

export function resolveRoot(root, { allowOutsideRoot = false } = {}) {
    if (!root || typeof root !== 'string') throw new Error('root is required');
    const absolute = resolve(root);
    if (!allowOutsideRoot) {
        const rel = relative(EXPERIMENT_ROOT, absolute);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            const error = new Error(`root must be below ${EXPERIMENT_ROOT}`);
            error.code = 'EOUTSIDEROOT';
            throw error;
        }
    }
    return absolute;
}

export function assertInsideExperiment(path) {
    const absolute = resolve(path);
    const rel = relative(EXPERIMENT_ROOT, absolute);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        const error = new Error(`path escapes experiment root: ${path}`);
        error.code = 'EOUTSIDE';
        throw error;
    }
    return absolute;
}

export function validateComponent(component) {
    if (typeof component !== 'string' || component === '') throw new Error('empty path component');
    if (component === '.' || component === '..') throw new Error('dot path component');
    if (INVALID_COMPONENT_CHARS.test(component)) throw new Error(`invalid path character: ${component}`);
    if (component.endsWith('.') || component.endsWith(' ')) throw new Error(`trailing dot/space: ${component}`);
    if (WINDOWS_RESERVED.test(component)) throw new Error(`reserved Windows name: ${component}`);
    if (component.length > 200) throw new Error(`path component too long: ${component.length}`);
    const normalized = component.normalize('NFC');
    if (normalized.length > 200) throw new Error('NFC path component too long');
    return normalized;
}

export function validateLogicalPath(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('logical path is empty');
    if (/^[A-Za-z]:/.test(value) || value.startsWith('\\\\') || value.startsWith('//')) {
        throw new Error('absolute/drive/UNC logical path is not allowed');
    }
    if (value.startsWith('/') || value.startsWith('\\')) throw new Error('absolute logical path is not allowed');
    if (/[\u0000-\u001f]/.test(value)) throw new Error('control character in logical path');
    if (value.includes(':')) throw new Error('colon/ADS is not allowed');
    const normalizedSlashes = value.replace(/\\/g, '/');
    const segments = normalizedSlashes.split('/');
    if (segments.some((part) => part === '')) throw new Error('empty logical path segment');
    return segments.map(validateComponent).join('/');
}

async function assertNoReparse(path, { allowMissing = false } = {}) {
    const parts = resolve(path).split(sep);
    let current = parts[0] === '' ? sep : parts[0];
    for (let index = 1; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink()) throw new Error(`reparse point in path: ${current}`);
        } catch (error) {
            if (allowMissing && error.code === 'ENOENT') return;
            throw error;
        }
    }
}

export async function assertSafeDirectory(path, { allowMissing = true, allowOutsideRoot = false } = {}) {
    const absolute = allowOutsideRoot ? resolve(path) : assertInsideExperiment(path);
    await assertNoReparse(absolute, { allowMissing });
    return absolute;
}

function isInsideLexical(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Explicit read-only source roots outside the experiment root. The caller must
 * name absolute directories; wildcards, relative paths and symlink/junction
 * roots are rejected. This list is authorization, not a search path.
 */
export async function normalizeAllowedSourceRoots(roots) {
    if (roots === undefined || roots === null) return [];
    if (!Array.isArray(roots)) {
        const error = new Error('allowedSourceRoots must be an array of absolute directories');
        error.code = 'EINVALIDALLOWEDROOT';
        throw error;
    }
    const values = [];
    for (const value of roots) {
        if (typeof value !== 'string' || !value || !isAbsolute(value)) {
            const error = new Error('allowedSourceRoots entries must be explicit absolute paths');
            error.code = 'EINVALIDALLOWEDROOT';
            throw error;
        }
        const absolute = resolve(value);
        let info;
        try {
            info = await lstat(absolute);
        } catch (error) {
            const invalid = new Error(`allowed source root does not exist: ${absolute}`);
            invalid.code = 'EINVALIDALLOWEDROOT';
            invalid.cause = error;
            throw invalid;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            const error = new Error(`allowed source root must be a real directory, not a symlink/junction: ${absolute}`);
            error.code = 'EINVALIDALLOWEDROOT';
            throw error;
        }
        if (!values.includes(absolute)) values.push(absolute);
    }
    return values;
}

export { isInsideLexical };

export async function assertReadableSource(sourcePath, options = {}) {
    const allowedRoots = await normalizeAllowedSourceRoots(options.allowedSourceRoots);
    if (!sourcePath || typeof sourcePath !== 'string') throw new Error('sourcePath is required');
    const absolute = resolve(sourcePath);
    if (!isAbsolute(sourcePath)) throw new Error('sourcePath must be absolute');
    const insideExperiment = isInsideLexical(EXPERIMENT_ROOT, absolute);
    if (!insideExperiment && !allowedRoots.some((root) => isInsideLexical(root, absolute))) {
        const error = new Error(`source is outside the experiment root and not in allowedSourceRoots: ${absolute}`);
        error.code = 'EOUTSIDE';
        throw error;
    }
    await assertNoReparse(absolute, { allowMissing: false });
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error(`source is not a regular file: ${absolute}`);
    return await realpath(absolute);
}

export function logicalToPath(base, logicalPath) {
    return join(base, ...validateLogicalPath(logicalPath).split('/'));
}

export function isInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
