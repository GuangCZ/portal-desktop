# I1 · Town 直连读写与时间线（集成单元）

基线：`next @ 9794cab`（I0 接缝已合）。日期：2026-09-16。

本文件是本单元的断点续传记录：阅读摘要 / 进度 / 决定与偏差 / IPC 清单 / 共享文件触碰行。

---

## 1. 阅读摘要

### 1.1 `integration-plan.md` §3 统一约定 + §3.1（I1）

- 独占新文件：`main/subsystems/town.ts`、`main/town/{ipc-desktop,speak}.ts`、`preload/channels/town.ts`、
  `shared/town-desktop-types.ts`、`renderer/town-desktop/{models,components,slot.tsx}`、`tests/town-integration-*.test.ts`。
- 子系统导出面：`TownSubsystem { key:'town'; client; session; background; pairing; cachedReads; identityKey(); invalidateMembers() }`。
- 装配逐行对照 BD `src/main.cjs:371-470`；`TownSession.fetchImpl` 必须外包 `credentials:'omit'` + `referrerPolicy:'no-referrer'`。
- 生命周期：`connectionVerified` → 刷新 connection/revision/identityRevision + `client.lifecycle` + `background.lifecycle` + `background.restore()`；
  `connectionCleared` → `pairing.reset()` + `client.reset()` + `background.stop()` + 清空 rooms；
  `quitting` → `background.stop()` + `bonfireCache.flush()` + `dataCache.flush()`；`powerMonitor.suspend/resume` 走 `ctx.electron.powerMonitor`。
- IPC 通道 18 条 handle + 2 条推送（表见 §4）。
- renderer：`SHEET_SLOTS` 一项（`view:'town-desktop'`）+ `SIDEBAR_SLOTS` 一项（篝火/围炉入口）。
- 要收敛的副本：`town/session/sanitize.ts`、`town/channel/sanitize.ts`、`town/channel/loom-connection.ts` 删除改 `common/*`；
  `town/timeline/cached-reads.ts` 的内联 `scrollId` 改 import `session/library-contract`。
- 要重新启用：`tests/town-channel-pairing.test.ts` 的 8 条 skip、`tests/town-channel-town-background.test.ts` 的 15 条 skip。
- 验收：typecheck + vitest（≥ 基线 + 新增 − 23）+ architecture 六条 + 手工点开篝火看缓存先行。

### 1.2 §2.1 子系统注册表（接缝 API）

`SubsystemContext = { handle, exclusive, window, store, electron, userData, desktopId, clientVersion, onError, registry, push }`。
`electron` 窄门面含 `net.fetch`、`safeStorage`、`powerMonitor?`、`clipboard`、`shell`、`session`、`WebContentsView`。
`DesktopSubsystem = { key, connectionVerified?(connection), connectionCleared?(), quitting?(), ready? }`。
**install 同步体里不得 `ctx.registry.get(...)` 取值**，只能存成惰性 getter。`SubsystemMap` 由各单元 `declare module` 扩展。

### 1.3 §2.2/§2.3/§2.4 preload / shared / renderer 插槽

- preload：`channels/town.ts` 导出 `townDesktop`，`channels/index.ts` 一行 import + 一行属性。
- shared：新建 `shared/town-desktop-types.ts`，`shared/desktop-types.ts` 一行 `export *`，`shared/types.ts` 的 `DesktopAPI` 一行属性（`chat:` 之后按字母序）。
- renderer：`slots.tsx` 的 `SHEET_SLOTS`/`SIDEBAR_SLOTS` 各一行；`app/models/registry.ts` 的 `FEATURE_MODELS` 一行。

### 1.4 §4 冲突约束 / 附录单元索引

I1 独占目录：`main/subsystems/town.ts`、`main/town/{ipc-desktop,speak}.ts`、`renderer/town-desktop/`。
合回顺序 I3 → I2 → I4 → I1 → I6。`main.ts`/`package.json`/`forge.config.ts`/`vite.*.config.ts` 在 I0 之后任何单元都不得修改
（本单元的唯一例外：删除 main.ts 里旧 Town 层的构造与注册行，只删不加）。

### 1.5 §1.1/§1.3/§1.4 注入点签名与副本清单

u1/u2/u3 的构造签名、portal-desktop 自带 town 模块的重叠判定、同源副本收敛落点，均见计划原文；本单元按 §5.1 定案 A 全量换成移植实现。

---

## 2. 进度

- [x] 读计划 §3/§3.1/§2.1/§2.4/§4/附录/§1
- [x] 读 i0-seams 与六个接缝文件、BD `main.cjs:371-470`、BD `interfaces.md` Town 节
- [x] 共享 DTO 契约 + 错误包络 + `town/speak.ts`（定案 5.7）
- [x] `main/town/catalog.ts`（匿名公开读，D1）+ `kits/install.ts` 改 import
- [x] `main/town/ipc-desktop.ts` 24 条通道 + `main/subsystems/town.ts` 装配 + `preload/channels/town.ts`
- [x] 删除旧 Town 层（`town/{client,live,pairing,ipc}.ts` 与 `main.ts` 的构造/注册行）
- [x] 渲染层原地重写（D3）：`models/{town,feed,mentions}.ts`、`components/{feed,auth,composer,mention-text}.tsx`、`page.tsx`
- [x] 删除 u3 的 `town-controller.ts` / `portal-config.ts` / `portal-release.ts` 与其独占测试（§5.2）
- [x] 测试：`town-catalog` / `town-integration-ipc` / `town-integration-lifecycle` 新建；
      `renderer-state` / `seeds` / `town-mentions` / `renderer-slots` / `chat-ipc` 改到新实现
