// Tauri 能力测试页:在普通浏览器和 Tauri WebView 里都能跑。
//
// 目的:桌面壳(WebView2)与 Chromium 的行为差异不能靠猜。这一页把「能不能渲染/播放/存储/联网/
// 调 Tauri API」变成一组可截图、可复制的结果,先在 Chromium 里验证,再进 `tauri dev` 对照。
//
// 设计约束:
//   · 不引入 @tauri-apps/api 依赖,只用 window.__TAURI_INTERNALS__(Tauri v2 注入);
//   · 每项检测独立 try/catch,单项失败不能拖垮整页;
//   · 普通浏览器里 Tauri 项标 SKIP(不是 FAIL),避免误报。

import { t } from './i18n.js';

const STATUS_KEYS = {
    pass: 'tauriTest.statusPass',
    warn: 'tauriTest.statusWarn',
    fail: 'tauriTest.statusFail',
    skip: 'tauriTest.statusSkip',
};

let lastReport = null;
let running = false;

function isTauri() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
        }),
    ]);
}

function environmentSnapshot() {
    const internals = isTauri() ? window.__TAURI_INTERNALS__ : null;
    return {
        language: document.documentElement.lang,
        origin: window.location.origin,
        path: window.location.pathname,
        userAgent: navigator.userAgent,
        platform: navigator.platform || '',
        viewport: `${window.innerWidth} × ${window.innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
        screen: `${window.screen.width} × ${window.screen.height}`,
        isTauri: isTauri(),
        tauriInternalsKeys: internals ? Object.keys(internals).sort() : [],
        globalTauriApi: Boolean(window.__TAURI__),
    };
}

function checkEnvironment() {
    return {
        status: 'pass',
        value: isTauri() ? t('tauriTest.inTauri') : t('tauriTest.notInTauri'),
        detail: `${navigator.platform || 'unknown'} · ${navigator.userAgent}`,
    };
}

function checkCss() {
    const features = [
        ['flex', CSS.supports('display', 'flex')],
        ['grid', CSS.supports('display', 'grid')],
        ['custom-properties', CSS.supports('--capability-test', '1')],
        ['backdrop-filter', CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')],
        ['animation', CSS.supports('animation', '1s linear')],
        ['aspect-ratio', CSS.supports('aspect-ratio', '1 / 1')],
    ];
    const supported = features.filter(([, ok]) => ok).map(([name]) => name);
    return {
        status: supported.length >= 5 ? 'pass' : supported.length >= 3 ? 'warn' : 'fail',
        value: `${supported.length}/${features.length} supported`,
        detail: features.map(([name, ok]) => `${ok ? '✓' : '✗'} ${name}`).join('  '),
    };
}

function checkCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { status: 'fail', value: 'getContext("2d") returned null' };
    ctx.fillStyle = 'rgb(255, 0, 0)';
    ctx.fillRect(0, 0, 8, 8);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const ok = r === 255 && g === 0 && b === 0;
    return {
        status: ok ? 'pass' : 'fail',
        value: ok ? 'pixel readback ok' : `unexpected pixel rgb(${r}, ${g}, ${b})`,
    };
}

function checkWebgl() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { status: 'warn', value: 'WebGL context unavailable' };
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const version = gl.getParameter(gl.VERSION);
    return {
        status: 'pass',
        value: String(renderer),
        detail: String(version),
    };
}

function checkSvg() {
    const svg = document.querySelector('#page-tauri-test .capability-icon svg');
    if (!svg) return { status: 'warn', value: 'no inline SVG found' };
    const box = svg.getBBox?.();
    const painted = Boolean(box && box.width > 0 && box.height > 0);
    return {
        status: painted ? 'pass' : 'warn',
        value: painted ? `${Math.round(box.width)} × ${Math.round(box.height)} rendered` : 'inline SVG not painted',
    };
}

function checkFonts() {
    const yahei = document.fonts.check('16px "Microsoft YaHei"');
    const inter = document.fonts.check('16px Inter');
    const fallback = document.fonts.check('16px sans-serif');
    return {
        status: yahei || inter ? 'pass' : 'warn',
        value: `Microsoft YaHei: ${yahei ? 'yes' : 'no'} · Inter: ${inter ? 'yes' : 'no'}`,
        detail: `sans-serif fallback: ${fallback ? 'yes' : 'no'} · font faces: ${document.fonts.size}`,
    };
}

function checkAudio() {
    const audio = document.createElement('audio');
    const formats = {
        'audio/mpeg': audio.canPlayType('audio/mpeg'),
        'audio/flac': audio.canPlayType('audio/flac'),
        'audio/mp4 (AAC)': audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
        'audio/ogg (Opus)': audio.canPlayType('audio/ogg; codecs="opus"'),
        'audio/wav': audio.canPlayType('audio/wav'),
    };
    const playable = Object.entries(formats)
        .filter(([, result]) => result !== '')
        .map(([mime, result]) => `${mime}: ${result}`);
    return {
        status: playable.length > 0 ? 'pass' : 'fail',
        value: playable.length > 0 ? playable.map((line) => line.split(':')[0]).join(', ') : 'no playable audio type',
        detail: Object.entries(formats)
            .map(([mime, result]) => `${mime}: ${result || 'no'}`)
            .join('  '),
    };
}

async function checkAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return { status: 'warn', value: 'AudioContext unavailable' };
    try {
        const context = new AudioContextClass();
        const state = context.state;
        const sampleRate = context.sampleRate;
        await context.close?.();
        return { status: 'pass', value: `${sampleRate} Hz · ${state}`, detail: 'AudioContext created' };
    } catch (error) {
        return { status: 'warn', value: 'AudioContext failed', detail: String(error?.message || error) };
    }
}

async function checkStorage() {
    let localStorageOk = false;
    let localStorageDetail = '';
    try {
        const key = '__tauri_capability_probe__';
        localStorage.setItem(key, 'ok');
        localStorageOk = localStorage.getItem(key) === 'ok';
        localStorage.removeItem(key);
    } catch (error) {
        localStorageDetail = String(error?.message || error);
    }

    const indexedDbOk = await new Promise((resolve) => {
        if (!('indexedDB' in window)) {
            resolve(false);
            return;
        }
        let request;
        try {
            request = indexedDB.open('__tauri_capability_probe__', 1);
        } catch {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => resolve(false), 2500);
        request.onsuccess = () => {
            clearTimeout(timer);
            try {
                request.result.close();
                indexedDB.deleteDatabase('__tauri_capability_probe__');
            } catch {
                // 清理失败不影响结论。
            }
            resolve(true);
        };
        request.onerror = () => {
            clearTimeout(timer);
            resolve(false);
        };
    });

    return {
        status: localStorageOk && indexedDbOk ? 'pass' : localStorageOk || indexedDbOk ? 'warn' : 'fail',
        value: `localStorage: ${localStorageOk ? 'yes' : 'no'} · IndexedDB: ${indexedDbOk ? 'yes' : 'no'}`,
        detail: localStorageDetail,
    };
}

async function checkNetwork() {
    const candidates = ['./manifest.webmanifest', './'];
    for (const url of candidates) {
        try {
            const response = await withTimeout(fetch(url, { cache: 'no-store' }), 4000);
            if (response.ok) {
                return {
                    status: 'pass',
                    value: `${response.status} ${response.statusText}`,
                    detail: `${new URL(url, window.location.href).href} · Content-Type: ${response.headers.get('content-type') || 'n/a'}`,
                };
            }
        } catch {
            // 继续尝试下一个候选 URL。
        }
    }
    return { status: 'warn', value: 'same-origin fetch failed', detail: `origin: ${window.location.origin}` };
}

function checkWasm() {
    const supported =
        typeof WebAssembly === 'object' &&
        typeof WebAssembly.validate === 'function' &&
        WebAssembly.validate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return {
        status: supported ? 'pass' : 'fail',
        value: supported ? 'WebAssembly available' : 'WebAssembly unavailable',
    };
}

async function checkTauriApi() {
    if (!isTauri()) {
        return {
            status: 'skip',
            value: t('tauriTest.notInTauri'),
            detail: 'window.__TAURI_INTERNALS__ is not present (normal browser)',
        };
    }
    const internals = window.__TAURI_INTERNALS__;
    const hasInvoke = typeof internals?.invoke === 'function';
    if (!hasInvoke) {
        return { status: 'warn', value: 'Tauri internals found, invoke missing', detail: Object.keys(internals || {}).join(', ') };
    }
    try {
        const version = await withTimeout(internals.invoke('plugin:app|version'), 2500);
        return {
            status: 'pass',
            value: typeof version === 'string' ? version : JSON.stringify(version),
            detail: 'plugin:app|version responded',
        };
    } catch (error) {
        return {
            status: 'warn',
            value: 'invoke available, version probe rejected',
            detail: String(error?.message || error),
        };
    }
}

function checkServiceWorker() {
    const supported = 'serviceWorker' in navigator;
    const controlled = Boolean(navigator.serviceWorker?.controller);
    const note = isTauri()
        ? 'Desktop shell intentionally disables PWA/service worker (see docs/06-tauri-plan.md).'
        : 'Web mode keeps the PWA service worker enabled.';
    return {
        status: supported ? 'pass' : 'warn',
        value: `serviceWorker: ${supported ? 'supported' : 'unsupported'} · controlled: ${controlled ? 'yes' : 'no'}`,
        detail: note,
    };
}

function checkWindow() {
    return {
        status: 'pass',
        value: `${window.innerWidth} × ${window.innerHeight} @ ${window.devicePixelRatio}x`,
        detail: `screen: ${window.screen.width} × ${window.screen.height} · visualViewport: ${window.visualViewport ? `${Math.round(window.visualViewport.width)} × ${Math.round(window.visualViewport.height)}` : 'n/a'}`,
    };
}

const CHECKS = [
    ['environment', checkEnvironment],
    ['css', checkCss],
    ['canvas', checkCanvas],
    ['webgl', checkWebgl],
    ['svg', checkSvg],
    ['fonts', checkFonts],
    ['audio', () => checkAudio()],
    ['audioContext', checkAudioContext],
    ['storage', checkStorage],
    ['network', checkNetwork],
    ['wasm', checkWasm],
    ['tauri', checkTauriApi],
    ['serviceWorker', checkServiceWorker],
    ['window', checkWindow],
];

function renderCard(result) {
    const status = result.status;
    return `
        <article class="capability-card" data-status="${status}">
            <span class="capability-status ${status}">${escapeHtml(t(STATUS_KEYS[status]))}</span>
            <h2>${escapeHtml(t(`tauriTest.tests.${result.id}`))}</h2>
            <p class="capability-value">${escapeHtml(result.value)}</p>
            ${result.detail ? `<p class="capability-detail">${escapeHtml(result.detail)}</p>` : ''}
        </article>
    `;
}

function updateSummary(results) {
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const result of results) counts[result.status] += 1;
    const summary = document.getElementById('tauri-test-summary');
    if (summary) {
        summary.textContent = t('tauriTest.summary', {
            passed: counts.pass,
            warnings: counts.warn + counts.skip,
            failed: counts.fail,
        });
    }
    return counts;
}

export async function runCapabilityTests() {
    if (running) return;
    running = true;
    const grid = document.getElementById('tauri-test-grid');
    const summary = document.getElementById('tauri-test-summary');
    const rerun = document.getElementById('tauri-test-rerun');
    const copied = document.getElementById('tauri-test-copied');
    if (!grid) {
        running = false;
        return;
    }
    if (rerun) rerun.disabled = true;
    if (copied) copied.hidden = true;
    grid.innerHTML = '';
    if (summary) summary.textContent = '…';

    const results = [];
    for (const [id, check] of CHECKS) {
        let result;
        try {
            result = await check();
        } catch (error) {
            result = { status: 'fail', value: 'check threw', detail: String(error?.message || error) };
        }
        const record = { id, status: result.status, value: result.value ?? '', detail: result.detail ?? '' };
        results.push(record);
        grid.insertAdjacentHTML('beforeend', renderCard(record));
        updateSummary(results);
    }

    const environment = environmentSnapshot();
    const counts = updateSummary(results);
    lastReport = {
        generated: new Date().toISOString(),
        environment,
        counts,
        results,
    };
    const envElement = document.getElementById('tauri-test-env');
    if (envElement) envElement.textContent = JSON.stringify(environment, null, 2);
    if (rerun) rerun.disabled = false;
    running = false;
}

async function copyReport() {
    if (!lastReport) return;
    const text = JSON.stringify(lastReport, null, 2);
    let copied = false;
    try {
        await navigator.clipboard.writeText(text);
        copied = true;
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            copied = document.execCommand('copy');
        } catch {
            copied = false;
        }
        textarea.remove();
    }
    const badge = document.getElementById('tauri-test-copied');
    if (badge && copied) {
        badge.hidden = false;
        setTimeout(() => {
            badge.hidden = true;
        }, 2000);
    }
}

export function initializeTauriTestPage() {
    const rerun = document.getElementById('tauri-test-rerun');
    const copy = document.getElementById('tauri-test-copy');
    if (!rerun || !copy) return;
    rerun.addEventListener('click', () => {
        void runCapabilityTests();
    });
    copy.addEventListener('click', () => {
        void copyReport();
    });
    document.addEventListener('monochrome:tauri-test-open', () => {
        void runCapabilityTests();
    });
    document.addEventListener('monochrome:language-changed', () => {
        const page = document.getElementById('page-tauri-test');
        if (page?.classList.contains('active')) void runCapabilityTests();
    });
    // 直接以 /tauri-test 打开时 router 会派发事件;这里兜底处理 HMR/异常情况。
    const page = document.getElementById('page-tauri-test');
    if (page?.classList.contains('active') && !lastReport) {
        window.setTimeout(() => {
            if (!lastReport) void runCapabilityTests();
        }, 400);
    }
}
