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
- [x] 打包冒烟逐条
- [x] 复审回合（2026-09-17）：medium 两条 + low 三条逐条处理（§4.3 / §4.3.1 / §4.5 / §4.6 / §8）

---

## 3. 改动点

### 3.1 `desktop/main/town/session/session.ts`（第 1、2 条）

| 改动 | 说明 |
| --- | --- |
| `getBonfireMessages` 不再把 `getMembers()` 放进 `Promise.all` | 改成：用**已经在手**的目录（`cachedMembers()`，纯内存、无请求），把新的目录读**起飞但不等**，只 await `/api/bonfire/hear`；返回时再取一次 `cachedMembers()`，所以目录若赶在消息之前回来，老载荷的作者兜底与改动前一模一样，赶不上就不拖任何人。 |
| 新增 `cachedMembers()` | 未过期就返回现有目录，否则空数组。没有任何请求。 |
| `getMembers` 同一 in-flight 读合并 | 新增 `_membersRead`：并发调用者 join 同一条 `/api`；共享请求**不带任何调用方的 AbortSignal**（一个调用方放弃不能取消别人的目录），但仍由 `reset()` 取消，因为 `_request` 把 controller 注册进 `_requests`。新增 `_join(shared, signal)` 让放弃的调用方自己拿到 `ABORTED`。 |
| `reset()` / `invalidateMembers()` 清 `_membersRead` | 失效之后到达的调用方必须重开一条，而不是 join 一条注定 `SESSION_CHANGED` 的读。 |
| **（复审）共享读带 `AbortSignal.timeout(membersReadTimeoutMs)`，默认 20 s** | 合并槽一旦被一条永不落地的请求占住，之后每个 `getMembers()` 都会被一起挂住；`_request` 自己不设超时。见 §4.3.1。 |
| **（复审）`getBonfireMessages` 在「这一页有 `authorUnknown` 且目录还在飞」时等最多 300 ms** | 只为老载荷的作者兜底，首次冷采集会落盘。见 §4.3。 |

### 3.2 `desktop/renderer/town/models/town.ts`

| 改动 | 出处 |
| --- | --- |
| `receiveState`：身份**到达**（`this.me` 原本为空）不再触发 `load()`，改为就地 `applyMembers(this.members)` 重投影 | BD `acceptTownState`（`renderer/town-app.js:1701`）的 `Boolean(previousId && nextId && nextId !== previousId)`——空的旧身份不算变化；而且 BD 从不因为状态更新去读 feed，只有 `open()` 读。身份**真的变了**仍然重读（本外壳与 BD 的有意差异，见 §4.2）。 |
| `applyTimeline`：新增 feed key 围栏 | BD「late previous-room events and read completion cannot overwrite the selected room」。换围炉不换 `request` 代（不是新页面），所以代号分不出两个围炉的答复。`receivePush` 一直有这条，读路径缺。 |
| `openFeed`：结果与 `reading` 都改用 `onFeed(key, generation)` | 同上，外加「the selected room completion updates its content and unlocks read controls」——被离开的那个围炉的迟到答复不得解锁读控件。 |
| `send()`：回执先删自己 target 的草稿，再判断 target 是否还在屏幕上 | BD「late successful receipt clears only its original room draft」/「returning to confirmed room shows a cleared draft without resending」。 |
| **（复审）`inboxRead` + `projectInbox()`：身份到达时就地重投收件箱** | 私信是物化投影，`applyMembers` 补不回来。见 §4.6。 |
| 新增 `sideBySide` 与 `receiveModelSettings()`，`start()` 订阅 `beings:model-settings-state` 并读一次 | I6b openIssue 2：Town 页要显示 SBS 就订阅这条，**不得自己再开 `/api/llm/config` 读**。 |

### 3.3 `desktop/renderer/town/page.tsx`

新增 `refreshLabel(town)` 与 `#town-refresh-status` 一行。逐句移植 BD `renderer/town-app.js` 的
`refreshLabel`（:163-175）与 `backgroundNotConfigured`（:161），顺序与文案照抄：
`prefix · 最近检查 · 最近采集 · 显示上次同步内容`。
**复审后（2026-09-17）：零增量** —— 每一句的触发条件都与 0.8.26 相同，
「后台采集尚未设置」只在读取器自己报 `SBS_NOT_CONFIGURED` / `sbs_not_configured` 时出现。
原先那处「本外壳被直接告知所以提前说」的增量已撤销，理由见 §4.5。

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

