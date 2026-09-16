# I1 · Town 直连读写与时间线（集成单元）

基线：`next @ 9794cab`（I0 接缝已合）。日期：2026-09-16。

本文件是本单元的断点续传记录：阅读摘要 / 进度 / 决定与偏差 / IPC 清单 / 共享文件触碰行。

---

## 1. 阅读摘要

### 1.1 `integration-plan.md` §3 统一约定 + §3.1（I1）

- 独占新文件：`main/subsystems/town.ts`、`main/town/{ipc-desktop,speak}.ts`、`preload/channels/town.ts`、
  `shared/town-desktop-types.ts`、`renderer/town-desktop/{models,components,slot.tsx}`、`tests/town-integration-*.test.ts`。
- 子系统导出面：`TownSubsystem { key:'town'; client; session; background; pairing; cachedReads; identityKey(); invalidateMembers() }`。
- 装配逐行对照 BD `src/main.cjs:371-470`；`TownSession.fetchImpl` 必须外包 `credentials:'omit'` + `referrerPolicy:'no-referrer'`。
- 生命周期：`connectionVerified` → 刷新 connection/revision/identityRevision + `client.lifecycle` + `background.lifecycle` + `background.restore()`；
  `connectionCleared` → `pairing.reset()` + `client.reset()` + `background.stop()` + 清空 rooms；
  `quitting` → `background.stop()` + `bonfireCache.flush()` + `dataCache.flush()`；`powerMonitor.suspend/resume` 走 `ctx.electron.powerMonitor`。
- IPC 通道 18 条 handle + 2 条推送（表见 §4）。
- renderer：`SHEET_SLOTS` 一项（`view:'town-desktop'`）+ `SIDEBAR_SLOTS` 一项（篝火/围炉入口）。
- 要收敛的副本：`town/session/sanitize.ts`、`town/channel/sanitize.ts`、`town/channel/loom-connection.ts` 删除改 `common/*`；
  `town/timeline/cached-reads.ts` 的内联 `scrollId` 改 import `session/library-contract`。
- 要重新启用：`tests/town-channel-pairing.test.ts` 的 8 条 skip、`tests/town-channel-town-background.test.ts` 的 15 条 skip。
- 验收：typecheck + vitest（≥ 基线 + 新增 − 23）+ architecture 六条 + 手工点开篝火看缓存先行。

### 1.2 §2.1 子系统注册表（接缝 API）

`SubsystemContext = { handle, exclusive, window, store, electron, userData, desktopId, clientVersion, onError, registry, push }`。
`electron` 窄门面含 `net.fetch`、`safeStorage`、`powerMonitor?`、`clipboard`、`shell`、`session`、`WebContentsView`。
`DesktopSubsystem = { key, connectionVerified?(connection), connectionCleared?(), quitting?(), ready? }`。
**install 同步体里不得 `ctx.registry.get(...)` 取值**，只能存成惰性 getter。`SubsystemMap` 由各单元 `declare module` 扩展。

### 1.3 §2.2/§2.3/§2.4 preload / shared / renderer 插槽

- preload：`channels/town.ts` 导出 `townDesktop`，`channels/index.ts` 一行 import + 一行属性。
- shared：新建 `shared/town-desktop-types.ts`，`shared/desktop-types.ts` 一行 `export *`，`shared/types.ts` 的 `DesktopAPI` 一行属性（`chat:` 之后按字母序）。
- renderer：`slots.tsx` 的 `SHEET_SLOTS`/`SIDEBAR_SLOTS` 各一行；`app/models/registry.ts` 的 `FEATURE_MODELS` 一行。

### 1.4 §4 冲突约束 / 附录单元索引

I1 独占目录：`main/subsystems/town.ts`、`main/town/{ipc-desktop,speak}.ts`、`renderer/town-desktop/`。
合回顺序 I3 → I2 → I4 → I1 → I6。`main.ts`/`package.json`/`forge.config.ts`/`vite.*.config.ts` 在 I0 之后任何单元都不得修改
（本单元的唯一例外：删除 main.ts 里旧 Town 层的构造与注册行，只删不加）。

### 1.5 §1.1/§1.3/§1.4 注入点签名与副本清单

u1/u2/u3 的构造签名、portal-desktop 自带 town 模块的重叠判定、同源副本收敛落点，均见计划原文；本单元按 §5.1 定案 A 全量换成移植实现。

---

## 2. 进度

- [x] 读计划 §3/§3.1/§2.1/§2.4/§4/附录/§1
