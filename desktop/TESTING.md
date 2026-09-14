# 自动化测试

## 一条命令运行

克隆仓库并安装依赖后执行 `npm run test:all`。需要已安装的 Rust toolchain，仓库内 `heart-portal/` 源码以及操作系统的桌面会话和可用密钥库。使用 `HEART_PORTAL_SOURCE` 可指定其他引擎源码目录。第一次构建会下载 Electron 和 Rust 依赖。

`npm run test:all -- --reuse-package` 使用已有客户端包，仍会执行 Rust 原生测试及所有适用的 E2E。源码改变后应执行默认命令重新构建，避免测试旧包。`PORTAL_DESKTOP_EXECUTABLE` 可指定被测客户端的可执行文件。

## 覆盖与边界

| 测试层 | 自动验证内容 | 命令 |
| --- | --- | --- |
| 类型检查 | 桌面 IPC、设置、渲染器与后台服务的类型契约 | `npm run typecheck` |
| 私信名称与小镇入口 | 真实 React/导航组件，本地 fixture：隐藏 ID、精确回复地址、横向入口展开/收起、键盘、窄屏、草稿保留 | `npm run test:town-names` |
| Seed Garden / 弹窗切换 | 公开阅读、筛选、派生关系、经验墙、卷轴一致的链接栏；弹窗内切换、每次刷新、旧响应隔离、窄屏深色排版 | `npm run test:seed-garden` |
| SBS 状态同步 | 真实 Loom 与桌面桥接、本地配置接口；刷新重新读取、慢响应、外部修改、切换失败、旧响应隔离与重试恢复 | `npm run test:sbs-refresh` |
| Town SDK 协议界面 | 模拟配对、真实 SSE hello、三类消息 via 标记、发送身份及自身私信拦截；不向真实 Town 写入 | `npm run test:town-sdk` |
| 客户端生命周期 | 关闭隐藏、菜单/再次启动恢复原窗口、明确退出；未连接 Being 时操作客户端自启开关（系统登录项 API 使用 fixture，不修改用户登录项） | `npm run test:client-lifecycle` |
| Portal 窗口生命周期 | 关闭窗口后仍能调用真实 Portal、恢复原窗口、网络重连不重启引擎、明确停止 | `npm run test:portal-e2e` |
| 客户端单元测试 | 凭据隔离、代理路由、流式请求、Portal 守护、配置失败回滚、Town 认证和 Kit 导入边界 | `npm test` |
| Rust 原生测试 | 配置解析、单实例锁、Relay 握手与退避、进程管理、路径边界、命令策略、Kit 工具及重启协议 | 在 Portal 源码目录执行 `cargo test --locked -p heart-portal -- --test-threads=1` |
| 桌面集成 | 实际 Electron 安装包、本地 HTTP/WebSocket 模拟 Being、真实 Rust Portal、附件与 SSE、文件写入、stdio Kit、模型设置、主题、草稿保留、对话刻度索引/搜索、过程区停止按钮和配置重载 | `npm run test:e2e` |
| 原生后台服务 | 实际 macOS LaunchAgent，关闭客户端后工具调用、SIGKILL 恢复、无界面启动登录项、附着和停用持久化 | 已包含在 macOS 桌面集成中 |
| Town 界面 | 模拟 HTTPS 数据通过真实 IPC/代理，验证篝火、收发件箱、认证、正文净化、分页、Kit 参数及实际导入 | `npm run test:town-ui` |
| macOS 安装包 | DMG 只读挂载、Applications 快捷方式、复制安装后的完整签名、DMG/ZIP 一致性及 ZIP 安装前检查，不启动客户端窗口 | `npm run test:macos-package` |
| macOS 客户端升级 | 从 DMG 安装并全新启动签名包，在独立 profile 中从较低版本测试基线经 Release 请求、ZIP 下载、替换和 LaunchServices 启动新版；保留原配置、工作文件和工具能力，确认运行随包 Portal 且没有重复客户端 | `npm run test:macos-upgrade` |

本地模拟 Being 能稳定复现协议及客户端行为，不代表真实云端当前可用，也不测试 LLM 回复质量或真实 Town token 的授权情况。登录项测试通过卸载/重新加载临时注册项模拟启动过程，不会重启或注销电脑。睡眠唤醒和 Windows 计划任务全生命周期仍需目标机器补充验收。Windows 专用 Rust 测试在 Mac 上按引擎声明跳过。

`test:town-names` 使用无头 Chrome，不打开日常客户端；默认需要本机安装 Google Chrome，也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium。截图写入 `test-results/town-names.png` 和 `test-results/chat-places-*.png`。

`test:seed-garden` 使用相同的无头 Chrome 配置，在本地 fixture 中验证真实组件，截图为 `test-results/seed-garden.png` 与 `test-results/seed-garden-narrow.png`。`tests/seeds.test.ts` 随 `npm test` 检查固定公开路由、筛选参数编码、凭据隔离、深链接和过期详情响应。

