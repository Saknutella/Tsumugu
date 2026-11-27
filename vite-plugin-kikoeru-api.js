// 开发环境 Kikoeru API 同源代理。
//
// asmr.one 的 API CORS 只放行 https://www.asmr.one,直接 fetch 会被浏览器拦;
// 自建 Kikoeru 也常因同源策略需要代理。这里只转发 GET /api/ JSON。
// 生产 Web 没有该端点;Tauri 走 native bridge。
//
// Node 的 fetch 对 api.asmr.one 会出现 TLS ECONNRESET(Cloudflare 指纹),
// 因此和 Tauri 侧一致改用 curl.exe;参数固定、只 GET,不当通用下载器。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const POWERSHELL_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$headers = @{
  'User-Agent' = $env:KIKOERU_UA
  'Accept' = 'application/json'
  'Origin' = 'https://www.asmr.one'
  'Referer' = 'https://www.asmr.one/'
}
(Invoke-WebRequest -Uri $env:KIKOERU_URL -UseBasicParsing -Headers $headers -TimeoutSec 30).Content
`;

const COVER_POWERSHELL_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$headers = @{
  'User-Agent' = $env:KIKOERU_UA
  'Accept' = 'image/jpeg,image/png,image/webp,*/*'
  'Origin' = 'https://www.asmr.one'
  'Referer' = 'https://www.asmr.one/'
}
$response = Invoke-WebRequest -Uri $env:KIKOERU_URL -UseBasicParsing -Headers $headers -TimeoutSec 30
[Convert]::ToBase64String([byte[]]$response.Content)
`;

async function fetchWithCurl(target) {
    const { stdout } = await execFileAsync(
        'curl',
        [
            '-L',
            '--fail',
            '--max-time',
            '30',
            '-sS',
            '-A',
            USER_AGENT,
            '-H',
            'Accept: application/json',
            target,
        ],
        { maxBuffer: 20 * 1024 * 1024, windowsHide: true },
    );
    return stdout;
}

async function fetchWithPowerShell(target) {
    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT],
        {
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, KIKOERU_URL: target, KIKOERU_UA: USER_AGENT },
        },
    );
    return stdout;
}


function isAllowed(target) {
    try {
        const url = new URL(target);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
        if (url.username || url.password) return false;
        if (!url.pathname.startsWith('/api/')) return false;
        if (/[\u0000-\u001f]/.test(target)) return false;
        return true;
    } catch {
        return false;
    }
}

function isCoverAllowed(target) {
    try {
        const url = new URL(target);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
        if (url.username || url.password) return false;
        if (!url.pathname.startsWith('/api/cover/')) return false;
        if (/[\u0000-\u001f]/.test(target)) return false;
        return true;
    } catch {
        return false;
    }
}

async function fetchCoverBuffer(target) {
    if (process.platform === 'win32') {
        const { stdout } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', COVER_POWERSHELL_SCRIPT],
            {
                maxBuffer: 20 * 1024 * 1024,
                windowsHide: true,
                env: { ...process.env, KIKOERU_URL: target, KIKOERU_UA: USER_AGENT },
            },
        );
        return Buffer.from(stdout.trim(), 'base64');
    }
    const response = await fetch(target, {
        headers: { 'user-agent': USER_AGENT, accept: 'image/jpeg,image/png,image/webp,*/*' },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

// 缓存随开发服务器释放;注入下载器和时钟使真实 middleware 可离线自检。
export function createCoverMiddleware({
    fetchCoverBuffer: download = fetchCoverBuffer,
    now = Date.now,
    ttlMs = 60 * 60 * 1000,
    maxEntries = 128,
    maxBytes = 32 * 1024 * 1024
} = {}) {
    const cache = new Map();
    const pending = new Map();
    let cacheBytes = 0;
    function remove(key) {
        const entry = cache.get(key);
        if (entry) cacheBytes -= entry.body.length;
        cache.delete(key);
    }
    async function load(target) {
        const time = now();
        for (const [key, entry] of cache) {
            if (entry.expiresAt <= time) remove(key);
        }
        const cached = cache.get(target);
        if (cached) {
            cache.delete(target);
            cache.set(target, cached);
            return cached;
        }
        if (pending.has(target)) return pending.get(target);
        const task = (async () => {
            const body = await download(target);
            let contentType;
            if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
                contentType = 'image/png';
            } else if (body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255) {
                contentType = 'image/jpeg';
            } else if (body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') {
                contentType = 'image/webp';
            } else {
                // 上游错误页即使返回 200 也不能缓存为图片。
                throw new Error('Unsupported cover image format');
            }
            const entry = {
                body,
                contentType,
                etag: `"${createHash('sha256').update(body).digest('hex')}"`,
                expiresAt: now() + ttlMs
            };
            if (maxEntries > 0 && body.length <= maxBytes && ttlMs > 0) {
                while (cache.size >= maxEntries || cacheBytes + body.length > maxBytes) {
                    remove(cache.keys().next().value);
                }
                cache.set(target, entry);
                cacheBytes += body.length;
            }
            return entry;
        })();
        pending.set(target, task);
        try {
            return await task;
        } finally {
            // 失败必须可重试,不能将 rejected Promise 留在合并表。
            pending.delete(target);
        }
    }
    return async (req, res) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const target = requestUrl.searchParams.get('url') ?? '';
        res.setHeader('cache-control', 'no-store');
        if (!isCoverAllowed(target)) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Only http(s) /api/cover/ URLs are allowed');
            return;
        }
        try {
            const entry = await load(target);
            const remainingSeconds = Math.max(0, Math.floor((entry.expiresAt - now()) / 1000));
            res.setHeader('cache-control', `public, max-age=${remainingSeconds}`);
            res.setHeader('etag', entry.etag);
            res.setHeader('content-type', entry.contentType);
            const condition = String(req.headers?.['if-none-match'] ?? '');
            if (condition.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === entry.etag)) {
                res.statusCode = 304;
                res.end();
                return;
            }
            res.statusCode = 200;
            res.setHeader('content-length', entry.body.length);
            res.end(entry.body);
        } catch (error) {
            res.statusCode = 502;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`Cover fetch failed: ${error?.message || error}`);
        }
    };
}

