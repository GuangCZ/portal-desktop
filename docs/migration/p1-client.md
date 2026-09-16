# P1 第一块：原生消息客户端与恢复逻辑移植（BeingDesktop 0.8.26 → TypeScript）

本块只新增文件，不改既有文件。并行块在同一工作树里创建了
`desktop/main/chat/{cache,frame,session-recovery,store-types,store,titles}.ts` 与
`tests/chat-store.test.ts`——本块不碰、不 import。

## 阅读摘要

### docs/desktop-message-layer.md（206 行，协议实测记录）

五个端点：`POST /api/chat/stream`、`GET /api/history`、`GET /api/stream/active`、
`POST /api/stop`、`GET /api/status`。**鉴权只认 `?token=`；带 `Authorization: Bearer` 返回 403**
（与 Town 客户端相反）。

- 一（202）：Being 空闲 → `200 text/event-stream`；正在呼吸 → `202 application/json {"spliced":true}`，
  消息已送达但没有自己的流。当失败处理会导致用户重发、队列里排两条。
- 二（连接不属于会话）：`message_stop` 之后同一连接可能出现
  `event: meta / {"continuation":true,"scene_id":"desktop-<desktopId>-<sessionId-B>"}`，
  随后流出 B 的回复。**事件必须按 scene 路由，不能按 scene 过滤**；正文缓冲按会话分开。
  映射是双向纯函数：`scene_id = desktop-{desktopId}-{sessionId}`，反解失败计入 `foreign`。
- 三（并发）：服务端串行排队，每条回复盖正确 scene 章。
- 四（打断）：`/api/stop` 没有 scene 参数。判定表：属于本会话且还在说 → 停；属于别的会话 →
  `other-scene`；缓冲无 scene → `unknown`；最后一条是 `message_stop` → `unknown` + 刚说完的 scene；
  空闲/已结束 → `idle`。`force: true` 是用户回答询问后的通道。剩余竞态堵不死（待提 Heart 侧）。
- 五（探活/replay）：空闲返回 `204` 无正文。活跃字段 `events, finished, next_seq, origin,
  started_at, stream_id, trigger_message`。replay 事件形如 `{"event":"reasoning","seq":1,"data":{...}}`，
  seq 从 1 起按流计数，`next_seq` 是续读位置。replay 事件带 `scene_id`。
  `reasoning` 是思考流（`data.text`），实时展示但不并入正文。
- 六（不变量）：① `meta` 不占 seq，其余事件与服务端 seq 严格 1:1；② `meta` 不进 replay 缓冲；
  ③ 消息与游标同一事务落盘；④ `lastSeq` 只前进——history 游标只能取「过滤后新行」的最后一个 seq；
  ⑤ 基线纪律：有全量基线前增量只攒不落盘。
- 七（历史行）：字段全集 `role, content, seq, at, from?, scene_id?`，**没有 session_id**。
  Loom 放行无 scene 的行，Desktop 不能照抄。
- 八：`/api/history` 不支持按 scene 查询，一次拉取 → 按 scene 分发。`history()` 额外返回
  `ignoredAfter`（整页非空但没有新于 `after` 的行）。
- 九（模块与职责）+「暂存项的确认规则」：一个 `message_stop` 一项；前缀容忍双向、共同前缀 ≥ 8 字符；
  **writer 结束必须 settle**（live reader / replay poller / 断线恢复意图彻底结束时，router 里还开着的
  气泡以 `settled` 事件通知会话层）；router 随恢复意图一起走（live → pending → cutover → replay）；
  调过工具的回复只落最后一个文本块；过期按项计（3 次「落了新行却没确认」）。
  「沉默没有信号」：catch-up 等满 5 分钟放弃时用中性文案「这口气没有留下给这个会话的话。」，不报错。
- 十（图片）：发送体用 `content` 块数组代替 `message`；服务端只认 `text`/`image`/`image_url`
  （`audio` → 422 且不落行）；只有图片没有文字 → 200 有流但 history 无 user 行且答错问题，
  **所以图片必须配文字**；9.5 MB PNG 可过；图片不进历史、不进下一口气的感知。
  包络：PNG/JPEG/WebP/GIF，每条 ≤ 10 MB，最多 8 张。

