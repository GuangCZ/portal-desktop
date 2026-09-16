# P1 复审修复：会话层与 IPC（2026-09-16）

接在 `docs/migration/p1-sessions.md` 之后。这一块只处理复审结论里的 high / medium，
外加两条改注释和文档就能了结的 low。

## 阅读摘要

### BeingDesktop 0.8.26 `src/main.cjs`（只读来源）

- **行 125-126 `townMethods`**：`chatView` / `chatSend` / `chatStop` / `chatReload` /
  `chatForgetSession`，以及五个 `chatDetail*`（`chatDetailOpen|View|Send|Stop|Close`）。
  不在集合里的对话方法：`changeChatSession`、`renameChatSession`、`getChatComposerData`、
  `showSessionMenu`、`chatOpenWorkerResult`。
- **行 127-135 `townErrorCodes`**：`AUTH_REQUIRED, INVALID_REQUEST, IDENTITY_MISMATCH,
  NOT_CONNECTED, SESSION_CHANGED, BUSY, REQUEST_ACCEPTED, RATE_LIMITED, RESULT_UNKNOWN,
  NETWORK_ERROR, SERVICE_ERROR, INVALID_RESPONSE, BACKGROUND_UNAVAILABLE, NOT_RUNNING,
  PAUSED, INCOMPLETE_RESULT, RESULT_SOURCE_UNAVAILABLE, WAITING_SBS, SBS_NOT_CONFIGURED,
  TASK_LIMIT_REACHED`，后面又补 `READINESS_UNKNOWN, RESULT_UNCONFIRMED, NOT_SENT,
  TOWN_TOOL_NOT_CALLED, RESULT_SOURCE_NOT_CONFIGURED` 和五个 `PAIR_*` / `STORAGE_ERROR`。
- **行 741（`handle` 的 catch）**：
  `if(townMethods.has(name)) return {__townError:true, code: townErrorCodes.has(error?.code)?error.code:'TOWN_ERROR',
  message: townErrorCodes.has(error?.code)?message:'Town 操作未完成，请稍后重试。', …}`。
  `message = sanitizeText(error?.message || '操作未完成')`。**返回**而不是抛出——这就是 code
  能过 IPC 的唯一原因。非 town 方法走 `activity('error',…); throw new Error(message)`。
- **`sanitizeText`（`src/services.cjs:12`）**：去 ANSI、按 secrets 打码、URL 只留 origin+path、
  打掉 Cookie/Authorization/Bearer/`*token|secret|password|key*`/`sk-*`/JWT/32+ hex/48+ base64、
  最后 `replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'')`（保留 `\t\n\r`）。
- **行 1151-1158 `renameChatSession`**：
  `if(typeof title!=='string' || !title.trim() || title.trim().length>80 || /[\x00-\x1f\x7f]/.test(title))
  throw new Error('会话名须为 1–80 个字符，且不能包含换行。')`。注意长度判定在 **trim 之后、
  空白折叠之前**，且控制字符测的是**原始** title。原生模式下 `chatSessions.rename(id,title); return true;`。
- **行 1160-1176 `changeChatSession(id, project='')`**：非法 id 文案是「会话标识无效。」；
  原生分支 `if(id===null)chatSessions.create({title:'新会话'});else chatSessions.select(id);`
  然后 `await remember(...); broadcast(); return {ok:true};`。

### BeingDesktop 0.8.26 `src/preload.cjs`（只读来源）

- **行 52-58**：渲染层侧同一份 `townErrorCodes`，注释原话：
  「Electron strips custom Error fields. Preserve only known Town error categories.」
- **行 60-76**：对 `chatView/chatSend/chatStop/chatReload/chatForgetSession/chatDetail*` 等，
  `const result = await ipcRenderer.invoke(...); if(result?.__townError===true){…throw Object.assign(new Error(
  known && typeof result.message==='string' ? result.message.slice(0,2000) : 'Town 操作未完成，请稍后重试。'),
  {code: known ? result.code : 'TOWN_ERROR'})} return result;`。
- `getChatComposerData` 在行 48 的**普通** invoke 列表里，没有包络。

### BeingDesktop `docs/interfaces.md`

