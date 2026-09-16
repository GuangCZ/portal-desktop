# P1 第二块：会话存储、加密缓存、会话标题与会话恢复移植（BeingDesktop 0.8.26 → TypeScript）

本块只新增文件，不改既有文件。并行块（p1-client）在同一工作树里创建了
`desktop/main/chat/{being-chat,protocol-types,recovery}.ts` 与
`tests/{being-chat,being-recovery}.test.ts`——本块不碰、不 import。
需要的类型全部在 `desktop/main/chat/store-types.ts` 自带，后续阶段合并。

产出文件：
`desktop/main/chat/{store-types,store,frame,cache,titles,session-recovery}.ts`，
`tests/{chat-store,chat-cache,session-titles,session-recovery}.test.ts`。

## 阅读摘要

### docs/desktop-message-layer.md §六～§九（实测记录，本块相关部分）

- **§六 必须照抄的不变量**（本块只涉及 ③④⑤，①② 属客户端块）：
  - ③ **消息与游标同一事务落盘**——否则「游标推过去了、消息没落盘」，下次 `after=` 永远跳过。
  - ④ **`lastSeq` 只前进**。具体后果：`/api/history` 的返回游标只能取「过滤后的新行」的最后一个
    seq；取未过滤整页最后一行会在服务端忽略 `after` 时让游标**后退**。
  - ⑤ **基线纪律**——有全量基线之前，增量写入只攒不落盘。
  三条都注明源自 Loom 的 IndexedDB 缓存（`loom.html:3620 / 3600 / 3660`）。
- **§七 历史行：无 scene 的行不属于任何会话**。历史行字段全集
  `role, content, seq, at, from?, scene_id?`——**没有 `session_id`**。`scene_id` 是服务端唯一持久化
  并回传的路由键；`client_ref` 只在 `meta` 上回传、不落盘，只能做实时关联。
  Loom 的规则是「没有 `scene_id` 的放行」（loom.html:3638），**Desktop 不能照抄**：一条时间线上有
  N 个会话，放行会让所有旧消息涌进每一个会话。分隔行（`from: system`，如
  `[breath yielded to human]`）也无 scene。实测 187 条历史里 157 条 assistant 行无 scene（v1.7.0
  之前），这些行在新界面里任何会话都看不到——渲染层必须一次性说明。
- **§八 一条时间线，一个全局游标，N 个投影**。`/api/history` 不支持按 scene 查询
  （loom.html:3910 只用 `limit`/`after`，过滤在客户端）：一次拉取 → 按 scene 分发给 N 个会话。
- **§九 模块与职责**：`chat-store.cjs` / `chat-cache.cjs` = 「每会话 transcript + 会话列表 +
  全局游标，一个加密文件，三条不变量」。`scene_meta.scene_label` 实测会进入 being 的感知
  （它看到 `[场景] <label>`），所以会话标题即话题门牌，随每条消息重发——这是 `SessionTitles`
  存在的理由。
- **§十 图片：`content` 块，只活一轮**——history 不返回图片（2026-09-11 实测），这就是
  `attach()` / `StoredImage` 作为本地注记存在的原因。

### docs/interfaces.md §7 持久化格式（本块相关行）

`chat-cache/<file per identity>`：safeStorage 密文，明文
`{version:1, cursor, seeded, active, sessions:[{id, title, titleSource?, createdAt, truncated,
rows:[{seq, role, content, at, from?, images?}]}]}`；≤100 会话、每会话 ≤300 行、
行 ≤100000 字符、总 ≤6MB。**必须逐字节兼容**：新版要能读 0.8.x 写出的文件。
（外层信封在 `chat-cache.cjs` 里另加一层：`{version:1, identityKey, state}`，密文上限 8MB。）

### src/chat-store.cjs（290 行）

导出面：`{ChatStore, snapshot}`。

常量：`MAX_SESSIONS=100`、`MAX_ROWS=300`、`MAX_CONTENT=100000`、`MAX_TITLE=120`、
`MAX_PAYLOAD=6*1024*1024`、`MAX_ROW_IMAGES=8`、`MAX_THUMB=48*1024`、`MAX_IMAGE_NAME=120`；
`THUMB=/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/`、
`IMAGE_TYPE=/^image\/(?:png|jpeg|webp|gif)$/`、`UUID` 为 v1-8 变体正则（大小写不敏感）。

模块级纯函数：
- `plain(v)`：`Object.getPrototypeOf(v) === Object.prototype`（拒绝数组、`null` 原型对象）。
- `seq(v)`：安全整数且 `> 0`；`time(v)`：安全整数、`0..8640000000000000`；
  `text(v, limit)`：非字符串 → `''`，否则 `slice(0, limit)`。
