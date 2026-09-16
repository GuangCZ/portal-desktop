# IN · 壳层错误码与合并后小缺口

单元 key：`IN`（并行组 C）。工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/in-shell-errors`，
分支 `in-shell-errors`，基线 `next @ 5be8565`（typecheck 绿；vitest 127 文件 / 1398 通过 / 24 跳过）。
日期：2026-09-17。

本单元不新增功能，收口的是并行组 A/B 合回 `next` 之后留下的**跨单元**遗留，最重的一条是
`contextBridge` 剥掉 Error 自定义属性导致四族通道的 `code` / `candidates` 到不了渲染层。

---

## 1. 阅读摘要

### 1.1 `docs/migration/im-integration.md` §4.4 / §4.5 / §8（openIssues）

- **§4.4（本单元第 1 条的原始证据）**：`tests/town-sdk.mjs` 首跑 13 过 4 红。红的 4 条都是读 `error.code` 的。
  实测：`window.beings.townDesktop.bonfire()` 未配对时 reject 出来的 Error，
  `Object.getOwnPropertyNames(e)` 只有 `["stack","message"]`，**没有 `code`**；
  同一刻 `townDesktop.appState()` 的 `sync.bonfire.errorCode` 是 `"AUTH_REQUIRED"`——主进程知道，渲染层拿不到。
  根因用两文件独立夹具复现（`/tmp/im-cb/fixture`，Electron 44.2.0）：
  `contextBridge` 暴露的函数 throw `Object.assign(new Error(m), {code})`，页面侧自有属性只剩 `["stack","message"]`
  （同步抛同样，`Object.keys` 只有 `message`）；**把同一个值当普通对象返回则原样到达**。
  → `preload/channels/bridge.ts` 的 `enveloped` 与 `preload/channels/town.ts` 的 `townEnveloped`
  把包络还原成 Error 的位置在 contextBridge 的**错误一侧**。
  继承自 0.8.26（`BeingDesktop/src/preload.cjs` 60-76，注释自己写着 Electron strips custom Error fields；
  `renderer/town-app.js:308` / `:1027` 的分支在 0.8.26 里同样走不到）。
  IM 明确不修（跨 I1/I5/I7/I6b 四个单元），4 条断言原样保留。
- **§4.5**：`tests/town-ui.mjs` 13 过 2 红。其一是私信歧义候选到不了渲染层
  （`TownModel.send()` 读 `(error).candidates`，`renderer/town/models/town.ts:1147`）——**本单元要转绿的那条**；
  其二（§8 第 10 条）是篝火读阻塞在成员目录上（`main/town/session/session.ts:408` 的 `Promise.all`）——**IT 的**，保持红。
- **§8 openIssues** 与本单元对应关系：1 → 本单元第 1 条；3 → 第 6 条（假钥匙串默认）；7 → 第 5 条（退出瞬间的 snapshot）；
  10 → IT；2/8 已被第二轮推翻/解决；4（窗口标题）、5（没连真实 Being）、6（protocol.ts 403 无测试）、9、11 不在本单元范围。
- IM 已核实 `connectionCleared()` 本外壳没有解绑路径（不再追）；`beings:select-saved-project` 定名不改；
  两个浏览器面板同时要求显示时矩形归最后说话的面板。

### 1.2 `docs/migration/i5-conversation.md`（D3 / F2 / F3 / 未做 1）

- **D3 + F2 + 未做 1（本单元第 2 条）**：`main.ts` 把 `PortalSupervisor` 留在自己的闭包里，没传给 `installDesktopExtensions`；
  `SubsystemContext` 也没有这个字段，所以 `subsystems/chat.ts` 传 `getPortalState: () => null`，
  帧里 `portal.status` 恒 `not_configured`、`health` 恒 `unknown`——**定案 §5.2 的交付物在合回 next 之后仍不成立**。
  I5 把 IM 要加的三行逐字写在了 `subsystems/chat.ts` 的 `getPortalState` 上方：
  `subsystems/types.ts: portalState?: () => PortalState | null;` /
  `main.ts: portalState: () => portal.state,` / `subsystems/chat.ts: getPortalState: () => ctx.portalState?.() ?? null,`。
  `chat/environment.ts` 的 `portalRuntime`（九行映射表）与 `tests/chat-integration-environment.test.ts` 都不用改。
  I5 明确否决过两条捷径：`declare module` 增补接缝、`ctx as {portalState?}` 硬转。
- **F3（本单元第 7 条）**：`connectionRevision` 的跨子系统隐式耦合。`main.ts` 只有两处调 `connectionVerified`（335 / 449），
  两处都在 `verifyBeingConnection` 之后，而 `chat/ready.ts:6` 第一行就 `if (!connection) throw`——
  **生产路径到不了 `!next` 那一支**（`town.ts:333` 与 `chat.ts` 的分歧点），两个计数器在可达路径上恒等。
  I5 没改行为，改为用 `tests/chat-integration-composer.test.ts` 钉住不变量
  （回显 revision → `AUTH_REQUIRED` 而非 `SESSION_CHANGED`；±1 → `SESSION_CHANGED`；换 Being 旧值仍被拒；同 Being 重验两边都不动）。
  真正的收敛留给 IM/IN。

### 1.3 `docs/migration/i7-channel-drafts.md`（D3 / R2 / 未做 1、5、8）

- **D3（与 IM §4.4 同一件事，且 I7 已给出可行修法）**：I7 的四条 `beings:channel-*` 通道
  **preload resolve 出信封而不是抛**，渲染层 `renderer/channel/models/channel.ts` 的 `unwrap()`
  在渲染层自己的上下文里变回带 `code` 的 Error——不跨界就不会被拷贝。
  `ChannelAPI` 四个方法因此返回 `ChannelAnswer<T> = T | ChannelErrorResult`。
  **这就是本单元要推广到全部通道族的机制**（I7 已在打包客户端上验证过）。
- **未做 1**：I1 的 24 条 `beings:town-*` 与 P1 的 5 条 `beings:chat-*` 仍是旧形状，需要合并者统一拍板。
- **R2 + 未做 8（本单元第 3 条）**：`feature-tasks.ts:121` 抛英文 `Too many active feature tasks`，
  33 字无换行，`shared/errors.ts:12` 的 `publicErrorMessage` 会原样放行 → 用户看到英文。
  BD 在 `src/main.cjs:740` 的 catch 里统一换成
  「功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。」（码 `TASK_LIMIT_REACHED`，BD `src/main.cjs:127` 有）。
  I7 只在自己的 `main/town/channel/ipc.ts` 用常量 `TASK_LIMIT` 出这句原话，没动共享表。
  统一修法（I7 写明）：`TOWN_ERROR_CODES` 末尾加 `'TASK_LIMIT_REACHED',`，中文文案放进 `feature-tasks.ts` 抛出点，
  `ipc.ts` 的 `TASK_LIMIT` 常量随之删除。
- **未做 5（本单元第 4 条）**：`FEATURE_NAMES` 的 `model` / `workspace` 两个键在本外壳没有页面，
  功能任务页点「打开功能页」toast「该功能暂时没有可打开的页面。」。`model` 的页面是 I6b 的，
  合回后把 `TASK_VIEWS` 加一行指过去；`workspace` 仍无页面 → 保持 toast。

### 1.4 `docs/migration/i6b-model-settings.md`（视图键 / openIssues 4）

- 模型页在 `desktop/renderer/settings/components/model-settings.tsx`，DOM id `#model-settings-page`，入口按钮 `#open-models`
  （`tests/sbs-refresh.mjs` 在真窗口里点 `#open-models` 等 `#model-settings-page`）。视图键要从 `app/slots.tsx` / 导航模型里实读。
