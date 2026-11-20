import { t } from './i18n.js';

export class SidePanelManager {
    constructor() {
        this.panel = document.getElementById('side-panel');
        this.titleElement = document.getElementById('side-panel-title');
        this.controlsElement = document.getElementById('side-panel-controls');
        this.contentElement = document.getElementById('side-panel-content');
        this.resizerElement = document.getElementById('side-panel-resizer');
        this.expandButton = document.getElementById('side-panel-expand-btn');
        this.closeButton = document.getElementById('side-panel-close-btn');
        this.reopenButton = document.getElementById('side-panel-reopen');
        this.currentView = null; // 'queue' or 'lyrics'
        this.isResizing = false;
        this.lastOpen = null;
        this.expanded = false;
        this.defaultWidth = 400;
        this.preferredWidths = {
            queue: this.defaultWidth,
            lyrics: this.defaultWidth,
            'creation-description': this.defaultWidth,
        };

        if (this.resizerElement) {
            this.initResizer();
        }
        this.closeButton?.addEventListener('click', () => this.close());
        this.expandButton?.addEventListener('click', () => this.toggleExpanded());
        this.reopenButton?.addEventListener('click', () => this.reopen());
    }

    toggleExpanded() {
        this.expanded = !this.expanded;
        this.panel.classList.toggle('expanded', this.expanded);
        this.applyWidth();
        if (this.expandButton) {
            const label = this.expanded ? t('sidePanel.restoreWidth') : t('sidePanel.widen');
            this.expandButton.title = label;
            this.expandButton.setAttribute('aria-label', label);
        }
    }

    reopen() {
        if (!this.lastOpen) return;
        this.open(
            this.lastOpen.view,
            this.lastOpen.title,
            this.lastOpen.renderControlsCallback,
            this.lastOpen.renderContentCallback,
            true,
        );
    }

    emitChange() {
        window.dispatchEvent(
            new CustomEvent('side-panel-changed', {
                detail: {
                    active: this.panel.classList.contains('active'),
                    view: this.currentView,
                },
            })
        );
    }

    widthStorageKey(view) {
        return `side-panel-width:${view}`;
    }

    initResizer() {
        this.resizerElement.addEventListener('mousedown', this.startResize.bind(this));

        try {
            // Keep the legacy queue key so existing users retain their queue width.
            const legacyWidth = parseInt(localStorage.getItem('side-panel-width'), 10);
            if (Number.isFinite(legacyWidth) && legacyWidth > 0) {
                this.preferredWidths.queue = legacyWidth;
                this.preferredWidths.lyrics = legacyWidth;
            }
            for (const view of Object.keys(this.preferredWidths)) {
                const saved = parseInt(localStorage.getItem(this.widthStorageKey(view)), 10);
                if (Number.isFinite(saved) && saved > 0) this.preferredWidths[view] = saved;
            }
        } catch {
            /* ignore storage errors */
        }
        this.applyWidth();
        window.addEventListener('resize', () => this.applyWidth());
    }

    availableWidth() {
        // Closed panels are translated offscreen; their fixed inset remains reliable.
        const right = Math.max(0, parseFloat(getComputedStyle(this.panel).right) || 0);
        return Math.max(0, document.documentElement.clientWidth - right);
    }

    applyWidth() {
        const available = this.availableWidth();
        const preferred = this.preferredWidths[this.currentView] ?? this.defaultWidth;
        const width = this.expanded ? available : Math.min(preferred, available);
        this.panel.style.setProperty('--side-panel-width', `${width}px`);
    }

    startResize(e) {
        e.preventDefault();
        this.isResizing = true;
        this.panel.style.transition = 'none'; // Disable transition for smooth resizing
        document.body.style.cursor = 'ew-resize';

        this.resizeBind = this.resize.bind(this);
        this.stopResizeBind = this.stopResize.bind(this);

        document.addEventListener('mousemove', this.resizeBind);
        document.addEventListener('mouseup', this.stopResizeBind);
    }

    resize(e) {
        if (!this.isResizing) return;
        if (this.expanded) this.toggleExpanded();
        const available = this.availableWidth();
        const minWidth = Math.min(300, available);
        const view = this.currentView || 'queue';
        this.preferredWidths[view] = Math.max(minWidth, Math.min(available, available - e.clientX));
        this.applyWidth();
    }

    stopResize() {
        this.isResizing = false;
        this.panel.style.transition = ''; // Restore transitions
        document.body.style.cursor = '';

        document.removeEventListener('mousemove', this.resizeBind);
        document.removeEventListener('mouseup', this.stopResizeBind);

        // A narrower window must not erase the user's preferred width.
        const view = this.currentView || 'queue';
        try {
            localStorage.setItem(this.widthStorageKey(view), String(this.preferredWidths[view]));
            if (view === 'queue') localStorage.setItem('side-panel-width', String(this.preferredWidths[view]));
        } catch {
            /* ignore storage errors */
        }
    }

    cleanupLyricsView() {
        if (!this.panel) return;
        if (typeof this.panel.lyricsCleanup === 'function') {
            try {
                this.panel.lyricsCleanup();
            } catch (error) {
                console.warn('Failed to clean up lyrics view:', error);
            }
            this.panel.lyricsCleanup = null;
        }
        this.panel.lyricsManager?.stopLyricsObserver?.();
        delete this.panel.lyricsManager;
    }

    open(view, title, renderControlsCallback, renderContentCallback, forceOpen = false) {
        this.cleanupLyricsView();
        // If clicking the same view that is already open, close it
        if (!forceOpen && this.currentView === view && this.panel.classList.contains('active')) {
            this.close();
            return;
        }

        this.lastOpen = {
            view,
            title,
            renderControlsCallback,
            renderContentCallback,
        };
        if (this.reopenButton) this.reopenButton.hidden = true;

        this.currentView = view;
        this.panel.dataset.view = view;
        this.titleElement.textContent = title;

        // Clear previous content
        this.controlsElement.innerHTML = '';
        this.contentElement.innerHTML = '';

        // Render new content
        if (renderControlsCallback) renderControlsCallback(this.controlsElement);
        if (renderContentCallback) renderContentCallback(this.contentElement);

        this.panel.classList.add('active');
        this.applyWidth();
        this.emitChange();
    }

    close() {
        this.cleanupLyricsView();
        this.panel.classList.remove('active');
        this.currentView = null;
        if (this.reopenButton) this.reopenButton.hidden = !this.lastOpen;
        this.emitChange();
        // Optionally clear content after transition
        setTimeout(() => {
            if (!this.panel.classList.contains('active')) {
                this.controlsElement.innerHTML = '';
                this.contentElement.innerHTML = '';
            }
        }, 300);
    }

    isActive(view) {
        return this.currentView === view && this.panel.classList.contains('active');
    }

    async refresh(view, renderControlsCallback, renderContentCallback, options = {}) {
        if (this.isActive(view)) {
            if (renderControlsCallback) {
                this.controlsElement.innerHTML = '';
                await renderControlsCallback(this.controlsElement);
            }
            if (renderContentCallback) {
                if (!options.noClear) {
                    this.contentElement.innerHTML = '';
                }
                await renderContentCallback(this.contentElement);
            }
        }
    }

    async updateContent(view, renderContentCallback) {
        if (this.isActive(view)) {
            this.contentElement.innerHTML = '';
            await renderContentCallback(this.contentElement);
        }
    }
}

export const sidePanelManager = new SidePanelManager();
