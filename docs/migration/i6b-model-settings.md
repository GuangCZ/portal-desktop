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

### 1.5 `src/model-config.cjs`（198 行，本单元的主移植源）

- `PROVIDERS`（9 项，逐字节移植，注释保留「镜像 Loom 1.8.0 的 providerNames/inferBaseUrl + Heart 的 CANONICAL_URLS」）：
  anthropic / openai-responses / openai / deepseek / kimi / google / glm / self-hosted（`keyless:true`，`http://115.190.110.33:7860/v1`）/ openrouter。
- `MESSAGES` 九条错误码：`NOT_CONNECTED` / `SESSION_CHANGED` / `BUSY` / `AUTH_REQUIRED` / `NETWORK_ERROR` /
  `INVALID_RESPONSE` / `RESULT_UNKNOWN` / `NEEDS_KEY` / `ROLLED_BACK`（外加 `validateModelPatch` 用的 `INVALID_REQUEST`，
  它**不在** `MESSAGES` 里 —— `request()` 的 `Object.hasOwn(MESSAGES, error.code)` 因此对 INVALID_REQUEST 为 false，这是有意的）。
- `modelConfigDto(value, connectionId, checkedAt)`：presets 上限 2000、`[provider, model]` 去重、`plainText` 去控制字符与
  BiDi 覆写字符（`‪-‮⁦-⁩`）、`publicModelUrl` 抹掉查询与凭据、`hasApiKey` 三态（true/false/null）、
  `providers` = 当前 provider + presets 的 provider + `PROVIDERS` 全部键去重、`modelsError` 只在 `presets` 不是数组时非空。