const TEXT_LIMIT = 2 * 1024 * 1024;
const DEFAULT_TEXT_PROXY = process.env.KIKO_TEXT_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';
// Runtime-configurable from Settings; the Vite middleware owns outbound text
// requests, so changing this variable is enough for the next VTT/SRT request.
let runtimeTextProxy = DEFAULT_TEXT_PROXY;
const TEXT_POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$request = [System.Net.HttpWebRequest]::Create($env:KIKOERU_URL)
$request.Method = 'GET'
$request.UserAgent = $env:KIKOERU_UA
$request.Accept = 'text/plain,*/*'
$request.Timeout = 30000
$request.ReadWriteTimeout = 30000
$request.Headers['Origin'] = 'https://www.asmr.one'
$request.Referer = 'https://www.asmr.one/'
# api.asmr.one 的 text stream 直连会被 Cloudflare 重置；开发环境与 DLSite 共用本机 mixed proxy。
if ($env:KIKOERU_PROXY) {
  $request.Proxy = [System.Net.WebProxy]::new($env:KIKOERU_PROXY)
  $request.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
}
$response = $request.GetResponse()
try {
  $limit = [int]$env:KIKOERU_TEXT_LIMIT
  if ($response.ContentLength -gt $limit) { throw 'Text file too large' }
  $stream = $response.GetResponseStream()
  $output = [System.IO.MemoryStream]::new()
  $buffer = [byte[]]::new(8192)
  try {
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($output.Length + $count -gt $limit) { throw 'Text file too large' }
      $output.Write($buffer, 0, $count)
    }
    @{ data = [Convert]::ToBase64String($output.ToArray()); contentType = $response.ContentType } | ConvertTo-Json -Compress
  } finally { $stream.Dispose(); $output.Dispose() }
} finally { $response.Dispose() }
`;

async function fetchTextWithCurl(target, maxBytes) {
    // The browser/download path works through the local mixed proxy, but
    // PowerShell's HttpWebRequest can fail on the same URL. curl is the most
    // predictable explicit-proxy transport on this machine.
    const proxy = runtimeTextProxy;
    const proxyArgs = proxy ? ['--proxy', proxy] : [];
    const { stdout } = await execFileAsync(
        'curl',
        [
            '-sS',
            '-L',
            '--max-time',
            '30',
            ...proxyArgs,
            '-A',
            USER_AGENT,
            '-H',
            'Accept: text/plain,*/*',
            '-H',
            'Origin: https://www.asmr.one',
            '-H',
            'Referer: https://www.asmr.one/',
            target,
        ],
        { encoding: 'buffer', maxBuffer: Math.ceil(maxBytes * 2) + 65536, timeout: 35000 },
    );
    if (!stdout || stdout.length === 0) throw new Error('empty curl text response');
    if (stdout.length > maxBytes) throw new Error('Text file too large');
    return { body: stdout, contentType: '' };
}

async function fetchTextDirect(target, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(target, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'user-agent': USER_AGENT, accept: 'text/plain,*/*' },
        });
        if (!response.ok) throw new Error(`Upstream text request failed: HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Text file too large');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > maxBytes) throw new Error('Text file too large');
            chunks.push(chunk);
        }
        return { body: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '' };
    } finally {
        clearTimeout(timer);
    }
}

