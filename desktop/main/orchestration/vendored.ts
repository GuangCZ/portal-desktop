// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Small pure helpers this unit depends on whose owning modules belong to other migration units:
//   sanitizeText      <- src/services.cjs   (Portal services unit)
//   desktopEnvironment<- src/platform.cjs   (platform unit)
//   consoleEnvironment<- src/desktop-console.cjs (DesktopTerminal unit)
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
