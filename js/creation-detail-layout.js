const defaultFileShare = 58;
const minFileShare = 30;
const maxFileShare = 75;

function mountSplitGrid(detail, signal) {
    const grid = detail.querySelector('[data-creation-split-grid]');
    const handle = grid?.querySelector('[data-creation-split-resizer]');
    if (!handle) return () => {};

    const styles = getComputedStyle(grid);
    const fileMinimum = Number.parseFloat(styles.getPropertyValue('--creation-file-min'));
    const introMinimum = Number.parseFloat(styles.getPropertyValue('--creation-intro-min'));
    const rtl = styles.direction === 'rtl';
    let share = defaultFileShare;
    let pointerId;
    let pointerOffset = 0;

    function limits() {
        const width = grid.clientWidth - handle.offsetWidth;
        return {
            width,
            min: Math.max(minFileShare, Math.ceil((fileMinimum / width) * 100)),
            max: Math.min(maxFileShare, Math.floor(100 - (introMinimum / width) * 100)),
        };
    }

    function setShare(value, { min, max } = limits()) {
        // Keep the requested ratio when a narrower viewport temporarily hits a column floor.
        share = value;
        if (min > max || !handle.offsetWidth) return;
        const effective = Math.min(max, Math.max(min, value));
        grid.style.setProperty('--creation-file-share', String(effective / 100));
        handle.setAttribute('aria-valuemin', String(min));
        handle.setAttribute('aria-valuemax', String(max));
        handle.setAttribute('aria-valuenow', String(effective));
    }

    function stopDrag() {
        if (pointerId === undefined) return;
        const capturedId = pointerId;
        pointerId = undefined;
        grid.classList.remove('is-dragging-split');
        handle.classList.remove('is-dragging');
        if (handle.hasPointerCapture(capturedId)) handle.releasePointerCapture(capturedId);
    }

    handle.addEventListener(
        'pointerdown',
        (event) => {
            if (event.button !== 0 || pointerId !== undefined) return;
            event.preventDefault();
            handle.focus({ preventScroll: true });
            handle.setPointerCapture(event.pointerId);
            const rect = handle.getBoundingClientRect();
            pointerOffset = event.clientX - (rect.left + rect.width / 2);
            pointerId = event.pointerId;
            grid.classList.add('is-dragging-split');
            handle.classList.add('is-dragging');
        },
        { signal }
    );
    handle.addEventListener(
        'pointermove',
        (event) => {
            if (event.pointerId !== pointerId) return;
            const bounds = limits();
            const gridRect = grid.getBoundingClientRect();
            const center = event.clientX - pointerOffset;
            const fromStart = rtl ? gridRect.right - center : center - gridRect.left;
            const value = Math.round(((fromStart - handle.offsetWidth / 2) / bounds.width) * 100);
            setShare(Math.min(bounds.max, Math.max(bounds.min, value)), bounds);
        },
        { signal }
    );
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(
            type,
            (event) => {
                if (event.pointerId === pointerId) stopDrag();
            },
            { signal }
        );
    }
    handle.addEventListener('dblclick', () => setShare(defaultFileShare), { signal });
    handle.addEventListener(
        'keydown',
        (event) => {
            const bounds = limits();
            const current = Number(handle.getAttribute('aria-valuenow'));
            const step = (event.shiftKey ? 10 : 2) * (rtl ? -1 : 1);
            const values = {
                ArrowLeft: current - step,
                ArrowRight: current + step,
                Home: bounds.min,
                End: bounds.max,
                Enter: defaultFileShare,
            };
            if (!Object.hasOwn(values, event.key)) return;
            event.preventDefault();
            setShare(Math.min(bounds.max, Math.max(bounds.min, values[event.key])), bounds);
        },
        { signal }
    );

    const resizeObserver = new ResizeObserver(() => {
        if (!handle.offsetWidth) stopDrag();
        setShare(share);
    });
    resizeObserver.observe(grid);
    setShare(share);
    return () => {
        resizeObserver.disconnect();
        stopDrag();
    };
}

function mountThumbnailPreview(detail, signal) {
    let trigger;
    let card;
    const root = document.documentElement;

    function canPreview(image) {
        if (
            detail.dataset.adult === 'true' &&
            root.matches('.blur-adult-creation-detail-content, .blur-adult-creation-detail-cover')
        ) {
            return false;
        }
        // A fixed preview lives outside the detail, so it cannot inherit filters from the thumbnail.
        for (let element = image; element && element !== detail; element = element.parentElement) {
            if (getComputedStyle(element).filter.includes('blur(')) return false;
        }
        return true;
    }

    const observer = new MutationObserver(hide);

    function hide() {
        observer.disconnect();
        card?.remove();
        card = undefined;
        trigger = undefined;
    }

    function position(event) {
        if (!card) return;
        const { clientWidth, clientHeight } = root;
        const gap = 12;
        const right = clientWidth - card.offsetWidth - gap;
        const bottom = clientHeight - card.offsetHeight - gap;
        const preferredX =
            event.clientX + card.offsetWidth + 18 <= clientWidth - gap
                ? event.clientX + 18
                : event.clientX - card.offsetWidth - 18;
        card.style.left = `${Math.max(gap, Math.min(right, preferredX))}px`;
        card.style.top = `${Math.max(gap, Math.min(bottom, event.clientY - 60))}px`;
    }

    detail.addEventListener(
        'pointerover',
        (event) => {
            if (event.pointerType === 'touch') return;
            const next = event.target.closest('[data-creation-thumb]');
            if (!next || next === trigger) return;
            hide();
            const image = next.querySelector('img');
            const source = image?.currentSrc || image?.getAttribute('src');
            if (!source || !canPreview(image)) return;

            trigger = next;
            card = document.createElement('div');
            card.className = 'creation-thumb-hover-card';
            card.setAttribute('aria-hidden', 'true');
            const preview = document.createElement('img');
            preview.alt = '';
            preview.referrerPolicy = image.referrerPolicy;
            preview.src = source;
            card.append(preview);
            const title = next.dataset.creationThumbTitle || image.alt;
            if (title) {
                const caption = document.createElement('div');
                caption.textContent = title;
                card.append(caption);
            }
            document.body.append(card);
            position(event);
            // In-place tree updates and preference changes can happen while the pointer stays still.
            observer.observe(detail, { childList: true, subtree: true });
            observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        },
        { signal }
    );
    detail.addEventListener('pointermove', position, { signal });
    detail.addEventListener(
        'pointerout',
        (event) => {
            if (trigger && !trigger.contains(event.relatedTarget)) hide();
        },
        { signal }
    );
    detail.addEventListener('pointerleave', hide, { signal });
    detail.addEventListener('click', hide, { capture: true, signal });
    window.addEventListener('scroll', hide, { capture: true, signal });
    window.addEventListener('resize', hide, { signal });
    window.addEventListener('blur', hide, { signal });
    return hide;
}

export function mountCreationDetailLayout(detail) {
    const controller = new AbortController();
    const disposeSplit = mountSplitGrid(detail, controller.signal);
    const disposePreview = mountThumbnailPreview(detail, controller.signal);
    return () => {
        controller.abort();
        disposeSplit();
        disposePreview();
    };
}
