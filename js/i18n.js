// 极简 i18n 层:英文默认 + 中文界面,资源随构建内联(i18next initImmediate:false 保证同步可用)。
//
// 两层文案:
//   1. 显式 key:静态 DOM 用 `data-i18n*` 属性,动态字符串用 `t(key)`。
//   2. 源文本映射(第二批起):`locales/zh-CN.dom.json` 是「英文原文 → 中文」词典,
//      applyDomTranslations() 遍历文本节点/属性,精确匹配后原地替换;切回英文时还原。
//      为什么加这层:Monochrome 的 400KB 手写 HTML 有上千条文案,逐条加 data-i18n 成本过高;
//      gettext 式映射能一次性覆盖静态界面,并且不改变 DOM 结构。
//
// 覆盖范围与未覆盖清单见 docs/07-i18n.md(项目文档)。

import i18next from 'i18next';
import en from '../locales/en.json';
import zhCN from '../locales/zh-CN.json';
import zhCnDom from '../locales/zh-CN.dom.json';

const STORAGE_KEY = 'monochrome-language';
const SUPPORTED = ['en', 'zh-CN'];

/** 语言选择器用的元数据(语言名用自身语言写,不翻译)。 */
export const SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English' },
    { code: 'zh-CN', label: '简体中文' },
];

function readStoredLanguage() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored !== null && SUPPORTED.includes(stored)) return stored;
    } catch {
        // 隐私模式等情况下 localStorage 可能不可用。
    }
    return null;
}

function detectLanguage() {
    const stored = readStoredLanguage();
    if (stored !== null) return stored;
    const browser = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
    return browser.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

let ready = false;

/** 初始化一次;资源是本地 JSON,initImmediate:false 时同步可用。 */
export function initializeI18n() {
    if (ready) return i18next;
    i18next.init({
        lng: detectLanguage(),
        fallbackLng: 'en',
        supportedLngs: SUPPORTED,
        resources: {
            en: { translation: en },
            'zh-CN': { translation: zhCN },
        },
        interpolation: { escapeValue: false },
        // 关键:不要异步加载资源,否则首屏 applyTranslations 时 t() 还没有底层数据。
        initImmediate: false,
        returnNull: false,
    });
    ready = true;
    return i18next;
}

/** 翻译一个 key;缺失时返回 key 本身,方便在页面上一眼看出漏翻。 */
export function t(key, options) {
    if (!ready) initializeI18n();
    return i18next.t(key, options);
}

export function getLanguage() {
    if (!ready) initializeI18n();
    return i18next.language || 'en';
}

/** 把静态 DOM 上的 data-i18n* 属性翻译成当前语言。 */
export function applyTranslations(root = document) {
    if (!ready) initializeI18n();
    if (!root?.querySelectorAll) return;
    for (const element of root.querySelectorAll('[data-i18n]')) {
        element.textContent = t(element.dataset.i18n);
    }
    for (const element of root.querySelectorAll('[data-i18n-title]')) {
        element.setAttribute('title', t(element.dataset.i18nTitle));
    }
    for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
        element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder));
    }
    for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
        element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    }
    if (document?.documentElement) {
        document.documentElement.lang = getLanguage();
    }
}

// ── 源文本字典(第二批)───────────────────────────────────────────────────
//
// 精确匹配整段文本(trim 后),不做子串替换;因此不会误伤曲名/歌手名。
// 只在 zh-CN 下替换,切回 en 时从 Map 还原,保证原文不丢。

const DOM_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CODE', 'PRE', 'TEXTAREA']);
const originalTexts = new Map();
const originalAttrs = new Map();

// 候选文案来自原始 HTML,可能带 &amp; / &plusmn; / &deg; 等实体;DOM 文本已解码,
// 所以查表前统一解码 + 折叠空白,否则永远匹配不上。
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    plusmn: '±',
    deg: '°',
    times: '×',
    divide: '÷',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    middot: '·',
    bull: '•',
    trade: '™',
    copy: '©',
    reg: '®',
};

function decodeEntities(value) {
    return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        if (body.startsWith('#')) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
}

