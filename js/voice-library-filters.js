import { t } from './i18n.js';
import { escapeHtml } from './utils.js';

const PANEL_ID = 'voices-filter-panel';
const ACTIVE_ID = 'voices-filter-bar';

/**
 * Voice library filter popover, modelled after the creation library filter:
 * portaled panel, contextual counts, external active chips, one clear action
 * and explicit focus handling. Filter state stays in voices.js.
 */
export function createVoiceLibraryFilters({
    getFacets,
    getSelected,
    getLabel,
    getResultCount,
    onToggle,
    onClear,
}) {
    const toggle = document.getElementById('voices-filter-toggle');
    const panel = document.getElementById(PANEL_ID);
    const active = document.getElementById(ACTIVE_ID);
    const groups = document.getElementById('voices-filter-panel-groups');
    const badge = document.getElementById('voices-filter-count');
    const clear = document.getElementById('voices-clear-filters');
    const summary = document.getElementById('voices-filter-summary');
    const closeButton = document.getElementById('voices-filter-close');
    if (!toggle || !panel || !active || !groups || !badge || !clear || !summary || !closeButton) {
        return { render() {}, close() {} };
    }

    let open = false;
    let activeMarkup = '';
    let panelMarkup = '';
    document.body.append(panel);

    const selected = () => getSelected();

    function position() {
        if (!open) return;
        const rect = toggle.getBoundingClientRect();
        const margin = 16;
        const width = Math.min(620, innerWidth - margin * 2);
        const top = Math.max(margin, Math.min(rect.bottom + 8, innerHeight - 200));
        panel.style.width = `${width}px`;
        panel.style.left = `${Math.max(margin, Math.min(rect.right - width, innerWidth - width - margin))}px`;
        panel.style.top = `${top}px`;
        panel.style.maxHeight = `${Math.max(160, innerHeight - top - margin)}px`;
    }

    function renderActive(chips) {
        const count = chips.length;
        active.hidden = count === 0;
        const markup =
            chips
                .map(
                    ({ kind, value, label }) => `<button type="button" class="creation-filter-chip voice-filter-chip" data-kind="${escapeHtml(kind)}" data-value="${escapeHtml(value)}" aria-label="${escapeHtml(t('voices.filter.remove', { name: label }))}">
                        ${escapeHtml(label)} <span aria-hidden="true">×</span>
                    </button>`,
                )
                .join('') +
            (count
                ? `<button type="button" class="creation-filter-reset" data-clear-filters>${escapeHtml(t('voices.filter.clear'))}</button>`
                : '');
        if (activeMarkup !== markup) {
            active.innerHTML = markup;
            activeMarkup = markup;
        }
        const reset = active.querySelector('[data-clear-filters]');
        if (reset) {
            reset.style.visibility = open ? 'hidden' : '';
            reset.tabIndex = open ? -1 : 0;
        }
    }

    function renderPanel(chips) {
        if (!open) return;
        const activeSet = new Set(chips.map(({ kind, value }) => `${kind}\u0000${value}`));
        // Capture focus before replacing the options; the clicked button is gone afterwards.
        const focused = groups.contains(document.activeElement)
            ? { kind: document.activeElement.dataset.kind, value: document.activeElement.dataset.value }
            : null;
        const markup = getFacets()
            .map((group) => {
                const options = group.values;
                if (!options.length) return '';
                return `<fieldset class="creation-filter-group">
                    <legend>${escapeHtml(group.label)}</legend>
                    <div class="creation-filter-options">${options
                        .map((option) => {
                            const isSelected = activeSet.has(`${group.kind}\u0000${option.value}`);
                            const disabled = !isSelected && option.count === 0;
                            return `<button type="button" class="creation-filter-option voice-filter-option" data-kind="${escapeHtml(group.kind)}" data-value="${escapeHtml(option.value)}" aria-pressed="${isSelected}" ${disabled ? 'disabled' : ''}>
                                <span>${escapeHtml(option.label)}</span><em>${option.count}</em>
                            </button>`;
                        })
                        .join('')}</div>
                </fieldset>`;
            })
            .join('');
        if (panelMarkup !== markup) {
            groups.innerHTML = markup;
            panelMarkup = markup;
        }
        summary.textContent = t('voices.filter.summary', { count: getResultCount() });
        clear.hidden = chips.length === 0;
        position();
        if (focused?.kind && focused?.value) {
            groups
                .querySelector(`[data-kind="${CSS.escape(focused.kind)}"][data-value="${CSS.escape(focused.value)}"]`)
                ?.focus({ preventScroll: true });
        }
    }

    function render() {
        const chips = selected().map(({ kind, value }) => ({ kind, value, label: getLabel(kind, value) }));
        const count = chips.length;
        badge.textContent = String(count);
        badge.hidden = count === 0;
        toggle.classList.toggle('is-active', count > 0);
        toggle.setAttribute('aria-expanded', String(open));
        panel.hidden = !open;
        clear.hidden = count === 0;
        renderActive(chips);
        if (open) renderPanel(chips);
    }

    function close({ focus = false } = {}) {
        if (!open) return;
        open = false;
        render();
        if (focus) toggle.focus({ preventScroll: true });
    }

    function togglePanel() {
        open = !open;
        render();
        if (open) position();
    }

    function clearAll() {
        onClear();
        close({ focus: false });
        toggle.focus({ preventScroll: true });
    }

    function optionValue(element) {
        return element?.closest('[data-kind][data-value]');
    }

    toggle.addEventListener('click', togglePanel);
    closeButton.addEventListener('click', () => close({ focus: true }));
    clear.addEventListener('click', clearAll);
    panel.addEventListener('click', (event) => {
        event.stopPropagation();
        const reset = event.target.closest('[data-clear-filters]');
        if (reset) {
            clearAll();
            return;
        }
        const option = optionValue(event.target);
        if (option) {
            onToggle(option.dataset.kind, option.dataset.value);
            render();
        }
    });
    active.addEventListener('click', (event) => {
        event.stopPropagation();
        const reset = event.target.closest('[data-clear-filters]');
        if (reset) {
            clearAll();
            return;
        }
        const option = optionValue(event.target);
        if (option) {
            onToggle(option.dataset.kind, option.dataset.value);
            render();
        }
    });
    document.addEventListener('click', (event) => {
        if (!open) return;
        if (panel.contains(event.target) || toggle.contains(event.target)) return;
        close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        close({ focus: true });
    });
    window.addEventListener('resize', position);

    render();
    return { render, close };
}
