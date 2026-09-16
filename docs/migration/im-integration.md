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
- 4.3 / 9.5：**没有 `beings:select-saved-project`**，理由是「本壳层没有文件浏览页，唯一能切换的 `settings.workspace` 是 Portal 工作目录」；
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

### 2.13 项目切换 `beings:select-saved-project`（i6 记录 §4.3 / §9.5 与 i3 未做 5）——已补

i6 当时的理由是「本外壳没有文件浏览页，唯一能切换的 `settings.workspace` 是 Portal 工作目录」；
但 I2/I3 落地之后，`DesktopTools({getWorkspace})`、`DesktopConsole({getWorkspace})` 与终端**都**读 `Settings.projectWorkspace`，
所以「切换项目」现在有确切的含义了（i6 §9.5 也是这么写的）。

BD `src/main.cjs:574` `selectSavedProject`：校验目录在 `sidebarState(...).projects` 里 → `disk.workspace = selected` + 落盘（失败回滚）
→ `state.workspace = {path, files}` → `desktopTools?.changed()`。

落地：

| 层 | 改动 |
| --- | --- |
| `main/shell/sidebar-state.ts` | 新增 `assertSavedProject(saved, scope, workspace, project)`——只有 BD 的那条校验，不写盘（切工作目录不是账本变更）。 |
| `main/shell/ipc.ts` | 新增 `beings:select-saved-project`（进 `ctx.exclusive`，BD 把它和 `sidebarAction` 一起列进串行表 `src/main.cjs:141`），字符串 + 4096 上限，其余交给 reducer 拒绝。 |
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


---

## 3. 门槛

在 `f4c56f5`（第 13 条完成）上实测：

| 门槛 | 基线 `next @ 7b2cef8` | 本单元 | 差 |
| --- | --- | --- | --- |
| `npm run typecheck` | 绿 | **绿** | — |
| `npx vitest run` 文件 | 109 | **115 passed / 8 skipped = 123** | +14 文件 |
| `npx vitest run` 用例 | 1197 通过 / 34 跳过 | **1221 通过 / 34 跳过** | **+24 通过，跳过数不变** |

+24 = 浏览器归属 6 + QUIT_ALLOWED 5 + WorkerPresenter 1 + 侧栏活动灯 4 + connectionCleared 2 + town-open 3
+ shell-state-ipc 2 + 工作目录联装 2 − 删掉的 `protocolFile` 1。**没有重新启用任何 skip，也没有新增 skip。**

## 4. 真机冒烟

### 4.1 打包

产物沿用第 1–13 条期间打的那一份（命令逐字记录在此，便于复现）：

```
cp /Users/d5c/Documents/ChatGPT/BeingDesktop/.local/i2-tools/resources/heart-portal resources/heart-portal   # clang 编的 Mach-O stub，--version 打印版本号
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy PORTAL_DESKTOP_MAC_LOCAL_TEST=1 npx electron-forge package
codesign --force --deep --sign - "out/Being Desktop-darwin-arm64/Being Desktop.app"
```

产物：`/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/im-integration/out/Being Desktop-darwin-arm64/Being Desktop.app`
（`codesign -dv` → `Signature=adhoc`、`Identifier=town.beings.desktop`）。
asar 里 `/.vite/renderer/main_window/index.html` 与 `/node_modules/node-pty/bin/darwin-arm64-149` 都在，
说明 Vite external 与 asar prune 两件事都对。

### 4.2 首次启动被系统钥匙串对话框挡住（环境问题，不是代码缺陷；实测，不是推断）

**现象**：刚 ad-hoc 重签之后的**头两次** `electron.launch` 都是
`Timeout 180000ms exceeded`——Playwright 的两个 ws 都连上了，然后一直等不到窗口。

**定位过程（全部是实测）**：

