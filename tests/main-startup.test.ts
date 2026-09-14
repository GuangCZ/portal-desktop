import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SettingsStore } from '../desktop/settings';
import { BackgroundPortal } from '../desktop/background';

const fixture = vi.hoisted(() => ({ directory: '', startup: undefined as Promise<void> | undefined }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, setName: vi.fn(), setAboutPanelOptions: vi.fn(), setPath: vi.fn(),
    getPath: () => fixture.directory, getAppPath: () => fixture.directory, getVersion: () => '0.1.6',
    requestSingleInstanceLock: () => true, quit: vi.fn(),
    whenReady: () => ({ then: (ready: () => Promise<void>) => (fixture.startup = Promise.resolve().then(ready)) }),
  });
  return { app, clipboard: {}, ipcMain: { handle: vi.fn() }, net: { fetch: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() }, nativeTheme: {}, shell: {},
    safeStorage: { isEncryptionAvailable: () => true },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  };
});
vi.mock('../desktop/tray', () => ({ installApplicationMenu: vi.fn(), createApplicationTray: () => ({ destroy: vi.fn() }) }));
vi.mock('../desktop/window-manager', () => ({ createMainWindow: vi.fn() }));

it('defers repeated launch and activation until protocol and IPC initialization, then owns one window', async () => {
  fixture.directory = await mkdtemp(path.join(os.tmpdir(), 'portal-window-startup-'));
  const { app, protocol, dialog } = await import('electron');
  const { createMainWindow } = await import('../desktop/window-manager');
  let releaseSettings!: () => void;
  const settingsGate = new Promise<void>(resolve => { releaseSettings = resolve; });
  const load = vi.spyOn(SettingsStore.prototype, 'load').mockImplementation(() => settingsGate);
  vi.spyOn(BackgroundPortal.prototype, 'discover').mockImplementation(async function (this: BackgroundPortal) { return this.state; });
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('PORTAL_DESKTOP_UPDATE_REPOSITORY', 'fixture/releases');
  const protocolReadyAtCreation: boolean[] = [];
  vi.mocked(createMainWindow).mockImplementation(options => {
    protocolReadyAtCreation.push(vi.mocked(protocol.handle).mock.calls.length > 0);
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn(), restore: vi.fn(),
      webContents: { isDestroyed: () => false, send: vi.fn() },
    });
    const browser = { close: vi.fn() };
    options.onBrowser(browser as never);
    return { window, browser } as never;
  });
  try {
    await import('../desktop/main');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    // NSIS launch plus updater fallback, or a double click during credential IO.
    app.emit('second-instance', {}, ['portal-desktop.exe']);
    app.emit('activate');
    const earlyWindows = protocolReadyAtCreation.length;
    releaseSettings();
    await fixture.startup;
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect({ earlyWindows, protocolReadyAtCreation }).toEqual({ earlyWindows: 0, protocolReadyAtCreation: [true] });
    app.emit('second-instance', {}, ['portal-desktop.exe']);
    app.emit('activate');
    expect(createMainWindow).toHaveBeenCalledOnce();
  } finally {
    releaseSettings();
    await fixture.startup;
    app.emit('before-quit', { preventDefault() {} });
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalled());
    app.removeAllListeners(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
