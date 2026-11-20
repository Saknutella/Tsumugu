import { t } from './i18n.js';
import { getVoiceFileType } from './voice-file-types.js';
import { renderMarkdown } from './markdown.js';
import '../voice-attachment-viewer.css';

const label = (key, fallback) => t(`voiceViewer.${key}`, { defaultValue: fallback });

// Only passive image data is accepted: SVG data URLs can contain active content.
function safeUrl(value, image = false) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value, window.location.href);
        if (['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
        if (image && /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/i.test(value)) return value;
    } catch { /* Invalid metadata must not become a navigation target. */ }
    return '';
}

export function createVoiceAttachmentViewer({ loadText, onVideoPlay }) {
    let overlay;
    let previousFocus;
    let previousOverflow;
    let controller;
    let generation = 0;
    let current;
    let siblings = [];
    let renderCleanup;
    let disposed = false;

    function releaseContent() {
        renderCleanup?.();
        renderCleanup = null;
        const image = overlay?.querySelector('img');
        if (image) image.removeAttribute('src');
        const video = overlay?.querySelector('video');
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        overlay?.querySelector('object')?.removeAttribute('data');
    }

    function close() {
        generation++;
        controller?.abort();
        controller = null;
        if (!overlay) return;
        releaseContent();
        overlay.remove();
        overlay = null;
        document.body.style.overflow = previousOverflow;
        document.removeEventListener('keydown', onKey, true);
        if (previousFocus?.isConnected) previousFocus.focus();
        current = null;
        siblings = [];
    }

    function button(parent, text, action) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'btn btn-secondary';
        element.textContent = text;
        element.addEventListener('click', action);
        parent.append(element);
        return element;
    }

    function link(parent, text, url, download = false) {
        if (!url) return;
        const element = document.createElement('a');
        element.className = 'btn btn-secondary';
        element.textContent = text;
        element.href = url;
        element.target = '_blank';
        element.rel = 'noopener noreferrer';
        if (download) element.download = current.title || '';
        parent.append(element);
    }

    function navigate(direction) {
        if (getVoiceFileType(current) !== 'image' || siblings.length < 2) return;
        const index = siblings.indexOf(current);
        current = siblings[(Math.max(index, 0) + direction + siblings.length) % siblings.length];
        render();
    }

    function onKey(event) {
        // Capture before the player's document shortcuts without cancelling native
        // copy, selection, scrolling or keyboard activation of modal buttons.
        event.stopImmediatePropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
        } else if (event.key === 'Tab') {
            const focusable = [...overlay.querySelectorAll('button:not([disabled]), a[href], video[controls], object')]
                .filter((element) => !element.closest('[hidden]'));
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
                event.preventDefault();
                first?.focus();
            }
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            if (getVoiceFileType(current) === 'image') {
                event.preventDefault();
                navigate(event.key === 'ArrowLeft' ? -1 : 1);
            }
        }
    }

    async function render() {
        const ticket = ++generation;
        controller?.abort();
        controller = new AbortController();
        releaseContent();
        overlay.replaceChildren();
        const dialog = document.createElement('section');
        dialog.className = 'voice-attachment-dialog';
        const kind = getVoiceFileType(current);
        dialog.dataset.kind = kind;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', current.title || label('title', 'Attachment'));
        overlay.append(dialog);
        const header = document.createElement('header');
        header.className = 'voice-attachment-header';
        const title = document.createElement('h2');
        title.textContent = current.title || label('title', 'Attachment');
        header.append(title);
        const closeButton = button(header, label('close', 'Close'), close);
        dialog.append(header);
        const toolbar = document.createElement('div');
        toolbar.className = 'voice-attachment-toolbar';
        dialog.append(toolbar);
        const source = safeUrl(current.localMediaStreamUrl || current.mediaStreamUrl || current.mediaDownloadUrl, kind === 'image');
        const download = safeUrl(current.localMediaDownloadUrl || current.localMediaStreamUrl || current.mediaDownloadUrl || current.mediaStreamUrl, kind === 'image');
        link(toolbar, label('download', 'Download'), download, true);
        link(toolbar, label('openOriginal', 'Open original file'), source);
        const content = document.createElement('div');
        content.className = 'voice-attachment-content';
        dialog.append(content);
        const status = document.createElement('p');
        status.className = 'voice-attachment-status';
        status.setAttribute('role', 'status');
        content.append(status);
        closeButton.focus();

        function failed() {
            if (ticket !== generation || !overlay) return;
            status.textContent = label('error', 'This file could not be previewed. You can retry or open the original file.');
            button(content, label('retry', 'Retry'), render);
        }

        if (kind === 'image' && source) {
            if (siblings.length > 1) {
                button(toolbar, label('previous', 'Previous image'), () => navigate(-1));
                button(toolbar, label('next', 'Next image'), () => navigate(1));
                const position = document.createElement('span');
                position.textContent = `${siblings.indexOf(current) + 1} / ${siblings.length}`;
                toolbar.append(position);
            }
            const image = document.createElement('img');
            image.alt = current.title || '';
            image.referrerPolicy = 'no-referrer';
            image.draggable = false;
            const hint = document.createElement('p');
            hint.className = 'voice-attachment-hint';
            hint.textContent = label('imageHint', 'Scroll to zoom; hold the left mouse button to pan.');
            content.append(hint);
            const viewport = document.createElement('div');
            viewport.className = 'voice-image-viewport';
            viewport.append(image);
            content.append(viewport);
            const scaleLabel = document.createElement('span');
            scaleLabel.className = 'voice-image-zoom';
            scaleLabel.setAttribute('aria-live', 'polite');
            let zoom = 1;
            let baseWidth = 0;
            let baseHeight = 0;
            let x = 0;
            let y = 0;
            let drag;
            let moved = false;
            function paint() {
                // Keep at least the viewport covered on a zoomed axis; a smaller image remains centered.
                const clamp = (offset, size, available) => size <= available
                    ? (available - size) / 2 : Math.max(available - size, Math.min(0, offset));
                x = clamp(x, baseWidth * zoom, viewport.clientWidth);
                y = clamp(y, baseHeight * zoom, viewport.clientHeight);
                image.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
                image.classList.toggle('is-zoomed', zoom > 1);
                viewport.dataset.zoom = String(zoom);
                scaleLabel.textContent = `${Math.round(zoom * 100)}%`;
            }
            function fit() {
                if (!image.naturalWidth) return;
                const ratio = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight, 1);
                baseWidth = image.naturalWidth * ratio;
                baseHeight = image.naturalHeight * ratio;
                image.style.width = `${baseWidth}px`;
                image.style.height = `${baseHeight}px`;
                zoom = 1;
                x = (viewport.clientWidth - baseWidth) / 2;
                y = (viewport.clientHeight - baseHeight) / 2;
                paint();
            }
            function setZoom(value, px = viewport.clientWidth / 2, py = viewport.clientHeight / 2) {
                if (!baseWidth) return;
                const next = Math.max(0.25, Math.min(8, value));
                // Preserve the image coordinate below the pointer, independent of the scroll container.
                x = px - (px - x) * next / zoom;
                y = py - (py - y) * next / zoom;
                zoom = next;
                paint();
            }
            button(toolbar, label('zoomOut', 'Zoom out'), () => setZoom(zoom / 1.25));
            button(toolbar, label('zoomIn', 'Zoom in'), () => setZoom(zoom * 1.25));
            button(toolbar, label('fit', 'Fit to window'), fit);
            toolbar.append(scaleLabel);
            viewport.addEventListener('wheel', (event) => {
                event.preventDefault();
                const rect = viewport.getBoundingClientRect();
                const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
                setZoom(zoom * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), event.clientX - rect.left, event.clientY - rect.top);
            }, { passive: false });
            viewport.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || !baseWidth) return;
                event.preventDefault();
                moved = false;
                drag = { id: event.pointerId, px: event.clientX, py: event.clientY, x, y };
                viewport.setPointerCapture(event.pointerId);
                viewport.classList.add('is-dragging');
            });
            viewport.addEventListener('pointermove', (event) => {
                if (!drag || drag.id !== event.pointerId) return;
                if (Math.hypot(event.clientX - drag.px, event.clientY - drag.py) > 3) moved = true;
                x = drag.x + event.clientX - drag.px;
                y = drag.y + event.clientY - drag.py;
                paint();
            });
            const endDrag = () => { drag = null; viewport.classList.remove('is-dragging'); };
            viewport.addEventListener('pointerup', endDrag);
            viewport.addEventListener('pointercancel', endDrag);
            viewport.addEventListener('lostpointercapture', endDrag);
            viewport.addEventListener('click', (event) => {
                // A completed pan also emits click; preserve the old click-to-zoom only for a still pointer.
                if (moved) { moved = false; return; }
                const rect = viewport.getBoundingClientRect();
                setZoom(zoom > 1 ? 1 : 2, event.clientX - rect.left, event.clientY - rect.top);
            });
            const observer = new ResizeObserver(fit);
            observer.observe(viewport);
            renderCleanup = () => observer.disconnect();
            status.textContent = label('loading', 'Loading…');
            image.addEventListener('load', () => {
                if (ticket === generation) { status.textContent = ''; fit(); }
            });
            image.addEventListener('error', failed, { once: true });
            image.src = source;
        } else if (kind === 'text' && source) {
            status.textContent = label('loading', 'Loading…');
            try {
                const result = await loadText(source, { signal: controller.signal, node: current });
                if (ticket !== generation || !overlay) return;
                const text = typeof result === 'string' ? result : result.text;
                const pre = document.createElement('pre');
                pre.textContent = text;
                content.append(pre);
                const article = document.createElement('article');
                article.className = 'voice-attachment-markdown';
                article.hidden = true;
                content.append(article);
                let formatted = false;
                const modes = {};
                function showMode(mode) {
                    if (mode === 'markdown' && !formatted) {
                        article.innerHTML = renderMarkdown(text);
                        formatted = true;
                    }
                    pre.hidden = mode !== 'source';
                    article.hidden = mode !== 'markdown';
                    for (const [name, control] of Object.entries(modes)) control.setAttribute('aria-pressed', String(name === mode));
                }
                for (const [mode, key, fallback] of [['source', 'sourceText', 'Plain text'], ['markdown', 'markdown', 'Markdown']]) {
                    modes[mode] = button(toolbar, label(key, fallback), () => showMode(mode));
                    modes[mode].dataset.voiceTextMode = mode;
                }
                showMode(/\.(?:md|markdown)$/i.test(current.title || '') ? 'markdown' : 'source');
                status.textContent = typeof result === 'object' && result.encoding ? result.encoding : '';
                const copyButton = button(toolbar, label('copy', 'Copy text'), async () => {
                    try {
                        await navigator.clipboard.writeText(text);
                        if (ticket === generation) copyButton.textContent = label('copied', 'Copied');
                    } catch {
                        if (ticket === generation) status.textContent = label('copyError', 'Copy failed. Select the text and copy it manually.');
                    }
                });
            } catch (error) {
                if (error?.name !== 'AbortError') failed();
            }
        } else if (kind === 'video' && source) {
            const video = document.createElement('video');
            video.controls = true;
            video.preload = 'metadata';
            video.playsInline = true;
            video.setAttribute('aria-label', current.title || label('title', 'Attachment'));
            video.addEventListener('play', () => onVideoPlay?.());
            video.addEventListener('error', failed, { once: true });
            video.src = source;
            content.append(video);
            status.textContent = label('videoHint', 'Use the video controls to play. If the format is unsupported, open or download the original file.');
        } else if (kind === 'pdf' && source) {
            const pdf = document.createElement('object');
            pdf.type = 'application/pdf';
            pdf.data = source;
            pdf.setAttribute('aria-label', current.title || 'PDF');
            pdf.tabIndex = 0;
            const fallback = document.createElement('p');
            fallback.textContent = label('pdfFallback', 'PDF preview is unavailable in this browser. Use Open original file or Download.');
            pdf.append(fallback);
            content.append(pdf);
            // Cross-origin plugins do not reliably report success; keep an honest fallback outside the embed.
            status.textContent = label('pdfHint', 'Uses your browser’s PDF reader. If it remains blank, open or download the original file.');
        } else {
            status.textContent = label('unsupported', 'Preview is unavailable for this file. Open or download the original file.');
        }
    }

    function open({ node, images = [] }) {
        if (disposed || !node) return;
        close();
        previousFocus = document.activeElement;
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        current = node;
        siblings = images.filter((item) => getVoiceFileType(item) === 'image');
        const match = siblings.find((item) => item === node || (node.hash && item.hash === node.hash));
        if (getVoiceFileType(node) === 'image') {
            if (match) current = match;
            else siblings = [node];
        }
        overlay = document.createElement('div');
        overlay.className = 'voice-attachment-overlay';
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        document.body.append(overlay);
        document.addEventListener('keydown', onKey, true);
        render();
    }

    return { open, close, dispose() { close(); disposed = true; } };
}
