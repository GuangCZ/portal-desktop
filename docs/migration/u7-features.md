# u7-features — 功能任务账本迁移记录

单元范围：把 BeingDesktop 0.8.26 的 `src/feature-tasks.cjs`、`src/feature-task-runner.cjs`、
`src/feature-task-history.cjs`、`src/feature-task-discussion.cjs` 及其测试逐行移植为
portal-desktop 的 TypeScript（`desktop/main/features/*.ts` + `tests/features-*.test.ts`）。
只移植，不集成（IPC / renderer / main.ts 挂钩留给后续阶段）。

来源工作树（只读）：`/Users/d5c/Documents/ChatGPT/BeingDesktop`，移植日期 2026-09-16。

---

## 阅读摘要

### docs/architecture.md（§4 子系统表「功能任务账本」一行 + §6 持久化 + §8 并发约定）

- §4 表格行：子系统 `features`；入口对象 `FeatureTaskRunner`、`FeatureTaskHistory`（内含 `FeatureTasks`）；
  职责「把长任务记为可持久化的功能任务，按 Being 身份隔离」；关键不变量「身份切换时拒绝过期写入（`SESSION_CHANGED`）」。
- §4 前言：子系统之间不直接 require 对方实例；`main.cjs` 的 `boot()` 是唯一组合根，用回调注入上下文
  （`getContext`、`getConnection`、`fetchImpl`、`persist`、`onChange`），子系统只持有自己的状态并通过 `onChange` 触发 `broadcast()`。
- §6.1：高频/大体积数据不走 `being:state`，走专用通道，其中包含 `being:feature-tasks`。
- §6.2 磁盘布局：`feature-tasks/<sha256(identity)>.bin` = 功能任务账本，保护方式 safeStorage。
- §8.1 纪元校验：`generation`（连接）、`identityRevision`（身份分区）等在异步开始时捕获、完成时比对；
  过期结果静默丢弃，过期写入抛 `SESSION_CHANGED`。
- §8.2 串行化：`serialized` 集合内的 IPC 方法进入 `mutationTail` 逐个执行；
  **`FeatureTaskRunner` 为 `OPERATIONS` 表内的方法建账并用 `AsyncLocalStorage` 传递归属**。
- §8.5 先落盘再通知：终态/验收/展示状态先 `flush()` 再 callback 或推送。
- §8.6 定时器全部 `unref()`。

### docs/interfaces.md（§3.9 功能任务账本 + §5 错误码 + §7 持久化 + §1.3 推送）

- §3.9 接口表（构造参数逐字）：
  - `FeatureTasks({onChange, now, createId, maxRecords, identityKey, initialSnapshot})`
    → `begin({feature, operation, title, execution})`、`update(id, {status, detail, requestId})`、
      `complete(id, {summary})`、`fail(id, error)`、`cancel(id, {detail})`、`get`、
      `list({feature})`、`snapshot()`、`reset({identityKey})`
  - `FeatureTaskHistory({identityKey, directory, safeStorage, onChange})`
    → `restore()`、`register(record)`、`save()`、`flush()`；属性 `ledger`、`records`、`persistenceError`
  - `FeatureTaskRunner({getLedger})`
    → `run(name, args, fn)`：`OPERATIONS` 表内的方法自动 `begin`/`complete`/`fail`，
      等待类错误码（`REQUEST_ACCEPTED`、`RESULT_UNKNOWN`、`WAITING_SBS`、`SBS_NOT_CONFIGURED`）转为 `waiting`；
      `currentTask()`、`recordRequest(record)`
  - `feature-task-discussion.cjs` → `discussFeatureTask(id, {getLedger, getContext, prepareDraft})`
- §1.3 推送通道：`being:feature-tasks` / `onFeatureTasks`，载荷 `{tasks, persistenceError}`，
  触发时机「账本变化、身份切换（先推空列表）」。
- §5 错误码（本单元相关）：
  - `TASK_LIMIT_REACHED` —「功能任务记录已满（100 条且无可淘汰的终态记录）」，来源 `FeatureTasks.begin`。
  - `SESSION_CHANGED` —「连接、身份、编排绑定或围炉选择在操作期间变化，结果已丢弃」，来源纪元校验。
  - 等待类：`REQUEST_ACCEPTED`、`RESULT_UNKNOWN`、`WAITING_SBS`、`SBS_NOT_CONFIGURED`（Being 中继路径的等待与失败分类）。
  - 其它可能出现在 fail 分支：`INVALID_REQUEST`、`NOT_CONNECTED`、`NOT_SENT`、`ABORTED`。
