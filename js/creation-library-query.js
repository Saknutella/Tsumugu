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

export function getCreationOrigin(post) {
    if (['local', 'web'].includes(post?.importKind)) return post.importKind;
    return /^https?:/i.test(post?.sourceUrl || post?.importedFrom || '') ||
        Boolean(post?.provider && post.provider !== 'local')
        ? 'web'
        : 'local';
}

export function getCreationLibraryDate(post) {
    const localImport = post?.imported && getCreationOrigin(post) === 'local';
    return {
        kind: localImport ? 'imported' : 'published',
        value: localImport ? post.importedAt || '' : post?.date || ''
    };
}

export function formatCreationLibraryDate(post) {
    const { kind, value } = getCreationLibraryDate(post);
    if (!value) return '—';
    // Preserve a source's calendar publication date; local imports use the runtime's local calendar.
    if (kind === 'published' && /^\d{4}-\d{2}-\d{2}/.test(value)) return String(value).slice(0, 10);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getCreationMediaTypes(post) {
    const types = new Set();
    if (Array.isArray(post?.gallery) && post.gallery.length) types.add('image');
    for (const attachment of Array.isArray(post?.attachments) ? post.attachments : []) {
        const type = attachment?.type;
        if (type === 'description') types.add('text');
        else if (type === 'gallery') types.add('image');
        else if (type === 'file') {
            types.add(['image', 'text', 'archive'].includes(attachment.kind) ? attachment.kind : 'file');
        } else if (['audio', 'image', 'video', 'text', 'archive', 'link'].includes(type)) types.add(type);
    }
    return ['audio', 'image', 'video', 'text', 'archive', 'file', 'link'].filter((type) => types.has(type));
}

function selectedValues(values) {
    return new Set(Array.isArray(values) || values instanceof Set ? values : []);
}

/** Search only display metadata: attachment URLs may contain private tokens. */
export function queryCreationLibrary(
    posts,
    {
        query = '',
        sort = 'date',
        source = 'all',
        creatorName = () => '',
        creatorId = (post) => post.creatorId,
        creatorIds = [],
        tags = [],
        media = []
    } = {}
) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const order = ['date', 'added', 'title'].includes(sort) ? sort : 'date';
    const origin = ['all', 'imported', 'sample'].includes(source) ? source : 'all';
    const creatorsSelected = selectedValues(creatorIds);
    const tagsSelected = selectedValues(tags);
    const mediaSelected = selectedValues(media);
    return (Array.isArray(posts) ? posts : [])
        .map((post, index) => ({ post, index }))
        .filter(({ post }) => {
            if (origin !== 'all' && Boolean(post.imported) !== (origin === 'imported')) return false;
            if (creatorsSelected.size && !creatorsSelected.has(creatorId(post))) return false;
            if (tagsSelected.size && !(Array.isArray(post.tags) ? post.tags : []).some((tag) => tagsSelected.has(tag)))
                return false;
            if (mediaSelected.size && !getCreationMediaTypes(post).some((type) => mediaSelected.has(type)))
                return false;
            const attachments = Array.isArray(post.attachments) ? post.attachments : [];
            const text = normalize(
                [
                    post.title,
                    post.creator,
                    creatorName(post),
                    post.excerpt,
                    ...(Array.isArray(post.tags) ? post.tags : []),
                    ...attachments.flatMap((attachment) => [attachment.title, attachment.name])
                ].join(' ')
            );
            return terms.every((term) => text.includes(term));
        })
        .sort((a, b) => {
            let difference;
            if (order === 'title') {
                difference = String(a.post.title || '').localeCompare(String(b.post.title || ''), 'ja', {
                    numeric: true,
                    sensitivity: 'base'
                });
            } else {
                const value = (post) =>
                    dateValue(order === 'added' ? post.importedAt || post.date : getCreationLibraryDate(post).value);
                difference = value(b.post) - value(a.post);
            }
            // Explicit indices keep equal or missing metadata in library order.
            return difference || a.index - b.index;
        })
        .map(({ post }) => post);
}

/** Retain the full domain so a selected zero-count option remains available to remove. */
export function getCreationFacetCounts(posts, options = {}) {
    const library = Array.isArray(posts) ? posts : [];
    const creatorId = options.creatorId || ((post) => post.creatorId);
    const facets = {
        creators: { option: 'creatorIds', values: (post) => [creatorId(post)] },
        tags: { option: 'tags', values: (post) => (Array.isArray(post.tags) ? post.tags : []) },
        media: { option: 'media', values: getCreationMediaTypes }
    };
    return Object.fromEntries(
        Object.entries(facets).map(([name, facet]) => {
            const domain = new Map();
            for (const post of library) {
                for (const value of facet.values(post)) {
                    if (typeof value === 'string' && value) domain.set(value, 0);
                }
            }
            const matching = queryCreationLibrary(library, { ...options, [facet.option]: [] });
            for (const post of matching) {
                for (const value of new Set(facet.values(post))) {
                    if (domain.has(value)) domain.set(value, domain.get(value) + 1);
                }
            }
            return [
                name,
                [...domain].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([value, count]) => ({ value, count }))
            ];
        })
    );
}
