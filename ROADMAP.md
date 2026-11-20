# ROADMAP — Monochrome(二开)

## 现状(2026-10-26 本机实测)

| 项 | 结果 |
| --- | --- |
| 上游基线 | `monochrome-music/monochrome` @ `cedea44`(2026-10-22),Apache-2.0 |
| 依赖安装 | `npm install` 成功(978 个包);后续新增 `i18next`(2026-10-26) |
| 生产构建 | `npm run build` 成功;`dist/` 134 个产物;PWA `dist/sw.js` 已生成 |
| dev 预览 | `npm run dev` 启动,`http://localhost:5173/` 返回 200,标题 `Monochrome` |
| 工作区契约 | 清单/简介/`verify/` 已接入;`node verify/check.mjs` 47 条断言全过 |
| 真实浏览器证据 | `node verify/render.mjs` 通过 18 条断言(含默认无统计请求、默认英文 i18n、字体栈、web 模式 SW) |
| 多语言(i18n) | i18next + 源文本词典(930 条);核心壳、设置页、菜单/弹窗/关于页等静态文案已中文化;`verify/i18n-probe.mjs` 21 条断言;中文默认字体微软雅黑 |
| 创作页 | 侧栏「创作」→ `/creations`;本地示例帖子流/详情(封面/画廊/音频/视频/正文/附件),图片可放大、`description.md` 简介、音频名+description 音频简介、标签多选、文本附件动态下拉、简介显示开关、艺人页、播放时简介侧栏(可加宽/收起/重开)、原生搜索本地创作、音频/视频进原播放器、Pawchive URL 预览导入、附件多选下载/删除与 IndexedDB 本地存储、卡片/详情作者头像与作者筛选;`verify/creations-probe.mjs` 74 条断言 |
| 音声页 | 侧栏「音声」→ `/voices`;导入 asmr.one 或同 Kikoeru 后端的作品 URL;RJ 号/上市时间/社团/声优/标签/评分/售价/总时长/DLsite、4:3 封面角标、递归文件树、单条/全部播放、声优+社团 facet 筛选;`verify/voices-probe.mjs` 14 条断言 |
| 视频页 | 侧栏「视频」→ `/videos`;导入 YouTube URL;标题/频道/头像/发布时间/时长/播放量/标签/简介/缩略图、点击后加载官方嵌入;`verify/videos-probe.mjs` 22 条断言；列表已按音声/创作库重构成统一头部、工具栏搜索/排序/portal 筛选、宽度条与 16:9 卡片 |
| 隐私默认值 | Sentry / Plausible **默认关闭**;`verify/analytics-probe.mjs` 证明开关有效 |
| 上游同步 | remote 已切为 `upstream`;`scripts/upstream-sync.ps1` 默认只 fetch + 报告(实测退出码 0) |
| 本地 Rust | `tools/rust/`(standalone 1.99.1,625.9 MB,不写系统 PATH);`cargo build` hello 实测通过 |
| Tauri 原型 | 2026-10-27 首次真实编译/启动:342 个 crate,Tauri 2.12.5 + WebView2 155;Monochrome 壳与外部复杂 HTML 均在 WebView2 渲染通过(`tauri-app.png`);创作页原生桥(dialog 插件 + 3 命令)已编译并在真实 Tauri 里验证 IPC/UI;播放/打包未验证 |
| 桌面壳适配 | `isTauri` 识别桌面壳并按 native shell 关闭 PWA/SW;`verify/desktop-probe.mjs` 3 条断言通过(真实 WebView2 未验证) |
| API Origin 实测 | Chromium 下 `127.0.0.1` 与 `tauri.localhost` origin 请求官方 API:search **200**、音频 **206 + FLAC**,SW 可注册;真实 WebView2 待复测 |
| 端到端播放 | dev server 下真实 `MusicAPI`/`Player` 播放官方 FLAC,`readyState=3`、`currentTime≈1.02s`(证据 `playback.png`) |

## 里程碑

### M0 基线(进行中)

