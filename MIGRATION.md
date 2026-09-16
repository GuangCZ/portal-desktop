# 迁移记录：portal-desktop → Being Desktop

本仓库以 portal-desktop 为新核心重实现 BeingDesktop。本文件记录每个阶段改了什么、
标识符如何对应、以及哪些事情还没做。

---

## P0：身份与 profile（2026-09-16）

目标：**新版打开 BeingDesktop 0.8.x 的旧 profile 直接能用**，不写一次性迁移器。
本阶段只动标识符、profile 解析、Desktop ID 与 `settings.json` 读写；chat、town、
kits、portal 的行为除标识符与识别模式外保持不变。

### 1. 标识符对照表

| 用途 | 原值（portal-desktop） | 新值 | 依据 / 说明 |
| --- | --- | --- | --- |
| npm `name` | `portal-desktop` | `being-desktop` | 也决定 NSIS 的 `<name>-updater` 缓存目录名 |
| `productName` / 窗口标题 / 菜单 / 托盘 / 对话框 | `Portal Desktop` | `Being Desktop` | `desktop/main/app/{tray,window}.ts`、`main.ts` 的 `CLIENT_NAME` |
| `version` | `0.1.3` | `0.9.0` | 紧接 BeingDesktop 0.8.26 之后 |
| Electron `app.setName()` | `portal-desktop` | `Being Desktop` | **必须**与 BeingDesktop 0.8.26 `src/main.cjs:87` 完全一致：Electron 用 app 名派生 safeStorage 的钥匙串条目，名字不同则旧凭据全部无法解密。调用点在任何 `safeStorage` 之前 |
| userData 目录名 | `<appData>/portal-desktop`（旧回退 `Beings`） | `<appData>/Being Desktop` | 与 `app.setName()` 同名；旧 `Beings` 回退已删除，改为「新目录不存在且 `portal-desktop` 目录存在则沿用后者」 |
| profile 覆盖环境变量 | `PORTAL_DESKTOP_USER_DATA` | `BEING_DATA_DIR`（`PORTAL_DESKTOP_USER_DATA` 保留为别名） | `desktop/main/app/profile.ts` `profileOverride()`；既有测试与 NSIS/升级脚本继续用别名 |
| 启动失败时的临时诊断目录 | `<tmp>/portal-desktop-startup` | `<tmp>/being-desktop-startup` | 只写启动诊断，不是 profile |
| `scene_meta.client`（对话） | `portal-desktop/<version>` | `being-desktop/<version>` | BeingDesktop `src/being-chat.cjs:372` |
| `scene_meta.client`（Town 配对） | `portal-desktop` | `being-desktop` | BeingDesktop `src/town-pairing.cjs:63` |
| 环境快照信封 `source.channel` | `portal-desktop` | `being-desktop` | `desktop/renderer/shared/models/scene.ts`，`being.environment/v1` 是 portal-desktop 自有结构 |
| Desktop 工具桥名字 | 无 | `being-desktop-tools-<desktopId>` | 移植自 BeingDesktop `src/desktop-identity.cjs` |
| GitHub API `User-Agent` | `portal-desktop` | `being-desktop` | `desktop/main/updates/checker.ts` |
| 诊断报告 `client` 字段 | `Portal Desktop <version>` | `Being Desktop <version>` | `desktop/main/portal/diagnostics.ts` |
| LaunchAgent label / 计划任务名 | `town.beings.portal-desktop.portal.<hash>` | `town.beings.desktop.portal.<hash>` | `desktop/main/portal/background.ts`；`<hash>` 仍是 profile 目录绝对路径的 sha256 前 16 位 |
| Portal 接管识别模式 | `town.beings.(portal-desktop\|desktop).portal.<hex>` 与 `town.beings.heart-portal.<hex>` | **不变** | 已同时覆盖新老两族；旧 label 必须继续被识别，否则旧守护会在接管后把被替换的引擎重新拉起。`desktop/main/portal/external.ts` |
| macOS bundle id / 签名 `clientIdentifier` | `town.beings.portal-desktop` | `town.beings.desktop` | BeingDesktop `docs/macos.md:41`、`src/main.cjs:88`（`setAppUserModelId`） |
| Portal 引擎签名 id | `com.aspect.heart-portal` | **不变** | 引擎不属于本次改名 |
| macOS 可执行文件名 | `Portal Desktop` | `Being Desktop` | `forge.config.ts`；`desktop/main/updates/mac-package.ts` 的 `CFBundleExecutable` 校验同步改 |
| Windows 可执行文件名 | `portal-desktop` | `being-desktop` | `forge.config.ts`、`desktop/windows-installer.json`、`scripts/windows-prepare-install.ps1` |
| DMG 标题 | `Portal Desktop` | `Being Desktop` | `forge.config.ts` |
| Windows `appId` | `town.beings.portal-desktop` | `town.beings.desktop` | `desktop/windows-installer.json` |
| Windows NSIS GUID（卸载注册表键） | `6c60f1a1-e159-5c1d-b957-49045ea94314` | `47d8a38f-963d-5665-ad62-ab41c0307f69` | 见下节 |

### 2. Windows NSIS GUID 的推导

BeingDesktop 0.8.x 的 NSIS 配置没有显式 `nsis.guid`，用的是 electron-builder 由
`appId` 派生的值。推导出处：

