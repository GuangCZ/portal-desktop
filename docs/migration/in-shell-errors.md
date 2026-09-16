# IN · 壳层错误码与合并后小缺口

单元 key：`IN`（并行组 C）。工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop/.local/in-shell-errors`，
分支 `in-shell-errors`，基线 `next @ 5be8565`（typecheck 绿；vitest 127 文件 / 1398 通过 / 24 跳过）。
日期：2026-09-17。

本单元不新增功能，收口的是并行组 A/B 合回 `next` 之后留下的**跨单元**遗留，最重的一条是
`contextBridge` 剥掉 Error 自定义属性导致四族通道的 `code` / `candidates` 到不了渲染层。

---

## 1. 阅读摘要

### 1.1 `docs/migration/im-integration.md` §4.4 / §4.5 / §8（openIssues）

- **§4.4（本单元第 1 条的原始证据）**：`tests/town-sdk.mjs` 首跑 13 过 4 红。红的 4 条都是读 `error.code` 的。
  实测：`window.beings.townDesktop.bonfire()` 未配对时 reject 出来的 Error，
  `Object.getOwnPropertyNames(e)` 只有 `["stack","message"]`，**没有 `code`**；
  同一刻 `townDesktop.appState()` 的 `sync.bonfire.errorCode` 是 `"AUTH_REQUIRED"`——主进程知道，渲染层拿不到。
  根因用两文件独立夹具复现（`/tmp/im-cb/fixture`，Electron 44.2.0）：
  `contextBridge` 暴露的函数 throw `Object.assign(new Error(m), {code})`，页面侧自有属性只剩 `["stack","message"]`
  （同步抛同样，`Object.keys` 只有 `message`）；**把同一个值当普通对象返回则原样到达**。
  → `preload/channels/bridge.ts` 的 `enveloped` 与 `preload/channels/town.ts` 的 `townEnveloped`
  把包络还原成 Error 的位置在 contextBridge 的**错误一侧**。
  继承自 0.8.26（`BeingDesktop/src/preload.cjs` 60-76，注释自己写着 Electron strips custom Error fields；
  `renderer/town-app.js:308` / `:1027` 的分支在 0.8.26 里同样走不到）。
  IM 明确不修（跨 I1/I5/I7/I6b 四个单元），4 条断言原样保留。
- **§4.5**：`tests/town-ui.mjs` 13 过 2 红。其一是私信歧义候选到不了渲染层
  （`TownModel.send()` 读 `(error).candidates`，`renderer/town/models/town.ts:1147`）——**本单元要转绿的那条**；
  其二（§8 第 10 条）是篝火读阻塞在成员目录上（`main/town/session/session.ts:408` 的 `Promise.all`）——**IT 的**，保持红。
- **§8 openIssues** 与本单元对应关系：1 → 本单元第 1 条；3 → 第 6 条（假钥匙串默认）；7 → 第 5 条（退出瞬间的 snapshot）；
  10 → IT；2/8 已被第二轮推翻/解决；4（窗口标题）、5（没连真实 Being）、6（protocol.ts 403 无测试）、9、11 不在本单元范围。
- IM 已核实 `connectionCleared()` 本外壳没有解绑路径（不再追）；`beings:select-saved-project` 定名不改；
  两个浏览器面板同时要求显示时矩形归最后说话的面板。
