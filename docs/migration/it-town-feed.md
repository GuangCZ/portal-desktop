# IT · Town 读取行为（集成单元，并行组 C）

工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/it-town-feed`，分支 `it-town-feed`，基线 `next @ 5be8565`。
日期：2026-09-17。

本文件是断点续传记录：阅读摘要 / 进度 / 决定与偏差 / 冒烟结果 / 未做事项。

---

## 1. 阅读摘要

### 1.1 `docs/migration/i1-town.md`（I1 的完整记录）

- D3：渲染层**原地重写** `desktop/renderer/town/`，`TownModel` 类名与构造签名不变；不新建 `town-desktop/`。
- D7：`openFeed` 的「读共享、结果不共享」——每个调用者各自 fence 后应用同一份结果（**已经有一半 in-flight 合并的雏形**）。
- §4：24 条 `beings:town-*` 通道 + 3 条推送（`town-state` / `town-messages` / `town-members-invalidated`）。
- 遗留 3（本单元第 3 条任务的出处）：BD `test/town-conversation-ui.cjs` 的 60+ 条断言只搬了 8 条，
  **围炉切换竞态族、草稿焦点/滚动保持、SBS 状态条文案族尚未搬运**。
- 遗留 7 在 I1 记录里没有独立编号；任务书说的「GET /api/messages 是否返回已发送的私信」对应 R4 那一节：
  I1 已经**给 `TownDirectMessage` 增了 `recipientId?` / `recipientName?`**，并在 `session.ts` 增 `recipientField()`。
  本单元要核的是**请求路由本身**（`?with=received` / `?with=sent` 还是普通路由）与 BD 0.8.26 是否一致。
- R1：`invalidateMembers()` 里不得 `identityRevision++`（会清空时间线）。
- 遗留 1：两个 E2E 脚本 I1 从未真跑，IM 在打包产物上第一次跑。

### 1.2 `docs/migration/im-integration.md`（IM 的整合修复与真机冒烟）

- §4.5 / §9.2：`tests/town-ui.mjs` 的夹具**已改回真挂起**（共享 deferred `globalThis.town.membersHeld`，
  一次 `releaseMembers()` 全部兑现），并引入 `pending(name, condition, why)`：红的规则照红但不中断后面的 check。
  **本单元必须核对并保留这个挂起版夹具**（IM 第一轮改成 503 快速失败被复审打回）。
- 打包产物结果：`town-ui` 13 过 2 红、`town-sdk` 13 过 4 红。
  - `town-ui` 红 1：`messages render while the member directory is still pending` → openIssue 10（**本单元第 1 条任务**）。
  - `town-ui` 红 2：`an ambiguous recipient offers the choices Town returned` → openIssue 1（contextBridge 剥 `error.code`，**归 IN**）。
  - `town-sdk` 红 4 条：同 openIssue 1（**归 IN**）。
- openIssue 10（复审 finding 2，high）：`main/town/session/session.ts:408` 的
  `Promise.all([request2('/api/bonfire/hear',…), this.getMembers({signal})…])`——`.catch` 接得住拒绝接不住慢；
  `getMembers`（同文件 348-358）只有成功后的 TTL 缓存，**没有 in-flight 去重**。
  修法：把 `getMembers` 从 `Promise.all` 里摘出来，先用缓存/空目录渲染，目录到了再补 mention 标签。
- openIssue 2（**重要，与任务书的说法不同**）：「打开一次篝火发两次 feed 读」被 **IM 第二轮复测推翻**——
  用「目录真的挂起、随后释放」的夹具重跑，三条 read 计数 check 全过（一次打开 = 1 条读）。
  第一轮量到的「250 ms 后第 2 条」是在 `/api` 回 503 的夹具下量的，属**目录失败路径**。
  **仍然成立的一半：公共目录 `/api` 没有 in-flight 去重**（一次打开有多个并发 `getMembers`，干净打开 4 次、失败 9–12 次）。
  → 本单元第 2 条任务按 MEMORY「协议行为必须实测」先复测，再按实测结果决定修哪一半。
- 已拍板：`beings:town-open` 走工具浏览器（IM §2.12）；`connectionCleared()` 没有解绑路径，不再追。

### 1.3 `docs/migration/i6b-model-settings.md`

- §3 IPC：`beings:model-settings-state` 是**推送**，载荷 `ModelSettingsState = {connected, connectionId, runtime}`；
  `beings:model-settings` 是一条 invoke，渲染端加载时自己读一次（复审 9.1 之后新增，冷启动必需）。
- openIssue 2 明文：**Town 页的 SBS 状态行应读 `beings:model-settings-state`，不要自己再开 `/api/llm/config` 读**
  （本仓库只允许有一个该路由的读者）。← 本单元第 3 条任务的 SBS 那一族按这条做。
- openIssue 3：`sideBySide.active` 恒为 `null`（本壳层没有来源），页面照实显示「未知」。

### 1.4 `docs/migration/i5-conversation.md` / `i7-channel-drafts.md`

- I5 §7.4：两个 Town E2E 脚本归 IM 跑（已跑）。
- I7 未做 1：`contextBridge` 吃掉 `error.code` 是外壳级缺陷，**需合并者统一拍板**，I7 只修了自己四条通道
  （做法：resolve 信封、由渲染层重建）。→ 本单元不碰，归 IN。
- I7 未做 4：BD `test/town-conversation-ui.cjs` 里围炉竞态族 / 草稿焦点滚动 / SBS 状态条仍未搬运（与 I1 遗留 3 同一件事）。

---

## 2. 进度

- [x] 读 i1 / im / i6b / i5 / i7 的 openIssues 与决定

### 1.5 真实代码与 BD 对照物（逐条实读）

**`desktop/main/town/session/session.ts`（600 行，u1 逐行移植自 BD `src/town-session.cjs`）**

- `:348-358` `getMembers`：TTL 60s，只在**成功之后**写缓存；并发调用各开各的请求（无 in-flight 去重）。
  BD `src/town-session.cjs:273-283` 一模一样 —— 缺陷是继承的，不是移植引入的。
- `:406-417` `getBonfireMessages`：`Promise.all([request2('/api/bonfire/hear',…), this.getMembers({signal})…])`。
  BD `src/town-session.cjs:335-336` 同两行。
- `messagesDto(value, members)`（`:87-105`）里 `members` 的**唯一**用途是
  `byId = members.find(m => m.id === item.being)`，作为 `beingId` 的**第三顺位兜底**
  （`town_id` → `being_id` → 目录里按显示名找 → `t_` 前缀自身）。也就是说目录只影响**老载荷**的作者归属，
  不影响消息本体、不影响 @提及标签（后者在渲染层用 `mentionNames`）。
- `_request`（`:257-310`）把自己的 `AbortController` 注册进 `this._requests`，所以 `reset()` 能取消一条**不带调用方 signal** 的请求。

**BD `renderer/town-app.js` 的两条规则（本单元第 1、2 条任务的原始出处）**

- `:1607-1610` `loadBonfire`：`Promise.all([readTownMessages('bonfire', '', manual), loadBonfireMembers(manual)])`
  —— **feed 与目录是两条独立的加载**，`readTownMessages(manual=false)` 走的是 `getTownMessageSnapshot`（纯缓存）。
- `:1581-1605` `loadBonfireMembers`：**先 `cachedData('getBeingMembers')` 画一次**，再 `call('getBeingMembers')` 覆盖，
  失败只写 `memberError`，两次都各自 `renderBonfire()`。对应 `test/town-conversation-ui.cjs:98`
  「cached directory resolves mentions while the fresh directory is pending」与 `:103`
  「late directory arrival rerenders mention labels without mutating messages」。
- `:1955-1974` `open()`：**同一次打开里读只发一次** ——
  `const cachedMessages = … ? readTownMessages('bonfire') : null` 在函数开头起飞，
  后面是 `await (cachedMessages || readTownMessages('bonfire'))`、`const members = cachedMembers || loadBonfireMembers()`。
  这就是「同一 in-flight 读合并」在 BD 里的原样：**已经起飞的那一个被复用，而不是再起一个**。

**`/api/messages` 路由（本单元第 4 条任务）：本壳层与 BD 0.8.26 逐字一致，不需要改**

| | BD 0.8.26 | 本壳层 |
| --- | --- | --- |
| 客户端路由表 | `src/town-client.cjs:14` `['/api/messages', []]`（**允许的 query 参数为空数组**） | `desktop/main/town/session/client.ts:69` 同一行 |
| 读法 | `src/town-session.cjs:344-348` `directMessagesDto(await request('/api/messages'))`，**不带任何 query** | `session.ts:419-423` 同 |

没有 `?with=received` / `?with=sent`，两边都没有。`docs/town-sdk-integration.md:40` 的实测记录也是
「私信：`GET /api/messages` 读收件箱，`POST /api/messages` 发送，均走 client token」。
**「GET 是否返回已发送的私信」仍然未实测**：同文件 `:93` 明说「Being 提醒公开帮助未明确 GET 私信是否改变已读/投递状态」，
本机没有真 Town 可连。按任务书「无法实测就以 BD 源码为准并标注未实测」处理 —— 路由不动。
（I1 的 R4 已经把 `recipient` / `recipient_town_id` 落进 DTO，所以真要是返回了已发送的私信，收件人地址是有的。）
- [x] 读 session.ts / renderer town 模型 / BD 对照原件 / tests/town-ui.mjs 与 town-sdk.mjs
- [x] 第 1 条：成员目录不再拖住篝火读
- [x] 第 2 条：`/api` 同一 in-flight 读合并；找到并消掉渲染层「身份到达就重读」那一次
- [x] 第 4 条：`/api/messages` 路由核对（结论：与 BD 0.8.26 逐字一致，不改）
- [x] 第 3 条：围炉竞态族 / 草稿族 / SBS 状态行族搬运
- [ ] 打包冒烟逐条

---

## 3. 改动点

### 3.1 `desktop/main/town/session/session.ts`（第 1、2 条）

| 改动 | 说明 |
| --- | --- |
| `getBonfireMessages` 不再把 `getMembers()` 放进 `Promise.all` | 改成：用**已经在手**的目录（`cachedMembers()`，纯内存、无请求），把新的目录读**起飞但不等**，只 await `/api/bonfire/hear`；返回时再取一次 `cachedMembers()`，所以目录若赶在消息之前回来，老载荷的作者兜底与改动前一模一样，赶不上就不拖任何人。 |
| 新增 `cachedMembers()` | 未过期就返回现有目录，否则空数组。没有任何请求。 |
| `getMembers` 同一 in-flight 读合并 | 新增 `_membersRead`：并发调用者 join 同一条 `/api`；共享请求**不带任何调用方的 AbortSignal**（一个调用方放弃不能取消别人的目录），但仍由 `reset()` 取消，因为 `_request` 把 controller 注册进 `_requests`。新增 `_join(shared, signal)` 让放弃的调用方自己拿到 `ABORTED`。 |
| `reset()` / `invalidateMembers()` 清 `_membersRead` | 失效之后到达的调用方必须重开一条，而不是 join 一条注定 `SESSION_CHANGED` 的读。 |

### 3.2 `desktop/renderer/town/models/town.ts`

| 改动 | 出处 |
| --- | --- |
| `receiveState`：身份**到达**（`this.me` 原本为空）不再触发 `load()`，改为就地 `applyMembers(this.members)` 重投影 | BD `acceptTownState`（`renderer/town-app.js:1701`）的 `Boolean(previousId && nextId && nextId !== previousId)`——空的旧身份不算变化；而且 BD 从不因为状态更新去读 feed，只有 `open()` 读。身份**真的变了**仍然重读（本外壳与 BD 的有意差异，见 §4.2）。 |
| `applyTimeline`：新增 feed key 围栏 | BD「late previous-room events and read completion cannot overwrite the selected room」。换围炉不换 `request` 代（不是新页面），所以代号分不出两个围炉的答复。`receivePush` 一直有这条，读路径缺。 |
| `openFeed`：结果与 `reading` 都改用 `onFeed(key, generation)` | 同上，外加「the selected room completion updates its content and unlocks read controls」——被离开的那个围炉的迟到答复不得解锁读控件。 |
| `send()`：回执先删自己 target 的草稿，再判断 target 是否还在屏幕上 | BD「late successful receipt clears only its original room draft」/「returning to confirmed room shows a cleared draft without resending」。 |
| 新增 `sideBySide` 与 `receiveModelSettings()`，`start()` 订阅 `beings:model-settings-state` 并读一次 | I6b openIssue 2：Town 页要显示 SBS 就订阅这条，**不得自己再开 `/api/llm/config` 读**。 |

### 3.3 `desktop/renderer/town/page.tsx`

新增 `refreshLabel(town)` 与 `#town-refresh-status` 一行。逐句移植 BD `renderer/town-app.js` 的
`refreshLabel`（:163-175）与 `backgroundNotConfigured`（:161），顺序与文案照抄：
`prefix · 最近检查 · 最近采集 · 显示上次同步内容`。**唯一一处增量**：0.8.26 只能从一次已经失败的
`SBS_NOT_CONFIGURED` 读里知道后台采集没设置，本外壳被直接告知（`beings:model-settings-state`），
所以同一句话在事实已知时就说；`configured: true` **不会**用来反驳「读不到」。

