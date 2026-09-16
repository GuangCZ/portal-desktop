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