- 行 88：`changeChatSession(id, project='')` 串行 → `{ok:true}`。
- 行 89：`renameChatSession(id, title)` 串行，`title` 1–80 字符，**无控制字符** → `true`。
- 行 92-96：`chatView` / `chatSend` / `chatStop` / `chatReload` / `chatForgetSession` 都标「Town 包络」。
- 行 97：`getChatComposerData` 无包络。

### portal-desktop 侧（本仓库）

- `desktop/main/main.ts:222-229`：`handle` 包装＝sender 校验 →（非
  `beings:browser-bounds|beings:diagnostics`）退出守卫 →（`beings:save|portal-start|portal-stop`）
  恢复守卫 → `try { return await callback(...) } catch { throw new Error(errorLog.report(channel, error)) }`。
  `ClientErrorLog.report` 末行 `return publicErrorMessage(error, fallback)`（只返回字符串）。
- `desktop/shared/errors.ts:12`：message 为空、>110 字符、含 `[\r\n]`、含 `[a-z]:[\\/]`（会命中 `https://`）
  等，一律换成兜底 `'操作未完成，请重试或查看日志。'`。
- `desktop/main/chat/sessions.ts:35` `normalize = String(v||'').replace(/\s+/g,' ').trim()`；
  `rename()` 在 normalize 之后判 `!clean || clean.length > MAX_TITLE`。JS 的 `\s` **不含** NUL/BEL/DEL。
- `desktop/main/main.ts:440-460` `beings:save`：`await store.save(input)` → try{ `verifyConnection()`
  （末行 `extensions?.connectionVerified(store.connection)`）→ `takeover.run(...)` → `publishCurrentPortal()` }
  catch{ `if (previousConnection) await store.save({...previous, connectionLink: previousAddress || …})`; throw }。
- `SettingsStore.resolveConnection`（`app/settings.ts:197`）在 `connectionLink` 为空时回退到
  `this.connection`，否则抛「请先输入 Being 链接。」——所以 `await store.save(input)` 成功后
  `store.connection` **不可能是 null**。

## 进度

| 文件 | 状态 |
| --- | --- |
| `desktop/shared/chat-errors.ts`（新增：Town 包络的两端） | 已移植 / 测试通过 |
| `desktop/main/chat/ipc.ts`（rename 守卫 + 五个通道的包络 + 偏差注释） | 已移植 / 测试通过 |
| `desktop/preload/desktop-channels.ts`（包络还原成带 code 的 Error） | 已移植 / 测试通过 |
| `desktop/main/app/ipc.ts`（新增：从 main.ts 抽出的可信 sender 包装） | 已移植 / 测试通过 |
| `desktop/main/main.ts`（改用抽出的包装 + 回滚后重新通知 extensions） | 已移植 / 测试通过 |
| `tests/chat-ipc.test.ts`（全部调用改走真实包装 + 包络用例 + rename 用例） | 测试通过 |
| `tests/chat-save-rollback.test.ts`（新增：takeover 失败 → 回滚 → chat 回到旧 Being） | 测试通过 |
| `desktop/shared/desktop-types.ts`（`changeSession` 偏差声明） | 已移植 / 测试通过 |

门槛（2026-09-16）：`npm run typecheck` 通过；
`npx vitest run` → Test Files 57 passed | 7 skipped (64)，Tests 448 passed | 16 skipped (464)。

## 复审逐条处理

| # | 结论 | 处理 |
| --- | --- | --- |
| high | `beings:save` 回滚不通知 extensions | 已改。`main.ts` 回滚保存之后补 `extensions?.connectionVerified(store.connection)`；新增 `tests/chat-save-rollback.test.ts`（去掉这一行就红）。 |
| medium | `chat-rename-session` 丢了控制字符校验、长度判定在折叠之后 | 已改。`chat/ipc.ts` 照抄 0.8.26 的守卫（原始 title 测控制字符、trim 后测长度），文案换回「会话名须为 1–80 个字符，且不能包含换行。」；NUL/BEL/DEL/LF 与 `'x'*78+'   '+'y'` 都进了 refuse 列表。 |
| medium | `error.code` 过不了 handle 包装，测试假绿 | 已改。新增 `desktop/shared/chat-errors.ts`，五个通道改成返回 `{__townError:true,code,message}`，preload 侧还原成带 `code` 的 Error；`tests/chat-ipc.test.ts` 的所有调用改走真实的 `createTrustedHandle`（为此把 `main.ts` 里那段包装原样抽到 `desktop/main/app/ipc.ts`，行为不变），另加 sender 校验 / 退出守卫用例。 |
| low | `prepareMessage` 未接线 | 接受延后。P2 验收条件已写进本文件与 `p1-sessions.md`。 |
| low | `chat-change-session` 注释谎称与 §1.2 一致 | 已改成明确的偏差声明（`chat/ipc.ts` 与 `desktop-types.ts` 两处），并进了下面的偏差清单。 |

