import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { macInstallLocation, validateMacApp } from '../desktop/mac-package';
import { command } from '../desktop/background';
import { macDmgIdentifier, verifyMacSignature } from '../desktop/mac-signature';
import { assetName, stageInstaller } from '../desktop/manual-installer';

it.skipIf(process.platform !== 'darwin' || process.env.PORTAL_DESKTOP_MAC_PACKAGE_TESTS !== '1')(
  'installs the signed DMG and stages its matching Release ZIP without launching another client', async () => {
    const { version, productName } = JSON.parse(await readFile('package.json', 'utf8'));
    const out = path.resolve(process.env.PORTAL_DESKTOP_PACKAGE_OUT || 'out');
    const name = `${productName}-darwin-${process.arch}`;
    const packaged = path.join(out, name, `${productName}.app`);
    const bundle = await validateMacApp(packaged, version);
    const metadata = await readFile(path.join(packaged, 'Contents/Resources/runtime-bundle.json'), 'utf8');
    // The published metadata must describe the signed engine, not its pre-sign bytes.
    expect(metadata).toBe(await readFile('resources/runtime-bundle.json', 'utf8'));
    expect(bundle.clientVersion).toBe(version);
    const dmg = path.join(out, 'make', `${productName}-${version}-${process.arch}.dmg`);
    await verifyMacSignature(dmg, macDmgIdentifier);
    await command('/usr/bin/hdiutil', ['verify', dmg]);
    const archive = path.join(out, 'make/zip/darwin', process.arch, `${name}-${version}.zip`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const sums = `${hash.digest('hex')}  ${assetName(version)}\n`;
    const root = await mkdtemp(path.join(os.tmpdir(), 'portal-real-mac-package-'));
    const mount = path.join(root, 'mounted');
    let mounted = false;
    try {
      const current = path.join(root, 'Applications/Portal Desktop.app');
      await mkdir(path.dirname(current)); await mkdir(mount);
      await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
      mounted = true;
      expect(await readlink(path.join(mount, 'Applications'))).toBe('/Applications');
      const source = path.join(mount, `${productName}.app`);
      await expect(validateMacApp(source, version)).resolves.toEqual(bundle);
      await expect(macInstallLocation(path.join(source, 'Contents/MacOS/Portal Desktop'))).rejects.toThrow('不可写');
      await command('/usr/bin/ditto', [source, current]);
      await command('/usr/bin/hdiutil', ['detach', mount]); mounted = false;
      await expect(validateMacApp(current, version)).resolves.toEqual(bundle);
      for (const file of ['Info.plist', '_CodeSignature/CodeResources', 'Resources/app.asar', 'Resources/runtime-bundle.json']) {
        expect(await readFile(path.join(current, 'Contents', file))).toEqual(await readFile(path.join(packaged, 'Contents', file)));
      }
      const handoff = await stageInstaller(path.join(root, 'profile'), version, 'd5z/portal-desktop', path.join(current, 'Contents/MacOS/Portal Desktop'),
        (async (url: string | URL | Request) => new Response(String(url).endsWith('SHA256SUMS.txt') ? sums : Readable.toWeb(createReadStream(archive)) as ReadableStream)) as typeof fetch);
      const stage = (await readdir(path.dirname(current))).find(name => name.startsWith('.portal-desktop-update-'))!;
      const unpacked = path.join(path.dirname(current), stage, `${productName}.app`);
      expect(await readFile(path.join(unpacked, 'Contents/Resources/runtime-bundle.json'), 'utf8')).toBe(metadata);
      await handoff.discard();
      expect(await readdir(path.dirname(current))).toEqual(['Portal Desktop.app']);
    } finally {
      if (mounted) await command('/usr/bin/hdiutil', ['detach', mount]);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
