# 多人群聊平台 + AI 机器人接入 — 设计草案

日期：2026-10-28
状态：待用户批准
下一阶段：superpowers:writing-plans（实施计划）

---

## 1. 意图与动机

搭建一个**多人同时在线的群聊网站**：用户注册登录后，创建或加入聊天室（房间），在房间内实时收发消息。

平台从第一天起就**预留聊天机器人接口**：机器人是房间里的一种特殊成员，**管理员或房主**通过配置 API 地址与密钥即可"激活"机器人，让它参与群聊（各自管理自己的 Key，互不可见）。机器人接入层做成 **OpenAI 兼容 API** 协议（事实标准），因此不绑定任何单一模型厂商——OpenAI、DeepSeek、通义、Kimi、本地 Ollama、Dify/FastGPT 平台发布的 Agent 应用，只要提供 OpenAI 兼容端点都能接。

在基础机器人之上，平台还有一只**招牌拟人化群友（代号"大肥鱼"）**：它不只被动应答，还能**主动发消息、学习群聊里的梗、联网搜索、自己更新自己的角色卡、有类人作息（晚上会睡觉）、有跨房间的长记忆**——像一位真住在群里的活人，而不是客服工具（方案见 §7.4）。

**为什么做：**
- 用户需要一个自主可控、体量轻的群聊平台，而不是 Rocket.Chat/Mattermost 这类重型企业 IM。
- AI 机器人是平台的差异化能力，且接口先行能避免后补集成时的架构返工。

## 2. 目标 / 非目标 / 反目标

**目标：**
- 多用户同时在线：小规模定位，**几百人同时在线**（内部使用：总账号数十~数百级）。
- 只做群聊（聊天室/房间），**不做私聊（1 对 1 DM）**——这是用户明确的决策。
- 实时消息：毫秒~秒级房间内广播；断线重连后能补齐错过的消息。
- 机器人作为群成员接入：支持 @机器人 触发与全量消息触发两种模式；回复流式逐字显示。
- **拟人化群友（大肥鱼）能力（本期方案，见 §7.4）**：主动发言、学梗、联网搜索、自更新角色卡、类人作息、长记忆。
- 激活方式 = 纯配置：填 base URL + API Key + 模型名，无需改代码。
- **客户端形态（用户已定：内部使用）**：安卓端用 **Capacitor 把现有 Vue 3 代码打包成 APK**（WebView 壳，免重写）；iPhone 端用 **PWA**（添加到主屏幕）。不上任何应用商店，仅内部人分发。
- 单机部署：一台 2–4GB 内存服务器 + Docker Compose 跑起来。

**非目标（本期不做，但架构不堵死）：**
- 私聊/DM（数据模型里 `room` 是唯一会话单元，将来加私聊 = 一种两人固定房间，可平滑演进）。
- 私密房间/邀请制房间（用户已定：**所有房间均为公开群聊**，无私房概念——大肥鱼的全局记忆因此不存在隐私分区问题）。
- 音视频通话、文件传输（图片消息列二期）。
- 多实例水平扩展（代码层面预留：Socket.IO Redis Adapter、无状态 HTTP 层）。
- 手机原生双端 App（不重写：安卓走 Capacitor 套壳 APK，iPhone 走 PWA）。
- 上架应用商店与公开发布（用户已定：仅内部使用，不上任何商店、不做公网推广）。
- 联网搜索、角色卡自更新的**记忆向量化语义检索**（MVP 用 MySQL 全文检索，见 §7.4.5；向量列为二期升级项，架构已留位）。
- 机器人语音/表情包消息（文本优先）。

**反目标（技术上实现了也算失败）：**
- 机器人回复"卡住不流式"——用户看到 10 秒白屏等整段回复。
- 断线重连后消息丢失或乱序，用户被迫刷新页面。
- 激活机器人需要改代码或重启服务。
- 单条密钥泄露能读出全平台聊天记录（已明确边界：bot Key 只能作用于其所在房间的上下文；管理端也不提供全平台消息批量导出工具，管理员只有单房间的管理处置能力）。
- **大肥鱼变成刷屏骚扰机器**：主动发言无节制、每 10 分钟发一次"在吗"（B站"鱼灾"的教训——同类刷屏最终被平台风控和用户屏蔽）。
- **大肥鱼人格崩坏**：自更新角色卡后性情大变、丢失核心设定（护栏见 §7.4.4）。