- `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:157`
  `const guid = options.guid || UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID)`
- 同文件 `:28` `ELECTRON_BUILDER_NS_UUID = UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3")`
- `node_modules/builder-util-runtime/out/uuid.js` `uuidNamed()`：标准 RFC 4122
  name-based UUID，`sha1(namespaceBytes ++ nameBytes)`，在第 6、8 字节写入版本 5
  与 RFC 4122 variant。

即 `uuid_v5("town.beings.desktop", 50e065bc-3134-11e6-9bab-38c9862bdaf3)`
`= 47d8a38f-963d-5665-ad62-ab41c0307f69`。`tests/windows-installer.test.ts`
独立实现同一算法并断言 `desktop/windows-installer.json` 里的值与之一致，同时用
RFC 4122 附录 B 的公开样例校验算法本身。GUID 必须与 0.8.x 安装登记的一致，
否则 Windows 上会变成并存的两份安装而不是原地升级。

### 3. profile 与 Desktop ID

- `desktop/main/app/profile.ts`：`userData = <appData>/Being Desktop`；
  `BEING_DATA_DIR` 覆盖，`PORTAL_DESKTOP_USER_DATA` 为别名；删除了 `Beings` 旧目录
  回退，改为「`Being Desktop` 不存在而 `portal-desktop` 存在则沿用后者」——同一思路：
  改名不能把升级变成全新安装，也不能在运行中拷贝加密凭据和恢复日志。
- `desktop/main/app/identity.ts`：逐行移植自 BeingDesktop `src/desktop-identity.cjs`。
  `desktop-id.json`、v4 UUID、`wx` + `link` 的防并发覆盖创建语义、0600 权限、
  读坏文件时保留原文件并报错，全部保持不变。测试移植自
  `test/desktop-identity.test.cjs`（`tests/identity.test.ts`），夹具原样照抄。
- 主进程在 `SettingsStore` 之后加载 desktopId，失败只出启动提示、不阻止启动；
  `Snapshot.desktopId` 为可选字段（`desktop/shared/types.ts`）。

### 4. `settings.json` 兼容

`desktop/main/app/settings.ts` 的 `SettingsStore` 改为直接读写 BeingDesktop 的
`settings.json`（同一个 profile 目录），不再使用 portal-desktop 自己的
`connection.json`。格式依据 BeingDesktop `docs/interfaces.md` 第 7 节与
`src/main.cjs` 的 `disk` / `restore()` / `persist()` / `storeConnection()`。

读：

- `credential`（base64 的 safeStorage 密文）→ 解密得到 Loom 连接地址字符串 →
  `parseConnection`。明文地址先于凭据解密读出其余设置，钥匙串一时打不开不会让
  下一次保存丢掉 profile 的其它内容。
- `api=` 参数语义按 BeingDesktop `src/security.cjs` `parseConnection` 保留：它只
  移动 API base（`Connection.endpoint`），Loom 链接（`Connection.link`）不变；
  必须同源，且自身不带 query / fragment / 用户名密码，否则拒绝——避免把 token
  发到别的站点。`desktop/main/chat/connection.ts` 相应扩展并加了测试。
- `Settings.workspace`（本客户端语义 = Portal 工作目录）取
  `managedPortal.workspace`，其次 `portalWorkspace`。
- BeingDesktop 顶层的 `workspace`（Desktop 项目目录）另存为
  `Settings.projectWorkspace`，本阶段只读不用，后续阶段接管。
- `portalName` 缺省仍走 portal-desktop 现有的 `reusePortalConfig` 逻辑。
- 若 `settings.json` 不存在但同目录有 portal-desktop 的 `connection.json`，读一次
  并按新格式写出 `settings.json`；`connection.json` 原地保留，旧版本客户端仍能打开。

写：

- 未知字段（`typography`、`colors`、`chatBackground`、`glassStrength`、
  `onboarding`、`onboardingLoomConnected`、`sidebar`、`orchestration`、
  `desktopAutoUpdate`、`chatMode`、`closeToTray`、`adoptedPortal`、
  `portalExecutable`、`portalConfig`、`portalUpdateNotifiedVersion`、顶层
  `workspace` …）原样保留、原样写回。
- 连接地址未变时把原 `credential` 密文原样写回；只有用户保存了**不同的**连接
  （endpoint / being / token / relaySecret 任一不同）才重新加密新的地址字符串。
  「未变」按解析后的连接比较，而不是按字符串比较，所以保存失败后的回滚不会
  把地址重写成一个丢了 `api=` 的版本。为此 `SettingsStore` 暴露
  `connectionAddress`，`main.ts` 的回滚改为保存这个地址本身。
- `portalWorkspace` 与（若存在）`managedPortal.workspace` 一起写：BeingDesktop 读
  `managedPortal` 优先，两者不一致会让本客户端在下次加载时丢掉用户刚选的工作目录。
- 仍是 0600 权限、临时文件 + `rename` 原子写；临时文件名带 UUID，与
  BeingDesktop `persist()` 一致。
- 本客户端独有、BeingDesktop 没有对应字段的设置（`portalName`、`autoStart`、
  `backgroundEnabled`、`allowExec`、`kitsEnabled`、`portalConfigPath`、
  `portalEnvironmentPath`）以各自的名字写在顶层；BeingDesktop 的 `disk` 展开会
  原样带过去，不会冲突。

