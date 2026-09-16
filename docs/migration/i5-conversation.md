# I5 · 对话补全（integration unit）

Worktree `.local/i5-conversation`，分支 `i5-conversation`，基线 `next @ 7b2cef8`（typecheck 绿，vitest 109 文件 / 1197 通过 / 34 跳过）。
日期 2026-09-16。

## 1. 阅读摘要

### 1.1 integration-plan.md §3 统一约定 / §3.5 / §2.1 / §2.4 / §4 / §6 / 附录

- 统一约定：独占目录只有本单元可改；共享文件只允许 append 一行（import + 数组项）；
  IPC `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  「Town 包络」用 `chat-errors.ts` 的 `chatErrorEnvelope` 返回而非抛；协议行为以实测文档为准；
  注入替身形状与生产一致（生产注入类实例 → 测试也用类实例）。
- §3.5 本单元目标：补 P1 留下的五个空洞——`prepareMessage`（请求上下文帧）、`ChatDetails` 的 IPC、
  `composer-data`、`workerResults` 卡片、`⌘1–9` 切会话。
  独占新文件：`main/chat/{prepare-message,environment,details-ipc,composer-data}.ts`、
  `renderer/conversation/components/{detail-card,worker-result,reference-toolbar}.tsx`、
  `renderer/conversation/models/{details,mentions}.ts`、`tests/chat-integration-*.test.ts`。
  装配：`subsystems/chat.ts` 的 `new ChatSessions({...})` 加四个参数（prepareMessage / generateTitle /
  titleAvailability / getWorkerResults）。
  收敛副本：`chat/context.ts` 删、`chat/titles.ts` 的 `sanitizeText` 改 import、`chat/connection.ts` 的
  `beingIdentityKey` 改一行代理。
  七条 IPC（见 §4 清单）。renderer 三块：选区工具条、解释卡片、Worker 结果卡片；ComposerModel 加 `/` Kit 与 `@` 成员补全；
  `page.tsx` keyboard 块加 `task-1..9`（唯一允许改 page.tsx 的例外）。
- §2.1 注册表：`SubsystemContext` 有 `handle/exclusive/window/store/electron/userData/desktopId/clientVersion/onError/registry/push`；
  install 同步体里**只能**构造自己的实例并把跨子系统访问存成惰性 getter，不得同步解引用 `ctx.registry.get(...)`。
- §2.4 插槽：`PANEL_SLOTS/SIDEBAR_SLOTS/TOPBAR_SLOTS/SHEET_SLOTS` + `FEATURE_MODELS`，每单元一行 append。
- §4：冲突点全部 append-only；`package.json`/`forge.config.ts`/`vite.*`/`main.ts` 只有 I0 改。
- §6.1：`tests/electron-smoke.mjs` 归 I5，10 步（起打包客户端 + 假 Being HTTP/WSS 夹具 → 连接 → 发一句 →
  断言 `POST /api/chat/stream` body 带 `scene_id`/`scene_meta.scene_label`/`client_ref` 且 `message` 带 v1 帧 →
  `GET /api/history` 一次 → 停止 → `POST /api/stop` → 重启后会话仍在）。
  §6.3 真机冒烟：typecheck/vitest、`npm run start`、打包产物启动、`test:all` 的 skipped 名单只减不增。

### 1.2 docs/migration/i0-seams.md（451 行）

对本单元最要紧的几条：

- **副本已经在 I0 一次收敛完**（偏离方案 §2.5 的分步走）：`chat/context.ts` **已删除**，`chat/titles.ts` 的本地
  `sanitizeText` **已删除**，`chat/session-recovery.ts` 已改 import `common`。
  也就是说 §3.5「要收敛的副本」三条里前两条在基线上已经完成；`chat/connection.ts` 的 `beingIdentityKey` 也已经是
  `sessionPartition(parseConnection(address))` 的一行代理（`tests/identity-partition.test.ts` 钉住）。**本单元这一步是核实而非施工。**
- `common/message-context.ts` 导出 `desktopMessageContext`、`DESKTOP_PORTAL_NAME`、`DesktopRuntime`、`DesktopMessageContextOptions`；
  I0 实测 `chat/context.ts` 与 `tools/message-context.ts` 去空白后逐字节相同（4626 字节）。
- `SubsystemContext`：`handle / exclusive / window() / store / electron / userData / desktopId / clientVersion / fetchImpl /
  onError / registry / push`。`store` 是 `SubsystemSettings`，**与方案不同**：拆成 `settings: Settings` + `extras` + `saveExtra(patch)`。
- `DesktopSubsystem` 多了 `linked?(): void`（装后同步一趟，惰性规则的唯一例外出口，用于「写」而不是「读」）。
- `installSubsystems(ctx, installers)` 是注册表测试入口；`installDesktopExtensions` 是生产入口。
- renderer：`FeatureModel = Store & { start?(): () => void }`；要开 IPC 订阅/定时器的一律放 `start()` 并返回关闭函数。
  插槽排序 `order` 升序、同 order 按 key 字典序；`order` 用百位留空隙。
- architecture 测试现在是**八条**（多了 `main/common/` 依赖边界、`subsystems/` 不得 import electron）。
- `connectionCleared()` **从来没有调用方**（main.ts 没接线），既有缺口。

### 1.3 本仓库既有实现（读一遍的结论）

- **`desktop/main/subsystems/chat.ts`（107 行）** —— `new ChatSessions({...})` 现在只传
  `desktopId / clientVersion / cache / getContext / fetchImpl / onEvent / onState`。
  四个空洞（`prepareMessage` / `generateTitle` / `titleAvailability` / `getWorkerResults`）都还没接。
- **`desktop/main/chat/sessions.ts`（490 行）** —— `ChatSessionsOptions` 里这四个参数**已经有定义**：
  `prepareMessage?: ({sessionId}) => Promise<PreparedMessage|null|undefined>|…`、`generateTitle?`、
  `titleAvailability?: () => string`、`getWorkerResults?: (sessionId) => unknown[]`。
  `view()` 里 `workerResults: this.getWorkerResults(sessionId)`（默认 `() => []`）。
  `titles` 只在 `generateTitle` 非空时构造 `SessionTitles`。`workersChanged()` 已存在。
- **`desktop/main/chat/frame.ts`（76 行）** —— `wrapMessage/unwrapMessage` 与 BD
  `src/orchestration-message.cjs:18-37` 逐行一致；`orchestrationInstructions` 是可注入的间接层，
  **I4 已在 `subsystems/orchestration.ts` 调 `setOrchestrationInstructions(orchestrationInstructions)`**
  （`orchestration/instructions.ts` 是 BD `:4-14` 的字节级副本，3069 字节）。
- **`desktop/main/common/message-context.ts`（78 行）** —— `desktopMessageContext({platform, hostname, runtime})`，
  `DESKTOP_PORTAL_NAME='being-desktop'`。`DesktopRuntime` 有 `desktopId?/portal?/mode?` + 索引签名。
- **`desktop/main/chat/ipc.ts`（164 行）** —— 9 条通道；`beings:chat-composer-data` 现在返回写死的空壳
  `{kits:[],members:[],kitsError:'',membersError:'',connectionRevision:0}` 且**不接受参数**。
  `enveloped` / `fields` / `sessionId` / `plain` / `invalid` 四个助手就在这个文件里。
- **`desktop/main/subsystems/orchestration.ts`** 导出 `orchestration / policy / methods / runner / histories /
  register / setDraftPreparer`。`Orchestration` 类有公有字段 `mode / owner / revision / configuring / agents /
  workers`，方法 `context(sessionId)` / `authorize(args)` / `generateTitle(sessionId, input)` / `openResult`。
  `OrchestrationPolicy.inspectForMessage()` 返回 `PolicyState`（永不抛，内部吞 `assertEnforced`）。

### 1.4 BeingDesktop 逐行对照物（实读行号，方案给的行号是旧的）

- **`src/orchestration-message.cjs:39-55`**（方案写 24-37）—— `nativeMessageContext({orchestration, environment})`：
  捕获 `revision/owner/enabled` 三个快照 → `assertCurrent()` 检查
  `configuring || revision变 || owner变 || enabled变` 则抛 `SESSION_CHANGED`「编排模式或会话绑定已变化，请重新发送。」
  → `assertCurrent()` → `await environment(sessionId)` → `assertCurrent()` →
  `mode = orchestration.context(sessionId)`；`if (mode.enabled) orchestration.authorize(mode)` →
  返回 `{context: runtime + orchestrationInstructions(mode), assertCurrent}`。
- **`src/main.cjs:200-219`** —— `desktopEnvironment(sessionId)`：先取 `enabled`，`configuring` 则抛
  `ORCHESTRATION_NOT_ENFORCED`「编排模式正在切换，请完成后再发送消息。」→ `await orchestrationPolicy.inspectForMessage()`
  → 再查一次 enabled/configuring，变了抛 `ORCHESTRATION_NOT_ENFORCED`「编排模式已变化，请重新发送。」→
  `bridge = desktopTools.link.capabilities()`；`terminalCallable = bridge.tools.includes('desktop_terminal_create')`
  → `desktopMessageContext({runtime:{desktopId, capturedAt, application:{name:'Being Desktop',version},
  chatSessionId, workspace, portal:{...}, bridge, executionPolicy, mode:'orchestrator'|'direct',
  terminal:{present,interactive,shell,callable,approval,scope,sessions,lifetime},
  browser:{present:true,callable,approval}, console:{interactive:false,callable,approval}}})`。
- **`src/main.cjs:634-637`** —— ChatSessions 的四个参数；`titleAvailability` 的指纹是
  `!exitStarted && chatSessions?.identityKey===orchestration.owner && orchestration.agents.some(ready)
  ? JSON.stringify([orchestration.revision, readyAgents.map(a=>[a.id,a.path])]) : ''`。
  `generateTitle` 的脱敏密钥是 `[connection?.token, connection?.secret]`（方案写的 relaySecret 名字不同）。
  `getWorkerResults` 的身份校验是 `connection && chatSessions?.identityKey===orchestration.owner`。
- **`src/native-worker-results.cjs`（11 行）** —— 过滤 `worker.sessionId===sessionId && (presentation || review?.summary)`；
  映射 `{workerId, sessionId, title, at: endedAt||updatedAt, preview: Boolean(presentation),
  status: review?.summary ? review.status : 'ready',
  summary: review?.summary || '结果已生成，可以在 Desktop 内置浏览器中打开。', evidence: review?.evidence || ''}`。
- **`src/main.cjs:1207-1219`** —— `chatView / chatOpenWorkerResult / chatSend / chatDetail{Open,View,Send,Stop,Close} /
  chatStop / chatReload / chatForgetSession`。`chatOpenWorkerResult({sessionId,workerId})` 先 `chatSessions.view(sessionId)`
  校验会话存在，再查 `connection && identityKey===orchestration.owner` 否则抛「Being 连接已变化。」，
  最后 `orchestration.openResult(workerId, sessionId)`。
  `src/main.cjs:126`：五条 `chatDetail*` 都在 `townMethods`（= 包络）。`chatOpenWorkerResult` **不在**。
- **`src/main.cjs:1334-1349`** —— `getChatComposerData(value)`：`memberOptions(value)` 只认 `{force?:boolean}`（原型必须是
  Object.prototype，多一个键就抛 `INVALID_REQUEST`「成员刷新参数无效。」）；捕获 `generation/identityRevision`；
  未连接抛「请先连接 Being。」；`Promise.allSettled([readComposerKits(), townSession.getMembers(options)])`；
  再查 revision/identity/status，变了抛 `SESSION_CHANGED`「Being 连接已变化。」；
  返回 `{...normalizeComposerData({kits,members,kitsError:'已安装 Kit 暂时无法读取。',membersError:'Being 成员暂时无法加载。'}),
  connectionRevision:revision, ...townSession.memberCacheState()}`。
- **`src/loom-composer.cjs:8-49`** —— `BUILTIN_KITS`（being-search / being-browse 两个）与 `normalizeComposerData`：
  clean 去控制字符 + trim + 截断；kit handle 由 name 生成（空格转 `-`，去非字母数字），重名加 `-<id>`，再重名丢弃；
  member handle 就是 id；`installed` / `icon`（只给 kit，内嵌 data URI）/ `builtin`；
  kits 先塞两个内置再接 `value.kits.filter(installed===true)`，各自上限 1000。

### 1.5 ChatDetails / kits / Town 成员 / composer 助手

- **`desktop/main/chat/details.ts`（117 行）** —— 类已在，无 IPC。方法：`reset(notify=true)` / `open({parentSessionId,
  reference})` / `view(id)` / `send({sessionId,text})` / `stop(id)` / `close(id)`。
  `open` 上限 8 张卡（`BUSY`「请先关闭一个解释卡片。」）；`view/send/stop` 的 `_card` 失败抛 `INVALID_REQUEST`
  「解释卡片已关闭。」。构造参数 `getContext / hasParent / onEvent / clientVersion / fetchImpl / timers`。
  `DetailEvent = ChatSessionEvent | {type:'reset'} | {type:'state', sessionId?}`。
- **`desktop/main/kits/catalog.ts`** —— `localKits(settings)` → `KitLibrary{directory, enabled, configPath?, kits: LocalKit[]}`；
  `LocalKit{name, version, description, directory, command, tools, compatible, eager, problem?}`。
  **没有 `id` 字段**：BD 的 `listInstalledComposerKits` 会读 `.being-desktop-install.json` 回执把市场 ID 找回来，
  本仓库的 `kits/install.ts` 只写 `.beings-install.json{sha256, installedAt}`，**没有 id**。→ 偏差 D3。
- **`desktop/main/town/session/session.ts`** —— `getMembers({signal?, force?})` → `{members: TownMember[], source}`，
  `TownMember{id, name, description}`；`memberCacheState()` → `{revision, expiresAt}`；`invalidateMembers()`。
  `TownSubsystem` 导出 `client/session/background/pairing/cachedReads/identityKey()/invalidateMembers()`。
- **BD `renderer/composer-helpers.js`（62 行）** —— `tokenAtCaret(text,start,end)`（`/(^|\s)([/@])([^\s/@]{0,200})$/u`，
  要求 start===end）、`composerSuggestions(data, token)`（大小写不敏感子串匹配 `name handle id description`，
  handle 前缀命中的排前面，取 12 条）、`replaceComposerToken(text, token, item)`（插 `prefix+handle`，
  后面没有空白就补一个空格并把 caret 放到空格后）、`composerReferences(text, items, prefix)`
  （marker 前必须是行首或空白、后必须是结尾或标点）、`buildKitPrompt(text, kits)`（内置能力段 + 远端 Kit 段，
  两段用 `\n` 连，再空一行接原文）。
- **BD `renderer/town-mentions.js`** —— 聊天 composer 用到的是 `memberMap / memberName / resolve / unresolvedNotice`：
  `resolve` 只认精确 ID（`t_` 前缀或目录里有的 id），其余进 `unresolved`；
  `unresolvedNotice` 文案「未解析提及：@x；按原文发送，可能不会触发通知。请从候选列表选择完整 Town ID。」。
  本仓库 `renderer/town/models/mentions.ts` 是 I1 的**显示向**投影（`mentionNames/mentionParts/mentionWarnings`），
  与 composer 的解析无关，**不能复用也不许改**；本单元自建 `renderer/conversation/models/mentions.ts`。

### 1.6 渲染层现状与 BD 界面规则来源

- **`renderer/conversation/`（P1 移植）**：`models/{conversation,composer,organizer,transcript}.ts`、
  `components/{conversation,composer,messages}.tsx`、`styles.css`。
  `transcript()` **丢掉了 `view.workerResults`**（BD `chat-app.js:427` 是 `interleave` 的第一组暂存项）；
  `ComposerModel` 没有补全、没有 notice；没有选区工具条、没有解释卡片。
- **BD 类名（`test/chat-worker-results-ui.cjs` 实测）**：`.chat-worker-result` / `.chat-worker-status` /
  `.chat-worker-open` / `.chat-worker-summary` / `.chat-worker-evidence`；状态词典
  `{passed:'已完成', failed:'未完成', needs_verification:'待补充验证', ready:'结果已就绪'}`，未知值落「待补充验证」。
  卡片外层是 `article.chat-message.is-being` + `.chat-meta`（beingName · clock）。五条断言：
  ①卡片含 review 文本 + 状态 + 恰好一个「打开预览」；②点开传 `{sessionId, workerId}`；
  ③切到别的会话 0 张；④切回仍是 1 张（不重复）；⑤summary 是纯文本，不能生成 `img`。
- **BD `renderer/chat-selection.js`（224 行）**：`referenceChip(references, {remove, removeOne, onClose})`
  与 `install({root, stream, input, …})`。工具条 `.chat-selection-toolbar`（两个按钮「添加到对话」「更多详情」，
  `role=toolbar`），选区必须落在 `.chat-body` 内且在 stream 里；Escape 清选区并回焦输入框；
  滚动/resize/换会话/断连都 hide。解释卡片 `.chat-detail-card`（`role=dialog`，`aria-label='更多详情 · 临时会话'`），
  含 `.chat-detail-header`（`更多详情` + `.chat-detail-badge='临时会话'` + `.chat-detail-close='×'`）、
  `.chat-detail-notice='关闭后不保留本地卡片；Being 仍可能保留对话并共享记忆。'`、`.chat-detail-source`（引用 chip）、
  `.chat-detail-messages`（`role=log`）、`.chat-detail-status`（`role=status`，初始「正在打开…」）、
  `.chat-detail-composer`（`.chat-detail-input` placeholder「继续追问…」+ `.chat-detail-stop='停止'` + `.chat-detail-send='↑'`）。
  打开后自动发第一问：「请解释所选文本的含义，补充必要的背景，并用一个具体例子帮助我理解。」
  每个父会话同时只有一张卡（再开会先关旧的）；`chatDetailStop` 返回 `stopped:false` 时状态写
  「当前回复不属于这张卡片，未停止其他会话。」；`type:'reset'` 事件直接清空所有卡片且**不再**发 close/stop。
- **BD `renderer/chat-composer.js`（148 行）**：菜单 `.chat-composer-menu`（`role=listbox`）、
  `.chat-composer-heading`（kit：「已安装 Kit · 内置能力」；member：「通知 Being · 消息将公开到篝火」）、
  `.chat-composer-option`（`role=option`，`.chat-composer-icon` + `.chat-composer-copy` 里 `strong` 是
  `prefix + (member ? name : handle)`，`.chat-composer-detail` member 是 `@id · description`）、
  `.chat-composer-empty`（加载中「正在加载…」/ 错误文案 / `token.query ? '没有匹配结果' : '暂无 Being 成员'`）、
  `.chat-composer-retry`（图标按钮，`aria-label='重新加载'`，只在有 error 且非 loading 时出现）、
  `.chat-composer-notice`（`aria-live=polite`，行用 ` · ` 连接）。
  键盘：Escape 记 `dismissed` 并关；↑↓ 循环；Enter/Tab（无 shift）有候选就选、没有就关。
  `prepare(text, event)`：输入法未结束抛「请完成输入后再发送。」；有提及且事件非 trusted 或
  `connectionRevision` 不是安全整数 → 「请在输入框按 Enter 或点击发送，确认公开通知 Being。」；
  含 `\0` → 「公开通知不能包含空字符，请检查消息内容。」；>20 位或正文 >4000 → 「公开通知最多提及 20 位 Being，消息不能超过 4000 字。」。
  `publish(plan, result)`：`!ok || (!streamed && !spliced)` → 「聊天送达状态待确认，尚未发布篝火通知；不会自动重发。」；
  epoch 变或断连 → 「Being 连接已变化，尚未发布篝火通知。」；收据无 id → 「篝火通知未确认送达，请打开篝火检查；不会自动重发。」。
  发送文本经 `buildKitPrompt` 展开（公开到篝火的用 `raw`，**不含** Kit 指令）。
- **`⌘1–9`**：BD `renderer/desktop-menu.cjs:35` 把 `⌘<数字>` 映射成 `task-<n>`，
  `renderer/sidebar.js:280` 取 `ordered().filter(!archived)[n-1]` 并 `select(id)`。
  本仓库 `OrganizerModel.ordered()/metadata()` 已经是同一套；`page.tsx` 现有的 `⌘1 → navigate('chat')` 会被本单元替换。
- **`tests/orchestration-native-results.test.ts`** 里 I4 留给本单元的那条：
  `const version = sessions.snapshot().version; sessions.workersChanged(); expect(snapshot().version > version)`。

---

## 2. 装配点

| 位置 | 改动 |
| --- | --- |
| `desktop/main/subsystems/chat.ts` | `new ChatSessions({…})` 补上 P1 留空的四个参数：`prepareMessage`（`nativeMessageContext` 包 `desktopEnvironment`）、`generateTitle`（先 `sanitizeText(input, [token, relaySecret])` 再交编排）、`titleAvailability`（`[revision, readyAgents]` 指纹，身份不符返回 `''`）、`getWorkerResults`（`nativeWorkerResults(manager.workers, id)`，身份不符返回 `[]`）。另新建 `ChatDetails` 并注册两组 IPC。 |
| 同上 | 跨子系统一律惰性：`orchestration()` / `tools()` / `town()` 三个闭包，构造期不解引用 `ctx.registry`。`sameIdentity()` 是 BD `chatSessions.identityKey === orchestration.owner` 的那对校验。 |
| `desktop/renderer/app/page.tsx` | **仅 keyboard 块**：`⌘/Ctrl + 1–9` → `navigate('chat')` + `organizer.listed(sessions)[n-1]` 的 `select(id)`。 |
| `desktop/renderer/app/models/registry.ts` | append 两行（import + `FEATURE_MODELS` 项）：`conversationMentionsModel`，即 composer 的 `@` 成员目录 / 公开通知模型，需要 `start()` 订阅所以走 FeatureModel。 |

## 3. IPC 清单

新增七条（全部经 `ctx.handle`，命名 `beings:<kebab-case>`）：

| 通道 | 形状 | 包络 | 出处 |
| --- | --- | --- | --- |
| `beings:chat-detail-open` | `{parentSessionId, reference:{text, source}}` → `ChatDetailCard` | 是 | BD `src/main.cjs:126` 把五条 `chatDetail*` 放进 `townMethods` |
| `beings:chat-detail-view` | `sessionId` → `ChatDetailCard` | 是 | 同上 |
| `beings:chat-detail-send` | `{sessionId, text}` → `ChatSendResult` | 是 | 同上 |
| `beings:chat-detail-stop` | `sessionId` → `ChatStopResult` | 是 | 同上 |
| `beings:chat-detail-close` | `sessionId` → `boolean` | 是 | 同上 |
| `beings:chat-worker-result` | `{sessionId, workerId}` → 描述符 | 否 | BD `chatOpenWorkerResult` 不在 `townMethods` |
| `beings:chat-detail-event`（推送） | `ChatDetailEvent` | — | 只发主窗口 |

改动一条：`beings:chat-composer-data` 从「无参数、返回空壳」变成接受 `{force?:boolean}`（原型必须是 `Object.prototype`，多一个键即 `INVALID_REQUEST`「成员刷新参数无效。」），返回 `kits / members / kitsError / membersError / connectionRevision / revision / expiresAt`。

## 4. 决定与偏差

- **D1 副本收敛是核实而非施工。** 方案 §3.5 要求删 `chat/context.ts`、改 `chat/titles.ts` 的 `sanitizeText`、把 `chat/connection.ts` 的 `beingIdentityKey` 改成一行代理——I0 已经一次做完（`docs/migration/i0-seams.md`）。本单元逐条核实后未再改动。
- **D2 Portal 归属（定案 5.2）的映射表** 写在 `chat/environment.ts` 的 `portalRuntime`，九行（八个 phase + 无状态），由 `tests/chat-integration-environment.test.ts` 逐行钉住。`conflict === true` 一律 `health: 'unhealthy'`；`name` 只在 `managed === true` 时claim `being-desktop`；`management` 只有 `phase === 'external'` 才是 `'external'`。
- **D3 `PortalState` 拿不到（未决）。** `main.ts` 把 `PortalSupervisor` 留在自己的闭包里，没有传给 `installDesktopExtensions`；`SubsystemContext` 也没有这个字段，而 `subsystems/types.ts` 与 `main.ts` 都是本单元不得修改的文件。因此 `subsystems/chat.ts` 传 `getPortalState: () => null`，帧里 `portal.status` 恒为 `not_configured`、`health` 恒为 `unknown`。**未把整个 `portal` 置 null**：帧正文有一句「已有部署的配置名见 `runtime.portal.configuredName`」，置 null 会让这句话指向不存在的字段；`configuredName` 与 `workspace` 来自已保存的 profile，是真值。方向上偏保守（Being 会更谨慎而不是更大胆），但仍是错的，列进 openIssues。
- **D4 Kit 没有市场 ID。** BD 的 `listInstalledComposerKits` 读 `.being-desktop-install.json` 回执把市场 ID 找回来，本仓库 `kits/install.ts` 只写 `.beings-install.json{sha256, installedAt}`。因此 composer 的 kit `id` 用 handle 兜底，`icon` 恒为 `''`（菜单画名字首字母）。
- **D5 `ChatComposerEntry.builtin` 从 `boolean` 改成 `string`**（`'search' | 'browse' | ''`）。BD `buildKitPrompt` 对两个内置能力展开的是**不同**的指令段，布尔量表达不了，P1 的占位类型在这里必须让位。
- **D6 `⌘1–9` 的计数顺序是「最近」，不是「屏幕上第几行」。** BD 0.8.26 的 `renderer/app.js:1300` 只绑 `⌘B` / `⌘,`，`⌘<数字>→task-<n>` 来自 `renderer/desktop-menu.cjs:35` 的菜单加速键；本仓库没有那张菜单，规则照 `renderer/sidebar.js:280` 实现在 keyboard 块里，`⌘1` 保留原来的「切到对话页」含义。
  **注意这里踩过一次坑**：侧栏 `render()`（`sidebar.js:98`）画的是「置顶段 → 项目段 → 其余」的分组顺序，但 `command` 用的是
  `ordered().filter(!archived)[n-1]` —— 纯 recency，无视分组。也就是说 BD 里 `⌘3` 是「你第三近碰过的会话」，不是「屏幕上第三行」。
  `OrganizerModel.listed()` 一开始按分组顺序写（看起来更合理：数第几行就是第几个），复核 BD 源码后改回 recency：
  这是行为移植，不是行为优化，而且 recency 的编号在置顶/取消置顶时不会跳。`tests/conversation-model.test.ts` 加了一条钉住它
  （置顶把行挪到屏幕顶端、但不改它的编号；归档的会话不占编号）。
- **D7 E2E 锚点与方案写的不同。** §6.1 写 `#client-main` / `#startup-screen[hidden]` / `.chat-message[data-role=user]` / `.chat-live`——真实代码是 `#connect-button` / `.chat-native` / `.chat-message.is-user` / `.chat-message.is-being.is-live`（`components/{messages,composer}.tsx` 实测）。按真实类名写。
- **D8 夹具必须报告活跃流。** `/api/stream/active` 一律 204 时，`BeingChat.stop` 的 `probe()` 得到 `verdict: 'gone'` 就返回 `{stopped:false, reason:'idle'}`，**根本不会发 `POST /api/stop`**——第一次跑就是这样超时的。夹具改成在流打开期间返回 `{stream_id, origin:'human', events:[{event:'content_block_delta', data:{scene_id}}]}`，`speaking` 才为真、场景才可证明属于本会话，停止才是真的停止。
- **D9 控制字符必须写成转义。** `renderer/conversation/models/{directory,worker-results}.ts` 与 `tests/conversation-renderer.test.ts` 一度把 `\x00`、`\x1f`、`‪` 等直接写成了裸字节，git 因此把三个文件当二进制（`Bin 0 -> N`），合回 next 时会变成二进制冲突而不是可读 diff。已按 BD `renderer/town-mentions.js:6` 与 `common/sanitize.ts` 的写法改回文本转义，运行时行为不变。

