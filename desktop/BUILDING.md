# 构建、打包与交付

本文对应 `package.json`、`scripts/build-portal.mjs`、`scripts/prepare-desktop.mjs` 和 `forge.config.ts`。桌面版本由 `package.json` 决定；根目录 `VERSION` 的 1.3.0 是原单文件 Loom 的版本，二者独立。

## 支持范围与前置条件

| 环境 | 前置条件 | 当前交付状态 |
| --- | --- | --- |
| macOS | Git、Node.js 22.12+、npm、Rust stable、Xcode Command Line Tools | Apple Silicon 支持 `.app` / DMG / ZIP；Intel 需对应 x64 机器另行构建 |
| Windows | Git、Node.js 22.12+、npm、Rust stable MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK | 配置了 ZIP / Squirrel Setup；Windows 原生构建、安装和后台任务仍需实机验收 |
| Linux | Git、Node.js 22.12+、npm、Rust stable、本机 C/C++ 链接工具及 Electron 桌面运行依赖、密钥库 | 配置了 ZIP；后台常驻未实现，未完成 Linux 桌面验收 |

这些是源码构建条件。使用已打包客户端进行聊天、运行内置 Portal 不需要另装 Node 或 Rust。特定 Kit 可能另需 Node/Python、账号凭据或外部 CLI，安装窗口会说明依赖。

Electron 与 Portal 必须来自同一目标操作系统和架构。目前脚本按**当前机器**构建，不提供交叉编译或 universal 包。不要单独给 Forge 加 `--arch` / `--platform` 来制作另一平台的包；也不要为本流程设置 `CARGO_BUILD_TARGET`、`CARGO_TARGET_DIR` 或 Cargo 的自定义 target-dir，否则脚本预期的 `target/release` 路径可能与实际输出不符。

## 从全新克隆开始

Portal 源码通过 `heart-portal/` 子模块引用，由客户端提交锁定版本。以下命令可在 macOS/Linux shell 或 Windows PowerShell 中逐行执行。

```text
git clone --recurse-submodules https://github.com/d5z/portal-desktop.git portal-desktop
cd portal-desktop
npm ci
npm run build:portal
npm start
```

已有克隆或拉取客户端更新后，运行 `git submodule update --init --recursive`，取得客户端锁定的 Portal 提交。GitHub Download ZIP 不包含子模块源码，源码构建请使用 Git 克隆。

### 更新 Portal

运行 `git submodule update --remote heart-portal` 显式取得兼容分支 `codex/portal-desktop-compat` 的最新提交。兼容分支合入原仓库 `main` 的更新，仅保留客户端必要的生命周期适配。验证客户端和引擎后，在 Portal Desktop 中提交子模块引用并更新 `UPSTREAM.md`。构建只使用锁定提交，不自动拉取远端代码；Portal 的编译、安装包与发布均跟随客户端。

仓库不提交 `node_modules/`、Portal 二进制、生成的网页资产或 `out/`。`npm ci` 根据 `package-lock.json` 安装依赖；首次构建需要联网下载 Electron、npm 包和 Cargo 依赖。`npm start` 先生成离线网页资产，再启动开发模式。

源码位于其他位置时，设置 `HEART_PORTAL_SOURCE`：

macOS / Linux：

```bash
export HEART_PORTAL_SOURCE="/absolute/path/to/heart-portal"
npm run build:portal
```

Windows PowerShell：

```powershell
$env:HEART_PORTAL_SOURCE = 'C:\code\heart-portal'
npm run build:portal
```

`build:portal` 执行 `cargo build --release --locked -p heart-portal`，复制结果到 `resources/heart-portal`（Windows 为 `heart-portal.exe`）。准备步骤只在该资源**不存在**时自动复制子模块源码的 release 引擎，不会自动替换已有引擎；Portal 源码更新后应显式重跑 `npm run build:portal`。`HEART_PORTAL_SOURCE` 同时影响构建、准备和完整测试流程，正式交付时应使用主仓库锁定的子模块版本。

## 构建命令与产物

在仓库根目录执行：

```text
npm run build:portal
npm run package
npm run make
```

`package` 生成可运行目录；`make` 会自行再次执行 package，并制作分发包，所以仅需分发包时可以跳过独立的 `npm run package`。两者都会先编译子模块 Portal，再生成本地聊天资源并打包；不运行自动化测试。

