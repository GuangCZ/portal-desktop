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
- [x] §2.5 `main/common/` 四个模块 + 一次性收敛全部副本 + `tests/identity-partition.test.ts`
- [x] §2.1 子系统注册表 + chat 改造成第一个子系统 + `tests/subsystem-registry.test.ts`
- [x] §2.1 main.ts 注入 `electron` 门面（唯一一处改动）
- [x] §2.2 preload 每子系统一个 channels 文件
- [x] §2.3 shared 类型拆分为聚合器
- [x] §2.4 renderer 四个插槽 + model 注册表 + `tests/renderer-slots.test.ts`
- [x] §2.6 ws 提级、node-pty + xterm + auto-unpack-natives、`packagerIgnore`
- [x] §2.7 typecheck / vitest / architecture / prepare:desktop / **package 实测通过**
- [x] 记录（本文件 + MIGRATION.md「集成阶段 I0」）

---

## 接缝契约（给 I1–I7）

### A. 主进程子系统

**新增**：`desktop/main/subsystems/types.ts`（契约）、`desktop/main/subsystems/chat.ts`（第一个子系统，也是模板）。
**改写**：`desktop/main/extensions.ts` 变成注册表 + 生命周期扇出。`desktop/main/main.ts` 只有一处调用，**I0 之后任何单元都不得再改 main.ts**。

一个子系统文件固定长这样：

```ts
// desktop/main/subsystems/tools.ts
import type { DesktopSubsystem, SubsystemContext } from './types';
export interface ToolsSubsystem extends DesktopSubsystem { readonly link: DesktopToolLink }
declare module './types' { interface SubsystemMap { 'tools': ToolsSubsystem } }
export function installToolsSubsystem(ctx: SubsystemContext): ToolsSubsystem {
  // 只构造自己的实例；跨子系统引用一律存成惰性 getter
  const sessions = () => ctx.registry.get('chat')?.sessions ?? null;
  ...
  return { key: 'tools', link, connectionVerified(c) {...}, async quitting() {...} };
}
```

**铁律**：install 的同步体里**不得** `ctx.registry.get(...)` 取值，只能把它包成 `() => ctx.registry...` 的闭包。
chat → orchestration → tools → orchestration → chat 是个环，任何构造期解引用都会拿到 `null`。
`tests/subsystem-registry.test.ts` 用两个假子系统把「两种安装顺序都能解析」钉住了。

`SubsystemContext` 的成员：
`handle`（main.ts 的 `createTrustedHandle` 产物，自带来源校验 + quitting 守卫）、`exclusive`（串行队列）、`window()`、
`store`（`SubsystemSettings`）、`electron`（`ElectronBindings` 门面）、`userData`、`desktopId`、`clientVersion`、`fetchImpl`、
`onError(scope, error)`、`registry`、`push(channel, payload)`（**窗口守卫已经在里面**，子系统不必自己判断 destroyed）。

`DesktopSubsystem` 可选实现 `connectionVerified(connection)`（**同步，不得 await `exclusive`**，它自己就跑在 exclusive 里）、
`connectionCleared()`、`quitting()`、`ready`。扇出规则：verified / cleared 按安装顺序，quitting 逆序；任何一个抛错只记 `onError`，不打断其余。
安装抛错记 `subsystem-install:<函数名>`，不影响其它子系统。

`SubsystemSettings` 与方案 §2.1 的**偏差**：方案写的是一个 `settings: Settings & Record<string, unknown>`；
真实的 `SettingsStore.settings` 只有类型化的那半，未知键在私有 `disk` 里。于是拆成两个成员：
`settings: Settings` 与 `extras: Readonly<Record<string, unknown>>`，外加 `saveExtra(patch)`（合并进 settings.json，保留其它所有键，值为 `undefined` 即删键）。
`SettingsStore` 新增了 `extras` getter 与 `saveExtra`。**I6 的侧栏 / 编排设置写盘走这两个，不要给 `Settings` 加字段**（0.8.x 不认识）。

`ElectronBindings` 里 `WebContentsView` / `session` / `net.request` 是 `unknown`：给它们真实类型会逼每个建上下文的测试造一个真 electron 类。
需要它们的单元（I3 的工具浏览器、I7 的 Portal 窗口）在使用处 `as` 一次并写明理由。
`clipboard` 是 **Promise 形态**（`readText(): Promise<string>`）——Electron 44 实测如此，不是文档推断。

