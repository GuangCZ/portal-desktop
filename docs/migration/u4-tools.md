# u4-tools — 工具桥与桌面工具 迁移记录

单元 key：`u4-tools`。分支 `u4-tools`，基线 `d5z/portal-desktop main @ 4921932`。
来源：`/Users/d5c/Documents/ChatGPT/BeingDesktop`（BeingDesktop 0.8.26 工作树，只读）。
移植日期：2026-09-16。

产出位置：源码 `desktop/main/tools/*.ts`，测试 `tests/tools-*.test.ts`。
本单元**只新增文件**，不修改任何既有文件，不新增依赖（`ws ^8.21.3` 已在 devDependencies）。

---

## 阅读摘要

### src/platform.cjs（34 行）→ desktop/main/tools/platform.ts
不在任务给定清单里，但 `src/desktop-console.cjs` 在模块作用域 require 它，所以必须一起移植。
导出面：`{desktopPlatform, desktopEnvironment, shellPath}`。

- `desktopPlatform(platform = process.platform, arch = process.arch)` →
  `{platform, arch, name, shell, terminalSupported, portalSupported}`。
  `name`: `{win32:'Windows', darwin:'macOS', linux:'Linux'}[platform] || platform`。
  `shell`: `platform==='darwin' ? 'zsh' : 'PowerShell'`。
  `terminalSupported`: `['win32','darwin'].includes(platform)`。
  `portalSupported`: `(win32 && x64) || (darwin && ['arm64','x64'].includes(arch))`。
- `desktopEnvironment(source = process.env, platform = process.platform)`：非 darwin 原样浅拷贝返回；
  darwin 上把 PATH 拆成绝对且不含 `\0\r\n` 的目录，追加
  `/opt/homebrew/bin`,`/usr/local/bin`,`/usr/bin`,`/bin`,`/usr/sbin`,`/sbin`，
  HOME 合法时再追加 `$HOME/.local/bin`,`$HOME/.cargo/bin`，去重后用 `:` 连接。
- `shellPath(platform, environment)`：darwin → `/bin/zsh`；否则
  `path.win32.join(SystemRoot||SYSTEMROOT||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')`。

### src/security.cjs（58 行）→ desktop/main/tools/security.ts
导出面：`{parseConnection, endpoint, publicModelUrl, protocolFile, sessionPartition, allowedNavigation}`。
常量：`SESSION_IDENTITY_VERSION = 'v1'`（模块私有）。

- `parseConnection(input)`：非字符串或 >8192 → `请输入有效的 Loom 连接地址。`；`new URL(input.trim())`
  失败 → `连接地址格式不正确。`；协议必须 https（或 loopback `127.0.0.1`/`localhost`/`[::1]` 的 http），
  且不得有 username/password → `Loom 地址须使用 HTTPS；本机回环地址可使用 HTTP。`；
  `api` 参数须与 url 同源、无 search/hash/凭据 → `Loom 和 API 必须位于同一来源，避免将连接凭据发送到其他网站。`；
  返回 `{url, apiBase, token, secret, displayUrl, beingName}`；
  `secret = relay_secret || secret || token`；`beingName = decodeURIComponent(最后一段 || 'Being')`。
- `endpoint(connection, route)`：只允许 `/api/status`、`/api/llm/config`、`/api/stream/active`，
  否则 `Unsupported read endpoint`；有 token 时追加 `?token=`。
- `publicModelUrl(value)`：`origin+pathname`，解析失败返回 `''`。
- `protocolFile(root, rawUrl)`：只认 `being://app`，否则 `Unknown app resource`；越界 `Invalid resource path`。
- `sessionPartition(connection)`：`persist:loom-v1-<sha256(JSON[v1,displayUrl,apiBase,token,secret]) 前32位hex>`。
- `allowedNavigation(connection, target)`：同 origin 且去尾斜杠后 pathname 相同。

### src/browser-links.cjs（27 行）→ desktop/main/tools/browser-links.ts
导出面：`{createBrowserLinks}`。构造参数 `{getBrowser, showBrowser, isCurrent = () => true, onError = () => {}}`，
返回 `{open, tryOpen, popup}`。原文件在模块作用域 `require('./desktop-browser.cjs')` 取 `normalizeBrowserUrl`；
**desktop-browser 归另一个并行单元**，所以这里把 `normalizeUrl` 作为构造参数注入。