### 3.4 测试

| 文件 | 改动 |
| --- | --- |
| `tests/town-conversation-rules.test.ts`（**新建**，17 条） | I1 遗留 3 的三族：围炉切换竞态 6 条、草稿 3 条、SBS 状态行 6 条、「一次打开一次读」2 条。每条都带它来自 BD `test/town-conversation-ui.cjs` 的原名。 |
| `tests/town-session-session.test.ts` | 新增 5 条（目录挂起不拖住篝火、暖目录仍解析作者、并发合并且失败不粘、放弃的调用方不取消别人的读、失效后另起一条）。既有「Bonfire reads use documented since and limit」那条把 `calls[1]` 改成按路由找 `/api/bonfire/hear`——原来断言的 `since=3`/`limit=20` 一个没少，只是目录读现在可能落在它前面。 |
| `tests/town-ui.mjs` | 新增 4 条真窗口 check（草稿光标与焦点、列表滚动位置、状态行到达页面、五个并发目录读只有一条上线）。两条原 `pending` 转绿改为硬 `check`，并把三条读计数断言改成**对各自基线**计数（理由与实测见脚本内注释与本文件 §4.1）。夹具只增加了一个 `bulk` 开关与一个并发计数，既有场景一个字没改。 |

**反向证据（去掉修复会重新变红）**

