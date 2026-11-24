# bot-for-all

轻量多人群聊 + AI 机器人群成员，可作为单机 Docker Compose 部署的完整群聊平台。当前分支 `cmd` 已包含群聊、机器人、管理端、附件/媒体、通知、搜索、导出与生产部署能力；接手与推送步骤见 [`HANDOFF.md`](./HANDOFF.md)。

## 功能概览

- 群聊：公开/私有房间、邀请码与二维码、加入申请、成员角色、慢速模式、消息保留期、归档/收藏/分组。
- 消息：实时收发、回复、编辑历史、撤回、表情、置顶、转发（单条/批量）、草稿、定时发送、已读回执、未读定位。
- 媒体：图片灯箱（翻页/缩放/滑动）、语音、视频首帧封面、媒体库筛选与批量删除、附件配额与清理。
- 协作：全局/房间搜索、收藏消息、投票、消息翻译、通知中心（筛选/搜索/免打扰）、桌面通知。
- 机器人：全局/房间级 bot、OpenAI 兼容流式回复、联网搜索（`web_search`/`web_fetch` 工具调用，DuckDuckGo/Brave/Tavily 可切换）、SSRF 防护、上下文与频率限制、失败重试/停止。
- 管理端：用户/房间/bot/举报/公告、审计日志、趋势统计、CSV/JSON/ZIP 导出、批量封禁与删除。
- 运维：MySQL 迁移（生产用非 root 业务账号）、Redis 可选（限流 + Socket.IO 多实例 + bot 跨实例状态）、CSP 双端、Docker 生产编排、GitHub Actions CI（含生产镜像构建）。


## 前置

- Node.js 24 + pnpm
- Docker / Docker Compose
- 可选：Ollama（本地 OpenAI 兼容端点，用于真模型联调）

## 快速启动

```bash
docker compose -f docker-compose.dev.yml up -d --wait
pnpm install
cp .env.example .env
# 必填项，三项都要生成：服务端不会用默认值兜底，缺失或过短会拒绝启动
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^BOT_KEY_SECRET=.*|BOT_KEY_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(openssl rand -hex 16)|" .env
pnpm migrate
pnpm seed:admin
pnpm dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:3000
- 管理员：`.env` 里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`

### 必填与安全相关变量

