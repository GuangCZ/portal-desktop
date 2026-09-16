// The channels the native conversation layer adds to the bridge; 2026-09-16.
// Moved here from desktop-channels.ts by the I0 seam stage, unchanged.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are `being:`
// — see MIGRATION.md). The two subscriptions mirror docs/interfaces.md §1.3:
// `chat-event` carries one event of a conversation's stream, `chat-state` a new
// session snapshot.
import { ipcRenderer } from 'electron';
import { enveloped, subscribe } from './bridge';
import type { ChatAPI, ChatDetailEvent, ChatEventPayload, ChatState } from '../../shared/desktop-types';

export const chat: ChatAPI = {
  sessions: () => ipcRenderer.invoke('beings:chat-sessions'),
  view: sessionId => enveloped('beings:chat-view', sessionId),
  send: request => enveloped('beings:chat-send', request),
  stop: input => enveloped('beings:chat-stop', input),
  reload: () => enveloped('beings:chat-reload'),
  changeSession: sessionId => ipcRenderer.invoke('beings:chat-change-session', sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke('beings:chat-rename-session', sessionId, title),
  forgetSession: sessionId => enveloped('beings:chat-forget-session', sessionId),
  composerData: input => ipcRenderer.invoke('beings:chat-composer-data', input),
  openWorkerResult: input => ipcRenderer.invoke('beings:chat-worker-result', input),
  // The five card channels are「Town 包络」in BeingDesktop (src/main.cjs line
  // 126), so they come back through the same envelope the conversation channels
  // use: it is the only way `BUSY`, `SESSION_CHANGED` and `INVALID_REQUEST` reach
  // the card that has to explain itself.
  detailOpen: input => enveloped('beings:chat-detail-open', input),
  detailView: sessionId => enveloped('beings:chat-detail-view', sessionId),
  detailSend: input => enveloped('beings:chat-detail-send', input),
  detailStop: sessionId => enveloped('beings:chat-detail-stop', sessionId),
  detailClose: sessionId => enveloped('beings:chat-detail-close', sessionId),
  onEvent: callback => subscribe<ChatEventPayload>('beings:chat-event', callback),
  onState: callback => subscribe<ChatState>('beings:chat-state', callback),
  onDetailEvent: callback => subscribe<ChatDetailEvent>('beings:chat-detail-event', callback),
};
