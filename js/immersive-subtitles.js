// 沉浸式全屏字幕视图（全屏 cover overlay 的「沉浸模式」）。
//
// 与 js/fullscreen-subtitles.js（整份滚动列表）和 js/floating-subtitles.js（非全屏单条）
// 共用 loadSubtitleCues 解析，但视图与交互完全独立：这里不 import 那两个模块，避免把
// 列表滚动/悬浮定位的职责带进 3D 卷轴。
//
// 设计要点：
//   · 正常态只在中央显示当前 cue，上一条/下一条在滚动过渡中卷出/卷入；cue 位置由
//     scrollPos（浮点 cue 索引）连续计算，transform/opacity/rotateX 每帧写内联样式，
//     因此滚轮/拖拽时是连续卷动，不依赖 CSS keyframes。
//   · browsing 态展开上下相邻 cue（低透明度、无 current 高亮），中央保留一条虚线轴，
//     轴上最近的 cue 用虚线框标记为 seek 目标。
//   · 普通点击不 seek；wheel / 长按 / 拖拽进入 browsing，停止/松手时 seek 到目标 cue
//     的 start 并卷回正常态。手势只绑在本模块 root 上，左上角按钮是 root 的兄弟节点，
//     事件不会互相抢。
//   · 本模块自己给最近的 #fullscreen-cover-overlay 加 `immersive-subtitles-mode`，
//     配套 CSS 只在该 class 下隐藏 media 列/播放控件；visualizer、.ui-hidden 与
//     .fullscreen-top-actions 的既有语义不动。
import './immersive-subtitles.css';
import { getLanguage, t } from './i18n.js';
import { loadSubtitleCues, subtitleSupported } from './voice-subtitles.js';

const OVERLAY_ID = 'fullscreen-cover-overlay';
const ROOT_CLASS = 'immersive-subtitles';
const MODE_CLASS = 'immersive-subtitles-mode';
const CONTAINER_CLASS = 'immersive-subtitles-container';

// 时间同步节奏：timeupdate 在很多浏览器里粒度约 250ms，纯靠它会让卷动落后半个字；
// interval 补帧（与全屏/悬浮字幕同一取舍），只在模块存活期间运行。
const SYNC_INTERVAL_MS = 100;
// 正常态只需要 ±2（±1 仅在滚动过渡中出现）；browsing 展开到 ±3。
const NORMAL_RADIUS = 2;
const BROWSING_RADIUS = 3;
// 固定 DOM 池：cue 索引 → 元素绑定跟随滚动，避免每帧重建节点；12 覆盖最大窗口 + 缓冲。
const SLOT_COUNT = 12;
const ROLL_MS = 520;
const SETTLE_MS = 260;
const WHEEL_IDLE_MS = 320;
// 一格鼠标滚轮约 100px；做成一格约一条 cue，触控板的小增量会自然累积。
const WHEEL_STEP_PX = 96;
// 长按要明显长于点击（普通点击不 seek），否则容易误触。
const LONG_PRESS_MS = 220;
const DRAG_THRESHOLD_PX = 8;
const CLICK_SUPPRESS_MS = 280;
const FOLLOW_EASING = 0.26;
// 动态行距：多行长 cue 的 offsetHeight 会超过固定视口比例；每条之间至少留 20px。
const SLOT_GAP_PX = 32;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** 与 fullscreen/floating 字幕一致的时间轴查找：cue 按 start 升序，二分定位当前条。 */
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

/** 只接受能画出来的 cue；脏数据（空文本/倒置时间）直接丢弃，避免出现空白帧。 */
function normalizeCue(cue) {
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    const text = String(cue?.text ?? '').trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end, text };
}

/** ASS/SSA 只有解析入口没有渲染器，静默显示空视图不如明确提示。 */
const UNSUPPORTED_MESSAGE = 'ASS/SSA subtitles are not supported yet';

/** 交互提示跟着界面语言走；i18n 里没有这两个 key，所以在模块内维护一个小词典。 */
function immersiveLabels() {
    const zh = String(getLanguage() || '')
        .toLowerCase()
        .startsWith('zh');
    return zh
        ? { aria: '沉浸式字幕', hint: '滚动 · 拖动', release: '松开跳转' }
        : { aria: 'Immersive subtitles', hint: 'SCROLL · DRAG', release: 'RELEASE TO SEEK' };
}

