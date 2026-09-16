# I6b · 模型设置 + SBS

单元 key：`i6b-model-settings`（并行组 B）。基线 `next @ 7b2cef8`。日期 2026-09-16。

目标（方案 §5.3 定案「全做」）：把 BeingDesktop 的 `/api/llm/config` 读写通道、`PROVIDERS` 表、
模型设置页与 SBS 开关/状态显示原生化到 portal-desktop 壳层。

---

## 1. 阅读摘要

### 1.1 integration-plan.md（§3 统一约定 / §3.6 / §5.3 / §2.1 / §2.4 / §4 / §6 / 附录）

- §3 统一约定：独占目录只本单元改；共享文件只允许 append 一行；IPC `being:<camelCase>` → `beings:<kebab-case>`，
  全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`，「包络」用 `chatErrorEnvelope` 返回而不是抛；
  协议行为以实测文档为准；注入替身形状与生产一致（类实例）。
- §3.6（I6 原始范围，本单元只继承其中模型设置/SBS 部分）：
  - 计划里的落点是 `desktop/main/shell/model-config.ts`（`ModelConfig({getContext, fetchImpl})` + `modelConfigDto`
    + `validateModelPatch` + `PROVIDERS`）。**本单元按任务书改为独占目录 `desktop/main/model-settings/{config,runtime}.ts`**，
    避免与并行组 A 已合入的 `main/shell/` 冲突。
  - 计划的 IPC：`getModelConfig` → `beings:model-config`、`saveModelConfig(patch)` → `beings:model-config-save`（串行）。
    **任务书把读通道定名为 `beings:model-config-get`**，以任务书为准。
  - 计划说 SBS 读写走 `/api/llm/config` 的 `sbsEnabled`，需要在 `chat/ready.ts` 之外新开一条 `/api/llm/config` 的
    GET/PATCH 通道；`common/loom-connection.ts` 的 `endpoint()` 白名单已含 `/api/llm/config`（**待核实**）。
  - 计划原本把 SBS 状态放在 `publicState.runtime.sideBySide:{configured, active}`；I6 记录 §4.5/§9.5 已说明本壳层
    Snapshot 没有 runtime 字段 → 本单元用自己的推送通道 `beings:model-settings-state`，不给 Snapshot 加字段。
- §5.3 定案：全做（模型设置 + PROVIDERS + SBS 开关与状态）。风险提示：模型设置是唯一一条把 API key 明文经 IPC
  送到主进程的路径；PROVIDERS 表随 Loom 版本漂移，`docs/architecture.md` §11 说它是「镜像 Loom 的
  providerNames/inferBaseUrl」的硬耦合点 —— 逐字节移植，不「修正」。
- §2.1 注册表：`SubsystemContext` 提供 `handle` / `exclusive` / `window()` / `registry` 惰性 getter /
  `store`（`connection`、`connectionAddress`、`settings`、`saveExtra`）/ `electron` 门面 / `fetchImpl` / `onError`。
- §2.4 插槽：`PANEL_SLOTS` / `SIDEBAR_SLOTS` / `TOPBAR_SLOTS` / `SHEET_SLOTS` + `FEATURE_MODELS` 注册表，
  每单元一行 import + 一行数组项。
- §4 冲突约束：六个共享文件 append-only；`main.ts` / `package.json` / `forge.config.ts` / `vite.*.config.ts` I0 之后不得改。
- §6 E2E：`tests/sbs-refresh.mjs` 归 I6b，按 §5.3 拍板后重写；真机冒烟清单 4 条（typecheck+vitest / `npm run start` /
  打包后从产物启动 / `test:all` 的 skipped 名单只减不增）。
- 附录单元索引：I6b 在并行组 B，依赖 I0（实际还依赖 I6 的 `renderer/settings/`）。

### 1.2 `docs/migration/i0-seams.md`（接缝权威说明）

- `SubsystemContext`：`handle` / `exclusive` / `window()` / `store`（`connection`、`connectionAddress`、`settings`、
  `extras`、`saveExtra`）/ `electron`（`ElectronBindings` 门面，`clipboard` 是 **Promise 形态**）/ `userData` / `desktopId` /
  `clientVersion` / `fetchImpl`（`net.fetch` 绑定）/ `onError(scope, error)` / `registry` / `push(channel, payload)`（**窗口守卫已在里面**）。
- `DesktopSubsystem` 可选实现 `linked()`（全部安装完成后同步跑，惰性规则的唯一例外，用于「赋值」）、
  `connectionVerified(connection)`（**同步**，自己就跑在 `exclusive` 里，不得 await 队列）、`connectionCleared()`、`quitting()`、`ready`。
- **铁律**：installer 同步体内不得解引用 `ctx.registry.get(...)`，只能包成闭包。
- **既有缺口（I0 记录、I6 复述）**：`main.ts` 从来没有调用过 `extensions.connectionCleared()`。切 Being 走
  `beings:save` → `verifyConnection` → `connectionVerified`，这条是通的。本单元照样实现 `connectionCleared`，并把缺口写进 openIssues。
- `desktop/main/common/`：`sanitize.ts`、`platform.ts`、`loom-connection.ts`（`parseConnection` / `sessionPartition` /
  `endpoint` / `publicModelUrl` / `allowedNavigation`）、`message-context.ts`。
  `tests/architecture.test.ts` 有一条「`main/common/` 只能 import node 内建与自己目录内的文件」。
- 六个一行式冲突点与「只有 I0 能改」的清单（含 `desktop/main/subsystems/types.ts` 的接口成员与 `renderer/app/models/app.ts`）。
- renderer 插槽：`FeatureModel = Store & { start?(): () => void }`，**订阅/定时器一律放 `start()` 并返回关闭函数**；
  排序 `order` 升序、同 order 按 `key` 字典序，`order` 用百位。

### 1.3 共享文件现状（读了真实代码）

`extensions.ts` 的 `INSTALLERS` 已有 7 项（chat / terminal / tool-browser / tools / orchestration / shell-state / town）；
`preload/channels/index.ts` 的 `desktopChannels` 已有 7 个属性；`shared/desktop-types.ts` 已有 7 行 `export *`；
`slots.tsx` 的 `SIDEBAR_SLOTS` 已有 `{ key: 'shell-pages', order: 900, placement: 'foot', Section: ShellPagesSection }`（I6）；
`SHEET_SLOTS` 仍为空数组；`models/registry.ts` 的 `FEATURE_MODELS` 已有 6 项。

### 1.4 `docs/migration/i6-shell-state.md`（本单元的直接前置）

- I6 的独占产出：`main/shell/{sidebar-state,ipc}.ts`、`subsystems/shell-state.ts`、`preload/channels/shell-state.ts`、
  `shared/shell-state-types.ts`、`renderer/settings/{components/{entry,about,privacy}.tsx,models/shell-state.ts,styles.css}`。
- IPC：`beings:sidebar-state`（只读）、`beings:sidebar-action`（串行）、`beings:sidebar-project-add`（串行）、推送 `beings:sidebar`。
- §4.1：`beings:snapshot` **没有**加 `sidebar` 字段，因为 `main.ts` 不得改；I6 自己开了读通道 + 推送。
  **本单元照此办理**：`beings:model-settings-state` 推送 + `beings:model-config-get` 读通道，不碰 Snapshot。
- §4.5 / §9.5：SBS 只读显示没做，因为本壳层 `Snapshot` 没有 `runtime`，而 `sbs_enabled` 的唯一来源是 `/api/llm/config`
  （`src/runtime.cjs:22`、`:52`）——正是本单元要开的通道。I6 没有留任何半成品文件。
- §4.6：静态页用 `SIDEBAR_SLOTS` 的 `foot` 插槽（`ShellPagesSection`），`app/components/settings.tsx` 一个字没改
  （它的三 tab 键盘导航是硬编码 `%3`，加第四个 tab 要重写三段）。**本单元的模型设置入口同样挂在 `ShellPagesSection` 里**，
  这是任务书给本单元的 `renderer/settings/**` 例外。
- §4.7：身份分区从「已保存的地址」解析，`SettingsStore.load()` 一读到 credential 就填好 `connectionAddress`。
- I6 有一条非一行式共享改动的先例：`tests/chat-ipc.test.ts` 的 `CHANNELS` 闭集断言随子系统落地而扩张
  （断言的是「`installDesktopExtensions` 注册的全部通道」）。**本单元也必须往那里追加自己的通道**。
