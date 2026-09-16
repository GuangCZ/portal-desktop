# P1 · 第四块：React 对话页与会话侧栏（替换 iframe 聊天页）

移植日期 2026-09-16。来源：BeingDesktop 0.8.26 工作树
`/Users/d5c/Documents/ChatGPT/BeingDesktop`（只读）。

## 阅读摘要

下面每一节都是「不重读原文件就能继续」为标准写的：导出面、构造参数、常量、
分支要点、文案原文。

### desktop/shared/desktop-types.ts（本仓库，上一阶段产出）

`window.beings.chat` 的全部形状。关键类型：

- `ChatRow {seq, role:'user'|'being', content, at, from?, images?:ChatRowImage[]}`；
  `ChatRowImage {media_type, name?, thumb?}`（thumb 是渲染层生成的 data URL）。
- `ChatSentItem {text, at, after, images?}`；`ChatRepliedItem {text, final, think, at, after, partial?}`；
  `ChatLiveReply {text, think, at}`。
- `ChatView {sessionId, version, rows, workerResults:unknown[], sent, replied, live}`。
- `ChatSessionSummary {id, title, titleSource?, createdAt:number, updatedAt:string|number,
  truncated, count, lastSeq, busy, inFlight}`。
- `ChatRecoveryState {phase:'idle'|'streaming'|'replaying'|'reconnecting'|'catching-up'|'watching',
  sessionId?, streamId?, origin?, hint?, gaveUp?, pending?, live?, replaying?, catchingUp?, watching?}`。
- `ChatState {open, version, identityKey:'bound'|'', active, cursor, seeded, degraded,
  sessions:ChatSessionSummary[], recovery}`。`open` = 主进程 `ChatSessions.open`
  = `recovery !== null` = 对话层已绑定某个 Being（sessions.ts:188）。
- `ChatSendRequest {sessionId, text, images?:ChatImageUpload[], references?:ChatReferenceInput[]}`；
  `ChatImageUpload {media_type, data(base64), name?, thumb?}`。
- `ChatSendResult {ok:true, streamed, spliced, recovering}`；
  `ChatStopResult {stopped, reason, scene, ownerTitle}`；`ChatReloadResult {ok, added, error}`。
- `ChatEventPayload`：`sent | meta | think | delta | reply | settled | error`，
  外加透传的 `{type, data}`（`usage`/`tool_use`/`tool_result`）。
- `ChatAPI`：`sessions() view(id) send(req) stop({sessionId,force?}) reload()
  changeSession(id|null)->string renameSession(id,title)->boolean forgetSession(id)
  composerData() onEvent(cb)->unsub onState(cb)->unsub`。

### desktop/main/chat/ipc.ts（本仓库）

九个通道。`chat-view / chat-send / chat-stop / chat-reload / chat-forget-session`
**resolve 一个 `{__townError:true, code, message}` 包络**，preload 还原成带 `code`
的 Error；其余四个裸抛。`chat-composer-data` 现在恒返回
`{kits:[], members:[], kitsError:'', membersError:'', connectionRevision:0}`
（kit 目录与 Town 成员目录是后续阶段）。`chat-change-session(null)` 新建并返回新
id（对 0.8.26 的既有偏差，见 p1-sessions-fix.md）。`view()` 的 `workerResults`
恒为 `[]`：`ChatSessions` 的 `getWorkerResults` 默认 `() => []`，编排层未接线。

### BeingDesktop renderer/chat-app.js（539 行）

原生对话视图，IIFE，导出 `window.beingChat = {setState, refresh, isNative}`。

常量：
- `NOTICE_KEY = 'being-chat-notice-v1'`（一次性说明条的 localStorage 键）。
- `PHASES = {streaming:'Being 正在回复…', replaying:'连接恢复中，正在续读回复…',
  reconnecting:'连接中断了，正在自动恢复…',
  'catching-up':'消息已送达，Being 正在处理其他会话，等它回到这里…',
  watching:'being 正在呼吸…'}`。
- `GROUP_MS = 60000`（同角色一分钟内合并 meta 行）、`GAP_MS = 300000`（静默超过五分钟插 `— hh:mm:ss —` 分隔）。
- `IMAGE_TYPES = /^image\/(?:png|jpeg|webp|gif)$/`、`MAX_IMAGE_BYTES = 10*1024*1024`、
  `MAX_IMAGES = 8`、`THUMB_EDGE = 256`、`MAX_THUMB = 48*1024`。
