import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalPortalObserver } from '../desktop/main/portal/external';
import { parseConnection } from '../desktop/main/chat/connection';
import { BackgroundPortal, type Command } from '../desktop/main/portal/background';

it('ignores the Windows bootstrap PID and verifies its supervised child before takeover', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'town-external-'));
  try {
    const binary = path.join(root, 'heart-portal.exe'), config = path.join(root, 'original.toml');
    const connection = parseConnection('https://example.org/test/?token=fixture');
    await writeFile(binary, 'fixture'); await writeFile(config, 'name="fixture"');
    await writeFile(path.join(root, '.portal-launch.json'), JSON.stringify({ arguments: ['--config', config, '--name', 'fixture'], working_directory: root, environment: { PORTAL_CONNECT_LINK: connection.link } }));
    let listings = 0;
    const run: Command = async (_file, args) => {
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      if (script.includes('GetOwnerSid')) {
        expect(script).toContain("FullyQualifiedErrorId -notmatch '^HRESULT 0x80041002,'");
        return JSON.stringify(++listings === 1 ? [{ pid: 11, binary }] : [{ pid: 11, binary }, { pid: 22, binary }]);
      }
      return JSON.stringify({ ready: true, supervised: true, pid: 22 });
    };
    const services = await new ExternalPortalObserver(run, 'win32').forUpgrade(connection, 'fixture');
    expect(listings).toBe(2); expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ configPath: config, name: 'fixture', root: await realpath(root) });
    await rm(config);
    expect(await new ExternalPortalObserver(run, 'win32').forUpgrade(connection, 'fixture')).toHaveLength(1);
    await writeFile(path.join(root, '.portal-launch.json'), JSON.stringify({ arguments: [], working_directory: root, environment: { PORTAL_CONNECT_LINK: connection.link } }));
    expect(await new ExternalPortalObserver(run, 'win32').forUpgrade(connection, 'fixture')).toMatchObject([{ configPath: undefined, name: '' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('waits for the macOS engine PID after launchd has removed its registration', async () => {
  let registered = true, reads = 0;
  const run: Command = async (file, args) => {
    if (file === '/bin/ps') return ++reads < 4 ? 'Thu Sep 10 2026 /fixture/heart-portal' : '';
    if (args[0] === 'bootout') registered = false;
    if (args[0] === 'print') { if (!registered) throw new Error('gone'); return 'state = running\npid = 123'; }
    return '';
  };
  const background = new BackgroundPortal(path.join(os.tmpdir(), 'fixture-profile'), run, 'darwin');
  await background.unload({ label: 'fixture', root: '/fixture', file: '/fixture.plist', existing: false });
  expect(registered).toBe(false); expect(reads).toBe(4);
});