| 变量 | 说明 |
|---|---|
| `JWT_SECRET` | 必填，≥32 字符；`openssl rand -hex 32` 生成 |
| `BOT_KEY_SECRET` | 必填，64 位小写 hex（32 字节）；全 0 或单一重复字符会被拒绝 |
| `ADMIN_PASSWORD` | 必填，无默认值；`openssl rand -hex 16` 生成 |
| `ALLOW_PRIVATE_BOT_URLS` | 默认 `false`；本地 demo 用 Ollama 时设为 `true` 才允许 `127.0.0.1` 等内网地址 |
| `TRUST_PROXY` | 默认 `false`；仅在反向代理后面时设置（`true` / 跳数 / `loopback`） |
| `REDIS_URL` | 可选，如 `redis://127.0.0.1:6379`；设置后限流计数走 Redis（多实例共享），Socket.IO 事件也经 Redis adapter 跨实例广播；不设或连不上则回退进程内计数与单实例广播 |
| `UPLOAD_DIR` | 可选，附件与头像落盘目录；默认 `backend/uploads`。生产 compose 挂载 `uploads` 命名卷，容器重建不丢附件与头像 |
| `ATTACHMENT_USER_QUOTA_BYTES` | 每用户附件磁盘配额（字节），默认 `209715200`（200 MiB），`0` 表示不限。上传前统计该用户全部附件（含未发送、已撤回）的 `SUM(size)`，超限返回 413 `ATTACHMENT_QUOTA_EXCEEDED` 并删除刚落盘的文件 |
| `ATTACHMENT_USER_MAX_FILES` | 每用户附件行数上限，默认 `1000`，范围 `1..100000`。上传与转发复制都在同一事务内统计该用户全部附件行数（含未发送、已撤回），达到上限返回 413 `ATTACHMENT_QUOTA_EXCEEDED` 并删除刚落盘/刚复制的文件。字节配额与行数上限独立生效，任一超限即拒绝 |
| `ATTACHMENT_ORPHAN_TTL_HOURS` | 孤立附件保留时长（小时），默认 `24`，范围 `1..8760`。上传后从未发送的附件，以及绑定到已撤回消息的附件，超过该时长后由后台清理；绑定到未撤回消息的附件永不清理。已撤回消息从 `deleted_at` 起算 |
| `ATTACHMENT_CLEANUP_INTERVAL_MS` | 清理任务间隔（毫秒），默认 `21600000`（6 小时），范围 `60000..86400000`。启动时先跑一次，之后按间隔执行；每轮最多删除 500 行，多实例用 `FOR UPDATE SKIP LOCKED` 分批领取。文件在事务提交后 best-effort 删除，缺失文件不报错，删除失败只计入日志 |
| `ROOM_RETENTION_SWEEP_MS` | 房间消息保留清理间隔（毫秒），默认 `21600000`（6 小时），范围 `60000..86400000`。启动时先跑一次，之后按间隔执行；只处理 `retention_days > 0` 的房间，每轮最多删除 500 条过期消息，置顶消息永不清理。多实例用 `FOR UPDATE SKIP LOCKED` 分批领取；消息经外键级联删除其 reaction/edit/report/收藏/投票/附件/通知，附件文件在事务提交后 best-effort 删除 |
| `AUDIT_EXPORT_ALL_MAX` | 全量审计导出 `GET /api/admin/audit/export-all` 的行数上限，默认 `100000`，范围 `1..1000000`。导出按 `id DESC` 每批 1000 行做 keyset 分页并逐批写响应（不缓存整表）；达到上限且仍有更多匹配行时响应头带 `X-Audit-Truncated: true`。同一管理员每 5 分钟只能导出一次 |
| `BOT_MAX_PER_ROOM` | 每个房间最多 room-scoped bot 数（不论 owner），默认 `10`，范围 `1..50`。`POST /api/me/bots` 超限返回 400 `BOT_LIMIT_REACHED`；供读取的 `getBotsForRoom` 与 gateway 单条消息也最多触发该数量，历史超额数据不会放大扇出。创建计数在同一事务内用 owner/room 行锁串行化，并发请求无法绕过 |
| `BOT_MAX_PER_OWNER` | 每个用户拥有的 bot 总数（global + room），默认 `20`，范围 `1..100`。禁用（软删除）的 bot 仍计入，防止反复创建/禁用撑大存储；超限返回 400 `BOT_LIMIT_REACHED`。用户与 admin 全局 bot 创建共用每用户 `10 次/分钟` 限流，超限返回 429 `RATE_LIMITED` |
| `BOT_MAX_RESPONSE_BYTES` | Provider 响应体字节上限，默认 `1048576`（1 MiB），范围 `65536..16777216`。覆盖非流式 JSON/文本、错误响应体和 SSE 累计总字节；按 reader 实际读到的字节计数，不信任 `Content-Length`。超限立即取消 reader/连接并抛 502 `BOT_RESPONSE_TOO_LARGE`，gateway 将占位消息定稿为 `error` |
| `BOT_MAX_SSE_EVENT_BYTES` | 单个 SSE 事件及未完成事件缓冲的字节上限，默认 `262144`（256 KiB），范围 `16384..1048576`。`SseParser` 在缓冲增长时即时抛错（同样的 502 `BOT_RESPONSE_TOO_LARGE`），避免无终止符的事件把内存和扫描复杂度拖成 O(n²) |
| `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL` | 可选，OpenAI 兼容翻译端点、Key 与模型。三者全部非空才启用消息翻译；缺任一（或为空）时端点返回 503 `TRANSLATION_DISABLED`。`BASE_URL` 原样拼接 `/chat/completions`，需要版本前缀时自行带上（如 `http://127.0.0.1:11434/v1`） |
| `TRANSLATE_TIMEOUT_MS` | 单次翻译请求的总超时（含读取响应体），默认 `15000`，正整数。超时、非 2xx、响应体超过 64 KiB、响应无 `choices` 或译文为空统一返回 502 `TRANSLATION_FAILED` |
| `TRANSLATE_CACHE_TTL_MS` | 成功译文在进程内缓存的有效期（毫秒），默认 `3600000`（1 小时），`0` 关闭缓存。key 为 `messageId:editedAt:targetLang`，消息编辑后自动失效；只缓存成功译文，失败（502）与未配置（503）不缓存，且不保存原文 |
| `TRANSLATE_CACHE_MAX` | 翻译缓存条目上限，默认 `500`，范围 `1..5000`；超限按 LRU 淘汰最久未使用的条目。缓存为单进程内存，多实例各自独立 |
| `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_API_KEY` | 机器人联网搜索开关，默认 `none`（不启用，请求体不带 `tools`）。`duckduckgo` 免 key 即用；`brave` / `tavily` 需同时设置 `WEB_SEARCH_API_KEY`，缺失时功能保持关闭（与翻译 provider 同一契约），非法取值在启动时被拒绝。启用后所有 enabled 机器人的主链请求自动携带 `web_search`（搜索）与 `web_fetch`（抓取网页正文）两个工具；bot-test 调试路径不受影响 |
| `WEB_TOOLS_TIMEOUT_MS` | 单次工具 HTTP 请求（搜索或抓取）的墙上时钟预算，默认 `10000`，范围 `1000..60000`。所有工具出网都走 `safeFetch` + `assertSafeBotUrl`（与机器人 provider 相同的 SSRF 防护，重定向逐跳复检），超时作为工具失败文本返回给模型，不中止整次生成 |
| `WEB_SEARCH_MAX_RESULTS` | 一次 `web_search` 交给模型的结果条数，默认 `5`，范围 `1..5` |
| `WEB_FETCH_MAX_BYTES` | 一次 `web_fetch` 最多读取的字节数，默认 `65536`（64 KiB），范围 `4096..1048576`；超限截断并附截断标记，不报错。工具执行每 bot 每分钟限 `BOT_TOOL_RATE_PER_MIN`（默认 `10`，范围 `1..1000`）次，超限以「速率受限」tool 消息回复模型而不中止生成；模型每轮最多 2 次工具调用（串行，其中 `web_fetch` 每轮≤1 次），之后请求不再携带 `tools` 强制收敛。整次生成（多轮 + 工具请求）有 `BOT_TOOL_TOTAL_TIMEOUT_MS`（默认 `180000`，范围 `10000..600000`）总时限，超时把回复定稿为 `TIMEOUT` 失败；回答末尾由服务端按实际工具结果确定性追加「来源」markdown 列表 |

