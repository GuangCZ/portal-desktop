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
import { isTownErrorEnvelope, townErrorFromEnvelope } from '../../shared/town-desktop-errors';
import type { ChannelAPI, ChannelDraftPush, ChannelWorkerState } from '../../shared/desktop-types';

/** Identical to `townEnveloped` in ./town.ts, and deliberately a second copy of
 * three lines rather than a shared export from that file: these are two
 * integration units' channel files, and the append-only rule that keeps them from
 * colliding also keeps one from importing the other's internals. */
async function enveloped<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  if (isTownErrorEnvelope(result)) throw townErrorFromEnvelope(result);
  return result as T;
}

export const channel: ChannelAPI = {
  begin: request => enveloped('beings:channel-begin', request),
  check: request => enveloped('beings:channel-check', request),
  inspect: request => enveloped('beings:channel-inspect', request),
  feishu: value => enveloped('beings:channel-feishu', value),
  catalog: () => ipcRenderer.invoke('beings:town-catalog'),
  openPage: id => ipcRenderer.invoke('beings:town-page', id),
  draft: request => ipcRenderer.invoke('beings:town-draft', request),
  onState: callback => subscribe<ChannelWorkerState>('beings:channel-state', callback),
  onDraft: callback => subscribe<ChannelDraftPush>('beings:composer-draft', callback),
  draftResult: (id, ack) => ipcRenderer.invoke('beings:composer-draft-ack', id, ack),
};
