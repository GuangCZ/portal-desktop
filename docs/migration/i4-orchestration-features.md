# I4 · 编排 + 功能任务账本（集成单元）

基线：`next` @ 9794cab。分支 `i4-orchestration-features`。日期 2026-09-16。

## 阅读摘要

### integration-plan.md §3 统一约定 / §3.4 / §2.1 / §2.4 / §4 / 附录单元索引
- 独占目录：`main/subsystems/orchestration.ts`、`main/orchestration/{ipc,instructions}.ts`、
  `main/features/{ipc,history-cache,town-sync}.ts`、`renderer/orchestration/`、`renderer/features/`。
- 共享文件只允许 append 一行：`main/extensions.ts` INSTALLERS、`preload/channels/index.ts`、
  `shared/desktop-types.ts` re-export、`shared/types.ts` 的 `DesktopAPI`、`renderer/app/slots.tsx`、
  `renderer/app/models/registry.ts`。`main.ts`/`package.json`/`forge.config.ts`/`vite.*.config.ts` 绝不改。
- IPC：`being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  BD 标「Town 包络」用 `chatErrorEnvelope` 返回。
- §2.1 注册表：install 同步体只构造自己的实例，跨子系统一律惰性 `ctx.registry.get(...)`；
  `SubsystemMap` 用 `declare module './types'` 扩展；`linked?()` 生命周期用于 presentation 赋值（I2 侧赋值）。
- §2.4 插槽：`PANEL_SLOTS` / `SIDEBAR_SLOTS` / `TOPBAR_SLOTS` / `SHEET_SLOTS` + `FEATURE_MODELS`。
- §4：I4 属并行组 A；合回顺序 I3 → I2 → I4 → I1 → I6 → I5 → I7。
- §3.4 装配对照 BD `src/main.cjs:163-176, 359-362, 122, 495-520, 721-735`。
- §3.4 IPC 表：`beings:orchestration`、`-inspect`、`-save`(串行)、`beings:worker`、`worker-cancel`、
  `worker-retry`、`workers-reconnect`、`beings:feature-tasks`、`feature-task`、`feature-task-end`、
  `feature-task-discuss`(串行)，推送 `beings:workers`、`beings:feature-tasks`。
- 定案 5.2：**不存在** `beings:portal-deploy`；`featureMethods` 放 `main/features/methods.ts`，各单元自传通道名。
- 要收敛的副本：`orchestration/vendored.ts` 整个删除；`orchestration-policy.ts` 的两个 `default*` 删除改注入；
  `tests/features-feature-task-history.test.ts` 四份本地副本删掉改 import。

### docs/migration/i0-seams.md（接缝权威说明）
- `linked?(): void` **已经在** `DesktopSubsystem` 上（I0 复审后补），在全部 installer 跑完后按安装顺序同步跑一趟，
  错误报 `${key}-linked`。→ I2 用它赋 `orchestration.presentation`，本单元只需暴露可被赋值的实例。
- `SubsystemSettings` 与方案偏差：拆成 `settings: Settings` + `extras: Readonly<Record<string, unknown>>` + `saveExtra(patch)`。
  **编排模式不在 `Settings` 里**（0.8.x 不认识），读写一律走 `extras.orchestration` / `saveExtra({ orchestration })`。
- `ctx.push` 已带窗口守卫；`ctx.handle` 已带来源校验与 quitting 守卫。
- `main/common/` 四个模块已存在并**已一次性收敛全部副本**：`orchestration/vendored.ts` I0 已删，
  `agent-process.ts`/`agent-kits.ts`/`worker-callbacks.ts` 的 import 已改指 `common/*`。→ §3.4「要收敛的副本」第一项**已完成**，本单元只需核实。
- renderer：`FeatureModel = Store & { start?(): () => void }`，`start()` 返回 cleanup；订阅一律放 `start()`。
  插槽排序 `order` 升序（用百位），同 order 按 key 字典序；`page.tsx`/`sidebar.tsx`/`topbar.tsx` 已接好，不需再改。
- shared 类型名不得撞车（`export *` 静默丢弃），按 `Chat*` 加前缀。

### desktop/main/subsystems/types.ts（158 行）与 extensions.ts（191 行）
- `SubsystemContext`：`handle` / `exclusive` / `window()` / `store` / `electron` / `userData` / `desktopId` /
  `clientVersion` / `fetchImpl` / `onError` / `registry` / `push`。
- `installSubsystems(ctx, installers)` 导出给测试；`INSTALLERS` 模块私有。四个扇出：install → linked → verified/cleared → quitting(逆序)。
- `registry.get` 返回 `null`（不是 undefined）；`require` 抛「子系统 X 未安装。」。

### desktop/main/subsystems/chat.ts（107 行，模板）
- `ChatSubsystem { readonly sessions: ChatSessions | null }`，`declare module './types'` 加键。
- `connectionVerified` 同步、fire-and-forget，`ready` 是最后一次 `start()` 的 promise。

### preload/channels/{bridge,chat,index}.ts 与 shared/{types,desktop-types}.ts
- `bridge.ts` 导出 `subscribe<T>(channel, cb)` 与 `enveloped<T>(channel, ...args)`（后者解 `chatErrorEnvelope`）。
- `channels/index.ts` 的 `desktopChannels = { chat }`；`shared/desktop-types.ts` 只有 `export * from './chat-types';`。
- `shared/types.ts` 的 `DesktopAPI` 追加区在 111 行 `chat: ChatAPI;`，按字母序插在其后。

### docs/migration/u6-orchestration.md（833 行）
- 九个模块已移植：`types/worker-events/native-worker-results/agent-kits/agent-process/orchestration-policy/worker-callbacks/orchestration`
  （`vendored.ts` I0 已删并改指 `common/*`）。测试 `tests/orchestration-{policy,agent-process,manager,worker-callbacks,native-results}.test.ts`。
- 集成阶段注入点：`OrchestrationPolicy.validDesktopId`/`desktopPortalName`（→ app/identity.ts）；
  `createCallbackSender`/`createContinuationSender` 的 `parseConnection`/`sessionPartition`（→ common/loom-connection）、`fetchImpl`（→ net.fetch）、
  `getTarget`（→ link.capabilities().place）；`WorkerCallbacks` 的 `send/resume/ready/toolsReady/report`；
  `Orchestration.presentation`（I2）、`assertEnforced`/`enforcement`（policy）、`getExecutionContext`。
- BD boot() wiring 原文已抄进该文档 654-680 行，与方案 §3.4 一致。
- `tests/orchestration-native-results.test.ts` 缺的最后一条断言（`sessions.workersChanged()` 让 snapshot.version 递增）属 I5。

### docs/migration/u7-features.md（758 行）
- 四个模块已移植：`feature-tasks/feature-task-runner/feature-task-history/feature-task-discussion` + `types.ts`。
- `FeatureTaskHistory` 的 `normalizeTownSyncRecords` 是**必填注入**（I0/u7 没有实现），本单元要建 `features/town-sync.ts`。
- `discussFeatureTask` 的 `prepareDraft` 改成必填注入（BD 是 `prepareLoomDraft` 默认值）。
- BD main.cjs 注入面（u7 文档 625-670 行）已逐段抄录：`loadFeatureHistory` / `publishFeatureTasks` /
  `featureHistoryCurrent` / `registerFeatureRequest` / `handle()` 的 SESSION_CHANGED 三处 / `endFeatureTaskTracking` 判定 / 退出 flush。
- **收尾动作**：`tests/features-feature-task-history.test.ts` 的四份本地副本（`normalizeTownSyncRecords`/`libraryRoute`/`detailId`/`RESERVED_SCROLL_IDS`）必须删掉改 import。

### desktop/main/orchestration/types.ts（493 行）与 features/types.ts（114 行）
- 编排 DTO：`OrchestrationSnapshot`、`WorkerRecord`/`WorkerSummary`（Summary = 去 events/result/taskPrompt + eventCount）、
  `AgentRecord`、`OrchestrationMode{enabled,defaultAgent,paths}`、`PolicyState{status,scope,detail?}`、`BridgeCapabilities{status?,place?,tools?}`。
- `CallbackManager` 是 `Orchestration` 被 `WorkerCallbacks` 驱动的子集。
- 功能任务 DTO：`FeatureTaskRecord`、`FeatureTaskSnapshot`、`FeatureTaskLedger`、`TownSyncRecord`、`NormalizeTownSyncRecords`、
  `FeatureTaskContext`、`PrepareFeatureTaskDraft`。

### BeingDesktop src/orchestration-message.cjs（56 行）
- `orchestrationInstructions(mode)` 在第 4–14 行；`mode?.enabled` 为假返回 `''`。
- 实测（`node -e` 直接 require 真实模块）：`{enabled:true,defaultAgent:'codex',paths:{}}` 输出长 **1508** 字符，
  以 `[Being Desktop Orchestrator mode]\n` 开头，以 `JSON.stringify(mode) + '\n[/Being Desktop Orchestrator mode]\n\n'` 结尾。
- 夹具已抄到 scratchpad（3115 字节的源码片段）；测试里放**源码逐字节副本**。
- portal-desktop 的注入点：`desktop/main/chat/frame.ts:46` `setOrchestrationInstructions(impl)`，
  其 mode 类型是 `{ enabled?: boolean } & Record<string, unknown>` —— 我的 `orchestrationInstructions` 形参必须用同一形状才能直接传入。

### BeingDesktop src/main.cjs 装配段（实读行号）
- 114–122：`townSyncRecords/featureHistory/featureHistories(WeakMap)/openFeatureHistories(Set)/featureHistoryCache(Map)`
  + `featureMethods`（16 项 + 2 项 Grove）+ `taskRunner`。
- 163–176：`new Orchestration({...})` + `callbacks.setTransport({send,resume,ready,toolsReady,report})`。
  `ready: () => !exitStarted && Boolean(connection) && state.connection.status==='connected'`。
- 359–362：`new OrchestrationPolicy({getIdentity,getDesktopId,getBridge,getMode,onChange})` + `orchestration.assertEnforced=...`。
- 490–520：`loadFeatureHistory` / `publishFeatureTasks` / `featureHistoryCurrent` / `registerFeatureRequest`。
- 721–735：`handle()` 的三段守卫（sdkReadMethods 直通 → featureMethods+!current 抛 SESSION_CHANGED → taskRunner.run + serialized→mutationTail）。
- 1118–1134：编排 7 条 IPC（`getOrchestration`/`inspectAgents`/`getWorker`/`cancelWorker`/`retryWorkerCallback`/`reconnectWorkers`/`saveOrchestration`）。
  `inspectAgents(paths)` = `orchestration.inspect(normalizeMode({paths}).paths)`。
- 1241–1251：`getFeatureTasks`/`getFeatureTask`/`endFeatureTaskTracking`（reading 判定）/`discussFeatureTask`。
- 1623：退出时 `[...openFeatureHistories].map(h => h.flush())`。
- SESSION_CHANGED 三句（逐字）：`'连接身份已变化，请重新读取功能任务。'`（restore 后）、
  `'连接身份正在切换，请稍后重新选择功能。'`（handle 守卫）、`'连接身份已变化，请重新选择功能。'`（serialized 执行前）。

### BeingDesktop src/loom-town-sync.cjs 第 9–29 行
- `normalizeTownSyncRecords(value)`：MAX_RECORDS=256、只取尾部 256 条；`Object.getOwnPropertyDescriptor(value,index)?.value`；
  原型必须是 `Object.prototype`；恰好四个自有键 `requestId/route/beingId/prompt` 且都是 value 描述符的 string；
  requestId 必须 UUID（version 1-8、variant 89ab）；route 必须在 7 条 bonfire/fireside 白名单内、或 `libraryRoute(route)`、
  或 `/^\/desktop\/channel\/(feishu|wechat)\/(begin|status)$/`；beingId `/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/`；
  prompt ≤160000 且以 `[Being Desktop Town sync:<requestId>]` 开头；`prompt.replace(/\s+/g,' ').trim()`；
  同 requestId 不同内容 → 双方都丢弃并记入 conflicts。
- 依赖 `libraryRoute`（BD src/town-library-contract.cjs）→ 本仓库**已存在**
  `desktop/main/town/session/library-contract.ts` 的 `libraryRoute`/`detailId`/`scrollId`（含 RESERVED_SCROLL_IDS）。

### tests/architecture.test.ts（199 行，八条）
- 无规则禁止 `main/features/` import `main/town/`；`main/common/` 只准 node 内建；`main/subsystems/` 不准 import electron。

### BeingDesktop renderer/orchestration.js（156 行）与 test/orchestration-ui.cjs（199 行）
- 四个词典逐字：`names`（starting 正在启动 / queued 排队中 / running 执行中 / stopping 正在停止 / completed 已完成 /
  failed 失败 / cancelled 已取消 / interrupted 已中断）、`reviews`、`deliveries`、`agent status` 五项。
- `active(worker)` = status ∈ {starting,running,queued,stopping}；`hasActiveWorkers(sessionId)` 供侧栏活动灯。
- `appendSession`：分组标题 `${n} 个 Worker · ${m} 执行中`、折叠状态存 localStorage `being.workerGroups.collapsed`、
  箭头 ▾/▸、动作文案「收起/展开」、`worker-caption` = `${agentId} · ${names[status]}${review ? ' · '+reviews[...] : ''}`。
- 设置页：四个 kit 行（codex/claude/cursor/grok 与中文名）、`自动从 PATH 检测，或填写程序绝对路径`、
  自动保存（无保存按钮）、失败后出现「重试」、`showModeStatus` 三句文案、`worker-reconnect` 两句文案。
- Worker 详情：返回/停止 Worker/停止接续/重试通知-重新接续四个按钮的出现条件、事件 `details` 按 seq 保持展开、
  `仅保留最近 300 条事件；早期事件已截断。`
- UI 测试钉住的规则：Worker running → 会话灯 `talking` 且**优先于**「等待回复」；`session-light-breathe` 动画；
  reduced-motion 下 opacity 恒 1；Worker 输出不清灯；Worker 消失时详情回退为「当前连接下没有此 worker。」。

### BeingDesktop renderer/feature-tasks.js（264 行）
- `featureNames` 9 项、`statusNames` 6 项、`activeStatuses`、`canEnd(task)`（与主进程 `endFeatureTaskTracking` 的 reading 判定同构）。
- 筛选：功能下拉（含「全部功能」）+ 状态下拉六项（全部状态/进行与等待/需要你决定/已完成/未完成/已结束跟踪）+ `${n} 个任务`。
- 详情：执行方式行（`使用 Being，聊天可能等待` / `本机执行` / `执行方式待确认`）、结果标题四选一、
  三个时间项、「打开功能页/到功能页处理」「拿到聊天里讨论」「结束本地跟踪」与各自 hint。
- `persistenceError` → `任务记录暂未保存，重启后可能无法恢复。当前操作不受影响。`

### BeingDesktop docs/interfaces.md §1.1/§1.2/§1.3/§3.9
- §1.1：`featureMethods` 经 `FeatureTaskRunner.run` 记账，身份不一致抛 `SESSION_CHANGED`；`serialized` 进 `mutationTail`。
- §1.2 编排七条与功能任务四条的 payload 已抄进本单元的 IPC 清单（见下）。
- §1.3 推送：`being:workers`（`Orchestration.snapshot()`，50ms 合并）、`being:feature-tasks`（`{tasks, persistenceError}`，身份切换先推空列表）。

### 本仓库既有实现（读一遍的结论）
- `desktop/main/app/ipc.ts` 的 `createTrustedHandle`：来源校验 + quitting 守卫 + `catch → new Error(report(channel, error))`。
  **所以任何 `code` 都活不过 IPC**：BD 里 `featureMethods` 的 SESSION_CHANGED 本来也是裸抛（这四条不在 `townMethods` 里），保真。
- `desktop/main/main.ts:88` 的 `exclusive` = `mutation.then(op)`，无 quitting 判定（quitting 由 `handle` 拦）。
- `desktop/main/app/identity.ts`：`validDesktopId` / `desktopPortalName`（`being-desktop-tools-<uuid>`），与 policy 的默认值逐字相同。
- `desktop/main/common/loom-connection.ts`：`parseConnection(input)` / `sessionPartition(ConnectionIdentity)`；
  `chat/connection.ts` 的 `beingIdentityKey(address)` 是二者的组合代理。
- `desktop/main/chat/sessions.ts`：`snapshot(): SessionsSnapshot{open,version,identityKey:'bound'|'',active,cursor,seeded,degraded,sessions[],recovery}`；
  `workersChanged()`（第 186 行，`if (this.open) this._touch()`）；`get open()`。
  **注意**：`snapshot().identityKey` 是 `'bound'`/`''`，不是真身份；`sessions.identityKey` 字段才是真值。
- `desktop/main/chat/ipc.ts`：IPC 注册模板（`fields()` 白名单、`plain()` 原型校验、`invalid()` 带 code、`enveloped()` 包装）。
- `desktop/main/features/feature-task-runner.ts`：`run(name, args, fn)` 里的 `name` 必须是 **BD 方法名**
  （`OPERATIONS` 的键是 `listScrolls`/`startPortal`/…，`requestTownRead` 特判）。传新 kebab 通道名会让账本定义全部落空。
  → `features/methods.ts` 同时接 `channel`（守卫/日志）与 `operation`（BD 方法名，喂给 runner）。
- `desktop/main/features/feature-task-history.ts`：`identityKey` 必须匹配 `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/`
  （`persist:loom-…` 与 `disconnected` 都满足）；`restore()`/`register()`/`save()`/`flush()`/`records`/`persistenceError`。
- `desktop/main/orchestration/orchestration-policy.ts`：`configure/syncBridge/inspectForMessage/assertEnforced`，
  失败码 `ORCHESTRATION_NOT_ENFORCED`。
- `desktop/main/orchestration/worker-callbacks.ts`：`createCallbackSender({getConnection,fetchImpl,parseConnection,sessionPartition})`、
  `createContinuationSender({...,getTarget})`；`getConnection()` 只需要 `{url}`。
- renderer：`desktop/renderer/app/components/sidebar.tsx:204/244` 已有 `session-activity-light`（talking/waiting/inactive），
  但该文件**不在本单元可触碰清单内** → BD 的「Worker running 让会话灯变 talking 且优先于等待回复」这条规则本单元做不了（写进 openIssues）。
  同理 `appendSession` 的「挂在每个会话行下面」做不到，`SidebarSlot` 只能是 `sidebar-scroll` 里的一个独立段落。