### 5. 本阶段刻意没改的标识符

| 保留项 | 原因 |
| --- | --- |
| 发布资产名 `portal-desktop-<version>-<platform>.<ext>`、CI 产物目录名、`d5z/portal-desktop` 发布仓库 | 发布渠道与在线更新是一对；改名会让已发布版本查不到更新。属于发布流程，不属于应用身份 |
| macOS 更新暂存目录前缀 `.portal-desktop-update-` | 与上面的资产名成套，同时改 |
| 构建期常量 `PORTAL_DESKTOP_BUILD`、`PORTAL_DESKTOP_UPDATE_REPOSITORY` 及 `PORTAL_DESKTOP_*` 构建/测试环境变量 | 构建与测试开关，不面向用户 |
| `PORTAL_DESKTOP_USER_DATA` | 作为 `BEING_DATA_DIR` 的别名保留；NSIS、macOS 升级脚本与既有测试靠它隔离 |
| `external.ts` 里的 `portal-desktop.portal` 识别分支 | 必须继续认出旧 label，否则接管会漏掉旧守护 |
| `com.aspect.heart-portal` 引擎签名 id | 引擎不在本次改名范围 |
| `appearance.json` | 仍是独立文件，未并入 `settings.json` |

### 6. 还没做的事

1. **Portal 接管尚未识别 BeingDesktop 0.8.x 与官方 heart-portal 安装器登记的守护。**
   `external.ts` 目前按 label 命名族 + 脚本文件名（`run.sh` /
   `portal-launchagent.sh` / `run.ps1`）识别。BeingDesktop 的
   `src/portal-launchagent.cjs` 还接受 `auto-connect.zsh` 包装器、`Program` 直接
   指向引擎（`--config` / `-c`）、以及 `.portal-executable` 指针文件等形态，并用
   `PORTAL_NAME` 正则判断可执行文件；Windows 侧见 `src/portal-windows-manager.cjs`。
   需要按这些实测形态补齐识别，否则老用户的 Portal 会被当成陌生进程。
2. **`appearance.json` 并入 `settings.json`。** BeingDesktop 把主题写在
   `settings.json`（`colors` / `glassStrength` / `chatBackground`），本客户端仍单独
   写 `appearance.json`，两边主题不互通。
3. **老用户需要手动升级一次。** BeingDesktop 0.8.x 用 electron-updater 与
   `Being-Desktop-<version>-macos-<arch>` 资产名；本仓库用自带的下载 + 校验 +
   替换流程与 `portal-desktop-*` 资产名。两条更新链不互通，0.8.x 用户必须手动下载
   安装一次新版；之后才会走新版自己的更新检查。
4. **BeingDesktop 的 `portalExecutable` / `portalConfig` 只保留、不采纳。**
   本客户端仍用自带引擎，并按自己的 `portalConfigPath` 管理配置；是否让新版直接
   接管 0.8.x 已绑定的 Portal 配置，留待 Portal 接管阶段一起决定。
5. **macOS 签名 team 未更新。** `desktop/macos-signing.json` 仍是
   `Developer ID Application: D5 Inc. (7N8XHQWCNN)`：BeingDesktop 的
   `electron-builder.mac.cjs` 与 `docs/macos.md` 都只说明 Developer ID 在构建时从
   钥匙串选取并写入 `~/Library/Application Support/Being Desktop Signing/developer-identity.json`，
   仓库里没有具体 team id。发布前需要用实际证书确认。
6. **未验证的打包链路。** `tests/*.mjs` 的打包/升级 E2E（electron-smoke、
   macos-upgrade-e2e、windows-upgrade-e2e 等）里的可执行文件名、`.app` 名、
   快捷方式名、LaunchAgent 前缀已同步改名，但本阶段没有真实打包运行过。

---

## P1：对话核心（2026-09-16）

目标：**把 BeingDesktop 0.8.26 的对话核心搬进 portal-desktop 的壳，并让 `beings://chat`
这条 iframe 路径彻底消失。** 分五块推进，逐块提交：

| 块 | 产出 | 记录 |
| --- | --- | --- |
| p1-client | `main/chat/{being-chat,recovery,ready,connection}.ts`：协议客户端、SSE 解析、断线恢复、watchdog | `docs/migration/p1-client.md` |
| p1-store | `main/chat/{store,cache,titles,session-recovery}.ts`：行存储、加密缓存、标题、会话级恢复 | `docs/migration/p1-store.md` |
| p1-sessions | `main/chat/{types,frame,context,sessions,details,ipc}.ts`、`main/extensions.ts`、`shared/{desktop-types,chat-references}.ts`、`preload/desktop-channels.ts` | `docs/migration/p1-sessions.md`、`p1-sessions-fix.md` |
| p1-ui | `renderer/conversation/`（时间线、草稿、侧栏归类、组件）、`app/components/sidebar.tsx`、`app/hooks/use-conversation-bridge.ts` | `docs/migration/p1-ui.md` |
| p1-cleanup | 删除 iframe 路径与聊天代理，清理脚本、测试与文档 | `docs/migration/p1-cleanup.md` |

### 1. 已完成