- §7 持久化：`feature-tasks/<sha256(identity)>.bin` = safeStorage 密文，明文
  `{version:1, identityKey, records:[TaskDto]}`；上限 ≤128MB。
- §8 变更规范提到：功能任务的 IPC 方法需在 `feature-task-runner.OPERATIONS` 登记，
  并归入 `main.cjs` 的 `featureMethods` 集合。

### src/feature-tasks.cjs（202 行，已逐行读完）

导出：`module.exports = {FeatureTasks}`（仅此一个类）。依赖 `node:crypto` 的 `randomUUID`（默认 `createId`）。

模块级常量（逐字照抄，不得改）：
- `STATUSES = new Set(['running','waiting','succeeded','failed','cancelled','needs_input'])`
- `TERMINAL = new Set(['succeeded','failed','cancelled'])`
- `RESTART_DETAIL = '应用已重新启动，执行状态待核对；不会自动重发。'`
- `ERROR_DETAILS`（`Object.freeze`，17 个键，顺序如下，值逐字）：
  `AUTH_REQUIRED` 此功能需要授权，请在对应功能页面完成连接。／`IDENTITY_MISMATCH` 连接身份不一致，请检查 Being 连接后重试。／
  `NOT_CONNECTED` 请先连接 Being。／`NETWORK_ERROR` 连接暂时中断，请稍后重试。／`SERVICE_ERROR` 服务暂时不可用，请稍后重试。／
  `RATE_LIMITED` 请求过于频繁，请稍后重试。／`BUSY` Being 当时正在处理其他请求，本次操作未发送。请打开功能页重试。／
  `READINESS_UNKNOWN` 未能确认 Being 是否空闲，本次操作未发送。请打开功能页重试。／
  `RESULT_UNCONFIRMED` 读取已发送，但尚未取得可核对结果；不会自动重复发送。／
  `REQUEST_ACCEPTED` 请求已送达，执行结果尚待确认；不会自动重发。／`SESSION_CHANGED` 连接已变化，当前界面不再跟踪此请求。／
  `ABORTED` 本地等待已停止，远端执行状态需另行确认。／`INCOMPLETE_RESULT` 返回结果不完整，请在功能页面检查后重试。／
  `INVALID_RESPONSE` 返回结果无法读取，请在功能页面检查后重试。／
  `TOWN_TOOL_NOT_CALLED` Being 未执行 Town 读取工具，请在模型设置检查原生 http 工具是否被限制。／
  `RESULT_SOURCE_UNAVAILABLE` 本机结果通道暂不可用，请稍后重试。／
  `RESULT_SOURCE_NOT_CONFIGURED` 未配置完整工具结果通道，无法从 Loom 摘要恢复消息。／
  `REQUEST_FAILED` 功能执行失败，请在对应功能页面检查后重试。

内部帮助函数：
- `plain(v)`：非 null、typeof object、`Object.getPrototypeOf(v) === Object.prototype`（拒绝 class 实例与 null 原型对象）。
- `fields(value, allowed, name)`：非 plain → `TypeError('Invalid ' + name)`；用 `Object.getOwnPropertyDescriptors` + `Reflect.ownKeys`
  检查每个 key 必须是 string、必须在 allowed 内、必须是数据属性（`Object.hasOwn(desc,'value')`），否则 `TypeError('Invalid ' + name + ' fields')`。
  即 symbol 键、getter、未知键一律拒绝。返回原对象。
- `identifier(value, name, max = 80)`：必须 string、`length <= max`、匹配 `/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/`，否则 `TypeError('Invalid ' + name)`。
- `identity(value)`：`''` 直接放行，否则 `identifier(value, 'identity key', 128)`。
- `safeText(value, limit)`：`undefined`/`null` → `''`；非 string → `TypeError('Task text must be a string')`；
  先 `slice(0, limit*8)`，再依次替换：控制字符与双向控制符 `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]` → 删除；
  `https?://[^\s<>\[\]()"']+` → `[链接]`；`\bBearer\s+[^\s,;"']+` → `Bearer [已隐藏]`；`\bsk-[A-Za-z0-9_-]{8,}` → `[已隐藏]`；
  `\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|key|password|secret|credential|cookie)\b(["']?\s*[:=]\s*["']?)[^\s,;&"']+` → `$1$2[已隐藏]`；
  最后 `slice(0, limit)`。（顺序不能换：链接先于 token 脱敏。）
