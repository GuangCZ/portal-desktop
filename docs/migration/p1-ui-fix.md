# P1 · 复审修复：对话界面与清理（p1-ui / p1-cleanup 的 7 条结论）

修复日期 2026-09-16。上游两块的记录见 `docs/migration/p1-ui.md` 与
`docs/migration/p1-cleanup.md`；本文件只记录复审结论的处理。
来源仓库（只读）：`/Users/d5c/Documents/ChatGPT/BeingDesktop`（0.8.26 工作树）。

## 阅读摘要

### BeingDesktop renderer/chat-app.js — 链接与 Enter（复审第 1、3 条）

- 第 60-61 行注释原文：「Links are shown as text — the shell's CSP forbids
  navigation from here anyway — and nothing is ever parsed as HTML.」
- `inline(target, text)`（第 111-124 行）用一条正则切分行内片段：
  `` /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\n)/g ``。
  链接分支是第 4 组：`const span = node('span', 'chat-link', link[1]); span.title = link[2];`
  —— **span，不是 a**；可见文字是 `[]` 里的文案，URL 只进 `title`。
- `renderer/chat-app.css:46-47`：
  `.chat-link { color: var(--link, var(--accent)); text-decoration: none; text-underline-offset: 3px; cursor: help; }`
  `.chat-link:hover { text-decoration: underline; }`
- `test/chat-conversation-ui.cjs:88` 的用例
  「markdown renders bold, inline code, lists and fenced code, and never injects HTML」
  断言 `being.querySelector('.chat-link')?.title==='https://example.invalid/doc'`
  **且** `being.querySelector('a')===null`。
- 输入框 keydown（chat-app.js:144）：
  `if (composerUI?.keydown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(event); }`
  —— 补全模块先看，它「吃掉」了就什么都不做（**不 preventDefault**）。

### BeingDesktop renderer/chat-composer.js — 输入法窗口（复审第 3 条）

- 第 18 行状态：`composing = false, compositionUntil = 0`。
- 第 141-142 行：
  `input.addEventListener('compositionstart', () => { composing = true; close(); });`
  `input.addEventListener('compositionend', () => { composing = false; compositionUntil = Date.now() + 50; setTimeout(refresh, 55); });`
- 第 98 行 `keydown`：
  `if (event.isComposing || event.keyCode === 229 || composing || Date.now() < compositionUntil) return event.key === 'Enter';`
  —— 窗口内的 Enter 返回 true（被吞），其它键返回 false。
- 第 106 行 `prepare(text, event)`：
  `if (composing || Date.now() < compositionUntil || event?.isComposing) throw new Error('请完成输入后再发送。');`
  chat-app.js 的 `send` 捕获后 toast 这句话并返回。
- `test/chat-composer-ui.cjs:37-41` 的两条用例：
  - 「IME commit and its trailing Enter never send or publish」：
    `compositionstart` → 真实 Enter → `compositionend` → 合成 `keydown Enter`，断言
    `fixture.calls.send.length===1`（没有新增）。
  - 「trusted Enter sends the original mention to Bonfire exactly once」：
    `await new Promise(r=>setTimeout(r,65))` 之后再按 Enter 才发出去 —— 65ms 正是
    为了越过 50ms 窗口。

### 本仓库 desktop/renderer/shared/components/markdown.tsx（复审第 1 条）

- `safeLink(value)`：只放行 `http:`/`https:` 且无 username/password 的 URL，否则
  `undefined`。