### src/being-chat.cjs（509 行）

常量：`MAX_BYTES = 4MiB`、`MAX_MESSAGE = 200000`、`MAX_EVENTS = 5000`、`HISTORY_LIMIT = 100`、
`IMAGE_TYPES = /^image\/(?:png|jpeg|webp|gif)$/`、`MAX_IMAGE_BYTES = 10MiB`、`MAX_IMAGES = 8`、
`BASE64 = /^[A-Za-z0-9+/]+={0,2}$/`、`UUID`（版本 1-8、variant 89ab）。

`MESSAGES`（面向用户的中文串，键即 error.code）：NOT_CONNECTED「请先连接 Being。」、
SESSION_CHANGED「Being 连接已变化，旧请求已取消。」、INVALID_REQUEST「请求参数无效。」、
INVALID_RESPONSE「Being 返回格式无效。」、NETWORK_ERROR「与 Being 的连接中断，请稍后重试。」、
SERVICE_ERROR「Being 服务暂时不可用。」、AUTH_REQUIRED「Being 连接凭据无效，请重新连接。」、
ABORTED「请求已取消。」、RESULT_UNKNOWN「发送结果未确认，请刷新后核对再决定是否重发。」。

导出面：`{BeingChat, consumeEvents, sceneId, sessionFromScene, inScene, historyRow, imageBlocks,
imageBytes, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES}`。

构造参数：`{getContext, desktopId, fetchImpl = globalThis.fetch, onEvent = () => {}, clientVersion = '',
prepareMessage = null}`。内部：`_epoch`、`_requests: Set<AbortController>`、`_pending: Map<clientRef, sessionId>`。

方法要点：
- `reset()` 递增 epoch、abort 全部请求、清空 pending。`inFlight(sessionId)` 查 `_pending` 的值。
- `_context(expected)`：`getContext()` 必须 `connected && connection`；`parseConnection(value.connection.url || value.connection)`
  失败 → NOT_CONNECTED；返回 `{apiBase, token, revision: value.revision ?? 0, epoch}`；
  与 `expected` 任一字段不同 → SESSION_CHANGED。
- `_url(ctx, route, query)`：`new URL(ctx.apiBase + route)` + `token` 查询参数 + query。
- `_request(ctx, route, {method, query, body, accept, signal, timeoutMs = 30000})`：
  `AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...signal])`；
  fetch 选项 `credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', cache:'no-store'`；
  401/403 → AUTH_REQUIRED；`!ok || redirected` → SERVICE_ERROR；catch 里先 `_context(ctx)`（可能抛
  SESSION_CHANGED），再 `signal?.aborted → ABORTED`，已知 code 原样抛，否则 NETWORK_ERROR。
- `_readJson`：204 → null；content-type 必须含 application/json；累计 > MAX_BYTES → INVALID_RESPONSE。
- `status()` → `{beingName}`（`being_name` 截 100）。
- `history({after = 0, limit = 100})` → `{rows, cursor, more, ignoredAfter}`；
  `after > 0` 时才带 `after` 查询参数；rows 按 seq 排序；`fresh = after > 0 ? rows.filter(seq > after) : rows`；
  `cursor = fresh.at(-1)?.seq ?? after`；`more = fresh.length >= limit`；
  `ignoredAfter = after > 0 && rows.length > 0 && fresh.length === 0`。
- `probe({streamId, after, localSeq})` → `{verdict, events, streamId, nextSeq, serverSeq, scene, scenes,
  origin, autonomous, speaking, trigger}`；204/null → `gone`（其余字段空）；
  `streamId && active && active !== streamId` → `superseded`（events 空、只带 active streamId）；
  events 规整为 `{type, seq, data}` 并截 MAX_EVENTS；`nextSeq = next_seq > 0 ? next_seq : after + events.length + 1`；
  `serverSeq = max(0, nextSeq - 1)`；`autonomous = origin !== '' && origin !== 'human'`；
  `scene` 取最后一个带 scene 的事件，`scenes` 去重；`speaking = !!last && last.type !== 'message_stop'`；
  `finished === true` → `finished`；`serverSeq > localSeq` → `progressing`；否则 `stalled`。
