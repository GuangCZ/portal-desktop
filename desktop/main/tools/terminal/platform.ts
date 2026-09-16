// Ported line by line from BeingDesktop 0.8.26 on 2026-09-16.
// Sources: src/platform.cjs (desktopPlatform / desktopEnvironment / shellPath)
// and the consoleEnvironment helper of src/desktop-console.cjs.
// Kept inside tools/terminal so this migration unit stays self-contained; the
// integration phase should fold it into one shared module together with the
// console unit's copy. Reading digest: docs/migration/u5-terminal-browser.md.

import path from 'node:path';

export interface DesktopPlatform {
  platform: string;
  arch: string;
  name: string;
  shell: string;
  terminalSupported: boolean;
  portalSupported: boolean;
}

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function desktopPlatform(platform: string = process.platform, arch: string = process.arch): DesktopPlatform {
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
  platform: string = process.platform,
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
  platform: string = process.platform,
  environment: Record<string, string | undefined> = process.env,
): string {
  return platform === 'darwin' ? '/bin/zsh'
    : path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

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
