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

## 3. 进度

- [x] 读方案 §3 约定 / §3.6 / §2.1 / §2.4 / §1.2 / §4 / 附录

## 4. 决定与偏差

（待填）

## 5. IPC 通道清单

（待填）