- `stop({sessionId, force})` → `{stopped, reason, scene}`；非 force 时先 probe，判定表见上文第四节；
  reason ∈ idle / autonomous / unknown / other-scene / matched / forced；
  `/api/stop` 的 INVALID_RESPONSE 被吞（服务端可能不返回 JSON）。
- `send({sessionId, text, images, sceneMeta, signal, onDelta, onProgress, router})`：
  前置校验（UUID、text 非空且无 `\0`、长度、sceneMeta 必须是纯对象、imageBlocks）；
  `clientRef = 'req-' + randomUUID()`；`prepareMessage?.({sessionId})` → `_context(ctx)` →
  `prepared?.assertCurrent?.()` → `wireText = wrapMessage(text, prepared?.context)`（再查一次长度）；
  body = `{...(blocks.length ? {content:[{type:'text',text:wireText}, ...blocks]} : {message: wireText}),
  scene_id, scene_meta: {client: 'being-desktop/<clientVersion|0>', ...sceneMeta}, client_ref}`；
  POST `timeoutMs: 600000`；`dispatched = true` 之后任何失败都变 RESULT_UNKNOWN（带 progress）；
  202 → `{ok:true, streamed:false, spliced: value?.spliced !== false, streamId:'', clientRef,
  confirmed:false, replies:0, liveSeq:0, foreign:0, trailing:''}` 并 emit `{type:'spliced', scene}`；
  否则 content-type 必须是 text/event-stream。
- `_consume`：`router.expect(clientRef)`；每个事件先 `_context(ctx)`、`live?.aborted → ABORTED`；
  失败时 `Object.assign(error, {progress: router.state()})`。
- `replay({events, from, router, sessionId, scene})`：跳过 `seq <= cursor`；
  `type = item.type ?? item.event ?? 'message'`；返回 `{cursor, ...router.state()}`。
- `router({scene, sessionId, onDelta, onProgress})` → `{handle, state, settle, expect, get sessionId}`；
  闭包状态 `streamId, liveSeq, confirmed, current = scene, replies, foreign, clientRef, buffers: Map`。
  `handle`：`type !== 'meta'` 才 `liveSeq++`；meta 带 `stream_id` 更新 streamId；
  **路由前**先 `onProgress({type, liveSeq, streamId})`（watchdog 必须看到外来事件）；
  meta：`client_ref` 相等 → confirmed；`eventScene` 非空 → `current = eventScene`；
  emit `{type:'meta', streamId, scene: current, confirmed}` 给 `sessionFromScene(current) || sessionId`；
  其余事件 `target = sessionFromScene(eventScene || current)`，无 target → `foreign++` 丢弃；
  error → emit message（截 2000）；reasoning → emit `{type:'think', text}`（不进正文）；
  content_block_delta → 按 target 累积 buffer（> MAX_MESSAGE → INVALID_RESPONSE），
  `target === sessionId` 才调 `onDelta`，emit `{type:'delta'}`；
  message_stop → 取出并删除 buffer，`target === sessionId` 才 `replies++`，emit `{type:'reply', text}`；
  其余 emit `{type, data}`。
  `state()` → `{streamId, confirmed, replies, liveSeq, foreign, trailing}`；
  `settle()` → 还开着气泡的 sessionId 列表，之后清空（第二次 settle 返回空）。
- 观察者异常一律吞掉（`catch { /* Observers cannot affect the stream. */ }`）。

依赖：`./security.cjs` 的 `parseConnection`（返回 `{url, apiBase, token, secret, displayUrl, beingName}`）、
`./orchestration-message.cjs` 的 `wrapMessage(text, context)`（`PREFIX = '[Being Desktop request context
v1; length='`、`SUFFIX = '\n[/Being Desktop request context v1]\n\n'`；无 context 原样返回）。

### src/being-recovery.cjs（461 行）

