// 悬浮字幕覆盖层。
//
// 与全屏字幕（js/fullscreen-subtitles.js）共用 cue 解析，但职责完全不同：全屏视图
// 渲染整份字幕列表并负责滚动，这里只显示当前时间点的那一条。overlay 由 JS 动态创建，
// 不往 index.html 里加节点，播放器栏只需要实例化并 setTrack/setEnabled。
import { loadSubtitleCues, subtitleSupported } from './voice-subtitles.js';
import { getVoiceAlbum, getVoiceTrack, isVoiceTrackId } from './voice-album.js';

const OVERLAY_ID = 'floating-subtitles-overlay';
const FULLSCREEN_OVERLAY_ID = 'fullscreen-cover-overlay';
const SETTINGS_STORAGE_KEY = 'monochrome-floating-subtitle-settings-v1';
const ENABLED_STORAGE_KEY = 'monochrome-floating-subtitle-enabled';
const POSITION_STORAGE_KEY = 'monochrome-floating-subtitle-position-v1';
// 与全屏字幕同一节奏：timeupdate 在部分浏览器里粒度很大，interval 负责补帧。
const SYNC_INTERVAL_MS = 120;
// 拖动/恢复位置时离视口边缘的最小距离，避免遮罩贴边后齿轮按钮被裁掉。
const DRAG_MARGIN = 14;

const DEFAULT_SETTINGS = Object.freeze({
    textColor: '#f4f4f5',
    paddingX: 18,
    paddingY: 9,
    radius: 12,
});

const SETTING_LIMITS = Object.freeze({
    paddingX: { min: 6, max: 48 },
    paddingY: { min: 2, max: 32 },
    radius: { min: 0, max: 40 },
});

const GEAR_ICON = `
    <svg class="floating-subtitles-settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"></path>
    </svg>
`;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function readJson(key) {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        // 隐私模式/存储被禁用时退回默认值，不影响播放。
        return null;
    }
}

function writeJson(key, value) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
        /* 存储不可写不算功能失败。 */
    }
}

/**
 * 只接受带本地文件地址、且解析器支持的格式。ASS/SSA 在 Monochrome 里没有渲染器，
 * 放行会得到一个永远空着的 overlay。
 */
function normalizeSubtitle(subtitle) {
    if (!subtitle?.node?.mediaStreamUrl) return null;
    if (!subtitleSupported(subtitle.format)) return null;
    return subtitle;
}

/**
 * 从已导入作品里回查一条音轨的完整数据。
 *
 * 为什么不能只看 track.id：播放队列会被持久化到 localStorage，旧版本写入的 track
 * 可能没有 `subtitle`，甚至连 `voice:` 前缀的 id 形态都不同（历史队列/外部构造）。
 * 这些 track 仍然带着 `voiceWorkId`/`voiceHash`，所以按作品 id 回查、再按 hash 配对
 * 是比 id 前缀更可靠的兜底。找不到就返回 null，由调用方决定按钮是否显示。
 */
function lookupVoiceTrack(track) {
    if (!track) return null;
    if (isVoiceTrackId(track.id)) {
        try {
            const resolved = getVoiceTrack(track.id);
            if (resolved) return resolved;
        } catch {
            /* 作品已删除/队列来自旧版本：继续按 voiceWorkId 回查。 */
        }
    }
    const albumId = track.voiceWorkId || track.album?.voiceWorkId;
    if (!albumId) return null;
    try {
        const album = getVoiceAlbum(albumId);
        const tracks = album?.tracks || [];
        if (track.id) {
            const byId = tracks.find((entry) => entry.id === track.id);
            if (byId) return byId;
        }
        if (track.voiceHash) {
            const byHash = tracks.find((entry) => entry.voiceHash && entry.voiceHash === track.voiceHash);
            if (byHash) return byHash;
        }
        // 只剩标题/路径可比的旧队列：同名单轨作品是唯一安全的无 hash 兜底。
        const byTitle = tracks.find(
            (entry) =>
                entry.title &&
                entry.title === track.title &&
                (!track.voicePath || entry.voicePath === track.voicePath),
        );
        if (byTitle) return byTitle;
        return tracks.length === 1 ? tracks[0] : null;
    } catch {
        return null;
    }
}

