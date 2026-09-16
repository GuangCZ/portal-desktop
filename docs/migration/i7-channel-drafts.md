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

---

## 进度

- [x] 读方案 §3 约定 / §3.7 / §2.1 / §2.4 / §4 / §6 / 附录
- [x] 读 `i0-seams.md` 与六个接缝文件
- [x] 读并行组 A 的 `i1-town.md` / `i4-orchestration-features.md` / `i2-tools.md`（导出面 / IPC / 未做事项）
- [x] 读 u3 的 `channel-being.ts` / `town-catalog.ts` / `types.ts`、BD `src/main.cjs` 装配与 handle 段、
      BD `docs/channel-sessions.md`、BD `renderer/town-app.js` 的 Channel 页与 `renderer/app.js` 的 Town 目录
- [x] `main/town/channel/draft.ts`：`createNativeDraft` / `createDraftAcks` / `requireDraftContext` + 四条文案
- [x] `main/town/channel/town-catalog.ts`：删除 `prepareLoomDraft` 与三个 Loom 版 `prepare*`，改为三个纯函数
- [x] `main/town/channel/ipc.ts`：9 条通道（7 条方案表 + 本地状态读 + 草稿回执）
- [x] `main/subsystems/channel.ts`：装配 + 生命周期 + `linked()` 装 `setDraftPreparer`
- [x] `shared/channel-types.ts`、`preload/channels/channel.ts`
- [x] `renderer/channel/{models,components,slot.tsx,styles.css}`：面板 + 顶栏按钮 + 两个标签页
- [x] `use-conversation-bridge.ts` 扩成「主进程推送也能触发」（本单元的明文例外）
- [x] 功能任务页导航接线（`FeatureTasksModel.setNavigate`）
- [x] 测试：`channel-integration-{ipc,session,renderer}`、`draft-integration`、重写 `town-channel-town-catalog`
- [x] `tests/portal-runtime-e2e.mjs`：对话部分改到原生页，跳过理由改成准确的一句
- [x] 门槛：typecheck 绿、vitest 1234 通过 / 34 跳过（基线 1197 / 34）
- [x] 打包 + 真机冒烟（见「冒烟结果」）
- [x] **第二轮**：按复审结论逐条处理（见「复审处理」），重新打包重跑冒烟，vitest 1238 / 34

---

## 决定与偏差

### D1 · 没有 `beings:portal-deploy`（定案 5.2）

方案 §3.7 表格最后一行的 `deployPortal(request)` 整条跳过。`TownController` / `portal-config` / `portal-release`
与它们的 32 条测试已由 I1 删除，`channel/types.ts` 末尾留了说明段。方案里「重新启用
`tests/town-channel-town-controller.test.ts` 的 1 条 `it.skip`」的对象**已不存在**，本单元没有重新启用任何 skip。
`tests/channel-integration-ipc.test.ts` 有一条断言钉住 `beings:portal-deploy` 没有被注册。

### D2 · 四条 `beings:channel-*` 全部包络，不是只有 `beings:channel-feishu`

方案 §3.7 的表只把 `updateFeishuCredentials` 标为「包络」。**真实代码推翻**：BD `src/main.cjs:125` 的 `townMethods`
含 `beginChannelConnection` / `updateFeishuCredentials` / `checkChannelStatus`，`:130` 又补进 `inspectChannelStatus`，
而 `townMethods` 正是 `src/preload.cjs:62` 那一圈包络的成员表。渲染层也确实依赖它：
`renderer/town-app.js:1027` 用 `error?.code === 'AUTH_REQUIRED'` 区分「Desktop 暂无权限直接读取」与「暂时未能读取」。
所以四条都包络。

`beings:town-catalog` / `beings:town-page` / `beings:town-draft` 不包络（BD 里 `getTownCatalog` / `openTownPage` /
三个 `prepare*` 都不在 `townMethods` 里）。它们的失败全是一句短中文，`desktop/main/app/ipc.ts` 的
`publicErrorMessage` 原样带过去（≤110 字、单行、无路径即保留）。
`prepareTownPairing` 在 BD 里**是**包络的（`docs/interfaces.md:110` 也这么标），但它抛的是 `prepareLoomDraft` 的
无 code 普通 Error，包络不增加任何信息；四种 kind 合成一条通道后统一按不包络处理。

顺带核对 BD `docs/interfaces.md:134`：那一行把四条渠道方法写在一起，「Town 包络」标记只跟在
`updateFeishuCredentials(value)` 后面——方案 §3.7 的表应该就是从这里抄的。`src/main.cjs:125/130` 的 `townMethods`
与 `src/preload.cjs:62` 的成员表是无歧义的，**以代码为准**。同一行确认的其它三点本单元都照做了：
`channel ∈ feishu|wechat`、返回 `{channel,status,detail,qrCodeDataUrl?,appId?,qrCodeUrl?}`、`inspect` 只读。
`docs/interfaces.md:27`「纪元字段」要求 `prepareFiresideDraft.connectionRevision` 必须等于当前 `generation`，
本单元在 `ipc.ts` 的 `prepareDraft` 里比，且在推送之前。

### D3 · **实测推翻方案与既有实现**：`contextBridge` 会吃掉 `error.code`

