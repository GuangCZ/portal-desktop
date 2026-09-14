import path from 'node:path';
import { existsSync } from 'node:fs';
import type { App } from 'electron';
import type { ClientStartup } from '../../shared/types';

// Squirrel's stable launcher selects the current version after an upgrade.
export function loginItemOptions(platform: string, executable: string, exists = existsSync) {
  if (platform !== 'win32') return {};
  const directory = path.win32.dirname(executable);
  const launcher = path.win32.resolve(directory, '..', path.win32.basename(executable));
  const installed = /^app-/i.test(path.win32.basename(directory)) && exists(launcher);
  return { path: installed ? launcher : executable, args: [] as string[] };
}

export function clientStartup(app: Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>,
  platform: string, executable: string, enabled?: boolean): ClientStartup {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('无效的开机自启设置。');
  const supported = app.isPackaged && ['darwin', 'win32'].includes(platform);
  if (!supported) {
    if (enabled !== undefined) throw new Error('请在安装后的 macOS 或 Windows 客户端中设置开机自启。');
    return { supported: false, enabled: false, message: '安装后的 macOS 和 Windows 客户端支持开机自启。' };
  }
  const options = loginItemOptions(platform, executable);
  if (enabled !== undefined) app.setLoginItemSettings({ ...options, openAtLogin: enabled });
  const state = app.getLoginItemSettings(options);
  const active = state.openAtLogin && (platform !== 'win32' || state.executableWillLaunchAtLogin);
  if (enabled !== undefined && active !== enabled) throw new Error('系统未应用开机自启设置，请检查系统的登录项或启动应用设置。');
  return { supported: true, enabled: active, message: '开启后，登录电脑时自动打开客户端。更改立即生效。' };
}
