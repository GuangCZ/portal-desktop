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

---

## 2. 逐条处理

### 2.1 DesktopBrowser 单实例（i3 记录 D1）——已修

**缺陷复现（实测，不是推断）**：把注入行 `getBrowser: toolBrowser` 从 `subsystems/tools.ts` 删掉再跑新测试，
`FakeSession.partitions` 是 **2 条** `persist:being-desktop-browser-v1`——两个 `DesktopBrowser` 各自 `session.fromPartition()` 了一次，
共用同一个分区、各自往同一个窗口的 `contentView` 挂 `WebContentsView`。恢复后 1 条。

改法（照 D1）：

- `DesktopToolsOptions` 新增可选 `getBrowser?: () => DesktopBrowserLike | null`。
- `DesktopTools.browser` 从字段改成 **getter**：`this.resolveBrowser() ?? (this.ownBrowser ??= this.createBrowser())`。
  构造期**不调用** resolver（安装顺序无意义，那时注册表还是空的——调用它就正好造出第二个实例）。
- **没有注入点时行为不变**：构造函数里直接 `this.ownBrowser = this.createBrowser()`，所以「Electron 门面被拒」仍然是**构造失败**，
  `tests/tools-desktop-tools.test.ts` 的 `tools.browser.destroyed` 那条不受影响。
- `dispose()` 改成 `this.ownBrowser?.destroy()`：注入进来的浏览器归 tool-browser 子系统，由它自己的 `quitting()` 销毁
  （`DesktopBrowser.destroy()` 本来就幂等，这里是归属问题不是双销毁问题）。
- `subsystems/tools.ts` 传 `getBrowser: () => ctx.registry.get('tool-browser')?.browser ?? null`（惰性，每次访问解析）。
- **Electron 门面检查上移**：0.8.26 在构造函数里建浏览器，所以门面被拒 = 构造失败 = 没有工具桥。
  注入让构造变惰性，于是把 `typeof View !== 'function' || typeof session?.fromPartition !== 'function'` 的检查搬到子系统里
  （与 `tool-browser.ts` 第 49 行同一条检查），否则拒绝会从 `changed()` 的 `setImmediate` 里抛出来——那是主进程崩溃。
- **onChange 两条路**：BD 的 `DesktopTools` 自己建浏览器、`onChange:()=>this.changed()`，浏览器一变工具快照就重算。
  归属搬走之后这条扇出改成显式的：`subsystems/tool-browser.ts` 的 onChange 里
  `push.state(snapshot)` 之后 `ctx.registry.get('tools')?.tools?.changed()`（惰性，且在回调里而不是构造期）。
  单独探针验证：删掉这一行，两条 `fans a browser change out to both state channels` 用例报
  `expected [ 'beings:tool-browser-state' ] to include 'beings:tools-state'`。

新增 `tests/tools-integration-browser-ownership.test.ts`（6 例）：两种安装顺序 × {单实例 + `tools.browser === toolBrowser.browser` 身份、
两条推送通道扇出} + 无 tool-browser 时的自建兜底 + 无 Electron 时的拒绝。

### 2.2 QUIT_ALLOWED（i2 记录「决定与偏差」8）——已修

核对 `desktop/main/tools/ipc.ts` 与 `desktop/main/tools/browser/ipc.ts` 的全部通道，「视口/几何」类只有两条：
`beings:tools-browser-view`（工具桥看到的浏览器视口）与 `beings:tool-browser-viewport`（面板自己的视口）。
终端没有几何通道（`beings:terminal-action` 是动作通道，放行会让退出期还能新建终端，不放）。

`QUIT_ALLOWED` 从 `['beings:browser-bounds','beings:diagnostics']` 变成
`['beings:browser-bounds','beings:tools-browser-view','beings:tool-browser-viewport','beings:diagnostics']`。
理由写在常量的注释里：`WebContentsView` 活在主进程，渲染层**唯一**的释放手段就是发 `visible:false`；
退出期面板 unmount 时发的正是这一条，拒绝它等于把页面钉在正在关闭的窗口上，还会让渲染层对着一条永远不答的通道反复测量重发。
BD 0.8.26 对 `setBrowserView`（src/main.cjs:1137）**一个守卫都没有**。

