# I6 · 侧栏持久化 + 关于/隐私

集成单元 I6（并行组 A）。worktree `.local/i6-shell-state`，分支 `i6-shell-state`，基线 `next @ 9794cab`。
日期 2026-09-16。

## 1. 范围（按定案 5.3 收窄）

做：
1. 侧栏元数据（置顶 / 归档 / 项目归属 / 项目列表）搬回主进程，按 Being（`sessionPartition`）分桶持久化。
2. 关于 Being / 隐私说明两个静态页。
3. SBS **只读**显示（读 `runtime.sideBySide`，不做开关）。

不做（属并行组 B 的 I6b，且不留半成品文件）：模型设置、`PROVIDERS`、`/api/llm/config` 通道、SBS 开关、
`desktop/main/shell/model-config.ts`、`desktop/renderer/settings/components/model-settings.tsx`、
`desktop/renderer/settings/models/model-settings.ts`、`tests/shell-state-model-config.test.ts`。

## 2. 阅读摘要

### `scratchpad/integration-plan.md` §3 统一约定 / §3.6 / §2.1 / §2.4 / §1.2 / §4 / 附录索引

- 统一约定：独占目录只本单元动；共享文件只允许 append 一行（import + 数组/对象项）；
  IPC `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  注入替身形状与生产一致（类实例）；协议行为以实测文档为准。
- §3.6 独占新文件（本单元按 5.3 收窄后）：`desktop/main/shell/sidebar-state.ts`、`desktop/main/subsystems/shell-state.ts`、
  `desktop/main/shell/ipc.ts`、`desktop/preload/channels/shell-state.ts`、`desktop/shared/shell-state-types.ts`、
  `desktop/renderer/settings/components/{sbs,about,privacy}.tsx`、`tests/shell-state-*.test.ts`。
- §3.6 IPC：`sidebarAction` → `beings:sidebar-action`（串行）；`selectSavedProject` → `beings:sidebar-project-select`（串行）；
  `selectWorkspace` 复用既有 `beings:choose('workspace')` + `beings:save`，选中目录**加入** `sidebar.projects`；
  `beings:snapshot` 增加 `sidebar` 字段 `{scope, projects, tasks:{[id]:{pinned,archived,project,touchedAt}}}`。
- §3.6 renderer：`OrganizerModel` 改「主进程为真值、渲染层只投影」——`metadata()` 读 `snapshot.sidebar.tasks`，
  `pin/archive/move` 调 IPC 等新 snapshot；`projects` 从单一 `settings.workspace` 改为 `snapshot.sidebar.projects` 数组 + 「添加项目文件夹」入口。
- §2.1：`SubsystemContext` 提供 `handle` / `exclusive` / `window()` / `registry` 惰性 getter；
  `SubsystemSettings.saveExtra(patch)` 是「未知字段原样保留的保存通道」，**I6 的侧栏写盘走这里**。
- §2.4：renderer 四个插槽数组 + `FEATURE_MODELS` 注册表，每单元一行。
- §1.2：存在真实环，破环只能靠 `ctx.registry` 惰性 getter。
- §4：合回顺序 I3 → I2 → I4 → I1 → I6；I6 与 I1 都动 `sidebar.tsx` / `settings.tsx` 周边，故排在 I1 之后。
- 附录：I6 独占目录 `main/shell/`、`main/subsystems/shell-state.ts`、`renderer/settings/`。

### `docs/migration/i0-seams.md`（接缝权威说明）

- `SubsystemContext` 成员：`handle`（自带来源校验 + quitting 守卫）、`exclusive`、`window()`、`store`（`SubsystemSettings`）、
  `electron`、`userData`、`desktopId`、`clientVersion`、`fetchImpl`、`onError(scope, error)`、`registry`、`push(channel, payload)`（窗口守卫已在内部）。
- **与方案 §2.1 的偏差（权威）**：`SubsystemSettings` 不是 `Settings & Record<string, unknown>`，而是拆成
  `settings: Settings` + `extras: Readonly<Record<string, unknown>>` + `saveExtra(patch)`（合并进 settings.json，保留其它键，值 `undefined` 即删键）。
  **I6 的侧栏写盘走 `extras` / `saveExtra`，不给 `Settings` 加字段**（0.8.x 不认识）。
- 铁律：install 同步体内不得 `ctx.registry.get(...)` 取值，只能包成闭包。
- `DesktopSubsystem` 可选实现：`linked()`（全部 installer 跑完后同步跑一趟，惰性规则的唯一例外，用于赋值）、
  `connectionVerified(connection)`（**同步，不得 await `exclusive`**）、`connectionCleared()`、`quitting()`、`ready`。
- 六个一行式冲突点与「只有 I0 能改」的清单：`main.ts`、`package.json`、`forge.config.ts`、`vite.*.config.ts`、
  `subsystems/types.ts` 的接口成员、`renderer/app/models/app.ts`。
- shared 类型：`desktop-types.ts` 是聚合器，各单元建自己的 `<key>-types.ts` 加一行 `export *`；**类型名必须加前缀防撞车**（`export *` 撞名静默丢弃）。
- renderer 插槽：`page.tsx` / `sidebar.tsx` / `topbar.tsx` 已接好，后续单元不改；插槽组件自带边框与空态；
  `order` 用百位留空隙；feature model 的订阅/定时器一律放 `start()` 并返回关闭函数。
- `common/` 已在 I0 一次收敛完（`sanitize` / `platform` / `loom-connection` / `message-context`），各单元不再有「删副本」步骤。
- `tests/architecture.test.ts` 强制分层；`main/common/` 只能 import node 内建与同目录文件。

### 接缝真实代码（`subsystems/types.ts`、`extensions.ts`、`subsystems/chat.ts`、`preload/channels/{index,bridge,chat}.ts`、`app/slots.tsx`、`app/models/registry.ts`、`shared/desktop-types.ts`）

- `extensions.ts`：`INSTALLERS` 只有 `installChatSubsystem`；`installSubsystems(ctx, installers)` 导出供测试注入假子系统；
  `store` 是对 `ExtensionSettings` 的 getter 包装，`saveExtra` 缺省时 reject「设置暂时无法写入，请重启客户端后重试。」。
- `subsystems/chat.ts` 是模板：`declare module './types' { interface SubsystemMap { 'chat': ChatSubsystem } }`，
  `registerChatIpc({handle, exclusive, sessions, blocked})`，`chatPush(() => ({ send: ctx.push }))`。
- preload `bridge.ts` 提供 `subscribe<T>(channel, cb)` 与 `enveloped<T>(channel, ...args)`（包络转 Error）。
- `slots.tsx`：四个空数组 + `visiblePanels/sidebarSections/topbarActions/viewSheets`；排序 `order` 升序、同 order 按 `key`。
- `registry.ts`：`FeatureModel = Store & { start?(): () => void }`，`create(api, app)` 的 `app` 是 `unknown`，**构造期不得读 app 状态**。
- `desktop-types.ts` 只有 `export * from './chat-types';`。

### `desktop/renderer/conversation/models/organizer.ts`（现状，本单元要改）

- `entries: Map<string, SessionMetadata>` 内存态 + `EMPTY`；`projects: string[]` 由 `sidebar.tsx` 的 effect 从 `snapshot.settings.workspace` 灌入单项。
- 导出 `basename`、`touched`、`age`、`SessionGroups`、`OrganizerModel{metadata,setProjects,pin,archive,move,forget,ordered,groups,search}`。
- 文件头已写明「DEVIATION：0.8.26 把这份元数据放主进程按 Being 分桶持久化（`sidebarAction`，src/main.cjs 1139），本壳层暂放内存」——本单元就是来还这笔账的。
- `groups()`：pinned 优先；`projects` 按 `this.projects` 顺序；`standalone` 是「不 pinned 且 project 不在 projects 列表里」的；archived 全部排除。
- `sidebar.tsx` 消费点：`organizer.metadata/pin/archive/move/projects/groups/search`，`ProjectGroup` 的折叠是组件内 `useState(true)`，
  新建会话后 `conversation.create().then(id => organizer.move(id, project.path))`。

### BeingDesktop 0.8.26 源（只读）

**`src/sidebar-state.cjs`（37 行，逐行移植的对象）**

- `validPath(value)`：string && ≤4096 && 无 `\x00-\x1f` && （posix 绝对 或 win32 绝对）。
- `sidebarState(saved, scope, workspace='')`：
  `projects = [...new Set((Array.isArray(saved?.projects) ? saved.projects : [workspace]).filter(validPath))].slice(0,100)`
  ——**只有 `projects` 字段缺失时才回退到 `[workspace]`**，空数组不回退（`remove-project` 后不会把工作区加回来）。
  `tasks` 取 `saved.owners[scope].tasks` 的前 10000 项，键必须匹配 `/^[0-9a-f-]{36}$/i`，值必须是对象；
  归一化成 `{pinned: v.pinned===true, archived: v.archived===true, project: projects.includes(v.project)?v.project:'', touchedAt: Number.isFinite(v.touchedAt)?v.touchedAt:0}`
  ——未知字段（如 `credential`）被丢弃，输入对象不被改动。`scope` 为空时 `tasks` 为 `{}`。
- `updateSidebar(saved, scope, workspace, action, sessionIds=[], now=Date.now())`：
  首行守卫 `if (action?.scope !== scope || (!scope && action.type !== 'remove-project')) throw new Error('连接已变化，请重试。')`
  ——**未连接（scope 为空）时只允许 `remove-project`**。
  `remove-project`：项目必须存在（否则 `项目不存在。`），移除后把该项目下的任务 `project` 清空。
  其余：`id` 必须是 UUID 且在 `sessionIds` 里（否则 `会话不存在。`）；
  `pin` 取反且置顶时清 `archived`；`archive` 取反且归档时清 `pinned`；
  `move` 的 `project` 必须是 `''` 或已存在项目（否则 `项目不存在。`）；`touch` 写 `touchedAt=now`；其它 `侧栏操作无效。`。
  返回 `{...saved, projects, owners: scope ? {...saved?.owners, [scope]:{tasks}} : {...saved?.owners}}`。

**`test/sidebar-state.test.cjs`（5 个 test）**：身份隔离 + 陈旧请求拒绝；归档保留项目归属且可逆；非法项目拒绝 + 删项目保留任务；
读取归一化不改动入参（含 `credential:'never exposed'` 被丢弃、`'C:\\work'` 被 win32 认成绝对路径、`relative` 与 `/bad\0path` 被剔除）；
未连接时删除当前项目不会被工作区回退加回来。

**`src/main.cjs` 装配段**
- 140：`serialized.add('sidebarAction')`；141：`serialized.add('selectSavedProject')`。
- 567（`publicState`）：`sidebar: sidebarState(disk.sidebar, connection ? sessionPartition(connection) : '', state.workspace.path)`。
- 569：`saveSidebarAction(action, ids = state.chatSessions?.items.map(i=>i.id) || [])`——写 `disk.sidebar` → `persist()`，**失败回滚 `disk.sidebar=previous` 再抛**。
- 574：`selectSavedProject(selected)`——先校验 `sidebarState(disk.sidebar,'',workspace).projects.includes(selected)`（错误文案「项目不存在，请重新选择文件夹。」），
  再 `safeListWorkspace`，再写 `disk.workspace` + persist（失败回滚）。
- 1139：`handle('sidebarAction', async action => { await saveSidebarAction(action); broadcast(); return publicState(); })`。
- 1140：`handle('selectSavedProject', async selected => { await selectSavedProject(selected); broadcast(); return publicState(); })`。
- 1491（`selectWorkspace`）：`disk.sidebar={...disk.sidebar, projects:[...new Set([...sidebarState(disk.sidebar,'',state.workspace.path).projects, selected])]}` 再写 `disk.workspace`，persist 失败整体回滚。

**`docs/interfaces.md`**：§1「工作区与侧栏」四行（`selectWorkspace` / `listWorkspace` / `openWorkspace` / `sidebarAction` / `selectSavedProject`）；
§2 模块表 332 行 `sidebar-state.cjs` 的导出面；§3 状态表 361 行 `sidebar` 字段 = `{scope, projects, tasks:{[id]:{pinned,archived,project,touchedAt}}}`；
353 行 `runtime.sideBySide:{configured, active}`；513 行 settings.json 有 `sidebar{projects[], owners{[scope]:{tasks}}}`（本壳层落在 `extras.sidebar`，同名同形）。

### 本壳层的真实代码（决定了下面的四条偏差）

- `desktop/main/main.ts:342` 的 `snapshot()` 是 `{settings, desktopId, portal, background, notice}`——**`beings:snapshot` 的构造点在 main.ts 里，而 main.ts 是 I0 之后任何单元都不得修改的文件**。
- `desktop/shared/types.ts` 的 `Settings.workspace` 是 **Portal 工作目录**（对应 BD 的 `managedPortal.workspace` / `portalWorkspace`）；
  BD 的顶层 `workspace`（Desktop 项目目录，也就是 `sidebarState` 的第三个参数）在本壳层叫 `Settings.projectWorkspace`，注释写着「读入并保留，本壳层尚未使用」。
- `beings:save`（main.ts:441）会重新验证连接并跑 Portal 接管/重启；`beings:choose('workspace')`（main.ts:475）只是一个目录对话框，没有副作用。
- `desktop/main/app/settings.ts` 的 `SettingsStore.extras` / `saveExtra(patch)` 已经就位，注释明确「侧栏账本走这里，不要给 `Settings` 加字段」；
  `merge()` 的注释也把 `sidebar` 列进「本客户端不拥有、原样保留」的键——**BD 的 `settings.json` 里就是 `sidebar{projects[], owners{[scope]:{tasks}}}`，键名与形状可以直接复用**。
- `runtime` 在本壳层**根本不存在**：`chat/ready.ts` 只读 `/api/status` 的 `being_name`，读完即丢；`sideBySide` 在 BD 里唯一的来源是 `/api/llm/config` 的 `sbs_enabled`（`src/runtime.cjs:22`）。
- `tests/conversation-model.test.ts` 有 7 条既有测试直接同步调用 `organizer.pin/move/archive/setProjects`（且用 `"new"`、`"old"` 这样的非 UUID id），
  它们一条都不能删或弱化——`OrganizerModel` 必须在「未绑定主进程」时保持原来的同步内存行为。
- `tests/architecture.test.ts`：renderer 不得 import main/preload/node/electron，也不得出现 `fetch`/`WebSocket` 等标识符；
  `main/common/` 只能 import node 内建；`main/subsystems/` 不得 import electron。

## 3. 进度

- [x] 读方案 §3 约定 / §3.6 / §2.1 / §2.4 / §1.2 / §4 / 附录
- [x] 读 `docs/migration/i0-seams.md`
- [x] 读接缝真实代码（subsystems / preload channels / slots / registry / desktop-types）
- [x] 读 `renderer/conversation/models/organizer.ts` 与 `renderer/app/components/sidebar.tsx`
- [x] 读 BD `test/sidebar-ui.cjs`（BD 规则集）、BD `renderer/sidebar.js`、BD `src/runtime.cjs`
- [x] 读本壳层 `main/main.ts` 装配段、`app/settings.ts`、`app/ipc.ts`、`shared/types.ts`、`app/models/app.ts`、`app/page.tsx`、`app/components/settings.tsx`、`tests/architecture.test.ts`
- [x] 读 BD `src/sidebar-state.cjs`、`test/sidebar-state.test.cjs`、`src/main.cjs` 装配段、`docs/interfaces.md` §1/§2/§3
- [x] `desktop/main/shell/sidebar-state.ts` 逐行移植 + `tests/shell-state-sidebar.test.ts`（8 条）
- [x] `desktop/main/shell/ipc.ts`、`desktop/main/subsystems/shell-state.ts`、`desktop/preload/channels/shell-state.ts`、`desktop/shared/shell-state-types.ts`
- [x] `tests/shell-state-ipc.test.ts`（5 条，真 `SettingsStore` + 真 `createTrustedHandle` + 真注册表）
- [x] `OrganizerModel` 改投影 + `desktop/renderer/settings/models/shell-state.ts` + `tests/shell-state-renderer.test.ts`（8 条）
- [x] 关于 / 隐私静态页（`renderer/settings/components/{about,privacy,entry}.tsx` + `renderer/settings/styles.css`），挂在侧栏底部插槽
- [x] `sidebar.tsx` 接线：右键菜单走 IPC、项目菜单、添加项目文件夹、`data-task-id`、两个主入口 id
- [x] `tests/sidebar-e2e.mjs`（Playwright + 真 renderer/preload/reducer，8 条 check，本机已跑通）
- [x] 门槛：typecheck 通过；`npx vitest run` 1092 通过 / 58 跳过（基线 1071 / 58，本单元 +21）
- [ ] **未做**：SBS 只读显示（原因见 §4.5）

## 4. 决定与偏差

### 4.1 `beings:snapshot` 不加 `sidebar` 字段（与方案 §3.6 的表格不同）

方案要求「`beings:snapshot` 增加 `sidebar` 字段」。真实代码里这个快照是 `desktop/main/main.ts:342` 的
`const snapshot = () => ({ settings, desktopId, portal, background, notice })`——而 `main.ts` 是 I0 之后**任何单元都不得修改**的文件
（i0-seams §E）。没有任何不改 main.ts 就能往这个对象里加字段的办法（`SettingsStore.settings` 是类型化的那半，`extras` 不进快照）。

于是本单元给自己开了一条读通道 `beings:sidebar-state` 与一条推送 `beings:sidebar`，语义与 BD 的
「`publicState().sidebar` + `broadcast()`」完全一致——只是不搭 `Snapshot` 的车。
`desktop/shared/types.ts` 的 `Snapshot` 因此**没有**新增 `sidebar?:` 字段：一个永远是 `undefined` 的可选字段，比没有更糟。
`ShellSidebarState` 仍然按要求放在 `desktop/shared/shell-state-types.ts` 并在 `desktop-types.ts` re-export 一行。

### 4.2 项目文件夹不再是 `settings.workspace`

方案写的是「`selectWorkspace` 既有 `beings:choose('workspace')` + `beings:save`，选中目录加入 `sidebar.projects`」。
在本壳层 `Settings.workspace` 是 **Portal 工作目录**（`app/settings.ts` 的注释与 `portalWorkspaceOf` 写得很清楚），
而 `beings:save` 会重新验证连接并跑 Portal 接管/重启（`main.ts:441`）——从侧栏加一个项目文件夹去重启 Portal 是不可接受的。

因此：
- 侧栏的项目列表完全住在账本里（`extras.sidebar.projects`，BD 同一个键）；
- 「添加项目文件夹」= `beings:choose('workspace')`（纯目录对话框，无副作用）+ 本单元的 `beings:sidebar-project-add`；
- `sidebarState(saved, scope, workspace)` 的 `workspace` 回退参数取 `settings.projectWorkspace`（BD 的顶层 `workspace`，本壳层此前「读入并保留但未使用」），
  这样 0.8.x profile 的项目目录第一次打开时仍然出现在侧栏。
- `addSidebarProject` 是 `main/shell/sidebar-state.ts` 里新增的函数（BD 把这段合并逻辑内联在 `src/main.cjs:1491` 的 `selectWorkspace` 里），
  `updateSidebar` 的动作集保持 BD 原样，一条没加。

副作用：`beings:choose('workspace')` 的系统对话框标题是 main.ts 写死的「选择 Being 工作目录」，加项目文件夹时标题略不贴切；改标题要改 main.ts，本单元不改。

### 4.3 没有 `beings:sidebar-project-select`（BD 的 `selectSavedProject`）

BD 的 `selectSavedProject` 做两件事：校验目录在 `sidebar.projects` 里，然后**切换工作区**让文件浏览器与控制台从那里开始
（`renderer/sidebar.js:171` 的项目菜单项就叫「浏览文件」）。本壳层没有文件浏览页，`workspace` 页是场景面板不是文件树；
唯一能被「切换」的 `settings.workspace` 是 Portal 的工作目录。所以这条通道在本壳层没有可对应的行为，没有注册。
项目菜单只保留「新会话」与「从侧栏移除项目」。

### 4.4 `OrganizerModel` 的两种模式

「主进程为真值、渲染层只投影」只在**绑定了账本**时成立。未绑定时（没有 bridge 的窗口、以及 `tests/conversation-model.test.ts`
里 7 条既有测试）它保持原来的同步内存行为，并且本地分支复刻了 reducer 的互斥规则（置顶清归档、归档清置顶），两条路径的语义一致。
既有测试因此一条没改、一条没删。

绑定后**不做乐观更新**：`pin/archive/move/touch/remove-project` 都是「发出去 → 等主进程答复 → 用答复重画」，
被拒绝（连接已变化 / 写盘失败）时侧栏保持已保存的样子，与 BD `renderer/sidebar.js:36` 的 `mutate` 同义。

### 4.5 SBS 只读显示：**没做**，并且不是靠缩范围绕过去的

任务书要求「SBS 只读显示（读 `runtime.sideBySide`）」，同时禁止「`/api/llm/config` 通道」（属 I6b）。这两条在真实代码上互斥：

- 本壳层的 `Snapshot` 里**根本没有 `runtime`**；`chat/ready.ts` 只读 `/api/status` 的 `being_name`，读完即丢。
- BD 里 `runtime.sideBySide.configured` 的唯一来源是 `/api/llm/config` 的 `sbs_enabled`（`src/runtime.cjs:22`、`:52`），
  `active` 只在已被删除的 Loom 页面消息 `beings:sbs-state` 里出现（`tests/sbs-refresh.mjs`）。

也就是说「只读显示」必须先有那条被禁止的通道。本单元的选择是：**不新建网络通道、不放半成品文件、不摆一个永远显示「未确认」的行**，
把这件事整件留给 I6b（它会同时带来通道与开关）。见 openIssues。

### 4.6 静态页的挂载方式

方案说「`ClientSettings` 里加三个分区」。`app/components/settings.tsx` 的三个 tab 的键盘导航是**逐 tab 复制粘贴**的硬编码
（`(0+1)%3`、`(1+1)%3`、`(2+1)%3`，三处各一份），加第四个 tab 要重写这三段——而 I1 也会动 `settings.tsx` 周边（方案 §4）。
本单元改为用 I0 给的插槽：`SIDEBAR_SLOTS` 的 `foot` 位置加一行，渲染「关于 · 隐私」两个入口和它们的对话框，
`settings.tsx` 一个字没改。BD 的入口也在侧栏底部的 profile 菜单里（`renderer/sidebar.js` 的 `profileMenu`），语义一致。

样式文件 `renderer/settings/styles.css` 由 `settings/components/entry.tsx` 自己 import（Vite 支持），
没有去改 `renderer/main.tsx`——那是壳层的文件。

### 4.7 身份分区从「已保存的地址」解析，而不是等 `connectionVerified`

实测：`SettingsStore.load()` 一读到 `credential` 就填好了 `connectionAddress`，所以账本在连接**被验证之前**就有正确的分桶，
侧栏一打开就是对的。BD 同理（`publicState()` 用的是 `restore()` 解析出来的 `connection`）。
`connectionVerified` / `connectionCleared` 仍然各推一次，用来在**切 Being** 时纠正渲染层手里的旧账本。

注意一个**既有缺口**（I0 已记录，不是本单元引入的）：`main.ts` 从来没有调用过 `extensions.connectionCleared()`。
所以「彻底断开 Being」时本单元的 `connectionCleared` 不会被触发；切换到另一个 Being 走的是 `beings:save` → `verifyConnection` →
`connectionVerified`，这条路径是通的，也是验收项覆盖的那条。等哪个单元把 `connectionCleared` 接上，本单元不需要改一行。

## 5. IPC 通道清单

| BD | 本单元 | 约定 | payload | 返回 |
| --- | --- | --- | --- | --- |
| `sidebarAction(action)` 串行 | `beings:sidebar-action` | `ctx.exclusive`，非包络 | `{type:'pin'\|'archive'\|'touch', id, scope}` / `{type:'move', id, scope, project}` / `{type:'remove-project', project, scope}`；字段白名单，未知字段拒绝；`scope` ≤128 字符、`id` ≤64、`project` ≤4096 | `ShellSidebarState` |
| （`publicState().sidebar`） | `beings:sidebar-state` | 只读 | — | `ShellSidebarState` |
| （`selectWorkspace` 的合并段） | `beings:sidebar-project-add` | `ctx.exclusive`，非包络 | 绝对路径字符串（`validPath`，≤4096，无控制字符） | `ShellSidebarState` |
| `being:state` 广播 | `beings:sidebar`（推送，只发主窗口） | `ctx.push` 自带窗口守卫 | `ShellSidebarState` | — |
| `selectSavedProject` | **未实现** | — | — | 见 §4.3 |

装配点：`desktop/main/extensions.ts` 的 `INSTALLERS` 追加 `installShellStateSubsystem`；
子系统实现 `connectionVerified` / `connectionCleared`（各推一次账本），不实现 `linked` / `quitting`（没有要关的东西）；
写盘走 `ctx.store.saveExtra({ sidebar })`，读盘走 `ctx.store.extras.sidebar`，会话 id 走 `ctx.registry.get('chat')?.sessions`（惰性 getter）。

## 6. 共享文件触碰行（逐行）

| 文件 | 追加的行 |
| --- | --- |
| `desktop/main/extensions.ts` | `import { installShellStateSubsystem } from './subsystems/shell-state';` / `INSTALLERS` 内 `installShellStateSubsystem,` |
| `desktop/preload/channels/index.ts` | `import { shellState } from './shell-state';` / `desktopChannels` 内 `shellState,` |
| `desktop/shared/desktop-types.ts` | `export * from './shell-state-types';` |
| `desktop/shared/types.ts` | `import type { ShellStateAPI } from './shell-state-types';` / `DesktopAPI` 内 `shellState: ShellStateAPI;`（`chat` 之后，字母序） |
| `desktop/renderer/app/slots.tsx` | `import { ShellPagesSection } from '../settings/components/entry';` / `SIDEBAR_SLOTS` 内 `{ key: 'shell-pages', order: 900, placement: 'foot', Section: ShellPagesSection },` |
| `desktop/renderer/app/models/registry.ts` | `import { ShellStateModel } from '../../settings/models/shell-state';` / `FEATURE_MODELS` 内 `{ key: 'shellState', create: (api, app) => new ShellStateModel(api, app) },` |

**非一行式、但必须改的共享文件**（都是「既有断言随子系统落地而扩张」，没有删除或弱化任何一条）：

- `desktop/renderer/conversation/models/organizer.ts`：整文件改为投影（§4.4）。这是任务书点名要改的文件；I5 的 `renderer/conversation/` 增量会在它之上 rebase。
- `desktop/renderer/app/components/sidebar.tsx`：右键菜单改调 IPC、项目菜单、添加项目文件夹入口、`data-task-id`、`#new-chat-session` / `#sidebar-search` 两个 id、删掉原来从 `settings.workspace` 灌项目的 effect。
- `tests/chat-ipc.test.ts`：`CHANNELS` 追加本单元三条（那条断言是「`installDesktopExtensions` 注册的**全部**通道」）；
  推送断言从「每一条都是 `beings:chat-state`」改成「每一条都在 `{beings:chat-state, beings:sidebar}` 白名单内」——仍是闭集断言。