- `validateModelPatch(value)`：白名单 5 键 + `Object.getPrototypeOf(value) !== Object.prototype` 原型污染闸门 +
  「每个自有属性必须是数据属性（`Object.hasOwn(descriptor,'value')`）」+ `connectionId` 必须是 ≥0 的安全整数；
  `model` ≤512、`provider` ≤100 且匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`、`baseUrl` ≤2048（http/https、无凭据/查询/片段）、
  `apiKey` ≤16384；产出是 **snake_case** 的 `{model, provider, base_url?, api_key?}`。
- `responseJson`：1 MiB 上限（先看 `content-length`，再边读边累计），超限或 JSON 失败都是 `INVALID_RESPONSE`。
- `ModelConfig`：`busy`（同一 connection + connectionId 才算忙）、`context(expected)`（纪元校验 → `SESSION_CHANGED`；
  无连接或退出中 → `NOT_CONNECTED`）、`request(expected, patch?)`（GET/PATCH，`X-Relay-Secret`、`redirect:'error'`、
  `credentials:'omit'`、`cache:'no-store'`、`referrerPolicy:'no-referrer'`；401/403 → `AUTH_REQUIRED`；
  `needs_key` → `NEEDS_KEY`；`rolled_back` → `ROLLED_BACK`；PATCH 的 `INVALID_RESPONSE`/`NETWORK_ERROR` 一律折成 `RESULT_UNKNOWN`）、
  `remember`（记住 `baseUrl` 快照）、`get()`（busy → `BUSY`；revision 变了也 `BUSY`）、
  `save()`（校验 → 纪元比对 → busy 判定 → **base_url 未变则删掉它**（避免用脱敏地址覆盖私有查询参数）→ PATCH → 重新 GET 确认
  model/provider/baseUrl/hasApiKey 四项，任一不符 → `RESULT_UNKNOWN`）。

### 1.6 `src/runtime.cjs`（55 行）

`sideBySide.configured` 的唯一来源是 `/api/llm/config` 的 `sbs_enabled`（`readRuntime` 第 22 行 / `updateRuntimeConfig` 第 52 行），
三态 `true|false|null`；`active` 只来自已删除的 Loom 页面消息 `beings:sbs-state`。
`src/main.cjs:972-979`：`doRefresh` 并发读 `/api/status`、`/api/llm/config`、`/api/stream/active`；
**如果 `modelConfigRevision` 变了或 `modelConfig.busy`，就把 6 个 config 字段与 `sideBySide.configured` 从旧 state 抄回来**
——「先于显式修改发出的读取不能撤销它的快照」。本单元把这条语义保留为「PATCH 期间与之后的陈旧 GET 不覆盖新状态」。
`src/main.cjs:1231-1236`：`handle('getModelConfig')` / `handle('saveModelConfig')`（后者 `modelConfigRevision++`，
成功后写一条 activity「模型配置已保存」）。

### 1.7 SBS 写入协议：**实测，不是推断**（MEMORY「协议行为必须实测」）

BeingDesktop **没有** SBS 写入路径（`validateModelPatch` 白名单里没有 sbs，界面上是只读显示 +「在 Loom 中调整 Side by Side」）。
真实写法从两处实测得到，两处一致：

1. 真实 Loom 1.8.0 页面源码（`/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/loom-stream-source.html:1766-1778`）：
   ```js
   const data = await applyConfigChange({ sbs_enabled: next ? 'on' : 'off' });
   if (data && data.ok && data.config) setSbsEnabled(!!data.config.sbs_enabled, true);
   ```
   `applyConfigChange`（:1545）= `PATCH /api/llm/config`，headers `Content-Type: application/json` +
   `X-Relay-Secret`（有 relay secret 时），响应 `{ok, config, needs_key?, rolled_back?, error?}`。
   **值是字符串 `'on'` / `'off'`，不是布尔**；GET 回读时 `sbs_enabled` 是布尔。
   注释原话：不做乐观翻转，以服务端回声为准。
2. 本仓库 `tests/sbs-refresh.mjs`（现已 SKIPPED）的假 Being 夹具：`enabled = patch.sbs_enabled === 'on'`，
   回 `{ok:true, config:{sbs_enabled: enabled, ...}}`。该夹具当年就是对着真 Loom 页面写的。

`tests/sbs-refresh.mjs` 的旧脚本还钉住了四条行为，重写时逐条保留：
未确认时开关 disabled 且 `aria-pressed` 为 null；被拒绝的 PATCH 不乐观翻转；
更早发出的 GET 不能撤销随后确认的成功切换；503 / 字段缺失 → 状态回到「未知」，刷新可恢复。

### 1.8 `renderer/model-settings.js`（205 行）与 `test/model-settings-ui.cjs`（363 行 / 26 条 check）

界面状态机（要逐条保真）：

- 身份 = `JSON.stringify([ready, beingName, displayUrl, identityRevision, connectionRevision])`；
  身份变则 `generation++`、清空 snapshot/models/providers/draft/apiKey/feedback、`attempted=false`、折叠服务设置。
  `ready = connection.configured === true && connection.status === 'connected'`。
- `load()`：未连接或忙则不发；**有脏草稿时保留草稿**（`preserveDraft`），成功后提示「已刷新支持的模型，保留了未保存的更改。」；
  过期（`request !== generation`）的答复直接丢弃，既不写状态也不清 busy。
- `save()`：payload = `{model, provider, baseUrl, connectionId}`，`apiKey` 只在非空时带上；
  `finally` 里 `delete payload.apiKey`（密钥不在内存里多停留一拍）。
- 模型下拉：按 provider 分组，`keyless`（自部署）组排最前；选项文本 `名称 · 模型ID · 服务商`（名称与 ID 相同时省略中段）；
  末尾一条「自定义模型…」（`__custom__`）。
- 选模型：provider 跟着变；endpoint 取 `model.baseUrl || (provider 变了 ? providers[provider].baseUrl : '')`；
  provider 变或 endpoint 变时**自动展开** `model-service-settings`。
- 选 provider：base-url 换成该 provider 的默认值（没有就清空）；若当前选中的 preset 不属于该 provider，切到自定义并把模型名带过去。
- `keyNote`：`hasApiKey` → 「已有密钥；留空保留，填写新密钥可替换。」否则「当前配置未提供密钥；按服务要求填写。」；
  keyless provider 覆盖成「<名称>服务通常不填 API Key；Being 提示需要时填写后重新保存。」（注释标注为 2026-09-11 实测：
  Loom 切 keyless 不送 key，但 Being 仍可能索要）。
- `保存` 按钮：`!editable || !isDirty() || !modelName() || !provider` 时禁用；忙时文案「正在保存…」。
- 错误文案 `cleanError` 剥掉 `Error invoking remote method 'being:xxx': `前缀。
- API Key 输入框 `type=password`，**永不回填**；断开连接时草稿与密钥一起清空。

26 条 check 的映射见本文档 §5「测试映射」。

### 1.9 `test/model-config.test.cjs`（12 条）

全部要移植：DTO 脱敏与去重、自部署 keyless 预设、patch 白名单与原型/getter 闸门、
同源路由 + `X-Relay-Secret` + `redirect/credentials/cache` 四项、PATCH 后必须重读确认且绝不自动重试、
`NEEDS_KEY`/`ROLLED_BACK`/`AUTH_REQUIRED`/`RESULT_UNKNOWN` 四码互不串味且不泄露 `private`、
传输异常/超大响应不泄露凭据、陈旧表单不发请求、切 Being 后的答复一律丢弃、
并发 `BUSY` 与旧读丢弃、`updateRuntimeConfig` 只动 config 半边、
地址未变则不发 `base_url`（保住私有查询参数）、卡住的保存不会锁住新 Being。

### 1.10 本壳层的模板与约束（读过的真实代码）

- `subsystems/chat.ts`：`revision` 只在**身份变化**时 ++（重新验证同一个 Being 不打断在途请求），
  `connectionVerified` 里先写 `address` 再启动。本单元的 `connectionId` 照此办理（BD 的 `generation` 每次
  `verifyConnection` 都 ++，是**偏差**，写进 §4）。
- `subsystems/shell-state.ts` + `shell/ipc.ts`：IPC 注册与推送的形状模板（`registerXIpc({handle, exclusive, …})`
  + `xPush(ctx.push)`）；输入白名单逐字段校验、未知字段直接拒绝。
- `shared/chat-errors.ts`：`CHAT_ERROR_CODES` 目前 9 条，**没有** `NEEDS_KEY` / `ROLLED_BACK`，
  未知码会被降级成 `TOWN_ERROR` + 通用文案（会吃掉「此服务需要 API Key…」这类必须原样到达用户的文案）。见 §4.3。
- `desktop/main/common/loom-connection.ts` 的 `endpoint()` 白名单**已含** `/api/llm/config`（核实）；
  `publicModelUrl` 也在同一文件，本单元直接用，不再复制。
- `tests/chat-ipc.test.ts` 的 `CHANNELS` 闭集**只装 chat 子系统**（I3/I2/I4/I6 合并时已改成这样），
  本单元**不需要**往那里追加通道——I6 记录里那条「必须追加」已经过时。
- `tests/renderer-slots.test.ts` 同理：已从点名清单改成「格式良好 + 键唯一」的性质断言，本单元**不需要**改它。
- `tests/architecture.test.ts` 八条：renderer 不得出现 `fetch`/`WebSocket` 等标识符；
  `models/`/`services/` 不得 import components/hooks/react；`main/subsystems/` 不得 import electron。
- `DesktopAPI` 的追加位在注释块内，已有 `chat/terminal/toolBrowser/tools/orchestration/shellState/townDesktop` 七项。
- `renderer/settings/`：`ShellPagesSection`（`SIDEBAR_SLOTS` 的 foot 槽）里已经有「关于 · 隐私」两个按钮 + 一个
  `Dialog#shell-page-dialog`，`ShellStateModel.page: ShellPage` 控制打开哪一页。
  本单元加第三个入口「模型」，把 `ShellPage` 扩成 `"" | "about" | "privacy" | "models"`。