- `copyRow(row)`：浅拷贝，`images` 逐项再拷一层（`rows()` 返回的对象改了不影响内部状态）。
- `storedRow(value)`：必须 `plain` + `seq>0` + `content` 是字符串，否则 `null`。
  `role` 只有 `'user'` 和其他（一律折成 `'being'`）。**`role === 'user'` 的 content 先过
  `unwrapMessage` 去掉请求上下文帧**，再 `slice(0, MAX_CONTENT)`。`at` 走 `text(_, 64)`。
  `from` 是字符串就留（`slice(0,64)`）。`images` 走 `rowImages`，空数组不写字段。
- `rowImages(value)`：非数组 → `[]`。取前 8 项，逐项要求 `plain` + `media_type` 匹配 `IMAGE_TYPE`，
  否则 **跳过该项而不是失败整行**。`name` 非空才留（`slice(0,120)`）；`thumb` 要 `≤48KB` 且匹配
  `THUMB` 才留（`javascript:` 之类被拒，但该项本身保留、只丢 thumb）。
- `storedSession(value)`：要求 `plain` + `id` 是 UUID + `rows` 是数组，否则 `null`。
  `rows` 取**末尾** 300 条（`slice(-MAX_ROWS)`）；**任一行无效或 seq 不严格递增 → 整个 session 判 null**。
  返回 `{id(小写), title(≤120), titleSource? (仅 auto|manual|system), createdAt(非法→0),
  truncated(严格 === true), rows}`。
- `snapshot(value)`（导出）：`version===1`、`cursor` 安全整数 ≥0、`seeded` 是布尔、`sessions` 是
  数组且 `≤100`；任一 session 无效 / id 重复 / 该 session 最后一行 `seq > cursor` → **整份 null**
  （「游标落后于自己的行」正是不变量 ③ 要防的腐坏）。`active` 命名不存在的会话时**降级为 `''`**
  而不是拒绝整份。

`class ChatStore`：
- 构造 `{cache, identityKey='', desktopId, clock=Date.now, onChange=()=>{}}`；
  `desktopId` 不是 UUID → `throw new TypeError('Invalid Desktop identity')`。
  内部：`_state`（初始 `{version:1,cursor:0,seeded:false,active:'',sessions:[]}`）、`_loaded=false`、
  `_writes=Promise.resolve(true)`（串行写队列）、`_failed=false`。
- getter：`cursor` / `seeded` / `degraded`（= `_failed`）。
- `load()`：只生效一次；`cache.load(identityKey)` 抛错或返回坏数据都当**缓存未命中**，不抛。
- `summary()`：`{cursor, seeded, active, degraded, sessions:[{id, title, titleSource?, createdAt,
  updatedAt, truncated, count, lastSeq}]}`。`updatedAt = 最后一行的 at || createdAt`
  （**字符串或数字两种类型都可能**）；`lastSeq` 无行时 0。
- `rows(id)`：深拷贝列表；找不到返回 `[]`。
- `attach(sessionId, rowSeq, images)`：找到行且**该行还没有 images** 且预览非空才挂；成功后
  `void this._persist()`（不触发 `onChange`——「本地事实，没有行移动」），返回布尔。
- `_find(id)`：字符串才查，小写匹配。
- `ensure(sessionId, {title, titleSource})`：非 UUID → `TypeError('Invalid conversation id')`。
  已存在直接返回。新建 `createdAt = time(clock()) ? clock() : 0`。超过 100 条时**从最旧开始删，
  但跳过刚建的这条和当前 active**（`findIndex(item => item.id !== id && item.id !== active)`，
  找不到就 break）。
- `rename(id, title, {source='manual'})` / `setActive(id)`（找不到则 active 置 `''` 并返回 false）/
  `forget(id)`（删掉，若是 active 则清空；**游标不回退**）。
- `apply({rows=[], cursor=0, baseline=false})`：参数非法 → `TypeError('Invalid history page')`。
  先把现有各 session 里带 images 的行按 `id → (seq → images)` 存进 `previews`；
  `baseline` 时**清空所有 session 的 rows**（替换语义，不是合并）。
  逐行：`storedRow` 失败或 `sessionFromScene(desktopId, value.scene_id)` 为空 → `skipped++`；
  否则 `ensure(target)`（会话可以只从历史里出现）、把 `previews` 里同 seq 的图片贴回来、
  按 seq 有序插入（相同 seq **替换**）、超过 300 行则从头砍并置 `truncated = true`、`stored++`。
  最后 `baseline` 置 `seeded = true`；`cursor = Math.max(旧, 新)`（不变量 ④）；
  `await _persist()`；`onChange(summary())`；返回 `{stored, skipped, cursor, persisted}`。