### 4.3 `getBonfireMessages` 里仍然会起飞一次目录读，并且在「只有它能补上作者」时短暂等它

只在手上没有未过期目录时起飞。**默认不等**：消息回来时取一次 `cachedMembers()`，赶上了就用，没赶上就算。

**复审第 5 条（2026-09-17）指出的后果，以及现在的做法。**
`messagesDto` 的目录兜底只服务一种载荷：`town_id` 与 `being_id` 都没有、作者名也不是 `t_` 开头的**老载荷**。
这种载荷兜不到就写 `authorUnknown: true`，而这个 DTO 会经 TownRefresh 进累积时间线并由 `bonfireCache.save` 落盘
（`town/channel/town-background.ts` 的 `onSuccess`）。**Town 页关着的时候没有任何渲染层去调 `beings:town-members`**，
冷启动后的第一次后台采集因此很可能拿到空目录；还在读取窗口内的消息会被下一次采集整条替换纠正
（`timeline/refresh.ts:420-421` 同 seq 内容不同整条替换），**滚出窗口的老载荷则会永久带着空作者落盘**。

现在的做法是**只在这一种情况下**短暂等：消息已经回来、目录还在飞、并且**这一页真的有 `authorUnknown`**，
才 `await within(directory, 300)` 然后用到手的目录重投一次。带 `town_id` 的现代载荷一毫秒都不等；
目录永远不回也最多多花 300 ms（`MEMBERS_GRACE_MS`），比改动前的「一直等到 20 s 或永远」小两个数量级，
也比「完全不等」多救回一类会落盘的错误。三条用例钉住这三种情形
（`a directory that lands inside the grace still names an author the payload only spells` /
`a directory that never lands costs the page the grace and no more…` /
`a payload that names its own author waits for no directory even on a cold cache`），
既有的 `a pending member directory does not hold up the bonfire messages` 补了一条「耗时有上界」的断言
（它的夹具正属于老载荷那一类，所以它现在会花掉这 300 ms，名字里的「不拖住」指的是**不无限期拖住**）。

### 4.3.1 共享目录读的 20 秒时限（复审第 4 条）

`_membersRead` 这个合并槽起飞的 `/api` **不带调用方 signal**（一个调用方放弃不能取消别人的目录），
而 `_request` 自己不设超时——它只认调用方传进来的 signal，`session/client.ts:256/308` 的 20 秒属于
TownClient 的带 token 读，公共目录读走不到那条链路。合并之前一条卡死的请求只坑它自己的调用方；
合并之后它会占着槽位，之后每一个 `getMembers()` 都 await 同一条永不落地的 promise，直到 `reset()` / `invalidateMembers()`。
**已给共享读一个自己的时限**：`AbortSignal.timeout(this.membersReadTimeoutMs)`，默认 `MEMBERS_READ_TIMEOUT_MS = 20000`，
与 `session/client.ts` 的那条同值；`reset()` 仍然能提前取消（`_request` 把 controller 注册进 `_requests`）。
`membersReadTimeoutMs` 是构造选项，只为让用例把 20 s 缩成 40 ms
（`a directory read that never lands frees the shared slot instead of stranding every later caller`：
超时后槽位释放、下一个调用者重新起飞）。

### 4.4 `/api/messages`：不改，并标注「未实测」

见 §1.5 的对照表。路由表、查询参数、读法都与 BD 0.8.26 逐字一致。
「GET 是否返回已发送的私信」本机无真 Town 可连，**未实测**；`docs/town-sdk-integration.md:93` 的原话是
「Being 提醒公开帮助未明确 GET 私信是否改变已读/投递状态」。按任务书以 BD 源码为准。

### 4.5 SBS 状态行只订阅，不自己读；而且 SBS 不替读取器说话（复审第 2 条，2026-09-17）

按 I6b openIssue 2：`TownModel.start()` 订阅 `beings:model-settings-state` 并读一次 `beings:model-settings`，
`api.modelSettings?.` 带可选链（夹具可以不装模型设置桥）。**没有**新增任何 `/api/llm/config` 读者。

