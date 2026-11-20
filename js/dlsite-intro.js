// Experimental: render the DLSite work-intro block inside the voice album page.
//
// The source page is untrusted third-party HTML. This module deliberately does
// not use `innerHTML` on the raw document: it walks the DOM and rebuilds a tiny
// allowlisted HTML string (h2/h3/p/br/a/img + text), then puts that into a Shadow
// Root so DLSite CSS/scripts cannot affect Monochrome (and vice versa).
import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import { fetchDlsiteHtml } from './tauri-bridge.js';

const CACHE_KEY = 'monochrome-dlsite-intros-v2';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HTML_LENGTH = 4 * 1024 * 1024;

const ALLOWED_TAGS = new Set(['H2', 'H3', 'P', 'BR', 'A', 'IMG', 'STRONG', 'EM', 'B', 'I', 'UL', 'OL', 'LI']);
const IMAGE_HOSTS = new Set(['img.dlsite.jp']);

function sourceUrlFor(work) {
    const existing = String(work?.sourceUrl || '');
    if (/dlsite\.com\/.+\/product_id\//i.test(existing)) return existing;
    // A local work has an edition code (`code`) and an optional original
    // sourceCode. Prefer the edition code for the page the user is actually
    // looking at; online works use their sourceCode.
    const candidates = [work?.code, work?.sourceCode].map((value) => String(value || '').trim());
    const code = candidates.find((value) => /^RJ\d{5,8}$/i.test(value)) || '';
    if (!code) return '';
    return `https://www.dlsite.com/maniax/work/=/product_id/${encodeURIComponent(code.toUpperCase())}.html`;
}

function absoluteUrl(value, baseUrl) {
    try {
        const url = new URL(String(value || ''), baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        return url.href;
    } catch {
        return '';
    }
}

function isSafeImageUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

function sanitizeChildren(node, baseUrl, output) {
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            output.push(escapeHtml(child.nodeValue || ''));
            continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName;
        // Scripts/styles/embedded media/tracking owners are dropped whole.
        if (['SCRIPT', 'STYLE', 'IFRAME', 'FORM', 'AUDIO', 'VIDEO', 'SOURCE', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE'].includes(tag)) {
            continue;
        }
        const className = String(child.getAttribute('class') || '');
        if (/trial|player|preview|recommend|advert|tracking/i.test(className)) continue;
        if (!ALLOWED_TAGS.has(tag)) {
            sanitizeChildren(child, baseUrl, output);
            continue;
        }
        if (tag === 'BR') {
            output.push('<br>');
            continue;
        }
        if (tag === 'IMG') {
            const src = absoluteUrl(child.getAttribute('src') || child.getAttribute('data-src'), baseUrl);
            if (!isSafeImageUrl(src)) continue;
            const alt = child.getAttribute('alt') || '';
            output.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`);
            continue;
        }
        if (tag === 'A') {
            const href = absoluteUrl(child.getAttribute('href'), baseUrl);
            if (!href) {
                sanitizeChildren(child, baseUrl, output);
                continue;
            }
            output.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">`);
            sanitizeChildren(child, baseUrl, output);
            output.push('</a>');
            continue;
        }
        const open = `<${tag.toLowerCase()}>`;
        const close = `</${tag.toLowerCase()}>`;
        output.push(open);
        sanitizeChildren(child, baseUrl, output);
        output.push(close);
    }
}

/**
 * Extract the public intro from a DLSite work page.
 * The caller gets a sanitized HTML fragment, never the third-party page itself.
 */
export function extractDlsiteIntro(html, work) {
    const sourceUrl = sourceUrlFor(work);
    if (!html || html.length > MAX_HTML_LENGTH) throw new Error('empty DLSite HTML');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // 2026 DLsite work pages are Vue-rendered and no longer expose
    // #intro-title/.work_parts_container. The whole "作品内容" block lives in
    // .c-productInfo, with one or more section.c-productContent children.
    const productInfo = doc.querySelector('.c-productInfo');
    let container = (productInfo && (productInfo.querySelector('.c-productInfo__inner') || productInfo)) ||
        doc.querySelector('#intro-title + .work_parts_container') ||
        doc.querySelector('#intro-title + div[itemprop="description"]') ||
        doc.querySelector('.work_parts_container[itemprop="description"]') ||
        doc.querySelector('#intro-title + .work_parts') ||
        doc.querySelector('[itemprop="description"].work_parts_container') ||
        doc.querySelector('.work_parts_container');
    if (!container) {
        // Some locale/anti-bot pages omit #intro-title but still expose the
        // description meta tag. Better to show that than a dead error block.
        const title = doc.querySelector('#intro-title')?.nextElementSibling;
        if (title && /description|work_parts/i.test(title.className || '')) container = title;
    }
    if (!container) {
        const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
            doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        if (description.trim()) {
            return {
                html: `<p>${escapeHtml(description.trim())}</p>`,
                sourceUrl,
                blockCount: 0,
                fallback: true,
                title: doc.querySelector('h1, #work_name, meta[property="og:title"]')?.textContent?.trim() || '',
            };
        }
        throw new Error('DLSite intro container not found');
    }
    const clone = container.cloneNode(true);
    clone.querySelectorAll('script, style, iframe, form, audio, video, source, object, embed, link, meta, template').forEach((node) => node.remove());
    const output = [];
    sanitizeChildren(clone, sourceUrl, output);
    const sanitized = output.join('').trim();
    if (!sanitized) throw new Error('DLSite intro has no renderable content');
    return {
        html: sanitized,
        sourceUrl,
        blockCount: clone.querySelectorAll('.work_parts').length,
    };
}

function readCache(code) {
    try {
        const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        const entry = all?.[code];
        if (!entry || !entry.html || !entry.fetchedAt) return null;
        return entry;
    } catch {
        return null;
    }
}

function writeCache(code, entry) {
    try {
        const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        all[code] = entry;
        localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch {
        /* The intro is optional; quota/private mode must not break the album page. */
    }
}

function clearCache(code) {
    try {
        const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        delete all[code];
        localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch {
        /* ignore */
    }
}

function shadowCss() {
    return `
    :host { display: block; width: 100%; margin: 1.8rem 0 1rem; }
    * { box-sizing: border-box; }
    .intro {
        width: 100%;
        border: 0;
        border-top: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
        border-radius: 0;
        background: none;
        overflow: visible;
        padding-top: .55rem;
    }
    .intro details { margin: 0; }
    .intro summary { list-style: none; }
    .intro summary::-webkit-details-marker { display: none; }
    .intro-head {
        display: flex; align-items: center; gap: .45rem;
        padding: 0 0 .55rem;
        border-bottom: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
        cursor: pointer;
    }
    .intro-caret {
        width: .85rem;
        color: var(--muted-foreground);
        font-size: .9rem;
        line-height: 1;
        transform: rotate(0deg);
        transition: transform .15s ease;
    }
    .intro details[open] .intro-caret { transform: rotate(90deg); }
    .intro-title {
        margin: 0;
        color: var(--muted-foreground);
        font-size: .78rem;
        font-weight: 600;
        letter-spacing: .04em;
    }
    .intro-refresh {
        margin-left: auto;
        width: 1.55rem; height: 1.55rem; border: 0; border-radius: .4rem;
        background: transparent; color: var(--muted-foreground); cursor: pointer;
    }
    .intro-refresh:hover { color: var(--foreground); background: var(--secondary); }
    .intro-body { padding: .75rem 0 0; color: var(--foreground); font-size: .82rem; line-height: 1.65; }
    .intro-body h2, .intro-body h3 { margin: .9rem 0 .35rem; font-size: .84rem; }
    .intro-body h2:first-child, .intro-body h3:first-child { margin-top: 0; }
    .intro-body p { margin: .35rem 0; }
    .intro-body a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
    .intro-body img { display: block; max-width: 100%; height: auto; margin: .65rem 0; border-radius: .35rem; }
    .intro-body ul, .intro-body ol { padding-left: 1.25rem; }
    .intro-state { padding: .65rem 0 .2rem; color: var(--muted-foreground); font-size: .78rem; line-height: 1.5; }
    .intro-error { color: var(--muted-foreground); }
    .intro-error button { margin-left: .45rem; }
    @keyframes intro-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    `;
}

function attachIntroHost(host) {
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${shadowCss()}</style><section class="intro" aria-label="${escapeHtml(t('voices.dlsiteIntro'))}"></section>`;
    return root.querySelector('.intro');
}

function introHeaderHtml() {
    return `
        <summary class="intro-head">
            <span class="intro-caret" aria-hidden="true">›</span>
            <h2 class="intro-title">${escapeHtml(t('voices.dlsiteIntro'))}</h2>
        </summary>`;
}

function renderState(host, work, state, detail = '') {
    const intro = attachIntroHost(host);
    const sourceUrl = sourceUrlFor(work);
    intro.innerHTML = `
        <details>
            ${introHeaderHtml()}
            <div class="intro-state ${state === 'error' ? 'intro-error' : ''}">${escapeHtml(detail)}</div>
        </details>`;
    if (state === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-secondary';
        retry.textContent = t('voices.dlsiteIntroRetry');
        retry.addEventListener('click', () => {
            if (sourceUrl) clearCache(String(work.sourceCode || work.code || '').toUpperCase());
            void renderDlsiteIntro(work, host);
        });
        intro.querySelector('.intro-state').append(retry);
    }
}

function renderLoaded(host, work, entry) {
    const intro = attachIntroHost(host);
    intro.innerHTML = `
        <details>
            ${introHeaderHtml().replace('</summary>', '<button class="intro-refresh" type="button" title="' + escapeHtml(t('voices.dlsiteIntroRefresh')) + '" aria-label="' + escapeHtml(t('voices.dlsiteIntroRefresh')) + '">↻</button></summary>')}
            <div class="intro-body"></div>
        </details>`;
    intro.querySelector('.intro-body').innerHTML = entry.html; // sanitized by extractDlsiteIntro
    const refresh = intro.querySelector('.intro-refresh');
    refresh?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const code = String(work.sourceCode || work.code || '').toUpperCase();
        clearCache(code);
        void renderDlsiteIntro(work, host);
    });
    refresh?.addEventListener('pointerdown', (event) => event.stopPropagation());
}

/**
 * Attach the optional DLSite intro to an existing host element.
 * Cached content is rendered synchronously; otherwise one proxy request is made.
 */
export async function renderDlsiteIntro(work, host) {
    if (!host) return;
    const code = String(work?.sourceCode || work?.code || '').toUpperCase();
    const sourceUrl = sourceUrlFor(work);
    if (!/^RJ\d{5,8}$/i.test(code) || !sourceUrl) {
        host.remove();
        return;
    }
    const cached = readCache(code);
    if (cached && Date.now() - Number(cached.fetchedAt || 0) < CACHE_TTL_MS) {
        renderLoaded(host, work, cached);
        return;
    }
    renderState(host, work, 'loading', t('voices.dlsiteIntroLoading'));
    try {
        const raw = await fetchDlsiteHtml(sourceUrl);
        if (!host.isConnected) return;
        const extracted = extractDlsiteIntro(raw, work);
        const entry = { ...extracted, fetchedAt: Date.now() };
        writeCache(code, entry);
        renderLoaded(host, work, entry);
    } catch (error) {
        if (!host.isConnected) return;
        renderState(host, work, 'error', `${t('voices.dlsiteIntroError')} ${error?.message || ''}`.trim());
    }
}

export function clearDlsiteIntroCache(code) {
    if (code) clearCache(String(code).toUpperCase());
}
