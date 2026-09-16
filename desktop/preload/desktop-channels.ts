// The channels the Being Desktop chat layer adds to the bridge; 2026-09-16.
// Kept apart from preload.ts so that file needs one import line and one spread
// rather than growing a block per subsystem.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are `being:`
// — see MIGRATION.md). The two subscriptions mirror docs/interfaces.md §1.3:
// `chat-event` carries one event of a conversation's stream, `chat-state` a new
// session snapshot.
import { ipcRenderer } from 'electron';
import type { ChatAPI, ChatEventPayload, ChatState } from '../shared/desktop-types';

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export const chat: ChatAPI = {
  sessions: () => ipcRenderer.invoke('beings:chat-sessions'),
  view: sessionId => ipcRenderer.invoke('beings:chat-view', sessionId),
  send: request => ipcRenderer.invoke('beings:chat-send', request),
  stop: input => ipcRenderer.invoke('beings:chat-stop', input),
  reload: () => ipcRenderer.invoke('beings:chat-reload'),
  changeSession: sessionId => ipcRenderer.invoke('beings:chat-change-session', sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke('beings:chat-rename-session', sessionId, title),
  forgetSession: sessionId => ipcRenderer.invoke('beings:chat-forget-session', sessionId),
  composerData: () => ipcRenderer.invoke('beings:chat-composer-data'),
  onEvent: callback => subscribe<ChatEventPayload>('beings:chat-event', callback),
  onState: callback => subscribe<ChatState>('beings:chat-state', callback),
};
