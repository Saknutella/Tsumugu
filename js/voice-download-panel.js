import { t } from './i18n.js';
import '../voice-download-panel.css';

const terminalStates = new Set(['done', 'partial', 'canceled', 'error']);
const labels = {
    title: 'Downloads',
    minimize: 'Minimize downloads',
    expand: 'Expand downloads',
    cancel: 'Cancel download',
    canceling: 'Canceling…',
    collapse: 'Collapse',
    queued: 'Queued',
    downloading: 'Downloading',
    resuming: 'Resuming',
    retrying: 'Retrying',
    done: 'Completed',
    skipped: 'Skipped',
    error: 'Failed',
    partial: 'Partially completed',
    canceled: 'Canceled',
    started: 'Downloading',
    scanning: 'Scanning files…',
    unknown: 'Unknown size',
    estimated: 'estimated',
    summary: '{{done}} / {{total}} completed · {{failed}} failed',
    progress: 'Overall download progress'
};
const text = (key, options = {}) => t(`voiceDownloadPanel.${key}`, { defaultValue: labels[key], ...options });
const bytes = (value) => {
    if (!value) return '0 B';
    const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};
const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

// The controller lives outside page routing; minimizing never removes the task or its entry point.
export function createVoiceDownloadPanel() {
    let panel;
    let files = [];
    let job = {};
    let rootName = '';
    let onCancel;
    let cancelRequested = false;
    let refs;
    let alignmentObserver;

    // The player bar is a floating element whose right edge depends on the sidebar/queue/zoom.
    // Measure it instead of assuming a fixed percentage or pixel inset.
    function alignToPlayerBar() {
        if (!panel) return;
        const playerBar = document.querySelector('.now-playing-bar');
        if (!playerBar) {
            panel.style.right = '20px';
            return;
        }
        const rect = playerBar.getBoundingClientRect();
        panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    }

    function observePlayerBar() {
        const playerBar = document.querySelector('.now-playing-bar');
        if (!playerBar || alignmentObserver || typeof ResizeObserver !== 'function') return;
        alignmentObserver = new ResizeObserver(alignToPlayerBar);
        alignmentObserver.observe(playerBar);
        window.addEventListener('resize', alignToPlayerBar);
    }

    function setExpanded(expanded, focus = false) {
        if (!panel) return;
        alignToPlayerBar();
        panel.dataset.minimized = String(!expanded);
        refs.details.hidden = !expanded;
        refs.banner.setAttribute('aria-expanded', String(expanded));
        refs.banner.setAttribute('aria-label', text(expanded ? 'minimize' : 'expand'));
        if (focus) refs.banner.focus({ preventScroll: true });
    }

    function ensure() {
        if (panel) return;
        panel = document.createElement('section');
        panel.id = 'voice-download-panel';
        panel.className = 'voice-download-panel voice-download-card';
        panel.setAttribute('aria-label', text('title'));
        panel.innerHTML = `<button type="button" class="voice-download-banner" aria-controls="voice-download-details" aria-expanded="true">
            <span class="voice-download-banner-fill" aria-hidden="true"></span>
            <span class="voice-download-banner-title"></span><span class="voice-download-overall-percent"></span>
            <span class="voice-download-toggle-icon" aria-hidden="true">⌃</span>
        </button>
        <div class="voice-download-overall-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
        <div id="voice-download-details" class="voice-download-details">
            <div class="voice-download-panel-head"><div class="voice-download-heading"><strong></strong><span class="voice-download-root"></span></div></div>
            <div class="voice-download-summary" role="status" aria-live="polite"></div>
            <div class="voice-download-files"></div>
            <div class="voice-download-footer"><button type="button" class="voice-download-cancel"></button></div>
        </div>`;
        const find = (selector) => panel.querySelector(selector);
        refs = {
            banner: find('.voice-download-banner'),
            fill: find('.voice-download-banner-fill'),
            percent: find('.voice-download-overall-percent'),
            progress: find('.voice-download-overall-progress'),
            details: find('.voice-download-details'),
            summary: find('.voice-download-summary'),
            list: find('.voice-download-files'),
            cancel: find('.voice-download-cancel')
        };
        find('.voice-download-banner-title').textContent = text('title');
        find('.voice-download-heading strong').textContent = text('title');
        // The banner is the single minimize/expand control; a second close/minus button inside
        // the details duplicated the same action and made the card look like it had two toggles.
        refs.banner.addEventListener('click', () => setExpanded(panel.dataset.minimized === 'true'));
        panel.addEventListener('keydown', (event) => {
            // Space/arrow keys belong to the focused download control, not the player's global shortcuts.
            event.stopPropagation();
            if (event.key === 'Escape' && panel.dataset.minimized !== 'true') {
                event.preventDefault();
                setExpanded(false, true);
            }
        });
        refs.cancel.addEventListener('click', () => {
            if (terminalStates.has(job.state)) return setExpanded(false, true);
            if (cancelRequested) return;
            cancelRequested = true;
            refs.cancel.disabled = true;
            refs.cancel.textContent = text('canceling');
            onCancel?.();
        });
        refs.progress.setAttribute('aria-label', text('progress'));
        document.body.append(panel);
        observePlayerBar();
        requestAnimationFrame(alignToPlayerBar);
    }

    function render() {
        if (!panel) return;
        const known = files.filter((file) => file.total > 0);
        const unknown = files.filter((file) => !file.total);
        const total = known.reduce((sum, file) => sum + file.total, 0);
        const loaded = known.reduce(
            (sum, file) => sum + (['done', 'skipped'].includes(file.state) ? file.total : Math.min(file.loaded, file.total)),
            0
        );
        // Unknown lengths receive an average known-file weight. This is an estimate, never an early 100%.
        const weight = known.length ? total / known.length : 1;
        const unknownLoaded = unknown.reduce(
            (sum, file) => sum + (file.state === 'done' ? 1 : file.loaded > 0 ? 0.5 : 0),
            0
        );
        const ratio = files.length ? (loaded + unknownLoaded * weight) / (total + unknown.length * weight) : 0;
        const allDone = job.state === 'done' && files.every((file) => ['done', 'skipped'].includes(file.state));
        const percent = allDone ? 100 : Math.min(99, Math.floor(ratio * 100));
        panel.dataset.state = job.state === 'progress' ? 'started' : job.state;
        refs.fill.style.width = `${percent}%`;
        refs.percent.textContent = `${percent}%${unknown.length ? ` · ${text('estimated')}` : ''}`;
        refs.progress.setAttribute('aria-valuenow', String(percent));
        refs.progress.setAttribute('aria-valuetext', refs.percent.textContent);
        // Derive counts from file states instead of the last job event: a file can
        // finish before the next job summary arrives, which used to show 0/3.
        const completedCount = files.filter((file) => ['done', 'skipped'].includes(file.state)).length;
        const failedCount = files.filter((file) => file.state === 'error').length;
        const summary = text('summary', { done: completedCount, total: files.length, failed: failedCount });
        const state = text(job.state === 'progress' ? 'started' : job.state);
        panel.querySelector('.voice-download-banner-title').textContent =
            `${state} · ${completedCount}/${files.length}`;
        refs.summary.textContent = `${state} · ${summary}${job.error ? ` · ${job.error}` : ''}`;
        refs.banner.title = `${rootName} · ${refs.summary.textContent} · ${refs.percent.textContent}`;
        refs.cancel.disabled = cancelRequested && !terminalStates.has(job.state);
        refs.cancel.textContent = text(
            terminalStates.has(job.state) ? 'collapse' : cancelRequested ? 'canceling' : 'cancel'
        );
    }

    function renderFile(file) {
        const row = file.row;
        row.dataset.state = file.state;
        row.querySelector('.voice-download-file-state').textContent = text(file.state);
        const complete = file.state === 'done' || file.state === 'skipped';
        const percent =
            complete
                ? 100
                : file.total
                  ? Math.min(99, Math.floor((file.loaded / file.total) * 100))
                  : null;
        row.dataset.percent = percent === null ? '' : String(percent);
        row.querySelector('.voice-download-progress span').style.width = `${percent ?? 0}%`;
        row.querySelector('.voice-download-file-bytes').textContent =
            `${bytes(file.loaded)} / ${file.total ? bytes(file.total) : text('unknown')}${percent !== null ? ` · ${percent}%` : ''}`;
        row.querySelector('.voice-download-file-error').textContent = file.error || '';
    }

    return {
        start(plan, options = {}) {
            ensure();
            onCancel = options.onCancel;
            cancelRequested = false;
            job = { state: 'started', completed: 0, failed: 0 };
            rootName = plan.rootName;
            panel.querySelector('.voice-download-root').textContent = rootName;
            refs.list.replaceChildren();
            files = plan.files.map((source, index) => {
                const row = document.createElement('div');
                row.className = 'voice-download-file';
                row.dataset.voiceDownloadIndex = String(index);
                row.innerHTML =
                    '<div class="voice-download-file-head"><span class="voice-download-file-name"></span><span class="voice-download-file-state"></span></div><div class="voice-download-file-bytes"></div><div class="voice-download-progress"><span></span></div><div class="voice-download-file-error"></div>';
                const name = row.querySelector('.voice-download-file-name');
                name.textContent = source.segments?.join(' / ') || source.name;
                name.title = name.textContent;
                refs.list.append(row);
                const file = { row, loaded: 0, total: positive(source.size), state: 'queued' };
                renderFile(file);
                return file;
            });
            setExpanded(true);
            render();
        },
        update(event) {
            if (!panel) return;
            if (event.type === 'file') {
                const file = files[event.index];
                if (!file) return;
                file.state = event.state || file.state;
                if (event.loaded !== undefined) file.loaded = positive(event.loaded);
                if (event.total !== undefined) file.total = positive(event.total);
                file.error = event.error || '';
                renderFile(file);
            } else if (event.type === 'job') {
                job = { ...job, ...event };
            }
            render();
        },
        expand() {
            setExpanded(true);
        },
        minimize() {
            setExpanded(false);
        }
    };
}
