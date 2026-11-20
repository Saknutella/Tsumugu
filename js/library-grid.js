function updateNode(current, next) {
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
        current.replaceWith(next.cloneNode(true));
        return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    for (const name of current.getAttributeNames()) {
        if (!next.hasAttribute(name)) current.removeAttribute(name);
    }
    for (const attribute of next.attributes) {
        if (current.getAttribute(attribute.name) !== attribute.value)
            current.setAttribute(attribute.name, attribute.value);
    }
    const children = [...current.childNodes];
    [...next.childNodes].forEach((child, index) => {
        if (children[index]) updateNode(children[index], child);
        else current.append(child.cloneNode(true));
    });
    for (const child of children.slice(next.childNodes.length)) child.remove();
}

/** Retain cards and decoded images across filtering; discard entries removed from the library. */
export function createLibraryGridRenderer(keyAttribute) {
    const cards = new Map();
    return (container, markup, libraryIds) => {
        const validIds = new Set(libraryIds.map(String));
        for (const id of cards.keys()) {
            if (!validIds.has(id)) cards.delete(id);
        }
        const template = document.createElement('template');
        template.innerHTML = markup;
        const desired = [...template.content.children].map((next) => {
            const id = next.getAttribute(keyAttribute);
            if (id === null) return next;
            const html = next.outerHTML;
            const cached = cards.get(id);
            if (!cached) {
                cards.set(id, { node: next, html });
                return next;
            }
            if (cached.html !== html) {
                updateNode(cached.node, next);
                cached.html = html;
            }
            return cached.node;
        });
        const retained = new Set(desired);
        for (const node of [...container.childNodes]) {
            if (!retained.has(node)) node.remove();
        }
        let cursor = container.firstChild;
        for (const node of desired) {
            if (node !== cursor) container.insertBefore(node, cursor);
            cursor = node.nextSibling;
        }
    };
}
