# I7 · Channel + 草稿入口

集成单元 I7（并行组 B）。基线 `next @ 7b2cef8`，工作分支 `i7-channel-drafts`，日期 2026-09-16。

## 阅读摘要

### `scratchpad/integration-plan.md` §3 统一约定 / §3.7 / §2.1 / §2.4 / §4 / §6 / 附录

- 统一约定：独占目录只本单元改；共享文件只 append 一行（`extensions.ts` INSTALLERS、`preload/channels/index.ts`、
  `shared/desktop-types.ts`、`shared/types.ts` 的 `DesktopAPI`、`renderer/app/slots.tsx`、`renderer/app/models/registry.ts`）；
  IPC `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；串行进 `ctx.exclusive`；Town 包络用 `chatErrorEnvelope`；
  协议以实测文档为准；注入替身用类实例。
- §3.7（本单元）：独占 `main/subsystems/channel.ts`、`main/town/channel/{ipc,draft}.ts`、`renderer/channel/`、
  `tests/channel-integration-*.test.ts`、`tests/draft-integration.test.ts`。
  IPC 表：`beings:channel-begin`（功能任务）、`beings:channel-check`（功能任务，BD IPC 名 `checkChannelStatus`、方法 `getChannelStatus`）、
  `beings:channel-inspect`（只读）、`beings:channel-feishu`（包络）、`beings:town-catalog`、`beings:town-page`、
  `beings:town-draft`（统一一条 `{kind,id?,draft?,connectionRevision?}`，串行）。
  **`beings:portal-deploy` 按定案 5.2 整条跳过**（`TownController` 已在 I1 删除）。
- `prepareNativeDraft` 设计：`createNativeDraft(push, waitAck)` → `(prompt, getContext) => Promise<{prepared:true}>`；
  三条 BD 拒绝文案逐字保留；渲染层复用 `beings:scene-draft` → `placeDraft()` → `beings:scene-draft-result`。
- §2.1 注册表：`SubsystemContext = { handle, exclusive, window, store, electron, userData, desktopId, clientVersion, onError, registry, push }`；
  `DesktopSubsystem = { key, connectionVerified?, connectionCleared?, quitting?, ready? }`；
  install 同步体里**不得**解引用 `ctx.registry.get(...)`，只能存惰性 getter。`SubsystemMap` 靠 `declare module './types'` 扩展。
- §2.4 插槽：`PANEL_SLOTS`（可停靠面板，`visible(app)`）、`SIDEBAR_SLOTS`、`TOPBAR_SLOTS`、`SHEET_SLOTS`（全屏页，按 `view` 匹配）；
  `FEATURE_MODELS` 是 model 工厂表，`AppFeatureModels` 用 `declare module` 扩展。
- §4：合回顺序 IM → I5 → I7 → I6b；冲突点全是 append-only。
- §6：`tests/portal-runtime-e2e.mjs` 归本单元；§6.3 真机冒烟四条（typecheck/vitest、`npm run start`、打包后从产物启动、`test:all` summary skip 只减不增）。

## 进度

- [x] 读方案 §3 约定 / §3.7 / §2.1 / §2.4 / §4 / §6 / 附录

### `docs/migration/i0-seams.md` + 真实接缝文件

- `SubsystemContext` 真实成员：`handle / exclusive / window() / store / electron / userData / desktopId / clientVersion /
  fetchImpl / onError / registry / push`（比方案多 `fetchImpl`）。`store` 是 `SubsystemSettings`：
  `connection / connectionAddress / settings / extras / saveExtra(patch)`（方案的单一 `settings` 被拆成 `settings` + `extras`）。
- `DesktopSubsystem` 多了 `linked?()`（全部 installer 跑完后同步跑一趟，用于「赋值给同伴」的场景）。
- `electron.clipboard` 是 Promise 形态（Electron 44 实测）；`WebContentsView / session / net.request` 是 `unknown`，用处 `as` 一次。
- `installSubsystems(ctx, installers)` 是可测入口；测试只装本单元需要的 installer。
- `main/common/` 已收敛：`sanitize.ts`、`platform.ts`、`loom-connection.ts`、`message-context.ts`；I0 已一次性删完副本。
- 六个一行式冲突点已全部就位；`extensions.ts` 已有 7 个 installer，`preload/channels/index.ts` 有 7 个 key，
  `slots.tsx` 的 `SHEET_SLOTS` **仍为空数组**（Town 是 `page.tsx` 内置的 `<Town>`），`FEATURE_MODELS` 有 6 项。
- `tests/architecture.test.ts` 按目录模式写，新目录自动纳入；`main/common/` 只能 import node 内建与同目录。

### `docs/migration/i1-town.md`（导出面 / IPC / 未做事项）+ `subsystems/town.ts`

- `TownSubsystem { key:'town'; client; session; background; pairing; cachedReads; identityKey(); invalidateMembers() }`。
- I1 **明确没有接 `ChannelBeing`**（文件头注释：「渠道属于后续单元」），`townApp` 快照里的 `channel` 区保持原样。
- 24 条 `beings:town-*` 已注册（`town/ipc-desktop.ts`），其中 `beings:town`（公开目录）与 `beings:town-open`（公开页外链，
  走 `ctx.electron.shell.openExternal`）**非包络**，其余全部包络 `{__townError:true, code, message}`。
  **本单元的 `beings:town-catalog` / `beings:town-page` / `beings:town-draft` 与它们不重名，可安全新增。**
- `TownSession.getChannelStatus({signal})` → `{channels: TownChannelStatus[]}`，正是 `ChannelBeing.readStatus` 要的形状。
- I1 的 `town-controller.ts` / `portal-config.ts` / `portal-release.ts` 与其 32 条 `town-channel-town-controller` 测试**已删**，
  `channel/types.ts` 末尾留了说明段。所以方案 §3.7「重新启用 1 条 it.skip」**已不存在**。
- I1 的基线数字：结束时 1026 通过 / 34 跳过（当前 worktree 实测 1197/34，是并行组 A 五个单元合完之后的）。

### `desktop/main/town/channel/{channel-being,town-catalog,types}.ts`（u3 移植件）

- `ChannelBeing` 构造：`{getContext, getSession?, readStatus?, fetchImpl?, onChange?, onRequest?, createClient?}`；
  方法 `state() / reset() / beginChannelConnection(v) / getChannelStatus(v) / inspectChannelStatus(v) / updateFeishuCredentials(...)`。
  请求体严格两键 `{channel, connectionRevision}`（原型 + 键数 + 值描述符全查），channel ∈ {feishu,wechat}。
  `updateFeishuCredentials` **本地必抛** `INVALID_REQUEST`「应用密钥须在渠道服务的专用配置入口提交，请按 Being 返回的连接说明操作。」
  `getContext()` 要 `{configured, connected, exiting, connectionId, identityRevision, beingName, connection:{url,token,secret}}`。
- `town-catalog.ts`：`getTownCatalog()`（9 个 feature）、`townPageUrl(id)`（只有 home/grove/ember 三个公开页）、
  `prepareLoomDraft`（**死路径，要被 `draft.ts` 取代**）、`prepareTownFeature`（DRAFTS 6 条）、
  `prepareTownAssistance`（ASSISTANCE 6 条）、`prepareFiresideDraft`（拼「围炉消息草稿」前缀）。
  `requireCurrentContext` 的三条文案是 Loom 版；原生版按 §3.7 用 BD 的三条拒绝文案。

### `docs/migration/i4-orchestration-features.md` + `main/features/` 的接口

- `OrchestrationSubsystem` 导出面里本单元要用的三个：
  - `methods.run(args, {operation, serialized?}, body)` —— `operation` 必须是 **BD 方法名**
    （`beginChannelConnection` / `checkChannelStatus`…），传 kebab 通道名会让账本定义全部落空。
  - `register(record, owner?)` —— BD 的 `registerFeatureRequest`，`ChannelBeing.onRequest` 接这个。
  - `setDraftPreparer(prepare: PrepareFeatureTaskDraft | null)` —— **I4 明文留给本单元**：
    `PrepareFeatureTaskDraft = (prompt: string, current: () => FeatureTaskContext) => unknown`，
    `FeatureTaskContext = { connection: unknown; generation: unknown; [k: string]: unknown }`。
    没装之前 `beings:feature-task-discuss` 直接拒绝。
- 渲染层 `FeatureTasksModel.setNavigate((feature, task) => …)`，`FEATURE_NAMES` 已含 `channel: "消息渠道"`；
  I4 明文写「Town 是 I1、Portal 与 Channel 是 I7」，没装之前按钮不画。
- I4 的偏差 1 很重要：**`SHEET_SLOTS` 的标题由壳层从 `renderer/town/models/town.ts` 的 `definitions` 取**，
  那是 I1 的文件；注册进去的 sheet 会顶着错误标题打开。I4 因此改用 `PANEL_SLOTS`。本单元要先核实 `page.tsx` 的真实行为。

### BD `src/main.cjs` 对照段（实读行号）

- `channelBeing` 装配 418-427：`readStatus: options=>townSession.getChannelStatus(options)`；
  `getSession: channel => { if(!chatSessions?.open) throw {code:'NOT_CONNECTED'} '请等待 Being 会话加载完成。'; return chatSessions.ensureChannel(channel); }`；
  `getContext: ()=>({connection, configured, connected: status==='connected', exiting, connectionId: generation, identityRevision, beingName})`；
  `fetchImpl` 外包 `credentials:'omit' + referrerPolicy:'no-referrer'`；`onChange: broadcast`；`onRequest: registerFeatureRequest`。
- `runChannel` 429-435：`const owner=chatSessions, revision=generation; try{return await action()} finally{ if(owner?.open && owner===chatSessions && revision===generation) void owner.syncChannel().catch(()=>{}) }`。
- handle 1329-1332：`beginChannelConnection`/`checkChannelStatus` 走 `runChannel`，`updateFeishuCredentials`/`inspectChannelStatus` 不走。
- handle 1238 `getTownCatalog`、1252 `openTownPage`（`browserLinks().open(townPageUrl(id))`）、
  1253-1255 三个 prepare\*、1262 `prepareTownPairing`（固定提示词已抄录）。
- `featureMethods`（120 行）含 `beginChannelConnection` 与 `checkChannelStatus`；
  `serialized`（136 行）含 `prepareTownFeature` / `prepareTownAssistance` / `prepareFiresideDraft`（**不含 prepareTownPairing**）。
- `channelBeing.reset()` 出现在 711（身份分区变化）、1482（disconnect）、1484（reconnect）、1590。
- `townState()` 523-527：`result.access.channel = channel.status`、`result.channel = channel`。

### BD `docs/channel-sessions.md`（实测记录，优先于源码推断）

- 每个 (Being, Desktop, channel) 一个稳定会话 ID；创建发生在**首次请求发送前**，不改变当前会话或草稿；
  重启保持、重命名不改变关联；切 Being 换一组。
- 请求从第一条起带 `scene_id` / `scene_meta` / `client_ref`，不依赖服务端 `session_id`；
  回复必须属于该 scene 且通过 requestId / beingId / route / channel 校验才更新状态；**202 或中断后不重发**。
- 打开页面 / 切渠道 / 刷新**只读**查询已有绑定（`inspectChannelStatus`），不创建会话、不发 Being 消息、不重新登记；
  `ready` 布尔：就绪＝已连接，未就绪的已有记录＝已登记；已连接时不再显示向导或新建连接按钮。
- 读不到就显示「未能确认状态」，**不判定未绑定**；已有确认结果保留。

### BD `renderer/town-app.js` 的 Channel 页（900-1040）与 `renderer/app.js` 的 Town 目录（815-1010）

- Channel 是 Town app 里的一个**整页** `section.ta-module.ta-channel`，三张卡片
  `feishu 飞书/连接飞书机器人`、`wechat 微信/检查可用连接方式`、`wecom 企业微信/暂不支持`。
- 卡片副标题规则：wecom 恒为「暂不支持」；connected→「已连接」；registered/pending/waiting→「已有渠道登记」；否则「查看绑定状态」。
- 切卡片：`channelRequest+1`、清三个 busy、重置 `{wizard:false,qr:'',detail:'',readError:'',status:'unknown',step:0}` 后并入 `channelStates` 记忆，非 wecom 自动 `inspectChannelStatus`。
- 三态正文：wecom 说明页；已连接 →「{name}已连接，无需重复绑定。」+ 刷新绑定状态 / 请 Being 核对状态；
  未开向导 → 正文默认句（registered 时「{name}已有渠道登记，可继续核对连接状态。」，否则
  「尚未确认已有绑定状态，不代表未绑定。已绑定时无需配置新连接。」）+「请 Being 核对绑定状态」+（非 registered 才有）「配置新连接」；
  向导 → 三步条（飞书 `请求 Being/配置说明/确认状态`、微信 `请求 Being/查看回复/确认状态`）+ 说明 + 二维码 +「请 Being 检查状态」。
- `applyChannelResult`：`status` 默认 unknown；`detail` 回退到 `statusNames[status]` 或「连接状态待确认」；
  pending 时改写成「Being 已收到请求，实际连接状态仍待确认。…」；二维码只认 data:image/(png|jpeg|webp);base64 且 ≤2000000 字节；
  expired/connected/disconnected/disabled 清空二维码；`step = status==='connected' ? 2 : 1`。
- `inspectChannelStatus` 读回 unknown 而本地已有 connected/registered/pending/waiting → 只写
  `readError='当前接口未能确认最新状态，暂时保留上次确认结果。'`，**不覆盖状态**。
  inspect 抛错 → `readError = '{保留上次确认的状态。}{Desktop 暂无权限直接读取渠道状态。|暂时未能读取渠道状态。}这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。'`；
  非 inspect 抛错 → `status='error'`、`detail=errorText(error)`。
- 竞态三重闸：`sameEpoch(requestEpoch) && request===channelRequest && selected===model.channel.selected`。
- Town 目录（`renderer/app.js:819-1010`）：`getTownCatalog()` 读回后**校验 9 个 id 齐全且 mode ∈ {being,web,local,app}**，
  不合格抛「Town 功能目录不完整或格式不正确，请重新读取。」；点击按 mode 分流：
  app→打开对应模块、local→Portal 设置、web→`openTownPage(id)`、being→切到对话页 + `prepareTownFeature(id)` + toast「已填入对话草稿，补充需求后发送」。
