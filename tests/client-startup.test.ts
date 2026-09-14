import { describe, expect, it, vi } from 'vitest';
import { clientStartup, loginItemOptions } from '../desktop/main/app/startup';

describe('client login startup', () => {
  it('uses the stable NSIS executable and preserves legacy Squirrel launcher compatibility', () => {
    expect(loginItemOptions('win32', 'C:\\Programs\\portal-desktop\\portal-desktop.exe', () => true)).toEqual({ path: 'C:\\Programs\\portal-desktop\\portal-desktop.exe', args: [] });
    expect(loginItemOptions('win32', 'C:\\portal-desktop\\app-1.2.3\\portal-desktop.exe', () => true)).toEqual({ path: 'C:\\portal-desktop\\portal-desktop.exe', args: [] });
    expect(loginItemOptions('win32', 'C:\\Portable\\portal-desktop.exe', () => true)).toEqual({ path: 'C:\\Portable\\portal-desktop.exe', args: [] });
    expect(loginItemOptions('win32', 'C:\\portal-desktop\\app-1.2.3\\portal-desktop.exe', () => false)).toEqual({ path: 'C:\\portal-desktop\\app-1.2.3\\portal-desktop.exe', args: [] });
  });
  const fixture = () => {
    let enabled = false;
    return { isPackaged: true,
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled } as Electron.LoginItemSettings)),
      setLoginItemSettings: vi.fn((settings: Electron.Settings) => { enabled = settings.openAtLogin ?? false; }),
    };
  };
  it('reads system state without changing it and persists both enable and disable through the OS', () => {
    const app = fixture();
    expect(clientStartup(app, 'darwin', '/portal-desktop').enabled).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(clientStartup(app, 'darwin', '/portal-desktop', true).enabled).toBe(true);
    expect(clientStartup(app, 'darwin', '/portal-desktop').enabled).toBe(true);
    expect(clientStartup(app, 'darwin', '/portal-desktop', false).enabled).toBe(false);
  });
  it('reports a Windows startup approval failure instead of claiming startup is enabled', () => {
    const app = fixture();
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: false } as Electron.LoginItemSettings);
    expect(() => clientStartup(app, 'win32', 'C:\\portal-desktop\\portal-desktop.exe', true)).toThrow('系统未应用');
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({ path: 'C:\\portal-desktop\\portal-desktop.exe', args: [] });
  });
  it('rejects invalid IPC values and never registers a development or unsupported executable', () => {
    const app = fixture();
    expect(() => clientStartup(app, 'darwin', '/portal-desktop', 'yes' as unknown as boolean)).toThrow('无效');
    for (const platform of ['linux', 'darwin']) {
      app.isPackaged = platform === 'linux';
      expect(clientStartup(app, platform, '/portal-desktop').supported).toBe(false);
      expect(() => clientStartup(app, platform, '/portal-desktop', true)).toThrow('安装后');
    }
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