- `stamp(v)`：`Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000`。
- `copy(v)`：`structuredClone`。

构造参数（默认值逐字）：`{onChange = () => {}, now = Date.now, createId = randomUUID, maxRecords = 100, identityKey = '', initialSnapshot, initialRecords, initialIdentityKey}`
（注意 interfaces.md 只列了前 6 个，源码另有 **旧格式兼容入口 `initialRecords` / `initialIdentityKey`**）。
- 三个回调非 function → `TypeError('Invalid feature task callbacks')`。
- `maxRecords` 非整数或 <1 或 >200 → `RangeError('Invalid feature task limit')`。
- `this.identityKey = identity(identityKey)`；`this._records = new Map()`。
- `source = initialSnapshot || (initialRecords === undefined ? null : {version:1, identityKey: initialIdentityKey, records: initialRecords})`；
  仅当 `plain(source) && source.version === 1 && source.identityKey === this.identityKey && Array.isArray(source.records)` 才 `_restore`。
  **身份不匹配的快照静默忽略**（不抛错、不载入）。

TaskDto 字段顺序（begin 构造）：`{id, feature, operation, title, execution, mayDelayChat, status, detail, summary, requestId, errorCode, createdAt, updatedAt, finishedAt}`，
`mayDelayChat = execution === 'being'`，初始 `status:'running'`，`detail/summary/requestId/errorCode` 均为 `''`，`finishedAt: null`。

方法逐条：
- `begin({feature, operation, title, execution = 'local'})`：`fields(...,['feature','operation','title','execution'],'feature task')`；
  `identifier(feature,'feature')`、`identifier(operation,'operation')`；`execution` 必须是 `'being'|'local'` 否则 `TypeError('Invalid task execution')`；
  `safeTitle = safeText(title,160).trim()`，空 → `TypeError('Task title is required')`。
  **淘汰逻辑**：`_records.size >= maxRecords` 时取所有终态记录按 `updatedAt` 升序（并列再按 `createdAt`）第一条为 `oldest`；
  没有终态记录 → `Error('Too many active feature tasks')` 且 `error.code = 'TASK_LIMIT_REACHED'`。
  **ID 分配**：最多 5 次 `identifier(this.createId(),'task ID',128)`，取第一个未占用的；5 次都撞 → `Error('Could not allocate a unique feature task ID')`。
  时间取 `_now()`；先 `_records.delete(oldest.id)` 再 `set(id, task)`；`_changed()`；返回 `copy(task)`。
- `update(id, patch)`：`fields(patch,['status','detail','requestId'],'task update')`；`status !== undefined` 且不在 STATUSES → `TypeError('Invalid task status')`；
  只把 `!== undefined` 的字段放进 changes；`detail` 走 `safeText(...,600)`；`requestId` 为 `''` 时保留 `''`，否则 `identifier(...,'request ID',128)`。返回 `_patch`。
- `complete(id, options = {})`：`fields(options,['summary'],'task completion')`；`_patch(id,{status:'succeeded', summary: safeText(summary,1200), detail:'', errorCode:''})`。
- `fail(id, error)`：只从 `error` 的**自有数据属性** `code` 取值（`Object.getOwnPropertyDescriptor` + `hasOwn(desc,'value')`，原型链上的 code 不算）；
  该值必须是 string 且是 `ERROR_DETAILS` 的自有键，否则回落 `'REQUEST_FAILED'`；`_patch(id,{status:'failed', errorCode, detail: ERROR_DETAILS[errorCode]})`。
- `cancel(id, options = {})`：`fields(options,['detail'],'local task cancellation')`；
  `detail === undefined` 时用默认文案 `'已停止本地跟踪，远端执行状态需另行确认。'`，再 `safeText(...,600)`；status `'cancelled'`。
- `get(id)`：命中返回 `copy`，否则 `null`（不校验 id 格式）。
- `list({feature} = {})`：`fields(options,['feature'],'task filter')`；`feature !== undefined` 时 `identifier(feature,'feature')`；
  `[...values()].reverse()` → **插入序的倒序（最新在前）**，再按 feature 过滤，逐个 `copy`。