**`VIEWPORT_RETRIES` 只为这一条存在**（i2 在常量注释里写明：「Here the channel is refused for the WHOLE of a quit —
it is not on QUIT_ALLOWED — … an unbounded retry is a live loop」），已删除：
`ToolsModel.send()` 的失败分支恢复成 0.8.26 的 `lastViewport=''`（无条件重试）。
**保留** `viewportFailures` 计数器与「一段失败只 `fail()` 一次」——那才是活循环的另一半
（`fail()` → `changed()` → 重渲染 → 重新测量 → 再发），而且它与退出无关，是「同一个原因不要每帧报一次」。

新增 `tests/app-ipc-quit-allowed.test.ts`（5 例）：`QUIT_ALLOWED` 的精确内容、退出期两条视口通道真的到达
`setViewport`、退出期其余五条仍被拒、未退出时行为不变、发送者校验先于放行名单（放行不削弱来源校验）。
`tests/tools-integration-model.test.ts` 那条「stops re-sending…」改写成「keeps re-sending a refused rectangle,
and says why only once」：断言 12 次布局发 12 次（不再封顶）、`fail()` 只通知一次、一次成功后重新计数——断言更强，不是更弱。

### 2.6 WorkerPresenter 与 WorkerPresentation 的四处类型不符（i2 记录）——已修

在 `desktop/main/orchestration/types.ts` 上放宽（**没有动 `main/tools/`**）：

| 位置 | 原来 | 现在 |
| --- | --- | --- |
| `WorkerPresentationValue` | `artifactPath?: string`、`requestedUrl?: string`、`tabId?: string`，无 `openedAt` | `artifactPath?: string \| null`、`requestedUrl?: string \| null`、`tabId?: string \| null`、新增 `openedAt?: string` |
| `WorkerPresenter.open` 的 worker 参数 | `WorkerRecord`（说「展示器需要整条记录」，而且真类赋不进来） | 新的 `PresentationTarget = {id, cwd, presentation?}`——`WorkerPresentation.open` 实际只读这三项 |
| `WorkerPresenter.open` 的返回 | `Promise<WorkerPresentationValue>` | `Promise<WorkerPresentationValue \| null>`（返回的是 `describe()` 的结果） |
| `WorkerPresenter.describe` | `(v \| undefined) => v \| undefined` | `(v \| null \| undefined) => v \| null \| undefined` |
| `PresentResult.presentation` | `WorkerPresentationValue` | `WorkerPresentationValue \| null`（跟随 `open` 的返回，不越过它断言） |

`null` 与 `undefined` 在运行期同路：orchestration 两处都写 `this.presentation?.describe(x) || x`。

`subsystems/tools.ts`：删掉 `OrchestrationPeer` 与 `TerminalPeer` 两个本地结构化 peer 类型和
`ctx.registry as unknown as { get(key: string): unknown }` 这个转型——I3/I4 已经合进 next，
`SubsystemMap` 里有 `'orchestration'` 与 `'terminal'`，改成 `ctx.registry.get('orchestration')` / `get('terminal')` 的**类型化**查表；
`linked()` 里 `peer.orchestration.presentation = new WorkerPresentation({...})` 现在是**直接赋值，没有任何 cast**。
顺带删掉因此不再使用的 `DesktopTerminalLike` / `ToolResult` 两个 import。

`tests/tools-worker-presentation.test.ts` 新增一条「is what orchestration declares a WorkerPresenter to be」：
`const presenter: WorkerPresenter = f.presentation;` 这一行**赋值本身就是断言**（类型回退即 typecheck 红），
再用一个真的 `WorkerRecord` 走一遍 `open`/`describe`，断言 `openedAt`、`artifactPath`、`requestedUrl:null` 与 `describe(undefined) === null`。