- `touch()`：`_persist()` + `onChange`。
- `_persist()`：**未 seeded 或没有 cache 一律返回 false**（不变量 ⑤）。`_payload()` 返回 null →
  `_failed = true`。写入挂在 `_writes` 链上串行（不变量 ③：行和游标是同一份原子替换）；
  `.catch(() => false).then(ok => {this._failed = !ok; return ok;})`。
- `_payload()`：整份深拷贝后循环最多 `MAX_SESSIONS*4` 次：`JSON.stringify` 量字节数，
  `≤6MB` 就 `return snapshot(state)`；否则挑**行数最多**的 session，砍掉最旧的
  `max(1, ceil(len/8))` 行并把 `truncated` 同时写进副本**和内存里的活对象**。
- `flush()`：循环 `await` 直到 `_writes` 不再变化，返回 `!_failed`。

### src/chat-cache.cjs（101 行）

导出面：`{ChatCache}`。常量 `MAX_FILE_BYTES = 8*1024*1024`。
`validKey`：字符串、`1..256` 字符、无控制字符。

- 构造 `{directory, safeStorage}`；`directory` 空 → `TypeError('Invalid chat cache directory')`；
  `path.resolve(directory)`。内部 `_writes: Map<identityKey, Promise>`、`_failed: Set<identityKey>`。
- `_available()`：`safeStorage?.isEncryptionAvailable() === true` 且 `encryptString` /
  `decryptString` 都是函数；抛异常也算不可用。
- `_file(key)`：`<directory>/<sha256(key) hex>.bin`。
- `load(key)`：key 非法或加密不可用 → `null`。**先 `await` 该 key 上排队中的写**，再
  `stat`（必须是文件、非空、`≤8MB`）→ `readFile` → `decryptString` → `JSON.parse` →
  信封校验 `plain` + `version===1` + `identityKey === key` → `snapshot(payload.state)`。
  任何异常都吞掉返回 `null`（不可读 = 缓存未命中）。
- `save(key, value)`：`snapshot(value)` 失败 → false；序列化 `{version:1, identityKey, state}`，
  `>8MB` → false。按 key 串行排队，`finally` 里只在自己仍是队尾时从 Map 删除。
- `_write`：加密不可用 → 抛（→ false）；密文必须是非空 Buffer 且 `≤8MB`；
  `mkdir -p` → 写 `<file>.<uuid>.tmp`（`flag:'wx'`, `mode:0o600`）→ `rename` 到正式名。
  成功 `_failed.delete`，失败 `_failed.add`，`finally` 里删残留临时文件
  （「失败的写保留上一份缓存」）。
- `remove(key)`：`unlink`；`ENOENT` 也算成功。
- `flush()`：等到 `_writes` 空，返回 `_failed.size === 0`。

### src/session-titles.cjs（69 行）

导出面：`{SessionTitles, defaultTitle, titleInput}`。`RETRY_MS = 5*60*1000`。

- `defaultTitle(title)`：空标题，或匹配 `/^(?:新会话|新任务|会话 \d+)$/`。
- `eligible(session)`：`!session.titleSource && defaultTitle(session.title)`
  ——**用户手动改成「新会话」也会带上 `titleSource:'manual'`，所以不再被自动命名**。
- `titleInput(rows)`：只留 `role ∈ {user, being}` 且 `content` 非空白的行；**没有任何 user 行就
  返回 `''`**；取前 6 条拼 `` `${role}: ${content.slice(0,1200)}` ``，过 `sanitizeText` 再
  `slice(0, 4000)`。工具行、图片字节、执行上下文都不进入。
- `class SessionTitles({getStore, available, generate, changed, delay=500})`。
  `available()` 返回的是**不透明的可用性指纹字符串**（空 = 不可用；值变了要重试失败过的会话）。
  - `reset()`：`epoch++`、清两个 timer、清 `attempts`、`dirty=false`。
  - `schedule()`：正在跑 → 置 `dirty`；已有 timer / 无 store / 不可用 → 直接返回；否则
    `setTimeout(delay)` 并 `unref?.()`。
  - `run()`：重入直接返回。取 `store` 与 `epoch` 快照。逐个会话：epoch 变了 / store 换了 /
    不可用 → **break**；重新查最新 summary，不 eligible → continue；`titleInput` 为空 → continue；
    指纹 = `sha256(String(available()) + input)`，和上次失败指纹相同且不足 5 分钟 → continue；
    记录尝试；`generate` 抛错 → continue；回来后再验 epoch / store（break），再验会话仍存在、
    仍 eligible、**标题没被人改过**（`current.title !== session.title` 则放弃）、返回值是非空字符串、
    `length ≤ 80`、无控制字符；通过才 `rename(..., {source:'auto'})` + `await touch()` + `changed()`。
  - `finally`：`running=false`；`dirty` 则重排；清 retryTimer；把还 eligible 且有尝试记录的会话
    换算成 `max(1000, RETRY_MS - 已过时间)`，取最小值排一次重试（仅当 available）。

