// 「视频」页:YouTube 元数据与嵌入播放。
//
// 只保存元数据;不下载视频。播放使用 YouTube 官方 embed,频道/原视频链接保留。
import { t } from './i18n.js';
import { navigate } from './router.js';
import { showNotification } from './downloads.js';
import { fetchYoutubeMetadata } from './tauri-bridge.js';
import { createImportOptions } from './import-options.js';
import { setUiState } from './ui-state.js';

const VIDEOS_STORAGE_KEY = 'monochrome-youtube-imported-v1';
const VIDEOS_OPTIONS_KEY = 'monochrome-youtube-import-options-v1';
let videos = [];
let importOptions = null;
const selectedIds = new Set();
const activeUploaders = new Set();
const activeVideoTags = new Set();
let visibleVideos = [];
let videoFilterPanelOpen = false;
let videoSearchQuery = '';
let videoSort = 'added';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function loadVideos() {
    try {
        const stored = JSON.parse(localStorage.getItem(VIDEOS_STORAGE_KEY) || '[]');
        videos = Array.isArray(stored) ? stored.filter((video) => video && video.videoId) : [];
    } catch (error) {
        console.error('Failed to load YouTube videos:', error);
        videos = [];
    }
}

function persistVideos() {
    try {
        localStorage.setItem(VIDEOS_STORAGE_KEY, JSON.stringify(videos));
    } catch (error) {
        console.error('Failed to persist YouTube videos:', error);
    }
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function setVideosImportPanelOpen(open) {
    const panel = document.getElementById('videos-import-panel');
    const toggle = document.getElementById('videos-import-toggle');
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) document.getElementById('videos-import-input')?.focus({ preventScroll: true });
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    return date.toISOString().slice(0, 10);
}

