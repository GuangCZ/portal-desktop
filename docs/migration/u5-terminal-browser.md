# 迁移单元 u5：终端与内置浏览器

来源：BeingDesktop 0.8.26（/Users/d5c/Documents/ChatGPT/BeingDesktop，只读）
目标：portal-desktop（TypeScript strict），源码 `desktop/main/tools/terminal`、`desktop/main/tools/browser`，测试 `tests/tools-terminal-*.test.ts`、`tests/tools-browser-*.test.ts`
迁移日期：2026-09-16

范围：src/desktop-terminal.cjs、src/desktop-browser.cjs 及其单元测试 test/desktop-terminal.test.cjs、test/desktop-browser.test.cjs。
不做集成（IPC / renderer / main.ts 挂钩留给后续阶段）。

---

## 阅读摘要

（每读完一个文件立刻追加）

### src/desktop-terminal.cjs（258 行）

依赖：`node:fs/promises`、`node:path`、`node:os`、`node:crypto.randomUUID`、`./platform.cjs`（`desktopPlatform`、`desktopEnvironment`、`shellPath as defaultShellPath`）、`./desktop-console.cjs`（`consoleEnvironment`）、可选 `require('node-pty')`（惰性，仅当构造参数没给 `pty` 时）。

导出面：`module.exports = { DesktopTerminal }`。

常量：`MAX_INPUT_BYTES = 64 * 1024`；`MAX_REPLAY_BYTES = 1024 * 1024`；`MAX_SESSIONS = 8`。

模块级函数：
- `dimensions(cols = 100, rows = 30)` — 要求 cols 为整数且 2..500、rows 为整数且 1..200，否则 `throw new Error('终端尺寸无效。')`；返回 `{cols, rows}`。注意默认值只在 `undefined` 时生效。
- `function* outputChunks(text)` — 按 16384 个 **UTF-16 码元**切片；若切点前一个字符是高代理（`/[\uD800-\uDBFF]/`）则 end--，避免劈开代理对。

构造参数（全部有默认值）：`{ getWorkspace = () => '', onChange = () => {}, onData = () => {}, pty, environment = process.env, platform = process.platform, shellPath }`。
构造体：
- `this.environment = { ...consoleEnvironment(desktopEnvironment(environment, platform)), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'BeingDesktop' }`
- `this.shellPath = shellPath || defaultShellPath(platform, environment)`
- `this.shell = desktopPlatform(platform).shell`
- `this.sessions = new Map()`；`this.activeSessionId = null`；`this.pendingCreates = 0`；`this.disposed = false`。

会话对象字段：`{id, title, cwd, status, pid, cols, rows, exitCode, process, sequence, chunks, replayBytes, truncated, subscriptions, closing, nativeReleased, didExit, exited, resolveExit}`。

方法：
- `snapshot()` → `{sessions: [{id,title,cwd,status,pid: item.process?.pid || item.pid, cols,rows,exitCode}], activeSessionId}`。
- `changed()` — 调 `onChange(snapshot())`，吞掉观察者异常。
- `requireSession(id, running = false)` — id 非 string 或不存在 → `'终端会话不存在。'`；running 且（this.disposed 或 status !== 'running'）→ `'终端会话已结束。'`。
- `async create({cwd, cols, rows} = {})`：
  1. `this.disposed` → `'终端已经关闭。'`
  2. `!desktopPlatform(this.platform).terminalSupported` → `'当前平台不支持交互终端。'`
  3. `dimensions(cols, rows)`
  4. `sessions.size + pendingCreates >= MAX_SESSIONS` → `` `最多同时保留 ${MAX_SESSIONS} 个终端，请先关闭一个终端。` ``
  5. `pendingCreates++`，`try { ... } finally { pendingCreates-- }`
  6. `cwd === undefined ? ((await this.getWorkspace()) || os.homedir()) : cwd`；非 string / 非绝对路径 / 含 `\0` → `'请先选择有效的本地工作区。'`
  7. `fs.realpath(requested)` + `fs.stat(directory).isDirectory()`，任何失败 → `'终端工作目录不存在或无法访问。'`
  8. 再查一次 `this.disposed` → `'终端已经关闭。'`
  9. `this.pty ||= require('node-pty')`；`pty.spawn(this.shellPath, platform === 'darwin' ? ['-f','-i'] : ['-NoLogo','-NoProfile'], { name:'xterm-256color', cwd: directory, cols, rows, env: {...this.environment}, handleFlowControl:false, ...(win32 ? {useConpty:true,useConptyDll:true,conptyInheritCursor:false} : {}) })`；失败 → `` `无法启动 ${this.shell} 交互终端，请检查终端组件与系统安装。` ``（带 `cause`）
  10. 建 item（`randomUUID()`、`title: this.shell`、`status:'running'`、`pid: processHandle.pid || null`），`sessions.set`，`activeSessionId = item.id`
  11. 订阅 `onData` → `this.append(item, data)`；`onExit(({exitCode}) => ...)`：didExit 守卫；`pid` 刷新；`status='exited'`；`exitCode = Number.isInteger(exitCode) ? exitCode : null`；darwin 上直接 `nativeReleased = true`（不 kill）；否则 `nativeReleased = true; try kill() catch { nativeReleased = false }`；随后 `processHandle._agent?.inSocket?.destroy()` 与 `processHandle._agent?._conoutSocketWorker?.dispose()`（各自 try/catch 吞掉）；`if (item.nativeReleased) item.process = null`；`resolveExit()`；`changed()`
  12. 若 `typeof processHandle.on === 'function'`，注册 `'error'` 监听：didExit 则 return；`status='failed'`；append `` `\r\n\x1b[31m${this.shell} 终端连接已中断。请关闭此会话并重新打开终端。\x1b[0m\r\n` ``；`changed()`；`nativeReleased = true; try kill() catch { nativeReleased=false }`；订阅数组里放一个 `{dispose: () => removeListener('error', onError)}`
  13. 订阅阶段抛错 → `kill()`（吞）、`this.remove(item)`、`` throw new Error(`无法连接 ${this.shell} 交互终端。`, {cause}) ``
  14. `changed()`；返回 `{ sessionId: item.id }`
