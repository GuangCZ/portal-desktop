# I7 · Channel + 草稿入口

集成单元 I7（并行组 B）。基线 `next @ 7b2cef8`，工作分支 `i7-channel-drafts`，日期 2026-09-16。

## 阅读摘要

### `scratchpad/integration-plan.md` §3 统一约定 / §3.7 / §2.1 / §2.4 / §4 / §6 / 附录

- 统一约定：独占目录只本单元改；共享文件只 append 一行（`extensions.ts` INSTALLERS、`preload/channels/index.ts`、
  `shared/desktop-types.ts`、`shared/types.ts` 的 `DesktopAPI`、`renderer/app/slots.tsx`、`renderer/app/models/registry.ts`）；
  IPC `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；串行进 `ctx.exclusive`；Town 包络用 `chatErrorEnvelope`；
  协议以实测文档为准；注入替身用类实例。
- §3.7（本单元）：独占 `main/subsystems/channel.ts`、`main/town/channel/{ipc,draft}.ts`、`renderer/channel/`、
  `tests/channel-integration-*.test.ts`、`tests/draft-integration.test.ts`。
  IPC 表：`beings:channel-begin`（功能任务）、`beings:channel-check`（功能任务，BD IPC 名 `checkChannelStatus`、方法 `getChannelStatus`）、
  `beings:channel-inspect`（只读）、`beings:channel-feishu`（包络）、`beings:town-catalog`、`beings:town-page`、
  `beings:town-draft`（统一一条 `{kind,id?,draft?,connectionRevision?}`，串行）。
  **`beings:portal-deploy` 按定案 5.2 整条跳过**（`TownController` 已在 I1 删除）。
- `prepareNativeDraft` 设计：`createNativeDraft(push, waitAck)` → `(prompt, getContext) => Promise<{prepared:true}>`；
  三条 BD 拒绝文案逐字保留；渲染层复用 `beings:scene-draft` → `placeDraft()` → `beings:scene-draft-result`。
- §2.1 注册表：`SubsystemContext = { handle, exclusive, window, store, electron, userData, desktopId, clientVersion, onError, registry, push }`；
  `DesktopSubsystem = { key, connectionVerified?, connectionCleared?, quitting?, ready? }`；
  install 同步体里**不得**解引用 `ctx.registry.get(...)`，只能存惰性 getter。`SubsystemMap` 靠 `declare module './types'` 扩展。
- §2.4 插槽：`PANEL_SLOTS`（可停靠面板，`visible(app)`）、`SIDEBAR_SLOTS`、`TOPBAR_SLOTS`、`SHEET_SLOTS`（全屏页，按 `view` 匹配）；
  `FEATURE_MODELS` 是 model 工厂表，`AppFeatureModels` 用 `declare module` 扩展。
- §4：合回顺序 IM → I5 → I7 → I6b；冲突点全是 append-only。
- §6：`tests/portal-runtime-e2e.mjs` 归本单元；§6.3 真机冒烟四条（typecheck/vitest、`npm run start`、打包后从产物启动、`test:all` summary skip 只减不增）。

## 进度

- [x] 读方案 §3 约定 / §3.7 / §2.1 / §2.4 / §4 / §6 / 附录