- [x] 重新启用 23 条 skip（pairing 8 + town-background 15），后者换成真实 `TownRefresh`
- [x] `SIDEBAR_SLOTS` 一项（篝火 / 围炉 / 私信入口）
- [x] `cached-reads.ts` 的 `scrollId` 收敛到 `session/library-contract`
- [x] 重写 `tests/town-ui.mjs` 与 `tests/town-sdk.mjs`（**未真跑**，见 §7）
- [x] `MIGRATION.md` 追加一行

### 1.6 `docs/migration/i0-seams.md`（接缝权威说明）

核对了 §A–§I，与本单元相关的实测结论：

- **I0 已经把同源副本一次收敛完**（偏差于方案 §2.5 的分步走）：`town/session/sanitize.ts`、`town/channel/sanitize.ts`、
  `town/channel/loom-connection.ts` **已删除**，导入已改指 `main/common/*`。所以 §3.1「要收敛的副本」里只剩
  `town/timeline/cached-reads.ts` 的内联 `scrollId` 要改 import。
- `SubsystemSettings` 是 `{connection, connectionAddress, settings, extras, saveExtra}`（不是方案写的交叉类型）。
- `ElectronBindings.clipboard` 是 Promise 形态；`WebContentsView`/`session`/`net.request` 是 `unknown`。
- `ctx.push` **已自带窗口守卫**，子系统不必自己判断 destroyed。
- **`connectionCleared` main.ts 从来没有调用过**（I0 如实记录的既有缺口）。本单元的 `connectionCleared` 仍要实现，
  但不能把它当作唯一的解绑路径——`connectionVerified(null)` 才是真实会走到的那条。
- `linked()` 是惰性规则的唯一例外出口（用于赋值而非读取），本单元不需要。
- renderer feature model 的类型是 `FeatureModel = Store & { start?(): () => void }`，
  **订阅/定时器一律放 `start()` 并返回关闭函数**；构造函数里不得读 AppModel 状态。
- 插槽排序 `order` 升序、同 order 按 `key`；`order` 用百位。
- `export *` 撞名是静默丢弃 → `shared/town-desktop-types.ts` 的类型名必须带前缀（`TownDesktop*`）。
- architecture 测试现在是八条（含 `main/common/` 依赖边界、`subsystems/` 不得 import electron）。

### 1.7 接缝文件真身

`subsystems/types.ts`、`subsystems/chat.ts`（模板）、`extensions.ts`（`installSubsystems` 可注入 installer 列表）、
`preload/channels/{bridge,chat,index}.ts`（`subscribe` / `enveloped` 两个助手）、`shared/{desktop-types,types}.ts`、
`renderer/app/slots.tsx`（四数组 + `visiblePanels`/`sidebarSections`/`topbarActions`/`viewSheets`）、
`renderer/app/models/registry.ts`（`FEATURE_MODELS` + `AppFeatureModels` + `FeatureModel`）。

### 1.8 基线门槛数字（本 worktree 实测）

`npm run typecheck` 绿；`npx vitest run` → **96 passed / 8 skipped 文件，1071 passed / 58 skipped 用例**。

### 1.9 BD `src/main.cjs:371-470` 装配段（逐行对照物）

与方案 §3.1 的伪代码一致，另有方案没写出来的几条实测细节：

- `townClient.getContext().key` = `connection ? sessionPartition(connection) : ''`（未连接是空串，不是 null）。
- `onEvent`：`profile_changed` → `invalidateTownMembers()` 并 **return**（不再喂 background）；其余 → `townBackground.notifyEvent(event)`；
  `dm` 额外推 `{kind:'dm'}`（收件箱不进后台收集，渲染层收到提示后自己重读）。
- `townSpeak` 先试 `townClient.speak(...)`，只有 `error.code==='AUTH_REQUIRED'` 才落到 `townWriter`（Being 中继）。
  本单元按定案 5.7 **不移植中继**：AUTH_REQUIRED 直接抛。
- `resetTownReader()` = `townPairing.reset() + townClient.reset() + townWriter?.reset() + 房间/成员缓存清空`。
- `syncTownLifecycle()` 的 enabled 判据是 `!exitStarted && !townSuspended && Boolean(connection) && status==='connected' && net.isOnline()`；
  `background.lifecycle` 多一个 `reason: townSuspended ? 'suspended' : 'offline'`。
