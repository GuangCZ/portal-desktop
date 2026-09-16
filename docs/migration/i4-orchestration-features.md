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

### docs/migration/i0-seams.md（接缝权威说明）
- `linked?(): void` **已经在** `DesktopSubsystem` 上（I0 复审后补），在全部 installer 跑完后按安装顺序同步跑一趟，
  错误报 `${key}-linked`。→ I2 用它赋 `orchestration.presentation`，本单元只需暴露可被赋值的实例。
- `SubsystemSettings` 与方案偏差：拆成 `settings: Settings` + `extras: Readonly<Record<string, unknown>>` + `saveExtra(patch)`。
  **编排模式不在 `Settings` 里**（0.8.x 不认识），读写一律走 `extras.orchestration` / `saveExtra({ orchestration })`。
- `ctx.push` 已带窗口守卫；`ctx.handle` 已带来源校验与 quitting 守卫。
- `main/common/` 四个模块已存在并**已一次性收敛全部副本**：`orchestration/vendored.ts` I0 已删，
  `agent-process.ts`/`agent-kits.ts`/`worker-callbacks.ts` 的 import 已改指 `common/*`。→ §3.4「要收敛的副本」第一项**已完成**，本单元只需核实。
- renderer：`FeatureModel = Store & { start?(): () => void }`，`start()` 返回 cleanup；订阅一律放 `start()`。
  插槽排序 `order` 升序（用百位），同 order 按 key 字典序；`page.tsx`/`sidebar.tsx`/`topbar.tsx` 已接好，不需再改。
- shared 类型名不得撞车（`export *` 静默丢弃），按 `Chat*` 加前缀。

### desktop/main/subsystems/types.ts（158 行）与 extensions.ts（191 行）
- `SubsystemContext`：`handle` / `exclusive` / `window()` / `store` / `electron` / `userData` / `desktopId` /
  `clientVersion` / `fetchImpl` / `onError` / `registry` / `push`。
- `installSubsystems(ctx, installers)` 导出给测试；`INSTALLERS` 模块私有。四个扇出：install → linked → verified/cleared → quitting(逆序)。
- `registry.get` 返回 `null`（不是 undefined）；`require` 抛「子系统 X 未安装。」。

### desktop/main/subsystems/chat.ts（107 行，模板）
- `ChatSubsystem { readonly sessions: ChatSessions | null }`，`declare module './types'` 加键。
- `connectionVerified` 同步、fire-and-forget，`ready` 是最后一次 `start()` 的 promise。

### preload/channels/{bridge,chat,index}.ts 与 shared/{types,desktop-types}.ts
- `bridge.ts` 导出 `subscribe<T>(channel, cb)` 与 `enveloped<T>(channel, ...args)`（后者解 `chatErrorEnvelope`）。
- `channels/index.ts` 的 `desktopChannels = { chat }`；`shared/desktop-types.ts` 只有 `export * from './chat-types';`。
- `shared/types.ts` 的 `DesktopAPI` 追加区在 111 行 `chat: ChatAPI;`，按字母序插在其后。
