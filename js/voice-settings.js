// 音声在线优化(asmr.one 多服务器 + 智能初始路径)的设置存储。
//
// 单独成文件而不是塞进 storage.js:
//   · 这两组设置只服务音声,和全局播放/主题设置无关;
//   · 上游 storage.js 很大,少改一处就少一处同步冲突。
// 所有读取都做形状校验与 try/catch:localStorage 在隐私模式/配额满时会抛,
// 不能让一个坏值把整个音声页拖崩。

export const VOICE_SERVERS_KEY = 'monochrome-voice-servers-v1';
export const VOICE_INITIAL_PATH_KEY = 'monochrome-voice-initial-path-v1';
export const VOICE_DOWNLOAD_KEY = 'monochrome-voice-download-settings-v1';
export const VOICE_SERVERS_EVENT = 'voice-settings-changed';

export const DEFAULT_AUDIO_TYPE_ORDER = Object.freeze(['mp3', 'flac', 'wav', 'opus', 'm4a', 'aac']);

const memoryStorage = new Map();

function storage() {
    try {
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch {
        // 隐私模式可能连访问 localStorage 都抛;用内存兜底。
    }
    return {
        getItem: (key) => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
        setItem: (key, value) => memoryStorage.set(key, String(value)),
        removeItem: (key) => memoryStorage.delete(key),
    };
}

function readRaw(key) {
    try {
        const raw = storage().getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function writeRaw(key, value) {
    try {
        storage().setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function stringValue(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

export function normalizeBaseUrl(value) {
    const text = stringValue(value);
    if (!text) return '';
    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
        if (url.username || url.password) return '';
        return url.href.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

export function normalizeProxyUrl(value) {
    const text = stringValue(value);
    if (!text) return '';
    try {
        const url = new URL(text);
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) return '';
        return url.href.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function defaultServerSettings() {
    return {
        version: 1,
        mode: 'auto',
        manualBase: '',
        customBases: [],
        probe: {},
        selectedBase: '',
        selectedAt: 0,
        discoveredMediaHosts: [],
        proxy: '',
    };
}

function sanitizeProbe(probe) {
    const result = {};
    if (!probe || typeof probe !== 'object') return result;
    for (const [base, entry] of Object.entries(probe)) {
        const normalized = normalizeBaseUrl(base);
        if (!normalized || !entry || typeof entry !== 'object') continue;
        result[normalized] = {
            ok: entry.ok === true,
            ms: Number.isFinite(Number(entry.ms)) ? Math.max(0, Math.round(Number(entry.ms))) : null,
            checkedAt: Number.isFinite(Number(entry.checkedAt)) ? Number(entry.checkedAt) : 0,
            failures: Number.isFinite(Number(entry.failures)) ? Math.max(0, Number(entry.failures)) : 0,
        };
    }
    return result;
}

function sanitizeCustomBases(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const result = [];
    for (const item of list) {
        const raw = typeof item === 'string' ? { url: item } : item;
        const url = normalizeBaseUrl(raw?.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        result.push({
            url,
            label: stringValue(raw?.label),
            enabledInAuto: raw?.enabledInAuto === true,
        });
    }
    return result;
}

function sanitizeServerSettings(value) {
    const defaults = defaultServerSettings();
    if (!value || typeof value !== 'object') return defaults;
    const mode = value.mode === 'manual' ? 'manual' : 'auto';
    return {
        version: 1,
        mode,
        manualBase: normalizeBaseUrl(value.manualBase),
        customBases: sanitizeCustomBases(value.customBases),
        probe: sanitizeProbe(value.probe),
        selectedBase: normalizeBaseUrl(value.selectedBase),
        selectedAt: Number.isFinite(Number(value.selectedAt)) ? Number(value.selectedAt) : 0,
        discoveredMediaHosts: Array.isArray(value.discoveredMediaHosts)
            ? [...new Set(value.discoveredMediaHosts.map((item) => stringValue(item)).filter(Boolean))].slice(0, 20)
            : [],
        proxy: normalizeProxyUrl(value.proxy),
    };
}

function defaultPathSettings() {
    return {
        initialPathBehavior: 'auto',
        sePreference: true,
        audioTypePreference: [...DEFAULT_AUDIO_TYPE_ORDER],
    };
}

function sanitizeAudioTypes(value) {
    const source = Array.isArray(value) ? value : DEFAULT_AUDIO_TYPE_ORDER;
    const result = [];
    for (const item of source) {
        const type = stringValue(item).toLowerCase();
        if (!/^[a-z0-9]{1,8}$/.test(type) || result.includes(type)) continue;
        result.push(type);
    }
    return result.length ? result : [...DEFAULT_AUDIO_TYPE_ORDER];
}

function sanitizePathSettings(value) {
    const defaults = defaultPathSettings();
    if (!value || typeof value !== 'object') return defaults;
    return {
        initialPathBehavior: value.initialPathBehavior === 'root' ? 'root' : 'auto',
        sePreference: value.sePreference !== false,
        audioTypePreference: sanitizeAudioTypes(value.audioTypePreference),
    };
}

function emit(key) {
    try {
        globalThis.dispatchEvent?.(new CustomEvent(VOICE_SERVERS_EVENT, { detail: { key } }));
    } catch {
        // 没有 window/CustomEvent 的测试环境忽略。
    }
}

export function getVoiceServerSettings() {
    return sanitizeServerSettings(readRaw(VOICE_SERVERS_KEY));
}

export function setVoiceServerSettings(partial) {
    const current = getVoiceServerSettings();
    const next = sanitizeServerSettings({ ...current, ...(partial || {}) });
    writeRaw(VOICE_SERVERS_KEY, next);
    emit('servers');
    return next;
}

export function updateVoiceServerSettings(mutator) {
    const current = getVoiceServerSettings();
    const draft = clone(current);
    mutator(draft);
    const next = sanitizeServerSettings(draft);
    writeRaw(VOICE_SERVERS_KEY, next);
    emit('servers');
    return next;
}

function defaultDownloadSettings() {
    return { fileConcurrency: 2, threadsPerFile: 2 };
}

function sanitizeDownloadSettings(value) {
    const defaults = defaultDownloadSettings();
    const number = (input) => {
        const parsed = Number(input);
        return Number.isFinite(parsed) ? Math.max(1, Math.min(8, Math.round(parsed))) : null;
    };
    return {
        fileConcurrency: number(value?.fileConcurrency) || defaults.fileConcurrency,
        threadsPerFile: number(value?.threadsPerFile) || defaults.threadsPerFile,
    };
}

export function getVoiceDownloadSettings() {
    return sanitizeDownloadSettings(readRaw(VOICE_DOWNLOAD_KEY));
}

export function setVoiceDownloadSettings(partial) {
    const current = getVoiceDownloadSettings();
    const next = sanitizeDownloadSettings({ ...current, ...(partial || {}) });
    writeRaw(VOICE_DOWNLOAD_KEY, next);
    emit('downloads');
    return next;
}

export function getVoicePathSettings() {
    return sanitizePathSettings(readRaw(VOICE_INITIAL_PATH_KEY));
}

export function setVoicePathSettings(partial) {
    const current = getVoicePathSettings();
    const next = sanitizePathSettings({ ...current, ...(partial || {}) });
    writeRaw(VOICE_INITIAL_PATH_KEY, next);
    emit('initialPath');
    return next;
}

export const voiceServerSettings = {
    get: getVoiceServerSettings,
    set: setVoiceServerSettings,
    update: updateVoiceServerSettings,
    getSelectedBase() {
        return getVoiceServerSettings().selectedBase;
    },
    reset() {
        memoryStorage.delete(VOICE_SERVERS_KEY);
        try {
            storage().removeItem(VOICE_SERVERS_KEY);
        } catch {
            // ignore
        }
        emit('servers');
    },
};

export const voicePathSettings = {
    get: getVoicePathSettings,
    set: setVoicePathSettings,
    reset() {
        memoryStorage.delete(VOICE_INITIAL_PATH_KEY);
        try {
            storage().removeItem(VOICE_INITIAL_PATH_KEY);
        } catch {
            // ignore
        }
        emit('initialPath');
    },
};