### B. preload 通道

**新增**：`desktop/preload/channels/bridge.ts`（`subscribe` / `enveloped` 两个助手）、`channels/chat.ts`、`channels/index.ts`。
`desktop/preload/desktop-channels.ts` 保留为 re-export（一个版本），`preload.ts` 的 `isMainFrame` 守卫原样不动，且**不会再变**（它 spread `desktopChannels`）。

### C. shared 类型

`desktop/shared/desktop-types.ts` 变成聚合器，原内容搬到 `desktop/shared/chat-types.ts`。
各单元建自己的 `desktop/shared/<key>-types.ts`，在聚合器加一行 `export *`。
**类型名不能撞车**：`export *` 撞名是静默丢弃，按 `Chat*` 的做法给自己的类型加前缀。

### D. renderer 插槽

**新增**：`desktop/renderer/app/slots.tsx`（`PANEL_SLOTS` / `SIDEBAR_SLOTS` / `TOPBAR_SLOTS` / `SHEET_SLOTS` 四个数组 + 四个读取函数）、
`desktop/renderer/app/models/registry.ts`（`FEATURE_MODELS` + `AppFeatureModels`）。
`page.tsx`（`<Browser>` 之后挂面板、`<Town>` 之后挂 sheet）、`sidebar.tsx`（head / scroll / foot 三处）、`topbar.tsx`（`topbar-actions` 开头）
已经接好，**这三个文件后续单元不需要再改**。
`AppModel` 新增 `readonly features`，构造末尾建全部注册 model（单个抛错只 toast，不阻断），`start()` 里把每个 model 的 `subscribe` 接进 `changed()`。

排序是 `order` 升序、同 order 按 `key` 字典序，所以数组里的位置没有语义；`order` 请用百位（100、200…）留空隙。
插槽组件自带边框、空态与错误处理，壳层只负责 mount。`tests/renderer-slots.test.ts` 钉住了这些规则。

### E. 六个一行式冲突点（后续单元只允许在这些文件里 append）

| 文件 | 加什么 |
| --- | --- |
| `desktop/main/extensions.ts` | 一行 `import { installXSubsystem } from './subsystems/x';` + `INSTALLERS` 里一行 `installXSubsystem,` |
| `desktop/preload/channels/index.ts` | 一行 `import { x } from './x';` + `desktopChannels` 里一行 `x,` |
| `desktop/shared/desktop-types.ts` | 一行 `export * from './x-types';` |
| `desktop/shared/types.ts` | `DesktopAPI` 的注释块内一行 `x: XAPI;`（按字母序排在 `chat` 之后） |
| `desktop/renderer/app/slots.tsx` | 一行 import + 对应数组里一行条目 |
| `desktop/renderer/app/models/registry.ts` | 一行 import + `FEATURE_MODELS` 里一行条目 |

**只有 I0 能改**：`desktop/main/main.ts`、`package.json`、`forge.config.ts`、`vite.*.config.ts`。
需要新依赖（比如 I3 若还缺什么）就回到 I0 补一次，不要在自己的单元里改这四处。
`DesktopSubsystem` 接口若要加成员（比如 §3.4 提到的 `linked?()`），同样回 I0。

### F. `desktop/main/common/`（共享正式实现）

| 文件 | 导出 |
| --- | --- |
| `common/sanitize.ts` | `sanitizeText(value, secrets?: readonly unknown[])` |
| `common/platform.ts` | `desktopPlatform`、`desktopEnvironment`、`shellPath`、`consoleEnvironment`、`WINDOWS_RUNNER`、`DesktopPlatformInfo` |
| `common/loom-connection.ts` | `parseConnection`、`sessionPartition`、`endpoint`、`publicModelUrl`、`allowedNavigation`、`LoomConnection`、`ConnectionIdentity` |
| `common/message-context.ts` | `desktopMessageContext`、`DESKTOP_PORTAL_NAME`、`DesktopRuntime`、`DesktopMessageContextOptions` |

