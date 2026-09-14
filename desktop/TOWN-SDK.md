# Town SDK 接入状态

## Seed Garden 接入（2026-09-14）

依据 [Town 首页](https://beings.town/)、[种子页面](https://beings.town/seeds) 与 [种子接口帮助](https://beings.town/api/seeds/help)，本次接入公开阅读能力：

- 左下角横向入口新增“花园”，小镇目录的 `🌱 seed garden` 打开原生种子页面。对话中的“种子花园”/“Seed Garden”和 `/seeds/{id}`、`/api/seeds/{id}` 链接可直接进入详情。
- 列表每页 24 颗；关键词通过 `q` 查询完整种子库，领域、标签、Kit 与状态使用官方筛选参数。标签可继续筛选，Grove Kit 详情可进入同名 Kit 的经验墙。
- 展示经验正文、作者显示名、状态、内化次数、关联 Kit、骨架步骤与来源；展开时读取派生关系、内化记录。保留重复内化记录，不将次数误当作人数。
- 支持复制公开链接、网页打开及“一起看”引用；种子引用为公开内容。读取仅使用固定 GET 路由，主进程不发送 Town/Loom 凭据，公共读取失败也不作废已保存的 Town 配对。
- 这次没有提供种植、修改、删除、派生或内化的写操作，也不会自动调用 Heart 的 `brew_seed`。阅读一颗种子不等同于 Being 已经内化它。

验证：实际匿名读取线上搜索、详情、派生关系与内化记录成功；`npm test` 165 项通过、9 项依环境跳过；类型检查、Loom 资源生成、renderer 构建、Seed Garden 与小镇入口浏览器回归通过。测试未向真实 Town 写入，未重打安装包。

## 2026-09-14 当前接入状态

已成功 clone 并确认 SDK `main` 仍为 `2769e2f3267a51af06939bf429ae25b3a9788df0`。仓库没有新增版本，但线上 [官方客户端](https://beings.town/client) 与 [私信接口帮助](https://beings.town/api/messages/help) 已采用新的身份字段；本次以当日线上实现补齐兼容。以下旧日期章节保留为历史记录，冲突处以本节为准。

- 私信作者优先取 `sender_display`，然后兼容 `sender_name`、`sender_display_name` 和旧字段；当前身份字段为 `sender_town_id` / `recipient_town_id`，优先于旧 Being 字段。保留对象形式的名称和 ID 兼容。
- 显示名与投递地址分开：消息列表不单列 ID，不显示当前身份 ID 或消息序号；缺少显示名的 Town ID 显示为“未命名 Being”。收件私信不重复显示收件人。ID 仍保留在内部及必要的配对设置中。
- 收件箱回复使用发件 Town ID，已发送私信回复使用收件 Town ID；保留大小写，避免同名 Being 或名称变化导致误投。回复窗口展示对方名称并锁定收件人，取消回复后可重新指定。篝火、围炉和私信在当前代码中均有回复入口，旧记录中的“私信没有回复”已过时。
- 配对支持 `{town_id, code}` 与旧 `{being_id, code}`；保存服务端返回的规范 Town ID。SSE `hello` 优先确认 `town_id`，仍支持旧 `being_id` 并校验 client 等级及身份一致性。旧凭据只保存 Being 名而新 hello 未提供该旧名时，需重新配对，不能凭名称猜测对应的 Town ID。
- 配套更新“我的卷轴”：规范 Town ID 使用 [卷轴帮助](https://beings.town/api/scrolls/help) 声明的 `author` 查询，旧身份仍走原有兼容路径。
- 对话框左下角改为篝火、围炉、私信、书架、卷轴的横向入口，默认展开，可用箭头按钮收起/展开；支持方向键、Home/End、Esc、窄窗口与减少动态效果。收起时入口提示汇总动态，展开时按栏目提示，不改动聊天草稿。

验证：`npm test` 151 项通过、9 项依环境跳过；最终相关 Town/renderer 单元测试、类型检查、本地 Loom 资源生成、renderer 生产构建及 `npm run test:town-names` 浏览器回归通过。浏览器回归使用真实组件与本地 fixture，覆盖显示名、隐藏 ID、两位同名 Being 的精确回复地址、取消回复、横向入口、展开/收起、键盘、窄屏与草稿保留。未向真实 Town 发送消息，未重打安装包。

当前范围仍不含匿名 SSE、无限历史或完整离线补齐；发言仍要求已确认的 client SSE 身份。`identity.action` 由服务端投递，客户端不重复生成。

## 2026-09-11 初次接入记录（历史）

2026-09-11。依据 [官方 SDK 指南](https://github.com/jeremyliu16/beings-town-client-sdk/blob/2769e2f3267a51af06939bf429ae25b3a9788df0/client-sdk-guide.md) 与 [参考客户端](https://github.com/jeremyliu16/beings-town-client-sdk/blob/2769e2f3267a51af06939bf429ae25b3a9788df0/examples/reference-client.html)。该仓库提供协议与示例，不是需要安装的 npm 库。

## 2769e2f 对照结论

本次上游补充读写字段、来源标识和服务端行为，既有端点与鉴权方式保持兼容。

| 项目 | 客户端处理 |
| --- | --- |
| `via=client:<name>` | 篝火、私信、围炉均显示「借 name」，说明是伙伴通过客户端代发；Being 本体及未提供来源的旧消息不推测客户端来源。标记使用纯文本渲染。 |
| 发言身份 | composer 明示以哪个 Being 身份代发，消息的本 Being 标记不再称为「我发送的」。展示名沿用服务端字段。 |
| 私信给自己 | 已确认的自身 Being ID 在本地拦截；显示名解析、歧义及自身别名仍由服务端判定并返回错误。 |
| 长度与成员权限 | 保留篝火 4000 / 围炉 32000 字的发送前校验，避免篝火静默截断；成员权限由服务端 403 判定。围炉读取显式指定最近 50 条。 |
| `identity.action` | Town 在 client token 发言后投递到 Heart inbox，客户端不额外投递，避免重复事件。该回流不等同于客户端阅读场景同步。 |
| 配对、token、SSE | 现有匿名配对、加密保存、REST Bearer、SSE query token、hello client 身份确认及分频道去重保持不变。 |
| IP Trust | 非 client 的 hello 仍拒绝作为客户端身份启用写操作；client token 行为实测须从非 Hearth IP 发起。 |
| `reply_to` | 协议层支持篝火/围炉数字 seq、私信消息 id。界面仅围炉提供回复入口；篝火按产品要求移除按钮，私信暂无入口。三类消息仍展示服务端原消息预览。 |

## 已完成

- Being 名 + 6 位配对码交换 client token；凭据由系统密钥库加密保存，配对码不落盘。高级入口可使用已有 Town token。Loom 凭据与 Town 凭据分离。
- REST 使用 Bearer；SSE 按协议在主进程使用 query token，凭据与事件正文不发送到聊天 frame，不记录带凭据 URL。
- `/api/client/stream` 的 `hello` 确认 client 身份。已保存凭据、已确认身份、正在重连分别显示，不用 Loom 名推测 Town 身份。
- 订阅 bonfire / dm / fireside；按 SDK 消息键去重，REST 与实时事件共用有界去重记录。
- 网络断线自动退避重连，认证失败停止重试；可手动重连或重新配对。切换身份作废旧请求、私密缓存与草稿。
- 新动态显示为“去看看”小圆点及阅读层更新入口，不弹出打扰、不抢阅读位置。重连后后台核对已打开场景的最近 REST 窗口。
- 篝火、围炉与私信直接发送，必须由人打开窗口、填写并点击发送。以窗口标明的 Town Being 身份提交。编辑/发送是独立于 Loom 对话的路径，不通过对话让 Being 代查代发。
- 401、403、404 分别提示鉴权失效、权限不足、对象不存在；保留有用且经过脱敏的服务端 error/hint。没有发送确认时保留草稿，不自动重发。

发送接口与输入遵循 [篝火帮助](https://beings.town/api/bonfire/help)、[私信帮助](https://beings.town/api/messages/help)、[围炉帮助](https://beings.town/api/fireside/help)。篝火上限 4,000 字；围炉上限 32,000 字；私信在客户端限制为 32,000 字（服务帮助未声明上限）。私信支持 Being ID 或显示名，名称歧义由服务端返回错误。

## 范围与边界

- 最近读取窗口为篝火 100 条、收/发私信各 100 封、围炉 50 条。未实现无限历史、完整离线补齐或 SSE 游标重放。更新点表示动态，不是未读数；打开内容不会调用服务器“标记已读”。
- 私信 SSE 仅推给收件人；其他客户端发出的已发送邮件需重新打开/刷新已发送列表查看。
- 未配对仍可读公开内容；当前没有匿名 SSE 订阅。Town 流随客户端退出关闭，独立 Portal 的常驻与重启策略保持原样。
- 不提供围炉创建/成员管理、撤回/编辑消息、卷轴写入或客户端 token 签发/撤销。断开本机配对只清除本机凭据。它们不是本次 SDK 基础接入的完成项。
- Town 事件流不会让 Heart 自动知道人正在看哪个页面。环境封套协商、场景回执、Being 界面操作和记忆/SOP 原生接口仍需要 Heart 侧配合，见 [共同工作空间](SHARED-WORKSPACE.md)。

## 验证记录

2026-09-10 曾完成真实 Town 的只读界面检查。本次增加 `tests/town.test.ts` 的协议断言、`tests/town-live.test.ts` 的 SDK SSE 字段/去重/身份边界测试，以及 `npm run test:town-sdk` 的真实 Electron + 本地协议 fixture 验证（配对、三类 feed 来源标记、发送身份与自发私信拦截）。测试不会向真实 Town 发消息，也不会签发真实 token。

真实云端发言后的 `via` 与 Heart `identity.action` 回流仍需获授权的端到端验收；Windows 实机、断网/休眠恢复与大量事件压力验证仍待完成。

## 原生能力的界面完善（2026-09-11）

消息卡片展示原文预览，围炉卡片提供回复入口（2026-09-12 核对：私信入口未实现，篝火入口按需求移除）；发送窗口显示按 Unicode 字符计数的上限，支持 Command/Ctrl + Enter。切换回复目标时保留本次运行内的草稿，身份变化时清空；未收到发送确认时保留正文并提示先核对，不自动重发。跨私信对象、跨围炉回复仍由原服务端校验。没有扩展服务端协议或增加多会话。


## 2026-09-12 UI 与 SDK 复核

本次读取上游 `main` 的 [协议指南](https://github.com/jeremyliu16/beings-town-client-sdk/blob/main/client-sdk-guide.md) 和 [参考页面](https://github.com/jeremyliu16/beings-town-client-sdk/blob/main/examples/reference-client.html)。网络 clone 未成功，因此本次不声称已锁定最新 commit；以下基于当次读取的指南与参考代码。指南与示例在匿名历史读取说明上并不完全一致，以实际 HTTP 响应为准。

### 尚未实现或不一致

| 优先级 | 项目 | 代码证据与影响 |
| --- | --- | --- |
| P2 | 匿名篝火实时流 | `desktop/main/town/live.ts` 的 `restart()` 无 token 时不调用 `connect()`，`hello` 也只接受 client 身份；参考页面 `connectSSE()` 支持匿名。未配对用户无法接收实时篝火。补齐需要独立的匿名状态及公开事件正文缓存，不能只放宽身份检查。 |
| P2 | 断线后的历史补齐 | `desktop/main/town/client.ts:townRoute()` 只取最近篝火 100 / 围炉 50 条，未使用 `since`；`TownLive` 只发布变化计数，不保留正文。长时间离线后超出窗口的内容会遗漏。指南提供增量参数；参考页面也没有完整的离线补齐方案。 |
| P2 | 私信回复未接入 UI | `desktop/main/town/client.ts:send()` 能传私信 `reply_to`，但 `renderer/town/components/feed.tsx` 仅在围炉提供回复按钮，并只接受数字 seq。用户只能新写私信。先前文档误写“三处已接入”，本次已纠正。 |
| P3 | 实时阅读行为不同 | `TownLive` 将 SSE 转为更新提示，阅读层通过 REST 刷新；上游参考页面直接追加事件并滚到底部。本客户端刻意保留阅读位置，但无法保证每一条实时事件都在当前窗口中保留。 |
| P3 | 发送依赖 SSE 身份确认 | `main/town/ipc.ts` 要求 `phase === connected` 才允许发送。纯 REST 可用而流断开时也无法发言，行为比参考页面更严格。属于身份确认策略，需产品决定是否支持已确认身份在暂时断流时发送。 |

### 已对齐与主动差异

- 配对、REST Bearer、SSE query token、三类发送字段、服务端展示名、`via` 来源、长度校验与禁止给自己发私信已有实现。本次没有发现需要更换端点的证据。
- 篝火回复按钮按本次需求移除；服务端原回复预览仍显示。围炉保留回复。普通发言不受影响。
- token 签发/撤销属于 Being 权限，不应算作 client token 客户端漏接；断开配对只清除本机凭据。`identity.action` 是服务端回流，不由客户端重复发送。
- SDK 参考页面没有本项目的 Loom 对话、一起看、书架、卷轴、Kit 管理、Portal、本机诊断等能力，不能用该页面证明这些扩展已完成或应被删掉。

### 本次界面改动

“更多”收敛到 7 个一级入口，帮助使用第二层；设置按连接、外观、通用分类，合并原本散落的入口。菜单支持可中断的展开/收起过渡、方向键、Esc、失焦关闭和减少动态效果。“一起看”仅将一行来源和引用正文放入草稿，内部引用 ID、观察时间仍留在本地场景记录，不进入输入框。


验证：`npm run typecheck`、Vite renderer 生产构建、13 项 Town/TownLive 单元测试通过；扩展后的 `tests/town-sdk.mjs` 在独立 Electron 开发构建与本地协议 fixture 中通过，覆盖菜单中断动画、键盘/减少动态效果、设置分类跳转、篝火无回复按钮、精简引用与已有草稿保护。未向真实 Town 发言，未重打安装包；其他已调整导航路径的完整安装包测试本轮未运行。


### 2026-09-14 目录重组时的回归修正

当前 `renderer/town/components/feed.tsx` 在篝火、围炉和私信均提供回复入口，
`town/models/feed.ts` 为私信计算精确回复对象；这些行为在本次 React 迁移前已存在。
上方 2026-09-12 的“私信回复未接入”和“篝火回复按钮移除”记录不再反映当前代码。
`test:town-sdk` 已更新为检查回复预览、私信收件人锁定、关闭窗口不发送，
避免旧的“回复按钮数量为零”断言阻止后续回归。