- `open(url)`：`!isCurrent()` → `当前页面已关闭，无法打开网页。`；非字符串或不匹配 `/^https?:\/\//i` →
  `仅支持在内置浏览器中打开 HTTP 和 HTTPS 网页。`；否则 `normalizeBrowserUrl` → `getBrowser().newTab({url})`
  → `showBrowser()` → `{opened:true, tabId:snapshot.activeTabId}`。
- `tryOpen(url)`：`!isCurrent()` 返回 false；`open` 抛错则 `onError(error)` 并返回 false。
- `popup(details)`：`queueMicrotask(() => tryOpen(details.url))`，同步返回 `{action:'deny'}`。

### src/desktop-message-context.cjs（33 行）→ desktop/main/tools/message-context.ts
导出面：`{DESKTOP_PORTAL_NAME, desktopMessageContext}`。`DESKTOP_PORTAL_NAME = 'being-desktop'`。
`desktopMessageContext({platform = process.platform, hostname = os.hostname(), runtime = null} = {})` 返回
`[Being Desktop 当前消息环境]` … `[/Being Desktop 当前消息环境]\n\n` 的中文环境帧。分支：
`runtime?.desktopId` 有才写 Desktop ID 行；`runtime?.portal?.name` 为空时写「未确认；已有部署的配置名见
runtime.portal.configuredName…」；`runtime` 非空才附 `JSON.stringify(runtime)` 段；
`runtime?.mode === 'orchestrator'` → 编排段（一段），否则 → 直接执行段 + 两段终端说明
（`terminal.scope` 的 sessionId/sessionToken、requestId 去重、终端保留）。
**逐字照抄，不得改写任何中文串。**

### src/desktop-network.cjs（47 行）→ desktop/main/tools/network.ts
导出面：`{portalRequestAdapter}`。`portalRequestAdapter(requestImpl)` 返回 `(url, options, callback)`。
返回的 `request` 是 EventEmitter，另加 `destroy()`（置 ended/delivered，`nativeRequest?.abort()`，返回 self）
与 `end()`（幂等）。`end()` 用
`requestImpl({url:url.href,method:'GET',redirect:'manual',credentials:'omit',useSessionCookies:false,referrerPolicy:'no-referrer'})`，
监听 `error`→fail、`redirect(statusCode,method,redirectUrl)`→合成 `Readable.from([])` 且
`statusCode`/`headers={location}`，callback 后 `finally { nativeRequest.abort() }`、
`response`→已交付则 `response.resume()`，否则直接 callback。
请求头：`User-Agent: Being-Desktop-Portal-Installer`、`Accept: application/octet-stream`。
`fail()` 只在未交付时 emit `Error('Portal download failed')`。整个 try 包 catch → `fail()`。

### src/desktop-console.cjs（340 行）→ desktop/main/tools/console.ts
导出面：`{DesktopConsole, consoleEnvironment, WINDOWS_RUNNER}`。

- `ENVIRONMENT_KEYS`：46 个小写键名的 Set（allowlist），`consoleEnvironment(source=process.env)` 按小写键名过滤，
  只保留 string 且不含 `\0` 的值。
- `WINDOWS_RUNNER`：PowerShell + 内联 C#（`BeingConsoleJob`，JobObject `KILL_ON_JOB_CLOSE` flag `0x2000`，
  `SetInformationJobObject(job, 9, …)`），初始化失败 `exit 125`。**原样照抄整段字符串。**
- `outputTail(text, bytes)`：按 UTF-8 字节裁尾，跳过续字节 `(b & 0xc0) === 0x80`。
- `DesktopConsole` 构造参数：`{getWorkspace=()=>'', onChange=()=>{}, shellPath, maxOutputBytes=256*1024,
  maxJobs=20, maxConcurrent=3, spawnImpl=spawn, environment=process.env, platform=process.platform,
  killGroup=(pid,signal)=>process.kill(-pid,signal)}`。
  夹紧：`maxOutputBytes` ∈[1024, 1MB]，`maxJobs` ∈[1,50]，`maxConcurrent` ∈[1, min(maxJobs,5)]。
- `snapshot()` → `{shell, limits:{maxConcurrent,maxOutputBytes,maxJobs}, jobs:[…]}`，job 去掉 `outputBytes`
  并深拷贝 output 条目。
