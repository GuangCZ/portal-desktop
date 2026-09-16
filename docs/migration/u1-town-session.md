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
