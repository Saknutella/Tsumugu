import { t } from './i18n.js';

const TYPE_LABELS = {
    audio: 'voices.fileType.audio',
    video: 'voices.fileType.video',
    image: 'voices.fileType.image',
    text: 'voices.fileType.text',
    pdf: 'voices.fileType.pdf',
    archive: 'creations.archive',
    link: 'creations.link',
    file: 'creations.file',
};

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function thumbSource(value) {
    const source = String(value ?? '').trim();
    if (!source) return '';
    try {
        const { protocol } = new URL(source, 'https://localhost');
        if (['http:', 'https:', 'blob:', 'asset:'].includes(protocol) || /^data:image\//i.test(source)) {
            return escapeHtml(source);
        }
    } catch {
        // A malformed imported poster should not prevent the remaining file rows from rendering.
    }
    return '';
}

function buildFolders(rows) {
    const root = { children: new Map(), entries: [] };
    for (const row of rows) {
        const path = String(row.path ?? '');
        // The logical path is presentation metadata. Remote URLs can contain slash-separated IDs too.
        const directories = /^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(path)
            ? []
            : path
                  .split(/[\\/]/)
                  .filter((part) => part && part !== '.' && part !== '..')
                  .slice(0, -1);
        let folder = root;
        for (const directory of directories) {
            if (!folder.children.has(directory)) {
                const child = { name: directory, children: new Map(), entries: [], count: 0 };
                folder.children.set(directory, child);
                folder.entries.push({ folder: child });
            }
            folder = folder.children.get(directory);
            folder.count++;
        }
        folder.entries.push({ row });
    }
    return root;
}

