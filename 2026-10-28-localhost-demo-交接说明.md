# 群聊平台 + AI 机器人 — localhost Demo 方案说明

首次编写：2026-10-28
本次更新：2026-11-01（原"0 骨架"版本作废，按 `cmd` 分支实际代码重写）
分支：`cmd`（个人分支）
基线提交：`7d597e0` feat: implement local group chat + AI bot demo
设计稿：`docs/superpowers/specs/2026-10-28-group-chat-platform-design.md`（唯一事实源）
审计详情：`docs/2026-11-01-架构审计与优化方案.md`
本说明目的：讲清项目现在做到哪了、架构长什么样、要优化什么、本地怎么零成本跑起来。

---

## 1. 项目在做什么

轻量多人在线群聊 + AI 机器人作为群成员，自研替代 Rocket.Chat/Mattermost。

- 定位：内部使用，几百人同时在线，单机 2–4GB VPS + Docker Compose 跑全套。
- 只做群聊，不做私聊；所有房间公开，无私密房。
- 核心差异：机器人是房间特殊成员。管理员建全局 bot、房主建房间级 bot，自备 `base_url + api_key + model`，纯配置激活，不改代码不重启。
- 协议：`OpenAI 兼容 /v1/chat/completions(stream=true)`，可接 OpenAI / DeepSeek / Kimi / 通义 / Ollama / Dify。
- 技术栈：`Node.js + TS + Socket.IO | Vue3 + TS + Vite + Element Plus | MySQL 8.4 |（Redis 多实例阶段再接）`。
- 里程碑：`M1 群聊 MVP → M2 基础机器人 → M3 拟人化大肥鱼 → M4 打磨与内部上线`。
- 预算：基础设施约 ¥300–920/年（国内 VPS 纯 IP 免备案），LLM token 另算（Key 自备）。

## 2. 当前进度（代码实证）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 群聊 | ✅ 已实现 | 注册登录、房间 CRUD/加入、实时消息、连号补洞、历史分页、在线状态、正在输入 |
| M2 基础机器人 | ✅ 已实现 | bot CRUD（管理员全局 + 房主房间级）、挂载、OpenAI 兼容流式回复、@/全量触发、超时降级、SSRF 防护 |
| 超出设计的部分 | ✅ 已实现 | 消息编辑/删除/置顶/表情回应、消息搜索、已读游标、命令面板 |
| M3 拟人化大肥鱼 | ⬜ 未开始 | 角色卡、分层记忆、作息、主动发言、Agent 工具、SearXNG 均未实现 |
| M4 交付 | ⬜ 未开始 | 无 Dockerfile/生产 compose/Nginx，无管理后台前端，无 APK/PWA |

代码规模：101 个文件，约 8,100 行 TS/Vue；后端测试 75 用例，Playwright E2E 5 用例，含假 OpenAI 服务端与压测脚本。

## 3. 架构总览

```
Vue3 SPA（视图 / Pinia / socket.io-client + axios）
        │  Vite 代理 :5173 → :3000（生产 Nginx 未配置）
Node.js 后端（Express 4 + Socket.IO 4）
  ├─ HTTP API 层：middleware(JWT/限流/错误) + routes(auth/rooms/me-bots/admin)
  ├─ 实时层：socket(join/leave/watch) + presence（进程内 Map）
  ├─ 服务层：services user/room/message/bot（seq 事务、先落库后广播）
  └─ 机器人子系统：trigger → queue → gateway → provider(HTTP/SSE) + context
        │                                    └─ url(SSRF) / crypto(AES-GCM)
MySQL 8.4（users/rooms/room_members/messages/bots/schema_migrations）
外部：OpenAI 兼容 LLM（任意厂商或本机 Ollama）
```

关键机制：

- **消息可靠性**：`UPDATE rooms SET max_seq = LAST_INSERT_ID(max_seq+1)` 与 `INSERT messages` 在同一事务，靠房间行锁串行化，提交后才广播；客户端按 `seq` 连续性补洞（`GET /api/rooms/:id/messages?afterSeq=`）。
- **机器人流式**：生成开始即占 `seq`（`status='streaming'`），定稿更新为 `done`，避免气泡跳位；启动时 `sweepStreaming()` 清理崩溃残留。
- **队列语义**：`mention` 按 `roomId:botId` 串行链式执行；`all` 模式 2 秒去抖只回最新一条。
- **上下文**：`context.ts` 拼 `system_prompt + 最近 20 条消息`（上限 6000 字符），自己消息映射为 `assistant`，他人消息带 `display_name` 前缀。
- **安全**：JWT（HTTP 与 WS 握手共用）、AES-256-GCM 加密 bot Key、SSRF 拦截内网与云元数据地址、zod 强校验、`marked + DOMPurify` 渲染。