1. 直接跑产物，40 秒内 stdout/stderr 一个字都没有，但 `ps` 里 GPU 与 Renderer 两个 helper 都在。
2. 用 `--inspect=9333` 挂上主进程的 node inspector（`Runtime.evaluate` + `includeCommandLineAPI`）：
   `app.isReady()` = `true`、`app.whenReady()` 立刻兑现，`BrowserWindow.getAllWindows()` = **一个窗口，`url` 是空串**。
3. 再挂一次（`--inspect=9334`，新 profile），这次 4 秒时窗口已经是 `beings://desktop/`、`loading:false`、`visible:true`，
   `protocol.isProtocolHandled('beings')` = `true`，`did-fail-load` 一条没有。
4. 最小 Playwright 脚本（同一个 executable、同样的空 profile）：**`electron.launch` 262 ms 返回**，
   `firstWindow().url()` = `beings://desktop/`；`pw:protocol` 日志里
   `beings://desktop/assets/index-*.js` 与 `*.css` 都是 `status:200`。
5. 原封不动重跑 `node tests/browser-e2e.mjs`：**PASS**。

**结论**：产物是好的，卡的是**第一次**。`main.ts:583-584` 的 `windowReady = true; createWindow();` 排在整个异步 `ready()` 的**最后**，
而 `ready()` 前面要取 `safeStorage`（`main.ts` 的 `secretStorage`）——ad-hoc 签名每次重签都变，macOS 因此弹**模态**钥匙串授权框，
主进程同步卡在那里，窗口就一直停在「已创建、未 load」的状态，与第 2 步观察到的完全一致。
`tests/support/electron-lifecycle.mjs` 里那个 `PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN=1` → `--use-mock-keychain` 的开关，
注释写的正是这件事（"Ad-hoc macOS builds change their signature on every rebuild"），
但 `tools-e2e` / `browser-e2e` / `terminal-e2e` **都没有设这个环境变量**，所以刚重签之后的第一次跑必然撞上。
→ 记进 openIssues（本单元不改这三个脚本的环境变量：那会把「真钥匙串」这条覆盖悄悄换成假的，属于产品判断，不该由整合单元替 I5/I2/I3 拍板）。

### 4.3 打包产物上的 E2E（逐条命令与结果）

全部在 `out/Being Desktop-darwin-arm64/Being Desktop.app` 上跑，一次一个（四个 worktree 共用 `os.tmpdir()` 下的 E2E 锁）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `node tests/tools-e2e.mjs` | **PASS**：握手 1 次，`tools/list` **15** 个工具（i2 记录当时是 9——I4/I1/I6 合入后工具桥多了 6 个），允许 1 次、拒绝 1 次，收起面板后原生视图已分离。 |
| 2 | `node tests/terminal-e2e.mjs` | **PASS**：打包客户端能启动 PTY、回显命令并关闭会话（node-pty 的 native rebuild + asar unpack 在产物里是对的）。 |
| 3 | `node tests/sidebar-e2e.mjs` | **PASS**，14 条 check 全绿，含本单元第 13 条新加的 4 条。 |
| 4 | `node tests/browser-e2e.mjs` | **PASS**：原生页面、地址栏、历史、弹窗、模态层叠、会话保持、隔离、关闭清理。 |
| 5 | `node tests/town-sdk.mjs` | **FAIL**（9 过 4 挂，见 §4.4）——**这是它第一次被执行**。 |
| 6 | `node tests/town-ui.mjs` | 见 §4.5 |
| 7 | `node tests/menu-keyboard.mjs` | 见 §4.6 |
| 8 | `node tests/update-progress.mjs` | 见 §4.6 |

### 4.4 `tests/town-sdk.mjs` 首次执行：两个脚本缺陷（已修）+ 一个继承自 0.8.26 的真缺陷（未修，见 openIssues）

**脚本自己的两处（已就地修，属本单元可改范围）**：

