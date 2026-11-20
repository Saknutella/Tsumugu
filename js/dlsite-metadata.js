// Minimal DLsite page extraction for the fields Kikoeru does not expose.
//
// The full HTML is large and layout-specific; only the stable attributes used by
// the language selector and maker template are parsed. Unknown pages return null
// rather than guessing from visible text.
import { fetchDlsiteHtml } from './tauri-bridge.js';

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

export function parseDlsiteLanguageEditions(html) {
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
    if (!editions.length) {
        return { sourceCode: code, editionCodes: [], editionLang: '', editionLabel: '' };
    }
    if (code && !editions.some((edition) => edition.code === code)) {
        editions.push({ code, lang: '', label: '', displayOrder: 0 });
    }
    const japanese = editions.find((edition) => edition.lang === 'jpn');
    const numeric = (value) => Number(String(value).match(/(\d{5,8})/)?.[1] || Number.MAX_SAFE_INTEGER);
    const sourceCode = japanese?.code || [...editions].sort((a, b) => numeric(a.code) - numeric(b.code))[0]?.code || code;
    const current = editions.find((edition) => edition.code === code);
    return {
        sourceCode,
        editionCodes: editions.map((edition) => ({
            ...edition,
            isOriginal: edition.code === sourceCode,
            label: edition.label || (edition.code === sourceCode ? '日' : ''),
        })),
        editionLang: current?.lang || '',
        editionLabel: current?.label || '',
    };
}

export function parseDlsiteWorkMetadata(html) {
    const source = String(html || '');
    if (!source) return null;
    const title =
        attribute(source, 'data-work_name') ||
        attribute(source, 'data-work-name') ||
        (source.match(/<h1[^>]*class=["'][^"']*work_name[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    if (!title) return null;
    const code =
        attribute(source, 'data-product_id') ||
        (source.match(/RJ\d{5,8}/i)?.[0] || '').toUpperCase();
    const circle = parseDlsiteMakerName(source);
    const cover =
        source.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
        source.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1] ||
        '';
    const ratingMatch = source.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/i) || source.match(/ratingValue["']?\s+content=["']([0-9.]+)["']/i);
    const rating = ratingMatch ? Number(ratingMatch[1]) : 0;
    const tags = [...new Set(
        [...source.matchAll(/work\.genre\/[^"']*["'][^>]*>([^<]+)</gi)]
            .map((match) => decodeEntities(match[1]).trim())
            .filter(Boolean),
    )];
    const age = dlsiteAgeCategory(source);
    return {
        ...dlsiteEditionInfo(source, code),
        code,
        title: decodeEntities(title),
        circle,
        trueCircle: circle,
        cover: cover ? decodeEntities(cover) : '',
        rating,
        tags,
        artists: dlsiteVoiceActors(source),
        release: dlsiteReleaseDate(source),
        ratingCount: dlsiteRatingCount(source),
        price: Number(attribute(source, 'data-price')) || 0,
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
    const url = `https://www.dlsite.com/maniax/work/=/product_id/${normalized}.html`;
    const html = await fetchDlsiteHtml(url, options);
    const translated = parseDlsiteWorkMetadata(html);
    if (!translated?.sourceCode || translated.sourceCode === normalized) return translated;
    try {
        // A translated edition's maker is the translation group. The card's
        // circle must come from the original Japanese product page instead.
        const originalUrl = `https://www.dlsite.com/maniax/work/=/product_id/${translated.sourceCode}.html`;
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
