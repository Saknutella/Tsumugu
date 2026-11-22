import { getVoiceFileType } from './voice-file-types.js';
import { deriveWorkSubtitles } from './voice-subtitles.js';

// 音声作品沿用专辑/曲目契约,但元数据始终来自已导入的本地作品。
// 不缓存适配结果:刷新、重导和删除后,收藏/最近播放入口必须重新读取真实存储。
export const VOICES_STORAGE_KEY = 'monochrome-voices-imported-v1';

function decodeId(id) {
    try {
        return decodeURIComponent(String(id ?? ''));
    } catch {
        return String(id ?? '');
    }
}

export function isVoiceAlbumId(id) {
    return decodeId(id).startsWith('voice-');
}

export function isVoiceTrackId(id) {
    return decodeId(id).startsWith('voice:');
}

function originFor(options) {
    return options.origin || globalThis.location?.origin || 'http://localhost';
}

function coverUrl(work, options) {
    if (!work.cover) return '';
    try {
        const origin = originFor(options);
        const cover = new URL(work.cover, origin);
        // 原生专辑封面同样使用 crossorigin;保留现有开发封面代理以免播放器破图。
        if (['localhost', '127.0.0.1'].includes(new URL(origin).hostname) && cover.pathname.startsWith('/api/cover/')) {
            return new URL(`/__kikoeru_cover?url=${encodeURIComponent(cover.href)}`, origin).href;
        }
        return cover.href;
    } catch {
        return '';
    }
}

function audioEntries(nodes, path = [], folders = []) {
    return (nodes || []).flatMap((node, index) => {
        const nodePath = [...path, index];
        if (node.type === 'folder') {
            return audioEntries(node.children, nodePath, [...folders, node.title || '']);
        }
        return getVoiceFileType(node) === 'audio' ? [{ node, path: nodePath, folders }] : [];
    });
}

function resolveCircleName(work, options) {
    if (work?.trueCircle) return work.trueCircle;
    if (!work?.sourceCode || work.code === work.sourceCode) return work?.circle || '';
    // The translated work's circle is the translator. Prefer a source edition
    // already in the local library; never leak that translator into a circle
    // label when the source is unavailable.
    try {
        const source = readWorks(options).find(
            (entry) =>
                entry &&
                (entry.code === work.sourceCode ||
                    entry.id === `voice-${work.sourceCode}` ||
                    entry.id === work.sourceCode)
        );
        return source?.trueCircle || source?.circle || '';
    } catch {
        return '';
    }
}

export function adaptVoiceWork(work, options = {}) {
    if (!work || !isVoiceAlbumId(work.id)) throw new Error('Invalid imported voice work');
    const entries = audioEntries(work.tracks);
    const subtitleInfo = deriveWorkSubtitles(work);
    const cover = coverUrl(work, options);
    // 声优没有在线曲库的 artist ID,不能伪造 ID 后导航到 /artist/undefined。
    const artists = (work.artists || []).map((name) => ({ name }));
    // Translated editions carry the translator in work.circle; the card/home
    // artist must stay the source circle so it matches the voice library.
    const circleName = resolveCircleName(work, options);
    const artist = {
        id: `voice-artist-${work.id}`,
        name: circleName || artists.map((entry) => entry.name).join(', ') || 'Unknown Artist',
    };
    const album = {
        id: work.id,
        title: work.title,
        type: 'ALBUM',
        provider: 'voices',
        source: 'voices',
        artist,
        artists: artists.length ? artists : [artist],
        cover,
        releaseDate: work.release || '',
        duration: Number(work.duration) || 0,
        numberOfTracks: entries.length,
        totalDiscs: 1,
        numberOfTracksOnDisc: entries.length,
        voiceWorkId: work.id,
        fileStorage: Boolean(work.fileStorage),
        hasSubtitle: subtitleInfo.hasSubtitle,
        // Keep age/NSFW metadata on the adapted album so home/recent cards can
        // apply the same adult blur as the voice library cards.
        ageCategory: work.ageCategory || '',
        nsfw: Boolean(work.nsfw),
        _href: `/album/${encodeURIComponent(work.id)}`
    };
    const tracks = entries.map(({ node, path, folders }, index) => ({
        id: `voice:${work.id}:${node.hash || `path-${path.join('-')}`}`,
        title: node.title,
        type: 'track',
        provider: 'voices',
        source: 'voices',
        audioUrl: node.localMediaStreamUrl || node.mediaStreamUrl,
        downloadUrl: node.localMediaDownloadUrl || node.localMediaStreamUrl || node.mediaDownloadUrl || node.mediaStreamUrl,
        duration: Number(node.duration) || null,
        artists: album.artists,
        artist,
        album: { ...album },
        cover,
        image: cover,
        trackNumber: index + 1,
        volumeNumber: 1,
        voiceWorkId: work.id,
        voiceHash: node.hash,
        hostVoiceWorkId: node.hostWorkId || '',
        hostVoiceEntryId: node.hostEntryId || '',
        fallbackAudioUrl: node.remoteMediaStreamUrl || '',
        fileStorage: Boolean(work.fileStorage) || Boolean(node.local),
        localMedia: Boolean(node.local),
        voicePath: folders.join(' / '),
        subtitle: subtitleInfo.byAudioHash.get(node.hash) || null,
        hasSubtitle: subtitleInfo.hasSubtitle,
        _href: album._href
    }));
    return { album, tracks, work };
}

