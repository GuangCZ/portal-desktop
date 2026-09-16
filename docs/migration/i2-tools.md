# I2 · 工具桥 + 控制台（集成单元）

来源：portal-desktop 壳层 + BeingDesktop `src/main.cjs` / `renderer/desktop-tools.js`。日期：2026-09-16。
基线：`next` @ 9794cab，分支 `i2-tools`。

## 阅读摘要

### integration-plan.md（§3 统一约定 / §3.2 / §2.1 / §2.4 / §2.5 / §2.6 / §4 / §6.2 / §6.3 / 附录）

- 独占目录：`desktop/main/subsystems/tools.ts`、`desktop/main/tools/ipc.ts`、`desktop/renderer/tools/`、
  `desktop/preload/channels/tools.ts`、`desktop/shared/tools-types.ts`、`tests/tools-integration-*`。
- 共享文件只允许 append 一行（import + 数组/对象项）：`desktop/main/extensions.ts` 的 `INSTALLERS`、
  `desktop/preload/channels/index.ts`、`desktop/shared/desktop-types.ts` 的 re-export、
  `desktop/shared/types.ts` 的 `DesktopAPI`（加在 `chat: ChatAPI;` 之后按字母序）、
  `desktop/renderer/app/slots.tsx` 的数组、`desktop/renderer/app/models/registry.ts`。
- 不得修改：`desktop/main/main.ts`、`package.json`、`package-lock.json`、`forge.config.ts`、`vite.*.config.ts`、
  `tsconfig*`、`vitest.config.ts`、`subsystems/types.ts`、`subsystems/chat.ts`。
- IPC：`being:<camelCase>` → `beings:<kebab-case>`，全部经 `ctx.handle`；BD 标「串行」进 `ctx.exclusive`；
  Town 包络用 `chat-errors.ts` 的 `chatErrorEnvelope` 返回而不是抛。
- §3.2 装配对照 `src/main.cjs:1696-1709`；`getConnection` 必须是 `parseConnection(ctx.store.connectionAddress)`
  （BD 形状 `LoomConnection`），不能直接传 portal-desktop 的 `Connection`。
- §3.2 IPC 清单：`beings:tools` / `beings:tools-action` / `beings:tools-browser-view` / `beings:clipboard-read`
  （+ 既有 `beings:clipboard-copy`）+ 推送 `beings:tools-state`。
- §3.2 要收敛的副本：删 `tools/platform.ts`、`tools/security.ts`、`tools/message-context.ts`；
  `tools/console.ts` 的 `consoleEnvironment`/`WINDOWS_RUNNER` 改 import `common/platform`。
  `tools/browser-links.ts` 与 `browser/url.ts` 的地址解析**保留两份**（语义不同），两处文件头互相引用。
- §3.2 类型收敛：`desktop-tools.ts` 的 `DesktopBrowserOptions` 改为 `import type { ElectronBrowserHost }`；
  `DesktopBrowserLike.newTab` 返回改 `BrowserSnapshot`；IPC 层直接用 `DesktopTerminal` 真类而非窄接口 `DesktopTerminalLike`。
- §2.1 registry：install 同步体内只能构造自己的实例 + 存惰性 getter，不得 `ctx.registry.get(...)` 取值。
- §2.4 插槽：`PANEL_SLOTS` 一项（工具面板）；`FEATURE_MODELS` 一项。
- §6.2/6.3 验收：`tests/tools-e2e.mjs`（打包客户端 + 本地假 relay，握手 → initialize → tools/list →
  tools/call desktop_browser_open 进待确认 → 允许 → 标签出现）——`ws` 提级的唯一有效验证。

## 进度

- [x] 读方案

### docs/migration/i0-seams.md + subsystems/{types,extensions}.ts + 四个 append-only 文件

- **I0 已经一次收敛完副本**（偏离方案 §2.5 的分步走）：`tools/platform.ts`、`tools/message-context.ts`、
  `tools/terminal/platform.ts`、`chat/context.ts`、`orchestration/vendored.ts` 等**已经删掉**，
  `tools/console.ts` 的 `consoleEnvironment`/`WINDOWS_RUNNER` **已经改指 `common/platform`**。
  `tools/security.ts` 只剩 `protocolFile`。→ **§3.2 的「要收敛的副本」这一步在 I2 里已无事可做**，只需核实。
- `linked?(): void` 钩子已存在（I0 复审第二轮补的），在全部 installer 跑完后按安装顺序同步跑一趟，
  错误报 `${key}-linked`。I0 明确点名给 I2 用来赋 `orchestration.presentation`。
- `FeatureModel = Store & { start?(): () => void }`，`start()` 必须返回 cleanup，由 `AppModel.start()` 接管。
- `ctx.push` 自带窗口守卫（destroyed 判断在里面），子系统不必自己判断。
- `ctx.electron.clipboard` 是 **Promise 形态**（`readText(): Promise<string>`），Electron 44 实测。
- `ctx.store` 是 `SubsystemSettings`：`connection` / `connectionAddress` / `settings: Settings` /
  `extras` / `saveExtra(patch)`（不是方案写的交叉类型）。
- `ElectronBindings.WebContentsView` / `session` / `net.request` 是 `unknown`，使用处 `as` 一次并写明理由。
- `PANEL_SLOTS` 排序：`order` 升序、`key` 兜底；建议 order 取百位。`visiblePanels(app)` 已由 page.tsx 调用。
