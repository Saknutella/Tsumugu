// 在线音声多服务器选择。
//
// 事实(2026-11-07 实测,见 docs/handoff/59):
//   · 上游 asmr.one 的 5 个条目只对应 4 个唯一 URL(latest 与 mirror-200 同 URL);
//   · 测速端点 GET /api/health?cache=false 返回纯文本 "OK";
//   · JSON API 的 CORS 固定只放行 https://www.asmr.one,所以普通 Web 不能读 JSON,
//     但 mode:'no-cors' 的探测请求可以跨源发出并计时;
//   · 媒体字节不在 API host 上,而是在 raw/fast.kiko-play-niptan.one/media/...,
//     媒体 CDN 放行 ACAO:*。
//
// 因此:探测优先用 no-cors(不依赖代理),失败再回退 Tauri/dev 的文本代理;
// 真正的 JSON 仍走 fetchKikoeruJson。自建 Kikoeru 不参与 asmr 镜像自动切换。

import { fetchKikoeruJson, fetchKikoeruText } from './tauri-bridge.js';
import { normalizeBaseUrl, voiceServerSettings } from './voice-settings.js';

export const PROBE_PATH = '/api/health?cache=false';
export const PROBE_TIMEOUT_MS = 3500;
export const PROBE_SAMPLES = 3;
export const PROBE_GAP_MS = 300;
export const PROBE_TTL_MS = 10 * 60 * 1000;
export const VOICE_MEDIA_HOST_SUFFIXES = Object.freeze(['kiko-play-niptan.one']);

export const ASMR_ENDPOINTS = Object.freeze([
    { key: 'latest', label: 'latest', url: 'https://api.asmr-200.com', family: 'asmr' },
    { key: 'original', label: 'original', url: 'https://api.asmr.one', family: 'asmr' },
    { key: 'mirror-100', label: 'mirror-100', url: 'https://api.asmr-100.com', family: 'asmr' },
    { key: 'mirror-200', label: 'mirror-200', url: 'https://api.asmr-200.com', family: 'asmr' },
    { key: 'mirror-300', label: 'mirror-300', url: 'https://api.asmr-300.com', family: 'asmr' },
]);

const ASMR_HOSTS = new Set(['asmr.one', 'www.asmr.one', 'api.asmr.one']);
const ASMR_MIRROR_HOSTS = new Set(['api.asmr-100.com', 'api.asmr-200.com', 'api.asmr-300.com']);

let activeProbePromise = null;

export function isAsmrFamilyBase(value) {
    const base = normalizeBaseUrl(value);
    if (!base) return false;
    try {
        const host = new URL(base).hostname.toLowerCase();
        return ASMR_HOSTS.has(host) || ASMR_MIRROR_HOSTS.has(host);
    } catch {
        return false;
    }
}

export function getUniqueEndpoints() {
    const map = new Map();
    for (const entry of ASMR_ENDPOINTS) {
        const base = normalizeBaseUrl(entry.url);
        if (!base) continue;
        if (!map.has(base)) map.set(base, { base, keys: [], labels: [] });
        const item = map.get(base);
        if (!item.keys.includes(entry.key)) {
            item.keys.push(entry.key);
            item.labels.push(entry.label);
        }
    }
    return [...map.values()];
}

export function getUniqueBases() {
    return getUniqueEndpoints().map((entry) => entry.base);
}

export function isKnownVoiceMediaHost(host) {
    const value = String(host || '').toLowerCase();
    if (!value) return false;
    return VOICE_MEDIA_HOST_SUFFIXES.some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

export function noteMediaHost(url) {
    const raw = String(url || '');
    if (!/^https?:/i.test(raw)) return;
    try {
        const host = new URL(raw).hostname.toLowerCase();
        if (!host) return;
        const settings = voiceServerSettings.get();
        if (settings.discoveredMediaHosts.includes(host)) return;
        voiceServerSettings.set({
            discoveredMediaHosts: [...settings.discoveredMediaHosts, host].slice(-20),
        });
    } catch {
        // 非法 URL 不值得记录。
    }
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function delay(ms, signal) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

async function defaultProbeFetcher(url, { timeout = PROBE_TIMEOUT_MS } = {}) {
    // 浏览器/WebView 里 no-cors 足够判断"可达",且不触发 CORS 预检。
    try {
        await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: timeoutSignal(timeout) });
        return true;
    } catch (error) {
        // CSP/WebView 限制 no-cors 时,退回 Tauri/dev 的文本代理(能看 body "OK")。
        try {
            const body = await fetchKikoeruText(url);
            return typeof body === 'string';
        } catch {
            throw error;
        }
    }
}

