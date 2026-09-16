# 迁移单元 u1：Town 会话与线协议（P2a）

来源：BeingDesktop 0.8.26 工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop`
目标：portal-desktop `desktop/main/town/session/*.ts` + `tests/town-session-*.test.ts`
移植日期：2026-09-16
分支：`u1-town-session`（基线 d5z/portal-desktop main @ 4921932）

移植模块清单：
- src/town-client.cjs -> desktop/main/town/session/client.ts
- src/town-session.cjs -> desktop/main/town/session/session.ts
- src/town-wire.cjs -> desktop/main/town/session/wire.ts
- src/town-library-contract.cjs -> desktop/main/town/session/library-contract.ts
- （新增）desktop/main/town/session/types.ts

---

## 阅读摘要

（每读完一个文件立刻追加）

---

## 进度

| 模块 | 状态 |
| --- | --- |
| wire.ts | 未开始 |
| library-contract.ts | 未开始 |
| client.ts | 未开始 |
| session.ts | 未开始 |
| types.ts | 未开始 |

### BeingDesktop/docs/town-sdk-integration.md（111 行，已读完）

协议层事实（迁移必须保真的部分）：

- SDK 无 npm 包，实现即 `src/town-client.cjs`。对齐上游 `ea56534f…`。
- **配对**：`POST /api/client/pair`（Being 侧生成一次性码）→ Desktop 匿名 `POST /api/client/pair/confirm` 兑换 client token。confirm 回包新版含 `town_id` / `display`，旧版含 `being_id`；**两者都要接受**。只有 confirm 成功才落盘，落盘失败时暂存 token 供“重试保存配对”（只重试写盘，不重新 confirm）。`400` = 码无效/过期/已用；`429` = 限流；网络不确定不自动重试。`t_` 开头的请求身份放 `town_id` 字段，否则放 `being_id`。
- **身份迁移**：Town 现用独立 `town_id`，`/api/bonfire/mentions` 与 SSE `hello` 已删除旧身份字段。首次遇到新格式必须 REST `town_id` 与 SSE `hello`（非匿名、`token_kind=client`）**两端一致**才把新编号附加到凭据。已保存编号不得被不同编号覆盖。缺少身份字段 = 响应格式错误，不等于需要重新配对。
- **直连替换范围**：`/api/bonfire/hear`、`/api/bonfire/speak`、`/api/fireside/list|members|hear|speak`、`/api/scrolls`、`/api/scrolls/:id`、`GET|POST /api/messages`。全部 client token。
- **`via` 字段**：`client:<name>` 界面标「借 <name>」，`being` 不标注。
- **发送回执校验**：`ok !== true`、`seq` 非法、身份不符 → `RESULT_UNKNOWN`（提示刷新核对，不当失败重发）。旧回执 `{seq, being, mentions, via}`，新回执用 `town_id`。
- **长度上限本地拦截（按码点计）**：篝火 4000、围炉 32000。指南称篝火超限静默截断、围炉超限 400。
- **错误码映射**：围炉非成员 `403` → `NOT_SENT`（读取路径的 `403` 才当作需要重新配对）；写请求网络异常 → `RESULT_UNKNOWN`（不是 `NOT_SENT`，请求可能已到达）。
- **未配对回退**：`speak` 未配对/token 被吊销（仅 `AUTH_REQUIRED`）回退 `BeingTownWriter` 中继；真实发送失败不回退。私信**无中继回退**，`reply_to` 只走直连。
- **私信**：`recipient` 必须是 Town 编号；发给自己 Town 会拒绝，本地先行拦截。重名拒绝回包候选取自 `recipient_warning.candidates`（旧为 `mention_warnings`）。
- **hear 分页（实测）**：不带 `since` = 最新 N 条；带 `since` = `seq > since` 的**最早** N 条；**没有 `before`**；响应带 `total_count`；序号稀疏（篝火 `global_latest_seq` 917 / `total_count` 861；围炉序号全局共享计数器）。`/api/bonfire/hear` 实测**需要 token**（匿名返回 401 `missing credentials`），与指南不一致。
- **传输约束**：主进程 fetch + Authorization 头（SSE 也用头，不用 query token）；固定 Town 来源、**禁止重定向**、**不发 cookie**。SSE hello 必须 `anonymous=false` + `token_kind=client` + 身份精确匹配，否则停止重连。
- 展示名：篝火 DTO 优先用服务端 `speaker_name`（坑 #11）；`beingId` 解析成员目录优先，目录解析不出时才采信 `being` 字段。
- 不在本单元：`town-refresh.cjs`（时间线累积/往上翻/补洞/1000 条内存上限/500 条缓存）、Being 中继读写。

### BeingDesktop/docs/interfaces.md §3.3 / §5 / §6.4（已读）

**§3.3 本单元相关接口签名**（构造参数只列注入项）：

- `TownClient({getContext, store, fetchImpl, onChange, onEvent})` → `pair({code})`、`retryPairStorage()`、`forget()`、`read(route, {query, signal})`、`identity({force})`、`speak({kind, message, firesideId, replyTo})`、`sendDirectMessage({recipient, content, replyTo})`、`lifecycle({enabled})`、`reset()`、`state()`
- `TownSession({getContext, writeImpl, getIdentity, fetchImpl, readImpl, onChange})` → `getMembers({force})`、`listScrolls`、`getScroll`、`listBeings`、`getBonfireMessages`、`getDirectMessages`、`getFiresides`、`getFiresideMembers`、`getFiresideMessages`、`sendBonfireMessage`、`getChannelStatus`、`beginChannelConnection`、`updateFeishuCredentials`、`memberDisplayName`、`memberCacheState()`、`invalidateMembers()`、`state()`、`reset()`；DTO 函数 `messagesDto`、`firesideMessagesDto`、`directMessagesDto`
- `TownClientStore({directory, safeStorage})` → `load/loadCredential(key, beingId)`、`save(key, beingId, token, townId)`、`bindTownId(...)`、`remove(key)`、`assertAvailable()`（**不在本单元**，但 TownClient 依赖其接口面）

**§5 错误码目录（本单元会用到的）**：
`INVALID_REQUEST`（参数/字段不合法）、`INVALID_RESPONSE`（上游格式不符，保留上次内容）、`NOT_CONNECTED`（未连接 Being）、`SESSION_CHANGED`（连接/身份/围炉在操作期间变化，结果丢弃）、`AUTH_REQUIRED`（无可用 client 凭据或读取权限未确认）、`IDENTITY_MISMATCH`、`BUSY`（正在配对）、`ABORTED`、`NETWORK_ERROR` / `RATE_LIMITED`（429） / `SERVICE_ERROR`（5xx）、`NOT_SENT`（明确未发送：校验失败、围炉 403、收件人无效）、`RESULT_UNKNOWN`（已提交结果未确认，**不要重发**）、`STORAGE_ERROR`、`PAIR_CODE_INVALID` / `PAIR_RESULT_UNKNOWN` / `PAIR_STORAGE_ERROR`、`TOWN_ERROR`（preload 兜底）。
> 经 Town 包络到渲染层保留原码，非白名单折叠为 `TOWN_ERROR`。

**§6.4 Town 外部协议表**（client token 走 `Authorization: Bearer`，不认查询参数；固定来源、**禁止重定向**、**不发 Cookie**、**响应 ≤1MB**）：

| 路由 | 关键点 |
| --- | --- |
| `POST /api/client/pair/confirm {being_id, code}` | → `{town_id \| being_id, token}`，新旧回包都接受 |
| `GET /api/client/stream` | SSE；首个 `hello` 必须 `token_kind=client`、`anonymous=false`、身份匹配 |
| `GET /api/bonfire/hear?since&limit&compact` | 无 since=最新 N；有 since=`seq > since` 最早 N；`limit` 1–200；响应含 `global_latest_seq`、`total_count` |
| `GET /api/bonfire/mentions?since_id` | 身份探测，`since_id` 固定为最大值 |
| `POST /api/bonfire/speak {message, reply_to?}` | 本地限 4000 码点；回执 `{ok, seq, mentions, via, town_id…}` |
| `GET /api/fireside/list` / `members?fireside_id` / `hear?fireside_id&since&limit` | 序号为所有围炉共用计数器 |
| `POST /api/fireside/speak {message, fireside_id, reply_to?}` | 本地限 32000；非成员 403 → `NOT_SENT` |
| `GET /api/scrolls?offset&limit&visibility`、`GET /api/scrolls/{id}?offset&limit` | DTO 校验分页一致性 |
| `GET /api/beings` | 公开居民目录，无凭据 |
| `GET /api/messages`、`POST /api/messages {recipient, content, reply_to?}` | 收件箱最新在前 ≤100；无中继回退 |
| `GET /api/channels/status`、`POST /api/channels/register`、`POST /api/channels/credentials` | 经 `TownSession`；QR 只接受白名单域名或内联图片 |
| `GET /api/grove?offset&limit`、`GET /api/grove/{id}` | 公开，`credentials:'omit'` |

### BeingDesktop/docs/architecture.md §5.3 / §6.3 / §7 / §8（已读）

- **§5.3 数据流**：`TownClient` 持 SSE → `onEvent(hello/bonfire/fireside/profile_changed/dm)` → main 合并为一次校准读 → `TownSession.getBonfireMessages({limit:50})` → `TownClient.read('/api/bonfire/hear', {limit, since?})` → `{messages, latest_seq, total_count}` → `pageDto` → TownRefresh `_merge`。`townSpeak` 先直连，只有 `AUTH_REQUIRED` 才回退 `BeingTownWriter`；私信无回退。只读缓存（卷轴/居民/Grove/围炉房间与成员）走 `TownCachedReads`→`TownDataCache`，成员 60 秒 TTL。
- **§7 安全边界（Town 部分，逐条保真）**：`credentials:'omit'`、`referrerPolicy:'no-referrer'`、**固定来源**、**禁止重定向**、**响应体 ≤1MB**、**DTO 严格校验**（`town-wire`、`town-library-contract`、`town-session`）。
- **§6.3 凭据**：连接地址只以 safeStorage 密文落盘；`isEncryptionAvailable()` 为假拒绝保存与配对（Linux basic_text 同样拒绝）。日志/诊断经 `sanitizeText`。
- **§8 并发约定（本单元相关）**：①纪元校验 `generation`/`identityRevision`/各子系统 `_epoch`，过期结果静默丢弃、过期写入抛 `SESSION_CHANGED`。③**不自动重发**：`202`/`RESULT_UNKNOWN`/网络中断保留待确认状态。④Town 每个 feed 单飞（`_flight`），60 秒最小间隔退避（最长 300 秒）。⑥定时器全部 `unref()`。

### 源码 src/town-wire.cjs（35 行，已读完）

导出面：`{validId, memberId, normalizeTownResponse, matchesTownIdentity}`（纯函数，无构造参数、无注入）。

- 内部 helper `record(value)` = `value !== null && typeof value === 'object' && !Array.isArray(value)`（**不导出**）。
- `validId(value)`：`typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)`（首字符必须字母数字，总长 ≤100）。
- `memberId(value)`：`record(value) && Object.hasOwn(value,'town_id') ? value.town_id : value?.being_id`。注意用 `Object.hasOwn`（不是真值判断），所以 `town_id: undefined` 也会返回 `undefined`。
- `author(value)`（内部）：非 record 原样返回；否则 `{...value, ...(hasOwn 'town_id' ? {being: town_id, being_id: town_id} : {}), ...(hasOwn 'reply_to_town_id' ? {reply_to_being: reply_to_town_id} : {})}`。
- `normalizeTownResponse(value, route, beingId)`：
  1. `route === '/api/fireside/members'` 且 `Array.isArray(value)` → `value.map(item => record(item) ? {...item, being_id: memberId(item)} : item)`（**先于 record 检查**，因为成员响应是数组）。
  2. 非 record → 原样返回。
  3. `result = {...value}`；若 `hasOwn 'town_id'` 且 route ∈ `['/api/bonfire/hear','/api/bonfire/mentions','/api/fireside/hear']` → `result.being = beingId`（注入调用方的 Loom beingId）。
  4. route ∈ `['/api/bonfire/hear','/api/fireside/hear']` 且 `Array.isArray(value.messages)` → `result.messages = value.messages.map(author)`。
  5. route === `'/api/messages'` 且 `Array.isArray(value.messages)` → 每条 record item 展开 `sender_town_id→sender`、`recipient_town_id→recipient`（均用 hasOwn）、`sender_display→sender_name`（用 `typeof === 'string'`，**不是 hasOwn**）。
- `matchesTownIdentity(value, {loomBeingId, townId}, legacy = 'being')`：
  - 非 record → `false`。
  - `hasOwn 'town_id'` → `validId(town_id) && !!townId && town_id === townId && (!hasOwn legacy || value[legacy] === loomBeingId || value[legacy] === townId)`。（**冲突的 legacy 字段不能被规范化掩盖**）
  - 否则 → `validId(value[legacy]) && (value[legacy] === loomBeingId || (!!townId && value[legacy] === townId))`。
  - 展示名永不参与身份判定。

移植注意：`Object.hasOwn` 的语义要保留；TS 下用 `Object.prototype.hasOwnProperty.call` 或 `Object.hasOwn`（ES2022 lib 已含）。

### 源码 src/town-library-contract.cjs（80 行，已读完）

导出面：`{scrollId, detailId, libraryRoute, libraryQuery, scrollListDto, scrollDto, beingsDto}`（纯函数）。依赖 `require('./town-wire.cjs').memberId`。

顶部注释：契约核对于 2026-09-07 的 `/api/scrolls/help`、`/api/beings/help` 与一次公开 `/api/scrolls/{id}` 响应；**绝不从 ID 推断人类身份**。

常量与内部 helper：
- `ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/`
- `RESERVED_SCROLL_IDS = new Set(['help','search','graph','match'])`
- `VISIBILITY = new Set(['private','shared','public'])`
- `record(value)`：**注意这里比 town-wire 更严** —— `value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype`（拒绝 null 原型、类实例、数组）
- `sequence(value)` = `Number.isSafeInteger(value) && value >= 0`
- `invalid(message)` = `Object.assign(new Error(message), {code:'INVALID_RESPONSE'})`
- `badRequest()` = `Object.assign(new Error('Town 阅读参数无效。'), {code:'INVALID_REQUEST'})`
- `display(value, limit)`：非字符串→`''`；否则剥离控制字符与双向覆写字符 `/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g` 再 `.slice(0, limit)`

函数：
- `scrollId(value)`：字符串 + `ID.test` + 不在 `RESERVED_SCROLL_IDS`。
- `detailId(route)`：非字符串或不以 `/api/scrolls/` 开头 → `null`；取后缀，`scrollId` 通过才返回 id，否则 `null`。
- `libraryRoute(route)`：`route === '/api/beings' || route === '/api/scrolls' || detailId(route) !== null`。
- `libraryQuery(route, value = {})`：
  - 非 library route 或非 record → `badRequest()`。
  - `allowed`：`/api/beings` → `[]`；`/api/scrolls` → `['offset','limit','visibility']`；详情 → `['offset','limit']`。
  - 用 `Object.getOwnPropertyDescriptors` + `Reflect.ownKeys` 检查：任一 key 非 string、不在 allowed、或描述符没有 `value`（即 getter/setter）→ `badRequest()`。**这是原型污染/取值副作用防护，必须保留。**
  - 逐项：`visibility` 必须在 `VISIBILITY`，原样放入；否则数字：字符串形如 `/^(0|[1-9]\d*)$/` 先 `Number()`；然后 `!sequence(number)` → bad；`limit` 且（`<1` 或 `> (route==='/api/scrolls' ? 200 : 10000)`）→ bad；`offset` 且 `> 4294967295` → bad。结果存 `String(number)`。
  - 返回值：**所有数字项都是字符串**。
- `summaryDto(value)`（**内部，不导出**）：`id = memberId(value)`；校验 `record(value) && scrollId(value.id) && typeof value.title==='string' && typeof id==='string' && ID.test(id) && VISIBILITY.has(value.visibility) && sequence(value.revision) && value.revision>=1`，否则 `invalid('卷轴文档格式发生变化，请刷新后重试。')`。
  返回 `{id, title: display(title,400), beingId: id, beingName: display(display_name,100) || id, visibility, kind: display(kind,30), lifecycle: display(lifecycle,30), tags: Array.isArray(tags) ? [...new Set(tags.filter(字符串).slice(0,50).map(t=>display(t,100)))] : [], createdAt: display(created_at,64), updatedAt: display(updated_at,64), revision}`。
  注意 tags 是**先 filter 再 slice(0,50) 再 map 再去重**。
- `scrollListDto(value, query = {})`：校验 `record && value.ok !== false && !hasOwn 'error' && Array.isArray(scrolls) && sequence(total) && sequence(offset) && sequence(limit) && limit>=1 && limit<=200 && scrolls.length<=limit && scrolls.length<=total && offset === Number(query.offset ?? 0) && limit === Number(query.limit ?? 50)`，否则 `invalid('卷轴列表格式发生变化，请刷新后重试。')`。
  然后 `scrolls.map(summaryDto)`；若 id 有重复，或 `scrolls.length !== Math.min(limit, Math.max(0, total - offset))` → `invalid('卷轴列表不完整，请刷新后重试。')`。
  返回 `{scrolls, total, offset, limit, hasMore: offset + value.scrolls.length < total}`。
- `scrollDto(value, id, query = {})`：先 `summaryDto(value)`；再校验 `scroll.id === id && value.ok !== false && !hasOwn 'error' && typeof content === 'string' && sequence(total_length) && sequence(offset) && sequence(limit) && limit>=1 && limit<=10000 && typeof has_more === 'boolean' && offset === Number(query.offset ?? 0) && limit === Number(query.limit ?? 10000)`，否则 `invalid('卷轴正文格式发生变化，请刷新后重试。')`。
  `length = [...value.content].length`（**按码点计**）；若 `length > limit || offset+length > total_length || has_more !== (offset+length < total_length) || (has_more && length !== limit)` → `invalid('卷轴正文不完整，请刷新后重试。')`。
  返回 `{scroll: {...scroll, content: display(content, 20000), totalLength, offset, limit, nextOffset: offset+length, hasMore: has_more}}`。
- `beingsDto(value)`：`list` 取 `Array.isArray(value) ? value : (record(value) && Array.isArray(value.beings) ? value.beings : null)`。
  若 `!list || list.length > 2000 || (record(value) && (ok===false || hasOwn 'error' || (has_more !== undefined && has_more !== false) || (hasMore !== undefined && hasMore !== false) || (total !== undefined && (!sequence(total) || total !== list.length)) || (offset !== undefined && offset !== 0)))` → `invalid('Town 居民目录不完整，请刷新后重试。')`。
  逐项：`id = memberId(item)`；`record(item) && typeof id==='string' && ID.test(id) && typeof display_name==='string' && !seen.has(id)`，否则 `invalid('Town 居民目录格式发生变化，请刷新后重试。')`。
  返回 `{id, name: display(display_name,100) || id, description: display(about,500), status: display(status,50), human: null}`（**`human` 恒为 null——不从 ID 推断人类身份**）。

### 源码 src/town-client.cjs（383 行，已读完）

导出面：`module.exports = {TownClient, consumeEvents}`。
顶部注释：`Public SDK protocol: jeremyliu16/beings-town-client-sdk @ ea56534, 2026-09-15.`

**依赖（移植时要处理的注入点）**：
- `require('./being-town-reader.cjs').validateTownToolResult` —— 中继模块，**不在本单元范围**，保留为注入实现 `validateResult`。
- `require('./town-library-contract.cjs').{libraryRoute, libraryQuery}` —— 本单元内。
- `require('../renderer/town-mentions.js').candidates` —— **renderer 层**，portal-desktop 的 main 不得 import renderer，需注入或搬到 shared（见下面的 town-mentions 摘要）。
- `require('./services.cjs').sanitizeText` —— 脱敏，注入。
- `require('./town-wire.cjs').{validId, normalizeTownResponse}` —— 本单元内。

**常量**：
- `ORIGIN = 'https://beings.town'`
- `MAX = 1024 * 1024`（1MB，同时用于 SSE 与 JSON 响应体上限）
- `IDENTITY_QUERY = {since_id: '9223372036854775807'}`
- `ROUTES`（Map，route → 允许的 query key）：`/api/bonfire/hear`→`['since','limit','compact']`；`/api/bonfire/mentions`→`['since_id']`；`/api/fireside/list`→`[]`；`/api/fireside/members`→`['fireside_id']`；`/api/fireside/hear`→`['fireside_id','since','limit','compact']`；`/api/messages`→`[]`
- `SPEAK_LIMIT = {bonfire: 4000, fireside: 32000}`
- `MESSAGES`（错误码 → 中文文案，逐字保留）：
  - `AUTH_REQUIRED: '请用 Being 提供的六位配对码连接 Town。'`
  - `IDENTITY_MISMATCH: 'Town 授权身份与当前 Being 不一致，请重新配对。'`
  - `NOT_CONNECTED: '请先连接 Being。'`
  - `SESSION_CHANGED: 'Being 连接已变化，旧 Town 请求已取消。'`
  - `INVALID_REQUEST: 'Town 请求参数无效。'`
  - `INVALID_RESPONSE: 'Town 返回格式无效，已保留上次同步内容。'`
  - `NETWORK_ERROR: 'Town 连接中断，请稍后重试。'`
  - `RATE_LIMITED: 'Town 请求过于频繁，请稍后重试。'`
  - `SERVICE_ERROR: 'Town 服务暂时不可用。'`
  - `ABORTED: 'Town 请求已取消。'`
  - `BUSY: 'Town 正在配对，请等待完成。'`
  - `NOT_SENT: '本次消息未发送。'`
  - `RESULT_UNKNOWN: '发送结果未确认，请刷新消息核对后再决定是否重发。'`
  - `STORAGE_ERROR: 'Town 身份对应关系未能保存，现有配对已保留，请重试。'`
  - `PAIR_CODE_INVALID: '配对码无效、已过期或已使用，请向 Being 获取新码。'`
  - `PAIR_RESULT_UNKNOWN: '配对请求的结果未确认，请先核对；不要重复提交同一码。'`
  - `PAIR_STORAGE_ERROR: '已取得 Town 授权，但未能保存到本机。请保持应用打开，点击「重试保存配对」。'`
- `fail(code)` = `Object.assign(new Error(MESSAGES[code] || MESSAGES.SERVICE_ERROR), {code})`；`failWith(code, message)` = 自定义文案。
- `Object.hasOwn(MESSAGES, error.code)` 是「已分类错误」判据，多处使用。

**`readQuery(route, query = {})`**（内部纯函数）：
- `libraryRoute(route)` 为真 → 直接 `libraryQuery(route, query)`。
- 否则：`!ROUTES.has(route) || !query || Object.getPrototypeOf(query) !== Object.prototype || Object.keys(query).some(k => !ROUTES.get(route).includes(k))` → `INVALID_REQUEST`。
- 逐项：`since_id` 必须 `=== IDENTITY_QUERY.since_id`；`compact` 必须 ∈ `[true, false, 'true', 'false']`；其余必须 `typeof ∈ ['string','number']`，字符串必须 `/^(0|[1-9]\d*)$/`，`Number.isSafeInteger(Number(value))`，`Number(value) >= (key === 'since' ? 0 : 1)`，`limit` 且 `Number(value) > 200` → bad。
- 收尾：`route === '/api/bonfire/mentions' && query.since_id !== IDENTITY_QUERY.since_id` 或 `route ∈ ['/api/fireside/hear','/api/fireside/members'] && !query.fireside_id` → bad。
- 返回 **原 query 对象**（非 library 路由不复制）。

**`consumeEvents(body, onEvent, onActivity = () => {})`**（导出）：SSE 解析。
- `!body` → `INVALID_RESPONSE`。
- `body.getReader()` + `new TextDecoder('utf-8', {fatal: true})`。
- 状态 `pending=''`, `type=''`, `data=[]`, `size=0`。
- `line(value)`：空行 → 若 `data.length` 则 `JSON.parse(data.join('\n'))`（parse 失败 → `INVALID_RESPONSE`），`await onEvent(type, parsed)`；随后重置 `type=''`, `data=[]`, `size=0`。
  否则 `size += value.length`，`size > MAX` → `INVALID_RESPONSE`；以 `:` 开头的注释行忽略；按第一个 `:` 切分 key/content，content 去掉一个前导空格；`key==='event'` → `type = content`；`key==='data'` → `data.push(content)`。
- 主循环：`reader.read()`，`done` 退出；每块 `onActivity()`；`decoder.decode(part.value, {stream:true})` 追加到 `pending`；用 `/\r\n|\r(?!$)|\n/` 反复切行（**`\r(?!$)` 保证结尾单独的 `\r` 留到下一块**）；`pending.length + size > MAX` → `INVALID_RESPONSE`。
- EOF 时未完成的事件被丢弃（重连后 REST 校准）。
- `finally { void reader.cancel().catch(() => {}); }`

**`class TownClient`**：
构造 `{getContext, store, fetchImpl = globalThis.fetch, onChange = () => {}, onEvent = () => {}, retryMs = 1000}`。
私有字段：`_epoch=0`、`_requests=new Set()`、`_token=null`、`_townId=''`、`_credentialLoading=null`、`_verification=null`、`_verified=''`、`_stream=null`、`_timer=null`、`_enabled=false`、`_pairing=false`、`_pairReceipt=null`。
`_state` 初值：`{status:'unpaired', paired:false, beingId:'', loomBeingId:'', townId:'', displayName:'', errorCode:'', authReason:'', pairingPending:false, pairErrorCode:''}`。

- `state()` → `{...this._state}`；`get pairing()` → `this._pairing`。
- `_set(value)`：所有 key 都未变则直接返回（不触发 onChange）；否则 `Object.assign` 后 `try { this.onChange(this.state()); } catch {}`。
- `_context(expected)`：`const c = this.getContext()`；`!c?.connected || !c.key || !validId(c.loomBeingId || c.beingId)` → `NOT_CONNECTED`。`next = {key, loomBeingId: c.loomBeingId || c.beingId, revision: c.revision, epoch: this._epoch}`；`expected` 存在且 `JSON.stringify` 不等 → `SESSION_CHANGED`。返回 `next`。
- `reset()`：`_epoch++`；`_enabled=false`；`clearTimeout(_timer)`；abort 全部 `_requests` 并清空；清 `_stream/_token/_townId/_credentialLoading/_verification/_verified/_pairReceipt`；`_set` 回初值。
- `_credential(ctx)`：无 token 时单飞加载（`_credentialLoading`）。优先 `store.loadCredential(ctx.key, ctx.loomBeingId)`，否则 `{token: await store.load(...)}`。加载出错先 `_context(ctx)`（纪元校验），若 `error.code === 'AUTH_REQUIRED'` 则 `_set({authReason: ['SECURE_STORAGE_UNAVAILABLE','CREDENTIAL_UNREADABLE'].includes(error.reason) ? error.reason : 'CREDENTIAL_UNREADABLE'})` 后抛出。成功后 `_context(ctx)`；`_token = saved?.token || null`；`_townId = saved?.townId || ''`；`typeof saved?.display === 'string'` → `_set({displayName: sanitizeText(saved.display).slice(0,100)})`。单飞 `finally` 清理只在同一个 pending 时清。
  无 token → `_set({authReason:'NO_SAVED_CREDENTIAL'})` + `AUTH_REQUIRED`。
  有 token → `_set({paired:true, beingId: ctx.loomBeingId, loomBeingId: ctx.loomBeingId, authReason:''})`，返回 token。
- `_identity(value, ctx, legacy)`：非对象/数组 → `INVALID_RESPONSE`。有 `town_id`：`!validId(town_id)` → `INVALID_RESPONSE`；`(this._townId && town_id !== this._townId) || (hasOwn legacy && value[legacy] !== ctx.loomBeingId)` → `IDENTITY_MISMATCH`；返回 `town_id`。无 `town_id`：`!validId(value[legacy])` → `INVALID_RESPONSE`；`value[legacy] !== ctx.loomBeingId` → `IDENTITY_MISMATCH`；返回 `''`。
- `_hello(value, ctx)`：`anonymous === true` → `AUTH_REQUIRED`；`anonymous !== false || token_kind !== 'client'` → `INVALID_RESPONSE`；否则 `_identity(value, ctx, 'being_id')`。
- `_probeHello(ctx, token, signal)`：单独一次 SSE 只为取 hello。`AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(signal?[signal]:[])])`。`fetch(new URL('/api/client/stream', ORIGIN).href, {headers:{Accept:'text/event-stream', Authorization:`Bearer ${token}`}, signal, credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', cache:'no-store'})`。`401/403` → 取消 body → `AUTH_REQUIRED`；`!ok || redirected || content-type 不含 text/event-stream` → `INVALID_RESPONSE`。`consumeEvents` 回调里 `type !== 'hello'` → `INVALID_RESPONSE`；拿到后 `throw complete`（Symbol 哨兵）。正常跑完 → `NETWORK_ERROR`。catch 里先 `_context(ctx)`，`error !== complete` → 已分类则原样抛，否则 `NETWORK_ERROR`；否则返回 identity。
- `_verifyIdentity(ctx, token, {signal, hello})`：单飞 `_verification`。
  1. `_json('/api/bonfire/mentions', {ctx, query: IDENTITY_QUERY, token, signal})` → `townId = _identity(identity, ctx, 'being')`。
  2. `townId && !this._townId`（首次迁移）：`streamed = hello ? this._hello(hello, ctx) : await this._probeHello(...)`；`streamed !== townId` → `IDENTITY_MISMATCH`；`_context(ctx)`；`await store.bindTownId?.(ctx.key, ctx.loomBeingId, token, townId, () => {纪元仍有效})`，出错时 `IDENTITY_MISMATCH`/`SESSION_CHANGED` 原样抛，其余 → `STORAGE_ERROR`；`_context(ctx)`；`this._townId = townId`。
  3. `_context(ctx)`；`_verified = ctx.key`。
  4. `displayName`：优先 `identity.display_name`（string → `sanitizeText().slice(0,100)`），否则 `identity.display`，否则沿用 `_state.displayName`。
  5. `renamed = this._state.townId === this._townId && this._state.displayName && displayName && this._state.displayName !== displayName`。
  6. `_set({loomBeingId, townId: this._townId, displayName})`；`renamed` → `try { onEvent({type:'profile_changed', townId}) } catch {}`（注释：改名通知不能使已验证身份失效）。
  单飞 await 后 `_context(ctx)`；若传了 `hello`，再 `_hello(hello, ctx)`，`id && id !== this._townId` → `IDENTITY_MISMATCH`。
- `_json(route, {ctx, query, token, body, signal, write=false})`：
  - `pairing = route === '/api/client/pair/confirm'`。
  - `AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...signal])`；URL query 用 `url.searchParams.set(k, String(v))`。
  - 已 aborted → `ABORTED`。
  - fetch：`method: body ? 'POST' : 'GET'`；headers `Accept: 'application/json'` + 有 token 加 Bearer + 有 body 加 `Content-Type: application/json`；`credentials:'omit'`、`redirect:'error'`、`referrerPolicy:'no-referrer'`、`cache:'no-store'`。
  - 状态码：`401` → `AUTH_REQUIRED`；`403` → write 时 `failWith('NOT_SENT','你不是该围炉的成员；本次消息未发送。')`，读时 `AUTH_REQUIRED`；`429` → `RATE_LIMITED`；`pairing && 400` → `PAIR_CODE_INVALID`；`rejected = write && status === 400`；`(!res.ok && !rejected) || res.redirected` → `SERVICE_ERROR`。
  - `content-type` 不含 `application/json` 或 `Number(content-length) > MAX` → `INVALID_RESPONSE`。
  - 流式读 body 累计长度，`> MAX` → `INVALID_RESPONSE`；`JSON.parse(Buffer.concat(chunks).toString('utf8'))`。
  - `rejected` 分支：`choices = candidates(value?.recipient_warning?.candidates || value?.candidates || value?.error?.candidates)`；`detail = sanitizeText(value.error 或 value.message 字符串).slice(0,500)`；抛 `failWith('NOT_SENT', choices.length ? '收件人有歧义；本次私信未发送，请选择 Town ID。' : 'Town 拒绝了本次发送参数；消息未发送。')` 并附 `{candidates: choices, ...(detail ? {detail} : {})}`。
  - `!value || typeof !== 'object' || value.ok === false || hasOwn 'error'` → `INVALID_RESPONSE`。
  - `finally { void res.body?.cancel().catch(()=>{}); }`（内层）。
  - catch：`_context(ctx)`；`signal?.aborted` → `ABORTED`；已分类 → 原样；`error instanceof SyntaxError` → `INVALID_RESPONSE` 否则 `NETWORK_ERROR`；最终 `fail(pairing && NETWORK_ERROR ? 'PAIR_RESULT_UNKNOWN' : write && NETWORK_ERROR ? 'RESULT_UNKNOWN' : code)`。
  - 外层 `finally { controller.abort(); this._requests.delete(controller); }`
- `pair(value)`：校验 `Object.getPrototypeOf(value) === Object.prototype`、只能有 `code` 键、`typeof code === 'string'`、`/^[A-Z0-9]{6}$/.test(code.toUpperCase())`，否则 `INVALID_REQUEST`。`_pairing` → `BUSY`。`_pairReceipt` 存在 → `PAIR_STORAGE_ERROR`。
  `ctx = this._context()`；`_set({pairErrorCode:''})`；`store.assertAvailable?.()`。
  `boundTownId = this._townId`；若为空且有 `store.loadCredential`，尝试读已保存 townId（`AUTH_REQUIRED` 以外的错误抛出；注释：重新配对可以修复读不了的旧文件），再 `_context(ctx)`。
  `identity = ctx.loomBeingId.startsWith('t_') ? {town_id: ctx.loomBeingId} : {being_id: ctx.loomBeingId}`。
  `data = await this._json('/api/client/pair/confirm', {ctx, body: {...identity, code: code.toUpperCase()}})`。
  校验：`typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token) || data.ok !== true` → `INVALID_RESPONSE`。
  `modern = hasOwn(data,'town_id')`；`modern && (!validId(town_id) || !town_id.startsWith('t_'))` → `INVALID_RESPONSE`。
  `(!modern || hasOwn(data,'being_id')) && data.being_id !== ctx.loomBeingId` → `IDENTITY_MISMATCH`。
  `modern && ((ctx.loomBeingId.startsWith('t_') && !data.town_id.startsWith(ctx.loomBeingId)) || (boundTownId && boundTownId !== data.town_id))` → `IDENTITY_MISMATCH`。
  `_pairReceipt = {ctx, token, townId: modern ? data.town_id : '', display: typeof data.display === 'string' ? sanitizeText(data.display).slice(0,100) : ''}`；`return await this._savePairReceipt()`。
  catch：若 `ctx` 已取得 → `_context(ctx)` + `_set({pairErrorCode: 已分类 ? error.code : 'STORAGE_ERROR'})`；重抛。`finally { this._pairing = false; }`
- `_savePairReceipt()`：无 receipt → `INVALID_REQUEST`。`_context(ctx)`。`store.save(key, loomBeingId, token, townId, display, () => 纪元仍有效)`。
  出错：`_context(ctx)` → `this.lifecycle({enabled:false})` → `_set({status:'pair_storage_error', pairingPending:true, errorCode:'PAIR_STORAGE_ERROR'})` → 抛 `PAIR_STORAGE_ERROR`（token 留在内存，只重试落盘）。
  成功：`_context(ctx)`；`this.reset()`；重新装回 `_token`/`_townId`；`_set({status:'connecting', paired:true, beingId, loomBeingId, townId, displayName: display, errorCode:''})`；`lifecycle({enabled:true})`；返回 `state()`。
  > 注意 `reset()` 会 `_epoch++`，所以 receipt 里的 ctx 在此之后已失效——这是**故意的顺序**。
- `retryPairStorage()`：`_pairing` → `BUSY`；置 `_pairing=true`，`_savePairReceipt()`，`finally` 复位。
- `forget()`：`_pairing` → `BUSY`；`ctx = _context()`；`reset()`；`await store.remove(ctx.key)`；返回 `state()`。
- `read(route, {query = {}, signal} = {})`：`query = readQuery(route, query)`；hear 路由补 `{compact:false, ...query}`；`ctx = _context()`；`token = await _credential(ctx)`；`_verified !== ctx.key` → `_verifyIdentity`；`value = await _json(route, {ctx, query, token, signal})`；`_context(ctx)`；若 `hasOwn(value,'town_id')`：`id = _identity(value, ctx, 'being')`，`!this._townId || id !== this._townId` → `IDENTITY_MISMATCH`。返回 `validateTownToolResult(normalizeTownResponse(value, route, ctx.loomBeingId), route, ctx.loomBeingId, query)`。
- `identity({signal, force = false} = {})`：`ctx`+`token`；`force || _verified !== ctx.key` → `_verifyIdentity`；`_context(ctx)`；返回 `{loomBeingId, townId: this._townId, displayName: this._state.displayName}`。
- `speak(value)`：键白名单 `['kind','message','firesideId','replyTo','signal']`，原型必须是 `Object.prototype`，否则 `INVALID_REQUEST`。
  `kind ∉ ['bonfire','fireside']` → `INVALID_REQUEST`。
  `typeof message !== 'string' || !message.trim() || message.includes('\0')` → `NOT_SENT` `'请输入要发送的内容；本次消息未发送。'`。
  `[...message].length > SPEAK_LIMIT[kind]` → `NOT_SENT` `` `消息超过 ${SPEAK_LIMIT[kind]} 字上限；本次消息未发送。` ``（按码点计）。
  `kind==='fireside'` 且 `!/^[1-9]\d{0,15}$/.test(String(firesideId)) || !Number.isSafeInteger(Number(firesideId))` → `NOT_SENT` `'围炉无效；本次消息未发送。'`。
  `replyTo !== ''` 且同样的数字校验失败 → `NOT_SENT` `'被回复的消息无效；本次消息未发送。'`。
  body：`{message, ...(fireside ? {fireside_id: Number(firesideId)} : {}), ...(replyTo !== '' ? {reply_to: Number(replyTo)} : {})}`，`_json('/api/${kind}/speak', {..., write: true})`。
  回执校验：`try { id = _identity(result, ctx, 'being'); if (id && id !== this._townId) throw IDENTITY_MISMATCH } catch { throw fail('RESULT_UNKNOWN') }`（**任何身份校验异常都折叠为 `RESULT_UNKNOWN`**）。
  `result.ok !== true || !Number.isSafeInteger(result.seq) || result.seq < 1` → `RESULT_UNKNOWN`。
  `mentions`：数组 → `filter(string).slice(0,20).map(n => n.slice(0,100))`，否则 `[]`。
  返回 `{ok:true, id: String(result.seq), seq: result.seq, mentions, ...(hasOwn(result,'mention_warnings') ? {mention_warnings: result.mention_warnings} : {}), via: typeof result.via === 'string' ? result.via.slice(0,120) : ''}`。
- `sendDirectMessage(value)`：键白名单 `['recipient','content','replyTo','signal']`。
  `recipient` 非字符串/空白/长度 >100/含 `\0` → `NOT_SENT` `'请填写有效的收件人；本次私信未发送。'`。
  `content` 非字符串/空白/含 `\0` → `NOT_SENT` `'请输入要发送的内容；本次私信未发送。'`。
  `[...content].length > SPEAK_LIMIT.fireside`（32000）→ `NOT_SENT` `` `私信超过 ${SPEAK_LIMIT.fireside} 字上限；本次私信未发送。` ``。
  `replyTo !== ''` 且（非字符串/空白/长度 >200）→ `NOT_SENT` `'被回复的私信无效；本次私信未发送。'`。
  `ctx = _context()`；`recipient.trim() === ctx.loomBeingId` → `NOT_SENT` `'Town 不允许给自己发私信；本次私信未发送。'`。
  `token`+（必要时）`_verifyIdentity`，**之后**再检查 `recipient.trim() === this._townId` → 同一条自发私信文案。
  body `{recipient: recipient.trim(), content, ...(replyTo !== '' ? {reply_to: replyTo} : {})}`（**reply_to 是字符串，不转数字**）。
  `result.ok !== true || typeof result.message_id !== 'string' || !result.message_id` → `RESULT_UNKNOWN`。
  `resolvedRecipient = result.recipient_town_id ?? result.recipient`。
  返回 `{ok:true, id: message_id.slice(0,200), recipient: 字符串 ? slice(0,100) : '', via: 字符串 ? slice(0,120) : ''}`。
- `lifecycle({enabled})`：关闭 → `_enabled=false`、清 timer、abort 全部请求、`_stream=null`、`_verified=''`；若 status ∈ `['connected','connecting','reconnecting']` → `_set({status:'paused'})`。
  开启 → `_enabled=true`；`!this._stream && !this._timer && !this._pairReceipt && !['auth_required','identity_mismatch'].includes(status)` → `void this._connect()`。
- `_connect()`：`ctx = _context()` 失败直接 return。controller 入 `_requests` 并记为 `_stream`。
  `token = await _credential(ctx)`；若已 abort return；`_set({status:'connecting', errorCode:''})`；`timer = setTimeout(abort, 20000)`。
  fetch `/api/client/stream`（同 `_probeHello` 的头与选项，但 `signal: controller.signal`）。
  `401/403` → `AUTH_REQUIRED`；`!ok || redirected || content-type 不含 text/event-stream` → `SERVICE_ERROR`。
  `consumeEvents` 回调：
  - `type==='hello'`：已收过 hello → `INVALID_RESPONSE`；`townId = _hello(data, ctx)`；`townId && !this._townId` → `await _verifyIdentity(ctx, token, {signal: controller.signal, hello: data})`；`_context(ctx)`+abort 检查；`hello=true`；`this.retryMs = 1000`；重置看门狗为 **90000ms**；`_verified = ctx.key`；`_set({status:'connected', loomBeingId, townId, errorCode:''})`；`onEvent({type:'hello'})`。
  - `type ∈ ['bonfire','fireside','dm']`：`!hello || 非对象 || 数组` → `INVALID_RESPONSE`；`onEvent({type, ...(type==='fireside' ? {firesideId: String(data.fireside_id || '')} : {})})`（**载荷只是失效提示，不进状态**）。
  - `type==='error'` → `SERVICE_ERROR`。
  - `onActivity`：`hello` 之后每次数据到达重置 90 秒看门狗。
  正常跑完 → `NETWORK_ERROR`。
  catch：`ctx.epoch !== this._epoch || !this._enabled || this._stream !== controller` → 直接 return（迟到结果丢弃）。`code = 已分类 ? error.code : 'NETWORK_ERROR'`；`_verified=''`；`blocked = code ∈ ['AUTH_REQUIRED','IDENTITY_MISMATCH']`；`_set({status: AUTH_REQUIRED?'auth_required':IDENTITY_MISMATCH?'identity_mismatch':'reconnecting', errorCode: code})`；非 blocked → `_timer = setTimeout(重连, this.retryMs)`，`this.retryMs = Math.min(retryMs*2, 30000)`，`this._timer.unref?.()`。
  `finally`：清 timer、abort controller、从 `_requests` 删除、`_stream === controller` 时清空。

**状态机 status 取值**：`unpaired` / `connecting` / `connected` / `reconnecting` / `paused` / `auth_required` / `identity_mismatch` / `pair_storage_error`。
**authReason 取值**：`''` / `NO_SAVED_CREDENTIAL` / `SECURE_STORAGE_UNAVAILABLE` / `CREDENTIAL_UNREADABLE`。

### 依赖摘要：candidates / sanitizeText / portal-desktop 既有 town/client.ts（已读）

**`candidates(value)`**（BeingDesktop `renderer/town-mentions.js:8-12`，本单元要在 main 层自带一份，因为 portal-desktop 禁止 main import renderer）：
```
clean(value, limit=100) = 字符串 ? value.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g,'').slice(0,limit) : ''
validId(value) = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
candidates(value):
  seen = new Set()
  (Array.isArray(value) ? value : []).slice(0,100)
    .filter(item => validId(item?.town_id) && !seen.has(item.town_id) && seen.add(item.town_id))
    .map(item => ({town_id: item.town_id, display_name: clean(item.display_name) || item.town_id}))
```
（`seen.add` 返回 Set 是真值，所以 filter 通过——这是原文写法，保留。）

**`sanitizeText(value, secrets = [])`**（BeingDesktop `src/services.cjs:12-36`）：注入项，本单元用注入的 `sanitize`。行为：去 ANSI 转义 → 逐个 secret（长度 ≥4）替换为 `[redacted]` → URL 去 username/password/search/hash（解析失败 → `[redacted URL]`）→ `Cookie/Set-Cookie/Authorization/Proxy-Authorization` 头行 → `[redacted header]` → `Bearer xxx` → `Bearer [redacted]` → `token/secret/password/credential/api_key/key/authorization/cookie` 形式的赋值 → `$1[redacted]` → `sk-*` → `[redacted]` → JWT `eyJ…` → `[redacted]` → `\b[a-f0-9]{32,}\b` → `[redacted]` → `\b[a-zA-Z0-9_+/=-]{48,}\b` → `[redacted]` → 去控制字符 → `.slice(0, 2000)`。

**portal-desktop 既有 `desktop/main/town/client.ts`（213 行）——与本单元的重叠分析**（写进 client.ts 顶部注释）：

重叠的能力：
- `TOWN_ORIGIN = 'https://beings.town'` 固定来源；`credentials:'omit'`、`redirect:'error'`、`AbortSignal.timeout(20000)`。
- 配对 `POST /api/client/pair/confirm`，`t_` 前缀走 `town_id` 字段否则 `being_id`；`data.ok !== true` 拒绝；`town_id` 必须 `t_` 前缀；`429` 有专门文案。
- 发言长度上限 bonfire 4000 / fireside 32000 按码点计；`reply_to`；私信不能发给自己；发送未确认返回「消息可能已送达，请刷新核对」。
- `readTownJson` 检查 `content-type` 含 `application/json` 并流式读取。

portal-desktop **没有**的能力（本单元补齐）：
- **DTO 严格校验**（`town-wire` / `town-library-contract` / `town-session` 的 `messagesDto` 等）；portal-desktop 直接把 `data` 原样返回给渲染层。
- **hear 的 `limit`/`since` 分页**：portal-desktop 把 `limit` 写死在路由里（bonfire 100 / fireside 50），没有 `since`、没有 `total_count`/`global_latest_seq` 语义。
- **错误码映射**：portal-desktop 用 `{ok:false, code:'auth'|'forbidden'|'not-found'|'http'|'network'}`，本单元用 `error.code` 错误码目录（`AUTH_REQUIRED`/`NOT_SENT`/`RESULT_UNKNOWN`/`RATE_LIMITED`/`IDENTITY_MISMATCH`/`PAIR_*` 等）。
- **`AUTH_REQUIRED` 判定**：本单元把读路径的 `403` 也当作 `AUTH_REQUIRED`，写路径的 `403` 当 `NOT_SENT`；portal-desktop 一律 `forbidden`。
- **响应体上限 1MB**（portal-desktop 是 4MB）、**`referrerPolicy:'no-referrer'`**、**`cache:'no-store'`**（portal-desktop 都没有）。
- **SSE 客户端流**（`/api/client/stream` + `consumeEvents` + hello 校验 + 90 秒看门狗 + 指数退避重连）；portal-desktop 的 `live.ts` 是另一套。
- **身份纪元校验**（`_context`/`_epoch`/`SESSION_CHANGED`）与**单飞**（`_credentialLoading`/`_verification`）。
- **Town ID 首次迁移绑定**（REST + SSE 两端一致才 `bindTownId`）。
- **配对落盘失败后的 `_pairReceipt` 暂存 + `retryPairStorage()`**。
- **`mentions` 回执与 `recipient_warning.candidates` 歧义收件人**处理。

### 源码 src/town-session.cjs（527 行，已读完）

导出面：`module.exports = {TownSession, TOWN_AUTH_DETAIL, messagesDto, firesideMessagesDto, directMessagesDto}`。
顶部注释：`Contracts: https://beings.town/api/{bonfire,fireside,beings,scrolls,channels}/help (2026-09-07). Production protected reads use the Town client SDK. A Loom token is never a Town credential.`

**依赖**：`town-library-contract.cjs` 的 `{scrollId, libraryRoute, scrollListDto, scrollDto, beingsDto}`；`town-result-source.cjs` 的 `{relaySource}`（中继来源标注，**范围外**，注入）；`town-wire.cjs` 的 `{memberId, matchesTownIdentity, normalizeTownResponse}`。

**常量**：
- `TOWN_ORIGIN = 'https://beings.town'`
- `TOWN_AUTH_DETAIL = 'Town 拒绝了本机的 GET 读取请求（401/403），当前连接没有消息读取权限。'`（**导出**）
- `MAX_RESPONSE_BYTES = 1024 * 1024`；`MAX_QR_BYTES = 256 * 1024`
- `ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/`
- `ROUTES = new Set(['/api', '/api/bonfire/mentions', '/api/bonfire/hear', '/api/bonfire/speak', '/api/fireside/list', '/api/fireside/members', '/api/fireside/hear', '/api/channels/status', '/api/channels/register', '/api/channels/credentials'])`
  > 注意：**`/api/messages` 不在 ROUTES 里**，但 `getDirectMessages` 调用 `request('/api/messages')`——所以私信只能走 `readImpl`（注入的 TownClient 读取）；直连 `_request('/api/messages')` 会抛 `INVALID_REQUEST`。这是有意的（私信无中继回退，读取必须走 client token）。

**内部 helper**：
- `failure(code, message)` = `new Error(message)` + `.code = code`。
- `record(value)` = 非 null 对象且非数组（**比 library-contract 宽**，允许类实例）。
- `text(value, limit = 2000)`：非字符串→`''`；先 `slice(0, limit*2)` 再剥控制字符 `/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g` 再 `slice(0, limit)`。
- `sequence(value)` = `Number.isSafeInteger && >= 0`；`validId(value)` = 字符串 + `ID.test`。
- `firesideId(value)`：字符串形如 `/^[1-9][0-9]{0,15}$/` 转数字；`!Number.isSafeInteger(n) || n < 1` → `INVALID_REQUEST` `'请选择有效的围炉。'`；返回数字。
- `checkAborted(signal)`：`signal?.aborted` → `ABORTED` `'读取已取消。'`。
- `plainRequest(value, allowed, required = allowed)`：非 record 或原型非 `Object.prototype` → `INVALID_REQUEST` `'请求格式无效。'`；用 `getOwnPropertyDescriptors` + `Reflect.ownKeys` 检查：key 非 string、不在 allowed、描述符无 `value`（getter）→ 抛；`required.some(key => !hasOwn(descriptors, key))` → 抛。返回原对象。
- `imageData(bytes, mime)`：非 Buffer/空/`> MAX_QR_BYTES` → `''`；魔数校验：PNG `[137,80,78,71,13,10,26,10]`；JPEG `bytes[0]===255 && bytes[1]===216 && bytes[2]===255`；WEBP `ascii(0,4)==='RIFF' && ascii(8,12)==='WEBP'`；通过 → `data:${mime};base64,${base64}`，否则 `''`。
- `inlineQr(value)`：非字符串或 `length > MAX_QR_BYTES * 1.4` → `''`；`/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/`；`match[2].length % 4` → `''`；再 base64 往返一致才 `imageData`。
- `viaField(item)` = `{via}`（`text(item.via, 120)` 非空时）否则 `{}`。
- `replyField(item)` = `sequence(item.reply_to)` ? `{replyTo: {id: String(item.reply_to), beingId: validId(item.reply_to_being) ? item.reply_to_being : '', preview: text(item.reply_to_preview, 200)}}` : `{}`。

**DTO 函数**：
- `membersDto(value)`（内部）：`!record(value) || !Array.isArray(value.community)` → `INVALID_RESPONSE` `'Town 成员目录格式发生变化，请稍后重试。'`。`community.slice(0,2000)` → filter（record + `validId(memberId(member))` + 去重）→ map `{id: memberId(m), name: text(display_name,100) || memberId(m), description: text(about,500)}`。
- `messagesDto(value, members = [])`（**导出**）：`!record(value) || value.ok !== true || !Array.isArray(value.messages) || !sequence(value.global_latest_seq)` → `INVALID_RESPONSE` `'篝火消息格式发生变化，请稍后重试。'`。
  `messages.slice(0,200)` → filter（record + `sequence(item.seq)` + `typeof item.message === 'string'` + `typeof item.being === 'string'` + seq 去重）→ map：
  `byId = members.find(m => m.id === item.being)`；
  `beingId = validId(item.town_id) ? item.town_id : validId(item.being_id) ? item.being_id : byId?.id || (/^t_/.test(item.being) && validId(item.being) ? item.being : '')`（**成员目录优先，最后才采信 `being` 字段，且只接受 `t_` 前缀**）；
  返回 `{id: String(seq), beingId, ...(validId(town_id) ? {townId: town_id} : {}), ...(!beingId ? {authorUnknown: true} : {}), beingName: text(speaker_name,100) || text(being,100), content: text(message,4000), createdAt: text(at,64), revisedAt: text(revised_at,64), mentions: [], ...viaField, ...replyField}`。
  然后 `.sort((l, r) => Number(l.id) - Number(r.id))`（**升序**）。
  返回 `{messages, latestSeq: value.global_latest_seq, ...(sequence(value.total_count) ? {total: value.total_count} : {}), ...relaySource(value)}`。
- `directMessagesDto(value)`（**导出**）：`!record(value) || !Array.isArray(value.messages)` → `INVALID_RESPONSE` `'私信格式发生变化，请稍后重试。'`。
  `messages.slice(0,100)`（**收件箱最新在前，顺序保留，不排序**）→ filter（record + `typeof id === 'string' && id` + `typeof content === 'string'` + id 去重）→ map：
  `senderId = validId(item.sender) ? item.sender : validId(item.sender_being_id) ? item.sender_being_id : ''`；
  `reply = typeof item.reply_to === 'string' && item.reply_to ? {replyTo: {id: text(reply_to,200), beingId: validId(reply_to_sender) ? reply_to_sender : '', preview: text(reply_to_preview,200)}} : {}`；
  `{id: text(id,200), senderId, senderName: text(sender_name,100) || senderId || '未知', content: text(content,32000), createdAt: text(created_at,64) || text(at,64), ...viaField, ...reply}`。
  返回 `{messages}`。
- `firesidesDto(value)`（内部）：`!record(value) || !Array.isArray(value.owned) || !Array.isArray(value.joined)` → `INVALID_RESPONSE` `'围炉列表格式发生变化，请稍后重试。'`。
  `rooms(entries)`：`slice(0,2000)` → filter（record + `Number.isSafeInteger(room.id) && room.id > 0` + `typeof room.name === 'string'` + id 去重，**owned/joined 共用同一个 seen**）→ map `{id, name: text(name,200), ...(sequence(member_count) ? {member_count} : {})}`。
  返回 `{owned: rooms(value.owned), joined: rooms(value.joined)}`。注释：owned 圈可能含私密邀请 key，只有展示字段离开 main。
- `firesideMembersDto(value)`（内部）：`!Array.isArray(value)` → `INVALID_RESPONSE` `'围炉成员格式发生变化，请稍后重试。'`。`slice(0,2000)` → filter（record + `validId(member.being_id)` + 去重）→ map `{being_id, display_name: text(display_name,100) || being_id, joined_at: text(joined_at,64)}`。返回 `{members}`。
- `firesideMessagesDto(value, expected)`（**导出**）：
  `!record(value) || value.being !== expected.beingId` → `IDENTITY_MISMATCH` `'Town 授权身份与当前 Being 不一致，请检查连接。'`（**先查身份**）。
  `!Array.isArray(value.messages) || !sequence(value.latest_seq) || value.messages.some(item => record(item) && item.truncated === true)` → `INVALID_RESPONSE` `'围炉消息格式发生变化，请稍后重试。'`。
  `slice(0,200)` → filter（record + `sequence(seq)` + `validId(item.being)` + `typeof message === 'string'` + seq 去重）→ map `{id: String(seq), beingId: item.being, beingName: text(speaker_name,100) || item.being, content: text(message,32000), createdAt: text(at,64), revisedAt: text(revised_at,64), mentions: Array.isArray(item.mentions) ? [...new Set(item.mentions.filter(validId))].slice(0,20) : [], ...viaField, ...replyField}` → 升序排序。
  返回 `{messages, latestSeq: value.latest_seq, ...(sequence(value.total_count) ? {total: value.total_count} : {})}`。
- `channelDto(value, channel)`（内部）：`source = record(value) ? value : {}`。
  `known = new Set(['connected','disconnected','pending','registered','disabled','waiting','expired','error'])`；
  `status = known.has(source.status) ? source.status : source.ready === true ? 'connected' : source.ready === false ? 'registered' : 'unknown'`。
  `result = {channel, status, detail: status === 'unknown' ? '渠道状态尚未确认，请刷新后查看。' : ''}`。
  `app_id` 匹配 `/^cli_[A-Za-z0-9_-]{1,120}$/` → `result.appId`。
  QR 取 `source.qr_code_url || source.qrcode_url || source.qr_url || source.qrcode || source.qr_code`；`inlineQr(qr)` 非空 → `result.qrCodeDataUrl`。
  若 `typeof qr === 'string' && qr.length <= 4096`：`new URL(qr)`，要求 `protocol === 'https:'`、无 username/password、`!port || port === '443'`、hostname ∈ `['beings.town','weixin.qq.com','wx.qq.com','open.weixin.qq.com']` → `result.qrCodeUrl = url.href`；解析异常吞掉。

**`class TownSession`**：
构造 `{getContext, fetchImpl = globalThis.fetch, readImpl = null, writeImpl = null, getIdentity = null, onChange = () => {}, now = Date.now, membersTtlMs = 60000} = {}`。
`typeof getContext !== 'function' || typeof fetchImpl !== 'function' || (readImpl !== null && typeof readImpl !== 'function')` → `new Error('Town 会话配置无效。')`（**普通 Error，无 code**）。
字段：`_membersRevision=0`、`_membersExpiresAt=0`、`_epoch=0`、`_requests=new Set()`、`_mutations=new Set()`、`_members=null`；构造里又 `_membersExpiresAt = 0; _membersRevision++`（→ 构造后 `_membersRevision === 1`）。
`_state` 五个区：`bonfire / fireside / channel / scroll / beings`，各 `{status:'unknown', detail:''}`。
> 注意 `_read` 还会用到 `'inbox'` 区（`getDirectMessages`），但 `_state` 初值里**没有** `inbox` —— `_set('inbox', …)` 会新增该键。这是原行为，保留。

- `state()` → 深拷贝一层：`Object.fromEntries(Object.entries(this._state).map(([area, s]) => [area, {...s}]))`。
- `reset()`：`_epoch++`；abort 并清空 `_requests`；清空 `_mutations`；`_members=null`；`_membersExpiresAt=0`；`_membersRevision++`；`_state` 回五区初值（**丢掉 inbox 键**）。
- `_set(area, status, detail = '')`：写 `_state[area] = {status, detail}`；`try { onChange(state()) } catch {}`。
- `_context(expected, connectionRevision)`：`current = getContext()`；`loomBeingId = current.loomBeingId || current.beingId || current.beingName`；`beingId = loomBeingId`。
  `!current.configured || !current.connected || current.exiting || !validId(beingId) || !sequence(current.connectionId)` → `NOT_CONNECTED` `'请先连接 Being 并等待会话加载完成。'`。
  `identity = {beingId, loomBeingId, connectionId, identityRevision, epoch: this._epoch}`。
  `(expected && Object.keys(identity).some(k => identity[k] !== expected[k])) || (connectionRevision !== undefined && current.connectionId !== connectionRevision)` → `SESSION_CHANGED` `'连接身份已变化，请在当前 Being 下重新操作。'`。
- `_request(route, {query, body, expected, mutation = false, signal})`：
  `!ROUTES.has(route) && !libraryRoute(route)` → `INVALID_REQUEST` `'不支持此 Town 操作。'`。
  `expected` → `_context(expected)`；`checkAborted(signal)`。
  URL `new URL(route, TOWN_ORIGIN)` + `searchParams.set(k, String(v))`。
  controller 入 `_requests`，把外部 signal 的 abort 转发。
  fetch：`method: body === undefined ? 'GET' : 'POST'`；headers `Accept: 'application/json'`（+ POST 的 `Content-Type`）；`credentials:'omit'`、`redirect:'error'`、`cache:'no-store'`。**注意：没有 Authorization 头**（这条直连路径靠 IP Trust / 公开端点；带凭据的读走 `readImpl`）。**也没有 `referrerPolicy`**。
  `401|403` → `AUTH_REQUIRED` `TOWN_AUTH_DETAIL`；`429` → `RATE_LIMITED` `'Town 请求过于频繁，请稍后重试。'`；`!ok` → `mutation ? RESULT_UNKNOWN '操作未获确认，请先刷新状态；不要重复提交。' : SERVICE_ERROR 'Town 暂时不可用，请稍后重试。'`。
  `content-type` 小写不含 `application/json` → `mutation ? RESULT_UNKNOWN : INVALID_RESPONSE`，文案 `'Town 返回了无法识别的结果，请先刷新状态。'`。
  `Number(content-length) > MAX_RESPONSE_BYTES` → `INVALID_RESPONSE` `'Town 返回的数据过大。'`。
  无 reader → `INVALID_RESPONSE` `'Town 返回的数据不完整。'`；流式累计 `> MAX` → `INVALID_RESPONSE` `'Town 返回的数据过大。'`。
  `JSON.parse` 失败 → `mutation ? RESULT_UNKNOWN : INVALID_RESPONSE` `'Town 返回了无法识别的结果，请先刷新状态。'`。
  `(!record(value) && !(['/api/fireside/members','/api/beings'].includes(route) && Array.isArray(value))) || value.ok === false || hasOwn(value,'error')` → `mutation ? RESULT_UNKNOWN '操作未获确认，请先刷新状态；不要重复提交。' : SERVICE_ERROR 'Town 暂时无法完成此操作。'`。
  catch：`_context(expected)` + `checkAborted(signal)`；已分类码 ∈ `['AUTH_REQUIRED','RATE_LIMITED','RESULT_UNKNOWN','SERVICE_ERROR','INVALID_RESPONSE','SESSION_CHANGED','NOT_CONNECTED']` → 原样抛；否则 `mutation ? RESULT_UNKNOWN '连接中断，操作结果未知，请先刷新状态；不要重复提交。' : NETWORK_ERROR '无法连接 Town，请检查网络后重试。'`。
- `_authorized(area, expected, {signal})`：`_request('/api/bonfire/mentions', {expected, signal, query: {since_id: '9223372036854775807'}})` → `verified = await _townIdentity(expected, signal)` → `!matchesTownIdentity(identity, verified)` → `IDENTITY_MISMATCH` `'Town 授权身份与当前 Being 不一致，请检查连接。'`；然后 `_context` + `checkAborted` + `_set(area, 'ready')`。
  catch：`_context(expected)`；`ABORTED` 原样抛；否则 `_set(area, code === 'AUTH_REQUIRED' ? 'auth_required' : 'error', error.message)` 再抛。
- `_townIdentity(expected, signal)`：`townId = getContext().townId || ''`；为空且有 `getIdentity` → `await getIdentity({signal})`，`_context(expected)`，`townId = identity.townId || ''`；`error.code !== 'AUTH_REQUIRED'` 才抛。最后 `_context(expected)`，返回 `{loomBeingId: expected.loomBeingId, townId}`。
- `memberCacheState()` → `{revision: this._membersRevision, expiresAt: this._membersExpiresAt}`。
- `memberDisplayName(townId)` → `this.now() < this._membersExpiresAt ? this._members?.get(townId)?.name || '' : ''`。
- `invalidateMembers()`：清缓存、`_membersRevision++`、`try { onChange(state()) } catch {}`，返回 `memberCacheState()`。
- `getMembers({signal, force = false} = {})`：`checkAborted`；未 force 且缓存未过期 → `{members: [...this._members.values()], source: 'public'}`。
  记 `epoch`+`revision`；`value = await _request('/api', {signal})`（**注意没传 expected**）；若 epoch 或 revision 变了 → `SESSION_CHANGED` `'成员目录已失效，请重新读取。'`；`members = membersDto(value)`；缓存 Map + `_membersExpiresAt = now() + membersTtlMs`；返回 `{members, source: 'public'}`。
- `listScrolls(value = {}, {signal})`：`plainRequest(value, ['offset','limit','visibility'], [])`；`offset` 非 sequence 或 `> 4294967295`、`limit` 非 sequence 或 `<1`/`>200`、`visibility` 不在三值内 → `INVALID_REQUEST` `'卷轴列表分页参数无效。'`。`query = {offset: offset ?? 0, limit: limit ?? 50, ...(visibility === undefined ? {} : {visibility})}`。`_read('scroll', expected, request => scrollListDto(await request('/api/scrolls', {query}), query))`。
- `getScroll(value, {signal})`：`plainRequest(value, ['id','offset','limit'], ['id'])`；`!scrollId(id)`、offset/limit 越界（limit `<1`/`>10000`）→ `INVALID_REQUEST` `'请选择有效的卷轴和正文页码。'`。`query = {offset: offset ?? 0, limit: limit ?? 10000}`。`scrollDto(await request(`/api/scrolls/${id}`, {query}), id, query)`。
- `listBeings(value = {}, {signal})`：`plainRequest(value, [], [])`。自带 `unchanged()` 检查（比较 `epoch` 与 `['connectionId','identityRevision','beingId','beingName']` 四个字段）→ `SESSION_CHANGED` `'连接身份已变化，请重新读取居民目录。'`。
  `detail = '人类伙伴信息暂未公开。'`；`unchanged()` → `_request('/api', {signal})` → `unchanged()` + `checkAborted` → `beings = beingsDto({beings: value.community})` → `_set('beings','ready')` → 返回 `{beings, source: 'public', detail: 'Town 公开居民目录。人类伙伴信息暂未公开。'}`。
  catch：`unchanged()`；非 `ABORTED` → `_set('beings','error', error.message)`；抛。
  > **`listBeings` 不走 `_read`，也不做 `_authorized`**。
- `getBonfireMessages(value = {}, {signal})`：`plainRequest(value, ['since','limit'], [])`；`since` 非 sequence 或 `limit` 非整数/`<1`/`>200` → `INVALID_REQUEST` `'篝火消息分页参数无效。'`。
  `_read('bonfire', expected, async request => { const [response, members] = await Promise.all([request('/api/bonfire/hear', {query: {limit: value.limit || 10, ...(since === undefined ? {} : {since})}}), this.getMembers({signal}).then(r => r.members).catch(e => { if (e.code === 'ABORTED') throw e; return []; })]); this._context(expected); checkAborted(signal); return messagesDto(response, members); })`。
  > **默认 limit 是 10**（不是 50）。成员目录读取失败只降级为空数组，不影响消息。
- `getDirectMessages(value = {}, {signal})`：`plainRequest(value, [], [])`；`_read('inbox', expected, request => directMessagesDto(await request('/api/messages')))`。
- `getFiresides(value = {}, {signal})`：`plainRequest(value, [], [])`；`_read('fireside', …, firesidesDto(await request('/api/fireside/list')))`。
- `getFiresideMembers(value, {signal})`：`id = firesideId(value)`（**value 本身就是 id，不是对象**）；`_read('fireside', …, firesideMembersDto(await request('/api/fireside/members', {query: {fireside_id: id}})))`。
- `getFiresideMessages(value, {signal})`：`plainRequest(value, ['firesideId','since','limit'], ['firesideId'])`；`id = firesideId(value.firesideId)`；分页校验同篝火（文案 `'围炉消息分页参数无效。'`）；`firesideMessagesDto(await request('/api/fireside/hear', {query: {fireside_id: id, limit: value.limit || 10, ...(since === undefined ? {} : {since})}}), expected)`。
- `_beingRequest(route, {query, expected, signal})`：`_context` + `checkAborted`；controller 入 `_requests` 并转发 abort；`value = await this.readImpl(route, {query, signal: controller.signal})`；再 `_context` + `checkAborted`；catch 里也先 `_context` + `checkAborted` 再重抛。
- `_read(area, expected, callback, {signal})`：
  `throughBeing = Boolean(this.readImpl && ['bonfire','fireside','scroll','beings','inbox'].includes(area))`。
  非 throughBeing → 先 `await _authorized(area, expected, {signal})`。
  `request(route, options = {})` = throughBeing ? `_beingRequest(route, {...options, expected, signal})` : `_request(route, {...options, expected, signal}).then(async value => { if (hasOwn(value,'town_id') && !matchesTownIdentity(value, await this._townIdentity(expected, signal))) throw IDENTITY_MISMATCH 'Town 返回的身份与当前 Being 不一致。'; return normalizeTownResponse(value, route, expected.loomBeingId); })`。
  `value = await callback(request)`；`_context` + `checkAborted`；`throughBeing` 时 `_set(area,'ready')`；返回。
  catch：`_context(expected)`；非 `ABORTED` → `_set(area, code === 'AUTH_REQUIRED' ? 'auth_required' : 'error', error.message)`；抛。
- `_mutate(area, expected, callback)`：`_mutations.has(area)` → `BUSY` `'当前操作正在提交，请等待结果。'`。`marker = `${this._epoch}:${area}``；加入 `_mutations`；`await _authorized(area, expected)`；`return await callback()`。
  catch：`_context(expected)`；`_set(area, AUTH_REQUIRED ? 'auth_required' : 'error', error.message)`；抛。
  finally：`marker === `${this._epoch}:${area}`` 才 delete（**reset 后的 epoch 变化会让旧标记不清理**）。
- `sendBonfireMessage(value)`：`plainRequest(value, ['content','mentions','connectionRevision','requestId','replyTo'], ['content','mentions','connectionRevision'])`。
  校验：`typeof content !== 'string' || !content.trim() || content.length > 4000 || /[\x00]/.test(content) || !Array.isArray(mentions) || mentions.length > 20 || mentions.some(id => typeof id !== 'string' || !ID.test(id)) || !sequence(connectionRevision)` → `INVALID_REQUEST` `'请输入 1–4000 字的篝火消息，并选择有效成员。'`。
  `expected = this._context(undefined, value.connectionRevision)`。
  **有 `writeImpl` 时**（中继路径）：`mentions = [...new Set(value.mentions)]`；`legacy = mentions.filter(id => !/^t_[A-Za-z0-9_-]+$/.test(id))`；有 legacy 才 `getMembers()`；`legacy.some(id => 目录里没有)` → `INVALID_REQUEST` `'所选 Being 已不在成员目录，请重新选择。'`；`missing = mentions.filter(id => !new RegExp(`(^|\\s)@${id}(?=$|[^A-Za-z0-9_-])`).test(content))`；`content = (missing.length ? missing.map(id => `@${id}`).join(' ') + '\n' : '') + value.content`；`writeImpl({kind:'bonfire', content, connectionRevision, ...(requestId ? {requestId} : {}), ...(replyTo ? {replyTo} : {})})`；`_context(expected)`；返回 result。
  **无 `writeImpl` 时**：`_mutate('bonfire', expected, …)`：同样的 mentions/legacy/missing 计算，但 `message = (missing.map(id => `@${id}`).join(' ') + (missing.length ? '\n' : '') + value.content).trim()`；`message.length > 4000` → `INVALID_REQUEST` `'加入 @成员后消息超过 4000 字，请缩短内容。'`；
  `response = await _request('/api/bonfire/speak', {expected, body: {message}, mutation: true})`；
  `response.ok !== true || !sequence(response.seq) || !matchesTownIdentity(response, await this._townIdentity(expected)) || !Array.isArray(response.mentions)` → `RESULT_UNKNOWN` `'篝火未返回完整发送确认，请刷新消息后核对；不要重复提交。'`；
  `_set('bonfire','ready')`；返回 `{ok:true, id: String(response.seq), ...(hasOwn(response,'mention_warnings') ? {mention_warnings} : {}), mentions: response.mentions.filter(字符串).slice(0,20).map(n => text(n,100))}`。
- `getChannelStatus({signal} = {})`：`_read('channel', expected, async () => { value = await _request('/api/channels/status', {expected, signal, query: {being_id: expected.loomBeingId}}); if ((hasOwn 'town_id' || hasOwn 'being') && !matchesTownIdentity(value, await _townIdentity(expected, signal))) throw IDENTITY_MISMATCH '渠道状态返回了不同的 Town 身份。'; list = Array.isArray(value.channels) ? value.channels : record(value.channels) ? Object.entries(value.channels).map(([channel, entry]) => ({...(record(entry) ? entry : {}), channel})) : [value]; return {channels: ['feishu','wechat'].map(channel => channelDto(list.find(item => record(item) && item.channel === channel), channel))} })`。
  > 这里回调忽略了传入的 `request`，直接用 `_request`——**即使有 `readImpl`，渠道状态也走直连**（`'channel'` 不在 throughBeing 的 area 白名单里，一致）。
- `beginChannelConnection(value)`：`plainRequest(value, ['channel','connectionRevision'])`（required 默认 = allowed，两个键都必填）；`channel ∉ ['feishu','wechat'] || !sequence(connectionRevision)` → `INVALID_REQUEST` `'请选择飞书或微信渠道。'`。
  `_mutate('channel', expected, async () => { response = await _request('/api/channels/register', {expected, body: {channel, being_id: expected.beingId}, mutation: true}); result = channelDto(response, channel); if (response.ok !== true && !['registered','pending','waiting','connected'].includes(result.status)) throw RESULT_UNKNOWN '渠道登记结果尚未确认，请先刷新状态。'; if (result.qrCodeUrl && !result.qrCodeDataUrl) { result.qrCodeDataUrl = await this._qrImage(result.qrCodeUrl, expected); if (!result.qrCodeDataUrl) result.detail = '渠道已登记，扫码图像暂时无法读取，请刷新渠道状态。'; } return {ok: true, ...result} })`。
- `_qrImage(url, expected)`：`_context(expected)`；fetch `{method:'GET', headers:{Accept:'image/png,image/jpeg,image/webp'}, credentials:'omit', redirect:'error', cache:'no-store'}`；`mime = content-type 分号前、trim、小写`；`!ok || mime ∉ 三种 || Number(content-length) > MAX_QR_BYTES` → `''`；流式累计 `> MAX_QR_BYTES` → `''`；`imageData(Buffer.concat(chunks), mime)`。catch → `_context(expected)` 后 `''`（**纪元失效仍会抛**）。
- `updateFeishuCredentials(value)`：`plainRequest(value, ['appId','appSecret','connectionRevision'])`（三个都必填）；`appId` 必须 `/^cli_[A-Za-z0-9_-]{1,120}$/`、`appSecret` 长度 1–4096 且不含 `/[\x00-\x20\x7f]/`、`connectionRevision` 是 sequence，否则 `INVALID_REQUEST` `'请输入有效的飞书 App ID 和 App Secret。'`。
  `_mutate('channel', expected, async () => { response = await _request('/api/channels/credentials', {expected, body: {channel:'feishu', app_id: appId, app_secret: appSecret}, mutation: true}); if (response.ok !== true) throw RESULT_UNKNOWN '飞书配置结果尚未确认，请先刷新渠道状态。'; return {ok:true, channel:'feishu', status:'pending', detail:'凭据已提交，请在飞书完成机器人设置并刷新连接状态。'} })`。