async function downloadText(target, maxBytes) {
    if (process.platform === 'win32') {
        try {
            // Windows PowerShell 5.1 uses .NET's HTTP transport, already needed by the existing API proxy.
            // Read bytes before decoding, otherwise Japanese legacy encodings are lost in stdout.
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TEXT_POWERSHELL_SCRIPT], {
                maxBuffer: Math.ceil(maxBytes * 4 / 3) + 65536,
                timeout: 35000,
                windowsHide: true,
                env: {
                    ...process.env,
                    KIKOERU_URL: target,
                    KIKOERU_UA: USER_AGENT,
                    KIKOERU_TEXT_LIMIT: String(maxBytes),
                    KIKOERU_PROXY: runtimeTextProxy,
                }
            });
            const result = JSON.parse(stdout.trim());
            return { body: Buffer.from(result.data, 'base64'), contentType: result.contentType || '' };
        } catch (error) {
            // The mixed proxy can be up while the media CDN rejects it. The download
            // button works through a direct browser request, so try a direct server
            // fetch before surfacing a 502 to the viewer.
            console.warn('Kikoeru text PowerShell failed; trying curl through the mixed proxy:', error?.message || error);
            try {
                return await fetchTextWithCurl(target, maxBytes);
            } catch (curlError) {
                console.warn('Kikoeru text curl/proxy failed; trying direct fetch:', curlError?.message || curlError);
                return await fetchTextDirect(target, maxBytes);
            }
        }
    }
    return await fetchTextDirect(target, maxBytes);
}

export function createTextMiddleware({ download = downloadText, maxBytes = TEXT_LIMIT } = {}) {
    return async (req, res) => {
        res.setHeader('cache-control', 'no-store');
        if (req.method && req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
        const target = new URL(req.url || '/', 'http://localhost').searchParams.get('url') || '';
        let allowed = false;
        try {
            const parsed = new URL(target);
            allowed = ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password &&
                /^\/(?:api\/)?media\/stream\//.test(parsed.pathname) && !/[\u0000-\u001f]/.test(target);
        } catch { /* Invalid metadata is not a general-purpose proxy target. */ }
        if (!allowed) { res.statusCode = 400; res.end('Only Kikoeru media stream URLs are allowed'); return; }
        try {
            const { body, contentType } = await download(target, maxBytes);
            if (body.length > maxBytes) { res.statusCode = 413; res.end('Text file too large'); return; }
            const charset = /charset\s*=\s*["']?([a-z0-9_-]{1,40})/i.exec(contentType)?.[1];
            res.setHeader('content-type', `text/plain${charset ? `; charset=${charset}` : ''}`);
            res.setHeader('x-content-type-options', 'nosniff');
            res.setHeader('content-length', body.length);
            res.statusCode = 200;
            res.end(body);
        } catch {
            res.statusCode = 502;
            res.end('Text preview could not be loaded');
        }
    };
}

const DLSITE_PROXY = process.env.DLSITE_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';
const DLSITE_CACHE_TTL = 60 * 60 * 1000;
const dlsiteCache = new Map();

const DLSITE_QUERY_TO_COOKIE = {
    ja_JP: 'ja-jp',
    zh_TW: 'zh-tw',
    zh_CN: 'zh-cn',
};

function isAllowedDlsiteUrl(value) {
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.hostname !== 'www.dlsite.com' ||
            !/^\/maniax\/work\/=\/product_id\/RJ\d{5,8}\.html$/i.test(url.pathname) ||
            url.username ||
            url.password
        ) {
            return false;
        }
        const keys = [...url.searchParams.keys()];
        if (keys.length === 0) return true;
        if (keys.length !== 1 || keys[0] !== 'locale') return false;
        return Boolean(DLSITE_QUERY_TO_COOKIE[url.searchParams.get('locale')]);
    } catch {
        return false;
    }
}

