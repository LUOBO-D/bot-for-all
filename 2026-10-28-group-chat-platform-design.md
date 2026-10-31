# 多人群聊平台 + AI 机器人接入 — 设计草案

日期：2026-10-28
状态：待用户批准
	下一阶段：superpowers:writing-plans（实施计划）

---

## 1. 意图与动机

搭建一个**多人同时在线的群聊网站**：用户注册登录后，创建或加入聊天室（房间），在房间内实时收发消息。

平台从第一天起就**预留聊天机器人接口**：机器人是房间里的一种特殊成员，**管理员或房主**通过配置 API 地址与密钥即可"激活"机器人，让它参与群聊（各自管理自己的 Key，互不可见）。机器人接入层做成 **OpenAI 兼容 API** 协议（事实标准），因此不绑定任何单一模型厂商——OpenAI、DeepSeek、通义、Kimi、本地 Ollama、Dify/FastGPT 平台发布的 Agent 应用，只要提供 OpenAI 兼容端点都能接。

**为什么做：**
- 用户需要一个自主可控、体量轻的群聊平台，而不是 Rocket.Chat/Mattermost 这类重型企业 IM。
- AI 机器人是平台的差异化能力，且接口先行能避免后补集成时的架构返工。

## 2. 目标 / 非目标 / 反目标

**目标：**
- 多用户同时在线：小规模定位，**几百人同时在线**（≈ 总注册用户数千级）。
- 只做群聊（聊天室/房间），**不做私聊（1 对 1 DM）**——这是用户明确的决策。
- 实时消息：毫秒~秒级房间内广播；断线重连后能补齐错过的消息。
- 机器人作为群成员接入：支持 @机器人 触发与全量消息触发两种模式；回复流式逐字显示。
- 激活方式 = 纯配置：填 base URL + API Key + 模型名，无需改代码。
- 单机部署：一台 2–4GB 内存服务器 + Docker Compose 跑起来。

**非目标（本期不做，但架构不堵死）：**
- 私聊/DM（数据模型里 `room` 是唯一会话单元，将来加私聊 = 一种两人固定房间，可平滑演进）。
- 音视频通话、文件传输（图片消息列二期）。
- 多实例水平扩展（代码层面预留：Socket.IO Redis Adapter、无状态 HTTP 层）。
- 手机 App（响应式 Web 即可）。

**反目标（技术上实现了也算失败）：**
- 机器人回复"卡住不流式"——用户看到 10 秒白屏等整段回复。
- 断线重连后消息丢失或乱序，用户被迫刷新页面。
- 激活机器人需要改代码或重启服务。
- 单条密钥泄露能读出全平台聊天记录（已明确边界：bot Key 只能作用于其所在房间的上下文；管理端也不提供全平台消息批量导出工具，管理员只有单房间的管理处置能力）。

## 3. 约束

- 目标规模：**几百人同时在线**，单房间活跃人数预计 < 200。
- 部署预算：单台 2–4GB 内存 VPS，Docker Compose。
- 技术栈（用户已选定）：后端 **Node.js + TypeScript + Socket.IO**；前端 **Vue 3 + TypeScript + Vite**；存储 **MySQL 8 + Redis**。
- 开发人力：个人开发者，需要开发速度优先、可单独维护的架构。
- 预算上限：基础设施 ≈ ¥1100/年以内，全部固定成本、零按量付费；LLM token 费用不计入（见 §11）。

## 4. 方案选型（Approaches）

| # | 方案 | 取舍 | 结论 |
|---|------|------|------|
| A | **自研轻量平台**：Node.js + Socket.IO 单体，房间=群聊，机器人接口内置 | 架构干净、完全可控、开发最快；功能全靠自己实现 | ✅ **用户选定** |
| B | 基于 Rocket.Chat/Mattermost 二次开发 | 功能开箱即用但体量重（Rocket.Chat 需 4GB+、Meteor+MongoDB 技术栈老旧；AGPL-3.0 协议对闭源商业化有传染风险） | ❌ 否决 |
| C | 对齐 echo-im 自研全功能 IM（私聊/离线/回执/文件全做） | 功能对标商业 IM，但工作量大数倍，且用户明确不要私聊 | ❌ 否决 |