- [x] 完整克隆(保留历史),remote 已切为 `upstream`(官方仓库)
- [x] `scripts/upstream-sync.ps1`:fetch + 落后/领先提交 + 改动范围报告(默认不改文件)
- [x] `npm install` / `npm run build` 跑通
- [x] 工作区契约文件(project.json / INTRO / AGENTS / ROADMAP / docs / verify / evidence)
- [x] `npm run dev` 本机预览 + 真实浏览器截图证据
- [x] 破坏性验证:`commands.test` 在关键文件被破坏后确实变红(记录到 docs/02-testing.md)
- [ ] 添加自己的 fork 为 `origin` 并推送 `main`(需要 fork URL 与 git 身份,流程见 docs/03-upstream-sync.md)

### M1 品牌与界面定制

- 品牌字符串、标题、meta、manifest、图标替换;默认主题色/排版按自己的审美调整
- 主题系统沿用上游(见 docs/05-customization.md),不做破坏性重写
- 验收:1440px/390px 真实截图各一张,品牌字符串替换清单可核对

### M1.5 多语言(i18n)

- [x] 英文默认回退 + 简体中文;核心壳(侧栏/顶栏/首页 tabs/播放器条/设置 tabs)已翻译
- [x] 设置 → Interface → Language 可运行时切换并持久化;`verify/i18n-probe.mjs` 覆盖首屏与切换
- [x] 中文默认字体为微软雅黑(通过字体 fallback 链,Inter 继续负责拉丁字符)
- [x] 第二批(2026-10-26):源文本词典 930 条,设置页/菜单/弹窗/关于页等静态文案已覆盖
- [ ] 第三批:library/search/album/track 等**数据渲染文本**、通知/toast、命令面板动态结果、全屏播放器
- 验收:中英文都能完整走一遍核心操作,截图与 `i18n-meta.json` 留证(见 docs/07-i18n.md)

### M2 精简 / 去功能

- 候选:账号与云同步、Sentry/统计、听歌派对、播客、社区主题、未发布音乐等
- 原则:先关入口与请求,再删代码;一轮只删一个模块,删完跑 `verify/kind.mjs` + 真实渲染
- 验收:被删功能无残留请求、无死链;保留功能可用
- [x] 第一步(2026-10-26):Sentry / Plausible 默认关闭,用户可在设置里显式开启;
  真实渲染新增「默认无统计请求」断言,`verify/analytics-probe.mjs` 验证断言非空

> **注意**:是否继续移除具体功能由用户决定;在明确指定模块之前不动任何"减法"。

### M2.5 创作页(Patreon 式帖子)

- [x] 2026-11-03:创作主页改为作品库，导入/管理收纳、来源/搜索/排序、手机双列和媒体分类色；
  按来源显示本地导入时间/网页发布时间，历史缺失导入日显示未知，见 [主页交接](docs/handoff/32-creations-library-layout-2026-11-03-codex.md)。
- [x] 侧栏「创作」+ 本地示例帖子流/详情:封面、画廊、正文描述、音频、可下载附件;
- [x] 图片点击放大灯箱;文本附件(.md/.txt/.json)动态下拉懒加载;音频整行可点击;
- [x] `description.md` 作为简介渲染(Markdown + 白名单 HTML 花活),同时保留在附件列表;
- [x] 音频简介文件按「音频名+description」命名,播放时优先显示音频专属简介;
- [x] 文件列表「显示简介」开关(控制简介行显示,记忆到 localStorage);
- [x] 标签多选筛选;播放创作音频时侧栏自动展示简介;播放器 actions 行有「简介」按钮;
- [x] 播放器侧栏可加宽/收起,收起后右侧浮标可重新打开并恢复上次内容;
- [x] 创作者进入艺人页(头像/简介/作品/播放全部/在 Monochrome 中搜索),track 带 artists 元数据进原播放器;
- [x] 音频附件 → Monochrome 原播放器(`Player.setQueue` / `playTrackFromQueue`),探针验证真的在播放;
- [x] i18n(中/英)与路由 `/creations`、`/creations/:id`、`/creations/artist/:id`;
- [x] 视频附件(A+B):详情内嵌 `<video>`;「在播放器中播放」进 Monochrome 全屏视频层,
  播放/seek/MediaSession/切歌复用原播放器;视频全屏时侧栏不遮挡;
- [x] 导入持久化 + 单条/多选/全部清空删除;导入卡右上角复选框 + 批量操作条;
- [x] Pawchive 附件:有 href 的 post__attachment-link 导入为文件/压缩包;逐文件下载进度、多选/全部下载到 IndexedDB;
  下载完成后链接切本地 Blob URL、删除本地回退源 URL;删除创作/重导可选保留/覆盖/删除本地文件，也可用导入选项开关批量处理;
