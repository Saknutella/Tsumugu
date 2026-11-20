import { getVoiceFileType } from './voice-file-types.js';
// Kikoeru / asmr.one 数据适配层。
//
// asmr.one 的公开 API 实际是 Kikoeru:
//   GET /api/search/<RJ code>  -> { works: [...] }
//   GET /api/work/<numeric id> -> work metadata
//   GET /api/tracks/<id>       -> folder/file tree
// 自建 Kikoeru 通常把这些挂在同源 /api/ 下。
import { fetchKikoeruJson, fetchDlsiteHtml } from './tauri-bridge.js';
import { parseDlsiteMakerName } from './dlsite-metadata.js';
import { deriveWorkSubtitles } from './voice-subtitles.js';
import { fetchJson as fetchVoiceJson, selectBase } from './voice-endpoints.js';

const ASMR_API_BASE = 'https://api.asmr.one';
const dlsiteMakerCache = new Map();
const WORK_CODE_RE = /(?:^|\/)(?:=\/product_id\/)?([A-Z]{2}\d{5,8})(?:\/|$)/i;

export function parseKikoeruInput(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^[A-Z]{2}\d{5,8}$/i.test(raw)) {
        return {
            code: raw.toUpperCase(),
            backendBase: ASMR_API_BASE,
            pageUrl: '',
            host: 'asmr.one',
            family: 'asmr',
        };
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const match = url.pathname.match(WORK_CODE_RE);
    if (!match) return null;
    const host = url.hostname.toLowerCase();
    const isAsmr = host === 'asmr.one' || host === 'www.asmr.one';
    const backendBase = isAsmr ? ASMR_API_BASE : url.origin;
    return {
        code: match[1].toUpperCase(),
        backendBase,
        pageUrl: url.href,
        host,
        family: isAsmr ? 'asmr' : 'custom',
    };
}

function absoluteUrl(value, base) {
    if (!value) return '';
    try {
        return new URL(value, base).href;
    } catch {
        return '';
    }
}

function countTree(nodes, type) {
    let count = 0;
    for (const node of nodes || []) {
        if (getVoiceFileType(node) === type) count += 1;
        if (node.children) count += countTree(node.children, type);
    }
    return count;
}

function normalizeTree(nodes, baseUrl) {
    return (nodes || []).map((node) => {
        const normalized = {
            ...node,
            mediaStreamUrl: absoluteUrl(node.mediaStreamUrl, baseUrl),
            mediaDownloadUrl: absoluteUrl(node.mediaDownloadUrl, baseUrl),
        };
        if (Array.isArray(node.children)) {
            normalized.children = normalizeTree(node.children, baseUrl);
        }
        return normalized;
    });
}

const EDITION_LABELS = {
    jpn: '日',
    chi_hans: '中',
    chi_hant: '繁',
    eng: '英',
    kor: '韩',
};

function editionLabel(lang, fallback = '') {
    const key = String(lang || '').toLowerCase();
    return EDITION_LABELS[key] || fallback || key.toUpperCase() || '';
}