- `code(value, language)`（第 182-199 行）：`onPlace && href && /^https?:\/\/[^\s<>"'`]+$/i`
  时产出 `<a className="chat-code-link" target="_blank">`；否则 chat 模式下交给
  `HighlightedCode`。**可见文字就是 URL 本身。**
- `link` 分支（第 269-302 行）：`<a href={safeLink(...)} target="_blank"
  rel="noopener noreferrer">`，`placeFromURL(link.href)` 命中时加 `chat-place-link`
  并在 click 里 `preventDefault()` + `onPlace(target)`（站内跳转，不发网络请求）。
- `onPlace` 只有对话页传（`messages.tsx:130`）；Town 的 feed / catalog / seeds /
  composer 都不传，所以 `chat-code-link` 与 `chat-place-link` 只出现在对话里。

### 本仓库 desktop/main/chat/sessions.ts（复审第 2 条）

`start(identityKey)`（第 213-232 行）绑定 Being：`store.load()` →
`store.ensure/setActive` → `this._touch()` → **`await this.recovery.reconcile({ full: !store.seeded })`**
→ `void this.recovery.checkActiveStream()`。连接建立时的全量对账已经在这里做过一次。

### 本仓库 desktop/renderer/app/models/app.ts（复审第 2、4 条）

- `applySnapshot(next)`：`next.settings.hasToken && (!this.chatSource || reload)` 时
  `chatLoading = true; connection = 'connecting'; chatSource = crypto.randomUUID()`；
  `!hasToken` 时 `chatSource = ''`。
- `frameLoaded()` 只做 `chatLoading = false`。
- `toast(error)` 6000ms 后自动清空。
- `page.tsx:133` 只在 `app.snapshot?.settings.hasToken` 为真时渲染 `<ConversationPage>`，
  `StopConfirmDialog` 在它里面；`app.conversation` 则是 `AppModel` 构造时创建的长生命周期对象。
- `main.tsx` 用了 `<StrictMode>`：挂载期 effect 会跑两遍，卸载兜底必须对
  「没有未决 confirm」为无副作用。

### 本仓库 scripts/test-all.mjs（复审第 7 条）

`step(name,file,args)` 把子进程输出同时写进 `test-results/<name>.log` 与 stdout，
`const status = result.code === 0 ? 'passed' : 'failed'` 写进 `report.steps`，
`persist()` 生成 `summary.json` 与 `summary.md` 的表格。五个跳过脚本
（`tests/{electron-smoke,town-sdk,portal-runtime-e2e,town-ui,sbs-refresh}.mjs`）
都在文件头 `console.log('SKIPPED: …')` 后 `process.exit(0)`。
`desktop/TESTING.md:65` 声明 `summary.json` 是给别的 CI 读的结构化结果。

## 逐条处理

| # | 结论 | 处理 |
| --- | --- | --- |
| 1 medium | 对话正文 markdown 链接变成可点击 `<a>` | 已修：chat 模式下无站内目标的链接回到惰性 `.chat-link` span |
| 2 medium | 连接建立时多余且竞态的 `conversation.reload()` | 已修：删掉这次 reload，保留 `frameLoaded()` |
| 3 medium | 输入法提交后的 Enter 不再被拦截 | 已修：`ComposerModel` 维护 composing/compositionUntil(50ms) |
| 4 low | 停止确认弹窗随页面卸载 → `stopping` 永久卡住 | 已修：连接关闭与组件卸载都 resolve(false) |
| 5 low | 投影读取失败变成 6 秒 toast | 已修：写进 `status`，下一次状态更新才清除 |
| 6 low | MIGRATION/README 夸大 architecture 测试守护范围 | 已修：新增源码级规则 + 改文案 |
| 7 low | 跳过的 E2E 在 summary.json 里记成 passed | 已修：识别 `SKIPPED:` 标记，记成 `skipped` |

## 进度

| 文件 | 状态 |
| --- | --- |
| `desktop/renderer/shared/components/markdown.tsx` | 已修改 / 测试通过 |
| `tests/markdown.test.ts` | 已加用例 / 通过 |
| `desktop/renderer/conversation/styles.css` | 已加 `.chat-link` 样式 |
| `desktop/renderer/app/hooks/use-conversation-bridge.ts` | 已修改 |
| `desktop/renderer/conversation/models/composer.ts` | 已修改 / 测试通过 |
| `desktop/renderer/conversation/components/composer.tsx` | 已修改 |
| `tests/composer.test.ts` | 已加用例 / 通过 |
| `desktop/renderer/conversation/models/conversation.ts` | 已修改 / 测试通过 |
| `desktop/renderer/conversation/components/conversation.tsx` | 已修改 |
| `tests/conversation-model.test.ts` | 已加用例 / 通过 |
| `tests/architecture.test.ts` | 已加规则 / 通过 |
| `scripts/test-all.mjs` | 已修改 |
| `MIGRATION.md` / `README.md` / `README_CN.md` / `desktop/TESTING.md` | 已更新 |