- [x] Pawchive URL 预览导入:公开页面标题/作者/正文/链接/缩略图;未归档附件明确标记缺失;
- [x] 原生搜索页显示本地创作艺人/帖子(修复「创作艺人搜不到」);
- [ ] 接 Tauri 原生桥的拖拽/更多命令与真实数据源、分页/搜索、provider 视频队列/清晰度、权限与付费内容;
- 说明与数据形状见 [docs/09-creations.md](docs/09-creations.md)。

### M2.6 音声(asmr.one / Kikoeru)

- [x] 2026-11-03:行/目录/全选复选框、源序静默追加队列、所选流式下载；右下卡片可最小化重开，
  浅绿色总体进度持续更新，跨页继续、完成保入口，见 [交接 29](docs/handoff/29-voice-selection-download-2026-11-03-codex.md)。

- [x] 2026-11-03:筛选选项改为顶部按钮弹出的浮层，点击外部/Escape 关闭；只保留活动筛选条一个
  清除入口，面板不再重复，见 [筛选交接](docs/handoff/26-voice-filter-popup-2026-11-03-dsh.md)。
- [x] 2026-11-03:全部/文件夹下载改为流式写入选定目录，根目录 `[RJ号]-标题`，默认 4 文件并发、
  Range 重试续传，右下角状态窗；目录行三点菜单提供文件夹下载，ZIP 仅作不支持 API 的回退。
  见 [流式下载交接](docs/handoff/24-voice-stream-download-2026-11-03-dsh.md)。
- [x] 2026-11-03:详情页统一模板已生效，旧作品与新导入共用 `/album/voice-<id>`；DSH 的视觉、
  下载和原生播放改动已并入，工具/范围见 [DSH 同步交接](docs/handoff/23-voice-template-sync-2026-11-03-dsh.md)。
- [x] 2026-11-03:音声主页以作品库为主，导入收纳、库内搜索/排序、管理与无匹配状态；
  标签分类色保留、年龄移封面左下，选择只作用当前结果，见 [主页交接](docs/handoff/31-voices-library-layout-2026-11-03-codex.md)。
- [ ] 顶部全局搜索与音声库搜索的最终范围提示/全局音声整合待用户确定。
- [x] 2026-11-03:音声图片灯箱支持滚轮缩放/左键拖拽并保留单击放大；文本可切原文/Markdown，
  与创作共用零依赖渲染器；视频原生播放、PDF 内置阅读器及备用入口，类型识别避免附件误入队列。
  实测与限制见 [灯箱交接](docs/handoff/30-voice-viewer-upgrade-2026-11-03-codex.md)。
- [x] 2026-11-03:附件行与音轨委托隔离后，恢复完整 row 悬停/按下动效，外层固定命中并裁剪滚动溢出；
  保留选中/播放底色。当前实现与验证见 [行动效交接](docs/handoff/27-voice-row-motion-2026-11-03-codex.md)。
  图片灯箱/TXT 阅读弹窗已接入整行点击与键盘打开，见 [附件实现](docs/handoff/21-voice-interactions-2026-11-03-codex.md)。
- [x] 2026-11-03:通用封面按钮主题由设置唯一总体开关控制，音声详情没有开关；
  背景恢复上游淡雅照片滤镜，移除额外渐变。每张封面按颜色簇占比独立取色，
  创作详情可按需接入，见 [当前交接](docs/handoff/19-cover-theme-global-2026-11-03-codex.md)。
- [x] 2026-11-02:按 RJ01605254 统一音声模板标题排版，旧作品与新导入自动采用，
  真实导入/旧链接/刷新及多尺寸模板回归 20 项通过，见 [模板交接](docs/handoff/17-voice-template-2026-11-02-codex.md)。
- [x] 2026-11-02:接入原生专辑页并保留层级文件列表、4:3 封面、社团/声优更多作品与 ZIP;
  修复音声间/普通专辑间的旧事件与 DOM 残留、懒加载图片阻塞播放器、菜单下载误入在线源。
  新增合成音频解码/时间前进与 ZIP 字节验证,详见 [交接记录](docs/handoff/15-voices-handoff-2026-11-02-codex.md)。
