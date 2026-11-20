// 「创作」页:浏览 Patreon 式帖子(图片/音频/正文/附件)。
//
// 应用**自带空库**:没有任何内嵌帖子。内容只来自两处——
//   · 用户从本地创作 JSON 导入(`examples/creations-sample.json` 是一份可选示例);
//   · 用户从链接导入。
// 帖子流 → 帖子详情、图片画廊、正文描述、下载附件、音频送进原生 Player 的联动都在这里。
//
// 示例素材不随应用打包:仓库里只有 `examples/` 下的 JSON 与说明,`dist/` 里没有这些文件。

import { t } from './i18n.js';
import { renderMarkdown } from './markdown.js';
import { queryCreationLibrary, getCreationOrigin, getCreationLibraryDate, formatCreationLibraryDate } from './creation-library-query.js';
import '../voice-file-selection.css';
import '../creations-library.css';
import '../library-management.css';
import '../src/styles/creation-detail-native.css';
import '../src/styles/creation-detail-tree.css';
import { renderCreationFileTree } from './creation-detail-tree.js';
import { mountCreationDetailLayout } from './creation-detail-layout.js';
import { createVoiceAttachmentViewer } from './voice-attachment-viewer.js';
import { animateVoiceFolders } from './voice-folder-animation.js';
import { getVoiceFileType } from './voice-file-types.js';
import { getVoiceTrackFormat } from './voice-album.js';
import { SVG_PLAY, SVG_DOWNLOAD, SVG_SHUFFLE, SVG_LINK, SVG_TRASH, SVG_PLUS, SVG_MENU, SVG_HEART, SVG_HEART_FILLED } from './icons.js';
import { createCreationLibraryFilters } from './creation-library-filters.js';
import { buildCreationCreators, creatorForPost, resolveCreationCreator, creatorPath } from './creation-creators.js';
import { mountCreationCreatorView } from './creation-creator-view.js';
import { createLibraryGridRenderer } from './library-grid.js';
import { navigate } from './router.js';
import { Player } from './player.js';
import { UIRenderer } from './ui.js';
import { showNotification } from './downloads.js';
import { sidePanelManager } from './side-panel.js';
import {
    isTauriRuntime,
    saveCreationAttachment,
    pickCreationJson,
    revealCreationFile,
    fetchCreationFile,
    fetchCreationPreviewHtml,
} from './tauri-bridge.js';
import { isPawchivePostUrl, parsePawchivePostHtml } from './creation-preview-import.js';
import {
    deleteCreationFiles,
    deleteLocalFile,
    getLocalFile,
    listLocalFiles,
    localFileSummary,
    putLocalFile,
} from './creation-store.js';
import { createImportOptions } from './import-options.js';

// 应用默认空库:没有任何内嵌帖子,内容只来自导入(本地 JSON 或链接)。
// 帖子对象的字段形状(导入 JSON 与 examples/creations-sample.json 共用):
//   id, title, creator, creatorId, date, tags,
//   cover,                  // 封面;http(s)/blob/相对路径都行
//   excerpt, body: [],      // 摘要与正文段落
//   gallery: [{ src, alt }],
//   attachments: [
//       { type: 'description', name, src },                     // 帖子简介
//       { type: 'description', audioFor, name, src },            // 音频简介
//       { type: 'audio', name, title, src?, duration, durationSeconds, notes? },
//       { type: 'file', name, src },
//   ]
// 示例(可选、不随应用打包)见 examples/creations-sample.json;素材需要自己准备。
// 这里为空,清空导入后就会回到真正的空库,由 renderFeed() 渲染空态。
let CREATIONS = [];

const SAMPLE_CREATIONS = [...CREATIONS];
const IMPORTED_STORAGE_KEY = 'monochrome-creations-imported-v2';
const LEGACY_IMPORTED_STORAGE_KEY = 'monochrome-creations-imported-v1';
const IMPORT_OPTIONS_KEY = 'monochrome-creations-import-options-v1';
let importOptions = { autoSaveImages: true, overwriteLocalFiles: false };
let IMPORTED_CREATIONS = [];
let importedStorageLoaded = false;

// 已知创作者档案(仅用于补充帖子对象里没有的 bio/头像等字段)。
// 与帖子一样,应用不再内嵌这份数据:示例在 examples/creations-sample.json 的 creators 里。
// 对象形状: { id, name, handle, bio, avatar, tags }
const CREATORS = {};

// The registry is derived from posts; imported source IDs and attachment records stay intact.
let creatorRegistryPosts = null;
let creatorRegistry = [];
function creationCreators() {
    if (creatorRegistryPosts !== CREATIONS) {
        creatorRegistry = buildCreationCreators(CREATIONS, { knownCreators: CREATORS });
        creatorRegistryPosts = CREATIONS;
    }
    return creatorRegistry;
}

function creatorOf(post) {
    return creatorForPost(post, creationCreators());
}

function openCreator(reference) {
    const creator = resolveCreationCreator(reference, creationCreators());
    if (creator) navigate(creatorPath(creator));
}

function isPostByCreator(post, reference) {
    const creator = resolveCreationCreator(reference, creationCreators());
    return Boolean(creator?.postIds.includes(post.id));
}

function postDescription(post) {
    return post.attachments.find((attachment) => attachment.type === 'description' && !attachment.audioFor);
}

function audioDescription(post, audioName) {
    return post.attachments.find(
        (attachment) => attachment.type === 'description' && attachment.audioFor === audioName,
    );
}

const SHOW_DESCRIPTIONS_KEY = 'monochrome-creations-show-descriptions';
const CREATION_FAVORITES_KEY = 'monochrome-creation-favorites-v1';
let showDescriptions = true;
let creationFavoriteIds = new Set();
try {
    showDescriptions = localStorage.getItem(SHOW_DESCRIPTIONS_KEY) !== 'false';
    const savedFavorites = JSON.parse(localStorage.getItem(CREATION_FAVORITES_KEY) || '[]');
    if (Array.isArray(savedFavorites)) creationFavoriteIds = new Set(savedFavorites.map(String));
} catch {
    // localStorage 不可用时默认显示，收藏只保留在当前页面。
}

function persistCreationFavorites() {
    try {
        localStorage.setItem(CREATION_FAVORITES_KEY, JSON.stringify([...creationFavoriteIds]));
    } catch {
        // The in-memory set still works for this session.
    }
}

function isCreationFavorite(postId) {
    return creationFavoriteIds.has(String(postId));
}

function toggleCreationFavorite(post) {
    const id = String(post.id);
    const added = !creationFavoriteIds.has(id);
    if (added) creationFavoriteIds.add(id);
    else creationFavoriteIds.delete(id);
    persistCreationFavorites();
    return added;
}

let currentId = null;
let currentPost = null;
let activeCreatorPage = null;
let activeTags = new Set();
let activeCreatorIds = new Set();
let activeMedia = new Set();
let libraryFilters = null;
let libraryQuery = '';
let librarySort = 'date';
let librarySource = 'all';
let libraryImportOpen = false;

function creationLibraryOptions() {
    return {
        query: libraryQuery, sort: librarySort, source: librarySource,
        creatorName: (post) => creatorOf(post).name,
        creatorId: (post) => creatorOf(post).id,
        creatorIds: activeCreatorIds, tags: activeTags, media: activeMedia
    };
}

function visibleCreationPosts() {
    return queryCreationLibrary(CREATIONS, creationLibraryOptions());
}

function creationLibraryQuery() {
    const params = new URLSearchParams();
    if (libraryQuery.trim()) params.set('q', libraryQuery.trim());
    if (librarySort !== 'date') params.set('sort', librarySort);
    if (librarySource !== 'all') params.set('source', librarySource);
    for (const id of activeCreatorIds) params.append('creator', id);
    for (const media of activeMedia) params.append('media', media);
    for (const tag of activeTags) params.append('tag', tag);
    return params.toString() ? `?${params}` : '';
}

function readCreationLibraryUrl() {
    const params = new URLSearchParams(location.search);
    libraryQuery = params.get('q') || '';
    librarySort = ['date', 'added', 'title'].includes(params.get('sort')) ? params.get('sort') : 'date';
    librarySource = ['all', 'imported', 'sample'].includes(params.get('source')) ? params.get('source') : 'all';
    activeCreatorIds = new Set(params.getAll('creator').map((id) => resolveCreationCreator(id, creationCreators())?.id || id));
    activeMedia = new Set(params.getAll('media'));
    activeTags = new Set(params.getAll('tag'));
}

function writeCreationLibraryUrl() {
    if (/^\/creations\/?$/.test(location.pathname)) history.replaceState(null, '', `/creations${creationLibraryQuery()}${location.hash}`);
}

function positionCreationImportTail() {
    const panel = document.getElementById('creations-import-panel');
    const button = document.getElementById('creations-import-toggle');
    const tail = document.getElementById('creations-import-tail');
    if (!panel || !button || !tail || panel.hidden) return;
    const panelRect = panel.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!panelRect.width || !buttonRect.width) return;
    const size = Math.max(20, Math.min(26, Math.round(buttonRect.height * 0.5)));
    const center = buttonRect.left + buttonRect.width / 2 - panelRect.left - (panel.clientLeft || 0);
    const left = Math.max(10, Math.min(panelRect.width - size - 10, center - size / 2));
    tail.style.setProperty('--bubble-tail-size', `${size}px`);
    tail.style.left = `${left}px`;
}

function setCreationImportOpen(open, focus = false) {
    libraryImportOpen = open;
    document.getElementById('creations-import-panel').hidden = !open;
    document.getElementById('creations-import-toggle').setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(positionCreationImportTail);
    if (focus) {
        const target = open
            ? document.getElementById('creations-import-url-input') || document.getElementById('creations-import-url')
            : document.getElementById('creations-import-toggle');
        target?.focus();
    }
}
const selectedImportedIds = new Set();
const selectedAttachmentIds = new Set();
let detailSession = null;

const DESCRIPTION_ALLOWED_TAGS = new Set([
    'A', 'B', 'STRONG', 'EM', 'I', 'BR', 'P', 'DIV', 'SPAN', 'UL', 'OL', 'LI',
    'H2', 'H3', 'H4', 'IMG', 'SMALL', 'CODE', 'PRE', 'BLOCKQUOTE', 'HR',
]);
const DESCRIPTION_ALLOWED_ATTRS = new Set(['class', 'href', 'src', 'alt', 'title', 'target', 'rel']);

// description.md 允许少量 HTML 做“花活”,但必须先过白名单:禁 script/iframe/事件属性/
// javascript: URL,保留 class 让样式可控。
function sanitizeDescriptionHtml(html) {
    const documentFragment = new DOMParser().parseFromString(`<div id="creation-description-root">${html}</div>`, 'text/html');
    const root = documentFragment.getElementById('creation-description-root');
    if (!root) return '';
    for (const element of Array.from(root.querySelectorAll('*'))) {
        if (!DESCRIPTION_ALLOWED_TAGS.has(element.tagName)) {
            if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE' || element.tagName === 'IFRAME') {
                element.remove();
            } else {
                element.replaceWith(...element.childNodes);
            }
            continue;
        }
        for (const attribute of Array.from(element.attributes)) {
            if (!DESCRIPTION_ALLOWED_ATTRS.has(attribute.name.toLowerCase())) {
                element.removeAttribute(attribute.name);
                continue;
            }
            if (attribute.name.toLowerCase() === 'href' || attribute.name.toLowerCase() === 'src') {
                const value = attribute.value.trim();
                if (!/^(https?:|\/|\.\/|#)/i.test(value)) element.removeAttribute(attribute.name);
            }
        }
    }
    return root.innerHTML;
}

function renderDescriptionBlocks(text) {
    const blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
    return blocks
        .map((block) => {
            const trimmed = block.trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('<')) return sanitizeDescriptionHtml(trimmed);
            return renderMarkdown(trimmed);
        })
        .join('\n');
}