/**
 * 沉浸式全屏字幕控制器。
 *
 * 构造即接管 container（清空原内容并渲染卷轴），destroy() 后不可复用；切轨用
 * setTrack()，或直接 setCues() 传入已解析的 cue（测试/宿主自备解析时）。
 */
export class ImmersiveSubtitles {
    constructor({ container, audioPlayer = null, track = null, cues = null, overlay = null } = {}) {
        if (!container) throw new TypeError('createImmersiveSubtitles: container is required');
        this.doc = container.ownerDocument || globalThis.document;
        this.win = this.doc?.defaultView || globalThis;
        this.container = container;
        this.audioPlayer = audioPlayer || null;
        this.overlay = overlay || container.closest?.(`#${OVERLAY_ID}`) || this.doc?.getElementById(OVERLAY_ID) || null;

        this.track = null;
        this.subtitle = null;
        this.cues = [];
        this.cueToken = 0;
        this.abortController = null;

        this.destroyed = false;
        this.activeIndex = -1;
        // Remember the last real cue so a cue after a gap still rolls from the
        // previous one instead of snapping because activeIndex briefly became -1.
        this.lastActiveIndex = -1;
        this.scrollPos = 0;
        this.browsing = false;
        this.settling = false;
        this.browsingSource = null;
        this.browsingStartActive = -1;
        this.browseTarget = 0;
        // 拖拽以按下瞬间的 scrollPos 为基准；若改用实时 scrollPos 累加，跟随动画的
        // 滞后会让每一次 pointermove 都多叠一段位移。
        this.dragStartScroll = 0;
        this.messageText = '';
        this.messageKey = '';

        this.rafId = null;
        this.following = false;
        this.followTarget = 0;
        this.syncInterval = null;
        this.wheelIdleTimer = null;
        this.longPressTimer = null;
        this.pointer = null;
        this.suppressClickUntil = 0;
        this.resizeObserver = null;

        this.slots = [];
        this.root = null;
        this.stage = null;
        this.axis = null;
        this.status = null;
        this.hintEl = null;
        this.releaseEl = null;
        this.counterEl = null;
        this.messageEl = null;
        this.liveEl = null;

        this.cleanupFn = () => this.destroy();
        this.audioEvents = ['timeupdate', 'seeked', 'ratechange'];

        this.buildDom();
        this.mount();
        this.attachAudio();
        this.attachPointer();
        this.doc?.addEventListener('monochrome:language-changed', this.handleLanguageChange);

        if (Array.isArray(cues)) this.setCues(cues);
        else if (track) void this.setTrack(track);
        else this.setMessage(t('player.subtitleEmpty'), 'player.subtitleEmpty');
    }

    // ------------------------------------------------------------------ API

    /** 切换音轨：重新解析/加载字幕；旧请求用 token + AbortController 丢弃。 */
    setTrack(track) {
        if (this.destroyed) return Promise.resolve();
        this.track = track || null;
        this.subtitle = this.resolveSubtitle(track);
        return this.loadCues();
    }

    /** 宿主已自带解析结果时直接接管，不再发请求。 */
    setCues(list) {
        if (this.destroyed) return;
        this.cueToken += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.resetView();
        this.cues = (Array.isArray(list) ? list : []).map(normalizeCue).filter(Boolean);
        if (!this.cues.length) {
            this.setMessage(t('player.subtitleEmpty'), 'player.subtitleEmpty');
            return;
        }
        this.setMessage('');
        this.render();
        this.sync({ initial: true });
    }

    /**
     * container 内容被外部 ui.js 替换后重新挂载并同步。
     * 事件绑定在 root 上，root 被移除后事件随之失效，所以这里只需放回 DOM。
     */
    refresh() {
        if (this.destroyed) return;
        if (this.root && !this.container.contains(this.root)) {
            this.container.replaceChildren(this.root);
            this.applyModeClasses();
        }
        this.render();
        this.sync({ initial: true });
    }

    /** 只读状态快照，方便集成方/探针断言，不暴露内部可变引用。 */
    get state() {
        return {
            destroyed: this.destroyed,
            activeIndex: this.activeIndex,
            browsing: this.browsing,
            settling: this.settling,
            cueCount: this.cues.length,
            scrollPos: this.scrollPos,
            targetIndex: this.cues.length ? this.targetIndex() : -1,
        };
    }