- [x] 2026-11-02:封面代理有界 LRU/并发合并/ETag、同源取色缓存与失败重试；
  真实 RJ01605254 封面代理首次约 1.25s、缓存约 2ms。音声 23 条、导航 18 条通过，
  背景解码/取色/原生滤镜已验证，见 [性能交接](docs/handoff/16-cover-performance-2026-11-02-codex.md)。

- [x] 侧栏「音声」→ `/voices`、`/voices/:id`;与「创作」平级;
- [x] 解析 asmr.one 与同源 Kikoeru:search → work → tracks,支持裸 RJ 号;
- [x] 元数据:RJ 号、上市时间、社团、声优、标签、评分/人数、售价、总时长、DLsite 原页面、封面;
- [x] 封面左上/右下角标、社团在声优上方;声优/社团可点击筛选(同 facet OR、跨 facet AND);
- [x] 文件数/标签数从文件树与 tags 实时重算,避免旧缓存;文件树递归;
- [x] 递归文件树(folder/audio/text/image/other),单文件播放/下载、播放全部、文件数;
- [x] 4:3 封面比例;localStorage 持久化;开发代理 `/__kikoeru_api`;
- [x] `verify/voices-probe.mjs` 14 条断言;真实 asmr.one `RJ01704024` 手动验证(28 音频/4 文件夹);
- [ ] Tauri 原生 `fetch_kikoeru_json` 的真实 WebView2 验证;asmr.one 在 curl 下的 TLS 重置待处理。

### M2.7 视频(YouTube)

- [x] 侧栏「视频」→ `/videos`、`/videos/:id`;
- [x] 抓取标题、频道/头像、发布时间、时长、播放量、标签、简介、缩略图、原链接、嵌入地址;
- [x] 点击封面后加载 YouTube 官方 iframe;16:9 卡片/详情布局;
- [x] 开发代理 `/__youtube_meta`(Windows PowerShell;可选 `YOUTUBE_PROXY`,默认 `127.0.0.1:7897`);
- [x] `verify/videos-probe.mjs` 22 条断言;真实示例 `i8Agj2jugbQ` 手动验证;
- [ ] Tauri 原生 YouTube 抓取;会员/年龄限制/登录内容与下载未做。

### M3 数据源 / 自托管

- 先摸清官方 API 的域名限制与 dev mode 自定义 endpoint 机制(见 docs/04-architecture.md §4.3)
- 备选:自建 HiFi API 端点;或把播放降级为本地音乐库/自己的曲库(与「换数据源」二选一)
- 验收:localhost 下真实播放成功;非官方域名下的限制写清楚

### M4 Tauri 沉浸式桌面播放器

- 目标:轻量桌面壳,加载构建产物,支持全屏 now-playing、歌词、可视化、全局媒体键
- 原型骨架已放在 `.scratch/tauri-proto/`(一次性验证用,不属于本仓库):2026-10-27 首次真实编译/
  启动通过(Tauri 2.12.5 + WebView2 155);2026-10-28 `tauri build --no-bundle` 通过(20.6 MB exe),
  NSIS 安装包 13.72 MiB;安装/卸载与签名未实测
- [x] 桌面端适配第一步(2026-10-26):`isTauri` 识别桌面壳,关闭 PWA/SW;
  `verify/desktop-probe.mjs` 验证分支生效,`render.mjs` 同时验证 web 模式 SW 仍注册
- [x] Tauri 能力测试页(2026-10-26):侧栏「Tauri 测试」→ `/tauri-test`,自动检测渲染/Canvas/
  WebGL/字体/音频/存储/网络/WASM/Tauri API/SW;`verify/tauri-test-probe.mjs` 12 条断言,
  证据 `tauri-test-zh.png` / `tauri-test-tauri-sim.png`
- [x] 创作页原生桥(2026-10-27):`tauri-plugin-dialog` + `pick_creation_json` / `save_creation_file` /
  `reveal_creation_file`;真实 Tauri 里验证 IPC/「导入本地创作」按钮、UI Automation 真点原生
  打开/另存为(视频 SHA256 一致),导入持久化 + 单条/批量删除;假 Tauri 探针 35 条断言;NSIS 安装包已生成;
  证据 `tauri-creations.png` / `tauri-bridge-meta.json`
- 下一步:在 Tauri 应用内打开 `/tauri-test`、搜索/播放链路与真实原生对话框,把 WebView2 的
  Origin/CORS/播放结果对照 §1.0 记录,再决定沉浸式 MVP 与是否打包
