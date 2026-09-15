import path from 'node:path';

function variable(environment: NodeJS.ProcessEnv, name: string) {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function windowsRoot(environment: NodeJS.ProcessEnv = process.env) {
  return [variable(environment, 'SystemRoot'), variable(environment, 'windir')]
    .find(value => value && /^[a-z]:[\\/]/i.test(value)) || 'C:\\Windows';
}

export function windowsExecutable(file: string, environment: NodeJS.ProcessEnv = process.env) {
  const system = path.win32.join(windowsRoot(environment), 'System32');
  if (/^powershell(?:\.exe)?$/i.test(file)) return path.win32.join(system, 'WindowsPowerShell/v1.0/powershell.exe');
  if (/^(cmd|taskkill)(?:\.exe)?$/i.test(file)) return path.win32.join(system, file.replace(/\.exe$/i, '') + '.exe');
  return file;
}

// Windows environment keys are case-insensitive, but Node sorts duplicate keys
// before spawning. Merge them ourselves so an explicit PATH cannot lose to Path.
export function windowsEnvironment(...sources: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const source of sources) for (const [key, value] of Object.entries(source)) {
    const previous = Object.keys(environment).find(name => name.toLowerCase() === key.toLowerCase());
    if (previous) delete environment[previous];
    environment[key.toLowerCase() === 'path' ? 'PATH' : key] = value;
  }
  const root = windowsRoot(environment);
  const entries = (environment.PATH || '').split(';').filter(Boolean);
  for (const directory of [path.win32.join(root, 'System32'), root,
    path.win32.join(root, 'System32/Wbem'), path.win32.join(root, 'System32/WindowsPowerShell/v1.0')]) {
    if (!entries.some(entry => path.win32.normalize(entry).toLowerCase() === directory.toLowerCase())) entries.push(directory);
  }
  environment.PATH = entries.join(';');
  if (!variable(environment, 'SystemRoot')) environment.SystemRoot = root;
  return environment;
}