**但「本外壳被直接告知，所以同一句话提前说」这一处增量是错的，已撤销。**
本外壳的 `TownBackground` 是 `direct: true`（`desktop/main/subsystems/town.ts:166-168`），
全仓没有任何地方接 `readCachedSnapshot`（`grep` 只命中 `town-background.ts` 自己与它的用例），
所以后台采集走的是 direct SDK 路径，**与 Being 的 SBS 环无关**，读取器也不可能报 `SBS_NOT_CONFIGURED`。
而 `(town.sideBySide === false && !collected)` 在 `prefix` 三元链里排在
`REQUEST_ACCEPTED` / `being_busy` / `refreshing` / `error` **之前**，于是「SBS 从没配过（绝大多数默认状态）
且还没成功采集过一次」的用户看到的是「后台采集尚未设置，可立即同步」，而真相是「正在同步 Town 消息」
或「结果检查失败 · 可刷新显示」。**现在这句话只在读取器自己报 `SBS_NOT_CONFIGURED` / `sbs_not_configured` 时出现**，
与 BD 0.8.26 的触发条件逐字一致（在本外壳里那是一条死分支，与同一条链里 `REQUEST_ACCEPTED` / `being_busy`
一样属于「逐行保真地留着」）。

`TownModel.sideBySide` 与那条订阅**保留**（仍然不开第二个 `/api/llm/config` 读者），但它不再参与任何文案；
新用例 `never lets an unconfigured loop talk over a reader that is working or failing` 钉住
`configured:false` + `refreshing` / `error` / `REQUEST_ACCEPTED` 三种组合，以及「读取器自己报时这句话照说」。
副作用见 §7 openIssue 9。

### 4.6 收件箱在身份到达时就地重投（复审第 1 条）

`arrived` 分支原来只做 `applyMembers(this.members)`。篝火/围炉没问题——`messages()` 每次渲染都用当前 `me`
重投影 `feedMessages`；**私信不是**：`inboxMessages`（`models/feed.ts:108`）在 `loadInbox` 时就把身份烤进每一条
（`mine` / `received` / 回信地址 `recipientId`），而 `messages()` 对 mail 视图只是按 `tab` 过滤这份物化结果。
身份是在页面打开、首读完成**之后**才到的（本单元实测），所以只要私信页是被先加载的那一个
（场景恢复、`beings:town-open` 深链、或 `town.inbox()` 比 `town.appState()` 先回），每一条都会 `mine=false`、
收到的信 `recipientId` 落到 `''`、`mailReply` 拒绝回信。

修法**不是**重新读一次，而是把 Town 返回的原始 `TownDesktopDirectMessage[]` 留在模型里（`inboxRead`），
身份到达时 `projectInbox()` 就地重跑 `inboxMessages` —— 与 `applyMembers` 同一性质的「重投影已经在手的东西」，
**零请求**。`resetIdentity()` 一并清空 `inboxRead`。
用例 `an inbox read before the identity arrived is re-projected when it does, without asking Town again`
断言 `inbox()` 调用次数不变、`mine`/`received`/`recipientId` 三项在身份到达后全部正确。
（注：`selectTab` 本来就会重新 `load()`，所以「已发送」标签页并非**永久**为空；但默认的「全部」标签页在身份到达前
把我自己寄出的信也显示成收到的、且没有任何回信地址，这一条与标签页无关。）

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

---

## 6. 门槛与打包冒烟（2026-09-17 实跑）

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿 |
| `npx vitest run` | **128 文件通过 / 8 跳过；1420 通过 / 24 跳过**（基线 127 / 8；1398 / 24 → 新增 22 条：`town-conversation-rules` 17 + `town-session-session` 5；**没有删除或弱化任何一条既有用例**） |
| 打包 | `PORTAL_DESKTOP_MAC_LOCAL_TEST=1 npx electron-forge package` + `codesign --force --deep --sign -`，成功。**本机上它会间歇性地因 GitHub `connect ETIMEDOUT 20.205.243.166:443` 失败**（`@electron/get` 去取校验文件；Electron 的 zip 本身是有缓存的），重试即过——网络抖动，不是构建问题。最后一次冒烟是在**当前 HEAD 重新打包后**跑的 |
| `npm run test:town-ui` | **18 条通过 / 1 条红**。红的那条是 `an ambiguous recipient offers the choices Town returned` —— `contextBridge` 剥掉 `error.candidates`，**待 IN**（IM openIssue 1 的第二个后果）。基线是 13 过 2 红 |
| `npm run test:town-sdk` | **13 条通过 / 4 条红**，四条全是同一个 `contextBridge` 剥 `error.code`，**待 IN**；与基线一模一样，本单元没有让它变好也没有让它变差 |
| `npm run test:town-names` | **PASS** |
| `npm run test:seed-garden` | **PASS** |

