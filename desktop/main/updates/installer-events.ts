import path from 'node:path';
import { command, type Command } from '../portal/background';
const events = new Set(['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete']);
export function installerEvent(argv: string[]) { return argv.find(value => events.has(value)); }
export function installerTarget(argv: string[] = []) {
  const value = argv.find(argument => argument.startsWith('--prepare-installer='))?.slice('--prepare-installer='.length);
  return value && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}
// Squirrel invokes these short-lived processes during manual Setup upgrades.
// Do not initialize IPC, start Portal or compete with the regular profile lock.
export async function handleInstallerEvent(event: string, executable: string, run: Command = command) {
  if (!events.has(event)) throw new Error('Unknown installer event');
  if (event === '--squirrel-obsolete') return;
  const updater = path.resolve(path.dirname(executable), '..', 'Update.exe');
  await run(updater, [event === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut', path.basename(executable)]);
}
