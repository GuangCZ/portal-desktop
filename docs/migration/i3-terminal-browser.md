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
