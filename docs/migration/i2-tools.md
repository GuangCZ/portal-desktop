# I2 · 工具桥 + 控制台（集成单元）

来源：portal-desktop 壳层 + BeingDesktop `src/main.cjs` / `renderer/desktop-tools.js`。日期：2026-09-16。
基线：`next` @ 9794cab，分支 `i2-tools`。

## 阅读摘要

### integration-plan.md（§3 统一约定 / §3.2 / §2.1 / §2.4 / §2.5 / §2.6 / §4 / §6.2 / §6.3 / 附录）

- 独占目录：`desktop/main/subsystems/tools.ts`、`desktop/main/tools/ipc.ts`、`desktop/renderer/tools/`、
  `desktop/preload/channels/tools.ts`、`desktop/shared/tools-types.ts`、`tests/tools-integration-*`。
- 共享文件只允许 append 一行（import + 数组/对象项）：`desktop/main/extensions.ts` 的 `INSTALLERS`、
  `desktop/preload/channels/index.ts`、`desktop/shared/desktop-types.ts` 的 re-export、
  `desktop/shared/types.ts` 的 `DesktopAPI`（加在 `chat: ChatAPI;` 之后按字母序）、
  `desktop/renderer/app/slots.tsx` 的数组、`desktop/renderer/app/models/registry.ts`。
- 不得修改：`desktop/main/main.ts`、`package.json`、`package-lock.json`、`forge.config.ts`、`vite.*.config.ts`、
  `tsconfig*`、`vitest.config.ts`、`subsystems/types.ts`、`subsystems/chat.ts`。
