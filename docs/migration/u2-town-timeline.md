# U2 · Town timeline accumulation & encrypted caches (P2b)

Port unit: BeingDesktop 0.8.26 -> portal-desktop TypeScript. Source tree (read-only):
`/Users/d5c/Documents/ChatGPT/BeingDesktop`. Target: `desktop/main/town/timeline/*`, tests
`tests/town-timeline-*.test.ts`. Port date 2026-09-16.

## 阅读摘要

### 环境（portal-desktop 基线 4921932）
- `desktop/main/app/settings.ts:8` 已有
  `export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }`
  —— 加密缓存用它注入。`TownClientStore` 另需可选 `getSelectedStorageBackend?(): string`，
  在 timeline/types.ts 里用 `TownSecretStorage extends SecretStorage` 扩展。
- tsconfig: strict, target ES2022, module ESNext, moduleResolution Bundler, types node+vite/client.
- vitest.config.ts: `test: { include: ['tests/**/*.test.ts'] }`.
- tests/architecture.test.ts: main 层**允许** node: 内置与 electron；只禁止 main->renderer。
  所以 `node:fs/promises` / `node:path` / `node:crypto` 可以直接 import。
- `desktop/main/town/` 已存在 client.ts / ipc.ts / live.ts / pairing.ts（portal-desktop 自有，勿动）。

### BeingDesktop main.cjs 注入面（后续集成阶段机械对接）
- `new TownClientStore({directory: path.join(userData,'town-client'), safeStorage})` (main.cjs:373)
- `new BonfireCache({directory: path.join(userData,'bonfire-cache'), safeStorage})` (main.cjs:436)
- `new TownDataCache({directory: path.join(userData,'town-data-cache'), safeStorage})` (main.cjs:444)
- `new TownCachedReads({cache: townDataCache, getContext: () => ({identityKey, revision, identityRevision, connected})})` (main.cjs:445)
- `TownRefresh` 不在 main.cjs 直接 new：由 `src/town-background.cjs:45` 构造
  `new TownRefresh({getIdentity, clock, limit, automatic: direct||Boolean(readCachedSnapshot), cached: Boolean(readCachedSnapshot), pageable: direct, ...})`
  —— TownBackground 属于另一个单元/后续阶段，这里只提供 TownRefresh 本体。

### src/town-refresh.cjs（531 行）→ timeline/refresh.ts
导出 `{TownRefresh}`。
常量：`MIN_INTERVAL=60000`、`MAX_BACKOFF=300000`、`MAX_HELD=1000`、`MAX_PERSISTED=500`、
`OLDER_PAGES=6`、`BLOCKING_ERRORS={AUTH_REQUIRED,IDENTITY_MISMATCH,BACKGROUND_UNAVAILABLE,NOT_CONNECTED}`、
`SBS_WAITING_REASONS={WAITING_SBS:'waiting_sbs', SBS_NOT_CONFIGURED:'sbs_not_configured'}`、
`ERROR_MESSAGES`（22 条中文，逐字照抄；见源文件 12-34 行）。
`failure(code, automatic=true)`：automatic=false 时把 '稍后自动重试'->'请稍后手动重试'、
'将自动重试'->'请手动重试'、'本轮同步稍后重试'->'请稍后手动更新'；error.code=code。
`record`（Object.prototype 原型判定）、`sequence`（safe int >=0）、`copy`=structuredClone、
`boundedText(v,limit)`：slice(limit*2) 去控制字符/方向覆写 `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]` 再 slice(limit)。
`identityDto`：null/undefined -> null；必须恰好 3 个 data 属性 beingId/connectionRevision/identityRevision，
beingId 匹配 `/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/`，两个 revision 是 sequence；否则 throw IDENTITY_MISMATCH。
`pageDto`：messages 数组 <=200、latestSeq sequence、total 可选 sequence；每条 content 必须 string，
id 允许数字串转 number，必须 sequence 且 <= latestSeq；字段裁剪 beingId/beingName 100、content 32000、
createdAt/revisedAt 64、mentions 最多 20 条各 100；`via` 非空时保留（120）；`replyTo.id` 非空时保留
{id 200, beingId 100, preview 200}。同页同 id 后者胜；按 id 升序。返回
`{messages, latestSeq, total: sequence(total)?total:null, ...(source==='being_relay'?{source}:{})}`。
`emptyTimeline(identity=null)` = `{identity, messages:[], latestSeq:null, total:null, hasOlder:false, lastRefresh:null}`。
`receiptDto`：capturedAt sequence 且 <=8640000000000000，revision 长度 1..128 且全 `[\x21-\x7e]`，返回 manual:false。
构造参数：`{readSnapshot, getIdentity, onSnapshot, onStatus, onSuccess, intervalMs=60000, limit=10,
automatic=true, cached=false, pageable=false, clock={now,setTimeout,clearTimeout}}`。
校验：五个回调必须是函数否则 TypeError('Invalid Town refresh callbacks')；
intervalMs 整数且 [60000,300000]、limit 整数且 [1,200] 否则 RangeError('Invalid Town refresh interval or limit')；
automatic/cached/pageable 必须 boolean 否则 TypeError('Invalid Town refresh settings')；
clock 三个成员必须函数否则 TypeError('Invalid Town refresh clock')。`pageable = pageable && !cached`。
公开方法：`status()`、`snapshot()`、`cacheRecord()`、`restoreCache(value)`、`start()`、`stop()`、
`pause(reason='suspended')`（只接受 suspended/offline/idle，其余归 suspended）、`resume()`、`reset()`、
`refresh()`、`requestRead(readSnapshot)`、`loadOlder()`（原型上挂）、内部 `_fill`（原型上挂）。
`_merge(page, {since, limit, refresh, identity})` 是核心：
  lower = since===undefined ? (full&&seqs.length ? seqs[0]-1 : -1) : since；
  upper = full && since!==undefined ? 最后一条 seq : Infinity；
  区间 (lower, upper] 内本地有、页里没有的删除；页里的 upsert；
  超过 MAX_HELD 丢最旧并把 `_exhausted` 置 false；
  latestSeq=max(page.latestSeq, cached.latestSeq??0)；total=page.total ?? cached.total ?? null；
  hasOlder = pageable && oldest!==null && oldest>1 && !_exhausted && (total===null || messages.length<total)；
  refresh=true 时 lastRefresh={at:now, boundarySeq: 有新消息? before : 上一次 boundarySeq}；
  返回 `{before, seqs, full}`。
