// 「回收站」页:列出已删除、尚未彻底清除的作品。
//
// 删除在本项目里是「移动到 <data>/trash/<work id>/」而不是 unlink,所以列表里的每一项都还能
// 原样搬回源根。页面只做三件事:看清楚、恢复、彻底删除——不对作品内容做任何加工,也不读源根。
//
// 数据全部来自 `/api/trash`。这里刻意不 import file-storage.js:它 import voices.js,而
// voices.js 会在删除后调本页的撤销按钮,直接互相 import 会绕成环;统一走
// `globalThis.__monochromeFileStorage` 这个已经存在的桥。
import { applyTranslations, t } from './i18n.js';
import { showNotification } from './downloads.js';
import { setUiState } from './ui-state.js';

let entries = [];
const selected = new Set();
let loading = false;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * Human-readable byte count. 1024-based because every file manager on Windows
 * and macOS shows those numbers, and a size that disagrees with Explorer invites
 * the question "which one is lying".
 */
export function formatTrashBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

/** Local date only: a trash list is scanned by day, and a full ISO string is noise. */
export function formatTrashDate(value) {
    const text = String(value || '');
    if (!text) return '';
    // A bare `2026-11-26` parses as UTC midnight, so formatting it would invent a
    // local time (08:00 in UTC+8) that never existed. The host writes full
    // timestamps; anything shorter is passed through rather than given an hour.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text.slice(0, 10);
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * What one row says about where its bytes are.
 *
 * `moved: false` is not a failure: the folder was shared with a live work, so
 * moving it would have taken that work's files too. The row was only flagged
 * deleted, and restoring puts nothing back — the bytes never left.
 */
export function trashEntrySummary(entry) {
    const moved = entry?.moved !== false;
    const files = Number(entry?.files) || 0;
    const size = formatTrashBytes(entry?.bytes);
    if (!moved) {
        // A work `/api/cleanup` only soft-deleted: its files were already gone.
        return files > 0 ? `${files} 项 · ${size}` : t('trash.filesGone');
    }
    return `${files} 项 · ${size}`;
}

function bridge() {
    return globalThis.__monochromeFileStorage;
}

function setStatus(state, message) {
    const element = document.getElementById('trash-status');
    if (!element) return;
    if (!message) {
        element.hidden = true;
        return;
    }
    setUiState(element, state, message);
}

function entryRowHtml(entry) {
    const id = String(entry?.workId || '');
    const checked = selected.has(id);
    const title = String(entry?.title || '') || t('trash.untitled');
    const origin = String(entry?.originalRoot || '');
    const moved = entry?.moved !== false;
    return `
        <article class="trash-row${checked ? ' trash-row--selected' : ''}" role="listitem" data-trash-id="${escapeHtml(id)}">
            <button
                type="button"
                class="creation-select-check trash-select-check"
                data-select-trash-id="${escapeHtml(id)}"
                aria-pressed="${checked}"
                aria-label="${escapeHtml(t('selection.selectAll'))}"
                title="${escapeHtml(t('selection.selectAll'))}"
            >
                <span aria-hidden="true">${checked ? '✓' : ''}</span>
            </button>
            <div class="trash-row-body">
                <h2 class="trash-row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h2>
                <p class="trash-row-origin" title="${escapeHtml(origin)}">${escapeHtml(origin || t('trash.originUnknown'))}</p>
                <p class="trash-row-meta">
                    <span>${escapeHtml(formatTrashDate(entry?.deletedAt))}</span>
                    <span class="trash-row-dot" aria-hidden="true">·</span>
                    <span>${escapeHtml(trashEntrySummary(entry))}</span>
                    ${moved ? '' : `<span class="trash-row-flag">${escapeHtml(t('trash.notMoved'))}</span>`}
                </p>
            </div>
            <div class="trash-row-actions">
                <button class="btn btn-primary" type="button" data-restore-trash-id="${escapeHtml(id)}" data-i18n="trash.restore">
                    Restore
                </button>
                <button class="btn btn-secondary creation-delete-btn" type="button" data-purge-trash-id="${escapeHtml(id)}" data-i18n="trash.deleteForever">
                    Delete forever
                </button>
            </div>
        </article>`;
}

function render() {
    const list = document.getElementById('trash-list');
    const empty = document.getElementById('trash-empty-state');
    const total = document.getElementById('trash-total');
    const selectionBar = document.getElementById('trash-selection-bar');
    const selectedCount = document.getElementById('trash-selected-count');
    const restoreButton = document.getElementById('trash-restore-selected');
    const emptyButton = document.getElementById('trash-empty');
    if (!list) return;
    list.innerHTML = entries.map(entryRowHtml).join('');
    if (empty) empty.hidden = entries.length > 0 || loading;
    // Drop selections whose rows are gone (a restore or purge from elsewhere).
    const present = new Set(entries.map((entry) => String(entry.workId || '')));
    for (const id of [...selected]) {
        if (!present.has(id)) selected.delete(id);
    }
    if (total) {
        const count = Number(entries.length);
        total.textContent = count ? `${count}` : '';
        if (count) {
            const bytes = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
            total.textContent = `${count} · ${formatTrashBytes(bytes)}`;
        }
    }
    if (selectionBar) selectionBar.hidden = entries.length === 0;
    if (selectedCount) selectedCount.textContent = t('selection.selectedCount', { count: selected.size });
    if (restoreButton) restoreButton.disabled = selected.size === 0;
    if (emptyButton) emptyButton.disabled = entries.length === 0;
    translateRows(list);
}

/**
 * `data-i18n` attributes are translated once when the page loads; rows are
 * rebuilt on every refresh, so they need the same pass or they stay English.
 */
function translateRows(root) {
    applyTranslations(root);
}

export async function refreshTrash() {
    const storage = bridge();
    if (!storage?.listTrash) {
        setStatus('error', t('trash.hostUnavailable'));
        return;
    }
    loading = true;
    setStatus('loading', t('trash.loading'));
    try {
        const result = await storage.listTrash();
        entries = Array.isArray(result?.entries) ? result.entries : [];
        setStatus('idle', '');
    } catch (error) {
        console.error('trash list failed', error);
        entries = [];
        setStatus('error', `${t('trash.loadFailed')}: ${error?.message || error}`);
    } finally {
        loading = false;
        render();
    }
}

async function restoreEntries(ids) {
    const storage = bridge();
    const list = (ids || []).filter(Boolean);
    if (!storage?.restoreWorks || list.length === 0) return;
    setStatus('loading', t('trash.restoring'));
    try {
        const result = await storage.restoreWorks(list);
        const failed = (result?.works || []).filter((work) => work?.ok !== true);
        if (failed.length > 0) {
            // The usual cause is a folder that reappeared at the original path
            // (re-downloaded, or copied back by hand). The host refuses to pick a
            // winner, so say which ones and leave both copies in place.
            setStatus('error', `${t('trash.restoreFailed')}: ${failed.map((work) => work?.error || work?.code || '?').join('; ')}`);
        } else {
            setStatus('success', t('trash.restored'));
        }
        showNotification(failed.length > 0 ? t('trash.restoreFailed') : t('trash.restored'));
        for (const id of list) selected.delete(id);
    } catch (error) {
        console.error('trash restore failed', error);
        setStatus('error', `${t('trash.restoreFailed')}: ${error?.message || error}`);
    } finally {
        await refreshTrash();
        // The library page is a separate module reading its own slice; tell it the
        // host list changed rather than making the user reload the window.
        document.dispatchEvent(new CustomEvent('monochrome:file-storage-works-updated'));
    }
}

async function purgeEntries(ids) {
    const storage = bridge();
    const list = (ids || []).filter(Boolean);
    if (!storage?.purgeTrash) return;
    const scope = list.length === 0 ? t('trash.emptyAll') : t('trash.deleteForever');
    // Irreversible: nothing else in this project asks twice for a one-way action,
    // and this is the only one.
    if (!window.confirm(t('trash.purgeConfirm', { scope }))) return;
    setStatus('loading', t('trash.purging'));
    try {
        const result = await storage.purgeTrash(list);
        const failed = (result?.works || []).filter((work) => work?.ok !== true);
        if (failed.length > 0) {
            setStatus('error', `${t('trash.purgeFailed')}: ${failed.map((work) => work?.error || work?.code || '?').join('; ')}`);
        } else {
            setStatus('success', t('trash.purged'));
        }
        for (const id of list) selected.delete(id);
    } catch (error) {
        console.error('trash purge failed', error);
        setStatus('error', `${t('trash.purgeFailed')}: ${error?.message || error}`);
    } finally {
        await refreshTrash();
        document.dispatchEvent(new CustomEvent('monochrome:file-storage-works-updated'));
    }
}

function toggleSelection(id) {
    if (!id) return;
    // A blank id marks a row the host could not address; selecting it would make
    // "restore selected" send an id that matches nothing.
    if (!id.trim()) return;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
}

function selectAll() {
    const addressable = entries.map((entry) => String(entry.workId || '')).filter((id) => id.trim());
    const allSelected = addressable.length > 0 && addressable.every((id) => selected.has(id));
    selected.clear();
    if (!allSelected) for (const id of addressable) selected.add(id);
    render();
}

export function initializeTrashPage() {
    const page = document.getElementById('page-trash');
    if (!page) return;
    document.getElementById('trash-list')?.addEventListener('click', (event) => {
        const select = event.target.closest('[data-select-trash-id]');
        if (select) {
            event.preventDefault();
            event.stopPropagation();
            toggleSelection(select.dataset.selectTrashId);
            return;
        }
        const restore = event.target.closest('[data-restore-trash-id]');
        if (restore) {
            void restoreEntries([restore.dataset.restoreTrashId]);
            return;
        }
        const purge = event.target.closest('[data-purge-trash-id]');
        if (purge) void purgeEntries([purge.dataset.purgeTrashId]);
    });
    document.getElementById('trash-refresh')?.addEventListener('click', () => void refreshTrash());
    document.getElementById('trash-select-all')?.addEventListener('click', () => selectAll());
    document.getElementById('trash-restore-selected')?.addEventListener('click', () => {
        void restoreEntries([...selected]);
    });
    document.getElementById('trash-cancel-selection')?.addEventListener('click', () => {
        selected.clear();
        render();
    });
    document.getElementById('trash-empty')?.addEventListener('click', () => void purgeEntries([]));
    document.addEventListener('monochrome:trash-open', () => {
        selected.clear();
        void refreshTrash();
    });
    // Re-entering the page from the sidebar navigates to `/trash`, which the
    // router turns into the same event; a refresh keeps the list honest after a
    // delete somewhere else.
    window.addEventListener('monochrome:file-storage-works-updated', () => {
        if (document.getElementById('page-trash')?.classList.contains('active')) void refreshTrash();
    });
}

// Exposed for the browser probes: a probe can drive the page without knowing
// which module instance the app loaded.
globalThis.__monochromeTrash = { refresh: refreshTrash, formatBytes: formatTrashBytes };