常量：`STALL_MS = {awaiting_first: 75000, reasoning: 90000, text: 45000, tool: 300000}`、
`STALL_BACKOFF_MS = [30000, 60000, 120000]`、`STALL_GIVEUP_MS = 15 * 60 * 1000`、
`WATCHDOG_TICK_MS = 5000`、`PROGRESS = new Set(['content_block_delta','thinking','reasoning',
'tool_use','tool_result','message_stop','error'])`（`usage` 故意不算进展）、
`POLL_INITIAL_MS = 500`、`POLL_MAX_INTERVAL_MS = 5000`、`POLL_ABSOLUTE_MAX_MS = 30 * 60 * 1000`、
`POLL_MAX_NET_FAILS = 6`、`AUTONOMOUS_POLL_MS = 2000`、`CATCH_UP_INITIAL_MS = 2000`、
`CATCH_UP_MAX_INTERVAL_MS = 30000`、`CATCH_UP_ABSOLUTE_MAX_MS = 5 * 60 * 1000`、
`RECOVERY_BACKOFF_MS = [2000, 5000, 10000, 30000]`、`CURSOR_SYNC_DELAYS = [0, 500, 1000]`、
`MAX_INCREMENTAL_PAGES = 10`；`gone(code)` = NOT_CONNECTED / SESSION_CHANGED / AUTH_REQUIRED。

导出面：`{BeingRecovery, stallTracker, STALL_MS, STALL_GIVEUP_MS, CATCH_UP_ABSOLUTE_MAX_MS,
POLL_ABSOLUTE_MAX_MS}`。

`stallTracker(clock)` → `{firstStalledAt, nextProbeAt, index, due(), onStalled() → {totalMs, nextInMs}}`。

构造参数 `{chat, store, timers = {setTimeout, clearTimeout}, clock = Date.now, onEvent, onState}`；
缺 chat/store 抛 TypeError。构造时劫持 `chat.onEvent` 直通到自己的 `onEvent`。
内部：`_epoch`、`_live`、`_poll`、`_catchUp`、`_autonomous`、`_pending`、`_reconcile`、`_phase`。
`state()` → `{...phase, pending, live, replaying, catchingUp, watching}`。

`store` 只用到四处：`store.cursor`、`store.seeded`、
`store.apply({rows, cursor, baseline}) → {stored, cursor}`、`store.rows(sessionId)`。

方法要点：
- `send()`：先 `_stopPoll(); _stopCatchUp()`（F2）；建 live writer（`epoch: ++this._epoch`、
  `phase: 'awaiting_first'`），router 由 `chat.router` 建好并挂 `onProgress`；启动 watchdog tick；
  调 `chat.send`；无论成败先 `_cancel(timer)` 并释放 writer 槽。
  成功且 `!streamed`（202）→ `startCatchUpWatcher` 并返回；
  成功且 streamed → `_settle(router)`；`replies === 0` → catch-up；否则 `_setPhase('idle')` + `syncCursor()`。
  失败分支顺序：`live.cutover` → `cutoverToReplay`（`recovering:'replay'`）；`live.recover` →
  `recoverViaHistory`（`'history'`）；`live.gaveUp` → `recoverViaHistory`（`'history'`, gaveUp:true）；
  `code !== 'RESULT_UNKNOWN'` → settle + idle + 抛出；`signal?.aborted` → settle + catch-up（`'catch-up'`）；
  否则 `queueDisconnectRecovery`（`'probe'`）。
- `_progress(live, {type, liveSeq, streamId})`：liveSeq 取 max；非 PROGRESS 事件不刷新 lastProgress；
  `tool_use → phase 'tool'`；`tool_result`/`content_block_delta → 'text'`；`thinking`/`reasoning` → `'reasoning'`。
- `_watchdogTick`：每 5s；`stalledFor >= STALL_MS[phase]` 且 `stall.due()` 才 `_onWatchdogExpired`；
  `busy` 防重入；tick 自我续期。
- `_onWatchdogExpired`：无 streamId → 只累计，`totalMs >= STALL_GIVEUP_MS` 才 gaveUp；
  否则 probe（异常 → `gone(code) ? 'abandoned' : 'unreachable'`）；
  progressing/finished → `live.cutover = probe` + abort；gone/superseded → `live.recover = true` + abort；
  abandoned → gaveUp + abort；stalled → 退避文案「服务端也没有新进展，N 秒后再检查一次」；
  default（unreachable）→「连接中断了，正在自动恢复…」，超时才 gaveUp。
- `cutoverToReplay({streamId, fromSeq, sessionId, initial, router})`：`_stopPoll(); _stopAutonomous()`；
  `++this._epoch`；F1——活着的 live reader 必须杀掉并借用它的 router/sessionId；
  `this._pending && this._pending.router !== router` → settle 掉被放弃的 pending；
  `initial?.events?.length` 先折进去；`initial?.verdict === 'finished'` → `_finishReplay`。