- IPC：`being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  Town 包络用 `chat-errors.ts` 的 `chatErrorEnvelope` 返回而不是抛。
- §3.2 装配对照 `src/main.cjs:1696-1709`；`getConnection` 必须是 `parseConnection(ctx.store.connectionAddress)`
  （BD 形状 `LoomConnection`），不能直接传 portal-desktop 的 `Connection`。
- §3.2 IPC 清单：`beings:tools` / `beings:tools-action` / `beings:tools-browser-view` / `beings:clipboard-read`
  （+ 既有 `beings:clipboard-copy`）+ 推送 `beings:tools-state`。
- §3.2 要收敛的副本：删 `tools/platform.ts`、`tools/security.ts`、`tools/message-context.ts`；
  `tools/console.ts` 的 `consoleEnvironment`/`WINDOWS_RUNNER` 改 import `common/platform`。
  `tools/browser-links.ts` 与 `browser/url.ts` 的地址解析**保留两份**（语义不同），两处文件头互相引用。
- §3.2 类型收敛：`desktop-tools.ts` 的 `DesktopBrowserOptions` 改为 `import type { ElectronBrowserHost }`；
  `DesktopBrowserLike.newTab` 返回改 `BrowserSnapshot`；IPC 层直接用 `DesktopTerminal` 真类而非窄接口 `DesktopTerminalLike`。
- §2.1 registry：install 同步体内只能构造自己的实例 + 存惰性 getter，不得 `ctx.registry.get(...)` 取值。
- §2.4 插槽：`PANEL_SLOTS` 一项（工具面板）；`FEATURE_MODELS` 一项。
- §6.2/6.3 验收：`tests/tools-e2e.mjs`（打包客户端 + 本地假 relay，握手 → initialize → tools/list →
  tools/call desktop_browser_open 进待确认 → 允许 → 标签出现）——`ws` 提级的唯一有效验证。

## 进度

- [x] 读方案

### docs/migration/i0-seams.md + subsystems/{types,extensions}.ts + 四个 append-only 文件

- **I0 已经一次收敛完副本**（偏离方案 §2.5 的分步走）：`tools/platform.ts`、`tools/message-context.ts`、
  `tools/terminal/platform.ts`、`chat/context.ts`、`orchestration/vendored.ts` 等**已经删掉**，
  `tools/console.ts` 的 `consoleEnvironment`/`WINDOWS_RUNNER` **已经改指 `common/platform`**。
  `tools/security.ts` 只剩 `protocolFile`。→ **§3.2 的「要收敛的副本」这一步在 I2 里已无事可做**，只需核实。
- `linked?(): void` 钩子已存在（I0 复审第二轮补的），在全部 installer 跑完后按安装顺序同步跑一趟，
  错误报 `${key}-linked`。I0 明确点名给 I2 用来赋 `orchestration.presentation`。
- `FeatureModel = Store & { start?(): () => void }`，`start()` 必须返回 cleanup，由 `AppModel.start()` 接管。
- `ctx.push` 自带窗口守卫（destroyed 判断在里面），子系统不必自己判断。
- `ctx.electron.clipboard` 是 **Promise 形态**（`readText(): Promise<string>`），Electron 44 实测。
- `ctx.store` 是 `SubsystemSettings`：`connection` / `connectionAddress` / `settings: Settings` /
  `extras` / `saveExtra(patch)`（不是方案写的交叉类型）。
- `ElectronBindings.WebContentsView` / `session` / `net.request` 是 `unknown`，使用处 `as` 一次并写明理由。
- `PANEL_SLOTS` 排序：`order` 升序、`key` 兜底；建议 order 取百位。`visiblePanels(app)` 已由 page.tsx 调用。

### docs/migration/u4-tools.md + desktop/main/tools/desktop-tools.ts

- `DesktopTools` 构造面与 §3.2 一致；`Browser` 与 `desktopPortalName` 必填，`Console`/`ToolLink` 有默认值。
- `snapshot()` = `{browser, console（jobs 补 origin）, link, workspace, requestResult, requests}`。
- `perform(action, value)` 的 15 个动作：`browser.new/activate/close/navigate/back/forward/reload/stop`、
  `console.run/stop/clear`、`link.connect`（无连接 → `请先连接 Being。`）、`link.disconnect`、
  `request.allow`、`request.deny`；未知 → `未知桌面工具操作。`；disposed → `桌面工具已关闭。`。
- `changed()` 用 `setImmediate` 合并一次 `onChange`。
- `link` 的 `toolAllowed` 已经守住 `desktop_terminal_*`：编排模式关时要求 `Boolean(getTerminal())` 且
  `['win32','darwin'].includes(process.platform)`。→ **`getTerminal` 返回 null 时终端工具自然不进目录**，
  I2 不需要额外过滤。
- `ws` 的 PACKAGING CONTRACT：默认传输是 `createRequire(import.meta.url)('ws')`；
  「静态 import 让 Vite 内联 ws」实测第一帧崩（`bufferUtil.mask is not a function`），不要再试。
  I0 已把 `ws` 提到 dependencies 并写了 `packagerConfig.ignore`。**唯一有效验证是打包后冒烟。**
- `tests/tools-portal-loopback.ts`（非 `.test.ts`）已有 `LoopbackRelay` / `frame` / `until`，
  是 I2 的 e2e 假 relay 的现成底座。

### tools/{types,browser-links,network,security}.ts + browser/{browser,host,types}.ts + common/loom-connection.ts

- `DesktopBrowser` 的真实构造是 `DesktopBrowserOptions`（`browser/types.ts`）：`WebContentsView: BrowserViewConstructor`、
  `session: BrowserSessionFactory`、`getWindow: () => BrowserHostWindow | null | undefined`、`onChange?`。
  **不是** `desktop-tools.ts` 里声明的三个 `unknown`。→ §3.2 的类型收敛要做。
- `DesktopBrowser.newTab()` 返回的是 `BrowserSnapshot`（不是 `NewTabResult`），`activateTab/closeTab/navigate/
  goBack/goForward/reload/stop/setViewport` 同样返回 `BrowserSnapshot`。
- **`setViewport(options)` 的入参是 `{visible: boolean, bounds: {x,y,width,height}}`**，
  不是 interfaces.md §1.2 写的 `{x,y,width,height}`。BD renderer `desktop-tools.js` 的 `layout()` 实测传
  `{visible, bounds}`。→ 记为文档偏差，IPC 按真实形状。
- `DesktopBrowser` 分区 `persist:being-desktop-browser-v1`（§5.6 要求的独立分区，已满足）。
- `normalizeBrowserUrl` 从 `tools/browser/browser.ts` 导出（给 `createBrowserLinks` / `WorkerPresentation` 注入）。
- `ToolLinkCapabilities = {status, place, hostname, platform, tools}`（I4/I5 要用）。
- `parseConnection(input: unknown)` 接受**地址字符串**，产出 `{url, apiBase, token, secret, displayUrl, beingName}`。
  `secret` 取 `relay_secret` → `secret` → `token`。`DesktopToolLink.connect(connection)` 要的正是这个形状。
- `tools/security.ts` 现在只剩 `protocolFile`（I0 已收敛），**本单元不删**（`tests/tools-security.test.ts` 在测它）。

### BeingDesktop src/main.cjs（boot 装配 1696-1709、IPC 1104/1117/1135-1137、browserLinks 599-608）+ renderer/desktop-tools.js

- 装配：`getConnection:()=>connection`（BD 的 `connection` 就是 `parseConnection` 的产物，见下）、
  `getWorkspace:()=>state.workspace.path`、`showTerminal` 会先 `activate` 再推 `being:terminal-state` 再让渲染层 reveal。
- `onChange`：`void orchestrationPolicy.syncBridge()` → 推 `being:tools-state` → 若有 worker 带 presentation 则 `orchestration.notify()`。
- `browserLinks(isCurrent)`：`showBrowser` 先推一次 `being:tools-state` 再 `sendShellCommand('open-browser')`；
  `isCurrent` = `!exitStarted && win 活着 && desktopTools 存在 && isCurrent()`；`onError` 进 activity 日志。
- IPC：`readNativeText` = `clipboard.readText().slice(0,65536)`；`copyDesktopText` 校验 `typeof value==='string' && length<=1MB`
  否则 `复制内容无效。`；`desktopAction` 先判 `exitStarted` → `桌面端正在退出。`；`setBrowserView` 直接转 `browser.setViewport`。
- renderer 规则（`renderer/desktop-tools.js` 126 行）：
  - 两个模式 `browser` / `console`；`show(mode)` 打开面板，`hide()` 关闭；`tools-full` 展开；分栏可拖拽（380..total-285）。
  - `show('browser')` 且没有标签时自动 `browser.new`。
  - link 文案：`connected` → `Being 工具已连接`；`connecting` → `正在连接 Being…`；`error` → `Being 工具连接失败`；
    `disconnected` → `Being 工具未连接`。按钮 `断开` / `连接 Being 工具`。
  - hint 优先级：`link.reconnect` → `调度工具已断线，${Math.ceil(delayMs/1000)} 秒后自动重连。`；否则 `link.error`；
    否则按 connected/活动命令数分四句。
  - `requestResult` 变化且 `status==='failed'` → 顶出错误条 `上一次 Being 调用：<message>`。
  - 待确认卡片：标题 `Being 请求：<中文工具名>`；`desktop_console_run` 的 summary 是
    `新建独立命令会话 · 非交互命令\n<cwd|未选择目录>\n\n<command>`；`console_status/stop` 列 `reviewJobs`；
    其余是 `target\n[targetSummary\n]JSON.stringify(args,null,2)`。两个按钮 `拒绝` / `允许本次`（running 时 `正在执行…`），
    非 pending 时 disabled。
  - `layout()` 用 rAF 合并，payload `{visible, bounds}`，visible 要求：面板开着 + browser 模式 + 未拖拽 +
    文档可见 + 无搜索对话框 + 当前标签有 url 且无 error；同 payload 不重发。
  - 错误文案脱敏：`String(error?.message).replace(/^Error invoking remote method '[^']+': Error: /,'')`。

