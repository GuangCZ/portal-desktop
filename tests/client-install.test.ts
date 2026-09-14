import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClientInstall } from '../desktop/main/updates/client-install';
import { BackgroundPortal, type Service } from '../desktop/main/portal/background';
import { parseConnection } from '../desktop/main/chat/connection';
import { assetName, checksumFor, macInstallerScript, windowsInstallerScript } from '../desktop/main/updates/manual-installer';

it('journals client launch records and never resumes independent runtimes from older install records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'town-install-'));
  const service: Service = { label: 'test', root: path.join(directory, 'engine'), file: '', existing: false };
  const external: Service = { ...service, root: path.join(directory, 'external'), kind: 'portable', existing: true, configPath: path.join(directory, 'original.toml') };
  const stopped: string[] = [], restored: string[] = [];
  const background = { label: 'test', installedService: service, refresh: async () => ({ enabled: true }),
    unload: async (s: Service) => {
      const intent = JSON.parse(await readFile(path.join(directory, 'client-install.json'), 'utf8'));
      expect(intent.services).toHaveLength(1); stopped.push(s.root);
    }, load: async (s: Service) => { restored.push(s.root); } } as unknown as BackgroundPortal;
  try {
    const installer = new ClientInstall(directory, background);
    const intent = await installer.prepare('0.1.3', '0.1.4', parseConnection('https://example.org/test/?token=fixture'), false);
    expect(stopped).toEqual([service.root]);
    intent.services.push({ service: external, enabled: true });
    await writeFile(path.join(directory, 'client-install.json'), JSON.stringify(intent));
    expect((await new ClientInstall(directory, background).read())?.services).toHaveLength(2);
    await installer.resume(intent);
    expect(restored).toEqual(stopped); expect(await installer.read()).toBeNull();
    vi.spyOn(background, 'unload').mockRejectedValue(new Error('still running'));
    await expect(installer.prepare('0.1.3', '0.1.4', null, false)).rejects.toThrow('still running');
    expect(await installer.read()).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('selects only supported assets, requires one digest and generates wait/replace/relaunch handoffs', () => {
  expect(assetName('0.1.4', 'win32', 'x64')).toBe('portal-desktop-0.1.4-windows-x64-Setup.exe');
  expect(() => assetName('../bad', 'darwin', 'arm64')).toThrow();
  expect(() => assetName('0.1.4', 'darwin', 'x64')).toThrow();
  const row = 'a'.repeat(64) + '  fixture.zip';
  expect(checksumFor(row, 'fixture.zip')).toBe('a'.repeat(64));
  expect(() => checksumFor(row + '\n' + row, 'fixture.zip')).toThrow();
  expect(() => checksumFor(row, 'other.zip')).toThrow();
  const mac = macInstallerScript(123, "/Applications/A 'B.app", '/tmp/new.app', '/tmp/old.app');
  expect(mac.indexOf('kill -0')).toBeLessThan(mac.indexOf('/bin/mv'));
  expect(mac).toContain("A '\\''B.app");
  expect(mac).toContain('/usr/bin/open -n');
  const windows = windowsInstallerScript(123, 'C:\\Setup.exe', 'C:\\old.exe');
  expect(windows.indexOf('Wait-Process')).toBeLessThan(windows.indexOf('Start-Process'));
  expect(windows).toContain("$_.ExecutablePath -eq $oldExecutable");
  expect(windows).toContain('Stop-Process -Id $_.ProcessId -Force');
  expect(windows).toContain('InstallLocation');
  expect(windows).toContain('Start-Process -FilePath $installed');
  expect(windows).not.toContain('Update.exe');
  expect(windows).not.toContain('--silent');
  expect(windows).toContain('-WindowStyle Normal -PassThru');
});