机器人接入形态同样比较过三条路：仅私聊助手（用户已否决——平台不做私聊）、群成员+网关（选定）、先私聊后群聊（随"无私聊"决策失效）。

**借鉴但不照搬的开源经验**（来自调研）：
- **echo-im 的 IM 四大原则**：实时性、不丢失、幂等性、时序性 → 转化为本项目的"房间消息连号 + 游标补洞"机制（见 §7.2，按无私聊场景大幅简化）。
- **Socket.IO 官方 Room 模型**：房间是服务端概念，天然支持按房间广播、断线自动退房、Redis Adapter 多实例扩展。
- **融云/Dify 生态的机器人接入模式**：机器人=独立用户类型 + Webhook 回调 + OpenAI 兼容平台对接 → 本项目采纳"特殊用户类型 + OpenAI 兼容网关"，Webhook 列为二期。
- **SSE 流式最佳实践**：delta 逐段转发、UTF-8 跨包边界用流式解码、心跳保活、中途取消。

## 5. 架构总览

```
┌─────────────────────────────────────────────┐
│ 浏览器 (Vue 3 SPA)                           │
│  HTTP: 登录/房间管理/历史消息 (REST + JWT)     │
│  WS:   Socket.IO 连接 (握手带 JWT)            │
└──────────────┬──────────────────────────────┘
        HTTPS / WSS (Nginx 反代)
┌──────────────▼──────────────────────────────┐
│ Node.js 单体服务 (Express + Socket.IO)        │
│ ├─ REST API 层（无状态，可多实例预留）          │
│ ├─ 实时网关层（Socket.IO，Redis Adapter 预留） │
│ ├─ 房间服务：成员管理、广播、消息连号           │
│ ├─ 消息服务：先落库→后广播，历史分页           │
│ └─ 机器人网关 (Bot Gateway)                   │
│     ├─ Bot 调度：识别触发（@ 或 全量）          │
│     ├─ OpenAI 兼容适配器：POST {baseUrl}/     │
│     │   v1/chat/completions (stream=true)    │
│     ├─ SSE 解析 → 逐 delta 广播回房间          │
│     └─ 取消/超时/降级（非流式兜底）             │
└───────┬──────────────┬───────────────────────┘
        │              │
   ┌────▼────┐    ┌────▼─────┐    ┌──────────────┐
   │ MySQL 8 │    │ Redis 7  │    │ 外部 LLM API  │
   │ 用户/房间 │    │ 在线状态  │    │ (OpenAI 兼容) │
   │ 消息/机器人│    │ 游标/限流 │    │ 任意厂商/自建  │
   └─────────┘    └──────────┘    └──────────────┘
```

**关键架构原则：**
1. **消息先落库再广播**（write-then-broadcast）：MySQL 是消息的唯一事实源，Redis 与内存只做加速。
2. **HTTP 与 WS 职责分离**：REST 管无状态 CRUD，Socket.IO 只管实时事件（发消息、广播、正在输入、在线状态）。
3. **Bot Gateway 是独立模块**：与聊天主链路解耦，LLM API 慢/挂不影响群聊本身。
4. **无状态水平扩展预留**：Socket.IO 换 Redis Adapter + Nginx ip_hash 即可多实例，本期不实施。

## 6. 核心概念与数据模型