- `append(item, text)` — 会话已删除 / text 非字符串 / 空串 → 直接 return；逐块 `sequence++`、push、`replayBytes += byteLength`；`while (replayBytes > MAX_REPLAY_BYTES || chunks.length > 4096)` shift 并置 `truncated = true`；每块调 `onData({id, sequence, data})`，吞掉观察者异常。
- `read(id)` → `{id, sequence, data: chunks.join(''), truncated}`（不要求 running）。
- `readSince(id, afterSequence = 0)` — 非安全整数 / <0 / > item.sequence → `'终端输出游标无效。'`；`first = sequence - chunks.length + 1`；从 `Math.max(0, afterSequence - first + 1)` 起累加，单次上限 `128 * 1024` 字节（超出即 break，不含该块）；返回 `{id, data, sequence, latestSequence, hasMore: sequence < item.sequence, truncated: afterSequence < first - 1}`。注意返回的 `id` 是传入的 id 参数。
- `write({id, data} = {})` — `requireSession(id, true)`；data 非 string 或 > 64 KiB → `'终端输入不能超过 64 KiB。'`；空串不写；返回 `{written: true}`。
- `resize({id, cols, rows} = {})` — `requireSession(id, true)`；`dimensions()`；尺寸不变则不调用 `process.resize`、不 `changed()`；返回 `{resized: true}`。
- `activate(id)` — `requireSession(id)`（不要求 running）；设 activeSessionId；`changed()`；返回 `snapshot()`。
- `remove(item)` — dispose 所有订阅（`subscription?.dispose()`）；`sessions.delete`；若删的是 active 则 `activeSessionId = [...sessions.keys()].at(-1) || null`；`changed()`。
- `async close(id)` — `requireSession(id)`（不要求 running）；已有 `item.closing` 直接返回同一个 promise（幂等）；`!item.process` → `remove` 并 `{closed:true}`；否则 `status='closing'`、`changed()`，`item.closing = Promise.resolve().then(async () => {...})`：`nativeReleased = true`；`kill()` 失败则 `nativeReleased = false` 并抛；`Promise.race([item.exited, 7000ms 超时 → '终端尚未结束，请稍后重试关闭。'])`；成功 `remove(item)` 返回 `{closed:true}`；失败时 `item.closing = null`，若 `item.process` 还在则 `status='running'`，`changed()`，重抛；`finally clearTimeout`。
- `async dispose()` — `disposed = true`；`Promise.allSettled` 关掉所有会话；有 rejected 则 `disposed = false` 并抛第一个 reason。

移植注意：`_agent.inSocket` / `_agent._conoutSocketWorker` 是 node-pty 内部字段，TS 里要在 PtyLike 上声明为可选的 unknown 形状。


---

## 进度

| 模块 | 状态 |
| --- | --- |
| desktop-terminal.cjs → tools/terminal/terminal.ts | 测试通过（18/18） |
| tools/terminal/types.ts (PtyLike / PtyFactory) | 已移植 |
| tools/terminal/platform.ts (platform.cjs + consoleEnvironment) | 已移植 |
| desktop-browser.cjs → tools/browser/browser.ts | 未开始 |
| tools/browser/host.ts (ElectronBrowserHost) | 未开始 |
| tools/browser/electron-host.ts | 未开始 |
| tests/tools-terminal-terminal.test.ts | 测试通过（18 条，与原文件一一对应） |
| tests/tools-browser-browser.test.ts | 未开始 |

### src/platform.cjs（33 行，terminal 的依赖）

导出 `{desktopPlatform, desktopEnvironment, shellPath}`。
- `desktopPlatform(platform = process.platform, arch = process.arch)` → `{platform, arch, name: {win32:'Windows',darwin:'macOS',linux:'Linux'}[platform] || platform, shell: platform === 'darwin' ? 'zsh' : 'PowerShell', terminalSupported: ['win32','darwin'].includes(platform), portalSupported: (win32 && x64) || (darwin && arm64|x64)}`。
- `desktopEnvironment(source = process.env, platform = process.platform)` — 非 darwin 直接浅拷贝返回；darwin 上把 `PATH` 按 `:` 拆开，只留 `path.posix.isAbsolute` 且不含 `\0\r\n` 的项，再追加 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`；若 `HOME` 合法再追加 `$HOME/.local/bin`、`$HOME/.cargo/bin`；最后 `[...new Set(dirs)].join(':')`。（注释：Finder 启动的程序不继承终端的 Homebrew PATH，这里不求值登录 shell。）
- `shellPath(platform = process.platform, environment = process.env)` — darwin → `/bin/zsh`；否则 `path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')`。

### src/desktop-console.cjs 里的 `consoleEnvironment`（terminal 的依赖；DesktopConsole 本体不属本单元）

`module.exports = { DesktopConsole, consoleEnvironment, WINDOWS_RUNNER }`。
`ENVIRONMENT_KEYS`（全小写集合）：tmpdir, lang, lc_all, lc_ctype, user, logname, shell, systemroot, windir, systemdrive, comspec, pathext, path, home, userprofile, homedrive, homepath, appdata, localappdata, temp, tmp, username, userdomain, computername, os, number_of_processors, processor_architecture, processor_identifier, processor_level, processor_revision, programfiles, programfiles(x86), programw6432, commonprogramfiles, commonprogramfiles(x86), commonprogramw6432, allusersprofile, public, psmodulepath。
`consoleEnvironment(source = process.env)` — 只保留 key 的小写形式命中集合、值为 string 且不含 `\0` 的项（保留原 key 大小写）。

本单元处理：把 `desktopPlatform / desktopEnvironment / shellPath / consoleEnvironment` 逐行移植到 `desktop/main/tools/terminal/platform.ts`（本单元目录内，避免与并行单元的 tools 顶层文件撞名）；集成阶段若 console 单元也移植了同名函数，应合并到一份共享模块。

### test/desktop-terminal.test.cjs（282 行，18 个用例）

**它注入假 pty，不起真 node-pty**（`fixture()` 里 `pty = { spawn: (...args) => {...new FakePty(1000 + calls.length)} }`），因此全部用例都能在 vitest 下跑，无需 it.skip。

`class FakePty`：`constructor(pid)` → `{pid, data:Set, exit:Set, errors:Set, writes:[], sizes:[], kills:0}`；`onData(l)`/`onExit(l)` 加入集合并返回 `{dispose}`；`emit(text)` 对 data 集合逐个调用；`end(exitCode = 0)` 对 exit 集合调 `listener({exitCode})`；`write(v)` push 到 writes；`resize(cols, rows)` push `{cols, rows}`；`kill()` → `kills++` 且 `end(1)`；`on('error', l)` / `removeListener('error', l)` 维护 errors 集合。

`fixture(options = {})` → `{service, calls}`；`calls` 每项 `{args, handle}`；默认 `getWorkspace: () => path.resolve(__dirname, '..')`（BeingDesktop 仓库根，真实存在的目录）、`platform: 'win32'`，options 覆盖在后。

