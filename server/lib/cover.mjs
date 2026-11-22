// C79-04: local explicit-cover selection with real PNG/JPEG header validation.
//
// No image library and no network. Dimensions come from actual bytes. The first
// increment selected explicit local covers; the second adds ID3v2 APIC / FLAC
// PICTURE extraction and already-prefetched online candidates. Live fetch is a
// host concern and never happens here.
import { readFile, lstat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

const COVER_STEMS = new Map([
    ['cover', 50],
    ['folder', 40],
    ['front', 30],
    ['jacket', 20],
    ['package', 10],
]);
const EXPLICIT_COVER = /(?:^|[-_ ])(cover|folder|front|jacket|package)(?:$|[-_ ])/i;

function synchsafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function deUnsynchronise(bytes) {
    const output = [];
    for (let index = 0; index < bytes.length; index += 1) {
        output.push(bytes[index]);
        if (bytes[index] === 0xff && bytes[index + 1] === 0x00) index += 1;
    }
    return Buffer.from(output);
}

function imageFromBytes(bytes) {
    const parsed = parsePng(bytes) || parseJpeg(bytes);
    if (!parsed) return null;
    return {
        ...parsed,
        mime: parsed.format === 'png' ? 'image/png' : 'image/jpeg',
    };
}

function parseApic(payload, major) {
    let offset = 0;
    if (!payload || payload.length < 4) return null;
    const encoding = payload[offset];
    offset += 1;
    if (major === 2) {
        offset += 3; // PIC image format ("PNG"/"JPG")
        if (offset > payload.length) return null;
    } else {
        const mimeEnd = payload.indexOf(0, offset);
        if (mimeEnd < 0) return null;
        offset = mimeEnd + 1;
    }
    if (offset >= payload.length) return null;
    const pictureType = payload[offset];
    offset += 1;
    // Description is terminated by one NUL (single-byte encodings) or two NULs
    // for UTF-16. The image begins immediately after the terminator.
    if (encoding === 1 || encoding === 2) {
        let found = -1;
        for (let index = offset; index + 1 < payload.length; index += 2) {
            if (payload[index] === 0 && payload[index + 1] === 0) {
                found = index + 2;
                break;
            }
        }
        if (found < 0) return null;
        offset = found;
    } else {
        const descEnd = payload.indexOf(0, offset);
        if (descEnd < 0) return null;
        offset = descEnd + 1;
    }
    const image = imageFromBytes(payload.subarray(offset));
    if (!image) return null;
    return { ...image, pictureType, data: payload.subarray(offset) };
}

function parseId3(bytes) {
    if (bytes.length < 10 || bytes.toString('ascii', 0, 3) !== 'ID3') return null;
    const major = bytes[3];
    if (![2, 3, 4].includes(major)) return null;
    const flags = bytes[5];
    const tagSize = synchsafe(bytes, 6);
    if (tagSize <= 0 || 10 + tagSize > bytes.length) return null;
    let body = bytes.subarray(10, 10 + tagSize);
    if (flags & 0x80) body = deUnsynchronise(body);
    if (flags & 0x40) {
        let extendedSize = 0;
        try {
            extendedSize = major === 4 ? synchsafe(body, 0) : body.readUInt32BE(0);
        } catch {
            return null;
        }
        body = body.subarray(extendedSize);
    }
    let offset = 0;
    const pictures = [];
    while (offset + (major === 2 ? 6 : 10) <= body.length) {
        let id;
        let length;
        let headerSize;
        if (major === 2) {
            id = body.toString('ascii', offset, offset + 3);
            length = body.readUIntBE(offset + 3, 3);
            headerSize = 6;
        } else {
            id = body.toString('ascii', offset, offset + 4);
            length = major === 4 ? synchsafe(body, offset + 4) : body.readUInt32BE(offset + 4);
            headerSize = 10;
        }
        if (length <= 0 || offset + headerSize + length > body.length) break;
        if (id === 'APIC' || id === 'PIC') {
            const parsed = parseApic(body.subarray(offset + headerSize, offset + headerSize + length), major);
            if (parsed) pictures.push(parsed);
        }
        offset += headerSize + length;
    }
    if (!pictures.length) return null;
    return pictures.find((picture) => picture.pictureType === 3) || pictures[0];
}

function parseFlacPicture(block) {
    let offset = 0;
    const pictureType = block.readUInt32BE(offset);
    offset += 4;
    const mimeLength = block.readUInt32BE(offset);
    offset += 4;
    if (offset + mimeLength + 4 > block.length) return null;
    const mime = block.toString('latin1', offset, offset + mimeLength);
    offset += mimeLength;
    const descLength = block.readUInt32BE(offset);
    offset += 4;
    if (offset + descLength + 20 > block.length) return null;
    offset += descLength;
    offset += 4; // width
    offset += 4; // height
    offset += 4; // depth
    offset += 4; // indexed colours
    const dataLength = block.readUInt32BE(offset);
    offset += 4;
    if (dataLength <= 0 || offset + dataLength > block.length) return null;
    const image = imageFromBytes(block.subarray(offset, offset + dataLength));
    if (!image) return null;
    return { ...image, mime: image.mime || mime || 'application/octet-stream', pictureType, data: block.subarray(offset, offset + dataLength) };
}

function parseFlac(bytes) {
    if (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'fLaC') return null;
    let offset = 4;
    const pictures = [];
    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const last = (header & 0x80) !== 0;
        const type = header & 0x7f;
        const length = bytes.readUIntBE(offset + 1, 3);
        if (offset + 4 + length > bytes.length) return null;
        if (type === 6) {
            const parsed = parseFlacPicture(bytes.subarray(offset + 4, offset + 4 + length));
            if (parsed) pictures.push(parsed);
        }
        offset += 4 + length;
        if (last) break;
    }
    if (!pictures.length) return null;
    return pictures.find((picture) => picture.pictureType === 3) || pictures[0];
}

