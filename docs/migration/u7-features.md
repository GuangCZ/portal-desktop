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

### test/feature-tasks.test.cjs（192 行，已逐行读完）—— 14 个用例

`setup(options)` 夹具（原样照抄）：`timestamp = 1000`、`sequence = 0`、`changes = []`；
`new FeatureTasks({now: () => timestamp, createId: () => \`task-${++sequence}\`, onChange: v => changes.push(v), ...options})`；
返回 `{tasks, changes, tick(value = 1){ timestamp += value; }, begin(input = {}){ return tasks.begin({feature:'bonfire', operation:'read', title:'读取篝火消息', execution:'being', ...input}); }}`。

用例名与断言要点（顺序即原文件顺序）：
1. `functional work owns its progress and result without invoking a transport` —
   begin → mayDelayChat true、status running；tick(50) update 到 waiting+detail+requestId 'request-1'；tick(50) complete summary '已读取 10 条篝火消息'；
   断言 status succeeded、finishedAt 1100、createdAt 1000、requestId 保留、summary 保留、detail ''、`changes.length === 3`、`changes[2].records` 深等于 `[done]`。
2. `local work never claims it can delay Being chat` — `begin({feature:'portal', operation:'install', execution:'local'})` → mayDelayChat false、execution 'local'。
3. `terminal records cannot be resurrected by late success, errors or progress` — 对 `['succeeded','failed','cancelled']` 各跑一轮：
   update 到终态得 `before`；tick(100) 后 update/complete/fail 全部深等于 `before`；`changes.length === 2`。
4. `active task identifiers and execution fields cannot be changed through patches` —
   `[{id:'other'},{execution:'local'},{mayDelayChat:false},{prompt:'hidden'},{status:'done'},{requestId:'https://example.test/?token=secret'}]` 逐个 `throws TypeError`；
   任务仍是 running；`changes.length === 1`。
5. `task errors never expose upstream messages, headers, or response bodies` —
   `Object.assign(new Error('Authorization: Bearer secret; https://host/path?token=secret'), {code:'NETWORK_ERROR', response:{password:'secret'}})`
   → errorCode NETWORK_ERROR、detail '连接暂时中断，请稍后重试。'、`JSON.stringify(failed)` 不含 `/secret|Authorization|password|response/`；
   `fail(other.id, {code:'SECRET_TOKEN_VALUE', message:'private prompt'})` → errorCode REQUEST_FAILED。
6. `public text strips credential URLs, bearer values and token assignments` —
   title `'读取 https://user:pw@example.test/being/?token=url-secret'`；
   detail `'Bearer bearer-secret; token=query-secret api_key=key-secret sk-abcdefghijklm'`；
   summary `'password=pass-secret refresh_token=refresh-secret cookie=session-secret key=bare-secret'`；
   `JSON.stringify(snapshot())` 不含 `/url-secret|bearer-secret|query-secret|key-secret|abcdefghijklm|pass-secret|refresh-secret|session-secret|bare-secret|user:pw/`，且含 `/已隐藏/`。
7. `text and record counts are bounded without dropping active work` — `setup({maxRecords: 2})`；
   `begin({title:'标题'.repeat(1000)})` → title.length 160；第二条后再 begin → 抛 `code:'TASK_LIMIT_REACHED'`；
   complete first summary `'结果'.repeat(1000)` → summary.length 1200；tick 后第三条 begin 成功，first 被淘汰（`get(first.id) === null`），
   `list().map(id)` 深等于 `[third.id, second.id]`。
8. `callers and observers cannot mutate retained records` — 对 begin 返回值 / get / list[0] / snapshot().records[0] / changes[0].records[0]
   写 `title='changed'` 后 `get(task.id).title` 仍是 '读取篝火消息'；`setup({onChange: () => { throw new Error('observer failed'); }})` 的 begin 仍返回 running。
9. `restarting preserves terminal results and marks unfinished work for reconciliation without replay` — identityKey 'alice'；
   一条 complete('原始摘要')，tick，一条 update 到 `needs_input` + requestId 'request-2'；
   用 `initialSnapshot: snapshot()` 重建 → done.summary 保留；pending.status 仍 `needs_input`（走旧版 Town 修复分支的 else 支）、
   detail 匹配 `/旧读取结果尚未确认，本地已无等待队列/`、mayDelayChat true、finishedAt null、requestId 'request-2'；
   **重建期间 `changed === 0`**（_restore 不触发 onChange）。