**偏差（与方案 §2.5 的分步走不同）**：方案让 I0 只建文件、各单元自己删副本。本次按任务要求**在 I0 里一次收敛完**——
副本全部删除、导入全部改指 `common/*`，所以 I1–I5 的 PR 里**不再有「删除自己的副本」这一步**（他们 rebase 后基线已经是收敛后的）。
已删除：`town/session/sanitize.ts`、`town/channel/sanitize.ts`、`town/channel/loom-connection.ts`、
`tools/platform.ts`、`tools/terminal/platform.ts`、`tools/message-context.ts`、`chat/context.ts`、`orchestration/vendored.ts`。
`tools/security.ts` 只剩 `protocolFile`（核实过：除 `tests/tools-security.test.ts` 外无人使用）。
`tools/console.ts` 去掉了内联的 `ENVIRONMENT_KEYS` / `consoleEnvironment` / `WINDOWS_RUNNER`。
`chat/titles.ts` 去掉了本地 `sanitizeText`。`chat/session-recovery.ts` 改 import `common` 的 `sessionPartition`。

`tests/architecture.test.ts` 新增一条：`main/common/` 只能 import node 内建与自己目录内的文件。
往 `common/` 加东西前先想清楚——它是所有单元的公共底座。

**仍留在原地、不要合并**的三份 SSE 解析（`town/session/client.ts` 的 `consumeEvents`、`town/channel/sse.ts`、`chat/being-chat.ts` 的 `consumeEvents`）：
上限与错误码语义不同（Town 1MB + `INVALID_RESPONSE`；chat 自带码表），u3 已实测 `data:null` 必须原样传。

### G. 身份字符串（磁盘格式）

`beingIdentityKey(address)` 现在是 `sessionPartition(parseConnection(address))` 的一行代理。
`tests/identity-partition.test.ts` 用七个 BeingDesktop 夹具地址（含 `api=`、`relay_secret=`、`secret=` 别名、路径尾斜杠、http 回环）
把两个入口与**写死的 32 位十六进制常量**钉在一起。改动 `common/loom-connection.ts` 时这条会先炸——它就是干这个的。

### H. 依赖与打包（**本节含一个推翻方案的实测结论**）

`ws` 8.21.3、`node-pty` 1.1.0、`@xterm/xterm` 6.0.0、`@xterm/addon-fit` 0.11.0 都进了 `dependencies`（版本与 BeingDesktop 0.8.26 一致）；
`@electron-forge/plugin-auto-unpack-natives` ^7.11.2 进 devDependencies 并挂进 `forge.config.ts`；
`vite.main.config.ts` 的 external 从 `['electron']` 变成 `['electron', 'node-pty', 'ws']`。

**方案 §2.6 的前提是错的，实测推翻**：方案说「@electron/packager 默认 prune devDependencies，所以把 ws 挪到 dependencies 就能进 asar」。
真实情况是 `@electron-forge/plugin-vite` 的 `resolveForgeConfig` 把 `packagerConfig.ignore` 设成
`file => !file.startsWith('/.vite')`（`node_modules/@electron-forge/plugin-vite/dist/VitePlugin.js:114-131`），
于是 **node_modules 整棵树根本不进包**——第一次打包出来的 asar 只有 15 个条目，一个 node_modules 都没有。
提级到 dependencies 是必要条件，不是充分条件。

修法：`forge.config.ts` 自己提供 `packagerConfig.ignore`（插件检测到已有 ignore 就不覆盖），
即 `packagerIgnore`：放行 `/.vite`、放行 `/node_modules` 目录本身、放行 `PACKAGED_MODULES = ['ws', 'node-pty', 'node-addon-api']` 三个模块，
其余一律 ignore。
`@electron/packager` 的 `copy-filter.js:90-95` 对 node_modules 下**模块根目录**走 pruner（生产依赖图），对模块内的文件才走用户 ignore ——
所以 react / marked / tar 这些还会留下一个空目录条目，内容不会进包。

**打包实测（本机，2026-09-16，`PORTAL_DESKTOP_MAC_LOCAL_TEST=1` + 临时 stub heart-portal）**：