## 3. 约束

- 目标规模：**几百人同时在线**，单房间活跃人数预计 < 200。
- 部署预算：单台 2–4GB 内存 VPS，Docker Compose。
- 技术栈（用户已选定）：后端 **Node.js + TypeScript + Socket.IO**；前端 **Vue 3 + TypeScript + Vite**；存储 **MySQL 8 + Redis**。
- 开发人力：个人开发者，需要开发速度优先、可单独维护的架构。
- 预算上限：基础设施 ≈ ¥900/年以内（纯 IP 无域名，零手续），全部固定成本、零按量付费；LLM token 费用不计入（见 §11）。

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
- **大肥鱼社区实战**（2026 年 DeepSeek 鲸鱼娘玩法）：全量聊天记录塞上下文 → 成本/延迟指数增长，解法是"睡眠式记忆整理"（定时重置 + 保留机器自提炼的记忆关键点与群友印象/好感度）；"人味"来自防抖合并、回复延迟 1–3s、分段回复、短句口语、主动发言克制——这些细节全部转化为 §7.4 的机制设计；B站"鱼灾"刷屏翻车案例成为反目标。
- **AstrBot**（43.7k stars）：人格配置、上下文自动压缩、Cron 定时任务驱动主动发言、长期记忆/好感度/自学习/用户画像插件模式、事件总线+流水线架构。
- **MemGPT/Letta 与 Mem0 的记忆架构**：MemGPT 让 agent 自编辑记忆块与 persona（对应"自更新角色卡"）；Mem0 被动提取+检索管线更便宜可控；生产主流是混合分层（工作记忆/滚动摘要/结构化记忆）；**记忆整理天然放在空闲窗口执行（对应"睡觉"）**。

## 5. 架构总览

```
┌─────────────────────────────────────────────┐
│ 浏览器 (Vue 3 SPA)                           │
│  HTTP: 登录/房间管理/历史消息 (REST + JWT)     │
│  WS:   Socket.IO 连接 (握手带 JWT)            │
└──────────────┬──────────────────────────────┘
        HTTPS / WSS (Nginx 反代)
┌──────────────▼────────────────────────────────────────┐
│ Node.js 单体服务 (Express + Socket.IO)                  │
│ ├─ REST API 层（无状态，可多实例预留）                    │
│ ├─ 实时网关层（Socket.IO，Redis Adapter 预留）           │
│ ├─ 房间服务：成员管理、广播、消息连号                     │
│ ├─ 消息服务：先落库→后广播，历史分页                     │
│ └─ 机器人子系统 (Bot Subsystem)                         │
│     ├─ Bot Gateway：触发识别 + Agent 循环               │
│     │   （OpenAI 兼容 chat/completions + tools）        │
│     │   工具: web_search / memory_write / persona_update│
│     ├─ 记忆服务：分层记忆读写 + 全文检索                 │
│     ├─ 作息调度器：状态机(醒/困/睡) + Cron 触发          │
│     │   醒时：主动发言决策（读近期消息→说不说）            │
│     │   睡时：记忆整理 job（提取梗/印象/摘要）            │
│     └─ 拟人化输出：防抖→延迟→分段→流式 delta             │
└───────┬──────────┬──────────┬──────────┬───────────────┘
        │          │          │          │
   ┌────▼────┐ ┌───▼───┐ ┌───▼────┐ ┌───▼─────────┐
   │ MySQL 8 │ │Redis 7│ │SearXNG │ │ 外部 LLM API │
   │用户/房间 │ │在线状态│ │自托管   │ │ (OpenAI 兼容)│
   │消息/记忆 │ │游标/  │ │元搜索   │ │ 任意厂商/自建 │
   │角色卡版本│ │限流/  │ │引擎     │ └─────────────┘
   │         │ │任务队列│ │(容器)   │
   └─────────┘ └───────┘ └────────┘
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
              status: 'active' | 'banned',         -- 停用位
              created_at)

invite_codes (code, created_by, used_by NULL, max_uses, used_count,
              expires_at, created_at)              -- 内部邀请码（一次性/限量/限期）
                                                   -- 无公开注册（用户已改：仅内部使用）

rooms        (id, name, topic, owner_id,
              max_seq, created_at)                 -- max_seq = 消息连号游标
              -- 全部房间公开可加入（无私房/邀请码，用户已定）

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
              temperature, max_tokens, enabled,
              -- 拟人化能力（§7.4，普通 bot 这些字段全关即为纯应答型）
              persona_level: 'basic' | 'companion',  -- 是否启用拟人化栈
              schedule_json,                         -- 作息表（醒/睡时段）
              proactive: enabled, interval_min, max_per_hour, cool_down)
              -- 与 users 一对一：bot 的身份在 users，配置在 bots

persona_cards (id, bot_user_id, content,          -- 当前生效角色卡（正文）
              version, updated_by: 'bot'|'admin', created_at)
              -- 全平台单一人格（用户已定）：每 bot 一套卡，跨房间共享

persona_versions (id, bot_user_id, version, content, diff_summary,
                 change_reason, created_at)        -- 全量历史版本，可回滚

bot_memories  (id, bot_user_id, room_id NULL,     -- room_id NULL = 全局记忆
              type: 'impression'|'meme'|'event'|'summary',
              -- impression=群友印象/好感度（含 target_user_id, affinity 数值）
              -- meme=梗库（梗的用法/出处/适用场合）
              -- event=关键事件    summary=滚动摘要
              content, keywords, importance, decay,
              last_recalled_at, created_at)
              FULLTEXT ngram 索引(content, keywords)   -- 检索依据

bot_memory_log (id, bot_user_id, room_id, run_at,  -- 睡眠整理 job 的运行日志
              messages_scanned, memories_created/updated/merged, notes)
```

