import { it, expect } from 'vitest';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { command, windowsModulePath } from '../desktop/background';
import { windowsInstallerScript } from '../desktop/manual-installer';

it.skipIf(process.platform !== 'win32' || process.env.PORTAL_DESKTOP_NATIVE_INSTALLER_TESTS !== '1')('installs and starts the client through the standard Squirrel handoff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'town-setup-'));
  const make = path.resolve('out/make/squirrel.windows/x64');
  const setups = (await readdir(make)).filter(name => /setup\.exe$/i.test(name));
  expect(setups).toHaveLength(1);
  const localAppData = process.env.LOCALAPPDATA!;
  const installedRoot = path.join(localAppData, 'portal-desktop') + path.sep;
  const stopInstalled = windowsModulePath + `$root='${installedRoot.replaceAll("'", "''")}'; Get-CimInstance Win32_Process -Filter "Name='portal-desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 750`;
  await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(stopInstalled, 'utf16le').toString('base64')]);
  const oldExecutable = path.join(root, 'old-client.exe');
  await copyFile(process.execPath, oldExecutable);
  const old = spawn(oldExecutable, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const script = path.join(root, 'install.ps1');
  const setup = path.join(make, setups[0]);
  const environment = { ...process.env, PORTAL_DESKTOP_USER_DATA: path.join(root, 'profile') };
  await writeFile(script, '\ufeff' + windowsInstallerScript(old.pid!, setup, oldExecutable));
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let errors = ''; helper.stderr.on('data', chunk => { errors += chunk.toString(); });
  let pid: number | undefined;
  try {
    const completion = new Promise<number | null>((resolve, reject) => { helper.once('exit', resolve); helper.once('error', reject); });
    old.kill();
    expect(await completion, errors).toBe(0);
    const version = (await import('../package.json')).version;
    const executable = path.join(localAppData, 'portal-desktop', 'app-' + version, 'portal-desktop.exe');
    const inspect = windowsModulePath + `$p=Get-CimInstance Win32_Process -Filter "Name='portal-desktop.exe'" | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'", "''")}' -and $_.CommandLine -notmatch '--type=' }; @($p.ProcessId) | ConvertTo-Json -Compress`;
    const deadline = Date.now() + 30_000;
    while (!pid && Date.now() < deadline) {
      const output = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspect, 'utf16le').toString('base64')]);
      const ids = output.trim() ? JSON.parse(output) : [];
      pid = Array.isArray(ids) ? ids[0] : ids;
      if (!pid) await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(pid, 'New installed client should launch automatically').toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(() => process.kill(pid!, 0)).not.toThrow();
    const reinstall = spawn(setup, ['--silent'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let reinstallErrors = ''; reinstall.stderr.on('data', chunk => { reinstallErrors += chunk.toString(); });
    const reinstalled = new Promise<number | null>((resolve, reject) => { reinstall.once('exit', resolve); reinstall.once('error', reject); });
    expect(await reinstalled, reinstallErrors).toBe(0);
    // Squirrel Setup installs and emits its lifecycle events; it does not
    // promise to launch the application after a silent install. Starting via
    // Update.exe is the supported launcher path and may reuse the existing
    // single instance or create a new one after an obsolete event.
    const launcher = path.join(localAppData, 'portal-desktop', 'Update.exe');
    const start = spawn(launcher, ['--processStart', 'portal-desktop.exe'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let startErrors = ''; start.stderr.on('data', chunk => { startErrors += chunk.toString(); });
    const started = new Promise<number | null>((resolve, reject) => { start.once('exit', resolve); start.once('error', reject); });
    expect(await started, startErrors).toBe(0);
    pid = undefined;
    const relaunchDeadline = Date.now() + 30_000;
    while (!pid && Date.now() < relaunchDeadline) {
      const output = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspect, 'utf16le').toString('base64')]);
      const ids = output.trim() ? JSON.parse(output) : [];
      // The launcher may reuse the existing single instance or start a new
      // process after Setup retires the previous version.
      pid = Array.isArray(ids) ? ids[0] : ids;
      if (!pid) await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(pid, 'Update.exe should start the installed client after Setup completes').toBeGreaterThan(0);
  } finally {
    old.kill(); helper.kill();
    if (pid) await command('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    // taskkill can report success just before Chromium releases profile DB
    // handles on Windows. Let fs.rm retry that bounded cleanup race.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}, 180_000);