## 5. 关键用例

- `tests/chat-integration-frame.test.ts`（4 条，P1 复审的验收条件逐字）：wire 带 v1 帧且 `unwrapMessage` 原样剥掉 / 落盘 `StoredRow.content` 不带帧 / 编排开启时帧里含 `[Being Desktop Orchestrator mode]` 段且 `JSON.stringify(mode)` 在内 / `assertCurrent` 在发送中途切换编排模式时抛 `SESSION_CHANGED`。
- `tests/chat-integration-environment.test.ts`：`portalRuntime` 的九行映射表 + 帧字段形状。
- `tests/chat-integration-composer.test.ts` / `-details.test.ts`：composer 数据的白名单校验与 revision 回显；七条卡片通道的包络、上限 8 张、`reset` 语义。
- `tests/conversation-renderer.test.ts`（30 条）：BD `test/chat-worker-results-ui.cjs` 的 5 条、`chat-composer-ui.cjs`、`chat-selection-ui.cjs`、`chat-conversation-ui.cjs` 里与对话页新增行为相关的规则逐条映射。
- `tests/orchestration-native-results.test.ts`：I4 记录里点名留给本单元的那条「验收卡片可见」断言已补上（`workersChanged()` 抬 `snapshot().version`），并把该文件里 10 条 deferred 用例重新启用。

