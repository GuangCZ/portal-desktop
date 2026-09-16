# P1 收尾：删除 iframe 聊天路径与聊天代理

本块只做删除与改写，不移植新模块。目标：`beings://chat` 这条路径（主进程代理、场景标识、
renderer/chat 整个目录、loom.html、构建脚本、相关测试）从仓库里消失，文档与 MIGRATION.md
更新到"对话核心在主进程，会话 = scene"。

## 阅读摘要

下一个接手的人不必重读原文件。

### desktop/main/chat/proxy.ts（删除）

- 导出 `upstreamRequest(request, connection)` 与 `class ChatProxy`。
- `routes` 白名单 7 条：`/health` GET、`/api/status` GET、`/api/history` GET、
  `/api/stream/active` GET、`/api/chat/stream` POST、`/api/stop` POST、`/api/llm/config` GET+PATCH。
- `upstreamRequest`：只接受 `beings:` 协议 + hostname `chat`，否则抛 `API route not allowed`；
  透传 `limit`/`after` 两个查询参数（`/^\d{1,16}$/`）；注入 `token`；`/api/llm/` 前缀加
  `X-Relay-Secret` 头。
- `ChatProxy` 构造参数：`(getConnection, fetchUpstream, scene?)`。方法 `abortAll()`、`handle(request)`。
- `handle` 的分支：未连接 401「请先连接 Being。」；`X-Portal-Being-Endpoint` 与当前不符 409
  「Being 连接已切换，请刷新对话后重试。」；路由不在白名单 404；发送且无 scene 409
  「客户端场景不可用，暂时无法发送消息。请检查启动提示并重启客户端。」；body 非对象 400
  「无效的聊天请求。」；上游失败 502「无法连接 Being，请检查网络、地址或凭据。」。
- 30 秒只是 header 超时，SSE 流保持打开；发送时主进程把 `...this.scene` 覆盖到 JSON 顶层
  （渲染层给的 scene 字段一律被覆盖）。

### desktop/main/chat/scene.ts（删除）

- 导出 `loadDesktopScene(directory, version, deviceName): Promise<ChatScene>`。
- 文件名 `chat-scene.json`，内容 `{ scene_id }`；校验 `/^desktop-[a-zA-Z0-9_-]{1,72}$/`；
  非 ENOENT 的读失败直接抛（不静默换身份）；新建走 `.tmp` + rename，目录 0700 文件 0600。
- 返回 `scene_meta = { client: "being-desktop/<version>", scene_label: "桌面·<deviceName>" }`。
- 这套语义已被原生对话层取代：会话即 scene，`ChatSessions` 自己按 `desktopId` 造 scene 名。

### desktop/main/main.ts 的引用点

第 26/27 行 import、第 30 行 `ChatScene` 类型、第 45 行注释里的 `chat/scene.ts` 调用点、
第 72 行 `let proxy`、第 184-188 行（chatScene/chatSceneNotice/new ChatProxy）、
第 190 行 `registerLocalProtocol(assets, proxy)`、第 350 行 snapshot 的 `chatScene` 与
`chatSceneNotice`、第 469 行 save 成功后的 `proxy.abortAll()`、第 653 行退出时的
`proxy.abortAll()`。`net` 与 `os` 另有多处使用，import 保留。
`beings:open-loom`（第 500 行，用 `browser?.open(store.connection.link)`）保留。

### desktop/main/app/protocol.ts

`registerLocalProtocol(assets, proxy)` 里：hostname `chat` 的 `/api/*` 与 `/health` 走代理；
`CHAT_ASSETS = {loom.html, chat.js, highlight.css, chat.css}`；`CHAT_CONTENT_SECURITY_POLICY`
只给 chat 文档。`desktop` hostname 的静态资源路径（`index.html`、路径穿越防护、MIME 表、
`Cache-Control: no-store`）保留。

### desktop/main/app/window.ts

`will-frame-navigate` 里 `chatDocument = protocol==='beings:' && hostname==='chat' && pathname==='/'`
是唯一允许的子 frame 导航例外。删除后规则变成：只有 `shellURL()` 本身可以导航，其余外开。

