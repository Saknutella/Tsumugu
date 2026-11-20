// Kikoeru subtitle discovery/parsing.
//
// Subtitles are deliberately not stored as ordinary tags: the library has a
// separate derived "带字幕" facet, and the age/blur systems stay independent.
// Remote subtitle files live in arbitrary folders, so association is by the
// normalized audio basename, never by the filesystem level.
import { getVoiceFileType } from './voice-file-types.js';
import { loadVoiceAttachmentText } from './voice-attachment-text.js';

export const SUBTITLE_FORMATS = Object.freeze(['srt', 'vtt', 'lrc', 'ass', 'ssa']);
// ASS/SSA are discoverable but not selected for the first overlay. Monochrome
// has no ASS renderer; they stay available for a future libass path.
export const SUBTITLE_PRIORITY = Object.freeze(['srt', 'vtt', 'lrc']);
const SUBTITLE_EXTENSION_RE = /\.(srt|vtt|lrc|ass|ssa)$/i;
const LANGUAGE_SUFFIX_RE = /(?:[._ -](?:zh|chs|cht|cn|中文|简体|繁体|汉化|日文|jp|ja))+$/i;

function flattenNodes(nodes, path = [], output = []) {
    for (const [index, node] of (nodes || []).entries()) {
        const nodePath = [...path, index];
        if (node?.type === 'folder') {
            flattenNodes(node.children, nodePath, output);
        } else {
            output.push({ node, path: nodePath });
        }
    }
    return output;
}

function subtitleFormatForNode(node) {
    const match = String(node?.title || '').match(SUBTITLE_EXTENSION_RE);
    return match ? match[1].toLowerCase() : '';
}

export function normalizeSubtitleStem(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(SUBTITLE_EXTENSION_RE, '')
        .replace(/\.(aac|mp3|wav|flac|m4a|ogg|opus|aiff|aif|wma|mp4|webm)$/i, '')
        .replace(LANGUAGE_SUFFIX_RE, '')
        .toLowerCase()
        .replace(/[\s_\-—–·.,，。!?！？:：;；'"“”‘’、/\\()（）[\]【】]+/g, '');
}

function audioNodes(tracks) {
    return flattenNodes(tracks)
        .filter(({ node }) => getVoiceFileType(node) === 'audio')
        .map(({ node, path }) => ({
            node,
            path,
            stem: normalizeSubtitleStem(node.title),
        }));
}

function subtitleNodes(tracks) {
    return flattenNodes(tracks)
        .filter(({ node }) => SUBTITLE_FORMATS.includes(getVoiceFileType(node)) || subtitleFormatForNode(node))
        .map(({ node, path }) => {
            const format = subtitleFormatForNode(node);
            return {
                node,
                path,
                format,
                stem: normalizeSubtitleStem(node.title),
            };
        })
        .filter((entry) => entry.format);
}

function formatPriority(format) {
    const index = SUBTITLE_PRIORITY.indexOf(format);
    return index < 0 ? SUBTITLE_PRIORITY.length : index;
}

function pickSubtitle(candidates) {
    return (
        [...candidates]
            .filter((candidate) => subtitleSupported(candidate.format))
            .sort((a, b) => formatPriority(a.format) - formatPriority(b.format))[0] || null
    );
}

/**
 * Derive subtitle metadata for a work without mutating it.
 *
 * `byAudioHash` maps audio node hash -> selected remote subtitle. Exact stem
 * matches handle the common nested-folder layout; the single-audio/single-file
 * case is the only safe fallback when a source used an unrelated filename.
 */
export function deriveWorkSubtitles(work) {
    const files = subtitleNodes(work?.tracks);
    const audios = audioNodes(work?.tracks);
    const byStem = new Map();
    for (const file of files) {
        const bucket = byStem.get(file.stem) || [];
        bucket.push(file);
        byStem.set(file.stem, bucket);
    }

    const byAudioHash = new Map();
    for (const audio of audios) {
        let candidates = byStem.get(audio.stem) || [];
        if (!candidates.length && audios.length === 1 && files.length) candidates = files;
        const selected = pickSubtitle(candidates);
        if (selected) byAudioHash.set(audio.node.hash, selected);
    }

    const aliasByAudioHash = work?.aliasSubtitlesByAudioHash && typeof work.aliasSubtitlesByAudioHash === 'object'
        ? work.aliasSubtitlesByAudioHash
        : {};
    for (const [hash, subtitle] of Object.entries(aliasByAudioHash)) {
        if (!byAudioHash.has(hash) && subtitle) byAudioHash.set(hash, subtitle);
    }

    return {
        files,
        audios,
        byAudioHash,
        hasSubtitle: Boolean(work?.has_subtitle || work?.hasSubtitle || files.length || Object.keys(aliasByAudioHash).length),
    };
}

export function subtitleForAudio(work, audioHash) {
    return deriveWorkSubtitles(work).byAudioHash.get(audioHash) || null;
}

export function subtitleSupported(format) {
    return SUBTITLE_PRIORITY.includes(String(format || '').toLowerCase());
}

function cleanSubtitleText(value) {
    return String(value ?? '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\\N/gi, '\n')
        .replace(/\{[^}]*\}/g, '')
        .trim();
}

function timestampSeconds(value) {
    const parts = String(value || '').trim().replace(',', '.').split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
}

function parseSrt(text) {
    const cues = [];
    const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').filter((line, index) => index > 0 || !/^\d+$/.test(line.trim()));
        const timingIndex = lines.findIndex((line) => line.includes('-->'));
        if (timingIndex < 0) continue;
        const [startText, endText] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
        const start = timestampSeconds(startText);
        const end = timestampSeconds(endText);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const content = cleanSubtitleText(lines.slice(timingIndex + 1).join('\n'));
        if (content) cues.push({ start, end, text: content });
    }
    return cues.sort((a, b) => a.start - b.start);
}

function parseVtt(text) {
    const source = String(text)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/^WEBVTT[^\n]*\n?/i, '');
    const cues = [];
    for (const block of source.split(/\n{2,}/)) {
        const lines = block.split('\n');
        const timingIndex = lines.findIndex((line) => line.includes('-->'));
        if (timingIndex < 0) continue;
        const [startText, endText] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
        const start = timestampSeconds(startText);
        const end = timestampSeconds(endText);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const content = cleanSubtitleText(lines.slice(timingIndex + 1).join('\n'));
        if (content) cues.push({ start, end, text: content });
    }
    return cues.sort((a, b) => a.start - b.start);
}