async function fetchDlsiteWithCurl(target) {
    // Mixed proxy on 7897 is the local-only route; never turn this into an open proxy.
    const queryLocale = new URL(target).searchParams.get('locale');
    const cookieLocale = DLSITE_QUERY_TO_COOKIE[queryLocale] || '';
    const cookieArgs = cookieLocale ? ['-H', `Cookie: locale=${cookieLocale}`] : [];
    const { stdout } = await execFileAsync(
        'curl',
        ['-sS', '-L', '--max-time', '30', '--proxy', DLSITE_PROXY, '-A', USER_AGENT, '-H', 'Accept: text/html', ...cookieArgs, target],
        { maxBuffer: 5 * 1024 * 1024 },
    );
    if (!stdout || stdout.length < 32) throw new Error('empty DLsite response');
    return stdout;
}

export function createDlsiteMiddleware({ download = fetchDlsiteWithCurl } = {}) {
    return async (req, res) => {
        res.setHeader('cache-control', 'no-store');
        if (req.method && req.method !== 'GET') {
            res.statusCode = 405;
            res.end('GET only');
            return;
        }
        const target = new URL(req.url || '/', 'http://localhost').searchParams.get('url') || '';
        if (!isAllowedDlsiteUrl(target)) {
            res.statusCode = 400;
            res.end('Only DLsite work product URLs are allowed');
            return;
        }
        const cached = dlsiteCache.get(target);
        if (cached && Date.now() - cached.at < DLSITE_CACHE_TTL) {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(cached.html);
            return;
        }
        try {
            const html = await download(target);
            dlsiteCache.set(target, { at: Date.now(), html });
            res.statusCode = 200;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(html);
        } catch (error) {
            res.statusCode = 502;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(String(error?.message || error));
        }
    };
}

export default function kikoeruApiProxyPlugin(options = {}) {
    return {
        name: 'kikoeru-api-proxy',
        configureServer(server) {
            server.middlewares.use('/__kikoeru_api', async (req, res) => {
                const requestUrl = new URL(req.url ?? '/', 'http://localhost');
                const target = requestUrl.searchParams.get('url') ?? '';
                res.setHeader('cache-control', 'no-store');
                if (!isAllowed(target)) {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end('Only http(s) /api/ URLs are allowed');
                    return;
                }
                try {
                    let stdout;
                    try {
                        stdout = await fetchWithCurl(target);
                    } catch (curlError) {
                        // asmr.one 的 Cloudflare 会重置 curl/Node 的 TLS 握手;
                        // Windows 上用 PowerShell/.NET 的 HTTP 客户端作为回退。
                        if (process.platform !== 'win32') throw curlError;
                        stdout = await fetchWithPowerShell(target);
                    }
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.end(stdout);
                } catch (error) {
                    res.statusCode = 502;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.end(
                        JSON.stringify({
                            error: String(error?.stderr || error?.message || error),
                        }),
                    );
                }
            });

            // 封面同源代理:播放器会给封面图加 crossorigin=anonymous,
            // 而 api.asmr.one 的 CORS 只放行 asmr.one;不代理会变成破图。
            server.middlewares.use('/__kikoeru_cover', createCoverMiddleware(options));
            server.middlewares.use('/__kikoeru_text', createTextMiddleware(options.text));
            // Runtime proxy override from Settings. The browser cannot choose a
            // proxy per fetch, so the dev server stores it for the next request.
            server.middlewares.use('/__kikoeru_proxy', async (req, res) => {
                res.setHeader('cache-control', 'no-store');
                res.setHeader('content-type', 'application/json; charset=utf-8');
                if (!req.method || req.method === 'GET') {
                    res.statusCode = 200;
                    res.end(JSON.stringify({ proxy: runtimeTextProxy }));
                    return;
                }
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end(JSON.stringify({ error: 'POST only' }));
                    return;
                }
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 4096) {
                        res.statusCode = 413;
                        res.end(JSON.stringify({ error: 'body too large' }));
                        return;
                    }
                    chunks.push(chunk);
                }
                let value = '';
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                    value = body?.proxy == null ? '' : String(body.proxy).trim();
                } catch {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'invalid JSON' }));
                    return;
                }
                if (value) {
                    try {
                        const proxy = new URL(value);
                        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol)) throw new Error('scheme');
                        value = proxy.href.replace(/\/+$/, '');
                    } catch {
                        res.statusCode = 400;
                        res.end(JSON.stringify({ error: 'invalid proxy URL' }));
                        return;
                    }
                }
                runtimeTextProxy = value;
                res.statusCode = 200;
                res.end(JSON.stringify({ proxy: runtimeTextProxy }));
            });

            server.middlewares.use('/__dlsite_fetch', createDlsiteMiddleware());
        },
    };
}
