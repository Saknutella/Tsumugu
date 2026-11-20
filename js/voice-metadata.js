// Merge the two remote metadata sources used by the local voice library.
//
// Kikoeru is usually richer for CV/tags/release/age; DLsite often has the
// authoritative rating/price that Kikoeru's translated-edition record omits.
// Neither source is complete by itself, so merge field by field instead of
// letting the first response win.
function uniqueStrings(...values) {
    const seen = new Set();
    const output = [];
    for (const list of values) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            const value = String(item ?? '').trim();
            if (!value) continue;
            const key = value.toLocaleLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            output.push(value);
        }
    }
    return output;
}

function uniqueEditions(...values) {
    const seen = new Set();
    const output = [];
    for (const list of values) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (!item || !item.code) continue;
            const code = String(item.code).toUpperCase();
            const key = `${code}:${String(item.lang || '')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            output.push({ ...item, code });
        }
    }
    return output;
}

export function mergeVoiceMetadata(kikoeru, dlsite) {
    const k = kikoeru && typeof kikoeru === 'object' ? kikoeru : {};
    const d = dlsite && typeof dlsite === 'object' ? dlsite : {};
    if (!k.title && !d.title) return null;
    const kikoeruAge = k.ageCategory && !['unrated', 'unknown'].includes(k.ageCategory) ? k.ageCategory : '';
    const dlsiteAge = d.ageCategory && !['unrated', 'unknown'].includes(d.ageCategory) ? d.ageCategory : '';
    const normalizedCode = (value) => String(value || '').toUpperCase();
    const translated = (meta) => Boolean(meta.code && meta.sourceCode && normalizedCode(meta.code) !== normalizedCode(meta.sourceCode));
    const kTranslated = translated(k);
    const dTranslated = translated(d);
    const kOriginalCircle = kTranslated ? '' : String(k.circle || '').trim();
    const dOriginalCircle = dTranslated ? '' : String(d.circle || '').trim();
    const trueCircle = String(k.trueCircle || d.trueCircle || kOriginalCircle || dOriginalCircle || '').trim();
    const circle = trueCircle || (!kTranslated ? String(k.circle || '').trim() : '') || (!dTranslated ? String(d.circle || '').trim() : '');
    const translators = uniqueStrings(
        k.translators,
        d.translators,
        kTranslated && k.circle ? [k.circle] : [],
        dTranslated && d.circle ? [d.circle] : [],
    );
    return {
        ...k,
        ...d,
        // DLsite is authoritative wherever it has a value: its product page
        // states `translation_info.original_workno`, so the identity fields must
        // come from it. Kikoeru only fills the gaps (tracks, CVs, richer tags).
        title: d.title || k.title,
        circle,
        trueCircle,
        artists: uniqueStrings(d.artists, k.artists),
        tags: uniqueStrings(k.tags, d.tags),
        rating: Number(d.rating) || Number(k.rating) || 0,
        ratingCount: Number(d.ratingCount) || Number(k.ratingCount) || 0,
        reviewCount: Number(k.reviewCount) || Number(d.reviewCount) || 0,
        soldCount: Number(k.soldCount) || Number(d.soldCount) || 0,
        price: Number(d.price) || Number(k.price) || 0,
        currency: d.currency || k.currency || 'JPY',
        release: d.release || k.release || '',
        ageCategory: dlsiteAge || kikoeruAge || d.ageCategory || k.ageCategory || 'unrated',
        nsfw: Boolean(d.nsfw || k.nsfw),
        sourceCode: d.sourceCode || k.sourceCode || '',
        sourceUrl: d.sourceUrl || k.sourceUrl || '',
        pageUrl: d.pageUrl || k.pageUrl || '',
        editionLang: d.editionLang || k.editionLang || '',
        editionLabel: d.editionLabel || k.editionLabel || '',
        editionCodes: uniqueEditions(d.editionCodes, k.editionCodes),
        translators,
        hasSubtitle: Boolean(k.hasSubtitle || d.hasSubtitle),
        // Cover: DLsite's image CDN is the canonical folder.jpg source; Kikoeru's
        // thumbnail is the fallback when the product page had no og:image.
        cover: d.cover || k.cover || '',
        thumbnail: d.thumbnail || k.thumbnail || d.cover || k.cover || '',
        duration: Number(k.duration) || Number(d.duration) || 0,
    };
}