**对话核心在主进程，会话 = scene。** `main/chat/being-chat.ts` 的
`sceneId(desktopId, sessionId)` 用本 profile 的持久 Desktop 身份（`desktop-id.json`）与
会话 ID 合成 `scene_id`，`sessionFromScene()` 是每个 SSE 事件与每一行历史的路由步骤。
不需要注册表：`scene_id` 自己说明这一行属于哪个会话，因此多个会话可以同时呼吸而不串台。
主进程负责连接、发送、流式解析、断线恢复、历史对账与加密缓存（profile 的 `chat-cache/`，
按 Being 身份分文件，safeStorage 加密）。

**渲染层只认 IPC。** `renderer/conversation/` 订阅 `beings:chat-state` /
`beings:chat-event`，调用 `beings:chat-{sessions,view,send,stop,reload,change-session,
rename-session,forget-session,composer-data}`。它不持有 token，也不自己发任何请求。
`tests/architecture.test.ts` 的「the renderer cannot reach the network on its own」按语法树
扫描 `desktop/renderer/` 下的标识符，出现 `fetch` / `XMLHttpRequest` / `WebSocket` /
`EventSource` / `sendBeacon` 即失败（2026-09-16 补：此前只有导入规则，这句话没有测试兜底）。
连接地址本身仍到得了渲染层——`Snapshot.settings.endpoint` 要显示在设置界面里——但它只是
一个用来显示的字符串，没有任何发送路径。

**以下东西已从仓库删除**（本块，2026-09-16）：

| 删除 | 取代它的 |
| --- | --- |
| `desktop/main/chat/proxy.ts`（`ChatProxy` + 7 条路由白名单 + 凭据注入 + SSE 转发） | 主进程直接持有连接；`main/chat/ready.ts` 自己拼 `/api/status` 请求 |
| `desktop/main/chat/scene.ts`、profile 里的 `chat-scene.json`、`Snapshot.chatScene`、`ChatScene` 类型 | 会话即 scene，见上 |
| `desktop/renderer/chat/`（14 个文件：沙箱 Loom 页面、它的 runtime、bridge、IndexedDB 缓存、场景过滤） | `desktop/renderer/conversation/` |
| `desktop/renderer/app/hooks/use-chat-bridge.ts`（postMessage 桥） | `use-conversation-bridge.ts`（同窗口内两个模型之间的接线） |
| `desktop/renderer/app/components/chat-scene.tsx`、`AppModel` 的 `chatHistoryScope*` 与 SBS 字段、settings 的「模型设置」入口 | 无。原生会话没有「当前场景 / 全部场景」；SBS 与模型面板原本住在 Loom 页面里，见下面的未完成项 |
| `WorkspaceModel` / `SceneStore` 的场景封套（`SceneEnvelope`、`capture()`、`beings:scene-select` / `-capture` / `-result`） | 引用语义由会话层的 `references` 承担；`compose()` → `beings:scene-draft` → `conversation.placeDraft()` 这条「一起看」的路仍在 |
| 根目录 `loom.html`、`scripts/build-chat.mjs`、`package.json` 的 `build:chat` / `test:chat-react` / `test:chat-history` | 对话随壳层一起由 Vite 编译。`THIRD-PARTY-LICENSES.txt` 的生成搬进 `scripts/prepare-desktop.mjs`（渲染层 `publicDir` 仍然要它） |
| `beings://chat` 协议分支、它的独立 CSP、`will-frame-navigate` 的子 frame 例外、页面 CSP 的 `frame-src beings://chat` | shell 现在没有任何子 frame：`beings://` 只服务 `desktop`，`frame-src` 为 `'none'` |
| `tests/{chat-runtime,chat-scopes,chat-scene,chat-reference}.test.ts`、`tests/{chat-react,chat-history}.mjs` | 主进程侧由 `tests/{being-chat,being-recovery,chat-store,chat-cache,chat-sessions,chat-details,chat-ipc,session-recovery,session-titles}.test.ts` 覆盖；渲染层侧由 `tests/{conversation-model,composer}.test.ts` 覆盖 |

门槛：`npm run typecheck` 通过；`npx vitest run` 为
`Test Files 55 passed | 7 skipped (62)` / `Tests 473 passed | 16 skipped (489)`
（复审修复后；修复前是 463 / 479）；`npm run prepare:desktop` 通过。

### 2. 未完成

1. **五个 E2E 脚本改成跳过，没有重写。** `tests/{electron-smoke,town-sdk,portal-runtime-e2e,
   town-ui,sbs-refresh}.mjs` 都通过 `page.frameLocator('#chat-frame')` 驱动对话，
   iframe 没了之后每个 locator 都指向不存在的东西。它们现在在文件头说明原因并 exit 0，
   `npm run test:all` 因此**不再覆盖打包客户端的对话冒烟、Town SDK 往返与 Portal 运行时**。
   这五步在 `test-results/summary.json` 与 `summary.md` 里记作 `skipped`（不是 `passed`），
   顶层 `skipped` 数组列出名单。重写为针对原生对话 DOM 是 P2 的第一件事。
2. **选区工具条与「更多详情」解释卡片**未移植：依赖 0.8.26 的 `chatDetail*` 五个 IPC 通道，
   本仓库没有。引用可以经 `ChatSendRequest.references` 发出，历史里的引用信封也会被还原成
   chip——只是还没有产生引用的入口（除了 Town / Portal 日志的「一起看」）。
