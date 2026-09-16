// The orchestration layer's IPC surface; 2026-09-16. Channel semantics ported
// from BeingDesktop 0.8.26 src/main.cjs lines 1118-1134 (`getOrchestration`,
// `inspectAgents`, `getWorker`, `cancelWorker`, `retryWorkerCallback`,
// `reconnectWorkers`, `saveOrchestration`) and docs/interfaces.md §1.2「编排模式」
// / §1.3「主进程 → 渲染层推送」.
//
// Registration follows chat/ipc.ts: every channel goes through the `handle`
// wrapper main.ts supplies, so it inherits the trusted-sender check and the
// quitting guard, and the one mutation BeingDesktop serializes —
// `saveOrchestration` (src/main.cjs line 143) — goes through the same `exclusive`
// queue. None of these are「Town 包络」channels in 0.8.26, so a failure throws and
// arrives as a redacted message; nothing here branches on a code.
//
// Arguments are untrusted. `paths` in particular is a record the renderer builds
// from four text inputs, and it reaches `detectAgents`, which spawns whatever it
// names: it is checked here for prototype, key set and value type before the
// manager ever sees it, and `normalizeMode` then applies 0.8.26's own filtering.

import { normalizeMode } from './agent-kits';
import type { Orchestration, OrchestrationSnapshot } from './orchestration';
import type { OrchestrationPolicy } from './orchestration-policy';
import type { AgentRecord, WorkerRecord } from './types';
import type { OrchestrationLinkSnapshot } from '../../shared/orchestration-types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface OrchestrationIpcOptions {
  handle: RegisterHandler;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  orchestration: Orchestration;
  policy: OrchestrationPolicy;
  /** Persist the accepted mode. Called from inside `Orchestration.configure`,
   * which rolls its own state back if this throws. */
  persist: (mode: OrchestrationSnapshot['mode']) => Promise<void>;
  /** Drop the tool bridge and connect it again, answering with its snapshot.
   * Supplied by the tool-bridge subsystem through the registry, so orchestration
   * keeps working — refusing these two channels — when it is not installed. */
  reconnectBridge: () => Promise<OrchestrationLinkSnapshot>;
}

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** The four adapters 0.8.26 ships (src/agent-kits.cjs `AGENTS`). A path for
 * anything else is refused rather than dropped: it means the renderer and this
 * build disagree about which adapters exist. */
const AGENT_IDS = ['codex', 'claude', 'cursor', 'grok'];
/** Long enough for any real absolute path; short enough that the record cannot be
 * used to push a megabyte through the channel. */
const MAX_PATH = 4096;

function agentPaths(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!plain(value)) throw invalid('程序路径参数无效。');
  const paths: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    if (!AGENT_IDS.includes(key)) throw invalid('程序路径参数无效。');
    const path = value[key];
    if (typeof path !== 'string' || path.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(path)) throw invalid('程序路径参数无效。');
    paths[key] = path;
  }
  return paths;
}

/** The mode the settings page sends. Unknown fields are refused, `enabled` must
 * be a boolean and `defaultAgent` one of the four; everything else
 * `normalizeMode` decides (it lowercases, trims and drops unknown adapters). */
function modeInput(value: unknown): { enabled: boolean; defaultAgent?: string; paths: Record<string, string> } {
  if (!plain(value)) throw invalid('编排设置无效。');
  for (const key of Object.keys(value)) if (!['enabled', 'defaultAgent', 'paths'].includes(key)) throw invalid('编排设置无效。');
  if (typeof value.enabled !== 'boolean') throw invalid('编排设置无效。');
  if (value.defaultAgent !== undefined && (typeof value.defaultAgent !== 'string' || !AGENT_IDS.includes(value.defaultAgent))) throw invalid('编排设置无效。');
  return { enabled: value.enabled, defaultAgent: value.defaultAgent as string | undefined, paths: agentPaths(value.paths) };
}

const MAX_ID = 128;
function workerId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ID) throw invalid('请选择有效的 Worker。');
  return value;
}

export function registerOrchestrationIpc({ handle, exclusive, orchestration, policy, persist, reconnectBridge }: OrchestrationIpcOptions) {
  handle('beings:orchestration', (): OrchestrationSnapshot => orchestration.snapshot());

  // `normalizeMode({paths})` rather than the raw record: 0.8.26 passes the
  // normalized paths so a detection run uses exactly the values a save would
  // (src/main.cjs line 1119).
  handle('beings:orchestration-inspect', (paths: unknown): Promise<AgentRecord[]> =>
    orchestration.inspect(normalizeMode({ paths: agentPaths(paths) }).paths));

  handle('beings:worker', (id: unknown): WorkerRecord => orchestration.get(workerId(id)));

  handle('beings:worker-cancel', (id: unknown): Promise<WorkerRecord> => orchestration.stop(workerId(id)));

  handle('beings:worker-retry', (id: unknown): Promise<WorkerRecord> => orchestration.callbacks.retry(workerId(id)));

  handle('beings:workers-reconnect', (): Promise<OrchestrationLinkSnapshot> => reconnectBridge());

  // BeingDesktop src/main.cjs lines 1124-1134, in order. `configure` owns the
  // refusals (a running worker, no ready adapter) and rolls back if `persist`
  // fails; a failure still re-syncs the policy so the settings page is told why
  // the switch did not take. The bridge is dropped and re-established afterwards
  // because the tool scope it advertises depends on the mode.
  handle('beings:orchestration-save', (value: unknown): Promise<OrchestrationSnapshot> => exclusive(async () => {
    const next = modeInput(value);
    await orchestration.configure(next, async mode => {
      await policy.configure(mode.enabled);
      await persist(mode);
    }).catch(async error => { await policy.syncBridge(); throw error; });
    await reconnectBridge().catch(() => {
      // The bridge is the tool-bridge subsystem's; a reconnect that fails is
      // reported by `syncBridge` below as a policy status, not as a failed save —
      // the mode is already persisted at this point.
    });
    await policy.syncBridge();
    return orchestration.snapshot();
  }));
}

/** The two pushes, given the sender. Kept beside the handlers so the channel
 * names live in one file. `beings:workers` carries `Orchestration.snapshot()`,
 * already coalesced to one per 50ms by the manager itself. */
export interface OrchestrationPushTarget { send(channel: string, payload: unknown): void }

export function orchestrationPush(target: () => OrchestrationPushTarget | null) {
  return {
    workers: (snapshot: OrchestrationSnapshot) => { target()?.send('beings:workers', snapshot); },
    featureTasks: (payload: { tasks: unknown[]; persistenceError?: boolean }) => { target()?.send('beings:feature-tasks', payload); },
  };
}
