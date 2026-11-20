import { getVoiceFileType } from './voice-file-types.js';
import { t } from './i18n.js';
import { adaptVoiceWork } from './voice-album.js';
import '../voice-file-selection.css';

function usableUrl(value) {
    try {
        return ['http:', 'https:'].includes(new URL(value, window.location.href).protocol) && Boolean(value);
    } catch {
        return false;
    }
}

/** Keep selection local to this rendered work; source order is independent of click order. */
export function bindVoiceFileSelection(root, work, { signal, onQueue, onDownload, onDeleteLocal }) {
    const files = [];
    const folders = [];
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === 'folder') {
                const folder = { start: files.length, end: files.length };
                folders.push(folder);
                walk(node.children);
                folder.end = files.length;
            } else files.push(node);
        }
    };
    walk(work.tracks);
    const tracks = adaptVoiceWork(work).tracks;
    let audioIndex = 0;
    const entries = files.map((node, index) => ({
        node,
        index,
        track: getVoiceFileType(node) === 'audio' ? tracks[audioIndex++] : null,
        enabled: usableUrl(node.localMediaDownloadUrl || node.localMediaStreamUrl || node.mediaDownloadUrl || node.mediaStreamUrl)
    }));
    const selected = new Set();
    const all = root.querySelector('#voice-select-all');
    const count = root.querySelector('#voice-selection-count');
    const queue = root.querySelector('#voice-selection-queue');
    const download = root.querySelector('#voice-selection-download');
    const deleteLocal = root.querySelector('#voice-selection-delete-local');
    const clear = root.querySelector('#voice-selection-clear');
    const toolbar = root.querySelector('.voice-selection-toolbar');
    const inputs = [...root.querySelectorAll('.voice-file-select')];
    const groupInputs = [...root.querySelectorAll('.voice-folder-select')];
    const enabled = entries.filter((entry) => entry.enabled);
    const chosen = () => entries.filter((entry) => selected.has(entry.index));
    const playable = (entry) => entry.track && usableUrl(entry.track.audioUrl);
    const downloadable = (entry) => usableUrl(entry.node.localMediaDownloadUrl || entry.node.localMediaStreamUrl || entry.node.mediaDownloadUrl || entry.node.mediaStreamUrl);
    const rowFor = (entry) => inputs[entry.index]?.closest('.voice-album-row-hitbox')?.querySelector('.voice-album-track-row');
    const isLocal = (entry) => rowFor(entry)?.dataset.voiceLocal === '1';
    let queuing = false;
    let downloading = false;

    function checkGroup(input, group) {
        const members = group.filter((entry) => entry.enabled);
        const total = members.filter((entry) => selected.has(entry.index)).length;
        input.checked = members.length > 0 && total === members.length;
        input.indeterminate = total > 0 && total < members.length;
        input.disabled = members.length === 0;
    }
    function update() {
        if (signal.aborted) return;
        const selection = chosen();
        const audioCount = selection.filter(playable).length;
        const missingCount = selection.filter((entry) => !isLocal(entry)).length;
        toolbar.dataset.empty = String(selection.length === 0);
        count.textContent = selection.length
            ? t('voices.selectionSummary', { count: selection.length, audio: audioCount }) +
                (missingCount ? ` · ${t('voices.selectionMissing', { count: missingCount })}` : '')
            : t('voices.selectFilesHint');
        checkGroup(all, enabled);
        queue.disabled = queuing || audioCount === 0;
        download.disabled = downloading || !selection.some(downloadable);
        if (deleteLocal) deleteLocal.disabled = !selection.some(isLocal);
        clear.disabled = selection.length === 0;
        for (const input of inputs) {
            const index = Number(input.dataset.voiceSelectIndex);
            input.checked = selected.has(index);
            input.disabled = !entries[index]?.enabled;
            input
                .closest('.voice-album-row-hitbox')
                .querySelector('.voice-album-track-row')
                .classList.toggle('voice-row-selected', input.checked);
        }
        for (const input of groupInputs) {
            const group = folders[Number(input.dataset.voiceSelectFolder)];
            checkGroup(input, group ? entries.slice(group.start, group.end) : []);
        }
    }
    function setGroup(members, checked) {
        for (const entry of members) {
            if (!entry.enabled) continue;
            if (checked) selected.add(entry.index);
            else selected.delete(entry.index);
        }
        update();
    }
    // Keep checkbox activation out of the native track-selection and folder-toggle delegates.
    toolbar.addEventListener('keydown', (event) => event.stopPropagation(), { signal });
    for (const label of root.querySelectorAll('.voice-row-selector, .voice-select-all-label, .voice-folder-selector')) {
        label.addEventListener('click', (event) => event.stopPropagation(), { signal });
        label.addEventListener('keydown', (event) => event.stopPropagation(), { signal });
    }
    for (const input of inputs)
        input.addEventListener(
            'change',
            () => {
                const index = Number(input.dataset.voiceSelectIndex);
                if (input.checked) selected.add(index);
                else selected.delete(index);
                update();
            },
            { signal }
        );
    for (const input of groupInputs)
        input.addEventListener(
            'change',
            () => {
                const group = folders[Number(input.dataset.voiceSelectFolder)];
                if (group) setGroup(entries.slice(group.start, group.end), input.checked);
            },
            { signal }
        );
    all.addEventListener('change', () => setGroup(enabled, all.checked), { signal });
    clear.addEventListener(
        'click',
        () => {
            selected.clear();
            update();
        },
        { signal }
    );
    queue.addEventListener(
        'click',
        async () => {
            if (queuing) return;
            const selectedTracks = chosen()
                .filter(playable)
                .map((entry) => entry.track);
            if (!selectedTracks.length) return;
            queuing = true;
            update();
            try {
                await onQueue(selectedTracks);
            } finally {
                queuing = false;
                update();
            }
        },
        { signal }
    );
    deleteLocal?.addEventListener(
        'click',
        async () => {
            const localEntries = chosen().filter(isLocal);
            if (!localEntries.length) return;
            const paths = localEntries.map((entry) => rowFor(entry)?.dataset.voicePath).filter(Boolean);
            if (!paths.length) return;
            deleteLocal.disabled = true;
            try {
                await onDeleteLocal?.(paths, deleteLocal, localEntries.map((entry) => entry.node.hash).filter(Boolean));
            } finally {
                update();
            }
        },
        { signal }
    );
    download.addEventListener(
        'click',
        async () => {
            if (downloading) return;
            const nodes = chosen()
                .filter(downloadable)
                .map((entry) => entry.node);
            if (!nodes.length) return;
            downloading = true;
            update();
            // Invoke synchronously before the first await so the native directory picker retains user activation.
            try {
                await onDownload(nodes, download);
            } finally {
                downloading = false;
                update();
            }
        },
        { signal }
    );
    update();
}