1. **发送回执少了身份字段**。夹具对所有 POST 回 `{ok:true, seq:12, id:'sent-1', via:'client:desktop'}`。
   但 `session/client.ts:458` 是 `this._identity(result, ctx, 'being')`，`_identity` 在没有 `town_id` 也没有 `being` 时抛 `INVALID_RESPONSE`，
   被外面的 `catch` 转成 `RESULT_UNKNOWN`——所以 `speak` 直接以「发送结果未确认…」中断，后面 5 条 check 根本没跑到。
   私信那条还要 `result.message_id` 是字符串（`client.ts:485`），夹具给的是 `id`。
   **逐行核对过上游**：`BeingDesktop/src/town-client.cjs:301` 与 `:326` 是同两行，**客户端是对的，夹具是错的**。
   夹具改成回 `{ok:true, seq:12, message_id:'sent-1', town_id:'t_Willow', via:'client:desktop'}`。
2. **按键序比较请求体**。`check('the three speak bodies…')` 用 `JSON.stringify` 全等比较，
   而实际围炉体是 `{message, fireside_id}`（`client.ts:456` 的展开顺序，与 `town-client.cjs:298` 一致），
   期望写的是 `{fireside_id, message}`——**内容完全正确，只有键的插入顺序不同**。
   JSON 对象在线上没有顺序，这条断言等于要求一个谁都没承诺的东西。改成递归按键排序后比较（`canonical()`），
   **字段集合与每个值仍然逐个断言，没有放宽**。

**第三处不是脚本的问题，也不是本单元该改的**（→ openIssues）：4 条读 `error.code` 的 check 现在**必然挂**。

- 现象：`window.beings.townDesktop.bonfire()` 在未配对时 reject 出来的 Error，
  `Object.getOwnPropertyNames(e)` 只有 `["stack","message"]`，**没有 `code`**；
  同一时刻 `townDesktop.appState()` 里 `sync.bonfire.errorCode` 是 `"AUTH_REQUIRED"`——主进程知道，渲染层拿不到。
  「旧连接」那条也一样：消息是对的（`Being 连接已变化。`，说明 `SESSION_CHANGED` 的守卫真的拦住了，没有多发第 4 条），只是 `code` 没了。
- 根因（**实测，两个文件的独立夹具，不是推断**）：`/tmp/im-cb/fixture` 一个 preload + 一个空白页，
  `contextBridge.exposeInMainWorld` 暴露 `reject: async () => { throw Object.assign(new Error(m), {code:'AUTH_REQUIRED'}) }`。
  在**本仓库这一版 Electron（44.2.0）**下，页面收到的 Error 的自有属性是 `["stack","message"]`（同步抛是 `["stack","message"]`，`Object.keys` 只有 `message`）；
  而把同一个值当**普通对象**返回，`{__townError:true, code:'AUTH_REQUIRED', message:…}` **原样到达**。
  → `contextBridge` 会剥掉 Error 上的自定义属性，普通对象不会。
- 所以 `preload/channels/bridge.ts` 的 `enveloped` 与 `preload/channels/town.ts` 的 `townEnveloped`
  **把包络还原成 Error 的位置错了一侧**：还原发生在 preload，而 preload 到页面之间还隔着 contextBridge。
  两个文件的注释都写着「a failure arrives as data and is turned back into an Error carrying its `code`,
  which is the only way a code survives the trip」——前半句对，后半句在这一版 Electron 上不成立。
- **这是从 0.8.26 继承的，不是移植引入的**：`BeingDesktop/src/preload.cjs` 第 60-76 行是同一套做法，
  它自己的注释就写着「Electron strips custom Error fields. Preserve only known Town error categories.」，
  而 `renderer/town-app.js:308`（`error.code`）与 `:1027`（`error?.code === 'AUTH_REQUIRED'`）两处分支在 0.8.26 里同样永远走不到。
  0.8.26 的 `package.json` 也是 `electron 44.2.0`。
- **本单元不修**：正确的修法是把包络当数据交给渲染层、在渲染层还原（或由渲染层统一包一层），
  这会改变 Town 与对话两族通道**每一个调用点**收到的东西——跨 I1/I5/I7/I6b 四个单元的文件，
  其中三个正在并行改这些文件。属于「应用层缺陷，附证据进 openIssues，不顺手重构」。
  脚本里的 4 条断言**原样保留**（它们断的是正确契约），只在文件头写清楚原因与证据出处。