- `powerMonitor.on('suspend'|'resume')` 只切 `townSuspended` 再 `syncTownLifecycle()`（resume **不自动重发消息**）。
- `loadCachedFiresides()`：已缓存直接 `structuredClone` 返回；否则 `cachedReads.snapshot({method:'getFiresides'})`，
  命中后写房间缓存并 `background.reconcileRooms(data)`。
- `loadCachedFiresideMembers(value)`：先取房间缓存，**房间不在目录里就直接 `{members:[],cached:false}`**；
  成员缓存 60 秒过期（`Date.now() - lastSuccessAt >= 60000` 才删）。
- `townState()` 把 `townSession.state()` / `channelBeing.state()` / `background.metadata()` / `client.state()` / `pairing.state()`
  拼进 `town.state()` 的结果，并把 `identity.townId`、`identity.displayName`、`memberDirectory` 补齐。

### 1.10 BD `docs/interfaces.md` §1.2 Town 节 / §1.3 推送 / §3.3 类接口 / §4 townApp / §5 错误码

- 通道语义、参数上限、返回 DTO 已逐条抄进本文件 §4 的 IPC 清单。
- 错误码目录（§5）：`INVALID_REQUEST` / `INVALID_RESPONSE` / `NOT_CONNECTED` / `SESSION_CHANGED` / `AUTH_REQUIRED` /
  `IDENTITY_MISMATCH` / `BUSY` / `ABORTED` / `NETWORK_ERROR` / `RATE_LIMITED` / `SERVICE_ERROR` / `NOT_SENT` /
  `RESULT_UNKNOWN` / `STORAGE_ERROR` / `PAIRING_INCOMPLETE` / `PAIR_CODE_INVALID` / `PAIR_RESULT_UNKNOWN` /
  `PAIR_STORAGE_ERROR` / `NOT_RUNNING` / `PAUSED`；未知码折叠为 `TOWN_ERROR`。
- `townApp`（§4）本期要填的字段：`identity` / `access` / `sync` / `client` / `pairing` / `memberDirectory`
  （`portalInstall` / `portalWorkspace` 属 I7）。

---

## 3. 决定与偏差（读完真实代码之后）

定案 5.1 说「删 `town/{client,live,pairing,ipc}.ts` 及其 9 条通道，渲染层 Town 页按新 DTO 重写」。
真实代码里有三处方案 §1.3 没有记到的约束，按「方案与真实代码冲突时以真实代码为准」处理：

### D1 · `town/client.ts` 还被 `main/kits/install.ts` 用着（匿名公开读）

`desktop/main/kits/install.ts:11` import `TOWN_ORIGIN, TownClient`，`:110` 用
`new TownClient(() => '', fetcher).query({kind:'kit', id})` 做**匿名公开目录读**，`:65` 用 `TOWN_ORIGIN` 拼下载地址。
Kits 子系统不属于本单元，也不在任何单元的删除范围里。

处理：把 `town/client.ts` 拆成两半——
**带鉴权的那半（`TownCredentials` 凭据库、`pair`、`send`、私密路由）全部删除**，由移植来的
`TownClient`（`town/session/client.ts`）+ `TownClientStore` 接管；
**匿名公开目录读那半**留下，搬进本单元的新文件 `desktop/main/town/catalog.ts`（`TOWN_ORIGIN` / `townRoute` / `TownCatalog`），
`townRoute` 只保留 `private:false` 的 kind（`home`/`seeds`/`seed*`/`embers`/`ember`/`scrolls`/`scroll`/`grove`/`kit`），
私密 kind（`bonfire`/`firesides`/`fireside`/`inbox`/`sent`/`my-scrolls`）删除。
`kits/install.ts` 改一行 import。

### D2 · 通道删除的实际账目

`town/ipc.ts` 注册的是 **10** 条（方案写 9）。按 D1 的拆分：
**删 8 条**：`beings:town-live`、`-reconnect`、`-send`、`-auth`、`-pair`、`-pair-cancel`、`-auto-pair`、`-token`。
**留 2 条**（改由本单元的 `town/ipc-desktop.ts` 注册，只服务公开目录）：`beings:town`（私密 kind 已从路由表删除）、`beings:town-open`。
`beings:town-open` 原来经 `options.open(url)` 打到外壳浏览器；子系统上下文没有浏览器句柄，改用
`ctx.electron.shell.openExternal`（允许名单与原来逐字一致）。这是行为偏差，已记在 openIssues。

### D3 · 渲染层「原地重写」，不新建 `renderer/town-desktop/`