### 6.1 本单元修掉的两条红，逐条反向证据

| 红 | 修好之后 | 去掉修复 |
| --- | --- | --- |
| `messages render while the member directory is still pending` | passed（打包产物） | 把 `session.ts` 的两处改回原样、**重新打包**、重跑：`AssertionError: messages render while the member directory is still pending`，脚本当场停在这一条 |
| `the pending directory did not stop the feed read` | passed（打包产物） | 同一次反向打包里它排在上一条之后，因此没有机会执行；它的规则由单元用例 `a pending member directory does not hold up the bonfire messages` 承接，去掉修复后该用例 **5008 ms 超时变红** |
| （新增）`five directory reads at once are one request on the wire` | passed（打包产物） | 单元用例 `concurrent directory reads share one request, and a failure is not sticky` 与 `one caller giving up on the directory leaves the shared read running for the others`，去掉合并后**双双变红** |
| （新增）四条渲染层规则 | passed | 逐条改回原样后 `tests/town-conversation-rules.test.ts` **17 条里 4 条变红**（围炉迟到答复、围炉往返、回执清草稿、身份到达不重读） |

反向打包那一轮的完整日志：`scratchpad/it-reverse.log`；正向四个脚本：`scratchpad/it-final-e2e.log`。

### 6.2 复审回合后重新打包重跑（2026-09-17）

复审的五条修复里有三条会进打包产物（收件箱重投、`refreshLabel`、目录时限与宽限），所以重新打包、重签、重跑：

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿 |
| `npx vitest run` | **128 文件通过 / 8 跳过；1426 通过 / 24 跳过**（上一轮 128 / 1420，本轮 +6：`town-conversation-rules` +2、`town-session-session` +4） |
| 打包 + `codesign --force --deep --sign -` | 成功（第一次仍撞上 `@electron/get` 取校验文件的 `connect ETIMEDOUT`，重试即过，与 §6 记录的间歇故障一致） |
| `npm run test:town-ui` | **18 过 1 红**，与复审前逐条一致；红的仍是 `an ambiguous recipient offers the choices Town returned`（contextBridge，**待 IN**）。`the pending directory did not stop the feed read` 在收紧成 `>= 1 && <= 2` 之后**实测通过**（这一轮量到的就是 1） |
| `npm run test:town-sdk` | **13 过 4 红**，四条全是同一个 contextBridge，**待 IN**；与基线一模一样 |
| `npm run test:town-names` | **PASS**（它正好覆盖「收到/寄出私信的确切回信地址」，也就是 §4.6 那条修复的真窗口一侧） |
| `npm run test:seed-garden` | **PASS** |

日志：`scratchpad/it-town-ui.log`、`it-town-sdk.log`、`it-town-names.log`、`it-seed-garden.log`、`it-package2.log`。

---

## 7. 未做事项 / 存疑（openIssues）

1. **`contextBridge` 剥掉 Error 的自定义属性** —— `tests/town-sdk.mjs` 的 4 条红与 `tests/town-ui.mjs` 的 1 条红全部指向它。
   **归 IN**（另一个 worktree），本单元一个字没碰 `desktop/preload/**`，红的照红。
2. **「GET /api/messages 是否返回已发送的私信」未实测** —— 本机没有真 Town。路由与 BD 0.8.26 逐字一致（§1.5 / §4.4），
   按任务书以 BD 源码为准。真要确认，需要一条真配对与一次真发信。
3. **250 ms 的那次 feed 读保留** —— 实测确认它是 SSE `hello` 触发的后台采集（§4.1），与 BD 逐字节一致。
   如果将来要把「页面打开的那次读」与「live 事件触发的那次」合成一次，正确的做法是让
   `notifyEvent` 知道「这条事件已经被一次在它之后开始并完成的读服务过了」，而不是缩短窗口或去掉事件；
   本单元不改，因为做不对就会丢更新。