### 4.5 `tests/town-ui.mjs` 首次执行：两个脚本缺陷（已修）+ 一个应用层重复读（未修，见 openIssues）

跑到第 4 条 check 停住。逐层测下来（全部实测）：

**脚本自己的两处（已就地修）**：

1. **夹具把自己饿死了**。`/api`（公共成员目录）原来的写法是每个并发请求各自
   `await new Promise(resolve => { globalThis.town.resolveMembers = resolve; })`——**永不兑现**，
   而且 `resolveMembers` 每次被覆盖，最后只兑现得了一个。
   目录不到时客户端会重试，实测 `globalThis.town.members` 涨到 **9**，九个请求同时挂在 `https://beings.town` 上。
   后果不是「目录慢」，是**整个源都挂死**：
   `held-direct-bonfire` → `HUNG>8s`、`held-refreshTimeline` → `HUNG>8s`——
   连**根本不读目录**的 `townDesktop.bonfire()` 直读都一起挂；`sync.bonfire.status` 永远停在 `refreshing`、`lastSuccessAt: null`。
   feed 当然是空的，于是「目录还没到也要出消息」那条永远等不到 `.social-message`，**看起来像产品缺陷，其实是夹具的**。
   改成「还没到」= 一次 **503 快速失败**（不占请求），同一次调用立刻变成
   `held-direct-bonfire {"ok":true,"n":2}`、`held-refreshTimeline {"ok":true}`、`sync.status: ready`。
2. **按渲染顺序取第一条**。`check('messages render while…')` 取 `.social-message` 的 `.first()`，
   但 feed 默认排序是「最新在前」，带 `@t_River` 的是 seq 7，排在 seq 8 之后——
   实测渲染出来的是 `["…第二条篝火消息…", "…篝火消息 @t_River…"]`，`.first()` 里没有 `@t_River`。
   改成在全部文本里按内容找，并**additionally** 断言「两条都渲染出来了」——比原来强，不是更松。

修完之后前 4 条 check 通过，停在第 5 条 `the pending directory did not stop the feed read`（`reads.length === 1`）。

**第三处是应用层的，不改**（→ openIssues）：**一次打开发两次 feed 读**。

- 实测：首次绘制那一刻 `reads` 是 **1** 条（`since:null`），**250 ms 之后变成 2 条**（同样 `since:null`）。
- 关键对照：把目录改成**立刻成功**（`holdMembers:false`，目录根本不挂）跑一遍，`reads` 同样是
  `[{at:…754424},{at:…754674}]` —— **两条，间隔 250 ms**。
  所以这次重复读**与目录是否就绪无关**，也不是 503 模型引入的，是打开篝火本身就读两次。
- 顺带量到：干净成功的一次打开，公共目录 `/api` 被请求 **4** 次（失败时 9–12 次）——公共目录没有 in-flight 去重。
- 这条 check 的断言（`=== 1`）是对的，**原样保留不动**；它现在红，指的正是上面这件事。

### 4.6 `tests/menu-keyboard.mjs` 与 `tests/update-progress.mjs`

- `update-progress`：**PASS**（更新弹窗的阶段、真实字节/百分比进度、未知总量、取消后焦点回到设置、安装中不可关闭）。
- `menu-keyboard`：原来**两处都挂**，都是脚本层的，已修，现在 **PASS**：
  1. **esbuild 没有输出路径**。脚本用 `write:false` 且不给 `outdir`，而 `Topbar` 现在经 `app/slots.tsx`
     牵进四个 slot，每个 slot 都 `import "./styles.css"`（I2/I3/I4/I6 合入之后才有的），
     于是整包构建被 esbuild 拒绝：`Cannot import … into a JavaScript file without an output path configured`。
     加 `outdir`（仍 `write:false`，只是给 CSS 一个名字）+ `loader:{'.png':'dataurl'}`，
     输出改成按扩展名挑（`outputFiles[0]` 不再一定是 JS），并把 slot 的 CSS 接在 `app/styles.css` 后面一起喂给夹具页面。
  2. **夹具模型少了 `features`**。slot 注册表会问每个 topbar action 可不可见，
     而 `desktop/renderer/tools/slot.tsx:39` 读的是 `app.features.tools`——
     没有 `features` 不是「没有功能」，是 `Cannot read properties of undefined (reading 'tools')`，
     整个 topbar 渲染失败，所以 `#options-trigger` 根本不存在（实测 pageerror 就是这一句）。
     夹具补 `features: {}`（这个夹具本来就不挂载任何功能）。