打包客户端上实测（见「冒烟结果」第 3 行）：preload 里 `Object.assign(new Error(message), {code})` 抛出去之后，
渲染层拿到的 `Object.getOwnPropertyNames(error)` **恰好是 `['stack','message']`** —— `code` 没了。
同一次测量对 I1 的 `beings:town-bonfire` 与 P1 的 `beings:chat-view` 给出同样结果，所以这是外壳的边界问题，不是本单元的。

后果：**包络的全部意义就是让 `code` 过河，而 preload 里重新抛出等于把自己做的事撤销**。
`desktop/preload/channels/bridge.ts` 的 `enveloped`、`channels/town.ts` 的 `townEnveloped` 都是这个形状，
所以 I1 的 24 条通道与 P1 的 5 条包络通道在打包客户端里 **`code` 一律是 `undefined`**，
凡是 `error.code === 'AUTH_REQUIRED'` 这类分支目前都是死代码。已写进「未做事项」，需要合并者决定统一修法。

本单元的修法（只动自己的四个文件）：四条包络通道的 preload **resolve 出信封**而不是抛，
渲染层 `renderer/channel/models/channel.ts` 的 `unwrap()` 在**渲染层自己的上下文里**把它变回带 `code` 的 Error——
不跨界就不会被拷贝。`ChannelAPI` 的四个方法因此返回 `ChannelAnswer<T> = T | ChannelErrorResult`。
`tests/channel-integration-renderer.test.ts` 有一条用例专门钉住「以数据形式到达的失败仍然能分出两句读取拒绝文案」。

### D4 · `waitAck` 返回四态而不是 `boolean`

方案 §3.7 写的是 `waitAck(id, ms): Promise<boolean>`。布尔分不出「已有草稿」与「对话尚未就绪」，
而这两句用户要做的事完全不同（一句让他清草稿，一句让他等）。渲染层分得出来（它握着 conversation 模型），
所以答案是 `DraftAck = 'placed' | 'occupied' | 'unavailable' | 'timeout'`，最后一个由主进程自己给出。

四条文案：未连接「请先连接 Being。」／已有草稿「已有草稿，已保留原文；请先发送或清空后再选择此功能。」／
纪元变化「会话已变化，请重新选择。」／回执超时「对话页面尚未准备好，请稍后重试。」
最后一句不是新造的——它是外壳 `renderer/app/models/workspace.ts` 的 compose 超时原文，同一个条件不该有两种说法。
超时也用外壳同一个 3000ms。

### D5 · Channel 进 `PANEL_SLOTS` 而不是 `SHEET_SLOTS`

BD 的 Channel 是整页（Town app 里的 `section.ta-module.ta-channel`），照 BD 应当是 sheet。**没有这么做**，理由是实测的：
外壳的 sheet 标题由 `page.tsx` 的 `PlaceHeading` 从 `renderer/town/models/town.ts` 的 `definitions` 取，
未登记的 view 会顶着「对话」打开；而往 `definitions` 加一行不只是起名——`TownModel.show()`（:468）与
`applyState()`（:402/:410）都以它为分支，会为一个没有东西可读的页面发起一次 Town 读。那是 I1 的文件。
于是做成可停靠面板 + 顶栏按钮，与 I4 遇到同一约束时的选择一致（`i4-orchestration-features.md`「与方案的偏差」1）。
后续单元往 `definitions` 加一行并给 `feedKind` 开个例外，就能把它搬回全屏页。

### D6 · 面板里两个标签页：「消息渠道」与「Town 功能」

BD 把 Town 功能目录放在主窗口的 `page-town`（`renderer/app.js`），把 Channel 放在 Town app 里，是两个地方。
本外壳没有 `page-town` 的对应物，而 `beings:town-catalog` / `beings:town-page` / `beings:town-draft` 是本单元的通道，
再开第二个面板就要第二个顶栏按钮。合成一个面板两个标签页，规则逐条照搬两处原文。

### D7 · 草稿推送/回执是方案表之外新增的两条通道

方案说「渲染层复用已有的 `beings:scene-draft` → `placeDraft()` → `beings:scene-draft-result` 三段」——
那三个是 `AppModel.post` 上的**渲染层内部消息类型**，不是 IPC。主进程到窗口那一段需要真的通道，于是新增
`beings:composer-draft`（推送）与 `beings:composer-draft-ack`（handle）。名字用 `composer-` 而不是 `channel-`，
因为它服务的是「原生 composer」，与飞书/微信渠道无关（功能任务讨论也走它）。

另新增 `beings:channel-status`（只读本机状态）：渲染层在发第一条请求之前必须知道 `connectionRevision`，
而推送只在变化时才有。**纪元必须是本子系统自己的计数器**——`ChannelBeing._context` 拿它和自己持有的身份比，
借用 Town 的 `identity.connectionRevision` 只要两者失步就会把每一条请求都拒掉。

### D8 · `town-catalog.ts` 不再接受任何注入

`prepareLoomDraft` 与 `requireCurrentContext` / `requireCurrentFrame` 全删（它们是对已删除的 Loom DOM 的注入）。
`prepareTownFeature` / `prepareTownAssistance` / `prepareFiresideDraft` 改成三个纯函数
`featureDraft(id)` / `assistanceDraft(operation)` / `firesideDraft(draft)`，只返回提示词字符串；
组合发生在 `ipc.ts`。围炉纪元检查（`FIRESIDE_EPOCH_CHANGED`）搬到 `ipc.ts`，仍在推送之前。