function embeddedResult(bytes, audioPath) {
    const parsed = parseId3(bytes) || parseFlac(bytes);
    if (!parsed) return null;
    return {
        ok: true,
        source: 'embedded',
        format: parsed.format,
        mime: parsed.mime,
        width: parsed.width,
        height: parsed.height,
        area: parsed.width * parsed.height,
        bytes: parsed.data.length,
        pictureType: parsed.pictureType,
        data: parsed.data,
        buffer: parsed.data,
        imageBytes: parsed.data,
        path: null,
        absolutePath: null,
        audioPath,
    };
}

async function embeddedFromPath(audioPath) {
    try {
        const info = await lstat(audioPath);
        if (!info.isFile() || info.isSymbolicLink()) return null;
        return embeddedResult(await readFile(audioPath), audioPath);
    } catch {
        return null;
    }
}

function candidateAudioPaths(candidate) {
    const entries = Array.isArray(candidate?.audioEntries) ? candidate.audioEntries : [];
    const all = Array.isArray(candidate?.entries) ? candidate.entries : [];
    const values = [...entries, ...all]
        .filter((entry) => entry && (String(entry.kind || '').toLowerCase() === 'audio' || /^audio\//i.test(String(entry.mime || ''))))
        .map((entry) => pathForCandidate(candidate, { path: entry.absolutePath || entry.path }))
        .filter(Boolean);
    return [...new Set(values.map((value) => resolve(value)))];
}

/**
 * Extract one embedded cover from an audio path or a candidate's audio entries.
 * ID3v2.2/2.3/2.4 APIC/PIC and FLAC PICTURE are supported without an image
 * library. Returns null (rather than throwing) when no decodable cover exists.
 */
export async function extractEmbeddedCover(input, options = {}) {
    if (typeof input === 'string' || Buffer.isBuffer(input)) {
        if (Buffer.isBuffer(input)) return embeddedResult(input, options.audioPath || null);
        return embeddedFromPath(resolve(input));
    }
    if (input && typeof input === 'object') {
        for (const audioPath of candidateAudioPaths(input)) {
            const extracted = await embeddedFromPath(audioPath);
            if (extracted) return extracted;
        }
    }
    return null;
}

export async function extractEmbeddedCovers(candidate) {
    const values = [];
    for (const audioPath of candidateAudioPaths(candidate)) {
        const extracted = await embeddedFromPath(audioPath);
        if (extracted) values.push(extracted);
    }
    return values;
}

const SOURCE_RANK = new Map([
    ['manual', 100],
    ['embedded', 80],
    ['folder', 60],
    ['local', 60],
    ['kikoeru', 40],
    ['dlsite', 20],
]);

function sourceRank(source) {
    return SOURCE_RANK.get(String(source || '').toLowerCase()) || 0;
}

function onlineChoices(candidate, onlineCandidates = []) {
    const values = [];
    for (const item of Array.isArray(onlineCandidates) ? onlineCandidates : []) {
        if (!item || !(item.path || item.absolutePath)) continue;
        const source = String(item.source || '').toLowerCase();
        if (!['kikoeru', 'dlsite'].includes(source)) continue;
        const absolute = pathForCandidate(candidate, item);
        if (!absolute) continue;
        values.push({ path: absolute, source, name: item.name || basename(absolute) });
    }
    return values;
}

function choiceForEmbedded(candidate, extracted) {
    const extension = extracted.format === 'png' ? 'png' : 'jpg';
    return {
        path: null,
        absolutePath: null,
        logicalPath: 'embedded:' + (extracted.audioPath || 'audio'),
        name: 'embedded-cover.' + extension,
        width: extracted.width,
        height: extracted.height,
        area: extracted.area,
        format: extracted.format,
        mime: extracted.mime,
        source: 'embedded',
        manual: false,
        embedded: true,
        data: extracted.data,
        audioPath: extracted.audioPath,
        pictureType: extracted.pictureType,
        score: extracted.area,
        scoreVersion: 'c79-04b-area-source-v1',
    };
}


function isInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pathForCandidate(candidate, cover) {
    const value = String(cover.path || cover.absolutePath || '');
    if (!value) return null;
    if (isAbsolute(value)) return resolve(value);
    if (candidate?.rootPath) return resolve(candidate.rootPath, value);
    return resolve(value);
}

function candidateRoot(candidate) {
    return candidate?.rootPath ? resolve(candidate.rootPath) : null;
}

function logicalCoverPath(candidate, absolutePath) {
    const root = candidateRoot(candidate);
    if (!root) return basename(absolutePath);
    const rel = relative(root, absolutePath);
    if (rel.startsWith('..') || isAbsolute(rel)) return basename(absolutePath);
    return rel.replace(/\\/g, '/');
}

function invalidImage(reason) {
    const error = new Error(`invalid cover image: ${reason}`);
    error.code = 'ECOVER_INVALID';
    return error;
}

function parsePng(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes.toString('ascii', 1, 4) !== 'PNG') return null;
    if (bytes.toString('ascii', 4, 8) !== '\r\n\x1a\n') return null;
    let offset = 8;
    let width = 0;
    let height = 0;
    let sawIhdr = false;
    let sawIend = false;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        if (length > 0x7fffffff || offset + 12 + length > bytes.length) return null;
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (type === 'IHDR') {
            if (length !== 13 || sawIhdr) return null;
            sawIhdr = true;
            width = bytes.readUInt32BE(dataStart);
            height = bytes.readUInt32BE(dataStart + 4);
            if (!width || !height) return null;
        }
        if (type === 'IEND') {
            sawIend = true;
            break;
        }
        offset += 12 + length;
    }
    if (!sawIhdr || !sawIend) return null;
    return { width, height, format: 'png' };
}