### desktop/renderer/chat/（整个目录删除，14 个文件）

`main.tsx`、`page.tsx`、`styles.css`、`components/{messages,navigation,panels,settings}.tsx`、
`hooks/use-chat-session.ts`、`models/{chat,scenes}.ts`、
`services/{runtime.js,runtime.d.ts,bridge.ts,history-cache.ts}`。
外部只有两处引用：`app/models/app.ts` 与 `app/components/chat-scene.tsx` 各 import 一个
`type HistoryScope`（`"current" | "all"`）。`conversation/` 与 `shared/` 一行都没引用它，
所以没有"仍被使用的组件需要搬家"这件事。

`models/scenes.ts` 的导出（随目录删除）：`MessageScene`、`HistoryScope`、`messageScene()`、
`sceneName()`、`sceneItems()`、`inCurrentScene()`——历史范围过滤是 Loom 页面的概念，
原生会话没有。

### desktop/renderer/app/ 里依赖 iframe 的部分

- `hooks/use-chat-bridge.ts`（删除）：`app.post` → `frame.contentWindow.postMessage(data, "beings://chat")`；
  接收侧校验 `event.origin === "beings://chat"` 且 `event.source === frame.contentWindow`，
  再按 `revision` 查询参数对齐。处理的消息：`beings:connection`（5 态）、
  `beings:history-scope-state`、`beings:sbs-state`、`beings:open-settings`、`beings:chat-search`、
  `beings:open-place`、`beings:search-index`（≤2000 条、id `^turn-\d+$`、text ≤240），其余交给
  `workspace.receive`。这些入站消息现在全部没有发送方。
- `components/chat-scene.tsx`（删除）：`ChatSceneIndicator`，显示 `chatScene.scene_meta.scene_label`
  与 `scene_id`，下拉切换"当前场景/全部场景"，`#chat-scene-dialog` 详情 + 复制 ID。
  DOM id：`chat-scene-indicator`、`chat-scene-menu`、`chat-scene-dialog`、`chat-scene-id`、
  `copy-chat-scene`。仅 `topbar.tsx` 使用。
- `models/app.ts` 里随之失去写入方的字段：`chatHistoryScope`、`chatHistoryScopeKnown`、
  `changeChatHistoryScope()`、`setChatHistoryScope()`、`sbsEnabled`、`sbsKnown`、`toggleSbs()`、
  `setSbsEnabled()`、`chatAction()`；`frameLoaded()` 里的三条 post
  （`beings:sbs-request`、`beings:history-scope-request`、`beings:search-request`）。
  `chatSource` 保留（连接身份令牌，`use-conversation-bridge` 依赖它触发 reload），
  但不再拼成 `beings://chat/?...` URL。
- `models/workspace.ts` 的封套逻辑：`receive()` 里 `beings:scene-select`（Loom 页面选中消息时发的）、
  `beings:scene-capture` / 回 `beings:scene-captured`、`beings:scene-result`，以及配套的
  `frozen` 字段与 `frameLoaded()`。保留：`beings:scene-draft-result` 分支、`compose()`
  （发 `beings:scene-draft`，由 `use-conversation-bridge` 转成 `conversation.placeDraft`）、
  `clear()`、`returnToSource()`、`enter()`、`connection()`、`snapshot()`、`toggle()`。
- `shared/models/scene.ts` 的封套逻辑：`SceneEnvelope` 类型、`envelopes` 字段、`capture()`。
  保留 `SceneStore` 其余部分（`select`/`pin`/`reference`/`visits`/`history`/`enter`/`update`）。

### 构建与脚本

- `scripts/build-chat.mjs`（删除）：esbuild 打包 `chat/main.tsx` → `desktop/generated/chat.js`；
  复制 `loom.html`、`highlight.js/styles/github-dark.min.css` → `highlight.css`、
  `chat/styles.css` → `chat.css`；删除历史遗留资源；拼 `THIRD-PARTY-LICENSES.txt`
  （marked LICENSE.md、highlight.js / react / react-dom / scheduler 的 LICENSE）。