10. `restoration and reset never cross a connection identity boundary` —
    `identityKey:'bob' + alice 的 snapshot` → `list()` 为空；`initialRecords: snapshot.records`（无 initialIdentityKey）→ 空；
    `initialRecords + initialIdentityKey:'alice'` → 1 条（**旧格式兼容入口的正用例**）；
    `reset({identityKey:'bob'})` 后 `get(task.id)` null、`complete(task.id,...)` 返回 null、`snapshot().identityKey === 'bob'`、`list()` 空。
11. `legacy rejected reads stop pretending to queue while accepted reads require reconciliation` —
    blocked 行 update 到 waiting + detail `'Being 正在处理其他请求，本次操作尚未完成；不会自动重发。'`（无 requestId）；
    accepted 行 update 到 waiting + requestId 'accepted-request' + detail `'请求结果尚待确认；不会自动重发。'`；
    重建后 blocked.status `'failed'`、detail 匹配 `/未发送/`；accepted.status `'needs_input'`、requestId 保留。
12. `invalid or hostile persisted fields cannot restore a task` — 五个坏候选：
    `{...task, prompt:'private'}`、`{...task, execution:'remote'}`、`{...task, createdAt:-1}`、`{...task, requestId:'Bearer token'}`、
    `{...task, status:'succeeded', finishedAt:null}`；全部被拒，`list()` 为空。
13. `feature filtering is exact, callback timestamps are monotonic, and duplicate updates are quiet` —
    first(bonfire) / tick / second(fireside)；按 feature 过滤各命中一条；`tick(-500)` 后 update 的 `updatedAt` 仍是 1000（单调）；
    重复同值 update 不产生新 change；`changes.length === 3`。
14. `accessors and prototype-bearing patches are rejected without evaluating them` —
    `{get detail(){ throw ... }}` → 抛 `/Invalid task update fields/`；`Object.create({status:'succeeded'})` → TypeError；
    `{get code(){ throw ... }}` 传给 fail → errorCode REQUEST_FAILED（**getter 不被求值**）。
15. `invalid allocation and clock callbacks leave existing records intact` —
    `new FeatureTasks({maxRecords:1, now:()=>timestamp, createId:()=>nextId})`，`input={feature:'bonfire',operation:'read',title:'读取消息'}`；
    `timestamp = NaN` 后 `complete(first.id)`（**不传 options**）抛 TypeError 且记录仍 running；
    `timestamp = 1001` 后 complete 成功；`nextId = 'invalid task ID'` 后 begin 抛 TypeError，
    **且 first 记录未被淘汰**（淘汰 `delete` 发生在 ID 分配成功之后）。

（实际 `test(...)` 调用共 15 个；文件头注的 192 是行数。移植后 vitest 用例数必须 ≥ 15。）

vitest 改写约定：`node:assert/strict` 的 `assert.equal` = 严格相等 → `expect(x).toBe(y)`；
`assert.deepEqual` = `deepStrictEqual` → `expect(x).toStrictEqual(y)`；`assert.throws(fn, TypeError)` → `expect(fn).toThrow(TypeError)`；
`assert.throws(fn, {code})` 需自己捕获断言 `error.code`（vitest 的 toThrow 对象参数比的是 message）；
`assert.match/doesNotMatch` → `expect(s).toMatch / not.toMatch`。

### src/feature-task-runner.cjs（203 行，已逐行读完）

导出：`module.exports = {FeatureTaskRunner, currentTask}`。**`OPERATIONS` 与 `WAITING_CODES` 未导出**
（interfaces.md §8 说「在 `feature-task-runner.OPERATIONS` 登记」是指改源码里的表，不是外部读属性）。
依赖 `node:async_hooks` 的 `AsyncLocalStorage`（模块级单例 `context`）与 `node:crypto` 的 `createHash`。

模块级常量：
- `WAITING_CODES = new Set(['REQUEST_ACCEPTED','RESULT_UNKNOWN','WAITING_SBS','SBS_NOT_CONFIGURED'])`
- `WAITING_DETAIL = '请求结果尚待确认；不会自动重发。'`
- `OPERATIONS`（`Object.freeze`，13 项，值是 `[feature, operation, title, execution]` 四元组，逐字）：
  `listScrolls: ['scroll','list','读取卷轴目录','being']`、`getScroll: ['scroll','read','读取卷轴正文','being']`、
  `getGroveCatalog: ['grove','list','读取工具包目录','local']`、`getGroveDetail: ['grove','inspect','查看工具包','local']`、
  `prepareGroveInstallation: ['grove','prepare','检查工具包安装条件','local']`、`installGroveKit: ['grove','install','安装工具包','local']`、
  `installEligibleGroveKits: ['grove','install_batch','批量安装工具包','local']`、`deployPortal: ['portal','deploy','部署 Portal','local']`、
  `startPortal: ['portal','start','启动 Portal','local']`、`stopPortal: ['portal','stop','停止 Portal','local']`、
  `checkPortalUpdates: ['portal','check_updates','检查 Portal 更新','local']`、
  `beginChannelConnection: ['channel','connect','连接消息渠道','being']`、`checkChannelStatus: ['channel','check','检查消息渠道状态','being']`。