`_recheck()` 用 since=Number.MAX_SAFE_INTEGER 的空页重算 hasOlder。
`_failed(error, explicit)`：未知 code 归 NETWORK_ERROR（SESSION_CHANGED/NOT_RUNNING/PAUSED 也归）；
REQUEST_ACCEPTED -> waiting/being_pending，cached 时不 block；WAITING_SBS/SBS_NOT_CONFIGURED -> waiting + failureCount:0；
BUSY -> waiting/being_busy；其余按 BLOCKING_ERRORS 决定 paused/error，
backoff = min(300000, intervalMs * 2**min(3, failureCount-1))，RATE_LIMITED 时并入 retryAfterMs。
`_read`：身份丢失 -> 清空 timeline + reject；身份变化 -> 清空重来；已有 flight 则复用；
成功后 pageDto -> receipt（cached 且 explicit 时 `manual:${++_manualRevision}`，否则 receiptDto）；
unchanged 判定：非 explicit 且 revision 相同 / capturedAt 更早 / 上次 manual 且 capturedAt 相等；
merge 后若 pageable && full && before!==null && seqs[0] > before+1 触发 `_fill` 补洞；
`stale = cached && now - capturedAt > 2*intervalMs`；成功后 `onSuccess(this.cacheRecord())`。
`loadOlder`：非 pageable -> BACKGROUND_UNAVAILABLE；未运行 -> NOT_RUNNING；暂停 -> PAUSED；
已有则复用；probe 记忆 `{oldest, since: max(0, oldest-1-limit), step: limit}`；最多 6 页：
命中更老消息且（不满页 或 末条 >= oldest）则完成并清 probe；满页但没够到目标则 since=末条继续；
没命中且 since===0 -> `_exhausted=true`、清 probe、`_recheck()` 后 break；
否则 step*=2、since=max(0, since-step)。

