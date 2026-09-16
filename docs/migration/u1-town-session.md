# 迁移单元 u1：Town 会话与线协议（P2a）

来源：BeingDesktop 0.8.26 工作树 `/Users/d5c/Documents/ChatGPT/BeingDesktop`
目标：portal-desktop `desktop/main/town/session/*.ts` + `tests/town-session-*.test.ts`
移植日期：2026-09-16
分支：`u1-town-session`（基线 d5z/portal-desktop main @ 4921932）

移植模块清单：
- src/town-client.cjs -> desktop/main/town/session/client.ts
- src/town-session.cjs -> desktop/main/town/session/session.ts
- src/town-wire.cjs -> desktop/main/town/session/wire.ts
- src/town-library-contract.cjs -> desktop/main/town/session/library-contract.ts
- （新增）desktop/main/town/session/types.ts

---

## 阅读摘要

（每读完一个文件立刻追加）

---

## 进度

| 模块 | 状态 |
| --- | --- |
| wire.ts | 未开始 |
| library-contract.ts | 未开始 |
| client.ts | 未开始 |
| session.ts | 未开始 |
| types.ts | 未开始 |
