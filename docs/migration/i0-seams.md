# I0 · 接缝脚手架（2026-09-16）

集成阶段第 0 步。目标：让 I1–I7 能在各自 worktree 并行开工，合回 `next` 时共享文件上只有 append-only 的一行式冲突。
I0 本身不接任何子系统，只铺脚手架、搬共享模块、改依赖。

基线：`next` @ 4a663ac，`npm run typecheck` 通过，`npx vitest run` 1036 通过 / 57 跳过。

---

## 阅读摘要

### integration-plan.md（§1.4 / §2 / §3 共享文件行 / §4 / §5.8 / 附录）

**§1.4 同源副本清单**（规划者已做逐函数体比对，结论「全部语义一致」；`desktopMessageContext` 一对标注**未核实**，I0 必须做字节级 diff）：

| 函数 | 副本 | 正式落点 |
| --- | --- | --- |
| `sanitizeText` | `chat/titles.ts`、`town/channel/sanitize.ts`、`town/session/sanitize.ts`、`orchestration/vendored.ts` | `main/common/sanitize.ts`，签名取最宽 `(value: unknown, secrets?: readonly unknown[]) => string` |
| `desktopPlatform` / `desktopEnvironment` / `shellPath` / `consoleEnvironment` / `WINDOWS_RUNNER` | `tools/platform.ts`、`tools/terminal/platform.ts`、`tools/console.ts`、`orchestration/vendored.ts` | `main/common/platform.ts`（以 `tools/platform.ts` 的类型为底） |
| `parseConnection` / `sessionPartition` / `endpoint` / `publicModelUrl` / `allowedNavigation` | `tools/security.ts`、`town/channel/loom-connection.ts` | `main/common/loom-connection.ts`（内容取 `tools/security.ts`） |
| `beingIdentityKey(address)` | `chat/connection.ts` | 保留入口，改为 `sessionPartition(parseConnection(address))` 的代理；**磁盘格式**，必须加同值断言测试 |
| `desktopMessageContext` / `DESKTOP_PORTAL_NAME` | `chat/context.ts`、`tools/message-context.ts` | `main/common/message-context.ts` |
| `scrollId` / `RESERVED_SCROLL_IDS` | `timeline/cached-reads.ts` 内联 | import `session/library-contract`（I1 做） |
| SSE 解析三处 | `session/client.ts`、`channel/sse.ts`、`chat/being-chat.ts` | **不要合并**，上限与错误码语义不同 |

迁移顺序：**I0 只新建 `common/*`、不删副本**；各单元在自己的 PR 里改 import 并删自己的副本 → 零跨单元冲突。

**§2 六个一行式冲突点**（I0 必须全部造出来）：
1. `desktop/main/extensions.ts` 的 `INSTALLERS` 数组
2. `desktop/preload/channels/index.ts` 的 `desktopChannels` 对象
3. `desktop/shared/desktop-types.ts` 的 re-export 聚合
4. `desktop/shared/types.ts` 的 `DesktopAPI` 属性
5. `desktop/renderer/app/slots.tsx` 的四个数组（PANEL / SIDEBAR / TOPBAR / SHEET）
6. `desktop/renderer/app/models/registry.ts` 的 `FEATURE_MODELS`

**§2.1 惰性 getter 铁律**：install 的同步体里只能构造自己的实例并把跨子系统引用存成惰性 getter（`() => ctx.registry.require('tools')`），
不得在同步体里 `ctx.registry.get(...)` 取值。否则 chat → orchestration → tools → orchestration → chat 的环会拿到 `undefined`。

**§2.6 依赖**：`ws` devDependencies → dependencies（u4 已实测：打进 bundle 第一帧 `bufferUtil.mask is not a function`；必须 external + asar 内保留）；
`node-pty` + `@electron-forge/plugin-auto-unpack-natives` + `vite.main.config.ts` 的 external。
**§3.3 补充**：`@xterm/xterm` + `@xterm/addon-fit` 也必须在 I0 加（`package.json` 只有 I0 能改）。

**§4 真正需要串行的两处**：`package.json` / `forge.config.ts` / `vite.*.config.ts` / `main.ts` 只有 I0 改；
`DesktopSubsystem` 接口若要加成员，回 I0 补。

**§2.7 验收**：typecheck + vitest 不降 + architecture 六条 + 新增 `tests/subsystem-registry.test.ts` 与 `tests/identity-partition.test.ts` + `npm run prepare:desktop` + 尝试 `npm run package`。

---

## 进度


### 真实代码（读一遍的结论）

**`desktop/main/main.ts`（657 行）** — 组合根。与 I0 相关的只有 428 行一处：
`extensions = installDesktopExtensions({ handle, exclusive, window: () => window, store, secretStorage, userData: directory, desktopId, clientVersion: app.getVersion(), fetchImpl: net.fetch…, onError })`。
另外 347 / 456 行调 `extensions?.connectionVerified(store.connection)`，645 行 `await extensions?.quitting()`。
**没有任何地方调用 `connectionCleared()`**（方案 §2.1 假设它存在；接口上有，组合根没接线——这是既有缺口，I0 原样保留）。
第 1 行的 electron import 已含 `clipboard`、`net`、`safeStorage`、`shell`、`protocol`、`nativeTheme`，**缺** `WebContentsView`、`session`、`powerMonitor`。

**`desktop/main/extensions.ts`（162 行）** — 现在就是 chat 一个子系统的手写安装：`chatPush` + `ChatCache` + `ChatSessions` + `registerChatIpc`，
外加 `address/identityKey/revision/closed/ready/blocked` 六个闭包变量与 `settle()`。`DesktopExtensions` 暴露 `connectionVerified/connectionCleared/quitting/chat/ready`。