- openIssues 4：`CHAT_ERROR_CODES` 已被 I6b 追加 `'NEEDS_KEY', 'ROLLED_BACK'`（第七处共享文件）。
  → 本单元第 1 条必须覆盖 `beings:model-config-save` / `beings:model-side-by-side` 这两条写通道的 `NEEDS_KEY`。

### 1.5 `docs/migration/i0-seams.md` §A/§B/§E + 真实接缝文件

- `SubsystemContext` 成员：`handle` / `exclusive` / `window()` / `store` / `electron` / `userData` / `desktopId` /
  `clientVersion` / `fetchImpl` / `onError` / `registry` / `push`。可选钩子 `linked()` / `connectionVerified(c)` /
  `connectionCleared()` / `quitting()` / `ready`。**「只有 I0 能改」的清单里含 `main.ts`、`subsystems/types.ts` 的接口成员、
  `renderer/app/models/app.ts`——本单元是这三处的授权例外持有者**（任务书「本单元的例外」）。
- `desktop/preload/channels/index.ts` 是 append-only 的九项对象；`preload.ts` 里 `...desktopChannels` 之后
  `if (process.isMainFrame) contextBridge.exposeInMainWorld('beings', api);` 是整条桥唯一的出口。
- `tests/architecture.test.ts`：shared 层不得 import electron / node 内置；renderer 不得 import main/preload/electron。
  → 主世界解码器必须**零 import**，才能既被 preload 用又能进 vitest。

