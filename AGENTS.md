# AGENTS.md — Monochrome(二开)项目内约定

## 0. 强制：先读设计指导，再开始工作

任何代码、数据或 UI 修改前，必须先读：

- [docs/17-library-ui-conventions.md](docs/17-library-ui-conventions.md)（库页/详情/交互基线，§16、§17 覆盖旧规则）
- [docs/16-voice-storage-download-metadata.md](docs/16-voice-storage-download-metadata.md)（音声存储/下载/元数据）
- [docs/05-customization.md](docs/05-customization.md)（本轮二开改动/文件索引，必须同步维护）
- [docs/03-upstream-sync.md](docs/03-upstream-sync.md)（上游同步改动清单）
- 最近相关的 `docs/handoff/` 交接与本文件 §0 之后的约定

用户最新指令 > 设计指导 > 旧交接；发现冲突先改设计指导，不能两套规则并存。
未读设计指导、或实现与设计指导冲突，视为未完成。

这是 `projects/monochrome/` **自己**的协作约定。工作区总规则在根 `AGENTS.md`,本文件只写
这个 fork 里额外需要遵守的事。优先级:用户 > 工作区根 `AGENTS.md` > 本文件。

## 1. 这是一个 fork,不是从模板生成的项目

- 源码来自 [monochrome-music/monochrome](https://github.com/monochrome-music/monochrome)(Apache-2.0),
  基线提交 `cedea44`。**上游文件尽量不改**;必须改时,把改动控制在一处、能说清理由,
  并记录到 [docs/05-customization.md](docs/05-customization.md) 的「改动清单」里 —— 上游同步时
  这些就是需要人工合并的点。
- 不要整体格式化上游文件(Prettier/ESLint 的 fix 只对你改过的文件、或你新增的文件跑),
  否则每次同步上游都会变成整文件冲突。
- **不要删除 `license`、不要删改版权与来源声明。** 对外分发时保留 Apache-2.0 文本与改动说明。
- 工作区契约文件(`project.json`、`INTRO.md`、`AGENTS.md`、`ROADMAP.md`、`docs/`、`verify/`)
  是本仓库自己的,不向上游发送。

## 2. 边界

- 只改本项目目录里的东西。工作区的 `tools/`、`templates/`、根 `docs/` 不属于这个项目。
- 不把 `.env`、密钥、证书、本机绝对路径、个人渠道名写进任何文件。`.npmrc` 是**本机安装配置**
  (只有 `legacy-peer-deps=true`),已在 `.gitignore` 里,不要提交;新克隆按 `docs/01-quickstart.md` 生成。
- 产物(`dist/`、`node_modules/`、`verify/.tmp/`)不进仓库;证据(`verify/evidence/`)必须进仓库。
- 需要新增依赖时,先问「能不能用现有依赖」;必须新增时同步更新 `package.json`、`docs/` 与
  `ROADMAP.md`,并说明为什么不能省。

- **测试隔离（硬约束）**：开发/验证只用隔离浏览器 profile、合成作品/封面/音频、隔离 IndexedDB/localStorage；
  禁止读取或改写用户真实浏览器 profile、真实导入库、真实下载目录、真实媒体。证据里区分“合成 fixture /
  公开元数据 / 真实用户样本”。证据所有字符串（含成功断言、stdout/stderr、诊断）落盘前递归脱敏，
  不得出现本机绝对路径、项目根、home 或真实样本根。

## 3. 验证门禁

改完任何东西,在项目根跑:

```powershell
node verify/check.mjs     # 契约:清单/入口/gitignore/文本卫生
node verify/kind.mjs      # 真实构建:跑 npm run build 并核对 dist 产物
node verify/render.mjs    # 可选:真实浏览器渲染 + 截图(无浏览器时 skip,退出 0)
```

`commands.test` = `node verify/check.mjs && node verify/kind.mjs`,必须**在正常状态下退出 0、
在关键文件被破坏后退出非 0**。`verify/kind.mjs` 依赖已安装的 `node_modules`(这是被收养的真实
前端项目,和模板「零依赖自检」的差异见 [docs/02-testing.md](docs/02-testing.md))。

- **验证结论分级**：真实样本 ≠ 合成 fixture ≠ 仅代码核对；skip/unverified/blocked 不算 pass；
  局部/Windows/Node 通过不能写成“整个应用全绿”，也不能代替 Linux/Docker/WebView2/Tauri；断言数/跳过数
  必须来自本次运行，失败/受限结果原样保留。
- **冲突以更晚者为准**：用户后续指令或编号更大的交接覆盖先前的；发现冲突先改设计指导，不能两边并存。

## 4. 文件归属

| 想写什么 | 写哪 |
| --- | --- |
| 上游实现(播放器/UI/功能) | 上游原有目录(`js/`、`src/`、`styles.css`、`index.html` …) |
| 项目简介 | `INTRO.md`:随项目更新;用户说「需要对简介进行更新」时必须更新(工作区 AGENTS §11) |
| 二开设计/说明/同步流程 | `docs/`,并在 `docs/README.md` 索引里加一行 |
| 每轮修改交接 | `docs/handoff/`,并更新 `docs/handoff/README.md`;Codex 文件名以 `-codex.md` 结尾,DSH 以 `-dsh.md` 结尾 |
| 证明功能可用的证据 | `verify/evidence/`,提交进仓库 |
| 构建产物 | `dist/`(已 gitignore) |

修改后必须写交接，列出功能变化、修改文件及验证结果。交接正文不放在普通 `docs/` 根目录；
移动或重命名交接文件时，同步更新所有引用和相对证据链接，保留原记录内容与本机历史备份。

- **大改前固定基线**：先提交当前源码/交接/证据，或生成带 SHA256 的本地备份；不得用旧备份/旧实验
  覆盖协作者当前实现；并行工作树只保留各自改动，合并前先同步主树。

## 5. 风格与行尾

- 这个仓库沿用上游风格:**4 空格缩进、单引号、分号、无尾逗号**(`.prettierrc`、`.editorconfig`)。
  新增的 `verify/*.mjs` 也按这个风格写,保证 `npm run format` 不会把它改成另一种样子。
- 文本文件 LF 行尾、末尾一个换行;`.gitattributes` 已把 `* text=auto eol=lf` 钉死。
- 注释解释**为什么**,不复述代码做了什么。

## 6. 做完了

`project.json.status` 从 `wip` 改成 `usable` 之前,先确认:自检绿、破坏后红、证据可重新生成、
README/INTRO 与实现一致、`ROADMAP.md` 的「已知限制」写清了没验证的部分(尤其是串流、账号、
Docker、Tauri 这些本机无法完全证明的结论)。

## 7. 音声 / 存储 / 下载 / 元数据硬约定

修改音声库、storage host、下载器、元数据抓取前，**必须先读**
[docs/16-voice-storage-download-metadata.md](docs/16-voice-storage-download-metadata.md)。最低限度：

- Kikoeru / asmr.one 是在线音源，storage host 是本地文件库，两者不能混配置；
- **元数据/评分以 DLsite 为准**：原版由 `translation_info.original_workno` 定；同一音声的多个
  RJ 里，**编号最小的那个 RJ 元数据最准确**（社团、评分、CV、价格都以它为准）。
  Kikoeru / asmr.one 只补 DLsite 为空的字段（CV、tag、文件树），不抢社团与评分；手动值最高。
  例外：RJ01506849 实测中最小号曾不等于原版，那种情况以 DLsite 的 `original_workno` 为准。
- 远程元数据必须写回 host（`user_title/circle/cv_json/user_meta_json`），手动值带 `manual=true`；
- 下载只有一个入口 `startVoiceDownload(..., destination)`，禁止新增第二套“保存到文件库”；
- 派生 tag 必须同时实现卡片 chip、filter facet、URL 参数；`--tag-accent` 与 `--filter-accent` 同源；
- voice URL 使用 `voice-<source_code>`，所有 host 操作再映射回 `storageWorkId`；
- 主页不显示售价，字幕/本地状态放在评分/时长同一行；
- tree depth0 灰色，颜色向下顺延，rail 跟随父层级；hover 保留行缩放，但 elbow 挂在 hitbox 上，不能随 row 缩放。

- 手动音源 = 仅手动，手动失败不得静默回退自动最快；API base 与 media base 分离。
- 普通下载只写用户目录，**不隐式创建 work/asset_ref**；入库必须显式 import。
- 用户源目录只读：不自动改名/移动/删除/覆盖；外部源默认拒绝，授权必须是绝对、真实、exact root、
  按次生效、不持久化、禁 symlink/junction。
- 文件库媒体签名 URL 不得持久化；队列/播放/seek/恢复用稳定 ID 临时换签，晚到响应校验播放代次。
- fileStorage 删除先 await host，成功才移 UI；CAS soft delete，不自动 GC。
- 作品身份 = provider + sourceCode；展示名/目录名/candidateId 不能当主键；同 RJ 在线/本地合并一张卡，
  重复导入报告“已有/0 个”。
- 新增列表型库页面必须先读 [docs/17](docs/17-library-ui-conventions.md)；不得复制筛选/管理/宽度/空态。
- 验证遵守 §3 分级；证据遵守 §2 隔离与递归脱敏。

- Kikoeru → storage 必须按“下载完成一个 → 移出 tmp → POST /api/import/file 导入一个”的流水线；未完成文件在 `tmp/` 且 scanner 排除，中断后已完成文件可跳过。
- 保存中断/未完成时不得判“本地文件完整”：必须比较全部文件节点 + 音频数 + 本地封面；partial host 保留在线树/封面，卡片和专辑都显示“部分本地”；专辑必须用 online work 并保留“保存到文件库”，未入库文件标“未下载”。
- 卡片 rating 为 0 时必须从源作品详情补（Kikoeru → DLsite fallback）并缓存；下载面板 `skipped` 算完成 100%。
- 音声文件行下载用 `btn btn-secondary` + `SVG_DOWNLOAD(16)` 图标按钮，保留 title/aria；库内 `<a>`→`<button>` 必须复制 innerHTML/title/aria，不能只复制 textContent。
- 下载与保存到文件库共用一个 destination 菜单；顶部/选中/文件夹都必须走 `startVoiceDownload`；本地位置由 host `/api/works/open` 打开，前端不拼绝对路径；partial 按钮/未下载标记要在 host works 更新后重新渲染；`localFileStorageState`/`__voicePartial` 禁止持久化。
- 大文件禁止整文件进 renderer 内存：storage 上传 8 MiB 复用缓冲 + Blob；>64 MiB WAV 时长只读 64 KiB 头；大 ZIP 回退必须 pipeTo 磁盘，不得 `.blob()`。
- 文件库/下载根目录统一 `[RJ][社团] 标题 (CV 声优1 声优2)`；旧的 `<RJ>-标题` 必须 migrate/merge 到标准目录并更新 host title。
- 单文件/文件夹删除必须通过 host `/api/works/delete-files`；按 `entry.logical_path` 删除实际源文件，并清理同 `original_path` 的重复 entry、空目录和 CAS；未下载远程文件本不在本地，不得误报“已删”；三点菜单按 `data-voice-local` 动态显示下载/删除。
- 创作详情标题前禁止类型图标，标题不得 26ch 截断；头像+名称是一个主页链接，hover 整块轻微高亮+底边，平台/标签各一行；操作按钮从实际媒体行动态派生（有音频才播放，>=2 才 Shuffle，>=2 格式才显示 MP3/WAV 选择，无音频必须隐藏）；导入的 type:'file'+kind:'audio' 必须进入原生播放器/队列。
- 创作图片本地保存同时缓存 preview 缩略图 blob；缩略图/网格/hover 用本地缩略图，灯箱用原图。导入即自动缓存图片的缩略图和原图（Pawchive URL 导入与同 URL 重导；后台并发 2、不阻塞导入，与「下载所选」共用 `saveAttachmentLocally` → `putLocalFile`，不得另写下载逻辑；只管图片，zip/音频/视频/其他文件保持远程；单张失败保持远程、记 `downloadError`、不弹窗；只有缩略图的帖子只存缩略图预览，不伪造原图；开关「导入时自动保存图片到本地」默认开）。音声队列添加不得等待在线 URL 刷新，先入队、后台补签。音声收藏按钮必须写 native DB likes（音乐库专辑页可见），不能只写 localStorage。
- 音声无本地副本的叶子统一显示虚线 `远程` badge（纯在线也显示）；删除后必须按当前 host hashes prune 下载 journal 并重渲染 album；创作卡片全量可多选，标签/媒体类型 badge 可点击筛选，头像+名称整块进入创作者主页（不再单独按头像筛选），详情提供收藏+三点菜单；根级文件子行回退显示类型不是错误。
- 创作后端使用 host `creation_post`/`creation_asset`，不得混入音声 `/api/works`；本地 localStorage/IndexedDB 只是缓存/回退，删除要同步 host。
新增音声功能没写进这份约定，视为未完成。
