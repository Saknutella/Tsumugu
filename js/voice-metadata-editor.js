// Manual metadata editor for storage-backed works. Local folders often have no
// RJ code, so title/circle/tags/rating/age/edition must be user-owned overrides
// instead of requiring an online match.
import { t } from './i18n.js';

function field(label, name, value, type = 'text') {
    return `<label class="voice-meta-field"><span>${label}</span><input type="${type}" name="${name}" value="${String(value ?? '').replaceAll('"', '&quot;')}" /></label>`;
}

function textarea(label, name, value) {
    return `<label class="voice-meta-field"><span>${label}</span><textarea name="${name}" rows="2">${String(value ?? '')}</textarea></label>`;
}

function normalizeAgeCategory(value) {
    const text = String(value || '').trim().toLowerCase();
    if (['all', 'general', 'all_ages', 'general_all', 'everyone'].includes(text)) return 'all';
    if (text === 'r15') return 'r15';
    if (['r18', 'adult', 'nsfw', '18+', 'r-18'].includes(text)) return 'r18';
    return 'unrated';
}

export function openVoiceMetadataEditor(work, { onSaved } = {}) {
    document.getElementById('voice-meta-editor')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'voice-meta-editor';
    overlay.className = 'voice-meta-editor';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const artists = (work.artists || []).join(', ');
    const tags = (work.tags || []).filter((tag) => tag !== '本地文件' && tag !== '部分本地').join(', ');
    const ageCategory = normalizeAgeCategory(work.ageCategory || work.userMeta?.ageCategory);
    overlay.innerHTML = `
        <form class="voice-meta-dialog">
            <header>
                <h2>${t('voices.metadata.title')}</h2>
                <button type="button" class="voice-meta-close" aria-label="${t('voiceViewer.close')}">×</button>
            </header>
            <p class="voice-meta-hint">${t('voices.metadata.hint')}</p>
            <div class="voice-meta-grid">
                ${field(t('voices.metadata.fields.title'), 'title', work.title)}
                ${field(t('voices.metadata.fields.circle'), 'circle', work.circle)}
                ${field(t('voices.metadata.fields.artists'), 'artists', artists)}
                ${field(t('voices.metadata.fields.tags'), 'tags', tags)}
                ${field(t('voices.metadata.fields.rating'), 'rating', work.rating || 0, 'number')}
                ${field(t('voices.metadata.fields.ratingCount'), 'ratingCount', work.ratingCount || 0, 'number')}
                ${field(t('voices.metadata.fields.release'), 'release', work.release || '', 'date')}
                ${field(t('voices.metadata.fields.price'), 'price', work.price || 0, 'number')}
                ${field(t('voices.metadata.fields.originalCode'), 'sourceCode', work.sourceCode || work.code || '')}
                ${field(t('voices.metadata.fields.editionLang'), 'editionLang', work.editionLang || '')}
                <label class="voice-meta-field"><span>${t('voices.metadata.fields.ageCategory')}</span>
                    <select name="ageCategory">
                        ${['unrated', 'all', 'r15', 'r18'].map((value) => `<option value="${value}" ${ageCategory === value ? 'selected' : ''}>${value}</option>`).join('')}
                    </select>
                </label>
                <!-- R-18 is represented by ageCategory=r18; a separate nsfw
                     checkbox duplicated the same information. -->
            </div>
            <footer>
                <button type="button" class="btn btn-secondary voice-meta-cancel">${t('voices.metadata.cancel')}</button>
                <button type="submit" class="btn btn-primary voice-meta-save">${t('voices.metadata.save')}</button>
            </footer>
        </form>`;
    document.body.append(overlay);
    const form = overlay.querySelector('form');
    const close = () => overlay.remove();
    overlay.querySelector('.voice-meta-close').addEventListener('click', close);
    overlay.querySelector('.voice-meta-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
        }
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const split = (name) => String(data.get(name) || '').split(',').map((value) => value.trim()).filter(Boolean);
        const metadata = {
            title: String(data.get('title') || '').trim(),
            circle: String(data.get('circle') || '').trim(),
            cvs: split('artists'),
            tags: split('tags'),
            rating: Number(data.get('rating')) || 0,
            ratingCount: Number(data.get('ratingCount')) || 0,
            release: String(data.get('release') || '').trim(),
            price: Number(data.get('price')) || 0,
            ageCategory: normalizeAgeCategory(data.get('ageCategory')),
            manual: true,
            nsfw: normalizeAgeCategory(data.get('ageCategory')) === 'r18',
            sourceCode: String(data.get('sourceCode') || '').trim().toUpperCase(),
            editionLang: String(data.get('editionLang') || '').trim().toLowerCase(),
        };
        const button = form.querySelector('.voice-meta-save');
        button.disabled = true;
        try {
            const bridge = globalThis.__monochromeFileStorage;
            if (typeof bridge?.updateMetadata !== 'function') throw new Error('storage bridge unavailable');
            await bridge.updateMetadata(work.storageWorkId || work.id, metadata);
            close();
            await onSaved?.(metadata);
        } catch (error) {
            console.error('voice metadata update failed', error);
            button.disabled = false;
            button.textContent = t('voices.metadata.failed');
        }
    });
    form.querySelector('input[name="title"]')?.focus();
}