---

## 2. 实测：contextBridge 到底吃掉什么、什么能过河（2026-09-17，本机 Electron 44.2.0）

夹具在 `…/scratchpad/cb-fixture/`（`main.js` + `preload.js` + `page.html`，第二轮 `main2.js` + `preload2.js` + `helper.js`），
两轮都是独立两文件夹具，不依赖本仓库任何代码。**全部为实测，不是源码推断。**

| 传法 | 页面侧 `Object.getOwnPropertyNames` | `code` | `candidates` | `instanceof Error` |
| --- | --- | --- | --- | --- |
| `throw Object.assign(new Error(m), {code, candidates})`（**今天 preload 的做法**） | `["message","stack"]` | **null** | **null** | true |
| 同步 `throw` 同一个值 | `["message","stack"]` | **null** | — | true |
| `return envelope`（普通对象） | `["__townError","candidates","code","message"]` | `NOT_SENT` | 原样 | — |
| **`throw envelope`（普通对象，此前无人实测）** | `["__townError","candidates","code","message"]` | `NOT_SENT` | **原样** | **false** |
| `throw Object.freeze({...envelope})` | 同上 | `NOT_SENT` | 原样 | false |
| **主世界里用 `executeInMainWorld` 重建的 Error** | `["candidates","code","message","stack"]` | `NOT_SENT` | **原样** | **true** |

→ **IM §4.4 的结论复现无误**：Error 跨 contextBridge 只留 `message` 与 `stack`。

另外三条决定设计的实测：

1. `typeof contextBridge.executeInMainWorld === 'function'`（Electron 44.2.0 有）。
   传进去的 `func` 是**被字符串化后在主世界重新求值的**：引用 preload 模块作用域的常量一律
   `THREW: OUTER is not defined` / `HELPER_CONST is not defined`，**另一个模块里定义的函数可以用，只要它自身自足**。
   → 解码函数必须零外部引用，输入全部走 `args`（普通数据或被代理的 api 对象）。
2. `exposeInMainWorld` 定义的名字在主世界是 `writable:false, configurable:false`：
   `window.probe = x` 静默失败、`Object.defineProperty` 抛 `Cannot redefine property`。
   → **渲染层无法接管 `window.beings` 这个名字**，「渲染层自己包一层」只能覆盖走 `AppModel` 的那一半，
   覆盖不了 `tests/town-sdk.mjs` 里直接 `window.beings.townDesktop.bonfire()` 的调用。
3. 整条安装路径实测跑通：`executeInMainWorld` 里 `Object.defineProperty(window,'beings',{value: walk(raw,1)})` 之后，
   `window.beings.chat.send()` 的拒绝值是 `isError:true / own ["code","message","stack"] / code:'BUSY'`；
   `platform` 这类普通值照抄；`onEvent(cb)` 这类**同步返回退订函数**的方法返回值仍是 `function`；
   主世界拿到的属性描述符同样是 `writable:false, configurable:false`（与 `exposeInMainWorld` 同等）。