### D9 · `connectionVerified(null)` 才是真实的断开路径

`i0-seams.md` 记录：`main.ts` 从来没有调用过 `connectionCleared()`。所以本子系统的 `connectionVerified`
在 `next === ''` 时自己做完整的解绑（清地址、连接、身份，纪元 +1，`channel.reset()`，`acks.reset()`，推一次状态），
`connectionCleared()` 仍然实现但不是唯一路径。`tests/channel-integration-ipc.test.ts` 有一条用例钉住这一点。

### D10 · 「另一个 Being 另一组会话」由 `ChatSessions` 保证，本单元只钉住接线

`docs/channel-sessions.md` 的前四条在 `tests/chat-sessions.test.ts`（P1）里已按 store 层钉住。
`tests/channel-integration-session.test.ts` 钉的是那个文件够不着的接缝：**真正上到线上的 `scene_id`**
就是对话层铸出来的那个，跨重启、跨 Being 切换、跨 202 都成立。

---

## IPC 通道清单

`registerChannelIpc`（`desktop/main/town/channel/ipc.ts`）注册 9 条，注册顺序即下表顺序。
全部经 `ctx.handle`（继承来源校验与 quitting 守卫）。

| 通道 | 载荷 | 包络 | 串行 | 功能任务 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `beings:channel-status` | — | 否 | 否 | 否 | 本机状态：`{channel,status,detail,qrCodeDataUrl?,connectionRevision,connected}`，不读服务 |
| `beings:channel-begin` | `{channel,connectionRevision}` | 是 | 否 | `beginChannelConnection` | 请 Being 实际连接渠道；`afterChannel` 尾随一次历史读回。账本写满时信封是 `{code:'TASK_LIMIT_REACHED', message:'功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。'}`（BD `src/main.cjs:740`，见 R2） |
| `beings:channel-check` | 同上 | 是 | 否 | `checkChannelStatus` | 请 Being 只读核对；方法是 `ChannelBeing.getChannelStatus`；账本写满时同上 |
| `beings:channel-inspect` | 同上 | 是 | 否 | 否 | 直接问 Town 服务，**不发 Being 消息、不建会话** |
| `beings:channel-feishu` | 任意 | 是 | 否 | 否 | 恒拒：「应用密钥须在渠道服务的专用配置入口提交…」 |
| `beings:town-catalog` | — | 否 | 否 | 否 | 9 个功能的目录 |
| `beings:town-page` | `id` | 否 | 否 | 否 | 三个公开页，开在**工具浏览器**（`ctx.registry.get('tools')?.links.open`） |
| `beings:town-draft` | `{kind,id?,draft?,connectionRevision?}` | 否 | **是** | 否 | 四种 kind，**每种有自己的字段表**（R4）：`feature`/`assistance` 只许 `id`（可缺，缺时由目录层给 BD 原话）；`fireside` 必须恰好带 `draft` + `connectionRevision`；`pairing` 不许其它键。多余键、访问器属性、符号键、非 `Object.prototype` 原型一律拒 |
| `beings:composer-draft-ack` | `(id, 'placed'\|'occupied'\|'unavailable')` | 否 | 否 | 否 | 渲染层回执；不认的 id 或结论返回 `{settled:false}`，不是错误 |

推送（`ctx.push` → 主窗口，自带窗口守卫）：

| 通道 | 载荷 | 时机 |
| --- | --- | --- |
| `beings:channel-state` | `ChannelWorkerState` | `ChannelBeing.onChange`、`connectionVerified`、断开 |
| `beings:composer-draft` | `{id, text, expiresAt}` | 主进程准备一条草稿时 |

---

## 装配点（对照 BD `src/main.cjs`）

| 装配 | BD 行号 | 本仓库 |
| --- | --- | --- |
| `new ChannelBeing({...})` | 418-427 | `subsystems/channel.ts`：`readStatus` → `registry.get('town').session.getChannelStatus`；`getSession` → `registry.get('chat').sessions.ensureChannel`（未就绪抛 `NOT_CONNECTED`「请等待 Being 会话加载完成。」）；`getContext` 用本子系统自己的 `generation` / `identityRevision`；`fetchImpl` 外包 `credentials:'omit'` + `referrerPolicy:'no-referrer'`；`onChange` 推 `beings:channel-state`；`onRequest` → `registry.get('orchestration').register` |
| `runChannel` | 429-435 | 同名语义的 `afterChannel`：`owner?.open && owner === sessions() && revision === generation` 才 `void owner.syncChannel()` |
| `handle('beginChannelConnection' …)` 等四条 | 1329-1332 | `town/channel/ipc.ts` |
| `handle('getTownCatalog')` / `openTownPage` / 三个 `prepare*` / `prepareTownPairing` | 1238 / 1252-1255 / 1262 | 同上，合成三条 |
| `channelBeing.reset()` | 711 / 1482 / 1484 / 1590 | `connectionVerified`（身份变化与解绑两支）、`quitting` |
| `discussFeatureTask` 的 `prepareDraft` | `src/town.cjs` 的 `prepareLoomDraft` | `linked()` 里 `orchestration.setDraftPreparer(...)`，包一层：先跑 I4 的 `current()` 栅栏，再给本单元的完整上下文 |
| 功能任务页「打开功能页」 | `renderer/feature-tasks.js:116` | `ChannelModel.start()` 里 `featureTasks.setNavigate(...)`，`stop()` 里置空 |