`BOT_KEY_SECRET` 一旦更换，已存库的 bot API Key 将无法解密（列表里显示 `***`，需要重新填 Key）。

## 生产部署（Docker Compose）

`docker-compose.prod.yml` 起四件套：`web`（Nginx：静态 SPA + 反代）→ `backend`（Node，启动前自动迁移）→ `mysql` / `redis`（均仅内部网络，不映射宿主端口）。Redis 承载限流计数和 Socket.IO 跨实例广播（纯 pub/sub，无持久化，重启只会重置当前限流窗口），`backend` 通过 `REDIS_URL=redis://redis:6379` 使用它。镜像由 `backend/Dockerfile`、`frontend/Dockerfile` 构建，业务代码不需要改。

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# 五个必填值，全部用 hex（MYSQL_ROOT_PASSWORD / MYSQL_APP_PASSWORD 会被拼进 DATABASE_URL）
sed -i "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)|" .env.production
sed -i "s|^MYSQL_APP_PASSWORD=.*|MYSQL_APP_PASSWORD=$(openssl rand -hex 24)|" .env.production
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env.production
sed -i "s|^BOT_KEY_SECRET=.*|BOT_KEY_SECRET=$(openssl rand -hex 32)|" .env.production
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(openssl rand -hex 16)|" .env.production