**为什么不能只让 preload 抛普通对象（第 4 行）就收工**：`desktop/shared/errors.ts:3` 的 `publicErrorMessage`
第一句是 `String(error instanceof Error ? error.message : error)`，普通对象会被 `String()` 成 `[object Object]`
（长度 15、无换行、不触发任何兜底正则），于是 `errorText(error)` —— 渲染层到处在用（`app/models/app.ts` 六处、
`renderer/channel/models/channel.ts` 等）—— 会把 `[object Object]` 直接显示给用户。**必须是真 Error。**

### 2.1 因此定下的机制

包络以**普通对象**穿过 contextBridge（走拒绝路径，`DesktopAPI` 的 `Promise<T>` 签名一个字不用改），
由 `contextBridge.executeInMainWorld` 在**主世界**装一层解码器，把带 `__townError` 的拒绝值重建成
带 `code` / `candidates` / `detail` 的真 Error。消费者（渲染层 model、E2E 脚本、`errorText`）**一行都不用改**。

---

## 3. 逐条处理

### 3.1 【第 1 条 · 最高优先级】错误码穿过 contextBridge——已修

| 文件 | 改动 |
| --- | --- |
| `desktop/preload/main-world.ts` | **新文件**。`installDecodedBridge(raw, name)`：在页面自己的世界里遍历 api（顶层 + 一层深），把每个函数包一层——**只有拒绝路径**上带 `__townError` 的普通对象被重建成带 `code`/`candidates`/`detail` 的真 Error；同步返回值（`subscribe` 的退订函数）、已解析值（Channel 族的 `ChannelAnswer<T>`）、非包络拒绝、普通值一律原样。每层 `Object.freeze`，`Object.defineProperty` 装到 `globalThis[name]`（描述符与 `exposeInMainWorld` 同为 `writable:false, configurable:false`，实测）。**零 import、完全自足**（`func` 会被字符串化后在主世界重新求值，实测引用模块作用域即 `ReferenceError`）。 |
| `desktop/preload/preload.ts` | `if (process.isMainFrame) contextBridge.exposeInMainWorld('beings', api)` → `if (process.isMainFrame) exposeBridge(api)`；`exposeBridge` 先试 `contextBridge.executeInMainWorld({func: installDecodedBridge, args: [api, 'beings']})`，**失败或该方法不存在**才退回 `rebuildEnvelopesInPreload() + exposeInMainWorld`（0.8.26 的形状：句子还在、码丢失；比给渲染层一个普通对象好——那会显示「[object Object]」）。 |
| `desktop/preload/channels/bridge.ts` | `enveloped` 由 `throw chatErrorFromEnvelope(result)` 改为 `throw chatErrorPayload(result)`（普通对象）；`townEnveloped` 从 `channels/town.ts` 搬进来，同样改为 `throw townErrorPayload(result)`；新增一个只进不出的 `rebuildHere` 开关与 `rebuildEnvelopesInPreload()` / `envelopesAreRebuiltInPreload()`。 |
| `desktop/preload/channels/town.ts` | 删掉本地的 `townEnveloped` 与两个 import，改为从 `./bridge` 引入；文件头改写为实测结论。**24 条通道一行未动。** |
| `desktop/shared/chat-errors.ts` | 新增 `chatErrorPayload(envelope)`（原 `chatErrorFromEnvelope` 的白名单 + 截断，返回普通包络）；`chatErrorFromEnvelope` 改为 `Object.assign(new Error(payload.message), {code})`，**行为逐字不变**，留给退路与测试。 |
| `desktop/shared/town-desktop-errors.ts` | 新增 `townErrorPayload(envelope)`（白名单 + 截断 + 候选人上限 100 / detail 500）；`townErrorFromEnvelope` 基于它重写，行为不变。另见 §3.3（`TASK_LIMIT_REACHED`）。 |