---

## 共享文件触碰行（逐行）

```
desktop/main/extensions.ts
  + import { installChannelSubsystem } from './subsystems/channel';
  +   installChannelSubsystem,                                  // INSTALLERS

desktop/preload/channels/index.ts
  + import { channel } from './channel';
  +   channel,                                                  // desktopChannels

desktop/shared/desktop-types.ts
  + export * from './channel-types';

desktop/shared/types.ts
  + import type { ChannelAPI } from './desktop-types';           // 独立一行，既有 import 未动
  +   /** Feishu/WeChat channels, the Town catalogue and composer drafts (channel-types.ts). */
  +   channel: ChannelAPI;                                       // DesktopAPI，townDesktop 之后

desktop/renderer/app/slots.tsx
  + import { channelAction, channelPanel } from '../channel/slot';
  +   channelPanel,                                             // PANEL_SLOTS
  +   channelAction,                                            // TOPBAR_SLOTS

desktop/renderer/app/models/registry.ts
  + import { channelModelFactory } from '../../channel/models/channel';
  +   channelModelFactory,                                      // FEATURE_MODELS

MIGRATION.md
  + 「集成阶段」表格末尾一行
```

**超出 append 的改动（合回时需人工过目）**：

| 文件 | 改动 | 依据 |
| --- | --- | --- |
| `desktop/renderer/app/hooks/use-conversation-bridge.ts` | `beings:scene-draft` 分支多读一个可选的 `ack` 回调，回执时额外调用它（`placed` / `occupied` / `unavailable`）。`workspace.compose()` 不传 `ack`，那条路径一字未变 | 任务书明文列出的本单元例外 |
| `desktop/main/town/channel/town-catalog.ts` | 删 `prepareLoomDraft` / `requireCurrentContext` / `requireCurrentFrame` / `DOCUMENT_ID_PATTERN` 与 Loom 类型 import；三个 `prepare*` 改成三个纯函数；新增 `FIRESIDE_EPOCH_CHANGED` | 方案 §1.1 与 §3.7：这是本单元要取代的死路径 |
| `tests/town-channel-town-catalog.test.ts` | 按新表面重写（18 → 14 条，见「测试账目」） | 同上 |
| `tests/town-fixture.ts` | 新增 `FOREIGN_TOWN_CHANNELS`（本单元的三条 `beings:town-*`） | fixture 装的是真实 `INSTALLERS`，本单元的通道会落进 I1 的断言里；用具名排除而不是放宽断言 |
| `tests/town-integration-ipc.test.ts` | 通道集合断言加一个 `!FOREIGN_TOWN_CHANNELS.has(channel)` 过滤 | 同上；既不在 `TOWN_CHANNELS` 也不在排除表里的 `beings:town*` 依然会红 |
| `tests/portal-runtime-e2e.mjs` | 对话部分改到原生页；跳过理由改写 | 方案 §6.1 归本单元 |
| `desktop/renderer/app/hooks/use-conversation-bridge.ts`（第二轮再动一次） | 那条 `ack` 的三态判定改成调用 `placeChannelDraft(conversation, text)`；`ok` 由它的返回值推出。**净减一行逻辑**，判定本体搬进本单元的 `renderer/channel/draft-target.ts` | 复审发现 1、5：判定留在这个文件里既盖掉纯空白草稿，又没有任何单测能跑它 |
| `desktop/main/town/channel/types.ts`（第二轮） | 删 `WebContentsLike` / `WebFrameLike` / `LoomDraftContext` 三个无人引用的类型，原处留一段说明 | 复审发现 6：`prepareLoomDraft` 已删，全仓库只剩自身定义。**此目录也是 IM 的副本收敛范围**，删除动作写在这里让合并者知情 |

`main.ts`、`package.json`、`package-lock.json`、`forge.config.ts`、`vite.*.config.ts`、`tsconfig*`、
`vitest.config.ts`、`subsystems/types.ts`、`app/ipc.ts`、`renderer/app/styles.css`、`renderer/app/page.tsx`、
`renderer/app/components/sidebar.tsx`、`scripts/test-all.mjs` **一个字都没改**。
CSS 由 `renderer/channel/slot.tsx` 自己 `import './styles.css'`，没有动 `renderer/main.tsx`。

---

## 测试账目

| 阶段 | 通过 / 跳过 |
| --- | --- |
| 基线 `next @ 7b2cef8` | 1197 / 34 |
| 本单元第一轮结束 | 1234 / 34 |
| 复审修复后（当前） | **1238 / 34** |

差额 +41 ＝ 新增 43（`draft-integration` 8 + `channel-integration-session` 6 + `channel-integration-ipc` 16 +
`channel-integration-renderer` 13 = 43）− `town-channel-town-catalog` 重写净减 4 + 2（第二轮）。
第二轮新增的四条：`channel-integration-ipc` 的「the feature-task ledger's own limit…」与「re-verifying the same binding…」、
`channel-integration-renderer` 的「a bridge that throws is answered at once…」与「the three answers a pushed draft can get…」；
另有两条既有用例就地加断言（`beings:town-draft` 的形状表加 11 个请求、草稿账目表改写）。
**没有重新启用任何 skip**（本单元对应的那条 `it.skip` 随 I1 删除 `town-controller` 一起没了，见 D1）。
**没有删除或弱化任何其它测试。**

