# Portal Desktop 桌面架构

参考 Codex 的「桌面 UI / 本地引擎分离」模式。OpenAI 的公开
[App Server 文档](https://learn.chatgpt.com/docs/app-server)描述了富客户端使用独立引擎、
请求和事件协议的集成方式。此项目不依赖 Codex 私有实现，也不需要 OpenAI API。

```text
Electron BrowserWindow
├─ 本地 React + TypeScript shell：Being 入口、Portal 面板、设置
│   └─ 隔离 preload：固定的、经过顶层 frame 校验的 IPC
└─ beings://chat/：本地 Loom iframe，无 preload / Node / 本机 IPC
    └─ beings://chat/api/*：受限路由的主进程流式代理
        └─ HTTPS → 云端 Being，主进程附加 token / relay secret

Electron main
├─ safeStorage：加密连接配置
├─ ChatProxy：请求白名单、凭据注入、SSE、取消和切换连接
└─ PortalSupervisor：Rust 子进程、脱敏日志、启停、受控重启
    └─ heart-portal → WSS /_relay → 云端 Being
        └─ tools/call → Rust 文件/搜索/命令/Kits → 结果回传
```

## React 界面

`renderer/main.tsx` 使用 React 19 的 `createRoot` 挂载应用，Vite 编译 TSX 并提供组件热更新。
`app.tsx` 组合对话、Town、Portal、浏览器和设置组件；`components/` 持有声明式 JSX，
沿用既有 CSS、节点 ID、原生 dialog、文案和布局。

`models/app.ts`、`models/town.ts` 和 `models/workspace.ts` 管理连接、异步读取、身份、
发送草稿及引用，组件通过 `useSyncExternalStore` 订阅稳定的版本快照。网络读取保留请求
序号校验；Town 身份变化时清空私密内容并作废旧请求。`useEffect` 统一注册与释放 IPC
订阅、窗口监听和计时器，开发模式启用 StrictMode 验证重挂载。

DOM 引用仅用于焦点、原生 dialog、动画、滚动、浏览器边界与 iframe 协议。Town 的 Markdown
在唯一的 `components/markdown.tsx` 中先经 DOMPurify 净化，再由 React 渲染。浏览器原生
视图继续由主进程管理，新增的动态 Kit 弹窗也会使其暂时隐藏。

Loom 作为既有独立协议页面保留在隔离 iframe 内；`hooks/use-chat-bridge.ts` 校验来源、
frame 和 revision，传递设置、搜索、导航与引用事件。`loom.html` 和聊天适配脚本继续按
原有流程打包，不共享 React shell 的 preload。主进程、preload、Rust 引擎不依赖 React。
详见 [渲染器维护说明](renderer/README.md)。

## 与现有项目的适配

Rust 引擎源码随 `heart-portal/` 目录一起版本管理，客户端与引擎由同一次提交记录，CI 和本机构建读取同一版本。来源见根目录 UPSTREAM.md；发布包只包含编译后的 Portal 可执行文件和许可，不包含源码或 Cargo 构建缓存。

`loom.html` 保留原状，浏览器用法仍然可用。`scripts/prepare-desktop.mjs` 在构建时生成
桌面副本：固定本地 API 源、移除 URL 凭据、打包 Markdown/高亮库、增加 DOMPurify、恢复
附件按钮，并应用桌面主题。替换锚点找不到时构建失败，避免上游改动被静默忽略。

客户端复用已有的一段持续对话和服务端历史，不制造服务端没有实现的新建/删除会话接口。
侧栏包括 Being 对话、小镇、篝火、围炉、私信、书架、卷轴、Kit 和本机 Portal；当前版本只保存一个 Being 对话连接及一个独立 Town 身份。

Portal 的 connect 模式不会打开旧的 Cowork HTTP 服务或 MCP TCP 端口，桌面应用不假设
存在 `/api/health` 或本机 REST API。命令通过云端 Being 的正常工具调用链抵达 Rust，
没有另造可被聊天内容调用的 JS exec 通道。CLI 参数只包含配置路径和 Portal 名称；
连接链接通过 `PORTAL_CONNECT_LINK` 环境变量传入。

`HEART_PORTAL_SUPERVISED=1` 开启已有的 `portal_restart`，Portal 返回调用结果后正常退出，
后台模式中 macOS launchd 或 Windows PowerShell 守护脚本约 5 秒后重新启动它。Windows 计划任务同时负责守护脚本自身的异常恢复。临时模式仍由 Electron 负责。网络重连由 Rust 内置退避负责。
日志匹配用于展示 Relay 状态，不把进程存在当成已完成握手。

`background.ts` 将引擎复制到应用数据目录内的独立版本目录，注册当前用户的登录任务。服务只运行 Rust 和系统启动脚本，不启动 Electron 或窗口。设置更新先准备新运行目录，注册失败时恢复旧服务；只在成功后替换服务元数据。相同配置重复启动只附着，不重启正在工作的进程。设置中的后台开关控制持久启动，显式停止同时禁用登录恢复。关闭窗口仅隐藏并保留临时 Portal；明确退出客户端才会清理临时子进程。

客户端托盘提供恢复窗口和退出入口；Dock 激活与第二次启动同样恢复原窗口。`client-startup.ts` 独立管理 macOS/Windows 的客户端登录自启，读取系统状态并校验写入结果，不依赖 Being 配置或 Portal 生命周期。Windows Squirrel 安装使用 Squirrel 提供的稳定启动器，便携版使用当前可执行文件；开发模式与 Linux 不注册登录项。

macOS 可识别配置目录、连接链接和已知启动脚本均匹配的原 Heart Portal LaunchAgent；不改写它的脚本、TOML 或凭据。改变此类已有服务的连接/路径需要在原配置中处理。新建的 macOS 后台凭据用 `0600` 文件和 `0700` 目录保护；Windows 后台凭据用当前用户 DPAPI 加密。服务注册项和进程参数不包含 token。

## 信任边界

- 主窗口仅加载本地 shell；iframe 使用另一个源，渲染器启用 sandbox/contextIsolation，关闭 Node。
- preload 只暴露固定 API，主进程校验 IPC 必须来自当前窗口的顶层 shell frame。
- 主进程代理只允许已有的 10 个聊天/配置路由及对应方法，不接受任意 URL、Cookie 或认证头。
- 上游请求禁止重定向，凭据不会被带到不同站点。SSE 逐块返回，取消和连接切换会终止上游请求。
- 页面资源离线打包。聊天保留旧 UI 所需的内联处理器，但独立 CSP 禁止任意外部脚本、iframe 和表单。
- 新窗口/导航只允许经过协议筛选的 HTTP(S) 链接在内置浏览器打开。
- `safeStorage` 加密客户端凭据；后台凭据另按上述 OS 机制保存。UI 展示最近 300 行脱敏日志；后台文件日志由系统启动脚本写入，macOS 每次重启保留上一份。
- 工作目录约束由 Rust 文件工具执行。用户开启命令和扩展工具后，这些能力具有对应进程权限，不能声称文件工具的目录边界约束了所有 shell 行为。

## 当前范围

对话内容左缘提供刻度式快速索引：悬停或键盘聚焦预览该轮提问和回复，点击跳转，滚动时高亮当前位置，并可回到最新消息。索引直接从聊天 frame 的已加载消息生成，不保存对话副本。左侧搜索接收限定长度的提问摘要，校验 frame source/origin 和当前 revision 后以纯文本渲染，展开/收起采用淡入与高度过渡，遵循系统减少动态效果设置。重载后从云端历史重建，范围与现有 `/api/history?limit=100` 一致。跳转复用聊天滚动控制器，保留草稿并暂停流式输出的自动跟随。

已覆盖内置对话、本机 Portal、小镇内容客户端、Kit 清单/导入以及桌面打包。篝火/邮局/卷轴的真实数据仍取决于 Town 服务的认证授权。当前不扩展多会话或自建服务端能力，逐次工具审批尚未实现。macOS Developer ID 签发与 Portal 源仓一致，公证暂缓；检查更新和手动安装后的 Portal 配套升级见 UPDATING.md。后台登录自启已支持 macOS 和 Windows，Windows 需在目标系统进一步验证；Linux 暂仅支持临时运行。登录前启动及休眠时联网不在本功能范围内。

Electron 的 API 和隔离配置参考
[protocol](https://www.electronjs.org/docs/latest/api/protocol) 与
[Security](https://www.electronjs.org/docs/latest/tutorial/security) 官方文档。

## Town 与 Kits

社区插件的后续扩展契约见 [插件扩展方案](EXTENSIONS.md)。该文档区分现有 Kit 能力与拟议的界面插件宿主；下文描述当前已实现的运行路径。

`TownClient` 使用独立 GET 路由表与固定 `https://beings.town` 源。IPC 不接受任意请求地址、
方法或认证头。配对通过固定 `POST /api/client/pair/confirm` 交换 `{being_id, code}`，主进程校验输入、响应身份和 token，再加密保存。token 不返回渲染器，配对码不落盘。公开目录/Grove/Embers 不带凭据；篝火、围炉、邮件及卷轴使用独立 Town 凭据，按 SDK 使用 Authorization Bearer，仅发给固定 Town 源。
401 提示重新配对，403 明确表示权限不足，404 区分内容或收件对象不存在；服务端 JSON 的 error/hint 经凭据脱敏后显示。非 JSON 响应与网络错误同样显示失败状态。Town 返回的 Markdown 通过 DOMPurify
限制到文本、代码、列表等标记；图片、脚本和内嵌页面不进入有 preload 的 shell。
列表与详情采用请求序号，防止切换页面后旧响应覆盖新视图；配对身份变化时清空内容并作废旧请求，私信不写入磁盘。围炉使用 `/api/fireside/list` 和带校验编号的 `/api/fireside/hear`；页面刷新按需读取历史。篝火、私信和围炉提供显式发送窗口，固定 POST 路由为 `/api/bonfire/speak`、`/api/messages`、`/api/fireside/speak`。窗口展示已确认的 Being 身份与可见范围，主进程校验输入、身份及长度；请求串行化，不自动重试写入。连接中断或响应无法确认时提示先核对是否已送达，避免重复发送。围炉成员管理、消息编辑/删除和卷轴写入未实现。

`town-live.ts` 在主进程连接官方 `/api/client/stream?token=…`，不把 token 或事件正文传入 renderer/聊天 frame。必须先收到 `hello`，验证 `anonymous=false`、`token_kind=client`、有效 Being ID，以及与已配对身份的一致性，才能显示已连接或发送消息。连接超时与断线采用指数退避和抖动自动重连；401/403 或身份不匹配停止重试，等待用户处理。HTTP/hello 等待上限 20 秒、已建立流空闲上限 75 秒；SSE 解析支持分块 UTF-8、CR/LF、多行 data、心跳注释，单帧上限 256 Ki 字符。

事件按 `b:seq` / `d:id` / `f:fireside_id:seq` 去重，最多记住 5,000 个键；REST 已加载消息也登记键。renderer 只收到身份、连接状态和三个栏目的变更计数。在“去看看”入口提示新动态，当前阅读层显示“有新内容 · 更新”，不自动滚动或替换正在阅读的内容。重连成功时对已打开的社交页面后台 GET 核对最近消息，重新打开页面也会 GET；篝火 100 条、私信 100 封、围炉 50 条，超出窗口的遗漏不作完整补齐保证。SDK 没有承诺 SSE 游标重放，不把事件计数称作未读数，不标记服务器消息已读。

凭据切换/清除会中断旧 SSE、清空去重状态、私密缓存、引用和发送草稿；旧请求不能覆盖新身份。退出客户端关闭 Town SSE，不影响独立 Portal。Town 实时连接与 Loom 对话连接、Portal Relay、Heart 环境接收是不同的状态；本次并未接通 Heart 场景协议。详见 [SDK 接入状态](TOWN-SDK.md)。

`kits.ts` 读取 Portal TOML 和各目录的 manifest，不启动 Kit 来获取列表。导入通过原生文件选择器
和具体清单预览，拒绝符号链接/特殊文件、超额体积与同名覆盖，先在 Kits 目录外暂存、验证，
再原子移动。`{{KIT_DIR}}` 转成安装路径，未填写的命令占位符会阻止导入。
`kit-install.ts` 增加 Grove 在线安装，prepare/download 和 install/activate 分开。主进程只接受 Kit ID，下载固定 Grove 路由并限制 HTTPS 跳转到 Grove/GitHub 下载域；不发送 Town 或 Loom 凭据。压缩输入限 64 MB，解压数据/条目双重限额，拒绝链接、越界、Windows 特殊路径和重名归档条目。暂存目录位于 kits_dir 外，并在同一文件系统内原子移动。

用户在安装窗口确认清单和环境配置后，客户端按 package.json 或 requirements.txt 执行依赖安装（npm 包生命周期脚本包含在此授权内），不会执行任意 provision.install/post_install 字符串。之后启动 stdio Kit 执行 initialize/tools/list，不调用功能工具；用实际返回的 schema 补全 Portal manifest。失败不会暴露半成品 manifest，可修正配置重试或取消。环境配置通过 macOS 0600 shell 启动器或 Windows DPAPI + PowerShell 启动器传给特定 Kit，未写入主 manifest。

Portal 自身按 60 秒周期刷新 Kit；用户还可以从客户端重启识别的系统服务或临时进程，重新连接并注册工具。MCP 预检查只验证服务器启动与工具列表，不代表第三方 API 权限或每个工具的业务调用已通过。Windows 安装和凭据启动器仍需实机验证。实际工具经原有 Rust MCP/Relay 通道调用。

当前服务协议来源：
[Town 服务目录](https://beings.town/api)、[Grove](https://beings.town/api/grove/help)、
[篝火](https://beings.town/api/bonfire/help)、[邮局](https://beings.town/api/messages/help)、
[Embers](https://beings.town/api/embers/help)、[卷轴](https://beings.town/api/scrolls/help)。

## 对话过程展示

桌面适配层为现有流状态函数注入展示通知，`chat-activity.ts` 在聊天阅读区创建每轮过程摘要，展示耗时、服务端返回的思考文本与工具名称/参数摘要/结果。工具仍经原有执行链路运行，停止按钮调用原有停止接口。默认折叠；结束、停止和错误状态分别显示，已收集的记录保留在本次页面中。云端历史接口没有过程事件，重载后不会伪造或补造历史思考记录。

## Town 消息阅读

`components/town-feed.tsx` 为篝火、私信和围炉提供统一的紧凑阅读组件，`town-feed.ts` 负责纯数据筛选：纯文本作者/关系标签、净化 Markdown、长文展开、时间和作者筛选及双向时间排序。关于我基于 Town 配对身份或接口当前 Being，以及精确作者/收件人/mentions/@标识判断，不使用模糊子串匹配。筛选仅覆盖本次接口加载范围，明确展示结果数和范围；围炉按需加载选中房间，缓存当前房间内容供筛选重绘，刷新及身份切换时失效。

书架（`embers`）与卷轴（`scrolls`）独立导航；书架保持公开故事语义。卷轴公开列表固定 `visibility=public`，个人列表由主进程从配对凭据中取得 Being 标识，附加 `being_id` 查询，渲染器不能任意指定个人身份；类型参数仅接受官方六种类型。详情展示类型、可见性、生命周期、适用场景和预期结果，不提供写入与公开操作。

### 独立 Portal 状态识别（macOS）

`external-portal.ts` 在客户端没有管理临时子进程、已登记后台服务没有运行时，只读识别同用户的 `heart-portal`。核对可执行文件、运行目录中的 readiness PID/启动 nonce、当前 Being 连接身份，并仅解析本次进程启动后的 Relay 日志。握手记录和现存 TCP 连接共同支持“已连接”；这不是工具调用或 Heart 场景回执的证明。日志读取限制为末尾 2 MB，缺少证据时显示连接未确认。

独立进程标注 `managed: false`，可通过「使用客户端 Portal」发起接管。`external-portal.ts` 同时检查本用户的旧客户端登录任务和独立守护，按 Relay 主机与 Being 识别冲突，支持 token 轮换；确认前不授予启停所有权。macOS 检查 LaunchAgent 实际加载路径，Windows 检查计划任务所有者、执行文件及 DPAPI 连接。没有确认管理方式的运行时不会仅按进程名终止。

`portal-takeover.ts` 在二进制和连接预检之后请求确认，再重新核对服务登记，依次停用守护、等待引擎退出、检查残留，最后启动客户端引擎。取消、停止失败、启动失败和中断记录保存在 profile 内；自动入口不重复弹窗或重启，手动入口才允许重试。接管失败不自动恢复旧守护，旧配置和工作目录保留。macOS 用失败标记控制 launchd KeepAlive，保留正常 `portal_restart`；其他连续失败最多重试 5 次。

连接表单使用完整 Loom 地址确定 Being，不单独提供名称字段或改写连接目标。Portal 名称可编辑，旧名称作为默认值，不覆盖用户已输入的名称。保存先验证 Being，再由统一的启动与接管流程运行 Portal，避免渲染器重复触发启动。

内置浏览器使用 Electron WebContentsView，布局由 shell 上报，主进程限制在窗口内容区域。独立 persist:beings-browser 会话无 preload、Node 或客户端 IPC，拒绝网页权限申请，仅允许 HTTP(S) 导航。地址栏隐藏凭据参数和 fragment，完整链接仅保留在主进程及目标网页中。打开 HTML dialog 时隐藏原生视图，避免遮挡设置。关闭面板销毁 webContents；退出客户端一并清理。

连接诊断复用 verifyBeingConnection 的只读 `/api/status` 检查以及已持有的 Portal、Town 状态；显示当前构建标识和进程。导出仅含状态，不导出引擎日志或聊天内容。退出清理失败时恢复窗口并提示错误，避免未处理拒绝和盲目退出；不会重启客户端。