**渲染层改动：零。** `DesktopAPI` 的 `Promise<T>` 签名一个字没改（包络走拒绝路径），
所有 `error.code` / `(error).candidates` 的消费点原样工作。`renderer/channel/**` 也没碰：
I7 的四条通道以数据形式返回包络、由 `renderer/channel/models/channel.ts` 的 `unwrap()` 在渲染层重建——
**与本机制是同一个思路**，而且已经是绿的；解码器只碰拒绝路径，所以 Channel 族完全不受影响（见 openIssues 收敛建议）。

`tests/preload-envelope-bridge.test.ts`（新，10 条）：包络规范化（白名单/截断/候选人上限/`NEEDS_KEY`/`TASK_LIMIT_REACHED`）、
拒绝的包络 → 真 Error、`NOT_SENT` 的候选人与 detail、**非包络一律穿透**（已解析包络/普通拒绝/同步返回/同步抛/普通值）、
桥被冻结、**把解码函数 `toString()` 后用 `new Function` 重新求值再跑一遍**（复刻 Electron 的序列化那一步，
把「必须自足」这条规则变成会红的测试）、**四个通道族各至少一条真路径**
（`beings:chat-send`/`beings:chat-detail-open`/`beings:town-speak`/`beings:town-bonfire`/`beings:model-config-save`/`beings:sbs-set`，
用真的 `desktopChannels` + 真的 bridge 助手 + 真的解码器，只有 `ipcRenderer.invoke` 是夹具）、退路的重建。

### 3.2 【第 2 条】Portal 运行态注入请求帧——已修（定案 §5.2 现在真的成立）

I5 的 openIssue 1 逐字给出的三行，落地时多了一处：**main.ts 构造的不是 `SubsystemContext` 而是
`DesktopExtensionsContext`**（`extensions.ts` 在中间把它翻译成前者），所以要穿四个点而不是三个。

| 文件 | 改动 |
| --- | --- |
| `desktop/main/subsystems/types.ts` | `SubsystemContext` 末尾 append 一个可选成员 `portalState?: () => PortalState | null;`（+ `import type` 里加 `PortalState`）。 |
| `desktop/main/extensions.ts` | `DesktopExtensionsContext` append 同名可选成员（+ `import type` 加 `PortalState`）；`subsystemContext` 构造里一行 `...(ctx.portalState ? { portalState: ctx.portalState } : {}),`。**INSTALLERS 一字未动。** |
| `desktop/main/main.ts` | `installDesktopExtensions({…})` 里 append 一行 `portalState: () => portal.state,`（`portal` 是 `main.ts:66` 的 `let portal: PortalSupervisor`，`state` 是 `portal/supervisor.ts:34` 的字段）。**其它一字未动。** |
| `desktop/main/subsystems/chat.ts` | `getPortalState: () => null` → `getPortalState: () => ctx.portalState?.() ?? null`，上方 13 行的「缺口说明」改写成「已接上 + 为什么按调用时读」。 |
| `desktop/main/chat/environment.ts` | **只改注释**：`getPortalState` 上方与文件头两处「今天读不到」的说明已成谎话，改写为现状 + 指向两个测试。无行为改动。 |

`tests/chat-integration-portal-state.test.ts`（新，3 条）：真 `installSubsystems` + 真 `installChatSubsystem` +
真 `createTrustedHandle` + 真 `beings:chat-send`，只有网络是夹具；
① `connected/managed` 时 wire 帧里的 `runtime.portal` **逐字等于** `portalRuntime(...)` 对应行（断言对着映射表的源，不是它的副本）；
② **按调用时读、不是安装时捕获**：同一个 fixture 连发五条，`not_configured → starting → external → running+conflict → error` 五行逐条命中；
③ 不带 `portalState` 的上下文仍然是 `not_configured / unknown`，且 `configuredName`、`workspace` 仍是 profile 里的真值。

### 3.3 【第 3 条】功能任务账本写满的那句话——已修