- `tests/renderer-slots.test.ts`：两条「ships empty」改成点名清单（第一条同时钉住 `FEATURE_MODELS` 与 `AppModel.features` 的键），
  第二条保留「注册表为空时壳层不凭空造 model」的性质。后续单元继续在这两处点名。

## 7. 验收

- `npm run typecheck`：通过。
- `npx vitest run`：**1092 通过 / 58 跳过**（基线 1071 / 58；本单元新增 21 条：ledger 8 + IPC 5 + renderer 8；没有重新启用任何 skip）。
- `node tests/sidebar-e2e.mjs`：**本机真跑通过**（Electron 44 真窗口 + 生产 renderer/preload + 生产 reducer）。8 条 check：
  `primary-entry-order`、`only-current-task-selected`、`pinned-task-only-once`、`pin-saved-to-disk`、
  `only-current-task-still-selected`、`fold-survives-state-update`、`metadata-swaps-with-the-being`、`no-script-errors`。
- `npm run start`（真机冒烟，本机已跑）：`electron-forge start` 用 Vite 构出 `main.js` 与 `preload.js`，客户端正常打开，
  日志里没有 `subsystem-install:*`、没有渲染层报错；唯一的两条 ERROR 是检查更新走代理时的 TLS 握手失败，退出时一条
  「客户端正在退出，请稍候。」是 quitting 守卫按预期拒绝了关窗过程中的 `beings:snapshot`。
  本机没有连接任何 Being，所以没有走到有会话的侧栏——那部分由 `tests/sidebar-e2e.mjs` 在真 Electron 窗口里覆盖。