### 1.11 装配与错误面（读完 BD main.cjs 与本壳层 ipc/error-log 后的定论）

- `src/main.cjs:358`：`new ModelConfig({getContext:()=>({connection,connectionId:generation,exiting:exitStarted}),fetchImpl:(url,options)=>net.fetch(url,options)})`。
- `src/main.cjs:363-369` `publishModelConfig(snapshot)`：**先校验** `!connection || snapshot.connectionId!==generation` → 抛「Being 连接已变化，请重新读取模型配置。」；
  然后 `modelConfigRevision++`、`state.runtime=updateRuntimeConfig(state.runtime,snapshot)`、`broadcast()`、返回 snapshot。
  两条 handle 都经它（`getModelConfig` 直接；`saveModelConfig` 先 `modelConfigRevision++` 再经它，成功后写 activity）。
- **`getModelConfig` / `saveModelConfig` 不在 `townMethods` 里**（`src/main.cjs:125`）→ BD **没有**给它们包络，失败是
  `throw new Error(sanitizeText(error.message))`，`renderer/model-settings.js` 的 `cleanError` 剥前缀后直接显示。
  `docs/interfaces.md:73-74` 也只给 `saveModelConfig` 标了「串行」，没标「包络」。
- 本壳层 `app/ipc.ts:59`：handler 抛出的东西一律被换成 `new Error(errorLog.report(channel, error))`；
  `error-log.ts:37` 返回 `publicErrorMessage(error, fallback)`，`shared/errors.ts` 保留 ≤110 字、无换行/路径的中文短句。
  → **文案能活下来，`code` 活不下来。**