- 验收:Windows 上真实启动、真实出声、截图与版本信息留档

## 非目标

- 不把项目重写成 React/Vue/Flutter 前端;保持上游技术栈与可合并性
- 不绕过上游 API 的访问控制,也不分发受版权保护的音频
- 不追求账号系统自托管(上游明确不支持,见 README「Self-Hosting」)
- 不在本仓库内改工作区 `tools/`、`templates/`(它们的规则属于工作区根)

## 已知限制(截至 2026-10-26)

1. **官方 API 域名限制。** 上游 README 写明:自托管放到非官方域名后无法串流,只有 localhost
   可用。**2026-10-26 实测补充**:Chromium 里以 `127.0.0.1` / `tauri.localhost` 为 origin 时,
   search 返回 200、`/track/<id>` 返回 206 + FLAC 魔数(证据 `verify/evidence/api-origin-probe.txt`);
   但**自定义 https 域名**与**真实 WebView2** 未验证,不能据此推断"换域名一定能播"。
2. **账号系统不可自托管。** 上游使用 Better Auth(client)+ PocketBase(数据),并写明自托管/
   非官方域名不能串流;本项目保留账号入口但不承诺自托管可用。
3. **`npm install` 需要 `legacy-peer-deps`。** 上游用 `.npmrc` 提供;本 fork 把 `.npmrc` 当作
   本机配置(gitignore),新克隆按 docs/01-quickstart.md 生成,否则可能 ERESOLVE。
4. **`commands.test` 依赖已安装依赖。** 与模板「零依赖自检」不同:真实 Vite 项目必须先
   `npm install`;这是收养上游项目的已知差异,已在 docs/02-testing.md 说明。
5. **Windows 上 git 默认 autocrlf=true** 会把上游文本 checkout 成 CRLF;本仓库用
   `.gitattributes` + 本地 `core.autocrlf=false` 统一为 LF。换机器后先按 docs/01-quickstart.md 设置。
6. **上游无 `.gitattributes`**,同步上游新增文件后如出现 CRLF/缺尾换行,`verify/check.mjs` 会红,
   属于预期信号,修完再提交。
7. **Tauri 能渲染、能打包,但还没验证"官方 API 能播"。** 2026-10-27/28 已真实启动
   Tauri 2.12.5 + WebView2 155,Monochrome 静态壳、创作页与外部复杂 HTML 都渲染通过;
   `tauri build --no-bundle`(20.6 MB)与 NSIS 安装包(13.72 MiB)已生成;但 WebView2 里的
   官方 API Origin/CORS、音频输出仍未实测,不能从 Chromium 行为外推。
8. **`npm run hygiene` 仍红(exit 1)，2026-11-02 实测 16 项。** 早期 6 处上游公开凭据位于
   `functions/{album,artist,playlist,track}/[id].js`、`js/librefm.js`、`js/profile.js`；
   当前还包含 `Hentasy/monochrome/` 研究副本中的凭据与嵌套 `.git`、临时/缓存目录。
   原版凭据虽是上游公开客户端配置，卫生规则仍按内容拦截；研究副本与目录也需分别处理，
   不能仅接受公开凭据便视为放行。另有 4 条路径/视频产物 warning，尚未解决。
9. **`kind=web` 的模板期望文件 `app.mjs` 不存在**(本项目沿用上游 `js/app.js` 入口),
   `npm run check` 因此保留 1 条 warning;这是被收养项目的形状差异,不是错误。
10. **i18n 只覆盖核心壳。** 设置页 item 文案、各内容页正文、弹窗/通知/命令面板、全屏播放器
    仍是英文;语言切换不会重渲染已由 JS 生成的动态文本(接 `monochrome:language-changed`
    事件后可扩展)。详见 docs/07-i18n.md。