async function renderDescription(post, session) {
    const intro = session.detail.querySelector('#creation-intro');
    if (!intro) return;
    const description = postDescription(post);
    if (!description) {
        intro.remove();
        return;
    }
    try {
        const response = await fetch(description.src, { signal: session.controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (session.controller.signal.aborted) return;
        intro.innerHTML = `
            <div class="creation-intro-label">${escapeHtml(t('creations.description'))}</div>
            <div class="creation-intro-content creation-reader">${renderDescriptionBlocks(text)}</div>
        `;
        intro.querySelectorAll('img[src]').forEach((image) => {
            if (image.closest('a')) return;
            image.dataset.zoom = 'true';
            image.tabIndex = 0;
            image.setAttribute('role', 'button');
        });
    } catch (error) {
        if (session.controller.signal.aborted) return;
        console.error('Failed to load description.md:', error);
        intro.innerHTML = `<p class="creation-intro-error">${escapeHtml(t('creations.textLoadFailed'))}</p>`;
    }
}


function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function attachmentMediaKind(attachment) {
    if (!attachment) return '';
    if (['audio', 'video'].includes(attachment.type)) return attachment.type;
    const kind = attachment.kind;
    if (['audio', 'video'].includes(kind)) return kind;
    const mime = String(attachment.mime || '').toLowerCase();
    if (/^audio\//.test(mime)) return 'audio';
    if (/^video\//.test(mime)) return 'video';
    const name = String(attachment.name || attachment.src || '').split(/[?#]/)[0].toLowerCase();
    if (/\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/.test(name)) return 'audio';
    if (/\.(mp4|webm|mkv|mov|m4v|avi)$/.test(name)) return 'video';
    return '';
}

// 导入的附件首先落成 type:'file' + kind:'audio'/'video'；渲染和播放必须同时识别
// type 与 kind，否则 Pawchive 导入的媒体只会出现在普通下载列表、进不了播放器。
function audioAttachments(post) {
    return post.attachments.filter((attachment) => attachmentMediaKind(attachment) === 'audio');
}

function videoAttachments(post) {
    return post.attachments.filter((attachment) => attachmentMediaKind(attachment) === 'video');
}

// 本地示例音频在浏览器里合成成 WAV Blob,避免把 1MB 二进制提交进仓库。
// 真实数据源接进来后,attachment.src 直接是远程/本地文件 URL,不会走到这里。
function createSampleWav(notes, durationSeconds = 8, sampleRate = 22050) {
    const totalSamples = Math.floor(durationSeconds * sampleRate);
    const buffer = new ArrayBuffer(44 + totalSamples * 2);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.charCodeAt(index));
        }
    };
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + totalSamples * 2, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, totalSamples * 2, true);
    for (let index = 0; index < totalSamples; index += 1) {
        const time = index / sampleRate;
        const fade = Math.min(1, time / 0.4, (durationSeconds - time) / 0.8);
        let value = 0;
        for (const frequency of notes) {
            value += Math.sin(2 * Math.PI * frequency * time) * 0.16;
            value += Math.sin(2 * Math.PI * frequency * 2 * time) * 0.03;
        }
        value *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.18 * time);
        value *= fade;
        view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, value)) * 32767, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

const generatedAudioUrls = new Map();

function resolveAudioUrl(attachment) {
    if (attachment.src) return attachment.src;
    if (!generatedAudioUrls.has(attachment.name)) {
        const blob = createSampleWav(attachment.notes ?? [220, 277.18, 329.63]);
        generatedAudioUrls.set(attachment.name, URL.createObjectURL(blob));
    }
    return generatedAudioUrls.get(attachment.name);
}

const localPlaybackUrls = new Map();

async function creationAudioUrl(post, attachment) {
    if (attachment.status === 'local') {
        const local = await localAttachmentUrl(post, attachment, localPlaybackUrls);
        if (local) return local;
    }
    return resolveAudioUrl(attachment);
}

function buildTrack(post, attachment, audioUrl = resolveAudioUrl(attachment)) {
    // Player.getCoverUrl 只会原样接受 http/blob/assets/ 开头的封面;这里把本地绝对路径
    // 转成完整 URL,避免它被当成 Tidal image id。
    const cover = new URL(post.cover, window.location.origin).href;
    return {
        id: `creation:${post.id}:${attachment.id || attachment.relativePath || attachment.name}`,
        title: attachment.title || attachment.name,
        type: 'track',
        audioUrl,
        duration: attachment.durationSeconds ?? null,
        artists: [{ name: post.creator }],
        album: { title: post.title, cover },
        source: 'creations',
        creationPostId: post.id,
        creationAudioName: attachment.name,
    };
}

async function playCreationAudio(post, attachment) {
    try {
        const audios = audioAttachments(post);
        const tracks = await Promise.all(
            audios.map(async (entry) => buildTrack(post, entry, await creationAudioUrl(post, entry)))
        );
        const index = Math.max(0, audios.indexOf(attachment));
        const player = Player.instance;
        await player.setQueue(tracks, index);
        await player.playTrackFromQueue();
        showNotification(`${t('creations.playing')}: ${attachment.title || attachment.name}`);
    } catch (error) {
        console.error('Failed to play creation audio:', error);
        showNotification(t('creations.playFailed'));
    }
}

async function queueCreationAudio(post, attachment) {
    try {
        const track = buildTrack(post, attachment, await creationAudioUrl(post, attachment));
        await Player.instance.addToQueue(track, { autoPlay: false });
        showNotification(t('creations.addedToQueue', { title: attachment.title || attachment.name }));
    } catch (error) {
        console.error('Failed to queue creation audio:', error);
        showNotification(t('creations.playFailed'));
    }
}

function buildVideoTrack(post, attachment) {
    const cover = new URL(post.cover, window.location.origin).href;
    const videoUrl = new URL(attachment.src, window.location.origin).href;
    return {
        id: `creation:${post.id}:video:${attachment.id || attachment.relativePath || attachment.name}`,
        title: attachment.title || attachment.name,
        type: 'video',
        videoUrl,
        duration: attachment.durationSeconds ?? null,
        artists: [{ name: post.creator }],
        album: { title: post.title, cover },
        image: cover,
        cover,
        source: 'creations',
        creationPostId: post.id,
        creationVideoName: attachment.name,
    };
}

async function playCreationVideo(post, attachment) {
    try {
        const player = Player.instance;
        await player.setQueue([buildVideoTrack(post, attachment)], 0);
        await player.playTrackFromQueue();
        showNotification(`${t('creations.playing')}: ${attachment.title || attachment.name}`);
    } catch (error) {
        console.error('Failed to play creation video:', error);
        showNotification(t('creations.playFailed'));
    }
}

async function playAllCreationAudio(post, { attachments = audioAttachments(post), shuffle = false, append = false } = {}) {
    if (!attachments.length) return;
    try {
        const tracks = await Promise.all(
            attachments.map(async (attachment) => buildTrack(post, attachment, await creationAudioUrl(post, attachment)))
        );
        const player = Player.instance;
        if (append) {
            await player.addToQueue(tracks, { autoPlay: false });
            showNotification(t('creations.detailQueued', { count: tracks.length }));
            return;
        }
        if (shuffle) {
            for (let index = tracks.length - 1; index > 0; index--) {
                const other = Math.floor(Math.random() * (index + 1));
                [tracks[index], tracks[other]] = [tracks[other], tracks[index]];
            }
        }
        await player.setQueue(tracks, 0);
        await player.playTrackFromQueue();
        showNotification(t('creations.playing') + ': ' + post.title);
    } catch (error) {
        console.error('Failed to play creation audio queue:', error);
        showNotification(t('creations.playFailed'));
    }
}

function feedView() {
    return document.getElementById('creations-feed-view');
}

function detailView() {
    return document.getElementById('creations-detail-view');
}

function artistView() {
    return document.getElementById('creations-artist-view');
}

function creationCardHtml(post, { inLibrary = false, selectable: allowSelection = true } = {}) {
    const time = getCreationLibraryDate(post);
    const displayDate = formatCreationLibraryDate(post);
    const dateHint = time.value ? t(time.kind === 'imported' ? 'creations.library.importedDate' : 'creations.library.publishedDate', { date: displayDate }) :
        t(time.kind === 'imported' ? 'creations.library.unknownImportDate' : 'creations.library.unknownPublishedDate');
    const audioCount = audioAttachments(post).length;
    const videoCount = videoAttachments(post).length;
    const fileAttachments = post.attachments.filter((attachment) => attachment.type === 'file');
    const archiveCount = fileAttachments.filter((attachment) => attachment.kind === 'archive').length;
    const textFileCount = fileAttachments.filter((attachment) => attachment.kind === 'text').length;
    const fileCount = fileAttachments.length - archiveCount - textFileCount;
    const linkCount = post.attachments.filter((attachment) => attachment.type === 'link').length;
    const textCount =
        post.attachments.filter((attachment) => attachment.type === 'description').length + textFileCount;
    const imageCount = post.gallery.length;
    const allTags = post.tags || [];
    const tags = (inLibrary ? allTags.slice(0, 3) : allTags).map((tag) => {
        // A real link keeps tag navigation working even if a stale HMR listener
        // or a card-level click handler wins; the delegated handler upgrades it
        // to a toggle on the current page.
        const href = `/creations?${new URLSearchParams({ tag }).toString()}`;
        return `<a class="creation-tag voice-tag-chip voice-tag-chip--tag" href="${escapeHtml(href)}" data-filter-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`;
    }).join('') +
        (inLibrary && allTags.length > 3 ? `<span class="creation-tag-more voice-tag-chip voice-tag-chip--tag">+${allTags.length - 3}</span>` : '');
    const typeBadge = (type, count, label) => {
        if (count <= 0) return '';
        const href = `/creations?${new URLSearchParams({ media: type }).toString()}`;
        const active = activeMedia.has(type) ? ' is-active' : '';
        return `<a class="creation-badge creation-badge-type${active}" data-type="${type}" data-filter-media="${type}"
            href="${escapeHtml(href)}" title="${escapeHtml(t('creations.filterByMedia'))}">${escapeHtml(label)} · ${count}</a>`;
    };
    const selectable = allowSelection;
    const selected = selectable && selectedImportedIds.has(post.id);
    const creator = creatorOf(post);
    return `
        <article class="creation-card${selectable ? ' creation-card--selectable' : ''}${
            selected ? ' creation-card--selected' : ''
        }" data-id="${escapeHtml(post.id)}" data-adult="${post.nsfw ? 'true' : 'false'}" tabindex="0" role="button"
            aria-label="${escapeHtml(post.title)}">
            ${inLibrary ? `<div class="creation-card-cover-wrap"><span class="creation-card-date" data-date-kind="${time.kind}" title="${escapeHtml(dateHint)}">${escapeHtml(displayDate)}</span>` : ''}
            ${
                selectable
                    ? `<button type="button" class="creation-select-check" data-select-post-id="${escapeHtml(
                          post.id,
                      )}" aria-pressed="${selected}"
                           title="${escapeHtml(t('creations.selectPost'))}"
                           aria-label="${escapeHtml(t('creations.selectPost'))}">
                           <span aria-hidden="true">${selected ? '✓' : ''}</span>
                       </button>`
                    : ''
            }
            <img class="creation-card-cover" src="${escapeHtml(post.cover)}" alt=""
                referrerpolicy="no-referrer" loading="eager" />
            ${inLibrary ? '</div>' : ''}
            <div class="creation-card-body">
                <h2 title="${escapeHtml(post.title)}">${escapeHtml(post.title)}</h2>
                <div class="creation-meta creation-card-byline">
                    <a class="creation-author-link creation-creator-link" href="${escapeHtml(creatorPath(creator))}"
                        data-creator-profile-id="${escapeHtml(creator.id)}"
                        title="${escapeHtml(t('creations.openArtist'))}">
                        <img class="creation-card-author-avatar" src="${escapeHtml(creator.avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy" />
                        <span class="creation-card-author-name">${escapeHtml(creator.name)}</span>
                    </a>
                    ${inLibrary ? '' : `<span>${escapeHtml(post.date)}</span>`}
                </div>
                ${inLibrary ? '' : `<p class="creation-excerpt">${escapeHtml(post.excerpt)}</p>`}
                <div class="creation-badges">
                    ${
                        post.incomplete
                            ? `<span class="creation-badge creation-badge-preview">${escapeHtml(
                                  t('creations.previewImport'),
                              )}</span>`
                            : ''
                    }
                    ${
                        audioCount > 0
                            ? typeBadge('audio', audioCount, t('creations.audio'))
                            : ''
                    }
                    ${videoCount > 0 ? typeBadge('video', videoCount, t('creations.video')) : ''}
                    ${imageCount > 0 ? typeBadge('image', imageCount, t('creations.image')) : ''}
                    ${linkCount > 0 ? typeBadge('link', linkCount, t('creations.link')) : ''}
                    ${textCount > 0 ? typeBadge('text', textCount, t('creations.text')) : ''}
                    ${archiveCount > 0 ? typeBadge('archive', archiveCount, t('creations.archive')) : ''}
                    ${fileCount > 0 ? typeBadge('file', fileCount, t('creations.file')) : ''}
                </div>
                ${tags ? `<div class="creation-card-tags">${tags}</div>` : ''}
            </div>
        </article>
    `;
}

function filterCreationsByCreator(creatorId) {
    if (!CREATIONS.some((post) => isPostByCreator(post, creatorId))) return;
    activeCreatorIds = new Set([resolveCreationCreator(creatorId, creationCreators())?.id || creatorId]);
    activeMedia.clear();
    activeTags = new Set();
    libraryQuery = '';
    librarySource = 'all';
    if (location.pathname !== '/creations' || detailView()?.hidden === false || artistView()?.hidden === false) {
        currentId = null;
        currentPost = null;
        navigate(`/creations${creationLibraryQuery()}`);
        // navigate 到相同路径时不会重新派发路由事件,这里兜底切回帖子流。
        renderFeed();
    } else {
        renderFeed();
    }
}

let lastCreationTagToggle = { value: '', at: 0 };
let lastCreationMediaToggle = { value: '', at: 0 };


function toggleCreationMediaFilter(media) {
    const value = String(media ?? '').trim();
    if (!value) return;
    const now = Date.now();
    if (lastCreationMediaToggle.value === value && now - lastCreationMediaToggle.at < 80) return;
    lastCreationMediaToggle = { value, at: now };
    if (activeMedia.has(value)) activeMedia.delete(value);
    else activeMedia.add(value);
    if (location.pathname !== '/creations' || detailView()?.hidden === false || artistView()?.hidden === false) {
        currentId = null;
        currentPost = null;
        navigate(`/creations${creationLibraryQuery()}`);
    } else {
        renderFeed();
    }
}

function toggleCreationTagFilter(tag) {
    const value = String(tag ?? '').trim();
    if (!value) return;
    // HMR can leave an older document-capture listener alive. Both handlers
    // receive the same click; only the first one may flip the filter.
    const now = Date.now();
    if (lastCreationTagToggle.value === value && now - lastCreationTagToggle.at < 80) return;
    lastCreationTagToggle = { value, at: now };
    if (activeTags.has(value)) activeTags.delete(value);
    else activeTags.add(value);
    if (location.pathname !== '/creations' || detailView()?.hidden === false || artistView()?.hidden === false) {
        currentId = null;
        currentPost = null;
        navigate(`/creations${creationLibraryQuery()}`);
    } else {
        renderFeed();
    }
}

const renderCreationGrid = createLibraryGridRenderer('data-id');

function renderFeed() {
    const feed = document.getElementById('creations-feed');
    if (!feed) return;
    closeCreationDetail();
    if (feedView()) feedView().hidden = false;
    if (detailView()) detailView().hidden = true;
    if (artistView()) artistView().hidden = true;
    feed.classList.toggle('creations-grid--filtered', activeCreatorIds.size > 0);

    for (const id of [...selectedImportedIds]) {
        if (!CREATIONS.some((post) => post.id === id)) selectedImportedIds.delete(id);
    }
    const posts = visibleCreationPosts();
    // 空库和「筛选无结果」是两件事:前者要引导用户导入,后者只是当前条件没命中。
    // 库真的为空时即使有筛选条件也显示导入引导,因为调条件也不可能有结果。
    const emptyKey = CREATIONS.length === 0 ? 'empty' : 'noMatches';
    const markup =
        posts.length === 0
            ? `<div class="creations-empty" id="creations-library-empty"><h2>${escapeHtml(t(`creations.library.${emptyKey}`))}</h2><p>${escapeHtml(t(`creations.library.${emptyKey}Hint`))}</p></div>`
            : posts.map((post) => creationCardHtml(post, { inLibrary: true })).join('');
    renderCreationGrid(feed, markup, CREATIONS.map((post) => post.id));
    document.getElementById('creations-library-total').textContent = t('creations.library.total', { count: CREATIONS.length });
    document.getElementById('creations-library-status').textContent = t('creations.library.results', { shown: posts.length, total: CREATIONS.length });
    const search = document.getElementById('creations-library-search');
    if (search.value !== libraryQuery) search.value = libraryQuery;
    document.getElementById('creations-library-sort').value = librarySort;
    document.getElementById('creations-library-source').value = librarySource;
    setCreationImportOpen(libraryImportOpen);
    writeCreationLibraryUrl();
    libraryFilters?.render();
    updateSelectionUi();
}

function updateSelectionUi() {
    const importedCount = CREATIONS.filter((post) => post.imported).length;
    const bar = document.getElementById('creations-selection-bar');
    const clearButton = document.getElementById('creations-clear-imported');
    const hasSelection = selectedImportedIds.size > 0;
    const visiblePosts = visibleCreationPosts();
    // Keep the same single management action visible as the voice library;
    // it is disabled when there is nothing imported to clear.
    if (clearButton) {
        clearButton.hidden = hasSelection;
        clearButton.disabled = importedCount === 0;
    }
    if (bar) bar.hidden = !hasSelection;
    const manage = document.getElementById('creations-manage');
    if (manage) {
        manage.hidden = CREATIONS.length === 0 || hasSelection;
        if (manage.hidden) manage.open = false;
    }
    const feed = document.getElementById('creations-feed');
    if (feed) feed.classList.toggle('is-selecting', hasSelection);
    if (!hasSelection) return;

    const count = document.getElementById('creations-selected-count');
    if (count) count.textContent = t('creations.selectedCount', { count: selectedImportedIds.size });
    const selectAll = document.getElementById('creations-select-all');
    if (selectAll) {
        selectAll.textContent =
            t(visiblePosts.length && visiblePosts.every((post) => selectedImportedIds.has(post.id))
                ? 'creations.library.unselectResults' : 'creations.library.selectResults');
        selectAll.disabled = visiblePosts.length === 0;
    }
    const deleteButton = document.getElementById('creations-delete-selected');
    if (deleteButton) {
        deleteButton.disabled = !visiblePosts.some(
            (post) => post.imported && selectedImportedIds.has(post.id),
        );
    }
}

function toggleImportedSelection(postId) {
    const restoreFocus = document.activeElement?.matches('[data-select-post-id]');
    if (selectedImportedIds.has(postId)) selectedImportedIds.delete(postId);
    else selectedImportedIds.add(postId);
    renderFeed();
    if (restoreFocus) [...document.querySelectorAll('#creations-feed [data-select-post-id]')]
        .find((button) => button.dataset.selectPostId === postId)?.focus({ preventScroll: true });
}

function toggleSelectAllImported() {
    const visiblePosts = visibleCreationPosts();
    if (visiblePosts.length && visiblePosts.every((post) => selectedImportedIds.has(post.id))) {
        visiblePosts.forEach((post) => selectedImportedIds.delete(post.id));
    } else {
        visiblePosts.forEach((post) => selectedImportedIds.add(post.id));
    }
    renderFeed();
}