- `TOOL_LABELS = {thinking:'在思考', remember:'在回忆', learn:'在反思', search_web:'在搜索',
  browse_web:'在浏览', read_file:'在阅读', write_file:'在编写', run_command:'在执行',
  list_files:'在查看', portal_exec:'在执行', act:'在行动'}`。

`keyArg(raw)`：工具调用里值得显示的那一个参数。JSON.parse 字符串（失败当 `{}`）；
依次取 `query`(≤60) / `path`(basename) / `file_path`(basename) / `command`(≤50) /
`url`(hostname，解析失败取前 40) / `topic`(≤40) / `content`(≤40) / 第一个非空字符串(≤40)；
截断用 `value.slice(0, max-1) + '…'`。

`clock(at)`：`toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'})`，
无效时间返回 `''`。

`setState(appState)` 的分支（逐条）：
1. `connected = appState.connection.status === 'connected'`；`local.chat = appState.chat`；
   `active = chat.open ? chat.active : ''`。
2. 会话切换时：把当前 `{text, images, references}` 存进 `drafts`（Map，按会话 id），
   清空 `view/live/activity`、`version = -1`、`pinned = true`，再载入目标会话的草稿。
3. `session = chat.sessions.find(id === active)`；`recovery = chat.recovery`；`phase = recovery.phase || 'idle'`。
4. `hint = ((!recovery.sessionId || recovery.sessionId === active) && recovery.hint) || PHASES[phase] || ''`
   —— **别的会话的 hint 不显示在这个会话下面**。
5. 状态行：`connected ? (degraded ? hint + (hint?' · ':'') + '本机未加密，记录仅保留在内存' : hint) : '尚未连接'`。
6. `input.disabled = !connected || !active`；`send.disabled = input.disabled || sending`。
7. 停止按钮可见性：`hidden = !(session && (session.busy || session.inFlight)) &&
   !['streaming','replaying'].includes(phase)`。
8. `waiting = !!(session && (session.inFlight || (recovery.sessionId === active &&
   (phase==='streaming' || phase==='replaying'))))` —— 注释说明 inFlight 比 phase 慢一个广播，所以两个都查。
9. 说明条：`notice.hidden = !chat.open || localStorage[NOTICE_KEY] === '1'`；读 localStorage 抛错时显示。
10. `if (active && chat.version !== local.version) refresh(); else render();`

`refresh()`：`chatView(active)` → 若 `view.sessionId !== local.active` 丢弃 →
写入 `local.view/live`、`local.version = version`。失败时把 `error.message` 写进状态行
（兜底 `'记录读取失败'`）。

`interleave(rows, transient)`：把暂存项插进历史行。
```
place(item): index = 0
  while index < rows.length && Number.isFinite(rows[index].seq) && rows[index].seq <= (item.after||0): index++
  while index < rows.length && (!at || epoch(rows[index].at) <= at): index++
  return index - 0.5
```
历史行 key = 下标；排序 `left.key - right.key || epoch(left.at) - epoch(right.at)`。

`render()`：
- `selectionUI.isSelecting()` 为真时**不重绘**（正在选文本）。
- 会话 `truncated` 且有行时，顶部一个「记录已裁剪，重新读取最新窗口」按钮 → `chatReload()`。
- 顺序：`rows` → `workerResults`（role being）→ `sent`（role user, pending）→
  `replied`（role being, pending, partial, think）→ 末尾追加 `live`（有 text 或 think 时）。
- 分组：`gap > GAP_MS` 插 `time-gap`；`item.role === lastRole && gap <= GROUP_MS && !pending && !live`
  时加 `is-consecutive`。
- `waiting && 没有 live 气泡` 时追加「思考中」气泡：有活动日志就画活动行，否则三个 `.chat-dot`。
- `local.pinned`（距底 < 48px）时滚到底。

`bubble(role, text, {pending, partial, think, at, live, images})`：
meta 行 = `[role==='user'?'you':beingName, clock(at), note].filter(Boolean).join(' · ')`，
`note = partial ? '回复中断，等待记录核对' : pending ? '等待记录确认' : ''`。
`live` 时正文用 textContent（不解析 markdown），落定后才 `renderMarkdown`。
用户消息先 `beingChatReferences.decode(text)`，有引用就画引用 chip。

