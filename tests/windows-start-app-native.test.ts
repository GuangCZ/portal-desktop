import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getMakeNsisPath, getNsisPluginsPath } from 'app-builder-lib/out/toolsets/windows';
import { nsisTemplatesDir } from 'app-builder-lib/out/targets/nsis/nsisUtil';

// Compile and execute the real startup macro without installing or opening a
// client. The child is a silent NSIS probe that records its inherited profile.
it.skipIf(process.platform !== 'win32')('preserves profiles without a linked token and keeps elevated startup delegated to the shell', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portal-nsis 中文 ' "));
  const execute = promisify(execFile);
  const literal = (value: string) => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
  try {
    const [compiler, plugins] = await Promise.all([getMakeNsisPath(undefined), getNsisPluginsPath(undefined)]);
    const compile = async (name: string, source: string) => {
      const file = path.join(root, name + '.nsi'), executable = path.join(root, name + '.exe');
      await writeFile(file, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${literal(executable)}"\n${source}`);
      await execute(compiler.path, ['-V2', '-INPUTCHARSET', 'UTF8', file], { env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 30_000 });
      return executable;
    };
    const marker = path.join(root, 'profile.txt');
    const child = await compile('probe', `Section
      ReadEnvStr $0 PORTAL_DESKTOP_USER_DATA
      FileOpen $1 "${literal(marker)}.tmp" w
      FileWriteUTF16LE $1 $0
      FileClose $1
      Rename "${literal(marker)}.tmp" "${literal(marker)}"
    SectionEnd`);
    const includes = `!addincludedir "${literal(path.join(nsisTemplatesDir, 'include'))}"
      !addplugindir /x86-unicode "${literal(path.join(plugins, 'x86-unicode'))}"
      !include LogicLib.nsh
      !include StdUtils.nsh
      Var appExe
      !macro StartApp
      !macroend
      !include "${literal(path.resolve('scripts/windows-start-app.nsh'))}"`;
    const profile = path.join(root, '独立 profile');
    const run = (file: string) => execute(file, [], { env: { ...process.env, PORTAL_DESKTOP_USER_DATA: profile }, windowsHide: true, timeout: 20_000 });
    const observed = async () => {
      const deadline = Date.now() + 10_000;
      do {
        const value = await readFile(marker, 'utf16le').catch(() => undefined);
        if (value !== undefined) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error('NSIS startup probe did not write its profile');
    };
    // Use the real Win32 query and launch on this account (including hosted CI
    // administrators with TokenElevationTypeDefault).
    const nativeToken = path.join(root, 'token.txt');
    const native = await compile('native', `${includes}
      Section
        StrCpy $appExe "${literal(child)}"
        Call PortalGetTokenElevationType
        FileOpen $1 "${literal(nativeToken)}" w
        FileWriteUTF16LE $1 $0
        FileClose $1
        !insertmacro StartApp
      SectionEnd`);
    await run(native);
    const elevationType = await readFile(nativeToken, 'utf16le');
    expect(['1', '2', '3']).toContain(elevationType);
    const nativeProfile = await observed();
    if (elevationType !== '2') expect(nativeProfile).toBe(profile);
    await rm(marker);

    // Exercise all privilege decisions on any Windows account. Intercept the
    // shell call only; direct launches still execute the real silent child.
    const shellMarker = path.join(root, 'shell.txt');
    const branches = await compile('branches', `${includes}
      !undef StdUtils.ExecShellAsUser
      !define StdUtils.ExecShellAsUser '!insertmacro ProbeShell'
      !macro ProbeShell OUT FILE VERB ARGS
        FileOpen $1 "${literal(shellMarker)}" w
        FileWriteUTF16LE $1 "$2"
        FileClose $1
      !macroend
      Section
        StrCpy $appExe "${literal(child)}"
        ReadEnvStr $2 PORTAL_NSIS_TEST_TOKEN
        !insertmacro PortalStartAppForToken $2
      SectionEnd`);
    for (const type of [1, 3, 2, 0]) {
      await execute(branches, [], { env: { ...process.env, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_NSIS_TEST_TOKEN: String(type) }, windowsHide: true, timeout: 20_000 });
      if (type === 1 || type === 3) {
        expect(await observed(), `token type ${type}`).toBe(profile);
        expect(await readFile(shellMarker).catch(() => null)).toBeNull();
        await rm(marker);
      } else {
        expect(await readFile(shellMarker, 'utf16le')).toBe(String(type));
        expect(await readFile(marker).catch(() => null)).toBeNull();
      }
    }
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}, 120_000);
