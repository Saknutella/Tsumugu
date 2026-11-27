// Minimal DLsite page extraction for the fields Kikoeru does not expose.
//
// The full HTML is large and layout-specific; only the stable attributes used by
// the language selector and maker template are parsed. Unknown pages return null
// rather than guessing from visible text.
import { fetchDlsiteHtml } from './tauri-bridge.js';
import { getVoiceServerSettings, normalizeDlsiteLocale } from './voice-settings.js';

export { normalizeDlsiteLocale };

const DLSITE_QUERY_LOCALE = {
    'ja-jp': 'ja_JP',
    'zh-tw': 'zh_TW',
    'zh-cn': 'zh_CN',
};

/**
 * Build the DLsite work URL, appending `?locale=` when configured.
 *
 * Uses query parameter rather than a `Cookie` header because browser/WebView2
 * `fetch()` silently strips forbidden `Cookie` headers even under
 * `--disable-web-security`; live probe across ja-jp/zh-tw/zh-cn confirmed
 * identical 115-key `__NUXT_DATA__` product payloads across all three locales.
 */
export function dlsiteProductUrl(code, locale = '') {
    const normalized = String(code || '').toUpperCase().match(/RJ\d{5,8}/)?.[0];
    if (!normalized) return '';
    const loc = normalizeDlsiteLocale(locale);
    const query = DLSITE_QUERY_LOCALE[loc];
    const base = `https://www.dlsite.com/maniax/work/=/product_id/${normalized}.html`;
    return query ? `${base}?locale=${query}` : base;
}

