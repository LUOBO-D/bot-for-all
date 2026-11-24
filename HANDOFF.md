# 接手与推送说明（HANDOFF）

更新时间：2026-11-25
当前分支：`cmd`
远端：`origin` → https://github.com/LUOBO-D/bot-for-all.git
最近已提交基线：`7d597e0 feat: implement local group chat + AI bot demo`
本轮收尾提交：`git log -1 --oneline`（本地已提交，**尚未推送**）

本文件面向下一位接手者：先把本地工作区提交并推送到 GitHub，再按这里的命令验证、部署和继续迭代。**本轮收尾提交尚未推送**，推送前请先看第 5 节。

---

## 1. 项目状态

- 一个可单机部署的多人群聊平台，机器人是房间成员。
- 后端：Node.js 24 + TypeScript + Express + Socket.IO + MySQL 8；Redis 可选。
- 前端：Vue 3 + TypeScript + Vite + Element Plus + Pinia。
- 测试：Vitest（后端）+ Playwright（浏览器 E2E）。
- 部署：`docker-compose.dev.yml` 只起 MySQL/Redis；`docker-compose.prod.yml` 起 Nginx + backend + MySQL + Redis。
- CI：`.github/workflows/ci.yml`，push / PR 自动跑后端测试、前端构建、E2E。

主要能力：房间/成员/角色、消息编辑与历史、回复/转发/置顶/表情、附件与媒体库、语音/视频封面、投票、收藏、草稿、定时消息、已读回执、通知中心、搜索、翻译、机器人流式回复、机器人联网搜索（web_search/web_fetch 工具调用，多 provider）、跨实例 bot 状态（Redis 可选）、管理端（用户/房间/bot/举报/公告/审计/统计/导出）；**前端为星空夜色单主题（Night-only「星夜」，无主题切换器，ProfileDialog 无主题项）**。

---

## 2. 本地启动

```bash
# 前置：Node ≥ 24；pnpm 版本已被 package.json 的 engines + packageManager 锁定
npm i -g pnpm@11.22.0
docker compose -f docker-compose.dev.yml up -d --wait
pnpm install
cp .env.example .env
# 三个必填值都要生成，服务端不会用默认值兜底
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^BOT_KEY_SECRET=.*|BOT_KEY_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(openssl rand -hex 16)|" .env
pnpm migrate
pnpm seed:admin
pnpm dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:3000
- 健康检查：`curl -fsS http://127.0.0.1:3000/api/health` → `{"ok":true,"db":"up"}`
- 管理员账号：`.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`

`.env` 已被 `.gitignore` 忽略；仓库只提交 `.env.example` 与 `.env.production.example`。

---

## 3. 验证基线

```bash
# 后端全量（需要 MySQL 已启动）
pnpm --filter backend test
# 当前：99 个测试文件，908 passed（配 REDIS live 变量时含跨实例用例；无 Redis 时部分 live 用例自动跳过）

# 前端类型检查 + 构建
pnpm --filter frontend build

# 全仓库构建（后端 tsc + 前端 build）
pnpm build

# 浏览器 E2E；必须先停掉本地 pnpm dev，端口 3000 不能被占用
pnpm exec playwright install chromium
pnpm test:e2e
# 当前：78 passed
```

E2E 使用独立 `chat_e2e` 数据库，并以 `CAPTCHA_ENABLED=false`、`RATE_LIMIT_ENABLED=false` 启动自己的后端；Playwright 配置为 `reuseExistingServer: false`。

CI 还会额外生成随机的 `JWT_SECRET` / `BOT_KEY_SECRET`，并创建 `chat_e2e` 数据库，见 `.github/workflows/ci.yml`。

---

## 4. 代码地图

```text
backend/src/
  app.ts                 Express 路由挂载
  index.ts               启动、迁移后的后台任务、优雅退出
  config.ts              环境变量与安全校验
  routes/                auth / rooms / admin / notifications / saved / search / settings / me-export ...
  services/              room / message / scheduled / notifications / reports / retention / translation ...
  socket/                Socket.IO 事件与 Redis adapter
  bot/                   provider、gateway、SSE、safe-fetch（SSRF 防护）
  middleware/            auth、rate limit、错误处理、安全头
backend/test/            Vitest，按领域拆分
db/migrations/           0001–0030，按顺序执行；不要改已发布迁移，追加新文件
frontend/src/
  views/                 ChatView / AdminView / SearchView / RoomListView / Login / Register
  components/            消息、附件、媒体库、通知、设置、机器人等
  stores/                auth / chat（Socket、消息窗口、未读、草稿）
  utils/                 格式化、视频封面等
e2e/chat.spec.ts         Playwright 主流程
e2e/fixtures/            测试用图片/视频
```

新增接口时：路由校验 → service 事务/SQL → 测试 → 前端 store/组件 → E2E 主路径。迁移只追加，不改历史文件。

---