帮助函数：
- `object(v)`：非 null、typeof object、非数组。
- `own(value, key)`：只读**自有数据属性**（getter 不求值），不存在或是访问器 → `undefined`。全文所有字段读取都走它。
- `definition(name, first)`：
  - `name === 'requestTownRead'`：`kind = own(first,'kind')` 必须是 `'bonfire'|'fireside'` 否则 null；
    返回 `{feature: kind, operation: kind === 'fireside' && !own(first,'firesideId') ? 'list' : 'read',
    title: kind === 'bonfire' ? '读取篝火消息' : (own(first,'firesideId') ? '读取围炉消息' : '读取围炉目录'), execution: 'being'}`。
  - 否则 `Object.hasOwn(OPERATIONS, name)` 才取四元组，否则 null（→ `run` 直接透传 `fn()`，不建账）。
- `requestKey(name, args)`：结构化归一后 sha256。`entries` 计数上限 500、`depth > 8` → `TypeError('Feature task arguments exceed the supported size')`；
  字符串长度 > 16384 同一错误；`undefined→['undefined']`、`null→['null']`、`string→['string',v]`、
  `boolean`/有限 `number` → `[typeof, v]`；数组 → `['array', items.map(...)]`；
  非 plain 对象（原型非 Object.prototype）→ `TypeError('Invalid feature task arguments')`；
  含 symbol 键或访问器 → `TypeError('Invalid feature task argument fields')`；
  对象 → `['object', Object.keys(descs).sort().map(k => [k, normalize(value)])]`。
  摘要 = `createHash('sha256').update(name).update('\0').update(JSON.stringify(normalize(args))).digest('hex')`。**只留摘要，不留原始参数。**
- `currentTask()`（模块级导出）：`context.getStore()` 为空 → null；否则 `active.ledger.get(active.id)`，
  命中返回 `{ledger, task}`，未命中返回 null。
- `wait(ledger, id, detail = WAITING_DETAIL)` → `ledger.update(id,{status:'waiting', detail})`。
- `input(ledger, id, detail)` → `ledger.update(id,{status:'needs_input', detail})`。
- `failed(ledger, id, error)`：`code = own(error,'code')`；
  `'RESULT_UNCONFIRMED'` → `input(..., '请求已发送，但自动检查尚未取得可核对的结果。请在功能页检查；不会自动重发。')`；
  `WAITING_CODES` 命中 → `wait(ledger, id)`（默认 WAITING_DETAIL）；否则 `ledger.fail(id, error)`。
- `responseFailure(result)`：`error = own(result,'error')`，当它 `!== undefined && !== null && !== false && !== ''` 时，
  返回 `object(error) ? error : {code: own(result,'code')}`；
  否则 `own(result,'__townError') === true || own(result,'ok') === false` → `{code: own(result,'code')}`；否则 null。

`finish(name, first, result, ledger, id)` —— **分支顺序即语义，逐条照抄不得合并**：
1. `responseFailure` 命中 → `failed(...)` 返回。
2. `own(result,'accepted') === true || WAITING_CODES.has(own(result,'code'))` → `failed(ledger, id, {code: own(result,'code') || 'REQUEST_ACCEPTED'})`。
3. `['busy','BUSY'].includes(own(result,'status')) || own(result,'code') === 'BUSY'` → `ledger.fail(id,{code:'BUSY'})`。
4. `own(result,'status') === 'accepted' || === 202` → `wait(ledger, id)`。
5. `['error','failed'].includes(own(result,'status'))` → `ledger.fail(id,{code: own(result,'code')})`。
6. `done = summary => ledger.complete(id, {summary})`。
7. `name === 'requestTownRead'`：`state = own(result,'status')`；`errorCode = own(state,'errorCode')` 真值 → `failed(ledger,id,{code:errorCode})`；
   围炉目录（`own(first,'kind')==='fireside' && !own(first,'firesideId')`）：`rooms = own(result,'rooms')`，
   `owned`/`joined` 都是数组 → `done(\`已读取围炉目录：创建 ${owned.length} 个，加入 ${joined.length} 个。\`)`；
   否则分支：`messages = own(own(result,'snapshot'),'messages')`，`own(state,'status') === 'ready' && Array.isArray(messages)`
   → `done(\`已读取 ${messages.length} 条${own(first,'kind')==='bonfire' ? '篝火' : '围炉'}消息。\`)`；
   都不命中 → `wait(ledger, id)`。