`activityLine({text, think, live})`：`<details>`，summary 标签
`current ? (current.error ? label+' ✗' : label) : live ? (text ? '正在回复' : think ? '思考中' : '等待回复') : '思考过程'`；
预览 = `current.arg` 或 `think.trim().slice(-60)`；live 时补一个 `▊`；
body 为每条日志 `` `${label} ${arg} ${done ? (error?'✗':'✓') : '…'}` ``，再附 think 全文；
都没有时写「（没有思考过程）」。

`onEvent(event)`：`event.sessionId !== local.active` 直接丢。
- `delta` / `think`：累加进 `local.live`（不存在就新建 `{text:'',think:'',at:now}`），重绘。
- `tool_use`：`{label: TOOL_LABELS[name] || name, arg: keyArg(data.input), done:false, error:false}`
  推进 `activity.log`，设为 `current`。
- `tool_result`：从后往前找第一条未 done 的，标 `done`，`error = data.is_error === true`；
  `current = error ? entry : null`。
- `reply` / `error` / `settled`：清空 `live` 与 `activity`。
- 其余（含上面三种落定后）：`local.version = -1; refresh()`。

`send(event)` 的守卫与顺序：
1. `sending || input.disabled || !active || !bridge().chatSend` → 返回。
2. `local.reading` → toast「图片还在读取，稍等一下再发送。」（非错误）。
3. `!text.trim()`：有引用 → toast「输入想讨论的问题，再连同引用一起发送。」；
   否则有图 → toast「给图片配一句话再发送。」（错误）；返回。
   注释：只有图片的消息不落行，Being 会去回答上一条。
4. `composerUI.prepare(text, event)` 抛错 → toast 后返回。
5. 清空输入/托盘/引用，`waiting = true`，立即重绘；
   `chatSend({sessionId, text, references?, images?})`（images 只挑 `{name, media_type, data, thumb}`）。
6. `result.spliced` → toast「消息已送达，Being 正在处理其他会话，回复稍后到达。」
7. 失败：把原文与图片、引用**并回**当前草稿（原文在前，已输入的新内容接在后面），
   写回 `drafts`，当前会话没变就同时还原 UI 并 `waiting = false`；toast 错误。
8. finally：`sending = false`，当前会话没变就把焦点还给输入框。

`stop()`：
- `chatStop({sessionId})`；`result.stopped` 为真直接返回。
- `reason === 'other-scene'`：`who = ownerTitle ? '「'+ownerTitle+'」' : '另一个会话'`，
  `confirm('Being 正在回复的是' + who + '，不是这个会话。要停止那边的回复吗？')` → `force:true` 重试。
- `reason === 'unknown'`：`last = ownerTitle ? '刚说完的是「'+ownerTitle+'」，接下来轮到谁还不确定。'
  : '无法确认 Being 正在回复哪个会话。'`，`confirm(last + '仍要停止当前这口气吗？')` → `force:true`。
- `reason === 'autonomous'` → toast「Being 正在自己思考，没有属于会话的回复可以停止。」
- 其余 → toast「当前没有正在进行的回复。」

图片（`addFiles`）：过滤 `instanceof File` → 逐个校验，**只记最后一条拒绝原因**：
- 非图片：`` `${file.name || '文件'} 不是图片，只支持 PNG、JPEG、WebP、GIF。` ``
- 超过 8 张：`` `一条消息最多 ${MAX_IMAGES} 张图片。` `` 并 **break**
- 合计超 10MB：`` `${file.name || '图片'} 放不下了：一条消息的图片合计不能超过 10 MB。` `` 并 continue
读取期间 `local.reading` 计数，读完若会话已切换则丢弃该图；单张失败 toast
`` `${file.name || '图片'} 读取失败，请重新添加。` ``。
缩略图：`createImageBitmap` → 最长边 256 等比缩放 → 白底 canvas → `toDataURL('image/jpeg', 0.7)`，
超过 48KB 返回 `''`。
托盘脚注：读取中 `` `正在读取 ${n} 张图片…` ``；否则
`` `${n} 张图片将随下一条消息发送 · Being 只在这一轮看到它们，记录里保留缩略图` ``。