# 先校验配置（不启动容器）
docker compose --env-file .env.production -f docker-compose.prod.yml config

docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

数据库账号：`backend` 的 `DATABASE_URL` 用非 root 业务账号 `chat_app`（密码为 `MYSQL_APP_PASSWORD`），由 `db/init/01-app-user.sh` 在 MySQL 数据卷首次初始化时创建（对 `chat.*` 有全部权限，迁移 / seed / 运行时共用）；root 仅用于容器初始化与健康检查。已有 `mysql-data` 卷的存量部署升级时 init 脚本不会重跑，需进 MySQL 手动执行同等内容（幂等，密码以 `.env.production` 为准）：

```sql
CREATE USER IF NOT EXISTS 'chat_app'@'%' IDENTIFIED BY '<MYSQL_APP_PASSWORD>';
ALTER USER 'chat_app'@'%' IDENTIFIED BY '<MYSQL_APP_PASSWORD>';
GRANT ALL PRIVILEGES ON chat.* TO 'chat_app'@'%';
FLUSH PRIVILEGES;
```

- 访问：`http://<host>:8080`（`WEB_PORT` 可改，例如 `WEB_PORT=80`）。
- 迁移：`backend` 启动命令是 `node dist/migrate.js && exec node dist/index.js`，无需手动 `pnpm migrate`；迁移失败容器直接退出，不会带病启动。
- 管理员：镜像不自动建号，首次部署后执行一次（幂等，改密码后重跑即同步）：
  ```bash
  docker compose --env-file .env.production -f docker-compose.prod.yml exec backend node dist/scripts/seed-admin.js
  ```
  账号/密码取 `.env.production` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。
- 健康检查：`GET /api/health`（真的查一次 MySQL）；`web` 另有 `GET /healthz`。
- 日志与停止：`... logs -f backend`、`... down`；只有 `down -v` 才会删除 MySQL 数据卷。

### 端口与反代

| 服务 | 宿主端口 | 说明 |
|---|---|---|
| web | `${WEB_PORT:-8080}` → 80 | Nginx，唯一对外入口 |
| backend | 无 | 仅 `edge` 网络内可达 `backend:3000` |
| mysql | 无 | 仅 `data` 网络内可达，数据在 `mysql-data` 卷 |
| redis | 无 | 仅 `data` 网络内可达 `redis:6379`，无持久化（限流计数 + Socket.IO 跨实例广播） |

`frontend/nginx.conf` 负责：SPA fallback（未知路径回 `index.html`）、`/api/` 与 `/socket.io/` 反代到 `backend:3000`（WS 带 `Upgrade`/`Connection` 头，`proxy_read_timeout 300s` 大于心跳间隔）、gzip、`X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy` / `Content-Security-Policy`（与后端同一份策略，`backend/test/security-headers.test.ts` 校验两份不漂移；只放行自身脚本资源、`blob:`/`data:`/https 图片媒体、ws/wss 连接，无 hash 的内联脚本一律拒绝）、`client_max_body_size 12m`（附件单文件上限 10 MB）。

附件与用户头像保存在 `uploads` 命名卷（挂载到 `/app/backend/uploads`），`docker compose down` 不会删除；只有 `down -v` 会同时清空 MySQL 与附件/头像卷。

上 HTTPS 时在外层再叠一层 TLS 终结（云 LB 或另一个 Caddy/Nginx 容器），透传 `X-Forwarded-For` / `X-Forwarded-Proto`；`backend` 的 `TRUST_PROXY=1` 已按「一跳反代」配置，限流拿到的是真实客户端 IP。

生产默认值写在 compose 里，不受本机 `.env` 影响：`NODE_ENV=production`、`ALLOW_PRIVATE_BOT_URLS=false`（机器人 baseUrl 不能指向 `127.0.0.1`/内网，需要本地 Ollama 的 demo 请走 dev 流程）、`TRUST_PROXY=1`。

compose 项目名固定为 `bot-for-all-prod`，与本地 dev compose（默认项目名取目录名）的容器、网络、数据卷互不干扰。

