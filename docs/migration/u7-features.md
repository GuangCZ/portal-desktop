# u7-features — 功能任务账本迁移记录

单元范围：把 BeingDesktop 0.8.26 的 `src/feature-tasks.cjs`、`src/feature-task-runner.cjs`、
`src/feature-task-history.cjs`、`src/feature-task-discussion.cjs` 及其测试逐行移植为
portal-desktop 的 TypeScript（`desktop/main/features/*.ts` + `tests/features-*.test.ts`）。
只移植，不集成（IPC / renderer / main.ts 挂钩留给后续阶段）。

来源工作树（只读）：`/Users/d5c/Documents/ChatGPT/BeingDesktop`，移植日期 2026-09-16。

---

## 阅读摘要

### docs/architecture.md（§4 子系统表「功能任务账本」一行 + §6 持久化 + §8 并发约定）

- §4 表格行：子系统 `features`；入口对象 `FeatureTaskRunner`、`FeatureTaskHistory`（内含 `FeatureTasks`）；
  职责「把长任务记为可持久化的功能任务，按 Being 身份隔离」；关键不变量「身份切换时拒绝过期写入（`SESSION_CHANGED`）」。
- §4 前言：子系统之间不直接 require 对方实例；`main.cjs` 的 `boot()` 是唯一组合根，用回调注入上下文
  （`getContext`、`getConnection`、`fetchImpl`、`persist`、`onChange`），子系统只持有自己的状态并通过 `onChange` 触发 `broadcast()`。
- §6.1：高频/大体积数据不走 `being:state`，走专用通道，其中包含 `being:feature-tasks`。
- §6.2 磁盘布局：`feature-tasks/<sha256(identity)>.bin` = 功能任务账本，保护方式 safeStorage。
- §8.1 纪元校验：`generation`（连接）、`identityRevision`（身份分区）等在异步开始时捕获、完成时比对；
  过期结果静默丢弃，过期写入抛 `SESSION_CHANGED`。
- §8.2 串行化：`serialized` 集合内的 IPC 方法进入 `mutationTail` 逐个执行；
  **`FeatureTaskRunner` 为 `OPERATIONS` 表内的方法建账并用 `AsyncLocalStorage` 传递归属**。
- §8.5 先落盘再通知：终态/验收/展示状态先 `flush()` 再 callback 或推送。
- §8.6 定时器全部 `unref()`。

## 进度

| 模块 | 状态 |
| --- | --- |
| docs 摘要（architecture §4/§6/§8） | 已读 |
| docs/interfaces.md §3/§5/§7 | 未开始 |
| src/feature-tasks.cjs | 未开始 |
| src/feature-task-runner.cjs | 未开始 |
| src/feature-task-history.cjs | 未开始 |
| src/feature-task-discussion.cjs | 未开始 |
| test/feature-tasks.test.cjs | 未开始 |
| test/feature-task-runner.test.cjs | 未开始 |
| test/feature-task-history.test.cjs | 未开始 |
| test/feature-task-discussion.test.cjs | 未开始 |
| test/town-error-ipc.test.cjs（feature-tasks 相关用例） | 未开始 |
| src/main.cjs boot() 注入面 | 未开始 |

注：worktree 里已存在上一轮被中断的未提交草稿 `desktop/main/features/{types,feature-tasks,feature-task-runner,feature-task-history}.ts`
（无任何迁移记录），本轮按源码逐行复核后再定稿。
