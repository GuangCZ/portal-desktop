import { expect, it } from 'vitest';
import { UpdateChecker } from '../desktop/updates';
const release = (tag = 'v0.2.0') => ({ tag_name: tag, draft: false, prerelease: false, assets: [
  { name: `portal-desktop-${tag.slice(1)}-macos-arm64.zip` },
  { name: `portal-desktop-${tag.slice(1)}-windows-x64-Setup.exe` },
  { name: 'SHA256SUMS.txt' },
] });
it('compares semantic versions and constructs release links from the trusted repository', async () => {
  const checker = new UpdateChecker('0.1.9', 'baiye0/Town-Client', (async (url, options) => {
    expect(url).toBe('https://api.github.com/repos/baiye0/Town-Client/releases/latest');
    expect(options?.redirect).toBe('error');
    return Response.json({ ...release('v0.1.10'), html_url: 'https://evil.invalid' });
  }) as typeof fetch);
  expect(await checker.check()).toMatchObject({ phase: 'available', latestVersion: '0.1.10', releaseUrl: 'https://github.com/baiye0/Town-Client/releases/tag/v0.1.10' });
});
it('does not offer installation without exactly one matching platform package and checksum manifest', async () => {
  const metadata = release();
  for (const assets of [metadata.assets.slice(1), metadata.assets.slice(0, 2), [...metadata.assets, metadata.assets[0]], [{ name: 'source.zip' }]]) {
    const checker = new UpdateChecker('0.1.4', 'baiye0/Town-Client', (async () => Response.json({ ...metadata, assets })) as typeof fetch,
      undefined, 'darwin', 'arm64');
    expect(await checker.check()).toMatchObject({ phase: 'unavailable', latestVersion: undefined });
  }
  const intel = new UpdateChecker('0.1.4', 'baiye0/Town-Client', (async () => Response.json(metadata)) as typeof fetch, undefined, 'darwin', 'x64');
  expect((await intel.check()).message).toContain('架构');
});
it('handles private/missing releases without claiming that the installed version is current', async () => {
  const checker = new UpdateChecker('0.1.1', 'baiye0/Town-Client', (async () => new Response('', { status: 404 })) as typeof fetch);
  expect((await checker.check()).phase).toBe('unavailable');
});
it('ignores older, incomplete and prerelease releases and bounds metadata', async () => {
  for (const metadata of [release('v0.1.0'), { ...release(), assets: [] }, { ...release(), prerelease: true }, { ...release(), body: 'x'.repeat(260000) }]) {
    const checker = new UpdateChecker('0.1.1', 'baiye0/Town-Client', (async () => Response.json(metadata)) as typeof fetch);
    expect((await checker.check()).phase).toBe(metadata.tag_name === 'v0.1.0' ? 'current' : 'unavailable');
  }
});
it('coalesces overlapping manual and automatic checks', async () => {
  let resolve!: (response: Response) => void; let count = 0;
  const checker = new UpdateChecker('0.1.1', 'baiye0/Town-Client', (() => { count++; return new Promise<Response>(r => { resolve = r; }); }) as typeof fetch);
  const a = checker.check(), b = checker.check();
  resolve(Response.json(release()));
  await Promise.all([a, b]); expect(count).toBe(1);
});

it('uses the Release ZIP for in-app macOS upgrades while also distributing a DMG', async () => {
  const metadata = release();
  const dmg = { name: `portal-desktop-${metadata.tag_name.slice(1)}-macos-arm64.dmg` };
  const check = (assets: typeof metadata.assets) => new UpdateChecker('0.1.4', 'baiye0/Town-Client',
    (async () => Response.json({ ...metadata, assets })) as typeof fetch, undefined, 'darwin', 'arm64').check();
  expect((await check([...metadata.assets, dmg])).phase).toBe('available');
  expect((await check([dmg, { name: 'SHA256SUMS.txt' }])).phase).toBe('unavailable');
});
