import { expect, it } from 'vitest';
import path from 'node:path';
import { handleInstallerEvent, installerEvent, installerTarget } from '../desktop/main/updates/installer-events';
it('handles installer shortcut events without normal application startup', async () => {
  const calls: [string, string[]][] = [];
  const executable = path.resolve('install/app-0.1.1/being-desktop.exe');
  const run = async (file: string, args: string[]) => { calls.push([file, args]); return ''; };
  expect(installerEvent(['being-desktop.exe', '--squirrel-updated'])).toBe('--squirrel-updated');
  expect(installerEvent(['being-desktop.exe', '--anything'])).toBeUndefined();
  expect(installerTarget(['being-desktop.exe', '--prepare-installer=0.1.5'])).toBe('0.1.5');
  expect(installerTarget(['being-desktop.exe', '--prepare-installer=bad'])).toBeUndefined();
  expect(installerTarget()).toBeUndefined();
  await handleInstallerEvent('--squirrel-updated', executable, run);
  await handleInstallerEvent('--squirrel-uninstall', executable, run);
  await handleInstallerEvent('--squirrel-obsolete', executable, run);
  expect(calls).toEqual([
    [path.resolve('install/Update.exe'), ['--createShortcut', 'being-desktop.exe']],
    [path.resolve('install/Update.exe'), ['--removeShortcut', 'being-desktop.exe']],
  ]);
});