```
users        (id, username, password_hash, display_name, avatar,
              type: 'human' | 'bot',               -- 机器人也是 users 行
              role: 'admin' | 'user',              -- 仅对 human 有意义
              status: 'active' | 'banned',         -- 封禁位（公网防滥用）
              created_at)

rooms        (id, name, topic, owner_id, is_public, invite_code,
              max_seq, created_at)                 -- max_seq = 消息连号游标

room_members (room_id, user_id, role: 'owner'|'admin'|'member'|'bot',
              last_read_seq, joined_at)            -- 人类与机器人统一管成员
                                                   -- last_read_seq = 未读数游标

messages     (id, room_id, seq, sender_id, sender_type: 'user'|'bot'|'system',
              content, reply_to_id, created_at)
              UNIQUE(room_id, seq)                 -- 连号防重，补洞依据
              -- sender_id 恒指向 users.id（bot 消息也指向其 users 行）

bots         (user_id, name, avatar, provider: 'openai_compatible',
              base_url, api_key_encrypted, model, system_prompt,
              trigger_mode: 'mention'|'all', owner_user_id,
              scope: 'global' | 'room',            -- 管理员建全局 / 房主建房间级
              temperature, max_tokens, enabled)
              -- 与 users 一对一：bot 的身份在 users，配置在 bots
```

设计说明：
- **注册模型（用户已定）**：开放注册，用户名 + 密码 + 图形验证码，**无邮箱字段**；密码找回走管理员重置，不引入 SMTP 依赖。
- **bot 身份统一**（我的裁量，builder check 结论）：每个机器人同步创建一个 `type='bot'` 的 users 行，`bots` 表只做 1:1 配置扩展。这样 `messages.sender_id` 恒指向 users.id，成员列表、@提及解析、前端渲染全部走统一 join，不再需要单独的 room_bots 分表。
- **seq 连号**：每房间独立、严格递增（`UPDATE rooms SET max_seq=max_seq+1 ... ` 或 Redis INCR + 落库），是消息不丢不重的锚点。
- **机器人 Key 归属（用户已定）**：管理员可建全局机器人；房主可为本房间建机器人，Key 加密存储且仅创建者可改。
- 私聊将来若要加：`rooms` 加 `is_dm` 标志 + 两个固定成员即可，不需要改表结构。

## 7. 关键机制设计

### 7.1 实时消息流（Socket.IO 事件）

| 事件 | 方向 | 载荷 | 说明 |
|------|------|------|------|
| `room:join` / `room:leave` | C→S | roomId | 进入/切换房间，服务端校验成员身份后 `socket.join(room)` |
| `message:send` | C→S | {roomId, content, clientMsgId} | clientMsgId 客户端生成，幂等去重 |
| `message:new` | S→C | {roomId, seq, sender, content, ...} | 广播给全房间（含发送者，回执用途） |
| `message:delta` | S→C | {roomId, botMsgId, delta, done} | 机器人流式回复的增量帧 |
| `typing` | C→S / S→C | {roomId, userId, isTyping} | 正在输入提示 |
| `presence` | S→C | {roomId, onlineUsers} | 在线成员变化 |

断线重连：Socket.IO 自带；重连后客户端上报 `lastSeq`，服务端按 `seq` 区间补发缺口（拉 REST 分页接口亦可）。

### 7.2 消息可靠性（借鉴 echo-im，按"只群聊+小规模"简化）

- **不丢失**：先落库 → 拿到 seq → 再广播。客户端发现 `seq` 跳号（本地最大 seq+1 ≠ 收到的 seq）→ 主动调 REST 补洞接口。
- **幂等**：客户端 `clientMsgId` + 服务端 `UNIQUE(room_id, seq)` 双保险；重复消息静默丢弃。
- **时序**：房间内以 seq 为唯一排序依据，天然有序。
- **离线消息**：不专门做离线队列——上线/进房时按 `last_read_seq` 拉最近历史即可（几百人规模足够）。

### 7.3 机器人接入（本项目核心差异点）

**激活流程（纯配置，不重启）：**
1. 管理员（全局机器人）或房主（本房间机器人）在后台"机器人管理"创建 bot：填名称、base_url、api_key、model、system_prompt、触发模式。Key 加密存储，仅创建者可见/可改。
2. 将 bot "邀请"进目标房间（写 room_members，即时生效——广播一条 system 消息"XX 机器人已加入"）。
3. `enabled` 开关与限流配置热更新，内存缓存 30s TTL。