/**
 * 解析音轨可用的本地字幕。
 *
 * 优先用 track 自带的 subtitle；缺失时按 id 或 voiceWorkId/voiceHash 回查已导入作品
 * （getVoiceTrack/getVoiceAlbum 会重新派生）。回查失败（作品已删除、非音声 track）
 * 一律返回 null。
 */
export function resolveFloatingSubtitle(track) {
    if (!track) return null;
    const direct = normalizeSubtitle(track.subtitle);
    if (direct) return direct;
    return normalizeSubtitle(lookupVoiceTrack(track)?.subtitle);
}

/**
 * 作品级字幕标记是否还能作为“显示按钮”的依据。
 *
 * 旧队列/外部构造的 track 可能只剩作品级的 `hasSubtitle`（作品里确实有字幕文件，
 * 但这一条轨与字幕的配对信息丢了，例如文件命名不匹配或字幕全是暂不支持的 ASS）。
 * 这时按钮仍应出现，用户打开后看不到 cue 由遮罩自己隐藏处理。
 * 但如果同一作品里别的音轨能正常配对，说明这套作品的配对机制没坏，本条轨就是真的
 * 没有字幕 —— 此时保持隐藏，避免给用户一个永远空着的开关。
 */
function hasWorkLevelSubtitle(track) {
    const isVoice =
        track.provider === 'voices' ||
        track.source === 'voices' ||
        isVoiceTrackId(track.id) ||
        Boolean(track.voiceWorkId || track.album?.voiceWorkId);
    if (!isVoice) return false;
    const albumId = track.voiceWorkId || track.album?.voiceWorkId;
    if (!track.hasSubtitle && !track.album?.hasSubtitle && !albumId) return false;
    if (!albumId) return track.hasSubtitle === true || track.album?.hasSubtitle === true;
    try {
        const album = getVoiceAlbum(albumId);
        // The work has a subtitle file somewhere. Even if this particular track's
        // pairing is missing (common for _SEあり/_SEなし variants), the floating
        // toggle must remain visible; the overlay handles a track with no cue as an
        // empty mask instead of silently hiding the control.
        return Boolean(track.hasSubtitle || track.album?.hasSubtitle || album?.album?.hasSubtitle);
    } catch {
        return track.hasSubtitle === true || track.album?.hasSubtitle === true;
    }
}

export function hasFloatingSubtitle(track) {
    if (resolveFloatingSubtitle(track)) return true;
    return Boolean(track) && hasWorkLevelSubtitle(track);
}

/** 与全屏字幕一致的时间轴查找：cue 按 start 升序，二分定位当前条。 */
function activeCueIndex(cues, time) {
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const cue = cues[middle];
        if (time < cue.start) high = middle - 1;
        else if (time >= cue.end) low = middle + 1;
        else return middle;
    }
    return -1;
}

function normalizeSettings(raw) {
    const settings = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== 'object') return settings;
    if (typeof raw.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.textColor)) {
        settings.textColor = raw.textColor.toLowerCase();
    }
    for (const key of ['paddingX', 'paddingY', 'radius']) {
        const value = Number(raw[key]);
        if (Number.isFinite(value))
            settings[key] = clamp(Math.round(value), SETTING_LIMITS[key].min, SETTING_LIMITS[key].max);
    }
    return settings;
}