任务给了二选一。选**原地重写** `desktop/renderer/town/`，理由是另一条路走不通：
`desktop/renderer/app/models/app.ts`（`readonly town = new TownModel(...)`、`this.town.start()`、`.show()`、`.updateLive()`）与
`desktop/renderer/app/page.tsx`（`<Town model={app.town}/>`、`<TownComposer>`、`<TownAuth>`、`<KitInstall>`）、
`components/navigation.tsx`（import `definitions`）、`topbar.tsx`、`settings.tsx`（`app.town.auth()`）都直接依赖 `TownModel`，
而 `app.ts` / `page.tsx` 是 I0 明文规定「只有 I0 能改 / 后续单元不需要再改」的文件。
删掉 `renderer/town/` 就必须改它们；新建一个 `town-desktop/` sheet 又正好是任务禁止的「两套并存」。
所以：`TownModel` 的类名与构造签名保持不变，**内部的私密视图（篝火 / 私信 / 围炉）整体改接新通道与新 DTO**，
公开目录视图（广场 / 书架 / 种子 / 卷轴公开页 / Grove / 本机 Kits）继续走保留下来的 `beings:town`。
每个功能只有一份实现，没有并存。
不新增 `SHEET_SLOTS` 项（会是第二个 Town 页）；新增一项 `SIDEBAR_SLOTS`（BD `sidebar.js` 的篝火 / 围炉入口）。

### D4 · `desktop/shared/types.ts` 与 `desktop/preload/preload.ts` 不止 append

删通道就必须删 `DesktopAPI` 上对应的成员与 `preload.ts` 里对应的行，这两处超出了「只 append 一行」的纪律。
已逐行记在 §5 的共享文件触碰行里，合回时这两处需要人工过一眼。

### D5 · 定案 5.7

`townSpeak` 未配对直接抛 `AUTH_REQUIRED`（文案「请用 Being 提供的六位配对码连接 Town。」），不做 Being 中继回退；
`createClient` 钩子保持可选、缺省 `undefined`（u3 的 `ChannelBeing` 用，本单元不传）。

### D6 · `mention_warnings` 的候选要显示，不是只报个数

第一版 `send()` 成功但有 `mention_warnings` 时只给一句固定文案。核对 BD `renderer/town-mentions.js`
`warnings()` / `renderReceipt()` 后改回 BD 的行为：**消息已被 Town 接受**，未解析的 @ 连同 Town 给出的候选
（`display_name · town_id`）一起展示，点候选把完整 Town ID 写进**下一条草稿**（私信则写进收件人），
绝不重发已发布的那条。新增 `renderer/town/models/mentions.ts` 的 `mentionWarnings()`（兼容 BD 见过的
string / `mention|name|display_name|query|token|input` / `message|reason|warning` 几种形状）。

### D7 · 两个渲染层缺陷，是重写测试时暴露的

1. `openFeed` 里同一个 feed 的第二次打开会 join 正在飞的读，但**结果被丢掉**——因为应用结果时比对的是
   第一个打开者的 generation，而它已经不是当前的了；同时 `reading` 卡在 true。
   改成：**读共享，结果不共享**——每个调用者各自 fence 后应用同一份结果。
2. `auth()` 直接 `this.townApp = state` 赋值，绕过了其它所有状态转换都要走的身份重置。改成 `receiveState(state)`。

### D8 · 被删测试的去向（逐个核对，不是整文件丢掉）

| 删除的测试文件 | 用例 | 去向 |
| --- | --- | --- |
| `tests/town.test.ts` | 12 | 「Town SDK 2769e2f protocol」7 条已由 `tests/town-session-client.test.ts` / `town-session-name-rules.test.ts` 逐条覆盖（mention_warnings、候选、reply_to、配对存储、三通道 body、Unicode 上限、自寄私信）；凭据落盘那条由 `tests/town-timeline-client-store.test.ts` 覆盖；其余 4 条（公开路由约束 / 不带凭据 / 四类错误 / 4MB 截断）搬进新建的 `tests/town-catalog.test.ts` |
| `tests/town-ipc.test.ts` | 1 | `tests/town-integration-ipc.test.ts`（通道集合、发送者校验、逐字段校验、包络码、epoch） |
| `tests/town-live.test.ts` | 3 | `beings:town-live` 已删；对应语义由 `tests/town-session-client.test.ts` 的 SSE 六条 + `tests/town-integration-lifecycle.test.ts` 承接 |
| `tests/town-pairing.test.ts` | 10 | `tests/town-channel-pairing.test.ts`（本单元重新启用的 8 条 + 原有 10 条） |
| `tests/town-identity.test.ts` | 9 | `tests/town-session-identity-migration.test.ts` / `town-session-store-binding.test.ts` / `town-mentions.test.ts`（已改写到成员目录） |
| `tests/town-channel-town-controller.test.ts` | 32 | 随 §5.2 删除的模块一起删除，grep 核实只 import `town-controller.ts` |
| `tests/town-channel-p1-identity.test.ts` | 2 | 合并为 `tests/town-integration-ipc.test.ts` 的「P1 identity …」一条，改到 `beings:town-app` 上断言同一条身份三元组规则 |

---

## 4. IPC 通道清单

`registerTownDesktopIpc`（`desktop/main/town/ipc-desktop.ts`）注册 24 条，注册顺序即下表顺序。
除最后两条外全部**包络**：失败时 resolve `{__townError:true, code, message}`，`code` 取自
`desktop/shared/town-desktop-errors.ts` 的目录；`NOT_SENT` 另带 `candidates`。