设计说明（新增部分）：
- **单一人格（用户已定）**：大肥鱼全平台共享一套 persona_cards、梗库、群友印象——在任何房间都认识同一批人；`bot_memories.room_id NULL` 的行即跨房间全局记忆，房间内梗则带 room_id。
- **记忆衰减**：`decay` + `last_recalled_at` 实现"越用越牢、久不用淡忘"（MemoryBank 的遗忘曲线思路），睡眠整理 job 据此降权/清理低信号记忆。
- 角色卡更新只写 persona_versions 并推进 version；生效卡由 persona_cards 持有，回滚 = 指回旧版本。

设计说明：
- **注册模型（用户已改：仅内部）**：无公开注册入口——管理员后台直接建号，或生成一次性邀请码（invite_codes 表）供内部人自助激活；密码找回走管理员重置，不引入 SMTP 依赖。
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
- **companion 的 `all` 模式分叉**（我的裁量，builder check 回填）：拟人化 bot（§7.4）在 `all` 触发下**不必然回复**——去抖合并后先过一道轻量"要不要回"决策门（与 §7.4.6 主动发言的 speak:false 同构，输出 speak + 建议情绪），避免大肥鱼对每个对话停顿都插嘴。`mention` 模式保持必回。
- **OpenAI 兼容意味着可直接接入**：OpenAI/DeepSeek/Kimi/通义/智谱、本地 Ollama、LiteLLM 网关、Dify/FastGPT 发布的 OpenAI 兼容端点。Webhook 自定义机器人（消息转发到任意外部服务）列二期。

### 7.4 拟人化智能体方案（大肥鱼）

§7.3 描述的是**基础应答链路**，所有 bot（含大肥鱼）共用。`persona_level='companion'` 的 bot 在此之上启用本节的拟人化栈：Agent 循环、分层记忆、作息、主动发言、自更新角色卡。**上下文组装从"近 N 条消息"升级为"角色卡 + 检索到的相关记忆 + 近 N 条消息"**。

**companion 权限（用户已定）**：`persona_level` 仅管理员可设置、仅全局 bot 可开启——平台只有一只大肥鱼跑拟人化栈；房主自建 bot 恒为 `basic`（纯应答型），`/api/me/bots` 拒绝该字段。理由：主动发言调度、每日睡眠整理 job、SearXNG 调用与记忆增长消耗的是平台单机资源（2–4GB），开放给房主需配额体系，本期不值得。