function clearImportedSelection() {
    selectedImportedIds.clear();
    renderFeed();
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function showCreationChoice({ title, message, options }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'creation-choice-overlay';
        overlay.innerHTML = `
            <div class="creation-choice" role="dialog" aria-modal="true" aria-labelledby="creation-choice-title">
                <h2 id="creation-choice-title">${escapeHtml(title)}</h2>
                <p>${escapeHtml(message)}</p>
                <div class="creation-choice-actions">
                    ${options
                        .map(
                            (option) =>
                                `<button type="button" class="btn ${option.kind === 'primary' ? 'btn-primary' : 'btn-secondary'}" data-choice="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`,
                        )
                        .join('')}
                </div>
            </div>`;
        const close = (choice) => {
            document.removeEventListener('keydown', onKeydown);
            overlay.remove();
            resolve(choice);
        };
        const onKeydown = (event) => {
            if (event.key === 'Escape') close(null);
        };
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(null);
        });
        overlay.querySelectorAll('[data-choice]').forEach((button) => {
            button.addEventListener('click', () => close(button.dataset.choice));
        });
        document.addEventListener('keydown', onKeydown);
        document.body.appendChild(overlay);
        overlay.querySelector('[data-choice]')?.focus();
    });
}

async function summarizeLocalFiles(ids) {
    let count = 0;
    let bytes = 0;
    for (const id of ids) {
        try {
            const summary = await localFileSummary(id);
            count += summary.count;
            bytes += summary.bytes;
        } catch (error) {
            console.error('Failed to inspect local creation files:', error);
        }
    }
    return { count, bytes };
}

async function chooseDeletionMode(ids, single = false) {
    const summary = await summarizeLocalFiles(ids);
    if (summary.count === 0) {
        const message = single
            ? t('creations.deleteImportedConfirm')
            : t('creations.deleteSelectedConfirm', { count: ids.length });
        return window.confirm(message) ? 'keep' : null;
    }
    const message = `${t('creations.localFilesSummary', {
        count: summary.count,
        size: formatBytes(summary.bytes),
    })}`;
    return showCreationChoice({
        title: single ? t('creations.deleteImported') : t('creations.deleteImportedConfirm'),
        message,
        options: [
            { id: 'keep', label: t('creations.keepLocalFiles'), kind: 'primary' },
            { id: 'delete', label: t('creations.deleteLocalFiles') },
            { id: 'cancel', label: t('creations.cancel') },
        ],
    });
}

async function deleteLocalFilesFor(ids) {
    let removed = 0;
    for (const id of ids) {
        try {
            const summary = await localFileSummary(id);
            removed += summary.count;
            await deleteCreationFiles(id);
        } catch (error) {
            console.error('Failed to delete local creation files:', error);
        }
    }
    return removed;
}

function deleteSelectedImported() {
    if (selectedImportedIds.size === 0) return;
    const ids = [...selectedImportedIds];
    void (async () => {
        const mode = await chooseDeletionMode(ids);
        if (!mode) return;
        for (const id of ids) await cancelImageAutoSave(id);
        const removed = mode === 'delete' ? await deleteLocalFilesFor(ids) : 0;
        IMPORTED_CREATIONS = IMPORTED_CREATIONS.filter((post) => !ids.includes(post.id));
        persistImportedCreations();
        for (const id of ids) deleteCreationPostFromHost(id);
        updateImportedUi();
        rebuildCreations();
        selectedImportedIds.clear();
        renderFeed();
        showNotification(
            removed > 0 ? t('creations.deletedWithFiles', { count: removed }) : t('creations.deleted'),
        );
    })();
}

// 把本地创作创作者/帖子接进 Monochrome 原生搜索结果页。
function renderSearchCreations(query) {
    const container = document.getElementById('search-local-creations');
    if (!container) return;
    const normalized = String(query ?? '').trim().toLowerCase();
    if (!normalized) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }

    const creators = creationCreators()
        .filter((creator) => {
            if (!creator.postIds.length) return false;
            const haystack = [creator.name, creator.handle, creator.bio, ...(creator.tags || [])]
                .join(' ')
                .toLowerCase();
            return haystack.includes(normalized);
        });
    const posts = CREATIONS.filter((post) => {
        const creator = creatorOf(post);
        const haystack = [post.title, post.excerpt, post.creator, creator.name, ...(post.tags || [])]
            .join(' ')
            .toLowerCase();
        return haystack.includes(normalized);
    }).slice(0, 6);

    if (creators.length === 0 && posts.length === 0) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="search-local-head">
            <h3>${escapeHtml(t('creations.localResults'))}</h3>
            <span>${escapeHtml(t('creations.local'))}</span>
        </div>
        ${
            creators.length > 0
                ? `<div class="search-local-creators">
                       ${creators
                           .map(
                               (creator) => `
                           <button type="button" class="search-local-creator" data-creator-id="${escapeHtml(creator.id)}">
                               <img src="${escapeHtml(creator.avatar)}" alt="" />
                               <span class="search-local-creator-info">
                                   <strong>${escapeHtml(creator.name)}</strong>
                                   <small>${escapeHtml(creator.handle)} · ${escapeHtml(t('creations.artist'))}</small>
                               </span>
                           </button>`,
                           )
                           .join('')}
                   </div>`
                : ''
        }
        ${
            posts.length > 0
                ? `<div class="search-local-posts">
                       ${posts
                           .map(
                               (post) => `
                           <button type="button" class="search-local-post" data-post-id="${escapeHtml(post.id)}">
                               <img src="${escapeHtml(post.cover)}" alt="" />
                               <span>
                                   <strong>${escapeHtml(post.title)}</strong>
                                   <small>${escapeHtml(post.creator)} · ${escapeHtml(post.date)}</small>
                               </span>
                           </button>`,
                           )
                           .join('')}
                   </div>`
                : ''
        }
    `;
    container.hidden = false;
}

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'csv', 'log', 'yml', 'yaml']);
function downloadableAttachments(post) {
    return post.attachments.filter(
        (attachment) =>
            attachment.type === 'file' &&
            // Images are regular downloadable files too; audio/video use the
            // native player and must not enter the generic download manager.
            !['audio', 'video'].includes(attachmentMediaKind(attachment)) &&
            !attachment.missing &&
            Boolean(attachment.sourceUrl || attachment.remoteUrl),
    );
}

function attachmentStatusText(attachment) {
    if (attachment.status === 'downloading') return t('creations.downloadingFile');
    if (attachment.status === 'local') return t('creations.localFile');
    if (attachment.status === 'failed') return t('creations.failedFile');
    return t('creations.remoteFile');
}

function updateAttachmentRowState(attachment) {
    // 只有缩略图的画廊预览没有附件 id,也就没有对应的文件行。
    if (!attachment.id) return;
    const row = document.querySelector(
        `[data-attachment-row="${String(attachment.id).replace(/["\\]/g, '\\$&')}"]`,
    );
    const state = row?.querySelector('.creation-attachment-state');
    if (state) {
        state.dataset.state = attachment.status || 'remote';
        state.textContent = attachmentStatusText(attachment);
    }
    // 自动保存不整页重渲染,渲染时打上的「未下载」标记要在这里跟着撤掉。
    if (attachment.status === 'local') row?.querySelector('.voice-file-local-state.is-missing')?.remove();
    updateAttachmentProgress(attachment);
}

function updateAttachmentProgress(attachment) {
    if (!attachment.id) return;
    const row = document.querySelector(
        `[data-attachment-row="${String(attachment.id).replace(/["\\]/g, '\\$&')}"]`,
    );
    const progress = row?.querySelector('[data-attachment-progress]');
    if (!progress) return;
    if (attachment.status !== 'downloading') {
        progress.hidden = true;
        return;
    }
    progress.hidden = false;
    const fill = progress.querySelector('i');
    const label = progress.querySelector('small');
    const total = Number(attachment.totalBytes) || 0;
    const received = Number(attachment.receivedBytes) || 0;
    const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null;
    if (fill) fill.style.width = percent === null ? '35%' : `${percent}%`;
    if (label) {
        label.textContent =
            percent === null ? formatBytes(received) : `${percent}% · ${formatBytes(received)}`;
    }
    progress.classList.toggle('is-indeterminate', percent === null);
}

function setCreationPageBackground(url) {
    try {
        // Reuse the UI helper: showPage() clears the background for non-album
        // pages, so direct DOM writes were being removed after render.
        UIRenderer.instance.setPageBackground(url || null);
    } catch {
        // UIRenderer is not ready during very early boot.
    }
}

function closeCreationDetail() {
    const session = detailSession;
    if (!session) return;
    detailSession = null;
    setCreationPageBackground('');
    session.controller.abort();
    session.viewer.dispose();
    for (const url of session.urls.values()) URL.revokeObjectURL(url);
    session.urls.clear();
}

function attachmentRemoteUrl(attachment) {
    return attachment.remoteUrl || attachment.sourceUrl || attachment.src || '';
}

// 本地记录的 key:附件用 id;「只有缩略图」帖子的画廊预览没有附件 id,用解析时生成的 previewId。
function localFileId(attachment) {
    return attachment?.id || attachment?.previewId || '';
}

function isPreviewOnly(attachment) {
    return Boolean(attachment?.previewId) && !attachment.id;
}

async function localAttachmentUrl(post, attachment, cache, signal) {
    if (!attachment || attachment.status !== 'local' || !attachment.localKey) return null;
    // 预览项本身就是缩略图,没有原图可给;灯箱也用这张本地缩略图。
    if (isPreviewOnly(attachment)) return localAttachmentThumbnailUrl(post, attachment, cache, signal);
    const key = post.id + '/' + attachment.id;
    if (cache.has(key)) return cache.get(key);
    const host = globalThis.__monochromeFileStorage?.creation;
    if (attachment.hostAssetId && host?.fetchAsset) {
        try {
            const blob = await host.fetchAsset(attachment.hostAssetId);
            if (blob && !signal?.aborted) {
                const url = URL.createObjectURL(blob);
                cache.set(key, url);
                return url;
            }
        } catch {
            // Fall through to the IndexedDB record.
        }
    }
    try {
        const record = await getLocalFile(post.id, attachment.id);
        if (!record?.blob || signal?.aborted) return null;
        if (cache.has(key)) return cache.get(key);
        const url = URL.createObjectURL(record.blob);
        cache.set(key, url);
        return url;
    } catch (error) {
        console.error('Failed to resolve local attachment URL:', error);
        return null;
    }
}

async function localAttachmentThumbnailUrl(post, attachment, cache, signal) {
    if (!attachment || attachment.status !== 'local' || !attachment.localKey) return null;
    const key = post.id + '/' + localFileId(attachment) + ':thumb';
    if (cache.has(key)) return cache.get(key);
    const host = globalThis.__monochromeFileStorage?.creation;
    if (attachment.thumbnailHostAssetId && host?.fetchAsset) {
        try {
            const blob = await host.fetchAsset(attachment.thumbnailHostAssetId);
            if (blob && !signal?.aborted) {
                const url = URL.createObjectURL(blob);
                cache.set(key, url);
                return url;
            }
        } catch {
            // Fall through to the IndexedDB thumbnail record.
        }
    }
    try {
        const record = await getLocalFile(post.id, localFileId(attachment));
        if (!record?.thumbnailBlob || signal?.aborted) return null;
        if (cache.has(key)) return cache.get(key);
        const url = URL.createObjectURL(record.thumbnailBlob);
        cache.set(key, url);
        return url;
    } catch {
        return null;
    }
}

async function hydrateAttachmentLocalUrls(post, session) {
    const { detail, urls, controller } = session;
    const { signal } = controller;
    const attachmentById = new Map(post.attachments.map((attachment) => [attachment.id, attachment]));
    for (const element of detail.querySelectorAll('img[data-attachment-id], video[data-attachment-id], a[data-attachment-id]')) {
        const attachment = attachmentById.get(element.dataset.attachmentId);
        const localUrl = await localAttachmentUrl(post, attachment, urls, signal);
        if (signal.aborted) return;
        if (!localUrl) continue;
        if (element.tagName === 'A') {
            element.href = localUrl;
            continue;
        }
        const previewUrl = element.tagName === 'IMG' && element.hasAttribute('data-image-preview')
            ? await localAttachmentThumbnailUrl(post, attachment, urls, signal)
            : null;
        if (signal.aborted) return;
        element.src = previewUrl || localUrl;
        if (element.tagName === 'IMG') element.dataset.full = localUrl;
    }
    // 「只有缩略图」帖子的画廊/文件行/封面:本地只有缩略图,src 与灯箱源都换成它。
    const previewById = new Map(post.gallery.filter((image) => image.previewId).map((image) => [image.previewId, image]));
    for (const element of detail.querySelectorAll('img[data-preview-id]')) {
        const localUrl = await localAttachmentThumbnailUrl(post, previewById.get(element.dataset.previewId), urls, signal);
        if (signal.aborted) return;
        if (!localUrl) continue;
        element.src = localUrl;
        element.dataset.full = localUrl;
    }
}

function selectedCreationRows(session) {
    return session.rows.filter((row) => selectedAttachmentIds.has(row.selectionId));
}

function updateAttachmentToolbar(post) {
    const session = detailSession;
    if (session?.post !== post) return;
    const toolbar = session.detail.querySelector('#creation-attachment-toolbar');
    if (!toolbar) return;
    const managed = downloadableAttachments(post);
    const selected = selectedCreationRows(session);
    const available = session.rows.filter((row) => row.selectable && (!row.description || showDescriptions));
    toolbar.querySelector('[data-local-count]').textContent = t('creations.localFilesCount', {
        local: managed.filter((attachment) => attachment.status === 'local').length,
        total: managed.length,
    });
    toolbar.querySelector('[data-creation-selection-count]').textContent =
        t('creations.detailSelected', { count: selected.length });
    const selectAll = toolbar.querySelector('#creation-select-files');
    selectAll.checked = available.length > 0 && available.every((row) => selectedAttachmentIds.has(row.selectionId));
    selectAll.indeterminate = !selectAll.checked && available.some((row) => selectedAttachmentIds.has(row.selectionId));
    selectAll.disabled = !available.length;
    toolbar.querySelector('#creation-download-selected').disabled = !selected.some((row) => row.downloadUrl);
    toolbar.querySelector('#creation-queue-selected').disabled = !selected.some((row) => row.kind === 'audio');
    toolbar.querySelector('#creation-delete-local-selected').disabled =
        !selected.some((row) => row.managed && row.attachment.status === 'local');
    session.detail.querySelectorAll('[data-attachment-check]').forEach((button) => {
        const checked = selectedAttachmentIds.has(button.dataset.attachmentCheck);
        button.setAttribute('aria-pressed', String(checked));
        button.textContent = checked ? '✓' : '';
        button.closest('.creation-attachment')?.classList.toggle('creation-attachment--selected', checked);
    });
    syncCreationFolderChecks(post);
}