function parseLrc(text) {
    const raw = [];
    const source = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    for (const line of source.split('\n')) {
        const timestamps = [];
        const rest = line.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, (_match, minutes, seconds, fraction) => {
            const fractionSeconds = fraction ? Number(`0.${fraction.padEnd(3, '0').slice(0, 3)}`) : 0;
            timestamps.push(Number(minutes) * 60 + Number(seconds) + fractionSeconds);
            return '';
        });
        const content = cleanSubtitleText(rest);
        if (!content || !timestamps.length) continue;
        for (const start of timestamps) raw.push({ start, text: content });
    }
    raw.sort((a, b) => a.start - b.start);
    return raw.map((cue, index) => ({
        start: cue.start,
        // LRC has no end timestamp; use the next line, capped at 4s.
        end: index + 1 < raw.length ? Math.min(raw[index + 1].start, cue.start + 4) : cue.start + 4,
        text: cue.text,
    }));
}

/** Parse SRT/VTT/LRC. ASS is intentionally unsupported until a renderer exists. */
export function parseSubtitleText(text, format) {
    const normalized = String(format || '').toLowerCase();
    if (normalized === 'srt') return parseSrt(text);
    if (normalized === 'vtt') return parseVtt(text);
    if (normalized === 'lrc') return parseLrc(text);
    return [];
}

const cueCache = new Map();
// A stalled media/subtitle request must not leave the overlay on the loading
// message forever. Abort the shared loader after this budget and surface an error.
const SUBTITLE_LOAD_TIMEOUT_MS = 15_000;

export async function loadSubtitleCues(subtitle, { signal } = {}) {
    if (!subtitle?.node?.mediaStreamUrl) throw new Error('Subtitle URL is missing');
    const key = `${subtitle.node.hash || subtitle.node.mediaStreamUrl}:${subtitle.format}`;
    if (cueCache.has(key)) return cueCache.get(key);
    if (subtitle.node.hostWorkId && subtitle.node.hostEntryId && globalThis.__monochromeFileStorage?.resolveTrackUrl) {
        const fresh = await globalThis.__monochromeFileStorage
            .resolveTrackUrl(subtitle.node.hostWorkId, subtitle.node.hostEntryId)
            .catch(() => null);
        if (fresh) subtitle.node.mediaStreamUrl = fresh;
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    let timedOut = false;
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, SUBTITLE_LOAD_TIMEOUT_MS);
    try {
        const { text } = await loadVoiceAttachmentText(subtitle.node.mediaStreamUrl, {
            signal: controller.signal,
        });
        const cues = parseSubtitleText(text, subtitle.format);
        cueCache.set(key, cues);
        return cues;
    } catch (error) {
        if (timedOut) throw new Error('Subtitle request timed out');
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
    }
}

export function clearSubtitleCueCache() {
    cueCache.clear();
}