#### 7.4.1 Agent 循环与工具（主动能力的地基）

基础链路是单次 completion；拟人化 bot 升级为带工具调用的循环（OpenAI function calling 协议，主流厂商全支持）：

```
组装上下文（角色卡 + 检索记忆 + 近消息）
  ↓
chat/completions(stream=true, tools=[web_search, memory_write, persona_update])
  ↓ 模型决定调用工具 → 本地执行 → 把结果回填 → 继续生成（最多 3 轮）
  ↓ 纯文本 delta → 走 §7.3 的流式广播链路
```

三个内置工具：

| 工具 | 作用 | 约束 |
|------|------|------|
| `web_search(query)` | 联网搜索（自托管 SearXNG，见 §10） | 每次回复最多 2 次调用；结果只回填摘要 |
| `memory_write(content, type, keywords)` | 主动写记忆（"这句值得记住"——MemGPT 式自我记忆管理） | 每次回复最多 3 条；与睡眠整理管线写入同一张表 |
| `persona_update(diff, reason)` | 自更新角色卡（见 §7.4.4） | 幅度与频率护栏 |

#### 7.4.2 分层长记忆（借鉴 MemGPT/Mem0/大肥鱼实践的混合架构）

| 层 | 内容 | 生命周期 | 载体 |
|----|------|----------|------|
| 工作记忆 | 当前房间最近 N 条消息（默认 20） | 实时，进上下文 | messages 表直读 |
| 滚动摘要 | 每房间每日话题摘要 | 睡眠整理时生成 | bot_memories(type='summary') |
| 群友印象 | 对每个群友的人设印象 + 好感度数值（大肥鱼社区的"好感度写进人设"实践） | 长期，被引用则增强 | bot_memories(type='impression') |
| 梗库 | 群内流行语/名场面：梗的写法、出处、适用场合、最近谁在用 | 长期 + 衰减 | bot_memories(type='meme') |
| 关键事件 | 值得记住的事（谁生日、谁在做什么项目） | 长期 + 衰减 | bot_memories(type='event') |

**每次回复的上下文注入**（prompt 组装顺序）：
```
[当前角色卡 persona_card]
[全局记忆: 高分梗库条目 + 群友印象(发言者及被提及者) + 相关事件]
[本房间记忆: 滚动摘要 + 房间内梗 + 本房间事件]
[工作记忆: 最近 N 条消息]
[用户本条消息]
```

**学习群聊的梗**：不靠专门算法，靠**睡眠整理管线**（§7.4.3）从聊天记录里高频/被反复玩的内容中提取 meme 条目（LLM 提示词要求识别"重复出现的口头禅、内部玩笑、名场面"），加上运行中 `memory_write` 的即时捕捉；回复时相关梗注入上下文，模型自然"用群里的方式说话"。

**记忆衰减**：`importance × 近期引用频率` 决定保留优先级；长期未被检索的低分记忆在睡眠整理时合并进摘要或删除（战略性遗忘）。

#### 7.4.3 作息状态机 + 睡眠式记忆整理

```
状态机（bots.schedule_json 配置，默认 09:00–01:00 活跃）：
  醒着(active)  ←默认→  困了(drowsy, 深夜降频)  →  睡觉(asleep)
规则：
  asleep：不主动发言；@提及仍可回复，但 30% 概率"被吵醒式回复"（揉眼/抱怨），其余静默到早上（次日醒来后睡眠整理会把 @ 的事补进记忆）
  drowsy：主动发言频率减半，语气变懒散（prompt 注入当前状态）
  active：正常
"睡觉"= 记忆整理窗口（02:00–04:00 的 Cron job）：
  1. 扫描全天各房间消息（有该 bot 的房间）
  2. LLM 批量提取/更新：梗、事件、群友印象与好感度增减、当日摘要
  3. 记忆衰减与合并：低分记忆并入摘要或删除
  4. 输出整理日志 bot_memory_log（做了什么、产生了什么记忆）
  —— 对应大肥鱼社区"每天定时重置但保留记忆关键点"的成熟实践，
     也对应 MemGPT 论文"记忆整理在空闲期执行（如人类睡眠）"的架构
```