3. **`/` Kit 补全与 `@` 成员补全**未移植：`beings:chat-composer-data` 恒返回空目录。
   同一模块（`renderer/chat-composer.js`）里的输入法守卫已单独移植进 `ComposerModel`，
   见下面第 3 节。
4. **composer 的横排小镇入口**（0.8.26 的 `ChatPlaces`）未移植。它随 Loom 页面一起删除，
   `tests/town-names.mjs` 的 `/places` 覆盖也一并去掉了。
5. **worker 结果卡片**未移植：`ChatView.workerResults` 是 `unknown[]`，本仓库没有生产者。
6. **SBS 自主醒来开关、模型设置面板、关于 Being / 隐私说明**：原本是 Loom 页面内的面板，
   现已随页面删除（此前一版只是隐藏）。要恢复需要在原生对话里重做，并给主进程加
   `/api/llm/config` 的读写通道。
7. **侧栏元数据只在内存里**：置顶、项目归属、归档存在 `OrganizerModel` 里，关窗即失。
   0.8.26 由主进程按 Being 连接分桶存进设置（`sidebarAction`，src/main.cjs:1139）。
8. **项目只有一个**，取自 `snapshot.settings.workspace`；壳层没有「添加项目文件夹」入口。
9. **⌘1–9 切换会话没有绑**：本壳层的 ⌘1 是「回对话」，已绑的是 ⌘N（新会话）与 ⌘K（搜索会话）。
10. **不属于任何已知会话的历史行被丢弃**：0.8.x 之前没有 `scene_id` 的旧行不会出现在任何
    会话的时间线里，界面用一条一次性说明条解释，但没有「全部历史」视图。

### 3. 复审修复（2026-09-16）

对话页与清理两块的复审开出七条，逐条处理如下，记录见
`docs/migration/p1-ui-fix.md`。

| 条目 | 结论 | 处理 |
| --- | --- | --- |
| 正文链接 | markdown 链接从 0.8.26 的惰性文本变成了可点击 `<a>`，一点即在应用内浏览器打开 Being 给出的地址 | 恢复 0.8.26：chat 模式下没有站内目标的链接渲染成 `<span class="chat-link" title="<地址>">`，地址只在悬停提示里 |
| 连接时重复对账 | `use-conversation-bridge` 在 `chatSource` 变化时又发一次 `conversation.reload()` | 删除。绑定 Being 时 `ChatSessions.start` 已经 `reconcile({full: !seeded})` 对过一次，0.8.26 也不在连接时重读 |
| 输入法 | 提交候选词的那次 Enter 会把半截消息发出去 | `ComposerModel` 维护 `composing` 与 50ms 的 `compositionUntil`（chat-composer.js:98/106/142），窗口内的 Enter 不发送，点发送按钮则被「请完成输入后再发送。」挡下 |
| 停止确认 | 弹窗随页面卸载消失时 `ask()` 永不 settle，停止按钮此后永久禁用 | `cancelConfirm()`：连接关闭（`accept` 收到 `open:false`）、模型 teardown、弹窗组件卸载三处都 resolve(false) |
| 读取失败提示 | 投影读取失败从常驻状态行变成 6 秒 toast | 回到状态行：`ConversationModel.readError` 优先显示在 `.chat-phase`，下一次状态更新才清除（chat-app.js:325 的语义） |
| 架构测试文案 | MIGRATION/README 夸大了 `tests/architecture.test.ts` 的守护范围 | 新增规则「the renderer cannot reach the network on its own」，并改掉「不持有 Being 地址」这句（见上文第 1 节） |
| E2E 报告 | 五个 exit 0 的跳过脚本在 `summary.json` 里记成 `passed` | `scripts/test-all.mjs` 认 `SKIPPED:` 标记，记成 `skipped`，并在 `summary.json` 顶层与 `summary.md` 里单列名单 |

仍然存在、已知并接受的偏差：

- **代码片段里的裸链接仍可点击。** `shared/components/markdown.tsx` 的 `code()` 在
  chat 模式下把整段就是一个 `http(s)` 地址的行内代码渲染成 `.chat-code-link`，点击在
  内置浏览器打开。0.8.26 没有这个行为（那里的行内代码永远是纯文本）。保留的理由是
  它的可见文字就是目标地址本身，不存在「文案与去向不一致」这一层；上面那条修的正是
  可见文字与地址不一致的 markdown 链接。
- **站内链接仍可点击。** `placeFromURL` 命中的 `https://beings.town/...` 链接走
  `onPlace`，在本窗口内跳转到对应页面，不发任何网络请求。

### 4. 下一步

**P2：Town。** Town 时间线累积（`docs/town-sdk-integration.md` 与 BeingDesktop
`test/town-client*.test.cjs` 的实测分页语义：`since` 是最早 N 条、没有 `before`、序号稀疏）、
Town 缓存、Channel、配对探活。同时重写第 2 节第 1 条列出的五个 E2E 脚本。

**P3：工具与外壳。** Desktop 工具桥（`being-desktop-tools-<desktopId>`）、终端、
浏览器多标签。

---

## 集成阶段 I0：接缝（2026-09-16）

P0、P1 与七个纯移植单元（u1–u7）之后，剩下的工作是把移植进来的类接上 IPC、接上界面。
那是六到七个彼此独立的单元（Town、工具桥、终端与浏览器、编排与功能任务、对话补全、侧栏与设置、Channel 与 Portal），
要在各自的 worktree 里并行做。I0 不接任何一个，只铺它们共同需要的接缝，让合回 `next` 时共享文件上**只有 append-only 的一行式冲突**。

