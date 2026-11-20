import { getCoverColorFromImage } from './cover-palette.js';
import { dynamicColorSettings } from './storage.js';

const palettes = new Map();
const pending = new Map();
const CACHE_LIMIT = 64;
const properties = [
    '--cover-theme-accent',
    '--cover-theme-foreground',
    '--cover-theme-rgb',
    '--cover-theme-secondary',
    '--cover-theme-secondary-foreground'
];

function imageSource(url) {
    const parsed = new URL(url, window.location.href);
    // CSS may have populated an opaque HTTP cache entry; keep the upstream
    // cache-bypass convention so the canvas receives a fresh CORS response.
    if (/^https?:$/.test(parsed.protocol) && parsed.origin !== window.location.origin) {
        if (!parsed.searchParams.has('not-from-cache-please')) {
            parsed.searchParams.set('not-from-cache-please', '');
        }
        return parsed.href;
    }
    return url;
}

function luminance(channels) {
    const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function foreground(channels) {
    const value = luminance(channels);
    return (value + 0.05) / 0.05 >= 1.05 / (value + 0.05) ? '#000000' : '#ffffff';
}

function makePalette(color) {
    if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return null;
    const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
    // Derive a deliberate second surface from this cover, never the global/player theme.
    // Dark covers need a lighter surface; further darkening them would hide the split.
    const dark = luminance(channels) < 0.12;
    const secondary = channels.map((channel) => Math.round(
        dark ? channel + (255 - channel) * 0.2 : channel * 0.78
    ));
    return {
        color: color.toLowerCase(),
        foreground: foreground(channels),
        rgb: channels.join(', '),
        secondaryColor: '#' + secondary.map((channel) => channel.toString(16).padStart(2, '0')).join(''),
        secondaryForeground: foreground(secondary)
    };
}

export function loadCoverPalette(url) {
    if (!url) return Promise.resolve(null);
    if (palettes.has(url)) {
        const palette = palettes.get(url);
        palettes.delete(url);
        palettes.set(url, palette);
        return Promise.resolve(palette);
    }
    if (pending.has(url)) return pending.get(url);
    const request = new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = async () => {
            try {
                if (typeof image.decode === 'function') await image.decode();
                resolve(makePalette(getCoverColorFromImage(image)));
            } catch (error) {
                reject(error);
            }
        };
        image.onerror = () => reject(new Error('Cover image could not be loaded with CORS.'));
        image.src = imageSource(url);
    }).then((palette) => {
        palettes.set(url, palette);
        if (palettes.size > CACHE_LIMIT) palettes.delete(palettes.keys().next().value);
        return palette;
    }).finally(() => {
        // Failures are deliberately absent from the LRU, allowing transient
        // network/CORS failures to recover on the next refresh.
        pending.delete(url);
    });
    pending.set(url, request);
    return request;
}

function clearTheme(target) {
    if (!target) return;
    properties.forEach((property) => target.style.removeProperty(property));
    delete target.dataset.coverTheme;
}

function applyTheme(target, palette) {
    if (!target) return;
    target.style.setProperty(properties[0], palette.color);
    target.style.setProperty(properties[1], palette.foreground);
    target.style.setProperty(properties[2], palette.rgb);
    target.style.setProperty(properties[3], palette.secondaryColor);
    target.style.setProperty(properties[4], palette.secondaryForeground);
    target.dataset.coverTheme = 'active';
}

export function bindCoverTheme(target, { coverUrl = '', isCurrent = () => true } = {}) {
    let source = coverUrl;
    let generation = 0;
    let disposed = false;

    const clear = () => {
        clearTheme(target);
    };
    const refresh = async () => {
        if (disposed) return null;
        const currentGeneration = ++generation;
        clear();
        if (!source || !dynamicColorSettings.isEnabled() || !isCurrent()) return null;
        try {
            const palette = await loadCoverPalette(source);
            if (disposed || currentGeneration !== generation || !isCurrent()) return null;
            if (!palette || !dynamicColorSettings.isEnabled()) return null;
            applyTheme(target, palette);
            return palette;
        } catch {
            // A failed cover must retain the ordinary CSS fallback, never an
            // unrelated previous cover's color or an unhandled rejection.
            return null;
        }
    };
    const onStorage = (event) => {
        if (event.key === null || event.key === dynamicColorSettings.STORAGE_KEY) {
            void refresh();
        }
    };
    window.addEventListener('dynamic-color-changed', refresh);
    window.addEventListener('storage', onStorage);
    void refresh();

    return {
        setCover(url) {
            if (disposed) return Promise.resolve(null);
            source = url || '';
            return refresh();
        },
        refresh,
        dispose() {
            disposed = true;
            generation += 1;
            window.removeEventListener('dynamic-color-changed', refresh);
            window.removeEventListener('storage', onStorage);
            clear();
        }
    };
}