文件地图：

```
backend/src/{app,index,config,db}.ts        # 装配、启动、配置、连接池
backend/src/routes/{auth,rooms,me-bots,admin}.ts
backend/src/socket/{index,broadcast}.ts
backend/src/services/{user,room,message,bot,presence}.ts
backend/src/bot/{gateway,provider,queue,trigger,context,sse,url,crypto,cache}.ts
db/migrations/0001_init.sql, 0002_message_actions.sql
frontend/src/{views,components,stores,socket,api}
backend/test/*.test.ts（75 用例）  e2e/chat.spec.ts（5 用例）
```

## 4. 架构优化方案

原则：**先补"会被未来需求倒逼返工"的接缝，不碰现在跑得好的部分。**

### 4.1 P0 阻塞项

1. **注册改邀请制**：当前是开放注册 + 图形验证码，与"仅内部使用"冲突。
   新增 `0003_invites.sql`（`invite_codes`）→ `POST /api/admin/users`、`POST /api/admin/invites` → 注册改为邀请码激活 → 前端注册页改激活页；`svg-captcha` 依赖可退役。
2. **补部署层**：多阶段 Dockerfile、`docker-compose.yml`（nginx + app + mysql + redis + searxng）、自签 CA 与 Nginx 配置；APK `networkSecurityConfig` 信任自签 CA（M4）。
3. **单实例假设接口化**：`presence` / `ratelimit` / `bot queue` 三处内存实现，抽成 `PresenceStore` / `RateLimiter` / `BotJobQueue` 接口，**只加抽象、默认仍内存实现**，Redis 实现留到多实例阶段。README 注明"当前仅支持单实例"。
4. **文档归一**：以 `docs/` 新版设计稿为唯一事实源；根目录旧版设计稿删除或替换；本说明持续维护。
5. **补 CI**：GitHub Actions 跑 typecheck + vitest（MySQL service）+ build，可选 E2E。

### 4.2 P1 质量项

- 主进程加优雅停机（`SIGTERM/SIGINT`）：停新连接 → 取消在途 bot 任务 → 流式定稿或标 error → `io.close()` → `pool.end()`。
- `bot/sse.ts` 增加 `flush()`，处理流尾不足一个空行的事件；显式忽略 `:` 心跳行；补跨包中文与尾包两个单测。
- 消息搜索当前为 `LOCATE` 全表扫描，数据量大后改 `FULLTEXT(ngram)`（与 M3 记忆检索共用方案）。
- 补管理后台前端（邀请码、账号停用、bot 配置、角色卡回滚、记忆浏览）。
- 补两个验收级测试：断网 30s 重连不丢消息；流式中途取消/超时。
- `package.json` 声明 `engines.node` + `.nvmrc`（README 要求 Node 24，本机 22 待实测）。
- 迁移加 `GET_LOCK` 防并发；连接池显式 `charset/timezone/connectionLimit`。

### 4.3 P2 为 M3 预留形状（改动最小、收益最大）

- **`context.ts` 改装配器**：`assemble([persona, memory, summary, recentMessages(20)])`，M3 只新增 provider、不动主链路。
- **`provider.ts` 预留 tools 通道**：请求支持 `tools/tool_choice`，流式解析支持 `delta.tool_calls` 分片累积；不支持 tools 的供应商自动降级为纯文本。
- **`trigger.ts` 升级判定器**：返回 `{ trigger, mode: 'fast'|'companion', reason }`，替代布尔分支，容纳"快速路径"与"companion speak 决策门"。
- **`BotJob.trigger` 改可选**：让"主动发言"这类非消息触发型任务能进同一队列。
- **新表一次迁移到位**：`persona_cards` / `persona_versions` / `bot_memories`（FULLTEXT ngram + 衰减字段）/ `bot_memory_log` / `invite_codes`；`bots` 增加 `persona_level`、`schedule_json`、`proactive`。

### 4.4 明确不做

不上 Redis（单实例阶段）、不换 SQLite（破坏连号语义）、不引入 ORM/NestJS 重写、不上向量库（M3 先用 FULLTEXT）、不做微服务/K8s、不提前做图片消息与已读回执。

## 5. localhost 零成本启动

### 路线 A：MySQL 便携版（推荐，不装 Docker）

适用：本机没有 Docker、不想装 Docker Desktop 的情况。