8. `listScrolls` + `Array.isArray(own(result,'scrolls'))` → `done(\`已读取 ${result.scrolls.length} 份卷轴的目录。\`)`。
9. `getScroll` + `typeof own(own(result,'scroll'),'title') === 'string'` → `done(\`已读取卷轴《${result.scroll.title.slice(0,160)}》当前页。\`)`。
10. `getGroveCatalog` + `Array.isArray(own(result,'kits'))` → `done(\`已读取 ${result.kits.length} 个工具包。\`)`。
11. `getGroveDetail` + `typeof own(result,'name') === 'string'` → `done(\`已读取工具包 ${result.name.slice(0,160)} 的说明。\`)`。
12. `prepareGroveInstallation` + `status === 'needs_setup'` → `input(..., '安装条件检查完成，请在工具包页面查看要求并完成配置；尚未安装或运行脚本。')`。
13. `['prepareGroveInstallation','installGroveKit']`：`status === 'needs_being'` → `input(..., own(result,'detail') || '此工具包需要 Being 协助，请在详情页查看原因。')`；
    `['ready','installed'].includes(status)` → `done(own(result,'detail') || '工具包检查已完成。')`。
14. `installEligibleGroveKits` + `Array.isArray(own(result,'results'))`：
    `items=result.results`，统计 `installed`(status==='installed')、`needs`('needs_being')、`errors`('failed')，
    `done(\`批量检查 ${items.length} 个 Kit：本机已安装 ${installed} 个，需 Being 协助 ${needs} 个，失败 ${errors} 个。加载状态见工具市场。\`)`。
15. `['deployPortal','startPortal','stopPortal']`：`portal = name === 'deployPortal' ? result : own(result,'portal')`；`status = own(portal,'status')`；
    `'error'` → `ledger.fail(id,{code:'SERVICE_ERROR'})`；
    `stopPortal` 且 `['stopped','not_configured']` → `done('Portal 本地进程已停止。')`；
    非 `stopPortal` 且 `'running'` → `done('Portal 本地进程已启动；中继连接状态请在 Portal 页面确认。')`；
    `['external','existing_configuration','existing_connection','not_configured','stopped']` → `input(..., status === 'external'
      ? 'Portal 由外部程序管理，请在 Portal 页面查看当前状态。' : 'Portal 尚未完成此操作，请在 Portal 页面核对程序、配置和连接。')`；
    否则 `wait`。
16. `checkPortalUpdates`：`update = own(result,'portalUpdate')`，`status = own(update,'status')`；
    `'error'` → `ledger.fail(id,{code:'NETWORK_ERROR'})`；`'available'` → `done('检查完成：Portal 有新版本，可在设置中查看。')`；
    `'current'` → `done('检查完成：Portal 已是当前稳定版本。')`；
    `['not_installed','unknown']` → `input(..., '请先在 Portal 页面确认已配置的程序版本，再检查更新。')`；否则 `wait`。
17. `['beginChannelConnection','checkChannelStatus']`：`status = own(result,'status')`；
    `label = own(first,'channel') === 'feishu' ? '飞书' : own(first,'channel') === 'wechat' ? '微信' : '渠道'`；
    `'connected'` → `done(\`Being 返回：${label}已连接。\`)`；`'error'` → `ledger.fail(id,{code:'SERVICE_ERROR'})`；
    `'unsupported'` → `ledger.update(id,{status:'failed', detail: \`当前 Being 尚不支持连接${label}。\`})`（**注意是 update 不是 fail，没有 errorCode**）；
    `'disconnected' && name === 'checkChannelStatus'` → `done(\`Being 返回：${label}当前未连接。\`)`；
    `['registered','disabled','expired','disconnected','needs_input','needs_setup'].includes(status) || own(result,'qrCodeDataUrl') || own(result,'qrCodeUrl')`
    → `input(..., \`请在${label}功能页查看授权或配置步骤；连接尚未确认。\`)`；否则 `wait`。
18. 兜底：`wait(ledger, id, '返回结果尚不足以确认操作完成，请在对应功能页面查看。')`。

`class FeatureTaskRunner`：
- `constructor({getLedger} = {})`：非函数 → `TypeError('Feature task runner requires getLedger')`；
  `this.getLedger = getLedger`；`this._flights = new WeakMap()`（ledger → `Map<key, Promise>`，**按账本实例隔离在途请求**）。
- `currentTask()` → 模块级 `currentTask()`。
- `recordRequest(record)`：`active = context.getStore()`；`requestId = own(record,'requestId')`；
  无 store 或 requestId 非 string → `null`；否则 `active.ledger.update(active.id, {requestId})` 并返回其结果。
