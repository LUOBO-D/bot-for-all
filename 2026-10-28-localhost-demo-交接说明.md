# 群聊平台 + AI 机器人 — localhost Demo 方案说明

> 历史文档：这是 2026-10-28 的初始方案，代码已远超此基线。当前接手、验证、推送与部署请看根目录 [`HANDOFF.md`](./HANDOFF.md)。

日期：2026-10-28
分支：`cmd`（个人分支）
状态：0 骨架，待搭建
设计稿：`2026-10-28-group-chat-platform-design.md`（待批准）
本说明目的：移交给朋友，讲清项目在做什么、本地怎么最低成本跑起来、下一步怎么分工。

---

## 1. 项目在做什么

轻量多人在线群聊 + AI 机器人作为群成员，自研替代 Rocket.Chat/Mattermost。

- 定位：几百人同时在线 / 数千注册，单机 `2-4GB VPS + Docker Compose` 跑全套。
- 只做群聊，不做私聊。流程：注册登录 → 创建/加入房间 → 实时收发。
- 核心差异：机器人是房间特殊成员。管理员建全局 bot、房主建房间级 bot，自备 `base_url + api_key + model`，纯配置激活，不改代码不重启。
- 协议：`OpenAI 兼容 /v1/chat/completions(stream=true)`，可接 OpenAI / DeepSeek / Kimi / 通义 / Ollama / Dify。
- 技术栈（已定）：`Node.js + TS + Socket.IO | Vue3 + TS + Vite | MySQL8 + Redis7 | Nginx`。
- 关键机制：
  - 消息先落库再广播，按 `rooms.max_seq` 房间内连号，`UNIQUE(room_id, seq)` + `clientMsgId` 保幂等，断线用 `lastSeq` 补洞。
  - `HTTP 管 CRUD，WS 只管实时`；`Bot Gateway` 独立模块，LLM 挂了不影响群聊。
  - 流式用 `message:delta` 节流广播，落定再发 `message:new`。
  - `mention` 串行排队，`all` 模式 2s 去抖合并。
- 里程碑：`M1 群聊 MVP → M2 机器人 → M3 打磨`。
- 预算：基础设施约 ¥400-1100/年，LLM token 另算（Key 自备）。

---

## 2. 当前状态（交接基线）

- `main` 只有 `Initial commit`，`README.md` 1 行。
- 设计稿目前是 untracked 文件，还没进版本库。
- `cmd` 分支是你的个人分支，干净，无业务代码。

建议协作位：设计稿批准后合进 `main`，`cmd` 再 rebase，避免骨架和设计双漂移。

---

## 3. localhost 最优解（零成本）

结论：混合本地跑，`Docker` 只装基础设施。

- 不买 VPS / 域名，不上 Nginx / HTTPS / Let's Encrypt。
- 不为了轻量换 SQLite / valkey-wasm，会和 `MySQL seq连号 + Redis游标` 脱钩，M1 必返工。
- 全量 Docker 化 app 在本地反而慢（rebuild 慢），本地联调要秒级热重载。

形态：

```yaml
# docker-compose.dev.yml，只跑这两个
services:
  mysql:
    image: mysql:8
    ports: ["3306:3306"]
    environment:
      MYSQL_ROOT_PASSWORD: devroot
      MYSQL_DATABASE: chat
    volumes: [mysql-data:/var/lib/mysql]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  mysql-data:
```

- `backend`：本机 `node v24 + pnpm dev`，端口如 `3000`。
- `frontend`：本机 `Vite dev :5173`，`proxy.ws -> :3000`，不要 Nginx。
- 启动顺序（MySQL 首次初始化约 20-30s，必须等）：
  ```bash
  docker compose -f docker-compose.dev.yml up --wait
  pnpm dev
  ```
  或 backend 启动加连接重试（建议 30s / 指数退避），否则 `up 即看到登录页` 会偶发失败。
- 低内存注意：如 Redis 报 `bgsave` 失败，宿主机设 `vm.overcommit_memory=1`。
- 本机 14Gi 跑这两个容器约 600MB，无压力。