用例清单（顺序即原文件顺序）：
1. `terminal construction is lazy and snapshots contain no output or environment` — 初始 snapshot `{sessions: [], activeSessionId: null}`；calls 为空；dispose 后 `create()` rejects `/关闭/`。
2. `creation selects a real directory, ConPTY and an interactive shell with a clean environment` — environment 夹具 `{SystemRoot:'C:\Windows', Path:'safe-path', OPENAI_API_KEY:'private', BEING_TOKEN:'private', HTTP_PROXY:'http://user:secret@proxy', ELECTRON_RUN_AS_NODE:'1', OTHER:'private'}`；`create({cols:91, rows:22})`；断言 file 匹配 `/powershell\.exe$/i`、args `['-NoLogo','-NoProfile']`、`options.useConpty === true`、`options.conptyInheritCursor === false`、`options.env.Path === 'safe-path'`、`options.env.TERM === 'xterm-256color'`、五个敏感键为 undefined；snapshot activeSessionId === sessionId、cols 91、status 'running'。
3. `input, Ctrl+C and terminal responses go to the same persistent session` — 写入 `['cd child\r','echo 中文🙂\r','\x03','\x1b[A','\x1b[1;1R']` 全部落到 handle.writes；`calls.length === 1`；`write({id, data:'界'.repeat(23000)})` throws `/64 KiB/`；`data: null` 也 throws `/64 KiB/`；未知 id throws `/不存在/`。
4. `resize validates before native calls and ignores identical dimensions` — 默认尺寸 100x30，`resize(100,30)` 不触发 native；`resize(120,42)` 触发一次；`[[0,20],[501,20],[80,201],[80.5,20],[80,NaN]]` 全 throws `/尺寸/`；sizes 仍为 1。
5. `incremental terminal reads paginate complete Unicode chunks and report expired cursors` — emit `'中文🙂'.repeat(100000)`；循环 readSince 直到 `hasMore === false`，每次 `truncated === false`、字节 ≤ 128*1024、`sequence > 上一次`；拼接等于原文；再 readSince 得空串；随后 emit `'x'.repeat(2*1024*1024)` 后 `readSince(id, 0).truncated === true`；`readSince(id, Number.MAX_SAFE_INTEGER)` throws `/游标/`。
6. `invalid creation dimensions and invalid directories never spawn` — `[{cols:0},{rows:201},{cwd:'relative'},{cwd:__filename},{cwd:path.join(__dirname,'missing-terminal-fixture')}]` 全 rejects；`calls.length === 0`。
7. `the eight-session limit includes concurrent pending creates` — `getWorkspace` 返回一个受控 promise；先并发发起 8 个 create，第 9 个立即 rejects `/8 个终端/`；release 后 8 个都成功、`calls.length === 8`；再 create 仍 rejects `/8 个终端/`。
8. `dispose during asynchronous workspace resolution prevents the spawn` — create 挂起时 dispose，再 release；pending rejects `/关闭/`；`calls.length === 0`。
9. `replay sequence and streaming sequence avoid loss or duplicate delivery` — emit 'one'；`read(id)` → `{data:'one', sequence:1}`；emit 'two'；`replay.data + 事件里 sequence > replay.sequence 的拼接 === 'onetwo'`；两条事件 id 均为 session id；`'data' in snapshot().sessions[0] === false`。
10. `replay memory and individual stream chunks are bounded without splitting Unicode` — emit `'界🙂'.repeat(400000) + 'tail-marker'`；`read()` 的 `truncated === true`、字节 ≤ 1024*1024、以 'tail-marker' 结尾；每条事件字节 ≤ 64*1024 且 UTF-8 往返一致；replay 同样往返一致（即不劈代理对）。
11. `observer failures cannot lose replay or interrupt terminal teardown` — onChange/onData 都抛错；read 仍拿到 'still-available'；dispose 后 `kills === 1`。
12. `closing a session stops only its owned PTY, preserves others and deduplicates` — 建两个，activate(first)，`Promise.all([close(first), close(first)])`；`calls[0].kills === 1`、`calls[1].kills === 0`；activeSessionId 变成 second；`handle.data.size === 0`、`handle.exit.size === 0`（订阅已 dispose）。
13. `natural exit preserves scrollback and exit code but blocks new input` — emit 'last output'；`end(7)`；snapshot exitCode 7、status 'exited'；read 仍有输出；write throws `/结束/`；resize throws `/结束/`；`close(id)` 后 `kills === 1`（close 走 `item.process` 已被置 null 的分支？不——win32 上 `nativeReleased` 在 onExit 里被置 true 后调用了 kill，kills 已为 1，`item.process = null`，所以 close 走 `!item.process` 直接 remove，kills 保持 1）。
14. `failed native close is retryable and never drops ownership` — 把 kill 换成抛 `'owned PTY is busy'`；`close` rejects `/busy/`；会话仍在；换回原 kill 后 close 成功、会话清空。
15. `failed dispose restores a usable service and a later successful dispose closes it` — 首个会话 kill 抛 `'fixture close failure'`；`dispose()` rejects；`service.disposed === false`；会话仍在且 status 'running'；还能 create 第二个并写入；恢复 kill 后 close(first)、dispose() 成功；`disposed === true`、sessions 清空、两个 handle 各 kills === 1；随后 create rejects `/关闭/`。
16. `failed spawn releases the create slot and unsupported platforms do not launch` — spawn 抛 `'native load failed'`，连续 10 次 create 都 rejects `/无法启动/`；`service.pendingCreates === 0`；sessions 为空；另起 `platform:'linux'` 的 fixture，create rejects `/不支持/`、calls 为空。
17. `native stream errors are handled inside the owning session` — 手动触发 `handle.errors` 里的监听；read 匹配 `/连接已中断/`；snapshot status 为 `'exited'`（onError 置 'failed' 后 kill → FakePty.end(1) → onExit 覆写为 'exited'）；`kills === 1`；dispose 后 `handle.errors.size === 0`。
18. `natural shell exit releases its pinned node-pty worker and pipe without touching another session` — 建两个会话；给 `calls[0].handle` 挂 `_agent = { inSocket: {destroy}, _conoutSocketWorker: {dispose} }`；`end(0)` 后 pipes/workers 各 1、第二个会话 kills 0；再 `end(0)` 不重复（didExit 守卫），pipes 仍为 1。

（`test(` 出现次数 = 18，与上表一一对应；移植后 vitest 用例数必须 ≥ 18。）

### src/desktop-browser.cjs（590 行）

依赖：只有 `node:crypto.randomUUID`；electron 对象（WebContentsView、session、窗口）全部由构造参数传入 —— 模块本身不 require('electron')。

导出面：`module.exports = {DesktopBrowser, BROWSER_PARTITION, MAX_BROWSER_TABS, normalizeBrowserUrl}`。

常量：
- `BROWSER_PARTITION = 'persist:being-desktop-browser-v1'`
- `MAX_BROWSER_TABS = 16`
- `MAX_URL_LENGTH = 8192`
- `INSPECTION_WORLD = 1004`
- `PRIVATE_PARAMETER = /(?:token|password|passwd|secret|api[_-]?key|authorization|credential|signature|^code$|^key$)/i`
- `OPERATION_ERRORS = {document_changed:'页面已变化，请重新读取后重试。', target_changed:'请求已过期：页面或操作目标已变化。', invalid_selector:'网页元素选择器无效。', ambiguous_target:'请选择唯一且可见的网页元素。', unavailable_target:'该元素不支持此操作，请在浏览器中手动操作。'}`

