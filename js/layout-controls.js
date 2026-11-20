// 大屏内容宽度拖拽 + 全局返回顶部。
// 宽度只作用于浏览型页面,音声详情继续使用原生 album 布局,避免把原生页撑坏。
const WIDTH_KEY = 'monochrome-content-width';
const MIN_WIDTH = 760;
const GUTTER = 32;
const MIN_VIEWPORT = 1280;
const LIVE_RESIZE_INTERVAL = 48;
const BACK_TO_TOP_THRESHOLD = 300;
// Experiment: auto layout replaces the per-page pixel-width preference.
const AUTO_LAYOUT = true;

const FRAMES = [
    { frame: '#page-creations .creations-page', view: '#creations-feed-view' },
    { frame: '#page-creations .creation-detail', view: '#creations-detail-view' },
    { frame: '#page-voices .voices-page', view: '#voices-list-view' },
    { frame: '#page-videos .videos-page', view: '#videos-list-view' }
];

function readStoredWidth() {
    try {
        const value = Number(localStorage.getItem(WIDTH_KEY));
        return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
    } catch {
        return null;
    }
}

function writeStoredWidth(width) {
    try {
        if (width === null) localStorage.removeItem(WIDTH_KEY);
        else localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
        // 隐私模式不可写时宽度仍在本页生效。
    }
}

function applyWidth(width) {
    const root = document.documentElement;
    if (width === null) root.style.removeProperty('--content-max-width');
    else root.style.setProperty('--content-max-width', `${Math.round(width)}px`);
}