export function buildVoiceTrack(work, node, options = {}) {
    const entries = audioEntries(work.tracks);
    const index = entries.findIndex((entry) => entry.node === node || (node.hash && entry.node.hash === node.hash));
    if (index < 0) throw new Error('Voice audio file is not part of this work');
    return adaptVoiceWork(work, options).tracks[index];
}

function readWorks(options) {
    const storage = options.storage || globalThis.localStorage;
    let works;
    try {
        works = JSON.parse(storage?.getItem(VOICES_STORAGE_KEY) || '[]');
    } catch {
        throw new Error('Imported voice library could not be read');
    }
    if (!Array.isArray(works)) throw new Error('Imported voice library is invalid');
    // Old builds could persist host-backed works into localStorage. They must never
    // be treated as the source of truth when the host is down or the work was removed.
    const localWorks = works.filter((work) => work && !work.fileStorage);
    // Tauri file-storage works live in SQLite/CAS, not localStorage. The voices
    // module publishes its host-backed slice here so album/track lookups can see it.
    const browserWorks = options.browserWorks || globalThis.__monochromeBrowserLocalWorks;
    const fileWorks = options.fileWorks || globalThis.__monochromeFileStorageWorks;
    // A partial host work must not shadow the online work in the album resolver;
    // the online work owns the full remote tree and the save-to-library entry.
    const codeOf = (work) => String(work?.sourceCode || work?.code || work?.id || '').match(/RJ\d{5,8}/i)?.[0]?.toUpperCase() || '';
    const nodeCount = (work) => {
        let count = 0;
        const walk = (nodes) => {
            for (const node of nodes || []) {
                if (node.type === 'folder') walk(node.children);
                else count += 1;
            }
        };
        walk(work?.tracks);
        return count;
    };
    const audioCount = (work) => {
        let count = 0;
        const walk = (nodes) => {
            for (const node of nodes || []) {
                if (node.type === 'folder') walk(node.children);
                else if (node.type === 'audio') count += 1;
            }
        };
        walk(work?.tracks);
        return count;
    };
    const usableFileWorks = Array.isArray(fileWorks)
        ? fileWorks.filter((work) => {
              if (work?.__voicePartial) return false;
              const code = codeOf(work);
              const match = code ? localWorks.find((candidate) => codeOf(candidate) === code) : null;
              if (!match) return true;
              const complete = nodeCount(work) >= nodeCount(match) &&
                  audioCount(work) >= audioCount(match) &&
                  (Boolean(work.hasLocalCover) || !match.cover);
              if (!complete) work.__voicePartial = true;
              return complete;
          })
        : [];
    const merged = [
        ...(Array.isArray(browserWorks) ? browserWorks : []),
        ...usableFileWorks,
    ];
    // A partial host work is filtered out of `merged` on purpose (the online
    // record owns the remote tree), but its cover is the copy already on disk and
    // the only fresh one: `/api/works` re-signs media every session, while a
    // `cover` persisted in localStorage is either absent or a dead signed URL.
    // Lend that cover to whichever record the album will actually resolve.
    if (Array.isArray(fileWorks)) {
        const covers = new Map();
        for (const work of fileWorks) {
            const code = codeOf(work);
            if (code && work?.cover && !covers.has(code)) covers.set(code, work.cover);
        }
        if (covers.size) {
            for (const work of [...localWorks, ...merged]) {
                const cover = work ? covers.get(codeOf(work)) : null;
                if (cover) work.cover = cover;
            }
        }
    }
    if (merged.length === 0) return localWorks;
    const ids = new Set(merged.map((work) => work?.id));
    return [...merged, ...localWorks.filter((work) => !ids.has(work?.id))];
}

export function getVoiceAlbum(id, options = {}) {
    const albumId = decodeId(id);
    const work = readWorks(options).find((entry) => entry?.id === albumId);
    if (!work) throw new Error('Voice work is not imported or has been deleted');
    return adaptVoiceWork(work, options);
}