说明条原文（0.8.26）：「所有会话共享同一个 being 的记忆，会话只是你的浏览视图。更早的记录
（v1.7.0 之前）没有场景标记，未归入任何会话，可在 Loom 页面查看完整时间线。」按钮「知道了」。

### BeingDesktop renderer/chat-references.js

已在上一阶段移植为 `desktop/shared/chat-references.ts`（`validate/encode/decode`，
≤12 段、合计 ≤60000 字符，信封 `【引用上下文】…【用户消息】…`，只认能原样重编码的信封）。

### BeingDesktop renderer/chat-selection.js（224 行）

`window.beingChatSelection = {install, referenceChip}`。
- `referenceChip(references, {remove, removeOne, onClose})`：折叠成「N 条引用」标签，
  悬停/聚焦展开 popover，列出 `所选文本 · ${source}` 与全文，可「移除此引用」/「移除全部引用」。
- `install({root, stream, input, getSession, isConnected, addReference, renderMarkdown, interleave, onRelease})`：
  选中 `.chat-body` 内文本后浮出工具条「添加到对话」「更多详情」；
  `reference = {text: selection.toString(), source: body.closest('.is-user') ? 'you' : 'Being'}`。
  「更多详情」开临时解释卡片（`chatDetailOpen/Send/Stop/Close`，本仓库尚无 IPC 通道）。
- 本阶段只移植了「引用随消息发送 + 历史里显示引用」这一半：选区工具条与解释卡片需要
  `chatDetail*` 通道，未接线（见「偏差与未做」）。

### BeingDesktop renderer/sidebar.js（284 行）

`window.beingSidebar = {init, setState, command, refresh, setPage, saveVisibility, isCollapsed}`。
本阶段用到的规则：
- `ordered()`：按 `max(metadata.touchedAt, updatedAt || createdAt)` 倒序，同值按原下标稳定。
- `age(item)`：`<1 分` → 「刚刚」；`<60` → `${n}分`；`<1440` → `${n}时`；否则 `${n}天`。
- 分组顺序：已置顶 → 项目（可折叠，`basename(path)` 作标题）→ 独立会话；
  归档的会话从三组里隐去，只能在搜索的「已归档」分类里找回。
- 会话行：活动灯（`talking`/`waiting`/`inactive`）+ 标题（空则「新会话」）+ 相对时间；
  `aria-label` 追加「，进行中」/「，等待回复」；右键或「更多」开菜单。
- 会话菜单：置顶/取消置顶、重命名（未连接时禁用）、移到某项目、移出项目、归档/取消归档。
  归档成功 toast「会话已归档，可从搜索中恢复。」/「会话已恢复」。
- 空态文案：`connection.configured` 时「暂无独立会话」，否则「连接 Being 后，会话会显示在这里。」
- 搜索：过滤 `${title} ${basename(project)}`，上下键移动、Enter 打开、Esc 关闭；
  空结果文案「没有找到匹配的会话」/「没有已归档的会话」/「暂无会话」；
  打开已归档结果会先取消归档。
- 快捷键：⌘N 新会话、⌘K 搜索、⌘O 添加项目、⌘B 显隐侧栏、⌘1–9 切换会话、
  ⌘[ / ] 导航、⌘J 控制台、⌘T 浏览器、⌘, 设置。
- `docs/sidebar-interaction.md`：「会话列表按最后消息时间排列；打开会话不会将它重新置顶。」
  「归档只修改本机侧栏元数据」「移除项目只移除侧栏引用，不删除文件。」

重命名 UI 在 `renderer/app.js:1475 renameChatSession(item, button)`：把会话行换成
`<input class="session-name-input" maxLength=80>`，`title='Enter 保存，Esc 取消'`，
Enter/blur 保存，Esc 取消；空标题或与原标题相同时直接关闭不调用 IPC；
保存失败 toast 后保持编辑态并 `select()`。

`showSessionMenu`（src/main.cjs:1142）用的是 Electron 原生菜单，返回
`'rename' | 'forget' | null`；本仓库没有这个通道，改为渲染层菜单。

### BeingDesktop renderer/composer-helpers.js（62 行）

纯函数 `tokenAtCaret / composerSuggestions / replaceComposerToken / composerReferences /
buildKitPrompt`，服务于 `/` 调 Kit、`@` 通知 Being。本阶段**没有移植**：本仓库
`chat-composer-data` 恒返回空目录，搬过来就是无人调用的死代码（见 openIssues）。