- `_notify(immediate=false)`：immediate 立即 emit 并清 timer，否则 50ms 合并；onChange 抛错被吞。
- `_append(job, stream, text)`：去 `\0`；条数上限 1000；字节超 `maxOutputBytes` 时从头裁（整条或 `outputTail`
  部分裁），置 `truncated`。
- `run({command, cwd, signal})`：错误串依次为 `控制台已经关闭。` / `命令取消信号无效。` /
  `命令调用已取消，尚未启动。` / `当前平台不支持本机控制台。` / `请输入有效命令，长度不能超过 65536 个字符。` /
  `` 最多同时运行 ${maxConcurrent} 个命令，请先停止或等待现有命令。`` / `请先选择有效的本地工作区。` /
  `命令工作目录不存在或无法访问，请重新选择工作区。` / `请先等待现有命令结束。`。
  spawn 参数：darwin `['-f','-s']`，否则 `['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text',
  '-EncodedCommand', base64(utf16le(WINDOWS_RUNNER))]`；options `{cwd, env:{...this.environment},
  detached: platform==='darwin', windowsHide:true, shell:false, stdio:['pipe','pipe','pipe']}`。
  spawn 抛错 → job.status='failed' 并 append `` 无法启动 ${shell}，请检查系统安装。\n ``，仍返回 `{jobId}`。
  事件：`spawn`→running；`error`→failed + `命令进程启动或运行失败。\n`；darwin `exit`→非 stopping 时
  `killGroup(pid,'SIGKILL')`，非 ESRCH 错误 → failed + `命令子进程清理未完成。\n`；
  `close(code,signal)`→ status = stopping?'stopped':(failed||code!==0?'failed':'completed')。
  abort 监听 `abortStartup` → `stop(jobId)`，失败 append `启动已取消，但进程未能停止，请在控制台重试停止。\n`。
  最后 `child.stdin.end(command,'utf8')`，`_notify(true)`，返回 `{jobId}`。
- `stop(jobId)`：非 string → `请选择有效的命令。`；无 owned → `{stopped:false}`；已 stopping → 等 closed →
  `{stopped:true}`；已退出 → 等 closed → `{stopped:false}`；darwin 用 `killGroup(pid,'SIGKILL')`（pid 必须是
  >1 的整数），否则 `child.kill()`；ESRCH 视为已杀；未杀掉 → 回滚 status 并抛 `未能停止该命令，请重试。`。
- `clear(jobId?)`：非 string 且非 undefined → `请选择有效的命令。`；清空 output/outputBytes/truncated，
  返回 `{cleared}`。
- `dispose()`：置 `_disposed`，`Promise.allSettled` 停所有子进程；有 rejected 则回滚 `_disposed=false` 并抛出。

### src/desktop-tool-link.cjs（396 行）→ desktop/main/tools/tool-link.ts
导出面：`{DesktopToolLink, toolDefinitions(workerMode=false), validArguments, MAX_MESSAGE_BYTES,
MAX_RESPONSE_BYTES, MAX_PENDING, MAX_REQUESTS, MAX_BUFFERED_BYTES}`。
常量：`MAX_MESSAGE_BYTES=131072`、`MAX_RESPONSE_BYTES=8MB`、`MAX_PENDING=4`、`MAX_REQUESTS=16384`、
`MAX_BUFFERED_BYTES=8MB`、`HEARTBEAT_INTERVAL_MS=15000`、`HEARTBEAT_DEADLINE_MS=90000`（后两个不导出）。

- 19 个工具定义：6 个 `desktop_browser_*`、3 个 `desktop_console_*`、6 个 `desktop_terminal_*`（前 15 个
  为直接模式），再 push 4 个 `desktop_worker_*`。每个工具 schema 都自动带 `place`/`target_portal`
  （`string(128)`）且都在 `required` 里，`additionalProperties:false`。
- `validArguments(name,args)`：先 `normalizeWorkerArguments`（worker_start 丢弃空的 parentWorkerId/agentId；
  worker_status 按 action 丢弃对应空字段），再 schema 校验（keys 白名单、required 里 `place` 例外、
  enum、字符串长度与 pattern、integer 最小值），再 `desktop_worker_status` 的 action 专属 required/allowed
  校验（present 要求 url/artifactPath 恰好一个），最后 `desktop_browser_open` 的 URL 协议/凭据/控制字符校验。
