// 开发环境 YouTube 元数据代理。
//
// YouTube watch 页面没有可用的 CORS;服务端抓页并提取:
// 标题、频道/频道头像、发布时间、时长、观看数、tags、简介、缩略图、嵌入地址。
// 只允许 youtube.com / youtu.be 的视频 URL,不做任意 URL 代理。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const YOUTUBE_PROXY = process.env.YOUTUBE_PROXY || 'http://127.0.0.1:7897';

function youtubeVideoId(input) {
    try {
        const url = new URL(String(input ?? '').trim());
        const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
        let id = '';
        if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
        else if (host === 'youtube.com' || host === 'music.youtube.com') {
            if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
            else if (url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2] || '';
            else if (url.pathname.startsWith('/embed/')) id = url.pathname.split('/')[2] || '';
        }
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
    } catch {
        return '';
    }
}

function extractObject(source, marker) {
    const index = source.indexOf(marker);
    if (index < 0) return null;
    const start = source.indexOf('{', index + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = start; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(source.slice(start, cursor + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

async function runPowerShell(url, proxy = '') {
    const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$headers = @{
  'User-Agent' = $env:YOUTUBE_UA
  'Accept' = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  'Accept-Language' = 'en-US,en;q=0.9'
}
$requestArgs = @{ Uri = $env:YOUTUBE_URL; UseBasicParsing = $true; Headers = $headers; TimeoutSec = 45 }
if ($env:YOUTUBE_PROXY) { $requestArgs.Proxy = $env:YOUTUBE_PROXY }
(Invoke-WebRequest @requestArgs).Content
`;
    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
            maxBuffer: 40 * 1024 * 1024,
            windowsHide: true,
            env: {
                ...process.env,
                YOUTUBE_URL: url,
                YOUTUBE_UA: USER_AGENT,
                YOUTUBE_PROXY: proxy,
            },
        },
    );
    return stdout;
}

async function fetchPage(url) {
    if (process.platform === 'win32') {
        try {
            return await runPowerShell(url, '');
        } catch {
            return runPowerShell(url, YOUTUBE_PROXY);
        }
    }
    const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

function largestThumbnail(thumbnails, fallback = '') {
    const list = thumbnails || [];
    return list.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || fallback;
}

async function fetchChannelAvatar(channelId) {
    if (!channelId) return '';
    try {
        const html = await fetchPage(`https://www.youtube.com/channel/${channelId}`);
        const match = html.match(/https:\/\/yt3\.googleusercontent\.com\/[^"'\\\s]+/);
        if (!match) return '';
        return match[0].replace(/=s\d+[^/]*$/, '=s176-c-k-c0x00ffffff-no-rj');
    } catch {
        return '';
    }
}

async function fetchYoutubeMetadata(videoId) {
    const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const html = await fetchPage(sourceUrl);
    const player = extractObject(html, 'ytInitialPlayerResponse =');
    const details = player?.videoDetails;
    if (!details?.videoId) throw new Error('YouTube player response unavailable');
    const micro = player?.microformat?.playerMicroformatRenderer || {};
    const channelId = details.channelId || '';
    const channelAvatar = await fetchChannelAvatar(channelId);
    return {
        videoId,
        title: details.title || '',
        channel: details.author || micro.ownerChannelName || '',
        channelId,
        channelAvatar,
        channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : '',
        publishDate: micro.publishDate || micro.uploadDate || '',
        duration: Number(details.lengthSeconds) || 0,
        viewCount: Number(details.viewCount) || 0,
        tags: Array.isArray(details.keywords) ? details.keywords : [],
        description: details.shortDescription || '',
        thumbnail:
            `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` ||
            largestThumbnail(details.thumbnail?.thumbnails),
        sourceUrl,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
    };
}

export default function youtubeMetaPlugin() {
    return {
        name: 'youtube-meta',
        configureServer(server) {
            server.middlewares.use('/__youtube_meta', async (req, res) => {
                const requestUrl = new URL(req.url ?? '/', 'http://localhost');
                const target = requestUrl.searchParams.get('url') ?? '';
                const videoId = youtubeVideoId(target);
                res.setHeader('cache-control', 'no-store');
                if (!videoId) {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end('Only YouTube video URLs are allowed');
                    return;
                }
                try {
                    const metadata = await fetchYoutubeMetadata(videoId);
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify(metadata));
                } catch (error) {
                    res.statusCode = 502;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ error: String(error?.message || error) }));
                }
            });
        },
    };
}
