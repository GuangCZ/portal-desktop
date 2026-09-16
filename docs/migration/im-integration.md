# IM · 合并后整合修复与真机冒烟

单元 key：`IM`（并行组 B）。工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/im-integration`，分支 `im-integration`，基线 `next @ 7b2cef8`。
日期：2026-09-16。

本单元不新增功能，只把并行组 A 五个单元（I3 / I2 / I4 / I1 / I6）合回 `next` 后留下的**跨单元**遗留一次性收口，
并在打包产物上真跑 E2E。

---

## 1. 阅读摘要

### 1.1 integration-plan.md §3 开头「统一约定」/ §4 / §6 / 附录

- 统一约定：独占目录只有本单元可改；共享文件只允许 append 一行（import + 数组/对象项），不重排不改他人行；
  IPC 命名 `being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`，
  标「Town 包络」用 `chatErrorEnvelope` 返回而不是抛；协议行为以实测文档为准；注入替身形状与生产一致（类实例，不是箭头函数对象）。
- §4：并行组 A 是 I1/I2/I3/I4/I6，合回顺序 I3 → I2 → I4 → I1 → I6 → I5 → I7。
  预计冲突点全部 append-only：`extensions.ts` 的 INSTALLERS、`preload/channels/index.ts`、`shared/desktop-types.ts` 的 re-export、
  `shared/types.ts` 的 `DesktopAPI`、`slots.tsx` 四个数组、`models/registry.ts`、`tests/`（只新增、带单元前缀）、`MIGRATION.md`（一行表格项）。
  「真正需要串行的两处」：`package.json` / `forge.config.ts` / `vite.*.config.ts` / `main.ts` 只有 I0 改（**IM 是本轮的例外持有者**）；
  `DesktopSubsystem` 接口新增 `linked?()` 也回 I0 补（已在 next 里）。
- §6.1 重写映射：`electron-smoke`→I5、`town-sdk`→I1、`town-ui`→I1（或并进 town-sdk）、`portal-runtime-e2e`→I7、`sbs-refresh`→I6b。
- §6.2 新增 E2E：`tools-e2e.mjs`（I2，ws 提级的唯一有效验证）、`terminal-e2e.mjs`（I3，node-pty native rebuild 的唯一有效验证）、
  `orchestration-e2e.mjs`（I4）、`sidebar-e2e.mjs`（I6，由 `test/sidebar-ui.cjs` 的 11 条 check 改写）。
- §6.3 真机冒烟清单：typecheck / vitest ≥ 基线；`npm run start` 连接夹具 Being 发消息退出无错；
  **从 `npm run package` 产物启动**（ws / node-pty / asar prune / Vite external 四个问题的唯一暴露点）；
  `test-results/summary.md` 的 `skipped` 名单只减不增。
- 附录单元索引：本单元不在附录里（附录只列 I0–I7），IM 的任务清单来自 workflow 提示词。

### 1.2 已拍板决定（§5，不再讨论）

5.1=A（Town 全量换 BD，已在 I1 落地，需重新配对）；5.2=portal-desktop 的「客户端持有引擎 + 停旧起新接管」，
**不存在 `beings:portal-deploy`**，u3 的 town-controller / portal-config / portal-release 已删；
5.3=本轮 I6b 全做 SBS 与模型设置；5.4=草稿推到原生 composer，落**当前会话**（I7）；
5.5=electron-smoke 由 I5 重写、town-sdk/town-ui 由 I1 重写但**从未执行过**（IM 在打包客户端上真跑）、sbs-refresh 由 I6b、portal-runtime-e2e 由 I7；
5.6=两个浏览器并存，工具浏览器分区 `persist:being-desktop-browser-v1`，由 tool-browser 子系统**独占实例**；
5.7=townSpeak 未配对直接 `AUTH_REQUIRED`；5.8=终端骨架与 node-pty 都已在 next。

