import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { checksumFor } from '../desktop/main/updates/manual-installer';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Publication assembles the two native CI artifacts on Linux using Python ZIP
// inspection; no Windows setup or disk image is executed by these tests.
it.skipIf(process.platform === 'win32')('requires both macOS formats and publishes each asset with its own checksum', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-release-assets-'));
  directories.push(root);
  const input = path.join(root, 'artifacts');
  const mac = path.join(input, 'portal-desktop-macos-14');
  for (const [artifact, platform, arch] of [['portal-desktop-macos-14', 'darwin', 'arm64'], ['portal-desktop-windows-latest', 'win32', 'x64']]) {
    const directory = path.join(input, artifact); await mkdir(directory, { recursive: true });
    const engine = Buffer.from('fixture ' + platform);
    const bundle = Buffer.from(JSON.stringify({ schema: 1, clientVersion: '0.1.4', platform, arch, sha256: sha(engine) }));
    await writeFile(path.join(directory, 'runtime-bundle.json'), bundle);
    await execute('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("App/resources/runtime-bundle.json",sys.argv[2])\n z.writestr("App/resources/heart-portal"+sys.argv[3],sys.argv[4])',
      path.join(directory, 'app.zip'), bundle.toString(), platform === 'win32' ? '.exe' : '', engine.toString()]);
    if (platform === 'win32') await writeFile(path.join(directory, 'App Setup.exe'), 'fixture setup');
  }
  const stage = (name: string) => execute(process.execPath, ['scripts/stage-release.mjs', input, path.join(root, name), '0.1.4']);
  await expect(stage('missing-dmg')).rejects.toThrow('macOS DMG');
  await writeFile(path.join(mac, 'App.dmg'), 'fixture signed disk image');
  await writeFile(path.join(mac, 'Duplicate.dmg'), 'duplicate');
  await expect(stage('duplicate-dmg')).rejects.toThrow('macOS DMG');
  await rm(path.join(mac, 'Duplicate.dmg'));
  await stage('release');
  const output = path.join(root, 'release');
  const files = await readdir(output);
  expect(files.sort()).toEqual(['SHA256SUMS.txt', 'portal-desktop-0.1.4-macos-arm64.dmg', 'portal-desktop-0.1.4-macos-arm64.zip',
    'portal-desktop-0.1.4-windows-x64-Setup.exe', 'portal-desktop-0.1.4-windows-x64.zip', 'runtime-bundle-macos-arm64.json', 'runtime-bundle-windows-x64.json']);
  const sums = await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  for (const name of files.filter(name => name !== 'SHA256SUMS.txt')) expect(checksumFor(sums, name)).toBe(sha(await readFile(path.join(output, name))));
  await expect(stage('release')).rejects.toThrow('must be empty');
});
