import { describe, expect, it, vi } from 'vitest';
import { clientStartup, loginItemOptions } from '../desktop/main/app/startup';

describe('client login startup', () => {
  it('uses the stable NSIS executable and preserves legacy Squirrel launcher compatibility', () => {
    expect(loginItemOptions('win32', 'C:\\Programs\\being-desktop\\being-desktop.exe', () => true)).toEqual({ path: 'C:\\Programs\\being-desktop\\being-desktop.exe', args: [] });
    expect(loginItemOptions('win32', 'C:\\being-desktop\\app-1.2.3\\being-desktop.exe', () => true)).toEqual({ path: 'C:\\being-desktop\\being-desktop.exe', args: [] });
    expect(loginItemOptions('win32', 'C:\\Portable\\being-desktop.exe', () => true)).toEqual({ path: 'C:\\Portable\\being-desktop.exe', args: [] });
    expect(loginItemOptions('win32', 'C:\\being-desktop\\app-1.2.3\\being-desktop.exe', () => false)).toEqual({ path: 'C:\\being-desktop\\app-1.2.3\\being-desktop.exe', args: [] });
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
    expect(clientStartup(app, 'darwin', '/being-desktop').enabled).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(clientStartup(app, 'darwin', '/being-desktop', true).enabled).toBe(true);
    expect(clientStartup(app, 'darwin', '/being-desktop').enabled).toBe(true);
    expect(clientStartup(app, 'darwin', '/being-desktop', false).enabled).toBe(false);
  });
  it('reports a Windows startup approval failure instead of claiming startup is enabled', () => {
    const app = fixture();
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: false } as Electron.LoginItemSettings);
    expect(() => clientStartup(app, 'win32', 'C:\\being-desktop\\being-desktop.exe', true)).toThrow('系统未应用');
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({ path: 'C:\\being-desktop\\being-desktop.exe', args: [] });
  });
  it('rejects invalid IPC values and never registers a development or unsupported executable', () => {
    const app = fixture();
    expect(() => clientStartup(app, 'darwin', '/being-desktop', 'yes' as unknown as boolean)).toThrow('无效');
    for (const platform of ['linux', 'darwin']) {
      app.isPackaged = platform === 'linux';
      expect(clientStartup(app, platform, '/being-desktop').supported).toBe(false);
      expect(() => clientStartup(app, platform, '/being-desktop', true)).toThrow('安装后');
    }
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