### 4.7 真机走查查出的一个回归——是本单元第 2 条引入的，已修

第一次走查跑完，`<userData>/logs/client-errors.log` 里有一条：

```
[beings:tool-browser-viewport]
Error: 浏览器已经关闭。
    at Of._alive (…/app.asar/.vite/build/main.js)
    at Of.setViewport (…)
```

**是本单元第 2 条把两条视口通道放进 `QUIT_ALLOWED` 之后才有的**：放行只做了一半。
放行之后它们真的会走到 `DesktopBrowser.setViewport`，而 `subsystems/tool-browser.ts` 的 `quitting()`
**先**把浏览器 `destroy()` 了，面板 unmount 发出的最后一条 `visible:false` 随后到达，
`_alive()` 抛「浏览器已经关闭。」，`createTrustedHandle` 把它记进错误日志——
**每一次「开着工具浏览器面板退出」都会写一条**。放行之前它是被 quitting 守卫拒掉的，不写日志，所以看不见。

改法（都在本单元独占的 `desktop/main/tools/**`）：**松开一个已经不存在的矩形不是失败**。

| 文件 | 改动 |
| --- | --- |
| `tools/types.ts` | `DesktopBrowserLike` 加 `readonly destroyed: boolean`（真类本来就有，`browser.ts:238`），并写明为什么只有这两条通道读它。 |
| `tools/browser/ipc.ts` | `beings:tool-browser-viewport`：**先校验参数**，再 `required()`（没有浏览器仍然拒绝——那是 Electron 门面被拒，不能静默），**只有 `destroyed` 时**返回 `idle` 且不调用 `setViewport`。 |
| `tools/ipc.ts` | `beings:tools-browser-view`：同样，`live.destroyed` 时返回 `IDLE_TOOLS_STATE.browser`。 |

`tests/app-ipc-quit-allowed.test.ts` 加 2 条（5 → 7）：
「浏览器已销毁时两条通道都安静作答、两个面都没有被要求摆放任何东西」，
以及「销毁不是接受垃圾输入的理由——参数校验仍然先跑」（`{visible:'no'}` 仍抛「浏览器显示参数无效。」）。

**重新打包 + 重签之后再走一遍，`ERROR-LOG scopes: []`**——回归确认修掉。

### 4.8 `npm run start`（开发路径）与面板走查

**a) `npm run start`**（`PORTAL_DESKTOP_USER_DATA=/tmp/im-devprofile`，避免和别的 worktree 抢单实例锁；
先 `pgrep` 确认没有别人的 Electron 在跑）：

- `prepare:desktop` 通过（"Prepared local desktop assets (no CDN requests)"）；
  Vite 两个目标都构建成功（`target built desktop/preload/preload.ts`、`target built desktop/main/main.ts`）；
- 窗口起来了：`[{"url":"http://localhost:5173/","visible":true,"title":"Portal Desktop"}]`，`app.getVersion()` = `0.9.0`；
- **`<userData>/logs/client-errors.log` 根本没有被创建**——即**没有任何 `subsystem-install` / `onError` 报告**；
- 用主进程 inspector 调 `app.quit()`（走真实退出路径，含 `extensions.quitting()`）：进程干净退出，无残留。
  退出瞬间终端上有一行 `Error occurred in handler for 'beings:snapshot': Error: 客户端正在退出，请稍候。`
  ——这是**退出守卫在正常工作**（`beings:snapshot` 不在 `QUIT_ALLOWED` 上，渲染层在拆卸时又问了一次快照），
  不是错误日志条目；记在这里是因为它看起来吓人。

