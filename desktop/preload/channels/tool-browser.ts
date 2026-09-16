// The channels the Being-operable tool browser adds to the bridge; 2026-09-16.
//
// Distinct from `beings:browser-*`, which is portal-desktop's own single-tab
// shell browser (`api.browserState` / `browserAction` / `browserBounds` on
// `DesktopAPI`). This one is `DesktopBrowser`: sixteen tabs, its own partition,
// and a Being may read and act on its pages — integration plan §5.6.
//
// Ported semantics: BeingDesktop 0.8.26 `desktopAction('browser.*')` and
// `setBrowserView` (docs/interfaces.md §1.2).
import { ipcRenderer } from 'electron';
import { subscribe } from './bridge';
import type { ToolBrowserAPI, ToolBrowserState } from '../../shared/desktop-types';

const act = (action: string, value?: unknown): Promise<ToolBrowserState> =>
  ipcRenderer.invoke('beings:tool-browser-action', action, value);

export const toolBrowser: ToolBrowserAPI = {
  state: () => ipcRenderer.invoke('beings:tool-browser'),
  newTab: value => act('new', value ?? {}),
  activateTab: id => act('activate', id),
  closeTab: id => act('close', id),
  navigate: value => act('navigate', value),
  goBack: id => act('back', id),
  goForward: id => act('forward', id),
  reload: id => act('reload', id),
  stop: id => act('stop', id),
  setViewport: value => ipcRenderer.invoke('beings:tool-browser-viewport', value),
  onState: callback => subscribe<ToolBrowserState>('beings:tool-browser-state', callback),
};
