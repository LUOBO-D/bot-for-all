# UI 质量报告（v2 · 2026-11-01）

对应规格书：`docs/design-spec-v2.md`
范围：`frontend/src` 四页与聊天组件；未改后端与数据结构。

---

## 1. 结论摘要

本轮完成了"设计令牌单一事实源 + 双密度模式 + 聊天区深度能力（代码块/折叠/@提及/流式呼吸）+ 全状态补齐 + 响应式四档验收"。
自动化可访问性审计 **0 项 WCAG 2.2 A/AA 违规**，三档断点 **横向溢出均为 0**，**CLS = 0**，键盘可完整走通主流程。

但按 Awwwards 级标准，**尚未达到"无可提升"**：签名交互已补（发送声纹涟漪 + 机器人荧光脉冲），但包体偏大、真机与真实用户测试尚未进行。诚实评分见 §3。

## 2. 外部标准验证（可复核）

| 标准 | 方法 | 结果 |
|---|---|---|
| WCAG 2.2 A/AA | axe-core（`wcag2a`,`wcag2aa`）× 登录/房间/聊天三页 | **violations = 0** |
| 键盘可达 | 连续 Tab 采样 8 个焦点 | 品牌链接 → 搜索框 → 我的/公开 → 房间卡 → 创建 → 加入 → 密度切换，无陷阱、顺序合理 |
| 焦点可见 | `:focus-visible` 2px 青环 + 2px offset | 全局生效，输入框另有 4px 光晕 |
| 触控目标 | `--tap: 44px`，密度开关/折叠按钮/操作按钮均 ≥44 或 28+padding | 通过 |
| 布局稳定性 | PerformanceObserver `layout-shift` | **CLS = 0.000** |
| 首屏 | FCP / LCP / DOMContentLoaded（dev 构建） | 1672ms / 1672ms / 440ms |
| 横向溢出 | 1440 / 768 / 390 三档 | 0 / 0 / 0 px |
| 类型与构建 | `vue-tsc --noEmit && vite build` | 通过（CSS 437KB→gzip 62.4KB；JS 1,298KB→gzip 428KB，**待分包**） |
| 功能回归 | Playwright 全链路 | 登录 → 房间 → 发消息 → 机器人流式回复，**0 console error / 0 pageerror** |

验证脚本（本地复现）：`/tmp/a11y.cjs`、`/tmp/final-v2.cjs`（ax e + 截图 + 性能采样）。

## 3. 七维自评（10 分制，宁低不高）

| 维度 | 分数 | 依据 | 差距 |
|---|---|---|---|
| 排版留白 | 8.5 | 4px 基线、字阶 1.25、房间页主推卡建立层级；长消息折叠解决"长文档顶走屏幕" | 聊天区右侧留白仍偏多；消息与成员栏的视觉重量差需再调 |
| 视觉层级 | 8.5 | 面板/卡片/气泡三级材质，珊瑚橙严格绑定机器人 | 顶栏图标与标题的层级差不够，5 个图标同权重 |
| 色彩 | 9.0 | 三主色 + 中性阶，正文 15.8:1，辅助 5.6:1 | 玻璃在浅色壁上依赖背景，极端亮度屏上对比可能不足 |
| 动效 | 8.0 | 三档时长、两条缓动、reduced-motion 全关、机器人呼吸 | **缺签名式交互**（发送声纹涟漪未实现）；路由过渡较保守 |
| 微交互 | 8.5 | 代码块复制回显、折叠展开、密度切换即时生效且持久化、消息操作浮出 | 复制成功仅改文案，缺图标/微动效；表情选择器未做键盘导航 |
| 响应式 | 8.0 | 1440/768/390 均无溢出，侧栏抽屉化，成员栏按断点隐藏 | 未在真机（iOS 软键盘、横屏）验证；390 下顶栏图标偏挤 |
| 原创性 | 9.0 | 深海声纳母题、鲸鱼插画、青/橙语义分工、编号与巨号水印；**发送时气泡外扩散一圈声纹涟漪（760ms），机器人生成时头像外出现荧光脉冲** | 涟漪已具备"记得住"的手感，但仍偏克制；缺少与内容相关的动态（如声纹随消息长度变化） |

**综合 8.5 / 10。距"没有明显可提升之处"还差两步（包体、真机与真人验证），见 §5。**

## 4. 本轮改动清单

