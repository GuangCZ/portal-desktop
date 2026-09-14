import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { buildWindowsInstaller } from './build-windows-installer.mjs';

const out = path.resolve(process.env.PORTAL_DESKTOP_PACKAGE_OUT || 'out');
const make = path.resolve(out, 'make');
if (path.dirname(make) !== out || make === out) throw new Error('Invalid maker output directory.');
// This directory only contains generated makers; exclude stale Squirrel assets.
await rm(make, { recursive: true, force: true });
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/@electron-forge/cli/dist/electron-forge.js', process.platform === 'win32' ? 'package' : 'make'], { stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Forge exited ${code}`)));
});
if (process.platform === 'win32') await buildWindowsInstaller(path.join(out, 'Portal Desktop-win32-x64'), path.join(make, 'nsis'));
