# U3 迁移单元：Channel 与 Town 后台（P2c）

来源：BeingDesktop 0.8.26 工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop`（只读）。
目标：portal-desktop `desktop/main/town/channel/*.ts` + `tests/town-channel-*.test.ts`。
移植日期：2026-09-16。基线 d5z/portal-desktop main @ 4921932。

本单元只做纯移植，不做集成（IPC 注册、renderer、main.ts 挂钩留给后续阶段）。

## 进度

| 模块 | 来源 | 目标 | 状态 |
| --- | --- | --- | --- |
| 注入接口 | （多处调用面） | `desktop/main/town/channel/types.ts` | 随模块增量补充 |
| 支撑函数 | `src/security.cjs` `src/services.cjs` `src/being-chat.cjs` | `channel/errors.ts` `loom-connection.ts` `sanitize.ts` `sse.ts` | 已移植（随各模块测试通过） |
| ChannelBeing | `src/channel-being.cjs` | `channel/channel-being.ts` | 未开始 |
| TownBackground | `src/town-background.cjs` | `channel/town-background.ts` | 未开始 |
| TownController | `src/town-controller.cjs` | `channel/town-controller.ts` | 未开始 |
| Town catalog/drafts | `src/town.cjs` | `channel/town-catalog.ts` | 测试通过（tests/town-channel-town-catalog.test.ts，18/18） |
| TownPairing 探活 | `src/town-pairing.cjs` | `channel/pairing-probe.ts` | 测试通过（tests/town-channel-pairing.test.ts，7 通过 + 8 skip） |

## 阅读摘要

### docs/channel-sessions.md
- 飞书/微信各自一个「飞书 · Channel」「微信 · Channel」会话；创建发生在首次请求发送前，不改当前会话或草稿。
- 每个 (Being, Desktop, channel) 一个稳定会话 ID；同渠道后续请求复用同一 `scene_id`；重启保持；重命名不变；切 Being 换一组会话。
- 请求从第一条起带 `scene_id`、`scene_meta`、请求关联 ID，不依赖旧的服务端 `session_id`。回复必须属于该 scene，并通过请求 ID、Being、route、channel 校验才能更新状态。
- 202 或中断后不重发；后续状态检查复用同一 scene。
- 已有绑定状态：打开/切换/刷新只读查询，不创建会话、不发 Being 消息、不重新登记。兼容服务端 `ready` 布尔：就绪=已连接，未就绪的已有记录=已登记。
- 无权读 IP Trust / 请求失败 / 结果不明确 → 显示「未能确认」，不判定未绑定；已有确认结果保留。只有用户点「请 Being 核对绑定状态」才发起只读核对任务。

### src/channel-being.cjs（268 行）
导出：`{ChannelBeing, parseChannelOutcome: outcome}`。
常量：
- `RESULT_PROTOCOL = 'being-desktop-channel-result/1'`
- `CHANNELS = Set{'feishu','wechat'}`
- `STATUSES = Set{connected,disconnected,pending,registered,disabled,waiting,expired,error,unknown,unsupported}`
- `MAX_REPLY = 512*1024`、`MAX_QR_BYTES = 256*1024`

辅助：`sequence`（安全整数且 >=0）、`record`（非数组对象）、`fail(code,message)`。
- `request(value)`：必须是纯 `Object.prototype` 原型对象，恰好 2 个 own key `channel`/`connectionRevision` 且都是 data descriptor（getter 直接判无效）；否则 `INVALID_REQUEST '渠道请求格式无效。'`。再校验 revision 与 channel，失败 `INVALID_REQUEST '请选择飞书或微信渠道，并重新检查当前连接。'`。
- `clean(value, secrets)`：非字符串 → ''；逐个 secret split/join '[redacted]'；再 `sanitizeText` 并去掉 `‪-‮⁦-⁩`。
- `qrImage(value)`：只接受 `data:image/(png|jpeg|webp);base64,<b64>`，长度 ≤ MAX_QR_BYTES*1.4，base64 长度 %4==0，round-trip 相等，字节数 1..MAX_QR_BYTES，且魔数匹配（PNG 89504E470D0A1A0A / JPEG FFD8FF / WEBP RIFF....WEBP）。
- `qrUrl(value, secrets)`：长度 ≤4096、不含 secret（含 encodeURIComponent 形式）；https、无 user/pass、端口空或 443、hostname ∈ {beings.town, weixin.qq.com, wx.qq.com, open.weixin.qq.com}。
- `outcome(reply, channel, secrets, expected=null)`：先 trim；支持 ```json fenced；JSON.parse 失败则 data=undefined。
  - 若有 expected 且（非对象 / protocol 不符 / requestId 不符 / route 不符 / beingId 不符 / channel 不符 / 出现白名单外字段）→ `{channel,status:'unknown',detail:'渠道回复无法对应本次功能任务，连接结果尚未确认。请稍后检查状态。'}`。白名单字段：protocol,requestId,route,beingId,channel,status,detail,qrCodeUrl,qrCodeDataUrl。
  - 否则若非对象 / channel 不符 / status 不在 STATUSES / detail 非 string → `{channel,status:'unknown',detail: clean(reply,secrets) || 'Being 已回复，连接状态仍待确认。'}`。
  - 正常：`{channel,status,detail: clean(detail)||'Being 已返回渠道处理结果。'}`；status ∉ {connected,disconnected,disabled,expired} 时附 qrCodeDataUrl（优先）或 qrCodeUrl。
- `prompt(operation, channel, expected)`：begin/status 两段固定中文任务描述；整体模板含 `[Being Desktop Town sync:<requestId>]` 前缀、`当前 Being：<beingId>；任务路线：<route>。`、JSON 协议模板。

`class ChannelBeing`：
- 构造 `{getContext, getSession=null, readStatus=null, fetchImpl=globalThis.fetch, onChange=()=>{}, onRequest=null}`；类型校验失败 `Error('Being 渠道连接配置无效。')`。
- 内部：`_epoch=0`、`_active=null`、`_sessions=Map`、`_sessionOwner=''`、`_inspections=Set`、`_state={channel:'',status:'unknown',detail:''}`。
- `state()` 返回浅拷贝；`_set(status,detail,channel,qrCodeDataUrl)` 覆盖 `_state`（qr 为空则不带该键），调用 onChange（吞异常）。
- `reset()`：epoch++、abort active、abort 全部 inspections、清 sessions/owner、`_set('unknown')`。
- `_context(revision, expected)`：要求 configured && connected && !exiting && connection.url && sequence(connectionId) && beingName 匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`，否则 `NOT_CONNECTED '请先连接 Being 并等待会话加载完成。'`；snapshot = {connectionId, identityRevision, beingName, url, epoch}；revision 不等或 expected 快照任一字段变化 → `SESSION_CHANGED '连接身份已变化，请在当前 Being 下重新操作。'`。
- `beginChannelConnection(v)` → `_run('begin', …)`；`getChannelStatus(v)` → `_run('status')` 并返回 `{...result, channels:[result]}`；`updateFeishuCredentials()` 永远抛 `INVALID_REQUEST '应用密钥须在渠道服务的专用配置入口提交，请按 Being 返回的连接说明操作。'`。
- `inspectChannelStatus(v)`：只读；无 readStatus → `SERVICE_ERROR '暂时无法读取渠道状态。'`；用 AbortController + `AbortSignal.timeout(15000)`，前后各校验 context，finally 从集合移除并 abort。
- `_qrImage(url, controller, revision, snapshot)`：GET，Accept image/png,image/jpeg,image/webp，credentials omit，redirect error，no-referrer，no-store；拒绝 !ok/redirected/非三种 mime/content-length > MAX_QR_BYTES；流式读取，超 MAX_QR_BYTES 返回 ''；成功返回 `qrImage('data:<mime>;base64,…')`。任何异常 → 仍校验 context 后返回 ''。
- `_run(operation, channel, revision)`：`_active` 非空 → `BUSY 'Being 正在处理渠道请求，请等待结果后再操作。'`；owner=JSON.stringify([beingName,url,identityRevision])，owner 变化清空本地 sessions；session 来源 getSession 或本地 Map（本地会生成 `desktop-channel-<uuid>-<channel>`）；sceneId 必须匹配 `^[A-Za-z0-9_-]{1,200}$`，否则 `NOT_CONNECTED '渠道会话尚未准备好，请等待 Being 连接完成。'`。
  - `expected={requestId:randomUUID(), route:'/desktop/channel/<channel>/<operation>', beingId:beingName}`；secrets=[token,secret].filter(Boolean)；先 `_set('working','Being 正在处理渠道任务…',channel)`。
  - 动态 import BeingClient，fetch 包装：每次先 `_context`；aborted → SESSION_CHANGED；首次发送前调用 `onRequest({...expected, prompt})` 并再次校验；随后 body 注入 `scene_id`、`scene_meta.scene_label`（feishu→'飞书 · Channel'，wechat→'微信 · Channel'）、`client_ref=requestId`。
  - onEvent：`meta` 记 currentScene；其它事件 scene 不符直接忽略；`content_block_delta` 累积 delta.text，超 MAX_REPLY → abort + `INVALID_RESPONSE 'Being 返回的渠道结果过长，请查看原对话。'`；`message_stop` 时若 reply.trim() 非空则 latestReply=reply，reply 清空。
  - `response.accepted` → `{channel,status:'pending',detail:'请求已发送给 Being；Being 正在处理其他消息，渠道结果尚未确认。稍后可手动检查状态。'}`；否则 `outcome(latestReply, channel, secrets, expected)`。
  - 若 result.qrCodeUrl：下载图片，删除 qrCodeUrl；成功设 qrCodeDataUrl，失败在 detail 追加 `\n扫码图像暂时无法读取，可稍后检查渠道状态。`。
  - catch：auth 判定 = `error.message === '连接凭据无效或已过期，请更新 Loom 连接地址。'`；code = auth ? AUTH_REQUIRED : (sent && operation!=='status') ? RESULT_UNKNOWN : SERVICE_ERROR。
  - finally：abort controller；`_active` 仍是本次则置 null。

### src/town-background.cjs（249 行）
导出 `{TownBackground}`。依赖 `TownRefresh`（本单元注入）。
- `invalid(message='请选择有效的 Town 消息来源。')` → code `INVALID_REQUEST`。
- `requestDto(value)`：纯对象；必须有 data-descriptor `kind`；bonfire 时 own key 恰为 ['kind']，否则恰为 ['kind','firesideId']；bonfire → `{kind:'bonfire',firesideId:''}`；fireside 要求 firesideId 匹配 `^[1-9]\d{0,15}$` 且 `Number.isSafeInteger(Number(id))`。
- 构造：`{townSession, getIdentity, readCachedSnapshot=null, direct=false, limit=10, bonfireCache=null, getCacheKey=()=>'', onUpdate=()=>{}, onStatus=()=>{}, clock={}}`；readCachedSnapshot 非函数非 null → `TypeError('Invalid Town cache reader')`。
- `_create(kind, firesideId)` 造 TownRefresh：`automatic = direct || Boolean(readCachedSnapshot)`、`cached = Boolean(readCachedSnapshot)`、`pageable = direct`；readSnapshot 走 readCachedSnapshot 或 `_requestRead`；onSuccess 在 current() && bonfireCache && identityKey 未变时 `bonfireCache.save(key, value)`（吞错）。
- `notifyEvent(event)`：仅 direct && enabled；`hello` 展开成 ['bonfire','fireside']；每个 reader 打 `_townDirty`，250ms setTimeout 合并（`unref?.()`），循环直到不 dirty；generation / enabled / room 变化则 break。
- `_requestRead`：bonfire → `townSession.getBonfireMessages({limit,[since]},{signal})`；fireside → `townSession.getFiresideMessages({firesideId,limit,[since]},{signal})`。
- `_cacheKey(kind,id)`：`getCacheKey()` 为空则空；bonfire 用原 key，fireside 用 `${key}:fireside:${id}`。
- `_envelope`：`{kind, firesideId, snapshot, status}`；snapshot 无 identity 且 messages 为空时补 `getIdentity()`。
- `metadata()`：`{bonfire: status, fireside: room?.status() || null}`。
- `lifecycle({enabled, reason='offline'})`：identity key 变化 → 停/重置 bonfire、clearRoom、`_allowedRooms=null`、cacheGeneration++、按 cacheKey 载入缓存（generation/identity/cacheKey 全部未变才 restoreCache）。next = Boolean(enabled && identity)；相同则 return；对 bonfire/room：启用时若有 restore promise 且未 running 则等它再 `_start`，否则直接 `_start`；停用则 `pause(reason)`。
- `_start(reader)`：running 则 resume 否则 start。
- `restore()`：循环 await `_restorePromise` 直到稳定。
- `clearRoom()`：roomGeneration++、清 promise/room/roomId、stop+reset 旧 reader、通知 onStatus。
- `reconcileRooms(rooms)`：ids = owned+joined 的 String(id) 集合；当前房间不在集合内则 clearRoom。
- `_select(value)`：fireside 且 `_allowedRooms` 不含 → `AUTH_REQUIRED '当前 Being 已无法访问此围炉，请刷新围炉目录。'`；切换房间时新建 reader 并按 cacheKey 载入缓存后 `_start`。
- `snapshot(v)`、`cachedSnapshot(v)`（等待 restore 后 `_assertCurrent`）。
- `_assertCurrent`：identity 变化或房间变化 → `SESSION_CHANGED '连接身份或选定围炉已变化，请重新读取消息。'`。
- `refresh(v)` / `requestRead(v)` → `_refresh(v, explicit)`；未 enabled → `NOT_CONNECTED '连接 Being 后再刷新 Town 消息。'`；explicit && readCachedSnapshot 时走 `reader.requestRead(fn)`，否则 `reader.refresh()`。
- `loadOlder(v)`：未 enabled → `NOT_CONNECTED '连接 Being 后再读取更早的消息。'`；`reader.loadOlder()` 后再校验。
- `stop()`：enabled=false，两个 generation++，停 bonfire 与 room。

### src/town-controller.cjs（174 行）
导出 `{TownController, requireTownIdentity}`。
- `AUTH_MESSAGE = '连接 Being 后，可在「设置 → 连接」中一键连接 Town，或使用六位配对码。'`
- `DEPLOY_ERRORS`：11 条可直接透出的部署错误文案。
- `dataObject(value, keys)`：纯对象 + own key 集合与 keys 完全一致且都是 data descriptor，否则 null。
- `confirmedDeployment(value)`：`{confirmed:true, permissions:{files:true, exec:false, web:false}}` 才算确认。
- 构造：`{installer, portal, getContext, saveDeployment, startPortal, defaultWorkspace='', onChange=()=>{}, platform=process.platform, arch=process.arch, configFactory=createPortalConfig, inspectInstallation}`；`inspectInstallation` 缺省 `()=>installer.inspect()`；`release = installer.release || portalRelease(platform,arch) || PORTAL_RELEASE`；`installation = {status:'unknown',phase:'idle',version:release.version,verified:false,started:false,detail:''}`。
- `state()`：identity/access/accessDetail/portalInstall/portalWorkspace/platformSupported/automaticKitInstallation；access.channel/bonfire 随 connected，fireside 与 groveRegistration 恒 `auth_required`，grove 恒 `ready`，sendAs 恒 `'being'`。
- `refresh()`：非部署中时 `installer.inspect()`，成功 `_update({...installation,detail:''})`，失败 `{status:'error',detail:'无法检查本机 Portal 安装，请确认目录权限。'}`；总是返回 `state()`。
- `deploy(value)`：未确认 → reject `Error('请确认当前设备、工作区与部署权限。')`；已有 `_deploying` 直接返回同一 promise；否则 `_revision++` 并执行 `_deploy()`。
- `_requireCurrent(context)`：configured/connected/!exiting，且 connectionId/identityRevision/beingName/portalWorkspace/portalExecutable/portalConfig 全等，否则 `'连接或工作区已变化，Portal 已安装但未启动。'`。
- `_deploy()` 分支顺序：平台不支持 → 抛；未连接 → 抛；`portal.inspect()` → `_requireCurrent`；external → `{status:'external'}`；portal error → 抛 detail；owned（含 portalIdentityRevision 不符 → existing_connection）→ `{status:'running'}`；managed 一致 → 核对安装+配置后启动；有 portalExecutable/portalConfig → existing_configuration；否则全新安装。失败路径构造 `recovery:{program,configuration,process}`。
- `requireTownIdentity()`：恒抛 `'Desktop 暂不支持创建或加入围炉，请通过 Being 完成。'`。

### src/town.cjs（170 行）
导出 `{getTownCatalog, townPageUrl, prepareTownFeature, prepareTownAssistance, prepareFiresideDraft, prepareLoomDraft}`。
- `SOURCE_URL='https://beings.town/'`、`CHECKED_AT='2026-09-06'`、`DOCUMENT_ID_PATTERN`（UUID v4）。
- `FEATURES`：9 条冻结记录（scroll/ember/bonfire/fireside/beings/grove/portal/channel/workspace），字段 id/name/label/description/group/mode[/url]。
- `PUBLIC_PAGES`：home/grove/ember 三个公开页。
- `DRAFTS`：scroll/search/browse/fireside/beings/workspace 六条固定草稿。
- `ASSISTANCE`：portal-setup/fireside-list/fireside-create/fireside-join/fireside-send/grove-register 六条。
- `validateId`：`^[a-z]{1,16}$`，否则 `'无效的 Town 功能。'`。
- `townPageUrl`：无公开页 → `'此 Town 功能没有已确认的独立网页。'`。
- `fixedDraft`：无草稿 → `'此 Town 功能不能填入会话草稿。'`。
- `requireCurrentContext` / `requireCurrentFrame` / `prepareLoomDraft`：Electron WebContents 注入 Loom 页面填草稿（本单元按注入的 contents/frame 抽象移植）。
- `prepareFiresideDraft`：严格 2 字段 `{draft, connectionRevision}`，draft 非空且 ≤32000；`context.generation !== connectionRevision` → `'连接身份已变化，草稿未转交，请在当前身份下重新确认。'`；前缀固定中文提示 + `\n\n` + draft。

### src/town-pairing.cjs（101 行）
导出 `{TownPairing, PAIR_PROMPT}`。
- `PAIR_PROMPT`：要求 Being 用自己的原生 http 工具 POST `https://beings.town/api/client/pair`，只回六位大写字母数字 code。
- `errors`：BUSY / NOT_CONNECTED / SESSION_CHANGED / READINESS_UNKNOWN / PAIRING_INCOMPLETE 五条固定中文。
- 构造 `{getContext, client, fetchImpl=globalThis.fetch, onChange=()=>{}, timeoutMs=90000, createScene=()=>'desktop-<uuid>-<uuid>'}`；state `{status:'idle',busy:false,errorCode:''}`。
- `connect()`：busy 或 `client.pairing` → BUSY；`client.store.assertAvailable?.()`；`client.state().pairingPending` → `client.retryPairStorage()`；无 token → NOT_CONNECTED。
- 探活：GET `/api/stream/active?token=`；204 视为空闲；否则必须 ok + JSON 且 `finished === true`，非 JSON/非 ok → READINESS_UNKNOWN，finished 非 true → BUSY。
- 发送：POST `/api/chat/stream`，body `{message:PAIR_PROMPT, scene_id, session_id, client_ref, scene_meta:{client:'being-desktop',scene_label:'Town 配对'}}`；!ok / 202 / 非 SSE → PAIRING_INCOMPLETE。
- 读流：`consumeEvents`；meta 记 scene；异 scene 忽略；error → failed；text 累积 >2000 → PAIRING_INCOMPLETE；`message_stop`/`done` 置 complete，若未 failed 且 `^[A-Z0-9]{6}$` 则抛哨兵提前收尾。
- 结束校验：aborted/failed/!complete/非六位码 → PAIRING_INCOMPLETE；否则 `client.pair({code})`，`_set({status:'complete'})`。
- catch：`code = error.code || (dispatched ? 'PAIRING_INCOMPLETE' : 'READINESS_UNKNOWN')`，`_set({status:'manual_required', errorCode:code})`。
- finally：cancel body、abort、清 controller 并 `_set({busy:false})`。

### 支撑依赖（BeingDesktop 内部，本单元需要本地副本）
- `src/security.cjs` → `parseConnection`（Loom 连接解析，返回 `{url, apiBase, token, secret, displayUrl, beingName}`）、`sessionPartition`（`persist:loom-v1-<sha256前32>`）。
- `src/services.cjs` → `sanitizeText(value, secrets=[])`：去 ANSI、redact secrets（≥4 字符）、URL 去凭据与查询、header/Bearer/token=… redact、sk-/JWT/长 hex/长 base64 redact、去控制字符、截断 2000。
- `src/being-chat.cjs` → `consumeEvents(body, onEvent)`：SSE 行解析，`MAX_BYTES = 4*1024*1024`，超限 `INVALID_RESPONSE`；截断尾事件丢弃；finally cancel reader。
- `extensions/being-anywhere/being-client.mjs` → `parseConnection`（更严格版本）、`consumeSSE`、`BeingClient.request/send`。`send` 的 202 → `{accepted:true}`；非 SSE → `response`；结束时必须见过 `message_stop` 且无未完成回复，否则 `stream` 错误（文案 `'Being 的回复中断，请查看已有内容后再决定是否重试。'`）。auth 文案 `'连接凭据无效或已过期，请更新 Loom 连接地址。'`。

### portal-desktop 既有 `desktop/main/town/pairing.ts`（目标侧，只读参考）
- 导出 `requestTownPairCode(connection, requestId, signal, fetcher = fetch): Promise<string>`。
- 自己解析 SSE（CR/LF/CRLF、event:/data:）；POST `${connection.endpoint}/api/chat/stream?token=…`，body `{message: townPairPrompt, session_id:'town-pair-<id>', scene_id:'town-pair-<id>', scene_meta:{client:'portal-desktop', scene_label:'Town 配对'}}`。
- 与 BeingDesktop 不同：无探活（readiness probe）、无 `client.pair`、错误文案统一以「请使用手动配对。」结尾、上限 8192 字符 / 1MB、要求回复里恰好一个 6 位码。
- 结论：**不修改它**。BeingDesktop `town-pairing.cjs` 的探活与状态判定移植为 `channel/pairing-probe.ts` 的纯函数。

### portal-desktop 既有 `desktop/main/town/live.ts`（目标侧，只读参考）
- `class TownLive`，构造为位置参数注入：`(getToken, getExpectedBeing, publish, fetcher = fetch, origin = TOWN_ORIGIN, getDisplay = () => '')`。
- 风格样本：`private` 字段、构造函数参数属性、`Data = Record<string, unknown>`、`object()` 守卫、中文面向用户文案、英文注释、单引号 2 空格。

### portal-desktop 既有 `desktop/shared/town-pairing.ts`
- 只导出 `townPairPrompt`（措辞与 BeingDesktop `PAIR_PROMPT` 不同，**不要改它**；本单元用自己的常量）。

### 目标工程约定（tsconfig / vitest.config / tests/architecture.test.ts）
- `strict: true`、target ES2022、module ESNext、moduleResolution Bundler、`noEmit`；include `desktop/**/*.ts`、`tests/**/*.ts`。
- vitest 只收 `tests/**/*.test.ts`；`npm run typecheck` = `tsc --noEmit`。
- architecture.test.ts 扫 `desktop/{main,preload,renderer,shared}`：renderer 不得 import main/preload/electron/node；main/preload 不得 import renderer；shared 不得 import 任何层或 electron/node。**main 层可以 import node: 内置模块**（本单元只用 `node:crypto` 的 randomUUID；能注入就注入）。
- 主进程风格：单引号、2 空格、`private` 字段 + 构造函数参数属性、`Data = Record<string, unknown>` 守卫函数、中文用户文案 + 英文注释。
- 测试风格：`import { expect, it, vi } from 'vitest'`；本单元按指令统一用双引号（`tests/architecture.test.ts` 即双引号先例）。

### src/town-pairing.cjs 补充细节（逐行移植必需）
- `fail(code) = Object.assign(new Error(errors[code]), {code})`。
- `_context(expected)`：`getContext()` → 要求 `connected && connection`；`parseConnection(value.connection.url || value.connection)`；context = `{connection, key: sessionPartition(connection), revision: value.revision, epoch: this._epoch}`；expected 存在且 key/revision/epoch 任一不同 → SESSION_CHANGED。
- `reset()`：epoch++、abort、controller=null、`_set({status:'idle',busy:false,errorCode:''})`。
- `connect()` 顺序：busy||client.pairing → BUSY；`_context()`；`client.store.assertAvailable?.()`；`client.state().pairingPending` → `return client.retryPairStorage()`；无 token → NOT_CONNECTED；建 AbortController + `AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])`。
- `url(route)` = `new URL(connection.apiBase + route)` 且 `searchParams.set('token', connection.token)`；`options = {signal, credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', cache:'no-store'}`。
- `_set({status:'requesting', busy:true, errorCode:''})` 在探活之前。
- 探活：`GET url('/api/stream/active')`；try 内 `_context(ctx)`；`status !== 204` 时要求 ok + content-type 含 `application/json`，否则 READINESS_UNKNOWN；`data.finished !== true` → BUSY；**finally 一定 cancel body**。
- 之后 `_context(ctx)`；`signal.aborted` → READINESS_UNKNOWN；`scene = createScene()`；再 `_context(ctx)`；`dispatched = true`；POST。
- POST 后 `_context(ctx)`；`!ok || status === 202 || content-type 不含 text/event-stream` → PAIRING_INCOMPLETE。
- 流内：每个事件先 `_context(ctx)`；`signal.aborted` → PAIRING_INCOMPLETE；`meta` 记 `current = data.scene_id`；`eventScene = data.scene_id ?? current`，≠scene 直接 return；`error` → failed=true；delta 取 `content_block_delta` 的 `data.delta?.text`，或 `['text','text_delta']` 的 `data.text ?? data.delta`；有 delta 则 `text += delta; complete = false`；`text.length > 2000` → PAIRING_INCOMPLETE；`['message_stop','done']` → `complete = true`，若 `!failed && /^[A-Z0-9]{6}$/.test(text.trim())` 则 **throw 哨兵对象 replyComplete**（catch 里只吞这个哨兵）。
- 收尾：`_context(ctx)`；`aborted||failed||!complete||码不合法` → PAIRING_INCOMPLETE；`client.pair({code})`；`_context(ctx)`；`_set({status:'complete', errorCode:''})`；返回 pair 的结果。
- catch：**先 `_context(ctx)`（可能抛 SESSION_CHANGED 覆盖原错误）**；`code = error.code || (dispatched ? 'PAIRING_INCOMPLETE' : 'READINESS_UNKNOWN')`；`_set({status:'manual_required', errorCode: code})`；`throw errors[code] ? fail(code) : error`。
- finally：cancel response body、abort controller、若 `_controller === controller` 则置 null 并 `_set({busy:false})`。

### 支撑函数的精确实现（已抄录，后续不必再读原文件）
`src/security.cjs`：
- `SESSION_IDENTITY_VERSION = 'v1'`。
- `parseConnection(input)`：非 string 或 >8192 → `'请输入有效的 Loom 连接地址。'`；`new URL(input.trim())` 失败 → `'连接地址格式不正确。'`；local = hostname ∈ {127.0.0.1, localhost, [::1]}；非 https 且非（http+local）或有 username/password → `'Loom 地址须使用 HTTPS；本机回环地址可使用 HTTP。'`；`url.hash=''`；`api = new URL(searchParams.get('api') || `${origin}${pathname.replace(/\/+$/,'')}`)`；api.origin≠url.origin 或 api.search/hash/username/password → `'Loom 和 API 必须位于同一来源，避免将连接凭据发送到其他网站。'`；`token = searchParams.get('token') || ''`；`secret = relay_secret || secret || token`；返回 `{url: url.href, apiBase: api.href.replace(/\/+$/,''), token, secret, displayUrl: `${origin}${pathname}`, beingName: decodeURIComponent(pathname.split('/').filter(Boolean).pop() || 'Being')}`。
- `sessionPartition(connection)`：`identity = JSON.stringify(['v1', displayUrl, apiBase, token, secret])`；返回 `persist:loom-v1-<sha256(identity) hex 前32>`。

`src/services.cjs` `sanitizeText(value, secrets = [])`：`String(value ?? '')` → 去 ANSI `/\x1b\[[0-?]*[ -/]*[@-~]/g` → 对每个长度≥4 的 string secret split/join `[redacted]` → URL 正则 `\b(?:https?|wss?):\/\/[^\s<>"']+` 去 username/password/search/hash（URL 解析失败用 `[redacted URL]`）→ header/Bearer/`key=value`/`sk-`/JWT/`[a-f0-9]{32,}`/`[a-zA-Z0-9_+/=-]{48,}` 依次 redact → 去控制字符 `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]` → `slice(0, 2000)`。

`src/being-chat.cjs`：
- `MAX_BYTES = 4*1024*1024`；`MESSAGES`：NOT_CONNECTED `'请先连接 Being。'`、SESSION_CHANGED `'Being 连接已变化，旧请求已取消。'`、INVALID_REQUEST `'请求参数无效。'`、INVALID_RESPONSE `'Being 返回格式无效。'`、NETWORK_ERROR `'与 Being 的连接中断，请稍后重试。'`、SERVICE_ERROR `'Being 服务暂时不可用。'`、AUTH_REQUIRED `'Being 连接凭据无效，请重新连接。'`、ABORTED `'请求已取消。'`、RESULT_UNKNOWN `'发送结果未确认，请刷新后核对再决定是否重发。'`。
- `consumeEvents(body, onEvent)`：无 body → INVALID_RESPONSE；`TextDecoder('utf-8',{fatal:true})`；行分隔 `/\r\n|\r(?!$)|\n/`；空行 flush（`JSON.parse(data.join('\n'))` 失败 → INVALID_RESPONSE，`onEvent(type || 'message', parsed)`）；`:` 开头忽略；`event:`/`data:`（去一个前导空格）；单事件累计 size 或 `pending.length + size` 超 MAX_BYTES → INVALID_RESPONSE；**截断的尾事件丢弃**；finally cancel reader。

### test/town-pairing.test.cjs（157 行，13 个 test）
前 7 个（第 25–86 行）测的是 **TownClient**（`src/town-client.cjs`），不属于本单元 → 以同名 `it.skip` 保留并记入 openIssues：
1. `current SDK confirm response persists Town ID and display without requiring removed being_id`
2. `Town-prefixed identities use the town_id confirm field`
3. `a saved Town binding is checked even before the background stream has loaded it`
4. `invalid or conflicting confirm identities cannot replace saved credentials`
5. `a new token survives storage failure in memory and retry never consumes another code`
6. `pair errors distinguish consumed-code uncertainty, invalid code, and rate limit without retry`
7. `changing Being while confirm is pending cannot save or publish its response`
8. `credential diagnostics distinguish missing, unreadable and unavailable storage without secrets`
（共 8 个 TownClient 用例，第 101 行起才是 TownPairing。）

TownPairing 的 5 个用例（全部移植）：
9. `one click pairs once from a complete, scene-bound reply and exposes no code or credential`
10. `content_block_delta supports fragmented codes and ignores reasoning and tool results`
11. `foreign, unscoped, incomplete, ambiguous and errored replies never authorize a client`
12. `202 queues only one request and falls back without extracting or resending`
13. `busy Being and unavailable safe storage block before sending a chat message`
14. `concurrent clicks and switching Being cannot confirm a stale code`
15. `a timeout ignores a late response and never repeats the chat or confirm request`
（TownPairing 实为 7 个用例；合计 15 个 test。）

`pairingFixture({events, response, active = () => new Response(null,{status:204}), timeoutMs = 90000})`：
- context = `{connected: true, connection: 'https://echo.example/alice?token=loom-fixture', revision: 1}`。
- client 假对象 = `{store:{assertAvailable(){}}, state: () => ({}), pair: async value => {pairs.push(value); return {paired:true};}}`。
- fetchImpl：`/active` → `active()`；否则若有 `response` 用它；否则从 body 取 `scene_id`，默认帧 `[['meta',{scene_id}],['text',{text:'AB0'}],['text',{text:'1XY'}],['done',{}]]`，拼成 `event: X\ndata: {...}\n\n` 的 `text/event-stream` Response。
- `switch()`：context → `{revision: 2, connection: 'https://echo.example/bob?token=other'}` 并 `pairing.reset()`。
- `json(value, status=200)`、`tick = () => new Promise(r => setImmediate(r))`。

### src/town.cjs 补充细节（逐行移植必需）
- `requireCurrentContext(getContext, expected)`：`contents = current.view?.webContents`；`exiting || !connection || !configured || status !== 'connected' || !contents || contents.isDestroyed()` → `'请先连接并等待 Loom 会话加载完成。'`；expected 存在且 generation/revision/view/connection 任一不同 → `'Loom 会话已变化，请重新选择 Town 功能。'`；`contents.isLoadingMainFrame()` → `'Loom 页面正在加载，请稍后重试。'`；返回 current。
- `requireCurrentFrame(contents, frame)`：`!frame || frame.isDestroyed() || frame.detached || contents.mainFrame !== frame` → `'Loom 页面已变化，请重新选择 Town 功能。'`。
- `prepareLoomDraft(prompt, getContext)` 步骤：
  1. `initial = requireCurrentContext(getContext)`；`expected = new URL(initial.connection.displayUrl)`；`contents = initial.view.webContents`；`frame = contents.mainFrame`；`requireCurrentFrame`。
  2. `currentUrl = new URL(contents.getURL())`；`normalizedPath = v => v.replace(/\/+$/,'')`；origin 或规范化 pathname 不符 → `'当前页面不是已连接的 Loom 会话。'`。
  3. `identity = {origin, path}`；再 `requireCurrentContext(getContext, initial)` + `requireCurrentFrame`。
  4. `frame.executeJavaScript(...)` 取/写 `document.documentElement.dataset.beingDesktopTownDocument`（`crypto.randomUUID()`），异常 → `'无法确认 Loom 当前文档，请检查会话后重试。'`。
  5. 再校验两次；`documentId` 非 string 或不匹配 `DOCUMENT_ID_PATTERN`（UUID v4）→ 同一条文案。
  6. `input = JSON.stringify({prompt, ...identity, documentId})`；第二段脚本同步校验 marker + `#app`/`#messages`/`#input-row`/`#input`(TEXTAREA)/`#send-btn` 的包含关系与 disabled/readOnly，返回 `'wrong_document' | 'missing_input' | 'existing_draft' | 'prepared'`；异常 → `'无法填入 Loom 草稿，请检查会话后重试。'`。
  7. 再校验两次；`existing_draft` → `'Loom 中已有草稿，已保留原文；请先发送或清空后再选择此功能。'`；非 `prepared` → `'未找到可用的 Loom 输入框，草稿未填入。'`；成功返回 `{prepared:true}`。
- `prepareTownFeature(id, getContext)` = `prepareLoomDraft(fixedDraft(id), getContext)`。
- `prepareTownAssistance(value, getContext)`：严格 1 字段 `{operation}`（data descriptor），且 `ASSISTANCE.has(operation)`，否则 `'请选择有效的 Being 协助操作。'`。
- `prepareFiresideDraft(value, getContext)`：严格 2 字段 `{draft, connectionRevision}`；`draft` 为非空 string 且 ≤32000；`connectionRevision` 为 `Number.isSafeInteger` 且 ≥0；否则 `'请填写有效的围炉协助草稿。'`。随后 `requireCurrentContext(getContext)`；`context.generation !== connectionRevision` → `'连接身份已变化，草稿未转交，请在当前身份下重新确认。'`；前缀文案见源码第 166 行。
- 注入化方案：`WebContentsLike { isDestroyed(); isLoadingMainFrame(); getURL(); mainFrame }`、`WebFrameLike { isDestroyed(); detached; executeJavaScript(code) }`，不 import electron。

### test/town.test.cjs（278 行，17 个 test）
`fixture({draft='', readyState='complete', url='https://loom.example/being/?token=not-for-the-catalog'})`：
- `field = {tagName:'TEXTAREA', value:draft, disabled:false, readOnly:false, dispatchEvent(e){events.push({type,bubbles}); return true;}, focus(){events.push({type:'focus'});}}`；`send = {click(){submissions++;}}`；`messages = {}`；`row.contains(v) = v===field||v===send`；`app.contains(v) = v===row||v===messages`。
- `sandbox = {document:{readyState, documentElement:{dataset:{}}, getElementById(id)}, location:new URL(url), crypto:{randomUUID}, Event: class{...}}`，脚本用 `vm.runInNewContext(script, sandbox)` 执行。
- `connection = {displayUrl:'https://loom.example/being/', url}`；`frame = {isDestroyed:()=>false, detached:false, async executeJavaScript(script){assert.equal(this, frame); executions++; return vm.runInNewContext(...);}}`（**断言 this === frame**）。
- `contents = {mainFrame:frame, isDestroyed:()=>false, isLoadingMainFrame:()=>false, getURL:()=>url, executeJavaScript(){assert.fail('Drafts must execute on the captured frame, not WebContents');}}`。
- `context = {connection, view:{webContents:contents}, generation:4, revision:2, configured:true, status:'connected', exiting:false}`；`getContext:()=>({...context})`；`change(patch)`。

用例名（顺序）：
1. `Town catalog exposes nine navigation features and only public static URLs`
2. `Town public page whitelist rejects URLs, credential parameters and prototype keys`
3. `draft preparation rejects unknown and non-being IDs before evaluating page code`
4. `each Being feature fills a fixed draft and only emits input without sending`
5. `moved capabilities retain legacy draft IPC without restoring old navigation entries`
6. `Channel and Bonfire cannot fall back to asking Being through legacy draft IPC`
7. `each native module assistance operation prepares only its fixed draft without sending`
8. `module assistance preserves existing drafts and requires a connected Loom document`
9. `module assistance rejects arbitrary prompts, extra keys and accessor objects before page evaluation`
10. `Fireside handoff treats the exact user draft as data and only fills a Loom draft`
11. `Fireside handoff strictly validates its two data fields without invoking accessors`
12. `Fireside handoff preserves existing Loom drafts and rejects stale connection revisions`
13. `Fireside handoff rejects a connection change during the document handshake before filling text`
14. `existing text and whitespace drafts are preserved with no input or focus event`
15. `draft requires an active editable Loom document with the known structure`
16. `disconnected, loading, exiting and foreign pages never receive a draft script`
17. `an asynchronous result from an old view, generation or document is never accepted`
18. `page execution errors cannot leak page content or secrets through the native error`
（实为 18 个 test。）