模块级函数（除 normalizeBrowserUrl 外未导出）：
- `object(value, label)` — 非对象或数组 → `TypeError(label + '格式无效。')`；否则原样返回。
- `navigationUrl(value)` — 非 string / 长度 > 8192 / 含 C0 与 DEL 控制字符 → `TypeError('请输入有效的网页地址。')`；trim 后不以 `https?://` 开头 → `TypeError('浏览器仅支持 HTTP 和 HTTPS 网页。')`；`new URL` 失败 → `TypeError('请输入有效的网页地址。')`；协议不在 http/https、无 hostname、有 username 或 password → `TypeError('网页地址不能包含登录凭据。')`；返回 `url.href`。
- `normalizeBrowserUrl(value)` — 同样的长度与控制字符检查（'请输入有效的网页地址。'）；`https?://` 开头直接走 navigationUrl；否则 localhost / 127.x.x.x / [::1]（可带 :port，后面要么结束要么是 `/?#`）→ 前缀 `http://`；否则形如域名（允许 `-￿` 的 IDN 字符，至少一个点，可带 :port）→ 前缀 `https://`；再否则 `TypeError('请输入 HTTP 或 HTTPS 地址，例如 localhost:3000。')`。
- `safeUrl(value)` — 空值 → `''`；`new URL(navigationUrl(value))` 失败 → `''`；命中 PRIVATE_PARAMETER 的查询参数 key 用 `searchParams.set(key, '[redacted]')`；若 `PRIVATE_PARAMETER.test(url.hash)` 则 `url.hash = '[redacted]'`；返回 `url.href`。
- `safeTitle(value, fallback)` — string 时：控制字符换空格、内嵌 `https?://...` 换成 `safeUrl(match)`、`(token|password|secret|api[_-]?key|authorization|credential)\s*[:=]\s*` 后的值换成 `[redacted]`、trim、slice(0,180)；空则退回 `new URL(fallback).hostname`，再失败 → `'新标签页'`。
- `normalizeBounds(value)` — `object(value, '浏览器显示区域')`；x/y/width/height 必须是有限数且 0..100000，否则 `TypeError('浏览器显示区域无效。')`；各自 `Math.floor`。
- `pageOperation(token, operation, args)` — 注入到页面隔离世界执行的函数（通过 `pageOperation.toString()` 序列化成源码）。
  - `globalThis.__beingBrowserDocument !== token` → `{error:'document_changed'}`
  - `visible(element)`：`getBoundingClientRect()` 宽高 > 0、`isConnected`、`style.visibility === 'visible'`、`style.display !== 'none'`，再 `element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})`
  - `read`：选择器优先唯一 `#id`（`CSS.escape`，长度 ≤ 512 且 querySelectorAll 唯一），否则逐级 `tag` 或 `tag:nth-of-type(n)` 用 ` > ` 连接，超过 512 返回 `''`；候选 `a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"]`；跳过不可见与 password/file/hidden 输入；上限 80 个（超过置 omitted 并 break）；label 取 aria-label → labels 的 innerText → title → placeholder → innerText，trim().slice(0,180)；返回 `{title:document.title, text:innerText.slice(0,20000), elements, truncated: text.length > 20000 || omitted}`
  - 其它操作：querySelectorAll 抛错 → `{error: args.targetToken ? 'target_changed' : 'invalid_selector'}`；可见匹配数不等于 1 → `{error: args.targetToken ? 'target_changed' : 'ambiguous_target'}`
  - `kind = operation === 'prepare' ? args.kind : operation`；`unavailable()` → `{error: args.targetToken && operation !== 'prepare' ? 'target_changed' : 'unavailable_target'}`
  - password/file/hidden 输入、disabled、`aria-disabled === 'true'` → unavailable
  - click：`a[download]` 祖先 → unavailable；祖先 `a[href]` 协议非 http/https → unavailable；`element.click` 非函数 → unavailable
  - fill：readOnly 或（非 HTMLInputElement/HTMLTextAreaElement 且非 isContentEditable）→ unavailable；HTMLInputElement 的 type 不在 text/search/email/url/tel/number → unavailable
  - 其它 kind → `{error:'invalid_operation'}`
  - `operation === 'prepare' || args.targetToken` 时做指纹：`control = element.closest('button,a,input,textarea,select') || element`；`form = control.form || control.closest('form')`；`fields = form ? [...form.elements] : []`；`describe(target)` 收集 tag/type/name/href/text/value/disabled/readOnly/checked/role/label/title/action/method/ariaDisabled，password 与 file 的 value 置空，value > 16000 或 text > 8000 抛 'Large target'；`fields.length > 80` → unavailable；指纹 JSON 长度 > 100000 → unavailable；异常 → unavailable
  - `globalThis.__beingBrowserTargets` 不是 Map → `{error:'target_changed'}`
  - prepare：`while (targets.size >= 32) targets.delete(最早 key)`；存 `{element,control,form,fields,kind,selector,fingerprint,handler:control.onclick}`；返回 `{targetToken, summary: control.localName + (control.type ? ' (' + control.type + ')' : '') + ' · ' + label.trim().slice(0,180)}`（label 取 aria-label → title → placeholder → innerText → name → selector）
  - 执行态：取出并 `targets.delete`；element/control/form/kind/selector/fingerprint/handler/fields 全等校验，任一不符 → `{error:'target_changed'}`
  - click → `element.click()`，返回 `{clicked:true}`
  - fill → 再次校验 readOnly 与 type；用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element, args.text)`（textarea 同理），contentEditable 用 `innerText`；派发 `new InputEvent('input',{bubbles:true,inputType:'insertText',data:args.text})` 与 `new Event('change',{bubbles:true})`；返回 `{filled:true}`
  - 兜底 `{error:'invalid_operation'}`

`class DesktopBrowser`：
- `constructor(options)` — `const {WebContentsView, session, getWindow, onChange = () => {}} = object(options, '浏览器选项')`；校验 `typeof WebContentsView === 'function'`、`typeof session?.fromPartition === 'function'`、`typeof getWindow === 'function'`、`typeof onChange === 'function'`，否则 `TypeError('浏览器依赖无效。')`。字段：View、getWindow、onChange、`tabs = new Map()`、`activeTabId = null`、`visible = false`、`bounds = {x:0,y:0,width:0,height:0}`、`attached = null`、`destroyed = false`、`session = session.fromPartition(BROWSER_PARTITION)`。随后 `setPermissionRequestHandler((_c,_p,callback) => callback(false))`、`setPermissionCheckHandler(() => false)`、`setDevicePermissionHandler(() => false)`；`downloadHandler = (event,_item,contents) => { event.preventDefault(); 找到 view.webContents === contents 的 tab → _notice(tab, '此浏览器暂不支持下载文件。') }`，`session.on('will-download', downloadHandler)`；`session.webRequest.onBeforeRequest((details, callback) => { cancel = ['mainFrame','subFrame'].includes(details.resourceType) 且 navigationUrl(details.url) 抛错; callback({cancel}) })`。
- 标签页对象：`{id:'browser-' + randomUUID(), view, url:'', title:'', error:'', notice:'', committedUrl:'', isLoading:false, canGoBack:false, canGoForward:false, listeners:[], revision:0, requestRevision:0, documentToken:'', contextPromise:null}`，另有动态字段 blockedRequestRevision、blockedRevision。
- `snapshot()` → `{tabs:[{id, title:safeTitle(tab.title, tab.url), url:safeUrl(tab.url), isLoading, canGoBack, canGoForward, error, notice, revision}], activeTabId, visible}`
- `newTab(options = {})` — `_alive()`；`object(options,'标签页选项')`；active 非 undefined 且非 boolean → `TypeError('标签页选项无效。')`；`tabs.size >= 16` → `Error('最多打开 16 个标签页，请先关闭一个。')`（模板串用 MAX_BROWSER_TABS）；url 为 undefined 或 `''` → `''`，否则 normalizeBrowserUrl；`new this.View({webPreferences:{session, nodeIntegration:false, nodeIntegrationInSubFrames:false, nodeIntegrationInWorker:false, contextIsolation:true, sandbox:true, webSecurity:true, allowRunningInsecureContent:false, webviewTag:false, navigateOnDragDrop:false, safeDialogs:true, disableDialogs:true, spellcheck:true}})`；`view.setVisible(false)`；`view.setBackgroundColor('#171717')`；`tabs.set`；`_bind(tab)`；`if (options.active !== false || !this.activeTabId) this.activeTabId = tab.id`；有 url 则 `_load`；`_syncView()`；`_emit()`；返回 snapshot。
- `activateTab(id)`、`closeTab(id)`、`navigate({id,url})`、`goBack(id)`、`goForward(id)`、`reload(id)`、`stop(id)`、`setViewport({visible,bounds})` 均返回 snapshot。
  - closeTab：先记 ids 与 index；若关的是 attached 则 `_detach()`；`tabs.delete`；`requestRevision++`；逐个 removeListener；未销毁则 `close({waitForBeforeUnload:false})`；active 转移到 `ids[index+1] || ids[index-1] || null`。
  - reload：仅当 tab.url 非空才清 error 与 notice、`reload()`、`_syncTab`、`_emit`。
  - stop：`requestRevision++`；`webContents.stop()`；`isLoading = false`；`_emit()`。
  - setViewport：`_alive()`；visible 必须 boolean，否则 `TypeError('浏览器显示选项无效。')`；`bounds === undefined && !visible` 时沿用旧 bounds，否则 `normalizeBounds(options.bounds)`；仅当 visible 变化才 `_emit()`（`_syncView()` 总是调）。
- `async readPage(id, expectedRevision)` → `{tabId, revision, title:safeTitle(result.title, tab.url), url:safeUrl(tab.url), text, elements, truncated}`
- `async prepareAction({id,selector,kind,expectedRevision})` — object、`_selector`、kind 属于 click/fill 否则 `TypeError('操作确认类型无效。')`；`targetToken = randomUUID()`；返回 `{targetToken, summary:safeTitle(result.summary, '')}`
- `async click({id,selector,targetToken,expectedRevision})` → `{tabId, clicked:true}`
- `async fill({id,selector,text,targetToken,expectedRevision})` — text 必须是 string、长度 ≤ 8000、不含 NUL，否则 `TypeError('填写内容无效或超过 8000 个字符。')` → `{tabId, filled:true}`
- `async screenshot(id, expectedRevision)` — `_operationTarget`；`view.getBounds()` 宽或高 ≤ 0 → `'请先在浏览器中打开此标签页再截图。'`；`capturePage({x:0,y:0,width,height},{stayHidden:true,stayAwake:true})` 抛错 → `'无法截取当前网页，请重试。'`；`_sameDocument`；`bitmap.isEmpty()` → `'网页截图暂不可用，请重试。'`；最长边 > 1600 则按比例 resize（各边至少 1）后重新 getSize；`toPNG()` 超过 8 MiB → `'网页截图过大，请缩小浏览器区域后重试。'`；返回 `{tabId, revision, mimeType:'image/png', data:base64, width, height}`
- `destroy()` — 幂等；`_detach()`；`destroyed = true`；每个 tab `requestRevision++`、移除监听、`close({waitForBeforeUnload:false})`；`tabs.clear()`；`activeTabId = null`；`visible = false`；`session.removeListener('will-download', downloadHandler)`；`session.webRequest.onBeforeRequest(null)`。
- `_alive()` → `Error('浏览器已经关闭。')`
- `_tab(id = this.activeTabId)` — `_alive()`；id 非 string / 长度 > 80 / 不存在 → `Error('请选择一个有效的浏览器标签页。')`；`webContents.isDestroyed()` → `Error('此标签页已经关闭，请重新打开。')`
- `_emit()` — 未销毁才 `onChange(snapshot())`（不吞观察者异常）
- `_load(tab, url)` — `revision = ++tab.requestRevision`；重置 url/title/error/notice，`isLoading = true`；`Promise.resolve(loadURL(url)).catch(...)`：若 tab 已删 / requestRevision 变了 / destroyed / `tab.blockedRequestRevision === revision` / `error?.code === 'ERR_ABORTED'` / `error?.errno === -3` 则忽略，否则置 `'网页未能加载，请检查地址或网络后重试。'`、`isLoading = false`、`_emit()`；同步抛错走同样文案但不 `_emit()`。
- `_history(direction, id)` — 用 `webContents.navigationHistory.canGoBack()/canGoForward()`，可用时清 error 与 notice、`goBack()/goForward()`、`_syncTab`、`_emit`。
- `_syncTab(tab)` — 已销毁直接返回；`getURL()` 非空且非 about:blank 时尝试 `navigationUrl` 更新 tab.url（失败静默）；同步 isLoading、canGoBack、canGoForward。
- `_bind(tab)` — 注册监听（全部记入 tab.listeners 以便移除）：`will-navigate` / `will-frame-navigate` / `will-redirect` 共用 guard（url 取 `event.url` 或 legacy 参数；非法则 preventDefault，主框架时置 `blockedRequestRevision = requestRevision`、`blockedRevision = revision`，已有 committedUrl 则 `_syncTab` + `_notice('已阻止不受支持的页面跳转，仅允许 HTTP 和 HTTPS。')`，否则 `tab.error = message` + `_emit()`）；`will-attach-webview` → preventDefault；`did-start-navigation` 主框架时 `revision++`、清 documentToken、清 contextPromise；`dom-ready` → `_prepareDocument`；`did-start-loading` 与 `did-stop-loading` → update（`_syncTab` + `_emit`，仅当 tab 还在）；`did-navigate` → 尝试 `committedUrl = navigationUrl(getURL())` 并清 notice，再 update；`did-navigate-in-page` 主框架时 `_prepareDocument` + update；`page-title-updated` → `tab.title = safeTitle(title, tab.url)` + `_emit()`；`did-fail-load`（isMainFrame === false 或 code === -3 忽略；`blockedRevision === revision` 时只 `isLoading=false` + `_emit()`；否则清 committedUrl、code === -105 → `'找不到此网站，请检查地址。'` 否则 `'网页未能加载，请检查地址或网络后重试。'`）；`render-process-gone` → 清 committedUrl、`'此标签页意外关闭，请刷新重试。'`、`isLoading=false`、`_emit()`。另外 `contents.setWindowOpenHandler(details => ...)`：url 非法 → `_notice('已阻止不受支持的弹出窗口。')` 并返回 `{action:'deny'}`；合法时 `queueMicrotask` 里 `newTab({url, active: details.disposition !== 'background-tab'})`，失败 `_notice('无法新建标签页，请关闭一个标签页后重试。')`，同样返回 `{action:'deny'}`。
- `_notice(tab, message)` — 设 notice；若 `committedUrl && !error && !documentToken` 则 `_prepareDocument(tab)`；`_emit()`。
- `_selector(value)` — 非 string / 空白 / > 512 / 含控制字符 → `TypeError('网页元素选择器无效。')`
- `_targetToken(value)` — 非 undefined 时必须匹配 `/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/`，否则 `TypeError('操作确认标识无效。')`
- `_operationTarget(id, expectedRevision)` — `_tab(id)`；expectedRevision 非 undefined 时必须是 ≥ 0 的安全整数否则 `TypeError('页面版本无效。')`；与 `tab.revision` 不等 → `Error(OPERATION_ERRORS.document_changed)`；`!tab.url || tab.isLoading || webContents.isLoading() || !tab.documentToken` → `Error('网页正在加载或尚未准备好，请稍后重试。')`；返回 `{tab, revision:tab.revision}`
- `_sameDocument(tab, revision)` — destroyed / tab 已换 / webContents 已销毁 / revision 变了 → `Error(OPERATION_ERRORS.document_changed)`
- `async _operate(id, expectedRevision, operation, args)` — `_operationTarget` 抛错时，若 `args.targetToken && operation !== 'prepare'` 改抛 target_changed；code 为 `'(' + pageOperation.toString() + ')(' + JSON.stringify(documentToken) + ',' + JSON.stringify(operation) + ',' + JSON.stringify(args) + ')'`；`executeJavaScriptInIsolatedWorld(INSPECTION_WORLD, [{code}], operation === 'click' || operation === 'fill')` 抛错 → `Error('网页操作未完成，请重新读取页面后重试。')`；`operation !== 'click' || !result?.clicked` 时做 `_sameDocument`（同样的 target_changed 改写）；`args.targetToken && operation !== 'prepare' && result?.error === 'document_changed'` → target_changed；`result?.error || !result` → `Error(OPERATION_ERRORS[result?.error] || '网页操作未完成。')`；返回 `{tab, revision, result}`
- `_prepareDocument(tab)` — 记录 revision 与新 token；执行 `globalThis.__beingBrowserDocument = "<token>"; globalThis.__beingBrowserTargets = new Map(); true;`（userGesture false）；成功且 tab 未变、revision 未变时写入 `tab.documentToken`；`.catch(() => {})`。
- `_detach()` — 取出 this.attached 并置 null；view 未销毁则 `setVisible(false)`；window 未销毁则 `window.contentView.removeChildView(view)`。
- `_syncView()` — `tab = tabs.get(activeTabId)`，`window = getWindow()`；不可见 / 无 tab.url / webContents 已销毁 / 无窗口 / 窗口已销毁 → `_detach()`；`const [width, height] = window.getContentSize()`；`x = min(bounds.x, width)`、`y = min(bounds.y, height)`，宽高按窗口剩余空间截断；任一 ≤ 0 → `_detach()`；attached 的 tab 或 window 变了则先 `_detach()` 再 `window.contentView.addChildView(view)` 并记录 attached；最后 `view.setBounds(bounds)`、`view.setVisible(true)`。

移植注意：所有 electron 触点（WebContentsView 构造器、session.fromPartition 及其 handler、webContents.*、view.*、window.contentView.*、window.getContentSize()、window.isDestroyed()、capturePage 返回的 NativeImage）都要在 tools/browser/host.ts 里声明成接口，browser.ts 只依赖接口。

### test/desktop-browser.test.cjs（371 行，17 个用例）

全部用假 electron 对象驱动，无需真 electron。

`class Contents extends EventEmitter`（假 webContents）：
- 字段 `url=''`、`history=[]`、`index=-1`、`loading=false`、`destroyed=false`、`pending=[]`
- `navigationHistory = {canGoBack:() => index > 0, canGoForward:() => index < history.length - 1, goBack:() => { url = history[--index]; emit('did-navigate') }, goForward:() => { url = history[++index]; emit('did-navigate') }}`
- `loadURL(url)`：先 `emit('did-start-navigation', {url,isMainFrame:true,isSameDocument:false})`；设 url；`history.splice(index+1)`；push；`index++`；`loading = true`；`emit('did-start-loading')`；返回一个把 `{resolve,reject}` 压进 `pending` 的 Promise（永不自动结束）
- `finish(title = 'Fixture page')`：`loading=false`；`emit('did-navigate')`；`emit('page-title-updated', {}, title)`；`emit('did-stop-loading')`；`pending.at(-1)?.resolve()`
- `getURL()`、`executeJavaScriptInIsolatedWorld()` → `Promise.resolve(true)`、`isLoading()`、`isDestroyed()`
- `setWindowOpenHandler(handler)` → 存到 `this.popup`
- `stop()` → `stopped = true; loading = false; emit('did-stop-loading')`
- `reload()` → `reloaded = true; loading = true`
- `close(options)` → `closeOptions = options; destroyed = true`

`fixture()` → `{browser, views, changes, attached, ses, window}`：
- `ses` 是 EventEmitter，另有 `setPermissionRequestHandler/​setPermissionCheckHandler/​setDevicePermissionHandler`（分别存成 `requestPermission`/`checkPermission`/`devicePermission`）与 `webRequest:{onBeforeRequest(handler) { this.before = handler }}`
- `window = {isDestroyed:() => false, getContentSize:() => [1000, 700], contentView:{addChildView(view){attached.push(view)}, removeChildView(view){attached.splice(indexOf,1)}}}`
- `class View { constructor(options){ this.options = options; this.webContents = new Contents(); views.push(this) } setBounds(b){this.bounds=b} getBounds(){return this.bounds || {x:0,y:0,width:0,height:0}} setVisible(v){this.visible=v} setBackgroundColor(c){this.color=c} }`
- `new DesktopBrowser({WebContentsView:View, session:{fromPartition(name){ assert.equal(name, BROWSER_PARTITION); return ses }}, getWindow:() => window, onChange:value => changes.push(value)})`

`event(url, isMainFrame = true)` → `{url, isMainFrame, prevented:false, preventDefault(){ this.prevented = true }}`

用例清单（顺序即原文件顺序，共 16 条）：
1. `browser address input supports real web URLs and local developer previews` — `example.com/docs` → `https://example.com/docs`；`' https://example.com:443/a?q=1 '` → `https://example.com/a?q=1`；`localhost:3000` → `http://localhost:3000/`；`127.0.0.1:8317/management.html` → `http://127.0.0.1:8317/management.html`；`[::1]:8080` → `http://[::1]:8080/`；`http://192.168.1.20:8080` → `http://192.168.1.20:8080/`
2. `address parser rejects executable and privileged schemes, credentials and malformed values` — 逐个 throws：`javascript:alert(1)`、`file:///C:/secret`、`data:text/html,hello`、`being://app/`、`about:blank`、`chrome://settings`、`devtools://a`、`//evil.test/`、`https://user:password@example.com`、`https://user@example.com`、`https:example.com`、`example.com\n.evil.test`、`search some text`、`localhost:999999`、`''`、`null`、`{}`、`4`、`'x'.repeat(9000)`
3. `browser creates an isolated sandboxed page without privileged preload or homepage requests` — `newTab()` 无 url 时不发起加载（`pending.length === 0`）；`sandbox/contextIsolation/webSecurity` 为 true；`nodeIntegration/nodeIntegrationInSubFrames/nodeIntegrationInWorker/webviewTag/navigateOnDragDrop/allowRunningInsecureContent` 为 false；`Object.hasOwn(preferences,'preload') === false`
4. `viewport attaches only the active page and clips dimensions to the host window` — 先 `setViewport({visible:true, bounds:{x:200.9,y:100.9,width:9999,height:9999}})`；两个标签页后只有 `views[1]` 被 attach、`views[0].visible === false`、`views[1].bounds === {x:200,y:100,width:800,height:600}`（窗口 1000x700 裁剪）；`activateTab(first)` 后 attached 变成 `[views[0]]`；`setViewport({visible:false})` 后 attached 为空；`closeTab(second)` → `views[1].webContents.destroyed === true`；两个都关掉后 tabs 为空、activeTabId 为 null
5. `history, loading, title, reload and stop reflect the active browser tab` — `newTab({url:'example.com'})` 后 isLoading true；`finish('First page')` 后 title 与 isLoading；`navigate({url:'example.org'})` + finish 后 canGoBack true；`goBack()` 后 url 为 `https://example.com/`、canGoForward true；`goForward()` 后 `https://example.org/`；`reload()` → `wc.reloaded`；`stop()` → `wc.stopped` 且 isLoading false
6. `all frame navigations and redirects enforce the protocol boundary` — 三个事件名各测一次阻止 `being://app/index.html`、放行 `http://localhost:3000`；子框架 `file:///C:/secret`（isMainFrame false）也被 preventDefault；`ses.webRequest.before({url:'being://app/', resourceType:'mainFrame'}, cb)` → `{cancel:true}`；`{url:'https://example.com/script.js', resourceType:'script'}` → `{cancel:false}`；`will-attach-webview` 被 preventDefault
7. `website popups become safe internal tabs and never native windows` — `popup({url:'https://example.org', disposition:'background-tab'})` 返回 `{action:'deny'}`，`await Promise.resolve()` 后新增一个标签页且 activeTabId 仍是第一个；`javascript:alert(1)` 与 `file:///C:/secret` 的 popup 同样 deny 且不新增标签页
8. `browser pages cannot request native permissions, devices or downloads` — `ses.requestPermission(wc,'media',cb)` → false；`ses.checkPermission()` → false；`ses.devicePermission()` → false；`ses.emit('will-download', download, {}, wc)` → `download.prevented === true`，notice 匹配 `/下载/`，error 为空
9. `UI snapshots redact credentials and contain no contents objects or page body` — url 带 `token=private-fixture&query=visible&api_key=secret-fixture#access_token=hidden-fixture`；snapshot 序列化后不含三个敏感值、包含 `query=visible`；`Object.keys(snapshot().tabs[0])` 恰为 `['id','title','url','isLoading','canGoBack','canGoForward','error','notice','revision']`；底层 `getURL()` 仍含 token；把标题设成一个带 token 的 URL 后 snapshot 依然不含 `private-fixture`
10. `stale page failures and closed-tab failures cannot overwrite a newer navigation` — 旧 pending reject 不写 error（requestRevision 已变）；关闭标签页后再 reject 也不复活标签页
11. `failed main frames show a sanitized error while aborted loads and subframes stay quiet` — `did-fail-load` code `-3` 忽略；`isMainFrame === false` 忽略；`-105` 主框架 → error 匹配 `/找不到/`；快照不含 `secret-fixture`（description 不进快照）
12. `invalid commands and viewport values leave the browser unchanged` — 九个操作全 throws：`newTab({active:'yes'})`、`newTab(null)`、`activateTab({})`、`closeTab('missing')`、`navigate({url:'file:///secret'})`、`setViewport({visible:1,...})`、bounds `y:-1`、`width:NaN`、`width:100001`；之后 snapshot 与之前深度相等
13. `tab limits and disposal release all page resources without beforeunload prompts` — 开满 `MAX_BROWSER_TABS` 个后再 newTab throws `/最多/`；`destroy()` 调用两次（幂等）；`ses.listenerCount('will-download') === 0`；`ses.webRequest.before === null`；每个 view 的 webContents `destroyed === true`、`closeOptions === {waitForBeforeUnload:false}`、`eventNames().length === 0`；destroy 后 newTab throws `/已经关闭/`
14. `structured operations reject stale revisions, loading pages and invalid parameters before execution` — 首个快照 `revision === 1`；加载中 readPage rejects `/加载/`；`finish()` 后手动设 `browser.tabs.get(first.id).documentToken = 'synthetic-fixture-context'`；`navigate` 后 revision 变 2；`readPage(first.id, 1)`、`click({...expectedRevision:1})`、`fill({...expectedRevision:1})`、`screenshot(first.id, 1)` 全 rejects `/页面已变化/`；`click({selector:'x'.repeat(513)})` rejects `/选择器/`；`fill({selector:'#note',text:'x'.repeat(8001)})` rejects `/8000/`；`fill({selector:'#note',text:42})` rejects `/填写内容/`
15. `screenshots bound the native bitmap and discard an image captured across navigation` — 假 bitmap 递归 resize；`capturePage` 断言 `options.stayHidden === true` 并返回 3200x2000；截图结果被缩到 1600x1000、mimeType `image/png`、data 为 png 的 base64；随后让 `capturePage` 在返回前触发 `navigate`，`screenshot` rejects `/页面已变化/`
16. `blocked navigation, downloads and popups keep a committed page visible and usable` — 已提交页面上 `did-start-navigation` 到 `mailto:` 再 `will-navigate` 被阻止后：error 为空、notice 匹配 `/已阻止/`、`browser.tabs.get(id).documentToken` 为真（`_notice` 重新注入）、view 仍 attached 且 visible；`will-download` 后 notice 匹配 `/下载/`；`popup({url:'javascript:alert(1)'})` 后 notice 匹配 `/弹出窗口/`、view 仍 visible；`navigate` 到新地址后 notice 清空
17. `a blocked redirect with no committed page remains a fatal load error` — 未提交页面上 `will-redirect` 到 `being://app/index.html` → error 匹配 `/已阻止/`、notice 为空