#### 7.4.4 自更新角色卡（护栏设计，用户已定：自动生效 + 可回滚）

- **角色卡为结构化 JSON 区块**（我的裁量，builder check 回填）：`{ identity: {名字/物种/基本设定}, core_traits: {核心性格，只读}, habits: {...}, style: {说话风格}, relationships: {对特定群友的态度}, notes: {...} }`。`identity` 与 `core_traits` 为只读区块（工具 schema 直接排除，程序化保证）；其余区块可由 `persona_update` 以**区块级替换指令**修改（diff = 新区块全文 + reason），护栏可精确执行（幅度 = 变更区块字数占比、一致性校验 = 只读区块哈希比对、版本 diff 可渲染）。
- 模型在对话中调用 `persona_update(diff, reason)` 提出修改（如"群友常叫我肥鱼，我想把'讨厌被叫肥鱼'加进 style"）。
- **幅度护栏**：单次 diff ≤ 角色卡 10%；每天最多 2 次自更新；只读区块永不可改。
- **生效即落库**：写 persona_versions（含 diff_summary 与 change_reason），persona_cards 推进版本——即时生效，无需审批。
- **回滚**：管理员在后台看到版本时间线与 diff，一键回滚任意历史版本。
- 人格漂移的兜底：每次睡眠整理时校验只读区块哈希与初始版本一致，异常则自动回滚并通知管理员。

#### 7.4.5 记忆检索（MVP：MySQL 全文，用户已定）

- **读侧查询串**（我的裁量，builder check 回填）：直接用"本条消息原文 + 被提及/@ 的用户名"去 `MATCH ... AGAINST`，不额外加轻量 LLM 抽关键词调用（控制每条消息延迟与成本）；写入侧 keywords 已保证梗名/人名/事件词命中。
- `FULLTEXT ngram(content, keywords)` + `WHERE type=? / room_id=? / importance>?` + 时间排序，取 Top-K 注入。
- 关键词由写入方（模型或整理 job）生成，保证"梗名/人名/事件词"可命中。
- 向量语义检索列二期：表结构预留 `embedding` 列与写入接口，届时换 SQLite-vec 或 MySQL 向量类型即可，不动业务层。

#### 7.4.6 主动发言（克制是第一原则）

```
醒着时，调度器按 interval_min（默认 45min）± 随机抖动唤醒：
  读取该房间自上次主动发言后的新消息（≤50 条）
  → 单独一次轻量 LLM 调用，输出 JSON：
     { "speak": false }                        -- 大多数时候选择不说话
     { "speak": true, "message": "...", "reason": "群里在聊XX，我也想说两句" }
  → speak=true 才走正常回复链路（含工具与记忆注入）
```

**防骚扰约束（硬性，不靠模型自觉）：**
- **配额层级**（我的裁量，builder check 回填）：限流计数按 **(bot, room) 组合**计——每房间每小时 ≤2 条主动消息（防单房刷屏）；bot 级再设总帽（默认 6 条/小时，防全局刷屏）；发言后 cool_down（默认 30min，同样按房间计）。调度器按房间组织唤醒（大肥鱼挂在 N 个房间时逐房独立决策），`bots.proactive` 的 interval/max 为默认值，房间级覆盖参数存 room_members 扩展字段（管理员可调，M4 后台化）。
- 房间冷场（1 小时无人说话）不主动发言——没人想听机器人自言自语（大肥鱼社区"克制"原则 + B站鱼灾反例）。
- 主动消息在 UI 上与普通消息无区别（本来就是群成员），但管理后台可查主动/被动比例。

#### 7.4.7 拟人化输出时序（"人味"细节）

| 机制 | 参数 | 目的 |
|------|------|------|
| 防抖合并 | 2s（沿 §7.3 队列语义） | 连续多条消息合并成一次理解，像人"看完再回" |
| 回复延迟 | 1–3s 随机（可关） | 别秒回，秒回=机器人 |
| 分段发送 | 长回复拆 1–3 段，段间 0.5–1.5s | 像人在打字；**每段是一条独立消息（各占 seq）**，与消息连号模型自然兼容 |
| 流式 delta | 沿 §7.3（80ms 合帧节流） | 打字机效果 |
| 表达风格 | system_prompt 层约束：短句、少感叹号、不用 markdown、偶尔口语词 | 群聊语感（大肥鱼社区验证过的风格配方） |