- `desktop/shared/town-desktop-errors.ts` 的 `TOWN_ERROR_CODES` 末尾 append `'TASK_LIMIT_REACHED',`（BD `src/main.cjs:127` 有）。
- `desktop/main/features/feature-tasks.ts`：新增常量 `TASK_LIMIT_REACHED = '功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。'`
  （BD `src/main.cjs:740` 逐字），第 121 行的抛出点由英文 `'Too many active feature tasks'` 改用它。
  **结构上偏离 BD、可观察行为与 BD 一致**：BD 在 `handle` 的统一 catch 里换文案，本外壳没有那一层
  （`beings:feature-task*` 四条不包络，`publicErrorMessage` 会原样放行 33 字的英文）。`code` 一字未动，
  两个按 code 分支的调用方（`feature-task-runner.ts:206`、`town/channel/ipc.ts:197`）不受影响。
- `tests/features-feature-tasks.test.ts` +1 条：账本满 → `code` 是 `TASK_LIMIT_REACHED`、`message` 是 BD 原话、
  `publicErrorMessage` 原样放行（普通通道那一半）、`townErrorEnvelope` 不再降级成「Town 操作未完成，请稍后重试。」（包络通道那一半）。
- **`main/town/channel/ipc.ts` 的 `TASK_LIMIT` 常量没有删**：任务书写的位置是 `features/ipc.ts`，
  实际在 `desktop/main/town/channel/ipc.ts:117`——**IT 的独占目录**。删它只是去冗余（两条路径现在给出同一个字符串），
  没有行为差异，留给合并者，见 openIssues。

### 3.4 【第 4 条】功能任务页的「模型」目的地——已接，但不是一行 TASK_VIEWS

任务书假设加一行 `TASK_VIEWS` 即可。**实读之后不成立**：`TASK_VIEWS` 的值进的是 `AppModel.navigate(view)`
（`renderer/app/models/app.ts:231`，设 `this.view`），而 I6b 的模型页不是 place，是**外壳对话框**——
`ShellStateModel.open("models")`（`renderer/settings/models/shell-state.ts:128`，`ShellPage = "" | "about" | "privacy" | "models"`），
侧栏页脚的「模型」按钮走的就是这条（`renderer/settings/components/entry.tsx:37`）。
写成 `TASK_VIEWS.model = 'models'` 会把 `app.view` 设成一个谁都不画的值。

于是 `desktop/renderer/channel/models/channel.ts` 加了一张并列的表：
`const TASK_SHELL_PAGES: Record<string, "models"> = { model: "models" };`，
`ChannelHost.features` 加一个可选成员 `shellState?: { open(page: "models"): void }`（与既有的 `featureTasks?` 同规格：
model 没建起来就 toast），`openFeature` 先查 `TASK_SHELL_PAGES` 再查 `TASK_VIEWS`。
`workspace` **不进表**：本外壳根本没有工作区页，保持 toast。
`tests/channel-integration-renderer.test.ts` 那条既有用例里，`model` 的断言改成「打开 models 对话框且没有 navigate」，
并**补一条** `workspace` 仍然 toast——规则数 +1，没有删。

### 3.5 【第 5 条】退出瞬间的 `beings:snapshot` ——已改，且把它降到「最多一次、不弹 toast」

**先把成因查实**（读代码，不是猜）：`main.ts:631` 的 `before-quit` 先 `quitting = true`，
**然后**才 `extensions.quitting()` / `portal.stop()`；`portal.stop()` 的每次状态变化都走
`main.ts:498` `window.webContents.send('beings:portal-state', state)`——**页面这时还活着**。
渲染层 `app/models/app.ts` 的 `onPortal` 收到推送后无条件 `this.api.snapshot()`，
而 `beings:snapshot` 不在 `QUIT_ALLOWED` 上，于是被 `createTrustedHandle` 拒掉：
终端一行 `Error occurred in handler`，**并且 `this.run(...)` 会把「客户端正在退出，请稍候。」弹成 toast**
——IM 的 openIssue 7 只记了前半句，后半句是本单元读代码时发现的。