### 壳层：subsystems/chat.ts、chat/ipc.ts、preload/channels/{bridge,chat}.ts、renderer/{app/page.tsx,app/models/app.ts,browser/page.tsx}

- 子系统模板：`install<Key>Subsystem(ctx)` 里 `report` 包 `ctx.onError`；构造自己的实例；
  `register<Key>Ipc({handle: ctx.handle, exclusive: ctx.exclusive, ...})`；返回 `{key, ...钩子}`。
- IPC 模板（`chat/ipc.ts`）：`plain()` 判原型、`fields(value, allowed, what)` 白名单、`invalid()` 带 `code:'INVALID_REQUEST'`；
  `enveloped(channel, cb)` 包 `chatErrorEnvelope`；push 函数单独导出 `chatPush(target)`。
- preload：`subscribe<T>(channel, cb)` / `enveloped<T>(channel, ...args)` 来自 `channels/bridge.ts`。
- 渲染层 `Store` 只有 `subscribe/getVersion/changed`；`FeatureModel` 可加 `start(): () => void`。
- `AppModel` 有 `api`、`toast(error)`、`run(op)`、`navigate`、`startup`、`snapshot`、`view`、`features`。
- **壳层 `Browser`（ClientBrowser 面板）已经占了 `browser-address` / `browser-back` / `browser-forward` /
  `browser-reload` / `browser-panel` / `browser-divider` 这些 DOM id**。工具面板必须用 `tools-` 前缀，
  不能照抄 BD 的 id。
