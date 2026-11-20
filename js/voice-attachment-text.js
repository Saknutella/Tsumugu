export const MAX_VOICE_TEXT_BYTES = 2 * 1024 * 1024;

/** Prefer declared/BOM encodings, then strict UTF-8, then common Japanese legacy text. */
export function decodeVoiceText(bytes, contentType = '') {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let encoding = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
    if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le';
    else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be';
    else if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) encoding = 'utf-8';
    if (encoding) {
        try {
            return { text: new TextDecoder(encoding, { fatal: true }).decode(data), encoding };
        } catch {
            /* Incorrect server charset labels must not prevent a readable fallback. */
        }
    }
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'UTF-8' };
    } catch {
        return { text: new TextDecoder('shift_jis').decode(data), encoding: 'Shift_JIS' };
    }
}

export async function loadVoiceAttachmentText(url, { signal } = {}) {
    const target = new URL(url, window.location.href);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
        throw new Error('Invalid text URL');
    // Kikoeru's opaque media IDs do not expose an extension; the caller already knows the node type.
    const proxied =
        ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
        /^\/(?:api\/)?media\/stream\//.test(target.pathname);
    const endpoint = proxied ? `/__kikoeru_text?url=${encodeURIComponent(target.href)}` : target.href;
    let response;
    try {
        response = await fetch(endpoint, { signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // A proxy error page is still a 200; do not pass HTML error bodies to the
        // subtitle parser as if they were VTT/SRT content.
        if (proxied && /text\/html/i.test(response.headers.get('content-type') || '')) {
            throw new Error('proxy returned HTML');
        }
    } catch (error) {
        if (!proxied || signal?.aborted) throw error;
        // The media CDN often allows direct CORS while the dev text proxy's
        // outbound transport is temporarily unavailable. Try direct once.
        console.warn('Kikoeru text proxy failed, trying direct media URL:', error?.message || error);
        response = await fetch(target.href, { signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
    if (Number(response.headers.get('content-length')) > MAX_VOICE_TEXT_BYTES)
        throw new Error('Text file is too large');
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_VOICE_TEXT_BYTES) {
                await reader.cancel();
                throw new Error('Text file is too large');
            }
            chunks.push(value);
        }
    } else {
        const value = new Uint8Array(await response.arrayBuffer());
        total = value.length;
        if (total > MAX_VOICE_TEXT_BYTES) throw new Error('Text file is too large');
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return decodeVoiceText(bytes, response.headers.get('content-type') || '');
}