function renderRow(row, depth, showDescriptions) {
    const kind = Object.hasOwn(TYPE_LABELS, row.kind) ? row.kind : 'file';
    const name = escapeHtml(row.name);
    const thumb = thumbSource(row.thumb);
    const label = escapeHtml(row.typeLabel || t(TYPE_LABELS[kind]));
    const isAudio = kind === 'audio';
    const remote = !row.description && ['remote', 'downloading', 'failed'].includes(row.attachment?.status);
    const remoteBadge = remote
        ? `<span class="voice-file-local-state is-missing">${escapeHtml(t('voices.notDownloaded'))}</span>`
        : '';
    const dataType = kind === 'link' ? 'file' : kind;
    const file = !row.description && (row.managed || ['archive', 'file', 'pdf', 'text'].includes(kind));
    const typeClasses = [
        file ? 'creation-attachment-file' : '',
        isAudio ? 'creation-attachment-audio' : '',
        row.description ? 'creation-attachment-description' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const descriptionClass = row.description
        ? ` is-description-animated${showDescriptions ? '' : ' is-description-hidden'}`
        : '';
    return `<div class="voice-album-row-hitbox${descriptionClass}" data-voice-depth="${depth}" style="--voice-depth:${depth}">
        <div class="creation-attachment ${isAudio ? 'track-item' : 'voice-album-file-row'} voice-album-track-row ${typeClasses}"
             data-creation-file-index="${escapeHtml(row.index)}"
             data-voice-depth="${depth}"
             data-voice-type="${escapeHtml(dataType)}"
             ${row.attachmentId ? `data-attachment-row="${escapeHtml(row.attachmentId)}"` : ''}
             ${row.description ? 'data-description-row' : ''} ${row.attrs || ''}>
            <div class="creation-file-ordinal">
                ${row.selector || ''}<span class="track-number" aria-hidden="true">${escapeHtml(row.index + 1)}</span>
            </div>
            <div class="track-item-info">
                ${
                    thumb
                        ? `<button class="creation-row-thumb-box" type="button" data-creation-thumb data-creation-thumb-title="${name}" aria-label="${name}">
                    <img class="creation-row-thumb" src="${thumb}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-preview
                        ${kind === 'image' && row.attachmentId ? `data-attachment-id="${escapeHtml(row.attachmentId)}"` : ''}
                        ${kind === 'image' && row.attachment?.previewId ? `data-preview-id="${escapeHtml(row.attachment.previewId)}"` : ''} />
                </button>`
                        : ''
                }
                <div class="track-item-details">
                    <div class="creation-file-title">
                        <span class="creation-attachment-type voice-album-type" data-type="${escapeHtml(dataType)}">${label}</span>
                        <button type="button" class="creation-attachment-name" data-creation-file-open title="${name}">${name}</button>${remoteBadge}
                    </div>
                    ${
                        row.meta || row.status
                            ? `<div class="creation-file-meta">
                        ${row.meta ? `<span class="creation-attachment-meta" title="${escapeHtml(row.meta)}">${escapeHtml(row.meta)}</span>` : ''}
                        ${row.status || ''}
                    </div>`
                            : ''
                    }
                </div>
            </div>
            <span class="track-item-duration" title="${escapeHtml(row.size)}">${escapeHtml(row.size)}</span>
            <div class="track-item-actions">${row.controls || ''}</div>
            ${row.progress || ''}
        </div>
    </div>`;
}

function folderRows(folder) {
    const rows = [];
    for (const entry of folder.entries || []) {
        if (entry.row) rows.push(entry.row);
        else if (entry.folder) rows.push(...folderRows(entry.folder));
    }
    return rows;
}

function renderFolderGallery(rows) {
    return '<div class="creation-folder-gallery-grid">' + rows.map((row) => `<button type="button" class="creation-folder-gallery-item" data-creation-file-index="${escapeHtml(row.index)}" data-creation-file-open title="${escapeHtml(row.name)}">
        <img src="${escapeHtml(row.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-image-preview />
        <span class="creation-folder-gallery-meta">
            <span class="creation-folder-gallery-title"><span class="voice-album-type" data-type="${escapeHtml(row.kind)}">${escapeHtml(row.typeLabel || t(TYPE_LABELS[row.kind] || 'creations.file'))}</span>${escapeHtml(row.name)}</span>
            <span class="creation-folder-gallery-sub"><span>${escapeHtml(row.meta || '')}</span><span>${escapeHtml(row.size || '')}</span></span>
        </span>
    </button>`).join('') + '</div>';
}

function renderFolderViewToggle(rows) {
    if (!rows.length) return '';
    return `<span class="creation-folder-view-toggle" role="group" aria-label="${escapeHtml(t('creations.folderViewLabel'))}"><button type="button" class="creation-folder-view-btn is-active" data-creation-folder-view="list" title="${escapeHtml(t('creations.folderViewList'))}">≣ ${escapeHtml(t('creations.folderViewList'))}</button><button type="button" class="creation-folder-view-btn" data-creation-folder-view="grid" title="${escapeHtml(t('creations.folderViewGrid'))}">⊞ ${escapeHtml(t('creations.folderViewGrid'))}</button></span>`;
}

function renderEntries(entries, showDescriptions, depth = 0, path = []) {
    return entries
        .map(({ row, folder }) => {
            if (row) return renderRow(row, depth, showDescriptions);
            const folderPath = [...path, String(folder.name)];
            const images = folderRows(folder).filter((row) => row.kind === 'image' && row.thumb);
            return `<details class="voice-album-folder" open data-folder-expanded="true" data-voice-depth="${depth}" style="--voice-depth:${depth}">
            <summary class="voice-album-folder-row" data-voice-depth="${depth}">
                <label class="voice-folder-selector"><input type="checkbox" class="voice-folder-select voice-native-checkbox"
                    data-creation-folder-select-path="${escapeHtml(JSON.stringify(folderPath))}"
                    aria-label="${escapeHtml(t('voices.selectFolder', { title: folder.name }))}" /></label>
                <span class="voice-folder-main" style="--voice-depth:${depth}">
                    <span class="voice-album-folder-caret" aria-hidden="true">▾</span>
                    <svg class="voice-album-folder-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                    <span class="voice-album-folder-name">${escapeHtml(folder.name)}</span>
                    ${renderFolderViewToggle(images)}
                    <span class="voice-album-folder-count">${escapeHtml(t('creations.fileCount', { count: folder.count }))}</span>
                    <button type="button" class="voice-album-folder-menu creation-folder-menu"
                        data-creation-folder-menu data-creation-folder-path="${escapeHtml(JSON.stringify(folderPath))}"
                        title="${escapeHtml(t('voices.folderActions'))}" aria-label="${escapeHtml(t('voices.folderActions'))}"
                        aria-haspopup="menu"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>
                </span>
            </summary>
            <div class="voice-album-folder-children">
                <div class="creation-folder-list">${renderEntries(folder.entries, showDescriptions, depth + 1, folderPath)}</div>
                ${images.length ? renderFolderGallery(images) : ''}
            </div>
        </details>`;
        })
        .join('');
}

/** Group imported paths without renumbering rows, so delegated actions still resolve the original attachment. */
export function renderCreationFileTree(rows, { toolbar = '', showDescriptions = true } = {}) {
    // Keep imported images together in one virtual folder so the native folder
    // list/gallery switch has a stable home; row objects (and their attachment
    // actions) stay untouched.
    const imageFolder = t('creations.imagesFolder');
    const displayRows = rows.map((row) => row.kind === 'image' && !row.description
        ? { ...row, path: imageFolder + '/' + String(row.name || '') }
        : row);
    const { entries } = buildFolders(displayRows);
    return `<section class="creation-tracklist-card" aria-labelledby="creation-file-heading">
        <div class="creation-column-head">
            <h2 id="creation-file-heading" class="creation-column-title">${escapeHtml(t('voices.files'))} <small>${displayRows.length}</small></h2>
            <span class="creation-column-sub">${escapeHtml(t('creations.fileTreeHint'))}</span>
            ${
                rows.some((row) => row.description)
                    ? `<label class="creation-description-toggle">
                <input type="checkbox" id="creation-show-descriptions"${showDescriptions ? ' checked' : ''} />
                <span>${escapeHtml(t('creations.showDescriptions'))}</span>
            </label>`
                    : ''
            }
        </div>
        ${toolbar}
        ${
            rows.length
                ? `<div class="track-list-header" aria-hidden="true">
            <span>#</span>
            <span class="voice-tree-heading">${escapeHtml(t('voices.albumList'))}</span>
            <span class="duration-header">${escapeHtml(t('voices.duration'))} / ${escapeHtml(t('creations.detailSize'))}</span>
            <span>${escapeHtml(t('voices.actions'))}</span>
        </div>
        <div class="voice-album-hierarchy creation-attachments">${renderEntries(entries, showDescriptions)}</div>`
                : `<p class="creations-empty">${escapeHtml(t('voices.noFiles'))}</p>`
        }
    </section>`;
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', (event) => {
        const button = event.target.closest?.('.creation-folder-view-btn[data-creation-folder-view]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const details = button.closest('details');
        if (!details) return;
        const mode = button.dataset.creationFolderView === 'grid' ? 'grid' : 'list';
        details.dataset.creationFolderView = mode;
        for (const item of details.querySelectorAll(':scope > summary [data-creation-folder-view]')) {
            item.classList.toggle('is-active', item.dataset.creationFolderView === mode);
        }
    }, true);
}