## 5. Git 提交与推送

上一轮基线 `8371661`（chore: pin node and pnpm versions for handoff）已在远端；本轮收尾提交见 `git log -1 --oneline`，推送前用下面的检查确认干净。

推送前检查：

```bash
git status --short
git diff --check
git ls-files .env .env.production   # 应只列出 .env.example / .env.production.example
```

直接推送：

```bash
git push origin cmd
```

如果远端 `cmd` 已有别人的新提交，先 `git pull --rebase origin cmd`，解决冲突后再推；不要强推。当前本地分支跟踪 `origin/cmd`。

### 跨机器交接

本地提交只存在于当前工作区；如果接手者不在本机，不能直接从 GitHub UI 推送它。按当前提交的短哈希生成完整历史 bundle：

```bash
# 当前机器
HASH=$(git rev-parse --short HEAD)
BUNDLE="/tmp/bot-for-all-cmd-${HASH}.bundle"
git bundle create "$BUNDLE" cmd
git bundle verify "$BUNDLE"
ls -lh "$BUNDLE"

# 接手者机器（在已有 clone 中）
git fetch /path/to/bot-for-all-cmd-<hash>.bundle cmd:cmd
git checkout cmd
git push origin cmd
```

也可以直接把当前目录整体拷贝/共享给接手者，再按上面的 `git push origin cmd` 操作。

推送后 GitHub Actions 会自动跑后端测试、前端构建和 E2E；如果只改了文档，可等 CI 通过后再合并/发布。

---

## 6. 生产部署

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# 五个必填值，全部用 hex；MYSQL_APP_PASSWORD 是新业务账号 chat_app 的密码
sed -i "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)|" .env.production
sed -i "s|^MYSQL_APP_PASSWORD=.*|MYSQL_APP_PASSWORD=$(openssl rand -hex 24)|" .env.production
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env.production
sed -i "s|^BOT_KEY_SECRET=.*|BOT_KEY_SECRET=$(openssl rand -hex 32)|" .env.production
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(openssl rand -hex 16)|" .env.production
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build

