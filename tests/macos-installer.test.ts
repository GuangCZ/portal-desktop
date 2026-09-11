import { afterEach, expect, it, vi } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { command } from '../desktop/background';
import { assetName, macInstallerScript, stageInstaller } from '../desktop/manual-installer';
import { macInstallLocation, validateMacApp } from '../desktop/mac-package';
import { digest } from '../desktop/runtime-update';

// Filesystem failure cases need no developer private key. Trust policy is
// exercised separately, and the actual release ZIP must pass the real verifier.
vi.mock('../desktop/mac-signature', () => ({ verifyMacSignature: async (file: string) => {
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', file]);
} }));

const mac = it.skipIf(process.platform !== 'darwin');
const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portal-mac-'安装-"));
  directories.push(root); return root;
}
async function appFixture(root: string, version: string) {
  const app = path.join(root, 'Portal Desktop.app'), contents = path.join(app, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(path.join(contents, 'Resources'));
  // System binaries can be arm64e; compile the same architecture as the client.
  const source = path.join(root, 'fixture.c');
  await writeFile(source, 'int main(void) { return 0; }\n');
  const executable = path.join(contents, 'MacOS/Portal Desktop');
  await command('/usr/bin/clang', ['-arch', process.arch === 'x64' ? 'x86_64' : process.arch, source, '-o', executable]);
  await rm(source);
  const engine = path.join(contents, 'Resources/heart-portal');
  await copyFile(executable, engine);
  await command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', engine]);
  await writeFile(path.join(contents, 'Resources/runtime-bundle.json'), JSON.stringify({ schema: 1, id: 'a'.repeat(64),
    clientVersion: version, portalVersion: '0.8.2', platform: process.platform, arch: process.arch, sha256: digest(await readFile(engine)) }));
  await writeFile(path.join(contents, 'Resources/app.asar'), 'fixture UI');
  const plist = path.join(contents, 'Info.plist');
  await writeFile(plist, JSON.stringify({ CFBundleIdentifier: 'town.beings.portal-desktop', CFBundleExecutable: 'Portal Desktop',
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: version }));
  await command('/usr/bin/plutil', ['-convert', 'xml1', plist]);
  await command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
  return app;
}
async function archiveFetcher(root: string, app: string, version: string, corruptDigest = false) {
  const zip = path.join(root, 'candidate.zip');
  await command('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  const data = await readFile(zip);
  const sum = `${corruptDigest ? '0'.repeat(64) : digest(data)}  ${assetName(version)}\n`;
  return (async (url: string | URL | Request) => new Response(String(url).endsWith('SHA256SUMS.txt') ? sum : data)) as typeof fetch;
}

mac('stages a signed ZIP without touching the installed app or profile; cancellation cleans temporary downloads', async () => {
  const root = await temporary(), profile = path.join(root, 'profile');
  const current = await appFixture(path.join(root, 'installed'), '0.1.3');
  const candidate = await appFixture(path.join(root, 'download'), '0.1.4');
  await mkdir(profile); await writeFile(path.join(profile, 'connection.json'), 'unchanged encrypted fixture');
  const old = await readFile(path.join(current, 'Contents/Info.plist'));
  const handoff = await stageInstaller(profile, '0.1.4', 'baiye0/Town-Client', path.join(current, 'Contents/MacOS/Portal Desktop'), await archiveFetcher(root, candidate, '0.1.4'));
  expect((await readdir(path.dirname(current))).some(name => name.startsWith('.portal-desktop-update-'))).toBe(true);
  expect(await readFile(path.join(current, 'Contents/Info.plist'))).toEqual(old);
  await handoff.discard();
  expect(await readdir(path.dirname(current))).toEqual(['Portal Desktop.app']);
  expect(await readdir(path.join(profile, 'client-updates'))).toEqual([]);
  expect(await readFile(path.join(profile, 'connection.json'), 'utf8')).toBe('unchanged encrypted fixture');
});

mac('rejects corrupt downloads, modified UI, wrong versions and missing executables before installation', async () => {
  const root = await temporary();
  const current = await appFixture(path.join(root, 'installed'), '0.1.3');
  for (const failure of ['digest', 'ui', 'version', 'executable', 'engine']) {
    const candidate = await appFixture(path.join(root, failure), failure === 'version' ? '0.1.5' : '0.1.4');
    if (failure === 'ui') await writeFile(path.join(candidate, 'Contents/Resources/app.asar'), 'modified UI');
    if (failure === 'executable') await rm(path.join(candidate, 'Contents/MacOS/Portal Desktop'));
    if (failure === 'engine') await writeFile(path.join(candidate, 'Contents/Resources/heart-portal'), 'corrupted engine');
    await expect(stageInstaller(path.join(root, 'profile'), '0.1.4', 'baiye0/Town-Client', path.join(current, 'Contents/MacOS/Portal Desktop'),
      await archiveFetcher(root, candidate, '0.1.4', failure === 'digest'))).rejects.toThrow();
    expect(await readdir(path.dirname(current))).toEqual(['Portal Desktop.app']);
    expect(await readdir(path.join(root, 'profile/client-updates'))).toEqual([]);
    await expect(validateMacApp(current, '0.1.3')).resolves.toMatchObject({ clientVersion: '0.1.3' });
  }
});

mac('rejects translocated and read-only install locations before starting a download', async () => {
  const root = await temporary();
  const translocated = await appFixture(path.join(root, 'AppTranslocation/test'), '0.1.4');
  await expect(macInstallLocation(path.join(translocated, 'Contents/MacOS/Portal Desktop'))).rejects.toThrow('应用程序');
  const current = await appFixture(path.join(root, 'read-only'), '0.1.4');
  await chmod(path.dirname(current), 0o500);
  try { await expect(macInstallLocation(path.join(current, 'Contents/MacOS/Portal Desktop'))).rejects.toThrow('不可写'); }
  finally { await chmod(path.dirname(current), 0o700); }
});

mac('waits for the old process, replaces once and restores the old app on move or launch failure', async () => {
  const root = await temporary();
  for (const scenario of ['success', 'missing-candidate', 'launch-failure', 'backup-failure']) {
    const dir = path.join(root, scenario); await mkdir(dir);
    const current = path.join(dir, "Current ' 客户端.app"), candidate = path.join(dir, 'Candidate.app');
    const backup = path.join(dir, scenario === 'backup-failure' ? 'missing/Previous.app' : 'Previous.app');
    await mkdir(current); await writeFile(path.join(current, 'version'), 'old');
    if (scenario !== 'missing-candidate') { await mkdir(candidate); await writeFile(path.join(candidate, 'version'), 'new'); }
    const launcher = path.join(dir, 'open-fixture.sh'), calls = path.join(dir, 'launches');
    await writeFile(launcher, '#!/bin/sh\nversion=$(/bin/cat "$2/version")\nprintf "%s\\n" "$version" >> "$LAUNCH_LOG"\n[ "$FAIL_NEW" != 1 ] || [ "$version" != new ]\n', { mode: 0o700 });
    const old = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const script = path.join(dir, 'install.sh');
    // Substitute only LaunchServices. The actual installer wait/move/rollback
    // commands operate on real files, without launching another Electron GUI.
    await writeFile(script, macInstallerScript(old.pid!, current, candidate, backup).replaceAll('/usr/bin/open', `'${launcher.replaceAll("'", "'\\''")}'`));
    const child = spawn('/bin/sh', [script], { env: { ...process.env, LAUNCH_LOG: calls, FAIL_NEW: scenario === 'launch-failure' ? '1' : '0' }, stdio: 'ignore' });
    const completion = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(path.join(current, 'version'), 'utf8')).toBe('old');
      old.kill();
      expect(await completion).toBe(scenario === 'success' ? 0 : 1);
      expect(await readFile(path.join(current, 'version'), 'utf8')).toBe(scenario === 'success' ? 'new' : 'old');
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(scenario === 'success' ? ['new'] : scenario === 'launch-failure' ? ['new', 'old'] : ['old']);
      if (scenario === 'success') expect(await readFile(path.join(backup, 'version'), 'utf8')).toBe('old');
    } finally { old.kill(); child.kill(); }
  }
}, 15_000);