function formatViews(value) {
    const count = Number(value) || 0;
    if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`;
    if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
    return String(count);
}

function videoTagChipsHtml(video, limit = Infinity) {
    const chips = [];
    if (video.channel) {
        chips.push(
            `<button type="button" class="video-tag video-tag-chip video-tag-chip--uploader${activeUploaders.has(video.channel) ? ' is-active' : ''}" data-filter-uploader="${escapeHtml(video.channel)}" title="${escapeHtml(t('videos.filter.uploader'))}">${escapeHtml(video.channel)}</button>`,
        );
    }
    for (const tag of (video.tags || []).slice(0, limit)) {
        chips.push(
            `<button type="button" class="video-tag video-tag-chip video-tag-chip--tag${activeVideoTags.has(tag) ? ' is-active' : ''}" data-filter-video-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`,
        );
    }
    return chips.join('');
}
function videoCardHtml(video) {
    const selected = selectedIds.has(video.videoId);
    return `
        <article class="video-card video-library-card video-card--selectable${selected ? ' video-card--selected' : ''}" data-video-id="${escapeHtml(video.videoId)}" data-uploader="${escapeHtml(video.channel)}" tabindex="0" role="button">
            <div class="video-card-thumb">
                <button type="button" class="creation-select-check video-select-check" data-select-video-id="${escapeHtml(
                    video.videoId,
                )}" aria-pressed="${selected}" title="${escapeHtml(t('selection.deleteSelected'))}"
                    aria-label="${escapeHtml(t('selection.deleteSelected'))}">
                    <span aria-hidden="true">${selected ? '✓' : ''}</span>
                </button>
                <img src="${escapeHtml(video.thumbnail)}" alt="" referrerpolicy="no-referrer" loading="lazy" />
                <span class="video-card-play" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </span>
                <span class="video-card-source">YouTube</span>
                <span class="video-duration">${escapeHtml(formatDuration(video.duration))}</span>
            </div>
            <div class="video-card-body">
                <div class="video-card-channel">
                    <img src="${escapeHtml(video.channelAvatar)}" alt="" referrerpolicy="no-referrer" loading="lazy" />
                    <span>${escapeHtml(video.channel)}</span>
                </div>
                <h2 class="video-card-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h2>
                <div class="video-card-meta">
                    <span>${escapeHtml(formatViews(video.viewCount))} ${escapeHtml(t('videos.views'))}</span>
                    <span>${escapeHtml(formatDate(video.publishDate))}</span>
                </div>
                <div class="video-card-tags">${videoTagChipsHtml(video, 5)}</div>
            </div>
        </article>`;
}

function matchesVideoFilters(video) {
    const uploaderOk = activeUploaders.size === 0 || activeUploaders.has(video.channel);
    const tagOk = activeVideoTags.size === 0 || (video.tags || []).some((tag) => activeVideoTags.has(tag));
    const query = videoSearchQuery.trim().toLowerCase();
    const queryOk =
        !query ||
        [video.title, video.channel, ...(video.tags || [])]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query));
    return uploaderOk && tagOk && queryOk;
}

function sortVideos(list) {
    const result = [...list];
    if (videoSort === 'published') {
        result.sort(
            (a, b) => (Date.parse(b.publishDate || b.importedAt || 0) || 0) - (Date.parse(a.publishDate || a.importedAt || 0) || 0),
        );
    } else if (videoSort === 'title') {
        result.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    }
    return result;
}

function renderVideoFilterBar() {
    const bar = document.getElementById('videos-filter-bar');
    const groups = document.getElementById('videos-filter-groups');
    if (!bar || !groups) return;
    const hasFilters = activeUploaders.size > 0 || activeVideoTags.size > 0;
    bar.hidden = !hasFilters;
    if (!hasFilters) {
        groups.innerHTML = '';
        return;
    }
    const uploaderChips = [...activeUploaders]
        .map(
            (name) => `<button type="button" class="voices-filter-chip voices-filter-chip--artist" data-remove-uploader="${escapeHtml(name)}">${escapeHtml(name)} <span aria-hidden="true">×</span></button>`,
        )
        .join('');
    const tagChips = [...activeVideoTags]
        .map(
            (tag) => `<button type="button" class="voices-filter-chip voices-filter-chip--tag" data-remove-video-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span aria-hidden="true">×</span></button>`,
        )
        .join('');
    groups.innerHTML = `
        ${uploaderChips ? `<div class="voices-filter-group"><span class="voices-filter-label">${escapeHtml(t('videos.filter.uploader'))}</span>${uploaderChips}</div>` : ''}
        ${tagChips ? `<div class="voices-filter-group"><span class="voices-filter-label">${escapeHtml(t('videos.filter.tag'))}</span>${tagChips}</div>` : ''}
    `;
}

function toggleVideoFilter(kind, value) {
    if (!value) return;
    const set = kind === 'uploader' ? activeUploaders : activeVideoTags;
    if (set.has(value)) set.delete(value);
    else set.add(value);
    if (document.getElementById('videos-detail-view')?.hidden === false) navigate(`/videos${videoFilterQuery()}`);
    else {
        writeVideoFiltersToUrl();
        renderList();
    }
}

function handleVideoTagClick(event) {
    const uploader = event.target.closest('[data-filter-uploader]');
    if (uploader) {
        event.preventDefault();
        event.stopPropagation();
        toggleVideoFilter('uploader', uploader.dataset.filterUploader);
        return true;
    }
    const tag = event.target.closest('[data-filter-video-tag]');
    if (tag) {
        event.preventDefault();
        event.stopPropagation();
        toggleVideoFilter('tag', tag.dataset.filterVideoTag);
        return true;
    }
    return false;
}
function positionVideoFilterPanel() {
    if (!videoFilterPanelOpen) return;
    const panel = document.getElementById('videos-filter-panel');
    const toggle = document.getElementById('videos-filter-toggle');
    if (!panel || !toggle) return;
    const rect = toggle.getBoundingClientRect();
    const margin = 16;
    const width = Math.min(620, window.innerWidth - margin * 2);
    const top = Math.max(margin, Math.min(rect.bottom + 8, window.innerHeight - 240));
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(180, window.innerHeight - top - margin)}px`;
}

