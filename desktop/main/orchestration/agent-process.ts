// Ported from BeingDesktop 0.8.26 src/agent-process.cjs on 2026-09-16.
// `consoleEnvironment` and `WINDOWS_RUNNER` belong to the DesktopTerminal unit and are injected;
// the local `consoleEnvironment` copy in ./vendored keeps this module testable on its own.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { consoleEnvironment as defaultConsoleEnvironment } from './vendored';
import type { AgentChild, AgentExitResult, AgentStream, LaunchAgentOptions } from './types';

// Only CLI configuration is inherited; Desktop/Loom tokens and runtime code
// injection variables stay excluded. Never persist or put these values in prompts.
const CLI_ENVIRONMENT_KEYS = new Set([
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'codex_home',
  'xdg_config_home', 'xdg_data_home', 'xdg_cache_home',
  'openai_api_key', 'openai_base_url', 'openai_org_id', 'openai_organization', 'openai_project_id',
  'cursor_api_key', 'xai_api_key', 'grok_api_key',
  'anthropic_api_key', 'anthropic_auth_token', 'anthropic_base_url', 'claude_config_dir',
  'node_extra_ca_certs', 'ssl_cert_file', 'ssl_cert_dir', 'requests_ca_bundle',
]);

// Encode values as data, including prompts; never interpolate user text as shell code.
export const psValue = (value: string): string =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;

export function agentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  consoleEnvironment: (value: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = defaultConsoleEnvironment,
): NodeJS.ProcessEnv {
  const env = consoleEnvironment(source);
  for (const [key, value] of Object.entries(source)) {
    if (CLI_ENVIRONMENT_KEYS.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')) env[key] = value;
  }
  return env;
}

export function launchAgent({
  file, args = [], input = '', cwd, onData = () => {}, platform = process.platform,
  spawnImpl = spawn, environment = process.env,
  consoleEnvironment = defaultConsoleEnvironment, windowsRunner = '',
}: LaunchAgentOptions): AgentChild {
  const env = agentEnvironment(environment, consoleEnvironment);
  let child;
  if (platform === 'win32') {
    // The DesktopTerminal unit owns WINDOWS_RUNNER; refuse rather than launch an empty shell job.
    if (!windowsRunner) throw new Error('Windows worker 运行脚本未注入，无法启动 worker。');
    const command = `$agentExecutable = ${psValue(file)}\n$agentArguments = @(${args.map(psValue).join(',')})\n`
      + (input ? `${psValue(input)} | & $agentExecutable @agentArguments` : '& $agentExecutable @agentArguments');
    const shell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = spawnImpl(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(windowsRunner, 'utf16le').toString('base64')],
      { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', () => {});
    child.stdin!.end(command);
  } else {
    child = spawnImpl(file, [...args], { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  }
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream]!.setEncoding('utf8');
    child[stream]!.on('data', (text: string) => onData(stream as AgentStream, text));
  }
  let failed: Error | null = null, stopping = false;
  child.on('error', (error) => { failed = error; });
  const done = new Promise<AgentExitResult>((resolve) => child.once('close', (code, signal) => resolve({ code, signal, error: failed, stopped: stopping })));
  return {
    done,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return done;
      stopping = true;
      if (platform === 'win32') {
        if (!child.kill()) throw new Error('无法停止 worker，请重试。');
      } else {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      return done;
    },
  };
}