`tests/town-channel-town-catalog.test.ts` 18 → 14 的逐条去向：

| 原用例 | 去向 |
| --- | --- |
| Town catalog exposes nine navigation features… | **原样保留** |
| Town public page whitelist rejects… | **原样保留** |
| draft preparation rejects unknown and non-being IDs… | 保留，改断 `featureDraft` 抛且一条都没推 |
| each Being feature fills a fixed draft… | 保留，改断推送内容与「只推一条」 |
| moved capabilities retain legacy draft IPC… | 保留 |
| Channel and Bonfire cannot fall back… | 保留 |
| each native module assistance operation… | 保留 |
| module assistance preserves existing drafts / requires connected | 保留（`occupied` 回执 + 未连接） |
| module assistance rejects arbitrary prompts, extra keys and accessor objects | **拆开**：提示词部分保留在这里；「多余键 / 访问器对象 / 原型污染」搬到 `channel-integration-ipc.test.ts` 的 `beings:town-draft` 形状检查（BD 在 `{operation}` 那一层做的检查，现在在通道那一层） |
| Fireside handoff treats the exact user draft as data | 保留 |
| Fireside handoff strictly validates its two data fields | 保留 draft 字段；`connectionRevision` 的校验搬到 `channel-integration-ipc.test.ts` |
| Fireside handoff preserves existing Loom drafts and rejects stale revisions | **拆成两条**：已有草稿保留在这里；纪元过期搬到 `channel-integration-ipc.test.ts`（epoch 现在由通道层比） |
| Fireside handoff rejects a connection change during the document handshake | 保留，改成「准备过程中连接变化被拒」 |
| existing text and whitespace drafts are preserved… | **第二轮更正**：原先写「合进…」是错的——那两处都只是让替身回 `occupied`，并不驱动真实的放置判定，而当时的真实判定（`ConversationModel.placeDraft`）会 `trim()`，纯空白草稿会被盖掉。现在这条保护由 `renderer/channel/draft-target.ts` 的 `placeChannelDraft` 承担（`composer.text !== ''`，与 BD `src/town.cjs:134` 同一判据），用例是 `channel-integration-renderer.test.ts`「the three answers a pushed draft can get…」，逐个断言 `" "` / `"\n"` / `" \n\t"` / `"  "` 都保留原文 |
| draft requires an active editable Loom document with the known structure | **删除**：断的是 `#input` 是 TEXTAREA、`#app` 含 `#messages` 等 Loom DOM 结构，该文档已不存在。等价保证是 `channel-integration-renderer.test.ts` 的 `placeChannelDraft`（`disabled` → `unavailable`）与 `draft-integration.test.ts` 的 `unavailable` 分支；`conversation-model.test.ts` **不是**等价保证，它断言的是伴随面板那条会 `trim` 的规则 |
| disconnected, loading, exiting and foreign pages never receive a draft script | 上下文那一半保留在 `draft-integration.test.ts`（五种未连接状态都不推送）；`view` / `webContents` / `mainFrame` 那一半随 Loom 视图删除 |
| an asynchronous result from an old view, generation or document is never accepted | 纪元那一半保留（本文件「准备过程中连接变化被拒」+ `draft-integration.test.ts` 的三种变化）；文档 nonce 那一半 **删除**，随文档一起 |
| page execution errors cannot leak page content or secrets | 保留，改成「拒绝只说自己那一句，不带提示词也不带连接」 |

---

## 冒烟结果（本机实测，2026-09-16）

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿 |
| `npx vitest run`（含 `tests/architecture.test.ts`） | **1238 通过 / 34 跳过**（第一轮 1234 / 34，连跑三次稳定） |
| `npx electron-forge package`（绕代理，`PORTAL_DESKTOP_MAC_LOCAL_TEST=1`，`resources/heart-portal` 用 i2 记录里的 clang stub） | 绿；`codesign --force --deep --sign -` 重签后可启动 |
| 打包产物真机冒烟（Playwright 驱动，假 Being HTTP 夹具） | **全部通过**，逐条见下 |
| `npm run start` | 未单独跑：打包产物冒烟是更强的同一件事（`npm start` 跑的是 Vite dev 产物，打包产物额外覆盖 asar / external / prune） |
| `npm run test:all` | **未跑，做不了**：`scripts/test-all.mjs` 第 7 行 `requirePortalSource()` 要求本机能构建 `heart-portal`（Rust 工具链），本机没有 `cargo`；它的 summary 里 `skipped` 名单因此无法产生，方案 §6.3 第 4 条（skip 名单只减不增）在本机无法验证。可验证的替代：`npx vitest run` 的 skip 数与基线同为 34，且 `git diff 7b2cef8..HEAD -- tests/ | grep -E '\.skip'` 没有任何增删行，即本单元既没有新增 skip 也没有重新启用 skip |

**冒烟对应的提交**：打包产物由 `ed919f0`（第二轮最后一个改动可执行代码的提交）构建并重签。其后到 `HEAD` 之间，
`desktop/` 下只有注释行变动——`git diff ed919f0..HEAD -- desktop/` 的加减行全部以 `//` 开头（`use-conversation-bridge.ts`
里一段四行注释），其余改动在本记录与 `tests/town-channel-town-catalog.test.ts` 的文件头。冒烟断言一条都没受影响。