详细契约见 `docs/migration/i0-seams.md`。这里只记结论与偏差。

### 造了什么

| 接缝 | 文件 | 后续单元怎么用 |
| --- | --- | --- |
| 主进程子系统注册表 | `desktop/main/subsystems/types.ts`、`extensions.ts` | 一个子系统一个 `subsystems/<key>.ts`，在 `INSTALLERS` 加一行 |
| preload 通道 | `desktop/preload/channels/{bridge,chat,index}.ts` | 一个子系统一个 `channels/<key>.ts`，在 `desktopChannels` 加一行 |
| shared 类型 | `desktop/shared/desktop-types.ts`（聚合）、`chat-types.ts` | 一个 `shared/<key>-types.ts`，聚合器加一行 `export *` |
| renderer 插槽 | `desktop/renderer/app/slots.tsx`、`app/models/registry.ts` | 面板 / 侧栏段 / 顶栏动作 / 全屏页各一行；model 一行 |
| 共享正式实现 | `desktop/main/common/{sanitize,platform,loom-connection,message-context}.ts` | 直接 import，不再各带一份 |

`desktop/main/main.ts` 只改了一处（多传一个 `electron` 门面）。**I0 之后任何单元都不得再改 main.ts、package.json、forge.config.ts、vite.*.config.ts。**

复审之后补了两个生命周期钩子，都是「单元自己加不了、必须回 I0」的那类：
`DesktopSubsystem.linked?()`（全部子系统装完后同步跑一趟，方案 §3.4 的 `orchestration.presentation` 赋值要用它），
以及注册进 `FEATURE_MODELS` 的 renderer model 的 `start(): () => void`（开 IPC 订阅并把关闭函数交给壳层，与内置 `TownModel` 同一条路径）。
同时修掉一个潜伏雷：`models/app.ts` 里 `this.features as Record<string, unknown>` 在 `AppFeatureModels` 有了第一个键之后就编译不过，
而那个文件任何单元都不许改。

P1 的 chat 子系统原样搬进 `subsystems/chat.ts`，成为这套注册方式的第一个使用者与模板；P1 的全部测试未改一行仍然通过。

### 副本收敛

四份 `sanitizeText`、三份 `desktopEnvironment` / `consoleEnvironment` / `WINDOWS_RUNNER`、
两份 `parseConnection` / `endpoint` / `publicModelUrl` / `allowedNavigation`、两份 `desktopMessageContext`、
**四份** `sessionPartition`（方案只列了三份，`chat/session-recovery.ts` 是漏掉的第四份）全部合并到 `desktop/main/common/`。
合并前逐函数体做了去空白的字节比对：全部等价，差异只有 `match =>` 与 `(match) =>`、一个尾逗号、以及类型标注宽窄。
`sanitizeText` 的 `secrets` 取最宽的 `readonly unknown[]`，四种旧签名的调用方都兼容。

`beingIdentityKey(address)` 改成 `sessionPartition(parseConnection(address))` 的一行代理。
这是磁盘格式（chat-cache 文件名、session-recovery 文件名、功能任务分桶、worker 目录名、TownClientStore 键），
所以 `tests/identity-partition.test.ts` 用七个 BeingDesktop 夹具地址把它钉在写死的常量上。

三份 SSE 解析**没有**合并：上限与错误码语义不同（Town 1MB + `INVALID_RESPONSE`，chat 自带码表）。

### 依赖与打包：一个推翻方案的实测

`ws` 从 devDependencies 移到 dependencies（8.21.3，与 BeingDesktop 0.8.26 一致），新增 `node-pty` 1.1.0、
`@xterm/xterm` 6.0.0、`@xterm/addon-fit` 0.11.0，以及 `@electron-forge/plugin-auto-unpack-natives`。

**提级到 dependencies 并不足够。** `@electron-forge/plugin-vite` 会把 `packagerConfig.ignore` 设成
`file => !file.startsWith('/.vite')`，于是 `node_modules` 整棵树都不进包——第一次打出来的 asar 只有 15 个条目。
`forge.config.ts` 因此自带一个 `packagerIgnore`：放行 `.vite`、放行 `node_modules` 目录本身、放行 `ws` / `node-pty` / `node-addon-api`，
其余一律排除，并只保留打包主机平台的 node-pty prebuilds（asar 因此从 63 MB 降到 7.1 MB）。

本机（darwin-arm64）实测 `electron-forge package` 通过，并用干净的 Electron 44.2.0 对打出来的 asar 验证了
`require('ws')` 与 `require('node-pty')` 都能解析，node-pty 的原生模块从 `app.asar.unpacked/.../build/Release/` 加载。
`tests/packaging-contract.test.ts` 把这一整套钉住——这是 typecheck 与 vitest 都看不见的那部分。

**复审抓到的第二个打包缺口（已修）**：`AutoUnpackNativesPlugin` 的 glob 是 `**/*.node`，而 node-pty 在 macOS 上还要一个
**没有扩展名**的可执行文件 `spawn-helper`（`binding.gyp` 的 `OS=="mac"` 分支构建，`pty.cc` 只在 `__APPLE__` 下用它）。
它留在 asar 内的后果是每一次 `pty.fork` 都 `posix_spawnp failed.`——也就是说打出来的 macOS 包里终端根本起不来。
`forge.config.ts` 因此自带一条 `asar.unpack`（插件会与它合并而不是替换）。
第二次真跑 `electron-forge package` 核实：helper 落在 `app.asar.unpacked/.../build/Release/`，mode 755，被 osx-sign 签过，
`codesign --verify --deep --strict` 整包通过。