- 结论（§4.3 展开）：任务书把 `beings:model-config-save` 标为「包络」是**有意偏离 BD**，因为本壳层丢 `code`；
  本单元照办，并把 `beings:sbs-set` 一并包络（理由见 §4.3）。
  `shared/chat-errors.ts` 的 `CHAT_ERROR_CODES` 缺 `NEEDS_KEY` / `ROLLED_BACK`，要追加一行（第七处共享文件触碰，§6 记录）。
  核实过没有任何 exhaustive switch 依赖这个联合类型（消费者只有 `chat/ipc.ts`、`preload/channels/bridge.ts`、`tests/chat-ipc.test.ts`）。
- `preload/channels/bridge.ts` 的 `enveloped<T>()` 就是包络通道的渲染端入口，注释明说「不只对话通道用」。
- `renderer/settings/` 现状：`entry.tsx` 的 `ShellPagesSection` = 两个按钮 + 一个 `Dialog#shell-page-dialog`，
  `ShellStateModel.page: ShellPage = "" | "about" | "privacy"`，`open(page)` 切换。本单元加第三个入口。
  `NO_SHELL_STATE` 的惰性兜底模式要照抄给模型设置模型。

---

## 2. 产出清单

### 2.1 独占新文件

| 文件 | 内容 |
| --- | --- |
| `desktop/main/model-settings/config.ts` | `PROVIDERS`（9 项，逐字节镜像 Loom 1.8.0）、`MESSAGES`（9 条）、`modelConfigDto`、`validateModelPatch`、`responseJson`（1 MiB 闸门）、`ModelConfig` 类（`busy` / `get()` / `save()` / **新增 `setSideBySide()`**） |
| `desktop/main/model-settings/runtime.ts` | `emptyRuntime`、`readRuntime`、`updateRuntimeConfig`、**新增 `failRuntimeConfig`** 与 `modelRuntimeState`（推送用的投影） |
| `desktop/main/model-settings/ipc.ts` | `registerModelSettingsIpc`（3 条通道）、`modelSettingsPush`（1 条推送） |
| `desktop/main/subsystems/model-settings.ts` | 装配：`ModelConfig` + 纪元 + `publishModelConfig` 等价物（`accept`）+ 连接生命周期 |
| `desktop/preload/channels/model-settings.ts` | `modelSettings` 桥接片（读走 `ipcRenderer.invoke`，两条写走 `enveloped`） |
| `desktop/shared/model-settings-types.ts` | `ModelProviderOption` / `ModelPresetOption` / `ModelConfigValues` / `ModelConfigDto` / `ModelPatchInput` / `ModelSideBySideState` / `ModelRuntimeState` / `ModelSettingsState` / `ModelSettingsAPI` |
| `desktop/renderer/settings/models/model-settings.ts` | `ModelSettingsModel`（BD `renderer/model-settings.js` 的状态机）、`NO_MODEL_SETTINGS`、`CUSTOM_MODEL` |
| `desktop/renderer/settings/components/model-settings.tsx` | 模型页（DOM id 与 BD `renderer/index.html:300-316` 一一对应） |
| `tests/model-settings-config.test.ts` | 17 条（BD 13 条逐条 + SBS 3 条 + 运行时失败半边 1 条） |
| `tests/model-settings-ipc.test.ts` | 9 条（真 `SettingsStore` + 真 `createTrustedHandle` + 假 Being） |
| `tests/model-settings-renderer.test.ts` | 21 条（BD `test/model-settings-ui.cjs` 26 条 check 的映射，见 §5） |