| 修复 | 反向证据 |
| --- | --- |
| `getBonfireMessages` 不等目录 | `tests/town-ui.mjs`「messages render while the member directory is still pending」——IM 在同一夹具、同一打包流程下实测为红（记录 §9.2），本单元实测为绿；`tests/town-session-session.test.ts`「a pending member directory does not hold up the bonfire messages」同一条规则的单元级复现。 |
| `getMembers` in-flight 合并 | `tests/town-ui.mjs`「five directory reads at once are one request on the wire」；单元级 `concurrent directory reads share one request`。 |
| 渲染层四条 | 把 `applyTimeline` 的 feed 围栏、`openFeed` 的 `onFeed`、`receiveState` 的 `arrived`、`send()` 的草稿删除逐条改回原样后重跑 `tests/town-conversation-rules.test.ts`：**17 条里 4 条变红**（围炉迟到答复、围炉往返、回执清草稿、身份到达不重读），改回来后 17 条全绿。 |

---

## 4. 决定与偏差

### 4.1 第 2 条任务的实测结论：250 ms 那一次不是重复读，另有一次才是

任务书按 IM 第一轮的观测写「打开一次篝火发两次 feed 读（首绘 reads=1，250 ms 后变 2）」。
按 MEMORY「协议行为必须实测」在打包产物上逐条量过之后，真实情况是：

