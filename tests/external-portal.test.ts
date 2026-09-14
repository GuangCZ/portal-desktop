import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalPortalObserver } from '../desktop/main/portal/external';
import { parseConnection } from '../desktop/main/chat/connection';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(['connection.url', '.portal-connection.url'])('observes a matching runtime using %s without claiming ownership or observing itself', async credentialFile => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'portal-observer-'))); roots.push(root);
  const connection = parseConnection('https://example.org/fixture/?token=observer-test');
  await writeFile(path.join(root, 'heart-portal'), 'fixture');
  await writeFile(path.join(root, credentialFile), connection.link);
  await writeFile(path.join(root, '.portal-status-nonce'), 'fixture-nonce');
  await writeFile(path.join(root, '.portal-connection-status.json'), JSON.stringify({ pid: 1234, nonce: 'fixture-nonce', state: 'connected' }));
  const observer = new ExternalPortalObserver(async () => `1234 ${process.getuid?.() ?? 0} ${path.join(root, 'heart-portal')}`, 'darwin');
  // Windows does not supply getuid; this observer is macOS-only.
  if (!process.getuid) return;
  expect(await observer.read(connection)).toMatchObject({ phase: 'connected', managed: false, pid: 1234, runtimePath: root });
  expect(await observer.read(connection, root)).toBeNull();
  expect(await observer.read(parseConnection('https://example.org/another/?token=observer-test'))).toBeNull();
  expect(await observer.read(parseConnection('https://example.org/fixture/?token=other-token'))).toMatchObject({ managed: false, pid: 1234 });
  expect(await readFile(path.join(root, credentialFile), 'utf8')).toBe(connection.link);
});
