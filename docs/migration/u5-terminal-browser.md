# 迁移单元 u5：终端与内置浏览器

来源：BeingDesktop 0.8.26（/Users/d5c/Documents/ChatGPT/BeingDesktop，只读）
目标：portal-desktop（TypeScript strict），源码 `desktop/main/tools/terminal`、`desktop/main/tools/browser`，测试 `tests/tools-terminal-*.test.ts`、`tests/tools-browser-*.test.ts`
迁移日期：2026-09-16

范围：src/desktop-terminal.cjs、src/desktop-browser.cjs 及其单元测试 test/desktop-terminal.test.cjs、test/desktop-browser.test.cjs。
不做集成（IPC / renderer / main.ts 挂钩留给后续阶段）。

---

## 阅读摘要

（每读完一个文件立刻追加）

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
