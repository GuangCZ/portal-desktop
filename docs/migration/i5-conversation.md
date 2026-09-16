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