```bash
# 1) 下载并解压到工作区外（已验证可下载，支持断点续传）
#    https://cdn.mysql.com//Downloads/MySQL-8.4/mysql-8.4.0-winx64.zip
#    解压到 C:\dev\mysql-8.4.0

# 2) 初始化并启动（数据目录自定，不要放进仓库）
mysqld --initialize-insecure --datadir=C:\dev\mysql-data
mysqld --port=3306 --datadir=C:\dev\mysql-data

# 3) 建库（与 .env 的 DATABASE_URL 对应）
mysql -uroot -e "CREATE DATABASE chat CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

# 4) 依赖与配置
pnpm install
cp .env.example .env
# 生成三个必填密钥（Git Bash 自带 openssl）：
# JWT_SECRET / BOT_KEY_SECRET：openssl rand -hex 32
# ADMIN_PASSWORD：openssl rand -hex 16

# 5) 初始化与启动
pnpm migrate && pnpm seed:admin
pnpm dev        # 后端 :3000，前端 :5173
```

### 路线 B：Docker（有 Docker Desktop 时）

```bash
docker compose -f docker-compose.dev.yml up -d --wait   # 只起 MySQL 8.4
pnpm install && cp .env.example .env                    # 填三个密钥
pnpm migrate && pnpm seed:admin && pnpm dev
```

### 验证清单

- `curl http://127.0.0.1:3000/api/health` → `{ ok: true, db: 'up' }`
- `pnpm --filter backend test` → 75 用例通过（需 MySQL 在线）
- 两个浏览器打开 `http://127.0.0.1:5173` 互聊；断网 30s 重连不丢消息
- 机器人联调（零 API 费用）：`pnpm fake:openai` 起假模型服务，或本机 Ollama
  （`baseUrl=http://127.0.0.1:11434`、`ALLOW_PRIVATE_BOT_URLS=true`），发送 `@<botUsername> 你好` 看流式回复
- 可选 E2E：`pnpm exec playwright install chromium && pnpm test:e2e`（先停 `pnpm dev`，E2E 自起后端并占用 :3000）

### 本机实测记录（2026-11-01）

环境：Windows 10 / Node v22.22.2 / pnpm 10.34.5 / MySQL 8.4.0 便携版（`C:\dev\mysql-8.4.0-winx64`，数据目录 `C:\dev\mysql-data`，root 密码见 `.env`）。**未使用 Docker。**

已验证通过：

| 项 | 结果 |
|---|---|
| 依赖安装 | 287 个包，`pnpm install` 3 分 6 秒（无报错） |
| 迁移 | `0001_init` + `0002_message_actions` 均 applied，7 张表（含 `message_reactions`） |
| 管理员种子 | `admin` 创建成功（id=1） |
| 健康检查 | `{"ok":true,"db":"up"}` |
| 登录 / 房间 / 历史 | 管理员登录、创建房间「验收测试房」、房间列表正常 |
| WebSocket 实时 | 连接鉴权通过，`room:join` 返回 `{ok:true,lastSeq}`，`message:send` 立刻收到 `message:new`（seq=1） |
| 机器人流式 | 挂载假模型 bot 后 @ 触发：收到 2 个 `message:delta` + `message:final`，落库 `sender_type=bot`、`status=done`（seq=2） |
| UI 全链路 | Playwright 实测：登录 → 房间列表 → 聊天页 → 输入框发消息 → 机器人回复渲染（`docs/screenshots/01-04`） |

**已知问题（本次实测发现，尚未修）：**

1. **消息时间偏移 8 小时**（P1）：`messages.created_at` 用 `DATETIME` 存本地时间，mysql2 按 UTC 解析后再被前端本地化，显示比真实时间快 8 小时。修法二选一：连接池加 `timezone: 'local'`，或建表/写入统一用 UTC 并在前端本地化。属 §4.2 连接池配置项。
2. **前端只监听 IPv6**：Vite 默认绑 `localhost`（解析到 `::1`），用 `http://127.0.0.1:5173` 会 502，请用 `http://localhost:5173`。若要兼容，可在 `vite.config.ts` 的 `server` 加 `host: true`。
3. **假模型服务需手动常驻**：`pnpm fake:openai`（端口 4010）关闭后，指向它的 bot 会报错；长期联调建议改用本机 Ollama。

