# Portal Desktop 桌面架构

参考 Codex 的「桌面 UI / 本地引擎分离」模式。OpenAI 的公开
[App Server 文档](https://learn.chatgpt.com/docs/app-server)描述了富客户端使用独立引擎、
请求和事件协议的集成方式。此项目不依赖 Codex 私有实现，也不需要 OpenAI API。

```text
Electron BrowserWindow
└─ 本地 React + TypeScript shell：对话、Being 入口、Portal 面板、设置
    └─ 隔离 preload：固定的、经过顶层 frame 校验的 IPC
        └─ beings:chat-* / beings:chat-event / beings:chat-state

Electron main
├─ safeStorage：加密连接配置
├─ 对话核心（main/chat/）：会话、SSE 流、断线恢复、历史对账、加密缓存
│   └─ HTTPS → 云端 Being，凭据只在主进程内注入
└─ PortalSupervisor：Rust 子进程、脱敏日志、启停、受控重启
    └─ heart-portal → WSS /_relay → 云端 Being
        └─ tools/call → Rust 文件/搜索/命令/Kits → 结果回传
```

主进程源码位于 `main/`，按窗口应用、对话、Portal、Town、Kits、浏览器与更新分组；
`preload/` 提供固定接口，`shared/` 保存跨进程类型与纯函数。源代码职责见
[桌面目录说明](README.md)。

## React 界面

`renderer/main.tsx` 使用 React 19 的 `createRoot` 挂载应用，Vite 编译 TSX 并提供组件热更新。
`app/page.tsx` 组合对话、Town、Portal、浏览器和设置组件。一级目录按业务模块划分，
模块内再按 `components/`、`models/`、`hooks/` 分类，协议代码放在 `services/`。
渲染层只有一个样式入口；目录规则见 [React 界面结构](renderer/README.md)。

`app/models/app.ts`、`town/models/town.ts` 和 `app/models/workspace.ts` 管理连接、异步读取、身份、
发送草稿及引用，组件通过 `useSyncExternalStore` 订阅稳定的版本快照。网络读取保留请求
序号校验；Town 身份变化时清空私密内容并作废旧请求。`useEffect` 统一注册与释放 IPC
订阅、窗口监听和计时器，开发模式启用 StrictMode 验证重挂载。

DOM 引用仅用于焦点、原生 dialog、动画、滚动、选区测量和浏览器边界。对话与 Town 共用
`shared/components/markdown.tsx`：Markdown token 直接转为 React 元素，原始 HTML 没有执行路径；
高亮代码通过 token emitter 转为 React span，链接限制为 HTTP/HTTPS。

对话与壳层同在一个 React root：`conversation/components/conversation.tsx` 组合时间线、
活动行、引用与输入框，`conversation/models/` 保存时间线投影、草稿与侧栏归类。渲染层不与
Being 通信——它订阅 `beings:chat-state` / `beings:chat-event`，调用 `beings:chat-*` 请求，
拿到的是主进程已经核对过的行。`app/hooks/use-conversation-bridge.ts` 把它接进壳层的出站
通道（引用草稿、⌘F 跳转、连接状态）。主进程、preload、Rust 引擎不依赖 React。
详见 [渲染器维护说明](renderer/README.md)。

`beings://chat` 这条路径——沙箱 Loom 文档、它背后的主进程请求代理、以及随之而来的
SBS 开关与「当前场景 / 全部场景」切换——已于 2026-09-16 整体移除，见根目录
[MIGRATION.md](../MIGRATION.md) 的「P1 完成状态」。

## 消息来源场景（sw 规范）

字段结构参考 [loom-local a18812c 的发送实现](https://github.com/d5z/loom-local/blob/a18812c35d2e2322f745f841d1d94fdec6015893/loom.html#L3160)；上游普通发送和思考中追加都携带房间标识及客户端元信息。

**一个会话就是一个 scene。** `main/chat/being-chat.ts` 的 `sceneId(desktopId, sessionId)`
由本 profile 的持久 Desktop 身份（`desktop-id.json`）与会话 ID 合成 `scene_id`，
`POST /api/chat/stream` 的 JSON 顶层带上它与 `scene_meta`
（`{ client: "being-desktop/<实际客户端版本>", scene_label: <会话标题> }`）。
反向的 `sessionFromScene()` 是每个事件与每一行历史的路由步骤：不需要任何注册表，
`scene_id` 自己就说明了这一行属于哪个会话，因此多个会话可以同时呼吸而不串台。
桌面级的单一房间标识（`chat-scene.json` 里的 `desktop-<UUID>`）随 `main/chat/scene.ts`
一起删除——它是“整个客户端只有一段对话”时期的产物。

场景字段由主进程写入，渲染层给的同名字段一律被覆盖。场景字段不进入 `message` 正文，
不携带协议提示、格式要求或要求 Being 翻译回执。服务端 SSE `meta` 原样透传，不渲染为
对话正文。Desktop 身份不可用时主进程直接拒绝对话 IPC 并说明原因，不降级为无场景发送。

`/api/history` 的游标按全部来源推进，主进程按 `scene_id` 把行分派给各自的会话；
不属于任何已知会话的历史行（包括 0.8.x 之前没有 scene 的旧行）不进入任何会话的时间线。
缓存按 Being 身份分文件保存在 profile 的 `chat-cache/` 下，由 safeStorage 加密。

此协议报告消息来自哪个客户端会话。`renderer/shared/models/scene.ts` 中的页面、筛选和选中
对象仍是本地观察，不随这两个字段上传；完整页面环境快照及 Heart 接收回执的讨论见
[共同工作空间](SHARED-WORKSPACE.md)。

## 与现有项目的适配

Rust 引擎源码随 `heart-portal/` 目录一起版本管理，客户端与引擎由同一次提交记录，CI 和本机构建读取同一版本。来源见根目录 UPSTREAM.md；发布包只包含编译后的 Portal 可执行文件和许可，不包含源码或 Cargo 构建缓存。

对话界面随壳层一起由 Vite 编译，没有独立的 HTML 入口或第二次构建：`loom.html` 与
`scripts/build-chat.mjs` 已随 iframe 路径一起删除，因此对话页不再能在普通浏览器里单独打开。
`scripts/prepare-desktop.mjs` 负责 Portal 二进制、runtime bundle 与
`desktop/generated/THIRD-PARTY-LICENSES.txt`（marked / highlight.js / react / react-dom /
scheduler 的许可声明，经渲染层 `publicDir` 进入安装包）。对话协议保持兼容已有 API。

客户端复用服务端历史，不制造服务端没有实现的新建/删除会话接口：会话由客户端按 `scene_id`
自行划分，服务端看到的仍然是同一条历史。侧栏列出当前 Being 的会话，以及小镇、篝火、围炉、
私信、书架、卷轴、Kit 和本机 Portal；当前版本只保存一个 Being 对话连接及一个独立 Town 身份。

Portal 的 connect 模式不会打开旧的 Cowork HTTP 服务或 MCP TCP 端口，桌面应用不假设
存在 `/api/health` 或本机 REST API。命令通过云端 Being 的正常工具调用链抵达 Rust，
没有另造可被聊天内容调用的 JS exec 通道。CLI 参数只包含配置路径和 Portal 名称；
连接链接通过 `PORTAL_CONNECT_LINK` 环境变量传入。

`HEART_PORTAL_SUPERVISED=1` 开启已有的 `portal_restart`，Portal 返回调用结果后正常退出，
后台模式中 macOS launchd 或 Windows PowerShell 守护脚本约 5 秒后重新启动它。Windows 计划任务同时负责守护脚本自身的异常恢复。临时模式仍由 Electron 负责。网络重连由 Rust 内置退避负责。
日志匹配用于展示 Relay 状态，不把进程存在当成已完成握手。

`main/portal/background.ts` 将引擎复制到应用数据目录内的独立版本目录，注册当前用户的登录任务。服务只运行 Rust 和系统启动脚本，不启动 Electron 或窗口。设置更新先准备新运行目录，注册失败时恢复旧服务；只在成功后替换服务元数据。相同配置重复启动只附着，不重启正在工作的进程。设置中的后台开关控制持久启动，显式停止同时禁用登录恢复。关闭窗口仅隐藏并保留临时 Portal；明确退出客户端才会清理临时子进程。

客户端托盘提供恢复窗口和退出入口；Dock 激活与第二次启动同样恢复原窗口。`main/app/startup.ts` 独立管理 macOS/Windows 的客户端登录自启，读取系统状态并校验写入结果，不依赖 Being 配置或 Portal 生命周期。Windows NSIS 和便携版使用稳定目录中的当前可执行文件，旧 Squirrel 安装仍识别其稳定启动器；开发模式与 Linux 不注册登录项。

macOS 可识别配置目录、连接链接和已知启动脚本均匹配的原 Heart Portal LaunchAgent；不改写它的脚本、TOML 或凭据。改变此类已有服务的连接/路径需要在原配置中处理。新建的 macOS 后台凭据用 `0600` 文件和 `0700` 目录保护；Windows 后台凭据用当前用户 DPAPI 加密。服务注册项和进程参数不包含 token。

## 信任边界

- 主窗口仅加载本地 shell，没有任何子 frame：`beings://` 只服务 `desktop` 一个主机，
  `will-frame-navigate` 只允许 shell 自身，页面 CSP 的 `frame-src` 为 `'none'`。
  渲染器启用 sandbox/contextIsolation，关闭 Node。
- preload 只暴露固定 API，主进程校验 IPC 必须来自当前窗口的顶层 shell frame。
- 渲染层不持有 Being 地址或 token，也不发起到 Being 的请求：对话只经固定的
  `beings:chat-*` 通道，主进程校验每个入参并注入凭据。
- 上游请求禁止重定向，凭据不会被带到不同站点。SSE 在主进程逐块解析，切换连接会终止上游请求。
- 页面资源离线打包，对话交互由 React 绑定。CSP 只允许本地脚本，禁止内联脚本、任意外部脚本、子 frame 和表单。
- 新窗口/导航只允许经过协议筛选的 HTTP(S) 链接在内置浏览器打开。
- `safeStorage` 加密客户端凭据；后台凭据另按上述 OS 机制保存。UI 展示最近 300 行脱敏日志；后台文件日志由系统启动脚本写入，macOS 每次重启保留上一份。
- 工作目录约束由 Rust 文件工具执行。用户开启命令和扩展工具后，这些能力具有对应进程权限，不能声称文件工具的目录边界约束了所有 shell 行为。

## 当前范围

⌘F 在当前会话已加载的提问里搜索并跳转：索引由对话模型的 `questions()` 直接派生
（行 ID `row-<seq>`，文本截断到 240 字），不单独保存副本，跳转把该行滚到视野中央并短暂高亮。
展开/收起采用淡入与高度过渡，遵循系统减少动态效果设置；跳转保留草稿。

对话缓存在主进程：`main/chat/cache.ts` 与 `main/chat/store.ts` 按 Being 身份在 profile 的
`chat-cache/` 下分文件保存，内容由 safeStorage 加密。三条不变量沿用 Loom 的 IndexedDB 思路
（`loom.html:3620 / 3600 / 3660`），以服务端 seq 为主键，行与游标同批落盘。缓存失败退回
网络读取，清除 profile 会移除缓存。草稿、附件二进制、未完成回复以及服务端历史缺失的
思考/工具细节不作为对话历史备份。

已覆盖内置对话（多会话）、本机 Portal、小镇内容客户端、Kit 清单/导入以及桌面打包。篝火/邮局/卷轴的真实数据仍取决于 Town 服务的认证授权。当前不扩展自建服务端能力，逐次工具审批尚未实现。侧栏的置顶/归档等会话元数据尚未持久化，见 [MIGRATION.md](../MIGRATION.md)。macOS Developer ID 签发与 Portal 源仓一致，公证暂缓；检查更新和手动安装后的 Portal 配套升级见 UPDATING.md。后台登录自启已支持 macOS 和 Windows，Windows 需在目标系统进一步验证；Linux 暂仅支持临时运行。登录前启动及休眠时联网不在本功能范围内。

Electron 的 API 和隔离配置参考
[protocol](https://www.electronjs.org/docs/latest/api/protocol) 与
[Security](https://www.electronjs.org/docs/latest/tutorial/security) 官方文档。

## Town 与 Kits

Seed Garden 是公开阅读模块：主进程开放 `/api/seeds` 的分页/搜索/领域/标签/Kit/状态查询及固定详情、`lineage`、`absorb` GET 路由，不附带凭据。`town/components/seeds.tsx` 展示列表和正文，派生关系与内化记录按需加载、卸载后丢弃旧结果；主详情沿用 Town 请求序号。左下角“花园”、服务目录、对话种子链接及 Grove 经验墙均进入同一个原生页面。种子内容沿用 Markdown 净化和公开“一起看”引用；没有种子或标签写入接口。

`app/components/navigation.tsx` 在弹窗内提供主要 Town 功能切换，当前标题独立突出；入口统一调用 `AppModel.navigate`，每次进入都清理旧详情并重新读取，旧请求不能覆盖新页面。种子、卷轴和书架共用 `town/components/reading-actions.tsx` 的复制链接与浏览器打开操作栏。

社区插件的后续扩展契约见 [插件扩展方案](EXTENSIONS.md)。该文档区分现有 Kit 能力与拟议的界面插件宿主；下文描述当前已实现的运行路径。

`TownClient` 使用独立 GET 路由表与固定 `https://beings.town` 源。IPC 不接受任意请求地址、
方法或认证头。配对通过固定 `POST /api/client/pair/confirm` 交换 `{town_id, code}`（兼容旧 `{being_id, code}`），主进程校验输入、响应身份和 token，再加密保存。token 不返回渲染器，配对码不落盘。公开目录/Grove/Embers 不带凭据；篝火、围炉、邮件及卷轴使用独立 Town 凭据，按 SDK 使用 Authorization Bearer，仅发给固定 Town 源。
401 提示重新配对，403 明确表示权限不足，404 区分内容或收件对象不存在；服务端 JSON 的 error/hint 经凭据脱敏后显示。非 JSON 响应与网络错误同样显示失败状态。Town 返回的 Markdown 通过 React token 渲染器
限制到文本、代码、列表等标记；图片、脚本和内嵌页面不进入有 preload 的 shell。
列表与详情采用请求序号，防止切换页面后旧响应覆盖新视图；配对身份变化时清空内容并作废旧请求，私信不写入磁盘。围炉使用 `/api/fireside/list` 和带校验编号的 `/api/fireside/hear`；页面刷新按需读取历史。篝火、私信和围炉提供显式发送窗口，固定 POST 路由为 `/api/bonfire/speak`、`/api/messages`、`/api/fireside/speak`。窗口说明以已配对 Being 身份代发及可见范围，主进程校验实际身份、输入及长度；请求串行化，不自动重试写入。连接中断或响应无法确认时提示先核对是否已送达，避免重复发送。围炉成员管理、消息编辑/删除和卷轴写入未实现。

`main/town/live.ts` 在主进程连接官方 `/api/client/stream?token=…`，不把 token 或事件正文传入渲染层。必须先收到 `hello`，验证 `anonymous=false`、`token_kind=client`、有效 Town ID（兼容旧 Being ID），以及与已配对身份的一致性，才能显示已连接或发送消息。连接超时与断线采用指数退避和抖动自动重连；401/403 或身份不匹配停止重试，等待用户处理。HTTP/hello 等待上限 20 秒、已建立流空闲上限 75 秒；SSE 解析支持分块 UTF-8、CR/LF、多行 data、心跳注释，单帧上限 256 Ki 字符。

事件按 `b:seq` / `d:id` / `f:fireside_id:seq` 去重，最多记住 5,000 个键；REST 已加载消息也登记键。renderer 只收到身份、连接状态和三个栏目的变更计数。在可展开/收起的横向小镇入口提示新动态，当前阅读层显示“有新内容 · 更新”，不自动滚动或替换正在阅读的内容。重连成功时对已打开的社交页面后台 GET 核对最近消息，重新打开页面也会 GET；篝火 100 条、私信 100 封、围炉 50 条，超出窗口的遗漏不作完整补齐保证。SDK 没有承诺 SSE 游标重放，不把事件计数称作未读数，不标记服务器消息已读。

凭据切换/清除会中断旧 SSE、清空去重状态、私密缓存、引用和发送草稿；旧请求不能覆盖新身份。退出客户端关闭 Town SSE，不影响独立 Portal。Town 实时连接与 Being 对话连接、Portal Relay、Heart 环境接收是不同的状态；本次并未接通 Heart 场景协议。详见 [SDK 接入状态](TOWN-SDK.md)。

`main/kits/catalog.ts` 读取 Portal TOML 和各目录的 manifest，不启动 Kit 来获取列表。导入通过原生文件选择器
和具体清单预览，拒绝符号链接/特殊文件、超额体积与同名覆盖，先在 Kits 目录外暂存、验证，
再原子移动。`{{KIT_DIR}}` 转成安装路径，未填写的命令占位符会阻止导入。
`main/kits/install.ts` 增加 Grove 在线安装，prepare/download 和 install/activate 分开。主进程只接受 Kit ID，下载固定 Grove 路由并限制 HTTPS 跳转到 Grove/GitHub 下载域；不发送 Town 或 Loom 凭据。压缩输入限 64 MB，解压数据/条目双重限额，拒绝链接、越界、Windows 特殊路径和重名归档条目。暂存目录位于 kits_dir 外，并在同一文件系统内原子移动。

Grove 列表与详情通过 `localKits()` 读取当前 Portal 目录，以安装目标的 manifest.name 匹配所有 Kit（包括旧安装与本地导入），显示“已安装”和本机版本。安装成功后保留当前条目并重新读取磁盘，已安装条目提供“查看本机 Kit”入口并禁用重复安装；重开页面或刷新会重新确认状态。读取失败显示可重试提示，清单损坏显示“本机文件异常”，均不冒充安装成功。“已安装”表示文件已就位，不代表 Portal 已加载或工具调用已验证。

用户在安装窗口确认清单和环境配置后，客户端按 package.json 或 requirements.txt 执行依赖安装（npm 包生命周期脚本包含在此授权内），不会执行任意 provision.install/post_install 字符串。之后启动 stdio Kit 执行 initialize/tools/list，不调用功能工具；用实际返回的 schema 补全 Portal manifest。失败不会暴露半成品 manifest，可修正配置重试或取消。环境配置通过 macOS 0600 shell 启动器或 Windows DPAPI + PowerShell 启动器传给特定 Kit，未写入主 manifest。

Portal 自身按 60 秒周期刷新 Kit；用户还可以从客户端重启识别的系统服务或临时进程，重新连接并注册工具。MCP 预检查只验证服务器启动与工具列表，不代表第三方 API 权限或每个工具的业务调用已通过。Windows 安装和凭据启动器仍需实机验证。实际工具经原有 Rust MCP/Relay 通道调用。

当前服务协议来源：
[Town 服务目录](https://beings.town/api)、[Grove](https://beings.town/api/grove/help)、
[篝火](https://beings.town/api/bonfire/help)、[邮局](https://beings.town/api/messages/help)、
[Embers](https://beings.town/api/embers/help)、[卷轴](https://beings.town/api/scrolls/help)。

## 对话过程展示

`main/chat/recovery.ts` 与 `main/chat/being-chat.ts` 解析每轮的过程事件并作为 `beings:chat-event`
推给渲染层，`conversation/components/messages.tsx` 在阅读区展示该轮的活动行：服务端返回的
思考文本与工具名称/参数摘要/结果。工具仍经原有执行链路运行，停止按钮调用 `beings:chat-stop`。
结束、停止和错误状态分别显示，已收集的记录保留在本次会话中。云端历史接口没有过程事件，
重载后不会伪造或补造历史思考记录。

## Town 消息阅读

`town/components/feed.tsx` 为篝火、私信和围炉提供统一的紧凑阅读组件，`town/models/feed.ts` 负责名称、投递身份与纯数据筛选：优先 `sender_display`，Town ID 保留大小写，消息列表只显示名称、ID 用于内部回复；纯文本作者/关系标签、净化 Markdown、长文展开、时间和作者筛选及双向时间排序。关于我基于 Town 配对身份或接口当前 Being，以及精确作者/收件人/mentions/@标识判断，不使用模糊子串匹配。筛选仅覆盖本次接口加载范围，明确展示结果数和范围；围炉按需加载选中房间，缓存当前房间内容供筛选重绘，刷新及身份切换时失效。

书架（`embers`）与卷轴（`scrolls`）独立导航；书架保持公开故事语义。卷轴公开列表固定 `visibility=public`，个人列表由主进程从配对凭据中取得身份，Town ID 使用 `author` 查询，旧 Being 名使用 `being_id` 查询，渲染器不能任意指定个人身份；类型参数仅接受官方六种类型。详情展示类型、可见性、生命周期、适用场景和预期结果，不提供写入与公开操作。

### 客户端 Portal 与已有配置

`main/app/settings.ts` 在读取和保存配置时固定使用当前客户端内置的 Portal 路径，忽略旧记录或渲染器传入的外部可执行文件路径。连接、名称、工作目录、PATH 和工具设置继续保留。已有 TOML 原样使用；首次配置可读取 `~/.heart-portal/portal.toml` 或旧 runtime 下的配置，也可以从旧服务记录获取配置路径，不要求旧引擎存在或运行。TOML 中的连接仅在客户端尚无连接时采用。

`main/portal/background.ts` 只恢复当前 profile 的客户端服务，不再接管旧独立引擎或守护。`main/updates/runtime.ts` 只更新客户端管理的引擎和守护，原 TOML、工作目录和 Kit 文件保持原位置；旧迁移日志不会重新启动独立 Portal。

`main/portal/external.ts` 仅用于识别同一用户、同一 Being 的冲突实例和可停止的守护。`main/portal/takeover.ts` 完成连接、配置和内置引擎预检，重新核对登记后自动停用旧服务、等待进程退出，再启动客户端引擎，无需切换确认。失败和中断记录暂停自动重试；旧版本的取消记录不再阻止使用客户端 Portal。无法核实管理方式时显示错误，不按进程名批量终止。旧配置和工作文件保留。

连接表单使用完整 Loom 地址确定 Being，不单独提供名称字段或改写连接目标。Portal 名称可编辑，旧名称作为默认值，不覆盖用户已输入的名称。保存先验证 Being，再由统一的启动与接管流程运行 Portal，避免渲染器重复触发启动。

内置浏览器使用 Electron WebContentsView，布局由 shell 上报，主进程限制在窗口内容区域。独立 persist:beings-browser 会话无 preload、Node 或客户端 IPC，拒绝网页权限申请，仅允许 HTTP(S) 导航。地址栏隐藏凭据参数和 fragment，完整链接仅保留在主进程及目标网页中。打开 HTML dialog 时隐藏原生视图，避免遮挡设置。关闭面板销毁 webContents；退出客户端一并清理。

连接诊断复用 verifyBeingConnection 的只读 `/api/status` 检查以及已持有的 Portal、Town 状态；显示当前构建标识和进程。导出仅含状态，不导出引擎日志或聊天内容。退出清理失败时恢复窗口并提示错误，避免未处理拒绝和盲目退出；不会重启客户端。