**Agent 循环期间的用户体验**（我的裁量，builder check 回填）：
- 工具执行期间（联网搜索等）bot 复用既有 `typing` 事件——前端显示"正在输入"，不引入新协议、不暴露内部步骤。
- 模型在工具调用前产生的中间文本一律**缓冲不发送**，只有最终轮的正文走流式；首字延迟预算 = 工具轮数 × 5s 超时上限，超过则中断工具直接生成（防"10 秒白屏"反目标）。
- 快速路径的触发判定用**启发式不做模型调用**：消息含 @bot、或以？/？结尾、或包含 bot 名字 → 走快速路径（防抖 1s、关闭延迟、直接流式）；其余全量触发走拟人化路径。

**及时性保障**（用户需求"回复消息及时"）：@提及与直接问句走**快速路径**——防抖窗口缩短到 1s、回复延迟关闭、直接流式输出；闲聊型全量触发才启用拟人化延迟。延迟是演技，不是负担。

#### 7.4.8 成本与失控控制

- 主动发言决策用轻量调用（max_tokens 限制 200）；正文生成才用完整上下文。
- 睡眠整理批处理（一次调用处理一个房间一整天，而非逐条）。
- 全局限流兜底（§7.3 Redis 计数）不因拟人化放开；`/stop` 指令对大肥鱼同样有效。
- 梗库/印象条目总量软上限（如 5000 条），超限触发强制衰减清理。

## 8. API 概要（REST）

```
POST /api/auth/activate|login           # JWT（无公开注册：邀请码激活，或管理员直接建号）
GET  /api/rooms                        # 房间列表 / 我的房间
POST /api/rooms                        # 创建房间（创建者即房主）
POST /api/rooms/:id/join               # 直接加入（全部房间公开，用户已定）
GET  /api/rooms/:id/messages?beforeSeq=&limit=   # 历史消息分页 + 补洞
GET  /api/rooms/:id/members            # 成员列表（人类与机器人统一）
--- 房主（自备 Key，管自己房间级机器人）---
CRUD /api/me/bots                      # 我的机器人配置（api_key 加密，仅回脱敏值）
POST /api/me/rooms/:id/bots            # 房主房间挂载/卸载自己的机器人
--- 平台管理员 ---
CRUD /api/admin/bots                   # 全局机器人配置
POST /api/admin/rooms/:id/bots         # 任意房间挂载/卸载
POST /api/admin/users                  # 直接建号（内部人员）
POST /api/admin/invites                # 生成一次性邀请码（有效期/次数可配）
PATCH /api/admin/users/:id/status      # 停用/启用账号
--- 拟人化 bot 专属（§7.4）---
GET  /api/admin/bots/:id/persona       # 角色卡当前版本 + 版本时间线/diff
POST /api/admin/bots/:id/persona/rollback   # 回滚到指定版本
GET  /api/admin/bots/:id/memories?     # 记忆浏览（按类型/房间/关键词过滤）
GET  /api/admin/bots/:id/memory-log    # 睡眠整理运行日志
PATCH /api/admin/bots/:id/proactive    # 主动发言参数/作息表热更新
```

REST 只覆盖配置与历史读取；**不存在**全平台消息批量导出接口（§2 反目标）。

## 9. 安全

- JWT 认证：REST 与 Socket.IO 握手统一（`handshake.auth.token`，`io.use()` 中间件校验）。
- WebSocket 鉴权失败直接拒绝连接，不进任何房间。
- 注册（用户已改：**仅内部**）：无公开注册入口——管理员直接建号或发一次性邀请码，外人无法自行注册；密码找回走管理员重置。
- **传输加密（纯 IP 部署的已知取舍）**：无域名 → 无法签 Let's Encrypt 证书。方案：自签 CA——服务器自签证书，**安卓 APK 通过 networkSecurityConfig 内置信任该 CA**（App 内 HTTPS 正常无警告）；iPhone PWA 用户首次访问需手动信任一次（Safari 提示），或接受风险提示。内部工具场景下已属可接受；管理员账号与 bot Key 相关接口全走 HTTPS。
- 机器人 **API Key 加密落库**（AES-256-GCM，主密钥走环境变量），管理接口只回脱敏值（`sk-***abc`）；Key 仅创建者可见/可改。
- 速率限制：发消息（每用户每房间 10 条/10s）、登录尝试、bot 调用（§7.3）。
- XSS：消息内容按纯文本存储，前端渲染转义（Markdown 渲染列二期，需配 DOMPurify）。
- 预留内容审核接口位（消息入站 hook，可接审核 API）。