打包产物上逐条实测到的：

1. `window.beings.channel` 暴露 11 个成员（`state/begin/check/inspect/feishu/catalog/openPage/draft/draftResult/onState/onDraft`）。
2. 未绑定时 `channel.state()` → `{channel:'',status:'unknown',detail:'',connectionRevision:0,connected:false}`。
3. `channel.catalog()` → 9 个功能、`checkedAt: '2026-09-06'`，**不需要连接**。
4. 未绑定时 `channel.inspect(...)` → `{__townError:true, code:'NOT_CONNECTED', message:'请先连接 Being 并等待会话加载完成。'}`
   —— **`code` 到达了渲染层**（D3 的修法生效）。同一次运行里 `townDesktop.bonfire({})` 与 `chat.view(...)`
   的 `code` 仍然是 `undefined`，`Object.getOwnPropertyNames(error)` 是 `['stack','message']`。
5. 绑定夹具 Being 后 `connectionRevision` 从 0 变 1、`connected: true`。
6. 顶栏「消息渠道」按钮存在，点开后 `.channel-panel` 出现，三张卡片文案是
   `飞书查看绑定状态` / `微信查看绑定状态` / `企业微信暂不支持`。
7. 切到「Town 功能」标签页，`.channel-feature` 9 行。
8. `channel.draft({kind:'pairing'})` → `{prepared:true}`，`.chat-input` 里出现 124 字的配对码提示词。
9. 紧接着 `channel.draft({kind:'feature',id:'scroll'})` → 拒绝「已有草稿，已保留原文；请先发送或清空后再选择此功能。」，
   且 `.chat-input` 内容**一字未变**。
10. 全程 `POST /api/chat/stream` 调用数 **0** —— 草稿只填不发。

复审修复后补跑的三条（同一脚本，同一产物）：

11. 把 `.chat-input` 填成 `" \n"`（纯空白）后 `channel.draft({kind:'pairing'})` → 拒绝
    「已有草稿，已保留原文；请先发送或清空后再选择此功能。」，且 `.chat-input` 仍是 `" \n"`（复审发现 1）。
12. `channel.draft({kind:'fireside', draft:'晚上好'})`（缺 `connectionRevision`）→「请填写有效的围炉协助草稿。」；
    带上过期的 `connectionRevision` 才是「连接身份已变化，草稿未转交，请在当前身份下重新确认。」（复审发现 4）。
13. 补跑后 `POST /api/chat/stream` 调用数仍是 **0**。

`TASK_LIMIT_REACHED`（复审发现 2）**没有**在真机上验证：要把功能任务账本真正填满才会触发，
夹具 Being 不会自己开出那么多等待任务。它由 `channel-integration-ipc.test.ts`
「the feature-task ledger's own limit keeps the sentence that says what to do」逐字断言信封。

冒烟脚本在 `<scratchpad>/i7-smoke.mjs`（一次性，不入库）。

---

## 复审处理（第二轮，2026-09-16）

七条发现，逐条。代码改动都在本单元的独占目录里，唯一的例外是那一个任务书点名的例外文件。

| # | 严重度 | 结论 | 做了什么 |
| --- | --- | --- | --- |
| 1 | medium | **属实，已修** | 见下 R1 |
| 2 | low | **属实，已修** | 见下 R2 |
| 3 | low | **判断不适用于本外壳，未改，已钉住** | 见下 R3 |
| 4 | low | **属实，已修** | 见下 R4 |
| 5 | low | **属实，已修** | 见下 R5 |
| 6 | low | **属实，已删** | 见下 R6 |
| 7 | low | **属实，已补** | 见下 R7 |

### R1 · 纯空白草稿不再被盖掉（`renderer/channel/draft-target.ts`，新文件）

BD `src/town.cjs:134` 的判据是 `field.value !== ''`——**任何**非空字符串都算已有草稿，换行和空格也算。
`ConversationModel.placeDraft`（I5 的目录，本单元不碰）是 `this.composer.text.trim()`，对伴随面板的引用按钮是对的，
对主进程推来的草稿是错的。判定因此搬到推草稿这一侧：

```ts
export function placeChannelDraft(target: DraftTarget, text: string): ChannelDraftAck {
  if (target.disabled) return 'unavailable';
  if (target.composer.text !== '') return 'occupied';   // BD src/town.cjs:134
  return target.placeDraft(text) ? 'placed' : 'occupied';
}
```

`use-conversation-bridge.ts` 只是改成调用它。`conversation.ts:457` 一个字都没动——I5 的目录，
而且伴随面板的 `trim` 规则本身没有错，错的是让它替主进程的草稿做决定。

**一处顺带的行为变化**：`app.post` 的这条分支同时服务伴随面板的引用（`WorkspaceModel.compose()`），
所以引用现在也不会盖掉纯空白的输入框，而是走它自己那句「对话输入框已有草稿，请先处理原草稿，再放入引用。」。
0.8.26 里这条路由 Loom 页面自己判定（页面不在本仓库，判据无法核实），
两种规则都说得通；选更严的那种：用户打进输入框的任何字符都不被覆盖，且两个草稿来源规则一致。
用例：`channel-integration-renderer.test.ts`「the three answers a pushed draft can get, decided as the Loom page decided them」，
`placeDraft` 替身逐字抄了真实模型（含 `trim`），所以钉住的是前面那道栅栏而不是替身。真机冒烟第 11 条。