function renderVideoFilterPanel() {
    const panel = document.getElementById('videos-filter-panel');
    const groups = document.getElementById('videos-filter-panel-groups');
    const toggle = document.getElementById('videos-filter-toggle');
    const countEl = document.getElementById('videos-filter-count');
    if (!panel || !groups || !toggle || !countEl) return;
    const activeCount = activeUploaders.size + activeVideoTags.size;
    countEl.textContent = String(activeCount);
    countEl.hidden = activeCount === 0;
    toggle.classList.toggle('is-active', activeCount > 0);
    toggle.setAttribute('aria-expanded', String(videoFilterPanelOpen));
    toggle.disabled = videos.length === 0;
    panel.hidden = !videoFilterPanelOpen || videos.length === 0;
    if (panel.hidden) return;
    const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ja'));
    const option = (kind, value, active, count) =>
        `<button type="button" class="creation-filter-option voice-filter-option" data-kind="${kind}" data-value="${escapeHtml(value)}" data-filter-${kind === 'uploader' ? 'uploader' : 'video-tag'}="${escapeHtml(value)}" aria-pressed="${active}"><span>${escapeHtml(value)}</span><em>${count}</em></button>`;
    const groupsHtml = [];
    const uploaders = unique(videos.map((video) => video.channel));
    if (uploaders.length) {
        groupsHtml.push(
            `<fieldset class="creation-filter-group"><legend>${escapeHtml(t('videos.filter.uploader'))}</legend><div class="creation-filter-options">${uploaders
                .map((value) => option('uploader', value, activeUploaders.has(value), videos.filter((video) => video.channel === value).length))
                .join('')}</div></fieldset>`,
        );
    }
    const tags = unique(videos.flatMap((video) => video.tags || []));
    if (tags.length) {
        groupsHtml.push(
            `<fieldset class="creation-filter-group"><legend>${escapeHtml(t('videos.filter.tag'))}</legend><div class="creation-filter-options">${tags
                .map((value) => option('tag', value, activeVideoTags.has(value), videos.filter((video) => (video.tags || []).includes(value)).length))
                .join('')}</div></fieldset>`,
        );
    }
    groups.innerHTML = groupsHtml.length ? groupsHtml.join('') : `<p class="voices-filter-panel-empty">${escapeHtml(t('videos.filter.empty'))}</p>`;
    const summary = document.getElementById('videos-filter-summary');
    if (summary) summary.textContent = t('videos.filter.summary', { count: visibleVideos.length });
    const clear = document.getElementById('videos-filter-panel-clear');
    if (clear) clear.hidden = activeCount === 0;
    positionVideoFilterPanel();
}
function renderList() {
    const list = document.getElementById('videos-list-view');
    const detail = document.getElementById('videos-detail-view');
    if (!list || !detail) return;
    list.hidden = false;
    detail.hidden = true;
    const grid = document.getElementById('videos-grid');
    const empty = document.getElementById('videos-empty');
    if (!grid || !empty) return;
    visibleVideos = sortVideos(videos.filter(matchesVideoFilters));
    grid.innerHTML = visibleVideos.map(videoCardHtml).join('');
    empty.hidden = visibleVideos.length > 0;
    const totalEl = document.getElementById('videos-library-total');
    if (totalEl) totalEl.textContent = t('videos.libraryTotal', { count: videos.length });
    const channels = new Set(videos.map((video) => video.channel).filter(Boolean)).size;
    const statusEl = document.getElementById('videos-library-status');
    if (statusEl) {
        statusEl.textContent = t('videos.status', {
            visible: visibleVideos.length,
            total: videos.length,
            channels,
        });
    }
    const searchEl = document.getElementById('videos-library-search');
    if (searchEl && searchEl.value !== videoSearchQuery) searchEl.value = videoSearchQuery;
    const sortEl = document.getElementById('videos-library-sort');
    if (sortEl && sortEl.value !== videoSort) sortEl.value = videoSort;
    renderVideoFilterBar();
    renderVideoFilterPanel();
    updateSelectionUi();
}

function updateSelectionUi() {
    const bar = document.getElementById('videos-selection-bar');
    const count = document.getElementById('videos-selected-count');
    const selectAll = document.getElementById('videos-select-all');
    const deleteButton = document.getElementById('videos-delete-selected');
    const clearAll = document.getElementById('videos-clear-all');
    const grid = document.getElementById('videos-grid');
    const hasSelection = selectedIds.size > 0;
    if (bar) bar.hidden = !hasSelection;
    if (clearAll) clearAll.hidden = videos.length === 0 || hasSelection;
    if (grid) grid.classList.toggle('is-selecting', hasSelection);
    if (count) count.textContent = t('selection.selectedCount', { count: selectedIds.size });
    if (selectAll) {
        const allSelected = visibleVideos.length > 0 && visibleVideos.every((video) => selectedIds.has(video.videoId));
        selectAll.textContent = allSelected ? t('selection.unselectAll') : t('selection.selectAll');
        selectAll.disabled = visibleVideos.length === 0;
    }
    if (deleteButton) deleteButton.disabled = selectedIds.size === 0;
}

function toggleVideoSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    renderList();
}

function toggleSelectAllVideos() {
    if (visibleVideos.length > 0 && visibleVideos.every((video) => selectedIds.has(video.videoId))) {
        selectedIds.clear();
    } else {
        visibleVideos.forEach((video) => selectedIds.add(video.videoId));
    }
    renderList();
}

function clearVideoSelection() {
    selectedIds.clear();
    renderList();
}

function deleteVideos(ids, singleTitle = '') {
    if (ids.length === 0) return;
    const message =
        ids.length === 1 && singleTitle
            ? t('selection.deleteSingleConfirm', { title: singleTitle })
            : t('selection.deleteSelectedConfirm', { count: ids.length });
    if (!window.confirm(message)) return;
    const idSet = new Set(ids);
    videos = videos.filter((video) => !idSet.has(video.videoId));
    for (const id of ids) selectedIds.delete(id);
    persistVideos();
    if (document.getElementById('videos-detail-view')?.hidden === false) navigate('/videos');
    else renderList();
    showNotification(t('selection.deleted'));
}

function deleteSelectedVideos() {
    deleteVideos([...selectedIds]);
}

function clearAllVideos() {
    if (videos.length === 0) return;
    if (!window.confirm(t('selection.deleteAllConfirm', { count: videos.length }))) return;
    videos = [];
    selectedIds.clear();
    persistVideos();
    renderList();
    showNotification(t('selection.deleted'));
}