- `run(name, args, fn)`：
  - `fn` 非函数 → `TypeError('Feature task callback is required')`。
  - `values = Array.isArray(args) ? args : args === undefined ? [] : [args]`；`source = values[0]`；
    `first = {kind: own(source,'kind'), firesideId: own(source,'firesideId'), channel: own(source,'channel')}`（**只提取三个字段，getter 不求值**）。
  - `definition` 为 null → **直接 `return fn()`（不建账、不去重）**。
  - `ledger = this.getLedger()`；假值或缺 `begin/update/complete/fail/get` 任一方法 → `TypeError('Invalid feature task ledger')`。
  - `key = requestKey(name, values)`；取/建 `flights`；**`flights.has(key)` → 直接返回已有 promise（同参在途去重）**。
  - `ledger.begin(taskDefinition)`；若抛错且 `name === 'stopPortal' && own(error,'code') === 'TASK_LIMIT_REACHED'` → 降级 `return fn()`；否则 rethrow。
  - `promise = Promise.resolve().then(() => context.run({ledger, id: task.id}, async () => {
      try { const result = await fn(); finish(name, first, result, ledger, task.id); return result; }
      catch (error) { failed(ledger, task.id, error); throw error; } }))
      .finally(() => { if (flights.get(key) === promise) flights.delete(key); })`；
    `flights.set(key, promise)`；返回 promise。**捕获的 ledger 在整个 run 期间属于发起时的身份。**

### test/feature-task-runner.test.cjs（260 行，已逐行读完）—— 21 个用例

夹具（原样照抄）：
- `setup()`：`sequence = 0`；`let ledger = new FeatureTasks({createId: () => \`task-${++sequence}\`, identityKey: 'alice'})`；
  `runner = new FeatureTaskRunner({getLedger: () => ledger})`；返回 `{runner, get ledger(){return ledger;},
  replace(){ ledger = new FeatureTasks({createId: () => \`task-${++sequence}\`, identityKey: 'bob'}); }}`。
- `deferred()`：暴露 `{promise, resolve, reject}`。
- `const bonfire = {kind:'bonfire', snapshot:{messages:[{content:'private message'}]}, status:{status:'ready', errorCode:''}}`。

用例（顺序即原文件顺序）：
1. `only allowlisted user operations create task records` — `['getTownMessageSnapshot','refreshTownMessages','getFiresides','sendBonfireMessage','unknown']`
   逐个 `run(name, [], () => 42) === 42`（同步透传，非 Promise）；账本为空；
   `run('requestTownRead',[{kind:'invalid'}],...)` 也透传原值；`run('requestTownRead',[{kind:'bonfire'}],()=>bonfire)` 结果 === bonfire，
   summary `'已读取 1 条篝火消息。'`、mayDelayChat true、快照不含 `/private message/`。
2. `identical concurrent requests share the same promise even with reordered object keys` —
   `listScrolls` 参数 `{offset:0,limit:10}` 与 `{limit:10,offset:0}` → `first === second`；`await Promise.resolve()` 后 `sends === 1`；账本 1 条；
   `pending.resolve({scrolls: []})` 后状态 succeeded。
3. `a settled request never replays itself; a new explicit invocation can run again` —
   `beginChannelConnection` 返回 `{status:'pending'}` → waiting；`sends === 1`；再次显式调用 → `sends === 2`（`.finally` 已清理在途表）。
4. `returning to a Fireside starts a new selection while the previous selection is still settling` —
   `read(firesideId, selectionRevision, pending)` 包装 `requestTownRead` + `[{kind:'fireside', firesideId, selectionRevision}]`；
   `first = read('1',1,previous)` 且**立刻**建立 `assert.rejects(first, {code:'SESSION_CHANGED'})`（避免未处理拒绝）；
   `selected = read('1',3,current)`、`duplicate = read('1',3,current)`；`first !== selected`、`selected === duplicate`；
   `await Promise.resolve()` 后 `calls` 深等于 `[{firesideId:'1',selectionRevision:1},{firesideId:'1',selectionRevision:3}]`；
   `current.resolve({kind:'fireside', firesideId:'1', snapshot:{messages:[]}, status:{status:'ready', errorCode:''}})` → `await selected === result`；
   `previous.reject(Object.assign(new Error('Previous room selection was cancelled'),{code:'SESSION_CHANGED'}))`；
   最终 succeeded 1 条、failed 1 条。
5. `identity changes isolate old request callbacks and duplicate maps` — `listScrolls [{}]` 两次，中间 `context.replace()`；
   `first !== second`（WeakMap 按账本实例分表）；旧账本第一条 succeeded，新账本第一条仍 running；
   第二个 resolve `{scrolls:[{title:'new'}]}` 后新账本 summary `'已读取 1 份卷轴的目录。'`。
