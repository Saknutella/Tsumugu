// Fullscreen subtitle view.
//
// The immersive pane is shared with lyrics so voice subtitle playback keeps the
// same visual language as music. This module only owns the cue timeline and the
// subtitle-specific list; lyric fetching remains untouched.
import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import { loadSubtitleCues } from './voice-subtitles.js';

function activeCueIndex(cues, time) {
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const cue = cues[middle];
        if (time < cue.start) high = middle - 1;
        else if (time >= cue.end) low = middle + 1;
        else return middle;
    }
    return -1;
}

function scrollActiveLine(view, line, behavior = 'smooth') {
    if (!view || !line) return;
    const viewRect = view.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const target = view.scrollTop + lineRect.top - viewRect.top - (viewRect.height - lineRect.height) / 2;
    view.scrollTo({ top: Math.max(0, target), behavior });
}

/**
 * Render subtitle cues into #fullscreen-lyrics-content.
 *
 * Returns false only when the track has no subtitle metadata, so the caller can
 * fall back to the normal lyrics path. A subtitle that fails to load still owns
 * the pane and renders an explicit error instead of silently showing lyrics.
 */
export async function renderFullscreenSubtitles(track, audioPlayer, container) {
    if (!track?.subtitle || !container) return false;
    const subtitle = track.subtitle;
    container.classList.add('is-subtitle-view');
    container.innerHTML = `<div class="fullscreen-subtitle-loading">${escapeHtml(t('player.subtitleLoading'))}</div>`;

    let cues;
    try {
        cues = await loadSubtitleCues(subtitle);
    } catch (error) {
        console.warn('Failed to load subtitles:', error);
        container.innerHTML = `<div class="fullscreen-subtitle-empty">${escapeHtml(t('player.subtitleError'))}</div>`;
        container.classList.remove('is-subtitle-view');
        container.lyricsCleanup = () => {
            container.classList.remove('is-subtitle-view');
            if (container.querySelector('.fullscreen-subtitle-empty')) container.replaceChildren();
        };
        return true;
    }

    if (!cues.length) {
        container.innerHTML = `<div class="fullscreen-subtitle-empty">${escapeHtml(t('player.subtitleEmpty'))}</div>`;
        container.classList.remove('is-subtitle-view');
        container.lyricsCleanup = () => {
            container.classList.remove('is-subtitle-view');
            if (container.querySelector('.fullscreen-subtitle-empty')) container.replaceChildren();
        };
        return true;
    }

    const view = document.createElement('div');
    view.className = 'fullscreen-subtitle-view';
    view.tabIndex = 0;
    const kicker = document.createElement('div');
    kicker.className = 'fullscreen-subtitle-kicker';
    kicker.textContent = `${t('voices.subtitle.badge')} · ${String(subtitle.format || '').toUpperCase()}`;
    const lines = document.createElement('div');
    lines.className = 'fullscreen-subtitle-lines';
    const lineElements = cues.map((cue) => {
        const line = document.createElement('div');
        line.className = 'fullscreen-subtitle-line';
        line.dataset.start = String(cue.start);
        line.dataset.end = String(cue.end);
        line.textContent = cue.text;
        lines.appendChild(line);
        return line;
    });
    view.append(kicker, lines);
    container.replaceChildren(view);

    let activeIndex = -1;
    let manualUntil = 0;
    let manualTimer = null;
    let drag = null;
    let suppressClickUntil = 0;
    let settleTimer = null;
    let settleDirection = 1;
    let momentumFrame = null;
    let snapScrollTimer = null;
    let snapScrollHandler = null;

    const bounce = () => {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        view.getAnimations().forEach((animation) => animation.cancel());
        const offset = settleDirection < 0 ? -2.5 : 2.5;
        view.animate(
            [
                { transform: 'translateY(0)' },
                { transform: `translateY(${offset}px)` },
                { transform: 'translateY(0)' },
            ],
            { duration: 190, easing: 'cubic-bezier(.22, 1.15, .36, 1)' }
        );
    };

    const scheduleBounce = (direction = 1, delay = 120) => {
        settleDirection = direction < 0 ? -1 : 1;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            settleTimer = null;
            if (!drag) bounce();
        }, delay);
    };

    const stopMomentum = () => {
        if (momentumFrame) cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
    };

    const startMomentum = (velocity) => {
        stopMomentum();
        let speed = Math.max(-2.8, Math.min(2.8, Number(velocity) || 0));
        if (Math.abs(speed) < 0.02) return;
        let lastTime = performance.now();
        const step = (now) => {
            const dt = Math.min(32, Math.max(1, now - lastTime));
            lastTime = now;
            const maxScroll = Math.max(0, view.scrollHeight - view.clientHeight);
            const next = Math.max(0, Math.min(maxScroll, view.scrollTop + speed * dt));
            view.scrollTop = next;
            speed *= Math.pow(0.94, dt / 16);
            if (Math.abs(speed) > 0.025 && next > 0 && next < maxScroll) {
                momentumFrame = requestAnimationFrame(step);
            } else {
                momentumFrame = null;
            }
        };
        momentumFrame = requestAnimationFrame(step);
    };

    const scheduleBounceAfterScroll = () => {
        if (snapScrollTimer) clearTimeout(snapScrollTimer);
        if (snapScrollHandler) view.removeEventListener('scrollend', snapScrollHandler);
        const finish = () => {
            if (snapScrollTimer) clearTimeout(snapScrollTimer);
            snapScrollTimer = null;
            if (snapScrollHandler) view.removeEventListener('scrollend', snapScrollHandler);
            snapScrollHandler = null;
            scheduleBounce(1, 0);
        };
        snapScrollHandler = finish;
        // Chrome fires scrollend after the smooth centering finishes; the timer
        // is a fallback for engines that do not expose it.
        view.addEventListener('scrollend', finish, { once: true });
        snapScrollTimer = setTimeout(finish, 700);
    };

    const markManual = () => {
        manualUntil = performance.now() + 1200;
        if (manualTimer) clearTimeout(manualTimer);
        manualTimer = setTimeout(() => {
            manualTimer = null;
            manualUntil = 0;
            if (activeIndex >= 0) scrollActiveLine(view, lineElements[activeIndex]);
        }, 1200);
    };

    const sync = () => {
        const time = Number(audioPlayer?.currentTime);
        const nextIndex = Number.isFinite(time) ? activeCueIndex(cues, time) : -1;
        if (nextIndex === activeIndex) return;
        activeIndex = nextIndex;
        lineElements.forEach((line, index) => {
            line.classList.toggle('is-active', index === activeIndex);
            line.classList.toggle('is-past', index < activeIndex);
        });
        if (activeIndex >= 0 && performance.now() >= manualUntil) {
            scrollActiveLine(view, lineElements[activeIndex]);
        }
    };

    const seekToLine = (line) => {
        if (!line || !audioPlayer) return;
        const start = Number(line.dataset.start);
        if (!Number.isFinite(start)) return;
        audioPlayer.currentTime = start;
        audioPlayer.dispatchEvent(new Event('seeked'));
        // A click is not a manual scroll gesture: cancel its auto-center timer
        // so the active line is not re-scrolled again 1.2s later. Snap instantly
        // and add only the deliberate rebound; running a smooth scroll under the
        // rebound made a second visible wobble.
        if (manualTimer) {
            clearTimeout(manualTimer);
            manualTimer = null;
        }
        manualUntil = performance.now() + 1;
        sync();
        manualUntil = 0;
        scrollActiveLine(view, line);
        scheduleBounceAfterScroll();
    };

    // Clicking a subtitle line is the same gesture as clicking a lyric line:
    // seek the underlying audio without changing play/pause state.
    lines.addEventListener('click', (event) => {
        if (performance.now() < suppressClickUntil) return;
        const line = event.target.closest('.fullscreen-subtitle-line');
        if (line) seekToLine(line);
    });

    // Native touchpad/mouse wheel scrolling. Mark it manual briefly so the next
    // cue does not yank the list away while the user is reading.
    view.addEventListener('wheel', markManual, { passive: true });
    view.addEventListener('touchstart', markManual, { passive: true });
    view.addEventListener(
        'pointerdown',
        (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            stopMomentum();
            drag = {
                y: event.clientY,
                scrollTop: view.scrollTop,
                lastScrollTop: view.scrollTop,
                lastTime: performance.now(),
                velocity: 0,
                moved: false,
                captured: false,
                pointerId: event.pointerId,
            };
        },
        { passive: true }
    );
    view.addEventListener(
        'pointermove',
        (event) => {
            if (!drag) return;
            const delta = event.clientY - drag.y;
            if (Math.abs(delta) > 4) {
                if (!drag.moved) markManual();
                drag.moved = true;
                // Capture only after the gesture becomes a drag. Capturing on
                // pointerdown retargets the click at the view, which would break
                // clicking a subtitle line to seek.
                if (!drag.captured) {
                    try {
                        view.setPointerCapture?.(event.pointerId);
                        drag.captured = true;
                    } catch {
                        /* Pointer capture is an enhancement, not required for drag. */
                    }
                }
                view.scrollTop = drag.scrollTop - delta;
                const now = performance.now();
                const dt = Math.max(1, now - drag.lastTime);
                drag.velocity = (view.scrollTop - drag.lastScrollTop) / dt;
                drag.lastScrollTop = view.scrollTop;
                drag.lastTime = now;
                view.classList.add('is-dragging');
                event.preventDefault();
            }
        },
        { passive: false }
    );
    const endDrag = () => {
        if (!drag) return;
        if (drag.moved) {
            suppressClickUntil = performance.now() + 220;
            startMomentum(drag.velocity);
        }
        if (drag.captured && view.hasPointerCapture?.(drag.pointerId)) {
            try {
                view.releasePointerCapture(drag.pointerId);
            } catch {
                /* already released */
            }
        }
        drag = null;
        view.classList.remove('is-dragging');
    };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    // Pointer capture normally keeps pointerup on the view; listening on the
    // window covers browsers that release capture before dispatching it.
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    audioPlayer?.addEventListener('timeupdate', sync);
    audioPlayer?.addEventListener('seeked', sync);
    audioPlayer?.addEventListener('ratechange', sync);
    const interval = window.setInterval(sync, 120);
    sync();

    container.lyricsCleanup = () => {
        window.clearInterval(interval);
        if (manualTimer) clearTimeout(manualTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (snapScrollTimer) clearTimeout(snapScrollTimer);
        if (snapScrollHandler) view.removeEventListener('scrollend', snapScrollHandler);
        stopMomentum();
        view.getAnimations().forEach((animation) => animation.cancel());
        audioPlayer?.removeEventListener('timeupdate', sync);
        audioPlayer?.removeEventListener('seeked', sync);
        audioPlayer?.removeEventListener('ratechange', sync);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
        container.classList.remove('is-subtitle-view');
        if (container.contains(view)) container.replaceChildren();
    };
    return true;
}
