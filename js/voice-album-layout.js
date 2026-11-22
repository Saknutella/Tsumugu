// Voice album split: track list on the left, "more works" on the right.
// Mirrors the creation detail splitter so both detail pages resize with the
// same pointer/keyboard contract; the column ratio is intentionally session
// local (no storage) to avoid another preference key.
import { t } from './i18n.js';

const defaultShare = 66;
const minShare = 35;
const maxShare = 80;

function clampShare(value, bounds) {
    return Math.min(bounds.max, Math.max(bounds.min, value));
}

export function mountVoiceAlbumSplit(layout, signal) {
    const more = layout?.querySelector('.voice-album-more');
    const tracklist = layout?.querySelector('#album-detail-tracklist');
    if (!more || !tracklist) return () => {};

    let handle = layout.querySelector('[data-voice-split-resizer]');
    if (!handle) {
        handle = document.createElement('div');
        handle.className = 'voice-album-split-resizer';
        handle.dataset.voiceSplitResizer = '';
        handle.tabIndex = 0;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', t('voices.resizeColumns'));
        handle.title = t('voices.resizeColumns');
        handle.innerHTML = '<span class="voice-album-split-resizer-pill" aria-hidden="true"></span>';
        more.before(handle);
    }

    let pointerId;
    let pointerOffset = 0;
    let share = defaultShare;

    function limits() {
        const width = layout.clientWidth - handle.offsetWidth;
        const trackMinimum = Number.parseFloat(getComputedStyle(layout).getPropertyValue('--voice-track-min')) || 420;
        const moreMinimum = Number.parseFloat(getComputedStyle(layout).getPropertyValue('--voice-more-min')) || 280;
        return {
            width,
            min: Math.max(minShare, Math.ceil((trackMinimum / width) * 100)),
            max: Math.min(maxShare, Math.floor(100 - (moreMinimum / width) * 100)),
        };
    }

    function setShare(value, bounds = limits()) {
        share = value;
        if (bounds.min > bounds.max || !handle.offsetWidth) return;
        const effective = Math.round(clampShare(value, bounds));
        layout.style.setProperty('--voice-track-share', String(effective / 100));
        handle.setAttribute('aria-valuemin', String(bounds.min));
        handle.setAttribute('aria-valuemax', String(bounds.max));
        handle.setAttribute('aria-valuenow', String(effective));
    }

    function stopDrag() {
        if (pointerId === undefined) return;
        const capturedId = pointerId;
        pointerId = undefined;
        layout.classList.remove('is-dragging-split');
        handle.classList.remove('is-dragging');
        if (handle.hasPointerCapture?.(capturedId)) handle.releasePointerCapture(capturedId);
    }

    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || pointerId !== undefined) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        const rect = handle.getBoundingClientRect();
        pointerOffset = event.clientX - (rect.left + rect.width / 2);
        pointerId = event.pointerId;
        layout.classList.add('is-dragging-split');
        handle.classList.add('is-dragging');
    }, { signal });

    handle.addEventListener('pointermove', (event) => {
        if (event.pointerId !== pointerId) return;
        const bounds = limits();
        const rect = layout.getBoundingClientRect();
        const rtl = getComputedStyle(layout).direction === 'rtl';
        const center = event.clientX - pointerOffset;
        const fromStart = rtl ? rect.right - center : center - rect.left;
        const value = Math.round(((fromStart - handle.offsetWidth / 2) / bounds.width) * 100);
        setShare(clampShare(value, bounds), bounds);
    }, { signal });

    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(type, (event) => {
            if (event.pointerId === pointerId) stopDrag();
        }, { signal });
    }

    handle.addEventListener('dblclick', () => setShare(defaultShare), { signal });
    handle.addEventListener('keydown', (event) => {
        const bounds = limits();
        const current = Number(handle.getAttribute('aria-valuenow')) || defaultShare;
        const step = event.shiftKey ? 10 : 2;
        const values = {
            ArrowLeft: current - step,
            ArrowRight: current + step,
            Home: bounds.min,
            End: bounds.max,
            Enter: defaultShare,
        };
        if (!Object.hasOwn(values, event.key)) return;
        event.preventDefault();
        setShare(values[event.key], bounds);
    }, { signal });

    const observer = new ResizeObserver(() => {
        if (!handle.offsetWidth) stopDrag();
        setShare(share);
    });
    observer.observe(layout);
    setShare(share);

    return () => {
        observer.disconnect();
        stopDrag();
        handle.remove();
        layout.classList.remove('is-dragging-split');
        layout.style.removeProperty('--voice-track-share');
    };
}