### src/session-recovery.cjs（48 行）

导出面：`{readSessionRecovery, importSessionRecovery}`。

- `readSessionRecovery(directory, connection)`：读
  `<directory>/session-recovery/<sessionPartition(connection).slice(8)>.json`
  （`.slice(8)` 砍掉 `persist:` 前缀）。校验 `data.origin === new URL(connection.displayUrl).origin`、
  `entries` 是数组、`id` 是字符串。`ENOENT` → `null`，**其他异常继续抛**。
  `sessionPartition`（src/security.cjs:45-48）=
  `persist:loom-v1-<sha256(JSON.stringify(['v1', displayUrl, apiBase, token, secret])).slice(0,32)>`。
- `importSessionRecovery(recovery, desktopId)`：**这个函数体会被 `toString()` 序列化后注入 Loom
  页面执行**（src/loom-sessions.cjs），所以必须自包含：不引用模块作用域的任何东西。
  - 守卫：无 recovery / 不在顶层 frame / `recovery.origin !== location.origin` → 返回。
  - `legacyKey = 'being-desktop-sessions-v1:' + location.pathname`；
    读 `legacyKey + ':desktop-owner'`；**owner 或 `recovery.desktopId` 指向别的 Desktop 就放弃**。
  - `scopedKey = 'being-desktop-sessions-v2:' + desktopId + ':' + location.pathname`；
    **迁移前写回 legacy**（让初始化能迁移完整历史），`scopedKey` 已存在才写 v2。
  - 幂等标记 `key + ':recovery:' + recovery.id`，legacy 上的同名标记也算数 → 只导入一次。
  - 逐条：拿备份里的完整会话（拿不到就用索引项本身）；已存在同 id 时，若**消息与 context 完全
    相同就跳过**，否则以新 UUID 建「`<title>（恢复副本）`」并把每条 message 的 `session_id` 改写
    为新 id。最后写回索引与标记。

### test/chat-store.test.cjs（245 行，16 个用例）

fixture：`DESKTOP=11111111-1111-4111-8111-111111111111`、`A=aaaaaaaa-…`、`B=bbbbbbbb-…`，
`clock: () => 1757000000000`，`identityKey: 'https://echo.beings.town/cz_being'`，
假 cache 记录每次 `save` 的 `{identityKey, value}`，`fail:true` 时 save 返回 false。
`row(seq, scene, content='x', role='assistant')` 的 `at` 固定 `'2026-09-11T00:00:00Z'`。

用例名：
1. `nothing is persisted before a baseline exists`
2. `rows and the cursor are persisted as one replacement`
3. `the cursor only moves forward`
4. `one page fans out to the conversations it names and skips the rest`（stored 3 / skipped 4）
5. `a conversation seen only in history joins the list`
6. `rows merge in seq order, and a re-read replaces rather than duplicates`
7. `a reloaded store resumes from its stored cursor and transcripts`
8. `a corrupt or inconsistent file is a cache miss, not a startup failure`（6 份坏盘 + load 抛错）
9. `a store with no cache at all still works in memory`
10. `a failed write is reported and leaves the previous file intact`
11. `conversations can be opened, renamed, activated and forgotten`
12. `an oversized transcript gives up age, keeps the conversation, and says so`
13. `a conversation keeps only its most recent rows`（340 → 300，首行 seq 41）
14. `the snapshot validator is the contract, not a cleanup pass`
15. `concurrent applies serialize into ordered writes`（saves 的 cursor 顺序 `[1,2,3]`）
16. `image previews attach to a durable row and survive a re-read and a fresh baseline`
17. `previews that do not fit are dropped, never the row they annotate`

（TS 版另加第 18 条 `a user row is stored without its request context frame`，覆盖 `frame.ts`
的去帧——原仓库里这条行为由 `test/orchestration.test.cjs` 的 `unwrapMessage` 用例覆盖。）

### test/session-titles.test.cjs（58 行，6 个用例）