| 通道 | 载荷 | 说明 |
| --- | --- | --- |
| `beings:town-app` | — | `townApp` 快照 |
| `beings:town-app-refresh` | — | 强制重读配对身份后返回快照 |
| `beings:town-timeline` | `{kind, firesideId?}` | 本机缓存快照，先于任何网络读 |
| `beings:town-timeline-refresh` | `{kind, firesideId?}` | 一次显式刷新（limit=50） |
| `beings:town-timeline-older` | `{kind, firesideId?}` | 一次有界向前翻页（≤6 页） |
| `beings:town-read` | `{kind, firesideId?, selectionRevision?, includeRooms?}` | 一次 SDK 读；围炉另带目录与成员 |
| `beings:town-bonfire` | `{limit?, since?}` | 篝火分页 |
| `beings:town-fireside-messages` | `{firesideId, limit?, since?}` | 围炉分页 |
| `beings:town-firesides` | — | 围炉目录（实读） |
| `beings:town-fireside-members` | `firesideId` | 围炉成员（缓存优先） |
| `beings:town-inbox` | — | 私信（两个方向一次读回） |
| `beings:town-beings` | `{}` | 居民目录 |
| `beings:town-scrolls` | `{offset?, limit?, visibility?}` | 卷轴列表 |
| `beings:town-scroll` | `{id, offset?, limit?}` | 卷轴正文 |
| `beings:town-cached` | `{method, value?}` | 八个方法的纯缓存读 |
| `beings:town-members` | `{force?}` | 成员目录 + 缓存元数据 |
| `beings:town-profile-changed` | — | 失效目录并重读身份（不改名、不发消息） |
| `beings:town-speak` | `{kind:'bonfire'\|'fireside'\|'dm', …, connectionRevision}` | 三种发送合一；epoch 不符拒发 |
| `beings:town-client-pair` | `{code}` | 六位码兑换 |
| `beings:town-client-auto-pair` | — | 一键配对（Being 生成码） |
| `beings:town-client-retry-storage` | — | 只重试落盘，绝不再要一个码 |
| `beings:town-client-forget` | — | 删除本机配对 |
| `beings:town` | `TownQuery` | **公开目录**，匿名，非包络 |
| `beings:town-open` | `route` | 公开页外链，白名单，非包络 |

推送（`ctx.push` → 主窗口）：

| 通道 | 载荷 |
| --- | --- |
| `beings:town-state` | `TownDesktopAppState`（**方案两条表之外新增的一条**，理由见 `shared/town-desktop-types.ts` 注释：本外壳没有 BD 的 `being:state` 总推送） |
| `beings:town-messages` | `TownDesktopEnvelope` 或无载荷的 `{kind:'dm'}` 提示 |
| `beings:town-members-invalidated` | `TownDesktopMemberCacheState` |

---

## 5. 共享文件触碰行

**只 append 一行 import + 一行条目**（符合纪律）：

| 文件 | 增加的行 |
| --- | --- |
| `desktop/main/extensions.ts` | `import { installTownSubsystem } from './subsystems/town';` / `installTownSubsystem,` |
| `desktop/preload/channels/index.ts` | `import { townDesktop } from './town';` / `townDesktop,` |
| `desktop/shared/desktop-types.ts` | `export * from './town-desktop-types';` |
| `desktop/shared/types.ts` | `import type { ChatAPI, TownDesktopAPI } from './desktop-types';` / `townDesktop: TownDesktopAPI;`（`chat:` 之后） |
| `desktop/renderer/app/slots.tsx` | `import { TownFeedLinks } from '../town/components/sidebar-feeds';` / `{ key: 'town-feeds', order: 100, placement: 'head', Section: TownFeedLinks },` |

**超出 append 的（合回时需人工过目）**：

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `desktop/main/main.ts` | **只删不加**：3 条 import、`let townLive` / `let cancelTownPairing`、`townCredentials`/`townLive`/`town` 构造块、Town 诊断 `checks.push(...)` 一行、`registerTownIpc({...})` 调用、`cancelTownPairing?.()`×2、`townLive?.dispose()`×2；另改了一处过期注释里的路径（`town/pairing.ts` → `town/channel/pairing-probe.ts`） | 任务明文允许的唯一例外：删除旧 Town 层的构造与注册行 |
| `desktop/preload/preload.ts` | 删除 `townLive`/`reconnectTown`/`sendTown`/`onTownLive`/`townAuth`/`pairTown`/`autoPairTown`/`cancelTownPair`/`saveTownToken`，保留 `town`/`openTownLink`，去掉 `TownLiveState` import | 通道删了，桥上的成员必须一起删 |
| `desktop/shared/types.ts` | 除上面那一行 append 外，删除同名 `DesktopAPI` 成员、删除 `TownLiveState`/`TownPost`/`TownChannel`、把 `TownKind` 收窄到公开 kind（附注释） | 同上 |
| `desktop/main/kits/install.ts` | import 改成 `../town/catalog` 的 `TOWN_ORIGIN`/`TownCatalog`，一处 `new TownClient(...)` 改 `new TownCatalog(...)` | D1 |
| `desktop/main/town/channel/types.ts` | 删除 `TownControllerContext`/`PortalInstaller`/`PortalInstallProgress`/`PortalProcess`（grep 核实无其它引用），留一段说明 | §5.2 |
| `desktop/main/town/timeline/cached-reads.ts` | 内联 `scrollId` 改 `import { scrollId } from '../session/library-contract'` | 计划要求的副本收敛 |
| `tests/chat-ipc.test.ts` | fixture 增加 `electron.net`（离线），通道断言与推送收集器各加一个 `beings:chat` 过滤 | 装上 Town 子系统后，别人的通道/请求会落进 chat 的断言里；chat 的每一条断言一字未动 |
| `tests/renderer-slots.test.ts` | fixture 的 `onTownLive`/`townLive` 换成 `townDesktop` 四个成员；「ships empty」改成按 key 断言 | 第一项落地插槽的单元必然要改这两处 |
| `tests/seeds.test.ts`、`tests/town-mentions.test.ts`、`tests/renderer-state.test.ts` | 改写到新实现 | 见 §6 |