// 单个附件「远程 → 本地」:手动「下载所选/下载全部」与导入时自动保存图片共用这一份,
// 不允许出现第二套下载/存储逻辑(fetchCreationFile 取字节 → putLocalFile 落 host/IndexedDB,
// 图片连同 previewUrl 缩略图一起存)。失败直接抛出,由调用方决定失败的表现。
//
// target 也可以是「只有缩略图」帖子的画廊项(带 previewId、没有附件 id):那种帖子没有原图链接,
// 只把缩略图存成本地预览(putLocalFile 的 blob 传 null),不伪造原图。
async function saveAttachmentLocally(post, attachment, { signal } = {}) {
    const previewOnly = Boolean(attachment.previewId) && !attachment.id;
    const key = attachment.id || attachment.previewId;
    const url = previewOnly ? attachment.src : attachment.remoteUrl || attachment.sourceUrl || attachment.src;
    const init = { referrerPolicy: 'no-referrer', signal };
    attachment.status = 'downloading';
    attachment.receivedBytes = 0;
    attachment.totalBytes = 0;
    updateAttachmentRowState(attachment);
    // fetchCreationFile:Pawchive 签名原图域没有 CORS 头,dev 下直连失败时走同源代理。
    const response = await fetchCreationFile(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    attachment.totalBytes = total;
    let blob;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            attachment.receivedBytes = received;
            attachment.progress = total > 0 ? Math.round((received / total) * 100) : null;
            updateAttachmentProgress(attachment);
        }
        blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
    } else {
        blob = await response.blob();
    }
    let thumbnailBlob = previewOnly ? blob : null;
    if (!previewOnly && attachment.previewUrl && attachment.previewUrl !== url) {
        try {
            const previewResponse = await fetchCreationFile(attachment.previewUrl, init);
            if (previewResponse.ok) thumbnailBlob = await previewResponse.blob();
        } catch {
            // The original is still usable; a missing preview must not fail the save.
        }
    }
    // 中途被取消(同 URL 重导/删除创作)时不能再落盘:新导入的那份记录已经接管了这条附件。
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const name = attachment.name || safeDecodeName(url) || key;
    const record = await putLocalFile(post.id, { ...attachment, id: key, name }, previewOnly ? null : blob, {
        sourceUrl: url,
        mime: blob.type || attachment.mime || '',
        thumbnailBlob,
        thumbnailMime: thumbnailBlob?.type || '',
    });
    if (!previewOnly) attachment.id = attachment.id || `att-${Date.now()}`;
    attachment.status = 'local';
    attachment.localKey = record.localKey || `${post.id}/${key}`;
    attachment.hostAssetId = record.hostAssetId || '';
    attachment.thumbnailHostAssetId = record.thumbnailHostAssetId || '';
    attachment.bytes = record.bytes;
    attachment.mime = record.mime;
    attachment.progress = 100;
    delete attachment.downloadError;
    updateAttachmentRowState(attachment);
    return true;
}

function safeDecodeName(url) {
    try {
        return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {
        return '';
    }
}

// ---- 导入时自动保存图片 -------------------------------------------------------------------
// 用户要求(2026-11-17):导入 Pawchive 帖子时就把每张图片的缩略图和原图存到本地,之后详情/灯箱
// 都读本地文件,不再依赖约 6 小时过期的签名原图链接,也就不需要续签。只管图片;zip/音频/视频/其他
// 文件保持远程,仍由用户手动下载。导入本身不等它:卡片出现、进详情后在后台逐张下。
//
// 并发 2:用户给的范围是 2–3;站点要求 ≤ 5 个并发下载、≤ 1 请求/秒,所以每张图的开始时间再间隔
// AUTO_SAVE_START_GAP_MS(一张图 = 原图 + 缩略图两次请求),不在导入瞬间一口气打出所有请求。
const AUTO_SAVE_CONCURRENCY = 2;
const AUTO_SAVE_START_GAP_MS = 1000;
const autoSaveJobs = new Map();

function imageAutoSaveTargets(post) {
    const images = downloadableAttachments(post).filter(
        (attachment) => attachment.kind === 'image' && !['local', 'downloading'].includes(attachment.status),
    );
    const previews = post.gallery.filter(
        (image) => image.previewId && image.status !== 'local' && image.status !== 'downloading' && safeCreationUrl(image.src),
    );
    return [...images, ...previews];
}

// 详情页正开着这份创作时,把刚落地的文件换成本地 blob,并刷新「本地 x / y」;不整页重渲染,
// 免得用户正在看的灯箱/滚动位置被打断。
function refreshDetailLocalState(post) {
    const session = detailSession;
    if (session?.post !== post) return;
    updateAttachmentToolbar(post);
    void hydrateAttachmentLocalUrls(post, session);
}

/** 停掉某个创作正在跑的自动保存(同 URL 重导、删除创作前调用),等它真正收尾再返回。 */
async function cancelImageAutoSave(postId) {
    const job = autoSaveJobs.get(postId);
    if (!job) return;
    job.controller.abort();
    await job.done.catch(() => {});
}

function startImageAutoSave(post) {
    const targets = imageAutoSaveTargets(post);
    if (targets.length === 0) return null;
    const controller = new AbortController();
    const { signal } = controller;
    const job = { controller, done: null };
    let nextStartAt = 0;
    const waitForSlot = async () => {
        const now = Date.now();
        const startAt = Math.max(now, nextStartAt);
        nextStartAt = startAt + AUTO_SAVE_START_GAP_MS;
        if (startAt > now) await new Promise((resolveWait) => setTimeout(resolveWait, startAt - now));
    };
    const stillCurrent = () => !signal.aborted && IMPORTED_CREATIONS.includes(post);
    const worker = async () => {
        while (targets.length > 0 && stillCurrent()) {
            const target = targets.shift();
            // 手动「下载所选」可能已经抢先下了这一张。
            if (['local', 'downloading'].includes(target.status)) continue;
            await waitForSlot();
            if (!stillCurrent()) break;
            try {
                await saveAttachmentLocally(post, target, { signal });
            } catch (error) {
                // 单张失败只留在这一行:保持「远程」(以后仍可手动下),记下原因,不弹窗、不打断其他图片。
                target.status = 'remote';
                target.progress = null;
                if (!signal.aborted) {
                    target.downloadError = String(error?.message || error);
                    console.warn('Auto-save of creation image failed:', target.name || target.src, target.downloadError);
                }
                updateAttachmentRowState(target);
            }
            if (!stillCurrent()) break;
            persistImportedCreations();
            refreshDetailLocalState(post);
        }
    };
    job.done = (async () => {
        // uploadAsset 要求 host 里已有这条 post;导入时的 syncCreationPostToHost 是 fire-and-forget,这里先等它落库。
        const host = globalThis.__monochromeFileStorage?.creation;
        if (host?.savePost) await host.savePost(post).catch(() => {});
        await Promise.all(Array.from({ length: AUTO_SAVE_CONCURRENCY }, worker));
        if (stillCurrent()) {
            persistImportedCreations();
            // 画廊预览的本地状态在 post JSON 里,要写回 host,刷新后从 host 合并时才认得。
            syncCreationPostToHost(post);
            refreshDetailLocalState(post);
        }
    })().finally(() => {
        if (autoSaveJobs.get(post.id) === job) autoSaveJobs.delete(post.id);
    });
    autoSaveJobs.set(post.id, job);
    return job;
}

async function downloadAttachmentFiles(post, attachments) {
    // 'downloading' 的那条正由导入自动保存在下,不再并行下第二份。
    const targets = attachments.filter((attachment) => !['local', 'downloading'].includes(attachment.status));
    if (targets.length === 0) return;
    const host = globalThis.__monochromeFileStorage?.creation;
    if (host?.savePost) await host.savePost(post).catch(() => {});
    showNotification(t('creations.downloadingFiles'));
    let downloaded = 0;
    for (const attachment of targets) {
        try {
            await saveAttachmentLocally(post, attachment);
            downloaded += 1;
        } catch (error) {
            console.error('Failed to download creation attachment:', error);
            attachment.status = 'failed';
            updateAttachmentRowState(attachment);
        }
    }
    persistImportedCreations();
    syncCreationPostToHost(post);
    if (detailSession?.post === post) renderDetail(post);
    if (downloaded > 0) showNotification(t('creations.downloadedFiles', { count: downloaded }));
    const failed = targets.length - downloaded;
    if (failed > 0) showNotification(t('creations.downloadAttachmentFailed'));
}

async function deleteSelectedLocalAttachments(post) {
    const targets = downloadableAttachments(post).filter(
        (attachment) => selectedCreationRows(detailSession).some((row) => row.attachment === attachment) && attachment.status === 'local',
    );
    if (targets.length === 0) return;
    const choice = await showCreationChoice({
        title: t('creations.deleteLocalFilesTitle'),
        message: t('creations.deleteLocalFilesConfirm', { count: targets.length }),
        options: [
            { id: 'delete', label: t('creations.deleteLocalFiles'), kind: 'primary' },
            { id: 'cancel', label: t('creations.cancel') },
        ],
    });
    if (choice !== 'delete') return;
    for (const attachment of targets) {
        await deleteLocalFile(post.id, attachment.id);
        attachment.status = 'remote';
        attachment.localKey = '';
        attachment.bytes = 0;
    }
    selectedAttachmentIds.clear();
    persistImportedCreations();
    if (detailSession?.post === post) renderDetail(post);
    showNotification(t('creations.deletedLocalFiles', { count: targets.length }));
}


function safeCreationUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(value, location.href);
        return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function creationDetailRows(post) {
    const managed = new Set(downloadableAttachments(post));
    const files = [...post.attachments];
    for (const image of post.gallery) {
        if (files.some((file) => (image.attachmentId && file.id === image.attachmentId) ||
            (image.src && [file.src, file.remoteUrl, file.sourceUrl].includes(image.src)))) continue;
        const src = image.full || image.src;
        // previewId 带到文件行上:行缩略图也要换成导入时存下的本地预览(hydrate 按 data-preview-id 找)。
        if (src) files.push({ type: 'image', name: image.alt || src.split('/').at(-1), src, thumbnail: image.src, previewId: image.previewId || '' });
    }
    return files.map((attachment, index) => {
        const name = String(attachment.name || attachment.title || t('creations.file'));
        const type = getVoiceFileType({ title: name, type: attachment.kind || attachment.type });
        const media = attachmentMediaKind(attachment);
        const kind = media || (attachment.type === 'description' ? 'text' :
            attachment.type === 'link' ? 'link' : type !== 'other' ? type :
            attachment.kind === 'archive' || /\.(zip|7z|rar|tar|gz|gp[345x]?)$/i.test(name) ? 'archive' : 'file');
        const url = attachment.missing ? '' : safeCreationUrl(attachmentRemoteUrl(attachment));
        const isManaged = managed.has(attachment);
        return {
            attachment, index, name, kind, url,
            path: attachment.relativePath || attachment.logicalPath || attachment.path || name,
            selectionId: attachment.id || `sample-${index}`,
            attachmentId: attachment.id || '',
            description: attachment.type === 'description',
            managed: isManaged,
            selectable: kind !== 'link' && Boolean(url || attachment.status === 'local' || kind === 'audio'),
            downloadUrl: kind === 'link' ? '' : url,
            // Pawchive/Kikoeru expose previewUrl for the small image; the
            // full-size attachment URL must stay the lightbox source.
            thumb: safeCreationUrl(
                attachment.thumbnail || attachment.previewUrl || (kind === 'image' ? url : kind === 'video' ? attachment.poster : ''),
            ),
            meta: attachment.audioFor || '',
            size: media ? attachment.duration || (attachment.bytes ? formatBytes(attachment.bytes) : '') :
                attachment.bytes ? formatBytes(attachment.bytes) : '',
        };
    });
}

function creationRowMarkup(row, audios, videos) {
    const { attachment, kind, name, url, selectionId, managed } = row;
    const selector = row.selectable ? `<button type="button" class="creation-attachment-check"
        data-attachment-check="${escapeHtml(selectionId)}" aria-pressed="false"
        aria-label="${escapeHtml(t('creations.selectAttachment') + ' ' + name)}"></button>` : '';
    const status = managed ? `<span class="creation-attachment-state" data-state="${escapeHtml(attachment.status || 'remote')}">
        ${escapeHtml(attachmentStatusText(attachment))}</span>` : '';
    const progress = managed ? '<div class="creation-attachment-progress" data-attachment-progress hidden><span><i></i></span><small></small></div>' : '';
    const play = kind === 'audio' || kind === 'video' ? `<button type="button" class="btn btn-secondary creation-row-action ${kind === 'audio' ? 'creations-play-btn' : 'creation-video-play'}"
        ${kind === 'audio' ? `data-play-index="${audios.indexOf(attachment)}"` : `data-play-video-index="${videos.indexOf(attachment)}"`}
        title="${escapeHtml(t('creations.playInPlayer'))}" aria-label="${escapeHtml(t('creations.playInPlayer'))}">${SVG_PLAY(16)}</button>` : '';
    const queue = kind === 'audio' ? `<button type="button" class="btn btn-secondary creation-row-action creation-audio-queue-btn"
        data-audio-queue-index="${audios.indexOf(attachment)}" title="${escapeHtml(t('creations.addToQueue'))}"
        aria-label="${escapeHtml(t('creations.addToQueue'))}">${SVG_PLUS(16)}</button>` : '';
    const download = row.downloadUrl ? `<a class="creation-attachment-link btn btn-secondary creation-row-action"
        data-attachment-id="${escapeHtml(row.attachmentId)}" href="${escapeHtml(url)}" download="${escapeHtml(name)}"
        target="_blank" rel="noreferrer" title="${escapeHtml(t('creations.download'))}"
        aria-label="${escapeHtml(t('creations.download'))}">${SVG_DOWNLOAD(16)}</a>` : '';
    return {
        ...row, selector, status, progress, controls: play + queue + download,
        attrs: kind === 'audio' ? `data-audio-index="${audios.indexOf(attachment)}"` : '',
    };
}

function creationAttachmentToolbar() {
    return `<div id="creation-attachment-toolbar" class="creation-attachment-toolbar voice-selection-toolbar">
        <label class="voice-select-all-label"><input type="checkbox" id="creation-select-files" class="voice-native-checkbox" />
            ${escapeHtml(t('voices.selectAllFiles'))}</label>
        <span data-creation-selection-count role="status" aria-live="polite"></span>
        <span class="creation-local-count" data-local-count></span>
        <div class="creation-attachment-actions voice-selection-actions">
            <button type="button" class="btn btn-secondary" id="creation-queue-selected" disabled>${escapeHtml(t('creations.addToQueue'))}</button>
            <button type="button" class="btn btn-secondary" id="creation-download-selected" disabled>${escapeHtml(t('creations.downloadSelected'))}</button>
            <button type="button" class="btn btn-secondary creation-delete-btn" id="creation-delete-local-selected" disabled>${escapeHtml(t('creations.deleteLocalSelected'))}</button>
        </div>
    </div>`;
}

async function downloadCreationRows(post, rows) {
    const managed = rows.filter((row) => row.managed && row.attachment.status !== 'local');
    const exports = rows.filter((row) => row.downloadUrl && !managed.includes(row));
    if (managed.length) await downloadAttachmentFiles(post, managed.map((row) => row.attachment));
    if (!exports.length) return;
    const cache = new Map();
    try {
        const files = [];
        const used = new Set();
        for (const row of exports) {
            const local = await localAttachmentUrl(post, row.attachment, cache);
            const response = local
                ? await fetch(local)
                : await fetchCreationFile(row.downloadUrl, { referrerPolicy: 'no-referrer' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const parts = String(row.path).split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..');
            const original = parts.join('/') || row.name;
            let name = original;
            for (let suffix = 2; used.has(name); suffix++) name = `${original}-${suffix}`;
            used.add(name);
            files.push({ name, input: await response.blob() });
        }
        const zip = files.length > 1;
        const blob = zip ? await (await import('client-zip')).downloadZip(files).blob() : files[0].input;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = zip ? `${post.title.replace(/[\\/:*?"<>|]/g, '_')}.zip` : exports[0].name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.error('Failed to download creation files:', error);
        showNotification(t('creations.downloadAttachmentFailed'));
    } finally {
        for (const url of cache.values()) URL.revokeObjectURL(url);
    }
}

let creationFolderMenuCleanup = null;

function closeCreationFolderMenu() {
    creationFolderMenuCleanup?.();
    creationFolderMenuCleanup = null;
}

function creationRowsInFolder(rows, folderPath) {
    // Images are rendered in a synthetic folder; their display paths are
    // rewritten inside renderCreationFileTree, so match the virtual folder by
    // kind instead of by the original attachment path.
    if (folderPath.length === 1 && folderPath[0] === t('creations.imagesFolder')) {
        return rows.filter((row) => row.kind === 'image' && !row.description);
    }
    const prefix = folderPath.map((part) => String(part || '').replace(/\\/g, '/')).join('/');
    if (!prefix) return [];
    return rows.filter((row) => String(row.path || '').replace(/\\/g, '/').startsWith(`${prefix}/`));
}

function syncCreationFolderChecks(post) {
    const session = detailSession;
    if (!session || session.post !== post) return;
    for (const input of session.detail.querySelectorAll('[data-creation-folder-select-path]')) {
        let folderPath = [];
        try { folderPath = JSON.parse(input.dataset.creationFolderSelectPath || '[]'); } catch { continue; }
        const candidates = creationRowsInFolder(session.rows, folderPath)
            .filter((row) => row.selectable && (!row.description || showDescriptions));
        const selected = candidates.filter((row) => selectedAttachmentIds.has(row.selectionId));
        input.checked = candidates.length > 0 && selected.length === candidates.length;
        input.indeterminate = selected.length > 0 && selected.length < candidates.length;
        input.disabled = candidates.length === 0;
    }
}

function openCreationFolderMenu(button, post, rows, folderPath) {
    closeCreationFolderMenu();
    const folderRows = creationRowsInFolder(rows, folderPath);
    if (!folderRows.length) return;
    const menu = document.createElement('div');
    menu.className = 'voice-folder-menu creation-folder-popup';
    menu.setAttribute('role', 'menu');
    const add = (label, run) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'voice-folder-menu-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeCreationFolderMenu();
            run();
        });
        menu.append(item);
    };
    add(t('voices.downloadFolder'), () => void downloadCreationRows(post, folderRows));
    const managed = folderRows.filter((row) => row.managed);
    if (managed.length) {
        const allLocal = managed.every((row) => row.attachment.status === 'local');
        add(allLocal ? t('voices.deleteFromLibrary') : t('voices.saveToLibrary'), () => {
            if (allLocal) {
                selectedAttachmentIds.clear();
                managed
                    .filter((row) => row.attachment.status === 'local')
                    .forEach((row) => selectedAttachmentIds.add(row.selectionId));
                void deleteSelectedLocalAttachments(post);
            } else {
                void downloadAttachmentFiles(post, managed
                    .filter((row) => row.attachment.status !== 'local')
                    .map((row) => row.attachment));
            }
        });
    }
    document.body.append(menu);
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;

    const close = () => {
        menu.remove();
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeydown);
    };
    const onDocumentClick = (event) => {
        if (menu.contains(event.target) || button.contains(event.target)) return;
        close();
    };
    const onKeydown = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            button.focus();
        }
    };
    setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
    document.addEventListener('keydown', onKeydown);
    creationFolderMenuCleanup = close;
    menu.querySelector('button')?.focus();
}