6. `request correlation stays inside asynchronous task context and never stores the prompt` —
   `currentTask() === null`；run 内 `await Promise.resolve()` 后 `currentTask()` 的 ledger === 当前账本、`task.feature === 'bonfire'`；
   `recordRequest({requestId:'request-1', prompt:'private prompt', token:'private token'})`；
   run 结束后 `runner.currentTask() === null`、账本 requestId 'request-1'、快照不含 `/private prompt|private token/`；
   `runner.recordRequest({requestId:'outside'}) === null`（无 store）。
7. `independent concurrent tasks retain their own AsyncLocalStorage request identifiers` —
   两个 `getScroll`（args `{id:'one'}` / `{id:'two'}`）交错 recordRequest，最终 `list().map(requestId).sort()` 深等于 `['one','two']`。
8. `accepted and unknown execution results stay waiting and preserve original errors` —
   对 `['REQUEST_ACCEPTED','RESULT_UNKNOWN']`：`listScrolls` 抛带 code 的 Error（message `'raw secret payload'`），
   run 拒绝且**抛回同一对象**（`candidate === error`），账本 waiting，快照不含 `/raw secret/`；
   再测 `{accepted: true}` 结果原样返回且账本 waiting。
9. `response errors cannot appear as successful tasks while existing UI receives the same result` —
   `[{error:{code:'NETWORK_ERROR',message:'secret'}}, {__townError:true,code:'SERVICE_ERROR'}, {ok:false,code:'SERVICE_ERROR'}]`
   逐个：`getGroveCatalog` 返回值原样透传，账本 failed，快照不含 `/secret/`。
10. `a rejected preflight ends locally and a later explicit read can complete independently` —
    `requestTownRead` 抛 `{code:'BUSY'}` → 拒绝且账本 failed、requestId `''`、detail 匹配 `/未发送/`；
    随后显式重读成功，先前那条仍为 failed。
11. `explicit busy and accepted transport states take precedence over stale result arrays` —
    `['accepted','busy','BUSY',202]`，结果 `{status, scrolls: []}`：busy/BUSY → failed，其余 → waiting。
12. `Town old snapshots never count as a successful new request when status reports failure or waiting` —
    `[['REQUEST_ACCEPTED','waiting'],['BUSY','failed'],['READINESS_UNKNOWN','failed'],['RESULT_UNCONFIRMED','needs_input'],['NETWORK_ERROR','failed']]`，
    响应 `{...bonfire, status:{status:'waiting', errorCode: code}}`；断言状态与 `summary === ''`。
13. `Grove installation checks require user setup and never claim installation` —
    `prepareGroveInstallation` 返回 `{status:'needs_setup', kit:{name:'name', env:{API_KEY:'private'}}, assessment:{blocked:true}}`
    → needs_input、mayDelayChat false、detail 匹配 `/尚未安装或运行脚本/`、JSON 不含 `/private|API_KEY/`。
14. `Channel outcomes distinguish QR authorization, pending, unsupported and confirmed statuses` —
    `[[{status:'pending'},'waiting'],[{status:'unknown'},'waiting'],[{status:'pending',qrCodeDataUrl:'data:image/png;base64,private'},'needs_input'],
      [{status:'registered'},'needs_input'],[{status:'unsupported'},'failed'],[{status:'connected'},'succeeded']]`；
    每次响应额外带 `detail:'secret raw channel response'`；快照不得含 `/base64|secret raw|qrCode/`。
15. `Channel checks can report disconnection while a connection operation still needs action` —
    `checkChannelStatus` + `{status:'disconnected'}` → succeeded；`beginChannelConnection` + 同样响应 → needs_input。
16. `Portal status confirms local process operations without implying a verified relay` —
    `startPortal → {portal:{status:'running',health:'unknown'}}` succeeded 且 summary 匹配 `/中继连接状态.*确认/`；
    `stopPortal → {portal:{status:'external'}}` needs_input；`deployPortal → {status:'existing_connection'}` needs_input；
    `stopPortal → {portal:{status:'stopped'}}` succeeded。
17. `Portal update response errors are failures even when the outer call resolved` —
    `{portalUpdate:{status:'error'}}` failed；`{portalUpdate:{status:'available', releaseUrl:'https://example.test/?token=secret'}}` succeeded；
    快照不含 `/example.test|secret/`。
