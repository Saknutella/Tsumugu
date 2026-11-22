// Read-only local voice scanner / preview core (79-S2).
//
// This module intentionally never imports the SQLite library, hashes bytes, writes
// files, renames sources, or follows symlinks/junctions. It only enumerates the
// authorized tree, identifies candidate work roots, and returns a preview for the
// UI/import layer to confirm. All later I/O must re-validate its path boundary.
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.aiff', '.aif']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.lrc', '.sub']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.tif', '.tiff']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz']);
const METADATA_JSON_NAMES = new Set(['metadata.json', 'meta.json', 'work.json', 'info.json', 'source.json', 'release.json']);
const METADATA_TEXT_NAMES = new Set(['info.txt', 'metadata.txt', 'readme.txt', 'info.nfo']);

const STRUCTURAL_NAMES = new Set([
    '音声本体',
    '音声',
    'wav',
    'mp3',
    'flac',
    'aac',
    'ogg',
    'opus',
    '字幕',
    'subtitle',
    'subtitles',
    '画像',
    'image',
    'images',
    '特典',
    'bonus',
    'omake',
    'se',
    'bgm',
    'sound',
    'audio',
    'voice',
    'voices',
    'cover',
    'covers',
    'scan',
    'scans',
    'booklet',
    'manual',
    '歌词',
    'lyrics',
]);

const EXCLUDED_DIR_NAMES = new Set([
    'library',
    'assets',
    'tmp',
    'cache',
    'index',
    'trash',
    'exports',
    'quarantine',
    '.git',
    'node_modules',
    '$recycle.bin',
    'system volume information',
]);

const SYSTEM_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_IMAGE_HEAD_BYTES = 256 * 1024;

function normalizedName(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function extensionOf(name) {
    return extname(String(name || '')).toLowerCase();
}

function kindOf(name) {
    const extension = extensionOf(name);
    if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
    if (SUBTITLE_EXTENSIONS.has(extension)) return 'subtitle';
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
    // The preview enum follows the S2 verifier contract: audio|subtitle|image|archive|extra.
    // Sidecars are still parsed separately by name, but do not invent a sixth kind.
    return 'extra';
}

function slashPath(path) {
    return String(path).split(sep).join('/');
}

function relativeLogical(root, path) {
    const rel = relative(root, path);
    if (!rel || rel === '.') return '';
    return slashPath(rel);
}

function isSameOrInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeRelativeRoot(root, path) {
    const rel = relativeLogical(root, path);
    return rel || '.';
}

function extractRj(text) {
    const match = String(text || '').match(/(?:^|[^A-Za-z0-9])RJ(\d{5,8})(?![0-9])/i);
    return match ? `RJ${match[1]}` : null;
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result;
}

function splitCvs(value) {
    if (Array.isArray(value)) return uniqueStrings(value.flatMap((item) => splitCvs(item)));
    if (value === null || value === undefined || value === '') return [];
    return uniqueStrings(String(value).split(/[,，、;/|]+/));
}

function cleanFolderTitle(name, sourceCode) {
    let title = String(name || '').normalize('NFKC').trim();
    if (!title) return 'Untitled local work';
    title = title.replace(/^[\[(（【]\s*RJ\d{5,8}\s*[\])）】]\s*/i, '');
    if (sourceCode) {
        const escaped = sourceCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        title = title.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '').trim();
    }
    title = title.replace(/^[\[(（【][^\])）】]{1,80}[\])）】]\s*/, '').trim();
    title = title.replace(/\s*[\[(（【](?:RJ\d{5,8}|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)[\])）】]\s*$/i, '').trim();
    return title || 'Untitled local work';
}

function parseCircleFromName(name) {
    const match = String(name || '').match(/^\s*[\[(（【]\s*([^\])）】]{1,80}?)\s*[\])）】]/);
    if (!match) return '';
    const candidate = match[1].trim();
    if (!candidate || extractRj(candidate) || /^\d{4}[-/.]\d{1,2}/.test(candidate)) return '';
    return candidate;
}

