import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackgroundPortal, command, windowsModulePath } from '../desktop/main/portal/background';
import { parseConnection } from '../desktop/main/chat/connection';

it.skipIf(process.env.PORTAL_DESKTOP_NATIVE_UPGRADE_TESTS !== '1' || process.platform !== 'win32')('protects credentials and registers an interactive Windows task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'town-windows-registration-'));
  const background = new BackgroundPortal(path.join(root, 'profile'));
  try {
    await background.enable({ endpoint: '', being: '', hasToken: true, portalName: 'fixture', portalBinary: process.execPath,
      workspace: root, autoStart: false, backgroundEnabled: true, allowExec: false, kitsEnabled: false },
    parseConnection('http://127.0.0.1:1/fixture/?token=registration-fixture'));
    expect(background.state.installed).toBe(true);
    expect(background.state.enabled).toBe(true);
    const encrypted = await readFile(path.join(background.installedService!.root, 'connection.dpapi'), 'utf8');
    expect(encrypted).not.toContain('registration-fixture');
    expect(encrypted.length).toBeGreaterThan(40);
  } catch (error) {
    console.error('Native Windows/macOS operation failed:', error);
    throw error;
  } finally {
    await background.disable();
    const script = windowsModulePath + `$task=Get-ScheduledTask | Where-Object TaskName -eq '${background.label}'; if ($task) { $task | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop }; exit 0`;
    await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    await rm(root, { recursive: true, force: true });
  }
}, 70_000);

it.skipIf(process.env.PORTAL_DESKTOP_NATIVE_UPGRADE_TESTS !== '1' || process.platform !== 'darwin')('stops a real launchd conflict retry and restarts the same registered job after correction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-native-recovery-'));
  const background = new BackgroundPortal(path.join(root, 'profile'));
  const binary = path.join(root, 'fixture-engine');
  const settings = { endpoint: '', being: '', hasToken: true, portalName: 'recovery-fixture', portalBinary: binary,
    workspace: root, autoStart: false, backgroundEnabled: true, allowExec: false, kitsEnabled: false };
  const connection = parseConnection('http://127.0.0.1:1/fixture/?token=recovery-fixture');
  await writeFile(binary, '#!/bin/sh\nprintf x >> attempts\nprintf "another Portal instance is already running for this relay/Being\\n" >&2\nexit 1\n', { mode: 0o700 });
  try {
    await background.enable(settings, connection);
    const service = background.installedService!;
    await vi.waitFor(async () => expect(await readFile(path.join(service.root, '.portal-start-failure'), 'utf8')).toBe('conflict'), { timeout: 12_000, interval: 250 });
    await vi.waitFor(async () => expect(await background.portalState()).toMatchObject({ phase: 'error' }), { timeout: 4000, interval: 250 });
    const status = () => command('/bin/launchctl', ['print', `gui/${process.getuid!()}/${background.label}`]);
    expect(await status()).toContain('last exit code = 0');
    // PathState may dispatch one final guard invocation when the marker is
    // created. It must never relaunch the engine or keep dispatching afterward.
    await new Promise(resolve => setTimeout(resolve, 5500));
    const stopped = await status();
    await new Promise(resolve => setTimeout(resolve, 5500));
    expect((await status()).match(/\bruns = (\d+)/)?.[1]).toBe(stopped.match(/\bruns = (\d+)/)?.[1]);
    expect(await readFile(path.join(root, 'attempts'), 'utf8')).toBe('x');
    // The native portal_restart tool exits successfully. Recovery must still
    // run after exit 0; SuccessfulExit=false alone would break that contract.
    await writeFile(path.join(service.root, 'heart-portal'), '#!/bin/sh\nprintf x >> restarts\nif [ "$(wc -c < restarts | tr -d " ")" = "1" ]; then exit 0; fi\nexec /bin/sleep 60\n', { mode: 0o700 });
    await background.enable(settings, connection);
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'restarts'), 'utf8')).toBe('xx'), { timeout: 10_000, interval: 250 });
    await vi.waitFor(async () => expect((await background.refresh()).running).toBe(true), { timeout: 6000, interval: 250 });
    expect(background.installedService!.root).toBe(service.root);
    expect((await background.portalState()).phase).toBe('starting');
    await expect(readFile(path.join(service.root, '.portal-start-failure'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await background.disable();
    if (background.installedService) await rm(background.installedService.file, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