### 本阶段没做的事

- **没有接任何一个子系统。** 注册表里只有 chat；`PANEL_SLOTS` / `SIDEBAR_SLOTS` / `TOPBAR_SLOTS` / `SHEET_SLOTS` / `FEATURE_MODELS` 都是空数组。
- **`connectionCleared()` 依然没有调用方。** 接口和扇出都在，`main.ts` 从来没有接过它——这是 P1 就有的缺口，I0 没有顺手改。
  （IM 2026-09-16 核实结论：**本外壳没有解绑路径**，所以不是「忘了接」而是「没有可接的时刻」。`SettingsStore.connection` 只被赋非空值，从不回到 null；`save()` 的 `resolveConnection` 在没有链接且没有既有连接时抛「请先输入 Being 链接。」，空链接保留原 Being；61 条 `beings:` 通道里没有一条解绑，渲染层也没有入口。BeingDesktop 0.8.26 的 `handle('disconnect')`（src/main.cjs:1476）就是这个缺失的调用方，portal-desktop 从来没有这条命令。**换 Being 不走这个钩子**：0.8.26 在 `storeConnection`（src/main.cjs:704-716）里一步完成「掉旧绑新」，本外壳的各子系统 `connectionVerified` 按 `sessionPartition` 比对后做同一件事。证据与规则钉在 `tests/connection-cleared.test.ts`。）
- **`npm run start` 的人工冒烟没做**（本机缺 Rust 工具链，`resources/heart-portal` 不存在；打包验证用的是临时 stub）。
- **Linux 的 node-pty 没有 prebuild**，`MakerZIP` 的 linux 目标需要构建机上有 python3 + make + g++，本次未验证。

## 集成阶段：各单元记录（2026-09-16）

I0 的接缝铺好之后，每个集成单元在各自的 worktree 里把移植进来的类接成真实子系统，
详情写在自己的 `docs/migration/<unit>.md`，**这里只追加一行**。

