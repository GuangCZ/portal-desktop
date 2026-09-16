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
| desktop-terminal.cjs → tools/terminal/terminal.ts | 未开始 |
| tools/terminal/types.ts (PtyLike / PtyFactory) | 未开始 |
| desktop-browser.cjs → tools/browser/browser.ts | 未开始 |
| tools/browser/host.ts (ElectronBrowserHost) | 未开始 |
| tools/browser/electron-host.ts | 未开始 |
| tests/tools-terminal-terminal.test.ts | 未开始 |
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