## 10. 部署

Docker Compose 一把梭：`nginx + node-app + mysql + redis + searxng`。Nginx 负责静态资源、WS 反代（`proxy_read_timeout` 调大防心跳间隔外断连）。前端构建产物由 Nginx 直接托管。

**国内 VPS + 纯 IP 访问（用户已定，免备案）**：
- 不使用域名 → 不触发云商的备案拦截与 ICP 备案流程，**零手续当天上线**；代价是无域名证书（HTTPS 方案见 §9 自签 CA）。
- 访问入口即 `http(s)://<服务器IP>`；安卓 APK 构建时写入该地址，iPhone PWA 同样指向 IP。
- 内部人分发：安卓 APK 由 **Capacitor 打包现有 Vue 3 代码**（WebView 壳，内置自签 CA 信任与服务器地址，扫码/下载页安装）；iPhone 用户 Safari 打开站点"添加到主屏幕"（PWA：manifest + Service Worker）。

**SearXNG**（联网搜索，用户已选自托管）：独立容器，仅监听内网、不给公网入口（只有 Node 服务可访问其 JSON API）；**国内 VPS 直连 Google 不可达，聚合引擎为百度/必应国内版/搜狗**（搜索质量较国际引擎降级，为纯 IP 国内部署的已接受代价）。零 API 费用，符合零按量预算。VPS 内存余量足够（SearXNG ≈ 300MB，4GB 机型可容纳；若用 2GB 机型则搜索功能降级为可关闭开关）。Node 侧对其结果做超时（5s）与条数截断（Top 5）。

## 11. 预算

**机器人 token 费用不计入平台预算**：机器人接的是外部 OpenAI 兼容 API，Key 由机器人创建者自备，token 消耗直接记在对应厂商账户上，与平台运营成本无关。平台侧仅在管理后台做调用次数/频率限制（§7.3），不做 token 计量与计费。

平台自身的基础设施预算（小规模定位 + 内部使用 + 纯 IP 免备案，全部固定成本）：

| 项目 | 规格 | 费用估算 | 说明 |
|------|------|----------|------|
| VPS 服务器（国内） | 2 核 4GB（阿里云/腾讯云轻量） | ¥50–150/月（年付约 ¥300–900） | 跑 Docker Compose 全套（nginx+app+mysql+redis+searxng）；内部几十人绰绰有余 |
| 域名 | 不购买（纯 IP 访问） | ¥0 | 免备案的代价与省钱项：无域名证书，HTTPS 用自签 CA（§9） |
| SSL 证书 | 自签 CA | ¥0 | APK 内置信任；iPhone PWA 首次手动信任 |
| App 分发 | APK 自托管下载页 / 蒲公英免费版 | ¥0 | 不上应用商店，仅内部安装 |
| 对象存储（二期） | 图片消息用 | ¥0–20/月 | 小流量基本免费额度内 |
| **合计** | | **≈ ¥300–920/年** | 无任何按量付费项；LLM token 费用除外（不计入） |

预算内含的隐含决策：**不使用任何按量计费的云服务**（托管数据库、CDN、云函数均不引入），保证成本可预测；将来若超规模，加一台 VPS 做水平扩展（§5 预留）仍在同一预算量级。

## 12. 里程碑