- `result(value)` 校验工具返回：`content` 最多 16 块；text 块 ≤1MB；image 块 mimeType ∈
  `image/png|image/jpeg|image/webp`，base64 规范化后必须自洽。
- `DesktopToolLink` 构造参数：`{onChange=()=>{}, invokeTool, portalName, toolAllowed=name=>!name.startsWith
  ('desktop_worker_'), WebSocketImpl=WebSocket, clock=()=>performance.now(), timers=globalThis,
  shouldReconnect=()=>false}`；`invokeTool`/`onChange` 非函数 → `工具调用处理器无效。`；
  portalName 必须匹配 `^[a-zA-Z0-9._-]{1,128}$`，否则 `Invalid desktop Portal name`；
  默认 `being-desktop-tools-<uuid 去横线前 12 位>`。
- `connect(connection)`：`parseConnection(connection.url)`，beingId 为 pathname 首段且匹配
  `^[a-zA-Z0-9_-]{1,100}$`，token 1..4096 且无 CRLF 且与 `connection.token` 相同，否则
  `Loom 连接缺少有效的 Being 身份或令牌。`；WS 地址 `new URL('/_relay', loom.origin)`，协议 http→ws 否则 wss；
  握手帧 `{being_id, loom_token, portal_name}`；握手超时 10000ms → `工具连接握手未完成，请重新连接。`（可重连）。
  握手响应只允许键 `ok/being_id/relay_keepalive`，`ok===true`，being_id 匹配，`relay_keepalive==='text-v1'`；
  不是 text-v1 且 socket 没有 ping/on → `工具连接不支持服务器的心跳协议。`。
  心跳 `setInterval(15000)`：超过 90000ms 未见活动 → `工具连接已失去响应，请重新连接。`（可重连）；
  text-v1 发 `{type:'keepalive'}`，收 `{type:'keepalive_ack'}` 刷新 lastSeen；否则 `socket.ping('bd',cb)`。
- `#message`：JSON-RPC 2.0；错误码 `-32700` Invalid JSON. / `-32600` Single request object required. /
  Invalid request. / Request identifier already used. / `-32602` Invalid initialization parameters. /
  Parameters not permitted. / Tool arguments not permitted. / Portal target mismatch;… / `-32002`
  Initialize the tool session first. / `-32601` Method not permitted. / `-32000` Too many pending desktop
  tool requests.；请求上限 16384 → `本次工具连接已达到请求上限，请重新连接。`；
  `initialize` 回 `{protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:false}},
  serverInfo:{name:'being-desktop-tools',version:'1.0.0'}}` 并把 `#reconnectAttempt` 归零；
  `tools/list` 把 place/target_portal 改成 `enum:[portalName]` 并在 description 追加
  `` ` Execution host: ${JSON.stringify(os.hostname())}, OS: ${process.platform}; Portal: ${portalName}.` ``；
  `tools/call` 依次校验 keys → validArguments → toolAllowed → target_portal/place 相符 → pending<4。
- `#invoke`：删 `place`/`target_portal`，调用 `invokeTool(name,args,{signal,requestKey})`，
  结果前插 `targetReceipt(place)`（`{execution_target:{place,hostname,platform}}`）；
  失败统一回 `Desktop tool was not completed. Check the local approval or tool status.` + `isError:true`。
- `#scheduleReconnect`：`Math.min(60000, 2000 * 2 ** Math.min(attempt++, 5))` → 2/4/8/16/32/64→60s 封顶；
  只有 `shouldReconnect()` 为真才排期；`#state.reconnect = {attempt, delayMs}`。
- `disconnect()` 清重连状态并 `#end()`；`dispose()` 置 disposed 后 disconnect。
- **移植注入点**：`ws` 没有随包类型声明且仓库没有 `@types/ws`，所以按仓库既有做法
  （见 `tests/portal-tools-native.test.ts`）用 `createRequire(import.meta.url)('ws')` 懒解析默认实现，
  `WebSocketImpl` 注入时完全不加载 ws。