/**
 * Resolve several album cards from one localStorage parse. Home/recent rows
 * show at most six entries; calling getVoiceAlbum per entry would re-parse the
 * whole imported library each time.
 */
export function getVoiceAlbums(ids, options = {}) {
    const wanted = new Set((ids || []).map((id) => decodeId(id)));
    const result = new Map();
    if (!wanted.size) return result;
    for (const work of readWorks(options)) {
        if (!wanted.has(work?.id) || !isVoiceAlbumId(work.id)) continue;
        try {
            result.set(work.id, adaptVoiceWork(work, options));
        } catch {
            /* A corrupt/stale entry must not hide the remaining cards. */
        }
    }
    return result;
}

export function getVoiceTrack(id, options = {}) {
    const trackId = decodeId(id);
    const works = readWorks(options);
    for (const work of works) {
        if (!work || !isVoiceAlbumId(work.id) || !trackId.startsWith(`voice:${work.id}:`)) continue;
        const track = adaptVoiceWork(work, options).tracks.find((entry) => entry.id === trackId);
        if (track) return track;
    }
    throw new Error('Voice audio file is not imported or has been deleted');
}

const VOICE_FORMATS = ['aac', 'mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'webm', 'mp4'];

export function getVoiceTrackFormat(track) {
    for (const value of [track?.title, track?.audioUrl, track?.mediaStreamUrl, track?.downloadUrl, track?.mediaDownloadUrl]) {
        if (!value) continue;
        let name = String(value).split(/[?#]/)[0];
        try { name = decodeURIComponent(name); } catch { /* Invalid escapes do not prevent title detection. */ }
        const match = name.match(/\.([a-z0-9]+)$/i);
        if (match && VOICE_FORMATS.includes(match[1].toLowerCase())) return match[1].toLowerCase();
    }
    return '';
}

export function getVoicePlaybackFormats(work) {
    return [...new Set(adaptVoiceWork(work).tracks.map(getVoiceTrackFormat).filter(Boolean))];
}

function preferVoiceFormat(formats) {
    return ['aac', 'mp3'].find((format) => formats.includes(format)) || formats[0] || '';
}

export function getVoiceDefaultFormat(work) {
    return preferVoiceFormat(getVoicePlaybackFormats(work));
}

function voiceContentKey(track) {
    // Only explicit format folder components are interchangeable; language and SE variants remain distinct.
    const folders = track.voicePath.split(' / ').map((folder) => {
        const match = folder.match(/^(aac|mp3|wav|flac|m4a|ogg|opus|aiff|aif|wma|webm|mp4)(?=$|[_ -])/i);
        return match ? folder.slice(match[0].length).replace(/^[_ -]+/, '') : folder;
    }).filter(Boolean);
    const title = String(track.title || '');
    const extension = title.match(/\.([a-z0-9]+)$/i);
    const stem = extension && VOICE_FORMATS.includes(extension[1].toLowerCase()) ? title.slice(0, -extension[0].length) : title;
    return JSON.stringify([folders, stem]);
}

export function getVoicePlaybackTracks(work, preferredFormat = getVoiceDefaultFormat(work)) {
    const groups = [];
    const preferred = String(preferredFormat || '').toLowerCase();
    // Host-backed local files have no per-track duration yet, but their format
    // folders (mp3/, wav/, ...) and identical stems are enough to pick one format.
    const canGroupWithoutDuration = Boolean(work?.fileStorage);
    for (const track of adaptVoiceWork(work).tracks) {
        const format = getVoiceTrackFormat(track);
        const key = voiceContentKey(track);
        // Missing durations or unknown formats are insufficient evidence of identical
        // content for remote libraries. Local file-storage imports can use the explicit
        // format folder + stem because both came from the same source tree.
        const group = format && groups.find((entries) => entries.every((entry) => {
            if (!getVoiceTrackFormat(entry) || getVoiceTrackFormat(entry) === format) return false;
            if (voiceContentKey(entry) !== key) return false;
            if (canGroupWithoutDuration) return true;
            return entry.duration > 0 && track.duration > 0 &&
                Math.abs(entry.duration - track.duration) <= Math.min(2, Math.max(0.25, Math.min(entry.duration, track.duration) * 0.02));
        }));
        if (group) group.push(track);
        else groups.push([track]);
    }
    return groups.map((entries) => {
        const formats = entries.map(getVoiceTrackFormat);
        const selected = formats.includes(preferred) ? preferred : preferVoiceFormat(formats);
        return entries.find((track) => getVoiceTrackFormat(track) === selected) || entries[0];
    });
}
