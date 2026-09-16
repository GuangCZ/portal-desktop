// The local machine as the main process sees it; 2026-09-16.
//
// Ported from BeingDesktop 0.8.26 src/platform.cjs (`desktopPlatform`,
// `desktopEnvironment`, `shellPath`) and src/desktop-console.cjs
// (`ENVIRONMENT_KEYS`, `consoleEnvironment`, `WINDOWS_RUNNER`).
//
// Three migration units had arrived with their own copies — `tools/platform.ts`,
// `tools/terminal/platform.ts` and `orchestration/vendored.ts`, plus the console
// helpers inlined in `tools/console.ts`. A byte comparison found every body
// identical and `WINDOWS_RUNNER` equal to the byte (2774 of them), so the copies
// are gone and this is the implementation. The types are the widest of the set:
// `NodeJS.Platform | string` so a test can pass 'freebsd', `Record<string,
// string | undefined>` so `process.env` and a literal both fit.
import path from 'node:path';

export interface DesktopPlatformInfo {
  platform: NodeJS.Platform | string;
  arch: string;
  name: string;
  shell: string;
  terminalSupported: boolean;
  portalSupported: boolean;
}

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function desktopPlatform(platform: NodeJS.Platform | string = process.platform, arch: string = process.arch): DesktopPlatformInfo {
  return {
    platform, arch,
    name: PLATFORM_NAMES[platform] || platform,
    shell: platform === 'darwin' ? 'zsh' : 'PowerShell',
    terminalSupported: ['win32', 'darwin'].includes(platform),
    portalSupported: (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && ['arm64', 'x64'].includes(arch)),
  };
}

// Finder-launched applications do not inherit a terminal's Homebrew PATH.
// Add known locations without evaluating a login shell or loading shell secrets.
export function desktopEnvironment(
  source: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform | string = process.platform,
): Record<string, string | undefined> {
  const env = { ...source };
  if (platform !== 'darwin') return env;
  const dirs = (env.PATH || '').split(':').filter(value => path.posix.isAbsolute(value) && !/[\0\r\n]/.test(value));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  if (env.HOME && path.posix.isAbsolute(env.HOME) && !/[\0\r\n]/.test(env.HOME)) {
    dirs.push(path.posix.join(env.HOME, '.local/bin'), path.posix.join(env.HOME, '.cargo/bin'));
  }
  env.PATH = [...new Set(dirs)].join(':');
  return env;
}

export function shellPath(
  platform: NodeJS.Platform | string = process.platform,
  environment: Record<string, string | undefined> = process.env,
): string {
  return platform === 'darwin' ? '/bin/zsh'
    : path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** src/desktop-console.cjs `ENVIRONMENT_KEYS`: the only variables a Desktop-owned
 * command inherits. Everything else — tokens, proxies, editor state — stays in
 * this process. */
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

export function consoleEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (ENVIRONMENT_KEYS.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')) result[key] = value;
  }
  return result;
}

/** src/desktop-console.cjs `WINDOWS_RUNNER`, byte for byte; `String.raw` keeps
 * every backslash literal. */
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