本地验证的都是官方标准路线：Socket.IO `get-started/chat` 先跑通最小聊天，再加 Redis Adapter；Vue3 用 `socket.js` 单例 + 组件内注册监听。

---

## 4. M1 demo 范围（先砍到这 4 个）

1. JWT 注册登录 + `Socket.IO handshake.auth.token` 鉴权，失败直接拒连。
2. 房间 CRUD / join + `room:join / message:send / message:new`。
3. 历史 `GET /api/rooms/:id/messages?beforeSeq=&limit=` + 重连补洞。
4. `presence`（在线成员），`typing` 可后放。

推到 M2/M3 的：bot 网关、限流、Markdown 渲染、管理后台、审核 hook、对象存储。

M1 验收信号：两个浏览器实时互聊，断网 30s 重连不丢消息。

---

## 5. 落码时必须遵守的 2 个约束

### 5.1 seq 拿号 + 落库必须在同一事务

房间消息连号是补洞验收的锚点。`LAST_INSERT_ID()` 是连接级，但只保证“同一连接内”还不够——必须 `UPDATE 拿号 + INSERT messages + COMMIT` 在同一个事务里。

反例：autocommit 下分三条执行，T1 拿 `seq=1`、T2 拿 `seq=2` 先提交先广播，客户端先收到 `seq=2` 会误判缺号触发补洞（此时 `seq=1` 还没提交，补不到），正撞“断线不丢不乱”反目标。

正确做法（单事务，同一连接内）：

```sql
BEGIN;
UPDATE rooms SET max_seq = LAST_INSERT_ID(max_seq + 1) WHERE id = ?;
INSERT INTO messages (room_id, seq, sender_id, sender_type, content)
VALUES (?, LAST_INSERT_ID(), ?, ?, ?);
COMMIT;
-- 广播放在 COMMIT 成功之后
```

原理：`UPDATE rooms WHERE id=?` 持有该房间行写锁直到 `COMMIT`，T2 的 `UPDATE` 会阻塞等待，天然按房间串行化，不会出现后拿号先可见。

### 5.2 backend 必须等 infra ready

见 §3。`healthcheck + up --wait + 连接重试` 三选二，不要裸 `up && pnpm dev`。

---

## 6. 建议骨架目录（下一步在 cmd 分支搭）

```
docker-compose.dev.yml   # 仅 mysql+redis，带 healthcheck
docker-compose.yml       # 生产用：+ nginx + app（M3 再补全）
backend/src/{routes,socket,services(db/room/message),middleware(auth,ratelimit)}
frontend/src/{views,pages,stores,api,socket}
db/migrations/           # users / rooms / room_members / messages / bots 五表先建全，bot 逻辑 M2 再写
.env.example
```

先搭架不写业务，`up --wait` 后看到登录页 + 空房间页即算骨架通。

---

## 7. 交接 checklist

- [ ] 设计稿是否批准、由谁合进 main
- [ ] cmd 分支是否 rebase 到最新 main
- [ ] `docker compose -f docker-compose.dev.yml up --wait` 是否一次通过
- [ ] M1 四件套是否按 §4 验收
- [ ] seq 原子语句、JWT 鉴权、XSS 纯文本渲染是否落实

---

## 8. 信息来源

本地聚合搜索，两路并行召回，6/8 引擎正常（`brave 402 / deepseek 401` 跳过，无 Jina Key 降级为 RRF）：

- Socket.IO 官方聊天入门：https://socket.io/get-started/chat
- Socket.IO 多实例/Redis：https://socket.io/get-started/private-messaging-part-4
- Socket.IO + Vue3：https://socket.io/how-to/use-with-vue
- Express + Redis + Compose v2：https://codewithhugo.com/setting-up-express-and-redis-with-docker-compose
- Redis Docker 本地开发：https://geshan.com.np/blog/2022/01/redis-docker

环境实测：`Docker 29.9 / Compose v5.6 / node v24.19.0 / 14Gi RAM`。
