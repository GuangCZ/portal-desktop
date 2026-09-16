import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, PortalState } from '../shared/types';
import { desktopChannels } from './channels';
import { rebuildEnvelopesInPreload } from './channels/bridge';
import { installDecodedBridge } from './main-world';
const api: DesktopAPI = {
  platform: process.platform,
  clientStartup: enabled => ipcRenderer.invoke('beings:client-startup', enabled),
  quit: () => ipcRenderer.invoke('beings:quit'),
  browserState: () => ipcRenderer.invoke('beings:browser-state'),
  openBrowser: url => ipcRenderer.invoke('beings:browser-open', url),
  copyText: text => ipcRenderer.invoke('beings:clipboard-copy', text),
  browserAction: action => ipcRenderer.invoke('beings:browser-action', action),
  browserBounds: bounds => ipcRenderer.invoke('beings:browser-bounds', bounds),
  onBrowser: callback => {
    const listener = (_event: unknown, state: import('../shared/types').BrowserState) => callback(state);
    ipcRenderer.on('beings:browser-state', listener);
    return () => ipcRenderer.removeListener('beings:browser-state', listener);
  },
  checkUpdates: () => ipcRenderer.invoke('beings:check-updates'),
  cancelUpdate: () => ipcRenderer.invoke('beings:cancel-update'),
  updateState: () => ipcRenderer.invoke('beings:update-state'),
  onUpdate: callback => {
    const listener = (_event: unknown, state: import('../shared/types').UpdateState) => callback(state);
    ipcRenderer.on('beings:update-state', listener);
    return () => ipcRenderer.removeListener('beings:update-state', listener);
  },
  appearance: theme => ipcRenderer.invoke('beings:appearance', theme),
  town: query => ipcRenderer.invoke('beings:town', query),
  localKits: () => ipcRenderer.invoke('beings:kits'),
  deleteKit: name => ipcRenderer.invoke('beings:kit-delete', name),
  importKit: () => ipcRenderer.invoke('beings:kit-import'),
  prepareKit: id => ipcRenderer.invoke('beings:kit-prepare', id),
  installKit: input => ipcRenderer.invoke('beings:kit-install', input),
  discardKit: ticket => ipcRenderer.invoke('beings:kit-discard', ticket),
  openKits: () => ipcRenderer.invoke('beings:kits-open'),
  openTownLink: route => ipcRenderer.invoke('beings:town-open', route),
  snapshot: () => ipcRenderer.invoke('beings:snapshot'),
  save: input => ipcRenderer.invoke('beings:save', input),
  choose: kind => ipcRenderer.invoke('beings:choose', kind),
  startPortal: () => ipcRenderer.invoke('beings:portal-start'),
  connectionDefaults: input => ipcRenderer.invoke('beings:connection-defaults', input),
  stopPortal: () => ipcRenderer.invoke('beings:portal-stop'),
  openWorkspace: () => ipcRenderer.invoke('beings:workspace'),
  openLogs: () => ipcRenderer.invoke('beings:logs'),
  portalLogReference: () => ipcRenderer.invoke('beings:portal-log-reference'),
  diagnostics: () => ipcRenderer.invoke('beings:diagnostics'),
  exportDiagnostics: () => ipcRenderer.invoke('beings:diagnostics-export'),
  openLoom: () => ipcRenderer.invoke('beings:open-loom'),
  onPortal: callback => {
    const listener = (_event: unknown, state: PortalState) => callback(state);
    ipcRenderer.on('beings:portal-state', listener);
    return () => ipcRenderer.removeListener('beings:portal-state', listener);
  },
  ...desktopChannels,
};
/** Hand the page its bridge, with the error envelope decoded on ITS side.
 *
 * `contextBridge.executeInMainWorld` runs `installDecodedBridge` inside the
 * page's world and lets it define `window.beings` there, so a failing「Town 包络」
 * channel rejects with an Error the page itself built — one that still carries
 * `code`, `candidates` and `detail`. Doing it from here is not a preference: the
 * name `exposeInMainWorld` defines is `writable:false, configurable:false`, so
 * the renderer cannot wrap it afterwards, and an Error thrown from this side
 * arrives with own properties ["message","stack"] and nothing else. Both
 * measured on Electron 44.2.0 — see ./main-world.ts's header.
 *
 * The fallback is for a build without that method (electron.d.ts marks it
 * experimental). It is what 0.8.26 shipped: the envelope becomes an Error here,
 * the sentence still reaches the user, and only the code is lost. Silently
 * handing the renderer a plain object instead would print「[object Object]」
 * through `publicErrorMessage`, which is worse than the hole it replaces. */
function exposeBridge(value: DesktopAPI): void {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    try {
      contextBridge.executeInMainWorld({ func: installDecodedBridge, args: [value, 'beings'] });
      return;
    } catch {
      // Fall through: a client with no bridge at all is a client that cannot start.
    }
  }
  rebuildEnvelopesInPreload();
  contextBridge.exposeInMainWorld('beings', value);
}
if (process.isMainFrame) exposeBridge(api);
