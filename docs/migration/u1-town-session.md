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