改动：

| 文件 | 改动 |
| --- | --- |
| `desktop/shared/errors.ts` | 新增 `QUITTING_MESSAGE`（原来是 `app/ipc.ts` 里的字面量）与 `isQuittingRefusal(error)`（认 Electron 的 `Error invoking remote method '…': Error: ` 前缀）。放 shared 是因为渲染层不能 import 主进程代码（`tests/architecture.test.ts`），而两边必须认同一句话。 |
| `desktop/main/app/ipc.ts` | 字面量换成 `QUITTING_MESSAGE`，**行为一字不变**。 |
| `desktop/renderer/app/models/app.ts` | `AppModel` 加私有 `quitting = false`；`onPortal` 里 `if (!active || this.quitting) return;` **在发起 invoke 之前**（原来只在 await 之后查 `active`）；读被拒且 `isQuittingRefusal` 为真时**吞掉并置位**，不再 toast、不再追。推送本身照旧合并进 `snapshot.portal`，所以还在屏幕上的面板不会显示过期相位。 |

`tests/app-quit-snapshot.test.ts`（新，4 条）：正常运行时推送照旧触发一次读；
**退出期第一次被拒之后不再读**（后续两次推送零 invoke）、不弹 toast、但推送仍被应用；
**非退出的失败照旧 toast 且不停追**；拆卸后即使有人握着旧回调也不会发起 invoke。

**剩下的一行没有清零**：`before-quit` 的第一次推送仍会换来一次被拒的 `beings:snapshot`（一行日志，不再有 toast）。
要清零必须让主进程在 `quitting` 时不推（`main.ts:498` 加 `&& !quitting`）——**本单元没有做**，两个理由：
(a) 任务书给本单元的 `main.ts` 授权是「只加 portalState 注入一行」；
(b) 退出可以失败（`main.ts:642` 把 `quitting` 置回 false 并重新显示窗口），那时被跳过的推送没有补发点，
面板会停在过期相位——要做得连补发一起做。写进 openIssues。

### 3.6 【第 6 条】假钥匙串改成 E2E 的默认——已改

`tests/support/electron-lifecycle.mjs` 的 `launchDesktop`：
`PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN === '1'` → **`!== '0'`**。也就是 macOS 上默认加 `--use-mock-keychain`，
`PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN=0` 才是真钥匙串（并且会打印 `Keychain coverage: REAL`，因为那条路径可能卡在系统对话框上）。

理由写进了文件注释：ad-hoc 重签之后第一次启动，系统会弹一个「新二进制能否读取旧二进制写的钥匙串条目」的模态框，
测试没人能回答，于是 `electron.launch: Timeout 180000ms exceeded`（IM §4.2 / openIssue 3）。
`tools-e2e` / `browser-e2e` / `terminal-e2e` 从来没设过这个变量，所以每次重签后的第一跑必挂，
而这三个脚本（以及 tests/ 下任何一个）**都不断言钥匙串的任何行为**。
已经显式设 `='1'` 的四个脚本（`electron-smoke` / `town-ui` / `town-sdk` / `model-settings-bound-e2e`）行为不变。

### 3.7 【第 7 条】两套连接纪元——**没做，按任务书「做不到就写设计、不要半做」**

读完两边的真实代码，任务书设想的「types.ts + chat.ts 一处 + town.ts 一处」不成立：

- `subsystems/chat.ts` 的 `revision`（`:66`）：`connectionVerified` 里 `!next` **直接 return 不动**；
  `current.open && key === identityKey` 也 return；其余 `++`。读它的只有 `context()` / `connection()` 两处。
- `subsystems/town.ts` 的 `revision`（`:89`）：`!next` **要 `++`**（并且同时 reset pairing/client/session、置 `connected=false`）；
  `switched` 才 `++`；同 Being 重验不动。它还有**第二根轴** `identityRevision`（Being 自己的档案变了，连接没变），
  两者成对出现在 `state()`、`getContext`、`getIdentity`、`getRevisions`、`revisions()` 五处读取点与三处 `++`。