- `npm run package`（即 `electron-forge package`）在 darwin-arm64 上**全绿**。注意 npm 必须绕过代理，否则 Electron 下载会 TLS 失败。
- `node-pty` 1.1.0 自带 N-API prebuilds（darwin-arm64 / darwin-x64 / win32-x64 / win32-arm64），本机安装**不需要** node-gyp 编译。
  但 Forge 打包时仍会跑 `@electron/rebuild`（日志里的「Preparing native dependencies」），它在**拷贝后的**目录里重建，
  产出 `build/Release/pty.node`（Electron ABI 149）——源码树里始终没有 `build/`，这是实测。
  因此 `binding.gyp`、`src/`、`deps/`、`third_party/` 必须跟着进包，不能过滤掉。
- `node-pty` 的 prebuilds 有 58 MB（四平台）。`packagerIgnore` 只放行 `prebuilds/<打包主机平台>-*`，asar 从 63 MB 降到 **7.1 MB**。
  跨平台打包原生模块本来就不可行，CI 三平台各自打自己的包。
- 用干净的 Electron 44.2.0 以 `ELECTRON_RUN_AS_NODE=1` 对打出来的 asar 实测：
  `require('ws')` → `app.asar/node_modules/ws/index.js` ✅；`require('node-pty')` → `app.asar/node_modules/node-pty/lib/index.js` ✅；
  `loadNativeModule('pty').dir` → `../build/Release/`（落在 `app.asar.unpacked/`）✅。
  `pty.spawn` 在 `ELECTRON_RUN_AS_NODE` 模式下报 `posix_spawnp failed.`——那是 node 模式下 helper 路径的问题，**不是打包问题**，
  真正的 spawn 冒烟留给 I3 在真实应用里做。
- Linux **没有** node-pty prebuild，`MakerZIP` 的 linux 目标需要构建机上有 python3 + make + g++。本次没验证。

`tests/packaging-contract.test.ts` 把这一整套钉住了：依赖位置与固定版本、main bundle 的 external、
auto-unpack-natives 真的产出 `*.node` 的 unpack 规则、`packagerIgnore` 的每一条放行与拦截。
这是 typecheck 与 vitest 都看不见的那部分，改 `forge.config.ts` / `vite.main.config.ts` / `package.json` 时它会先炸。

`scripts/prepare-desktop.mjs` 的三方许可证清单补了 `ws`、`node-pty`、`@xterm/xterm`、`@xterm/addon-fit`。

### I. 核实过的、与方案不同的点（汇总）

| 方案的说法 | 实测 |
| --- | --- |
| §2.6「ws 提级即可进 asar」 | 错。plugin-vite 把整个 node_modules 排除在外，必须自己写 `packagerConfig.ignore`（见 H） |
| §2.6「node-pty 版本未核实，猜 1.0.0」 | 实际 BeingDesktop 0.8.26 用 **1.1.0** |
| §2.6「三平台各自需要构建工具链」 | darwin / win32 有 N-API prebuild，安装不需要；打包仍会跑 electron-rebuild（本机 Xcode CLT 已满足）。Linux 确实需要 |
| §1.4「`desktopMessageContext` 两份未逐行比对」 | 去空白后**逐字节相同**（4626 字节） |
| §1.4「`candidates` 与 renderer `mentions.ts` 未核实是否同源」 | **不同源**。renderer 那份是 `collectMentionNames`，两者无关；`candidates` 留在 `town/session/` |
| §1.4「`protocolFile` 未核实谁在用」 | 只有 `tests/tools-security.test.ts`。留在 `tools/security.ts` |
| §1.4 副本清单 | **漏了第四份 `sessionPartition`**：`chat/session-recovery.ts:15`。已一并收敛（`common` 的 `sessionPartition` 参数放宽成 `ConnectionIdentity`） |
| §2.1 `SubsystemSettings.settings` 是交叉类型 | 拆成 `settings` + `extras` + `saveExtra`（见 A） |
| §2.1 `ElectronBindings.clipboard` 是同步的 | Electron 44 是 **Promise 形态** |
| §2.1 `connectionCleared` 生命周期 | 接口与扇出都在，但 **main.ts 从来没有调用过它**。既有缺口，I0 原样保留 |
| §2.5 分步收敛（I0 只建文件） | 按任务要求一次收敛完（见 F） |
| §2.7「architecture 六条」 | 既有六条按目录模式写，新目录自动覆盖，不需要改；另补了两条（`common/` 的依赖边界、`subsystems/` 不得 import electron），现在是八条 |
