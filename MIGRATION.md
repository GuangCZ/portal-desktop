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
