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

### 1.2 `docs/migration/i5-conversation.md`（D3 / F2 / F3 / 未做 1）

- **D3 + F2 + 未做 1（本单元第 2 条）**：`main.ts` 把 `PortalSupervisor` 留在自己的闭包里，没传给 `installDesktopExtensions`；
  `SubsystemContext` 也没有这个字段，所以 `subsystems/chat.ts` 传 `getPortalState: () => null`，
  帧里 `portal.status` 恒 `not_configured`、`health` 恒 `unknown`——**定案 §5.2 的交付物在合回 next 之后仍不成立**。
  I5 把 IM 要加的三行逐字写在了 `subsystems/chat.ts` 的 `getPortalState` 上方：
  `subsystems/types.ts: portalState?: () => PortalState | null;` /
  `main.ts: portalState: () => portal.state,` / `subsystems/chat.ts: getPortalState: () => ctx.portalState?.() ?? null,`。
  `chat/environment.ts` 的 `portalRuntime`（九行映射表）与 `tests/chat-integration-environment.test.ts` 都不用改。
  I5 明确否决过两条捷径：`declare module` 增补接缝、`ctx as {portalState?}` 硬转。
- **F3（本单元第 7 条）**：`connectionRevision` 的跨子系统隐式耦合。`main.ts` 只有两处调 `connectionVerified`（335 / 449），
  两处都在 `verifyBeingConnection` 之后，而 `chat/ready.ts:6` 第一行就 `if (!connection) throw`——
  **生产路径到不了 `!next` 那一支**（`town.ts:333` 与 `chat.ts` 的分歧点），两个计数器在可达路径上恒等。
  I5 没改行为，改为用 `tests/chat-integration-composer.test.ts` 钉住不变量
  （回显 revision → `AUTH_REQUIRED` 而非 `SESSION_CHANGED`；±1 → `SESSION_CHANGED`；换 Being 旧值仍被拒；同 Being 重验两边都不动）。
  真正的收敛留给 IM/IN。

### 1.3 `docs/migration/i7-channel-drafts.md`（D3 / R2 / 未做 1、5、8）

- **D3（与 IM §4.4 同一件事，且 I7 已给出可行修法）**：I7 的四条 `beings:channel-*` 通道
  **preload resolve 出信封而不是抛**，渲染层 `renderer/channel/models/channel.ts` 的 `unwrap()`
  在渲染层自己的上下文里变回带 `code` 的 Error——不跨界就不会被拷贝。
  `ChannelAPI` 四个方法因此返回 `ChannelAnswer<T> = T | ChannelErrorResult`。
  **这就是本单元要推广到全部通道族的机制**（I7 已在打包客户端上验证过）。
- **未做 1**：I1 的 24 条 `beings:town-*` 与 P1 的 5 条 `beings:chat-*` 仍是旧形状，需要合并者统一拍板。
- **R2 + 未做 8（本单元第 3 条）**：`feature-tasks.ts:121` 抛英文 `Too many active feature tasks`，
  33 字无换行，`shared/errors.ts:12` 的 `publicErrorMessage` 会原样放行 → 用户看到英文。
  BD 在 `src/main.cjs:740` 的 catch 里统一换成
  「功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。」（码 `TASK_LIMIT_REACHED`，BD `src/main.cjs:127` 有）。
  I7 只在自己的 `main/town/channel/ipc.ts` 用常量 `TASK_LIMIT` 出这句原话，没动共享表。
  统一修法（I7 写明）：`TOWN_ERROR_CODES` 末尾加 `'TASK_LIMIT_REACHED',`，中文文案放进 `feature-tasks.ts` 抛出点，
  `ipc.ts` 的 `TASK_LIMIT` 常量随之删除。
- **未做 5（本单元第 4 条）**：`FEATURE_NAMES` 的 `model` / `workspace` 两个键在本外壳没有页面，
  功能任务页点「打开功能页」toast「该功能暂时没有可打开的页面。」。`model` 的页面是 I6b 的，
  合回后把 `TASK_VIEWS` 加一行指过去；`workspace` 仍无页面 → 保持 toast。

### 1.4 `docs/migration/i6b-model-settings.md`（视图键 / openIssues 4）

- 模型页在 `desktop/renderer/settings/components/model-settings.tsx`，DOM id `#model-settings-page`，入口按钮 `#open-models`
  （`tests/sbs-refresh.mjs` 在真窗口里点 `#open-models` 等 `#model-settings-page`）。视图键要从 `app/slots.tsx` / 导航模型里实读。
- openIssues 4：`CHAT_ERROR_CODES` 已被 I6b 追加 `'NEEDS_KEY', 'ROLLED_BACK'`（第七处共享文件）。
  → 本单元第 1 条必须覆盖 `beings:model-config-save` / `beings:model-side-by-side` 这两条写通道的 `NEEDS_KEY`。
