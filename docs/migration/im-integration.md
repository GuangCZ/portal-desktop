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

### 1.3 docs/migration/i0-seams.md（接缝契约）

- **子系统**：`SubsystemContext` = `handle`（自带来源校验 + quitting 守卫）/`exclusive`/`window()`/`store`（`settings`+`extras`+`saveExtra`）/
  `electron`/`userData`/`desktopId`/`clientVersion`/`fetchImpl`/`onError(scope,error)`/`registry`/`push(channel,payload)`（窗口守卫在里面）。
  `DesktopSubsystem` 可选 `linked()`（全部 installer 跑完后、返回前，按安装顺序同步跑一趟，**惰性规则的唯一例外出口**，用来做「写」）、
  `connectionVerified(connection)`（同步，不得 await exclusive）、`connectionCleared()`、`quitting()`、`ready`。
  扇出：linked/verified/cleared 按安装顺序，quitting 逆序；单个抛错只记 `onError`，scope 是 `${key}-<阶段>`；安装抛错记 `subsystem-install:<函数名>`。
  **铁律**：install 同步体里不得 `ctx.registry.get(...)` 取值，只能包成闭包。
- **common/**：`sanitize.ts`、`platform.ts`、`loom-connection.ts`、`message-context.ts`。I0 已**一次收敛完**副本
  （删了 town/session/sanitize、town/channel/sanitize、town/channel/loom-connection、tools/platform、tools/terminal/platform、
  tools/message-context、chat/context、orchestration/vendored）。`tools/security.ts` 只剩 `protocolFile`（核实过：除 `tests/tools-security.test.ts` 外无人使用）。
  三份 SSE 解析**不合并**。
  → 本单元第 8 条（town/channel 的 sanitize/loom-connection 副本）i0 说已经删了，**需要复核 i1 是否又带回来**。
  → 本单元第 9 条（protocolFile）i0 已核实只有测试在用。
- **renderer**：`slots.tsx` 四数组 + `models/registry.ts` 的 `FEATURE_MODELS`；`FeatureModel = Store & { start?(): () => void }`；
  排序 `order` 升序、同 order 按 key 字典序。`page.tsx`/`sidebar.tsx`/`topbar.tsx` 已接好，后续单元不需要再改。
- **打包**：`forge.config.ts` 自带 `packagerConfig.ignore`（plugin-vite 会把整个 node_modules 排除）+ `asar.unpack` 的 `NATIVE_UNPACK`
  （node-pty 的 spawn-helper 没有扩展名，`*.node` 匹配不到）。`PORTAL_DESKTOP_MAC_LOCAL_TEST=1` + stub heart-portal 可本机打包。
- **i0 自己留下的待办**：`connectionCleared()` 仍无调用方（→ 本单元第 11 条）。

### 1.4 docs/migration/i3-terminal-browser.md（未做事项 / D1）

- **D1（本单元第 1 条的来源）**：`tool-browser` 子系统是 `DesktopBrowser` 的唯一所有者，
  经 `registry.get('tool-browser')?.browser` 暴露。给 I2 的一行式接法：`DesktopToolsOptions` 加可选 `browser?: DesktopBrowserLike`，
  构造体 `this.browser = browser ?? new Browser({...})`，I2 传 `ctx.registry.get('tool-browser')?.browser`。
  「若 I2 直接 new 而不注入，会出现两个 `DesktopBrowser` 抢同一个 `BrowserWindow` 的 contentView，分区相同、`_syncView` 互相 detach——
  这是一个真实缺陷。」合回顺序是 I3 → I2，所以由整合者处理。
- D5：外壳浏览器占 `beings:browser-*`，工具浏览器用 `beings:tool-browser-*`。
- D6：终端工作目录只取 `projectWorkspace`（实测推翻方案 §3.3：`settings.workspace` 是 Portal 的目录，未保存连接前不存在）。
- D7：`tests/chat-ipc.test.ts` 改 `installSubsystems(ctx,[installChatSubsystem])`；`tests/renderer-slots.test.ts` 快照 `LANDED`。
- 未做事项：(1) `tests/terminal-e2e.mjs` 没接进 package.json scripts 与 test-all.mjs → **本单元第 3 条**；
  (2) DesktopBrowser 归属需 I2 配合 → **本单元第 1 条**；(3) 工具浏览器没有独立 E2E；
  (4) 终端面板三项 BD 功能未移植（Being·命令只读标签、终端选项菜单、可拖拽分隔条）；
  (5) `Settings.projectWorkspace` 没有界面可设置 → 与**本单元第 13 条**（项目切换）相关；
  (6) Linux 终端不支持；(7) xterm 字号变量 `--font-mono`/`--text-code` 本仓库未定义；
  (8) `#browser-panel{flex:0 0 49%}` 在 `app/styles.css:92` 不可压缩，三面板并排 <1024px 溢出 → **本单元第 7 条**；
  (9) `connectionCleared()` 无调用方 → **本单元第 11 条**。
- `tests/browser-e2e.mjs` 里 `contentView.children.find(v => v.webContents)` 在两个浏览器同时挂载时会取到第一个（当前只开外壳浏览器，仍正确）。

### 1.5 docs/migration/i2-tools.md（未做事项 / 决定与偏差）

- IPC：`beings:tools`、`beings:tools-action`、`beings:tools-browser-view`、`beings:clipboard-read`；推送 `beings:tools-state`、`beings:tools-reveal`。
- 偏差 2 + 类型探针第 4 条（**本单元第 6 条的来源**）：`WorkerPresentation` → `WorkerPresenter` 四处不符——
  `open` 的 worker 参数（`WorkerRecord.presentation?: WorkerPresentationValue` 缺 `openedAt`）、`open` 返回的 `null`、
  `describe` 的参数同样缺字段、`describe` 返回 `null` 而契约写 `undefined`。
  建议正式修法：`WorkerPresenter.describe` 返回放宽成 `| null | undefined`、`open` 放宽成 `Promise<WorkerPresentationValue | null>`、
  `PresentationWorker.presentation` 放宽成 `Record<string, unknown> | null`。
- 偏差 8（**本单元第 2 条的来源**）：`beings:tools-browser-view` 不在 `QUIT_ALLOWED` 里，退出中被 `handle` 恒拒。
- 复审 medium「失败重试是无节流死循环」引入 `VIEWPORT_RETRIES = 3`，注释说明「唯一一处刻意不与 0.8.26 逐行一致」，
  上限是为了给退出期的恒拒封顶 → **本单元第 2 条要判断它是否只为此存在**。
- 复审 low（**本单元第 3、4 条的来源**）：`scripts/test-all.mjs` 末尾内联了
  `await step('tools-e2e', process.execPath, ['tests/tools-e2e.mjs'])`，因为 package.json 不可改所以没有 `test:tools`；
  MIGRATION.md 只留了一行数据行，「表头 / 章节标题留给合并者补」。
- 复审 low（**本单元第 9 条**）：`tools/security.ts` 的 `protocolFile` 保留，理由是「I3 看不到本分支、无法表态，留给 I3 落地后再判断」。
- 已核实无副本遗留（I0 已收敛 tools/ 下的）。

### 1.6 docs/migration/i4-orchestration-features.md

- IPC 11 条 invoke + 2 条推送（`beings:workers`、`beings:feature-tasks`）。
- 「没做 / 待后续单元」：`orchestration.presentation` 由 I2 的 `linked()` 赋值（已做）；验收卡片属 I5；
  **侧栏活动灯不认 Worker**（BD 规则「有 Worker 在跑 → 会话灯 talking，且优先于等待回复」，
  `OrchestrationModel.hasActiveWorkers(sessionId)` 已写好，侧栏接一行即可）→ **本单元第 10 条**；
  **`connectionCleared()` 依然没有调用方**，本子系统实现了它（generation++、selectOwner('')、重载账本）→ **本单元第 11 条**；
  功能任务详情的「打开功能页」没有目的地（`setNavigate()` 已备好）→ I7；交互冒烟未做（另一个 worktree 的 Electron 占着单实例锁）。

### 1.7 docs/migration/i1-town.md

- D2：`town/ipc.ts` 原 10 条删 8 留 2；`beings:town` 与 `beings:town-open` 改由 `town/ipc-desktop.ts` 注册。
  **`beings:town-open` 原来经 `options.open(url)` 打到外壳浏览器，改成 `ctx.electron.shell.openExternal`（允许名单逐字一致），已记为行为偏差**
  → **本单元第 12 条**。
- 遗留 4：`desktop/main/town/channel/` 里还留着 u3 的 `sanitize.ts` / `loom-connection.ts` 类副本未收敛到 `common/*`
  （i1 只做了 `scrollId` 一项）→ **本单元第 8 条**。
- 遗留 1：`tests/town-ui.mjs` 与 `tests/town-sdk.mjs` 未经真实运行验证（无 cargo → 无安装包）→ **本单元第 14b 条**。
- 遗留 6：`MIGRATION.md` 里 i1 建了表头（标题 + 一行说明 + 表头 + 分隔行 + 自己一行）→ 与 i2/i4/i6 各自的一行数据行并存 → **本单元第 4 条**。
- §10.1：`tests/town-names.mjs` 与 `tests/seed-garden.mjs` 曾被 i1 改坏，已重写并真跑通过。

### 1.8 docs/migration/i6-shell-state.md

- 4.1：`beings:snapshot` 不加 `sidebar`，改用自己的 `beings:sidebar-state` 读通道 + `beings:sidebar` 推送。
- 4.3 / 9.5：**没有 `beings:sidebar-project-select`**，理由是「本壳层没有文件浏览页，唯一能切换的 `settings.workspace` 是 Portal 工作目录」；
  9.5 明确说「I2/I3 的 `DesktopTools({getWorkspace})` / `DesktopConsole({getWorkspace})` 若要按项目切换工作目录，就需要补回这条通道，
  实现落在 `main/shell/ipc.ts`，`updateSidebar` 不用动」→ **本单元第 13 条**。
- 4.7：重申 `main.ts` 从来没调用过 `extensions.connectionCleared()` → **本单元第 11 条**。
- 没做 4：`tests/sidebar-e2e.mjs` 没有 npm 脚本入口 → **本单元第 3 条**。
- 没做 6 / §6：`MIGRATION.md` 表头与 `desktop/renderer/README.md` 目录树留给合回者；i6 给了要粘贴的四行（settings/）→ **本单元第 4、5 条**。