**b) 面板走查**（在**打包产物**上做，比 dev 更接近用户；脚本留在
`…/scratchpad/im-smoke-walk.mjs`，夹具 Being 用 `protocol.handle('http')` 拦 `127.0.0.1:1`）：

| 步骤 | 结果 |
| --- | --- |
| 绑定夹具 Being（设置对话框 → 保存、连接并启动） | OK |
| 终端面板：新建终端，输入 `echo being` | **OK，回显到 `.xterm-rows`** |
| 工具浏览器面板：在它自己的标签页里打开一个本地 http 页面 | **OK，标签标题变成「工具浏览器冒烟」** |
| 编排与 Worker 面板 / 功能任务面板 | OK |
| Town：小镇 → 配对页 → 配对码对话框 → 回到对话 | OK |
| 关于 / 隐私两个外壳页（开→关→开→关） | OK |
| 置顶一个会话 | OK（`[aria-label="已置顶"]` 里出现） |
| 退出 → 再起（同一 profile） | **仍置顶**；且磁盘 `settings.json` 的 `sidebar.owners[<scope>].tasks[<id>].pinned === true` |
| 渲染层 `pageerror` | 0 条 |
| `logs/client-errors.log` 里的 `subsystem-*` scope | **0 条** |

唯一的日志条目是重启那一轮的 `startup-connection` / `startup-notice`：
夹具的 `protocol.handle('http')` 只能在应用起来之后装，所以第二次启动的**开机连接校验**必然先失败一次
（脚本随后用磁盘上的设置重新 `save()` 一次让它绑回来）。这是走查夹具的时序，不是产品问题。

**连上真实 Being 发消息没有做**：本机没有可用的 Being/Portal（引擎是 stub），
所以对话核心只在夹具层面跑过；方案 §6.3 里「连接夹具 Being 发消息」这一条记进 openIssues。

---

## 5. IPC 通道清单（本单元的全部改动）

**新增 1 条**：

| 通道 | 方向 | payload | 守卫 | 来源 |
| --- | --- | --- | --- | --- |
| `beings:select-saved-project` | invoke → `SidebarState` | `project: string`（≤4096，非字符串/超长/不在已保存项目里都拒） | `ctx.exclusive`（BD `src/main.cjs:141` 把它与 `sidebarAction` 一起列进串行表） | BD `selectSavedProject`（`src/main.cjs:574`）/ `being:sidebarProjectSelect` |

**行为改变、名字没动的 3 条**：

| 通道 | 之前 | 现在 |
| --- | --- | --- |
| `beings:town-open` | `ctx.electron.shell.openExternal(url)`（I1 的偏差） | `ctx.registry.get('tools')?.links.open(url)` → 工具浏览器标签页；**拿不到工具桥**才退回 `openExternal`。允许名单一字未动；`open()` 自身失败照 BD 抛出，不退回系统浏览器 |
| `beings:tool-browser-viewport` | 退出期被恒拒 | 进 `QUIT_ALLOWED`；浏览器已 `destroy()` 时**安静返回 idle**（参数仍先校验；没有浏览器仍然拒绝） |
| `beings:tools-browser-view` | 退出期被恒拒，渲染层用 `VIEWPORT_RETRIES=3` 封顶 | 进 `QUIT_ALLOWED`，封顶删除（恢复 0.8.26 的无条件重试）；浏览器已 `destroy()` 时返回 `IDLE_TOOLS_STATE.browser` |

`QUIT_ALLOWED` 现在是 `['beings:browser-bounds','beings:tools-browser-view','beings:tool-browser-viewport','beings:diagnostics']`。
**没有删除、没有改名任何通道。**

## 6. 装配点