- 手工验收项「置顶 → 重启 → 仍置顶」由 `tests/shell-state-ipc.test.ts`「a pin is written to the profile and is still there after a restart」
  自动化覆盖（真 `SettingsStore`，第二个客户端实例读同一个 settings.json）；
  「切 Being → 元数据换一套」由同文件的第三条与 e2e 的 `metadata-swaps-with-the-being` 覆盖。

## 8. 没做的事

1. **SBS 只读显示**（§4.5）——需要被本单元禁止的 `/api/llm/config` 通道，整件留给 I6b。
2. **模型设置 / PROVIDERS / SBS 开关**——按定案 5.3 属 I6b，本单元没有预留任何半成品文件。
3. **`beings:sidebar-project-select`**（§4.3）——本壳层没有可切换的项目工作区。
4. **`tests/sidebar-e2e.mjs` 没有 npm 脚本入口**：`package.json` 只有 I0 能改，`scripts/test-all.mjs` 也因此没有这一步。
   目前的跑法是 `node tests/sidebar-e2e.mjs`。合回后建议由 I0 补一行 `"test:sidebar": "node tests/sidebar-e2e.mjs"` 并加进 `test:all`。
5. **`npm run package` 后从产物启动**：本机没有 Rust 工具链（`cargo not found`、`resources/heart-portal` 不存在），
   与 I0 记录的情况相同，未做。本单元不碰 `package.json` / `forge.config.ts` / 原生依赖，打包面无改动。