fixture：4 个会话 id `0000000{1..4}-0000-4000-8000-000000000000`，全部 `title:'新会话'`，
active 是第 4 个（**没有行，所以不该被命名**），前 3 个各一条 user 行
（`修复登录按钮` / `增加消息搜索` / `整理项目分组`），`available` 初值 `'worker-v1'`。

用例名：
1. `backfills each populated session, preserves selection and persists generated titles`
2. `manual names including a manually chosen default title are preserved after reload`
3. `a manual rename or deletion while generating cannot be overwritten`
4. `identity reset discards an in-flight result and stops the old queue`
5. `unavailable workers do no work; failures are deduplicated until availability changes`
6. `title input excludes tools and images and redacts URL credentials`

### test/session-recovery.test.cjs（38 行，2 个用例）

两条都用 `node:vm` 建一个假 window/localStorage 上下文，再
`vm.runInContext('(' + importSessionRecovery.toString() + ')(...)')` ——即**按注入后的真实形态**
测。用例名：
1. `recovery preserves current sessions, retains conflicts separately, and imports only once`
2. `post-migration recovery reaches only its owning Desktop namespace`

`chat-cache.cjs` 在原仓库**没有专属测试**（只有 `src/main.cjs` 的接线）；本块新写
`tests/chat-cache.test.ts`，含任务要求的「读 0.8.x 写出的缓存文件」兼容用例。

### 移植时的取舍（原样保留语义，只换写法）

- `sessionFromScene` 在 `store.ts` 里本地重实现（原 `src/being-chat.cjs:92`），避免 import 并行块的
  `being-chat.ts`；`sanitizeText`（原 `src/services.cjs:12-37`）搬进 `titles.ts`；
  `sessionPartition`（原 `src/security.cjs:45`）搬进 `session-recovery.ts`；
  `unwrapMessage`（原 `src/orchestration-message.cjs:18-37`）搬进 `frame.ts`。四处都在文件头注明
  来源，后续阶段合并。
- `frame.ts` 的 `unwrapMessage` 去掉了原函数的 `typeof text !== 'string'` 分支：唯一调用点
  `storedRow` 已经先检查 `typeof value.content === 'string'`，类型签名承担了这个守卫。
- `cache.ts` 的写队列种子从 `Promise.resolve()` 改成 `Promise.resolve(true)`（`.then(() => …)`
  丢弃这个值，行为不变，只为让 `Promise<boolean>` 成立）。
- `importSessionRecovery` 的函数体保持自包含、不含任何会被 TS 降级成运行时 helper 的语法，
  因为它要被 `toString()` 注入页面；测试按注入形态验证。

## 进度

| 文件 | 状态 |
| --- | --- |
| `desktop/main/chat/store-types.ts` | 已移植 |
| `desktop/main/chat/frame.ts` | 已移植 |
| `desktop/main/chat/store.ts` | 已移植，测试通过 |
| `desktop/main/chat/cache.ts` | 已移植，测试通过 |
| `desktop/main/chat/titles.ts` | 已移植，测试通过 |
| `desktop/main/chat/session-recovery.ts` | 已移植，测试通过 |
| `tests/chat-store.test.ts` | 18 用例通过 |
| `tests/chat-cache.test.ts` | 9 用例通过（新写，含 0.8.x 兼容夹具） |
| `tests/session-titles.test.ts` | 6 用例通过 |
| `tests/session-recovery.test.ts` | 3 用例通过（原 2 条 + `readSessionRecovery`） |

门槛：`npm run typecheck` 通过；`npx vitest run` → Test Files 53 passed | 7 skipped (60)，
Tests 414 passed | 16 skipped (430)（含并行 p1-client 块的用例）。

## 存疑 / 待后续阶段处理

- `importSessionRecovery` 要被 `toString()` 注入页面执行。vitest 用 esbuild 转译，实测注入后
  行为正确；但生产构建（vite.main.config.ts）目前没有显式的 `keepNames`/`minify` 配置，
  接线阶段把它真正注入 Loom 页面时要再验一次转译产物里没有 `__name(...)` 之类的运行时 helper。
- `frame.ts` / `titles.ts` / `session-recovery.ts` / `store.ts` 里各有一份从别的 BeingDesktop 模块
  搬来的小函数（`unwrapMessage` / `sanitizeText` / `sessionPartition` / `sessionFromScene`），
  后续阶段应与 orchestration、services、security、being-chat 的正式移植合并，避免两份实现漂移。
- `rename()` 的 `source` 参数在 TS 里被收窄成 `TitleSource`；原 JS 不校验、写什么存什么，
  但 `snapshot()` 会在落盘时丢掉非法值。行为等价，只是把校验点从运行时提前到编译期。
