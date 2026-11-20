import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import { getCreationFacetCounts, queryCreationLibrary } from './creation-library-query.js';

const MEDIA_KEYS = {
    audio: 'audio',
    image: 'image',
    video: 'video',
    text: 'text',
    archive: 'archive',
    file: 'file',
    link: 'link'
};
/** A non-modal library filter panel. Content identity and filtering stay in the query module. */
export function createCreationLibraryFilters({ getPosts, getCreators, getOptions, onChange }) {
    const toggle = document.getElementById('creations-filter-toggle');
    const panel = document.getElementById('creations-filter-panel');
    const active = document.getElementById('creations-filter-active');
    const groups = panel.querySelector('.creation-filter-groups');
    const badge = document.getElementById('creations-filter-count');
    const clear = document.getElementById('creations-filter-clear');
    const close = document.getElementById('creations-filter-close');
    const playerBar = document.querySelector('.now-playing-bar');
    let open = false;
    let activeMarkup = '';
    // Portaling avoids clipping inside the scrolling content and keeps placement relative to the viewport.
    document.body.append(panel);

    const selected = () => {
        const options = getOptions();
        return {
            creator: new Set(options.creatorIds),
            tag: new Set(options.tags),
            media: new Set(options.media)
        };
    };
    const labels = () => new Map(getCreators().map((creator) => [creator.id, creator]));
    const label = (kind, value, creators) =>
        kind === 'creator'
            ? creators.get(value)?.name || value
            : kind === 'media'
              ? t(`creations.${MEDIA_KEYS[value] || 'file'}`)
              : value;
    const countSelected = (state) => Object.values(state).reduce((total, values) => total + values.size, 0);

    function position() {
        if (!open) return;
        const rect = toggle.getBoundingClientRect();
        const margin = 16;
        const width = Math.min(620, innerWidth - margin * 2);
        const player = playerBar?.getBoundingClientRect();
        const bottom =
            player?.height && player.top > margin
                ? Math.min(innerHeight - margin, player.top - 8)
                : innerHeight - margin;
        const top = Math.max(margin, Math.min(rect.bottom + 8, bottom - 220));
        panel.style.width = `${width}px`;
        panel.style.left = `${Math.max(margin, Math.min(rect.right - width, innerWidth - width - margin))}px`;
        panel.style.top = `${top}px`;
        panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    }

    function render() {
        const options = getOptions();
        const state = selected();
        const creators = labels();
        const count = countSelected(state);
        badge.textContent = String(count);
        badge.hidden = !count;
        toggle.classList.toggle('is-active', count > 0);
        toggle.setAttribute('aria-expanded', String(open));
        active.hidden = !count;
        const markup =
            Object.entries(state)
                .flatMap(([kind, values]) =>
                    [...values].map((value) => {
                        const name = label(kind, value, creators);
                        const creator = kind === 'creator' ? creators.get(value) : null;
                        const avatar = creator?.avatar
                            ? `<img class="creation-filter-chip-avatar" src="${escapeHtml(creator.avatar)}" alt="" referrerpolicy="no-referrer" />`
                            : '';
                        return `<button type="button" class="creation-filter-chip" data-kind="${kind}" data-value="${escapeHtml(value)}"
                aria-label="${escapeHtml(t('creations.filters.remove', { name }))}">${avatar}${escapeHtml(name)} <span aria-hidden="true">×</span></button>`;
                    })
                )
                .join('') +
            (count
                ? `<button type="button" class="creation-filter-reset" data-clear-filters>${escapeHtml(t('creations.filters.clear'))}</button>`
                : '');
        if (activeMarkup !== markup) {
            active.innerHTML = markup;
            activeMarkup = markup;
        }
        const reset = active.querySelector('[data-clear-filters]');
        if (reset) {
            // Reserve its space so opening the panel cannot move the grid below the chips.
            reset.style.visibility = open ? 'hidden' : '';
            reset.tabIndex = open ? -1 : 0;
        }
        clear.hidden = !count;
        panel.hidden = !open;
        if (!open) return;
        position();
        // Re-rendered options keep keyboard focus on the same choice after toggling it.
        const focused = groups.contains(document.activeElement)
            ? {
                  kind: document.activeElement.dataset.kind,
                  value: document.activeElement.dataset.value
              }
            : null;
        const counts = getCreationFacetCounts(getPosts(), options);
        const renderGroup = (kind, values) => {
            const filtered = values;
            if (kind === 'creator')
                filtered.sort((a, b) => label(kind, a.value, creators).localeCompare(label(kind, b.value, creators)));
            if (!filtered.length) return '';
            const heading = t(`creations.filters.${kind}`);
            return `<fieldset class="creation-filter-group"><legend>${escapeHtml(heading)}</legend><div class="creation-filter-options">${filtered
                .map(({ value, count: matches }) => {
                    const creator = creators.get(value);
                    const isSelected = state[kind].has(value);
                    const name = label(kind, value, creators);
                    const duplicateName =
                        kind === 'creator' && getCreators().some((other) => other.id !== value && other.name === name);
                    const disambiguation = duplicateName ? ` · ${creator.platform} / ${creator.sourceId}` : '';
                    return `<button type="button" class="creation-filter-option" data-kind="${kind}" data-value="${escapeHtml(value)}"
                    aria-pressed="${isSelected}"${matches === 0 && !isSelected ? ' disabled' : ''}>
                    ${creator ? `<img src="${escapeHtml(creator.avatar)}" alt="" referrerpolicy="no-referrer" />` : ''}
                    <span>${escapeHtml(name + disambiguation)}</span><em>${matches}</em></button>`;
                })
                .join('')}</div></fieldset>`;
        };
        groups.innerHTML =
            [
                renderGroup('creator', counts.creators),
                renderGroup('media', counts.media),
                renderGroup('tag', counts.tags)
            ].join('') || `<p class="creation-filter-empty">${escapeHtml(t('creations.filters.noOptions'))}</p>`;
        if (focused)
            [...groups.querySelectorAll('button')]
                .find((button) => button.dataset.kind === focused.kind && button.dataset.value === focused.value)
                ?.focus({ preventScroll: true });
        document.getElementById('creations-filter-summary').textContent = t('creations.library.results', {
            shown: queryCreationLibrary(getPosts(), options).length,
            total: getPosts().length
        });
    }

    function setOpen(value, restoreFocus = false) {
        open = value;
        render();
        if (value) close.focus({ preventScroll: true });
        else if (restoreFocus) toggle.focus({ preventScroll: true });
    }

    function change(kind, value) {
        const state = selected();
        if (!state[kind]) return;
        const chipFocused = active.contains(document.activeElement);
        if (state[kind].has(value)) state[kind].delete(value);
        else state[kind].add(value);
        onChange({ creatorIds: state.creator, tags: state.tag, media: state.media });
        if (chipFocused) (active.querySelector('button') || toggle).focus({ preventScroll: true });
    }

    function clearFilters() {
        onChange({ creatorIds: new Set(), tags: new Set(), media: new Set() });
        (open ? close : toggle).focus({ preventScroll: true });
    }

    toggle.addEventListener('click', () => setOpen(!open));
    close.addEventListener('click', () => setOpen(false, true));
    clear.addEventListener('click', clearFilters);
    groups.addEventListener('click', (event) => {
        const option = event.target.closest('button[data-kind]');
        if (option && !option.disabled) change(option.dataset.kind, option.dataset.value);
    });
    active.addEventListener('click', (event) => {
        const chip = event.target.closest('button[data-kind]');
        if (chip) change(chip.dataset.kind, chip.dataset.value);
        else if (event.target.closest('[data-clear-filters]')) clearFilters();
    });
    document.addEventListener('click', (event) => {
        // Options/chips are rebuilt during this same click; its original path survives detached targets.
        const path = event.composedPath();
        if (open && !path.includes(panel) && !path.includes(toggle) && !path.includes(active)) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false, true);
        }
    });
    panel.addEventListener('keydown', (event) => {
        // Player shortcuts must not interpret typing, Space or arrows inside this portaled panel.
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false, true);
        }
        event.stopPropagation();
    });
    window.addEventListener('resize', position);
    // A queued scroll event can arrive after the trigger opens the panel.
    document.querySelector('.main-content')?.addEventListener('scroll', position, { passive: true });
    window.addEventListener('scroll', position, { passive: true });
    if (playerBar) new ResizeObserver(position).observe(playerBar);
    window.addEventListener('popstate', () => setOpen(false));
    document.addEventListener('monochrome:language-changed', render);
    // showPage changes native/custom containers even without a popstate (e.g. player links).
    const observer = new MutationObserver(() => {
        if (
            !document.getElementById('page-creations').classList.contains('active') ||
            document.getElementById('creations-feed-view').hidden
        ) {
            if (open) setOpen(false);
        }
    });
    observer.observe(document.getElementById('page-creations'), { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.getElementById('creations-feed-view'), { attributes: true, attributeFilter: ['hidden'] });
    render();
    return { render, close: () => setOpen(false) };
}