function parseJpeg(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    let width = 0;
    let height = 0;
    let sawSof = false;
    while (offset + 4 <= bytes.length) {
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) break;
        const marker = bytes[offset];
        offset += 1;
        if (marker === 0xd9) break;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) return null;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) return null;
        const isSof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
        if (isSof) {
            if (length < 7) return null;
            height = bytes.readUInt16BE(offset + 3);
            width = bytes.readUInt16BE(offset + 5);
            if (!width || !height) return null;
            sawSof = true;
        }
        offset += length;
        if (marker === 0xda) break;
    }
    if (!sawSof) return null;
    // Require actual EOI; a truncated entropy stream without EOI is not decodable.
    const tail = bytes.subarray(Math.max(0, bytes.length - 4));
    if (!tail.includes(Buffer.from([0xff, 0xd9]))) return null;
    return { width, height, format: 'jpeg' };
}

async function readImage(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw invalidImage(`symlink/junction: ${path}`);
    if (!info.isFile()) throw invalidImage(`not a regular file: ${path}`);
    const bytes = await readFile(path);
    const parsed = parsePng(bytes) || parseJpeg(bytes);
    if (!parsed) throw invalidImage(`unrecognized or truncated PNG/JPEG: ${path}`);
    return { ...parsed, bytes: info.size };
}

function explicitName(path) {
    return basename(String(path || ''), extname(String(path || ''))).normalize('NFKC');
}

function explicitRank(stem) {
    const match = String(stem || '').match(/(?:^|[-_ ])(cover|folder|front|jacket|package)(?:$|[-_ ])/i);
    return match ? COVER_STEMS.get(match[1].toLowerCase()) || 0 : 0;
}