### portal-desktop 壳层（本仓库既有）

- `desktop/renderer/shared/models/store.ts`：`Store` 基类，`subscribe/getVersion/changed`；
  `errorText = publicErrorMessage`。
- `desktop/renderer/shared/hooks/use-model.ts`：`useModel(model)` = `useSyncExternalStore`。
- `desktop/renderer/shared/components/dialog.tsx`：`<Dialog open onClose busy dismissOnBackdrop>`，
  用原生 `showModal()`。
- `desktop/renderer/shared/components/markdown.tsx`：`<Markdown content className onPlace chat renderText previewMarkdownCode>`，
  marked + highlight.js，`chat` 打开 `breaks:true`。
- `desktop/renderer/app/models/app.ts`：`AppModel extends Store`。与本块相关的字段：
  `snapshot / theme / view / chatSource / chatLoading / connection / searchEntries /
  searchOpen / search / toast() / run() / navigate() / post()`；
  `applySnapshot()` 仍然生成 `chatSource`（`beings://chat/?name=…&history_scope=…&scene_id=…`），
  `tests/renderer-state.test.ts` 第一条用例直接断言这串 URL 的参数，所以**不能删**。
  `frameLoaded()` 把 `chatLoading` 置回 false 并重置搜索索引。
- `desktop/renderer/app/hooks/use-chat-bridge.ts`：iframe 的 postMessage 桥，本块不再挂载。

## 偏差与未做（决定与理由）

1. **说明条的触发条件**改成了 0.8.26 的规则（对话层已打开且未关闭过），不是任务书写的
   「首次出现无 scene 历史行时」：无 scene 的历史行在主进程 `ChatStore.apply`
   （store.ts:262）就被丢弃并只计入本地变量 `skipped`，既不进 `ChatView.rows`
   也不进 `ChatState`，渲染层拿不到任何信号。要做成条件触发得先给 `ChatState`
   加一个字段，那是主进程阶段的改动。文案用任务书给的短版。
2. **选区工具条与「更多详情」解释卡片**未移植：依赖 `chatDetail*` 五个 IPC 通道，
   本仓库没有。引用仍然可以经 `ChatSendRequest.references` 发出，历史里的引用信封
   也会被 `decode` 还原成 chip —— 只是本阶段没有产生引用的入口。
3. **`/` Kit 与 `@` 成员补全**未移植（目录恒为空）。
4. **worker 结果卡片**未移植：`ChatView.workerResults` 是 `unknown[]`，本仓库没有生产者
   （`getWorkerResults` 默认返回 `[]`），照着 0.8.26 的字段画卡片等于编造 DTO。
5. **SBS 开关、模型设置面板、关于 Being / 隐私说明**在 topbar 里隐藏：它们原本是
   iframe 聊天页里的面板（`renderer/chat/components/panels.tsx`、`settings.tsx`），
   壳层不再加载那个页面。
6. **历史范围（当前场景 / 全部场景）**：原生会话没有这个概念，`ChatSceneIndicator`
   的两个单选项保持禁用（`scopeReady` 恒 false），「场景详情」仍可用。

## 进度

| 文件 | 状态 |
| --- | --- |
| docs/migration/p1-ui.md | 已写阅读摘要 |
| desktop/renderer/conversation/models/transcript.ts | 已移植 · 测试通过 |
| desktop/renderer/conversation/models/composer.ts | 已移植 · 测试通过 |
| desktop/renderer/conversation/models/conversation.ts | 已移植 · 测试通过 |
| desktop/renderer/conversation/components/messages.tsx | 已移植 |
| desktop/renderer/conversation/components/composer.tsx | 已移植 |
| desktop/renderer/conversation/components/conversation.tsx | 已移植 |
| desktop/renderer/conversation/styles.css | 已移植 |
| desktop/renderer/app/components/sidebar.tsx | 已移植 |
| desktop/renderer/app/hooks/use-conversation-bridge.ts | 已移植 |
| desktop/renderer/app/page.tsx | 已改（去 iframe） |
| desktop/renderer/app/models/app.ts | 已改（最小） |
| tests/conversation-model.test.ts | 通过 |
| tests/composer.test.ts | 通过 |
| tests/architecture.test.ts | 已加规则 · 通过 |
