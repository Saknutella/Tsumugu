const EXTENSION_TYPES = {
    audio: ['aac', 'mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aiff', 'aif', 'wma'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg'],
    text: ['txt', 'text', 'md', 'markdown', 'lrc', 'srt', 'vtt', 'ass', 'ssa', 'csv', 'json', 'log'],
    video: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv'],
    pdf: ['pdf']
};
const DECLARED_TYPES = new Set(['folder', 'audio', 'image', 'text', 'video', 'pdf', 'other']);

/** Titles survive opaque streaming URLs and stale imported type labels; never mutate stored nodes. */
export function getVoiceFileType(node) {
    if (node?.type === 'folder') return 'folder';
    const title = String(node?.title || '').trim();
    const match = title.match(/\.([a-z0-9]+)$/i);
    if (match) {
        const extension = match[1].toLowerCase();
        const detected = Object.keys(EXTENSION_TYPES).find((type) => EXTENSION_TYPES[type].includes(extension));
        if (detected) return detected;
    }
    return DECLARED_TYPES.has(node?.type) ? node.type : 'other';
}