### src/desktop-tools.cjs（151 行）→ desktop/main/tools/desktop-tools.ts
导出面：`{DesktopTools}`。构造参数
`{desktopId, WebContentsView, session, getWindow, getConnection, getWorkspace, onChange, orchestration,
getTerminal=()=>null, showTerminal=()=>{}, Browser=DesktopBrowser, Console=DesktopConsole,
ToolLink=DesktopToolLink}`。
`textResult = value => ({content:[{type:'text',text:JSON.stringify(value)}],isError:false})`。

- 构造：`terminalTools = new DesktopTerminalTools({getTerminal, showTerminal})`；
  `link = new ToolLink({shouldReconnect: () => !disposed && orchestration?.mode.enabled===true &&
  !orchestration.configuring, …(desktopId?{portalName:desktopPortalName(desktopId)}:{}), onChange,
  toolAllowed: name => orchestration?.mode.enabled ? name.startsWith('desktop_worker_')
  : !name.startsWith('desktop_worker_') && (!name.startsWith('desktop_terminal_') ||
  Boolean(getTerminal()) && ['win32','darwin'].includes(process.platform)), invokeTool: …this.request})`。
- `snapshot()`：`{browser, console（jobs 补 origin: 'being'|'you'）, link, workspace, requestResult, requests}`；
  会顺手清掉不存在 job 的 `jobOrigins`。
- `changed()`：`setImmediate` 合并一次 onChange。
- `perform(action,value)`：`browser.new/activate/close/navigate/back/forward/reload/stop`、
  `console.run/stop/clear`、`link.connect`（无连接 → `请先连接 Being。`，先 `disconnectLink()`）、
  `link.disconnect`、`request.allow`、`request.deny`；未知 → `未知桌面工具操作。`；
  已 disposed → `桌面工具已关闭。`。
- `request(name,args,{signal,requestKey})`：编排模式只放行 `desktop_worker_*`（否则
  `编排模式下 Being 只能调度 worker，不能直接执行桌面工具。`）；非编排模式遇 `desktop_worker_*` →
  `编排模式未开启。`；disposed/aborted → `调用已取消。`；`desktop_terminal_*` 直接走 terminalTools，
  错误信息只在匹配白名单正则时透传，否则统一为
  `交互终端操作未完成，请读取终端列表和当前消息的会话绑定后核对。`；
  待确认队列 ≥8 → `待确认调用过多，请稍后重试。`；浏览器工具校验 tabId 存在
  （`浏览器标签已关闭。`）与 revision（`页面已变化，请重新读取。`）；`desktop_console_run` 补 cwd；
  `desktop_console_status/stop` 限定 remoteJobs（`只能读取/停止本次 Being 连接发起的命令。`）；
  click/fill 先 `browser.prepareAction` 再入队；入队时若 generation 变化 → `调用已取消。`。
- `decide(id,allow)`：找不到或非 pending → `该调用已处理或已取消。`；拒绝 → `用户拒绝了本次调用。`。
- `finish(request,error,result)`：写 `requestResult={id,status,message}`，成功消息 `Being 调用已完成。`。
- `invoke(name,args,…)`：编排模式 → `编排模式下禁止 Being 直接执行桌面工具。`；
  revision 过期 → `请求已过期：页面或操作目标已变化，请重新申请。`；
  分派 6 个 browser、3 个 console；screenshot 返回 image 块；console.run 记 jobOrigins/remoteJobs，
  中途取消则停止并抛 `连接已结束，命令已停止。`；未知 → `工具不可用。`。
- `disconnectLink()`：`generation++`，清 remoteJobs，`link.disconnect()`，把待确认调用全部
  `finish(…, new Error('工具连接已断开。'))`。
- `dispose()`：disconnectLink → `console.dispose()` → `browser.destroy()` → `disposed=true`。
- **移植注入点**：`DesktopBrowser`、`DesktopConsole`、`DesktopToolLink`、`desktopPortalName`、
  `Orchestration` 都在构造参数里注入（`desktopPortalName` 归身份单元、`DesktopBrowser` 归浏览器单元、
  `Orchestration` 归编排单元），接口定义在 `desktop/main/tools/types.ts`。

### src/desktop-terminal-tools.cjs（65 行）→ desktop/main/tools/terminal-tools.ts
导出面：`{DesktopTerminalTools}`。构造参数 `{getTerminal, showTerminal}`。

- `scope(sessionId)`：首次创建 `{sessionToken: randomUUID(), terminals:Set, requests:Map}`，
  返回 `{sessionId, sessionToken}`。
