import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import authGatePlugin from './vite-plugin-auth-gate.js';
import blobAssetPlugin from './vite-plugin-blob.js';
import svgUse from './vite-plugin-svg-use.js';
import uploadPlugin from './vite-plugin-upload.js';
import creationPreviewFetchPlugin from './vite-plugin-creation-preview.js';
import kikoeruApiProxyPlugin from './vite-plugin-kikoeru-api.js';
import youtubeMetaPlugin from './vite-plugin-youtube-meta.js';
import { playwright } from '@vitest/browser-playwright';
import { execSync } from 'child_process';
import { createWatchIgnore } from './watch-roots.mjs';

function proxyAudioPlugin() {
    return {
        name: 'proxy-audio-dev',
        configureServer(server) {
            // No longer needed: local proxy-audio middleware replaced by remote proxy
        },
    };
}

function getGitCommitHash() {
    try {
        return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

/**
 * 让 watcher 的 error 事件永远不会掀掉进程。
 *
 * chokidar 打到被占用的文件时 `emit('error', EBUSY)`;EventEmitter 上没有 `error`
 * 监听器时 Node 会直接抛,整个 dev server 退出 —— 上传/下载写到被监听目录时必现。
 */
function watchErrorGuard() {
    return {
        name: 'watch-error-guard',
        configureServer(server: { watcher: NodeJS.EventEmitter; config: { logger: { warn: (msg: string) => void } } }) {
            server.watcher.on('error', (error: NodeJS.ErrnoException) => {
                server.config.logger.warn(
                    `[watch] 忽略一次文件监听错误(${error?.code || error?.message});dev server 继续运行`,
                );
            });
        },
    };
}

export default defineConfig(({ mode }) => {
    const commitHash = getGitCommitHash();
    const isDev = mode === 'development';

    return {
        test: {
            // https://vitest.dev/guide/browser/
            browser: {
                enabled: true,
                provider: playwright({
                    launchOptions: {
                        args: ['--disable-web-security'],
                        // Workspace policy prefers the shared Chromium; allow CI/dev
                        // to point the test runner at that binary explicitly.
                        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
                            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
                            : {}),
                    },
                }),
                headless: !!process.env.HEADLESS,
                instances: [{ browser: 'chromium' }],
            },
        },
        base: './',
        define: {
            __COMMIT_HASH__: JSON.stringify(commitHash),
            __VITEST__: !!process.env.VITEST,
            'process.env.CI': JSON.stringify(process.env.CI ?? ''),
        },
        worker: {
            format: 'es',
        },
        resolve: {
            alias: {
                '!lucide': '/node_modules/lucide-static/icons',
                '!simpleicons': '/node_modules/simple-icons/icons',
                '!': '/node_modules',

                events: '/node_modules/events/events.js',
                pocketbase: '/node_modules/pocketbase/dist/pocketbase.es.js',
                stream: path.resolve(__dirname, 'stream-stub.js'), // Stub for stream module
            },
        },
        optimizeDeps: {
            exclude: ['pocketbase', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
            include: ['workbox-window', '@sentry/browser', '@capacitor/haptics', 'fuse.js'],
        },
        server: {
            // Dev bridge to the bundled file-library host (`scripts/dev-web.mjs`).
            // `connectWebBackend()` already probes `/storage` as a candidate, so a
            // same-origin proxy is enough — and unlike a `?storage=` query string it
            // survives a page reload, which HMR does constantly.
            ...(process.env.MONOCHROME_DEV_STORAGE_TARGET
                ? {
                      proxy: {
                          '/storage': {
                              target: process.env.MONOCHROME_DEV_STORAGE_TARGET,
                              changeOrigin: true,
                              rewrite: (p: string) => p.replace(/^\/storage/, ''),
                          },
                      },
                  }
                : {}),
            fs: {
                allow: ['.', 'node_modules'],
                // host: true,
                // allowedHosts: ['<your_tailscale_hostname>'], // e.g. pi5.tailf5f622.ts.net
            },
            watch: {
                // 只监听浏览器源码(见 watch-roots.mjs)。以前是黑名单:数据目录、后端源码
                // 都在监听范围内,而 dev loop 上传正是往 `data/` 里写 —— Windows 上
                // 文件被占用时 chokidar 抛 EBUSY,把整个 dev server 打挂。
                ignored: [
                    createWatchIgnore(__dirname),
                    '**/.*.tmpdir/**',
                    '**/*.tmpdir/**',
                    '**/.cache/**',
                    '**/artifacts/**',
                ],
            },
        },
        // preview: {
        //     host: true,
        //     allowedHosts: ['<your_tailscale_hostname>'], // e.g. pi5.tailf5f622.ts.net
        // },
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            sourcemap: false,
            minify: 'esbuild',
            reportCompressedSize: false,
            rollupOptions: {
                treeshake: true,
            },
        },
        plugins: [
            proxyAudioPlugin(),
            watchErrorGuard(),
            authGatePlugin(),
            uploadPlugin(),
            blobAssetPlugin(),
            svgUse(),
            creationPreviewFetchPlugin(),
            kikoeruApiProxyPlugin(),
            youtubeMetaPlugin(),
            VitePWA({
                registerType: 'prompt',
                devOptions: {
                    enabled: true,
                    type: 'classic',
                    disableRuntimeConfig: true,
                    suppressWarnings: true,
                },
                workbox: {
                    skipWaiting: true,
                    clientsClaim: true,
                    globPatterns: ['index.html', 'manifest.json'],
                    cleanupOutdatedCaches: true,
                    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB limit
                    // Define runtime caching strategies
                    runtimeCaching: [
                        {
                            urlPattern: ({ request }) =>
                                request.destination === 'script' || request.destination === 'worker',
                            handler: isDev ? 'NetworkFirst' : 'CacheFirst',
                            options: {
                                cacheName: 'scripts',
                                expiration: {
                                    maxEntries: 200,
                                    maxAgeSeconds: 60 * 24 * 60 * 60,
                                },
                            },
                        },
                        {
                            urlPattern: ({ request }) =>
                                request.destination === 'style' || request.destination === 'font',
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'static-resources',
                                expiration: {
                                    maxEntries: 60,
                                    maxAgeSeconds: 60 * 24 * 60 * 60,
                                },
                            },
                        },
                        {
                            urlPattern: ({ request }) => request.destination === 'image',
                            handler: 'StaleWhileRevalidate',
                            options: {
                                cacheName: 'images',
                                expiration: {
                                    maxEntries: 500,
                                    maxAgeSeconds: 30 * 24 * 60 * 60, // 30 Days
                                },
                            },
                        },
                        {
                            urlPattern: ({ request }) =>
                                request.destination === 'audio' || request.destination === 'video',
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'media',
                                expiration: {
                                    maxEntries: 50,
                                    maxAgeSeconds: 60 * 24 * 60 * 60, // 60 Days
                                },
                                rangeRequests: true, // Support scrubbing
                            },
                        },
                    ],
                },
                includeAssets: ['discord.html'],
                manifest: false, // Use existing public/manifest.json
            }),
        ],
    };
});