4. **`/api` 在一次完整打开里仍然不止一条** —— 实测挂起场景下是 3 条，但它们**不是没合并**：
   配对会 `session.reset()`（纪元 ++、旧请求被 abort）、`invalidateMembers()` 也会清合并槽，
   每一条都属于不同的纪元。合并本身由 `five directory reads at once are one request on the wire`
   与两条单元用例证明。夹具无法区分「被 abort 的旧请求」与「没合并的新请求」（被 abort 的 handler 永远挂着），
   所以没有在 E2E 里对总条数下断言。
5. **`refreshLabel` 的时间戳用的是本机 `toLocaleTimeString('zh-CN')`**，与 BD 一致；没有做窄屏/暗色的几何回归
   （本仓库对 Town 页没有几何回归脚本，与 I6b openIssue 5 同一缺口）。
6. **草稿焦点/滚动只覆盖篝火** —— BD 还有一条围炉版（`Fireside background changes preserve draft focus and scroll`）。
   规则相同、代码路径相同（同一个 `TownComposer` 与同一个 feed 组件），模型层的围炉半边在
   `tests/town-conversation-rules.test.ts` 里有，真窗口那半只做了篝火，没有第二次开围炉重跑一遍。
7. **`npm run test:all` 没有整条跑过** —— 它是 fail-fast 的，`town-sdk` 的四条红（openIssue 1）会让它停在那一步，
   与 IM 记录的现状一致。本单元验证方式是逐个脚本单独跑（§6）。
8. **没有连过真 Being / 真 Town** —— 本机引擎是 stub，全部 E2E 都是 `protocol.handle` 夹具。
9. **（复审后新增）`TownModel.sideBySide` 与 `beings:model-settings-state` 订阅保留，但页面上没有任何地方再用它** ——
   §4.5 撤销了那句文案之后，这个字段只剩下被用例读。保留而不是删掉，是因为
   （a）I6b openIssue 2 要求的是「要显示就订阅这条、不要另开 `/api/llm/config` 读者」，订阅本身没有错，
   （b）删掉它要动 `start()` 与三条用例，超出本轮复审的范围。
   **如果合并者认为它该走，连同 `receiveModelSettings` 与 `start()` 里那两行一起删即可，没有其它调用点。**
10. **`MEMBERS_GRACE_MS = 300` 与 `MEMBERS_READ_TIMEOUT_MS = 20000` 都是本外壳自己定的数**，
   不是 BD 的常数（BD 两处都没有）。300 是复审给的建议值，20000 取自 `session/client.ts` 的同名时限；
   两者都没有在真 Town 上量过。

---

## 8. 复审回合（2026-09-17）

| 复审条目 | 处理 | 位置 |
| --- | --- | --- |
| medium · 身份到达时私信不重投 | **已修**：`inboxRead` + `projectInbox()`，零请求就地重投；`resetIdentity()` 一并清空 | §4.6；`town.ts`；用例 `an inbox read before the identity arrived is re-projected when it does, without asking Town again` |
| medium · `refreshLabel` 用 SBS 盖住真实状态 | **已修**：删掉 `(town.sideBySide === false && !collected)`，回到 BD 的触发条件 | §4.5；`page.tsx`；用例 `never lets an unconfigured loop talk over a reader that is working or failing`，并改写了 `takes the side-by-side fact…` 的断言 |
| low · `readsWhilePending >= 1` 近乎恒真 | **已修**：改成 `>= 1 && <= 2` 并在注释里写明那个 +1 的来源 | `tests/town-ui.mjs` |
| low · 共享目录读没有超时 | **已修**：`AbortSignal.timeout(membersReadTimeoutMs)`，默认 20 s | §4.3.1；用例 `a directory read that never lands frees the shared slot instead of stranding every later caller` |
| low · 冷采集把 `authorUnknown` 落盘 | **已修**：只在「这一页真的有 `authorUnknown` 且目录还在飞」时等最多 300 ms；并写进 §4.3 | §4.3；三条新用例 |

**反向证据（逐条改回原样后重跑）**

| 修复 | 改回后 |
| --- | --- |
| `arrived` 重投收件箱 | `tests/town-conversation-rules.test.ts` 那条变红 |
| 去掉 SBS 那段条件 | 同文件两条变红（新增的那条，以及改写后的 `takes the side-by-side fact…`） |
| 共享读时限 | `tests/town-session-session.test.ts` 那条 **5004 ms 超时变红** |
| 目录宽限 | `a directory that lands inside the grace…` 变红（`beingId` 为空） |