async function defaultMediaProbe(url, { timeout = 2500 } = {}) {
    if (!url) return false;
    try {
        const response = await fetch(url, {
            headers: { Range: 'bytes=0-1' },
            cache: 'no-store',
            signal: timeoutSignal(timeout),
        });
        return response.ok || response.status === 206;
    } catch {
        // 自建 Kikoeru 不一定放行 CORS;只能退回 opaque 请求判断"能连上"。
        try {
            await fetch(url, {
                mode: 'no-cors',
                headers: { Range: 'bytes=0-1' },
                cache: 'no-store',
                signal: timeoutSignal(timeout),
            });
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * 纯函数:从探测结果里挑 base。previous 用于迟滞,manualBase 永远优先。
 * results 形如 { [base]: { ok, ms } }。
 */
export function chooseBase(results, previous = null, manualBase = '') {
    const manual = normalizeBaseUrl(manualBase);
    if (manual) return manual;
    const ok = Object.entries(results || {})
        .filter(([, entry]) => entry?.ok === true && Number.isFinite(Number(entry.ms)))
        .map(([base, entry]) => ({ base, ms: Number(entry.ms) }))
        .sort((a, b) => a.ms - b.ms);
    if (!ok.length) return previous?.ok ? previous.base : getUniqueBases()[0] || '';
    const best = ok[0];
    const prevBase = normalizeBaseUrl(previous?.base);
    const prevMs = Number(previous?.ms);
    // 迟滞:当前可用且不比最优差 25%+50ms,就不因一次抖动切走。
    if (
        previous?.ok === true &&
        prevBase &&
        prevBase !== best.base &&
        Number.isFinite(prevMs) &&
        prevMs <= best.ms * 1.25 + 50
    ) {
        return prevBase;
    }
    return best.base;
}

export async function probeBase(base, options = {}) {
    const target = normalizeBaseUrl(base);
    if (!target) return { base: '', ok: false, ms: null, samples: [] };
    const samples = Number.isFinite(Number(options.samples)) ? Math.max(1, Number(options.samples)) : PROBE_SAMPLES;
    const gap = Number.isFinite(Number(options.gap)) ? Math.max(0, Number(options.gap)) : PROBE_GAP_MS;
    const timeout = Number.isFinite(Number(options.timeout)) ? Number(options.timeout) : PROBE_TIMEOUT_MS;
    const fetcher = options.fetcher || defaultProbeFetcher;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const measured = [];
    for (let index = 0; index < samples; index += 1) {
        const startedAt = now();
        try {
            await fetcher(`${target}${PROBE_PATH}`, { timeout });
            measured.push(Math.max(0, now() - startedAt));
        } catch {
            measured.push(null);
        }
        if (index < samples - 1) await delay(gap, options.signal);
    }
    const okSamples = measured.filter((value) => typeof value === 'number');
    return {
        base: target,
        ok: okSamples.length > 0,
        ms: median(okSamples),
        samples: measured,
    };
}

function collectProbeResults(settings, now, ttl) {
    const results = {};
    const uniqueBases = getUniqueBases();
    for (const base of uniqueBases) {
        const entry = settings.probe[base];
        if (!entry) continue;
        results[base] = {
            ...entry,
            fresh: now - Number(entry.checkedAt || 0) <= ttl,
        };
    }
    return results;
}

export async function probeAll(options = {}) {
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const ttl = Number.isFinite(Number(options.ttl)) ? Number(options.ttl) : PROBE_TTL_MS;
    const settings = voiceServerSettings.get();
    const cached = collectProbeResults(settings, now(), ttl);
    const cachedBases = getUniqueBases();
    const cachedFresh =
        cachedBases.length > 0 && cachedBases.every((base) => cached[base]?.fresh === true);

    if (!options.force && cachedFresh && settings.selectedBase) {
        return { results: cached, selectedBase: settings.selectedBase, cached: true };
    }
    if (activeProbePromise && !options.force) return activeProbePromise;

    activeProbePromise = (async () => {
        const unique = getUniqueEndpoints();
        const probed = await Promise.all(
            unique.map((entry) =>
                probeBase(entry.base, {
                    samples: options.samples,
                    gap: options.gap,
                    timeout: options.timeout,
                    fetcher: options.fetcher,
                    now,
                    signal: options.signal,
                }),
            ),
        );
        const previousEntry = settings.probe[settings.selectedBase];
        const previous = previousEntry
            ? { base: settings.selectedBase, ok: previousEntry.ok, ms: previousEntry.ms }
            : null;
        const results = {};
        for (const entry of probed) {
            results[entry.base] = {
                ok: entry.ok,
                ms: entry.ms,
                checkedAt: now(),
                failures: entry.ok ? 0 : (previousEntry?.failures || 0) + 1,
            };
        }
        const selectedBase = chooseBase(results, previous, settings.mode === 'manual' ? settings.manualBase : '');
        const next = voiceServerSettings.set({
            probe: { ...settings.probe, ...results },
            selectedBase,
            selectedAt: now(),
        });
        return { results, selectedBase: next.selectedBase, cached: false };
    })();

    try {
        return await activeProbePromise;
    } finally {
        activeProbePromise = null;
    }
}

export function getOrderedBases(family = 'asmr') {
    if (family !== 'asmr') return [];
    const settings = voiceServerSettings.get();
    const unique = getUniqueBases();
    // 手动模式必须真正只用手动 base:否则 selectedBase/probe 会把请求悄悄带回自动最快的镜像。
    const manual = normalizeBaseUrl(settings.manualBase);
    if (settings.mode === 'manual' && manual) return [manual];
    const ordered = [];
    const push = (base) => {
        const normalized = normalizeBaseUrl(base);
        if (normalized && !ordered.includes(normalized)) ordered.push(normalized);
    };
    push(settings.selectedBase);
    Object.entries(settings.probe || {})
        .filter(([base, entry]) => unique.includes(normalizeBaseUrl(base)) && entry?.ok && Number.isFinite(Number(entry.ms)))
        .sort(([, a], [, b]) => Number(a.ms) - Number(b.ms))
        .forEach(([base]) => push(base));
    unique.forEach(push);
    for (const custom of settings.customBases || []) {
        if (custom.enabledInAuto) push(custom.url);
    }
    return ordered;
}

export async function selectBase(options = {}) {
    const family = options.family || 'asmr';
    if (family !== 'asmr') return null;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const maxAge = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : 5 * 60 * 1000;
    const settings = voiceServerSettings.get();
    if (settings.mode === 'manual' && settings.manualBase) return settings.manualBase;
    if (
        settings.selectedBase &&
        now() - Number(settings.selectedAt || 0) <= maxAge &&
        settings.probe[settings.selectedBase]?.ok
    ) {
        return settings.selectedBase;
    }
    try {
        const result = await probeAll({
            force: options.force === true,
            fetcher: options.fetcher,
            gap: options.gap,
            timeout: options.timeout,
            samples: options.samples,
            now,
        });
        return result.selectedBase || getUniqueBases()[0] || '';
    } catch {
        return settings.selectedBase || getUniqueBases()[0] || '';
    }
}

function recordProbeFailure(base) {
    const normalized = normalizeBaseUrl(base);
    if (!normalized) return;
    const settings = voiceServerSettings.get();
    const entry = settings.probe[normalized] || { ok: false, ms: null, checkedAt: 0, failures: 0 };
    voiceServerSettings.set({
        probe: {
            ...settings.probe,
            [normalized]: {
                ...entry,
                ok: false,
                failures: Number(entry.failures || 0) + 1,
                checkedAt: Date.now(),
            },
        },
    });
}

function recordProbeSuccess(base) {
    const normalized = normalizeBaseUrl(base);
    if (!normalized) return;
    const settings = voiceServerSettings.get();
    const entry = settings.probe[normalized] || { ms: null };
    voiceServerSettings.set({
        selectedBase: normalized,
        selectedAt: Date.now(),
        probe: {
            ...settings.probe,
            [normalized]: { ...entry, ok: true, failures: 0, checkedAt: Date.now() },
        },
    });
}

/**
 * 按当前选择顺序请求 JSON;失败自动尝试下一个 base(默认最多 3 个)。
 * @returns {Promise<{json:any, base:string}>}
 */
export async function fetchJson(path, options = {}) {
    const family = options.family || 'asmr';
    const requestPath = String(path || '');
    if (!requestPath.startsWith('/')) throw new Error('voice endpoint path must start with /');
    // Pass the caller's signal through: without this, AbortSignal.timeout() in
    // edition hydration only cancels the retry delay, not the HTTP request.
    const fetcher = options.fetcher || ((url, requestOptions = {}) => fetchKikoeruJson(url, requestOptions));
    const retries = Number.isFinite(Number(options.retries)) ? Math.max(1, Number(options.retries)) : 3;

    if (family !== 'asmr') {
        const base = normalizeBaseUrl(options.base);
        if (!base) throw new Error('custom voice endpoint base is required');
        const json = await fetcher(`${base}${requestPath}`, { signal: options.signal });
        return { json, base };
    }

    const ordered = getOrderedBases('asmr');
    const preferred = normalizeBaseUrl(options.base);
    const candidates = [];
    for (const base of [...(preferred ? [preferred] : []), ...ordered]) {
        if (!candidates.includes(base)) candidates.push(base);
    }
    let lastError = null;
    for (const base of candidates.slice(0, retries)) {
        try {
            const json = await fetcher(`${base}${requestPath}`, { signal: options.signal });
            recordProbeSuccess(base);
            return { json, base };
        } catch (error) {
            lastError = error;
            recordProbeFailure(base);
        }
    }
    throw lastError || new Error(`Voice endpoint request failed: ${requestPath}`);
}

export async function probeMediaUrl(url, options = {}) {
    if (!url) return false;
    const probe = options.fetcher || defaultMediaProbe;
    try {
        return (await probe(url, { timeout: options.timeout })) === true;
    } catch {
        return false;
    }
}

export function resetVoiceEndpointStateForTests() {
    activeProbePromise = null;
}