### 一键启停脚本

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-up.ps1    # 起 MySQL + 前后端 + 开浏览器
powershell -ExecutionPolicy Bypass -File scripts\dev-down.ps1  # 停前端/后端/MySQL
```

脚本会检测端口占用、等待就绪，最后打印访问地址；`.env` 里的管理员密码不会写入任何脚本或文档。

### 注意事项

- 不要提交 `.env`（含密钥），`.gitignore` 已覆盖；`BOT_KEY_SECRET` 更换后已存 bot Key 无法解密，需重填。
- MySQL 数据目录、便携版解压目录都放在仓库外，避免误提交。
- 后端启动有 `waitForDb()`，MySQL 未就绪会自动等待，但仍建议先起库再起后端。

## 6. 推进顺序

| 阶段 | 内容 | 产出 |
|---|---|---|
| S0 跑通 | 按 §5 本地启动，过验证清单 | 可演示的 M1+M2 |
| S1 补接缝 | P0 全部 + 优雅停机 + SSE flush | 不再被未来需求倒逼返工 |
| S2 M3 数据层 | 新表迁移、context 装配器、provider tools、角色卡 CRUD/回滚 | 大肥鱼"记得住、演得像" |
| S3 M3 调度层 | 作息状态机、主动发言（防骚扰）、睡眠整理、SearXNG | 大肥鱼"活着" |
| S4 交付 | 生产 compose + Nginx + 自签 CA、管理后台、APK/PWA | 内部上线 |

**S1 的接口抽象必须先于 S2**，否则 M3 会在内存队列与上下文拼装两处同时积累返工。

## 7. 协作约定

- 设计稿以 `docs/superpowers/specs/` 下版本为准，改动走新日期文件或追加决策记录，不回改旧结论。
- 功能分支从 `cmd` 切出，完成后合回；`main` 仅在里程碑验收后更新。
- 提交避免单次巨型提交：按"迁移 / 接口 / 前端 / 测试"拆分，便于 review 与回滚。

## 8. UI 改造：深海沉浸主题（2026-11-01）

目标：把默认 demo 界面提升到设计奖项级别的观感，同时**不改数据流、不改组件契约**，保证功能零回归。

### 8.1 设计方向

- **基调**：深海蓝底（#050A15）+ 生物荧光青（#48E6C5）+ 珊瑚橙（#FF8F5E，专用于机器人）。
- **材质**：毛玻璃面板（blur 22px + 半透明渐变 + 1px 冷光描边 + 顶部内高光），替代原来的实色"墨纸"。
- **排版**：显示级标题 40–68px、负字距；正文 13–15px；功能性微文本统一 9–11px 等宽体、0.2em 字距（时间、编号、标签）。
- **动效**：环境光缓慢漂移（26s）、鲸鱼游动（14s）、面板入场、消息逐条浮起、路由淡入淡出；全部在 `prefers-reduced-motion` 下关闭。

### 8.2 改动清单

| 文件 | 改动 |
|---|---|
| `frontend/src/styles/deepsea.css` | 新增，约 900 行：令牌重映射、玻璃基元、登录场景、房间页、聊天三栏、输入区、成员栏、Element Plus 暗色化、响应式、焦点可见性 |
| `frontend/src/main.ts` | 在 `style.css` 后引入主题层（覆盖式，不改旧文件） |
| `frontend/src/views/LoginView.vue` | 重写：左侧大标题 + 信号标签 + 手绘鲸鱼 SVG，右侧玻璃登录卡；保留 `data-testid` |
| `frontend/src/views/RegisterView.vue` | 同上结构，保留验证码逻辑与 `data-testid` |
| `frontend/src/views/RoomListView.vue` | 重写：编号索引、巨号水印、主推大卡（跨两列）、三步引导、最近动态（真实数据）、底栏元信息 |
| `frontend/src/App.vue` | 路由过渡（out-in 淡入位移） |

**策略说明**：旧 `style.css` 3,435 行未删改，全部通过 CSS 变量重映射完成换肤（旧样式仅 2 处硬编码色值）。这样弹窗、抽屉、命令面板等 10 余个组件自动继承新主题，回归风险最低。

### 8.3 验证结果

- Playwright 全链路：登录 → 房间页 → 进入房间 → 发送 @ 消息 → 机器人流式回复，**零 console 错误、零 pageerror**。
- 桌面 1440×900 与移动 390×844 均无横向溢出。
- 生产构建通过（`vue-tsc` 无类型错误）。
- 截图：`docs/screenshots/ui-01-login.png`、`ui-02-rooms.png`、`ui-03-chat.png`、`ui-04-mobile-login.png`、`ui-05-register.png`。

### 8.4 已知取舍与后续

- **未引入 Tailwind / GSAP**：现有类名体系已足够，CSS 变量 + 原生 keyframes 能达到同等观感且零迁移风险；若后续需要复杂滚动编排，再单独引入 GSAP。
- **Element Plus 保留**：仅做暗色变量覆盖，弹窗/抽屉/消息提示已统一为玻璃质感，但未做组件级重绘。
- **构建包体 1.30MB（gzip 427KB）**：Element Plus 全量引入所致，后续可改按需引入或 `manualChunks` 分包。
- **待做**：管理后台页面（邀请码/封禁/机器人）、移动端抽屉内样式细化、大肥鱼 IP 插画（需 AI 生图，约 5–10 credits/张）、消息代码块高亮。
