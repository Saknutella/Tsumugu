// Pawchive 帖子 → 创作页预览导入。
//
// 只解析公开页面的元数据、正文文本、缩略图和链接。图片(原图 + 缩略图,或只有缩略图时的预览)
// 由 creations.js 在导入后自动存到本地;其他附件文件仍由用户按需下载。
// 有 href 的 post__attachment-link 是真实附件;没有 href 的才标记 incomplete。

const PAWCHIVE_HOSTS = new Set(['pawchive.pw', 'www.pawchive.pw']);

export function isPawchivePostUrl(value) {
    try {
        const url = new URL(String(value));
        return (
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            PAWCHIVE_HOSTS.has(url.hostname) &&
            /\/post\/\d+/.test(url.pathname)
        );
    } catch {
        return false;
    }
}

function textOf(root, selector) {
    return root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function absoluteUrl(value, baseUrl) {
    if (!value) return '';
    try {
        const url = new URL(value, baseUrl);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

function extractDate(value) {
    const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : new Date().toISOString().slice(0, 10);
}

function safeDecode(value) {
    try {
        return decodeURIComponent(String(value));
    } catch {
        return String(value);
    }
}

function attachmentName(anchor, href) {
    const download = anchor.getAttribute('download');
    if (download) return safeDecode(download.split(/[\\/]/).pop());
    try {
        const url = new URL(href);
        const named = url.searchParams.get('f');
        if (named) return safeDecode(named.split(/[\\/]/).pop());
        const base = safeDecode(url.pathname.split('/').pop() || '');
        if (base) return base;
    } catch {
        /* fall through to text */
    }
    return anchor.textContent?.replace(/^download\s+/i, '').replace(/\s+/g, ' ').trim() || 'attachment';
}

function attachmentKind(name, mime = '') {
    const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    if (/^image\//.test(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(extension)) return 'image';
    if (/^audio\//.test(mime) || ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(extension)) return 'audio';
    if (/^video\//.test(mime) || ['mp4', 'webm', 'mkv', 'mov'].includes(extension)) return 'video';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(extension)) return 'archive';
    if (/^text\//.test(mime) || ['md', 'txt', 'json', 'csv'].includes(extension)) return 'text';
    return 'file';
}

function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// 「点预览图看原图」的原图是签名链接 `…/f/<id>/<名>?e=<到期>&s=<签名>`,每次抓页 e/s 都变
// (实测同一帖子隔 2 s 抓两次,签名不同)。附件 id 若跟着签名变,同 URL 重导时「保留现有文件」
// 就对不上已下载的本地原图。所以 id 只用去掉 e/s 后的 URL;没有签名的 URL 原样不变,
// 已导入帖子的附件 id 不受影响。
function stableAttachmentKey(href) {
    try {
        const url = new URL(href);
        if (!url.searchParams.has('e') || !url.searchParams.has('s')) return href;
        url.searchParams.delete('e');
        url.searchParams.delete('s');
        return url.href;
    } catch {
        return href;
    }
}

function normalizeContentLines(contentNode) {
    if (!contentNode) return [];
    const lines = [];
    const items = contentNode.querySelectorAll('li');
    if (items.length > 0) {
        items.forEach((item) => {
            const text = item.textContent.replace(/\s+/g, ' ').trim();
            if (text) lines.push(text);
        });
    } else {
        contentNode.querySelectorAll('p').forEach((paragraph) => {
            const text = paragraph.textContent.replace(/\s+/g, ' ').trim();
            if (text) lines.push(text);
        });
    }
    if (lines.length === 0) {
        const fallback = contentNode.textContent.replace(/\s+/g, ' ').trim();
        if (fallback) lines.push(fallback);
    }
    return lines.slice(0, 120);
}

export function parsePawchivePostHtml(html, sourceUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const postId = sourceUrl.match(/\/post\/(\d+)/)?.[1] ?? `${Date.now()}`;
    const title =
        textOf(doc, '.post__title span') ||
        doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
        textOf(doc, 'h1') ||
        `Pawchive post ${postId}`;
    const creator = textOf(doc, '.post__user-name') || 'Pawchive';
    const creatorHref = doc.querySelector('.post__user-name')?.getAttribute('href') ?? '';
    const creatorProfile = absoluteUrl(creatorHref, sourceUrl);
    const sourceIdentity = (creatorProfile || sourceUrl).match(/\/(patreon|fanbox|fantia|gumroad|subscribestar)\/user\/([^/]+)/i);
    const creatorSourceId = sourceIdentity?.[2] || creatorHref.match(/\/user\/([^/]+)/)?.[1] || '';
    const creatorPlatform = sourceIdentity?.[1]?.toLowerCase() || '';
    const creatorId =
        `pawchive-${creatorSourceId || creator.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/-+$/, '');
    const creatorUrl = creatorProfile || (sourceIdentity ? new URL(sourceIdentity[0], sourceUrl).href : '');
    const creatorHandle = `@${creator}`;
    const creatorBio = creatorSourceId ? 'Pawchive 创作者' : '';
    const published = textOf(doc, '.post__published');
    const date = extractDate(published);
    const contentNode = doc.querySelector('.post__content');
    const body = normalizeContentLines(contentNode);

    // 只有缩略图的帖子会有多个 .post__thumbnail(例如 post/144783018 有两张):
    // 全部进画廊预览,第一张当封面。只取 querySelector 的第一张会让其余图片静默消失。
    const thumbnails = [
        ...new Set(
            Array.from(doc.querySelectorAll('.post__thumbnail img'))
                .map((node) => absoluteUrl(node.getAttribute('data-src') || node.getAttribute('src'), sourceUrl))
                .filter(Boolean),
        ),
    ];
    const thumbnail = thumbnails[0] ?? '';
    const avatar =
        absoluteUrl(
            doc.querySelector('.post__user-profile img')?.getAttribute('src') ||
                doc.querySelector('.post__user img')?.getAttribute('src'),
            sourceUrl,
        ) || (creatorSourceId && creatorPlatform ? `https://pawchive.pw/icons/${creatorPlatform}/${creatorSourceId}` : '');
    const fallbackCover = absoluteUrl(
        doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '',
        sourceUrl,
    );
    const cover = thumbnail || avatar || fallbackCover;

    const links = [];
    const linkedImages = [];
    const imageFiles = [];
    const seenLinks = new Set();
    doc.querySelectorAll('.post__files a[href]').forEach((anchor) => {
        const href = absoluteUrl(anchor.getAttribute('href'), sourceUrl);
        if (!href || seenLinks.has(href)) return;
        seenLinks.add(href);
        const image = anchor.querySelector('img');
        const name = attachmentName(anchor, href);
        const kind = attachmentKind(name);

        // 图片帖的 <a> 指向原图，<img> 只是缩略图。
        // 缩略图只作为预览，附件和 gallery 的 canonical URL 始终是原图。
        if (image && kind === 'image') {
            const preview = absoluteUrl(
                image.getAttribute('data-src') || image.getAttribute('src') || '',
                sourceUrl,
            );
            const imageId = `att-${hashString(`${stableAttachmentKey(href)}|${name}`)}`;
            imageFiles.push({
                id: imageId,
                type: 'file',
                kind: 'image',
                name,
                title: name,
                src: href,
                sourceUrl: href,
                remoteUrl: href,
                previewUrl: preview,
                status: 'remote',
                localKey: '',
            });
            linkedImages.push({
                src: preview || href,
                full: href,
                alt: name || title,
                attachmentId: imageId,
            });
            return;
        }

        const label =
            anchor.querySelector('.embed-view h3')?.textContent?.replace(/\s+/g, ' ').trim() ||
            anchor.textContent?.replace(/\s+/g, ' ').trim() ||
            href;
        links.push({ type: 'link', name: label, title: label, src: href });
    });

    // 真实附件:有 href 的 post__attachment-link 是可下载文件,不能再一律当缺失。
    const downloadedFiles = [];
    const seenFiles = new Set();
    doc.querySelectorAll('.post__attachments a[href], .post__attachment-link[href]').forEach((anchor) => {
        const href = absoluteUrl(anchor.getAttribute('href'), sourceUrl);
        if (!href || seenFiles.has(href)) return;
        seenFiles.add(href);
        const name = attachmentName(anchor, href);
        const kind = attachmentKind(name);
        downloadedFiles.push({
            id: `att-${hashString(`${stableAttachmentKey(href)}|${name}`)}`,
            type: 'file',
            kind,
            name,
            title: name,
            src: href,
            sourceUrl: href,
            remoteUrl: href,
            status: 'remote',
            localKey: '',
        });
    });

    const missingAttachments = Array.from(
        doc.querySelectorAll('.post__attachment-link:not([href])'),
    )
        .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const missingStats = textOf(doc, '.post__missing-stats');
    const previewBadge = doc.querySelector('.state-badge--preview');
    const incomplete =
        missingAttachments.length > 0 || /missing/i.test(missingStats) || Boolean(previewBadge);
    const missingSummary = incomplete
        ? missingStats || `${missingAttachments.length} attachment(s) missing on the source page`
        : '';

    const excerpt = body.slice(0, 2).join(' · ').slice(0, 180) || `${creator} · Pawchive`;
    const nsfw = /(?:R-?18|18\+|NSFW|成人向|成人)/i.test(doc.body?.textContent || '');
    return {
        nsfw,
        id: `pawchive-${postId}`,
        title,
        creator,
        creatorId,
        creatorHandle,
        creatorAvatar: avatar,
        creatorUrl,
        creatorPlatform,
        creatorSourceId,
        creatorBio,
        date,
        tags: ['Pawchive', '预览'],
        cover,
        excerpt,
        body,
        gallery:
            linkedImages.length > 0
                ? linkedImages
                : // 只有缩略图、没有原图链接:缩略图要在导入时存成本地预览,需要一个稳定的本地 key。
                  // 不用 att- 前缀、也不进 attachments —— 这不是原图附件,不能被当成可下载的原图。
                  thumbnails.map((src) => ({
                      src,
                      alt: title,
                      previewId: `prev-${hashString(stableAttachmentKey(src))}`,
                      status: 'remote',
                      localKey: '',
                  })),
        attachments: [...downloadedFiles, ...imageFiles, ...links],
        sourceUrl,
        importedFrom: sourceUrl,
        sourcePostId: postId,
        provider: 'pawchive',
        incomplete,
        missingSummary,
        missingAttachments,
    };
}
