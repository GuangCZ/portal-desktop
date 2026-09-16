# I4 · 编排 + 功能任务账本（集成单元）

基线：`next` @ 9794cab。分支 `i4-orchestration-features`。日期 2026-09-16。

## 阅读摘要

### integration-plan.md §3 统一约定 / §3.4 / §2.1 / §2.4 / §4 / 附录单元索引
- 独占目录：`main/subsystems/orchestration.ts`、`main/orchestration/{ipc,instructions}.ts`、
  `main/features/{ipc,history-cache,town-sync}.ts`、`renderer/orchestration/`、`renderer/features/`。
- 共享文件只允许 append 一行：`main/extensions.ts` INSTALLERS、`preload/channels/index.ts`、
  `shared/desktop-types.ts` re-export、`shared/types.ts` 的 `DesktopAPI`、`renderer/app/slots.tsx`、
  `renderer/app/models/registry.ts`。`main.ts`/`package.json`/`forge.config.ts`/`vite.*.config.ts` 绝不改。
- IPC：`being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  BD 标「Town 包络」用 `chatErrorEnvelope` 返回。
- §2.1 注册表：install 同步体只构造自己的实例，跨子系统一律惰性 `ctx.registry.get(...)`；
  `SubsystemMap` 用 `declare module './types'` 扩展；`linked?()` 生命周期用于 presentation 赋值（I2 侧赋值）。
- §2.4 插槽：`PANEL_SLOTS` / `SIDEBAR_SLOTS` / `TOPBAR_SLOTS` / `SHEET_SLOTS` + `FEATURE_MODELS`。
- §4：I4 属并行组 A；合回顺序 I3 → I2 → I4 → I1 → I6 → I5 → I7。
- §3.4 装配对照 BD `src/main.cjs:163-176, 359-362, 122, 495-520, 721-735`。
- §3.4 IPC 表：`beings:orchestration`、`-inspect`、`-save`(串行)、`beings:worker`、`worker-cancel`、
  `worker-retry`、`workers-reconnect`、`beings:feature-tasks`、`feature-task`、`feature-task-end`、
  `feature-task-discuss`(串行)，推送 `beings:workers`、`beings:feature-tasks`。
- 定案 5.2：**不存在** `beings:portal-deploy`；`featureMethods` 放 `main/features/methods.ts`，各单元自传通道名。
- 要收敛的副本：`orchestration/vendored.ts` 整个删除；`orchestration-policy.ts` 的两个 `default*` 删除改注入；
  `tests/features-feature-task-history.test.ts` 四份本地副本删掉改 import。