### 2.2 重写的既有文件

- `tests/sbs-refresh.mjs`：原脚本驱动已删除的 `beings://chat` iframe，一直报 `SKIPPED:`。
  重写为「production preload + production renderer + production 子系统 + 本地假 Being HTTP 夹具」的
  Electron 夹具（方法同 `tests/sidebar-e2e.mjs`），**26 条 check，实跑通过**。
  `scripts/test-all.mjs` 的 skipped 名单因此少一项（只减不增 ✓）。

### 2.3 共享文件触碰行（逐行）

| 文件 | 追加的行 |
| --- | --- |
| `desktop/main/extensions.ts` | `import { installModelSettingsSubsystem } from './subsystems/model-settings';` |
| `desktop/main/extensions.ts` | `  installModelSettingsSubsystem,`（`INSTALLERS` 末尾） |
| `desktop/preload/channels/index.ts` | `import { modelSettings } from './model-settings';` |
| `desktop/preload/channels/index.ts` | `  modelSettings,`（`desktopChannels` 末尾） |
| `desktop/shared/desktop-types.ts` | `export * from './model-settings-types';` |
| `desktop/shared/types.ts` | `import type { ModelSettingsAPI } from './model-settings-types';` |
| `desktop/shared/types.ts` | `  /** 模型配置 and Side by Side (model-settings-types.ts). */` + `  modelSettings: ModelSettingsAPI;`（`DesktopAPI`，`townDesktop` 之后） |
| `desktop/renderer/app/models/registry.ts` | `import { ModelSettingsModel } from '../../settings/models/model-settings';` |
| `desktop/renderer/app/models/registry.ts` | `  { key: 'modelSettings', create: (api, app) => new ModelSettingsModel(api, app) },`（`FEATURE_MODELS` 末尾） |
| `MIGRATION.md` | 「集成阶段 I1 起」表格末尾一行 |
| **`desktop/shared/chat-errors.ts`** | `  'NEEDS_KEY', 'ROLLED_BACK',`（`CHAT_ERROR_CODES` 末尾，**第七处共享文件，方案六处之外**，理由见 §4.3） |

`desktop/renderer/app/slots.tsx` **没有碰**：模型页挂在 I6 已注册的 `ShellPagesSection` 里，少一处共享冲突。

### 2.4 例外目录 `desktop/renderer/settings/**`（任务书授权，本轮只有 I6b 动它）

- `components/entry.tsx`：加第三个入口按钮 `#open-models`，对话框标题与内容加一条 `page === "models"` 分支。
- `models/shell-state.ts`：`ShellPage` 从 `"" | "about" | "privacy"` 扩成 `… | "models"`。
- `styles.css`：追加 `.model-*` / `.sbs-header-switch` 一组规则（用壳层变量，两套主题自动成立）。

---

## 3. IPC 清单

| 通道 | BD 对应 | 队列 | 包络 | payload |
| --- | --- | --- | --- | --- |
| `beings:model-config-get` | `being:getModelConfig` | 否 | 否（同 BD） | `() → ModelConfigDto` |
| `beings:model-config-save` | `being:saveModelConfig`（BD 标「串行」） | `ctx.exclusive` | **是**（偏离 BD，§4.3） | `(ModelPatchInput) → ModelConfigDto` |
| `beings:sbs-set` | **无**（BD 只显示） | `ctx.exclusive` | **是**（§4.3） | `(enabled: boolean, connectionId: number) → ModelConfigDto` |
| `beings:model-settings-state` | BD 的 `being:state` 里的 `state.runtime` 半边 | 推送 | — | `ModelSettingsState = {connected, connectionId, runtime}` |