### 2.7 `#browser-panel` 的 flex-shrink（i3 记录第 8 条）——已修

`desktop/renderer/app/styles.css:92` 的 `#browser-panel{flex:0 0 49%;min-width:0}` 改成 `{flex:0 1 49%;min-width:240px}`，
与工具浏览器 / 终端两个面板（`flex:0 1 42%` + `min-width:240px`）一致。
拖拽自己的下限在 `browser/hooks/use-browser-split.ts` 的 `Math.min(360, total/2)`，比 240px 大，
所以手拖不会到 240px，只有「三个面板同时打开、窗口很窄」的自动压缩会到。

### 2.8 `main/town/channel/` 的 u3 副本收敛（i1 记录遗留 4）——**已核实：该收敛的早已收敛，i1 的这条记录是过时的**

实测（不是推断）：`git show a6877ef --stat -- desktop/main/town/channel/` 显示 I0 的
「wip(i0-seams): shared main/common modules and converge the duplicate copies」这一提交里
**已经删掉** `town/channel/loom-connection.ts`（45 行）与 `town/channel/sanitize.ts`（30 行），
并把 `channel-being.ts`、`pairing-probe.ts` 的 import 改指 `../../common/*`。
当前 `desktop/main/town/channel/` 只剩 being-client / channel-being / errors / pairing-probe / sse / town-background / town-catalog / types 八个文件。

把 `common/*` 的全部导出名在 `desktop/main/town/` 下 grep 了一遍，**唯一的重名**是
`town/channel/being-client.ts:41` 的 `parseConnection`。逐行对照两个上游后确认**它不是副本**：

| | `town/channel/being-client.ts` | `main/common/loom-connection.ts` |
| --- | --- | --- |
| 上游 | `extensions/being-anywhere/being-client.mjs:34`（逐字一致，只差 TS 类型与尾逗号） | `src/security.cjs` |
| 额外校验 | 控制字符、反斜杠、`api`/`token`/`secret`/`relay_secret` 重复参数、token ≤4096、`api` 值格式 | 无 |
| 返回 | `{url, apiBase, token, displayUrl, beingName(≤100), origin}` | `{url, apiBase, token, **secret**, displayUrl, beingName}` |
| 失败 | `ClientError` + `code`（`ChannelBeing` 按 `MESSAGES.auth` 分支） | 普通 `Error` |

两者互不为超集，且 `secret` 是 `sessionPartition` 的输入之一（**磁盘格式**），这个 client 压根没有这个字段。
**不合并**，并在 `being-client.ts` 的文件头写清楚为什么不合并，免得下一个人照 i1 的记录去"收敛"。

`channel-being.ts` 的 `clean(value, secrets)` 是 `common/sanitize` 的**包装**（先无长度门槛地 redact secrets，再 `sanitizeText`，再去 bidi 控制字符），
与 BD `src/channel-being.cjs` 一致，不是副本。三份 SSE 解析按 I0 的结论保持不合并。

**真正还剩的一份副本在测试里**：`tests/orchestration-worker-callbacks.test.ts` 第 19-45 行内联了
`src/security.cjs` 的 `parseConnection` + `sessionPartition`（注释写着「copied verbatim」）。
已删除，改成 `import { parseConnection, sessionPartition } from "../desktop/main/common/loom-connection"`——
这条测试断言的正是回调请求里的 `sessionPartition` 值，注入真实实现之后这些断言才真的在测正式实现。

### 2.9 `tools/security.ts` 的 `protocolFile`（i2 记录 low）——已删

`grep -rn protocolFile desktop tests scripts` 全树只有三处：它自己的定义、`tests/tools-security.test.ts` 的三行断言、
以及 `security.ts` 文件头里自己的说明。**零生产调用方**（I2 与 I3 都已落地，两个单元都不需要它：
工具浏览器加载的是远程 http(s)，外壳唯一的本地文档是 `beings://desktop`，由 `app/protocol.ts` 用自己的 join 解析）。

