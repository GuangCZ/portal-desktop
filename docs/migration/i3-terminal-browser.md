# I3 · 终端 + 内置工具浏览器（集成单元）

基线：`next @ 9794cab`（worktree `.local/i3-terminal-browser`，分支 `i3-terminal-browser`）。日期 2026-09-16。

目标：把已移植的 `DesktopTerminal`（pty）与 `DesktopBrowser`（多标签工具浏览器）接成真实子系统
—— 子系统装配、IPC、preload、renderer 面板、测试。按定案 §5.8 分两次正式提交：先骨架（pty 不注册也能过门槛），
再 `tools/terminal/node-pty.ts` 的注册 + 真机验证。

---

## 1. 阅读摘要

### 1.1 `integration-plan.md` §3 统一约定 / §3.3 / §2.1 / §2.4 / §4 / 附录

**统一约定**
- 独占目录只有本单元可新建/修改；共享文件只允许 append 一行（import + 数组/对象项）。
- 共享文件清单固定为：`desktop/main/extensions.ts`、`desktop/preload/channels/index.ts`、
  `desktop/shared/desktop-types.ts`、`desktop/shared/types.ts`(`DesktopAPI`)、
  `desktop/renderer/app/slots.tsx`、`desktop/renderer/app/models/registry.ts`。
