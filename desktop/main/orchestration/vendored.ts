// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Small pure helpers this unit depends on whose owning modules belong to other migration units:
//   sanitizeText      <- src/services.cjs   (Portal services unit)
//   desktopEnvironment<- src/platform.cjs   (platform unit)
//   consoleEnvironment<- src/desktop-console.cjs (DesktopTerminal unit)
//   WINDOWS_RUNNER    <- src/desktop-console.cjs (DesktopTerminal unit)
// Copied line by line so this unit is testable on its own; the integration phase should re-point
// the three call sites at the canonical ports instead of keeping two copies.

import path from 'node:path';

/** src/services.cjs `sanitizeText`. */
export function sanitizeText(value: unknown, secrets: readonly unknown[] = []): string {
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (match) => {
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return '[redacted URL]'; }
  });
  text = text
    .replace(/\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:[^\r\n]*/gi, '[redacted header]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|credential)[\w-]*|api[_-]?key|key|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?\b/g, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .replace(/\b[a-zA-Z0-9_+/=-]{48,}\b/g, '[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return text.slice(0, 2000);
}

/** src/platform.cjs `desktopEnvironment`. */
export function desktopEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (platform !== 'darwin') return env;
  const dirs = (env.PATH || '').split(':').filter((value) => path.posix.isAbsolute(value) && !/[\0\r\n]/.test(value));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  if (env.HOME && path.posix.isAbsolute(env.HOME) && !/[\0\r\n]/.test(env.HOME)) {
    dirs.push(path.posix.join(env.HOME, '.local/bin'), path.posix.join(env.HOME, '.cargo/bin'));
  }
  env.PATH = [...new Set(dirs)].join(':');
  return env;
}

/** src/desktop-console.cjs `ENVIRONMENT_KEYS`. */
const ENVIRONMENT_KEYS = new Set([
  'tmpdir', 'lang', 'lc_all', 'lc_ctype', 'user', 'logname', 'shell',
  'systemroot', 'windir', 'systemdrive', 'comspec', 'pathext', 'path',
  'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata',
  'temp', 'tmp', 'username', 'userdomain', 'computername', 'os',
  'number_of_processors', 'processor_architecture', 'processor_identifier',
  'processor_level', 'processor_revision', 'programfiles', 'programfiles(x86)',
  'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)',
  'commonprogramw6432', 'allusersprofile', 'public', 'psmodulepath',
]);

/** src/desktop-console.cjs `consoleEnvironment`. */
export function consoleEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (ENVIRONMENT_KEYS.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')) result[key] = value;
  }
  return result;
}

/** src/desktop-console.cjs `WINDOWS_RUNNER` (copied byte for byte; `String.raw` keeps every backslash literal). */
// The shell owns this non-inheritable handle. Windows closes it when the shell
// exits or Node terminates its process handle, killing only that job's tree.
// Command text travels through stdin, never through a shell-quoted argument.
export const WINDOWS_RUNNER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BeingConsoleJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic;
    public Counters Counters;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr ownedJob;
  public static void Enter() {
    ownedJob = CreateJobObject(IntPtr.Zero, null);
    if (ownedJob == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    Extended info = new Extended();
    info.Basic.Flags = 0x2000;
    int size = Marshal.SizeOf(typeof(Extended));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, memory, false);
      if (!SetInformationJobObject(ownedJob, 9, memory, (uint)size))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(memory); }
    if (!AssignProcessToJobObject(ownedJob, GetCurrentProcess()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
  [BeingConsoleJob]::Enter()
  $commandText = [Console]::In.ReadToEnd()
} catch {
  [Console]::Error.WriteLine('[Being Console] Unable to initialize the owned command process: ' + $_.Exception.Message)
  exit 125
}
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0
try {
  & ([ScriptBlock]::Create($commandText))
  $commandSucceeded = $?
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  if (-not $commandSucceeded) { exit 1 }
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}
`;
