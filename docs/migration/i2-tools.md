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