- `desktop/main/main.ts`、`package.json`、`forge.config.ts`、`vite.*.config.ts` 在 I0 之后任何单元不得修改。
- IPC 命名 `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  BD 标「Town 包络」用 `chatErrorEnvelope` 返回而不是抛。
- 注入替身形状与生产一致（类实例，不要箭头函数对象）。

**§3.3 I3 本体**
- 独占新文件：`main/subsystems/terminal.ts`、`main/tools/terminal/{ipc,node-pty}.ts`、
  `preload/channels/terminal.ts`、`shared/terminal-types.ts`、
  `renderer/terminal/{models/terminal.ts,components/{panel,tabs,stage}.tsx,slot.tsx}`、`tests/terminal-integration-*.test.ts`。
- 装配对照 `src/main.cjs:1710-1712`：`registerNodePty()` + `new DesktopTerminal({ getWorkspace, onChange, onData })`，
  environment/platform/shellPath 用默认。
- `reveal(id)`：BD 用 `executeJavaScript('window.beingTerminal.reveal(id)')`；本壳层改为
  推送 `beings:terminal-reveal` + 渲染层 invoke `beings:terminal-revealed`，`showTerminal` 变成「推送 + 超时 2s 等 ack」，
  超时报「面板尚未展示」。
- IPC 清单（计划版）：`beings:terminal`（快照）、`beings:terminal-read`（回放 ≤1MB）、
  `beings:terminal-action`（create/write≤64KiB/resize/activate/close，≤8 会话）、
  推送 `beings:terminal-state`、`beings:terminal-data`、`beings:terminal-reveal`，invoke `beings:terminal-revealed`。
- renderer：`PANEL_SLOTS` 一项；xterm 主题/字号/reduced-motion 从 BD `renderer/terminal-panel.js` 的
  `typography()` / `terminalTheme()`（18–37 行）逐行移植。
- 收敛副本：`tools/terminal/platform.ts` 删除，改 import `common/platform`。
- 新测试：`tests/terminal-integration-ipc.test.ts`（8 会话上限、64KiB 写入上限、未知操作抛「未知终端操作。」、`readSince` 序号语义）。
- 验收：typecheck / vitest / architecture；真机 `npm run start` 新建终端跑 `echo` 回显；`npm run package` 后产物再跑一次。

**§2.1 注册表 API**：`SubsystemContext` = `{handle, exclusive, window, store, electron, userData, desktopId,
clientVersion, onError, registry, push}`；`DesktopSubsystem` = `{key, connectionVerified?, connectionCleared?,
quitting?, ready?}`；子系统文件头模板固定（`declare module './types' { interface SubsystemMap { ... } }`）。
**install 的同步体里只能构造自己的实例 + 存惰性 getter，不得 `ctx.registry.get(...)` 取值。**

**§2.4 插槽**：`PanelSlot{key,title,icon?,order,Panel,visible}`；`FEATURE_MODELS` 注册表
`{key, create(api, app): Store}`，`AppModel.features` 由壳层填充并把 subscribe 接进 `changed()`。

**§4 冲突约束**：I3 排第一个合回（共享文件只 append 两处，且给 I2 提供真实类）。
xterm 依赖若缺必须回 I0 补，不在 I3 改 package.json。

**附录**：I3 独占目录 = `main/subsystems/terminal.ts`、`main/tools/terminal/{ipc,node-pty}.ts`、`renderer/terminal/`。

### 1.2 已拍板的决定（与本单元相关）
- §5.6：两个浏览器并存；工具浏览器分区 `persist:being-desktop-browser-v1`，进 `PANEL_SLOTS` 面板区；
  portal-desktop 自带 `desktop/main/browser/`（外壳浏览器）一行都不改。
- §5.8：先合骨架（pty 不注册也能过门槛，未注入 pty 的优雅失败路径要有测试），node-pty 注册 + 真机验证单独第二个提交；
  第二步任何一环过不去就只保留第一次提交，缺的写进 openIssues。

---

## 2. 进度

- [x] 读 integration-plan §3 约定 / §3.3 / §2.1 / §2.4 / §4 / 附录 / §1.1 u5 / §1.3 / §1.4 / §5.6 / §5.8 / §6.2-6.3

### 1.3 `docs/migration/i0-seams.md`（接缝权威说明）

**A 主进程子系统**：`SubsystemContext` 实际成员 = `handle / exclusive / window() / store / electron / userData /
desktopId / clientVersion / fetchImpl / onError / registry / push`（push 自带窗口守卫）。
`DesktopSubsystem` 可选 `linked() / connectionVerified(connection)（同步，不得 await exclusive） / connectionCleared() / quitting() / ready`。
扇出：linked / verified / cleared 按安装顺序，quitting 逆序；抛错只记 `onError` 不打断其余。
**铁律**：install 同步体里不得 `ctx.registry.get(...)` 取值，只能包成闭包。
`linked()` 是惰性规则的唯一例外出口（用于「赋值」而不是「读」）。
`SubsystemSettings` 与方案偏差：拆成 `settings: Settings` + `extras` + `saveExtra(patch)`。
`ElectronBindings` 的 `WebContentsView` / `session` / `net.request` 是 `unknown`——**需要它们的单元（I3 的工具浏览器）
在使用处 `as` 一次并写明理由**。`clipboard` 是 Promise 形态。

**D renderer 插槽**：`page.tsx` / `sidebar.tsx` / `topbar.tsx` 已接好，后续单元不需要再改。
`FEATURE_MODELS` 的 model 类型是 `FeatureModel = Store & { start?(): () => void }`——
**IPC 订阅、定时器一律放 `start()` 里并返回关闭函数**，构造函数里开的东西没地方关。
排序 `order` 升序、同 order 按 key 字典序；`order` 用百位留空隙。插槽组件自带边框、空态与错误处理。

**E 六个一行式冲突点**：与方案一致。只有 I0 能改 `main.ts` / `package.json` / `forge.config.ts` /
`vite.*.config.ts` / `subsystems/types.ts` 的接口成员 / `renderer/app/models/app.ts`。

**F `main/common/`**：I0 已**一次收敛完**——`tools/terminal/platform.ts` **已被 I0 删除**，
导入已改指 `common/platform`。所以 §3.3 里「要收敛的副本」这一步 **I3 不需要再做**（基线已是收敛后的）。

**H 依赖与打包（对 I3 至关重要，全部已由 I0 落地）**：
`node-pty` 1.1.0（不是方案猜的 1.0.0）、`@xterm/xterm` 6.0.0、`@xterm/addon-fit` 0.11.0、`ws` 8.21.3 已在 `dependencies`；
`@electron-forge/plugin-auto-unpack-natives` 已挂进 `forge.config.ts`；
`vite.main.config.ts` 的 external = `['electron','node-pty','ws']`；
`forge.config.ts` 自带 `packagerIgnore`（plugin-vite 会把整棵 node_modules 排除，提级 dependencies 只是必要条件）；
`NATIVE_UNPACK = '**/node_modules/node-pty/{build/*,prebuilds/*}/spawn-helper'`（macOS 专用 helper，`*.node` glob 匹配不到它）。
I0 已实测 `npm run package` 在 darwin-arm64 全绿、`require('node-pty')` 从 asar 内可解析、
`loadNativeModule('pty').dir` 落在 `app.asar.unpacked/`。**`pty.spawn` 的真实冒烟 I0 明确留给 I3 在真实应用里做。**

**I 与方案不同的点**：`tools/terminal/platform.ts` 已删；node-pty 是 1.1.0；`connectionCleared()` 至今无调用方（既有缺口）。

### 1.4 接缝真实代码（`subsystems/{types,chat}.ts`、`extensions.ts`、`preload/channels/*`、`slots.tsx`、`models/registry.ts`）

- `installSubsystems` 的 `ctx.push` 已自带窗口守卫；`registry.get` 返回 `null`（不是 undefined）；
  `require` 抛「子系统 X 未安装。」。`linked()` 在全部 install 之后按顺序同步跑。
- `subsystems/chat.ts` 是模板：`report()` 包 `ctx.onError`、`registerChatIpc({handle, exclusive, sessions: () => …, blocked: () => …})`、
  构造失败时不抛而是把 `blocked` 文案交给 IPC 层。**照抄这个形状**。
- `preload/channels/bridge.ts` 提供 `subscribe<T>(channel, cb)` 与 `enveloped<T>(channel, ...args)`。
  终端通道不是 Town 包络，用 `ipcRenderer.invoke` + `subscribe` 即可。
- `slots.tsx` 已有 `visiblePanels/sidebarSections/topbarActions/viewSheets` 四个读取函数，`page.tsx` 已接。
- `models/registry.ts` 的 `FeatureModel = Store & { start?(): () => void }`；`create(api, app)` 的 `app` 是 `unknown`。

### 1.5 `docs/migration/u5-terminal-browser.md`（本单元的移植源）

**BD `src/main.cjs` 的装配（行 1710 起）**——逐行对照物：
```js
desktopTerminal = new DesktopTerminal({
  getWorkspace: () => state.workspace.path,
  onChange: s => win?.webContents.send('being:terminal-state', s),
  onData: c => win?.webContents.send('being:terminal-data', c),
});
```
没有传 `pty` / `environment` / `platform` / `shellPath`，全部走默认。
IPC：`getTerminalState → snapshot()`；`readTerminal → read(id)`；
`terminalAction` 按 create/write/resize/activate/close 分发后**返回 `snapshot()`**，未知操作抛 `'未知终端操作。'`。

**`DesktopTerminal` 导出面**（docs/interfaces.md 3.6）：`create({cwd,cols,rows})`、`write({id,data})`、`resize({id,cols,rows})`、
`activate(id)`、`close(id)`、`read(id)`、`readSince(id, afterSequence)`、`snapshot()`、`dispose()`；另导出 `setDefaultPtyFactory`。
上限：`MAX_INPUT_BYTES=64KiB`、`MAX_REPLAY_BYTES=1MB`、`MAX_SESSIONS=8`；`readSince` 单次 ≤128KiB。
未注册 pty 时 `create()` 抛 `无法启动 ${shell} 交互终端，请检查终端组件与系统安装。`（带 cause）——这就是「优雅失败路径」。

**`DesktopBrowser` 导出面**：`newTab/activateTab/closeTab/navigate/goBack/goForward/reload/stop/setViewport/
readPage/prepareAction/click/fill/screenshot/snapshot()/destroy()`；另导出 `BROWSER_PARTITION`（**已是
`persist:being-desktop-browser-v1`，定案 5.6 已满足**）、`MAX_BROWSER_TABS=16`、`normalizeBrowserUrl`。
构造参数 = `ElectronBrowserHost & {onChange}`，真适配在 `tools/browser/electron-host.ts`
（`createElectronBrowserHost(getWindow)` / `createElectronBrowser(getWindow, onChange)`，唯一 import electron 的文件）。

**与既有 `desktop/main/browser/`（ClientBrowser，外壳浏览器）的区别**：单标签 vs 16 标签；
分区 `persist:beings-browser` vs `persist:being-desktop-browser-v1`；`browserURL` 裸文本补 https vs `normalizeBrowserUrl` 直接拒绝。
**定案 5.6：ClientBrowser 一行都不改。**

### 1.6 `desktop/main/tools/terminal/{terminal,types}.ts`（真实代码）

- `terminal.ts` 已 import `../../common/platform`（I0 收敛完成），**`tools/terminal/platform.ts` 不存在**。
- `setDefaultPtyFactory(loader)` 是模块级单例；`loadPtyFactory()` 未注册时抛
  `node-pty factory is not registered; inject 'pty' or call setDefaultPtyFactory().`，
  被 `create()` 的 try 包成中文文案 + cause。
- `create()` 先 `desktopPlatform(platform).terminalSupported` 闸门（linux 为 false），再 `dimensions()`，再会话数上限，
  再 `realpath`/`stat` 工作目录，最后 spawn。
- `snapshot()` 的 `pid` 取 `item.process?.pid || item.pid`。
- `readSince(id, after)` 的游标语义：`first = sequence - chunks.length + 1`；越界抛 `终端输出游标无效。`。

### 1.7 `desktop/main/tools/desktop-tools.ts`（I2 的，只读）

`DesktopTools` 在构造体里 `this.browser = new Browser({WebContentsView, session, getWindow, onChange})`——
即 **DesktopBrowser 的实例由 I2 的组合根间接创建**。§3.3 的独占文件清单里没有任何 browser 文件、IPC 表里也没有 browser 通道。
→ 见 §3「决定与偏差」里的 D1。

### 1.8 BD `src/main.cjs` 的终端装配与 IPC（逐行对照物）

- 行 1710-1712：`new DesktopTerminal({getWorkspace:()=>state.workspace.path, onChange:s=>win.webContents.send('being:terminal-state',s),
  onData:c=>win.webContents.send('being:terminal-data',c)})`——没传 pty/environment/platform/shellPath。
- 行 1102-1116：
  - `handle('getTerminalState',()=>desktopTerminal.snapshot())`
  - `handle('readTerminal',id=>desktopTerminal.read(id))`
  - `handle('terminalAction', async(action,value)=>{ if(exitStarted) throw new Error('桌面端正在退出。');
    switch(action){create/write/resize/activate/close} default: throw new Error('未知终端操作。'); return desktopTerminal.snapshot(); })`
    —— **create 之后也返回 snapshot()，不返回 sessionId**；渲染层靠 `result?.sessionId` 取值，所以 BD 的 `create` 分支
    其实丢掉了 sessionId（`renderer/terminal-panel.js:create()` 里 `result?.sessionId` 恒为 undefined，随后靠
    `accept(await bridge.getTerminalState())` 与 `activeSessionId` 兜底）。移植时保持返回 snapshot，**并额外带上 sessionId**
    见 §3 D2。
  - `handle('readNativeText',()=>clipboard.readText().slice(0,65536))`（I2 的通道，终端粘贴要用）
  - `handle('copyDesktopText', v => …)`（I2 的通道，终端复制要用）；本仓库已有 `beings:clipboard-copy`。
- 行 1697-1703 `showTerminal`：`exitStarted || !win || win.isDestroyed()` → 抛「桌面窗口已关闭。」；
  `desktopTerminal.activate(id)` → 推 `being:terminal-state` → `executeJavaScript('window.beingTools?.show("console"); window.beingTerminal?.reveal(id)')`
  → `if(!shown) throw new Error('终端已创建，但面板尚未展示，请用终端列表和显示工具恢复。')`。
- 行 1615 shutdown：`await desktopTerminal?.dispose(); await desktopTools?.dispose();`（终端先于工具）。

### 1.9 BD `renderer/terminal-panel.js`（204 行，界面规则来源）

**typography()（第 18 行）**：
`fontFamily = --font-mono || 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'`；
`fontSize = clamp(8, 32, ([12,13,14].includes(--text-code) ? --text-code : 12) + fontZoom)`；
`cursorBlink = !matchMedia('(prefers-reduced-motion: reduce)').matches`。

**terminalTheme()（第 19-23 行）**：`background = --background || '#181818'`，`foreground = --text || '#dfdfdf'`，
`selection = /^#[\da-f]{6}$/i.test(foreground) ? foreground+'33' : (--line || '#ffffff1a')`；
`cursor=foreground`、`cursorAccent=background`、`selectionBackground=selectionInactiveBackground=selection`；
16 色写死：black #181818 / red #e2777a / green #9bbd91 / yellow #d6bb85 / blue #8aa9d6 / magenta #ba9bd2 /
cyan #84b8bc / white #dfdfdf / brightBlack #777777 / brightRed #ee9294 / brightGreen #b3d2a9 / brightYellow #e4d0a6 /
brightBlue #abc3e6 / brightMagenta #d0b5e3 / brightCyan #a2d0d3 / brightWhite #f1f1f1。

**terminalOptions(readonly)**：`{...typography(), fontWeight:400, lineHeight:1.2, letterSpacing:0, cursorStyle:'bar',
cursorWidth:1, scrollback:5000, allowProposedApi:false, allowTransparency:false, convertEol:readonly,
disableStdin:readonly, drawBoldTextInBrightColors:false, minimumContrastRatio:1, theme:terminalTheme()}`。

**回放/增量的序号协议（`replay` / `receive`）**：
先 `readTerminal(id)` 拿 `{sequence, data, truncated}`，`terminal.reset()`，truncated 时先写
`\x1b[90m[较早的终端输出已截断]\x1b[0m\r\n`；回放期间到达的事件进 `pending`，回放结束后按 sequence 升序补发。
`receive`：`sequence <= entry.sequence` 丢弃；`sequence > entry.sequence + 1`（有洞）→ 入 pending 并**重新 replay**。

**其它规则**：`fit()` 走 `requestAnimationFrame`，宽 <30 或高 <20 不 fit；fit 时把 typography 逐键 diff 后写回
`terminal.options`；`resize` 只在 `cols>=2 && rows>=1` 且状态 running/starting 且尺寸变了才发。
键盘：Ctrl/Cmd+C（有选区或按了 Shift）复制、Ctrl/Cmd+V 粘贴、Ctrl/Cmd +/-/0 调字号（fontZoom 限 -6..20）。
`reveal(id)`：`accept(await getTerminalState())` → 没有这个 id 返回 false → `setSelected` → `show()` →
等一帧 → 返回 `visible && selected===key && host 的宽高都 >0`。
主题变化靠 `window 'being-theme-change'` 事件 + `prefers-reduced-motion` 的 change 事件重新 fit。

### 1.10 壳层真实代码（renderer / IPC 基础设施）

- `desktop/main/app/ipc.ts` 的 `createTrustedHandle`：已包含来源校验、`quitting()` 守卫（抛「客户端正在退出，请稍候。」）
  与 `report(channel, error)` 脱敏——**BD 的 `if(exitStarted) throw '桌面端正在退出。'` 不需要在子系统里重写**。
- `desktop/main/chat/ipc.ts` 是 IPC 层的风格样板：`plain()` / `fields(value, allowed, what)` 白名单校验、
  `invalid(msg)` 带 `code:'INVALID_REQUEST'`、`chatPush(target)` 把通道名收在同一文件。
- `desktop/renderer/main.tsx` **不在允许触碰的共享文件里** → 新的 CSS 只能从本单元自己的组件 `import './styles.css'`。
- vitest 没有 DOM environment（`vitest.config.ts` 未设 `environment`）→ **renderer 侧只能测 model，不能挂载组件**。
- `desktop/renderer/browser/page.tsx`（外壳浏览器）是「把 DOM 矩形回报给主进程去挂 WebContentsView」的样板：
  `getBoundingClientRect()` → `browserBounds({x,y,width,height,visible})`，用 ResizeObserver + MutationObserver(`open`/`hidden`)
  + `window resize` 触发，`visible` 还要排除拖拽中与任何 `dialog[open]`。
- `desktop/main/tools/browser/host.ts` 的 `ElectronBrowserHost = {WebContentsView, session, getWindow}`；
  `electron-host.ts` 是唯一 import electron 的文件——**但 `tests/architecture.test.ts` 禁止 `main/subsystems/` 直接 import electron**，
  所以子系统改为从 `ctx.electron` 造 host 并在使用处 `as` 一次（i0-seams §A 明确要求这么做）。
- `DesktopBrowser` 构造参数校验：`WebContentsView` 必须是函数、`session.fromPartition` 必须是函数、`getWindow`/`onChange` 必须是函数，
  否则抛 `TypeError('浏览器依赖无效。')`——**`ctx.electron.WebContentsView` 在测试上下文里默认是 `null`，所以子系统必须优雅降级。**

### 1.11 基线门槛（本 worktree 实测，9794cab）

- `npm run typecheck` 退出码 0。
- `npx vitest run`：**96 文件通过 / 8 跳过，1071 通过 / 58 跳过（共 1129）**。

---

## 2. 决定与偏差

### D1 · `DesktopBrowser` 实例的归属（**跨单元约定，I2 合回时必须处理**）

方案 §3.3 的独占文件清单与 IPC 表里**没有任何 browser 条目**，而 §3.2 的 I2 装配段把
`Browser: DesktopBrowser` 传给 `DesktopTools`，由它在构造体里 `new Browser({...})`。
但本单元的任务书明确要求「DesktopBrowser 与 DesktopTerminal 的子系统」，定案 5.6 也把工具浏览器定在 `PANEL_SLOTS` 的面板区。

**决定**：I3 建 `tool-browser` 子系统，它是 `DesktopBrowser` 实例的**唯一所有者**，并通过注册表暴露
`registry.get('tool-browser')?.browser`。I3 负责它的 IPC、preload、面板与可见区域（含与 ClientBrowser 的分区隔离）。

**给 I2 的一行式接法**（I2 本来就要动 `desktop-tools.ts` 做「类型对齐」，见方案 §3.2）：
给 `DesktopToolsOptions` 加一个可选 `browser?: DesktopBrowserLike`，构造体改成
`this.browser = browser ?? new Browser({WebContentsView, session, getWindow, onChange: () => this.changed()})`，
I2 的子系统里传 `browser: ctx.registry.get('tool-browser')?.browser`（惰性拿不到就退回自己 new，行为不变）。
**若 I2 直接 `new` 而不注入，会出现两个 `DesktopBrowser` 抢同一个 `BrowserWindow` 的 contentView，
分区相同、`_syncView` 互相 detach——这是一个真实缺陷，不是合并噪声。** 已列进 openIssues。

### D2 · `beings:terminal-action` 的 `create` 返回值
BD 的 `terminalAction` 对所有动作一律 `return desktopTerminal.snapshot()`，
于是 `renderer/terminal-panel.js:create()` 里的 `result?.sessionId` **恒为 undefined**（靠 `activeSessionId` 兜底）。
移植时保留「返回 snapshot」，但在 create 分支额外带上 `sessionId`：返回 `{...snapshot(), sessionId}`。
这是 BD 渲染层本来就想要的形状，不改变任何协议语义。

### D3 · `showTerminal` 的回执
BD 走 `win.webContents.executeJavaScript('window.beingTerminal.reveal(id)')` 取布尔回执。
本壳层没有全局 `window.beingTerminal`，按方案改为：主进程 `activate(id)` → 推 `beings:terminal-state`
→ 推 `beings:terminal-reveal {id}` → 等渲染层 invoke `beings:terminal-revealed {id, shown}`，**超时 2000ms**。
未在时限内拿到 `shown:true` 则抛 BD 原文案「终端已创建，但面板尚未展示，请用终端列表和显示工具恢复。」。

### D4 · 子系统不 import electron
`tests/architecture.test.ts` 有一条「`main/subsystems/` 不得 `import 'electron'`」。
因此 `tool-browser` 子系统**不 import `tools/browser/electron-host.ts`**，改为把 `ctx.electron.WebContentsView` /
`ctx.electron.session`（声明为 `unknown`）在使用处 `as` 成 `BrowserViewConstructor` / `BrowserSessionFactory`——
这正是 i0-seams §A 为这两个成员写的用法。缺席（测试上下文、非 Electron 环境）时不构造浏览器，
IPC 以「内置浏览器在当前运行环境不可用。」拒绝。

### D5 · 通道命名
外壳浏览器已经占了 `beings:browser-*`（`browser-state/-action/-bounds/-open`）。
工具浏览器用 `beings:tool-browser-*`，与 I2 计划的 `beings:tools-*` 也不撞。

### D6 · 终端工作目录取 `projectWorkspace`，不回退到 `workspace`（**实测推翻方案 §3.3**）

方案 §3.3 写的是 `getWorkspace: () => ctx.store.settings.projectWorkspace || ctx.store.settings.workspace`。
**打包冒烟实测（2026-09-16）：这样每个新档案的终端都开不起来。**
`settings.workspace` 是 **Portal 的工作目录**，默认值是 `~/Being Desktop Workspace`（`app/settings.ts:44`），
而这个目录要等用户保存过一次连接设置才会被 `mkdir`。于是 `DesktopTerminal.create()` 的 `realpath` 失败，
抛「终端工作目录不存在或无法访问。」。
BD 的 `state.workspace.path` 对应的是本仓库的 `projectWorkspace`（`shared/types.ts` 注释写明），
两者语义也不同：一个是引擎跑在哪，一个是用户在做什么。
**改为只取 `projectWorkspace`，为空时由 `DesktopTerminal.create()` 回退到 `os.homedir()`——与 BD 完全一致。**

### D7 · 两处既有测试的最小改动（不是弱化，是把断言指向它自己的主体）

1. `tests/chat-ipc.test.ts`：fixture 从 `installDesktopExtensions`（跑真实 `INSTALLERS`）改成
   `installSubsystems(ctx, [installChatSubsystem])`。
   原因：该文件第 111 行 `expect([...f.handlers.keys()]).toEqual(CHANNELS)` 断言的是**对话层**的通道集合，
   任何单元落地都会让它把别人的通道也算进来。改成只装它自己的子系统后，断言强度**一字未减**，
   而且对后面四个单元免疫。**I1/I2/I4/I6 不需要再改这个文件。**
2. `tests/renderer-slots.test.ts`：两条「ships empty」改成「carries exactly the surfaces the landed units
   registered」，并在模块加载时把 `PANEL_SLOTS` 等四个数组与 `FEATURE_MODELS` 的初始内容快照进 `LANDED`
   （`afterEach` 会清空这些共享数组，第二个 describe 里已经读不到了）。
   断言从「是空的」变成「恰好是已落地单元注册的这些」——更强，不是更弱。
   **后续单元落地时只需在这两处各加自己的 key。**

---

## 3. 产出清单

### 3.1 独占新文件

| 文件 | 内容 |
| --- | --- |
| `desktop/main/subsystems/terminal.ts` | `installTerminalSubsystem`；装配、reveal、quitting |
| `desktop/main/subsystems/tool-browser.ts` | `installToolBrowserSubsystem`；`DesktopBrowser` 实例的唯一所有者 |
| `desktop/main/tools/terminal/ipc.ts` | `registerTerminalIpc` / `terminalPush` / `createRevealGate` / `REVEAL_TIMEOUT_MS` / `TERMINAL_UNAVAILABLE` |
| `desktop/main/tools/browser/ipc.ts` | `registerToolBrowserIpc` / `toolBrowserPush` / `TOOL_BROWSER_UNAVAILABLE` |
| `desktop/main/tools/terminal/node-pty.ts` | `registerNodePty()`——全树唯一 `require('node-pty')`（第二个提交） |
| `desktop/preload/channels/terminal.ts` | `terminal: TerminalAPI` |
| `desktop/preload/channels/tool-browser.ts` | `toolBrowser: ToolBrowserAPI` |
| `desktop/shared/terminal-types.ts` | `TerminalAPI` 与 DTO |
| `desktop/shared/tool-browser-types.ts` | `ToolBrowserAPI` 与 DTO（全部 `ToolBrowser*` 前缀，避开外壳浏览器的 `Browser*`） |
| `desktop/renderer/terminal/models/terminal.ts` | `TerminalModel` + `terminalModelFactory` |
| `desktop/renderer/terminal/components/{stage,tabs,panel}.tsx` | xterm 实例 / 标签条 / 面板 |
| `desktop/renderer/terminal/slot.tsx` | `terminalPanelSlot`、`terminalTopbarSlot` |
| `desktop/renderer/terminal/styles.css` | 面板样式（类名沿用 BD） |
| `desktop/renderer/tool-browser/models/tool-browser.ts` | `ToolBrowserModel` + `toolBrowserModelFactory` |
| `desktop/renderer/tool-browser/components/panel.tsx` | 标签条 + 地址栏 + 视口占位 |
| `desktop/renderer/tool-browser/slot.tsx`、`styles.css` | 插槽与样式 |
| `tests/terminal-integration-ipc.test.ts` | 9 条 |
| `tests/terminal-integration-subsystem.test.ts` | 5 条 |
| `tests/tool-browser-integration.test.ts` | 6 条 |
| `tests/terminal-panel-model.test.ts` | 12 条 |
| `tests/terminal-e2e.mjs` | 打包客户端的真机 E2E（方案 §6.2，第二个提交） |

### 3.2 IPC 通道清单

| 通道 | 方向 | payload | 备注 |
| --- | --- | --- | --- |
| `beings:terminal` | invoke | → `TerminalState` | 无终端时答空快照，不拒绝 |
| `beings:terminal-read` | invoke `(id)` | → `TerminalReplay` | 回放 ≤1MB；`sequence` 与 data 事件共用 |
| `beings:terminal-action` | invoke `(action, value)` | → `TerminalState`（`create` 额外带 `sessionId`） | create/write/resize/activate/close；未知动作抛「未知终端操作。」 |
| `beings:terminal-revealed` | invoke `({id, shown})` | → void | 渲染层对 reveal 的回执 |
| `beings:terminal-state` | push | `TerminalState` | `DesktopTerminal.onChange` |
| `beings:terminal-data` | push | `TerminalData` | `DesktopTerminal.onData` |
| `beings:terminal-reveal` | push | `{id}` | 主进程请求面板展示；2s 无回执即失败 |
| `beings:tool-browser` | invoke | → `ToolBrowserState` | 同上，不可用时答空快照 |
| `beings:tool-browser-action` | invoke `(action, value)` | → `ToolBrowserState` | new/activate/close/navigate/back/forward/reload/stop；未知动作抛「未知浏览器操作。」 |
| `beings:tool-browser-viewport` | invoke `({visible, bounds?})` | → `ToolBrowserState` | 面板占位矩形 |
| `beings:tool-browser-state` | push | `ToolBrowserState` | `DesktopBrowser.onChange` |

校验分工：**白名单（未知字段、非 plain 对象、原型污染）在 IPC 层**；
**上限与语法（8 会话 / 64KiB / 2..500×1..200 / 16 标签 / 地址语法 / 矩形范围）留在 `DesktopTerminal` 与
`DesktopBrowser`**，它们的文案原样到达渲染层，不在上层复述。
来源校验与 quitting 守卫由 `ctx.handle`（`createTrustedHandle`）继承，不重写。

### 3.3 装配点

- `desktop/main/extensions.ts` 的 `INSTALLERS`：`installTerminalSubsystem`、`installToolBrowserSubsystem`。
- 终端：`new DesktopTerminal({ getWorkspace, onChange → beings:terminal-state, onData → beings:terminal-data })`，
  environment / platform / shellPath 用默认（对照 `src/main.cjs:1710-1712`）。
  `quitting()` → `dispose()`（对照 `src/main.cjs:1615`，终端先于工具）。
- 工具浏览器：`new DesktopBrowser({ WebContentsView: ctx.electron.WebContentsView as BrowserViewConstructor,
  session: ctx.electron.session as BrowserSessionFactory, getWindow: ctx.window, onChange → beings:tool-browser-state })`。
  `quitting()` → `destroy()`。两个 `as` 是 i0-seams §A 指定的用法（这两个成员声明为 `unknown`）。
  **不 import `tools/browser/electron-host.ts`**：`tests/architecture.test.ts` 禁止 `main/subsystems/` 直接 import electron。

### 3.4 共享文件触碰行（逐行）

| 文件 | 加的行 |
| --- | --- |
| `desktop/main/extensions.ts` | `import { installTerminalSubsystem } from './subsystems/terminal';` |
| | `import { installToolBrowserSubsystem } from './subsystems/tool-browser';` |
| | `INSTALLERS` 内：`  installTerminalSubsystem,` |
| | `INSTALLERS` 内：`  installToolBrowserSubsystem,` |
| `desktop/preload/channels/index.ts` | `import { terminal } from './terminal';` |
| | `import { toolBrowser } from './tool-browser';` |
| | `desktopChannels` 内：`  terminal,` |
| | `desktopChannels` 内：`  toolBrowser,` |
| `desktop/shared/desktop-types.ts` | `export * from './terminal-types';` |
| | `export * from './tool-browser-types';` |
| `desktop/shared/types.ts` | `import type { TerminalAPI, ToolBrowserAPI } from './desktop-types';`（单独一行，不改既有 import 行） |
| | `DesktopAPI` 内：注释 1 行 + `  terminal: TerminalAPI;` |
| | `DesktopAPI` 内：注释 1 行 + `  toolBrowser: ToolBrowserAPI;` |
| `desktop/renderer/app/slots.tsx` | `import { terminalPanelSlot, terminalTopbarSlot } from '../terminal/slot';` |
| | `import { toolBrowserPanelSlot, toolBrowserTopbarSlot } from '../tool-browser/slot';` |
| | `PANEL_SLOTS` 内：`  terminalPanelSlot,` / `  toolBrowserPanelSlot,` |
| | `TOPBAR_SLOTS` 内：`  terminalTopbarSlot,` / `  toolBrowserTopbarSlot,` |
| `desktop/renderer/app/models/registry.ts` | `import { terminalModelFactory } from '../../terminal/models/terminal';` |
| | `import { toolBrowserModelFactory } from '../../tool-browser/models/tool-browser';` |
| | `FEATURE_MODELS` 内：`  terminalModelFactory,` / `  toolBrowserModelFactory,` |
| `MIGRATION.md` | 表格一行 |

另外改了两个既有测试文件（见 D7）：`tests/chat-ipc.test.ts`、`tests/renderer-slots.test.ts`。

**注意**：model 工厂放在 model 文件里而不是 `slot.tsx` 里，是为了让 `app/models/registry.ts`
（`AppModel` 会 import 它）不把 React 组件拖进 model 图——`tests/architecture.test.ts` 的
「models/services 不 import components/hooks/react」是按直接边判定的，但这条是它的用意。

---

## 4. 门槛与真机

### 4.1 第一个提交（骨架，pty 工厂不注册）

- `npm run typecheck` 退出码 0。
- `npx vitest run`：**100 文件通过 / 8 跳过，1103 通过 / 58 跳过**。
  对照基线（9794cab）96/8、1071/58 → 净增 **32** 条，全部是本单元新增；没有删除或跳过任何既有用例。
- `tests/architecture.test.ts` 八条全绿（含新目录 `main/subsystems/terminal.ts`、`main/subsystems/tool-browser.ts`
  不 import electron 这一条）。
- 「未注入 pty」的优雅失败路径有专门用例：`tests/terminal-integration-subsystem.test.ts` 的
  「without a pty module it refuses with BeingDesktop's own sentence and stays usable」。

### 4.2 第二个提交（node-pty 注册 + 真机验证）

`desktop/main/tools/terminal/node-pty.ts` 的 `registerNodePty()` 在终端子系统的 installer 里调用一次
（不在 `main.ts`——I0 之后任何单元都不得改它）。它只存一个 thunk，**不加载模块**：
原生模块缺失或 ABI 不匹配的机器照样能开客户端，只有有人要终端时才失败，文案还是 BD 的那句。
用 `createRequire(import.meta.url)` 而不是静态 import——`vite.main.config.ts` 把 `node-pty` 列进
`rollupOptions.external`，静态 import 会在 ESM bundle 里留下裸 specifier。

- `npm run typecheck` 退出码 0；`npx vitest run` **1103 通过 / 58 跳过**（与骨架一致：
  新增的 `tests/terminal-e2e.mjs` 是 Playwright 脚本，不在 vitest 的 `include` 里）。

**真机（本机 darwin-arm64，2026-09-16 实跑）**

1. **`npm run start`（开发树）**：用 `npm run start -- -- --remote-debugging-port=9223` 起客户端，
   再用 Playwright 的 `connectOverCDP` 驱动。结果：
   - 点顶栏「终端」→ 面板打开 → 自动新建会话
     `{"title":"zsh","cwd":"/Users/d5c","status":"running","pid":55493,"cols":72,"rows":49}`；
   - 在 xterm 里敲 `echo dev-mode-ok` + 回车 → `readTerminal` 里出现两次该串（命令回显 + 输出），
     且 `.xterm-rows` 的 textContent 也包含它 → **PTY 与渲染两端都通**；
   - 点顶栏「Being 工具浏览器」→ 面板打开 → 地址栏输入本地夹具 URL → 标签页标题变为「工具浏览器测试」；
   - `toolBrowser.navigate({url:'search some text'})` 被拒绝，文案
     「请输入 HTTP 或 HTTPS 地址，例如 localhost:3000。」（与外壳浏览器的「裸文本补 https」**不同**，符合定案 5.6）；
   - 收起浏览器后 `visible === false`，原生视图从窗口摘下。
   - 渲染层无 `pageerror`。
2. **`npm run package` 后从产物启动**：`tests/terminal-e2e.mjs`（新增）跑通，输出
   「终端 E2E 通过：打包客户端能启动 PTY、回显命令并关闭会话。」。断言覆盖：
   会话 `status==='running'` 且有 pid、cwd 是绝对路径；`.xterm-screen` 挂载且 `cols>=2`（fit 真的跑过）；
   在 xterm 自己的 `.xterm-helper-textarea` 里敲 `echo being-desktop-terminal-ok` 后回显出现 ≥2 次；
   `.xterm-rows` 也包含它；新建第二个会话后逐个 `close`，最终 `sessions.length === 0`；渲染层无 `pageerror`。
   产物里实测：
   ```
   app.asar.unpacked/node_modules/node-pty/build/Release/pty.node        -rwxr-xr-x
   app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper    -rwxr-xr-x
   app.asar/node_modules/node-pty/lib/index.js                            （在 asar 内）
   ```

**两个与产品无关的本地变通（不改任何产品代码，供复现）**：
- 本机没有 Rust 工具链，`resources/heart-portal` 不存在 → 用一个打印 `heart-portal 0.0.0` 的
  临时 Mach-O stub 满足 `forge.config.ts` 的 `extraResource`（I0 也是这么做的）。
- macOS 26 下 ad-hoc 签名 + hardened runtime 的产物**起不来**：
  `dyld: ... Electron Framework ... different Team IDs`——library validation 不接受两个无 Team 的 ad-hoc 签名。
  验证前对产物执行一次 `codesign --force --deep --sign - "Being Desktop.app"`（去掉 runtime 标志）即可。
  这是本机签名环境的限制，不是打包配置问题；正式签名（`signing.identity`）不受影响。

---

## 5. 未做 / 存疑（如实记录）

1. **`tests/terminal-e2e.mjs` 没有接进 `package.json` 的 scripts，也没有接进 `scripts/test-all.mjs`。**
   这两个都是本单元不许改的共享文件（`package.json` 只有 I0 能改；`test-all.mjs` 的步骤列表不在允许清单里）。
   在有人补上 `"test:terminal"` 与一行 `await npm('terminal-e2e', ['run', 'test:terminal'])` 之前，
   它只能手工跑：`npm run package` 之后 `node tests/terminal-e2e.mjs`。
2. **`DesktopBrowser` 实例的归属需要 I2 配合**（见 D1）。I2 若照方案 §3.2 直接
   `new Browser(...)`，会出现两个 `DesktopBrowser` 抢同一个窗口的 `contentView`、共用同一个分区。
   建议的一行接法写在 D1 里。**合回顺序是 I3 → I2，所以这件事由 I2 的作者或整合者在 rebase 时处理。**
3. **工具浏览器没有独立的 E2E。** 本次用一次性脚本在开发树里实测过（见 §4.2 第 1 条），
   但没有落成可重复的 `tests/tool-browser-e2e.mjs`——方案 §6.2 也没有要求。
   既有的 `tests/browser-e2e.mjs` 测的是外壳浏览器，本单元一行未改。
   **注意**：它里面的 `contentView.children.find(v => v.webContents)` 在两个浏览器同时挂载时会取到第一个；
   该脚本只开外壳浏览器，所以当前仍然正确，但 I2 扩写它时要留意。
4. **终端面板的三项 BD 功能没有移植**：
   - `Being · 命令`只读标签页（`updateJobs`）——它映射的是 `DesktopConsole` 的 job，属于 I2；
   - 终端选项菜单（新建 / 选择工作目录 / 复制 / 粘贴 / 清除显示 / 恢复隐藏的只读标签）——
     其中「复制/粘贴」已按快捷键实现（走 `navigator.clipboard`，不是 BD 的
     `copyDesktopText`/`readNativeText` 通道，那两条属于 I2），「选择工作目录」需要 I6 的设置面板；
   - 面板宽度可拖拽的分隔条（外壳浏览器有 `#browser-divider`，终端面板暂时用固定 flex-basis）。
5. **`Settings.projectWorkspace` 目前没有任何界面可以设置**（`SaveSettings` 里没有这个字段）。
   因此现在的终端总是开在用户主目录。这不是本单元引入的缺口——`projectWorkspace` 是 P0 从
   BeingDesktop 的配置里读出来保留的字段——但在有界面之前，「选择工作目录」这件事是断的。
6. **Linux**：`common/platform.ts` 的 `terminalSupported` 只认 win32/darwin（BD 的写死行为，原样保留），
   所以 Linux 上终端面板会一直显示「当前平台不支持交互终端。」。node-pty 的 Linux prebuild 与打包同样未验证（I0 也没验）。
7. **xterm 的字号变量**：`typography()` 读 `--font-mono` 与 `--text-code`，这两个 CSS 变量是 BeingDesktop 的，
   **本仓库的样式表里没有定义**，所以现在一直走兜底（等宽栈 + 12px）。
   等 I6 的外观设置把这两个变量补上，终端字号就会跟着走，不需要再改这里。
8. **`connectionCleared()` 依然没有调用方**（P1 就有的缺口，I0 原样保留）。
   本单元的两个子系统都没有实现它——终端与浏览器是本地工具，换 Being 不需要清空。