function normalizePosition(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // 存归一化比例而不是像素：窗口/手机旋转后仍然落在可见范围内。
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

function settingsHtml() {
    const range = (key, label) => `
        <label class="floating-subtitles-setting">
            <span>${label}</span>
            <input type="range" data-setting="${key}" min="${SETTING_LIMITS[key].min}"
                max="${SETTING_LIMITS[key].max}" step="1" aria-label="${label}">
            <output data-setting-output="${key}"></output>
        </label>`;
    return `
        <div class="floating-subtitles-settings-header">
            <span>悬浮字幕</span>
            <button type="button" class="floating-subtitles-settings-close" aria-label="关闭悬浮字幕设置">×</button>
        </div>
        <label class="floating-subtitles-setting">
            <span>文字颜色</span>
            <input type="color" data-setting="textColor" aria-label="文字颜色">
        </label>
        ${range('paddingX', '水平留白')}
        ${range('paddingY', '垂直留白')}
        ${range('radius', '圆角')}
        <button type="button" class="floating-subtitles-settings-reset">恢复默认</button>
    `;
}

/**
 * 非全屏悬浮字幕。
 *
 * 播放器负责何时调用 setTrack/setEnabled；本类自己维护时间同步、全屏互斥、拖动定位
 * 和设置持久化。所有 DOM 都在构造时创建，destroy() 之后实例不可复用。
 */
export class FloatingSubtitles {
    constructor({ audioPlayer = null } = {}) {
        this.audioPlayer = audioPlayer || null;
        this.doc = globalThis.document;
        this.win = this.doc?.defaultView || globalThis;
        this.enabled = readJson(ENABLED_STORAGE_KEY) === true;
        this.settings = normalizeSettings(readJson(SETTINGS_STORAGE_KEY));
        this.savedPosition = normalizePosition(readJson(POSITION_STORAGE_KEY));
        this.track = null;
        this.subtitle = null;
        this.cues = [];
        this.hasCues = false;
        this.workSubtitleAvailable = false;
        this.cueToken = 0;
        this.activeIndex = -1;
        this.activeCueText = null;
        this.abortController = null;
        this.intervalId = null;
        this.syncStarted = false;
        this.visible = false;
        this.destroyed = false;
        this.settingsOpen = false;
        this.positioned = false;
        this.dragging = null;
        this.fullscreenOverlay = null;
        this.fullscreenObserver = null;

        this.buildDom();
        this.applySettings();
        this.syncSettingsInputs();
        this.attachFullscreenObserver();
        this.win.addEventListener('resize', this.handleViewportChange, { passive: true });
        this.win.visualViewport?.addEventListener('resize', this.handleViewportChange, { passive: true });
        if (this.enabled) {
            this.startSync();
            void this.loadCues();
        }
    }

    /** 切换当前音轨；没有本地字幕时立即隐藏，不会把上一条字幕留在屏幕上。 */
    setTrack(track) {
        if (this.destroyed) return;
        this.track = track || null;
        this.subtitle = resolveFloatingSubtitle(track);
        this.cueToken += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.cues = [];
        this.hasCues = false;
        this.workSubtitleAvailable = Boolean(track?.hasSubtitle || track?.album?.hasSubtitle);
        this.activeIndex = -1;
        this.activeCueText = null;
        this.clearFrozenSize();
        this.textEl.textContent = '';
        this.mask?.classList.add('is-empty');
        if (this.subtitle && this.enabled) void this.loadCues();
        this.updateVisibility();
    }

    /** 开关悬浮字幕并持久化；按钮状态由播放器自己维护。 */
    setEnabled(value) {
        if (this.destroyed) return;
        const next = Boolean(value);
        if (next === this.enabled) {
            // 播放器初始化时可能重复上报同一状态，不能因此重新拉取字幕。
            if (next && !this.syncStarted) this.startSync();
            return;
        }
        this.enabled = next;
        writeJson(ENABLED_STORAGE_KEY, next);
        if (next) {
            this.startSync();
            void this.loadCues();
        } else {
            this.stopSync();
            this.closeSettings();
            this.updateVisibility();
        }
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.stopSync();
        this.abortController?.abort();
        this.abortController = null;
        this.fullscreenObserver?.disconnect();
        this.fullscreenObserver = null;
        this.win.removeEventListener('resize', this.handleViewportChange);
        this.win.visualViewport?.removeEventListener('resize', this.handleViewportChange);
        this.win.removeEventListener('pointerup', this.handlePointerEnd);
        this.win.removeEventListener('pointercancel', this.handlePointerEnd);
        this.doc?.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
        this.root?.remove();
        this.root = null;
        this.mask = null;
        this.textEl = null;
        this.settingsPanel = null;
        this.settingsButton = null;
        this.settingInputs = null;
    }

    // ------------------------------------------------------------------ DOM

    buildDom() {
        const doc = this.doc;
        const root = doc.createElement('div');
        root.id = OVERLAY_ID;
        root.className = 'floating-subtitles';

        const mask = doc.createElement('div');
        mask.className = 'floating-subtitles-mask';
        mask.setAttribute('role', 'group');
        mask.setAttribute('aria-label', '悬浮字幕');

        const text = doc.createElement('div');
        text.className = 'floating-subtitles-text';

        const settingsButton = doc.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'floating-subtitles-settings-btn';
        settingsButton.setAttribute('aria-label', '悬浮字幕设置');
        settingsButton.title = '悬浮字幕设置';
        // 固定常量 SVG，不含用户数据，textContent 方案对静态图标没有意义。
        settingsButton.innerHTML = GEAR_ICON;

        mask.append(text, settingsButton);

        const settingsPanel = doc.createElement('div');
        settingsPanel.className = 'floating-subtitles-settings';
        settingsPanel.hidden = true;
        settingsPanel.setAttribute('role', 'dialog');
        settingsPanel.setAttribute('aria-label', '悬浮字幕设置');
        settingsPanel.innerHTML = settingsHtml();

        root.append(mask, settingsPanel);
        doc.body.appendChild(root);

        this.root = root;
        this.mask = mask;
        this.textEl = text;
        this.settingsButton = settingsButton;
        this.settingsPanel = settingsPanel;
        this.settingInputs = {
            textColor: settingsPanel.querySelector('[data-setting="textColor"]'),
            paddingX: settingsPanel.querySelector('[data-setting="paddingX"]'),
            paddingY: settingsPanel.querySelector('[data-setting="paddingY"]'),
            radius: settingsPanel.querySelector('[data-setting="radius"]'),
        };
        this.settingOutputs = {
            paddingX: settingsPanel.querySelector('[data-setting-output="paddingX"]'),
            paddingY: settingsPanel.querySelector('[data-setting-output="paddingY"]'),
            radius: settingsPanel.querySelector('[data-setting-output="radius"]'),
        };

        mask.addEventListener('pointerdown', this.handlePointerDown);
        mask.addEventListener('pointermove', this.handlePointerMove);
        mask.addEventListener('pointerup', this.handlePointerEnd);
        mask.addEventListener('pointercancel', this.handlePointerEnd);
        this.win.addEventListener('pointerup', this.handlePointerEnd);
        this.win.addEventListener('pointercancel', this.handlePointerEnd);
        // Pointer activation is more reliable than click here: the button sits
        // outside the mask edge and can be easily retargeted by pointer capture.
        let pointerToggled = false;
        settingsButton.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            pointerToggled = true;
            this.toggleSettings();
        });
        settingsButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (pointerToggled) {
                pointerToggled = false;
                return;
            }
            this.toggleSettings();
        });
        settingsButton.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this.toggleSettings();
        });
        settingsPanel.addEventListener('input', this.handleSettingInput);
        settingsPanel.addEventListener('click', this.handleSettingsClick);
        this.doc.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
    }

    // -------------------------------------------------------------- 设置

    applySettings() {
        if (!this.root) return;
        const settings = this.settings;
        this.root.style.setProperty('--floating-subtitle-color', settings.textColor);
        this.root.style.setProperty('--floating-subtitle-pad-x', `${settings.paddingX}px`);
        this.root.style.setProperty('--floating-subtitle-pad-y', `${settings.paddingY}px`);
        this.root.style.setProperty('--floating-subtitle-radius', `${settings.radius}px`);
    }

    syncSettingsInputs() {
        if (!this.settingInputs) return;
        const { textColor, paddingX, paddingY, radius } = this.settings;
        this.settingInputs.textColor.value = textColor;
        this.settingInputs.paddingX.value = String(paddingX);
        this.settingInputs.paddingY.value = String(paddingY);
        this.settingInputs.radius.value = String(radius);
        this.settingOutputs.paddingX.textContent = `${paddingX}px`;
        this.settingOutputs.paddingY.textContent = `${paddingY}px`;
        this.settingOutputs.radius.textContent = `${radius}px`;
    }

    handleSettingInput = (event) => {
        const input = event.target?.closest?.('[data-setting]');
        if (!input) return;
        const key = input.dataset.setting;
        if (key === 'textColor') {
            if (!/^#[0-9a-f]{6}$/i.test(input.value)) return;
            this.settings.textColor = input.value.toLowerCase();
        } else if (SETTING_LIMITS[key]) {
            const limits = SETTING_LIMITS[key];
            const value = Number(input.value);
            if (!Number.isFinite(value)) return;
            this.settings[key] = clamp(Math.round(value), limits.min, limits.max);
        } else {
            return;
        }
        this.applySettings();
        this.syncSettingsInputs();
        writeJson(SETTINGS_STORAGE_KEY, this.settings);
        // 留白/圆角变化会改变遮罩尺寸，手动拖过的位置需要重新 clamp。
        if (this.positioned && this.visible) this.applySavedPosition();
    };

    handleSettingsClick = (event) => {
        if (event.target?.closest?.('.floating-subtitles-settings-close')) {
            this.closeSettings();
            return;
        }
        if (event.target?.closest?.('.floating-subtitles-settings-reset')) {
            this.settings = { ...DEFAULT_SETTINGS };
            this.applySettings();
            this.syncSettingsInputs();
            writeJson(SETTINGS_STORAGE_KEY, this.settings);
            this.resetPosition();
            this.clearFrozenSize();
        }
    };

    toggleSettings() {
        if (this.settingsOpen) this.closeSettings();
        else this.openSettings();
    }

    openSettings() {
        if (!this.settingsPanel || this.destroyed) return;
        this.settingsOpen = true;
        this.syncSettingsInputs();
        this.settingsPanel.hidden = false;
        this.positionSettings();
    }

    closeSettings() {
        if (!this.settingsPanel) return;
        this.settingsOpen = false;
        this.settingsPanel.hidden = true;
    }

    /** 面板贴着遮罩：优先放上方，上方不够就放下方，左右 clamp 进视口。 */
    positionSettings() {
        const panel = this.settingsPanel;
        const mask = this.mask;
        if (!panel || !mask || panel.hidden) return;
        const rect = mask.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const gap = 10;
        let left = rect.right - panelRect.width;
        left = clamp(left, 8, Math.max(8, this.win.innerWidth - panelRect.width - 8));
        let top = rect.top - panelRect.height - gap;
        if (top < 8) {
            top = Math.min(this.win.innerHeight - panelRect.height - 8, rect.bottom + gap);
        }
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(Math.max(8, top))}px`;
    }

    handleDocumentPointerDown = (event) => {
        if (!this.settingsOpen) return;
        const target = event.target;
        if (this.settingsPanel?.contains(target) || this.settingsButton?.contains(target)) return;
        // 点在遮罩上开始拖动时也收起面板，避免面板悬在旧位置。
        this.closeSettings();
    };

    // -------------------------------------------------------------- 时间同步

    startSync() {
        if (this.syncStarted || this.destroyed) return;
        this.syncStarted = true;
        const player = this.audioPlayer;
        player?.addEventListener('timeupdate', this.sync);
        player?.addEventListener('seeked', this.sync);
        player?.addEventListener('ratechange', this.sync);
        this.intervalId = this.win.setInterval(this.sync, SYNC_INTERVAL_MS);
        this.sync();
    }

    stopSync() {
        if (!this.syncStarted) return;
        this.syncStarted = false;
        const player = this.audioPlayer;
        player?.removeEventListener('timeupdate', this.sync);
        player?.removeEventListener('seeked', this.sync);
        player?.removeEventListener('ratechange', this.sync);
        if (this.intervalId !== null) {
            this.win.clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    async loadCues() {
        const subtitle = this.subtitle;
        if (!subtitle || this.destroyed) return;
        const token = this.cueToken;
        const controller = new AbortController();
        this.abortController?.abort();
        this.abortController = controller;
        try {
            const cues = await loadSubtitleCues(subtitle, { signal: controller.signal });
            // 切轨/关闭会 abort 或让 token 变化，旧请求的结果必须丢弃。
            if (this.destroyed || token !== this.cueToken) return;
            this.cues = Array.isArray(cues) ? cues : [];
            this.hasCues = this.cues.length > 0;
            this.activeIndex = -1;
            this.activeCueText = null;
            // Before the first cue the index is already -1, so sync() would not
            // call renderCue(null) and the empty class would be missing.
            this.renderCue(null);
            this.sync();
        } catch (error) {
            if (this.destroyed || token !== this.cueToken || controller.signal.aborted) return;
            console.warn('Failed to load floating subtitles:', error);
            this.cues = [];
            this.hasCues = false;
            this.activeIndex = -1;
            this.updateVisibility();
        } finally {
            if (this.abortController === controller) this.abortController = null;
        }
    }

    /** 无 active cue 时判断是“首句前/末句后”还是两条字幕之间的间隔。 */
    cueForGap(time) {
        if (!this.cues.length || !Number.isFinite(time)) return null;
        const first = this.cues[0];
        const last = this.cues[this.cues.length - 1];
        if (time < first.start || time >= last.end) return null;
        let low = 0;
        let high = this.cues.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (this.cues[middle].start <= time) low = middle + 1;
            else high = middle;
        }
        return this.cues[low - 1] || null;
    }

    sync = () => {
        if (this.destroyed || !this.textEl) return;
        const time = Number(this.audioPlayer?.currentTime);
        const index = Number.isFinite(time) ? activeCueIndex(this.cues, time) : -1;
        if (index !== this.activeIndex) {
            this.activeIndex = index;
            // Keep the previous cue through an inter-cue gap; only clear it
            // before the first cue or after the last one.
            this.renderCue(index >= 0 ? this.cues[index] : this.cueForGap(time));
        } else if (index < 0) {
            // activeIndex stays -1 across the whole gap. Re-evaluate the gap
            // context so crossing from "between cues" to "after last" clears
            // the retained previous text.
            this.renderCue(this.cueForGap(time));
        }
        this.updateVisibility();
    };

    renderCue(cue) {
        const text = cue?.text ?? '';
        if (text === this.activeCueText) return;
        const hadText = Boolean(this.activeCueText);
        this.activeCueText = text;
        // A cue gap keeps the gray mask visible. After a cue we freeze the exact
        // previous size; before the first cue there is no previous size, so an
        // .is-empty minimum keeps the pill from collapsing to a 38x20 sliver.
        this.mask?.classList.toggle('is-empty', !text);
        if (!text) {
            if (hadText) this.freezeSize();
            else this.clearFrozenSize();
        } else {
            this.clearFrozenSize();
        }
        // 字幕文本走 textContent，cue 里的 <i>/<b> 等标签不会被解释成 DOM。
        this.textEl.textContent = text;
        // 文本变长短会改变遮罩宽高，手动定位后要重新 clamp，避免顶出视口。
        if (this.positioned && this.visible && !this.dragging) this.applySavedPosition();
    }

    freezeSize() {
        if (!this.mask || this.mask.style.minWidth) return;
        const rect = this.mask.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        this.mask.style.minWidth = `${Math.ceil(rect.width)}px`;
        this.mask.style.minHeight = `${Math.ceil(rect.height)}px`;
    }

    clearFrozenSize() {
        if (!this.mask) return;
        this.mask.style.removeProperty('min-width');
        this.mask.style.removeProperty('min-height');
    }

    isFullscreenOpen() {
        if (!this.fullscreenOverlay || !this.fullscreenOverlay.isConnected) {
            this.fullscreenOverlay = this.doc?.getElementById(FULLSCREEN_OVERLAY_ID) || null;
            if (this.fullscreenOverlay) this.attachFullscreenObserver();
        }
        const overlay = this.fullscreenOverlay;
        if (!overlay) return false;
        return this.win.getComputedStyle(overlay).display !== 'none';
    }

    attachFullscreenObserver() {
        if (!this.fullscreenOverlay || this.fullscreenObserver || typeof globalThis.MutationObserver !== 'function') {
            return;
        }
        // 全屏打开只改 style.display，没有事件可听；观察属性变化最省事。
        this.fullscreenObserver = new globalThis.MutationObserver(() => this.sync());
        this.fullscreenObserver.observe(this.fullscreenOverlay, {
            attributes: true,
            attributeFilter: ['style', 'class'],
        });
    }

    updateVisibility() {
        if (this.destroyed || !this.root) return;
        // Keep the mask visible between cues; only hide when the whole subtitle
        // is unavailable, disabled, or fullscreen owns the lyric pane.
        const shouldShow = Boolean(this.enabled && (this.hasCues || this.workSubtitleAvailable) && !this.isFullscreenOpen());
        if (shouldShow === this.visible) return;
        this.visible = shouldShow;
        this.root.classList.toggle('is-visible', shouldShow);
        this.root.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
        if (shouldShow) this.applySavedPosition();
        else this.closeSettings();
    }

    // -------------------------------------------------------------- 拖动定位

    handlePointerDown = (event) => {
        if (this.destroyed || (event.button !== undefined && event.button !== 0)) return;
        // 齿轮/设置面板不是拖动手柄，否则按下即拖动会吃掉点击。
        // contains() is more reliable than closest() for SVG descendants of the gear button.
        if (this.settingsButton?.contains(event.target) || this.settingsPanel?.contains(event.target)) return;
        const rect = this.mask.getBoundingClientRect();
        this.dragging = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originLeft: rect.left,
            originTop: rect.top,
            moved: false,
            captured: false,
        };
        event.preventDefault();
        // 捕获指针后即使鼠标移出遮罩也能继续拖；失败只是少一层保险。
        try {
            this.mask.setPointerCapture?.(event.pointerId);
            this.dragging.captured = true;
        } catch {
            /* 某些实现不允许此刻捕获 */
        }
    };

    handlePointerMove = (event) => {
        const drag = this.dragging;
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved) {
            if (Math.hypot(dx, dy) < 3) return;
            drag.moved = true;
            this.mask.classList.add('is-dragging');
        }
        const rect = this.mask.getBoundingClientRect();
        const maxLeft = Math.max(DRAG_MARGIN, this.win.innerWidth - rect.width - DRAG_MARGIN);
        const maxTop = Math.max(DRAG_MARGIN, this.win.innerHeight - rect.height - DRAG_MARGIN);
        this.placeAt(
            clamp(drag.originLeft + dx, DRAG_MARGIN, maxLeft),
            clamp(drag.originTop + dy, DRAG_MARGIN, maxTop)
        );
        event.preventDefault();
    };

    handlePointerEnd = () => {
        const drag = this.dragging;
        if (!drag) return;
        this.dragging = null;
        this.mask.classList.remove('is-dragging');
        if (drag.captured && this.mask.hasPointerCapture?.(drag.pointerId)) {
            try {
                this.mask.releasePointerCapture(drag.pointerId);
            } catch {
                /* 已经释放 */
            }
        }
        if (!drag.moved) return;
        const rect = this.mask.getBoundingClientRect();
        this.savedPosition = {
            x: clamp(rect.left / this.win.innerWidth, 0, 1),
            y: clamp(rect.top / this.win.innerHeight, 0, 1),
        };
        writeJson(POSITION_STORAGE_KEY, this.savedPosition);
    };

    placeAt(left, top) {
        if (!this.mask) return;
        this.mask.style.left = `${Math.round(left)}px`;
        this.mask.style.top = `${Math.round(top)}px`;
        this.mask.style.right = 'auto';
        this.mask.style.bottom = 'auto';
        this.mask.style.transform = 'none';
        this.positioned = true;
    }

    /** 默认位置是 CSS 的底部居中；只有拖动过（savedPosition 存在）才恢复绝对位置。 */
    applySavedPosition() {
        if (!this.savedPosition || !this.mask) return;
        // Measure after clearing the old fixed left/top. On a narrow viewport the
        // previous left can constrain the auto width, making the mask collapse
        // and the saved-position clamp move it under the player bar.
        const mask = this.mask;
        const previous = {
            left: mask.style.left,
            top: mask.style.top,
            right: mask.style.right,
            bottom: mask.style.bottom,
            transform: mask.style.transform,
        };
        mask.style.left = '0px';
        mask.style.top = '0px';
        mask.style.right = 'auto';
        mask.style.bottom = 'auto';
        mask.style.transform = 'none';
        const rect = mask.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            mask.style.left = previous.left;
            mask.style.top = previous.top;
            mask.style.right = previous.right;
            mask.style.bottom = previous.bottom;
            mask.style.transform = previous.transform;
            return;
        }
        const maxLeft = Math.max(DRAG_MARGIN, this.win.innerWidth - rect.width - DRAG_MARGIN);
        const maxTop = Math.max(DRAG_MARGIN, this.win.innerHeight - rect.height - DRAG_MARGIN);
        this.placeAt(
            clamp(this.savedPosition.x * this.win.innerWidth, DRAG_MARGIN, maxLeft),
            clamp(this.savedPosition.y * this.win.innerHeight, DRAG_MARGIN, maxTop)
        );
    }

    resetPosition() {
        this.savedPosition = null;
        this.positioned = false;
        try {
            globalThis.localStorage?.removeItem(POSITION_STORAGE_KEY);
        } catch {
            /* 存储不可写时也仍然回到默认位置 */
        }
        if (!this.mask) return;
        for (const property of ['left', 'top', 'right', 'bottom', 'transform']) {
            this.mask.style.removeProperty(property);
        }
    }

    handleViewportChange = () => {
        if (this.destroyed) return;
        if (this.positioned && this.visible) this.applySavedPosition();
        if (this.settingsOpen) this.positionSettings();
    };
}
