// Ported from BeingDesktop 0.8.26 src/agent-kits.cjs on 2026-09-16.
// CLI invocation and detection contracts are measured, not inferred: docs/orchestration.md
// "Agent adapters" (Codex `exec --help`/`login --help`, Claude Code 2.1.245 measured 2026-09-11).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { desktopEnvironment } from '../common/platform';
import { launchAgent } from './agent-process';
import type { AgentDefinition, AgentRecord, ExecutableFinder, LaunchAgent, OrchestrationMode, OrchestrationModeInput, ProbeResult, ProbeRunner } from './types';

// Claude Code runs with the same boundary Codex's workspace-write sandbox gives: edits and
// commands inside the workspace are accepted without prompts, while its own sandbox refuses
// writes elsewhere and outbound network (measured 2026-09-11 on 2.1.245: `touch /tmp/x` →
// "Operation not permitted", curl → "deny network-outbound"). Commands are only auto-allowed
// where that sandbox exists (macOS, Linux); elsewhere they are refused as needing approval.
const CLAUDE_SANDBOX = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
// `auth` is a login probe whose exit code alone is trusted (0 = signed in); `authHint` is what to
// tell the user when it fails.
export const AGENTS: readonly AgentDefinition[] = Object.freeze([
  {
    id: 'codex', name: 'Codex CLI', commands: ['codex'], help: ['exec', '--help'], features: ['--json', '--sandbox', '--skip-git-repo-check'], args: ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-'],
    auth: ['login', 'status'], authHint: '请先在终端完成 codex login，再重新检测。',
  },
  {
    id: 'claude', name: 'Claude Code CLI', commands: ['claude'], help: ['--help'], features: ['--output-format', '--print', '--permission-mode', '--settings'], args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--settings', CLAUDE_SANDBOX],
    auth: ['auth', 'status'], authHint: '请先在终端完成 claude auth login，再重新检测。',
  },
  { id: 'cursor', name: 'Cursor CLI', commands: ['cursor-agent', 'agent'], help: ['--help'], features: ['--output-format', '--print'], args: ['--print', '--output-format', 'stream-json'] },
  { id: 'grok', name: 'Grok Build CLI', commands: ['grok'], help: ['--help'], features: ['--output-format', '--prompt-file'], args: ['--output-format', 'streaming-json'] },
]);

export async function executable(commands: readonly string[], override = ''): Promise<string> {
  const dirs = [...new Set((desktopEnvironment().PATH || '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)).concat([
    path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin'),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
  ]))];
  const candidates = override ? [override] : dirs.flatMap((dir) => commands.flatMap((name) => (process.platform === 'win32' ? ['.exe', '.cmd', '.ps1'] : ['']).map((ext) => path.join(dir, name + ext))));
  for (const file of candidates) {
    if (!path.isAbsolute(file) || /[\0\r\n]/.test(file)) continue;
    try { if ((await fs.stat(file)).isFile()) { await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return file; } } catch { /* try the next candidate */ }
  }
  return '';
}

export async function probe(file: string, args: readonly string[], launch: LaunchAgent = launchAgent): Promise<ProbeResult> {
  let output = '', overflow = false;
  const child = launch({ file, args, cwd: os.homedir(), onData: (_stream, text) => { if (output.length + text.length > 65536) overflow = true; output = (output + text).slice(0, 65536); } });
  // Local capability probes are bounded; executing workers have no deadline.
  const timer = setTimeout(() => { void child.stop().catch(() => {}); }, 15000);
  try { const result = await child.done; return { ...result, output, overflow }; }
  finally { clearTimeout(timer); }
}

export async function detectAgents(
  paths: Record<string, string> = {},
  { find = executable, run = probe }: { find?: ExecutableFinder; run?: ProbeRunner } = {},
): Promise<AgentRecord[]> {
  return Promise.all(AGENTS.map(async (agent) => {
    const base: AgentRecord = { id: agent.id, name: agent.name, path: '', status: 'missing', detail: '未找到可执行程序。', auth: 'unknown' };
    try {
      const file = await find(agent.commands, paths[agent.id] || '');
      if (!file) return base;
      base.path = file;
      const help = await run(file, agent.help);
      if (help.code !== 0 || help.overflow || !agent.features.every((flag) => help.output.includes(flag))) return { ...base, status: 'incompatible' as const, detail: '程序无法运行或不支持所需的事件输出接口。' };
      if (agent.auth) {
        const auth = await run(file, agent.auth);
        if (auth.code !== 0) return { ...base, status: 'needs_auth' as const, auth: 'required', detail: agent.authHint };
        return { ...base, status: 'ready' as const, auth: 'configured', detail: '执行接口与本机登录状态已确认。' };
      }
      return { ...base, status: 'ready' as const, detail: '执行接口可用；登录状态将在执行时确认，沿用 CLI 权限配置。' };
    } catch { return { ...base, status: 'error' as const, detail: '检测失败，请检查程序路径。' }; }
  }));
}

export function normalizeMode(value?: OrchestrationModeInput | null): OrchestrationMode {
  const paths: Record<string, string> = {};
  for (const agent of AGENTS) if (typeof value?.paths?.[agent.id] === 'string') paths[agent.id] = (value.paths[agent.id] as string).slice(0, 4096);
  return { enabled: value?.enabled === true, defaultAgent: AGENTS.some((agent) => agent.id === value?.defaultAgent) ? value!.defaultAgent as string : 'codex', paths };
}