三条 invoke 全部经 `ctx.handle` 注册（继承来源校验与 quitting 守卫），推送经 `ctx.push`（窗口守卫在里面）。

**输入校验**：`beings:model-config-save` 的唯一闸门是 `validateModelPatch`（白名单 5 键、原型必须是 `Object.prototype`、
每个自有属性必须是数据属性——带 getter 的输入**不读取**就拒绝、`connectionId` 必须是 ≥0 安全整数、
`model` ≤512 / `provider` ≤100 且匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` / `baseUrl` ≤2048 且 http(s) 无凭据无查询无片段 / `apiKey` ≤16384）。
IPC 层**不再复写一遍弱化版**——两份校验迟早会分叉。`beings:sbs-set` 的两个参数在 `setSideBySide` 里校验，同一条原则。

---

## 4. 决定与偏差

### 4.1 纪元跟身份走，不跟验证次数走（偏离 BD，有意）

BD 传 `connectionId: generation`，而 `generation` 每次 `verifyConnection` 都 `++`
（`src/main.cjs:358`）——重新验证**同一个** Being 会作废用户正在填的表单、打断在途保存。
本单元照 `subsystems/chat.ts`：纪元只在**身份**（`sessionPartition(parseConnection(address))`）变化时 `++`，
并且**保留同一个 `LoomConnection` 对象**——`ModelConfig` 按引用比较 connection，重新 parse 出的等值对象会被当成新 Being，
让所有在途请求以 `SESSION_CHANGED` 失败。由 `tests/model-settings-ipc.test.ts`「the epoch follows the Being's identity」钉住。

### 4.2 不给 `Snapshot` 加字段，自开推送

BD 把 runtime 放在 `publicState()` 里整体广播。本壳层的 `beings:snapshot` 在 `main.ts` 里组装，集成单元不得改 `main.ts`
（方案 §4），所以本子系统自开 `beings:model-settings-state`——与 I6 处理侧栏账本的做法一致（`i6-shell-state.md` §4.1）。
`ModelSettingsState` 里多了一个 BD 没有的 `connected` 布尔：渲染端否则得从 `beings:snapshot` 推断「有没有连上」，
而两条通道的到达顺序没有保证。

### 4.3 两条写通道包络，并往 `CHAT_ERROR_CODES` 追加两个码（第七处共享文件）

**实测**：BD 的 `getModelConfig` / `saveModelConfig` **不在** `townMethods` 里（`src/main.cjs:125`），
`docs/interfaces.md:73-74` 也只标了「串行」没标「包络」——BD 是抛错，`renderer/model-settings.js` 的 `cleanError` 剥前缀后显示。
BD 那样可行是因为它自己的 handle 包装 `throw new Error(sanitizeText(error.message))`。

**本壳层不一样**：`app/ipc.ts:59` 把 handler 抛出的东西换成 `new Error(errorLog.report(channel, error))`，
`shared/errors.ts` 的 `publicErrorMessage` 会保留 ≤110 字的中文短句——**文案活得下来，`code` 活不下来**。
而 `NEEDS_KEY`（去填密钥）/ `ROLLED_BACK`（Being 撤销了）/ `RESULT_UNKNOWN`（没人知道，去重读）是三条不同的用户指令。
所以两条写通道按任务书标的「包络」走 `chatErrorEnvelope`，读通道保持抛错（同 BD，它的调用方不分支）。

`CHAT_ERROR_CODES` 原来 9 条，缺 `NEEDS_KEY` / `ROLLED_BACK`，未知码会被降级成 `TOWN_ERROR` + 通用文案，
把「此服务需要 API Key…」这句必须原样到达用户的话吃掉。因此追加一行。
核实过没有任何 exhaustive switch 依赖这个联合类型（消费者只有 `chat/ipc.ts`、`preload/channels/bridge.ts`、`tests/chat-ipc.test.ts`），
加码只会放宽、不会改变既有行为；`npx vitest run` 全绿佐证。
**这是方案六处共享文件之外的第七处**，如实记在 §2.3 与 openIssues。

任务书把 `beings:sbs-set` 只标了「串行」。本单元**一并包络**，因为它与 save 同属「PATCH 后重读确认」这一类，
而「503 → 状态回到未知」这条 E2E 钉死的规则需要渲染端分辨 `RESULT_UNKNOWN`。

### 4.4 读失败要自己发布（偏离 BD 的实现，保住 BD 的可观察行为）

BD 的 `getModelConfig` 失败时不发布任何东西，靠 `doRefresh` 轮询（`src/main.cjs:972`，同时读三条路由）把
`configStatus` 置 error、`sideBySide.configured` 重置为 null。**本壳层没有这条定时器**——本子系统是 `/api/llm/config` 的唯一读者。
所以失败在 `readConfig` 里就地记录（`failRuntimeConfig`，即 `readRuntime` 的 else 分支），
保住 E2E 钉的那条可观察规则：503 或字段缺失 → Side by Side 回到「未知」，刷新可恢复。
`SESSION_CHANGED` / `BUSY` / `NOT_CONNECTED` 三个码不算「读失败」——纪元已经换了（状态跟着重置过），
或者有写在途（它自己的结果会发布，而 BD `src/main.cjs:977` 正是明确保护写的快照不被并发读覆盖）。

### 4.5 SBS 写入协议是实测的，不是推断的

BD **没有** SBS 写入路径。wire shape 来自两处独立实测且一致（详见 §1.7）：Loom 1.8.0 页面源码的 `toggleSbs`
（`PATCH /api/llm/config`，`{sbs_enabled: 'on'|'off'}`，**字符串**不是布尔，回读是布尔），
以及本仓库 `tests/sbs-refresh.mjs` 当年对着真 Loom 写的假 Being 夹具。
确认方式与 `save()` 一致（PATCH 后重读），但**只确认 `sbs_enabled` 一项**——不带 model 的 PATCH 无法用 `patch.model` 校验。
Loom 自己的注释也写明「不做乐观翻转，以服务端回声为准」，渲染端照此实现。

### 4.6 `sideBySide.active` 恒为 null，并且照实说

BD 的「运行中」来自 Loom 页面 post 的 `beings:sbs-state` 消息，该页已被原生对话取代，本壳层没有来源。
页面显示「未知」而不是「已关闭」——把不知道说成已关闭是在撒谎。

### 4.7 BiDi 覆写字符改成 `\uXXXX` 转义

`plainText` 的正则在 BD 里写作 `‪-‮⁦-⁩`；移植稿里一度是**字面不可见字符**（hexdump 核实码位一致）。
改回显式转义：字面 U+202E 出现在源码里本身就是 trojan-source 的经典手法，而且审阅者看不见。语义不变。

### 4.8 身份串不从 `main/chat/` 取

`connectionVerified` 需要身份串。`chat/connection.ts` 的 `beingIdentityKey` 可用，但那是 I5 的目录。
改用 `main/common/loom-connection.ts` 的 `sessionPartition(parseConnection(address))`——
`tests/identity-partition.test.ts` 已经钉住两者相等，少一处跨单元耦合。

---

## 5. 测试映射：BD `test/model-settings-ui.cjs` 26 条 check 去哪了

BD 那套在隐藏 Electron 窗口里驱动真实 DOM。本壳层没有 `renderer/index.html`，vitest 也没有 DOM，
所以规则搬进 `settings/models/model-settings.ts`，check 搬进 `tests/model-settings-renderer.test.ts`（21 条，按名对应）。

| BD check | 去处 |
| --- | --- |
| `disconnected-cannot-load-or-save` | renderer #1 |
| `list-retry-loads-through-preload` | renderer #2 |
| `supported-list-and-custom-option`、`self-hosted-group-is-listed-first-with-provider-names`、`existing-key-is-never-filled` | renderer #3 |
| `same-provider-model-keeps-configured-proxy`、`periodic-state-preserves-model-selection` | renderer #4 |
| `supported-model-save-omits-blank-key` | renderer #5 |
| `self-hosted-model-fills-default-endpoint-with-key-optional`、`self-hosted-save-sends-default-endpoint-without-key`、`saved-self-hosted-model-stays-selected` | renderer #6 |
| `provider-without-default-clears-previous-endpoint`、`duplicate-model-and-preset-ids-select-correct-provider` | renderer #7 |
| （BD 没单独命名的 provider 切换带走模型名） | renderer #8 |
| `periodic-state-preserves-entire-custom-draft`、`explicit-list-refresh-preserves-custom-draft` | renderer #9 |
| `pending-save-disables-submit`、`duplicate-submit-does-not-duplicate-save`、`custom-save-sends-config-and-new-key`、`saved-custom-stays-editable-with-key-cleared` | renderer #10 |
| `save-error-keeps-draft-and-allows-retry`、`error-feedback-hides-electron-wrapper` | renderer #11 |
| `initial-read-error-disables-editing-and-allows-retry`、`read-error-offers-retry` | renderer #12 |
| `empty-list-allows-custom-model`、`list-error-keeps-custom-configuration-available` | renderer #13 |
| `previous-identity-load-cannot-replace-new-config` | renderer #14 |
| `previous-identity-save-cannot-replace-new-config` | renderer #15 |
| `disconnect-clears-draft-and-secret` | renderer #16 |
| `model-settings-never-send-being-messages` | 结构性成立：本单元只注册 3 条通道，`tests/model-settings-ipc.test.ts` 断言通道集合；渲染端 model 只调 `api.modelSettings.*` |
| `model-panel-is-selected-and-other-panels-are-hidden` | `tests/sbs-refresh.mjs`（真窗口里点 `#open-models`，等 `#model-settings-page`） |
| `*-no-horizontal-overflow`、`*-fits`、`fixture-window-never-shown` | **未移植**：几何与截图规则，model 层答不了；本壳层没有对应的响应式回归脚本。写进 openIssues |
| `no-network-attempts`、`no-renderer-errors` | `tests/sbs-refresh.mjs`（`pageerror` 收集 + 夹具服务器只应答一条路由，其它 404） |

