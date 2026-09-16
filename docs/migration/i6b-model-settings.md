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