| 位置 | 接了什么 |
| --- | --- |
| `subsystems/tools.ts` | `getBrowser: () => ctx.registry.get('tool-browser')?.browser ?? null`（惰性，每次访问解析）；Electron 门面检查上移到子系统；`linked()` 里 `orchestration.presentation` 直接赋值，无 cast |
| `subsystems/tool-browser.ts` | onChange 里 `push.state(snapshot)` 之后 `ctx.registry.get('tools')?.tools?.changed()`——浏览器一变，`beings:tools-state` 也重算（BD `DesktopTools` 自建浏览器时的 `onChange` 语义） |
| `subsystems/town.ts` | `openExternal` 改为先取 `ctx.registry.get('tools')?.links` |
| `subsystems/shell-state.ts` | `selectProject`：校验 → `saveExtra({workspace})`（BD 同一个磁盘键）→ 写 `ctx.store.settings.projectWorkspace` → 推 `beings:sidebar` → `ctx.registry.get('tools')?.tools?.changed()` |
| `renderer/app/components/sidebar.tsx` | 会话灯改调 `session-activity.ts` 的纯函数，数据取 `app.features.orchestration?.hasActiveWorkers(id)`；项目菜单加「设为工作目录」 |

**全部经 `ctx.registry` 惰性 getter，构造期一次都没有取过实例。**

## 7. 共享文件触碰行

| 文件 | 本单元做了什么 |
| --- | --- |
| `desktop/main/app/ipc.ts` | **本单元的例外**：`QUIT_ALLOWED` 由 2 项改为 4 项 + 常量上方的理由注释 |
| `desktop/renderer/app/styles.css` | **本单元的例外**：`#browser-panel` 一行 `flex:0 0 49%;min-width:0` → `flex:0 1 49%;min-width:240px` |
| `desktop/renderer/app/components/sidebar.tsx` | **本单元的例外**：会话灯改调纯函数、项目菜单加一项 |
| `desktop/renderer/README.md` | **本单元的例外**：目录树补七个模块 |
| `package.json` | **本单元的例外**：`scripts` 段 append 三行（`test:tools` / `test:terminal` / `test:sidebar`），**依赖一个没动** |
| `scripts/test-all.mjs` | **本单元的例外**：内联的 tools-e2e 改成 npm 脚本，另加 terminal-e2e、sidebar-e2e 两步 |
| `MIGRATION.md` | **本单元的例外**：两个「集成阶段」小节合成一个 + 补表头，五行原文逐字保留，末尾 append IM 一行；I0 小节的 `connectionCleared()` 那条补上本单元的核实结论 |
| `desktop/preload/channels/shell-state.ts` | **append 一行**：`selectProject: project => ipcRenderer.invoke('beings:select-saved-project', project),` |
| `desktop/shared/shell-state-types.ts` | **append**：`selectProject(project: string): Promise<SidebarState>;` 一行（带注释） |
| `desktop/main/main.ts` | **一行都没改**（第 11、12 条都不需要动它：11 的结论是没有可接的时刻，12 落在 `subsystems/town.ts`） |

`desktop/main/extensions.ts`、`preload/channels/index.ts`、`shared/desktop-types.ts`、`shared/types.ts`、
`renderer/app/slots.tsx`、`app/models/registry.ts`、`subsystems/types.ts`、`app/page.tsx`、
`forge.config.ts`、`vite.*.config.ts`、`tsconfig.json`、`vitest.config.ts`、`use-conversation-bridge.ts`
——**一个字都没动**。`subsystems/chat.ts`、`main/chat`、`renderer/conversation`、`renderer/settings`、
`renderer/channel`、`main/features` 的导航接线（I5 / I6b / I7 的地盘）同样没碰。

## 8. 未做事项 / 存疑（openIssues）