/** 查表 key:解码实体并折叠空白(与 .scratch/merge-translations.mjs 的 normalize 一致)。 */
function normalizeDomKey(value) {
    return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

const domLookup = new Map(Object.entries(zhCnDom).map(([key, value]) => [normalizeDomKey(key), value]));

function translateTextNode(node) {
    if (originalTexts.has(node) || shouldSkipTextNode(node)) return;
    const raw = node.nodeValue;
    const key = normalizeDomKey(raw);
    if (key.length < 2) return;
    const translated = domLookup.get(key);
    if (translated === undefined) return;
    originalTexts.set(node, raw);
    const leading = raw.match(/^\s*/)?.[0] ?? '';
    const trailing = raw.match(/\s*$/)?.[0] ?? '';
    node.nodeValue = `${leading}${translated}${trailing}`;
}

function shouldSkipTextNode(node) {
    let element = node.parentElement;
    while (element) {
        if (DOM_SKIP_TAGS.has(element.tagName)) return true;
        if (element.hasAttribute?.('data-i18n')) return true;
        if (element.id === 'language-select') return true;
        if (element.getAttribute?.('contenteditable') === 'true') return true;
        element = element.parentElement;
    }
    return false;
}

function translateTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        translateTextNode(node);
        node = walker.nextNode();
    }
}

const DOM_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function translateAttributes(root) {
    for (const attr of DOM_ATTRS) {
        for (const element of root.querySelectorAll(`[${attr}]`)) {
            if (element.id === 'language-select') continue;
            if (element.hasAttribute(`data-i18n-${attr}`)) continue;
            if (element.closest('[data-i18n]')) continue;
            const raw = element.getAttribute(attr);
            const key = normalizeDomKey(raw);
            if (key.length < 2) continue;
            const translated = domLookup.get(key);
            if (translated === undefined) continue;
            let stored = originalAttrs.get(element);
            if (!stored) {
                stored = {};
                originalAttrs.set(element, stored);
            }
            if (!Object.prototype.hasOwnProperty.call(stored, attr)) stored[attr] = raw;
            element.setAttribute(attr, raw.replace(raw.trim(), translated));
        }
    }
}

/** 中文模式下把静态/新增 DOM 的源文本替换成中文。 */
export function applyDomTranslations(root = document) {
    if (!ready) initializeI18n();
    if (getLanguage() !== 'zh-CN' || !root?.querySelectorAll) return;
    translateTextNodes(root);
    translateAttributes(root);
}

/** 切回英文:还原所有被源文本字典改过的节点/属性。 */
export function restoreDomTranslations() {
    for (const [node, original] of originalTexts) {
        try {
            node.nodeValue = original;
        } catch {
            // 节点已被移除。
        }
    }
    originalTexts.clear();
    for (const [element, attrs] of originalAttrs) {
        for (const [attr, original] of Object.entries(attrs)) {
            try {
                element.setAttribute(attr, original);
            } catch {
                // 节点已被移除。
            }
        }
    }
    originalAttrs.clear();
}

let domObserver = null;

/**
 * 启动源文本翻译:立即处理现有 DOM,并监听后续新增节点(settings 懒加载、列表渲染等)。
 * 只观察 childList,避免替换文本触发 observer 循环。
 */
export function initializeDomTranslation() {
    if (!ready) initializeI18n();
    applyDomTranslations();
    if (domObserver !== null || typeof MutationObserver === 'undefined' || !document.body) return;
    domObserver = new MutationObserver((mutations) => {
        if (getLanguage() !== 'zh-CN') return;
        for (const mutation of mutations) {
            for (const added of mutation.addedNodes) {
                if (added.nodeType === Node.TEXT_NODE) {
                    translateTextNode(added);
                } else if (added.nodeType === Node.ELEMENT_NODE) {
                    if (added.matches?.('[data-i18n]') || added.closest?.('[data-i18n]')) continue;
                    applyDomTranslations(added);
                }
            }
        }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * 切换语言:持久化 + 翻译静态 DOM + 源文本字典 + 派发事件(动态 UI 可监听后自行重渲染)。
 * @param {string} language
 */
export async function setLanguage(language) {
    if (!SUPPORTED.includes(language)) return;
    if (!ready) initializeI18n();
    await i18next.changeLanguage(language);
    try {
        localStorage.setItem(STORAGE_KEY, language);
    } catch {
        // 忽略:即使不能持久化,当前会话仍然生效。
    }
    applyTranslations();
    if (language === 'zh-CN') applyDomTranslations();
    else restoreDomTranslations();
    const select = document.getElementById('language-select');
    if (select) select.value = language;
    document.dispatchEvent(new CustomEvent('monochrome:language-changed', { detail: { language } }));
}
