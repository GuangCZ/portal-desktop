import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { windowsEnvironment, windowsExecutable } from '../portal/windows';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { command, windowsModulePath } from '../portal/background';
import { macInstallLocation, validateMacApp } from './mac-package';
import { profileOverride } from '../app/profile';
import windowsInstaller from '../../windows-installer.json';
import type { UpdateActivity } from '../../shared/types';

interface StageOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Omit<UpdateActivity, 'version'>) => void;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const ps = (s: string) => `'${s.replaceAll("'", "''")}'`;
export function assetName(version: string, platform = process.platform, arch = process.arch) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效的更新版本。');
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `portal-desktop-${version}-macos-${arch}.zip`;
  if (platform === 'win32' && arch === 'x64') return `portal-desktop-${version}-windows-x64-Setup.exe`;
  throw new Error('当前平台没有配套安装包，请查看发布页。');
}
export async function downloadUpdateFile(url: string, file: string, max: number, fetcher: typeof fetch,
  onProgress?: (received: number, total?: number) => void, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15 * 60_000);
  const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
  lifetime.throwIfAborted();
  onProgress?.(0);
  const response = await fetcher(url, { signal: lifetime });
  if (!response.ok || !response.body) throw new Error('安装包下载失败，原服务未停止。');
  const reader = response.body.getReader(), handle = await open(file, 'wx', 0o600), hash = createHash('sha256');
  const length = Number(response.headers.get('content-length'));
  const total = Number.isSafeInteger(length) && length > 0 && length <= max ? length : undefined;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  lifetime.addEventListener('abort', cancel, { once: true });
  let size = 0;
  try {
    lifetime.throwIfAborted();
    onProgress?.(0, total);
    while (true) {
      const next = await reader.read(); lifetime.throwIfAborted(); if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new Error('安装包超出大小限制。');
      hash.update(next.value); await handle.writeFile(next.value);
      onProgress?.(size, total);
    }
  } finally { lifetime.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); await handle.close(); }
  return hash.digest('hex');
}
export function checksumFor(text: string, name: string) {
  const matches = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})  (.+)$/.exec(line)).filter(m => m?.[2] === name);
  if (matches.length !== 1) throw new Error('发布包校验清单缺失或重复。');
  return matches[0]![1];
}
export function macInstallerScript(parentPid: number, current: string, candidate: string, backup: string, profile?: string) {
  // The relaunched build may be either the old or the new one, so hand over the
  // profile under the name both understand (see app/profile.ts profileOverride).
  const launch = `/usr/bin/open${profile ? ` --env ${quote(`PORTAL_DESKTOP_USER_DATA=${profile}`)}` : ''} -n ${quote(current)}`;
  return `#!/bin/sh
set -eu
count=0
while kill -0 ${parentPid} 2>/dev/null; do
  count=$((count + 1)); [ "$count" -lt 120 ] || exit 1; sleep 1
done
if /bin/mv ${quote(current)} ${quote(backup)}; then
  if /bin/mv ${quote(candidate)} ${quote(current)} && ${launch}; then exit 0; fi
  # Keep a failed candidate for diagnosis; restore the old app on launch failure.
  [ ! -e ${quote(current)} ] || /bin/mv ${quote(current)} ${quote(candidate + '.failed')}
  /bin/mv ${quote(backup)} ${quote(current)}
fi
${launch}
exit 1
`;
}
export function windowsInstallerScript(parentPid: number, setup: string, oldExecutable: string) {
  return windowsModulePath + `
$ErrorActionPreference='Stop'
Wait-Process -Id ${parentPid} -Timeout 120 -ErrorAction SilentlyContinue
if (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { exit 1 }
try {
  # Chromium children can briefly outlive the Electron main process and keep
  # native DLLs locked. Give them time to exit, then stop only processes that
  # still run from the exact client executable being replaced.
  $oldExecutable=${ps(oldExecutable)}
  $deadline=(Get-Date).AddSeconds(15)
  do {
    $remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $oldExecutable })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if ($remaining.Count -gt 0) {
    $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }
  $result=Start-Process -FilePath ${ps(setup)} -WindowStyle Normal -PassThru
  # Wait for Setup itself, not any newly launched long-lived client descendants.
  $result.WaitForExit()
  if ($result.ExitCode -ne 0) { throw 'Client installation failed' }
  $location=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\${windowsInstaller.guid}' -Name InstallLocation).InstallLocation
  $installed=Join-Path $location '${windowsInstaller.executableName}.exe'
  if (!(Test-Path -LiteralPath $installed)) { throw 'Installed client missing' }
  # NSIS starts the app normally. Also launch directly to retain an explicit
  # profile/environment for managed installations; the single-instance lock
  # ensures the standard NSIS launch never creates a second client.
  Start-Process -FilePath $installed -WindowStyle Normal
} catch {
  Start-Process -FilePath ${ps(oldExecutable)}
  throw
}
`;
}
// Everything expensive and fallible is staged before stopping Portal.
export async function stageInstaller(directory: string, version: string, repository: string, executable: string,
  fetcher: typeof fetch = fetch, options: StageOptions = {}) {
  options.signal?.throwIfAborted();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('无效的更新源。');
  const current = process.platform === 'darwin' ? await macInstallLocation(executable) : undefined;
  const name = assetName(version), root = path.join(directory, 'client-updates', randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  let stage: string | undefined;
  const discard = async () => {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  };
  try {
    const base = `https://github.com/${repository}/releases/download/v${version}/`;
    const sums = path.join(root, 'SHA256SUMS.txt'), installer = path.join(root, name);
    options.onProgress?.({ phase: 'metadata' });
    await downloadUpdateFile(base + 'SHA256SUMS.txt', sums, 64_000, fetcher, undefined, options.signal);
    const expected = checksumFor(await readFile(sums, 'utf8'), name);
    const actual = await downloadUpdateFile(base + name, installer, 1024 * 1024 * 1024, fetcher,
      (received, total) => options.onProgress?.({ phase: 'downloading', received, total }), options.signal);
    options.onProgress?.({ phase: 'verifying' });
    options.signal?.throwIfAborted();
    if (actual !== expected) throw new Error('安装包校验失败，原服务未停止。');
    options.onProgress?.({ phase: 'preparing' });
    let script: string, scriptFile: string;
    if (process.platform === 'darwin') {
      stage = path.join(path.dirname(current!), `.portal-desktop-update-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      await command('/usr/bin/ditto', ['-xk', installer, stage]);
      const apps = (await readdir(stage)).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) throw new Error('更新包内客户端结构无效。');
      const candidate = path.join(stage, apps[0]);
      await validateMacApp(candidate, version);
      script = macInstallerScript(process.pid, current!, candidate, path.join(stage, 'Previous.app'), profileOverride() ? directory : undefined);
      scriptFile = path.join(root, 'install.sh');
    } else {
      script = '\ufeff' + windowsInstallerScript(process.pid, installer, executable);
      scriptFile = path.join(root, 'install.ps1');
    }
    await writeFile(scriptFile, script, { mode: 0o700 });
    options.signal?.throwIfAborted();
    const handoff = async () => {
      if (process.platform === 'win32') {
        // DETACHED_PROCESS makes Windows PowerShell exit before executing the
        // script; an attached console can also close with the old client.
        // Start-Process gives the worker its own hidden console and returns as
        // soon as it starts, so the worker can wait for this client to exit.
        const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`;
        const launch = windowsModulePath + `$ErrorActionPreference='Stop'; Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList ${ps(args)} -RedirectStandardOutput ${ps(path.join(root, 'install.log'))} -RedirectStandardError ${ps(path.join(root, 'install-error.log'))}`;
        const log = await open(path.join(root, 'install-launch.log'), 'a', 0o600);
        const bootstrap = spawn(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')],
          { windowsHide: true, env: windowsEnvironment(process.env), stdio: ['ignore', log.fd, log.fd] });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Wait for the bootstrap's exit, not inherited pipe handles held by
          // the worker that is itself waiting for this client to exit.
          await new Promise<void>((resolve, reject) => {
            bootstrap.once('error', reject);
            bootstrap.once('exit', code => code === 0 ? resolve() : reject(new Error('无法启动客户端安装助手，请查看 install-launch.log。')));
            timer = setTimeout(() => { bootstrap.kill(); reject(new Error('启动客户端安装助手超时。')); }, 30_000);
          });
        } finally { clearTimeout(timer); await log.close(); }
        return;
      }
      const log = await open(path.join(root, 'install.log'), 'a', 0o600);
      const child = spawn('/bin/sh', [scriptFile], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      try { await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref(); }
      finally { await log.close(); }
    };
    return Object.assign(handoff, { discard });
  } catch (error) {
    await discard();
    throw error;
  }
}