- `_pollOnce`：超 deadline → `recoverViaHistory`；gone/superseded → `recoverViaHistory`；
  有事件就 replay 推进 cursor；finished → `_finishReplay`；
  异常：`gone(code)` → 直接 idle；`++netFails >= 6` → 交给 `queueDisconnectRecovery`；
  否则 `interval = min(interval * 1.5, 5000)`。
- `_stopPoll()` 会 settle poller 的 router。
- `recoverViaHistory({router})`：`_stopPoll()`、`_epoch++`、settle pending 与传入 router、
  `reconcile()`、无 live 才 idle、最后 `checkActiveStream({autonomousOnly: true})`。
- `applyVerdict(probe, {streamId, localSeq, sessionId, router})` → 'cutover' / 'recovered' / 'stalled' / 'unreachable'。
- `queueDisconnectRecovery` + `runPendingRecovery`：abandoned → 静默放弃；
  非 unreachable 先清 `_pending` 再 `applyVerdict`；stalled/unreachable 则按
  `RECOVERY_BACKOFF_MS` 续约，超过 `POLL_ABSOLUTE_MAX_MS` 转 `recoverViaHistory`。
- `startCatchUpWatcher({sessionId})`：`sinceSeq = store.cursor`，延迟 2s 起每次翻倍封顶 30s；
  有 live 时直接让步（不 reconcile）；超过 5 分钟 → `_setPhase('idle', {sessionId, gaveUp: true,
  hint: '这口气没有留下给这个会话的话。'})`；同时 `checkActiveStream()`。
- `watchAutonomous({streamId, origin})`：有 live 或无 streamId 直接返回；同一 streamId 不重复；
  文案映射 `{beating:'being 正在自己想事情…', callback:'being 正在处理一条回调…',
  leftover:'being 正在回答排队的消息…'}`，默认「being 正在呼吸…」；每 2s 只问 finished/gone/superseded。
- `checkActiveStream({autonomousOnly})` → 'busy' / 'unreachable' / 'idle' / 'autonomous' / 'skipped' / 'cutover'。
- `reconcile({full})`：并发共享同一个 in-flight promise；
  `baseline = full || !store.seeded || cursor === 0`；最多 10 页；`baseline || !page.more || page.ignoredAfter` 就停；
  失败返回 `{error: code}` 而不抛；`finally` 里检查 catch-up watcher 是否已被满足。
- `syncCursor()`：`[0, 500, 1000]` 三次，成功或 `gone` 提前返回。
- `onReconnected()`：先 `runPendingRecovery()`，返回 'idle' 才 `checkActiveStream()`。
- `stop()` 直接委托 `chat.stop`。`dispose()`：epoch++、abort live（gaveUp）、settle、停三类定时器、idle。

### test/being-chat.test.cjs（351 行，30 个用例）

夹具：`DESKTOP/A/B` 三个 UUID、`token = 'c'.repeat(64)`、
`json(value, status)`、`sse(frames)`、`fixture(fetchImpl)` 返回 `{chat, calls, events, reconnect}`，
context 为 `{connected: true, connection: {url: 'https://echo.beings.town/cz_being/?token=' + token}, revision: 1}`，
`clientVersion: '0.8.24'`。用例名清单见「进度」一节的测试文件说明。

### test/being-recovery.test.cjs（473 行，22 个用例）

夹具：手写假定时器队列（`now = 1_000_000` 起、`advance(ms)` 按到期时间依次触发并 `settle()`）、
`settle()` = 25 次 `setImmediate`、可编排的 `fetchImpl`（`on` 一次性路由 / `always` 兜底路由，
路径去掉 `/cz_being` 前缀）、手动喂的 SSE 流（`open/push/close/error`，abort 会让 reader 报错）。
`WATCHDOG = 5000` 常量定义在文件中部（第 244 行），被前面的用例引用（函数提升）。
原测试用真实 `ChatStore`；本移植用测试内的 `TestStore` 替身（只实现 recovery 用到的四个成员），
因为 `store.ts` 属于并行块。