function renderDetail(video) {
    const list = document.getElementById('videos-list-view');
    const detailView = document.getElementById('videos-detail-view');
    const detail = document.getElementById('videos-detail');
    if (!list || !detailView || !detail) return;
    list.hidden = true;
    detailView.hidden = false;
    const tags = videoTagChipsHtml(video, 18);
    detail.innerHTML = `
        <header class="video-hero">
            <div class="video-cover-wrap">
                <img class="video-cover" src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" referrerpolicy="no-referrer" />
                <button type="button" class="video-cover-play" aria-label="${escapeHtml(t('videos.play'))}">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                        <path d="M6 3l14 9-14 9V3z" />
                    </svg>
                </button>
            </div>
            <div class="video-hero-info">
                <div class="video-channel">
                    <img src="${escapeHtml(video.channelAvatar)}" alt="" referrerpolicy="no-referrer" />
                    <div>
                        <strong>${escapeHtml(video.channel)}</strong>
                        <span>${escapeHtml(formatViews(video.viewCount))} ${escapeHtml(t('videos.views'))}</span>
                    </div>
                </div>
                <h1>${escapeHtml(video.title)}</h1>
                <div class="video-stats">
                    <span>${escapeHtml(formatDuration(video.duration))}</span>
                    <span>${escapeHtml(formatDate(video.publishDate))}</span>
                    <span>${escapeHtml(video.videoId)}</span>
                </div>
                <div class="video-hero-tags">${tags}</div>
                <div class="video-hero-actions">
                    <a class="btn btn-secondary" href="${escapeHtml(video.sourceUrl)}" target="_blank" rel="noreferrer">
                        ${escapeHtml(t('videos.openOriginal'))}
                    </a>
                    ${
                        video.channelUrl
                            ? `<a class="btn btn-secondary" href="${escapeHtml(video.channelUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t('videos.openChannel'))}</a>`
                            : ''
                    }
                    <button type="button" class="btn btn-secondary" id="video-delete">${escapeHtml(
                        t('selection.delete'),
                    )}</button>
                </div>
            </div>
        </header>
        <section class="video-player-section">
            <div class="video-embed" data-video-embed="${escapeHtml(video.embedUrl)}">
                <button type="button" class="video-embed-poster" aria-label="${escapeHtml(t('videos.play'))}">
                    <img src="${escapeHtml(video.thumbnail)}" alt="" referrerpolicy="no-referrer" />
                    <span class="video-embed-play" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                            <path d="M6 3l14 9-14 9V3z" />
                        </svg>
                    </span>
                </button>
            </div>
        </section>
        <section class="video-description">
            <h2>${escapeHtml(t('videos.description'))}</h2>
            <p>${escapeHtml(video.description || t('videos.noDescription'))}</p>
        </section>`;
    detail.querySelector('.video-embed-poster')?.addEventListener('click', () => {
        const container = detail.querySelector('.video-embed');
        if (!container) return;
        const iframe = document.createElement('iframe');
        iframe.src = container.dataset.videoEmbed || video.embedUrl;
        iframe.title = video.title;
        iframe.loading = 'lazy';
        iframe.allow =
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        container.replaceChildren(iframe);
    });
    detail.querySelector('.video-cover-play')?.addEventListener('click', () => {
        const section = detail.querySelector('.video-player-section');
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        detail.querySelector('.video-embed-poster')?.click();
    });
    detail.querySelector('#video-delete')?.addEventListener('click', () => {
        deleteVideos([video.videoId], video.title);
    });
}

function readVideoFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    for (const [set, key] of [[activeUploaders, 'uploader'], [activeVideoTags, 'tag']]) {
        set.clear();
        for (const value of params.getAll(key)) set.add(value);
    }
    videoSearchQuery = params.get('q') || '';
    videoSort = ['added', 'published', 'title'].includes(params.get('sort')) ? params.get('sort') : 'added';
}

function videoFilterQuery() {
    const params = new URLSearchParams();
    for (const [set, key] of [[activeUploaders, 'uploader'], [activeVideoTags, 'tag']]) {
        for (const value of set) params.append(key, value);
    }
    if (videoSearchQuery.trim()) params.set('q', videoSearchQuery.trim());
    if (videoSort !== 'added') params.set('sort', videoSort);
    const query = params.toString();
    return query ? `?${query}` : '';
}

function writeVideoFiltersToUrl() {
    const params = new URLSearchParams(window.location.search);
    for (const key of ['uploader', 'tag', 'q', 'sort']) params.delete(key);
    for (const [key, value] of new URLSearchParams(videoFilterQuery())) params.append(key, value);
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
}
function openVideos(id) {
    loadVideos();
    if (!id) {
        readVideoFiltersFromUrl();
        renderList();
        return;
    }
    const decoded = decodeURIComponent(id);
    const video = videos.find((entry) => entry.videoId === decoded);
    if (!video) {
        renderList();
        return;
    }
    renderDetail(video);
}

async function importVideo() {
    const input = document.getElementById('videos-import-input');
    const button = document.getElementById('videos-import-button');
    const status = document.getElementById('videos-import-status');
    const value = input?.value?.trim() ?? '';
    if (!value) return;
    if (button) button.disabled = true;
    setUiState(status, 'loading', t('videos.importing'));
    try {
        const video = await fetchYoutubeMetadata(value);
        video.importedAt = new Date().toISOString();
        const existing = videos.findIndex((entry) => entry.videoId === video.videoId);
        if (existing >= 0 && importOptions && !importOptions.get('overwriteExisting')) {
            setUiState(status, 'success', t('importOptions.keptExisting'));
            return;
        }
        if (existing >= 0) videos[existing] = video;
        else videos = [video, ...videos];
        selectedIds.clear();
        persistVideos();
        if (input) input.value = '';
        setUiState(status, 'success', t('videos.imported'));
        setVideosImportPanelOpen(false);
        navigate(`/videos/${encodeURIComponent(video.videoId)}`);
    } catch (error) {
        console.error('Failed to import YouTube video:', error);
        setUiState(status, 'error', `${t('videos.importFailed')}: ${error?.message ?? error}`);
    } finally {
        if (button) button.disabled = false;
    }
}

export function initializeVideosPage() {
    if (!document.getElementById('page-videos')) return;
    const filterPanel = document.getElementById('videos-filter-panel');
    if (filterPanel && filterPanel.parentElement !== document.body) document.body.append(filterPanel);
    loadVideos();
    renderList();
    importOptions = createImportOptions({
        storageKey: VIDEOS_OPTIONS_KEY,
        container: '#videos-import-options',
        labelKey: 'importOptions.label',
        items: [
            {
                id: 'overwriteExisting',
                elementId: 'video-option-overwrite-existing',
                labelKey: 'importOptions.overwriteExisting',
            },
        ],
        defaults: { overwriteExisting: true },
        noteKey: 'importOptions.metadataOnly',
    });
    document.getElementById('videos-import-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        void importVideo();
    });
    document.getElementById('videos-import-toggle')?.addEventListener('click', () => {
        setVideosImportPanelOpen(document.getElementById('videos-import-panel')?.hidden !== false);
    });
    document.getElementById('videos-import-close')?.addEventListener('click', () => setVideosImportPanelOpen(false));
    document.getElementById('videos-grid')?.addEventListener('click', (event) => {
        const select = event.target.closest('[data-select-video-id]');
        if (select) {
            event.preventDefault();
            event.stopPropagation();
            toggleVideoSelection(select.dataset.selectVideoId);
            return;
        }
        if (handleVideoTagClick(event)) return;
        const card = event.target.closest('[data-video-id]');
        if (card) navigate(`/videos/${encodeURIComponent(card.dataset.videoId)}`);
    });
    document.getElementById('videos-detail')?.addEventListener('click', (event) => {
        handleVideoTagClick(event);
    });
    document.getElementById('videos-filter-groups')?.addEventListener('click', (event) => {
        const uploader = event.target.closest('[data-remove-uploader]');
        const tag = event.target.closest('[data-remove-video-tag]');
        if (uploader) toggleVideoFilter('uploader', uploader.dataset.removeUploader);
        else if (tag) toggleVideoFilter('tag', tag.dataset.removeVideoTag);
    });
    document.getElementById('videos-clear-filters')?.addEventListener('click', () => {
        activeUploaders.clear();
        activeVideoTags.clear();
        writeVideoFiltersToUrl();
        renderList();
    });
    document.getElementById('videos-library-search')?.addEventListener('input', (event) => {
        videoSearchQuery = event.target.value || '';
        writeVideoFiltersToUrl();
        renderList();
    });
    document.getElementById('videos-library-sort')?.addEventListener('change', (event) => {
        videoSort = ['added', 'published', 'title'].includes(event.target.value) ? event.target.value : 'added';
        writeVideoFiltersToUrl();
        renderList();
    });
    document.getElementById('videos-filter-toggle')?.addEventListener('click', () => {
        videoFilterPanelOpen = !videoFilterPanelOpen;
        renderVideoFilterPanel();
    });
    document.getElementById('videos-filter-close')?.addEventListener('click', () => {
        videoFilterPanelOpen = false;
        renderVideoFilterPanel();
        document.getElementById('videos-filter-toggle')?.focus();
    });
    document.addEventListener('click', (event) => {
        if (!videoFilterPanelOpen) return;
        const panel = document.getElementById('videos-filter-panel');
        const toggle = document.getElementById('videos-filter-toggle');
        if (panel?.contains(event.target) || toggle?.contains(event.target)) return;
        videoFilterPanelOpen = false;
        renderVideoFilterPanel();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !videoFilterPanelOpen) return;
        event.stopPropagation();
        videoFilterPanelOpen = false;
        renderVideoFilterPanel();
        document.getElementById('videos-filter-toggle')?.focus();
    });
    window.addEventListener('resize', positionVideoFilterPanel);
    document.getElementById('videos-filter-panel')?.addEventListener('click', (event) => {
        if (event.target.closest('#videos-filter-panel-clear')) {
            activeUploaders.clear();
            activeVideoTags.clear();
            writeVideoFiltersToUrl();
            renderList();
            return;
        }
        handleVideoTagClick(event);
    });
    document.getElementById('videos-select-all')?.addEventListener('click', () => {
        toggleSelectAllVideos();
    });
    document.getElementById('videos-delete-selected')?.addEventListener('click', () => {
        deleteSelectedVideos();
    });
    document.getElementById('videos-cancel-selection')?.addEventListener('click', () => {
        clearVideoSelection();
    });
    document.getElementById('videos-clear-all')?.addEventListener('click', () => {
        clearAllVideos();
    });
    document.addEventListener('monochrome:videos-open', (event) => {
        openVideos(event.detail?.id ?? null);
    });
}