（`test(` 出现次数 = 17，与上表一一对应；移植后 vitest 用例数必须 ≥ 17。）

### docs/architecture.md 5.4（桌面工具桥）与 9（渲染层）中与本单元相关的内容

- 工具桥是 Desktop 充当 MCP 服务器的反向连接（DesktopToolLink over Portal relay）。直接模式暴露 `desktop_browser_*`、`desktop_console_*`、`desktop_terminal_*`；编排模式只暴露 `desktop_worker_*`。
- 浏览器与控制台工具调用进入「待确认队列（上限 8）」，用户 `request.allow` 后才 `invoke → DesktopBrowser.readPage / DesktopConsole.run …`。
- `desktop_terminal_*` 用消息里的 `terminal.scope`（sessionId + sessionToken）绑定会话，**不再逐次确认**。
- 渲染层：`desktop-tools.js`（`beingTools`）负责内置浏览器面板、控制台与待确认工具调用；`terminal-panel.js`（`beingTerminal`）是 xterm 终端面板。两者都属于后续集成阶段的 renderer 工作，不在本单元范围。

结论：本单元只移植 `DesktopTerminal` 与 `DesktopBrowser` 两个主进程类本身；确认队列、工具目录、terminal scope 绑定、renderer 面板都在别的单元或后续集成阶段。