| 观测 | 手段 |
| --- | --- |
| 一次打开的 `/api/bonfire/hear` 时间序列是 `dt=0`、`dt=245–251`（有时中间还有一条 `dt=2`） | 夹具记 `Date.now()`，探针脚本打印 |
| SSE `hello` 帧落在 `dt=-2 ~ -7`，**早于**第一次读 | 夹具在 `/api/client/stream` 的 `start(controller)` 里记 `helloAt` |

所以 250 ms 那一条的来源是 `desktop/main/town/channel/town-background.ts` 的 `notifyEvent`：
配对完成就是开 SSE，`hello` 到达 → 把篝火标脏 → **250 ms 合并窗口**之后 `reader.refresh()`。
这段（连同那个 250）是 BD `src/town-background.cjs:60-82` 的逐字节移植，**是 Town 说「有变化」，不是页面问了两次**，
压掉它等于丢掉服务端宣告过的更新。**不改。**

IM 当初量到 1，是因为那时 feed 读卡在成员目录上、flight 一直不落地，
250 ms 的那次 `refresh()` 于是命中 `timeline/refresh.ts:543` 的 `if (this._flight) return this._flight.promise` 直接并进去、根本没上线；
把目录挪开之后它才露出来。也就是说 `=== 1` 量的是它旁边那个缺陷，不是一条规则。