11. **音声依赖开发代理/桌面壳。** 生产 Web 没有 `/__kikoeru_api`;asmr.one 的 Cloudflare
    会重置 curl/Node TLS,Windows 开发代理回退到 PowerShell,真实 Tauri WebView2 未验证。
    需要登录的 Kikoeru 实例未做认证。
    封面缓存仅在开发服务内存中，重启后首次仍需上游请求；不能把本机耗时外推到生产或 Tauri。
    文本预览开发代理使用 Windows PowerShell 5.1/.NET 字节流（实测 5.1.26100.9711），
    上限 2 MiB；生产 Web/Tauri 跨域字节获取、Linux/macOS 未验证。
    多格式合并是保守启发式：标题/目录/时长不足时保留多份；菜单不转码，真实编码支持由运行时决定。
    视频预览不转码，浏览器编码支持不等于扩展名支持；PDF 优先用内置阅读器，真实源站与
    Tauri/WebView2 阅读器未验证。Markdown 为基础阅读子集，未实现完整 GFM/表格/数学公式。
12. **YouTube 原生与生产 Web 抓取未完成。** 开发代理 `/__youtube_meta` 依赖 Windows
    PowerShell;Tauri 的 `fetch_youtube_meta` 尚未实现。视频不下载,只嵌入;会员/年龄限制
    内容与 YouTube 改版后的解析未覆盖。详见 docs/12-voices-youtube.md。
13. **压缩包内文件浏览尚未实现。** 调研结论、推荐分层（ZIP/zip.js、7z-RAR/7z-wasm+sidecar）、分卷/密码/安全边界与未验证项见 [docs/13-archive-browser-research.md](docs/13-archive-browser-research.md)；本轮只调研，未改源码。
14. **当前音乐 API 源站不可达（2026-11-02 当次实测）。** 已有代理访问官网为 200，
    但 `tracks.monochrome.st/search?q=moss` 为 523；加客户端代理未恢复在线专辑，
    需等待源站或另行验证兼容数据源。原始结果见 `verify/evidence/network-api-diagnosis.json`。
15. **Rust storage host（分支 `refactor/rust-backend`，2026-11-15）只在 Windows 验证过。**
    Node host 的全部路由与 legacy 迁移已移植，差分 79 步 0 差异，但 Linux/macOS 连编译都没做过；
    Tauri 打包仍启动 Node host；封面/音声包外网下载、`/api/works/open`、创作附件上传只做了代码核对。
    默认后端仍是 Node（`start-web-fullstack.ps1 -Backend rust` 才切换）。详见
    [docs/18](docs/18-rust-backend.md) §6。

## 未验证(不要当结论用)

- 创作者页仅列本地已导入作品，资料由作品派生；删除最后一篇后不单独保留作者档案。
  历史 Pawchive 记录可能曾被写入默认 Patreon 地址，无法无损反推平台；不按同名跨平台合并。
  本轮原生 artist 接入及实测边界见 [交接 37](docs/handoff/37-creation-native-creator-2026-11-03-codex.md)。

- UI 点击播放/切歌/队列/EQ 等交互(程序化播放链路已由 `verify/playback-probe.mjs` 证明:
  `readyState=3`、`currentTime` 前进;但没在界面上点过)
- 自定义 https 域名下的串流(README 说的域名限制未在该场景实测;只测了 localhost 与 tauri.localhost)
- Docker 自托管(`docker compose up`)与 Tailscale/局域网访问
- 账号登录、OAuth、云同步
- Tauri 真实播放/安装包安装卸载签名(WebView2 内官方 API 的 Origin/CORS、音频输出)
- Linux/macOS 上的构建与运行(只在本机 Windows 验证过)




## 待定：音声稳定下载目录

- 当前音声下载仍在每次任务中手动 `showDirectoryPicker()`，没有固定存储根目录；因此暂不能实现可靠的“在文件管理器中打开位置”。
- 待定方案：IndexedDB 持久化目录句柄并重新申请权限；设置中指定统一“音声下载根目录”；Tauri 桌面版走原生路径/打开文件管理器命令。
- 需要先决定目录移动/权限过期、多作品根冲突和跨平台路径展示；在决定前不把该功能写成已实现。
- 详见 [下载文件夹封面与待定项](docs/handoff/33-voice-download-folder-cover-2026-11-03-dsh.md)。

## 待定：全年龄模式（成人内容隐藏）

- 设置页已展示「全年龄模式」占位项（位于成人内容模糊进阶设置内，标为开发中，开关禁用）。
- 后续目标：创作页与音声页不展示成人内容；成人内容不可被搜索命中；对应 tag 从筛选/搜索结果中消失。
- 需先确定成人判定来源（音声 `nsfw`、创作导入字段/标签/Pawchive 预览）、已导入作品的处理方式、与现有年龄筛选的关系，以及是否提供临时查看入口。
- 在实现前不要把该模式写成可用；当前只保留占位和 TODO。


