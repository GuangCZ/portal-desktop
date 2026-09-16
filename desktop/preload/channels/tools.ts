// The channels the desktop tool bridge adds to the bridge; 2026-09-16.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are
// `being:` — see MIGRATION.md): `getDesktopTools` → `beings:tools`,
// `desktopAction` → `beings:tools-action`, `setBrowserView` →
// `beings:tools-browser-view`, `readNativeText` → `beings:clipboard-read`, and
// the `being:tools-state` push → `beings:tools-state`.
//
// `act` is the one shape change. 0.8.26's `desktopAction(action, value)` is two
// loose positional arguments, which let a caller pair any verb with any payload;
// here the renderer passes one discriminated union and this file splits it back
// into the two arguments the main process expects. The main process validates
// both regardless — the union is a typing convenience, not a security boundary.
//
// None of the four is enveloped: they are not among BeingDesktop's `townMethods`,
// and their callers branch on nothing but success.
import { ipcRenderer } from 'electron';
import { subscribe } from './bridge';
import type {
  DesktopToolsAPI, DesktopToolsAction, DesktopToolsBrowserState,
  DesktopToolsPane, DesktopToolsState, DesktopToolsViewport,
} from '../../shared/desktop-types';

export const tools: DesktopToolsAPI = {
  state: () => ipcRenderer.invoke('beings:tools'),
  act: (input: DesktopToolsAction) =>
    ipcRenderer.invoke('beings:tools-action', input.action, 'value' in input ? input.value : undefined) as Promise<DesktopToolsState>,
  browserView: (viewport: DesktopToolsViewport) =>
    ipcRenderer.invoke('beings:tools-browser-view', viewport) as Promise<DesktopToolsBrowserState>,
  readText: () => ipcRenderer.invoke('beings:clipboard-read'),
  onState: callback => subscribe<DesktopToolsState>('beings:tools-state', callback),
  onReveal: callback => subscribe<DesktopToolsPane>('beings:tools-reveal', callback),
};