- `scripts/prepare-desktop.mjs` 第 4 行 `import './build-chat.mjs'`。其余做 Portal 二进制复制与
  runtime bundle。**THIRD-PARTY-LICENSES 的生成必须搬到这里**：`vite.renderer.config.ts` 的
  `publicDir: '../generated'` 会把 `desktop/generated` 整个拷进渲染层产物，而 shell 仍然打包
  marked / highlight.js / react / react-dom / scheduler，法务声明不能跟着 build-chat 一起消失。
- `desktop/generated/` 在 .gitignore 里，当前为空；forge 的 `extraResource` 只列 `resources/*`，
  品牌资源不经 generated 走，`publicDir` 保留即可。
- `package.json` 删 `build:chat`、`test:chat-react`、`test:chat-history`。
- `scripts/test-all.mjs` 删 `chat-react`、`chat-history` 两步（第 66/67 行）。`sbs-refresh` 保留
  为跳过步骤，让报告里看得见。

### 测试

- 删除：`tests/chat-runtime.test.ts`（`ChatProxy` 路由/凭据/SSE）、`tests/chat-scopes.test.ts`
  （`chat/models/scenes` + `chat/services/runtime`）、`tests/chat-scene.test.ts`
  （`loadDesktopScene` + 代理注入 scene）、`tests/chat-react.mjs`、`tests/chat-history.mjs`。
- `tests/chat-reference.test.ts` **也必须删**：它 import `chat/models/chat` 的 `ChatState` 与
  `chat/services/bridge` 的 `createChatBridge`，测的是 iframe 桥而不是 shared 组件，随源码一起走。
- `tests/markdown.test.ts` 保留：只 import `shared/components/markdown`。
- `tests/connection.test.ts` import 了 `upstreamRequest, ChatProxy`：其中 4 个用例测代理，
  需要删除这些用例（文件本身保留，其余用例测 `chat/connection` 的解析与脱敏）。
- `tests/renderer-state.test.ts`：用例 "passes the proxy's exact scene identity…"（第 98 行）
  与 SBS 用例（第 155 行）测的正是本块删除的行为，随之删除；其余用例里 `app.frameLoaded()`
  的调用要改。
- `tests/architecture.test.ts` 里有 `renderer/conversation` 不得 import `renderer/chat/services`
  的规则，目录没了以后规则要改写成"renderer 下不存在 chat 目录"。
- E2E（不进 vitest 门槛）：`tests/electron-smoke.mjs`、`tests/town-sdk.mjs`、
  `tests/portal-runtime-e2e.mjs`、`tests/town-ui.mjs`、`tests/sbs-refresh.mjs` 都用
  `page.frameLocator('#chat-frame')`，全部改成开头跳过并注明原因。
  `tests/client-lifecycle.mjs` 只有一条 iframe 相关的控制台告警白名单和 `#open-loom` 断言，
  不跳过，改注释即可。`tests/menu-keyboard.mjs` 用 stub model 渲染 `Topbar`，
  只需清掉 stub 里 `sbsKnown` 这类死字段。

### 文档

- `desktop/ARCHITECTURE.md`：第 17 行 ChatProxy 条目、第 57 行 7 条路由 + `chat-scene.json`
  段落、第 67 行场景控件段落。
- `README.md` 第 37 行（Loom IndexedDB 缓存）、第 159 行（loom.html 条目）、第 164 行
  （`npm run build:chat` 浏览器用法）；`README_CN.md` 第 154 / 159 行同。
- 根目录 `MIGRATION.md` 追加"P1 完成状态"。

## 进度