- `tests/architecture.test.ts` 八条：renderer 不得出现 `fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest`/
  `sendBeacon` 标识符；`models/` 不得 import components/hooks/react；`main/common/` 只能 import node 内建；
  `main/subsystems/` 不得 import electron。
- 渲染层代码风格是 Prettier（双引号、2 空格、尾逗号）；主进程/测试是单引号。**跟随所在目录**。

### 类型对齐实测（2026-09-16，tsc 探针，不是推断）

用一个临时 `probe-i2.ts` 把四条真实赋值喂给 `tsc --noEmit`，**四条全红**：

1. `typeof DesktopBrowser` → `DesktopBrowserConstructor`：`desktop-tools.ts` 的 `DesktopBrowserOptions.WebContentsView`
   是 `unknown`，构造参数逆变，不能赋给 `browser/types.ts` 的 `BrowserViewConstructor`。
2. `DesktopBrowser` → `DesktopBrowserLike`：`BrowserTabState`（interface，无隐式索引签名）不能赋给
   `tools/types.ts` 的 `BrowserTab`（要求 `[key: string]: unknown`）。
3. `DesktopTerminal` → `DesktopTerminalLike`：同样的索引签名问题（`TerminalSessionState` → `TerminalSession`）。
4. `WorkerPresentation` → `WorkerPresenter`（`orchestration/types.ts`）：四处不符——
   `open` 的 `worker` 参数（`WorkerRecord.presentation?: WorkerPresentationValue` 缺 `openedAt`，
   不能逆变赋给 `PresentationWorker.presentation?: PresentationValue|null`）、
   `open` 返回 `Promise<PresentationValue|null>` 的 `null`、
   `describe` 的参数同样缺字段、`describe` 返回 `null` 而契约写的是 `undefined`。

处理：1/2/3 在本单元收敛（§3.2 明确授权动 `desktop-tools.ts`；`tools/types.ts` 的索引签名去掉）。
4 **不动 `orchestration/`**（I4 的邻域，避免五路并行合并时的非 append 冲突）：
`subsystems/tools.ts` 用本地结构化 peer 类型做赋值，运行期与 BD 一致
（`orchestration.ts` 两处都写成 `this.presentation?.describe(x) || x`，null 与 undefined 同样落到 `||` 右边）。
建议的正式修法写进 openIssues：把 `WorkerPresenter.describe` 的返回放宽成 `| null | undefined`、
`open` 放宽成 `Promise<WorkerPresentationValue | null>`、`PresentationWorker.presentation` 放宽成
`Record<string, unknown> | null`。

## 基线

`next` @ 9794cab：`npm run typecheck` 通过；`npx vitest run` **1071 通过 / 58 跳过**（96 文件通过 / 8 跳过）。

## 进度

- [x] 类型收敛（`tools/types.ts` 的索引签名、`DesktopBrowserOptions`、`DesktopBrowserLike.newTab`、
  `DesktopTerminalLike.write/readSince`）——typecheck + vitest 数字不变。

---

## 产出

### 独占新文件