## 删除只删 UI，后端库仍在（已修）

- 现象：从列表删除后约 5 秒自动回来；`fileStorage` 作品只改了前端数组，没有调用 host 删除 API。
- 方向：host `POST /api/works/delete` soft delete；`deleteVoices`/`clearAllVoices` 对 fileStorage 先删 host 再 refresh；失败不要先移除 UI。
- 修复：host `POST /api/works/delete`，UI 先删 host 再移除卡片；详见 [交接 157](docs/handoff/157-import-identity-and-backend-delete-2026-11-10-dsh.md)。

## 同一 RJ 出现两张卡（已修）

- 现象：`local:local:RJ...` 与 `RJ...` 两张作品卡同时存在；
- 方向：按 RJ + manifest fingerprint 归并 source identity，候选边界去重，旧 work 显式 cleanup；
- 修复：上传按单作品边界、以文件夹/RJ 为 source identity、旧 local RJ work 归并；详见 [交接 157](docs/handoff/157-import-identity-and-backend-delete-2026-11-10-dsh.md)。

## 文件库拖拽封面（待办）

- 把封面图片拖到作品/专辑，设置 work cover；
- 需要 host API 将图片写入 CAS 并更新 cover entry/asset_ref；
- 拖拽失败/非图片要给出提示，不覆盖原封面。

## 文件库 dynamic link / reference mode（待办）

- 小库/固定盘场景：只索引原目录，不复制到 CAS；
- 需要 UI 明确区分「导入到库」和「引用目录」；
- 当前实现仍是 CAS 导入模式，reference mode 尚未做。

## 音声字幕（已实现全屏/侧栏/悬浮）

- 已实现：优先读取 Kikoeru `has_subtitle`，同时扫描 `.srt/.vtt/.lrc/.ass/.ssa` 轨道文件；派生独立「字幕」筛选类别和 `带字幕` 徽标，不进入普通 tag；全屏播放接入右侧歌词区域。
- 已实现 SRT/VTT/LRC 解析，默认优先级 SRT > VTT > LRC（ASS 暂不选择）；字幕目录可以不同于音频目录，按书名/文件名归一化自动对应。
- 已实现：全屏字幕支持滚动、拖拽、点击 seek、当前句居中；非全屏侧栏歌词优先显示本地字幕，关闭/切视图清理定时器。
- 已实现：播放条悬浮字幕开关，当前 cue 覆盖层，文字颜色/遮罩留白/圆角设置，遮罩拖动定位，移动端动态播放条占位和全屏互斥。
- 已实现：全屏沉浸式字幕（当前 cue、3D 卷轴、滚轮/长按拖拽 browsing + 虚线轴 seek），移动端手势/横屏细节仍待办；下载目录 folder.jpg 使用开发代理。
- 待办：悬浮字幕英文 i18n、显式字号设置、多语言选择；ASS/SSA 若要完整样式/定位/karaoke，需要额外引入 libass-wasm 等渲染器，Monochrome 当前没有原生 ASS 能力。
- 实现与边界见 [交接 49](docs/handoff/49-voice-r15-and-subtitles-plan-2026-11-04-dsh.md)。

### 手动导入与跨作品字幕

- 允许用户导入本地 `.srt/.vtt/.ass/.ssa/.lrc`，指定目标音声和目标音频轨道；不要求字幕来源 RJ 与目标 RJ 相同（汉化音声常见 RJ 不同）。
- 字幕内容存 IndexedDB，不塞进 localStorage 的工作记录；保存来源、目标、格式、语言、offset 和关联轨道，避免依赖原始文件路径。
- 优先级：用户手动关联 > 本地已导入 > 远程 SRT > 远程 VTT > ASS 纯文本 > LRC；原始字幕文件不覆盖、不删除。
- 独立「上传字幕到音声列表」的字幕库/未关联资产列表，列为本地存储完成后的待办，不在本轮实现。
- 同一作品多音频同名时不要自动猜，必须给出路径/时长提示；歧义交用户确认。


## 音声多语言版本（已实现合并基础）

