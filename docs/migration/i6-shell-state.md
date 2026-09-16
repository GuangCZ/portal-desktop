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

## 4. 决定与偏差

（待填）

## 5. IPC 通道清单

（待填）