### docs/interfaces.md 与本单元相关的条目

**1.2 IPC 方法目录（桌面工具、控制台与终端）**
- `getDesktopTools()` → `{browser:{tabs:[{id,url,title,revision,isLoading,error,…}], activeTabId, visible, …}, console:{…}, link:{…}, workspace, requestResult, requests:[…]}`
- `desktopAction(action, value)` — `browser.new|activate|close|navigate|back|forward|reload|stop`、`console.*`、`link.*`、`request.allow|deny`
- `setBrowserView(bounds)` — `{x,y,width,height}`
- `getTerminalState()` → `{sessions:[{id,title,cwd,status,pid,cols,rows,exitCode}], activeSessionId}`
- `readTerminal(id)` → `{id, sequence, data, truncated}`（回放缓冲 ≤ 1MB）
- `terminalAction(action, value)` — `create {cwd?, cols?, rows?}`、`write {id, data ≤64KiB}`、`resize {id, cols, rows}`、`activate id`、`close id`；最多 8 个会话

**1.3 主进程 → 渲染层推送**
- `being:terminal-state` / `onTerminalState` ← `DesktopTerminal.snapshot()`（终端创建、状态、尺寸变化）
- `being:terminal-data` / `onTerminalData` ← `{id, sequence, data}`（PTY 输出；`sequence` 与 `readTerminal` 共用，读后丢弃 ≤ 回放序号的事件）
- `being:tools-state` / `onToolsState` ← `DesktopTools.snapshot()`（含浏览器快照）