**`desktop/main/chat/ipc.ts`（164 行）** — 9 条通道 + `chatPush`（两条推送）。注册全走 `ctx.handle`；5 条 `enveloped`。
`chatPush(target: () => ChatPushTarget | null)` 返回 `{event, state}`——`SubsystemContext.push` 要覆盖的就是这个形状。

**`desktop/preload/preload.ts`（68 行）** — `const api: DesktopAPI = { …, chat }`，第 68 行 `if (process.isMainFrame) contextBridge.exposeInMainWorld('beings', api)`。
**`desktop/preload/desktop-channels.ts`（41 行）** — `subscribe<T>` / `enveloped<T>` 两个助手 + `export const chat: ChatAPI`。

**`desktop/shared/desktop-types.ts`（190 行）** — 18 个 chat 类型 + `ChatAPI`，无 import。
**`desktop/shared/types.ts`** — `DesktopAPI` 末尾一行 `chat: ChatAPI;`（58–106 行），第 107 行 `declare global`。

**`desktop/renderer/app/page.tsx`（195 行）** — `workspace-body` 内依次 `<Sidebar>` / `workspace-stage` / `<Companion>` / `<Browser>`；
`Dialog#place-sheet` 内 `<PlaceHeading>` / `<Portal>` / `<Town>`。插槽插在 `<Browser>` 之后与 `<Town>` 之后。
**`sidebar.tsx`** 有 `sidebar-head` / `sidebar-scroll` / `sidebar-foot` 三个 div，正好对应 `SidebarSlot.placement`。
**`topbar.tsx`** 有 `div.topbar-actions`（136 行）。
**`models/app.ts`** — `AppModel extends Store`，构造里建 `conversation` 与 `town`；`start()` 返回 cleanup 数组。

**`tests/architecture.test.ts`（165 行）** — 六条：renderer 不导入 main/preload/electron/node；main/preload 不导入 renderer；
shared 纯净 + `renderer/shared/` 不反向依赖；`renderer/chat/` 必须不存在；renderer 不得出现 `fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon` 标识符；
`renderer/**/models|services/**` 不导入 components/hooks/react。规则是按目录模式写的，**新目录自动纳入**，不需要改测试就已覆盖 `subsystems/`、`common/`、`preload/channels/`、`slots.tsx`。

**`package.json`** — `ws: ^8.21.3` 在 devDependencies；dependencies 只有 highlight.js / marked / react / react-dom / smol-toml / tar。
**`forge.config.ts`** — `asar: true`，`plugins: [new VitePlugin({…})]`。
**`vite.main.config.ts`** — `build.rollupOptions.external: ['electron']`（一行式 defineConfig）。
**`scripts/prepare-desktop.mjs`** — 写 `desktop/generated/THIRD-PARTY-LICENSES.txt`（读 marked/highlight.js/react/react-dom/scheduler 的 LICENSE），拷 Portal 二进制。

### 同源副本现场（本人实测，非源码推断）

| 比对 | 结论 |
| --- | --- |
| `sanitizeText` 四份函数体（去空白） | **等价**。唯一差异在 `town/session` 的 `match =>` vs 另三份的 `(match) =>`；另三份逐字节相同。签名差异：`string[]` / `unknown[]` / `unknown[]` / `readonly unknown[]` |
| `WINDOWS_RUNNER`（`tools/console.ts` vs `orchestration/vendored.ts`） | **逐字节相同，2774 字节** |
| `ENVIRONMENT_KEYS` 三份 | **相同** |
| `desktopEnvironment` 三份 | **相同** |
| `parseConnection`（`tools/security.ts` vs `town/channel/loom-connection.ts`） | 只差对象字面量结尾的一个逗号，**等价** |
| `sessionPartition`（同上两份） | **逐字节相同** |
| `desktopMessageContext`（`chat/context.ts` vs `tools/message-context.ts`）**方案标「未核实」** | **去空白后逐字节相同（4626 字节）**。差异只有解构参数与对象字面量的空格 |
| `candidates`（`town/session/candidates.ts`）vs renderer `town/models/mentions.ts` **方案标「未核实」** | **不同源**：renderer 那份是 `collectMentionNames`（消息里收集显示名），与 `candidates`（解析 `recipient_warning.candidates`）毫无关系。`candidates` 留在 `town/session/` |

**方案 §1.4 漏掉的第四份 `sessionPartition`**：`desktop/main/chat/session-recovery.ts:15`，参数类型是 `RecoveryConnection = {displayUrl, apiBase, token, secret}`。
体与 `tools/security.ts` 的相同。收敛办法：把 `common/loom-connection.ts` 的 `sessionPartition` 参数放宽成
`Pick<LoomConnection, 'displayUrl' | 'apiBase' | 'token' | 'secret'>`，`session-recovery.ts` 直接 import。

**`protocolFile`（`tools/security.ts:49`）谁在用**（方案标「未核实」）：**只有 `tests/tools-security.test.ts`**。
`app/protocol.ts` 有自己的 `beings://desktop` 处理，不用它。结论：`protocolFile` 留在 `tools/security.ts`，该文件收敛后只剩它。

**BeingDesktop 0.8.26 真实依赖版本**（方案对 node-pty 标「未核实」，猜的是 1.0.0）：
`node-pty 1.1.0`、`ws 8.21.3`、`@xterm/xterm 6.0.0`、`@xterm/addon-fit 0.11.0`、`electron-updater 6.8.9`。

## 进度

- [x] 读 integration-plan.md
- [x] 读真实代码（main/extensions/chat-ipc/preload/shared/renderer/architecture/构建配置）
- [x] 核实同源副本（含方案标「未核实」的三处）