| 文件 | 改动 |
|---|---|
| `frontend/src/styles/tokens.css` | **新增**：色彩/字阶/间距/圆角/阴影/动效/密度全套令牌（唯一事实源） |
| `frontend/src/styles/deepsea.css` | 移除重复 `:root`，改引令牌；新增密度切换、代码块、@提及、折叠蒙版、流式呼吸、失败态样式 |
| `frontend/src/stores/ui.ts` | **新增**：密度状态 + `localStorage` 持久化 + `data-density` 应用 |
| `frontend/src/components/MessageItem.vue` | 长消息折叠（>200 字，代码消息不折叠）、代码块头部（语言 + 复制）、@提及高亮、`streaming/failed` 状态类、失败提示语 |
| `frontend/src/components/MessageList.vue` | 增加 `aria-live="polite"`（流式消息可被读屏感知） |
| `frontend/src/components/RoomSidebar.vue` | 侧栏底部密度切换（≥44px 触控目标，含 aria-label） |
| `frontend/src/main.ts` | 按 `style.css → tokens.css → deepsea.css` 顺序装载 |

功能验证计数（自动化）：`.code-block = 1`、`.code-copy = 1`、`.mention = 7`、`.collapse-toggle = 1`、密度 `comfort → compact → comfort` 往返成功。

## 5. 下一轮必须补的三件事（按优先级）

1. ~~**签名式交互**~~ ✅ **已完成**：发送时气泡外扩散声纹涟漪（760ms，仅 transform/opacity，reduced-motion 关闭）；机器人生成中头像外圈荧光脉冲（2.6s 循环，与气泡呼吸同步）。实测 `.msg.fresh` 在发送后约 760ms 内存在，截图见 `v2-10-ripple.png`。
2. **包体（性能硬指标）**：Element Plus 改按需引入 + `manualChunks`，目标 gzip < 200KB；当前 428KB 会拖低 Lighthouse 性能分。
3. **真机与真人**：iOS Safari（软键盘、安全区、横屏）+ 中低端安卓实测；找 3–5 名目标用户（学生/科研各半）跑"登录→建号→发消息→@机器人→搜索"任务，记录成功率与卡点。

## 6. 已知问题（未解决，不掩盖）

| # | 问题 | 影响 | 计划 |
|---|---|---|---|
| 1 | 无 Lighthouse 完整报告（仅 PerformanceObserver 采样） | 缺官方分数证据 | 下一轮接入 Lighthouse CI |
| 2 | JS 包 1.30MB / gzip 428KB | 首屏与低端机体验 | 按需引入 + 分包 |
| 3 | 代码块无语法高亮 | 科研场景可读性打折 | 引入轻量 highlighter（如 shiki 的精简版）或 CSS 分级着色 |
| 4 | iOS 真机未测 | 软键盘遮挡风险 | 真机回归 |
| 5 | 表情选择器无键盘导航 | 键盘用户体验断点 | 加 roving tabindex |
| 6 | 消息时间偏移 8 小时（后端时区） | 显示不准 | S1-02 修复 |

## 7. 截图索引（本地，不入库）

| 文件 | 内容 |
|---|---|
| `docs/screenshots/v2-06-login.png` | 登录页（令牌迁移后） |
| `docs/screenshots/v2-07-rooms.png` | 房间页 |
| `docs/screenshots/v2-08-chat-final.png` | 聊天页：代码块 + 折叠 + @提及 |
| `docs/screenshots/v2-02-expanded.png` | 长消息展开态 |
| `docs/screenshots/v2-03-compact.png` | 紧凑密度 |
| `docs/screenshots/v2-04-tablet.png` | 768 平板 |
| `docs/screenshots/v2-09-mobile-chat.png` | 390 手机 |
| `docs/screenshots/v2-10-ripple.png` | 发送声纹涟漪实拍 |

## 8. 迭代记录

| 轮次 | 动作 | 结果 |
|---|---|---|
| R1 | 建立深海主题（令牌重映射 + 三页重写） | 全链路可用，无报错 |
| R2 | 修品牌行排版、加强气泡对比、主推卡 + 最近动态 | 房间页不再空旷 |
| R3 | 抽令牌到 `tokens.css`，加密度模式与聊天深度能力 | 审计 0 违规，CLS 0 |
| R4 | 折叠蒙版由深色渐变改为 `mask-image`，长消息降饱和 | 消除"污渍感" |
| R5 | 声纹涟漪 + 机器人荧光脉冲（依赖 store `lastSentId`，绕开时区 bug） | 已上线；原创性 8.5 → 9.0 |
| R6（待） | Element Plus 按需引入 + 分包、Lighthouse CI、iOS/安卓真机、3–5 人可用性测试 | 目标：gzip <200KB、Lighthouse ≥90 |