| 文件 | 内容 |
| --- | --- |
| `desktop/shared/tools-types.ts` | 渲染层契约：`DesktopToolsState` / `DesktopToolsAction` / `DesktopToolsViewport` / `DesktopToolsAPI` + `IDLE_TOOLS_STATE` |
| `desktop/main/tools/ipc.ts` | `registerToolsIpc(options)` + `toolsPush(target)`（四条通道 + 两条推送） |
| `desktop/main/subsystems/tools.ts` | `installToolsSubsystem(ctx)` —— 装配点 |
| `desktop/preload/channels/tools.ts` | `export const tools: DesktopToolsAPI` |
| `desktop/renderer/tools/models/tools.ts` | `ToolsModel`（面板状态与全部 BD 规则） |
| `desktop/renderer/tools/components/{panel,browser-bar,console,requests,link-status}.tsx` | 面板 |
| `desktop/renderer/tools/slot.tsx` | `toolsModel` / `toolsPanel` / `toolsAction` |
| `desktop/renderer/tools/styles.css` | 面板样式（BD `desktop-tools.css` 的布局 + 本壳层的变量） |
| `tests/tools-integration-connection.test.ts` | 8 条：`Connection → LoomConnection` 转换与握手帧 |
| `tests/tools-integration-ipc.test.ts` | 23 条：通道校验、待确认队列、子系统接线 |
| `tests/tools-integration-model.test.ts` | 16 条：面板模型的 BD 规则 |
| `tests/tools-e2e.mjs` | 打包客户端 + 本地假 relay 的冒烟 |

### IPC 通道清单

| BD | 新名 | 方向 | payload / 返回 |
| --- | --- | --- | --- |
| `getDesktopTools` | `beings:tools` | invoke | — → `DesktopToolsState`（无桥时返回 `IDLE_TOOLS_STATE`，不抛） |
| `desktopAction(action, value)` | `beings:tools-action` | invoke | `(action: 15 个白名单动词, value)` → `DesktopToolsState` |
| `setBrowserView(bounds)` | `beings:tools-browser-view` | invoke | `{visible: boolean, bounds?: {x,y,width,height}}` → `DesktopToolsBrowserState` |
| `readNativeText` | `beings:clipboard-read` | invoke | — → `string`（≤65536） |
| 推送 `being:tools-state` | `beings:tools-state` | push | `DesktopTools.snapshot()` |
| （BD 用 `executeJavaScript`） | `beings:tools-reveal` | push | `'browser' \| 'console'` |

`copyDesktopText` 对应的 `beings:clipboard-copy` 壳层已有（`main.ts:223`），本单元不重复注册。
四条 invoke 通道都**不进 `exclusive`**（BD 的 §1.2 未标「串行」），都**不用包络**（不在 `townMethods` 里）。

### 装配点（对照 `src/main.cjs:1696-1709`、`599-608`、`710`）

| BD | 本单元 |
| --- | --- |
| `getConnection:()=>connection` | `parseConnection(ctx.store.connectionAddress)`，失败返回 `null` 并报 `tools-connection` |
| `getWorkspace:()=>state.workspace.path` | `ctx.store.settings.projectWorkspace \|\| ctx.store.settings.workspace \|\| ''` |
| `orchestration`（boot 作用域里的实例） | **惰性门面**（见下「决定与偏差」第 1 条） |
| `getTerminal/showTerminal` | `ctx.registry.get('terminal')`（结构化 cast），缺席即 `null` |
| `WebContentsView/session/getWindow` | `ctx.electron.*`，使用处各 cast 一次（I0 规定的写法） |
| `onChange` | `policy.syncBridge()` → `push('beings:tools-state')` → 有 presentation 的 worker 则 `orchestration.notify()` |
| `orchestration.presentation = new WorkerPresentation(...)` | `linked()` 钩子里赋值 |
| `createBrowserLinks({...})` | 子系统导出 `links`；`showBrowser` 推 state + `reveal('browser')` |
| `portalRequestAdapter(net.request.bind(net))` | 子系统导出 `portalRequest` |
| `sessionPartition 变化才 disconnectLink + terminalTools.reset()` | `connectionVerified` 里按 `sessionPartition(parseConnection(address))` 比对 |

### 共享文件触碰行（逐行）