function decodeEntities(value) {
    return String(value ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

export function parseDlsiteMakerName(html) {
    const source = String(html || '');
    const template = source.match(/data-maker-name=["']([^"']+)["']/i);
    if (template?.[1]) return decodeEntities(template[1]).trim();
    const makerLink = source.match(/\/maker_id\/[^"']+["'][^>]*>([^<]+)</i);
    return makerLink?.[1] ? decodeEntities(makerLink[1]).trim() : '';
}

/**
 * Read the Nuxt SSR payload (`<script id="__NUXT_DATA__">`).
 *
 * DLsite serves the work record through Nuxt with a flat, index-referenced array
 * ("devalue" format): every value is either a literal or an index into the same
 * array. The product page carries two fields the plain HTML attributes do not:
 *
 *   work.translation_info.original_workno  -> the *authoritative* Japanese source RJ
 *   work.language_editions                 -> every edition (code, lang, label)
 *
 * Kikoeru's translation mapping is frequently wrong (it sometimes points a
 * translation at a sibling translation), so this payload is the primary source
 * for "which RJ is the original" and the attributes below are only a fallback.
 */
function nuxtPayload(html) {
    const match = String(html || '').match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    try {
        const array = JSON.parse(match[1]);
        if (!Array.isArray(array)) return null;
        const resolve = (value) => (Number.isInteger(value) && value >= 0 && value < array.length ? array[value] : value);
        return { array, resolve };
    } catch {
        return null;
    }
}

/** `["product_id": <index>]` records that describe a work. */
function nuxtWorkRecords(payload) {
    const records = [];
    for (const value of payload.array) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const productId = payload.resolve(value.product_id);
        if (typeof productId !== 'string' || !/^RJ\d{5,8}$/i.test(productId)) continue;
        records.push({ record: value, productId: productId.toUpperCase(), payload });
    }
    return records;
}

/**
 * Follow the payload's index table all the way down.
 *
 * `payload.resolve` only undoes one hop, which is enough for a scalar but not for
 * the product record: `genres` is an array of indexes, each of which is an object
 * of further indexes. Without a deep resolve those come back as raw integers.
 *
 * The table stores *every* value, so a property's number is always an index —
 * including booleans and numbers. Dereferencing a number that came *out* of the
 * table would walk somewhere unrelated (a rating count would resolve to whatever
 * entry happens to sit at that offset), which is why index lookup and value
 * materialisation are two separate steps here.
 */
function nuxtEntry(payload, index, depth = 0) {
    if (depth > 10) return null;
    if (typeof index !== 'number' || !Number.isInteger(index)) return nuxtValue(payload, index, depth);
    return nuxtValue(payload, payload.array[index], depth);
}

function nuxtValue(payload, value, depth = 0) {
    if (depth > 10 || value === null || value === undefined) return null;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        // devalue markers: `["ShallowRef", <index>]` and friends name a wrapper,
        // not a value; the wrapped index is the real payload.
        if (typeof value[0] === 'string' && /^(Shallow)?(Ref|Reactive)$/.test(value[0])) {
            return nuxtEntry(payload, value[1], depth + 1);
        }
        return value.map((item) => nuxtEntry(payload, item, depth + 1));
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = nuxtEntry(payload, item, depth + 1);
    return out;
}

/**
 * The product record of *this* page.
 *
 * WHY this exists: DLsite serves a Nuxt payload, and the markup the field readers
 * below were written against (`<th>声優</th>`, `work.genre/` links, `販売日` table
 * rows) is no longer in the HTML. Everything those readers produced came back
 * empty — CV, tags, release date, review count — while title/circle/rating/price
 * survived because they also exist in meta tags. A locally imported work then
 * showed no circle, no CV and no tags even though DLsite had all of them.
 */
function nuxtProduct(payload) {
    const records = nuxtWorkRecords(payload);
    for (const { record } of records) {
        if (record.work_name === undefined) continue;
        const product = nuxtValue(payload, record);
        if (product && typeof product === 'object') return product;
    }
    return null;
}

/** `release_date` is unix seconds; render it in UTC so the day cannot shift. */
function nuxtReleaseDate(product) {
    const seconds = Number(product?.release_date);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const date = new Date(seconds * 1000);
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** `age_category`: 1 全年齢, 2 R15, 3 R18 (anything else stays unrated). */
function nuxtAgeCategory(product) {
    const category = Number(product?.age_category);
    if (category === 1) return { ageCategory: 'all', nsfw: false };
    if (category === 2) return { ageCategory: 'r15', nsfw: true };
    if (category === 3) return { ageCategory: 'r18', nsfw: true };
    return { ageCategory: '', nsfw: false };
}

/** Voice actors live under `creators[].role === 'voice_by'`. The inner list is
 * spelled `creaters` in the raw payload and `creators` once materialised, so read
 * whichever is present. */
function nuxtVoiceActors(product) {
    const groups = Array.isArray(product?.creators) ? product.creators : [];
    for (const group of groups) {
        if (String(group?.role || '') !== 'voice_by') continue;
        const people = Array.isArray(group.creaters) ? group.creaters : Array.isArray(group.creators) ? group.creators : [];
        const names = people
            .map((person) => String(person?.name || '').trim())
            .filter(Boolean);
        if (names.length) return [...new Set(names)];
    }
    return [];
}

/**
 * Resolve a Nuxt value to a plain string.
 *
 * `devalue` encodes arrays-of-one as `[index]` and nested references as indexes
 * into the same table, so a language arrives as `[305]` and only a recursive
 * resolve reaches `"JPN"`. Stopping at the outer array produced lang ids like
 * `"305"`, which then failed every `lang === 'jpn'` check.
 */
function nuxtString(payload, value, depth = 0) {
    if (depth > 6 || value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        for (const item of value) {
            const text = nuxtString(payload, item, depth + 1);
            if (text) return text;
        }
        return '';
    }
    if (typeof value === 'number') return nuxtString(payload, payload.resolve(value), depth + 1);
    if (typeof value === 'object') return '';
    return String(value).trim();
}

/**
 * The Japanese source code this DLsite page belongs to.
 *
 * Returns `''` when the page does not say — the caller then keeps whatever code
 * it was asked for instead of guessing from a numeric order (the old heuristic
 * picked a *sibling translation* for RJ01506849).
 */
export function parseDlsiteOriginalCode(html) {
    const payload = nuxtPayload(html);
    if (!payload) return '';
    const records = nuxtWorkRecords(payload);
    // Prefer the record that carries translation_info; on a translation page
    // that is the current product.
    for (const { record } of records) {
        const info = record.translation_info === undefined ? null : payload.resolve(record.translation_info);
        if (!info || typeof info !== 'object') continue;
        const original = payload.resolve(info.original_workno);
        if (typeof original === 'string' && /^RJ\d{5,8}$/i.test(original)) return original.toUpperCase();
    }
    return '';
}

/**
 * Language of *this* page's edition.
 *
 * The `language_editions` list on a translated product page omits the current
 * translation (it lists the original and the *other* translations), so the
 * edition language has to come from this work's own `translation_info.lang`.
 */
export function parseDlsiteEditionLanguage(html, code) {
    const wanted = String(code || '').toUpperCase();
    if (!wanted) return { lang: '', label: '' };
    const payload = nuxtPayload(html);
    if (!payload) return { lang: '', label: '' };
    for (const { record, productId } of nuxtWorkRecords(payload)) {
        if (productId !== wanted) continue;
        const info = record.translation_info === undefined ? null : payload.resolve(record.translation_info);
        if (!info || typeof info !== 'object') continue;
        return { lang: nuxtString(payload, info.lang).toLowerCase(), label: '' };
    }
    return { lang: '', label: '' };
}

export function parseDlsiteLanguageEditions(html) {
    // Nuxt editions first: `language_editions` is the same data the selector is
    // rendered from and survives markup changes better than the data attribute.
    const payload = nuxtPayload(html);
    if (payload) {
        const editions = [];
        const seen = new Set();
        for (const { record } of nuxtWorkRecords(payload)) {
            const listRef = record.language_editions;
            const list = listRef === undefined ? null : payload.resolve(listRef);
            if (!Array.isArray(list)) continue;
            for (const entryRef of list) {
                const entry = payload.resolve(entryRef);
                if (!entry || typeof entry !== 'object') continue;
                const code = String(payload.resolve(entry.product_id) || '').toUpperCase();
                if (!/^RJ\d{5,8}$/.test(code) || seen.has(code)) continue;
                seen.add(code);
                const lang = nuxtString(payload, entry.lang).toLowerCase();
                editions.push({
                    code,
                    lang,
                    label: String(payload.resolve(entry.display_label) || '').trim(),
                    displayOrder: Number(payload.resolve(entry.display_order)) || 0,
                });
            }
        }
        if (editions.length) return editions;
    }
    const match = String(html || '').match(/data-language-editions=(['"])([\s\S]*?)\1/i);
    if (!match) return [];
    try {
        const parsed = JSON.parse(decodeEntities(match[2]));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((edition) => ({
                code: String(edition.workno || '').toUpperCase(),
                lang: String(edition.lang || '').toLowerCase(),
                label: String(edition.display_label || edition.label || ''),
                displayOrder: Number(edition.display_order) || 0,
            }))
            .filter((edition) => edition.code);
    } catch {
        return [];
    }
}

function attribute(source, name) {
    const marker = `${name}=`;
    const startIndex = String(source || '').indexOf(marker);
    if (startIndex < 0) return '';
    const quoteIndex = startIndex + marker.length;
    const quote = source[quoteIndex];
    if (quote !== '"' && quote !== "'") return '';
    const endIndex = source.indexOf(quote, quoteIndex + 1);
    if (endIndex < 0) return '';
    return decodeEntities(source.slice(quoteIndex + 1, endIndex)).trim();
}

function dlsiteAgeCategory(source) {
    const text = String(source || '');
    const match = text.match(/age_category\W(\d+)/i);
    if (match) {
        const category = Number(match[1]);
        if (category === 1) return { ageCategory: 'all', nsfw: false };
        if (category === 2) return { ageCategory: 'r15', nsfw: true };
        return { ageCategory: 'r18', nsfw: true };
    }
    // Many product pages expose a visible 年齢指定 table row instead of a URL.
    const section = text.match(/<th>年齢指定<[/]th>([\s\S]{0,600}?)<[/]tr>/i);
    const label = section?.[1] || '';
    if (/全年齢/.test(label)) return { ageCategory: 'all', nsfw: false };
    if (/R15|15歳/.test(label)) return { ageCategory: 'r15', nsfw: true };
    if (/R18|18歳|成人/.test(label)) return { ageCategory: 'r18', nsfw: true };
    return { ageCategory: '', nsfw: false };
}

function dlsiteReleaseDate(source) {
    const match = String(source || '').match(/<th>販売日<\/th>\s*<td>[\s\S]{0,200}?(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!match) return '';
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

function dlsiteRatingCount(source) {
    const match = String(source || '').match(/ratingCount["']?\s+content=["']([0-9]+)["']/i);
    return match ? Number(match[1]) : 0;
}

function dlsiteVoiceActors(source) {
    const section = String(source || '').match(/<th>声優<\/th>([\s\S]{0,2500}?)<\/tr>/i);
    if (!section) return [];
    return [...new Set(
        [...section[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
            .map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).trim())
            .filter(Boolean),
    )];
}

function dlsiteDurationSeconds(source) {
    const section = String(source || '').match(/総時間[^0-9]{0,40}([^<]{1,40})/);
    const text = section?.[1] || '';
    const hours = Number(text.match(/(\d+)\s*時間/)?.[1]) || 0;
    const minutes = Number(text.match(/(\d+)\s*分/)?.[1]) || 0;
    const seconds = Number(text.match(/(\d+)\s*秒/)?.[1]) || 0;
    const total = hours * 3600 + minutes * 60 + seconds;
    return total > 0 ? total : 0;
}

function dlsiteEditionInfo(source, currentCode) {
    const code = String(currentCode || '').toUpperCase();
    const editions = parseDlsiteLanguageEditions(source);
    // The Nuxt payload states the original RJ explicitly; it is the only source
    // that is right for every page (Kikoeru sometimes maps a translation to a
    // sibling translation, and picking the lowest code is a pure guess).
    const explicitOriginal = parseDlsiteOriginalCode(source);
    if (!editions.length && !explicitOriginal) {
        return { sourceCode: code, editionCodes: [], editionLang: '', editionLabel: '' };
    }
    if (code && !editions.some((edition) => edition.code === code)) {
        editions.push({ code, lang: '', label: '', displayOrder: 0 });
    }
    const japanese = editions.find((edition) => edition.lang === 'jpn');
    const sourceCode = explicitOriginal || japanese?.code || code;
    if (sourceCode && !editions.some((edition) => edition.code === sourceCode)) {
        editions.unshift({ code: sourceCode, lang: 'jpn', label: '日', displayOrder: 0 });
    }
    const current = editions.find((edition) => edition.code === code);
    // The current page's own `translation_info.lang` is authoritative for this
    // edition; the shared edition list usually omits the page itself.
    const ownLanguage = parseDlsiteEditionLanguage(source, code);
    const editionLang = (current?.lang || ownLanguage.lang || '').toLowerCase();
    return {
        sourceCode,
        editionCodes: editions.map((edition) => ({
            ...edition,
            lang: edition.code === code && !edition.lang ? editionLang : edition.lang,
            isOriginal: edition.code === sourceCode,
            label: edition.label || (edition.code === sourceCode ? '日' : ''),
        })),
        editionLang,
        editionLabel: current?.label || ownLanguage.label || '',
    };
}

export function parseDlsiteWorkMetadata(html) {
    const source = String(html || '');
    if (!source) return null;
    // Payload first: it is the only place CV, tags, release date and review count
    // still exist (see `nuxtProduct`). The markup readers stay as a fallback for
    // pages that still serve the old layout.
    const payload = nuxtPayload(source);
    const product = payload ? nuxtProduct(payload) : null;
    const title =
        String(product?.work_name || '') ||
        attribute(source, 'data-work_name') ||
        attribute(source, 'data-work-name') ||
        (source.match(/<h1[^>]*class=["'][^"']*work_name[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    if (!title) return null;
    const code =
        // `data-product-id` (hyphen) is the purchase panel's id for *this* page; `data-product_id`
        // also appears in the "other editions" block and would win later in the document.
        String(product?.product_id || '') ||
        attribute(source, 'data-product-id') ||
        attribute(source, 'data-product_id') ||
        (source.match(/RJ\d{5,8}/i)?.[0] || '').toUpperCase();
    const circle = String(product?.maker?.maker_name || '').trim() || parseDlsiteMakerName(source);
    const cover =
        source.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
        source.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1] ||
        '';
    const ratingMatch = source.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/i) || source.match(/ratingValue["']?\s+content=["']([0-9.]+)["']/i);
    const rating = Number(product?.rating?.average) || (ratingMatch ? Number(ratingMatch[1]) : 0);
    const payloadTags = (Array.isArray(product?.genres) ? product.genres : [])
        .map((genre) => String(genre?.genre_name || '').trim())
        .filter(Boolean);
    const tags = payloadTags.length
        ? [...new Set(payloadTags)]
        : [...new Set(
            [...source.matchAll(/work\.genre\/[^"']*["'][^>]*>([^<]+)</gi)]
                .map((match) => decodeEntities(match[1]).trim())
                .filter(Boolean),
        )];
    const payloadAge = product ? nuxtAgeCategory(product) : null;
    const age = payloadAge?.ageCategory ? payloadAge : dlsiteAgeCategory(source);
    const payloadActors = product ? nuxtVoiceActors(product) : [];
    return {
        ...dlsiteEditionInfo(source, code),
        code,
        title: decodeEntities(title),
        circle,
        trueCircle: circle,
        cover: cover ? decodeEntities(cover) : '',
        rating,
        tags,
        artists: payloadActors.length ? payloadActors : dlsiteVoiceActors(source),
        release: (product ? nuxtReleaseDate(product) : '') || dlsiteReleaseDate(source),
        ratingCount: Number(product?.rating?.count) || dlsiteRatingCount(source),
        price: Number(product?.currency_price?.JPY) || Number(attribute(source, 'data-price')) || 0,
        currency: 'JPY',
        ageCategory: age.ageCategory,
        nsfw: age.nsfw,
        duration: dlsiteDurationSeconds(source),
    };
}

function mergeOriginalCircle(translated, original) {
    const translatedCircle = String(translated?.circle || '').trim();
    const originalCircle = String(original?.circle || '').trim();
    if (!originalCircle) {
        // The translated edition's maker is the translation group. Never keep it
        // as the work circle; expose it only as translator metadata.
        return {
            ...translated,
            circle: '',
            trueCircle: '',
            translators: translatedCircle ? [translatedCircle] : [],
        };
    }
    return {
        ...translated,
        circle: originalCircle,
        trueCircle: originalCircle,
        translators: translatedCircle && translatedCircle !== originalCircle ? [translatedCircle] : [],
        artists: translated.artists?.length ? translated.artists : original.artists || [],
    };
}

export async function fetchDlsiteWorkMetadata(code, options = {}) {
    const normalized = String(code || '').toUpperCase().match(/RJ\d{5,8}/)?.[0];
    if (!normalized) return null;
    const locale = normalizeDlsiteLocale(options.locale ?? getVoiceServerSettings().dlsiteLocale);
    const url = dlsiteProductUrl(normalized, locale);
    const html = await fetchDlsiteHtml(url, options);
    const translated = parseDlsiteWorkMetadata(html);
    if (!translated?.sourceCode || translated.sourceCode === normalized) return translated;
    try {
        // A translated edition's maker is the translation group. The card's
        // circle must come from the original Japanese product page instead.
        const originalUrl = dlsiteProductUrl(translated.sourceCode, locale);
        const originalHtml = await fetchDlsiteHtml(originalUrl, options);
        return mergeOriginalCircle(translated, parseDlsiteWorkMetadata(originalHtml));
    } catch (error) {
        console.warn('DLsite original circle unavailable', translated.sourceCode, error?.message || error);
        return {
            ...translated,
            circle: '',
            trueCircle: '',
            translators: translated.circle ? [translated.circle] : [],
        };
    }
}
