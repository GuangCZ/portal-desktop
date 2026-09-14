import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const psQuote = value => `'${value.replaceAll("'", "''")}'`;
export async function powershell(script) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60_000 });
  return stdout.trim();
}

// /D isolates the actual installed files. NSIS still writes known-folder
// shortcuts, installer cache and HKCU metadata, regardless of LOCALAPPDATA.
export async function isolateWindowsInstallation(root) {
  if (process.platform !== 'win32') throw new Error('Windows installation test only.');
  const { guid } = JSON.parse(await readFile(new URL('../../desktop/windows-installer.json', import.meta.url), 'utf8'));
  const keys = [`HKCU:\\Software\\${guid}`, `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`];
  const metadata = JSON.parse(await powershell(`
    $keys=@(${keys.map(psQuote).join(',')});
    foreach ($key in $keys) { if (Test-Path -LiteralPath $key) { throw 'A daily NSIS installation exists; use a separate Windows test account.' } }
    @{desktop=[Environment]::GetFolderPath('Desktop'); programs=[Environment]::GetFolderPath('Programs'); local=[Environment]::GetFolderPath('LocalApplicationData')} | ConvertTo-Json -Compress
  `));
  const files = [];
  for (const file of [path.join(metadata.desktop, 'Portal Desktop.lnk'), path.join(metadata.programs, 'Portal Desktop.lnk'),
    path.join(metadata.local, 'portal-desktop-updater', 'installer.exe')]) {
    const bytes = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    files.push({ file, bytes });
  }
  const installedRoot = path.join(root, '安装目录', 'Portal Desktop');
  await writeFile(path.join(root, 'installation-metadata.json'), JSON.stringify({ keys, installedRoot,
    files: files.map(s => ({ file: s.file, base64: s.bytes?.toString('base64') ?? null })) }));
  return {
    environment: { ...process.env }, installedRoot,
    async restore() {
      await powershell(`
        $location=(Get-ItemProperty -LiteralPath ${psQuote(keys[0])} -ErrorAction SilentlyContinue).InstallLocation;
        if ($location -and $location -ne ${psQuote(installedRoot)}) { throw 'Installation metadata changed outside this test; recovery snapshot retained.' }
        foreach ($key in @(${keys.map(psQuote).join(',')})) { if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key } }
      `);
      for (const { file, bytes } of files) {
        if (bytes) await writeFile(file, bytes);
        else await rm(file, { force: true });
      }
    },
  };
}