function numericRj(code) {
    const match = String(code || '').match(/(\d{5,8})/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function inferEditionLanguage(title) {
    const value = String(title || '');
    if (/简体中文版|簡体中文版|简体中文|簡体中文/.test(value)) return { lang: 'chi_hans', label: '中' };
    if (/繁体中文版|繁體中文版|繁体中文|繁體中文/.test(value)) return { lang: 'chi_hant', label: '繁' };
    if (/English|英语版|英語版/i.test(value)) return { lang: 'eng', label: '英' };
    if (/日本語版|日语版|日語版/.test(value)) return { lang: 'jpn', label: '日' };
    return { lang: '', label: '' };
}

function buildEditionInfo(work, currentCode) {
    const current = String(currentCode || work.source_id || '').toUpperCase();
    const editions = (Array.isArray(work.language_editions) ? work.language_editions : [])
        .map((edition) => ({
            code: String(edition.workno || '').toUpperCase(),
            lang: String(edition.lang || '').toLowerCase(),
            label: editionLabel(edition.lang, edition.label || ''),
            displayOrder: Number(edition.display_order) || 0,
        }))
        .filter((edition) => edition.code);
    if (current && !editions.some((edition) => edition.code === current)) {
        editions.push({ code: current, lang: '', label: '', displayOrder: 0 });
    }
    const explicitOriginal = String(work.translation_info?.original_workno || work.original_workno || '').toUpperCase();
    const japanese = editions.find((edition) => edition.lang === 'jpn');
    const sourceCode =
        explicitOriginal ||
        japanese?.code ||
        [...editions].sort((a, b) => numericRj(a.code) - numericRj(b.code))[0]?.code ||
        current;
    if (sourceCode && !editions.some((edition) => edition.code === sourceCode)) {
        editions.unshift({ code: sourceCode, lang: 'jpn', label: '日', displayOrder: 0 });
    }
    const normalizedEditions = editions
        .sort((a, b) => a.displayOrder - b.displayOrder || numericRj(a.code) - numericRj(b.code))
        .map((edition) => ({
            ...edition,
            isOriginal: edition.code === sourceCode,
            label: edition.label || (edition.code === sourceCode ? '日' : ''),
        }));
    let currentEdition = normalizedEditions.find((edition) => edition.code === current);
    if (currentEdition && !currentEdition.lang) {
        const inferred = inferEditionLanguage(work.title);
        currentEdition.lang = inferred.lang;
        currentEdition.label = currentEdition.label || inferred.label;
    }
    const translators =
        current && sourceCode && current !== sourceCode && work.circle?.name ? [work.circle.name] : [];
    return {
        sourceCode: sourceCode || current,
        editions: normalizedEditions,
        editionLang: currentEdition?.lang || '',
        editionLabel: currentEdition?.label || '',
        translators,
        trueCircle: sourceCode === current ? work.circle?.name || '' : '',
    };
}

export function normalizeKikoeruWork(work, tracks, context) {
    const base = context.backendBase;
    const artists = (work.vas || []).map((artist) => artist.name).filter(Boolean);
    const tags = (work.tags || []).map((tag) => tag.name || tag.i18n?.['zh-cn']?.name).filter(Boolean);
    // DLsite/Kikoeru exposes the age category outside tags; keep it in its own
    // age dimension instead of duplicating it as a normal tag.
    const ageCategory = String(work.age_category_string || '').toLowerCase();
    const normalizedTracks = normalizeTree(tracks, base);
    const subtitleInfo = deriveWorkSubtitles({ tracks: normalizedTracks, has_subtitle: work.has_subtitle });
    const editionInfo = buildEditionInfo(work, work.source_id || context.code);
    return {
        id: `voice-${work.source_id || work.id}`,
        provider: 'kikoeru',
        workId: work.id,
        code: work.source_id || context.code,
        sourceCode: editionInfo.sourceCode,
        editionCodes: editionInfo.editions,
        editionLang: editionInfo.editionLang,
        editionLabel: editionInfo.editionLabel,
        translators: editionInfo.translators,
        trueCircle: editionInfo.trueCircle,
        title: work.title || context.code,
        circle: work.circle?.name || work.name || '',
        circleId: work.circle?.id || work.circle_id || '',
        artists,
        tags,
        ageCategory,
        rating: Number(work.rate_average_2dp) || 0,
        ratingCount: Number(work.rate_count) || 0,
        reviewCount: Number(work.review_count) || 0,
        soldCount: Number(work.dl_count) || 0,
        price: Number(work.price) || 0,
        currency: 'JPY',
        release: work.release || '',
        duration: Number(work.duration) || 0,
        nsfw: Boolean(work.nsfw),
        hasSubtitle: subtitleInfo.hasSubtitle,
        cover: absoluteUrl(work.mainCoverUrl || work.samCoverUrl || work.thumbnailCoverUrl, base),
        thumbnail: absoluteUrl(work.thumbnailCoverUrl || work.samCoverUrl || work.mainCoverUrl, base),
        sourceUrl: work.source_url || '',
        pageUrl: context.pageUrl || '',
        backendBase: base,
        host: context.host || new URL(base).hostname,
        tracks: normalizedTracks,
        audioCount: countTree(normalizedTracks, 'audio'),
        fileCount: countTree(normalizedTracks, 'audio') + countTree(normalizedTracks, 'text') + countTree(normalizedTracks, 'image') + countTree(normalizedTracks, 'other') + countTree(normalizedTracks, 'video') + countTree(normalizedTracks, 'pdf'),
        importedAt: new Date().toISOString(),
    };
}

async function fetchDlsiteSourceCircle(sourceCode) {
    const code = String(sourceCode || '').toUpperCase();
    if (!code) return '';
    if (dlsiteMakerCache.has(code)) return dlsiteMakerCache.get(code);
    try {
        const url = `https://www.dlsite.com/maniax/work/=/product_id/${encodeURIComponent(code)}.html`;
        const html = await fetchDlsiteHtml(url);
        const maker = parseDlsiteMakerName(html);
        dlsiteMakerCache.set(code, maker);
        return maker;
    } catch (error) {
        console.warn('Failed to resolve DLSite source circle:', code, error);
        dlsiteMakerCache.set(code, '');
        return '';
    }
}

/**
 * The translated edition's search endpoint is often not indexed, but the work's
 * numeric Kikoeru id is already persisted on the imported work. Reuse
 * /api/work/<id> so rating hydration does not depend on search.
 */
export async function fetchKikoeruWorkById(workId, options = {}) {
    const id = String(workId || '').trim();
    if (!id) throw new Error('work id is required');
    const base = String(options.backendBase || ASMR_API_BASE).replace(/\/+$/, '');
    const work = await fetchKikoeruJson(`${base}/api/work/${encodeURIComponent(id)}`);
    return {
        rating: Number(work?.rate_average_2dp) || 0,
        ratingCount: Number(work?.rate_count) || 0,
    };
}

export async function fetchKikoeruWork(input, options = {}) {
    const parsed = parseKikoeruInput(input);
    if (!parsed) throw new Error('invalid kikoeru work url');
    const family = parsed.family || (parsed.host === 'asmr.one' ? 'asmr' : 'custom');
    let base = parsed.backendBase;
    if (family === 'asmr') {
        // 导入/切版本时先选当前最快 base;探测失败也要能继续,回退到 original。
        const selected = await selectBase({
            family: 'asmr',
            force: options.forceProbe === true,
            fetcher: options.probeFetcher,
            timeout: options.probeTimeout,
            signal: options.signal,
            now: options.now,
        }).catch(() => '');
        base = options.base || selected || ASMR_API_BASE;
        parsed.backendBase = base;
    }

    const requestJson = async (path) => {
        if (family !== 'asmr') return fetchKikoeruJson(`${base}${path}`);
        const result = await fetchVoiceJson(path, {
            family: 'asmr',
            base: base || undefined,
            fetcher: options.jsonFetcher,
            retries: options.retries,
            signal: options.signal,
            now: options.now,
        });
        if (result?.base) base = result.base;
        return result?.json;
    };

    const search = await requestJson(`/api/search/${encodeURIComponent(parsed.code)}`);
    const works = Array.isArray(search?.works) ? search.works : [];
    const found =
        works.find((work) => String(work.source_id || '').toUpperCase() === parsed.code) || works[0];
    if (!found?.id) throw new Error('work not found');
    const [work, tracks] = await Promise.all([
        requestJson(`/api/work/${encodeURIComponent(found.id)}`),
        requestJson(`/api/tracks/${encodeURIComponent(found.id)}?v=2`),
    ]);
    const normalized = normalizeKikoeruWork(work, tracks, { ...parsed, backendBase: base });
    // 导入时刚拉过 tracks,记录时间,播放时 TTL 内不必再请求。
    normalized.urlsResolvedAt = Date.now();
    if (normalized.sourceCode && normalized.sourceCode !== normalized.code) {
        // Kikoeru sometimes has the original JPN work even when it is not a
        // direct search result for the translation. Use that record when
        // available; a missing source record stays explicit as an empty circle
        // so the UI never presents the translator as the circle.
        try {
            const originalSearch = await requestJson(
                `/api/search/${encodeURIComponent(normalized.sourceCode)}`
            );
            const original = Array.isArray(originalSearch?.works) ? originalSearch.works[0] : null;
            if (original?.id) {
                const originalWork = await requestJson(`/api/work/${encodeURIComponent(original.id)}`);
                normalized.trueCircle = originalWork?.circle?.name || originalWork?.name || '';
            }
        } catch (error) {
            console.warn('Failed to resolve original voice circle:', error);
        }
        if (!normalized.trueCircle) {
            normalized.trueCircle = await fetchDlsiteSourceCircle(normalized.sourceCode);
        }
        // The card's circle is the original creator. The translated edition's
        // publisher belongs in translators, not in circle. If we cannot resolve
        // the original creator, leave circle empty instead of showing the
        // translator/translation group as the circle.
        const translatedCircle = String(normalized.circle || '').trim();
        if (normalized.trueCircle) {
            normalized.circle = normalized.trueCircle;
        } else {
            normalized.circle = '';
        }
        if (translatedCircle && translatedCircle !== normalized.circle) {
            normalized.translators = [...new Set([...(normalized.translators || []), translatedCircle])];
        }
    }
    return normalized;
}
