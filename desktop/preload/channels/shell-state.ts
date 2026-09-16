// The channels the sidebar ledger adds to the bridge; 2026-09-16.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are
// `being:` — see MIGRATION.md): `sidebarAction` → `beings:sidebar-action`.
// The subscription mirrors 0.8.26's `being:state` broadcast after a sidebar
// change (src/main.cjs line 1139), narrowed to the one section that changed.
//
// None of the three invocations is enveloped: their callers branch on nothing but
// success, so a failure arrives as a rejected promise the renderer toasts.
import { ipcRenderer } from 'electron';
import { subscribe } from './bridge';
import type { ShellSidebarAction, ShellSidebarState, ShellStateAPI } from '../../shared/desktop-types';

export const shellState: ShellStateAPI = {
  sidebar: () => ipcRenderer.invoke('beings:sidebar-state'),
  sidebarAction: (action: ShellSidebarAction) => ipcRenderer.invoke('beings:sidebar-action', action),
  addProject: (project: string) => ipcRenderer.invoke('beings:sidebar-project-add', project),
  selectProject: (project: string) => ipcRenderer.invoke('beings:select-saved-project', project),
  onSidebar: callback => subscribe<ShellSidebarState>('beings:sidebar', callback),
};
