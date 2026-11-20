import { getCreationLibraryDate } from './creation-library-query.js';
import '../creation-creator.css';
import { t } from './i18n.js';

const FALLBACK_AVATAR = '/assets/creation-avatar-placeholder.svg';

function normalized(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .trim();
}

function hasMedia(post, type) {
    const attachments = post.attachments || [];
    if (type === 'all') return true;
    if (type === 'image')
        return (
            Boolean(post.gallery?.length) || attachments.some((item) => item.type === 'image' || item.kind === 'image')
        );
    if (type === 'text') return attachments.some((item) => item.type === 'description' || item.kind === 'text');
    if (type === 'files') return attachments.some((item) => item.type === 'file');
    return attachments.some((item) => item.type === type);
}

/** Adapt the shared artist template without destroying the music artist's listeners. */
export function mountCreationCreatorView({
    creator,
    posts,
    renderCard,
    onPlay,
    onOpenPost,
    onCreator,
    onFilterCreator
}) {
    const page = document.getElementById('page-artist');
    if (!page) return () => {};
    const restorers = [];
    const inserted = [];
    const listen = (node, type, handler) => {
        node.addEventListener(type, handler);
        restorers.push(() => node.removeEventListener(type, handler));
    };
    const attribute = (node, name, value) => {
        const previous = node.getAttribute(name);
        restorers.push(() => (previous === null ? node.removeAttribute(name) : node.setAttribute(name, previous)));
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
    };
    const contents = (node, text = '') => {
        const children = [...node.childNodes];
        restorers.push(() => node.replaceChildren(...children));
        node.textContent = text;
    };
    const insert = (node, parent, before = null) => {
        parent.insertBefore(node, before);
        inserted.push(node);
        return node;
    };
    const ownPosts = (Array.isArray(posts) ? posts : []).filter((post) => creator.postIds?.includes(post.id));
    const grid = page.querySelector('#artist-detail-albums');
    const section = grid.closest('section');
    attribute(page, 'class', `${page.className} creation-creator-page`);
    for (const other of page.querySelectorAll(':scope > section')) {
        if (other !== section) attribute(other, 'hidden', '');
    }
    const banner = page.querySelector('#artist-detail-banner-container');
    if (banner) attribute(banner, 'hidden', '');
    contents(page.querySelector('#artist-detail-name'), creator.name || t('creations.creatorPage.unknownProfile'));
    const imported = ownPosts.filter((post) => post.imported).length;
    contents(
        page.querySelector('#artist-detail-meta'),
        [
            t('creations.artist'),
            creator.platform || creator.provider,
            imported
                ? t('creations.creatorPage.importedCount', { count: imported })
                : t('creations.creatorPage.workCount', { count: ownPosts.length })
        ]
            .filter(Boolean)
            .join(' · ')
    );
    contents(page.querySelector('#artist-detail-bio'), creator.bio || '');
    const bio = page.querySelector('#artist-detail-bio');
    attribute(bio, 'class', 'artist-bio');
    const oldBioClick = bio.onclick;
    bio.onclick = null;
    restorers.push(() => {
        bio.onclick = oldBioClick;
    });
    const image = page.querySelector('#artist-detail-image');
    attribute(image, 'style', '');
    attribute(page.querySelector('#artist-detail-name'), 'style', '');
    const libraryLink = document.querySelector('#sidebar-nav-creations a');
    if (libraryLink) attribute(libraryLink, 'class', `${libraryLink.className} active`);
    attribute(image, 'crossorigin', null);
    attribute(image, 'alt', creator.name || t('creations.creatorPage.unknownProfile'));
    listen(image, 'error', () => {
        if (image.getAttribute('src') !== FALLBACK_AVATAR) image.setAttribute('src', FALLBACK_AVATAR);
    });
    attribute(image, 'src', creator.avatar || FALLBACK_AVATAR);
    const socials = page.querySelector('#artist-detail-socials');
    contents(socials);
    try {
        const url = new URL(creator.sourceUrl);
        if (['http:', 'https:'].includes(url.protocol)) {
            const link = document.createElement('a');
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = t('creations.creatorPage.sourceLink');
            socials.append(link);
        }
    } catch {
        /* Missing or unsafe source URLs do not become navigation targets. */
    }
    const actions = page.querySelector('.detail-header-actions');
    for (const child of actions.children) attribute(child, 'hidden', '');
    const controls = insert(document.createElement('div'), actions);
    controls.className = 'creation-creator-controls';
    const postTime = (post) => Date.parse(getCreationLibraryDate(post).value) || 0;
    // Stable source indices retain the library order when dates are equal or missing.
    const audioPosts = ownPosts
        .map((post, index) => ({ post, index }))
        .filter(({ post }) => hasMedia(post, 'audio'))
        .sort((a, b) => postTime(b.post) - postTime(a.post) || a.index - b.index)
        .map(({ post }) => post);
    if (audioPosts.length) {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'btn-primary';
        play.id = 'creation-creator-play';
        play.textContent = t('creations.creatorPage.playAll');
        controls.append(play);
        listen(play, 'click', () => onPlay?.(audioPosts));
    }
    const back = document.createElement('a');
    back.href = '/creations';
    back.className = 'btn-secondary';
    back.textContent = t('creations.creatorPage.back');
    controls.append(back);
    contents(section.querySelector('h2'), t('creations.creatorPage.works'));
    contents(grid);
    attribute(grid, 'class', `${grid.className} creations-grid`);
    const toolbar = insert(document.createElement('div'), section, grid);
    toolbar.className = 'creation-creator-toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.id = 'creation-creator-search';
    search.placeholder = t('creations.creatorPage.search');
    search.setAttribute('aria-label', t('creations.creatorPage.search'));
    toolbar.append(search);
    const select = (label, choices) => {
        const node = document.createElement('select');
        node.setAttribute('aria-label', label);
        for (const [value, text] of choices) node.add(new Option(text, value));
        toolbar.append(node);
        return node;
    };
    const media = select(t('creations.creatorPage.mediaLabel'), [
        ['all', t('creations.creatorPage.allMedia')],
        ['audio', t('creations.creatorPage.audio')],
        ['image', t('creations.creatorPage.image')],
        ['video', t('creations.creatorPage.video')],
        ['text', t('creations.creatorPage.text')],
        ['files', t('creations.creatorPage.files')]
    ]);
    const tags = [...new Set(ownPosts.flatMap((post) => post.tags || []))].sort();
    const tag = select(t('creations.creatorPage.tagLabel'), [
        ['', t('creations.creatorPage.allTags')],
        ...tags.map((value) => [value, `#${value}`])
    ]);
    const sort = select(t('creations.creatorPage.sortLabel'), [
        ['date', t('creations.creatorPage.newest')],
        ['oldest', t('creations.creatorPage.oldest')],
        ['title', t('creations.creatorPage.title')]
    ]);
    const feedback = insert(document.createElement('p'), section, grid);
    feedback.className = 'creation-creator-feedback';
    feedback.setAttribute('role', 'status');
    const render = () => {
        const terms = normalized(search.value).split(/\s+/).filter(Boolean);
        const filtered = ownPosts
            .filter((post) => {
                const text = normalized(
                    [
                        post.title,
                        post.excerpt,
                        ...(post.tags || []),
                        ...(post.attachments || []).flatMap((attachment) => [attachment.title, attachment.name])
                    ].join(' ')
                );
                return (
                    terms.every((term) => text.includes(term)) &&
                    hasMedia(post, media.value) &&
                    (!tag.value || (post.tags || []).includes(tag.value))
                );
            })
            .sort((a, b) => {
                if (sort.value === 'title')
                    return String(a.title || '').localeCompare(String(b.title || ''), 'zh', { numeric: true });
                const time = (post) => Date.parse(getCreationLibraryDate(post).value) || 0;
                return sort.value === 'oldest' ? time(a) - time(b) : time(b) - time(a);
            });
        grid.innerHTML = filtered.map((post) => renderCard(post)).join('');
        feedback.textContent =
            t('creations.creatorPage.feedback', { shown: filtered.length, total: ownPosts.length }) +
            (filtered.length ? '' : ` · ${t('creations.creatorPage.empty')}`);
    };
    listen(search, 'input', render);
    for (const node of [media, tag, sort]) listen(node, 'change', render);
    listen(grid, 'click', (event) => {
        const target = event.target;
        const profile = target.closest('[data-creator-profile-id]');
        const filter = target.closest('[data-filter-creator-id]');
        const creatorLink = target.closest('.creation-creator-link');
        if (profile || filter || creatorLink) {
            event.preventDefault();
            event.stopPropagation();
            if (filter) onFilterCreator?.(filter.dataset.filterCreatorId);
            else onCreator?.(profile?.dataset.creatorProfileId || creator.id);
            return;
        }
        if (target.closest('a, button, input, select, textarea, [contenteditable="true"]')) return;
        const card = target.closest('.creation-card[data-id]');
        if (card) {
            event.stopPropagation();
            onOpenPost?.(card.dataset.id);
        }
    });
    listen(grid, 'keydown', (event) => {
        if (!['Enter', ' '].includes(event.key) || !event.target.matches('.creation-card[data-id]')) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenPost?.(event.target.dataset.id);
    });
    render();
    let cleaned = false;
    return () => {
        if (cleaned) return;
        cleaned = true;
        for (const node of inserted) node.remove();
        for (const restore of restorers.reverse()) restore();
    };
}