**消息处理链：**
```
用户消息落库+广播
   ↓ (房间内有 enabled bot，且触发条件满足)
Bot Gateway 异步调用：
  POST {base_url}/v1/chat/completions
  { model, stream:true, messages:[system_prompt, 近N条房间消息, 本条消息] }
   ↓ SSE data: {"choices":[{"delta":{"content":"..."}}]}
逐 delta → 聚合到缓冲 → 每 ~80ms 或 16 个 delta 节流一次
   → Socket.IO 广播 message:delta（全房间打字机效果）
   ↓ [DONE]
完整消息落库（sender_type='bot'，占一个 seq）→ message:new 定稿
```

**工程要点：**
- **上下文窗口**：只带最近 N 条（默认 20）房间消息 + system_prompt，超长截断（滚动摘要列二期）。
- **背压与节流**：delta 广播做合帧节流，避免高频广播打爆客户端渲染。
- **UTF-8 跨包**：SSE 解析用流式 TextDecoder，防中文乱码。
- **超时与取消**：LLM 响应 > 60s 则中止并广播错误 system 消息；用户可发 `/stop` 取消正在生成的回复（一期可先只做超时）。
- **非流式降级**：供应商不支持 stream 时退回整段回复，一次性 `message:new`。
- **限流**：每 bot 每分钟调用数上限（Redis 计数），防止房间刷屏刷爆 API 账单。
- **并发与队列语义**（我的裁量，builder check 结论）：同一房间同一 bot 同时只跑一个生成任务。`mention` 模式逐条排队串行回复；`all` 模式用 2 秒去抖合并——去抖窗口内的多条消息合并为一次调用，只针对最新内容回复（防止活跃房间刷屏）。被限流丢弃的触发广播一条 system 提示（"机器人调用已达上限，稍后再试"），不静默。
- **OpenAI 兼容意味着可直接接入**：OpenAI/DeepSeek/Kimi/通义/智谱、本地 Ollama、LiteLLM 网关、Dify/FastGPT 发布的 OpenAI 兼容端点。Webhook 自定义机器人（消息转发到任意外部服务）列二期。

## 8. API 概要（REST）

```
POST /api/auth/register|login          # JWT（开放注册：用户名+密码+图形验证码）
GET  /api/rooms                        # 公开房间列表 / 我的房间
POST /api/rooms                        # 创建房间（创建者即房主）
POST /api/rooms/:id/join               # 加入（公开房/邀请码）
GET  /api/rooms/:id/messages?beforeSeq=&limit=   # 历史消息分页 + 补洞
GET  /api/rooms/:id/members            # 成员列表（人类与机器人统一）
--- 房主（自备 Key，管自己房间级机器人）---
CRUD /api/me/bots                      # 我的机器人配置（api_key 加密，仅回脱敏值）
POST /api/me/rooms/:id/bots            # 房主房间挂载/卸载自己的机器人
--- 平台管理员 ---
CRUD /api/admin/bots                   # 全局机器人配置
POST /api/admin/rooms/:id/bots         # 任意房间挂载/卸载
PATCH /api/admin/users/:id/status      # 封禁/解封（公网防滥用）
```

REST 只覆盖配置与历史读取；**不存在**全平台消息批量导出接口（§2 反目标）。

## 9. 安全

- JWT 认证：REST 与 Socket.IO 握手统一（`handshake.auth.token`，`io.use()` 中间件校验）。
- WebSocket 鉴权失败直接拒绝连接，不进任何房间。
- 注册（用户已定：开放注册、无邮箱）：图形验证码 + 注册 IP 频控；密码找回走管理员重置。
- 机器人 **API Key 加密落库**（AES-256-GCM，主密钥走环境变量），管理接口只回脱敏值（`sk-***abc`）；Key 仅创建者可见/可改。
- 速率限制：发消息（每用户每房间 10 条/10s）、登录尝试、注册、bot 调用（§7.3）。
- XSS：消息内容按纯文本存储，前端渲染转义（Markdown 渲染列二期，需配 DOMPurify）。
- 预留内容审核接口位（消息入站 hook，可接审核 API）。