### src/chat-sessions.cjs（371 行）——调用点

`new BeingChat({getContext, desktopId, clientVersion, prepareMessage, ...(fetchImpl ? {fetchImpl} : {})})`；
`new BeingRecovery({chat, store, ...(timers ? {timers} : {}), clock, onEvent, onState})`。
用到的方法：`chat.inFlight(id)`、`chat.reset()`、`sceneId(desktopId, id)`、
`imageBytes/IMAGE_TYPES/MAX_IMAGE_BYTES/MAX_IMAGES`、
`recovery.send({sessionId, text, images, sceneMeta})`、`recovery.stop({sessionId, force})`、
`recovery.reconcile({full})`、`recovery.checkActiveStream()`、`recovery.dispose()`、`recovery.state()`。
事件消费：`delta` / `think` / `tool_use` / `reply` / `settled` / `error`（`_onEvent`）。

## 进度

| 文件 | 状态 |
|---|---|
| `desktop/main/chat/protocol-types.ts` | 已移植 |
| `desktop/main/chat/being-chat.ts` | 已移植，测试通过（30/30） |
| `desktop/main/chat/recovery.ts` | 已移植，测试通过（22/22） |
| `tests/being-chat.test.ts` | 已移植，30 个用例全绿 |
| `tests/being-recovery.test.ts` | 已移植，22 个用例全绿 |

### 移植时的取舍（being-chat.ts）

- `parseConnection` 改用本仓库既有的 `desktop/main/chat/connection.ts`（返回 `{endpoint, being,
  token, relaySecret, link}`，`endpoint` 即原来的 `apiBase`），不再重复 BeingDesktop 的
  `src/security.cjs`。两者对 `https://host/being/?token=…` 与 `api=` 同源参数的解析结果一致；
  本仓库的版本另外限制 token 字符集、不接受 `[::1]` 回环写法。
- `_readJson` 原本 `for await (const chunk of response.body)`（Node 的 Response body 可异步迭代，
  DOM 类型里不可），移植为等价的 reader 循环；另外给 `body` 为 null 的 200 响应补了
  `INVALID_RESPONSE`（原来会抛裸 TypeError）。读到的字节完全一致。
- `wrapMessage` 留在 being-chat.ts 里（`unwrapMessage` 已被并行块放进 `frame.ts`），
  两者在后续阶段合并。
- `randomUUID` 变成可注入的构造参数（默认仍是 `node:crypto` 的那个），符合本阶段
  「外部依赖用构造参数注入」的要求；默认行为不变。
- `ChatEvent` 是可辨识联合，`emit()` 用分发式 `Omit`（`ChatEventBody`）保留各成员自己的字段。

### 移植时的取舍（recovery.ts）

- `store` 不再是具体的 `ChatStore`，而是本文件声明的 `RecoveryStore` 接口（`cursor`、`seeded`、
  `apply`、`rows` 四个成员），这样本块与并行的 store 块互不依赖；`ChatStore` 结构上满足它。
- 测试里的 store 用 `TestStore` 替身，实现 `ChatStore.apply` 的按 scene 分发、去重、
  「游标只前进」「baseline 先清空」四条规则，足以覆盖原测试的全部断言。
- 定时器与时钟继续走构造参数注入（原样保留原测试的手写队列夹具），没有改用 `vi.useFakeTimers`：
  `chat.send` 内部持有真实的 `AbortSignal.timeout(600000)`，全局假定时器会一并接管它。
- `applyVerdict` 的 `streamId` 原来可能是 `undefined`（只用于 `probe.streamId || streamId`），
  TS 版本默认 `''`；唯一调用方 `runPendingRecovery` 传的 pending 里 `streamId` 一定是字符串。
- `send` / `stop` / `startCatchUpWatcher` 的参数对象在 TS 里是必填（原来 `= {}`）。
  原实现在缺 `sessionId` 时也会在 `sceneId()` 抛 `INVALID_REQUEST`，只是先做了 `_stopPoll()` 等副作用。

## 全量门槛

`npm run typecheck` 通过；`npx vitest run`：Test Files 50 passed | 7 skipped (57)，
Tests 396 passed | 16 skipped (412)。其中本块贡献 52 个（chat 30 + recovery 22）。
