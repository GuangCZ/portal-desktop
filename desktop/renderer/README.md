# React 界面结构

整个客户端界面（含对话）由一个 React 19 root 渲染。一级目录按业务大模块划分，模块内再按
`components / models / hooks` 分类；只有实际存在对应代码时才创建目录。

```text
renderer/
├─ main.tsx                 桌面 React 入口
├─ index.html               桌面 HTML 挂载点
├─ app/                     全局布局、导航、设置及跨页面协调
│  ├─ page.tsx
│  ├─ components/           顶栏、侧栏、设置、搜索、诊断
│  ├─ models/               应用状态、跨页面工作场景
│  ├─ hooks/                对话与壳层的接线
│  └─ styles.css            桌面文档样式入口
├─ conversation/            与 Being 的对话
│  ├─ components/           时间线、活动行、引用、输入框
│  ├─ models/               时间线投影、草稿、会话列表与侧栏归类
│  └─ styles.css            对话样式入口
├─ town/                    小镇、篝火、围炉、私信、阅读及 Kit
│  ├─ page.tsx
│  ├─ components/           身份、发送、内容阅读和安装面板
│  └─ models/               Town 状态、请求协调和消息筛选
├─ settings/                侧栏账本的渲染层投影与关于 / 隐私静态页
│  ├─ components/           侧栏底部入口、关于、隐私
│  ├─ models/               侧栏账本（主进程为真值）
│  └─ styles.css            本模块自带样式入口（由 components/entry.tsx 引入）
├─ portal/page.tsx          本机 Portal 页面
├─ browser/                内置浏览器页面及 hooks/ 分栏交互
└─ shared/                 跨功能复用
   ├─ components/          弹窗、Markdown 与代码高亮
   ├─ models/              状态订阅基类、共享场景数据
   ├─ hooks/               React 状态订阅
   └─ lib/                 导航解析等纯函数
```

## 依赖与文件约定

- `page.tsx` 组合当前模块的组件；`components/` 负责 JSX 与表单，`models/` 负责
  状态和业务规则，`hooks/` 负责 React 生命周期。协议实现放 `services/`，不混入 JSX。
- 在功能模块内就近修改代码，不创建全局业务 `components / models / hooks`。
  紧密相关的小组件可以放同一文件；不为单个组件继续嵌套目录。
- `app/` 组合页面并协调跨模块动作。`shared/` 不依赖具体功能页面或业务模型。
  模型不导入组件和 hooks，避免状态依赖 UI。
- 页面只通过 preload 暴露的 `window.beings` 调用本机能力；跨进程契约在
  `desktop/shared/types.ts`。禁止 renderer 导入 `main/`、`preload/`、Electron 或 Node。
- 文件名省略目录已表达的模块前缀。使用明确的相对导入，不添加转发用 `index.ts`
  或旧路径兼容层。
- 壳层与对话各有一个样式入口，保留既有级联顺序，避免零散覆盖文件相互依赖。

## React 与对话协议

对话是壳层的一部分，随壳层一起由 Vite 编译，没有独立的 HTML 入口：`conversation/` 下
`models/` 保存时间线投影、草稿与侧栏归类，`components/` 只负责呈现。
Loom 的流式、重试、重放、watchdog 和历史对账协议都在主进程
（`desktop/main/chat/`），渲染层拿到的是已经核对过的行。

`app/hooks/use-conversation-bridge.ts` 把对话模型接进壳层的出站通道（引用草稿、⌘F 跳转、
连接状态）。渲染层不持有 Being 地址或 token，也不向 Being 发请求。沙箱
`beings://chat` 页面与它的 postMessage 桥已于 2026-09-16 删除，见根目录 MIGRATION.md。
主进程、preload 和 Rust Portal 的 API 契约独立于 React。

Markdown 和高亮 token 直接渲染为 React 元素，不使用 HTML 注入。界面内容和可见性
由 React 状态控制；DOM 引用用于焦点、滚动、选区、输入框尺寸、原生 dialog 和浏览器
位置测量。

## 验证

`npm run typecheck`、`npm test` 检查类型、状态及模块依赖边界（对话层见
`tests/conversation-model.test.ts` 与 `tests/composer.test.ts`）；
`npm run test:menu-keyboard`、`npm run test:town-names`、`npm run test:seed-garden`、
`npm run test:update-progress` 用无头 Chrome 验证真实组件之间的界面联动。
桌面检查见[测试说明](../TESTING.md)，进程划分见[桌面目录说明](../README.md)。