| 项 | 状态 |
| --- | --- |
| docs/migration/p1-cleanup.md 阅读摘要 | 已完成 |
| 主进程：proxy.ts / scene.ts 删除，main.ts / protocol.ts / window.ts / shared/types.ts 改写 | 已完成 |
| main/chat/ready.ts：`upstreamRequest` 内联为 `/api/status` 直连 | 已完成 |
| 渲染层：renderer/chat/ 整目录、use-chat-bridge.ts、chat-scene.tsx 删除 | 已完成 |
| 渲染层：app.ts / workspace.ts / scene.ts / topbar.tsx / settings.tsx / styles.css / index.html CSP | 已完成 |
| 根目录 loom.html 删除 | 已完成 |
| 构建与脚本：build-chat.mjs 删除、package.json 三个脚本、prepare-desktop.mjs 接手 THIRD-PARTY-LICENSES、test-all.mjs | 已完成（npm run prepare:desktop 通过） |
| 测试删除：chat-runtime / chat-scopes / chat-scene / chat-react / chat-history / chat-reference | 已完成 |
| 测试改写：connection.test.ts、renderer-state.test.ts、architecture.test.ts、town-names.mjs、menu-keyboard.mjs、client-lifecycle.mjs | 已完成（town-names 与 menu-keyboard 实跑通过） |
| E2E 跳过：sbs-refresh / electron-smoke / town-sdk / portal-runtime-e2e / town-ui | 已完成（五个脚本均实跑 exit 0） |
| 文档：ARCHITECTURE.md / README.md / README_CN.md / MIGRATION.md | 未开始 |
| typecheck + vitest | 通过（463 passed / 16 skipped） |

### 实跑记录

- `npx tsc --noEmit`：通过。
- `npx vitest run`：`Test Files 55 passed | 7 skipped (62)` / `Tests 463 passed | 16 skipped (479)`。
- `npm run prepare:desktop`：通过，`desktop/generated/THIRD-PARTY-LICENSES.txt` 正常生成（7794 字节）。
- `npx vite build --config vite.renderer.config.ts`：通过，271 modules。
- `node tests/menu-keyboard.mjs`、`node tests/town-names.mjs`、`node tests/seed-garden.mjs`、
  `node tests/update-progress.mjs`：PASS。
- 五个 iframe E2E 脚本逐个 `node tests/<name>.mjs`：都在跳过块处 exit 0。

### 本块做出的判断（原任务没写死的地方）

1. **SBS 开关与 `beings:chat-action` 面板**：唯一写入方是 `use-chat-bridge`，删掉之后
   `sbsKnown` 永远为 false、`chatAction` 发给空气。连同 topbar 的隐藏按钮、settings 的
   「模型设置」入口、`renderer-state.test.ts` 的 SBS 用例一起删，而不是留死状态。
2. **历史范围（当前场景/全部场景）**：原生会话没有这个概念，`ChatSceneIndicator` 与
   `HistoryScope` 一并删除。topbar 的 grid 第 1 列空出来，`.topbar-actions{grid-column:3}`
   是显式的，布局不变。
3. **`chatSource`**：保留为"会话界面身份"的变更令牌（`crypto.randomUUID()`），不再拼成
   `beings://chat/?...`。`use-conversation-bridge` 依赖它触发 reload，`sharePortalLogs`
   依赖它判断"是否已连接"。原来断言 URL 参数的用例改写成断言它不含连接信息。
4. **`tests/chat-reference.test.ts` 删除**：它 import 的是 `chat/models/chat` 与
   `chat/services/bridge`，不是 shared 组件。`tests/markdown.test.ts` 保留。
5. **`tests/connection.test.ts` 保留文件、删 5 个代理用例**：其余用例测的是
   `chat/connection` 的链接解析与脱敏，与代理无关。
6. **`tests/town-names.mjs` 的 `/places` 路由删除**：它渲染的 `ChatPlaces` 属于 Loom
   composer，原生 composer 还没有这一排小镇入口。Town 名称/提及部分原样保留并实跑通过。
7. **THIRD-PARTY-LICENSES**：forge 不直接依赖，但 `vite.renderer.config.ts` 的
   `publicDir: '../generated'` 会把它拷进渲染层产物，而 shell 仍打包 marked / highlight.js /
   react / react-dom / scheduler。生成逻辑搬进 `scripts/prepare-desktop.mjs`。