function candidateExplicitCovers(candidate) {
    const covers = Array.isArray(candidate?.coverCandidates) ? candidate.coverCandidates : [];
    const entries = Array.isArray(candidate?.entries) ? candidate.entries : [];
    const values = [];
    for (const cover of covers) {
        const absolute = pathForCandidate(candidate, cover);
        if (!absolute) continue;
        const stem = explicitName(cover.name || absolute);
        if (!EXPLICIT_COVER.test(stem)) continue;
        values.push({
            path: absolute,
            source: String(cover.source || 'local'),
            name: basename(absolute),
            rank: explicitRank(stem),
        });
    }
    // Scanner may omit coverCandidates in hand-built previews; fall back to explicit
    // image entries, never arbitrary CG/random images.
    for (const entry of entries) {
        if (String(entry.kind || '').toLowerCase() !== 'image') continue;
        const absolute = pathForCandidate(candidate, { path: entry.absolutePath || entry.path });
        if (!absolute) continue;
        const stem = explicitName(entry.logicalPath || absolute);
        if (!EXPLICIT_COVER.test(stem)) continue;
        values.push({
            path: absolute,
            source: 'local',
            name: basename(absolute),
            rank: COVER_STEMS.get(stem.toLowerCase()) || 0,
        });
    }
    const seen = new Set();
    return values
        .filter((value) => {
            const key = resolve(value.path).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
}

function choiceFor(candidate, path, parsed, source, manual) {
    const root = candidateRoot(candidate);
    return {
        path,
        absolutePath: path,
        logicalPath: logicalCoverPath(candidate, path),
        name: basename(path),
        width: parsed.width,
        height: parsed.height,
        area: parsed.width * parsed.height,
        format: parsed.format,
        source,
        manual,
        score: manual ? Number.MAX_SAFE_INTEGER : parsed.width * parsed.height,
        bytes: parsed.bytes,
        scoreVersion: 'c79-04-area-v1',
    };
}

/**
 * Select one explicit local cover. `manualPath` is a hard override when decodable;
 * an invalid manual image throws ECVOER_INVALID and leaves the caller's previous
 * choice untouched. Invalid/truncated explicit candidates are skipped. No CG,
 * random screenshot, embedded cover or online candidate is considered.
 */
export async function selectCover(candidate, options = {}) {
    if (!candidate || typeof candidate !== 'object') throw new Error('candidate is required');
    if (options.manualPath) {
        const manual = resolve(String(options.manualPath));
        let parsed;
        try {
            parsed = await readImage(manual);
        } catch (error) {
            const wrapped = invalidImage(error?.message || String(error));
            wrapped.code = 'ECOVER_INVALID';
            throw wrapped;
        }
        return choiceFor(candidate, manual, parsed, 'manual', true);
    }

    const choices = [];
    // Area is primary; this rank is only consulted when decoded areas tie.
    if (options.includeEmbedded === true) {
        for (const extracted of await extractEmbeddedCovers(candidate)) {
            choices.push(choiceForEmbedded(candidate, extracted));
        }
    }
    for (const cover of candidateExplicitCovers(candidate)) {
        try {
            const parsed = await readImage(cover.path);
            const choice = choiceFor(candidate, cover.path, parsed, 'folder', false);
            choice.folderRank = cover.rank;
            choices.push(choice);
        } catch {
            // Explicit but truncated/corrupt candidate is rejected, not selected.
        }
    }
    const online = [...onlineChoices(candidate, options.onlineCandidates), ...onlineChoices(candidate, candidate.onlineCandidates)];
    const seen = new Set();
    for (const cover of online) {
        const key = resolve(cover.path).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            const parsed = await readImage(cover.path);
            const choice = choiceFor(candidate, cover.path, parsed, cover.source, false);
            choice.external = true;
            choices.push(choice);
        } catch {
            // Prefetched online bytes are local files; corrupt/truncated ones are skipped.
        }
    }
    if (!choices.length) return null;
    choices.sort((a, b) =>
        b.area - a.area ||
        sourceRank(b.source) - sourceRank(a.source) ||
        String(a.path || a.name).localeCompare(String(b.path || b.name))
    );
    return choices[0];
}

/**
 * Internal compatibility path for staged scanner placeholders: only explicit
 * names, no decoding. Kept for callers that have no image-decoding fixture.
 */
export function selectExplicitNameFallback(candidate) {
    const covers = candidateExplicitCovers(candidate);
    if (!covers.length) return null;
    return {
        path: covers[0].path,
        absolutePath: covers[0].path,
        logicalPath: logicalCoverPath(candidate, covers[0].path),
        name: basename(covers[0].path),
        source: 'local',
        manual: false,
        fallback: true,
    };
}

export { parsePng as parsePngDimensions, parseJpeg as parseJpegDimensions, parseId3 as parseId3Cover, parseFlac as parseFlacCover, SOURCE_RANK, sourceRank };
