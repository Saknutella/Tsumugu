# Monochrome(二开)— 简介

- 项目:`monochrome`
- 类型:`web`
- 状态:`wip`
- 最后更新:2026-11-18
- 一句话:以 monochrome-music/monochrome 为基础的二开音乐播放器:品牌与功能定制、精简、自托管数据源,并规划 Tauri 沉浸式桌面封装。

## 它是什么

这是开源 Web 音乐播放器 [Monochrome](https://github.com/monochrome-music/monochrome) 的个人二开 fork:
Vite 7 + TypeScript/Preact + 大量原生 JS 模块,`index.html` 是包含完整界面结构的单页,
`js/` 负责播放器、歌词、下载、可视化等行为,`functions/` 是 Cloudflare Pages Functions,
`docker/` 提供自托管入口。注意 `src/main.tsx` 是一份**未接线的 Preact 重构半成品**
(没有任何入口引用它,依赖 `preact` 也未声明),当前构建产物完全来自 `index.html` + `js/`。

二开的目标不是另起炉灶,而是在这份上游代码上做三件事:改品牌与界面、按需要精简功能、
对接自己的数据源;在此基础上再验证用 Tauri 封装成轻量桌面「沉浸式播放器」的可行性。

## 现在到哪一步

**一句话结论(2026-11-18):存储后端 Node 最终版已封版于 schema v7,服务端代码在 `server/`;
功能开发在 `node-final` 分支上完成,本地提交、未推送。**

- 存储后端(2026-11-17/18):`verify/storage-lab/lib/` → `server/lib/`、`host-server-start.mjs` →
  `server/start.mjs`、`host.mjs` → `server/cli.mjs`、`ui/` → `server/ui/`(搬家前后 121 条用例逐条一致);
  D1–D19、D21、T1 全部修复,Rust 迁移中发现的 Node 缺陷清空;新的运维/API 说明在 `server/README.md`。
- 验证:storage-lab **132 条 = 131 pass / 1 skip / 0 fail**,25 组 runner 退出码全 0;与 Rust host 的
  **82 步差分 0 DIFF**(只剩 3 条 schema v8 专属差异);便携版 20 MiB 分块上传通过,并有「撤销修复就失败」的反向对照。
- 前端:同步 Pawchive 多缩略图、签名原图可下载、**导入即自动保存图片**(「导入选项」默认开)、`kind.mjs` 证据脱敏。
- 门禁:`node verify/check.mjs` 只剩 1 条 worktree 固有失败(目录名),`link-sweep` 只剩 2 条 worktree 坏链。
- 细节与全部证据见 [交接 345](docs/handoff/345-node-final-edition-2026-11-17-dsh.md)。

历史进展(按时间,最新在下):

- 已导入 `projects/monochrome/`,完整保留上游 git 历史;remote 已切成 `upstream`(官方仓库),
  新增 `scripts/upstream-sync.ps1`(默认只 fetch + 报告,实测退出码 0);`origin` 等 fork 建好后添加。
- 本机基线已跑通:`npm install`(978 个包)、`npm run build`(实测 22.7–43.7s,`dist/` 134 个产物)、
  `npm run dev` 返回 200、`node verify/render.mjs` 18 条断言全过(共享 Chromium 156),
  截图与元数据在 `verify/evidence/`。
- 工作区契约已接入;当前工作区清单检查通过、真实构建 17 条通过。
  项目契约仍因 `Hentasy/` 研究资料的行尾/尾换行两项失败而阻断 `npm run verify`,见本轮交接。
- 多语言(2026-10-26):i18next + 源文本词典(930 条),**英文默认回退 + 简体中文**;核心壳、
  设置页、右键菜单/弹窗/关于页等静态文案已中文化;设置 → Interface → Language 可运行时切换;
  `verify/i18n-probe.mjs` 21 条断言通过,中文默认字体为微软雅黑
  (证据 `i18n-zh.png`、`i18n-zh-settings.png`、`i18n-meta.json`)。
- 精简第一步已完成(2026-10-26):**Sentry / Plausible 默认关闭**,只有用户在设置里显式开启才注入;
  `verify/analytics-probe.mjs` 证明了开关有效(开启后确实抓到 2 个统计请求)。
- 桌面端适配第一步(2026-10-26):`isTauri` 识别桌面壳并按 native shell 关闭 PWA/SW;
  `verify/desktop-probe.mjs` 3 条断言通过,web 模式 SW 仍正常注册(render 18 条)。
- 官方 API 的 Origin 行为已实测(2026-10-26):Chromium 里以 `tauri.localhost` / `127.0.0.1`
  为 origin,search 返回 200、音频返回 206 + FLAC 魔数、SW 可注册;证据
  `verify/evidence/api-origin-probe.txt`。真实 WebView2 与自定义 https 域名仍未验证。
- 端到端播放已实测(2026-10-26):`verify/playback-probe.mjs` 拉起 dev server,用真实
  `MusicAPI`/`Player` 播放官方 FLAC,`readyState=3`、`currentTime≈1.02s`;证据
  `playback.png` + `playback-meta.json`。UI 点击/切歌/队列仍未验证。
- Tauri 原型(2026-10-27 首次真实运行):工作区 `tools/rust/` 的 Rust 1.99.1 编译 Tauri 2.12.5
  (342 个 crate),WebView2 155 成功打开窗口;Monochrome 静态壳渲染通过(标题/侧栏/24 个页面容器/
  样式与脚本),证据 `tauri-app.png` + `tauri-app-meta.json`。用户提供的第三方复杂 HTML 夹具也
  渲染通过(24/24 图片解码,仅本机 `.scratch`,未入库)。播放/Origin/CORS/打包仍未验证。
- Tauri 能力测试页(2026-10-26):侧栏「Tauri 测试」→ `/tauri-test`,检测渲染/Canvas/WebGL/
  字体/音频/存储/网络/WASM/Tauri API/SW;`verify/tauri-test-probe.mjs` 12 条断言通过,
  证据 `tauri-test-zh.png` / `tauri-test-tauri-sim.png`。可在 Tauri 里打开该页复测真实 WebView2。
- 创作页(2026-10-27,2026-11-20 改为默认空库):侧栏「创作」→ `/creations`,帖子流/详情(封面/画廊/音频/视频/附件);应用不内嵌示例,示例 JSON 见 `examples/`;
  图片可放大、`description.md` 简介、音频名+description 音频简介、标签多选、文本附件动态下拉、
  简介显示开关、艺人页、播放时简介侧栏(可加宽/收起/重开)、视频内嵌/送进全屏播放器(含 seek/切歌);
  创作者可进入艺人页并「在 Monochrome 中搜索」,原生搜索页会显示「创作」本地区块;
  `verify/creations-probe.mjs` 74 条断言,证据 `creations-zh.png` / `creations-detail-zh.png` /
  `creations-artist-zh.png` / `creations-video-zh.png` / `search-local-creations-zh.png` 等。
- 音声页(2026-10-30):侧栏「音声」→ `/voices`,导入 asmr.one / 同 Kikoeru 后端作品 URL;
  展示 RJ 号、上市时间、社团、声优、标签、评分、售价、总时长、DLsite、4:3 封面和递归文件树;
  音频可单条或全部进原播放器;`verify/voices-probe.mjs` 14 条断言,证据 `voices-asmr-zh.png`。
  详见 [docs/12-voices-youtube.md](docs/12-voices-youtube.md)。
- 音声原生专辑(2026-11-02):详情已接入 `/album/voice-…`,保留新版 4:3 封面、层级文件列表、
  社团/声优更多作品与 ZIP 下载;修复连续切页旧监听、普通专辑状态残留、懒加载图片阻塞播放，
  新增真实合成音频/ZIP 字节回归。功能、文件与验证范围见 [本轮交接](docs/handoff/15-voices-handoff-2026-11-02-codex.md)。
- 音声封面性能(2026-11-02):开发代理加入有界缓存/并发合并，修复同源取色绕过缓存和失败后不可重试；
  指定作品封面代理实测首次约 1.25s、缓存约 2ms，原生晕染参数保持一致。音乐 API 经已有代理返回 523，
  在线 album 当前仍受源站可用性影响，见 [性能交接](docs/handoff/16-cover-performance-2026-11-02-codex.md)。
- 音声模板(2026-11-02):所有作品统一采用 RJ01605254 的紧凑标题规则，旧/新导入共用布局，
  无需重新导入；模板回归 20 项通过，见 [模板交接](docs/handoff/17-voice-template-2026-11-02-codex.md)。
- 音声模板同步(2026-11-03):详情已由 Codex 重构为所有导入共用的模板；DSH 的 4:3 封面/角标、
  元数据合并、操作栏、更多作品侧栏、层级下载和行点击原生播放已并入。当前功能与验证边界见
  [DSH 同步交接](docs/handoff/23-voice-template-sync-2026-11-03-dsh.md)。
- 音声流式下载(2026-11-03):全部/文件夹下载优先直接写入选定目录的 `[RJ号]-标题` 根文件夹，
  保留层级；目录行三点菜单提供文件夹下载，右下角状态窗逐文件显示进度；默认最多 4 个文件并发，
  单文件 Range 重试/续传，不支持 File System Access 时回退 ZIP。见
  [流式下载交接](docs/handoff/24-voice-stream-download-2026-11-03-dsh.md)。
- 音声附件灯箱(2026-11-03):图片支持滚轮缩放/左键拖拽，文本可切换原文与 Markdown；
  视频/PDF 分流到原生预览，附件类型统一识别，避免误入音频队列；未新增依赖。
- 创作主页(2026-11-03):导入/管理收纳，新增本库搜索、来源、排序与双列手机布局，保留作者与媒体色；
  本地卡片显示导入日期，网页作品保留发布时间；历史缺失时间不猜测。
  作者/标签/媒体改为分类筛选浮层与 URL 多选条件，卡片头像姓名合并入口；作者页收紧留白并保留轻微效果，见 [交接 38](docs/handoff/38-creation-library-facets-2026-11-03-codex.md)。
- 创作者页(2026-11-03):`/creations/creator/平台/作者ID` 接入原生 artist 模板，兼容旧 artist 地址；
  按平台隔离作者资料，提供作者内搜索/媒体/标签/排序；范围与验证见 [交接 37](docs/handoff/37-creation-native-creator-2026-11-03-codex.md)。
- 音声主页(2026-11-03):重排为作品库，导入区收起、增加库内搜索/排序、管理菜单；
  保留分类标签色，年龄移到封面，顶部全局/本库搜索的最终呈现待定。
- 音声多选/下载窗(2026-11-03):行、目录和全选复选框可选音频/附件；所选音频按源序静默追加队列，
  所选文件复用 DSH 流式下载；总体浅绿进度 banner 可最小化/重开，跨页继续、完成仍保留入口，
  见 [当前交接](docs/handoff/29-voice-selection-download-2026-11-03-codex.md)。
- 音声筛选弹出层(2026-11-03):筛选选项改为从顶部按钮动态弹出,点击外部/Escape 关闭;
  活动筛选条只保留一个清除入口,面板不再重复。见
  [筛选弹出层交接](docs/handoff/26-voice-filter-popup-2026-11-03-dsh.md)。
- 封面主题(2026-11-03):音声主要操作/底部播放按钮分别跟随各自封面，三点菜单保持原色，设置提供唯一总体开关；
  移除页面开关/额外渐变，保留原生淡雅背景，主色改为颜色簇占比优先，见 [当前交接](docs/handoff/19-cover-theme-global-2026-11-03-codex.md)。
- 音声交互(2026-11-03):默认 AAC/MP3、下拉选择 WAV/FLAC 等实际格式并避免重复队列；
  队列可拖到窗口全宽、目录有动画、图片/TXT 整行打开站内预览；整行灵动恢复，
  外层稳定命中并限制末行缩放溢出，播放/选中底色保留。当前动效与验证见
  [行动效交接](docs/handoff/27-voice-row-motion-2026-11-03-codex.md)，其他交互见 [交接 21](docs/handoff/21-voice-interactions-2026-11-03-codex.md)。
- 视频页(2026-10-30):侧栏「视频」→ `/videos`,导入 YouTube;抓标题、频道/头像、发布时间、
  时长、播放量、标签、简介、缩略图;点击封面才加载官方嵌入;`verify/videos-probe.mjs` 11 条断言,
  证据 `videos-youtube-zh.png`。生产 Web/Tauri 原生抓取仍未验证。
- Tauri 原生桥(2026-10-27):`js/tauri-bridge.js` + 原型 `tauri-plugin-dialog`;
  Tauri 下「导入本地创作」走原生文件对话框、附件下载走原生另存为;真实 Tauri 里已验证
  `invoke`/创作页/按钮(`tauri-creations.png`),假 Tauri 探针 35 条断言;UI Automation 真点原生
  打开/另存为已通过(视频字节 SHA256 一致),导入持久化 + 单条/批量删除;NSIS 安装包已生成(13.72 MiB),已有静默安装/卸载记录,未签名。
- 音声本地存储(2026-11-11):storage host 已接 SQLite + CAS + HTTP upload + 增量 scan/import;Kikoeru 作品可下载或“保存到文件库”,两者共用 `startVoiceDownload` destination、下载锁、进度小窗、AbortController。
- 音声元数据(2026-11-10/11):Kikoeru 有界查询 + DLsite 权威 fallback;翻译版抓原版 sourceCode/社团,年龄解析“全年齢→all”;远程元数据持久化到 host 的 `user_title/circle/cv_json/user_meta_json`,手动编辑以 `manual=true` 防覆盖。
- 音声 UI / 下载设置(2026-11-11):稳定 URL `/album/voice-<RJ>`、统一目录命名、双语版本下拉、主页移除售价、本地/字幕派生 badge 点击筛选;下载并发默认 2 个文件、单文件 2 个 Range 线程,可在设置调整。
- 共同约定(2026-11-11):新增 [docs/16](docs/16-voice-storage-download-metadata.md),并写进项目 AGENTS §7;之前散落在交接里的下载/元数据/派生 tag/URL 规则已集中。
- 尚未验证:官方 API 在 WebView2 里的串流/播放、账号登录、Docker 自托管与安装包签名。
- 工作区 `npm run hygiene` 仍红(16 项:上游公开客户端凭据及研究副本、临时/缓存目录、嵌套仓库);
  不能按“只有 6 处凭据”处理,详见本轮交接与 [ROADMAP](ROADMAP.md) 已知限制 #8。

## 下一步

1. **存储后端后续开发在 `refactor/rust-backend`**(schema v8)进行;`node-final` 已封版,不再加功能、
   不改 schema、不搬文件。Rust 写过的库 Node 打不开,切换前先备份。
2. 补上本轮未验证的运行面:Linux/Docker、真实 WebView2 播放、NSIS 安装版重打、
   `run-real-sample*` 的真实样本,以及 Pawchive 联网链路在 Node host 上的实测。
3. 其余前端工作按原计划:docs/16 的音声约定、[docs/05](docs/05-customization.md) 的品牌/界面定制、
   [docs/07](docs/07-i18n.md) 的 i18n 第二批、Tauri 沉浸式 MVP(先验证 Origin/CORS 与真实播放)。

## 不做什么

- 不把上游代码整体重写成别的框架;二开以最小、可合并的改动为原则,方便同步上游。
- 不修改 `license` 文件、不删除版权与来源声明(Apache-2.0 要求)。
- 不把「能构建」当成「能串流」:没有真实 API 与真实浏览器证据的功能,一律标「未验证」。
- 不复活 `src/main.tsx` 的 Preact 重构(未接线的半成品,见 [docs/04](docs/04-architecture.md) §1.1)。
- 不在封版后的 `node-final` 上继续动存储后端(见 ROADMAP 已知限制 #15)。

## 更新记录
- 2026-11-18:Node 最终版（node-final）：服务端搬到 `server/`、D1–D19/D21/T1 修复、与 Rust 差分一致、Pawchive/自动保存图片前端同步，Node 存储后端封版于 schema v7。
- 2026-11-11:保存到文件库改为逐文件流水线：完整文件先落 tmp，move 到最终路径后立即 scan/import，中断后已完成文件不重下。
- 2026-11-11:审计 15–179 共 169 份交接，把反复用户的下载/元数据/存储/验证/UI 规则合并进 [docs/16](docs/16-voice-storage-download-metadata.md)、[docs/17](docs/17-library-ui-conventions.md)、AGENTS §2–§7；明确“后写覆盖先写”。
- 2026-11-11:音声 storage host、下载 destination 统一、DLsite 元数据/持久化、稳定 URL、派生 badge 筛选与下载并发设置;新增 docs/16 共同约定并写进 AGENTS §7。
- 2026-10-25:导入上游 `cedea44`,接入工作区项目契约,完成本机构建基线。
- 2026-10-25:补真实浏览器渲染证据(11 条断言),补齐架构测绘、二开指南、Tauri 方案三份项目文档;
  修正「`src/` 用 Preact 挂载」的错误说法。
- 2026-10-26:remote 切为 `upstream` 并新增上游同步检查脚本;Tauri 2 原型骨架就位并通过
  `tauri info` 配置解析(Rust 未装,启动未验证);确认 hygiene 剩余命中均为上游公开凭据。
- 2026-10-26:桌面端适配第一步——`isTauri` 识别桌面壳并关闭 PWA/SW;desktop-probe 3 条断言、
  render 13 条断言。
- 2026-10-26:精简第一步——Sentry/Plausible 默认关闭并可被用户显式开启;渲染证据新增
  「默认无统计请求」断言(当时 12 条,现 18 条),并用 analytics-probe 验证该断言非空。
- 2026-10-26:新增官方 API Origin 探针——Chromium 下 `tauri.localhost`/`127.0.0.1` 的
  search 200、音频 206 + FLAC 已实测;自定义 https 域名与真实 WebView2 仍标未验证。
- 2026-10-26:新增端到端播放探针——dev 模式下真实 `MusicAPI`/`Player` 播放官方 FLAC,
  `readyState=3`、`currentTime` 前进;播放链路不再只是"能构建"。
- 2026-10-26:接入 i18next——英文默认回退 + 简体中文,核心壳文案全部抽 key,设置页可切换;
  `verify/i18n-probe.mjs` 15 条断言、`i18n-zh.png` / `i18n-meta.json` 留证。
- 2026-10-26:中文字体默认改为微软雅黑(通过字体 fallback 链;Inter 继续负责拉丁字符),
  i18n 探针新增 3 条字体断言。
- 2026-10-26:i18n 第二批——新增源文本词典 930 条(设置页/菜单/弹窗/关于页等静态文案),
  语言切换可完整还原英文;探针 21 条断言、新增中文设置页截图。
- 2026-10-26:新增 Tauri 能力测试页——侧栏「Tauri 测试」→ `/tauri-test`,卡片化检测
  渲染/WebGL/字体/音频/存储/网络/WASM/Tauri API;web 与模拟 Tauri 两种环境共 12 条断言。
- 2026-10-27:首次真实运行 Tauri——Rust 1.99.1 编译 342 个 crate,Tauri 2.12.5 + WebView2 155
  打开窗口;Monochrome 壳与外部 HTML 夹具都渲染通过(`tauri-app.png`);播放/打包仍未验证。
- 2026-10-27:新增「创作」页——Patreon 式本地示例帖子流/详情(封面/画廊/正文/音频/附件),
  点音频直接进入原播放器;`verify/creations-probe.mjs` 74 条断言,含音频/视频真实播放验证。
- 2026-10-27:创作页增强——`description.md` 简介(白名单 HTML 花活)、音频名+description 的音频简介、
  标签多选、文本附件动态下拉、简介显示开关、创作者艺人页、播放时自动展示简介侧栏、侧栏可加宽/收起/重开;
  视频 A+B 方案(内嵌 `<video>` + 进 Monochrome 全屏播放器)、Pawchive URL 预览导入
  (缺失附件会标记,不伪造下载)、Pawchive 附件多选下载/逐文件进度/IndexedDB 本地链接、
  压缩包/文本类型、删除创作保留/删除本地文件、同 URL 重导覆盖/保留、导入选项开关、
  卡片与详情作者头像/作者筛选、附件类型柔色标签与原生搜索本地创作;探针扩到 74 条。
- 2026-10-27:接 Tauri 原生桥——`tauri-plugin-dialog` + 3 个 Rust 命令,创作页支持原生导入 JSON/
  附件另存为;真实 Tauri IPC 验证,假 Tauri 桥探针 35 条;原生打开/另存为已用 UI Automation 真点通,
  导入持久化 + 单条/批量删除;NSIS 安装包 13.72 MiB,静默安装/启动/卸载实测。
- 2026-10-30:新增「音声」页——asmr.one / Kikoeru 适配,RJ/上市时间/社团/声优/标签/评分/售价/
  总时长/DLsite/4:3 封面/递归文件树/播放;`verify/voices-probe.mjs` 14 条断言。
- 2026-10-30:新增「视频」页——YouTube 元数据抓取与点击后嵌入播放;`verify/videos-probe.mjs` 11 条断言。
- 2026-10-30:创作页详情 Hero 统一 16/10;作者头像与作者名统一进艺人页,漏斗按钮单独筛选。
- 2026-11-02:核对音声原生专辑新版并修复导航/初始化/菜单下载,新增连续导航与媒体回归及交接记录。
- 2026-11-02:修复音声封面重复抓取与取色重试，补真实封面耗时/背景和音乐 API 网络诊断交接。
- 2026-11-02:统一音声详情模板的标题排版，补旧链接/新导入/刷新与多尺寸回归及交接。
- 2026-11-02:新增通用封面主题接口、音声/播放按钮配色和持久化开关，补可见渐变及主题回归。
- 2026-11-03:按用户纠正移除详情开关/额外渐变，恢复原生背景，并加入每封面按簇占比动态取色。
- 2026-11-03:修复音声附件悬停尺寸变化及误入音轨交互，记录图片/TXT 站内预览建议。
- 2026-11-03:完成格式菜单/播放按钮修复、队列全宽、目录动画和附件预览，恢复背景缩放与原色三点菜单。
- 2026-11-03:恢复完整音声行灵动与播放/选中底色，增加稳定命中框并排除末行缩放滚动溢出。
- 2026-11-03:接入行/目录多选、源序静默追加与所选下载，下载窗改为可折叠重开的总体进度卡片。
- 2026-11-03:同步音声详情统一模板——确认所有旧/新导入共用当前详情结构，DSH 侧界面/播放改动已并入，并补 DSH 交接。
- 2026-11-03:音声全部/文件夹下载改为流式写入选定目录，新增目录三点菜单、右下状态窗、4 文件并发与 Range 续传；ZIP 仅作不支持环境的回退。
- 2026-11-03:音声筛选改为从顶部按钮弹出的浮层，移除面板内重复的清除入口，并补弹出层断言。
- 2026-11-03:增强图片灯箱，提取共用 Markdown，并接入视频/PDF 附件类型和原生预览。
- 2026-11-03:提交改造前快照并重排音声作品库，保留标签色、突出年龄，记录搜索界限待定。
- 2026-11-03:提交音声主页快照并重排创作库，区分来源日期，去除封面示例标记。
- 2026-11-03:创作者按平台与源 ID 接入原生 artist 模板，增加新地址兼容和作品内筛选。
- 2026-11-03:创作库新增作者/标签/媒体分类筛选，收敛作者入口、管理按钮和作者头部视觉。
- 2026-11-04:同步 DSH 的筛选视觉、布局控件和 9 篇创作样本，补齐创作浮层与作者页回归。见 [交接 44](docs/handoff/44-creation-filter-integration-2026-11-04-codex.md)。
- 2026-11-04:大屏拖拽杆改为主题短条，实时缩放限频并在松手时保存宽度。见 [交接 45](docs/handoff/45-layout-resizer-2026-11-04-codex.md)。
- 2026-11-04:修复创作/音声筛选的条件栏跳动和卡片整批替换，按作品 ID 复用结果与封面。见 [交接 46](docs/handoff/46-filter-stability-2026-11-04-codex.md)。
- 2026-11-04:核对 DSH 模糊/侧栏/管理更新，两页共用音声管理样式，复验筛选稳定并记录创作详情建议。见 [交接 48](docs/handoff/48-library-management-2026-11-04-codex.md)。