| 阶段 | 内容 | 验收信号 |
|------|------|----------|
| M1 群聊 MVP | 注册登录、房间 CRUD/加入、实时消息、连号+补洞、历史分页、在线状态 | 两个浏览器实时互聊，断网 30s 重连不丢消息 |
| M2 基础机器人 | bot CRUD（管理员全局 + 房主房间级）、房间挂载、OpenAI 兼容流式回复、@触发、超时降级 | @机器人 后打字机式回复；房主自备 Key 换 baseUrl 即换模型厂商 |
| M3 拟人化群友（大肥鱼） | Agent 循环 + 三工具、分层记忆 + 全文检索、作息状态机 + 睡眠整理、主动发言（含防骚扰约束）、角色卡自更新 + 版本回滚、SearXNG 接入、快速路径延迟策略 | 连续 3 天养 bot：会用群里的梗说话；半夜 @ 它会"被吵醒"；会主动插话但每小时 ≤2 次；角色卡自改留痕可一键回滚；问它"昨天群里聊了什么"能答对 |
| M4 打磨与内部上线 | 限流、管理后台（含角色卡时间线/记忆浏览器）、消息 Markdown 渲染、正在输入、**PWA 支持（manifest+Service Worker）、Capacitor 打包 APK + 自签 CA 内置信任、内部分发** | 内部人在手机上装 APK / 添加 PWA 到主屏幕正常使用；管理员可发邀请码拉人 |

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
5. 注册模型（二次修订）：**仅内部使用**——管理员直接建号或发一次性邀请码，无公开注册入口；密码找回走管理员重置。
6. 预算：基础设施 ≈ ¥1100/年内、零按量付费；**LLM token 费用不计入**（Key 自备、费用记在各自厂商账户）。
7. 拟人化 bot（大肥鱼）需求：主动发言、学梗、联网搜索、自更新角色卡、回复及时、类人作息（晚上睡觉）、长记忆。
8. 大肥鱼人格与记忆：**全平台单一人格**（跨房间共享角色卡/梗库/群友印象）。
9. 联网搜索：**自托管 SearXNG**（零 API 费用，不破坏零按量预算）。
10. 角色卡自更新护栏：**自动生效 + 全程版本留痕可回滚**（单次幅度 ≤10%、核心区块只读、每日 ≤2 次、睡眠期一致性校验自动回滚兜底）。
11. 长记忆检索：MVP 用 **MySQL FULLTEXT(ngram)**，向量语义检索列二期（表结构已留 embedding 位）。
12. 部署（最终）：**国内 VPS + 纯 IP 访问**，不购域名、免备案零手续、当天上线；HTTPS 用自签 CA（安卓 APK 内置信任，iPhone PWA 首次手动信任）；SearXNG 聚合百度/必应国内版/搜狗（Google 国内不可达，质量降级为已接受代价）。
13. 房间模型：**全部公开群聊，不做私密房/邀请制**——大肥鱼全局记忆无隐私分区问题。
14. companion 权限：**仅平台管理员建的全局 bot（大肥鱼）可开拟人化栈**，房主 bot 恒为纯应答型。
15. 客户端形态：**安卓 Capacitor 套壳 APK + iPhone PWA**，不上任何应用商店，仅内部人分发；不重写双端原生代码。

**我的裁量（两次 builder check 后由我定，可推翻）：**
- bot 身份落库：每个机器人建一个 `type='bot'` 的 users 行，bots 表 1:1 存配置，成员关系统一走 room_members（弃用 room_bots 分表）。
- `trigger_mode:'all'` 队列语义：2 秒去抖合并回最新一条；`mention` 模式逐条串行；限流触发广播提示不静默；**companion 的 `all` 模式先过"要不要回"轻量决策门再决定是否回复**。
- 反目标边界：bot Key 只作用于所在房间上下文；管理端无全平台消息导出能力。
- 角色卡为**结构化 JSON 区块**（identity/core_traits 只读），`persona_update` 为区块级替换指令，护栏程序化执行。
- 主动发言配额按 **(bot, room) 组合**计（每房每小时 ≤2、bot 级总帽 6/小时、cool_down 按房间计），调度器按房间组织。
- Agent 循环期间：复用 `typing` 事件给用户可见信号；工具轮中间文本缓冲不发；首字延迟超预算则中断工具直接生成；快速路径触发用启发式（@/问号/含 bot 名），不做模型判定。
- FULLTEXT 读侧：用消息原文 + @/被提及用户名直接 MATCH，不加抽词调用。