### R2 ·「功能任务记录已满」保住 BD 原话（`main/town/channel/ipc.ts`）

`accounted` 里抛出的 `TASK_LIMIT_REACHED` 原先落进 `townErrorEnvelope`，而 I1 的 `TOWN_ERROR_CODES` 没有这个码
（BD `src/main.cjs:127` 有），整条被降级成「Town 操作未完成，请稍后重试。」——而重试永远不会成功。
现在 `envelope` 在降级前单独认这个码，直接出 BD `src/main.cjs:740` 的原话：

```
{__townError:true, code:'TASK_LIMIT_REACHED', message:'功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。'}
```

**没有动 `desktop/shared/town-desktop-errors.ts`**（I1 的文件，且 I6b 很可能要往同一张表里加 SBS 的码）。
能这么做是因为这四条通道按 D3 是「信封当数据过桥、渲染层自己重建」，而渲染层的 `unwrap`
（`renderer/channel/models/channel.ts`）原样取 `code` 与 `message`，不再过一次白名单。
用例：`channel-integration-ipc.test.ts`「the feature-task ledger's own limit keeps the sentence that says what to do」。

### R3 · 同地址重新验证**不**推进纪元：不是遗漏，是本外壳的必需（未改）

复审要求把 `channel.reset()` 与 `generation++` 提到 `if (next !== address)` 之外，理由是 BD `src/main.cjs:710-713`
无条件重置。证据方向相反：

- BD 的 `storeConnection` **只**被 `handle('connect')` 调用（`src/main.cjs:1475`）——存一次凭据就是一个新纪元。
- 本外壳的 `connectionVerified` 不是「存凭据」，是「验证连接」，由三个地方触发：`beings:save`（`main.ts:430`）、
  **`beings:portal-start`（`main.ts:469`）** 与 takeover preflight（`main.ts:351`）。无条件推进纪元，
  等于用户每点一次「启动 Portal」就作废一条在途的渠道请求，BD 从来不会这样。
- 这正是 I2/IM 在 `subsystems/tools.ts:281-292` 为 `disconnectLink` 写下的同一段理由，逐字对得上：
  「this shell re-verifies on `beings:portal-start`, on `beings:save` and on a takeover preflight, so an unguarded
  disconnect would cut a live tool bridge every time someone started their Portal」。本单元跟随这个先例。

守卫用的是**完整地址**（不是身份分区），比 `tools.ts` 更紧：凭据文本只要变了就是新纪元，
所以「换 Being」「改 relay secret」「改 token」都会 reset。唯一与 BD 有别的情形是「原样再存一次同一条地址」，
而在本外壳里这只发生在 `beings:save` 只改了别的开关（`allowExec` / `kitsEnabled`）时——BD 那边这类改动根本不走 `storeConnection`。
新增用例把这个选择钉死：`channel-integration-ipc.test.ts`「re-verifying the same binding leaves the epoch alone; a different one moves it」。

### R4 · 每个 kind 有自己的字段表（`main/town/channel/ipc.ts`）

`draftRequest` 原先只有一张公共白名单，于是 `{kind:'fireside', draft:'晚上好'}`（缺 `connectionRevision`）
一路走到纪元比较，`undefined !== 1` 变成「连接身份已变化，草稿未转交…」——让用户去确认一个根本没变的身份。
现在按 kind 收紧：`fireside` 必须同时有 `draft` 与 `connectionRevision`（BD `src/town.cjs:158` 要求恰好两个数据属性），
缺任一或多出别的键 →「请填写有效的围炉协助草稿。」；`pairing` 不接受任何其它键；
`feature` / `assistance` 只允许 `id`，且**故意不在通道层强制它存在**——少了 `id` 时目录层会给出 BD 自己的
「无效的 Town 功能。」/「请选择有效的 Being 协助操作。」，比一句笼统的拒绝更有用。
用例：`channel-integration-ipc.test.ts` 的形状表加了 11 个请求；真机冒烟第 12 条。

### R5 · 桥的判定可单测了，`receiveDraft` 不再让异常逃逸

判定提成 R1 的纯函数，四条分支（`placed` / `occupied` / 纯空白 `occupied` / `disabled` → `unavailable`）都有断言，
其中 `unavailable` 这条此前零覆盖。另外 `ChannelModel.receiveDraft` 给 `this.host.post(...)` 加了 `try/catch`：
异常原先会从 IPC 监听回调里逃逸，主进程只能干等满 3 秒；现在立刻回 `unavailable`。
用例：`channel-integration-renderer.test.ts`「a bridge that throws is answered at once rather than waited out」
（`expect(...).not.toThrow()` 同时钉住「不逃逸」）。

### R6 · 三个死类型已删（`main/town/channel/types.ts`）

`WebContentsLike` / `WebFrameLike` / `LoomDraftContext` 随 `prepareLoomDraft` 一起失去了唯一的消费者，
全仓库只剩自身定义。原处留了一段说明，指向取代它们的 `NativeDraftContext`。
**这个目录也是 IM 的副本收敛范围**，所以删除动作同时写进了上面的「超出 append 的改动」表。