**3.6 桌面工具桥（本单元的两行）**
- `DesktopBrowser` | 构造注入 `{WebContentsView, session, getWindow, onChange}` | 公开 `newTab`、`activateTab`、`closeTab`、`navigate`、`goBack`、`goForward`、`reload`、`stop`、`setViewport`、`readPage(id, revision)`、`prepareAction`、`click`、`fill`、`screenshot`、`snapshot()`、`destroy()`；另导出 `BROWSER_PARTITION`、`MAX_BROWSER_TABS=16`、`normalizeBrowserUrl`
- `DesktopTerminal` | 构造注入 `{getWorkspace, onChange, onData, pty, environment, platform, shellPath}` | 公开 `create({cwd, cols, rows})`、`write({id, data})`、`resize`、`activate`、`close(id)`、`read(id)`、`readSince(id, afterSequence)`、`snapshot()`、`dispose()`

（与源码一致；移植后的 TS 导出面必须逐项对齐这两行。）

### src/main.cjs 与 src/desktop-tools.cjs 里的实例化点（集成阶段要机械对接的形状）

`src/main.cjs`：
- 顶部 `const {DesktopTerminal} = require('./desktop-terminal.cjs');`（行 56）；`DesktopBrowser` 不在 main.cjs 里直接 new。
- boot() 里（行 1710 起）：
  ```js
  desktopTerminal = new DesktopTerminal({
    getWorkspace: () => state.workspace.path,
    onChange: terminalState => { if (win && !win.isDestroyed()) win.webContents.send('being:terminal-state', terminalState); },
    onData: chunk => { if (win && !win.isDestroyed()) win.webContents.send('being:terminal-data', chunk); },
  });
  ```
  —— 没有传 `pty`，所以运行时走 `require('node-pty')` 的惰性分支；`environment`/`platform`/`shellPath` 也都用默认。
