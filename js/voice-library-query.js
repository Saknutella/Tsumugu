function normalize(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .trim();
}

function dateValue(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function ratingValue(value) {
    const rating = Number(value);
    return Number.isFinite(rating) ? rating : 0;
}

/** Keep query and ordering independent of the UI's facet filters. */
function subtitleSearchText(work) {
    return work.hasSubtitle || work.has_subtitle ? '带字幕 subtitled subtitles' : '';
}

function ageSearchText(work) {
    const category = String(work.ageCategory || '').toLowerCase();
    if (category === 'r15') return 'R-15 R15 15+';
    if (category === 'r18' || work.nsfw) return 'R-18 R18 成人 adult';
    return '全年龄 all ages';
}

export function queryVoiceLibrary(works, { query = '', sort = 'added' } = {}) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const order = ['added', 'release', 'rating', 'title'].includes(sort) ? sort : 'added';
    return works
        .map((work, index) => ({ work, index }))
        .filter(({ work }) => {
            const text = normalize(
                [
                    work.title,
                    work.code,
                    work.RJcode,
                    work.sourceCode,
                    ...(work.editionCodes || []).map((edition) => edition.code),
                    work.circle,
                    work.trueCircle,
                    ...(work.translators || []),
                    ...(work.artists || []),
                    ...(work.tags || []),
                    ageSearchText(work),
                    subtitleSearchText(work),
                ].join(' ')
            );
            return terms.every((term) => text.includes(term));
        })
        .sort((a, b) => {
            let difference;
            if (order === 'title') {
                difference = String(a.work.title || '').localeCompare(String(b.work.title || ''), 'ja', {
                    numeric: true,
                    sensitivity: 'base'
                });
            } else if (order === 'rating') {
                difference = ratingValue(b.work.rating) - ratingValue(a.work.rating);
            } else {
                const field = order === 'release' ? 'release' : 'importedAt';
                difference = dateValue(b.work[field]) - dateValue(a.work[field]);
            }
            // Explicit indices preserve library order for equal or absent metadata.
            return difference || a.index - b.index;
        })
        .map(({ work }) => work);
}
