const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function inline(text, depth = 0) {
    if (depth > 8) return escape(text);
    // Parse source tokens before emitting HTML: formatting must never rewrite code or link attributes.
    const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s<>"')]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
    let output = '';
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        output += escape(text.slice(offset, match.index));
        if (match[1] !== undefined) output += `<code>${escape(match[1])}</code>`;
        else if (match[2] !== undefined) {
            let url;
            try { url = new URL(match[3]); } catch { /* Invalid links remain readable text. */ }
            output += url && ['https:', 'http:'].includes(url.protocol)
                ? `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${inline(match[2], depth + 1)}</a>`
                : escape(match[0]);
        } else if (match[4] !== undefined) output += `<strong>${inline(match[4], depth + 1)}</strong>`;
        else output += `<em>${inline(match[5], depth + 1)}</em>`;
        offset = match.index + match[0].length;
    }
    return output + escape(text.slice(offset));
}

/** Shared dependency-free reader subset; raw HTML and remote embedded images stay inert text. */
export function renderMarkdown(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let list = null;
    let code = null;
    let fence = '';
    const closeList = () => {
        if (list) output.push(`</${list}>`);
        list = null;
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (code !== null) {
            if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
                output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
                code = null;
            } else code.push(raw);
            continue;
        }
        if (marker) {
            closeList();
            code = [];
            fence = marker;
            continue;
        }
        if (!line.trim()) { closeList(); continue; }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        const item = /^\s*(?:([-*+]) |(\d+)\. )(.*)$/.exec(line);
        if (heading) {
            closeList();
            const level = Math.min(6, heading[1].length + 1);
            output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        } else if (line.startsWith('> ')) {
            closeList();
            output.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
        } else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            closeList();
            output.push('<hr />');
        } else if (item) {
            const kind = item[1] ? 'ul' : 'ol';
            if (list !== kind) { closeList(); output.push(`<${kind}>`); list = kind; }
            output.push(`<li>${inline(item[3])}</li>`);
        } else {
            closeList();
            const timestamp = /^(\d{1,2}:\d{2})\s+(.*)$/.exec(line);
            output.push(timestamp
                ? `<p class="creation-timestamp"><span class="creation-timestamp-time">${escape(timestamp[1])}</span><span>${inline(timestamp[2])}</span></p>`
                : `<p>${inline(line)}</p>`);
        }
    }
    if (code !== null) output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
    closeList();
    return output.join('');
}
