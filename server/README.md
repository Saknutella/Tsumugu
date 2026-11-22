# 文件库后端（storage host）

音声文件库的本地服务：SQLite 索引 + 内容寻址存储（CAS）+ HTTP API。

零外部依赖 —— 只使用 Node 内置模块（`node:sqlite` 要求 Node 22.5+）。

## 启动

通常不用直接跑这个目录，根目录的脚本会带好参数：

```bash
npm run server     # 只起后端
npm run dev:web    # 后端 + 前端
```

直接启动：

```bash
MONOCHROME_DATA=<data>/storage \
MONOCHROME_SOURCE=<data>/library \
MONOCHROME_PORT=5174 \
MONOCHROME_TOKEN=<token> \
node server/host-server-start.mjs
```

启动成功后 stdout 会输出**一行 JSON**（这是契约，不是日志）：

```json
{"ok":true,"service":"monochrome-storage-lab","url":"http://127.0.0.1:5174","libraryId":"…","auth":"bearer"}
```

失败时同样输出一行 JSON，`ok` 为 `false`，进程以非零码退出。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `MONOCHROME_DATA` | **必填**。库数据根（SQLite 在 `<DATA>/data/library.sqlite`） |
| `MONOCHROME_SOURCE` | 可读文件根（用户的音声目录） |
| `MONOCHROME_BIND` | 监听地址，默认 `127.0.0.1`；非回环需显式设置 |
| `MONOCHROME_PORT` | 端口，`0` 表示自动分配 |
| `MONOCHROME_TOKEN` | Bearer 令牌；设置后 `/api/*` 需鉴权，`/media/*` 使用签名 URL |
| `MONOCHROME_MEDIA_TTL_MS` | 媒体签名有效期 |

## 数据布局

```
<DATA>/
├─ data/
│  ├─ library.sqlite       索引（唯一权威）
│  └─ tmp/  trash/  assets/
└─ quarantine/             导入失败隔离区
<SOURCE>/
└─ [RJ…] [社团] 标题 (CV …)/
   ├─ 音轨文件…
   └─ .monochrome/folder.jpg   封面（唯一的伴生文件）
```

**数据库是唯一权威。** `.monochrome/` 里只放封面，不再写 `metadata.json` / `manifest.json`
——那两份是只写不读的镜像，只会多出一条可能写空社团字段的写入路径。

## 安全边界

- 默认只绑回环地址；`MONOCHROME_BIND` 设成别的地址属于运维显式决定。
- 源目录**只读**：不自动改名、移动、删除、覆盖用户已有的文件。
- 目录限制在授权根内，拒绝符号链接/联接点逃逸。
- 非本地部署务必设置 `MONOCHROME_TOKEN`，否则 API 对同网段完全开放。

## 文件

| 文件 | 职责 |
| --- | --- |
| `host-server-start.mjs` | 入口：读环境变量、启动、处理 SIGINT/SIGTERM |
| `lib/host.mjs` | 领域逻辑（work / entry / asset / 导入 / 删除） |
| `lib/host-server.mjs` | HTTP 路由与鉴权 |
| `lib/library.mjs` | SQLite 表结构与查询 |
| `lib/schema.mjs` | 版本与迁移 |
| `lib/scan.mjs` / `ingest.mjs` | 目录扫描与文件入库 |
| `lib/media.mjs` | 媒体读取、Range、签名 |
