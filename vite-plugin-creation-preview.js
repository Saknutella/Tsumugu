// 开发环境专用:给创作页的 "从 Pawchive 链接导入" 提供同源代理。
// 生产 Web 没有这些 endpoint;CORS 直连失败时前端会提示用 Tauri 原生桥。
// 帖子页只允许 pawchive.pw 的帖子 URL、文件只允许 *.pawchive.pw 子域,避免变成任意 URL 的 SSRF 代理。
import https from 'node:https';

const ALLOWED_HOSTS = new Set(['pawchive.pw', 'www.pawchive.pw']);
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

function isAllowed(url) {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' &&
            ALLOWED_HOSTS.has(parsed.hostname) &&
            /^\/patreon\/user\/\d+\/post\/\d+\/?$/.test(parsed.pathname)
        );
    } catch {
        return false;
    }
}

export default function creationPreviewFetchPlugin() {
    return {
        name: 'creation-preview-fetch',
        configureServer(server) {
            server.middlewares.use('/__creation_preview_fetch', async (req, res) => {
                const requestUrl = new URL(req.url ?? '/', 'http://localhost');
                const target = requestUrl.searchParams.get('url') ?? '';
                if (!isAllowed(target)) {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end('Only pawchive.pw post URLs are allowed');
                    return;
                }
                try {
                    const response = await fetch(target, {
                        headers: {
                            'user-agent': USER_AGENT,
                            accept: 'text/html,application/xhtml+xml',
                        },
                        signal: AbortSignal.timeout(30_000),
                    });
                    const body = await response.text();
                    res.statusCode = response.ok ? 200 : 502;
                    res.setHeader('content-type', 'text/html; charset=utf-8');
                    res.end(body);
                } catch (error) {
                    res.statusCode = 502;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end(`Fetch failed: ${error?.message ?? error}`);
                }
            });
            server.middlewares.use('/__creation_file_fetch', createCreationFileMiddleware());
        },
    };
}

// ---- /__creation_file_fetch:Pawchive 原图/附件的同源转发 ----
//
// 为什么需要:帖子里「点预览图看原图」的原图在 `t*.pawchive.pw/f/...?e=<到期>&s=<签名>`,
// 2026-11-17 实测它返回 200 但**没有** Access-Control-Allow-Origin(缩略图 img.pawchive.pw 和
// 附件 n*.pawchive.pw 有 `*`)。<img> 显示不受 CORS 限制,灯箱能看;但「下载所选」要 fetch 字节
// 存进本地/host,页面直连会被 CORS 拦下,状态变成「失败」。dev 下由这里转发,前端只在直连失败时才用它。
//
// UA:文件服务器对 UA 敏感(docs/09):浏览器 UA 403,可识别的工具 UA 200,所以这里不冒充浏览器。
// 代理:本机原图子域直连连接超时、经 HTTPS_PROXY 200。`https.Agent({ proxyEnv })` 依赖 Node ≥ 24.5
// (本机 24.16 实测);更老的 Node 上的行为未验证。
const FILE_USER_AGENT = 'monochrome-dev-file-proxy/1.0';
const FILE_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;

export function isAllowedCreationFileUrl(value) {
    try {
        const url = new URL(value);
        return (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            (url.port === '' || url.port === '443') &&
            url.hostname.endsWith('.pawchive.pw') &&
            !ALLOWED_HOSTS.has(url.hostname)
        );
    } catch {
        return false;
    }
}

let fileAgent = null;
function requestPawchiveFile(target, redirects = 0) {
    fileAgent ??= new https.Agent({ keepAlive: true, proxyEnv: process.env });
    return new Promise((resolve, reject) => {
        const request = https.get(
            target,
            { agent: fileAgent, headers: { 'user-agent': FILE_USER_AGENT, accept: '*/*' } },
            (response) => {
                const location = response.headers.location;
                if (response.statusCode >= 300 && response.statusCode < 400 && location) {
                    response.resume();
                    const next = new URL(location, target).href;
                    // 重定向也必须留在 Pawchive 文件子域里,否则就成了开放转发。
                    if (redirects >= MAX_REDIRECTS || !isAllowedCreationFileUrl(next)) {
                        reject(new Error('redirect outside pawchive file hosts'));
                        return;
                    }
                    resolve(requestPawchiveFile(next, redirects + 1));
                    return;
                }
                resolve({
                    status: response.statusCode ?? 502,
                    contentType: response.headers['content-type'] || 'application/octet-stream',
                    contentLength: Number(response.headers['content-length']) || 0,
                    contentDisposition: response.headers['content-disposition'] || '',
                    body: response,
                });
            }
        );
        request.setTimeout(FILE_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
        request.on('error', reject);
    });
}

/**
 * `request(target)` 可注入(探针用桩,不联网);返回 `{ status, contentType, contentLength, body: Readable }`。
 * 只做 GET,body 直接 pipe 给页面,不在 dev server 内存里攒整个文件(附件包 20–60 MB)。
 */
export function createCreationFileMiddleware({ request = requestPawchiveFile } = {}) {
    return async (req, res) => {
        res.setHeader('cache-control', 'no-store');
        if (req.method && req.method !== 'GET') {
            res.statusCode = 405;
            res.end('GET only');
            return;
        }
        const target = new URL(req.url ?? '/', 'http://localhost').searchParams.get('url') ?? '';
        if (!isAllowedCreationFileUrl(target)) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Only https://*.pawchive.pw file URLs are allowed');
            return;
        }
        try {
            const upstream = await request(target);
            if (upstream.status < 200 || upstream.status >= 300) {
                upstream.body?.resume?.();
                res.statusCode = 502;
                res.setHeader('content-type', 'text/plain; charset=utf-8');
                res.end(`Upstream HTTP ${upstream.status}`);
                return;
            }
            res.statusCode = 200;
            res.setHeader('content-type', upstream.contentType);
            if (upstream.contentLength > 0) res.setHeader('content-length', String(upstream.contentLength));
            if (upstream.contentDisposition) res.setHeader('content-disposition', upstream.contentDisposition);
            upstream.body.on('error', () => res.destroy());
            req.on?.('close', () => upstream.body.destroy?.());
            upstream.body.pipe(res);
        } catch (error) {
            res.statusCode = 502;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`Fetch failed: ${error?.message ?? error}`);
        }
    };
}