- 已实现：Kikoeru `language_editions`/`original_workno` 求源 RJ；合并卡；中文优先标题；源 RJ 角标；详情版本下拉；翻译者结构化字段与筛选分类；旧库自动迁移。
- 已实现：源作品不在 Kikoeru 时，通过本机 7897 mixed proxy 拉 DLSite 真实社团；Tauri 代理设置待办。
- 待办：本地 SHA256 内容索引、下载后内容复用/虚拟链接、真实软链接（Tauri/文件存储方式敲定后）；未导入版本的即时导入目前按需请求，失败不阻塞。
- 详见 [交接 50](docs/handoff/50-voice-editions-2026-11-05-dsh.md)。

## 音乐分类与 am-lyrics 适用边界（待办，2026-11-07）

- 现状：`am-lyrics`（在线歌词）只应服务**导入的音乐**；音声作品不使用在线歌词，音声没有本地字幕时播放条/侧栏/全屏显示“暂无”。
- 已做：`openLyricsPanel` 与全屏逻辑对 voice/local 轨禁用 am-lyrics，只走本地字幕或空状态；无字幕按钮仍显示。
- 待办：新增「音乐」分类/导入入口后，`am-lyrics` 仅在该分类启用；音乐分类的导入、库页、播放队列/媒体元数据与音声分类分开，避免把音乐作品混入音声树。
- 验收：音乐分类下在线歌词可用；音声分类下即使有 `am-lyrics` 组件也不加载在线歌词，无字幕时稳定显示“暂无”。

## 存储与平台路线（2026-11-09）

### 已完成

- Windows Tauri storage admin spike：真实 exe + WebView2 + bundled Node sidecar，原生文件夹选择、scan/import/verify；便携包约 101MB；见 [交接 128](docs/handoff/128-storage-lab-tauri-admin-2026-11-09-dsh.md)。
- Windows 生产 host 外部数据根/启动/重启；见 [交接 126](docs/handoff/126-storage-lab-prod-host-2026-11-09-dsh.md)。
- Node storage host sidecar supervisor；见 [交接 127](docs/handoff/127-storage-lab-sidecar-2026-11-09-dsh.md)。

### 待办

- [x] Windows Tauri：sidecar 打包（bundled Node/resources）；
- [x] Windows Tauri：NSIS/安装包；demo NSIS 37.11 MiB，静默安装→导入播放→卸载通过；
- [x] Windows Tauri：Monochrome UI Storage 入口 + portable 验收；
- [x] Windows Tauri：真实文件存储切换 + 本地音声库导入/播放主流程（追加切片，见交接 131）；
- [ ] Windows Tauri：旧库迁移/删除/编辑/导出主流程。
- [ ] npm/Web UI：浏览器目录上传/挂载源选择，不依赖 Tauri。
- [ ] Linux/Docker：POSIX 锁、auth/TLS、`/data/MonochromeData` volume、只读 `/sources`、备份/导出、容器重启/健康检查；需要 Linux 环境与用户明确许可。
- [ ] Android APK（后续，不在当前阶段）：远程 Web/PWA 优先；离线本地存储需原生 SQLite/CAS adapter，不复用 Node sidecar。
- [ ] 真实旧库迁移切换与回滚。

### 明确不做

- 不把 Docker 当 Tauri 桌面替代。
- 不在 Android 上强塞 Node sidecar。
- 不在未验证 Linux 锁/auth 前宣称 Docker 生产可用。

## 音声元数据手动刷新（待办，2026-11-14）

- 本地作品在导入时抓取一次 Kikoeru + DLsite 并写入 host `user_meta`，启动/刷新不再重新拉取。
- 后续增加单个/多选后的“更新元数据”动作，手动触发两源抓取并写回；不自动覆盖已有的非空字段。

- 手动“更新元数据”动作应同时重抓封面并写回 `folder.jpg`（单/多选）。

- 存储改为 source-only：workRoot 是唯一文件存储，默认不再复制 CAS；同一 work identity（code + editionCodes）内按 sha256 去重，不做跨作品全局去重。
- 可选备份层（TODO）：显式开启后按 sha256 备份，明确提示会额外占用一份空间；与 source 存储解耦，可随时关闭/清理。
- 迁移现有 CAS：校验 manifest/source hash 后逐步停止 asset 复制，清理无引用 asset。

- 可选 sha256 备份层：显式开启后额外保存一份内容，明确提示空间翻倍；默认关闭。

- 2026-11-14 CAS 数据已清空；代码层 CAS 兼容路径保留，彻底移除需单独迁移测试。