| 命令 / 平台 | 输出位置（`<arch>` 为当前架构，`<version>` 为桌面版本） |
| --- | --- |
| package / macOS | `out/Portal Desktop-darwin-<arch>/Portal Desktop.app` |
| package / Windows | `out/Portal Desktop-win32-<arch>/portal-desktop.exe`，必须连同所在目录的其他文件使用 |
| package / Linux | `out/Portal Desktop-linux-<arch>/portal-desktop`，必须连同所在目录的其他文件使用 |
| make / ZIP | `out/make/zip/<platform>/<arch>/Portal Desktop-<platform>-<arch>-<version>.zip` |
| make / macOS DMG | `out/make/Portal Desktop-<version>-<arch>.dmg` |
| make / Windows Setup | `out/make/squirrel.windows/<arch>/Portal Desktop-<version> Setup.exe`，同目录另有 `RELEASES` 和 `portal-desktop-<version>-full.nupkg` |

DMG 和 ZIP 均含完整客户端和内置 Portal；macOS 的 DMG 用于拖拽安装，ZIP 用于客户端内升级。不要只拷贝 Windows 的单个 exe 或 macOS `.app` 中的单个可执行文件。当前没有 MSI、AppImage、deb/rpm。版本标签触发 macOS / Windows 配套构建，全部验证通过后才发布 GitHub Release。

macOS 打开 DMG，将 `Portal Desktop.app` 拖到其中的 Applications 快捷方式，推出磁盘映像后从应用程序启动；也可将 ZIP 解压到稳定、可写的用户应用目录。DMG 内运行及 App Translocation 路径不适合原地升级，客户端会在下载前要求更换安装位置。Windows ZIP 应解压到当前用户可写的稳定目录再运行 `portal-desktop.exe`，不要直接在压缩包预览里启动。

### Windows 安装包的明确边界

客户端已处理 Squirrel 安装、更新和卸载事件，由安装程序创建或移除快捷方式；这些短进程不会启动 Portal。Windows Setup 升级及后台任务仍需实机验收。