### 多实例（横向扩容）

`backend` 可以起多个副本：每个副本配上同一个 `REDIS_URL` 后，启动时会在注册 Socket 处理器前挂上 `@socket.io/redis-adapter`（pub/sub 各一条连接，Redis 不可用时记一条 warn 并退回单实例，不阻塞启动），关闭时随进程一起 `quit`。房间广播、通知、在线状态事件因此能到达所有副本：连在 A 副本上的客户端能收到 B 副本产生的事件。

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --scale backend=2
```

两点注意：

- 轮询（polling）传输需要粘性会话。客户端是 `transports: ['websocket', 'polling']`：websocket 连接天然粘在某个副本上，没问题；一旦降级到 polling，同一会话的请求必须落到同一副本。多副本时给 `frontend/nginx.conf` 的 `location /socket.io/` 加 `ip_hash`（Nginx 免费版没有 `sticky` 模块），或让前端强制 `transports: ['websocket']`。
- 定时消息扫描每个副本都会跑，`processDueScheduled` 用 `UPDATE ... WHERE status = 'pending'` 抢锁，同一条消息只会被一个副本投递。

## 机器人配置（本地 Ollama）

| 字段 | 值 |
|---|---|
| baseUrl | `http://127.0.0.1:11434` |
| apiKey | `ollama` |
| model | `qwen3.5:9b` |
| extraBody | `{"reasoning_effort":"none"}` |
| triggerMode | `mention` |

创建后发送 `@<botUsername> 你好` 触发流式回复。

`127.0.0.1` 属于内网地址，必须同时设置 `ALLOW_PRIVATE_BOT_URLS=true` 才能保存；云端元数据地址（`169.254.169.254`、`metadata.google.internal`、`0.0.0.0`、`::`）无论该开关如何拒绝。

## 消息翻译

`POST /api/rooms/:id/messages/:seq/translate`（仅房间成员）按需翻译一条消息，body 为 `{ "targetLang"?: string }`（1–20 字符，默认 `zh-CN`），返回 `{ text, targetLang }`。翻译结果不落库、不广播，刷新后前端不再展示；前端在气泡下方展示，并保留原文。

- 前置校验：消息不存在 404 `MESSAGE_NOT_FOUND`、已撤回 409 `MESSAGE_DELETED`、无文本 400 `MESSAGE_EMPTY`、正文超过 4000 字符 400 `MESSAGE_TOO_LONG`、非成员 403 `NOT_MEMBER`。每用户限流 20 次/分钟（`translate:<userId>`），超限 429 `RATE_LIMITED`。
- 上游调用：`${TRANSLATE_BASE_URL}/chat/completions`，`Authorization: Bearer ${TRANSLATE_API_KEY}`，请求体带 `TRANSLATE_MODEL`、只输出译文的 system 提示，以及含目标语言和原文的 user 消息。原文不会写入日志。
- 缓存：成功译文按 `messageId:editedAt:targetLang` 存在进程内，命中直接返回、不再请求上游。默认 TTL 1 小时、最多 500 条（`TRANSLATE_CACHE_TTL_MS` / `TRANSLATE_CACHE_MAX`，TTL 为 `0` 关闭），超限按 LRU 淘汰最久未使用的条目；消息编辑后 `editedAt` 变化，旧译文自动失效。只缓存成功译文，失败与未配置不缓存，缓存不保存原文。
- 超时与大小：`TRANSLATE_TIMEOUT_MS`（默认 15000）覆盖请求与响应体读取；响应体最多读取 64 KiB，按 reader 实际字节计数、不信任 `Content-Length`，超限立即取消连接。
- 失败映射：超时、非 2xx、响应过大、非法 JSON、无 `choices` 或译文为空，统一 502 `TRANSLATION_FAILED`。三者未配置完整时端点直接 503 `TRANSLATION_DISABLED`，不会发起上游请求。

## 测试

```bash
# 需要 MySQL 已启动
pnpm --filter backend test

# 可选：浏览器 E2E
pnpm exec playwright install chromium
pnpm test:e2e

# 构建
pnpm build
```