### R7 · `test:all` 与打包产物的时间差

`npm run test:all` 这一行补进了冒烟表：做不了，理由是 `scripts/test-all.mjs:7` 的 `requirePortalSource()` 需要
Rust 工具链，本机没有 `cargo`；同时给出可验证的替代（skip 数与基线一致，且 `tests/` 的 diff 里没有任何 `.skip` 增删）。
产物已按 `ed919f0` 重新打包重签、冒烟重跑（13 条全过），对应提交写在冒烟表下面。

---

## 未做事项 / 存疑

1. **`contextBridge` 吃掉 `error.code` 是外壳级缺陷，本单元只修了自己的四条通道。**
   I1 的 24 条 `beings:town-*` 与 P1 的 5 条 `beings:chat-*` 包络通道在打包客户端里 `code` 一律 `undefined`，
   渲染层里所有 `error.code === 'AUTH_REQUIRED'` / `'NOT_SENT'` / `'SESSION_CHANGED'` 分支目前都走不到
   （`NOT_SENT` 的 `candidates` 同理丢失）。修法有两种：把 `preload/channels/bridge.ts` 的 `enveloped` 与
   `channels/town.ts` 的 `townEnveloped` 改成 resolve 信封、由渲染层重建（本单元的做法），
   或者改成 reject 一个普通对象（未实测能否过桥）。**需要合并者统一拍板**，不适合由一个并行单元单方面改别人的通道文件。
2. `tests/portal-runtime-e2e.mjs` 仍然 SKIPPED。对话部分已改到原生页（`.chat-input` / `.chat-send` /
   `.chat-tray-item` / `input[aria-label="选择图片"]`，附件从 `draft.txt` 改成 PNG——原生 composer 只收图片），
   但它要起真 Portal、等 `phase==='connected'` 拿到真 PID、再经中继调 `portal_file_write` / `portal_exec` /
   `portal_status` / `tools/list`。这些只有真 `heart-portal` 会答，本机没有 `cargo`。跳过理由已改成这一句。
   装好 Rust 工具链后：`npm run build:portal && npm run package && npm run test:portal-e2e`，并删掉脚本顶部的跳过块。
3. `renderer/town-app.js` 的三条规则**没有**覆盖，因为它们要真窗口：卡片焦点环、二维码图片实际渲染、向导滚动位置。
   `tests/channel-integration-renderer.test.ts` 的文件头列了这三条。
4. BD `test/town-conversation-ui.cjs` 里与渠道无关的部分（围炉竞态族、草稿焦点/滚动保持、SBS 状态条）
   仍未搬运，见 `i1-town.md` 遗留 3。
5. 「Town 功能」标签页里 `mode: 'app'` 的功能（篝火/围炉/卷轴/工具市场/电脑连接/居民名录）导航到 I1 的 Town 页面
   与外壳的 Portal 页；`model` 与 `workspace` 这两个 `FEATURE_NAMES` 键在本外壳没有页面，
   功能任务页点「打开功能页」会 toast「该功能暂时没有可打开的页面。」。`model` 的页面是 I6b 的，
   合回后可以把 `TASK_VIEWS` 加一行指过去。
6. `beings:channel-feishu` 只做「恒拒」这一件事，与 BD 一致；如果服务端将来提供了专用配置入口，
   拒绝文案里指的就是那个入口，本单元没有为它预留任何通道。
7. 没有为「企业微信」做任何服务端探测——BD 也是写死的「暂不支持」。
8. **功能任务账本写满这句话，本单元只修了自己的两条通道。** BD 在 `handle` 的 catch 里统一把
   `TASK_LIMIT_REACHED` 换成「功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。」（`src/main.cjs:740`），
   本外壳没有这一层。现状实测（读代码，未真机复现）：
   - `desktop/main/features/ipc.ts` 的四条（`getFeatureTasks` / `getFeatureTask` / `endFeatureTaskTracking` /
     `discussFeatureTask`，I4）不包络，`feature-tasks.ts:121` 抛的是英文 `Too many active feature tasks`，
     33 字、无换行，`publicErrorMessage`（`shared/errors.ts:12` 的长度与字符过滤）会原样放行 —— 用户会看到英文。
   - 包络类通道若将来也进账本，会被 `townErrorEnvelope` 降级成「Town 操作未完成，请稍后重试。」，
     因为 `desktop/shared/town-desktop-errors.ts` 的 `TOWN_ERROR_CODES` 没有这个码（BD `src/main.cjs:127` 有）。
   本单元的两条通道已在 `ipc.ts` 里自己出 BD 原话（R2），没有替别人改共享表。合并者若要统一：
   往 `TOWN_ERROR_CODES` 末尾加一行 `'TASK_LIMIT_REACHED',`，并把中文文案放进 `feature-tasks.ts` 的抛出点，
   届时 `ipc.ts` 里的 `TASK_LIMIT` 常量可以删掉。
9. `desktop/renderer/app/hooks/use-conversation-bridge.ts` 仍然没有 React 层的测试（整个文件没有任何用例渲染它）。
   本单元把它里面唯一一处判定搬进了可单测的 `placeChannelDraft`，但「hook 挂上去之后 `app.post` 真的被装上」
   这一步仍只有打包产物冒烟覆盖（冒烟第 8/9/11 条走的正是这条路）。
