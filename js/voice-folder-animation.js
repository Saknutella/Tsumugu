/** Keep native details semantics while delaying its instant hide until collapse finishes. */
export function animateVoiceFolders(root, signal) {
    for (const folder of root.querySelectorAll('.voice-album-folder')) {
        const summary = folder.querySelector(':scope > summary');
        const content = folder.querySelector(':scope > .voice-album-folder-children');
        if (!summary || !content) continue;
        let expanded = folder.open;
        let animation = null;
        let generation = 0;
        summary.setAttribute('aria-expanded', String(expanded));
        summary.addEventListener(
            'click',
            (event) => {
                // Checkboxes, view toggles and folder action menus live inside
                // <summary>; they must not also toggle the folder.
                if (event.target.closest?.('button, input, label, a')) return;
                event.preventDefault();
                const start = folder.open ? content.getBoundingClientRect().height : 0;
                const opacity = folder.open ? getComputedStyle(content).opacity : '0';
                animation?.cancel();
                const ticket = ++generation;
                expanded = !expanded;
                summary.setAttribute('aria-expanded', String(expanded));
                folder.dataset.folderExpanded = String(expanded);
                if (matchMedia('(prefers-reduced-motion: reduce)').matches || !content.animate) {
                    folder.open = expanded;
                    content.style.overflow = '';
                    return;
                }
                folder.open = true;
                content.style.overflow = 'hidden';
                animation = content.animate(
                    [
                        { height: `${start}px`, opacity },
                        { height: `${expanded ? content.scrollHeight : 0}px`, opacity: expanded ? '1' : '0' }
                    ],
                    { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' }
                );
                animation.onfinish = () => {
                    if (ticket !== generation) return;
                    folder.open = expanded;
                    animation?.cancel();
                    animation = null;
                    content.style.overflow = '';
                };
            },
            { signal }
        );
        signal.addEventListener(
            'abort',
            () => {
                generation++;
                animation?.cancel();
                folder.open = expanded;
                content.style.overflow = '';
            },
            { once: true }
        );
    }
}