- 因此收敛不是「改读取纪元的那一行」：Town 要放弃对 `revision` 的所有权（删 3 处 `++`、把 5 处读取改成
  `ctx.connectionGeneration()`），而新的所有者（注册表）必须自己算 `beingIdentityKey(next)` 才知道该不该推进
  ——那等于把身份键搬进接缝，是 I0 级的契约变更，且会**改变 Town 在 `!next` 时的行为**。
- 还有一层风险：`connectionRevision` 是**协议值**，会回显给渲染层并原样回到 `beings:town-speak` /
  `beings:chat-composer-data`（I5 的 `tests/chat-integration-composer.test.ts` 钉住了这条握手）。换铸造者要连它一起重验。

**结论**：不在本单元做。不变量仍由 I5 的 `tests/chat-integration-composer.test.ts` 钉着
（生产可达路径上两者恒等，理由是 `main.ts:335/449` 两处调用都在 `verifyBeingConnection` 之后，
而 `chat/ready.ts:6` 第一行就拒绝空连接，`!next` 那一支到不了）。设计与代价写进 openIssues。

---

## 4. 真机冒烟（打包产物，2026-09-17）

打包：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy PORTAL_DESKTOP_MAC_LOCAL_TEST=1 npx electron-forge package` → 退出码 0；
随后 `codesign --force --deep --sign - "out/Being Desktop-darwin-arm64/Being Desktop.app"`。

### 4.1 先验一件只能在打包产物上验的事：解码函数在 minify 之后仍然自足

`executeInMainWorld` 的 `func` 是被**字符串化后在主世界重新求值**的，所以打包器只要留下一个外部引用就会在真机上炸，
而且没有任何编译期告警。从 `.vite/build/preload.js` 里按 `func:<名>` 找到压缩后的函数体（685 字节）逐个标识符核对：

```
function Q(e,i){const r=g=>{…},d=g=>(...a)=>{…},k=(g,a)=>{…};
  return Object.defineProperty(globalThis,i,{value:k(e,1),enumerable:!0}),i}
```

`e`/`i` 是形参，`r`/`d`/`k`/`g`/`a`/`s`/`p`/`l` 全部在函数内声明——**零外部引用**，
压缩只把局部名改短了。vitest 里那条「`toString()` 后 `new Function` 重新求值再跑」的用例守的是源码形态，这一步守的是产物形态。

### 4.2 `tests/town-sdk.mjs`：**13 过 4 红 → 17 全过**

IM 留的四条 `pending`（读 `error.code` 的）全部转绿，退出码 0：

| check | 之前 | 现在 |
| --- | --- | --- |
| `an unpaired read rejects with AUTH_REQUIRED rather than a sentence` | 红（`code` 是 null） | **passed** |
| `…and says so as INVALID_REQUEST` | 红 | **passed** |
| `…and says so as SESSION_CHANGED` | 红 | **passed** |
| `…as AUTH_REQUIRED`（forget 之后） | 红 | **passed** |

其余 13 条原样通过，含 `the renderer raised no errors`。**脚本一字未改。**

### 4.3 `tests/town-ui.mjs`：**13 过 2 红 → 14 过 1 红**（剩下的那条是 IT 的）

- **`an ambiguous recipient offers the choices Town returned`：红 → passed**。
  这正是 IM openIssue 1 的第二个后果：`TownModel.send()` 读 `(error).candidates`（`renderer/town/models/town.ts:1147`），
  以前页面收到的 Error 自有属性只有 `["stack","message"]`，`#town-send-candidates` 永远是空的；现在两个候选人都列出来了。
- **仍然红的一条**：`messages render while the member directory is still pending`
  ——`desktop/main/town/session/session.ts` 的 `getBonfireMessages` 把 `/api/bonfire/hear` 与 `getMembers()` 放在同一个
  `Promise.all` 里（IM openIssue 10 / 复审 finding 2）。**属 IT 的独占目录，本单元按分工保持红。**
- 脚本一字未改。