| 文件 | 增加的行 |
| --- | --- |
| `desktop/main/extensions.ts` | `import { installToolsSubsystem } from './subsystems/tools';` |
| `desktop/main/extensions.ts` | `INSTALLERS` 数组内 `  installToolsSubsystem,` |
| `desktop/preload/channels/index.ts` | `import { tools } from './tools';` |
| `desktop/preload/channels/index.ts` | `desktopChannels` 内 `  tools,` |
| `desktop/shared/desktop-types.ts` | `export * from './tools-types';` |
| `desktop/shared/types.ts` | `import type { DesktopToolsAPI } from './desktop-types';` |
| `desktop/shared/types.ts` | `DesktopAPI` 内 `  tools: DesktopToolsAPI;`（在 `chat: ChatAPI;` 之后） |
| `desktop/renderer/app/slots.tsx` | `import { toolsAction, toolsPanel } from "../tools/slot";` |
| `desktop/renderer/app/slots.tsx` | `PANEL_SLOTS` 内 `  toolsPanel,` |
| `desktop/renderer/app/slots.tsx` | `TOPBAR_SLOTS` 内 `  toolsAction,` |
| `desktop/renderer/app/models/registry.ts` | `import { toolsModel } from "../../tools/slot";` |
| `desktop/renderer/app/models/registry.ts` | `FEATURE_MODELS` 内 `  toolsModel,` |
| `MIGRATION.md` | 表格一行 |

**非 append 的共享改动**（两处，都在既有测试里，理由见下）：
`tests/chat-ipc.test.ts` 改为 `installSubsystems(ctx, [installChatSubsystem])`；
`tests/renderer-slots.test.ts` 的两条「ships empty」断言改为「registers exactly this build's surfaces」。

### 本单元改动的既有模块（类型对齐，§3.2 授权）

- `desktop/main/tools/types.ts`：去掉 `BrowserTab`/`BrowserSnapshot`/`NewTabResult`/`TerminalSession`/`TerminalSnapshot`
  的 `[key: string]: unknown`（真类是 interface，没有隐式索引签名，带索引签名就赋不进来）；
  `TerminalSession` 补齐真实字段；`DesktopTerminalLike.write/readSince` 返回改 `object`；
  `DesktopBrowserLike` 的三个 snapshot 方法改用真实的 `LiveBrowserSnapshot`；新增 `setViewport`。
- `desktop/main/tools/desktop-tools.ts`：`DesktopBrowserOptions` 改成 `ElectronBrowserHost & {onChange}`，
  构造处 cast 一次；`DesktopToolsSnapshot.browser` 改真实快照类型。
  结果：`DesktopToolsSnapshot` **无需 cast**即可赋给 `DesktopToolsState`（探针验证）。

### §3.2「要收敛的副本」的现状

I0 已经一次收敛完（见上「阅读摘要」）：`tools/platform.ts`、`tools/message-context.ts` 已删除，
`tools/console.ts` 已改 import `common/platform`。本单元核实无遗留，**无事可做**。
`tools/security.ts` 只剩 `protocolFile`，保留（`tests/tools-security.test.ts` 在测）。
`tools/browser-links.ts` 与 `browser/url.ts` 按方案**保留两份**，两处文件头已有互相引用的说明（u4/u5 写的），本单元未改。

---

## 决定与偏差

1. **`orchestration` 用惰性门面，不是惰性 getter**（方案 §3.2 写的是 `lazyOrchestration()`，语义未定）。
   实测原因：`DesktopTools` 的 `shouldReconnect` 与 `toolAllowed` 闭包捕获的是**构造参数** `orchestration`，
   不是 `this.orchestration`。事后给 `tools.orchestration` 赋值只能修好 `request()`/`invoke()`，
   这两个谓词会永远看着构造时的值。所以注入一个 `get mode()` / `get configuring()` / `tool()` 都转发的门面。
   无编排子系统时 `mode.enabled === false`，与 BD 未开编排时一致。
2. **`WorkerPresenter` 与 `WorkerPresentation` 类型不符，本单元不动 `orchestration/`。**
   四处不符已实测（见上）。`subsystems/tools.ts` 用本地结构化 peer 类型完成赋值，运行期与 BD 一致。
   正式修法列进 openIssues。
3. **新增一条推送通道 `beings:tools-reveal`。** BD 的 `showBrowser` / `showTerminal` 用
   `win.webContents.executeJavaScript('window.beingTools.show(...)')` 让渲染层开面板；本壳层没有这条回路。
   改成主进程推一个 `'browser' | 'console'`，模型收到就开面板 —— 行为等价，方向相反。
4. **`slots.tsx` 多 append 一行 `TOPBAR_SLOTS`**（方案 §3.2 只写了 PANEL 一项）。
   面板的 `visible` 是「打开时」，没有入口就永远打不开；BD 的入口（`#open-browser` / `#open-console`）
   本来就在工具栏而不在面板里。合成一个 `#open-tools` 按钮，带待确认计数徽标。