export function initializeLayoutControls() {
    const main = document.querySelector('.main-content');
    const resizer = document.getElementById('content-resizer');
    const backToTop = document.getElementById('back-to-top');
    if (!main || !resizer || !backToTop) return;

    // Do not apply the old pixel width preference; CSS + auto-fill grids now
    // own the content width. Keep the key untouched for rollback.
    applyWidth(null);
    let storedWidth = null;
    if (AUTO_LAYOUT) {
        resizer.hidden = true;
        resizer.style.display = 'none';
    }

    let activeFrame = null;
    let drag = null;
    let resizeFrame = 0;
    const frames = FRAMES.map(({ frame, view }) => {
        const element = document.querySelector(frame);
        return { element, view: document.querySelector(view), page: element?.closest('.page') };
    }).filter(({ element, view, page }) => element && view && page);

    function maxWidth() {
        const limit = main.clientWidth - GUTTER * 2;
        // The detail's parent still has padding even when its own max-width is lifted.
        const available = activeFrame?.classList.contains('creation-detail')
            ? activeFrame.parentElement.clientWidth
            : limit;
        return Math.max(MIN_WIDTH, Math.min(limit, available));
    }

    function visibleFrame() {
        if (window.innerWidth < MIN_VIEWPORT) return null;
        return frames.find(({ view, page }) => !view.hidden && page.classList.contains('active'))?.element ?? null;
    }

    function updateResizer() {
        if (AUTO_LAYOUT) {
            resizer.hidden = true;
            return;
        }
        if (drag) return;
        activeFrame = visibleFrame();
        if (!activeFrame) {
            resizer.hidden = true;
            return;
        }
        const frameRect = activeFrame.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const spare = mainRect.width - frameRect.width;
        if (!frameRect.width || spare < 32) {
            resizer.hidden = true;
            return;
        }
        const left = Math.max(mainRect.left + 12, frameRect.left - 12);
        const top = Math.min(window.innerHeight - 120, Math.max(110, window.innerHeight / 2));
        resizer.hidden = false;
        resizer.style.left = `${Math.round(left)}px`;
        resizer.style.top = `${Math.round(top)}px`;
        resizer.setAttribute('aria-valuemin', String(MIN_WIDTH));
        resizer.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
        resizer.setAttribute('aria-valuenow', String(Math.round(frameRect.width)));
    }

    function scheduleUpdate() {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = 0;
            updateResizer();
        });
    }

    function setWidth(width) {
        const next = Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(width)));
        storedWidth = next;
        applyWidth(next);
        writeStoredWidth(next);
        scheduleUpdate();
    }

    function resetWidth() {
        storedWidth = null;
        applyWidth(null);
        writeStoredWidth(null);
        scheduleUpdate();
    }

    function dragWidth(state, clientX) {
        // Both margins move symmetrically, so each pixel of handle motion changes the width by two.
        return Math.max(MIN_WIDTH, Math.min(state.maxWidth, state.startWidth + (state.startX - clientX) * 2));
    }

    function finishDrag(commit, clientX) {
        if (!drag) return;
        const state = drag;
        drag = null;
        cancelAnimationFrame(state.previewFrame);
        if (commit && state.frame === visibleFrame()) {
            const next = Math.round(dragWidth(state, clientX));
            if (next !== Math.round(state.startWidth)) setWidth(next);
        }
        state.frame.style.removeProperty('--content-max-width');
        resizer.style.translate = '';
        delete resizer.dataset.width;
        resizer.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing-content');
        if (resizer.hasPointerCapture(state.pointerId)) resizer.releasePointerCapture(state.pointerId);

        scheduleUpdate();
    }

    function paintDrag(timestamp) {
        const state = drag;
        state.previewFrame = 0;
        const width = Math.round(dragWidth(state, state.clientX));
        resizer.style.translate = `${(state.startWidth - width) / 2}px`;
        if (state.appliedWidth === width) return;

        // Keep pointer feedback at screen refresh rate and give the grid time between reflows.
        if (timestamp - state.lastLayout < LIVE_RESIZE_INTERVAL) {
            state.previewFrame = requestAnimationFrame(paintDrag);
            return;
        }
        state.frame.style.setProperty('--content-max-width', `${width}px`);
        state.lastLayout = timestamp;
        state.appliedWidth = width;
        resizer.dataset.width = `${width} px`;
    }

    resizer.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || drag || !activeFrame || resizer.hidden) return;
        event.preventDefault();
        const startWidth = activeFrame.getBoundingClientRect().width;
        drag = {
            frame: activeFrame,
            pointerId: event.pointerId,
            startX: event.clientX,
            clientX: event.clientX,
            startWidth,
            maxWidth: maxWidth(),
            previewFrame: 0,
            appliedWidth: Math.round(startWidth),
            lastLayout: -Infinity
        };
        resizer.dataset.width = `${Math.round(startWidth)} px`;
        resizer.classList.add('is-dragging');
        document.body.classList.add('is-resizing-content');
        resizer.setPointerCapture(event.pointerId);
    });

    resizer.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const state = drag;
        state.clientX = event.clientX;
        if (!state.previewFrame) state.previewFrame = requestAnimationFrame(paintDrag);
    });

    resizer.addEventListener('pointerup', (event) => {
        if (event.pointerId === drag?.pointerId) finishDrag(true, event.clientX);
    });
    for (const eventName of ['pointercancel', 'lostpointercapture']) {
        resizer.addEventListener(eventName, (event) => {
            if (event.pointerId === drag?.pointerId) finishDrag(false);
        });
    }
    window.addEventListener('blur', () => finishDrag(false));
    window.addEventListener(
        'keydown',
        (event) => {
            if (!drag || event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            finishDrag(false);
        },
        true
    );

    resizer.addEventListener('keydown', (event) => {
        if (drag) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        const frame = activeFrame;
        if (!frame) return;
        if (event.key === 'Home') {
            resetWidth();
            return;
        }
        const current = frame.getBoundingClientRect().width;
        setWidth(current + (event.key === 'ArrowLeft' ? 40 : -40));
    });

    resizer.addEventListener('dblclick', () => resetWidth());

    function updateBackToTop() {
        const scrolled = main.scrollTop > BACK_TO_TOP_THRESHOLD || window.scrollY > BACK_TO_TOP_THRESHOLD;
        backToTop.classList.toggle('is-visible', scrolled);
        backToTop.setAttribute('aria-hidden', String(!scrolled));
        backToTop.tabIndex = scrolled ? 0 : -1;
    }

    backToTop.addEventListener('click', () => {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const behavior = reduceMotion ? 'auto' : 'smooth';
        if (main.scrollHeight > main.clientHeight + 4 && main.scrollTop > 0) {
            main.scrollTo({ top: 0, behavior });
        } else {
            window.scrollTo({ top: 0, behavior });
        }
    });

    main.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('resize', () => {
        finishDrag(false);
        if (storedWidth !== null) {
            const clamped = Math.min(storedWidth, maxWidth());
            if (clamped !== storedWidth) {
                storedWidth = clamped;
                applyWidth(clamped);
                writeStoredWidth(clamped);
            }
        }
        updateBackToTop();
        scheduleUpdate();
    });

    // Only page activation and view visibility change which frame owns the handle.
    const observer = new MutationObserver(() => {
        if (drag && activeFrame !== visibleFrame()) finishDrag(false);
        scheduleUpdate();
    });
    for (const { page, view } of frames) {
        observer.observe(page, { attributes: true, attributeFilter: ['class'] });
        observer.observe(view, { attributes: true, attributeFilter: ['hidden'] });
    }
    new ResizeObserver(scheduleUpdate).observe(main);
    document.addEventListener('monochrome:language-changed', scheduleUpdate);

    updateResizer();
    updateBackToTop();
    scheduleUpdate();
}
