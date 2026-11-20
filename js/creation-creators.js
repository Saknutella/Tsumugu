const text = (value) => (typeof value === 'string' ? value.trim() : '');

function safeUrl(value) {
    try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
}

function sourceIdentity(post) {
    const platform = text(post.creatorPlatform || post.sourcePlatform).toLowerCase();
    const sourceId = text(post.creatorSourceId || post.sourceCreatorId);
    const explicit = /^[a-z][a-z0-9_-]*$/.test(platform) && sourceId ? { platform, sourceId } : null;
    for (const value of [post.creatorUrl, post.sourceUrl, post.importedFrom]) {
        const url = safeUrl(value);
        if (!url) continue;
        const match = url.pathname.match(/^\/(patreon|fanbox|fantia|gumroad|subscribestar)\/user\/([^/]+)/i);
        if (match) {
            url.pathname = match[0];
            url.search = '';
            url.hash = '';
            return { ...(explicit || { platform: match[1].toLowerCase(), sourceId: match[2] }), sourceUrl: url.href };
        }
        if (/(^|\.)patreon\.com$/.test(url.hostname)) {
            const id = url.searchParams.get('u') || url.pathname.match(/^\/user\/([^/]+)/)?.[1];
            if (id) return { ...(explicit || { platform: 'patreon', sourceId: id }), sourceUrl: url.href };
        }
        if (/(^|\.)fanbox\.cc$/.test(url.hostname)) {
            const id = url.pathname.match(/^\/@([^/]+)/)?.[1] || url.pathname.match(/^\/users\/([^/]+)/)?.[1];
            if (id) return { ...(explicit || { platform: 'fanbox', sourceId: id }), sourceUrl: url.href };
        }
    }
    return explicit;
}

function hash(value) {
    let result = 2166136261;
    for (const char of value) result = Math.imul(result ^ char.codePointAt(0), 16777619);
    return (result >>> 0).toString(36);
}

function identity(post, knownCreators) {
    const source = sourceIdentity(post);
    if (source) return source;
    const legacy = text(post.creatorId);
    if (!post.imported && knownCreators[legacy]) return { platform: 'local', sourceId: legacy };
    // Generic import IDs describe an ingestion slot, rather than a person.
    const generic = !legacy || /^(pawchive|local(?:-\d+)?|imported(?:-\d+)?)$/i.test(legacy);
    return {
        platform: 'imported',
        sourceId: generic ? `${legacy || 'unknown'}-${hash(text(post.creator) || text(post.id))}` : legacy
    };
}

export function creatorPath(creator) {
    return `/creations/creator/${encodeURIComponent(creator.platform)}/${encodeURIComponent(creator.sourceId)}`;
}

/** Build a derived registry without changing source IDs or attachment nodes. */
export function buildCreationCreators(posts, { knownCreators = {}, stored = [] } = {}) {
    const registry = new Map();
    function ensure(platform, sourceId) {
        const id = `${platform}/${sourceId}`;
        if (!registry.has(id)) {
            const creator = {
                id,
                platform,
                sourceId,
                name: '',
                handle: '',
                avatar: '',
                bio: '',
                sourceUrl: '',
                aliases: [],
                tags: [],
                postIds: []
            };
            creator.path = creatorPath(creator);
            registry.set(id, creator);
        }
        return registry.get(id);
    }
    function merge(creator, data) {
        if (Array.isArray(data.tags)) creator.tags.push(...data.tags.filter((tag) => text(tag)));
        for (const key of ['name', 'handle', 'avatar', 'bio', 'sourceUrl']) {
            const value = text(data[key]);
            if (!value || (key === 'sourceUrl' && !safeUrl(value))) continue;
            // 占位头像不是真有头像:已经拿到真头像后,后面的来源(尤其旧记录里的
            // imported.svg)不能把它盖掉。两种占位文件名都要认。
            if (key === 'avatar' && /(?:^|\/)(?:imported|creation-avatar-placeholder)\.svg(?:[?#]|$)/.test(value) && creator.avatar) continue;
            if (key === 'bio' && value === 'Pawchive 创作者' && creator.bio) continue;
            creator[key] = value;
        }
    }
    for (const data of stored) {
        if (!text(data.platform) || !text(data.sourceId)) continue;
        const creator = ensure(data.platform, data.sourceId);
        merge(creator, data);
        creator.aliases.push(...(Array.isArray(data.aliases) ? data.aliases.filter((alias) => text(alias)) : []));
    }
    const ordered = [...posts].sort((a, b) => {
        const time = (post) => Date.parse(post.updatedAt || post.importedAt || post.date || '') || 0;
        return time(a) - time(b);
    });
    for (const post of ordered) {
        const source = identity(post, knownCreators);
        const creator = ensure(source.platform, source.sourceId);
        const known = source.platform === 'local' ? knownCreators[post.creatorId] : null;
        if (known) merge(creator, known);
        merge(creator, {
            name: post.creator,
            handle: post.creatorHandle,
            avatar: post.creatorAvatar,
            bio: post.creatorBio,
            tags: post.tags,
            sourceUrl: source.sourceUrl || post.creatorUrl
        });
        if (text(post.creatorId)) creator.aliases.push(post.creatorId);
        if (text(post.id)) creator.postIds.push(post.id);
    }
    return [...registry.values()].map((creator) => ({
        ...creator,
        handle: creator.handle || (creator.name ? `@${creator.name}` : ''),
        avatar: creator.avatar || '/assets/creation-avatar-placeholder.svg',
        tags: [...new Set(creator.tags)],
        aliases: [...new Set(creator.aliases)],
        postIds: [...new Set(creator.postIds)]
    }));
}

export function resolveCreationCreator(reference, creators) {
    const value = text(reference).replace(/^\/creations\/(?:creator|artist)\//, '');
    const direct = creators.filter((creator) => creator.id === value);
    if (direct.length === 1) return direct[0];
    let decoded;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        return null;
    }
    const canonical = creators.filter((creator) => creator.id === decoded);
    if (canonical.length === 1) return canonical[0];
    const matches = creators.filter((creator) => creator.aliases.includes(decoded));
    return matches.length === 1 ? matches[0] : null;
}

export function creatorForPost(post, creators) {
    const source = sourceIdentity(post);
    if (source) return resolveCreationCreator(`${source.platform}/${source.sourceId}`, creators);
    const matches = creators.filter((creator) => creator.postIds.includes(post.id));
    return matches.length === 1 ? matches[0] : resolveCreationCreator(post.creatorId, creators);
}