function creationMoreCardMarkup(entry) {
    return `<a class="creation-more-card creation-card" href="/creations/${encodeURIComponent(entry.id)}" data-adult="${Boolean(entry.nsfw)}">
        <div class="creation-card-cover"><img src="${escapeHtml(safeCreationUrl(entry.cover))}" alt="" loading="lazy" referrerpolicy="no-referrer" /></div>
        <div class="creation-more-card-body creation-card-body">
            <h3 class="creation-more-card-title">${escapeHtml(entry.title)}</h3>
            <p class="creation-more-card-sub">${escapeHtml(formatCreationLibraryDate(entry))}</p>
        </div>
    </a>`;
}

// Import provenance is not a series: every Pawchive import carries
// Pawchive/预览, so matching those would make unrelated imports look related.
const CREATION_SYSTEM_TAGS = new Set([
    'pawchive',
    '预览',
    'preview',
    '已导入',
    'imported',
    'web',
    '本地',
    'local',
    'download',
    '下载',
]);

function creationMeaningfulTags(tags) {
    return (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag).trim().toLocaleLowerCase())
        .filter((tag) => tag && !CREATION_SYSTEM_TAGS.has(tag));
}

function creationTagRelatedPosts(post) {
    const ownTags = new Set(creationMeaningfulTags(post.tags));
    if (!ownTags.size) return [];
    const scored = [];
    for (const entry of CREATIONS) {
        if (!entry || entry.id === post.id) continue;
        const shared = creationMeaningfulTags(entry.tags).filter((tag) => ownTags.has(tag)).length;
        if (!shared) continue;
        scored.push({ entry, shared });
    }
    return scored
        .sort((a, b) => b.shared - a.shared
            || String(getCreationLibraryDate(b.entry).value).localeCompare(String(getCreationLibraryDate(a.entry).value)))
        .slice(0, 6)
        .map(({ entry }) => entry);
}

function creationRelatedMarkup(post, creator) {
    const creatorPosts = CREATIONS.filter((entry) => entry.id !== post.id && creator.postIds.includes(entry.id))
        .sort((a, b) => String(getCreationLibraryDate(b).value).localeCompare(String(getCreationLibraryDate(a).value))).slice(0, 6);
    const tagPosts = creationTagRelatedPosts(post);
    const grid = (entries) => entries.length
        ? `<div class="creation-more-grid">${entries.map((entry) => creationMoreCardMarkup(entry)).join('')}</div>`
        : `<p class="creation-column-sub">${escapeHtml(t('creations.detailNoRelated'))}</p>`;
    return `<section class="creation-bottom-more" data-creation-more>
        <div class="creation-bottom-more-head">
            <h2 class="section-title">${escapeHtml(t('creations.detailMore', { name: creator.name }))}</h2>
            <div class="voice-album-more-switch creation-more-switch" role="group" aria-label="${escapeHtml(t('creations.detailMore', { name: creator.name }))}">
                <button type="button" class="is-active" data-creation-more-tab="creator" aria-pressed="true">${escapeHtml(t('creations.sameCreator', { count: creatorPosts.length }))}</button>
                <button type="button" data-creation-more-tab="tags" aria-pressed="false">${escapeHtml(t('creations.sameTags'))}</button>
            </div>
        </div>
        <div data-creation-more-panel="creator">${grid(creatorPosts)}</div>
        <div data-creation-more-panel="tags" hidden>${grid(tagPosts)}</div>
    </section>`;
}