按任务书删除 `desktop/main/tools/security.ts` 与 `tests/tools-security.test.ts` 里对应的那一条用例
（`app resource handler rejects encoded path traversal`，本单元明确允许删除的那条）。
测试文件头写清楚为什么删，以及 `app/protocol.ts` 的守卫**不解码 pathname**，所以 `..%2f` 只是个文件名而不是穿越——
两者是不同的做法，不是同一个函数的两份。
顺带删掉测试里因此不再使用的 `node:path` import。该文件其余 6 条用例的主体本来就是 `common/loom-connection.ts`。

**留下的缺口（如实记录）**：`desktop/main/app/protocol.ts` 的 403 守卫**没有任何单元测试**——它 import electron，
本仓库没有给它建过夹具。这不是本单元引入的，也没有因为删 `protocolFile` 而变差（那条测的是另一个函数），
但既然现在唯一一条「路径穿越」用例没了，把它写进 openIssues。

### 2.3 三个 E2E 的 npm 入口（i3 未做 1 / i6 没做 4 / i2 复审 low）——已接

`package.json` 的 `scripts` 段新增三行（**没有动依赖**）：
`"test:tools": "node tests/tools-e2e.mjs"`、`"test:terminal": "node tests/terminal-e2e.mjs"`、`"test:sidebar": "node tests/sidebar-e2e.mjs"`。
`scripts/test-all.mjs` 把 i2 内联的 `step('tools-e2e', process.execPath, ['tests/tools-e2e.mjs'])` 换成
`npm('tools-e2e', ['run','test:tools'])`，并在后面加 `terminal-e2e`、`sidebar-e2e` 两步（都排在 `package` 之后，它们跑的是打包产物）。
`summary.md` 的 `skipped` 名单由 `step()` 的 `SKIPPED:` 标记自动生成，本单元只增加步骤、**没有让任何一步变成 skip**。

### 2.4 MIGRATION.md 的两个「集成阶段」小节——已合并

原来是 `## 集成阶段 I1–I7：并行单元`（表头齐全，I3/I2/I4/I6 四行）+ `---` + `## 集成阶段 I1 起：各单元一行`
（**缺分隔行**，所以 I1 那一行根本不渲染成表格）。
现在是一个 `## 集成阶段：各单元记录（2026-09-16）` + 一张 `| 单元 | 产出 | 用户可见的变化 / 记录 |` 的表，
五行原文逐字保留（I1 那行的第三列本来是「用户可见的变化」，补了它的记录路径；其余四行第三列本来就是记录路径），
再 append 本单元一行。

### 2.5 `desktop/renderer/README.md` 的目录树——已补

补 `tools/`、`tool-browser/`、`terminal/`、`orchestration/`、`features/`、`settings/` 六个模块（settings 的四行用 i6 §6 给的原文），
`app/` 下补 `slots.tsx` 与 models 的「功能模型注册表」。逐个 `ls` 核对过，与真实目录一致：
`features/` 与 `settings/` **没有** `slot.tsx`（注册项分别从 `orchestration/slot.tsx` 与 `settings/components/entry.tsx` 导出），已在树里注明。
「依赖与文件约定」加一条解释 `slot.tsx` 是什么；「验证」一节补上三个打包 E2E 的跑法。

### 2.10 侧栏活动灯认 Worker（i4 记录「没做」第 3 条）——已修

BD `renderer/sidebar.js:63`：`window.beingOrchestration?.hasActiveWorkers(item.id) ? 'talking' : state.chatSessionActivity?.[item.id]`
——**有 Worker 在跑就是「进行中」，优先于「等待回复」**，而且和它下面那组 Worker 计数读同一份快照（源码第 62 行的注释说的就是这件事）。