---

## 6. 测试账目

| 阶段 | 通过 / 跳过 |
| --- | --- |
| 基线 `next @ 9794cab` | 1071 / 58 |
| 本单元结束 | 1026 / 34 |

差额是 §5.1 / §5.2 明文授权删除的旧模块独占测试（见 D8 的逐条去向表），减去新增与重新启用的：
删除 69 条（`town` 12 + `town-ipc` 1 + `town-live` 3 + `town-pairing` 10 + `town-identity` 9 +
`town-channel-town-controller` 32 + `town-channel-p1-identity` 2，`it.each` 展开后运行时条数更多），
新增 20 条（`town-catalog` 5 + `town-integration-ipc` 10 + `town-integration-lifecycle` 5）
+ `renderer-state` 净增 2 + `shared reading` 净增 1，
重新启用 23 条 skip（pairing 8 + town-background 15）。
**没有删除或弱化任何一条不属于被删模块的测试。**

---

## 7. Smoke 与真机验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿 |
| `npx vitest run`（含 `tests/architecture.test.ts` 六条） | 92 文件通过 / 8 跳过；1026 通过 / 34 跳过 |
| `node tests/town-ui.mjs` | **未执行**：打印 `SKIPPED: 客户端测试包不存在` |
| `node tests/town-sdk.mjs` | **未执行**：同上 |
| 打包 smoke（`npm run package`） | **失败于前置条件**：`forge.config.ts` 的 prePackage 钩子要求 `resources/heart-portal`，而它由 `npm run build:portal` 用 `cargo build --release -p heart-portal` 产出；本机没有 `cargo`（`which cargo` 无结果），`resources/` 里也没有预置二进制。`npm run prepare:desktop` 本身是成功的 |
| 手工点开篝火看「缓存先行」 | **未执行**：同上，需要可运行的客户端 |

两个 E2E 脚本已按新表面重写完毕并通过语法检查，但**在本环境里一次都没有真跑过**。
装好 Rust 工具链后应先跑 `npm run build:portal && npm run package`，再依次跑
`npm run test:town-ui`、`npm run test:town-sdk`，两者的断言都可能需要按真实 DOM 时序微调。

---

## 8. 遗留

1. 上面两个 E2E 脚本未经真实运行验证（无 `cargo` → 无安装包）。
2. `beings:town-open` 由 `options.open(url)` 改为 `ctx.electron.shell.openExternal`（允许名单逐字一致）。
3. BD `test/town-conversation-ui.cjs` 有 60+ 条 UI 断言；`tests/town-ui.mjs` 只承接了其中「需要真实主进程才有意义」的 8 条，
   其余（围炉切换的竞态族、草稿焦点/滚动保持、SBS 状态条文案族）尚未搬运。
4. `desktop/main/town/channel/` 里还留着 u3 的 `sanitize.ts` / `loom-connection.ts` 类副本收敛（计划 §1.1 提到的 `common/*`），
   本单元只做了 `scrollId` 一项。
5. 用户需要重新配对（无凭据迁移器），已写进 `MIGRATION.md`。
6. `MIGRATION.md` 里原本没有「每个集成单元一行」的表，所以本单元建了表头（标题 + 一行说明 + 表头 + 分隔行 + 自己的一行，共 4 行内容）。
   后续单元只需要在表里追加一行。这比约定的「只追加一行」多，记在这里以便合回时知道多出来的是什么。

---

## 9. 复审结论处理（2026-09-16）

复审给了 2 条 high + 2 条 medium。逐条核对源码后的结论与处理：

### R1（high · `subsystems/town.ts` 的 `identityRevision++`）—— 属实，已改

核对：BD `src/main.cjs:455-460` 的 `invalidateTownMembers()` 只做
`townMemberCache.clear() + townCachedReads.invalidateMembers() + townSession.invalidateMembers() + 推送`，
**不碰 `identityRevision`**；BD 里只有两处动它——`src/main.cjs:710`（身份分区变化）和 `:1482`（断开）。
而 `identityRevision` 进了 `background.getIdentity()`，下游三处都会把它当身份变化：