# 首次部署后建管理员（幂等）
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec backend node dist/scripts/seed-admin.js
```

生产要点：

- 入口是 `web`（默认宿主 8080），Nginx 反代 `/api` 与 `/socket.io`。
- `backend` 启动时自动迁移；迁移失败容器退出。
- MySQL / Redis 只在内部网络，不映射宿主端口。
- 多副本时设置 `REDIS_URL` 并注意 polling 需要粘性会话（见 README 多实例一节）。
- `ALLOW_PRIVATE_BOT_URLS=false` 是生产默认；需要本地 Ollama 才在 dev 打开。
- 附件/头像在 `uploads` 命名卷；`docker compose down -v` 会删数据卷。
- 轮换 `BOT_KEY_SECRET` 会让已存 bot Key 无法解密，需要重新填写。

---

## 7. 已知取舍与注意

- 不做私聊，只做群聊；消息按房间 `seq` 连续编号，断线用 `afterSeq` 补洞。
- 全文搜索使用 MySQL ngram；单字/特殊字符回退 `LIKE`，停用词在全文路径下可能不命中。
- 翻译是可选功能，三个 `TRANSLATE_*` 变量齐全才启用；译文不落库、不广播。
- 机器人 provider 走 `safe-fetch`，默认拒绝内网/云元数据地址；改网络层时不要绕过它。
- 限流/在线状态/验证码在未配置 Redis 时退回进程内状态，只适合单实例。
- E2E 会写 `chat_e2e` 数据库并启动自己的后端，跑之前停掉本地 dev server。
- 测试夹具 `e2e/fixtures/tiny.webm` 与 `pixel-64.png` 是二进制小文件，保留在仓库中。

---

## 8. 接手检查清单

- [ ] `.env` 已按 `.env.example` 填好，`JWT_SECRET` / `BOT_KEY_SECRET` / `ADMIN_PASSWORD` 不是示例值。
- [ ] `pnpm migrate` 成功，`pnpm seed:admin` 成功。
- [ ] `curl /api/health` 返回 `db: up`。
- [ ] 后端 908 passed，E2E 78 passed，`pnpm build` 通过。
- [ ] 已确认 `git status` 中没有 `.env`、上传文件、测试产物。
- [ ] 已推送 `cmd` 并等待 GitHub Actions 通过。
- [ ] 生产部署前已替换全部密钥，并确认 `ALLOW_PRIVATE_BOT_URLS=false`。

---

## 9. QA 测试交接（当前暂停点）

已完成的收尾（2026-11-25 本批，全部窄验证通过）：

- bot 停止 / `all` 去抖 / enabled 缓存跨副本化：新增 `backend/src/bot/bus.ts`（Redis pubsub，成对 pub/sub 客户端、fail-fast 掉线即静默退化），双实例同房间去抖合并为一次回复、跨副本取消、缓存失效全实例广播；无 `REDIS_URL` 时行为与旧版完全一致。
- Redis presence 定时续期（TTL/3 单 interval，按 room 聚合），长连接不再 1 小时后显离线；Redis 掉线时的 remove 同样停止续期。
- 房间列表未读数改每请求一次聚合 JOIN（`services/room.ts fetchUnreadCounts`），谓词与原逐房间 COUNT 子查询逐条等价。
- 前端：房间打开失败有错误页（重试 / 返回房间列表，`data-testid="room-open-error"`）；离线启动有全屏重试门 `OfflineGate.vue`（App 级挂载）；管理端趋势图四指标共用一根 y 轴与刻度标签。
- 生产 MySQL 改用 `chat_app` 业务用户（`MYSQL_APP_PASSWORD` 必填，`db/init/01-app-user.sh` 仅授权 `chat.*`；存量卷升级看 README 的手工 SQL）；root 只留给容器初始化。
- CSP 双端落地（后端安全头 + nginx 同策略串）；`index.html` 内联主题脚本以 sha256 白名单化；`security-headers.test.ts` 交叉校验后端 / nginx / index.html 三处不漂移。
- CI：test job 挂 redis service（`SOCKET_ADAPTER_REDIS_URL`），Redis live 用例进入 CI；新增 build-images job 构建两个生产镜像（不 push）。
- 机器人联网搜索：`WEB_SEARCH_PROVIDER=duckduckgo|brave|tavily`（键控版需 `WEB_SEARCH_API_KEY`，缺失降级关闭，与翻译同契约）启用后，bot 主链带 `web_search`/`web_fetch`，2 轮上限、180s 总时限、每 bot 每分钟限速，回答末尾由服务端按实际工具结果确定性追加「来源」列表；出网全走 safe-fetch SSRF 防护、逐跳复检。
- 撤回守卫：流式中的 bot 消息被撤回后，后端 flush/finalize 前重读并立即停流、定稿空内容 `CANCELLED`，不再广播原文；前端 delta/final 对已撤回目标不写预览与桌面通知（违反「撤回不泄露原文」反目标的泄漏已关）。

真实联调记录（本机 Ollama `qwen3.5:9b` + `duckduckgo` provider）：模型真实发出 `tool_calls`，两轮搜索与「联网搜索」进度行均按预期广播，DDG 返回 202 反爬页时解析为空结果、以结构化失败文本回给模型并正常定稿——工具循环与降级路径在真实环境验证通过。搜索命中质量取决于出口 IP：DDG 对数据中心 IP 常回反爬页，正式运营建议直接配 brave/tavily。

建议 QA 重点：

1. 多实例真机（`--scale backend=2` + `REDIS_URL`）：同房间双发只回一次、停止跨副本生效、presence 续期（单机回环已有 live 用例）。
2. 生产 Nginx 的 CSP 严格页：markdown 外链图片、语音 blob、Socket.IO polling 降级不被拦。
3. 联网搜索换 brave/tavily 真 key 的命中质量与限流表现。
4. 真实手机：OfflineGate 全屏、房间错误页、趋势图新轴在 390px 的布局。
5. 沿用上批的并发清单（LAST_ADMIN / ADMIN_BUSY 不回归）。

仍未处理（已知，不是回归；体检新挖出的问题按严重度排）：

- `ALLOW_PRIVATE_BOT_URLS` 开着时聊天链接预览同样放行内网地址（med）：本地 Ollama 场景必须开此开关，任意成员可借链接预览探测内网（metadata 恒拒）。修法：link-preview 通道独立判定、默认恒拒内网。
- 全文搜索 ngram 0 命中时 LIKE 兜底对 messages 做双扫描（med；已有 30/min 限流挡着）：建议兜底仅在有 roomId / 时间窗时启用。
- 表情反应 `GROUP_CONCAT` 默认 1024 截断：单 emoji 响应人数多时 `userIds` 静默丢、高亮与名单失效（low，按 MySQL 默认值推断，unverified 实测）：改行级返回或 EXISTS。
- 转发 streaming 占位 bot 消息会产生永久空消息、绕过「文本或附件二选一」（low）：`assertForwardable` 补 `status <> 'done'` 拒绝。
- `AdminView` 审计搜索防抖定时器离页未清理（low）：卸载块补 `clearTimeout(auditSearchTimer)`。
- 上传仅信客户端声明 MIME，无 magic bytes 白名单（low；nosniff + inline 前缀限制下可利用性低）。
- 代理出口环境：tools 的 undici 出网直连、不认 `HTTP(S)_PROXY`（直连畅通的部署不受影响）；需要时以 `EnvHttpProxyAgent` 包装 safeLookup（小改动，用到再做）。
- Redis presence 崩溃副本留下的 stale hash 靠 TTL 自然消失（≤1h），多实例下短暂幽灵在线可接受（边界行为，非性缺陷）。
