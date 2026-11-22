// Tauri 原生桥(创作页用)。
//
// 设计原则:
//   · 普通浏览器零依赖、零行为变化;
//   · 只有检测到 Tauri 时,才通过 window.__TAURI_INTERNALS__.invoke 调原生命令;
//   · 不把 @tauri-apps/api 打进 Web 包,避免给纯网页端增加 Tauri 专用代码。
//
// 对应的 Rust 命令在 .scratch/tauri-proto/src-tauri/src/main.rs:
//   pick_creation_json / save_creation_file / reveal_creation_file。

export function isTauriRuntime() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function invoke(command, args = {}) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals?.invoke) throw new Error('Tauri invoke is unavailable');
    return internals.invoke(command, args);
}

/**
 * 原生「另存为」:下载附件字节,交给用户选择保存位置。
 * @returns {Promise<string|null>} 保存后的绝对路径;取消时返回 null。
 */
export async function saveCreationAttachment({ url, name }) {
    if (!isTauriRuntime()) return null;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    return invoke('save_creation_file', { fileName: name, bytes });
}

/** 原生打开 JSON 文件;取消返回 null。 */
export async function pickCreationJson() {
    if (!isTauriRuntime()) return null;
    const text = await invoke('pick_creation_json');
    return typeof text === 'string' ? text : null;
}

/** 在资源管理器中定位文件(仅 Tauri)。 */
export async function revealCreationFile(path) {
    if (!isTauriRuntime()) return;
    await invoke('reveal_creation_file', { path });
}

/** 抓取 Pawchive 预览页 HTML:Tauri 走原生 curl,Web dev 走同源代理。 */
export async function fetchCreationPreviewHtml(url) {
    if (isTauriRuntime()) return invoke('fetch_creation_preview_html', { url });
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const response = await fetch(`/__creation_preview_fetch?url=${encodeURIComponent(url)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    }
    // 生产 Web 没有代理;直连会在 CORS 处失败,由 UI 提示改用 Tauri。
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

const PAWCHIVE_FILE_HOST = /(^|\.)pawchive\.pw$/;
// 一个域直连失败过一次,本次会话里就直接走代理:站点要求 ≤ 1 请求/秒,不要每个文件都先白打一次。
const corsBlockedHosts = new Set();

/**
 * 取创作附件/原图的字节。先直连(缩略图与附件包的域带 `Access-Control-Allow-Origin: *`);
 * 直连在 fetch 层失败(CORS/网络,TypeError)且是 Web dev 下的 Pawchive 文件子域时,改走同源
 * `/__creation_file_fetch`。Pawchive「点预览图看原图」的签名原图域不带 CORS 头(2026-11-17 实测),
 * 页面直连永远读不到字节,但 <img> 能显示 —— 所以只在下载这条路径上需要代理。
 * HTTP 错误(4xx/5xx)原样返回给调用方,不换路重试,避免把站点拒绝变成第二次请求。
 */
export async function fetchCreationFile(url, init = {}) {
    let host = '';
    try {
        host = new URL(url, window.location.href).hostname;
    } catch {
        /* 非法 URL 交给 fetch 自己报错 */
    }
    const proxyable =
        !isTauriRuntime() &&
        ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
        PAWCHIVE_FILE_HOST.test(host);
    const viaProxy = () => fetch(`/__creation_file_fetch?url=${encodeURIComponent(url)}`, { signal: init.signal });
    if (proxyable && corsBlockedHosts.has(host)) return viaProxy();
    try {
        return await fetch(url, init);
    } catch (error) {
        if (!proxyable || init.signal?.aborted) throw error;
        corsBlockedHosts.add(host);
        return viaProxy();
    }
}

function abortable(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener?.('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener?.('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener?.('abort', onAbort);
                reject(error);
            },
        );
    });
}

/** Kikoeru API JSON:Tauri 原生 curl / Web dev 同源代理 / 普通 Web 直连。 */
export async function fetchKikoeruJson(url, { signal } = {}) {
    if (isTauriRuntime()) {
        // invoke 本身没有 abort 通道;用 race 让调用方及时超时,原生请求会自然结束。
        const text = await abortable(invoke('fetch_kikoeru_json', { url }), signal);
        return JSON.parse(text);
    }
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const response = await fetch(`/__kikoeru_api?url=${encodeURIComponent(url)}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/** Kikoeru 纯文本(健康检查 /api/health 返回 "OK"):复用同一套传输,但不 JSON.parse。 */
export async function fetchKikoeruText(url, { signal } = {}) {
    if (isTauriRuntime()) return abortable(invoke('fetch_kikoeru_json', { url }), signal);
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const response = await fetch(`/__kikoeru_api?url=${encodeURIComponent(url)}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    }
    const response = await fetch(url, { headers: { Accept: 'text/plain' }, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

/** DLsite HTML:Tauri 直接取,开发 Web 走同源 7897 代理。 */
export async function fetchDlsiteHtml(url) {
    // 桌面壳带着 `--disable-web-security` 启动(main.rs 的 WEBVIEW2_BROWSER_ARGS),
    // 直接 fetch 不受同源限制;这里曾经无条件 throw,结果是**桌面版里 DLsite 整条链路
    // 都是死的**——社团/评分/价格/发售日全部为空,而调用方都把异常当"没抓到"吞掉。
    // 开发模式仍然走同源代理,因为浏览器里有 CORS。
    if (isTauriRuntime()) {
        const response = await fetch(url, { headers: { Accept: 'text/html' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    }
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const response = await fetch(`/__dlsite_fetch?url=${encodeURIComponent(url)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    }
    const response = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

/** YouTube 元数据:Tauri 可接原生;Web dev 走同源代理。 */
export async function fetchYoutubeMetadata(url) {
    if (isTauriRuntime()) {
        // 原生 YouTube 抓取(含 PowerShell/curl 与 HTML 解析)尚未实现;不要调用不存在的命令。
        throw new Error('YouTube metadata requires the dev proxy; native Tauri adaptation is pending');
    }
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        const response = await fetch(`/__youtube_meta?url=${encodeURIComponent(url)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }
    throw new Error('YouTube metadata requires the desktop shell or dev proxy');
}