function creationHeaderMarkup(post, creator, audios, rows) {
    const formats = [...new Set(audios.map((file) => getVoiceTrackFormat({ title: file.name, audioUrl: file.src })).filter(Boolean))];
    const date = formatCreationLibraryDate(post);
    const seconds = audios.reduce((total, file) => total + (Number(file.durationSeconds) || 0), 0);
    const time = seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';
    const stats = [audios.length ? t('creations.detailTrackCount', { count: audios.length }) : '', t('creations.fileCount', { count: rows.length }), time, post.imported ? t('creations.imported') : ''].filter(Boolean);
    const source = safeCreationUrl(post.sourceUrl);
    const cover = safeCreationUrl(post.cover) || '/assets/creation-cover-placeholder.svg';
    const coverAttachment = post.gallery.find((image) => image.attachmentId && [image.src, image.full].includes(post.cover));
    const coverPreview = coverAttachment ? null : post.gallery.find((image) => image.previewId && image.src === post.cover);
    const provider = post.creatorPlatform || post.provider || t('creations.local');
    const favorite = isCreationFavorite(post.id);
    const action = (attributes, label, icon) => `<button type="button" class="btn btn-secondary creation-action-circle"
        ${attributes} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
    return `<header class="detail-header creation-detail-hero">
        <div class="creation-detail-cover-wrap">
            <img class="detail-header-image" src="${escapeHtml(cover)}" alt="${escapeHtml(post.title)}"
                data-zoom="true" data-attachment-id="${escapeHtml(coverAttachment?.attachmentId || '')}"
                ${coverPreview ? `data-preview-id="${escapeHtml(coverPreview.previewId)}"` : ''}
                tabindex="0" role="button" referrerpolicy="no-referrer" title="${escapeHtml(t('creations.zoomHint'))}" />
            ${post.sourcePostId ? `<span class="creation-cover-badge creation-cover-badge--code">${escapeHtml(provider)} #${escapeHtml(post.sourcePostId)}</span>` : ''}
            ${date ? `<span class="creation-cover-badge creation-cover-badge--date">${escapeHtml(date)}</span>` : ''}
        </div>
        <div class="detail-header-info creation-detail-heading">
            <div class="creation-title-row"><h1 class="title">${escapeHtml(post.title)}</h1></div>
            <div class="meta creation-detail-meta">${stats.map((stat) => `<span>${escapeHtml(stat)}</span>`).join('<span aria-hidden="true">•</span>')}</div>
            <div class="creation-creator-rows">
                <div class="creation-creator-row creation-creator-row--creator">
                    <span class="creation-creator-label">${escapeHtml(t('creations.artist'))}</span>
                    <a class="creation-creator-link creation-creator-profile" href="${escapeHtml(creatorPath(creator))}"
                        data-creator-profile-id="${escapeHtml(creator.id)}" title="${escapeHtml(t('creations.openArtist'))}">
                        <span class="creation-detail-avatar">
                            <img src="${escapeHtml(safeCreationUrl(creator.avatar))}" alt="" referrerpolicy="no-referrer" />
                        </span>
                        <span class="creation-creator-name">${escapeHtml(creator.name)}</span>
                    </a>
                    <button type="button" class="btn btn-secondary creation-filter-author" data-filter-creator-id="${escapeHtml(creator.id)}">
                        ${escapeHtml(t('creations.filterByCreatorShort'))}
                    </button>
                </div>
                <div class="creation-creator-row">
                    <span class="creation-creator-label">${escapeHtml(t('creations.platform'))}</span>
                    <span class="creation-chip creation-chip--artist">${escapeHtml(provider)}</span>
                </div>
                ${post.tags?.length ? `<div class="creation-creator-row"><span class="creation-creator-label">${escapeHtml(t('creations.library.tags'))}</span>${post.tags.map((tag) => `<span class="creation-chip creation-chip--tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="detail-header-actions creation-header-actions">
                ${audios.length ? `<button type="button" class="btn btn-primary creation-action-play" id="creations-play-all">
                    ${SVG_PLAY(19)}<span>${escapeHtml(t('creations.playAll'))}</span></button>` : ''}
                ${formats.length > 1 ? `<label class="creation-format-picker">
                    <select id="creation-play-format" aria-label="${escapeHtml(t('creations.detailPlayFormat'))}">
                        <option value="">${escapeHtml(t('creations.detailPlayFormat'))}</option>
                        ${formats.map((format) => `<option value="${format}">${format.toUpperCase()}</option>`).join('')}
                    </select></label>` : ''}
                ${audios.length > 1 ? action('id="creation-shuffle"', t('creations.detailShuffle'), SVG_SHUFFLE(18)) : ''}
                ${rows.some((row) => row.downloadUrl) ? action('id="creation-download-all"', t('creations.downloadAll'), SVG_DOWNLOAD(18)) : ''}
                ${source ? `<a class="btn btn-secondary creation-action-circle" href="${escapeHtml(source)}" target="_blank" rel="noreferrer"
                    title="${escapeHtml(t('creations.openSource'))}" aria-label="${escapeHtml(t('creations.openSource'))}">${SVG_LINK(18)}</a>` : ''}
                ${post.imported ? action(`id="creation-delete-post" data-delete-post-id="${escapeHtml(post.id)}"`, t('creations.deleteImported'), SVG_TRASH(18)) : ''}
                ${action(`id="creation-favorite" aria-pressed="${favorite}"`, t(favorite ? 'creations.unfavorite' : 'creations.favorite'), favorite ? SVG_HEART_FILLED(18) : SVG_HEART(18))}
                ${action('id="creation-actions-menu"', t('creations.moreActions'), SVG_MENU(18))}
            </div>
        </div>
    </header>`;
}

function updateCreationFavoriteButton(button, post) {
    if (!button) return;
    const favorite = isCreationFavorite(post.id);
    button.setAttribute('aria-pressed', String(favorite));
    button.title = t(favorite ? 'creations.unfavorite' : 'creations.favorite');
    button.setAttribute('aria-label', button.title);
    button.innerHTML = favorite ? SVG_HEART_FILLED(18) : SVG_HEART(18);
}

function openCreationActionsMenu(anchor, post, rows) {
    document.querySelector('.creation-actions-menu')?.remove();
    const source = safeCreationUrl(post.sourceUrl);
    const favorite = isCreationFavorite(post.id);
    const items = [
        { action: 'favorite', label: t(favorite ? 'creations.unfavorite' : 'creations.favorite') },
        rows.some((row) => row.downloadUrl) ? { action: 'download', label: t('creations.downloadAll') } : null,
        source ? { action: 'source', label: t('creations.openSource') } : null,
        source ? { action: 'copy-source', label: t('creations.copySource') } : null,
        post.imported ? { action: 'delete', label: t('creations.deleteImported'), danger: true } : null,
    ].filter(Boolean);
    const menu = document.createElement('div');
    menu.className = 'creation-actions-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map((item) => `<button type="button" role="menuitem" data-creation-menu-action="${item.action}"${item.danger ? ' class="is-danger"' : ''}>${escapeHtml(item.label)}</button>`).join('');
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 6))}px`;
    const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', onKey, true);
    };
    const outside = (event) => {
        if (!menu.contains(event.target) && event.target !== anchor) close();
    };
    const onKey = (event) => {
        if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    menu.addEventListener('click', (event) => {
        const button = event.target.closest('[data-creation-menu-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.creationMenuAction;
        close();
        if (action === 'favorite') {
            toggleCreationFavorite(post);
            updateCreationFavoriteButton(document.getElementById('creation-favorite'), post);
        } else if (action === 'download') {
            void downloadCreationRows(post, rows);
        } else if (action === 'source') {
            window.open(source, '_blank', 'noopener,noreferrer');
        } else if (action === 'copy-source') {
            navigator.clipboard?.writeText(source).then(
                () => showNotification(t('creations.copiedSource')),
                () => showNotification(t('creations.copySourceFailed')),
            );
        } else if (action === 'delete') {
            deleteImportedPost(post.id);
        }
    });
}

function creationIntroMarkup(post, videos) {
    const description = postDescription(post);
    const paragraphs = post.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
    const excerpt = !paragraphs && !description && post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : '';
    const gallery = post.gallery.filter((image) => safeCreationUrl(image.src));
    const inlineVideos = videos.filter((attachment) => safeCreationUrl(attachment.src));
    if (!description && !paragraphs && !excerpt && !gallery.length && !inlineVideos.length && !post.incomplete) return '';
    return `<aside class="creation-intro-flat" aria-labelledby="creation-intro-title">
        <div class="creation-column-head"><h2 class="creation-column-title" id="creation-intro-title">${escapeHtml(t('creations.description'))}</h2><span class="creation-column-sub">${escapeHtml(t('creations.descriptionHint'))}</span></div>
        <div class="creation-intro-body">
            ${post.incomplete ? `<div class="creation-preview-note"><strong>${escapeHtml(t('creations.previewImport'))}</strong>
                <span>${escapeHtml(t('creations.previewNote'))} ${escapeHtml(post.missingSummary || '')}</span></div>` : ''}
            ${description ? '<section id="creation-intro" class="creation-intro"></section>' : ''}
            ${paragraphs || excerpt ? `<div class="creation-body">${paragraphs || excerpt}</div>` : ''}
            ${inlineVideos.length ? `<h3>${escapeHtml(t('creations.video'))}</h3><div class="creation-videos">${inlineVideos.map((attachment) => `
                <figure class="creation-video">
                    <video controls playsinline preload="metadata" data-attachment-id="${escapeHtml(attachment.id || '')}"
                        poster="${escapeHtml(safeCreationUrl(attachment.poster || post.cover))}" src="${escapeHtml(safeCreationUrl(attachment.src))}"></video>
                    <figcaption><span>${escapeHtml(attachment.title || attachment.name)}</span><span>${escapeHtml(attachment.duration || '')}</span>
                        <button type="button" class="btn btn-secondary creation-video-play" data-play-video-index="${videos.indexOf(attachment)}">
                            ${escapeHtml(t('creations.playInPlayer'))}</button></figcaption>
                </figure>`).join('')}</div>` : ''}
            ${gallery.length ? `<h3>${escapeHtml(t('creations.gallery'))}</h3><div class="creation-gallery creation-intro-figures">${gallery.map((image) => `
                <figure class="creation-intro-figure"><img src="${escapeHtml(safeCreationUrl(image.src))}" alt="${escapeHtml(image.alt || '')}" data-image-preview
                    data-zoom="true" data-full="${escapeHtml(safeCreationUrl(image.full || image.src))}"
                    data-attachment-id="${escapeHtml(image.attachmentId || '')}" ${image.previewId ? `data-preview-id="${escapeHtml(image.previewId)}"` : ''} tabindex="0" role="button"
                    loading="lazy" referrerpolicy="no-referrer" title="${escapeHtml(t('creations.zoomHint'))}" /></figure>`).join('')}</div>` : ''}
        </div>
    </aside>`;
}


function creationViewerNode(row, url) {
    return { type: row.kind, title: row.name, hash: row.selectionId, mediaStreamUrl: url, mediaDownloadUrl: url };
}

function creationViewerImages(session) {
    return session.rows.filter((row) => row.kind === 'image' && row.url).map((row) => creationViewerNode(
        row, session.urls.get(session.post.id + '/' + row.attachmentId) ||
            (row.attachment.previewId ? session.urls.get(session.post.id + '/' + row.attachment.previewId + ':thumb') : '') ||
            row.url
    ));
}

function openCreationImage(image) {
    const session = detailSession;
    const url = safeCreationUrl(image.dataset.full || image.currentSrc || image.src);
    if (!session || !url) return;
    const images = creationViewerImages(session);
    const node = images.find((item) => item.mediaStreamUrl === url) || {
        type: 'image', title: image.alt || session.post.title, mediaStreamUrl: url
    };
    session.viewer.open({ node, images });
}

async function openCreationFile(session, row, element) {
    if (!row) return;
    const { post, controller, urls, viewer } = session;
    if (row.kind === 'audio') {
        await playCreationAudio(post, row.attachment);
        return;
    }
    if (row.kind === 'link') {
        if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
        return;
    }
    if (row.kind === 'archive' || row.kind === 'file') {
        element.querySelector('.creation-attachment-link')?.click();
        return;
    }
    // 只有缩略图的预览行是 creationDetailRows 现拼的对象,本地状态记在 gallery 那一项上。
    const source = row.attachment.previewId
        ? post.gallery.find((image) => image.previewId === row.attachment.previewId) || row.attachment
        : row.attachment;
    const local = await localAttachmentUrl(post, source, urls, controller.signal);
    if (controller.signal.aborted || !(local || row.url)) return;
    viewer.open({ node: creationViewerNode(row, local || row.url), images: creationViewerImages(session) });
}

function renderDetail(post) {
    const detail = document.getElementById('creations-detail');
    if (!detail) return;
    closeCreationDetail();
    selectedAttachmentIds.clear();
    currentPost = post;
    if (feedView()) feedView().hidden = true;
    if (detailView()) detailView().hidden = false;
    if (artistView()) artistView().hidden = true;
    detail.classList.add('creation-detail-native');
    detail.dataset.adult = String(Boolean(post.nsfw));

    const rows = creationDetailRows(post);
    // Derive media from the rendered rows, not only from the original attachment
    // array: imported Pawchive/Kikoeru posts can expose media through the row
    // classifier even when the source attachment shape is incomplete.
    const audios = rows.filter((row) => row.kind === 'audio').map((row) => row.attachment);
    const videos = rows.filter((row) => row.kind === 'video').map((row) => row.attachment);
    setCreationPageBackground(safeCreationUrl(post.cover) || '/assets/creation-cover-placeholder.svg');
    const creator = creatorOf(post);
    const intro = creationIntroMarkup(post, videos);
    const split = Boolean(rows.length && intro);
    const controller = new AbortController();
    const { signal } = controller;
    const viewer = createVoiceAttachmentViewer({
        onVideoPlay: () => Player.instance.activeElement?.pause(),
        async loadText(url, options) {
            const response = await fetch(url, { signal: options.signal, referrerPolicy: 'no-referrer' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.text();
        }
    });
    const session = { post, detail, rows, controller, viewer, urls: new Map() };
    detailSession = session;
    detail.innerHTML = `
        ${creationHeaderMarkup(post, creator, audios, rows)}
        <div class="creation-album-main-grid" data-creation-split-grid ${split ? '' : 'data-single-column'}>
            ${rows.length ? renderCreationFileTree(rows.map((row) => creationRowMarkup(row, audios, videos)), {
                toolbar: creationAttachmentToolbar(), showDescriptions
            }) : ''}
            ${split ? `<div class="creation-split-resizer" data-creation-split-resizer tabindex="0" role="separator"
                aria-orientation="vertical" aria-label="${escapeHtml(t('creations.detailResize'))}"
                title="${escapeHtml(t('creations.detailResize'))}"><span class="creation-split-resizer-pill" aria-hidden="true"></span></div>` : ''}
            ${intro}
        </div>
        ${creationRelatedMarkup(post, creator)}
    `;

    detail.querySelectorAll('[data-creation-more-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            const selected = button.dataset.creationMoreTab;
            detail.querySelectorAll('[data-creation-more-tab]').forEach((item) => {
                const active = item === button;
                item.classList.toggle('is-active', active);
                item.setAttribute('aria-pressed', String(active));
            });
            detail.querySelectorAll('[data-creation-more-panel]').forEach((panel) => {
                panel.hidden = panel.dataset.creationMorePanel !== selected;
            });
        }, { signal });
    });

    const unmountLayout = mountCreationDetailLayout(detail);
    signal.addEventListener('abort', unmountLayout, { once: true });
    animateVoiceFolders(detail, signal);
    const page = detail.closest('.page');
    if (page) {
        const observer = new MutationObserver(() => {
            if (!page.classList.contains('active') || detailView()?.hidden) closeCreationDetail();
        });
        observer.observe(page, { attributes: true, attributeFilter: ['class'] });
        observer.observe(detailView(), { attributes: true, attributeFilter: ['hidden'] });
        signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    }
    detail.addEventListener('change', (event) => {
        const input = event.target.closest?.('[data-creation-folder-select-path]');
        if (!input) return;
        let folderPath = [];
        try { folderPath = JSON.parse(input.dataset.creationFolderSelectPath || '[]'); } catch { return; }
        const candidates = creationRowsInFolder(rows, folderPath)
            .filter((row) => row.selectable && (!row.description || showDescriptions));
        for (const row of candidates) {
            if (input.checked) selectedAttachmentIds.add(row.selectionId);
            else selectedAttachmentIds.delete(row.selectionId);
        }
        updateAttachmentToolbar(post);
    }, { signal });
    detail.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-creation-folder-menu]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        let folderPath = [];
        try { folderPath = JSON.parse(button.dataset.creationFolderPath || '[]'); } catch { return; }
        openCreationFolderMenu(button, post, rows, folderPath);
    }, { signal });
    const bind = (selector, event, callback) => detail.querySelector(selector)?.addEventListener(event, callback, { signal });
    bind('#creations-play-all', 'click', () => void playAllCreationAudio(post));
    bind('#creation-shuffle', 'click', () => void playAllCreationAudio(post, { shuffle: true }));
    bind('#creation-play-format', 'change', ({ target }) => {
        if (!target.value) return;
        const attachments = audios.filter((audio) => getVoiceTrackFormat({ title: audio.name, audioUrl: audio.src }) === target.value);
        target.value = '';
        void playAllCreationAudio(post, { attachments });
    });
    bind('#creation-show-descriptions', 'change', ({ target }) => {
        showDescriptions = target.checked;
        try { localStorage.setItem(SHOW_DESCRIPTIONS_KEY, String(showDescriptions)); } catch { /* optional preference */ }
        rows.filter((row) => row.description).forEach((row) => selectedAttachmentIds.delete(row.selectionId));
        detail.querySelectorAll('[data-description-row]').forEach((row) => {
            row.hidden = false;
            // Collapse the whole hitbox (not only the inner row) so it animates
            // shut instead of leaving a blank block above the remaining rows.
            const hitbox = row.closest('.voice-album-row-hitbox');
            if (!hitbox) return;
            hitbox.classList.add('is-description-animated');
            hitbox.classList.toggle('is-description-hidden', !showDescriptions);
            hitbox.setAttribute('aria-hidden', String(!showDescriptions));
            hitbox.inert = !showDescriptions;
        });
        updateAttachmentToolbar(post);
    });
    bind('#creation-select-files', 'change', ({ target }) => {
        selectedAttachmentIds.clear();
        if (target.checked) rows.filter((row) => row.selectable && (!row.description || showDescriptions))
            .forEach((row) => selectedAttachmentIds.add(row.selectionId));
        updateAttachmentToolbar(post);
    });
    bind('#creation-queue-selected', 'click', () => void playAllCreationAudio(post, {
        attachments: selectedCreationRows(session).filter((row) => row.kind === 'audio').map((row) => row.attachment), append: true,
    }));
    bind('#creation-download-all', 'click', () => void downloadCreationRows(post, rows));
    bind('#creation-download-selected', 'click', () => void downloadCreationRows(post, selectedCreationRows(session)));
    bind('#creation-delete-local-selected', 'click', () => void deleteSelectedLocalAttachments(post));
    bind('#creation-favorite', 'click', (event) => {
        toggleCreationFavorite(post);
        updateCreationFavoriteButton(event.currentTarget, post);
    });
    bind('#creation-actions-menu', 'click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCreationActionsMenu(event.currentTarget, post, rows);
    });
    updateAttachmentToolbar(post);
    // 后台自动保存可能在这次渲染之前就开始了(导入后跳详情、或离开再回来):进度条不等下一个分块再出现。
    post.attachments.filter((attachment) => attachment.status === 'downloading').forEach(updateAttachmentProgress);
    void hydrateAttachmentLocalUrls(post, session);
    if (postDescription(post)) void renderDescription(post, session);
}

async function playCreatorAudio(creator, posts) {
    const tracks = posts.flatMap((post) => audioAttachments(post).map((attachment) => buildTrack(post, attachment)));
    if (tracks.length === 0) return;
    try {
        const player = Player.instance;
        await player.setQueue(tracks, 0);
        await player.playTrackFromQueue();
        showNotification(`${t('creations.playing')}: ${creator.name}`);
    } catch (error) {
        console.error('Failed to play creator audio:', error);
        showNotification(t('creations.playFailed'));
    }
}

export function renderCreationCreatorPage(reference, ui) {
    closeCreationDetail();
    loadImportedCreations();
    const creator = resolveCreationCreator(reference, creationCreators());
    currentPost = null;
    currentId = creator ? `creator/${creator.id}` : null;
    ui.currentArtistId = null;
    ui.player.clearArtistPopularTracksContext();
    ui.setPageBackground(null);
    // Canonicalization replaces the current entry, so Back still returns to the work/library.
    if (creator && location.pathname !== creatorPath(creator)) {
        history.replaceState(history.state, '', `${creatorPath(creator)}${location.search}${location.hash}`);
    }
    const posts = creator ? CREATIONS.filter((post) => creator.postIds.includes(post.id)) : [];
    const profile = creator || {
        id: '', name: t('creations.creatorPage.unknownProfile'), handle: '', bio: t('creations.creatorPage.unknownHint'),
        avatar: '/assets/creation-avatar-placeholder.svg', platform: '', sourceUrl: ''
    };
    const context = { reference: creator?.id || reference, ui };
    activeCreatorPage = context;
    const cleanup = mountCreationCreatorView({
        creator: profile,
        posts,
        renderCard: (post) => creationCardHtml(post, { inLibrary: true, selectable: false }),
        onPlay: (audioPosts) => void playCreatorAudio(profile, audioPosts),
        onOpenPost: (id) => navigate(`/creations/${encodeURIComponent(id)}`),
        onCreator: openCreator,
        onFilterCreator: filterCreationsByCreator
    });
    return () => {
        cleanup();
        if (activeCreatorPage === context) activeCreatorPage = null;
    };
}

function openCreationDescriptionPanel(post, track = null, toggle = false) {
    const audioName = track?.creationAudioName ?? null;
    const description = (audioName ? audioDescription(post, audioName) : null) ?? postDescription(post);
    const panelTitle = audioName
        ? `${t('creations.audioDescription')} · ${track?.title || post.title}`
        : `${t('creations.description')} · ${post.title}`;
    sidePanelManager.open(
        'creation-description',
        panelTitle,
        null,
        (content) => {
            content.innerHTML = `<div class="creation-side-description">
                <div class="creation-side-meta">${escapeHtml(t('creations.by'))} ${escapeHtml(post.creator)} · ${escapeHtml(post.date)}${
                    audioName ? ` · ${escapeHtml(audioName)}` : ''
                }</div>
                <div class="creation-side-content creation-reader"><p class="creation-side-loading">…</p></div>
            </div>`;
            const target = content.querySelector('.creation-side-content');
            if (!description) {
                target.innerHTML = `<p class="creation-intro-error">${escapeHtml(t('creations.textLoadFailed'))}</p>`;
                return;
            }
            fetch(description.src)
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.text();
                })
                .then((text) => {
                    target.innerHTML = renderDescriptionBlocks(text);
                })
                .catch((error) => {
                    console.error('Failed to load playing description:', error);
                    target.innerHTML = `<p class="creation-intro-error">${escapeHtml(t('creations.textLoadFailed'))}</p>`;
                });
        },
        // 按钮点击允许 toggle;自动展示/语言切换时强制打开,避免把侧栏关掉。
        !toggle,
    );
}

function updateCreationDescription(track) {
    const button = document.getElementById('now-playing-description-btn');
    const post = track?.creationPostId
        ? CREATIONS.find((entry) => entry.id === track.creationPostId)
        : null;
    if (!post) {
        if (button) {
            button.hidden = true;
            button.classList.remove('active');
            button.setAttribute('aria-pressed', 'false');
        }
        if (sidePanelManager.currentView === 'creation-description') sidePanelManager.close();
        return;
    }
    if (button) button.hidden = false;
    // 视频会进全屏视频层,不要让简介侧栏自动盖住画面;需要时用户仍可手动点「简介」。
    if (track?.type === 'video') {
        if (sidePanelManager.currentView === 'creation-description') sidePanelManager.close();
        return;
    }
    // 用户正在看歌词/队列时不抢面板;否则在播放带简介的创作音频时自动展示。
    if (
        sidePanelManager.currentView === 'creation-description' ||
        !sidePanelManager.panel.classList.contains('active')
    ) {
        openCreationDescriptionPanel(post, track);
    }
}

function openCreations(id) {
    if (id && (id.startsWith('artist/') || id.startsWith('creator/'))) {
        openCreator(id.slice(id.indexOf('/') + 1));
        return;
    }
    const post = id ? CREATIONS.find((entry) => entry.id === id) : null;
    if (post) {
        const entering = detailSession?.post.id !== post.id;
        currentId = post.id;
        renderDetail(post);
        if (entering) {
            const scroll = detailView()?.closest('.main-content');
            scroll?.scrollTo({ top: 0, behavior: 'instant' });
        }
        return;
    }
    currentId = null;
    currentPost = null;
    readCreationLibraryUrl();
    renderFeed();
}

