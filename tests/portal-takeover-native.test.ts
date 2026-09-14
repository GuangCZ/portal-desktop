import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackgroundPortal, command } from '../desktop/background';
import { ExternalPortalObserver } from '../desktop/external-portal';
import { PortalTakeover } from '../desktop/portal-takeover';
import { RuntimeUpdater } from '../desktop/runtime-update';
import { parseConnection } from '../desktop/connection';

it.skipIf(process.env.PORTAL_DESKTOP_NATIVE_UPGRADE_TESTS !== '1' || process.platform !== 'darwin')('takes over a real old client guardian automatically and leaves unrelated Being services running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-native-takeover-'));
  const old = new BackgroundPortal(path.join(root, 'old'));
  const client = new BackgroundPortal(path.join(root, 'client'));
  const other = new BackgroundPortal(path.join(root, 'other'));
  const binary = path.resolve('resources/heart-portal');
  const settings = { endpoint: '', being: '', hasToken: true, portalName: 'previous-laptop', portalBinary: binary,
    workspace: root, autoStart: false, backgroundEnabled: true, allowExec: false, kitsEnabled: false };
  const connection = parseConnection(`http://127.0.0.1:1/${path.basename(root)}/?token=local-test`);
  const unrelated = parseConnection(`http://127.0.0.1:1/${path.basename(root)}-other/?token=local-test`);
  const observer = new ExternalPortalObserver();
  try {
    await old.enable(settings, connection); await new RuntimeUpdater(root, old).waitReady(old.installedService!);
    await other.enable({ ...settings, portalName: 'other-being' }, unrelated); await new RuntimeUpdater(root, other).waitReady(other.installedService!);
    const pid = old.state.pid!, otherPid = other.state.pid!;
    const options = {
      discover: () => observer.conflicts(connection, client.installedService?.root),
      preflight: async () => { expect((await readFile(binary)).length).toBeGreaterThan(0); },
      stop: async (target: Awaited<ReturnType<typeof observer.conflicts>>[number]) => { await client.unload(target.service!); },
    };
    const manager = new PortalTakeover(path.join(root, 'client'), options);
    const start = async (replacing: boolean) => {
      expect(replacing).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect((await old.refresh()).enabled).toBe(false);
      await client.enable({ ...settings, portalName: 'chosen-laptop' }, connection);
      await new RuntimeUpdater(root, client).waitReady(client.installedService!);
    };
    expect(await manager.run(connection, 'automatic', start)).toBe(true);
    expect((await other.refresh()).pid).toBe(otherPid);
    expect(client.state.running).toBe(true);
    expect(await readFile(client.installedService!.configPath!, 'utf8')).toContain('name = "chosen-laptop"');
    await new Promise(resolve => setTimeout(resolve, 5500));
    expect((await old.refresh()).running).toBe(false);
    expect(await observer.conflicts(connection, client.installedService!.root)).toEqual([]);
    await vi.waitFor(async () => expect((await client.refresh()).running).toBe(true));
    const disabled = await command('/bin/launchctl', ['print-disabled', `gui/${process.getuid!()}`]);
    expect(disabled).toContain(`"${old.label}" => disabled`);
  } finally {
    for (const service of [client, old, other]) {
      await service.disable();
      if (service.installedService?.file) await rm(service.installedService.file, { force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