- `sessions(sessionId)`：只返回本 scope 拥有的终端。
- `reset()`：清空所有 scope。
- `invoke(name,args,{signal})`：`check()` 在每次执行前校验 signal/scope 身份与 sessionToken →
  `终端调用不属于当前桌面会话，请使用当前消息中的会话绑定。`；无终端 → `交互终端尚未就绪。`；
  `desktop_terminal_list` 直接返回 `{sessions}`；非 create 且终端不属本会话 →
  `只能操作本会话创建的终端，不能接管其他会话或用户单独创建的终端。`；
  create 成功后再 `check()`，失败则关掉刚建的终端再抛；
  create 返回 `{terminalId, shell: terminal.shell||'PowerShell', interactive:true, visible:true,
  ...terminal.readSince(id,0)}`；write 返回 `{...result, terminalId, status}`；
  read 返回 `{...readSince, terminal}`；show 返回 `{terminalId, visible:true}`；close 直接返回
  `terminal.close(id)`；未知 → `终端工具不可用。`。
- create/write/close 三个动作需要 `requestId`（否则 `终端操作需要 requestId，重试时沿用同一个值。`），
  按 `JSON.stringify([name, terminalId||'', cwd||'', data||''])` 做指纹去重，重复 requestId 不同指纹 →
  `同一 requestId 不能用于不同终端操作。`，相同则复用同一个 promise；
  记录上限 10000 → `当前会话的终端操作记录已满，请新建对话。`。
- **移植注入点**：`DesktopTerminal`（`getTerminal()` 返回值）归终端单元，接口在 `types.ts` 里定义为
  `DesktopTerminalLike`。

### src/worker-presentation.cjs（82 行）→ desktop/main/tools/worker-presentation.ts
导出面：`{WorkerPresentation}`。构造参数 `{browser, showBrowser}`。
`MIME` 表 18 个扩展名；`inside(root,file)` 用 `path.relative` 判定包含关系。

- `describe(value)`：按浏览器快照推断 `state ∈ closed|navigated|failed|loading|loaded`，
  补 `visible/title/error/detail`（detail 是 5 条中文说明，逐字照抄）。