const ADULT_TAG_PATTERN = /(?:^|[s/_-])(?:r-?18|18+|adult|nsfw|成人(?:向)?|エロ|えっち)(?:$|[s/_-])/i;

function creationHasAdultFlag(raw, tags = []) {
    if (raw?.nsfw === true || raw?.adult === true || raw?.isAdult === true) return true;
    if (String(raw?.ageRating || '').toLowerCase() === 'adult') return true;
    if (String(raw?.rating || '').toLowerCase() === 'adult') return true;
    return tags.some((tag) => ADULT_TAG_PATTERN.test(String(tag)));
}

function normalizeImportedPost(raw, index) {
    // 'downloading' 只在当前页面会话里有意义:刷新/崩溃后没有任务在下它了,不改回「远程」的话
    // 手动下载与自动保存都会把它当成「正在下」而永远跳过。
    const settled = (entry) =>
        entry && typeof entry === 'object' && entry.status === 'downloading' ? { ...entry, status: 'remote', progress: null } : entry;
    const creator = raw.creator || raw.creatorName || 'Local Import';
    const creatorId =
        raw.creatorId ||
        creator
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') ||
        `local-${index}`;
    const tags = Array.isArray(raw.tags) ? raw.tags : ['导入'];
    return {
        schemaVersion: 2,
        id: raw.id || `imported-${Date.now()}-${index}`,
        imported: true,
        nsfw: creationHasAdultFlag(raw, tags),
        importKind: getCreationOrigin(raw),
        importedAt: raw.importedAt || '',
        title: raw.title || t('creations.imported'),
        creator,
        creatorId,
        creatorHandle: raw.creatorHandle || `@${creator}`,
        creatorAvatar: raw.creatorAvatar || '',
        creatorUrl: raw.creatorUrl || '',
        creatorPlatform: raw.creatorPlatform || raw.sourcePlatform || '',
        creatorSourceId: raw.creatorSourceId || raw.sourceCreatorId || '',
        creatorBio: raw.creatorBio || '',
        date: raw.date || (getCreationOrigin(raw) === 'local' ? new Date().toISOString().slice(0, 10) : ''),
        tags,
        cover: raw.cover || '/assets/creation-cover-placeholder.svg',
        excerpt: raw.excerpt || '',
        body: Array.isArray(raw.body) ? raw.body : raw.body ? [String(raw.body)] : [],
        gallery: Array.isArray(raw.gallery) ? raw.gallery.map(settled) : [],
        attachments: Array.isArray(raw.attachments) ? raw.attachments.map(settled) : [],
        sourceUrl: raw.sourceUrl || raw.importedFrom || '',
        importedFrom: raw.importedFrom || raw.sourceUrl || '',
        sourcePostId: raw.sourcePostId || '',
        provider: raw.provider || '',
        incomplete: Boolean(raw.incomplete),
        missingSummary: raw.missingSummary || '',
        missingAttachments: Array.isArray(raw.missingAttachments) ? raw.missingAttachments : [],
    };
}

function pickJsonFileWeb() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) {
                resolve(null);
                return;
            }
            file.text()
                .then(resolve)
                .catch(() => resolve(null));
        });
        input.click();
    });
}

async function importLocalCreations() {
    try {
        const text = isTauriRuntime() ? await pickCreationJson() : await pickJsonFileWeb();
        if (!text) return;
        await importCreationJsonText(text);
    } catch (error) {
        console.error('Failed to import local creation:', error);
        showNotification(t('creations.importFailed'));
    }
}

async function importPreviewFromUrl(incomingUrl = '') {
    const url = String(incomingUrl || '').trim() || window.prompt(t('creations.importUrlPrompt'), '');
    if (!url) return;
    const sourceUrl = url.trim();
    if (!isPawchivePostUrl(sourceUrl)) {
        showNotification(t('creations.importUrlInvalid'));
        return;
    }
    showNotification(t('creations.importUrlLoading'));
    try {
        const html = await fetchCreationPreviewHtml(sourceUrl);
        const post = parsePawchivePostHtml(html, sourceUrl);
        // 上一次导入的自动保存还在跑的话先停掉:否则它可能在「覆盖」清空本地文件之后又写进一份旧的。
        await cancelImageAutoSave(post.id);
        const localFiles = await localFileSummary(post.id).catch(() => ({ count: 0, bytes: 0, files: [] }));
        const existing = IMPORTED_CREATIONS.find((entry) => entry.id === post.id);

        let mode = 'merge';
        if (localFiles.count > 0) {
            if (importOptions.overwriteLocalFiles) {
                mode = 'overwrite';
                await deleteCreationFiles(post.id);
            } else {
                const choice = await showCreationChoice({
                    title: t('creations.reimportConflictTitle'),
                    message: t('creations.reimportConflictMessage', {
                        files: localFiles.count,
                        size: formatBytes(localFiles.bytes),
                    }),
                    options: [
                        { id: 'overwrite', label: t('creations.overwriteLocalFiles'), kind: 'primary' },
                        { id: 'keep', label: t('creations.keepExistingLocalFiles') },
                        { id: 'cancel', label: t('creations.cancel') },
                    ],
                });
                if (!choice || choice === 'cancel') return;
                mode = choice;
                if (choice === 'overwrite') {
                    await deleteCreationFiles(post.id);
                } else {
                    const localById = new Map(localFiles.files.map((file) => [file.attachmentId, file]));
                    // 保留下来的本地文件要把 host asset id 一起带上,否则读回时只能绕 IndexedDB 记录再查一次 host。
                    const keepLocal = (entry, local) => ({
                        ...entry,
                        status: 'local',
                        localKey: local.localKey || local.key,
                        hostAssetId: local.hostAssetId || '',
                        thumbnailHostAssetId: local.thumbnailHostAssetId || '',
                        bytes: local.bytes,
                        mime: local.mime,
                    });
                    post.attachments = post.attachments.map((attachment) => {
                        const local = localById.get(attachment.id);
                        return local ? keepLocal(attachment, local) : attachment;
                    });
                    // 只有缩略图的帖子:本地预览按 previewId 存,同样要认回来,自动保存才会跳过它们。
                    post.gallery = post.gallery.map((image) => {
                        const local = image.previewId ? localById.get(image.previewId) : null;
                        return local ? keepLocal(image, local) : image;
                    });
                }
            }
        }

        const normalized = normalizeImportedPost({ ...post, importedAt: existing?.importedAt || new Date().toISOString() }, IMPORTED_CREATIONS.length);
        if (existing) {
            const index = IMPORTED_CREATIONS.findIndex((entry) => entry.id === post.id);
            IMPORTED_CREATIONS[index] = normalized;
        } else {
            IMPORTED_CREATIONS = [normalized, ...IMPORTED_CREATIONS];
        }
        persistImportedCreations();
        syncCreationPostToHost(normalized);
        updateImportedUi();
        rebuildCreations();
        currentId = normalized.id;
        currentPost = normalized;
        libraryImportOpen = false;
        renderFeed();
        navigate(`/creations/${encodeURIComponent(normalized.id)}`);
        if (mode === 'overwrite') showNotification(t('creations.reimportOverwrittenFiles'));
        else if (localFiles.count > 0) showNotification(t('creations.reimportKeptFiles'));
        else showNotification(t('creations.imported'));
        // 不 await:导入到这里就算完成,图片在后台存;详情页靠单文件进度条实时看到「远程 → 本地」。
        if (importOptions.autoSaveImages !== false) startImageAutoSave(normalized);
    } catch (error) {
        console.error('Failed to import Pawchive preview:', error);
        const corsBlocked =
            !isTauriRuntime() && !['localhost', '127.0.0.1'].includes(window.location.hostname);
        showNotification(t(corsBlocked ? 'creations.importUrlCors' : 'creations.importUrlFailed'));
    }
}

function loadImportedCreations() {    if (importedStorageLoaded) return;
    importedStorageLoaded = true;
    try {
        let stored = JSON.parse(localStorage.getItem(IMPORTED_STORAGE_KEY) || 'null');
        if (!Array.isArray(stored)) {
            // 从 v1 迁移:旧记录没有本地文件字段,按“仅远程链接”处理。
            stored = JSON.parse(localStorage.getItem(LEGACY_IMPORTED_STORAGE_KEY) || '[]');
            if (Array.isArray(stored) && stored.length > 0) {
                localStorage.setItem(IMPORTED_STORAGE_KEY, JSON.stringify(stored));
                localStorage.removeItem(LEGACY_IMPORTED_STORAGE_KEY);
            }
        }
        if (!Array.isArray(stored)) return;
        const seen = new Set();
        IMPORTED_CREATIONS = stored
            .filter((entry) => entry && typeof entry === 'object')
            .map(normalizeImportedPost)
            .filter((post) => {
                if (!post.id || seen.has(post.id)) return false;
                seen.add(post.id);
                return true;
            });
        if (IMPORTED_CREATIONS.length > 0) {
            const importedIds = new Set(IMPORTED_CREATIONS.map((post) => post.id));
            CREATIONS = [
                ...IMPORTED_CREATIONS,
                ...SAMPLE_CREATIONS.filter((post) => !importedIds.has(post.id)),
            ];
        }
    } catch (error) {
        console.error('Failed to load imported creations:', error);
    }
    updateImportedUi();
}

function persistImportedCreations() {
    try {
        if (IMPORTED_CREATIONS.length === 0) localStorage.removeItem(IMPORTED_STORAGE_KEY);
        else localStorage.setItem(IMPORTED_STORAGE_KEY, JSON.stringify(IMPORTED_CREATIONS));
    } catch (error) {
        console.error('Failed to persist imported creations:', error);
    }
}

function deleteCreationPostFromHost(postId) {
    const host = globalThis.__monochromeFileStorage?.creation;
    if (!host?.deletePost) return;
    void host.deletePost(postId).catch((error) => {
        console.warn('Failed to delete creation post from host:', error?.message || error);
    });
}

function syncCreationPostToHost(post) {
    const host = globalThis.__monochromeFileStorage?.creation;
    if (!host?.savePost || !post) return;
    void host.savePost(post).catch((error) => {
        console.warn('Failed to sync creation post to host:', error?.message || error);
    });
}

async function hydrateCreationPostsFromHost() {
    const host = globalThis.__monochromeFileStorage?.creation;
    if (!host?.listPosts) return;
    let hosted;
    try {
        hosted = await host.listPosts();
    } catch {
        return;
    }
    if (!Array.isArray(hosted) || hosted.length === 0) return;
    let changed = false;
    for (const hostedPost of hosted) {
        if (!hostedPost?.id) continue;
        // 正在自动保存图片的创作:本页内存里的状态比 host 快照新,而且替换对象会让后台任务
        // 失去它正在更新的那份 post。等任务结束时它自己会 syncCreationPostToHost。
        if (autoSaveJobs.has(hostedPost.id)) continue;
        const assets = Array.isArray(hostedPost.hostAssets) ? hostedPost.hostAssets : [];
        if (assets.length > 0) {
            hostedPost.attachments = (Array.isArray(hostedPost.attachments) ? hostedPost.attachments : []).map((attachment) => {
                const original = assets.find((asset) => asset.attachmentId === attachment.id && asset.role === 'original');
                const thumbnail = assets.find((asset) => asset.attachmentId === attachment.id && asset.role === 'thumbnail');
                if (!original) return attachment;
                return {
                    ...attachment,
                    status: 'local',
                    hostAssetId: original.assetId,
                    thumbnailHostAssetId: thumbnail?.assetId || '',
                    localKey: `host:${hostedPost.id}/${attachment.id}`,
                    bytes: original.bytes,
                    mime: original.mime || attachment.mime,
                };
            });
        }
        const normalized = normalizeImportedPost(hostedPost, IMPORTED_CREATIONS.length);
        const index = IMPORTED_CREATIONS.findIndex((entry) => entry.id === normalized.id);
        if (index >= 0) {
            IMPORTED_CREATIONS[index] = { ...IMPORTED_CREATIONS[index], ...normalized };
        } else {
            IMPORTED_CREATIONS.unshift(normalized);
        }
        changed = true;
    }
    if (!changed) return;
    persistImportedCreations();
    rebuildCreations();
    updateImportedUi();
    renderFeed();
}

function updateImportedUi() {
    const button = document.getElementById('creations-clear-imported');
    if (button) {
        button.hidden = false;
        button.disabled = IMPORTED_CREATIONS.length === 0;
    }
}

async function importCreationJsonText(text) {
    const data = JSON.parse(text);
    const posts = Array.isArray(data) ? data : data?.posts;
    if (!Array.isArray(posts) || posts.length === 0) throw new Error('no posts in JSON');
    const existingIds = new Set(CREATIONS.map((post) => post.id));
    const imported = posts.map((post, index) => normalizeImportedPost({ ...post, importedAt: new Date().toISOString() }, index)).filter((post) => !existingIds.has(post.id));
    if (imported.length === 0) {
        showNotification(t('creations.imported'));
        return;
    }
    IMPORTED_CREATIONS = [...imported, ...IMPORTED_CREATIONS];
    const importedIds = new Set(IMPORTED_CREATIONS.map((post) => post.id));
    CREATIONS = [...IMPORTED_CREATIONS, ...SAMPLE_CREATIONS.filter((post) => !importedIds.has(post.id))];
    persistImportedCreations();
    for (const post of imported) syncCreationPostToHost(post);
    updateImportedUi();
    activeTags = new Set();
    activeCreatorIds.clear();
    activeMedia.clear();
    libraryQuery = '';
    librarySource = 'all';
    librarySort = 'added';
    libraryImportOpen = false;
    renderFeed();
    showNotification(t('creations.imported'));
}

function showSaveResult(path) {
    const result = document.getElementById('creation-save-result');
    if (!result) return;
    result.querySelector('code').textContent = path;
    result.hidden = false;
    result.dataset.path = path;
}

function rebuildCreations() {
    const importedIds = new Set(IMPORTED_CREATIONS.map((post) => post.id));
    CREATIONS = [...IMPORTED_CREATIONS, ...SAMPLE_CREATIONS.filter((post) => !importedIds.has(post.id))];
}

function deleteImportedPost(postId) {
    const post = CREATIONS.find((entry) => entry.id === postId && entry.imported);
    if (!post) return;
    void (async () => {
        const mode = await chooseDeletionMode([postId], true);
        if (!mode) return;
        // 先停掉后台自动保存,免得删完之后还有一张图落盘成孤儿文件。
        await cancelImageAutoSave(postId);
        let removed = 0;
        if (mode === 'delete') {
            const summary = await localFileSummary(postId).catch(() => ({ count: 0 }));
            removed = summary.count;
            await deleteCreationFiles(postId);
        }
        IMPORTED_CREATIONS = IMPORTED_CREATIONS.filter((entry) => entry.id !== postId);
        persistImportedCreations();
        deleteCreationPostFromHost(postId);
        updateImportedUi();
        rebuildCreations();
        const wasCurrentPost = currentPost?.id === postId;
        currentPost = null;
        if (wasCurrentPost) currentId = null;
        renderFeed();
        if (wasCurrentPost) navigate('/creations');
        showNotification(
            removed > 0 ? t('creations.deletedWithFiles', { count: removed }) : t('creations.deleted'),
        );
    })();
}