**真正的重复读在渲染层**，而且与 250 ms 无关：`receiveState` 里 `this.me !== identity` 就 `void this.load()`，
而身份是在页面打开之后一次状态推送才到的，`this.me` 从 `''` 变成 `t_Willow` 被当成「换了身份」。
BD `acceptTownState`（`renderer/town-app.js:1701`）明写 `Boolean(previousId && nextId && nextId !== previousId)`
——空的旧身份不算变化——而且 BD **从不因为状态更新去读 feed**。已按 BD 改（§3.2），单元用例
`an identity arriving after the page opened does not start a second read` 钉住，去掉修复即红。

三条读计数断言因此改成**对各自基线**计数而不是对 1 计数，理由与实测逐句写在 `tests/town-ui.mjs` 里。
这不是放宽：原来的 `=== 1` 里混着「一次打开一次读」和「这段时间里不许有别的读」两件事，
现在前者由 `repeated openings never start more than one read per opening`（打开两次 → 至多 +2）单独断言，
后者由 `a directory arrival costs no second message read`（目录到达前后计数不变）单独断言，
而且后者先 `waitForTimeout(800)` 让 250 ms 窗口过去，**量的就只是目录的影响**。

### 4.2 身份**真的**变了仍然重读（保留本外壳既有行为）

BD 的 `acceptTownState` 在身份变化时只 `clearPrivate()`，不重读，等下一次 `open()`。
本外壳的 Town 页可能正开着，清空之后就是一张白页，所以 I1 选择重读。本单元**只**改掉「到达」那一半，
「变化」那一半保持不动，并加了 `an identity that actually changed re-reads the feed on screen` 钉住它。

### 4.3 `getBonfireMessages` 里仍然会起飞一次目录读

只在手上没有未过期目录时起飞，且**不等**。留着它的理由：`messagesDto` 的目录兜底
（`town_id` / `being_id` 都没有的老载荷）在 BD 里是有的，而后台采集在 Town 页没打开时也会走这条路——
真砍掉，关着页面采集到的老载荷会永久带上 `authorUnknown`。起飞之后若赶在消息之前回来，行为与改动前完全一致。

### 4.4 `/api/messages`：不改，并标注「未实测」

见 §1.5 的对照表。路由表、查询参数、读法都与 BD 0.8.26 逐字一致。
「GET 是否返回已发送的私信」本机无真 Town 可连，**未实测**；`docs/town-sdk-integration.md:93` 的原话是
「Being 提醒公开帮助未明确 GET 私信是否改变已读/投递状态」。按任务书以 BD 源码为准。

### 4.5 SBS 状态行只订阅，不自己读

按 I6b openIssue 2：`TownModel.start()` 订阅 `beings:model-settings-state` 并读一次 `beings:model-settings`，
`api.modelSettings?.` 带可选链（夹具可以不装模型设置桥）。**没有**新增任何 `/api/llm/config` 读者。

### 4.6 `tests/town-ui.mjs` 的滚动容器是找出来的，不是写死的

`#town-view` 有 `overflow:auto`，但实测 63 条消息时它的 `scrollHeight === clientHeight`（637/637）——
真正滚动的是别的祖先。所以那条 check 从 `.social-messages` 往上找第一个 `scrollHeight - clientHeight > 40` 的元素；
一次「没有任何东西可滚」的运行会在 `scrolled > 0` 上**响亮地红**，而不是悄悄通过。

---

## 5. 共享文件触碰行

| 文件 | 触碰 | 是否符合「只 append 一行」 |
| --- | --- | --- |
| `MIGRATION.md` | 「集成阶段：各单元记录」表**末尾追加一行**（`IT · Town 读取行为`） | 是 |

**没有**改动 `desktop/main/extensions.ts`、`desktop/preload/channels/index.ts`、`desktop/shared/desktop-types.ts`、
`desktop/shared/types.ts`、`desktop/renderer/app/slots.tsx`、`desktop/renderer/app/models/registry.ts`
——本单元不新增子系统、不新增通道、不新增插槽，全部改动落在自己的独占目录里。
`package.json` / `package-lock.json` / `forge.config.ts` / `vite.*.config.ts` / `tsconfig.json` / `vitest.config.ts` /
`scripts/test-all.mjs` 一个字没动。IN 的独占目录（`desktop/preload/**`、`desktop/main/main.ts`、
`desktop/renderer/app/**`、`tests/support/**` 等）一个文件没碰。

唯一落在独占目录之外的是 `tests/town-session-session.test.ts`，它是 `tests/town-*`，属本单元独占。