### 一处没按建议改，附证据

复审给 high 的修法是 `if (previousConnection) {…; connectionVerified} else await connectionCleared()`。
**`else` 分支没有加**，理由：

1. `SettingsStore.resolveConnection`（`app/settings.ts:197`）在 `connectionLink` 为空时回退到
   `this.connection`，否则抛「请先输入 Being 链接。」；`save()` 第一步就调它，最后一行
   `this.connection = connection`。所以 `await store.save(input)` 一旦成功，`store.connection`
   必定非 null。
2. `previousConnection` 为 null 只发生在「第一次连接」——而那条路径**根本不回滚**（`if (previousConnection)`
   为假，新设置原样留在盘上）。此时 `store.connection` 就是刚验过的新 Being。
3. 这时调 `connectionCleared()` 会把对话层解绑，而设置里仍写着这个 Being——变成反方向的不一致；
   而且原生对话是直连 Being 的 `/api/*`，Portal 接管失败并不否定一个 `/api/status` 已经答应过的 Being。
4. 如果失败发生在 `verifyConnection()` 自己（Being 不可达），`connectionVerified` 压根没执行过，
   对话层从未绑定，也没有要清的东西。

`tests/chat-save-rollback.test.ts` 里 `expect(fixture.cleared).toBe(0)` 把这个判断钉住了。

## 与 BeingDesktop 0.8.26 的偏差清单（本块新增）

1. **`beings:chat-change-session` 返回会话 id，不是 `{ok:true}`**。BeingDesktop
   `docs/interfaces.md` 行 88 与 `src/main.cjs:1177` 都返回 `{ok:true}`，调用方要再读一次
   `publicState().chatSessions.active` 才知道新建的是哪个。这里直接返回现在生效的 id。
   渲染层本来就要重写，P2 照着 BeingDesktop 的渲染层写会对不上——以本仓库
   `desktop/shared/desktop-types.ts` 的 `ChatAPI.changeSession` 为准。
2. **非法会话 id 的文案统一成「会话不存在。」**，BeingDesktop `changeChatSession` 用的是
   「会话标识无效。」（`src/main.cjs:1161`）。本仓库一个 `sessionId()` 守卫服务所有通道，
   分两种文案只会让渲染层多一条分支。
3. **包络的兜底文案沿用 BeingDesktop 的「Town 操作未完成，请稍后重试。」**。对话通道在
   0.8.26 里就是走 Town 包络的（`docs/interfaces.md` 行 92-96），未知 code 时用户看到的就是这句；
   逐行保真优先于措辞好看。
4. **`project` 参数未移植**：`changeChatSession(id, project='')` 的第二个参数属于侧边栏的
   项目归属（`sidebarState` / `saveSidebarAction`），侧边栏本身还没移植。

## 留给 P2 的验收条件（复审 low #4）

`ChatSessions` 的 `prepareMessage` 至今没接线（`desktop/main/extensions.ts:104-112` 构造时没传），
所以 `being-chat.ts:513` 恒为 `null`，`wrapMessage(text, undefined)` 原样返回——
`chat/context.ts` 的 `desktopMessageContext` / `DESKTOP_PORTAL_NAME` 与 `chat/frame.ts` 的
`orchestrationInstructions` / `setOrchestrationInstructions` 目前零引用。**在 orchestration 与
desktopEnvironment 落地的同一阶段必须**：

1. 在 `installDesktopExtensions` 里把 `prepareMessage` 传给 `ChatSessions`；
2. 补一条端到端用例：发出去的 wire 文本带 v1 帧，且 `unwrapMessage` 能原样剥掉；
3. 在那之前，不要把原生对话当成可交付给真实 Being 的功能——少了「环境数据不是指令 /
   本轮只能用 runtime.bridge.place」的注入边界文案。
