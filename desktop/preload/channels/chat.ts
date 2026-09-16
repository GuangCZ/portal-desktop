// The channels the native conversation layer adds to the bridge; 2026-09-16.
// Moved here from desktop-channels.ts by the I0 seam stage, unchanged.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are `being:`
// — see MIGRATION.md). The two subscriptions mirror docs/interfaces.md §1.3:
// `chat-event` carries one event of a conversation's stream, `chat-state` a new
// session snapshot.
import { ipcRenderer } from 'electron';
import { enveloped, subscribe } from './bridge';
import type { ChatAPI, ChatEventPayload, ChatState } from '../../shared/desktop-types';

export const chat: ChatAPI = {
  sessions: () => ipcRenderer.invoke('beings:chat-sessions'),
  view: sessionId => enveloped('beings:chat-view', sessionId),
  send: request => enveloped('beings:chat-send', request),
  stop: input => enveloped('beings:chat-stop', input),
  reload: () => enveloped('beings:chat-reload'),
  changeSession: sessionId => ipcRenderer.invoke('beings:chat-change-session', sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke('beings:chat-rename-session', sessionId, title),
  forgetSession: sessionId => enveloped('beings:chat-forget-session', sessionId),
  composerData: () => ipcRenderer.invoke('beings:chat-composer-data'),
  onEvent: callback => subscribe<ChatEventPayload>('beings:chat-event', callback),
  onState: callback => subscribe<ChatState>('beings:chat-state', callback),
};
