# bot-for-all

轻量多人群聊 + AI 机器人群成员。本仓库当前是本地 demo（M1 群聊 + M2 机器人）。

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

`BOT_KEY_SECRET` 一旦更换，已存库的 bot API Key 将无法解密（列表里显示 `***`，需要重新填 Key）。

## 机器人配置（本地 Ollama）

| 字段 | 值 |
|---|---|
| baseUrl | `http://127.0.0.1:11434` |
| apiKey | `ollama` |
| model | `qwen3.5:9b` |
| extraBody | `{"reasoning_effort":"none"}` |
| triggerMode | `mention` |

创建后发送 `@<botUsername> 你好` 触发流式回复。

`127.0.0.1` 属于内网地址，必须同时设置 `ALLOW_PRIVATE_BOT_URLS=true` 才能保存；云端元数据地址（`169.254.169.254`、`metadata.google.internal`、`0.0.0.0`、`::`）无论该开关如何都拒绝。

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

## 说明

- 本地 demo 只起 MySQL；Redis 留给多实例阶段。
- 断线补洞：客户端按 `seq` 连续性判断，缺口走 `GET /api/rooms/:id/messages?afterSeq=`。
- 机器人消息在生成开始即占 `seq`（`status='streaming'`），定稿后更新为 `done`，避免气泡跳位。
- 退出房间（`POST /api/rooms/:id/leave`）会立即把该用户的在线 socket 移出房间并下发 `room:revoked`，无需等客户端主动断开。
