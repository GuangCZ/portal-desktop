# IT · Town 读取行为（集成单元，并行组 C）

工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/it-town-feed`，分支 `it-town-feed`，基线 `next @ 5be8565`。
日期：2026-09-17。

本文件是断点续传记录：阅读摘要 / 进度 / 决定与偏差 / 冒烟结果 / 未做事项。

---

## 1. 阅读摘要

### 1.1 `docs/migration/i1-town.md`（I1 的完整记录）

- D3：渲染层**原地重写** `desktop/renderer/town/`，`TownModel` 类名与构造签名不变；不新建 `town-desktop/`。
- D7：`openFeed` 的「读共享、结果不共享」——每个调用者各自 fence 后应用同一份结果（**已经有一半 in-flight 合并的雏形**）。
- §4：24 条 `beings:town-*` 通道 + 3 条推送（`town-state` / `town-messages` / `town-members-invalidated`）。
- 遗留 3（本单元第 3 条任务的出处）：BD `test/town-conversation-ui.cjs` 的 60+ 条断言只搬了 8 条，
  **围炉切换竞态族、草稿焦点/滚动保持、SBS 状态条文案族尚未搬运**。
- 遗留 7 在 I1 记录里没有独立编号；任务书说的「GET /api/messages 是否返回已发送的私信」对应 R4 那一节：
  I1 已经**给 `TownDirectMessage` 增了 `recipientId?` / `recipientName?`**，并在 `session.ts` 增 `recipientField()`。
  本单元要核的是**请求路由本身**（`?with=received` / `?with=sent` 还是普通路由）与 BD 0.8.26 是否一致。
- R1：`invalidateMembers()` 里不得 `identityRevision++`（会清空时间线）。
- 遗留 1：两个 E2E 脚本 I1 从未真跑，IM 在打包产物上第一次跑。

### 1.2 `docs/migration/im-integration.md`（IM 的整合修复与真机冒烟）

- §4.5 / §9.2：`tests/town-ui.mjs` 的夹具**已改回真挂起**（共享 deferred `globalThis.town.membersHeld`，
  一次 `releaseMembers()` 全部兑现），并引入 `pending(name, condition, why)`：红的规则照红但不中断后面的 check。
  **本单元必须核对并保留这个挂起版夹具**（IM 第一轮改成 503 快速失败被复审打回）。
- 打包产物结果：`town-ui` 13 过 2 红、`town-sdk` 13 过 4 红。
  - `town-ui` 红 1：`messages render while the member directory is still pending` → openIssue 10（**本单元第 1 条任务**）。
  - `town-ui` 红 2：`an ambiguous recipient offers the choices Town returned` → openIssue 1（contextBridge 剥 `error.code`，**归 IN**）。
  - `town-sdk` 红 4 条：同 openIssue 1（**归 IN**）。
- openIssue 10（复审 finding 2，high）：`main/town/session/session.ts:408` 的
  `Promise.all([request2('/api/bonfire/hear',…), this.getMembers({signal})…])`——`.catch` 接得住拒绝接不住慢；
  `getMembers`（同文件 348-358）只有成功后的 TTL 缓存，**没有 in-flight 去重**。
  修法：把 `getMembers` 从 `Promise.all` 里摘出来，先用缓存/空目录渲染，目录到了再补 mention 标签。
- openIssue 2（**重要，与任务书的说法不同**）：「打开一次篝火发两次 feed 读」被 **IM 第二轮复测推翻**——
  用「目录真的挂起、随后释放」的夹具重跑，三条 read 计数 check 全过（一次打开 = 1 条读）。
  第一轮量到的「250 ms 后第 2 条」是在 `/api` 回 503 的夹具下量的，属**目录失败路径**。
  **仍然成立的一半：公共目录 `/api` 没有 in-flight 去重**（一次打开有多个并发 `getMembers`，干净打开 4 次、失败 9–12 次）。
  → 本单元第 2 条任务按 MEMORY「协议行为必须实测」先复测，再按实测结果决定修哪一半。
- 已拍板：`beings:town-open` 走工具浏览器（IM §2.12）；`connectionCleared()` 没有解绑路径，不再追。

### 1.3 `docs/migration/i6b-model-settings.md`

- §3 IPC：`beings:model-settings-state` 是**推送**，载荷 `ModelSettingsState = {connected, connectionId, runtime}`；
  `beings:model-settings` 是一条 invoke，渲染端加载时自己读一次（复审 9.1 之后新增，冷启动必需）。
- openIssue 2 明文：**Town 页的 SBS 状态行应读 `beings:model-settings-state`，不要自己再开 `/api/llm/config` 读**
  （本仓库只允许有一个该路由的读者）。← 本单元第 3 条任务的 SBS 那一族按这条做。
- openIssue 3：`sideBySide.active` 恒为 `null`（本壳层没有来源），页面照实显示「未知」。

### 1.4 `docs/migration/i5-conversation.md` / `i7-channel-drafts.md`

- I5 §7.4：两个 Town E2E 脚本归 IM 跑（已跑）。
- I7 未做 1：`contextBridge` 吃掉 `error.code` 是外壳级缺陷，**需合并者统一拍板**，I7 只修了自己四条通道
  （做法：resolve 信封、由渲染层重建）。→ 本单元不碰，归 IN。
- I7 未做 4：BD `test/town-conversation-ui.cjs` 里围炉竞态族 / 草稿焦点滚动 / SBS 状态条仍未搬运（与 I1 遗留 3 同一件事）。

---

## 2. 进度

- [x] 读 i1 / im / i6b / i5 / i7 的 openIssues 与决定