- IPC：`getTerminalState` → `snapshot()`；`readTerminal` → `read(id)`；`terminalAction` 按 `create/write/resize/activate/close` 分发后返回 `snapshot()`（未知操作抛 `'未知终端操作。'`）；`setBrowserView` → `desktopTools.browser.setViewport(value)`。
- `DesktopTools` 在 boot 里拿到 electron 的 `WebContentsView`、`session`、`getWindow:()=>win`，并把 `getTerminal:()=>desktopTerminal`、`showTerminal` 一起注入。

`src/desktop-tools.cjs`（另一个单元的范围）：
```js
constructor({desktopId, WebContentsView, session, getWindow, getConnection, getWorkspace, onChange, orchestration,
  getTerminal = () => null, showTerminal = () => {}, Browser = DesktopBrowser, Console = DesktopConsole, ToolLink = DesktopToolLink}) {
  …
  this.browser = new Browser({WebContentsView, session, getWindow, onChange: () => this.changed()});
```
—— 即 `DesktopBrowser` 的四个构造参数原样来自 electron 的 `WebContentsView` 构造器、`session` 模块、`getWindow`，`onChange` 是 DesktopTools 自己的 `changed()`。

**本单元对应的注入点**：
- `DesktopTerminal`：`pty`（`PtyFactory`，集成时传 `require('node-pty')`）、`getWorkspace`、`onChange`、`onData`、`environment`、`platform`、`shellPath`。
- `DesktopBrowser`：`WebContentsView`（构造器）、`session`（`{fromPartition}`）、`getWindow`、`onChange` —— 三个 electron 触点统一为 `ElectronBrowserHost`，真适配在 `tools/browser/electron-host.ts`。

### portal-desktop 既有 `desktop/main/browser/`（ClientBrowser，不修改）

`browser.ts` — `class ClientBrowser`，`constructor(private window: BrowserWindow, private publish: (state: BrowserState) => void)`，直接 `import { BrowserWindow, WebContentsView, session, shell } from 'electron'`。
- **单标签页**：内部只有一个可选 `view?: WebContentsView`，`open(input?)` / `close()` / `action('back'|'forward'|'reload'|'stop'|'external'|'close')` / `setBounds({x,y,width,height,visible})`。
- 分区 `persist:beings-browser`，只设置 `setPermissionRequestHandler` 与 `setPermissionCheckHandler`（无 `setDevicePermissionHandler`、无 `will-download`、无 `webRequest.onBeforeRequest`）。
- 状态 `BrowserState = {open, address, title, loading, canGoBack, canGoForward, error?}`，靠 `navigationHistory.getActiveIndex()/getAllEntries()` 推导前进后退。
- 布局 `layout()` 会乘 `window.webContents.getZoomFactor()`。
- 支持 `shell.openExternal`（"在系统浏览器打开"）。
- 脱敏在 `url.ts`：`browserURL(input)`（长度 ≤ 16000，无 scheme 时补 `https://`，只允许 http/https 且无凭据）与 `browserAddress(input)`（把命中 `token|secret|password|api[-_]?key|authorization|^code$` 的查询参数**删除**并把值收进 `secrets`，hash 整体收进 secrets 并清空），标题脱敏用 `chat/connection` 的 `redact`。

**与本单元移植的 `tools/browser/browser.ts`（DesktopBrowser）的区别**：
| 维度 | ClientBrowser（既有） | DesktopBrowser（本单元移植） |
| --- | --- | --- |
| 标签页 | 单页 | 多标签页，上限 16，`activeTabId` |
| 用途 | 用户手动浏览的外壳浏览器 | Being 可读可操作的工具浏览器（readPage / prepareAction / click / fill / screenshot） |
| electron 耦合 | 直接 import electron | 全部经构造参数注入，测试可脱离 electron |
| 地址解析 | `browserURL`：无 scheme 一律补 https | `normalizeBrowserUrl`：只有 localhost/IP/域名形状才补 scheme，其余文本直接拒绝（不当搜索词） |
| 脱敏 | 删除敏感参数、hash 收入 secrets | `safeUrl` 把敏感参数值替换成 `[redacted]`、命中的 hash 整体替换；`safeTitle` 另做内嵌 URL 与 `key: value` 脱敏 |
| 安全面 | 权限两项 | 权限三项 + `will-download` 拦截 + `webRequest.onBeforeRequest` 协议闸门 + `will-attach-webview` + 弹窗转内部标签页 |
| 页面注入 | 无 | 隔离世界 1004 的 `__beingBrowserDocument` / `__beingBrowserTargets` 与 revision 校验 |

**可能的复用点**（留给后续集成阶段，本单元不做）：两者最终应共用一个 partition 与一套脱敏工具；`url.ts` 的 `browserURL` 与 `normalizeBrowserUrl` 语义不同，不可互换（ClientBrowser 把裸文本当域名，DesktopBrowser 会拒绝），合并时必须以 DesktopBrowser 的更严格语义为准并回归 `tests/browser-url.test.ts`。`ClientBrowser.layout()` 的 zoomFactor 缩放是 portal-desktop 特有的，DesktopBrowser 的 `_syncView()` 没有；集成到同一个窗口时需要决定是否补上。