function countAudio(info, recursive = true) {
    let count = info.directFiles.filter((file) => file.kind === 'audio').length;
    if (recursive) {
        for (const child of info.childDirs) count += child.audioCount;
    }
    return count;
}

function countEntries(info) {
    let count = info.directFiles.length;
    for (const child of info.childDirs) count += countEntries(child);
    return count;
}

function countCovers(info) {
    let count = info.coverCandidates.length;
    for (const child of info.childDirs) count += countCovers(child);
    return count;
}

async function readHead(path, maxBytes) {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/** Best-effort image dimensions, no full decode and no image dependency. */
function imageSizeFromHead(buffer, extension) {
    try {
        if (extension === '.png' && buffer.length >= 24) {
            if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
            return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
        }
        if (extension === '.gif' && buffer.length >= 10) {
            if (buffer.toString('ascii', 0, 3) !== 'GIF') return null;
            return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
        }
        if (extension === '.bmp' && buffer.length >= 26) {
            if (buffer.toString('ascii', 0, 2) !== 'BM') return null;
            return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
        }
        if (extension === '.webp' && buffer.length >= 30) {
            if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
            const chunk = buffer.toString('ascii', 12, 16);
            if (chunk === 'VP8X') {
                return {
                    width: 1 + buffer.readUIntLE(24, 3),
                    height: 1 + buffer.readUIntLE(27, 3),
                };
            }
            if (chunk === 'VP8 ' && buffer.length >= 30) {
                return {
                    width: buffer.readUInt16LE(26) & 0x3fff,
                    height: buffer.readUInt16LE(28) & 0x3fff,
                };
            }
            return null;
        }
        if ((extension === '.jpg' || extension === '.jpeg') && buffer.length >= 4) {
            if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
            let offset = 2;
            while (offset + 9 < buffer.length) {
                if (buffer[offset] !== 0xff) {
                    offset += 1;
                    continue;
                }
                const marker = buffer[offset + 1];
                if (marker === 0xd8 || marker === 0xd9) {
                    offset += 2;
                    continue;
                }
                const length = buffer.readUInt16BE(offset + 2);
                if (length < 2) return null;
                if (marker >= 0xc0 && marker <= 0xc3) {
                    return {
                        height: buffer.readUInt16BE(offset + 5),
                        width: buffer.readUInt16BE(offset + 7),
                    };
                }
                offset += 2 + length;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function normalizeMetadata(raw, metadataFile) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = raw.title ?? raw.workTitle ?? raw.name ?? raw.album;
    const circle = raw.circle ?? raw.circleName ?? raw.brand ?? raw.artist;
    const code = raw.sourceCode ?? raw.rj ?? raw.productId ?? raw.product_id;
    const cvs = raw.cvs ?? raw.cv ?? raw.voiceActors ?? raw.voice_actors ?? raw.cast;
    const language = raw.language ?? raw.edition?.language;
    const role = raw.role ?? raw.edition?.role;
    return {
        metadataFile,
        title: typeof title === 'string' ? title.trim() : '',
        circle: typeof circle === 'string' ? circle.trim() : '',
        sourceCode: typeof code === 'string' ? extractRj(code) || code.trim().toUpperCase() : '',
        cvs: splitCvs(cvs),
        language: typeof language === 'string' ? language.trim() : '',
        role: typeof role === 'string' ? role.trim() : '',
    };
}

function parseTextMetadata(text, metadataFile) {
    const result = {
        metadataFile,
        title: '',
        circle: '',
        sourceCode: '',
        cvs: [],
        language: '',
        role: '',
    };
    for (const line of String(text || '').split(/\r?\n/).slice(0, 400)) {
        const match = line.match(/^\s*([A-Za-z_ ]{2,24})\s*[:=]\s*(.+?)\s*$/);
        if (!match) continue;
        const key = match[1].trim().toLowerCase();
        const value = match[2].trim();
        if (['title', 'name', 'work', 'work title'].includes(key)) result.title ||= value;
        else if (['circle', 'brand', 'artist'].includes(key)) result.circle ||= value;
        else if (['cv', 'cvs', 'cast', 'voice actors'].includes(key)) result.cvs.push(...splitCvs(value));
        else if (['rj', 'code', 'sourcecode', 'product'].includes(key)) result.sourceCode ||= extractRj(value) || value;
        else if (['language', 'lang'].includes(key)) result.language ||= value;
        else if (['role', 'edition'].includes(key)) result.role ||= value;
    }
    result.cvs = uniqueStrings(result.cvs);
    return result;
}

async function readMetadataFile(file) {
    try {
        const head = await readHead(file.absolutePath, MAX_METADATA_BYTES);
        if (METADATA_JSON_NAMES.has(normalizedName(file.name)) || extensionOf(file.name) === '.json') {
            let parsed;
            try {
                parsed = JSON.parse(head.toString('utf8'));
            } catch {
                return null;
            }
            return normalizeMetadata(parsed, file.logicalPath);
        }
        if (METADATA_TEXT_NAMES.has(normalizedName(file.name))) {
            return parseTextMetadata(head.toString('utf8'), file.logicalPath);
        }
    } catch {
        return null;
    }
    return null;
}

class ScanContext {
    constructor({ sourceRoot, libraryRoot, maxDepth, maxFiles }) {
        this.sourceRoot = sourceRoot;
        this.libraryRoot = libraryRoot;
        this.maxDepth = maxDepth;
        this.maxFiles = maxFiles;
        this.scannedFiles = 0;
        this.scannedDirectories = 0;
        this.depthLimited = false;
        this.fileLimited = false;
        this.rejected = [];
        this.infos = [];
    }

    get truncated() {
        return this.depthLimited || this.fileLimited;
    }

    reject(absolutePath, reason, detail = '') {
        this.rejected.push({
            path: absolutePath,
            relativePath: slashPath(relative(this.sourceRoot, absolutePath)) || '.',
            reason,
            ...(detail ? { detail } : {}),
        });
    }
}

function isExcludedDirectoryName(name) {
    return EXCLUDED_DIR_NAMES.has(normalizedName(name));
}

function isStructuralDirectoryName(name) {
    return STRUCTURAL_NAMES.has(normalizedName(name));
}

function isSystemFile(name) {
    return SYSTEM_FILE_NAMES.has(normalizedName(name));
}

function isMetadataName(name) {
    return METADATA_JSON_NAMES.has(normalizedName(name)) || METADATA_TEXT_NAMES.has(normalizedName(name));
}

function isCoverName(name) {
    const stem = basename(String(name || ''), extname(String(name || ''))).normalize('NFKC').toLowerCase();
    return /^(cover|folder|front|front cover|jacket|package|package image|表紙|封面|パッケージ|パッケージ画像|main)$/.test(stem);
}

function coverScore(name) {
    const stem = basename(String(name || ''), extname(String(name || ''))).normalize('NFKC').toLowerCase();
    if (/^(cover|folder|front|jacket|package|表紙|封面|パッケージ)$/.test(stem)) return 30;
    return 10;
}

async function inspectDirectory(absolutePath, relativePath, depth, ctx) {
    if (ctx.fileLimited) return null;
    ctx.scannedDirectories += 1;
    const info = {
        path: absolutePath,
        relativePath: relativePath || '.',
        depth,
        name: basename(absolutePath),
        directFiles: [],
        childDirs: [],
        metadata: null,
        metadataFile: '',
        rjCodes: new Set(),
        coverCandidates: [],
        evidence: [],
        ambiguities: [],
        excluded: [],
        directAudioCount: 0,
        audioCount: 0,
        entryCount: 0,
        coverCount: 0,
    };

    const ownRj = extractRj(info.name);
    if (ownRj) info.rjCodes.add(ownRj);

    let names;
    try {
        names = await readdir(absolutePath);
    } catch (error) {
        ctx.reject(absolutePath, 'unreadable-directory', String(error?.message || error));
        return info;
    }
    names.sort((a, b) => a.localeCompare(b));

    for (const name of names) {
        if (ctx.fileLimited) break;
        const childPath = join(absolutePath, name);
        const childRelative = relativeLogical(ctx.sourceRoot, childPath);
        if (isSystemFile(name)) continue;
        if (isExcludedDirectoryName(name)) {
            // Still stat so a file named "cache" is not silently treated as a dir.
            let stat;
            try {
                stat = await lstat(childPath);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                info.excluded.push({ path: childRelative, reason: 'excluded-directory' });
                ctx.reject(childPath, 'excluded-directory');
            }
            continue;
        }
        if (ctx.libraryRoot && isSameOrInside(ctx.libraryRoot, childPath)) {
            // The whole library root is excluded. Do not follow it, even if it is a file.
            info.excluded.push({ path: childRelative, reason: 'library-root' });
            ctx.reject(childPath, 'library-root');
            continue;
        }

        let stat;
        try {
            stat = await lstat(childPath);
        } catch (error) {
            ctx.reject(childPath, 'unreadable-entry', String(error?.message || error));
            continue;
        }
        if (stat.isSymbolicLink()) {
            ctx.reject(childPath, 'symlink-or-junction');
            info.excluded.push({ path: childRelative, reason: 'symlink-or-junction' });
            continue;
        }
        if (stat.isDirectory()) {
            if (depth >= ctx.maxDepth) {
                ctx.depthLimited = true;
                ctx.reject(childPath, 'max-depth');
                info.excluded.push({ path: childRelative, reason: 'max-depth' });
                continue;
            }
            const child = await inspectDirectory(childPath, childRelative, depth + 1, ctx);
            if (child) info.childDirs.push(child);
            continue;
        }
        if (!stat.isFile()) {
            ctx.reject(childPath, 'not-regular-file');
            continue;
        }
        if (ctx.scannedFiles >= ctx.maxFiles) {
            ctx.fileLimited = true;
            break;
        }
        ctx.scannedFiles += 1;
        const kind = kindOf(name);
        const file = {
            name,
            absolutePath: childPath,
            logicalPath: relativeLogical(absolutePath, childPath),
            extension: extensionOf(name),
            size: stat.size,
            kind,
        };
        info.directFiles.push(file);
        if (kind === 'audio') info.directAudioCount += 1;
        const fileRj = extractRj(name);
        if (fileRj) info.rjCodes.add(fileRj);
        if (kind === 'image' && isCoverName(name)) {
            let width;
            let height;
            try {
                const head = await readHead(childPath, MAX_IMAGE_HEAD_BYTES);
                const size = imageSizeFromHead(head, file.extension);
                if (size && size.width > 0 && size.height > 0) {
                    width = size.width;
                    height = size.height;
                }
            } catch {
                /* dimensions are best-effort */
            }
            info.coverCandidates.push({
                path: childPath,
                relativePath: file.logicalPath,
                source: 'local',
                name,
                score: coverScore(name),
                ...(width ? { width } : {}),
                ...(height ? { height } : {}),
            });
        }
    }

    // Sidecar metadata is read only after the file list is known. It is not used
    // to authorize any path; it only supplies display candidates.
    for (const file of info.directFiles) {
        if (!isMetadataName(file.name)) continue;
        const metadata = await readMetadataFile(file);
        if (!metadata) continue;
        info.metadata = metadata;
        info.metadataFile = file.logicalPath;
        if (metadata.sourceCode) {
            const code = extractRj(metadata.sourceCode);
            if (code) info.rjCodes.add(code);
        }
        break;
    }

    info.audioCount = countAudio(info, true);
    info.entryCount = countEntries(info);
    info.coverCount = countCovers(info);
    const hasDirectContent = info.directFiles.length > 0;
    const hasDescendantContent = hasDirectContent || info.childDirs.some((child) => child.entryCount > 0);
    info.hasDirectContent = hasDirectContent;
    info.hasDescendantContent = hasDescendantContent;
    info.structural = isStructuralDirectoryName(info.name);
    info.strong =
        info.rjCodes.size > 0 ||
        Boolean(info.metadata?.title || info.metadata?.sourceCode) ||
        (info.coverCandidates.length > 0 && info.audioCount > 0 && !info.structural);

    if (info.rjCodes.size > 1) {
        info.ambiguities.push(`rj-conflict:${[...info.rjCodes].sort().join(',')}`);
    }
    if (info.metadata?.title) info.evidence.push(`metadata:${info.metadataFile}`);
    for (const code of [...info.rjCodes].sort()) info.evidence.push(`rj:${code}`);
    if (info.audioCount > 0) info.evidence.push(`audio:${info.audioCount}`);
    if (info.coverCount > 0) info.evidence.push(`cover:${info.coverCount}`);
    if (!info.evidence.length && info.entryCount > 0) info.evidence.push('files:present');
    if (info.structural) info.evidence.push(`structural:${normalizedName(info.name)}`);

    ctx.infos.push(info);
    return info;
}

function flattenInfos(rootInfo) {
    const result = [];
    const visit = (info) => {
        result.push(info);
        for (const child of info.childDirs) visit(child);
    };
    visit(rootInfo);
    return result;
}

function isIndependentStrong(info) {
    if (!info.strong || !info.hasDescendantContent) return false;
    return info.rjCodes.size > 0 || Boolean(info.metadata?.title || info.metadata?.sourceCode);
}

function chooseCandidates(rootInfo, mode, ctx) {
    const infos = flattenInfos(rootInfo);
    const byPath = new Map(infos.map((info) => [info.path, info]));
    const allStrong = infos.filter((info) => isIndependentStrong(info) && info.path !== rootInfo.path);
    const rootStrong = isIndependentStrong(rootInfo);
    let selected = [];

    if (mode === 'single') {
        // Single mode keeps the selected directory as the boundary. Only truly
        // independent RJ/metadata children trigger a split preview; one child alone
        // does not silently replace the selected root.
        if (allStrong.length >= 2) {
            selected = allStrong;
            ctx.ambiguities.push('multiple-work-candidates-in-single-mode');
        } else {
            selected = [rootInfo];
        }
    } else {
        // Batch mode: strong markers are independent roots; do not add their
        // ancestors. Directly-audio directories become roots only when no selected
        // ancestor already covers them. Structural dirs never become works.
        selected = infos.filter((info) => isIndependentStrong(info));
        const selectedPaths = new Set(selected.map((info) => info.path));
        // A no-RJ local work is still a candidate when it owns audio somewhere in
        // its tree (often under 音声/音声本体). Structural dirs never become works.
        // If a selected strong child already lives under this dir, the parent is a
        // container and is not added, preventing silent swallowing.
        for (const info of [...infos].sort((a, b) => a.depth - b.depth)) {
            if (selectedPaths.has(info.path) || info.structural) continue;
            if (!info.hasDescendantContent || info.audioCount === 0) continue;
            if (selected.some((candidate) => candidate.path !== info.path && isSameOrInside(info.path, candidate.path))) {
                continue;
            }
            selected.push(info);
            selectedPaths.add(info.path);
        }
        if (!selected.length && rootInfo.hasDescendantContent) selected = [rootInfo];
    }

    // Remove duplicate paths and ancestors that are only containers of a selected
    // strong child and have no own direct content. A container may still keep its
    // metadata/cover-only role if it has direct files.
    selected = [...new Map(selected.map((info) => [info.path, info])).values()];
    const selectedPaths = new Set(selected.map((info) => info.path));
    selected = selected.filter(
        (info) =>
            info.path === rootInfo.path ||
            !selected.some(
                (other) =>
                    other.path !== info.path &&
                    isSameOrInside(info.path, other.path) &&
                    !info.hasDirectContent &&
                    !info.metadata?.title &&
                    !info.rjCodes.size
            )
    );

    // A candidate must cover at least one file; metadata-only empty dirs are not
    // useful previews. If a selected ancestor has only nested selected children and
    // no files of its own, drop it unless it is the root fallback.
    const withContent = selected.filter((info) => {
        const nestedSelected = selected.some(
            (other) => other.path !== info.path && isSameOrInside(info.path, other.path)
        );
        return (
            info.hasDescendantContent &&
            (!nestedSelected ||
                info.hasDirectContent ||
                info.path === rootInfo.path ||
                info.rjCodes.size > 0 ||
                Boolean(info.metadata?.title || info.metadata?.sourceCode))
        );
    });
    if (withContent.length) selected = withContent;

    // In batch mode the parent must not swallow two independent children. If the
    // root was selected only as a fallback but has multiple independent strong
    // descendants, those descendants win.
    if (mode === 'batch' && selected.some((info) => info.path === rootInfo.path) && allStrong.length >= 2) {
        selected = allStrong;
    }

    // Stable deterministic ordering; deepest-independent children after parents.
    selected.sort((a, b) => a.depth - b.depth || a.relativePath.localeCompare(b.relativePath));
    return selected;
}

function collectFiles(info, candidatePaths) {
    const files = [];
    const walk = (node) => {
        for (const file of node.directFiles) files.push(file);
        for (const child of node.childDirs) {
            if (child.path !== info.path && candidatePaths.has(child.path)) continue;
            walk(child);
        }
    };
    walk(info);
    return files;
}

function collectCovers(info, candidatePaths) {
    const covers = [];
    const walk = (node) => {
        covers.push(...node.coverCandidates);
        for (const child of node.childDirs) {
            if (child.path !== info.path && candidatePaths.has(child.path)) continue;
            walk(child);
        }
    };
    walk(info);
    return covers;
}

function buildCandidate(info, { rootInfo, ctx, mode, selectedPaths }) {
    const nestedSelected = [...selectedPaths].filter((path) => path !== info.path && isSameOrInside(info.path, path));
    const candidatePaths = new Set(selectedPaths);
    const files = collectFiles(info, candidatePaths);
    const covers = collectCovers(info, candidatePaths).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const entries = files.map((file) => ({
        logicalPath: relativeLogical(info.path, file.absolutePath),
        absolutePath: file.absolutePath,
        kind: file.kind,
        size: file.size,
        ...(file.extension ? { extension: file.extension } : {}),
    }));
    const metadata = info.metadata || null;
    const rjCodes = [...info.rjCodes].sort();
    const sourceCode = metadata?.sourceCode
        ? extractRj(metadata.sourceCode) || metadata.sourceCode
        : rjCodes[0] || null;
    const folderTitle = metadata?.title || cleanFolderTitle(info.name, sourceCode);
    const circle = metadata?.circle || parseCircleFromName(info.name);
    const cvs = metadata?.cvs?.length ? metadata.cvs : [];
    const audioEntries = entries.filter((entry) => entry.kind === 'audio');
    const subtitleEntries = entries.filter((entry) => entry.kind === 'subtitle');
    const imageEntries = entries.filter((entry) => entry.kind === 'image');
    const archiveEntries = entries.filter((entry) => entry.kind === 'archive');
    const ambiguities = [...info.ambiguities];
    if (!sourceCode) ambiguities.push('no-rj-code:lower-confidence-local-work');
    if (metadata?.sourceCode && !extractRj(metadata.sourceCode)) {
        ambiguities.push('non-rj-source-code:not-authoritative');
    }
    if (nestedSelected.length) ambiguities.push('nested-work-candidates:preview-split');
    if (ctx.depthLimited) ambiguities.push('max-depth-reached:preview-truncated');
    if (ctx.fileLimited) ambiguities.push('max-files-reached:preview-truncated');
    if (mode === 'single' && selectedPaths.size > 1) ambiguities.push('single-mode-multiple-candidates:needs-user-split');
    let confidence = 0.3;
    if (sourceCode) confidence = metadata?.title ? 0.95 : 0.85;
    else if (metadata?.title) confidence = 0.8;
    else if (audioEntries.length > 0) confidence = 0.55;
    else if (covers.length > 0 || entries.length > 0) confidence = 0.4;
    if (!sourceCode) confidence = Math.min(confidence, 0.55);
    if (nestedSelected.length) confidence = Math.min(confidence, 0.7);
    confidence = Math.round(confidence * 100) / 100;

    const evidence = [...info.evidence];
    if (metadata?.file) evidence.push(`metadata-file:${metadata.metadataFile}`);
    if (audioEntries.length) evidence.push(`entry-audio:${audioEntries.length}`);
    if (subtitleEntries.length) evidence.push(`entry-subtitle:${subtitleEntries.length}`);
    if (imageEntries.length) evidence.push(`entry-image:${imageEntries.length}`);
    if (archiveEntries.length) evidence.push(`entry-archive:${archiveEntries.length}`);
    if (!evidence.length) evidence.push('files:present');

    const excluded = [];
    for (const item of info.excluded) excluded.push(item);
    for (const rejected of ctx.rejected) {
        if (isSameOrInside(info.path, rejected.path) && !nestedSelected.some((path) => isSameOrInside(path, rejected.path))) {
            excluded.push({ path: rejected.relativePath, reason: rejected.reason });
        }
    }

    return {
        candidateId: `local:${normalizeRelativeRoot(ctx.sourceRoot, info.path)}`,
        rootPath: info.path,
        relativeRoot: normalizeRelativeRoot(ctx.sourceRoot, info.path),
        confidence,
        confidenceLabel: confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low',
        evidence,
        sourceCode,
        folderTitle,
        circle,
        cvs,
        entries,
        coverCandidates: covers.map((cover) => ({
            path: cover.path,
            relativePath: relativeLogical(info.path, cover.path),
            source: cover.source,
            name: cover.name,
            ...(cover.width ? { width: cover.width } : {}),
            ...(cover.height ? { height: cover.height } : {}),
        })),
        excluded,
        ambiguities,
        savingBytes: 'pending',
        counts: {
            entries: entries.length,
            audio: audioEntries.length,
            subtitles: subtitleEntries.length,
            images: imageEntries.length,
            archives: archiveEntries.length,
        },
        ...(metadata
            ? {
                  metadata: {
                      file: metadata.metadataFile,
                      title: metadata.title,
                      circle: metadata.circle,
                      sourceCode: metadata.sourceCode,
                      cvs: metadata.cvs,
                      language: metadata.language,
                      role: metadata.role,
                  },
              }
            : {}),
    };
}

/**
 * Scan a local source tree without writes, hashes, DB access or renames.
 *
 * @param {string} sourceRoot absolute or project-relative selected directory
 * @param {{mode:'single'|'batch', libraryRoot?:string, maxDepth?:number, maxFiles?:number}} options
 */
export async function scanSource(sourceRoot, options = {}) {
    if (!sourceRoot || typeof sourceRoot !== 'string') throw new Error('sourceRoot is required');
    const mode = options.mode || 'single';
    if (!['single', 'batch'].includes(mode)) throw new Error("mode must be 'single' or 'batch'");
    const maxDepth = options.maxDepth === undefined ? 8 : Number(options.maxDepth);
    const maxFiles = options.maxFiles === undefined ? 5000 : Number(options.maxFiles);
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth must be a non-negative integer');
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('maxFiles must be a positive integer');

    const absoluteSource = resolve(sourceRoot);
    let sourceStat;
    try {
        sourceStat = await lstat(absoluteSource);
    } catch (error) {
        const wrapped = new Error(`sourceRoot is not readable: ${absoluteSource}`);
        wrapped.code = 'ESOURCE_UNREADABLE';
        throw wrapped;
    }
    if (sourceStat.isSymbolicLink()) {
        const error = new Error('sourceRoot must not be a symlink or junction');
        error.code = 'ESOURCE_REPARSE';
        throw error;
    }
    if (!sourceStat.isDirectory()) {
        const error = new Error('sourceRoot must be a directory');
        error.code = 'ESOURCE_NOT_DIRECTORY';
        throw error;
    }

    let libraryRoot = null;
    if (options.libraryRoot) {
        libraryRoot = resolve(options.libraryRoot);
        if (isSameOrInside(libraryRoot, absoluteSource) && !isSameOrInside(absoluteSource, libraryRoot)) {
            const error = new Error('sourceRoot is inside the library root');
            error.code = 'ESOURCE_LIBRARY';
            throw error;
        }
        if (absoluteSource === libraryRoot || isSameOrInside(libraryRoot, absoluteSource)) {
            const error = new Error('sourceRoot is the library root or inside it');
            error.code = 'ESOURCE_LIBRARY';
            throw error;
        }
    }

    const ctx = new ScanContext({ sourceRoot: absoluteSource, libraryRoot, maxDepth, maxFiles });
    ctx.ambiguities = [];
    const rootInfo = await inspectDirectory(absoluteSource, '.', 0, ctx);

    let selected = chooseCandidates(rootInfo, mode, ctx);
    if (!selected.length && rootInfo.hasDescendantContent) selected = [rootInfo];
    const selectedPaths = new Set(selected.map((info) => info.path));
    const candidates = selected.map((info) => buildCandidate(info, { rootInfo, ctx, mode, selectedPaths }));

    const rejected = [...ctx.rejected];
    const candidatePaths = new Set(candidates.map((candidate) => candidate.rootPath));
    const topAmbiguities = [...ctx.ambiguities];
    if (mode === 'single' && candidates.length > 1) topAmbiguities.push('single-mode-multiple-candidates:needs-user-split');
    if (mode === 'batch' && candidates.length > 1) topAmbiguities.push('batch-mode-multiple-candidates:preview-each');
    if (ctx.depthLimited) topAmbiguities.push('max-depth-reached');
    if (ctx.fileLimited) topAmbiguities.push('max-files-reached');

    // Files outside every selected candidate are not silently absorbed. Record only
    // source-root-level files so a batch preview can explain why they were ignored.
    for (const info of flattenInfos(rootInfo)) {
        for (const file of info.directFiles) {
            if ([...candidatePaths].some((path) => isSameOrInside(path, file.absolutePath))) continue;
            if (!rejected.some((item) => item.path === file.absolutePath)) {
                rejected.push({
                    path: file.absolutePath,
                    relativePath: slashPath(relative(absoluteSource, file.absolutePath)),
                    reason: 'outside-work-root',
                });
            }
        }
    }

    return {
        mode,
        sourceRoot: absoluteSource,
        libraryRoot,
        candidates,
        rejected,
        ambiguities: topAmbiguities,
        savingBytes: 'pending',
        limits: {
            maxDepth,
            maxFiles,
            scannedFiles: ctx.scannedFiles,
            scannedDirectories: ctx.scannedDirectories,
            truncated: ctx.truncated,
            depthLimited: ctx.depthLimited,
            fileLimited: ctx.fileLimited,
        },
    };
}