5. **控制台面板渲染自己的 job 列表。** BD 的 `tools-console-pane` 里是 `#terminal-host`，
   job 列表由 `window.beingTerminal.updateJobs()` 画。终端属于 I3，不在本 worktree，
   所以本单元自带一个 job 列表（命令 / cwd / 状态 / 来源 / 输出尾部 / 停止 / 清除）。
   I3 的终端落地后并入同一个 pane，job 列表保留。
6. **DOM id 全部加 `tools-` 前缀。** 壳层的 `ClientBrowser` 面板已经占了 `browser-address`、`browser-back`、
   `browser-forward`、`browser-reload`、`browser-panel`、`browser-divider`。
7. **`setBrowserView` 的真实入参是 `{visible, bounds}`**，不是 `docs/interfaces.md` §1.2 写的 `{x,y,width,height}`
   （BD renderer `layout()` 实测）。IPC 按真实形状。
8. **`beings:tools-browser-view` 不在 `QUIT_ALLOWED` 里**，退出中会被 `handle` 拒绝
   （壳层浏览器的 `beings:browser-bounds` 在里面）。BD 的 `setBrowserView` 本来没有退出守卫。
   面板的 layout 调用自己吞错误，影响仅限退出瞬间的一次无效调用。未改 `app/ipc.ts`（共享文件）。
9. **`connectionVerified` 按身份变化才断链**（`src/main.cjs:710` 的 `sessionPartition` 比对），
   并同时 `terminalTools.reset()`。本壳层的 `verifyConnection()` 还会被 `beings:portal-start`、
   `beings:save`、takeover preflight 调用，不加这个守卫会在用户每次启动 Portal 时掐断在用的工具桥。
10. **`tests/chat-ipc.test.ts` 改注册面。** 原来用 `installDesktopExtensions`（跑整个 `INSTALLERS`），
    它的两条精确断言（通道全集、错误 scope 全集）会随每个落地的子系统增长，而这两条断言的主题
    都是对话层自己。改成 `installSubsystems(ctx, [installChatSubsystem])`——`extensions.ts` 正是为此导出它。
    断言一条没删、没放宽，且后续单元不必再碰这个文件。
11. **`tests/renderer-slots.test.ts` 的两条「ships empty」** 按定义在第一个单元落地时失效。
    改成在 import 时快照 `REGISTERED`，断言「本次构建注册的就是这些、每个 key 只出现一次」。

---

## 门槛与冒烟

- `npm run typecheck`：通过。
- `npx vitest run`：**1118 通过 / 58 跳过**（基线 1071/58 + 本单元新增 47 条，`tools-integration-{connection,ipc,model}`
  共 8+23+16=47；skip 一条没增、没减）。
- `tests/architecture.test.ts` 八条全绿。
- **打包冒烟（真机，darwin-arm64，2026-09-16）**：
  `resources/heart-portal` 用一个编译出来的 Mach-O stub（本机无 cargo），
  `PORTAL_DESKTOP_MAC_LOCAL_TEST=1 npx electron-forge package` 成功；
  `npx @electron/asar list` 确认 `/node_modules/ws/**` 在 asar 内。
  ad-hoc 签名的产物首次启动报 `different Team IDs`，`codesign --force --deep --sign -` 重签后可运行
  （本机打包的已知问题，与本单元无关）。
  `node tests/tools-e2e.mjs` → **PASS：握手 1 次，tools/list 9 个工具，允许 1 次、拒绝 1 次。**
  9 个 = 6 个 `desktop_browser_*` + 3 个 `desktop_console_*`；6 个 `desktop_terminal_*` 因为没有终端子系统
  （I3 未合）被 `toolAllowed` 挡在目录外 —— 与设计一致。
- `node tests/browser-e2e.mjs`（既有、非跳过）：PASS，工具栏新增按钮没有影响壳层浏览器。
- 注意：`tests/support/electron-lifecycle.mjs` 的锁在 `os.tmpdir()`，**五个 worktree 共用**。
  并行跑 E2E 会互相拒绝，合回后按顺序跑。
