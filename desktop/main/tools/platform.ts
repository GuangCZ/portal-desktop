// Ported line by line from BeingDesktop 0.8.26 src/platform.cjs on 2026-09-16.
// DesktopConsole (and, after integration, DesktopTerminal) resolve the local
// shell through these helpers. Kept in this unit because src/desktop-console.cjs
// imports them at module scope; if a sibling unit ports src/platform.cjs as well,
// integration should keep one copy and delete the other.
import path from 'node:path';

export interface DesktopPlatformInfo {
  platform: NodeJS.Platform | string;
  arch: string;
  name: string;
  shell: string;
  terminalSupported: boolean;
  portalSupported: boolean;
}

export function desktopPlatform(platform: NodeJS.Platform | string = process.platform, arch: string = process.arch): DesktopPlatformInfo {
  return {
    platform, arch,
    name: ({win32: 'Windows', darwin: 'macOS', linux: 'Linux'} as Record<string, string>)[platform] || platform,
    shell: platform === 'darwin' ? 'zsh' : 'PowerShell',
    terminalSupported: ['win32', 'darwin'].includes(platform),
    portalSupported: (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && ['arm64', 'x64'].includes(arch)),
  };
}

// Finder-launched applications do not inherit a terminal's Homebrew PATH.
// Add known locations without evaluating a login shell or loading shell secrets.
export function desktopEnvironment(source: Record<string, string | undefined> = process.env, platform: NodeJS.Platform | string = process.platform): Record<string, string | undefined> {
  const env = {...source};
  if (platform !== 'darwin') return env;
  const dirs = (env.PATH || '').split(':').filter(value => path.posix.isAbsolute(value) && !/[\0\r\n]/.test(value));
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  if (env.HOME && path.posix.isAbsolute(env.HOME) && !/[\0\r\n]/.test(env.HOME)) {
    dirs.push(path.posix.join(env.HOME, '.local/bin'), path.posix.join(env.HOME, '.cargo/bin'));
  }
  env.PATH = [...new Set(dirs)].join(':');
  return env;
}

export function shellPath(platform: NodeJS.Platform | string = process.platform, environment: Record<string, string | undefined> = process.env): string {
  return platform === 'darwin' ? '/bin/zsh'
    : path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