E2E 使用独立 `chat_e2e` 数据库，并以 `CAPTCHA_ENABLED=false`、`RATE_LIMIT_ENABLED=false` 启动自己的后端；请先停掉本地 `pnpm dev`（后端 `reuseExistingServer:false`，端口 3000 被占用会直接失败）。

当前基线（2026-11-02，稳定性收尾后）：后端 `874 passed / 1 skipped`（94 个测试文件），Playwright `78 passed`，`pnpm build` 通过。

## 说明

- 本地 demo 只起 MySQL；限流默认用进程内计数，`.env` 里设 `REDIS_URL` 才切到 Redis（连不上时自动回退内存，不会放行全部请求）。同理，`REDIS_URL` 也决定 Socket.IO 是否跨实例广播：单实例开发不设即可，连不上时保持单实例行为。
- 断线补洞：客户端按 `seq` 连续性判断，缺口走 `GET /api/rooms/:id/messages?afterSeq=`。
- 消息搜索：`messages.content` 使用 MySQL ngram 全文索引；2 字及以上且仅含字母/数字/CJK/空白的查询走 `MATCH ... AGAINST`（短语匹配），单字或含 `% _ \ " + - @` 等特殊字符的查询回退 `LIKE` 字面匹配。InnoDB 停用词（如 `in`/`at`）在全文路径下不命中，属 ngram 的已知取舍。
- 房间消息保留：`PATCH /api/rooms/:id` 可带 `retentionDays`（`0..3650`，`0` 表示永久保留，默认 `0`），权限与公告、慢速模式相同（房间 owner / 房间管理员 / 全局管理员）。后台任务按房间的窗口删除 `created_at` 早于阈值的消息，`pinned_at` 非空的消息永不删除；删除同时级联清理该消息的 reaction、编辑历史、举报、收藏、投票、附件与通知，附件文件在数据库事务提交后删除。
- 用户头像：`POST /api/me/avatar`（`multipart` 字段 `file`，≤2 MB，仅 PNG/JPEG/WebP/GIF，每用户 10 次/分钟）上传并替换；`DELETE /api/me/avatar` 清除。`GET /api/users/:id/avatar?v=<token>` 无需认证即可读取，响应带 `Cache-Control: public, max-age=31536000, immutable`。`users.avatar` 只存随机 32 位 hex token，文件落在 `UPLOAD_DIR/avatars/<token>.<ext>`；替换/删除会同步清理旧文件。所有用户与消息 DTO 的 `avatar` / `senderAvatar` 统一返回 `"/api/users/<id>/avatar?v=<token>"`，无头像（含旧的非 token 值）为 `null`。
- 机器人消息在生成开始即占 `seq`（`status='streaming'`），定稿后更新为 `done`，避免气泡跳位。
- 退出房间（`POST /api/rooms/:id/leave`）会立即把该用户的在线 socket 移出房间并下发 `room:revoked`，无需等客户端主动断开。
- 防滥用限流（`RATE_LIMIT_ENABLED=false` 时全部跳过）：房间搜索与全局搜索各 30 次/分钟/用户，房间导出 5 次/10 分钟/用户+房间，邀请成员与移除成员各 30 次/分钟/操作者+房间，附件上传 30 次/分钟/用户，全量审计导出 `GET /api/admin/audit/export-all` 1 次/5 分钟/管理员，超限统一 429 `RATE_LIMITED`。批量转发按条数逐条预检慢速模式与消息频率（每条一次），任一条不通过则整批不写入；目标房间开启慢速模式时只允许逐条转发（400/429 `SLOW_MODE`），源房间与目标房间相同返回 400 `INVALID_TARGET`。
- 通知只携带收件人仍有权限读取的内容：消息类通知在收件人已退出/被移出房间后 `content` 为空、`messageId`/`messageSeq` 为 `null`（列表、计数、未读数仍返回该通知），房间邀请等无消息通知不受影响；同一用户对同一房间的未读 `room_invite` 只保留一条，重新邀请会更新该行而不堆积。