### src/town-data-cache.cjs（182 行）→ timeline/data-cache.ts
导出 `{TownDataCache}`。常量 `MAX_FILE_BYTES=8MB`、`MAX_IDENTITY_BYTES=64MB`、
`MAX_IDENTITY_ENTRIES=128`、`MAX_ARRAY_LENGTH=10000`、`MAX_DEPTH=12`、`MAX_NODES=50000`。
`snapshot(value)`：只复制有界 JSON，用 descriptor 读取（getter/toJSON 永不执行）；
预算：null/boolean 5 字节、number 24、string utf8+2、容器 2、key utf8+4；超 8MB throw
TypeError('Town cache data is too large')；深度/节点超限 'Town cache data is too complex'；
非 plain/非 Array 原型/循环 'Town cache requires JSON data'；数组超 10000 或 key 数不等于 length+1、
对象 key>2000 'Town cache has too many entries'；symbol key 或数组非序号 key 'Town cache requires JSON keys'；
非 value descriptor 或不可枚举 'Town cache requires JSON fields'；对象里 undefined 值跳过。
构造 `{directory, safeStorage, clock=Date.now}`；directory 非空字符串否则 TypeError('Invalid Town cache directory')；
clock 非函数 TypeError('Invalid Town cache clock')；`this.directory = path.resolve(directory)`。
key 校验：identityKey<=256、resourceKey<=32768，非空且无控制字符。
路径：`<dir>/<sha256(identityKey)>/<sha256(resourceKey)>.bin`。
`load`：等待同 key 写入；不可用 -> miss；stat 必须是文件且 0<size<=8MB；解密必须是 string 且 <=8MB；
payload.version===1 && identityKey/resourceKey 匹配 && validTime(lastSuccessAt)，否则 miss。
`miss() = {cached:false, data:null, lastSuccessAt:null}`；命中 `{cached:true, data, lastSuccessAt}`。
`save`：snapshot -> `{version:1, identityKey, resourceKey, data, lastSuccessAt: clock()}` JSON 化，超 8MB 返回 false。
`_enqueue` 按 identityKey 串行（写与逐出不会交错），成功从 `_failed` 删、失败加。
`_write`：mkdir -> encryptString -> 写 `.<uuid>.tmp`（flag 'wx', mode 0o600）-> rename -> `_prune`。
`_prune`：只认 `/^[a-f0-9]{64}\.bin$/`，按 mtime 再按路径排序，逐出最旧直到 count<=128 且 bytes<=64MB，跳过 keep。
`invalidate`：unlink，ENOENT 也算成功。`flush()`：等所有写完，返回 `_failed.size===0`。