    /** 幂等清理：定时器/动画/监听器/DOM/mode class 全部移除。 */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.cueToken += 1;
        this.abortController?.abort();
        this.abortController = null;

        this.stopAnimation();
        this.clearWheelIdle();
        this.clearLongPress();
        this.pointer = null;
        this.stopAudio();

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        this.root?.removeEventListener('wheel', this.handleWheel);
        this.root?.removeEventListener('pointerdown', this.handlePointerDown);
        this.root?.removeEventListener('pointermove', this.handlePointerMove);
        this.root?.removeEventListener('pointerup', this.handlePointerUp);
        this.root?.removeEventListener('pointercancel', this.handlePointerUp);
        this.root?.removeEventListener('click', this.handleClick);
        this.root?.removeEventListener('contextmenu', this.handleContextMenu);
        this.win.removeEventListener('pointerup', this.handlePointerUp);
        this.win.removeEventListener('pointercancel', this.handlePointerUp);
        this.win.removeEventListener('blur', this.handleWindowBlur);
        this.doc?.removeEventListener('monochrome:language-changed', this.handleLanguageChange);

        this.overlay?.classList.remove(MODE_CLASS);
        this.container?.classList.remove(CONTAINER_CLASS);
        if (this.container && this.container.lyricsCleanup === this.cleanupFn) {
            this.container.lyricsCleanup = null;
        }
        this.root?.remove();
        this.root = null;
        this.stage = null;
        this.axis = null;
        this.status = null;
        this.hintEl = null;
        this.releaseEl = null;
        this.counterEl = null;
        this.messageEl = null;
        this.liveEl = null;
        this.slots = [];
        this.cues = [];
        this.activeIndex = -1;
    }

    // ---------------------------------------------------------------- 数据

    resolveSubtitle(track) {
        const subtitle = track?.subtitle;
        if (!subtitle?.node?.mediaStreamUrl) return null;
        return subtitle;
    }

    async loadCues() {
        const token = ++this.cueToken;
        this.abortController?.abort();
        this.abortController = null;
        this.cues = [];
        this.resetView();

        const subtitle = this.subtitle;
        if (!subtitle) {
            this.setMessage(t('player.subtitleEmpty'), 'player.subtitleEmpty');
            return;
        }
        if (!subtitleSupported(subtitle.format)) {
            this.setMessage(UNSUPPORTED_MESSAGE);
            return;
        }

        this.setMessage(t('player.subtitleLoading'), 'player.subtitleLoading');
        const controller = new AbortController();
        this.abortController = controller;
        try {
            const loaded = await loadSubtitleCues(subtitle, { signal: controller.signal });
            if (this.destroyed || token !== this.cueToken) return;
            this.abortController = null;
            this.cues = (Array.isArray(loaded) ? loaded : []).map(normalizeCue).filter(Boolean);
            if (!this.cues.length) {
                this.setMessage(t('player.subtitleEmpty'), 'player.subtitleEmpty');
                return;
            }
            this.setMessage('');
            this.render();
            this.sync({ initial: true });
        } catch (error) {
            if (this.destroyed || token !== this.cueToken) return;
            if (error?.name === 'AbortError') return;
            console.warn('Failed to load immersive subtitles:', error);
            this.setMessage(t('player.subtitleError'), 'player.subtitleError');
        }
    }

    resetView() {
        this.stopAnimation();
        this.clearWheelIdle();
        this.clearLongPress();
        this.pointer = null;
        this.browsing = false;
        this.settling = false;
        this.browsingSource = null;
        this.browsingStartActive = -1;
        this.browseTarget = 0;
        this.activeIndex = -1;
        this.lastActiveIndex = -1;
        this.scrollPos = 0;
        this.suppressClickUntil = 0;
        this.root?.classList.remove('is-browsing', 'is-settling', 'is-dragging');
        this.slots.forEach((slot) => {
            slot.cueIndex = null;
            slot.el.style.visibility = 'hidden';
            slot.el.style.opacity = '0';
            slot.lastBlur = null;
        });
        this.updateLiveText();
        this.updateStatus();
    }

    // ---------------------------------------------------------------- 同步

    attachAudio() {
        for (const event of this.audioEvents) this.audioPlayer?.addEventListener(event, this.handleAudioEvent);
        this.syncInterval = this.win.setInterval(() => this.sync(), SYNC_INTERVAL_MS);
    }

    stopAudio() {
        for (const event of this.audioEvents) this.audioPlayer?.removeEventListener(event, this.handleAudioEvent);
        if (this.syncInterval) this.win.clearInterval(this.syncInterval);
        this.syncInterval = null;
    }

    handleAudioEvent = () => {
        this.sync();
    };

    /**
     * 时间 → 当前 cue。browsing/settling 时不抢用户手势：只更新 activeIndex，
     * 让目标 cue 的落点由 settleBrowsing 决定。
     */
    sync({ initial = false } = {}) {
        if (this.destroyed || !this.cues.length) return;
        const time = Number(this.audioPlayer?.currentTime);
        if (!Number.isFinite(time)) return;
        const index = activeCueIndex(this.cues, time);
        if (index === this.activeIndex) return;
        const previous = this.activeIndex;
        if (previous >= 0) this.lastActiveIndex = previous;
        this.activeIndex = index;
        this.updateLiveText();
        // During a cue gap keep the last real cue as the animation origin. The
        // next cue then rolls from it instead of snapping from -1.
        if (this.browsing || this.settling || index < 0) return;

        const transitionFrom = previous >= 0 ? previous : this.lastActiveIndex;
        // 首帧或外部大幅 seek（拖进度条）直接落位；只让相邻 cue 的切换做卷动动画。
        if (initial || transitionFrom < 0 || this.reduceMotion || Math.abs(index - transitionFrom) > 1) {
            this.stopAnimation();
            this.scrollPos = index;
            this.lastActiveIndex = index;
            this.render();
            return;
        }
        this.startTween(index, ROLL_MS);
        this.lastActiveIndex = index;
    }

    get reduceMotion() {
        return this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    }

    updateLiveText() {
        if (!this.liveEl) return;
        const cue = this.activeIndex >= 0 ? this.cues[this.activeIndex] : null;
        this.liveEl.textContent = cue ? cue.text : '';
    }

    // ---------------------------------------------------------------- 渲染

    buildDom() {
        const doc = this.doc;
        const labels = immersiveLabels();
        const root = doc.createElement('div');
        root.className = ROOT_CLASS;
        root.dataset.state = 'normal';
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', labels.aria);

        const stage = doc.createElement('div');
        stage.className = `${ROOT_CLASS}-stage`;

        const axis = doc.createElement('div');
        axis.className = `${ROOT_CLASS}-axis`;
        axis.setAttribute('aria-hidden', 'true');
        stage.appendChild(axis);

        const slots = [];
        for (let index = 0; index < SLOT_COUNT; index += 1) {
            const cueEl = doc.createElement('div');
            cueEl.className = `${ROOT_CLASS}-cue`;
            cueEl.style.opacity = '0';
            cueEl.style.visibility = 'hidden';
            stage.appendChild(cueEl);
            slots.push({ el: cueEl, cueIndex: null, lastBlur: null });
        }

        const status = doc.createElement('div');
        status.className = `${ROOT_CLASS}-status`;
        status.setAttribute('aria-hidden', 'true');
        const hint = doc.createElement('span');
        hint.className = `${ROOT_CLASS}-hint`;
        hint.textContent = labels.hint;
        const release = doc.createElement('span');
        release.className = `${ROOT_CLASS}-release`;
        release.textContent = labels.release;
        const counter = doc.createElement('span');
        counter.className = `${ROOT_CLASS}-counter`;
        counter.textContent = '';
        status.append(hint, release, counter);

        const message = doc.createElement('div');
        message.className = `${ROOT_CLASS}-message`;
        message.hidden = true;

        const live = doc.createElement('div');
        live.className = `${ROOT_CLASS}-live`;
        live.setAttribute('aria-live', 'polite');
        live.setAttribute('aria-atomic', 'true');

        root.append(stage, status, message, live);
        this.root = root;
        this.stage = stage;
        this.axis = axis;
        this.status = status;
        this.hintEl = hint;
        this.releaseEl = release;
        this.counterEl = counter;
        this.messageEl = message;
        this.liveEl = live;
        this.slots = slots;
    }

    /** 接管 container：清掉旧的列表/占位，放上卷轴并挂 mode class。 */
    mount() {
        if (!this.root) return;
        this.container.replaceChildren(this.root);
        this.applyModeClasses();
        this.container.lyricsCleanup = this.cleanupFn;

        if (typeof this.win.ResizeObserver === 'function') {
            this.resizeObserver = new this.win.ResizeObserver(() => this.render());
            this.resizeObserver.observe(this.root);
        }
    }

    applyModeClasses() {
        this.container?.classList.add(CONTAINER_CLASS);
        this.overlay?.classList.add(MODE_CLASS);
    }

    attachPointer() {
        if (!this.root) return;
        this.root.addEventListener('wheel', this.handleWheel, { passive: false });
        this.root.addEventListener('pointerdown', this.handlePointerDown, { passive: true });
        this.root.addEventListener('pointermove', this.handlePointerMove, { passive: false });
        this.root.addEventListener('pointerup', this.handlePointerUp);
        this.root.addEventListener('pointercancel', this.handlePointerUp);
        this.root.addEventListener('click', this.handleClick);
        this.root.addEventListener('contextmenu', this.handleContextMenu);
        // Pointer capture 在部分浏览器会比 root 上的 pointerup 先结束；window 兜底避免卡在拖拽态。
        this.win.addEventListener('pointerup', this.handlePointerUp);
        this.win.addEventListener('pointercancel', this.handlePointerUp);
        this.win.addEventListener('blur', this.handleWindowBlur);
    }

    /** 卷轴项基准间距跟着视口高度走；多行长 cue 在 render 里按实际高度再抬高。 */
    get spacing() {
        const height = this.root?.clientHeight || 0;
        return height ? clamp(height * 0.18, 80, 170) : 104;
    }

    targetIndex() {
        if (!this.cues.length) return -1;
        return clamp(Math.round(this.scrollPos), 0, this.cues.length - 1);
    }

    clampIndex(value) {
        if (!this.cues.length) return 0;
        return clamp(value, 0, this.cues.length - 1);
    }

    render() {
        if (this.destroyed || !this.root) return;
        const cues = this.cues;
        const total = cues.length;
        if (!total) {
            this.slots.forEach((slot) => {
                slot.cueIndex = null;
                slot.el.style.visibility = 'hidden';
                slot.el.style.opacity = '0';
            });
            this.updateStatus();
            return;
        }

        const radius = this.browsing ? BROWSING_RADIUS : NORMAL_RADIUS;
        const center = this.scrollPos;
        const lo = Math.max(0, Math.floor(center) - radius - 1);
        const hi = Math.min(total - 1, Math.ceil(center) + radius + 1);

        // 先释放离开窗口的绑定，再给窗口内缺失的 index 找空槽；已有绑定的元素保持不动，
        // 这样动画中每个元素的文字不会互相交换（否则卷动会变成“文字乱跳”）。
        for (const slot of this.slots) {
            if (slot.cueIndex !== null && (slot.cueIndex < lo || slot.cueIndex > hi)) slot.cueIndex = null;
        }
        const bound = new Set();
        for (const slot of this.slots) if (slot.cueIndex !== null) bound.add(slot.cueIndex);
        for (let index = lo; index <= hi; index += 1) {
            if (bound.has(index)) continue;
            const free = this.slots.find((slot) => slot.cueIndex === null);
            if (!free) break;
            free.cueIndex = index;
            free.el.textContent = cues[index].text;
            free.lastBlur = null;
            bound.add(index);
        }

        // Dynamic spacing: a 3-line cue can be taller than the viewport-derived
        // base spacing. Measure bound slots first, then guarantee a vertical gap.
        const baseSpacing = this.spacing;
        let maxSlotHeight = 0;
        for (const slot of this.slots) {
            if (slot.cueIndex === null || !slot.el) continue;
            maxSlotHeight = Math.max(maxSlotHeight, slot.el.offsetHeight || 0);
        }
        const spacing = Math.max(baseSpacing, maxSlotHeight * 1.15 + SLOT_GAP_PX);
        this.root.dataset.spacing = spacing.toFixed(2);
        const targetIndex = this.browsing ? this.targetIndex() : -1;
        for (const slot of this.slots) {
            const el = slot.el;
            if (slot.cueIndex === null) {
                el.style.visibility = 'hidden';
                el.style.opacity = '0';
                el.classList.remove('is-current', 'is-target');
                continue;
            }
            const offset = slot.cueIndex - center;
            const abs = Math.abs(offset);
            const visible = abs <= radius + 1.5;

            // 上方 cue 的顶边向后倒（rotateX 正值），形成向下卷轴的圆柱感；
            // 正常态 ±1 之外必然淡出，保证静止时只剩中心一条。
            const y = offset * spacing;
            const z = -Math.min(260, abs * 70);
            const rotate = clamp(-offset * 10, -40, 40);
            const scale = Math.max(0.6, 1 - abs * 0.14);
            const isCurrentTimeCue = slot.cueIndex === this.activeIndex;
            // In browsing the current-time cue stays highlighted while the
            // selected/target cue is marked by the dashed target box; the rest
            // must recede instead of competing for attention.
            const opacity = this.browsing
                ? isCurrentTimeCue
                    ? 1
                    : clamp(1 - abs * 0.24, 0.12, 0.52)
                : clamp(1 - abs * 1.15, 0, 1);
            const blur = this.browsing ? Math.min(2.4, abs * 0.7) : Math.min(7, Math.max(0, abs - 0.28) * 9);

            el.style.visibility = visible ? 'visible' : 'hidden';
            el.style.transform = `translate(-50%, -50%) translate3d(0, ${y.toFixed(2)}px, ${z.toFixed(
                1
            )}px) rotateX(${rotate.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
            el.style.opacity = opacity.toFixed(3);
            // filter 每帧写会触发样式重算，按 0.25px 分桶只在明显变化时更新。
            if (slot.lastBlur === null || Math.abs(slot.lastBlur - blur) > 0.24) {
                el.style.filter = blur < 0.05 ? 'none' : `blur(${blur.toFixed(2)}px)`;
                slot.lastBlur = blur;
            }
            el.classList.toggle('is-current', isCurrentTimeCue);
            el.classList.toggle('is-target', this.browsing && slot.cueIndex === targetIndex);
        }
        this.updateStatus();
    }

    updateStatus() {
        if (!this.root) return;
        const state = this.messageText ? 'message' : this.browsing ? 'browsing' : 'normal';
        if (this.root.dataset.state !== state) this.root.dataset.state = state;
        if (this.counterEl) {
            this.counterEl.textContent =
                this.browsing && this.cues.length ? `${this.targetIndex() + 1} / ${this.cues.length}` : '';
        }
        if (this.releaseEl) this.releaseEl.hidden = !this.browsing;
        if (this.hintEl) this.hintEl.hidden = this.browsing;
    }

    setMessage(text, key = '') {
        this.messageText = text || '';
        this.messageKey = this.messageText ? key : '';
        if (!this.root) return;
        this.root.classList.toggle('is-message', Boolean(this.messageText));
        if (this.messageEl) {
            this.messageEl.textContent = this.messageText;
            this.messageEl.hidden = !this.messageText;
        }
        this.updateStatus();
    }

    /** 运行中切换界面语言时，就地更新提示与占位文案，不重建 DOM、不影响播放。 */
    handleLanguageChange = () => {
        if (this.destroyed) return;
        const labels = immersiveLabels();
        this.root?.setAttribute('aria-label', labels.aria);
        if (this.hintEl) this.hintEl.textContent = labels.hint;
        if (this.releaseEl) this.releaseEl.textContent = labels.release;
        if (this.messageKey) this.setMessage(t(this.messageKey), this.messageKey);
    };

    // ------------------------------------------------------------ 卷动动画

    stopAnimation() {
        if (this.rafId !== null) {
            this.win.cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.following = false;
    }

    startTween(target, duration, done) {
        this.stopAnimation();
        const from = this.scrollPos;
        const finish = () => {
            this.rafId = null;
            done?.();
        };
        if (duration <= 0 || Math.abs(target - from) < 0.0005) {
            this.scrollPos = target;
            this.render();
            finish();
            return;
        }
        const startedAt = this.win.performance.now();
        const step = (now) => {
            if (this.destroyed) return;
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            this.scrollPos = from + (target - from) * eased;
            this.render();
            if (progress < 1) this.rafId = this.win.requestAnimationFrame(step);
            else finish();
        };
        this.rafId = this.win.requestAnimationFrame(step);
    }

    /** browsing 用连续跟随（lerp）而不是定长 tween：wheel/拖拽可以在半途改变目标。 */
    startFollow(target) {
        this.followTarget = target;
        if (this.following) return;
        this.following = true;
        if (this.rafId !== null) {
            this.win.cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        const step = () => {
            if (this.destroyed) return;
            const diff = this.followTarget - this.scrollPos;
            if (Math.abs(diff) < 0.002) {
                this.scrollPos = this.followTarget;
                this.following = false;
                this.rafId = null;
                this.render();
                return;
            }
            this.scrollPos += diff * FOLLOW_EASING;
            this.render();
            this.rafId = this.win.requestAnimationFrame(step);
        };
        this.rafId = this.win.requestAnimationFrame(step);
    }

    // -------------------------------------------------------------- 交互

    enterBrowsing(source) {
        if (this.destroyed || this.browsing || !this.cues.length) return;
        this.browsing = true;
        this.browsingSource = source;
        this.browsingStartActive = this.activeIndex;
        this.browseTarget = this.scrollPos;
        // 上一次 settle 的收尾动画被新一轮手势打断时，settling 必须一起复位，
        // 否则 sync() 会一直让位于一个永远不会结束的“落位中”。
        this.settling = false;
        this.root.classList.remove('is-settling');
        this.stopAnimation();
        this.root.classList.add('is-browsing');
        this.render();
    }

    settleBrowsing() {
        if (!this.browsing || this.destroyed) return;
        this.clearWheelIdle();
        const target = this.targetIndex();
        // 长按后没拖动/滚轮只回到起点：不 seek，避免“误把当前这句重播”。
        const shouldSeek = target !== this.browsingStartActive;
        this.browsing = false;
        this.settling = true;
        this.root.classList.remove('is-browsing');
        this.root.classList.add('is-settling');
        if (shouldSeek) this.seekTo(target);
        this.updateStatus();
        this.startTween(target, this.reduceMotion ? 0 : SETTLE_MS, () => {
            if (this.destroyed) return;
            this.settling = false;
            this.root?.classList.remove('is-settling');
            this.sync();
        });
    }

    seekTo(index) {
        const cue = this.cues[index];
        if (!cue || !this.audioPlayer) return;
        const start = Number(cue.start);
        if (!Number.isFinite(start)) return;
        try {
            this.audioPlayer.currentTime = start;
        } catch {
            /* 媒体尚未 metadata 时 setter 可能抛错；下一次 sync 会再对一次。 */
            return;
        }
        // 与既有 fullscreen 字幕一致：除原生 seeked 外再手动通知一次，保证同步立即发生。
        try {
            this.audioPlayer.dispatchEvent(new Event('seeked'));
        } catch {
            /* 非 EventTarget 的宿主（测试替身）忽略即可。 */
        }
    }

    scheduleWheelIdle() {
        this.clearWheelIdle();
        this.wheelIdleTimer = this.win.setTimeout(() => {
            this.wheelIdleTimer = null;
            this.settleBrowsing();
        }, WHEEL_IDLE_MS);
    }

    clearWheelIdle() {
        if (this.wheelIdleTimer) this.win.clearTimeout(this.wheelIdleTimer);
        this.wheelIdleTimer = null;
    }

    clearLongPress() {
        if (this.longPressTimer) this.win.clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
    }

    wheelDelta(event) {
        let delta = Number(event.deltaY);
        if (!delta) delta = Number(event.deltaX);
        if (!Number.isFinite(delta)) return 0;
        if (event.deltaMode === 1) delta *= 16;
        else if (event.deltaMode === 2) delta *= this.root?.clientHeight || 480;
        return delta;
    }

    handleWheel = (event) => {
        if (this.destroyed || !this.cues.length) return;
        // Ctrl+wheel 是浏览器缩放，不接管。
        if (event.ctrlKey) return;
        const delta = this.wheelDelta(event);
        if (!delta) return;
        event.preventDefault();
        if (!this.browsing) this.enterBrowsing('wheel');
        const step = clamp(delta / WHEEL_STEP_PX, -1.2, 1.2);
        this.browseTarget = this.clampIndex(this.browseTarget + step);
        this.startFollow(this.browseTarget);
        this.scheduleWheelIdle();
    };

    handlePointerDown = (event) => {
        if (this.destroyed || !this.cues.length) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        // 将来若在 root 里放按钮/链接，交给它们自己处理，不进入卷轴手势。
        if (event.target?.closest?.('button, a, input, select, textarea, [data-immersive-no-gesture]')) return;
        this.clearPointerTimers();
        this.clearLongPress();
        // 指针按下后滚轮计时的“停止即 seek”不该在拖拽中途抢跑。
        this.clearWheelIdle();
        this.suppressClickUntil = 0;
        this.pointer = {
            id: event.pointerId,
            startY: event.clientY,
            browsing: false,
            captured: false,
        };
        this.longPressTimer = this.win.setTimeout(() => {
            this.longPressTimer = null;
            this.beginPointerBrowsing();
        }, LONG_PRESS_MS);
    };

    beginPointerBrowsing() {
        const pointer = this.pointer;
        if (!pointer || pointer.browsing || this.destroyed) return;
        this.clearLongPress();
        pointer.browsing = true;
        this.enterBrowsing('pointer');
        this.browseTarget = this.scrollPos;
        this.dragStartScroll = this.scrollPos;
        this.root.classList.add('is-dragging');
        this.capturePointer(pointer.id);
    }

    handlePointerMove = (event) => {
        const pointer = this.pointer;
        if (!pointer || this.destroyed || event.pointerId !== pointer.id) return;
        const dy = pointer.startY - event.clientY;
        if (!pointer.browsing) {
            if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
            this.beginPointerBrowsing();
        }
        if (!this.browsing) return;
        event.preventDefault();
        // 向上拖（clientY 变小）对应 cue 索引增大，和滚轮方向保持一致。
        this.browseTarget = this.clampIndex(this.dragStartScroll + dy / this.spacing);
        this.startFollow(this.browseTarget);
    };

    handlePointerUp = (event) => {
        const pointer = this.pointer;
        if (!pointer || this.destroyed) return;
        if (event?.pointerId !== undefined && event.pointerId !== pointer.id) return;
        this.clearPointerTimers();
        const wasBrowsing = pointer.browsing;
        this.releasePointer(pointer.id);
        this.pointer = null;
        this.root?.classList.remove('is-dragging');
        if (wasBrowsing) {
            this.suppressClickUntil = this.win.performance.now() + CLICK_SUPPRESS_MS;
            this.settleBrowsing();
        }
    };

    handleWindowBlur = () => {
        if (this.pointer) {
            const wasBrowsing = this.pointer.browsing;
            this.releasePointer(this.pointer.id);
            this.pointer = null;
            this.root?.classList.remove('is-dragging');
            this.clearPointerTimers();
            if (wasBrowsing) this.settleBrowsing();
            return;
        }
        if (this.browsing) this.settleBrowsing();
    };

    handleClick = (event) => {
        if (this.destroyed) return;
        // 普通点击不 seek；只有刚结束的拖拽长按会吞掉 click，避免触发 overlay 的点击行为。
        if (this.win.performance.now() < this.suppressClickUntil) {
            event.preventDefault();
            event.stopPropagation();
        }
    };

    handleContextMenu = (event) => {
        // 触摸端长按可能弹系统菜单；browsing 时让它别打断卷轴。
        if (this.browsing) event.preventDefault();
    };

    capturePointer(pointerId) {
        try {
            this.root?.setPointerCapture?.(pointerId);
            if (this.pointer) this.pointer.captured = true;
        } catch {
            /* Pointer capture 只是增强，失败不影响拖拽。 */
        }
    }

    releasePointer(pointerId) {
        if (!this.pointer?.captured) return;
        try {
            if (this.root?.hasPointerCapture?.(pointerId)) this.root.releasePointerCapture(pointerId);
        } catch {
            /* 已经释放过。 */
        }
    }

    clearPointerTimers() {
        this.clearLongPress();
    }
}

/** 工厂函数：Lead 用 `createImmersiveSubtitles({ container, audioPlayer, track })` 接入。 */
export function createImmersiveSubtitles(options) {
    return new ImmersiveSubtitles(options);
}