- `staticUrl(worker, artifactPath, current)`：`fs.realpath(worker.cwd)` 作工作区，入口必须在工作区内
  （`结果入口必须位于此 Worker 的工作区内。`），目录则取 `index.html`，必须是工作区内的 `.html` 文件
  （`静态结果请提供工作区内的 HTML 入口或包含 index.html 的目录。`）；同 key 复用已有服务器；
  上限 16（`静态结果预览已达上限，请重启桌面端后重试。`）；
  HTTP 服务器只监听 `127.0.0.1:0`，校验 Host/Origin（403）、方法 GET/HEAD（405）、
  路径解码失败 400、`..`/点开头/`:`/`\0` → 403、realpath 失败 404、越界或未知 MIME 403、非文件 404、
  >32MB 413；成功返回头含 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: no-referrer`；监听后若 `!current()` 则关闭并抛 `结果展示已取消。`。
- `open(worker, args, {current=()=>true, reveal=true})`：同 worker 的并发以
  `JSON.stringify([artifactPath||null, url||null, reveal])` 为 key 合并，不同 key →
  `此 Worker 的另一结果正在打开，请稍后重试。`；artifactPath 与 url 必须恰好一个
  （`请指定一个结果 HTML 路径或网页 URL。`）；路径 >4096 → `结果路径无效。`；
  URL 非 http(s) → `结果网页仅支持 HTTP 和 HTTPS 地址。`；复用已有标签页（错误则 reload），
  否则新开标签页并用 before/after 差集找出新 tabId；`reveal` 时 `showBrowser()`；
  最后 `valid()` 失败 → `结果展示所属会话已变化。`。
- `dispose()`：`revision++` 并关闭所有静态服务器。
- **移植注入点**：`normalizeBrowserUrl`（`src/desktop-browser.cjs`，归浏览器单元）改为构造参数注入；
  `browser`/`showBrowser` 本来就是构造参数。

---

## 进度

| 模块 | 源文件 | 目标 | 状态 |
| --- | --- | --- | --- |
| platform | src/platform.cjs | desktop/main/tools/platform.ts | 已移植 |
| security | src/security.cjs | desktop/main/tools/security.ts | 已移植 |
| browser-links | src/browser-links.cjs | desktop/main/tools/browser-links.ts | 已移植 |
| message-context | src/desktop-message-context.cjs | desktop/main/tools/message-context.ts | 已移植 |
| network | src/desktop-network.cjs | desktop/main/tools/network.ts | 已移植 |
| console | src/desktop-console.cjs | desktop/main/tools/console.ts | 已移植 |
| tool-link | src/desktop-tool-link.cjs | desktop/main/tools/tool-link.ts | 已移植 |
| types（注入接口） | — | desktop/main/tools/types.ts | 已移植 |
| desktop-tools | src/desktop-tools.cjs | desktop/main/tools/desktop-tools.ts | 测试通过 |
| terminal-tools | src/desktop-terminal-tools.cjs | desktop/main/tools/terminal-tools.ts | 测试通过 |
| worker-presentation | src/worker-presentation.cjs | desktop/main/tools/worker-presentation.ts | 测试通过 |

| 测试 | 源文件 | 目标 | 状态 |
| --- | --- | --- | --- |
| security | test/security.test.cjs | tests/tools-security.test.ts | 测试通过（7/7） |
| browser-links | test/browser-links.test.cjs | tests/tools-browser-links.test.ts | 测试通过（5/5） |
| network | test/desktop-network.test.cjs | tests/tools-network.test.ts | 测试通过（13/13） |
| console | test/desktop-console.test.cjs | tests/tools-console.test.ts | 测试通过（12/12） |
| tool-link | test/desktop-tool-link.test.cjs | tests/tools-tool-link.test.ts | 未开始 |
| desktop-tools | test/desktop-tools.test.cjs | tests/tools-desktop-tools.test.ts | 测试通过（16/16） |
| terminal-tools | test/desktop-terminal-tools.test.cjs | tests/tools-terminal-tools.test.ts | 测试通过（4/4） |
| worker-presentation | test/worker-presentation.test.cjs | tests/tools-worker-presentation.test.ts | 测试通过（6/6） |
| console 集成 | test/desktop-console-integration.cjs | tests/tools-console-integration.test.ts | 未开始 |

### 移植期补充记录（2026-09-16 第二段）
- `TerminalScope` 在 TS 里写成 type alias 而非 interface，好让它能直接展开进带索引签名的
  `TerminalToolArguments`（interface 没有隐式索引签名）。运行时语义不变。
- `WorkerPresentation` 构造里的 `Object.assign(this,{…})` 改成三行显式赋值：TS 的
  `strictPropertyInitialization` 不认 `Object.assign`。语义不变。
- `worker-presentation` 测试里的 `normalizeBrowserUrl` 由 `navigationUrl` 夹具代入
  （逐行抄自 `src/desktop-browser.cjs` 16..24 行），因为 desktop-browser 归浏览器单元。
  被测输入只有 http(s)，所以只需要 navigationUrl 这一支。
- 浏览器夹具的 `activeTabId` 写成 `tabs.at(-1)?.id ?? null`（原文件是 `?.id`，会得到
  `undefined`）：`BrowserSnapshot.activeTabId` 是 `string | null`，两者在所有断言里等价。
- `DesktopTools` 的 `Browser` 与 `desktopPortalName` 在 TS 版里是**必填**构造参数（BeingDesktop 里是
  `require` 进来的默认值）：`src/desktop-browser.cjs` 与 `src/desktop-identity.cjs` 不在本 worktree。
  `Console`/`ToolLink` 保留默认值，指向本单元移植出的 `DesktopConsole` / `DesktopToolLink`。
- `target=tab.url || tab.title` 保留原表达式，只加了 `as string`（不是 `|| ''`），保证 url/title 都为空时
  运行期取值与 BeingDesktop 一致。
- `desktop-tools` 测试里的 `desktopPortalName` 夹具逐行抄自 `src/desktop-identity.cjs` 5..10 行。
- `browser-links` 测试同样内联 `normalizeBrowserUrl` + `navigationUrl` 夹具（src/desktop-browser.cjs 16..34 行）。
- console 测试里的 `__dirname`/`__filename` 换成 `path.resolve("tests")` 与本测试文件路径（vitest 的 cwd 是仓库根）。
