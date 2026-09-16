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
