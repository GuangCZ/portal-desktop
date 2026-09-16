// The channels the Feishu/WeChat channel, the Town catalogue and the composer
// draft add to the bridge; 2026-09-16 (integration unit I7).
//
// The four `beings:channel-*` methods are「Town 包络」: BeingDesktop lists all four
// in its `townMethods` set (src/main.cjs line 125 and line 130), so a failure
// arrives as data and is turned back into an Error that still carries its `code`.
// The renderer branches on one of them — `AUTH_REQUIRED` from `inspect` means
//「Desktop 暂无权限直接读取渠道状态」rather than「未绑定」(renderer/town-app.js
// line 1027) — and a code cannot survive an Error crossing IPC.
//
// The other four are NOT enveloped, and neither are they in BeingDesktop's set:
// `getTownCatalog`, `openTownPage` and the three `prepare*Draft` methods all throw
// plain Errors with no code, and the shell's own IPC wrapper already reduces a
// throw to one short, redacted, displayable sentence (desktop/main/app/ipc.ts →
// `publicErrorMessage`). The draft refusals are exactly that: short sentences the
// user acts on.
import { ipcRenderer } from 'electron';
import { subscribe } from './bridge';
import type { ChannelAPI, ChannelDraftPush, ChannelWorkerState } from '../../shared/desktop-types';

// ── WHY THIS FILE DOES NOT REBUILD THE ERROR, AND ./town.ts DOES ──────────────
//
// `./bridge.ts`'s `enveloped` and `./town.ts`'s `townEnveloped` both turn the
// main process's `{__townError, code, message}` back into an Error carrying
// `code`, and throw it. MEASURED on the packaged client on 2026-09-16
// (docs/migration/i7-channel-drafts.md「冒烟结果」): that `code` never arrives.
// `contextBridge` copies an Error out of the preload's isolated world by message
// and stack alone — in the renderer, `Object.getOwnPropertyNames(error)` is
// exactly `['stack', 'message']`. The same measurement on a Town channel
// (`beings:town-bonfire`) and a conversation channel (`beings:chat-view`) gives
// the same answer, so this is the shell's boundary and not this unit's mistake.
//
// So these four RESOLVE with the envelope and the renderer reconstitutes it on
// its own side, where nothing is copied and the property survives. The main
// process is unchanged; only the half that rebuilds the Error moved across the
// bridge. The other five channels here throw as usual: their failures are one
// short sentence with no code, which `message` carries perfectly well.
export const channel: ChannelAPI = {
  state: () => ipcRenderer.invoke('beings:channel-status'),
  begin: request => ipcRenderer.invoke('beings:channel-begin', request),
  check: request => ipcRenderer.invoke('beings:channel-check', request),
  inspect: request => ipcRenderer.invoke('beings:channel-inspect', request),
  feishu: value => ipcRenderer.invoke('beings:channel-feishu', value),
  catalog: () => ipcRenderer.invoke('beings:town-catalog'),
  openPage: id => ipcRenderer.invoke('beings:town-page', id),
  draft: request => ipcRenderer.invoke('beings:town-draft', request),
  onState: callback => subscribe<ChannelWorkerState>('beings:channel-state', callback),
  onDraft: callback => subscribe<ChannelDraftPush>('beings:composer-draft', callback),
  draftResult: (id, ack) => ipcRenderer.invoke('beings:composer-draft-ack', id, ack),
};