规则抽成纯函数 `desktop/renderer/app/components/session-activity.ts`（`sessionActivity` / `sessionActivityLabel` / `sessionActivityClass`），
`sidebar.tsx` 的 `SessionRow` 改调它，数据来自 `app.features.orchestration?.hasActiveWorkers(session.id) === true`
（编排单元没落地时是 `undefined`，即「没有 Worker」）。
**为什么抽出来**：本仓库的 vitest 没有 DOM 环境，规则写在 JSX 里就没有任何东西能执行它。
新增 `tests/sidebar-activity.test.ts`（4 例）：Worker 压过 `waiting`、原有三态不变、无编排模型时的退化、三个文案与三个 class 与 0.8.26 逐字一致。

### 2.11 `connectionCleared()` 的调用方（P1/I0/I4/I6 四份记录都提到）——**本外壳没有可接的时刻，未加调用；结论已写进 MIGRATION.md 与 openIssues**

逐条核实（全部是读真实代码，不是推断）：

1. **没有解绑路径**。`SettingsStore.connection` 起始 `null`，`desktop/` 里只有四处赋值（`app/settings.ts:72/90/127/150`），
   **没有任何一处赋回 null**。`save()` 经 `resolveConnection`：没有 `connectionLink` 就回退到当前连接，两者都没有时抛「请先输入 Being 链接。」——
   **空链接保留原 Being，不能清除**。`grep -rho "handle('beings:[a-z-]*'" desktop/main | sort -u | wc -l` = **61** 条通道，没有一条解绑；渲染层也没有入口。
   BD 0.8.26 的 `handle('disconnect')`（`src/main.cjs:1476`，清 `disk.credential` + `orchestration.selectOwner('')` + `chatSessions.end()` + …）
   就是这个缺失的调用方，**portal-desktop 从来没有这条命令**。
2. **换 Being 不应该走这个钩子**。BD 的换 Being 在 `storeConnection`（`src/main.cjs:704-716`）里一步完成：
   `if (!connection || sessionPartition(connection)!==sessionPartition(parsed)) {identityRevision++; desktopTools?.disconnectLink(); …}` 然后绑新的，
   **没有 disconnect 这一步**。本外壳的 I2/I4/I6 三个 `connectionVerified` 都是按 `sessionPartition` 比对后做同一件事。
   在 `beings:save` 里插一行 `connectionCleared()` 会在两个都已绑定的状态之间推一次空账本、空侧栏、断一次工具桥，
   几微秒后又被 `connectionVerified` 撤销——BD 没有这个闪烁。

所以**没有加这行调用**。新增 `tests/connection-cleared.test.ts`（2 例）把结论钉住：
一条走真实 `SettingsStore` 断言「空链接 / 不给链接都清不掉，换 Being 是一步替换，重启后仍是新的那个」——
**哪天有人加了解绑路径，这条会先红并指向 `connectionCleared()`**；
另一条用三个假子系统跑真实 `installSubsystems`，断言 cleared 扇出仍按安装顺序、单个抛错记 `beta-cleared` 且不打断其余
（钩子本身没坏，不能当死代码删掉）。

### 2.12 `beings:town-open` 回到工具浏览器（i1 记录遗留 2）——已改

BD `src/main.cjs:1252`：`handle('openTownPage', id => browserLinks().open(townPageUrl(id)))`——
**页面开在工具浏览器的标签页里**，面板同时前置；这不是口味问题：只有那个浏览器里的页面 Being 才读得到、操作得了。
I1 的 worktree 里没有工具桥，退而用了 `ctx.electron.shell.openExternal`，并记为偏差。

`desktop/main/subsystems/town.ts` 传给 `registerTownDesktopIpc` 的 `openExternal` 改成：
`const links = ctx.registry.get('tools')?.links; if (links) { links.open(url); return; } return ctx.electron.shell.openExternal(url);`
——惰性解析（在回调里，不在构造期）；**`open()` 内部失败（窗口没了、地址被拒）照 BD 抛出，不退回系统浏览器**，
只有「压根没有工具桥」才退回。`town/ipc-desktop.ts` 的路由允许名单**一个字没动**（那是 I1 的文件）。