- `town/timeline/refresh.ts:533-540`：`identityKey` 一变就 `_invalidate()` + `_replace(emptyTimeline())` + 清掉
  `lastSuccessAt/revision/receipt` —— 累积的时间线被抹掉。
- `town/channel/town-background.ts:163-181`：`lifecycle()` 认为身份变了 → `_bonfire.stop()+reset()`、`clearRoom()`。
- `town/channel/town-background.ts:258-260`：`_assertCurrent` 让所有在飞的 `requestRead/refresh/loadOlder` 抛 `SESSION_CHANGED`。

也就是说一次 `profile_changed`（改个显示名）会清空篝火时间线并让在飞的读失败，
正好和它上面两行注释承诺的「feeds 没变，故意不动」相反。成员缓存本身也不需要这个 bump：
`TownCachedReads.invalidateMembers()` 自己 bump `_membersRevision`，`TownSession.invalidateMembers()` 自己围栏目录。

处理：删掉这一行。新增回归用例见 §10。

### R2（high · 私有卷轴正文读不到）—— 属实，已改（按 visibility 路由）

核对：`main/town/catalog.ts:70-74` 把 `kit|ember|scroll` 一律 `private:false`，`:90-94` 只发
`Accept: application/json` + `credentials:'omit'`；而基线 `town/client.ts:48-51` 对 `kind:'scroll'` 是
`private:true`，`:151-153` 会带 `Authorization`。「我的卷轴」页签（`models/town.ts:696`）已经走配对客户端
`this.town.scrolls({visibility:'private'})` 列出行，行一点开却又回到匿名 `this.api.town(query)`
（`components/catalog.tsx:144-148` → `models/town.ts:860`），于是私有/分享卷轴的正文必然 401。
`beings:town-scroll` 通道与 preload 成员都已注册，但没有任何调用方。

处理（`models/town.ts`）：

- 新增 `scrollVisibility(id)`：从当前列表里取该卷轴的 `visibility`；取不到（从链接直接打开）当作**非公开**。
- 新增 `readScrollBody(query)`：走 `this.town.scroll({id, offset?})`，把校验过的 DTO（`beingName`/`updatedAt`/`hasMore`）
  投影成公开目录那一份（`display_name`/`updated_at`/`has_more`），所以阅读面板仍然只认一种形状。
- `loadDetail` 的路由判据：`kind==='scroll' && paired && visibility!=='public'` → 配对客户端；其余（未配对的匿名浏览、
  以及目录已经标成 `public` 的那一份）继续走 `beings:town`。公开的那一份**故意**留在匿名路由上：
  校验过的 DTO 不带 `trigger_context`/`outcome`，而公开阅读面板要渲染它们（`components/catalog.tsx:307-308`）。
- 失败时 `detailError.auth = (code==='AUTH_REQUIRED')`，按钮给「去配对」而不是一个只会再失败一次的重试。

用例：`tests/renderer-state.test.ts` 新增 2 条（「我的卷轴」→ 打开 → 带凭据读、公开那一份仍然匿名；
以及 `AUTH_REQUIRED` 时 `detailError.auth`）。

### R3（medium · `tests/town-identity.test.ts` 的渲染层用例没有去向）—— 属实，已补

核对：被删文件确实同时 import 了 `models/feed.ts` 的 `feedMessages`/`feedReplyAuthor`/`mailReply`，
而 `feed.ts` 是**重写**不是删除。§5.1 授权删除的是「旧模块的专属测试」，这半个文件不在授权范围内；
D8 的去向表把这 9 条整体记给了 `town-session-*` / `town-mentions`，那三处都不碰渲染层的回复规则。
删除后 `grep -rn 'mailReply\|feedReplyAuthor' tests/` 为空——两个导出零覆盖。

处理：新建 `tests/town-feed.test.ts`（10 条），把回复规则按新 DTO 逐条重述：

| 旧用例 | 新用例 |
| --- | --- |
| 显示名与大小写敏感回复地址分离（收件/发件） | 「keeps display names separate from case-sensitive reply addresses…」 |
| 回复用精确 Town ID | 「answers the exact Town id and never a differently cased one」 |
| 绝不拿 feed 序号当私信回复 ID | 「never uses a feed sequence as a private message reply id」 |
| 服务端解析的 mention 列表优先 | 已在 `tests/renderer-state.test.ts` 的「prefers the mention list Town resolved」 |
| 显示名兜底（无 Town ID 时） | **有意改变**，见下「declines a letter of mine…」 |
| 回复作者取显示字段 | 「resolves through the member directory and falls back to the neutral label」 |

有意改变的一条：旧实现在没有 Town ID 时把**显示名**当收件地址。新实现拒绝——显示名可以同时指两个 Being，
Town 对这种情况回 `NOT_SENT` + 候选而不是投递（`session/client.ts:472`），预填一个发不出去的收件人不如不给回复按钮。
这条在测试里带注释写明了是改变，不是漏掉。

### R4（medium · 自己发出的私信无法回复）—— 属实，已改；成因在 DTO 而不只在渲染层