1. **`contextBridge` 剥掉 Error 的 `code`，Town 与对话两族通道的错误码都到不了渲染层**（§4.4）。
   实测于 Electron 44.2.0，两文件独立夹具复现；`preload/channels/{bridge,town}.ts` 把包络还原成 Error 的位置在 contextBridge 的**错误一侧**。
   **从 0.8.26 继承**（`src/preload.cjs` 60-76 行，`renderer/town-app.js:308`/`:1027` 的分支同样走不到）。
   修法要改每一个调用点收到的东西，跨 I1/I5/I7/I6b 四个单元，不是本单元能做的。
   直接后果：`tests/town-sdk.mjs` 的 4 条断言红（9 过 4 挂），`npm run test:all` 因此不是全绿。
2. **打开一次篝火发两次 feed 读**（§4.5）。首次绘制时 1 条，250 ms 后第 2 条，`since` 都是 `null`；
   目录立刻成功时同样两条，与目录无关。`tests/town-ui.mjs` 停在 `the pending directory did not stop the feed read`。
   顺带：公共目录 `/api` 一次干净打开被请求 4 次（失败时 9–12 次），没有 in-flight 去重。
3. **刚 ad-hoc 重签之后的第一次启动会被系统钥匙串对话框挡住**（§4.2），
   `tools-e2e` / `browser-e2e` / `terminal-e2e` 都没设 `PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN=1`，
   所以打包后第一次跑必然 `electron.launch: Timeout 180000ms exceeded`，第二次起正常。
   要不要给这三个脚本也开假钥匙串，是 I2/I3/I5 的产品判断（开了就等于不再覆盖真钥匙串），本单元没有替它们决定。
4. **窗口标题仍是 `Portal Desktop`**：`desktop/renderer/index.html:7` 的 `<title>` 没跟着改名，
   而 `main.ts:42` 的 `CLIENT_NAME` 是 `Being Desktop`；文档标题会覆盖 `BrowserWindow` 的 `title`，
   所以标题栏和 App 切换器里显示的是旧名字（实测 `w.getTitle()` → `"Portal Desktop"`）。
   `desktop/renderer/index.html` 不在本单元可改清单里。
5. **没有连真实 Being 发过消息**：本机引擎是 stub，方案 §6.3 的「连接夹具 Being 发消息、退出无错」只做到了
   「绑定夹具 Being + 面板全走一遍 + 干净退出无错」，**对话发送没测**（那是 I5 的 `electron-smoke` 覆盖的事）。
6. **`desktop/main/app/protocol.ts` 的 403 守卫没有任何单元测试**（§2.9）。删 `protocolFile` 没有让它变差
   （那条测的是另一个函数），但现在全树唯一一条「路径穿越」用例没有了。它 import electron，本仓库没给它建过夹具。
7. **`beings:snapshot` 在退出瞬间会被守卫拒一次**，终端上留下一行
   `Error occurred in handler for 'beings:snapshot'`。守卫是对的（它不是几何通道，不该放行），
   但渲染层在拆卸时不该再问快照。属于渲染层拆卸顺序，未改。
8. **`tests/town-ui.mjs` 只跑到第 5 条 check**，后面的累积时间线、私信候选人、`NOT_SENT` 候选等
   （约 10 条）**仍未被执行过**，挡在第 2 条 openIssue 后面。
9. `tests/sbs-refresh.mjs`（I6b）、`tests/electron-smoke.mjs`（I5）、`tests/portal-runtime-e2e.mjs`（I7）
   本单元**没有跑**：它们要重写，重写者是并行组 B 的其它单元。

## 9. `npm run test:all` 的现状

流水线是 fail-fast 的（每一步 `await`，抛出即中止）。三个新步骤排在 `package` 之后、`browser-e2e` 之后，
位置正确；但**第 85 行的 `town-sdk` 会先失败**（openIssue 1），所以整条流水线现在停在那一步，
`report.status` 是 `failed`。本单元验证三个新步骤的方式是**单独跑**（§4.3 第 1–3 行，全绿）。
`summary.md` 的 `skipped` 名单由脚本自己打印的 `SKIPPED:` 标记生成，本单元**只增加步骤，没有让任何一步变成 skip**。