### src/town-cached-reads.cjs（103 行）→ timeline/cached-reads.ts
导出 `{TownCachedReads}`。依赖 `scrollId`（来自 town-library-contract.cjs，本单元内联）：
`/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/` 且不在 `{help, search, graph, match}` 里。
`PUBLIC_METHODS={listBeings,getBeingMembers,getGroveCatalog,getGroveDetail}`；
`MEMBER_METHODS={getBeingMembers,listBeings,getFiresideMembers}`；
`NO_ARGS={listBeings,getBeingMembers,getFiresides}`。
错误：`invalid()` 'Town 缓存读取参数无效。' code INVALID_REQUEST；
`changed()` 'Being 连接已变化，请重新读取。' code SESSION_CHANGED；
read 未连接 '请先连接 Being。' code NOT_CONNECTED。
`resource(method, value)` 归一化：NO_ARGS 只允许空对象；
listScrolls {offset 默认0 [0,4294967295], limit 默认50 [1,200], visibility∈private/shared/public 可选}；
getScroll {id 必填 scrollId, offset 默认0, limit 默认10000 [1,10000]}；
getGroveCatalog {offset 默认0 [0,100000], limit 默认30 [1,100]}；
getGroveDetail 必须字符串匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/`（注意含点）；
getFiresideMembers 必须 `/^[1-9]\d{0,15}$/` 且 Number 是 safe integer；其余 throw invalid。
返回 `{method, value: query, key: JSON.stringify([method, query]), public}`。
构造 `{cache, getContext, now=Date.now, membersTtlMs=60000}`（Object.assign，无校验）。
`_context`：public 请求用固定 identityKey `'public-town-v1'`，否则 `context.connected && context.identityKey`；
member 方法额外带 `membersRevision`。
`snapshot(value)`：fields(['method','value'],['method']) -> resource -> 无 identityKey 则 miss；
`cache.load` 后若上下文已变 throw changed()；member 方法命中时检查 TTL：
`at` 支持数字或可 Date.parse 的字符串，`!isFinite(at) || at <= _membersInvalidatedAt || now()-at >= membersTtlMs` -> miss。
`invalidateMembers()`：`_membersRevision++`、`_membersInvalidatedAt = now()`。
`read(method, value, read)`：无 identityKey throw NOT_CONNECTED；serial 去抖，只有最新一次写缓存；
读完上下文已变 throw changed()；保存失败不影响返回值。

### src/town-client-store.cjs（54 行）→ timeline/client-store.ts
导出 `{TownClientStore}`。构造 `{directory, safeStorage}`（Object.assign，无校验），`_tail` 串行化写。
`_file(key)` = `<dir>/<sha256(key)>.json`（注意：**.json**，明文外壳 + base64 密文）。
`_secure()`：`!isEncryptionAvailable() || getSelectedStorageBackend?.()==='basic_text'` 时 throw
'系统安全存储不可用，Town 配对凭据未保存。' {code:'AUTH_REQUIRED', reason:'SECURE_STORAGE_UNAVAILABLE'}。
`assertAvailable()` 就是 `_secure()`。
`loadCredential(key, beingId)`：stat 必须是文件且 size<=8192；raw<=8192；
`JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(raw).encrypted,'base64')))`；
data.key/beingId 必须匹配、token 必须 `/^[a-f0-9]{64}$/`，否则 null；
townId 存在但非法 -> throw（被 catch 转成 AUTH_REQUIRED/CREDENTIAL_UNREADABLE）；
返回 `{token, townId: data.townId||'', ...(typeof display==='string'?{display: display.slice(0,100)}:{})}`；
ENOENT -> null，其余 -> 'Town 凭据无法读取，请重新配对。' {code:'AUTH_REQUIRED', reason:'CREDENTIAL_UNREADABLE'}。
`load(key, beingId)` = token 或 null。
`save(key, beingId, token, townId='', display='', isCurrent=()=>true)`：token 必须 64 hex 否则
Error('Invalid client token')；townId 非空时必须合法否则 Error('Invalid Town binding')；
mkdir mode 0o700；写 `.<uuid>.tmp` (mode 0o600, flag 'wx')；写完 `!isCurrent()` 则 throw
'Being 连接已变化，配对未保存。' {code:'SESSION_CHANGED'}；再 rename；finally 清 tmp。
落盘外壳：`{version:1, encrypted: base64(encryptString(JSON.stringify({key, beingId, token, townId?, display?})))}`。
`bindTownId(key, beingId, token, townId, isCurrent)`：townId 非法 -> 'Town 身份编号无效。' INVALID_RESPONSE；
凭据不在或 token 不符或 !isCurrent -> 'Town 配对已变化，身份绑定未保存。' SESSION_CHANGED；
已绑不同 townId -> 'Town 返回的身份与已保存配对不一致。' IDENTITY_MISMATCH；只有未绑时才写。
`remove(key)` = rm force。

### src/bonfire-cache.cjs（122 行）→ timeline/bonfire-cache.ts
导出 `{BonfireCache}`。`MAX_FILE_BYTES=8MB`。
`snapshot(value)` 返回 null 表示不合法：messages 数组 <=500、latestSeq sequence、
capturedAt sequence 且 <=8640000000000000、manual boolean、revision `/^[\x21-\x7e]{1,128}$/`；
每条：content string <=32000，id 数字串转 number 且 sequence 且 <=latestSeq；
可选字段 beingId 100 / beingName 100 / createdAt 64 / revisedAt 64 / via 120（只在 !==undefined 时校验并保留）；
mentions 可选，<=20 条各 <=100；replyTo 可选，{id 非空<=200, beingId<=100, preview<=200} 三个都必须是 string。
输出 `{messages, latestSeq, capturedAt, revision, manual, ...(source==='being_relay'?{source}:{})}`；
message 字段顺序 `{id, content, ...可选}`。
构造 `{directory, safeStorage}`，directory 非空字符串否则 TypeError('Invalid Bonfire cache directory')；
`this.directory = path.resolve(directory)`。文件 `<dir>/<sha256(identityKey)>.bin`（无按身份分子目录）。
`load(identityKey)`：validKey(<=256, 无控制字符) 且 `_available()`，否则 null（注意与 TownDataCache 不同：
先查 available 再等待写入）；stat/size/解密/`version===1 && identityKey` 匹配后 `snapshot(payload.snapshot)`。
`save`：snapshot 非法 -> false；payload `{version:1, identityKey, snapshot}`；按 identityKey 串行。
`_write` 成功从 `_failed` 删，失败加。`flush()` 同 TownDataCache。

## 进度
| 模块 | 源文件 | 目标 | 状态 |
|---|---|---|---|
| types | — | desktop/main/town/timeline/types.ts | 已移植 |
| TownRefresh | src/town-refresh.cjs | timeline/refresh.ts | 测试通过（38/38，tests/town-timeline-refresh.test.ts） |
| TownDataCache | src/town-data-cache.cjs | timeline/data-cache.ts | 未开始 |
| TownCachedReads | src/town-cached-reads.cjs | timeline/cached-reads.ts | 未开始 |
| TownClientStore | src/town-client-store.cjs | timeline/client-store.ts | 未开始 |
| BonfireCache | src/bonfire-cache.cjs | timeline/bonfire-cache.ts | 未开始 |