核对确认了复审说的症状：`feed.ts` 的 `inboxMessages` 对 `mine` 的消息写 `recipientId: ''`，
`mailReply` 的 `message.mine ? message.recipientId : message.authorId` 于是恒为空 → 回复按钮消失
（`components/feed.tsx:252`）。而同一个组件 `:295` 又写着 `{mail && m.recipient && !m.received && <span>→ …</span>}`，
界面本来就是按「发件人是我时显示收件人」画的。

但**光改渲染层改不动**：地址根本没进来。`session/session.ts` 的 `directMessagesDto`（逐行移植自 BD
`src/town-session.cjs:81-95`）只取 `sender*`，把收件人整个丢了。Town 是发了的——
`session/wire.ts:45`（同样逐行移植）专门为 `/api/messages` 做了 `recipient_town_id → recipient` 的改名，
`tests/town-session-client.test.ts:259-260` 与 `tests/town-session-identity-migration.test.ts:142` 的真实载荷样本里也都有
`recipient`/`recipient_town_id`。BD 丢得起，是因为 BD 的收件箱只画一个方向、回复恒定填 `entry.senderId`
（`renderer/town-app.js:1623-1629`）；本外壳的收件箱会标「本 Being 发送」并提供继续这段对话，就需要另一端的地址。

处理（三层，都是**增量字段**，不改任何请求、头、校验或既有字段）：

1. `main/town/session/types.ts`：`TownDirectMessage` 增 `recipientId?` / `recipientName?`。
2. `main/town/session/session.ts`：新增 `recipientField(item)`，与既有 `viaField`/`replyField` 同一写法——
   只在载荷真有的时候带上（`validId(recipient) || validId(recipient_being_id)`；名字取 `recipient_name` 或 `recipient_display`，
   且只在有地址时才带名字）。这是**超出逐行移植的一处增量**，注释里写了理由与证据。
3. `shared/town-desktop-types.ts`：`TownDesktopDirectMessage` 同步增两个可选字段。
4. `renderer/town/models/feed.ts`：`inboxMessages` 用 Town 给的收件人；给我的信没带收件人时仍然算给我的；
   我发的信没带收件人时地址为空，`mailReply` 于是**照旧不给回复按钮**（诚实：确实无处可回），显示名照常显示。

顺带修掉自测暴露的第二个缺陷：`mailReply` 之前对一条**篝火消息**也会返回回复（feed 的 id 是纯数字序号，
正好过 `[a-zA-Z0-9_-]{1,160}`，`authorId` 又在），也就是旧用例点名的「拿 feed 序号当私信回复 ID」。
现在 `FeedMessage` 带一个 `mail: boolean`（`feedMessages` 给 false、`inboxMessages` 给 true），
`mailReply` 先看它再看 id——两套 id 空间不再有机会混。

用例：`tests/town-feed.test.ts` 10 条（含「我发的信回给另一端」「篝火行不给私信回复」「没有地址就不给按钮」），
`tests/town-session-client.test.ts` 与 `tests/town-session-identity-migration.test.ts` 各加一条断言（不删不弱化任何既有断言），
钉住 `recipient` 与 `recipient_town_id` 都能落进 DTO。

---

## 10. 复审修复后的门槛与账目

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿 |
| `npx vitest run` | 93 文件通过 / 8 跳过；**1039 通过 / 34 跳过** |

1026（本单元结束）→ 1039：R1 +1（`town-integration-ipc`：`profile_changed` 之后时间线与 `sync.bonfire.lastSuccessAt` 仍在）、
R2 +2（`renderer-state`）、R3/R4 +10（新建 `tests/town-feed.test.ts`）。
`town-session-client` 与 `town-session-identity-migration` 是在既有用例里**加断言**，条数不变。

复审修复轮触碰的文件（前三个是本单元自己的，后两个是 u1 移植模块的增量字段）：

| 文件 | 改动 |
| --- | --- |
| `desktop/main/subsystems/town.ts` | R1：删掉 `invalidateMembers()` 里的 `identityRevision++` |
| `desktop/renderer/town/models/town.ts` | R2：`scrollVisibility()` / `readScrollBody()` / `loadDetail` 路由 / `detailError.auth` |
| `desktop/renderer/town/models/feed.ts` | R4：`FeedMessage.mail`、`inboxMessages` 收件人、`mailReply` 守卫 |
| `desktop/main/town/session/types.ts` | R4：`TownDirectMessage` 增两个可选字段 |
| `desktop/main/town/session/session.ts` | R4：`recipientField()` 与 `directMessagesDto` 里的一行展开 |
| `desktop/shared/town-desktop-types.ts` | R4：`TownDesktopDirectMessage` 增两个可选字段（本单元自建文件） |

`session/{types,session}.ts` 属于 u1 已合入的移植模块，不在任何单元的独占目录里；I7（`main/town/channel/`）在并行组 B，
与这两个文件不重叠。改动是纯增量字段，合回时应无冲突。

§7 的真机项（两个 E2E、打包 smoke、手工点篝火）仍然**没有执行**，条件与 §7、§8 记的一样（本机无 `cargo`）。
