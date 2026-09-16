# I0 · 接缝脚手架（2026-09-16）

集成阶段第 0 步。目标：让 I1–I7 能在各自 worktree 并行开工，合回 `next` 时共享文件上只有 append-only 的一行式冲突。
I0 本身不接任何子系统，只铺脚手架、搬共享模块、改依赖。

基线：`next` @ 4a663ac，`npm run typecheck` 通过，`npx vitest run` 1036 通过 / 57 跳过。

---

## 阅读摘要

### integration-plan.md（§1.4 / §2 / §3 共享文件行 / §4 / §5.8 / 附录）

**§1.4 同源副本清单**（规划者已做逐函数体比对，结论「全部语义一致」；`desktopMessageContext` 一对标注**未核实**，I0 必须做字节级 diff）：

| 函数 | 副本 | 正式落点 |
| --- | --- | --- |
| `sanitizeText` | `chat/titles.ts`、`town/channel/sanitize.ts`、`town/session/sanitize.ts`、`orchestration/vendored.ts` | `main/common/sanitize.ts`，签名取最宽 `(value: unknown, secrets?: readonly unknown[]) => string` |
| `desktopPlatform` / `desktopEnvironment` / `shellPath` / `consoleEnvironment` / `WINDOWS_RUNNER` | `tools/platform.ts`、`tools/terminal/platform.ts`、`tools/console.ts`、`orchestration/vendored.ts` | `main/common/platform.ts`（以 `tools/platform.ts` 的类型为底） |
| `parseConnection` / `sessionPartition` / `endpoint` / `publicModelUrl` / `allowedNavigation` | `tools/security.ts`、`town/channel/loom-connection.ts` | `main/common/loom-connection.ts`（内容取 `tools/security.ts`） |
| `beingIdentityKey(address)` | `chat/connection.ts` | 保留入口，改为 `sessionPartition(parseConnection(address))` 的代理；**磁盘格式**，必须加同值断言测试 |
| `desktopMessageContext` / `DESKTOP_PORTAL_NAME` | `chat/context.ts`、`tools/message-context.ts` | `main/common/message-context.ts` |
| `scrollId` / `RESERVED_SCROLL_IDS` | `timeline/cached-reads.ts` 内联 | import `session/library-contract`（I1 做） |
| SSE 解析三处 | `session/client.ts`、`channel/sse.ts`、`chat/being-chat.ts` | **不要合并**，上限与错误码语义不同 |

迁移顺序：**I0 只新建 `common/*`、不删副本**；各单元在自己的 PR 里改 import 并删自己的副本 → 零跨单元冲突。

**§2 六个一行式冲突点**（I0 必须全部造出来）：
1. `desktop/main/extensions.ts` 的 `INSTALLERS` 数组
2. `desktop/preload/channels/index.ts` 的 `desktopChannels` 对象
3. `desktop/shared/desktop-types.ts` 的 re-export 聚合
4. `desktop/shared/types.ts` 的 `DesktopAPI` 属性
5. `desktop/renderer/app/slots.tsx` 的四个数组（PANEL / SIDEBAR / TOPBAR / SHEET）
6. `desktop/renderer/app/models/registry.ts` 的 `FEATURE_MODELS`

**§2.1 惰性 getter 铁律**：install 的同步体里只能构造自己的实例并把跨子系统引用存成惰性 getter（`() => ctx.registry.require('tools')`），
不得在同步体里 `ctx.registry.get(...)` 取值。否则 chat → orchestration → tools → orchestration → chat 的环会拿到 `undefined`。

**§2.6 依赖**：`ws` devDependencies → dependencies（u4 已实测：打进 bundle 第一帧 `bufferUtil.mask is not a function`；必须 external + asar 内保留）；
`node-pty` + `@electron-forge/plugin-auto-unpack-natives` + `vite.main.config.ts` 的 external。
**§3.3 补充**：`@xterm/xterm` + `@xterm/addon-fit` 也必须在 I0 加（`package.json` 只有 I0 能改）。

**§4 真正需要串行的两处**：`package.json` / `forge.config.ts` / `vite.*.config.ts` / `main.ts` 只有 I0 改；
`DesktopSubsystem` 接口若要加成员，回 I0 补。

**§2.7 验收**：typecheck + vitest 不降 + architecture 六条 + 新增 `tests/subsystem-registry.test.ts` 与 `tests/identity-partition.test.ts` + `npm run prepare:desktop` + 尝试 `npm run package`。

---

## 进度

- [x] 读 integration-plan.md（§1.4 / §2 / §3 共享行 / §4 / §5.8 / 附录）