macOS 签发与 [Portal 源仓](https://github.com/d5z/heart-portal/blob/main/scripts/package-portal-macos.py) 保持一致：使用 `Developer ID Application: D5 Inc. (7N8XHQWCNN)`、固定标识、Hardened Runtime 和安全时间戳。客户端及 Electron Helpers/Frameworks 由同一证书签名；客户端标识为 `town.beings.portal-desktop`，内置 Portal 保留源仓的 `com.aspect.heart-portal`。签名身份和标识记录在 `desktop/macos-signing.json`，升级时保持稳定。

内置 Portal 直接复用锁定子模块的 `scripts/package-portal-macos.py` 签发并验证，之后才生成 `runtime-bundle.json`。应用签名阶段保留该二进制的签名，确保发布清单描述最终包内字节。`package` / `make` 默认要求该 Developer ID 的证书和私钥位于当前钥匙串；可用 `PORTAL_DESKTOP_MAC_KEYCHAIN` 指定专用钥匙串路径。证书缺失、时间戳或签名验证失败会终止出包，不自动降级。

DMG 完成后由同一 Developer ID 签名并添加安全时间戳，标识为 `town.beings.portal-desktop.dmg`；其内部应用保持原签名。`test:macos-package` 实际挂载只读 DMG，检查 Applications 快捷方式、复制安装后的签名，以及 DMG 与 ZIP 的应用一致性。

与源仓当前策略一致，公证暂缓，不自动提交 Apple 公证请求；签名通过不代表已通过新 Mac 的 Gatekeeper 下载安装验收。Windows Authenticode 尚未配置。

```bash
npm run make
npm run test:macos-package
```

完整升级验收使用 `npm run test:macos-upgrade`，需要已登录图形会话的 Mac、上述签发证书及实际签名 DMG 和 ZIP。先退出日常客户端；测试会拒绝并行启动另一份客户端。自定义构建输出目录时，同时为构建和测试设置 `PORTAL_DESKTOP_PACKAGE_OUT`。测试基线、配置保留及自动启动范围见 [UPDATING.md](UPDATING.md#验证)。

GitHub 发布任务使用与 Portal 源仓同名的 `APPLE_CERTIFICATE_BASE64` 和 `APPLE_CERTIFICATE_PASSWORD` Secrets，在临时钥匙串导入证书，并在结束时清理。仓库之间的 Secrets 不会自动共享；维护者需在客户端仓库单独配置这两个 Secret。不要将私钥、P12 或密码提交到源码。

没有发布证书的贡献者可显式使用 `PORTAL_DESKTOP_MAC_LOCAL_TEST=1 npm run package` 构建仅供本地测试的 ad hoc 应用。PR CI 使用这种模式，不发布分发包；版本 tag 禁止该模式，正式安装器也拒绝这种签名。

安装器在停止旧服务前验证版本、架构、Portal 摘要及两者的 Developer ID、固定标识、Hardened Runtime 和安全时间戳。临时转移目录（App Translocation）或不可写安装位置会提示先将应用移到稳定目录。

## 网络与常见失败

如果 Electron 下载失败，可在当前终端临时设置镜像后重试原先失败的 `npm ci` 或构建命令；镜像只影响 Electron 下载，npm registry 和 Cargo 仍使用各自配置。

macOS / Linux：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm ci
npm run make
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm ci
npm run make
```

| 问题 | 处理 |
| --- | --- |
| `Portal source missing from heart-portal/` | 恢复仓库中的 `heart-portal/` 源码目录，或设置 `HEART_PORTAL_SOURCE` |
| `Portal binary missing` | 先完成 `npm run build:portal`；聊天开发模式可缺少引擎，package/make 不允许缺少内置引擎 |
| `cargo` / `link.exe` 找不到 | 安装 Rust 和目标系统链接工具，重开终端确认 PATH；Windows 使用 MSVC 工具链 |
| 构建成功但引擎启动失败 / 架构错误 | 用同平台、同架构 Node 和 Rust 重新构建，勿复用另一台机器的 `resources/` 二进制 |
| Windows 构建无法覆盖文件 | 先退出正在运行的 `out/` 客户端，再构建；后台 Portal 运行于独立目录，不需要批量结束 Portal 进程 |
| 客户端提示系统加密不可用 | 在已登录桌面会话和可用系统密钥库下运行；Linux 不支持明文凭据降级 |
| 改了源码但打开仍是旧 UI | 重新 make 后完全退出旧进程，再启动新 `.app` / exe；仅替换磁盘文件不会更新内存中的旧进程 |

不要把真实 Being 链接、Town token、个人 Portal 配置或 Kit 密钥写进源码、构建参数、提交或分发包。

## 升级、重启与卸载

客户端设置位于 Electron 的用户数据目录（通常 macOS 为 `~/Library/Application Support/portal-desktop`，Windows 为 `%APPDATA%\portal-desktop`，Linux 为 `$XDG_CONFIG_HOME/portal-desktop` 或 `~/.config/portal-desktop`）。`PORTAL_DESKTOP_USER_DATA` 会覆盖该目录，仅用于隔离开发/测试 profile。

客户端采用手动安装新版本、首次启动自动同步 Portal 与守护的配套升级方式。先结束本机任务并保存草稿，退出旧客户端并安装新版，再重新打开。配置、Kits、凭据和工作目录保留；配套升级完成后启动 Portal，没有版本变化的普通启动尊重停止状态，失败回滚恢复升级前状态。详细范围、发布和恢复流程见 [UPDATING.md](UPDATING.md)。

卸载前若不再需要本机能力，在「本机 Portal」点击「停止」，确认后台常驻和登录自启已停用，再移除客户端。删除客户端安装目录本身不会卸载后台服务，也不会删除用户配置或 Kit 凭据。由客户端识别并沿用的服务同样需要先停用；不要按进程名批量杀死其他 Portal。

## 验证与 CI

静态类型检查：`npm run typecheck`。完整测试及覆盖边界见 [TESTING.md](TESTING.md)。`npm run test:all` 会构建 package，但本地不会顺带生成 make 分发包；发布前还需执行 `npm run make`。

Push / PR 的 GitHub Actions 在 macOS 和 Windows 运行测试并上传测试报告（保存 14 天）。只有版本 tag 触发分发包构建和 Release 发布；其中 Mac DMG 和 ZIP 必须共同通过 `test:macos-package`。托管 runner 跳过真实登录服务测试；可通过手动 `native_background` job 使用专用已登录 Mac runner。Windows 原生后台任务、睡眠唤醒以及其他平台仍需实机验收。

每次交付记录客户端 commit、桌面版本、Portal commit、平台/架构和验证范围。更新桌面版本使用 `npm version <新版本> --no-git-tag-version` 同步 `package.json` / lockfile，然后重新构建；不要只改原网页的 `VERSION`。依赖风险应以交付时重新执行的 `npm audit` 为准，README 中的历史构建记录不代表永久无漏洞。