export function initializeCreationsPage() {
    // Card metadata must be clickable on both the feed and the creator page.
    // Handle tags at the window capture phase: HMR can leave an old document
    // listener behind, and the window-phase handler both wins before card
    // navigation and prevents those stale handlers from toggling the tag twice.
    window.addEventListener('click', (event) => {
        if (event.__monochromeCreationMetaHandled) return;
        const tagButton = event.target.closest?.('[data-filter-tag]');
        // Voice cards also use [data-filter-tag]; only intercept creation tags.
        if (tagButton && tagButton.classList.contains('creation-tag')) {
            event.__monochromeCreationMetaHandled = true;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            toggleCreationTagFilter(tagButton.dataset.filterTag);
            return;
        }
        const mediaButton = event.target.closest?.('[data-filter-media].creation-badge-type');
        if (!mediaButton) return;
        event.__monochromeCreationMetaHandled = true;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        toggleCreationMediaFilter(mediaButton.dataset.filterMedia);
    }, true);
    document.addEventListener('click', (event) => {
        if (event.__monochromeCreationMetaHandled) return;
        const tagButton = event.target.closest?.('[data-filter-tag]');
        if (tagButton && tagButton.classList.contains('creation-tag')) {
            event.__monochromeCreationMetaHandled = true;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            toggleCreationTagFilter(tagButton.dataset.filterTag);
            return;
        }
        const mediaButton = event.target.closest?.('[data-filter-media].creation-badge-type');
        if (mediaButton) {
            event.__monochromeCreationMetaHandled = true;
            event.preventDefault();
            event.stopPropagation();
            toggleCreationMediaFilter(mediaButton.dataset.filterMedia);
            return;
        }
        const avatarButton = event.target.closest?.('.creation-card-author-avatar-btn[data-filter-creator-id]');
        if (avatarButton) {
            event.preventDefault();
            event.stopPropagation();
            filterCreationsByCreator(avatarButton.dataset.filterCreatorId);
        }
    }, true);
    const feed = document.getElementById('creations-feed');
    const detail = document.getElementById('creations-detail');
    if (!feed || !detail) return;

    importOptions = createImportOptions({
        storageKey: IMPORT_OPTIONS_KEY,
        container: '#creations-import-options',
        labelKey: 'creations.importOptions',
        items: [
            {
                id: 'autoSaveImages',
                elementId: 'creation-option-auto-save-images',
                labelKey: 'creations.autoSaveImagesOption',
                titleKey: 'creations.autoSaveImagesHint',
            },
            {
                id: 'overwriteLocalFiles',
                elementId: 'creation-option-overwrite-local',
                labelKey: 'creations.overwriteLocalFilesOption',
            },
        ],
        // 自动保存默认开(用户要求);旧的存储值里没有这个 key,createImportOptions 会保留默认值。
        defaults: { autoSaveImages: true, overwriteLocalFiles: false },
    }).values;
    loadImportedCreations();
    for (const delay of [0, 800, 2500]) setTimeout(() => void hydrateCreationPostsFromHost(), delay);

    libraryFilters = createCreationLibraryFilters({
        getPosts: () => CREATIONS,
        getCreators: creationCreators,
        getOptions: creationLibraryOptions,
        onChange: ({ creatorIds, tags, media }) => {
            activeCreatorIds = new Set(creatorIds);
            activeTags = new Set(tags);
            activeMedia = new Set(media);
            renderFeed();
        }
    });

    document.getElementById('creations-import-toggle')?.addEventListener('click', () => setCreationImportOpen(!libraryImportOpen, true));
    document.getElementById('creations-import-close')?.addEventListener('click', () => setCreationImportOpen(false, true));
    document.getElementById('creations-library-search')?.addEventListener('input', (event) => {
        libraryQuery = event.target.value;
        renderFeed();
    });
    for (const name of ['sort', 'source']) document.getElementById(`creations-library-${name}`)?.addEventListener('change', (event) => {
        if (name === 'sort') librarySort = event.target.value;
        else librarySource = event.target.value;
        renderFeed();
    });
    const library = feedView();
    const closeManagement = (focus = false) => {
        const manage = document.getElementById('creations-manage');
        if (!manage?.open) return;
        manage.open = false;
        if (focus) manage.querySelector('summary')?.focus();
    };
    library?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeManagement(true);
        // Native controls own Space/arrow keys; the document's player shortcuts do not.
        if (event.target.closest('button, input, select, summary, a')) event.stopPropagation();
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('#creations-manage')) closeManagement();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeManagement(true);
    });

    document.getElementById('creations-import')?.addEventListener('click', () => {
        void importLocalCreations();
    });
    document.getElementById('creations-import-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = document.getElementById('creations-import-url-input');
        const url = String(input?.value || '').trim();
        if (!url) {
            input?.focus();
            return;
        }
        void importPreviewFromUrl(url).finally(() => {
            if (input) input.value = '';
        });
    });
    window.addEventListener('resize', () => {
        if (libraryImportOpen) requestAnimationFrame(positionCreationImportTail);
    });
    document.getElementById('creations-cancel-selection')?.addEventListener('click', () => {
        clearImportedSelection();
    });
    document.getElementById('creations-select-all')?.addEventListener('click', () => {
        toggleSelectAllImported();
    });
    document.getElementById('creations-delete-selected')?.addEventListener('click', () => {
        deleteSelectedImported();
    });
    document.getElementById('creations-clear-imported')?.addEventListener('click', () => {
        closeManagement();
        const ids = IMPORTED_CREATIONS.map((post) => post.id);
        if (ids.length === 0) return;
        void (async () => {
            const mode = await chooseDeletionMode(ids);
            if (!mode) return;
            for (const id of ids) await cancelImageAutoSave(id);
            const removed = mode === 'delete' ? await deleteLocalFilesFor(ids) : 0;
            IMPORTED_CREATIONS = [];
            selectedImportedIds.clear();
            try {
                localStorage.removeItem(IMPORTED_STORAGE_KEY);
                localStorage.removeItem(LEGACY_IMPORTED_STORAGE_KEY);
            } catch (error) {
                console.error('Failed to clear imported creations:', error);
            }
            CREATIONS = [...SAMPLE_CREATIONS];
            updateImportedUi();
            activeTags = new Set();
            activeCreatorIds.clear();
            activeMedia.clear();
            libraryQuery = '';
            librarySource = 'all';
            librarySort = 'date';
            renderFeed();
            showNotification(
                removed > 0 ? t('creations.deletedWithFiles', { count: removed }) : t('creations.deleted'),
            );
        })();
    });

    // Tauri 下把附件下载改成原生「另存为」;普通浏览器保持原下载。
    document.getElementById('page-creations')?.addEventListener(
        'click',
        (event) => {
            if (!isTauriRuntime()) return;
            const link = event.target.closest('a[download]');
            if (!link) return;
            event.preventDefault();
            void saveCreationAttachment({ url: link.href, name: link.download })
                .then((path) => {
                    if (path) showSaveResult(path);
                })
                .catch((error) => {
                    console.error('Failed to save attachment through Tauri:', error);
                    showNotification(t('creations.saveFailed'));
                });
        },
        true,
    );

    const page = document.getElementById('page-creations');
    const dropHint = document.getElementById('creations-drop-hint');
    const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    let dragDepth = 0;
    const hideDropHint = () => {
        dragDepth = 0;
        if (dropHint) dropHint.hidden = true;
    };
    page?.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth += 1;
        if (dropHint) dropHint.hidden = false;
    });
    page?.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    page?.addEventListener('dragleave', (event) => {
        if (!hasFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0 && dropHint) dropHint.hidden = true;
    });
    page?.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        hideDropHint();
        const file = Array.from(event.dataTransfer?.files ?? []).find((entry) =>
            entry.name.toLowerCase().endsWith('.json'),
        );
        if (!file) {
            showNotification(t('creations.importFailed'));
            return;
        }
        file.text()
            .then(importCreationJsonText)
            .catch((error) => {
                console.error('Failed to import dropped creation:', error);
                showNotification(t('creations.importFailed'));
            });
    });

    document.getElementById('creation-save-reveal')?.addEventListener('click', () => {
        const result = document.getElementById('creation-save-result');
        if (result?.dataset.path) void revealCreationFile(result.dataset.path);
    });
    document.getElementById('creation-save-dismiss')?.addEventListener('click', () => {
        const result = document.getElementById('creation-save-result');
        if (result) result.hidden = true;
    });

    feed.addEventListener('click', (event) => {
        if (event.__monochromeCreationMetaHandled) return;
        const tagButton = event.target.closest('[data-filter-tag]');
        if (tagButton && tagButton.classList.contains('creation-tag')) {
            event.__monochromeCreationMetaHandled = true;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            toggleCreationTagFilter(tagButton.dataset.filterTag);
            return;
        }
        const mediaButton = event.target.closest('[data-filter-media].creation-badge-type');
        if (mediaButton) {
            event.__monochromeCreationMetaHandled = true;
            event.preventDefault();
            event.stopPropagation();
            toggleCreationMediaFilter(mediaButton.dataset.filterMedia);
            return;
        }
        const profileAvatar = event.target.closest('[data-creator-profile-id]');
        if (profileAvatar) {
            event.preventDefault();
            event.stopPropagation();
            openCreator(profileAvatar.dataset.creatorProfileId);
            return;
        }
        const filterAvatar = event.target.closest('[data-filter-creator-id]');
        if (filterAvatar) {
            event.preventDefault();
            event.stopPropagation();
            filterCreationsByCreator(filterAvatar.dataset.filterCreatorId);
            return;
        }
        const selectButton = event.target.closest('[data-select-post-id]');
        if (selectButton) {
            event.preventDefault();
            event.stopPropagation();
            toggleImportedSelection(selectButton.dataset.selectPostId);
            return;
        }
        if (selectedImportedIds.size > 0) {
            const selectingCard = event.target.closest('.creation-card');
            if (selectingCard) {
                event.preventDefault();
                if (selectingCard.querySelector('[data-select-post-id]')) {
                    toggleImportedSelection(selectingCard.dataset.id);
                }
            }
            return;
        }
        const deleteButton = event.target.closest('[data-delete-post-id]');
        if (deleteButton) {
            event.preventDefault();
            event.stopPropagation();
            deleteImportedPost(deleteButton.dataset.deletePostId);
            return;
        }
        const creator = event.target.closest('.creation-creator-link');
        if (creator) {
            event.preventDefault();
            navigate(creator.getAttribute('href'));
            return;
        }
        const card = event.target.closest('.creation-card');
        if (!card) return;
        navigate(`/creations/${encodeURIComponent(card.dataset.id)}`);
    });
    feed.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const focusedCard = event.target.closest('.creation-card');
        if (!focusedCard || event.target !== focusedCard) return;
        event.stopPropagation();
        if (selectedImportedIds.size > 0) {
            const selectingCard = event.target.closest('.creation-card');
            if (selectingCard) {
                event.preventDefault();
                if (selectingCard.querySelector('[data-select-post-id]')) {
                    toggleImportedSelection(selectingCard.dataset.id);
                }
            }
            return;
        }
        const deleteButton = event.target.closest('[data-delete-post-id]');
        if (deleteButton) {
            event.preventDefault();
            deleteImportedPost(deleteButton.dataset.deletePostId);
            return;
        }
        const card = event.target.closest('.creation-card');
        if (!card) return;
        event.preventDefault();
        navigate(`/creations/${encodeURIComponent(card.dataset.id)}`);
    });
    document.addEventListener('monochrome:search-opened', (event) => {
        renderSearchCreations(event.detail?.query);
    });
    document.getElementById('search-local-creations')?.addEventListener('click', (event) => {
        const creator = event.target.closest('[data-creator-id]');
        if (creator) {
            openCreator(creator.dataset.creatorId);
            return;
        }
        const post = event.target.closest('[data-post-id]');
        if (post) navigate(`/creations/${encodeURIComponent(post.dataset.postId)}`);
    });

    // 详情内的图片点击放大、音频整行点击播放(不是只有小按钮能点)。
    detail.addEventListener('click', (event) => {
        const profileAvatar = event.target.closest('[data-creator-profile-id]');
        if (profileAvatar) {
            event.preventDefault();
            event.stopPropagation();
            openCreator(profileAvatar.dataset.creatorProfileId);
            return;
        }
        const filterAvatar = event.target.closest('[data-filter-creator-id]');
        if (filterAvatar) {
            event.preventDefault();
            event.stopPropagation();
            filterCreationsByCreator(filterAvatar.dataset.filterCreatorId);
            return;
        }
        const deleteButton = event.target.closest('[data-delete-post-id]');
        if (deleteButton) {
            event.preventDefault();
            event.stopPropagation();
            deleteImportedPost(deleteButton.dataset.deletePostId);
            return;
        }
        const creator = event.target.closest('.creation-creator-link');
        if (creator) {
            event.preventDefault();
            navigate(creator.getAttribute('href'));
            return;
        }
        const image = event.target.closest('img[data-zoom]');
        if (image) {
            openCreationImage(image);
            return;
        }
        const videoButton = event.target.closest('[data-play-video-index]');
        if (videoButton && currentPost) {
            const attachment = videoAttachments(currentPost)[Number(videoButton.dataset.playVideoIndex)];
            if (attachment) void playCreationVideo(currentPost, attachment);
            return;
        }
        const attachmentCheck = event.target.closest('[data-attachment-check]');
        if (attachmentCheck && currentPost) {
            event.preventDefault();
            event.stopPropagation();
            const id = attachmentCheck.dataset.attachmentCheck;
            if (selectedAttachmentIds.has(id)) selectedAttachmentIds.delete(id);
            else selectedAttachmentIds.add(id);
            updateAttachmentToolbar(currentPost);
            return;
        }
        if (event.target.closest('.creation-attachment-link')) return;
        const queueAudioButton = event.target.closest('[data-audio-queue-index]');
        if (queueAudioButton && currentPost) {
            event.preventDefault();
            event.stopPropagation();
            const attachment = audioAttachments(currentPost)[Number(queueAudioButton.dataset.audioQueueIndex)];
            if (attachment) void queueCreationAudio(currentPost, attachment);
            return;
        }
        const row = event.target.closest('[data-creation-file-index]');
        if (!row || !detailSession) return;
        const trigger = event.target.closest('button, a, input, select, video, summary');
        if (trigger && !trigger.matches('[data-creation-file-open], [data-creation-thumb], [data-play-index]')) return;
        void openCreationFile(detailSession, detailSession.rows[Number(row.dataset.creationFileIndex)], row);
    });
    detail.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('img[data-zoom]')) {
            event.preventDefault();
            openCreationImage(event.target);
        }
    });

    document.addEventListener('monochrome:creations-open', (event) => {
        openCreations(event.detail?.id ?? null);
    });
    document.addEventListener('monochrome:track-changed', (event) => {
        updateCreationDescription(event.detail?.track);
    });
    window.addEventListener('side-panel-changed', (event) => {
        const button = document.getElementById('now-playing-description-btn');
        if (!button) return;
        const active =
            event.detail?.active === true && event.detail?.view === 'creation-description';
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('now-playing-description-btn')?.addEventListener('click', () => {
        const track = Player.instance.currentTrack;
        const post = track?.creationPostId
            ? CREATIONS.find((entry) => entry.id === track.creationPostId)
            : null;
        if (post) openCreationDescriptionPanel(post, track, true);
    });
    document.addEventListener('monochrome:language-changed', () => {
        if (activeCreatorPage && document.getElementById('page-artist')?.classList.contains('creation-creator-page')) {
            const { reference, ui } = activeCreatorPage;
            void ui.renderArtistPage(reference, 'creations');
            return;
        }
        if (!document.getElementById('page-creations')?.classList.contains('active')) return;
        openCreations(currentId);
        if (sidePanelManager.currentView === 'creation-description') {
            const track = Player.instance.currentTrack;
            const post = track?.creationPostId
                ? CREATIONS.find((entry) => entry.id === track.creationPostId)
                : null;
            if (post) openCreationDescriptionPanel(post, track);
        }
    });

    // 直接以 /creations/:id 打开时 router 会派发事件;这里兜底处理 HMR。
    if (document.getElementById('page-creations')?.classList.contains('active')) {
        const parts = window.location.pathname.split('/').filter(Boolean);
        window.setTimeout(() => {
            openCreations(parts[1] ? decodeURIComponent(parts[1]) : null);
        }, 200);
    }
}