BD `test/model-config.test.cjs` 13 条 → `tests/model-settings-config.test.ts` 前 13 条，逐条同名同断言。

旧 `tests/sbs-refresh.mjs` 钉的 5 条：前 4 条在新脚本里（未确认时 disabled 且无 `aria-pressed`；被拒绝的 PATCH 不乐观翻转；
503/字段缺失 → 未知且刷新可恢复；只有显式切换才写配置）。第 5 条「更早的 GET 不能撤销随后确认的切换」搬进 vitest：
本客户端的页面不可能让读写重叠（`busy` 挡住），这条规则现在住在 `ModelConfig` 里，由
`tests/model-settings-config.test.ts`「saving rejects concurrent requests and discards older configuration reads」断言。

---

## 6. API Key 的路径（本仓库唯一一条经 IPC 的明文凭据）

渲染端输入框（`type=password`，**永不回填**）→ `beings:model-config-save` 的 `apiKey` →
`validateModelPatch` 转成 `api_key` → `ModelConfig.request` 的 PATCH body → Being。**到此为止。**

- 不落盘：`saveExtra` 从未被本子系统调用；`tests/model-settings-ipc.test.ts` 断言 settings.json 不含密钥。
- 不进推送：`ModelConfigDto` 只有 `hasApiKey`；同一测试断言全部 push 的 JSON 不含密钥。
- 不进日志与文案：`onError` 只收到 scope 与 error，本路径的错误文案全是 `MESSAGES` 里的作者常量或
  `${name}格式无效。`（密钥值靠"不写进去"而不是"写进去再删"）；同一测试断言 errors 与包络 message 都不含密钥。
- 内存里不多停一拍：渲染端 `save()` 的 `finally` 里 `delete payload.apiKey`（BD 同款），换 Being 时连草稿一起清空。