18. `curated library and Grove summaries contain titles and counts, not raw bodies or setup data` —
    `getScroll [{id:'one'}] → {scroll:{title:'日志',content:'private body'}}`；`getGroveCatalog [{}] → {kits:[{name:'one',description:'private manifest'}]}`；
    `getGroveDetail ['one'] → {name:'One', setup_guide:{env_template:{TOKEN:'private setup'}}}`（**args 第一项是字符串**）；
    `requestTownRead [{kind:'fireside'}] → {rooms:{owned:[{id:1,description:'private room'}], joined:[]}}`；
    全部 succeeded，快照不含 `/private body|private manifest|private setup|private room|env_template/`。
19. `unknown response shapes remain unconfirmed and raw backend exceptions retain identity` —
    `getScroll → {message:'done'}` waiting；`getGroveDetail` 拒绝一个无 code 的 Error（`'private upstream exception'`）→ 原对象抛回、账本 failed、
    快照不含 `/private upstream/`。
20. `a full active ledger never prevents stopping Portal but still blocks new tracked work` —
    `new FeatureTasks({maxRecords: 1})`（**无 identityKey**），先 begin 一条 `{feature:'channel',operation:'connect',title:'渠道授权',execution:'being'}`
    并 update 到 waiting；`stopPortal` 走逃生路径：返回值透传、`stopped === 1`、账本仍 1 条且那条仍 waiting；
    `startPortal` 抛 `{code:'TASK_LIMIT_REACHED'}` 且 `started === 0`。
21. `the full-ledger stop escape preserves stop failures and never swallows unrelated bookkeeping errors` —
    `new FeatureTasks({maxRecords: 1})`，`ledger.begin({feature:'portal',operation:'inspect',title:'待核对'})`（**无 execution，默认 local**）；
    `stopPortal` 逃生后 fn 抛 `stopError` → 原对象拒绝；再把 `ledger.begin` 换成抛 `ledgerError`（无 code）→ `run('stopPortal',...)` 同步抛出原对象，
    且 fn 未被调用（`stopped === false`）。

vitest 改写注意：`assert.rejects(p, c => c === error)` → `await expect(p).rejects.toBe(error)`；
`assert.rejects(p, {code:'X'})` → `expect(p).rejects.toHaveProperty("code","X")`（提前建立以免未处理拒绝）；
`assert.ok(arr.every(...))` → `expect(...).toBe(true)`。

### src/feature-task-history.cjs（148 行，已逐行读完）

导出：`module.exports = {FeatureTaskHistory}`。
依赖：`node:fs/promises`、`node:path`、`node:crypto`（`createHash`、`randomUUID`）、
`./feature-tasks.cjs` 的 `FeatureTasks`、**`./loom-town-sync.cjs` 的 `normalizeTownSyncRecords`**
（后者属于 Town/Loom 单元，本 worktree 不存在 → 必须作为构造参数注入）。
常量 `MAX_FILE_BYTES = 128 * 1024 * 1024`。

`constructor({identityKey, directory, safeStorage, onChange = () => {}} = {})`：
- `identityKey` 必须是 string 且匹配 `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/`，否则 `TypeError('Invalid task history identity')`
  （**注意：与 FeatureTasks 的 `identity()` 不同，这里不允许空串**）。
- `directory` 必须是非空 string、`onChange` 必须是函数，否则 `TypeError('Invalid task history configuration')`。
- `this.directory = path.resolve(directory)`；
  `this.filePath = path.join(this.directory, \`${createHash('sha256').update(identityKey).digest('hex')}.bin\`)`。
- 内部状态：`_persistenceError = false`、`_records = []`、`_blocked = false`、`_dirty = false`、`_generation = 0`、
  `_restorePromise = null`、`_savePromise = null`；最后 `this.ledger = this._ledger()`。

属性：`get records()` → `structuredClone(this._records)`；`get persistenceError()` → `this._persistenceError`。

- `_ledger(initialSnapshot)`：`new FeatureTasks({identityKey: this.identityKey, initialSnapshot, onChange: () => {
   this._generation++; this._notify(); void this.save(); }})` —— **账本每次变化都 +generation、推送、异步落盘**。
- `_notify()`：`try { this.onChange({tasks: this.ledger.list(), persistenceError: this.persistenceError}); } catch {}`。
- `_encryptionAvailable()`：`try` 包住，要求 `safeStorage?.isEncryptionAvailable` 是函数且**返回值 === true**，
  且 `encryptString`、`decryptString` 都是函数；任何异常 → false。