| 单元 | 产出 | 用户可见的变化 / 记录 |
| --- | --- | --- |
| I1 · Town | Town 直连读写、累积时间线、成员目录与六位码配对（`subsystems/town.ts` + 24 条 `beings:town-*` 通道 + 三条推送）；删除旧 Town 层与 u3 的 Portal 控制器 | **需要重新配对**：凭据改由 `<userData>/town-client` 保管（与 BeingDesktop 0.8.x 同格式），旧的 `town-credential.json` 不再读取，也没有迁移器；篝火/围炉/私信改为本机直连，不再经 Being 转发，未配对时发送会提示「请用 Being 提供的六位配对码连接 Town。」（`docs/migration/i1-town.md`） |
| I2 工具桥 + 控制台 | `main/subsystems/tools.ts`、`main/tools/ipc.ts`、`preload/channels/tools.ts`、`shared/tools-types.ts`、`renderer/tools/`；六个接缝各 append 一行 | `docs/migration/i2-tools.md` |
| I3 终端 + 内置工具浏览器 | `main/subsystems/{terminal,tool-browser}.ts`、`main/tools/{terminal,browser}/ipc.ts`、`main/tools/terminal/node-pty.ts`、`preload/channels/{terminal,tool-browser}.ts`、`shared/{terminal,tool-browser}-types.ts`、`renderer/{terminal,tool-browser}/` | `docs/migration/i3-terminal-browser.md` |
| I4 编排 + 功能任务账本 | `main/subsystems/orchestration.ts`、`main/orchestration/{instructions,ipc}.ts`、`main/features/{methods,history-cache,town-sync,ipc}.ts`、`preload/channels/orchestration.ts`、`shared/orchestration-types.ts`、`renderer/{orchestration,features}/`；六个接缝各 append 一行。`orchestration.presentation` 待 I2 赋值、Worker 验收卡片待 I5，在那之前对话里看不到卡片（方案接受的中间态） | `docs/migration/i4-orchestration-features.md` |
| I6 | 侧栏持久化 + 关于/隐私：`main/shell/{sidebar-state,ipc}.ts`、`main/subsystems/shell-state.ts`、`preload/channels/shell-state.ts`、`shared/shell-state-types.ts`、`renderer/settings/`；`OrganizerModel` 改为主进程账本的投影 | `docs/migration/i6-shell-state.md` |
| I5 · 对话补全 | 请求上下文帧（发送时在主进程读取本机运行态，`prepareMessage` + `desktopEnvironment`）、解释卡片的七条 `beings:chat-detail-*` / `beings:chat-worker-result` 通道、composer 的 `/` Kit 与 `@` 成员补全数据、Worker 结果卡片；`tests/electron-smoke.mjs` 按原生对话页重写并在打包客户端上跑通 | 选中转写里的文字可以「添加到对话」或开一张**临时**解释卡片（关闭即不留本地记录）；`/` 唤出已安装 Kit 与两个内置能力、`@` 唤出 Being 成员（提及会公开到篝火，发送前要求本人按键确认）；委派出去的 Worker 有结果时，对话里出现可打开预览的验收卡片；`⌘1–9` 切到侧栏第 N 个会话 |
| I7 · Channel + 草稿入口 | 飞书/微信渠道向导与只读绑定检查、Town 功能目录与公开页、四种对话草稿合成一条 `beings:town-draft`（`subsystems/channel.ts` + 9 条通道 + 两条推送）；`prepareLoomDraft` 换成推向原生 composer 的 `prepareNativeDraft`，功能任务的「带到聊天里讨论」与「打开功能页」因此接通 | 顶栏多一个「消息渠道」按钮，打开是渠道向导与 Town 功能两个标签页；Town 功能的草稿**只填入当前会话、不发送**，对话框里已有草稿时会拒绝并保留原文 |
| I6b · 模型设置 + SBS | `/api/llm/config` 的读写（`subsystems/model-settings.ts` + `main/model-settings/{config,runtime,ipc}.ts` + `beings:model-settings` / `beings:model-config-get` / `beings:model-config-save` / `beings:sbs-set` 四条通道与 `beings:model-settings-state` 推送）；`PROVIDERS` 表逐字节镜像 Loom 1.8.0；`renderer/settings/` 新增模型页 | 侧栏底部多一个「模型」入口：在客户端里就能换模型、换服务商、填 API Key，保存后从 Being 读回确认；Side by Side 第一次可以在客户端开关（0.8.26 只显示、让你去 Loom 改）。状态未读到时显示「未知」而不是「已关闭」。API Key 只转发给 Being，不落盘、不进日志 |
| IM 合并后整合修复 | 工具浏览器归属收敛到 `tool-browser` 子系统（`DesktopTools` 改惰性注入，构造失败降级不再崩主进程），两条视口通道进 `QUIT_ALLOWED` 且**各自只为自己的矩形说话**、`test:tools` / `test:terminal` / `test:sidebar` 三个脚本接进 `test:all`、`main/town/channel/` 的 u3 副本收敛到 `main/common/`、`WorkerPresenter` 类型放宽、侧栏活动灯认 Worker、`beings:select-saved-project` 补回；`connectionCleared()` 核实为**本外壳没有可接的时刻**（见上）并把结论钉成测试；在打包产物上真跑了八个 E2E，修好 `town-sdk` / `town-ui` / `menu-keyboard` 三个从未执行过或已过时的脚本，并让前两个跑到底（红的两/四条各自带实测证据） | 侧栏项目可以切换工作目录（终端 / 控制台 / 工具桥随之改变）；有 Worker 在跑的会话，侧栏的灯是「说话中」；`beings:town-open` 回到工具浏览器标签页而不是系统浏览器；工具面板开在控制台页时不再把工具浏览器面板的网页摘掉（`docs/migration/im-integration.md`） |
| IN · 壳层错误码与合并后小缺口 | 错误包络改为以普通对象穿过 `contextBridge`，由 `preload/main-world.ts` 经 `contextBridge.executeInMainWorld` 在**页面自己的世界**里重建成带 `code` / `candidates` / `detail` 的真 Error（`preload/channels/{bridge,town}.ts` 与 `shared/{chat,town-desktop}-errors.ts` 各加一个 `*Payload` 规范化函数）；`SubsystemContext.portalState` 把 `PortalSupervisor` 的实时状态接进请求帧（定案 §5.2 至此成立）；`TOWN_ERROR_CODES` 加 `TASK_LIMIT_REACHED` 且抛出点改中文；功能任务的「模型」页接到 I6b 的对话框；退出期不再追快照；E2E 默认假钥匙串 | **对话、Town、模型设置三族通道的错误码终于到得了渲染层**（句子本来就到得了，码到不了，所以所有按码分支的界面都走不到）：未配对时 Town 页给的是「连接 Town，继续阅读」和一个配置按钮，而不是「暂时未能读取内容」加一个重试；私信收件人有歧义时重新列出 Town 给的候选人；模型设置能分清「请先填写密钥」与「Being 撤销了这次改动」；功能任务账本写满改说中文并指向任务页；功能任务页的「模型」可以打开模型设置了；退出时不再弹「客户端正在退出，请稍候。」（`docs/migration/in-shell-errors.md`） |
| IT · Town 读取行为 | 成员目录不再拖住篝火读（`session.ts` 的 `Promise.all` 拆开，改成「用手上的目录、把新的起飞但不等」）、`/api` 同一 in-flight 读合并、身份「到达」不再触发第二次 feed 读、围炉切换与往返的迟到答复围栏、回执只清自己那条草稿、后台采集状态行（`#town-refresh-status`，逐句照 BD 的触发条件，不由 Side by Side 代读取器说话）、身份到达时私信收件箱就地重投、共享目录读的 20 秒时限；BD `test/town-conversation-ui.cjs` 遗留的三族补齐为 `tests/town-conversation-rules.test.ts`（19 条）与 `tests/town-ui.mjs` 的四条真窗口 check | 篝火不再因为成员目录慢而空着（最长曾等 20 秒），@提及标签等目录到了再补；同一次打开只问一次公共目录；在围炉之间来回切换时，上一个围炉的迟到答复不会顶掉当前围炉的消息，也不会提前解锁刷新按钮；feed 上方多一行说明后台采集停在哪里（`docs/migration/it-town-feed.md`） |