`test:sbs-refresh` 会先生成最新 Loom 资源，再用无头 Chrome 加载本地 HTTP fixture。使用真实顶部刷新按钮和 SBS 开关，只读写模拟配置，不连接真实 Being。与其他 Chrome fixture 一样，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器路径。

## CI 接入

`.github/workflows/desktop-tests.yml` 在分支 push、pull request 和手动运行时执行 macOS/Windows 矩阵，构建并运行客户端和引擎测试，上传测试报告。普通 CI 的 macOS 包仅使用显式本地测试签名，不作为分发包。正式签名、安装包检查和发布由版本 tag 触发的 `.github/workflows/release.yml` 执行；完整图形升级测试需在具备发布证书的已登录 Mac 上单独运行。Portal 源码由客户端仓库的子模块引用锁定。

托管 runner 设置 `PORTAL_DESKTOP_TEST_BACKGROUND=0`，报告中显示 **SKIPPED**；普通 Portal 子进程、真实 Relay/工具调用及 Rust 测试仍执行。不能把这个结果当成登录自启验收。

若需要 CI 自动验收真实 macOS 后台服务，准备专用测试 Mac，在已登录图形会话的用户下运行 GitHub runner，并添加 `beings-test` 标签。手动运行 workflow 时勾选 `native_background`，会额外执行原生后台服务 job。不要把未经信任的分支放到日常办公机器上的自托管 runner 执行。该 runner 尚未由本项目自动配置，工作流配置本身不代表云端已经运行成功。

## 报告与隔离

- `test-results/summary.md`：阶段结果、耗时、平台和后台测试是否适用。
- `test-results/summary.json`：适合其他 CI 系统读取的结构化结果；失败退出码为 1。
- `test-results/unit.xml`：客户端单元测试的 JUnit 报告。
- `test-results/*.log`：各阶段原始日志，包含 Rust 实际通过/忽略计数。
- `test-results/*.png`：界面截图，桌面失败时保存 `failure.png`，Town 失败时保存 `town-failure.png`。
- `test-results/town-trace.zip`：通过 `npx playwright show-trace test-results/town-trace.zip` 回放 Town 操作。

测试使用随机临时 profile、独立工作和 Kit 目录、模拟 token、本地随机端口。真实后台测试注册名按临时 profile 生成；正常结束、断言失败以及 SIGINT/SIGTERM 时清理自己的 macOS 登录项，不停止用户原有服务。强制杀死测试进程（SIGKILL）或主机断电无法执行 finally 清理；可按测试临时 profile 对应的 `portal-service.json` 定位残留登录项，不能按通用 Portal 进程名批量终止。

`npm run test:browser`：打包客户端中以本地 HTTP fixture 验证内置网页、导航历史、新窗口链接、弹窗层级、独立登录会话、无本机 API 和关闭清理。不会访问真实 Being 或发消息。

`tests/portal-takeover.test.ts` 验证确认顺序、取消后的持久暂停、确认期间配置变化、旧守护拒绝停止、新启动失败和中断后的手动恢复。`tests/portal-discovery.test.ts` 验证旧客户端守护、token 轮换、原名称识别及无关服务排除。`PORTAL_DESKTOP_NATIVE_UPGRADE_TESTS=1 npx vitest run tests/portal-takeover-native.test.ts` 使用临时 profile 和本机测试 Being，验证真实 macOS LaunchAgent 的取消、确认接管、旧守护停用、新名称以及无关 Being 保持运行，不启动 Electron 测试窗口。

桌面 E2E 统一通过 `tests/support/electron-lifecycle.mjs` 启动：同一时间仅允许一个测试实例，单个测试设 5 分钟上限，退出等待最多 8 秒；超时仅清理该次 launch 返回的子进程。原生桌面 E2E 会显示窗口，不在日常使用客户端时自动运行。浏览器生命周期单元测试使用替身验证销毁窗口后不再访问 shell。

macOS 安装包与完整升级测试需要实际 Developer ID 签名包，签发条件见 [BUILDING.md](BUILDING.md)。完整升级测试会打开真实客户端窗口，运行前需退出日常客户端；它使用签名包构造较低版本基线，不代表覆盖所有历史发布版本。签名和升级通过也不代表 Apple 公证或首次下载的 Gatekeeper 检查通过，详见 [UPDATING.md](UPDATING.md#验证)。

## React 迁移回归

`tests/renderer-state.test.ts` 随 `npm test` 运行，覆盖组件重挂载时 IPC 订阅清理、旧启动请求失效、
连接表单异步默认值、Town 页面与身份切换、重复发送拦截、断线核对不替换阅读内容、精确身份
筛选及私密引用的跨身份限制。组件的键盘、焦点、菜单动画、原生弹窗、配对、引用草稿、
Markdown、分页、安装和浏览器隔离由现有 Electron `test:town-sdk`、`test:town-ui`、
`test:browser` 和 `test:e2e` 使用新构建的包验证。