## 10. 部署

Docker Compose 一把梭：`nginx + node-app + mysql + redis`。Nginx 负责 HTTPS（Let's Encrypt）、静态资源、WS 反代（`proxy_read_timeout` 调大防心跳间隔外断连）。前端构建产物由 Nginx 直接托管。

## 11. 预算

**机器人 token 费用不计入平台预算**：机器人接的是外部 OpenAI 兼容 API，Key 由机器人创建者自备，token 消耗直接记在对应厂商账户上，与平台运营成本无关。平台侧仅在管理后台做调用次数/频率限制（§7.3），不做 token 计量与计费。

平台自身的基础设施预算（小规模定位，全部一次性/固定成本）：

| 项目 | 规格 | 费用估算 | 说明 |
|------|------|----------|------|
| VPS 服务器 | 2 核 4GB（国内厂商轻量型） | ¥50–150/月（年付约 ¥300–900） | 跑 Docker Compose 全套（nginx+app+mysql+redis），足够几百人同时在线 |
| 域名 | 1 个 | ¥50–80/年 | .com/.cn 任选 |
| SSL 证书 | Let's Encrypt | ¥0 | 自动续期 |
| 对象存储（二期） | 图片消息用 | ¥0–20/月 | 小流量基本免费额度内 |
| **合计** | | **≈ ¥400–1100/年** | 无任何按量付费项；LLM token 费用除外（不计入） |

预算内含的隐含决策：**不使用任何按量计费的云服务**（托管数据库、CDN、云函数均不引入），保证成本可预测；将来若超规模，加一台 VPS 做水平扩展（§5 预留）仍在同一预算量级。

## 12. 里程碑

| 阶段 | 内容 | 验收信号 |
|------|------|----------|
| M1 群聊 MVP | 注册登录、房间 CRUD/加入、实时消息、连号+补洞、历史分页、在线状态 | 两个浏览器实时互聊，断网 30s 重连不丢消息 |
| M2 机器人 | bot CRUD（管理员全局 + 房主房间级）、房间挂载、OpenAI 兼容流式回复、@触发、超时降级 | @机器人 后打字机式回复；房主自备 Key 换 baseUrl 即换模型厂商 |
| M3 打磨 | 限流、审核接口位、管理后台、消息 Markdown 渲染、正在输入 | 可对公网开放试运行 |

## 13. 留给实现者（builder）的决定

- MySQL 表结构细节、索引与分区（几百人规模无需分区）。
- Socket.IO 事件载荷的字段命名与错误码规范。
- 前端组件拆分（Pinia store 结构、房间切换动效）。
- bot 缓存 TTL、节流参数、上下文条数 N 的具体取值（给出默认值，可调）。
- 单元/集成测试框架选型（建议 Vitest + Supertest）。

## 14. 决策记录

**用户拍板（2026-10-28）：**
1. 建设路线：自研轻量平台；技术栈 Node.js + Socket.IO + Vue 3。
2. 只做群聊，不做私聊；机器人以群成员形态接入。
3. 规模定位：几百人同时在线，单机部署。
4. 机器人创建权限：管理员（全局）+ 房主（房间级、自备 Key）。
5. 注册模型：开放注册 + 无邮箱，密码找回走管理员重置。
6. 预算：基础设施 ≈ ¥1100/年内、零按量付费；**LLM token 费用不计入**（Key 自备、费用记在各自厂商账户）。

**我的裁量（builder check 后由我定，可推翻）：**
- bot 身份落库：每个机器人建一个 `type='bot'` 的 users 行，bots 表 1:1 存配置，成员关系统一走 room_members（弃用 room_bots 分表）。
- `trigger_mode:'all'` 队列语义：2 秒去抖合并回最新一条；`mention` 模式逐条串行；限流触发广播提示不静默。
- 反目标边界：bot Key 只作用于所在房间上下文；管理端无全平台消息导出能力。