新增 `tests/town-integration-open.test.ts`（3 例）：装 tool-browser + tools + town 三个子系统，断言
(a) 链接进了工具浏览器的标签页、`beings:tools-state` 先于 `beings:tools-reveal:'browser'` 推送、`shell.openExternal` **没有**被调用；
(b) 允许名单在两条路径上都原样（六个坏 route 都抛「不支持的 Town 链接。」，且没有开出任何标签页）；
(c) 只装 town 子系统时退回 `shell.openExternal`。

### 2.13 项目切换 `beings:sidebar-project-select`（i6 记录 §4.3 / §9.5 与 i3 未做 5）——已补

i6 当时的理由是「本外壳没有文件浏览页，唯一能切换的 `settings.workspace` 是 Portal 工作目录」；
但 I2/I3 落地之后，`DesktopTools({getWorkspace})`、`DesktopConsole({getWorkspace})` 与终端**都**读 `Settings.projectWorkspace`，
所以「切换项目」现在有确切的含义了（i6 §9.5 也是这么写的）。

BD `src/main.cjs:574` `selectSavedProject`：校验目录在 `sidebarState(...).projects` 里 → `disk.workspace = selected` + 落盘（失败回滚）
→ `state.workspace = {path, files}` → `desktopTools?.changed()`。

落地：

| 层 | 改动 |
| --- | --- |
| `main/shell/sidebar-state.ts` | 新增 `assertSavedProject(saved, scope, workspace, project)`——只有 BD 的那条校验，不写盘（切工作目录不是账本变更）。 |
| `main/shell/ipc.ts` | 新增 `beings:sidebar-project-select`（进 `ctx.exclusive`，BD 把它和 `sidebarAction` 一起列进串行表 `src/main.cjs:141`），字符串 + 4096 上限，其余交给 reducer 拒绝。 |
| `main/subsystems/shell-state.ts` | `selectProject`：校验 → `saveExtra({ workspace })`（**BD 的同一个磁盘键**，`app/settings.ts:68` 就是从这个键读进 `projectWorkspace` 的，所以 0.8.x 档案互通）→ `ctx.store.settings.projectWorkspace = chosen` → 推 `beings:sidebar` → `ctx.registry.get('tools')?.tools?.changed()`（BD 的 `desktopTools?.changed()`）。 |
| `shared/shell-state-types.ts` / `preload/channels/shell-state.ts` | `selectProject(project)` 各一行。 |
| `renderer/app/components/sidebar.tsx` | 项目菜单加「设为工作目录」（BD 的「浏览文件」，本外壳没有文件浏览页，所以切换本身就是全部动作）。 |

**为什么要写 `ctx.store.settings.projectWorkspace`**：`saveExtra` 只写文件，不动 `SettingsStore.settings` 那半，
而所有工作目录消费者读的都是后者；BD 对应的就是 `state.workspace = {...}` 那一行。
不走 `store.save()`：那是 Portal 的路径，会重新校验连接、可能重启引擎（`main.ts:441`）——从侧栏选个文件夹不该做这两件事。
`save()` 会原样带过 `projectWorkspace`（`app/settings.ts:147`），`load()` 从上面写的键读回来，三者一致。

测试：`tests/shell-state-ipc.test.ts` 新增 2 条（真 `SettingsStore`：落盘到 BD 的 `workspace` 键、`projectWorkspace` 变了、推送、重启后仍在、
六种坏输入都拒且不写盘），`CHANNELS` 常量加一条；
新增 `tests/shell-state-integration-workspace.test.ts`（2 例）：**shell-state + tools + tool-browser 一起装**，
断言选中之后 `beings:tools` 的 `workspace` 真的变了、`beings:tools-state` 推的也是新的、拒绝时一切不变；
`tests/sidebar-e2e.mjs` 加 4 条 check（`project-new-task-binds-project`、`projects-contain-their-tasks`、
`workspace-unset-before-select`、`project-select-moves-workspace`），**本机真跑通过，14 条全绿**。