## 6. 冒烟与门槛

- `npm run typecheck`：绿。
- `npx vitest run`：**114 文件 / 1271 通过 / 24 跳过**（基线 109 / 1197 / 34）。新增 5 个测试文件、+74 通过；重新启用 10 条 skip（34 → 24）。既有用例一条未删、未弱化。
- **打包真跑**：`PORTAL_DESKTOP_MAC_LOCAL_TEST=1 npx electron-forge package`（绕代理）+ `codesign --force --deep --sign -`，`resources/heart-portal` 用 clang 编的 Mach-O stub（`--version` 打印 `heart-portal 0.0.0`）。
- **`tests/electron-smoke.mjs`：18 条全过**（在最终树上重新打包后又跑了一遍，仍全过）（§6.1 的 10 步全部走到）。覆盖：打包客户端启动 → 真实设置对话框连接夹具 → 侧栏一个会话 → 基线 `GET /api/history` 恰好一次 → 发一句 → `.chat-message.is-user` + 流式行 → `POST /api/chat/stream` 的 body 带 `scene_id`（`desktop-<uuid>-<uuid>`）/ `scene_meta.scene_label` / `scene_meta.client` / `client_ref`，`message` 带 v1 帧且声明长度属实、剥掉后正是人说的话、帧里 `chatSessionId` 等于场景里的会话 UUID、直接模式无 orchestrator 段、token 不在 body 任何位置 → 停止按钮 → `POST /api/stop` 恰好一次 → 重启后会话、标题、双方消息都在，且转写里没有 `request context v1`。
- 未跑：`npm run test:all` 全量（会串行占用四个 worktree 共用的 E2E 锁，且包含其它单元的脚本）。本单元只保证 `electron-smoke` 从「skipped」变「passed」，§6.3.4 的「skipped 名单只减不增」在这一项上成立。
- `npm run start` 开发实例未单独跑：打包产物启动（§6.3 第 3 条，更强的一条）已真跑通过。

## 7. 未做 / 存疑

1. **D3：帧里的 `portal` 运行态是假的**（恒 `not_configured` / `unknown`）。要修必须动 `subsystems/types.ts` 或 `main.ts` 给 `SubsystemContext` 加一个 Portal 状态读取口——两个文件本单元都不能碰。建议 IM 收敛时加一个 `ctx.portalState?: () => PortalState | null`，`chat/environment.ts` 已经预留 `getPortalState` 参数，接上即可，`portalRuntime` 与它的表不用改。
2. **D4：composer 的 Kit 没有市场 ID、没有图标**，与 BD 的菜单在这两处观感不同。要对齐得让 `kits/install.ts` 把市场 ID 写进安装回执，属 Kit 安装链路，不在本单元范围。
3. `connectionCleared()` 依然没有调用方（I0 记录里就存在的缺口）：Being 被清空时卡片的 `details.reset()` 因此不会触发。本单元没有扩大这个缺口，也没有修——接线在 `main.ts`。
4. `tests/town-sdk.mjs` / `tests/town-ui.mjs`（I1 重写、从未执行）本单元未代跑，按分工归 IM 在打包客户端上真跑。