- `restore()`：记忆化 `_restorePromise`，`await` 后 `return this`。
- `_restore()`：
  1. `!_encryptionAvailable()` → `_blocked = true; _persistenceError = true; _notify(); return`。
  2. `fs.stat(filePath)`，非文件或 `size > MAX_FILE_BYTES` → 抛 `Error('Invalid encrypted task history')`；
     `fs.readFile`，`ciphertext.length > MAX_FILE_BYTES` 同样抛。
  3. `payload = JSON.parse(this.safeStorage.decryptString(ciphertext))`。
  4. 校验（任一不满足 → 抛 `Error('Task history identity or schema mismatch')`）：payload 是非数组对象、
     **`Object.keys(payload).length === 4`**、`version === 1`、`identityKey === this.identityKey`、
     `payload.ledger` 真值且 `ledger.version === 1`、`ledger.identityKey === this.identityKey`、
     `Array.isArray(ledger.records)`、`Array.isArray(payload.records)`、`payload.records.length <= 256`。
  5. **合并首次磁盘读取期间提交的工作**：`current = this.ledger.snapshot()`，`currentIds = new Set(current.records.map(t => t.id))`；
     `records = this._generation ? [...current.records, ...payload.ledger.records.filter(t => !currentIds.has(t?.id))] : payload.ledger.records`；
     `this.ledger = this._ledger({...payload.ledger, records})`；
     `this._records = normalizeTownSyncRecords([...payload.records, ...this._records])`。
  6. `catch (error) { if (error?.code !== 'ENOENT') { this._blocked = true; this._persistenceError = true; } }`
     —— **文件不存在是正常首启，不算错误、不置 blocked**。
  7. 无论成败最后 `this._notify()`。
- `register(record)`：`candidate = normalizeTownSyncRecords([record])`，长度 !== 1 → `return false`；
  `next = normalizeTownSyncRecords([...this._records, candidate[0]])`；
  `accepted = next.some(item => item.requestId === candidate[0].requestId)`；
  `JSON.stringify(next) !== JSON.stringify(this._records)` 时才 `_records = next; _generation++; _notify(); void this.save();`；返回 `accepted`。
- `save()`：`_dirty = true`；若无在途 `_savePromise` 则 `_savePromise = this._drain().finally(() => {
   this._savePromise = null; if (this._dirty && !this._blocked) void this.save(); })`；返回 `_savePromise`。
- `_drain()`：先 `await this.restore()`；然后 `while (this._dirty && !this._blocked)`：
  - `this._dirty = false`；`let temporary`（try/catch/finally）：
  - `!_encryptionAvailable()` → `_blocked = true` 并抛 `Error('Task history encryption unavailable')`；
  - `this.ledger.identityKey !== this.identityKey` → `_blocked = true` 并抛 `Error('Task history identity changed')`；
  - `payload = JSON.stringify({version:1, identityKey: this.identityKey, ledger: this.ledger.snapshot(), records: this._records})`
    （**磁盘明文格式，四个键，顺序固定**）；
  - `ciphertext = this.safeStorage.encryptString(payload)`，抛错 → `_blocked = true` + `Error('Task history encryption failed')`；
  - 非 Buffer / 空 / 超限 → `_blocked = true` + `Error('Invalid encrypted task history')`；
  - `fs.mkdir(this.directory, {recursive: true})`；`temporary = \`${this.filePath}.${randomUUID()}.tmp\``；
    `fs.writeFile(temporary, ciphertext, {flag:'wx', mode: 0o600})`；`fs.rename(temporary, this.filePath)`；`temporary = null`；
  - 写成功且此前有 `persistenceError` → `_persistenceError = false; _notify()`（**恢复也要推送**）。
  - `catch { this._persistenceError = true; this._dirty = false; this._notify(); }`
  - `finally { if (temporary) { try { await fs.unlink(temporary); } catch {} } }` —— **临时文件必清理**。
  - 循环结束 `return !this.persistenceError`。
- `flush()`：`while (this._savePromise) await this._savePromise;` 然后 `return !this.persistenceError`。

## 进度

| 模块 | 状态 |
| --- | --- |
| docs 摘要（architecture §4/§6/§8） | 已读 |
| docs/interfaces.md §3/§5/§7 | 已读 |
| src/feature-tasks.cjs | 已读 |
| src/feature-task-runner.cjs | 已读 |
| src/feature-task-history.cjs | 已读 |
| src/feature-task-discussion.cjs | 未开始 |
| test/feature-tasks.test.cjs | 已读（15 个用例） |
| test/feature-task-runner.test.cjs | 已读（21 个用例） |
| test/feature-task-history.test.cjs | 未开始 |
| test/feature-task-discussion.test.cjs | 未开始 |
| test/town-error-ipc.test.cjs（feature-tasks 相关用例） | 未开始 |
| src/main.cjs boot() 注入面 | 未开始 |

注：worktree 里已存在上一轮被中断的未提交草稿 `desktop/main/features/{types,feature-tasks,feature-task-runner,feature-task-history}.ts`
（无任何迁移记录），本轮按源码逐行复核后再定稿。
