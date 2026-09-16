# I5 · 对话补全（integration unit）

Worktree `.local/i5-conversation`，分支 `i5-conversation`，基线 `next @ 7b2cef8`（typecheck 绿，vitest 109 文件 / 1197 通过 / 34 跳过）。
日期 2026-09-16。

## 1. 阅读摘要

### 1.1 integration-plan.md §3 统一约定 / §3.5 / §2.1 / §2.4 / §4 / §6 / 附录

- 统一约定：独占目录只有本单元可改；共享文件只允许 append 一行（import + 数组项）；
  IPC `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  「Town 包络」用 `chat-errors.ts` 的 `chatErrorEnvelope` 返回而非抛；协议行为以实测文档为准；
  注入替身形状与生产一致（生产注入类实例 → 测试也用类实例）。
- §3.5 本单元目标：补 P1 留下的五个空洞——`prepareMessage`（请求上下文帧）、`ChatDetails` 的 IPC、
  `composer-data`、`workerResults` 卡片、`⌘1–9` 切会话。
  独占新文件：`main/chat/{prepare-message,environment,details-ipc,composer-data}.ts`、
  `renderer/conversation/components/{detail-card,worker-result,reference-toolbar}.tsx`、
  `renderer/conversation/models/{details,mentions}.ts`、`tests/chat-integration-*.test.ts`。
  装配：`subsystems/chat.ts` 的 `new ChatSessions({...})` 加四个参数（prepareMessage / generateTitle /
  titleAvailability / getWorkerResults）。
  收敛副本：`chat/context.ts` 删、`chat/titles.ts` 的 `sanitizeText` 改 import、`chat/connection.ts` 的
  `beingIdentityKey` 改一行代理。
  七条 IPC（见 §4 清单）。renderer 三块：选区工具条、解释卡片、Worker 结果卡片；ComposerModel 加 `/` Kit 与 `@` 成员补全；
  `page.tsx` keyboard 块加 `task-1..9`（唯一允许改 page.tsx 的例外）。
- §2.1 注册表：`SubsystemContext` 有 `handle/exclusive/window/store/electron/userData/desktopId/clientVersion/onError/registry/push`；
  install 同步体里**只能**构造自己的实例并把跨子系统访问存成惰性 getter，不得同步解引用 `ctx.registry.get(...)`。
- §2.4 插槽：`PANEL_SLOTS/SIDEBAR_SLOTS/TOPBAR_SLOTS/SHEET_SLOTS` + `FEATURE_MODELS`，每单元一行 append。
- §4：冲突点全部 append-only；`package.json`/`forge.config.ts`/`vite.*`/`main.ts` 只有 I0 改。
- §6.1：`tests/electron-smoke.mjs` 归 I5，10 步（起打包客户端 + 假 Being HTTP/WSS 夹具 → 连接 → 发一句 →
  断言 `POST /api/chat/stream` body 带 `scene_id`/`scene_meta.scene_label`/`client_ref` 且 `message` 带 v1 帧 →
  `GET /api/history` 一次 → 停止 → `POST /api/stop` → 重启后会话仍在）。
  §6.3 真机冒烟：typecheck/vitest、`npm run start`、打包产物启动、`test:all` 的 skipped 名单只减不增。

### 1.2 docs/migration/i0-seams.md（451 行）

对本单元最要紧的几条：

- **副本已经在 I0 一次收敛完**（偏离方案 §2.5 的分步走）：`chat/context.ts` **已删除**，`chat/titles.ts` 的本地
  `sanitizeText` **已删除**，`chat/session-recovery.ts` 已改 import `common`。
  也就是说 §3.5「要收敛的副本」三条里前两条在基线上已经完成；`chat/connection.ts` 的 `beingIdentityKey` 也已经是
  `sessionPartition(parseConnection(address))` 的一行代理（`tests/identity-partition.test.ts` 钉住）。**本单元这一步是核实而非施工。**
- `common/message-context.ts` 导出 `desktopMessageContext`、`DESKTOP_PORTAL_NAME`、`DesktopRuntime`、`DesktopMessageContextOptions`；
  I0 实测 `chat/context.ts` 与 `tools/message-context.ts` 去空白后逐字节相同（4626 字节）。
- `SubsystemContext`：`handle / exclusive / window() / store / electron / userData / desktopId / clientVersion / fetchImpl /
  onError / registry / push`。`store` 是 `SubsystemSettings`，**与方案不同**：拆成 `settings: Settings` + `extras` + `saveExtra(patch)`。
- `DesktopSubsystem` 多了 `linked?(): void`（装后同步一趟，惰性规则的唯一例外出口，用于「写」而不是「读」）。
- `installSubsystems(ctx, installers)` 是注册表测试入口；`installDesktopExtensions` 是生产入口。
- renderer：`FeatureModel = Store & { start?(): () => void }`；要开 IPC 订阅/定时器的一律放 `start()` 并返回关闭函数。
  插槽排序 `order` 升序、同 order 按 key 字典序；`order` 用百位留空隙。
- architecture 测试现在是**八条**（多了 `main/common/` 依赖边界、`subsystems/` 不得 import electron）。
- `connectionCleared()` **从来没有调用方**（main.ts 没接线），既有缺口。