- `snapshot()`：`{version:1, identityKey: this.identityKey, records: this.list()}`。
- `reset({identityKey = this.identityKey} = {})`：重设 identityKey（走 `identity()` 校验）、清空 Map、`_changed()`、返回 `snapshot()`。
- `_now()`：`this.now()` 结果必须通过 `stamp()`，否则 `TypeError('Invalid feature task clock')`。
- `_patch(id, values)`：找不到 → `null`；**已终态 → 原样返回 `copy(task)`（拒绝复活/覆盖）**；
  所有字段都相等 → 返回 `copy(task)` 且**不触发 onChange**；
  `updatedAt = Math.max(task.updatedAt, this._now())`（时钟回拨不倒退）；`Object.assign` 后设 `updatedAt`，
  `finishedAt = TERMINAL.has(task.status) ? task.updatedAt : null`；`_changed()`；返回 `copy(task)`。
- `_changed()`：`try { this.onChange(this.snapshot()); } catch {}` —— **观察者抛错必须吞掉**。
- `_restore(records)`：只取前 200 条；每条用 try/catch 包住（异常 → 跳过该条）：
  `fields(candidate, [14 个 TaskDto 字段], 'stored task')`；`identifier` 校验 id/feature/operation；
  `execution` 必须合法、`status` 必须在 STATUSES、`createdAt`/`updatedAt` 必须是 stamp 且 `updatedAt >= createdAt`，否则 `continue`；
  终态记录要求 `stamp(finishedAt) && finishedAt >= createdAt && finishedAt <= updatedAt`，非终态要求 `finishedAt === null`，否则 `continue`；
  title 经 safeText+trim 为空 → `continue`；
  重建的 task：非终态 status 一律改写为 `'waiting'`，detail 改写为 `RESTART_DETAIL`（终态保留原 detail 经 safeText）；
  `summary` safeText 1200；`requestId` 真值才校验否则 `''`；`errorCode` 必须是 ERROR_DETAILS 自有键否则 `''`。
  **旧版 Town 行修复分支**：非终态 且 `feature ∈ ['bonfire','fireside','scroll']` 且 `execution === 'being'` 时，
  若 `!task.requestId && candidate.detail === 'Being 正在处理其他请求，本次操作尚未完成；不会自动重发。'`（`blockedBeforeSend`）
  → `{status:'failed', errorCode:'READINESS_UNKNOWN', detail:'旧版未发送这次读取，却留下了等待状态。请打开功能页重新读取。', finishedAt: updatedAt}`；
  否则 → `{status:'needs_input', detail:'应用已重新启动，旧读取结果尚未确认，本地已无等待队列。请在功能页检查；不会自动重发。'}`（finishedAt 保持 null）。
  最后：`restored.sort((a,b) => b.createdAt - a.createdAt).slice(0, maxRecords).reverse()`，逐个 `if (!this._records.has(task.id)) set(...)`
  → 插入序为 createdAt 升序，于是 `list()` 输出 createdAt 降序（最新在前）；**超出 maxRecords 的旧记录被丢弃**。
  注意 `_restore` 不调用 `_changed()`（构造期不推送）。

## 进度

| 模块 | 状态 |
| --- | --- |
| docs 摘要（architecture §4/§6/§8） | 已读 |
| docs/interfaces.md §3/§5/§7 | 已读 |
| src/feature-tasks.cjs | 已读 |
| src/feature-task-runner.cjs | 未开始 |
| src/feature-task-history.cjs | 未开始 |
| src/feature-task-discussion.cjs | 未开始 |
| test/feature-tasks.test.cjs | 未开始 |
| test/feature-task-runner.test.cjs | 未开始 |
| test/feature-task-history.test.cjs | 未开始 |
| test/feature-task-discussion.test.cjs | 未开始 |
| test/town-error-ipc.test.cjs（feature-tasks 相关用例） | 未开始 |
| src/main.cjs boot() 注入面 | 未开始 |

注：worktree 里已存在上一轮被中断的未提交草稿 `desktop/main/features/{types,feature-tasks,feature-task-runner,feature-task-history}.ts`
（无任何迁移记录），本轮按源码逐行复核后再定稿。
