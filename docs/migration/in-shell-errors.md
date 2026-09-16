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
