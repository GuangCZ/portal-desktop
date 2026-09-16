// Worker orchestration and the feature-task ledger, as a subsystem; 2026-09-16.
// Assembled against BeingDesktop 0.8.26 src/main.cjs lines 114-122 (the ledger
// state), 163-176 (the manager and its callback transport), 359-362 (the policy),
// 488-520 (the per-identity histories), 674 and 691-695 (what `restore()` does at
// startup) and 1623 (the shutdown flush).
//
// The two halves are one subsystem because they are one lifecycle: both are keyed
// by the connected Being's identity, both are rebound by `connectionVerified`,
// and the feature-task runner accounts for operations the orchestration channels
// perform. BeingDesktop keeps them in the same composition root for the same
// reason.
//
// THE LAZY RULE (subsystems/types.ts): the chat layer and the tool bridge are
// reached only through `ctx.registry`, inside closures, never while installing.
// The real graph is a cycle — chat's request context needs the orchestration
// instructions, orchestration needs the bridge's capabilities, the bridge needs
// chat's sessions — so a construction-time lookup resolves to null for whichever
// half installs first. The tool bridge is also allowed to be absent entirely: its
// unit lands separately, and everything here degrades to「本机 Worker 工具尚未连接」
// rather than failing to install.

import path from 'node:path';
import { beingIdentityKey } from '../chat/connection';
import { setOrchestrationInstructions } from '../chat/frame';
import { parseConnection, sessionPartition } from '../common/loom-connection';
import { FeatureHistoryCache } from '../features/history-cache';
import { registerFeatureTasksIpc } from '../features/ipc';
import { createFeatureMethods } from '../features/methods';
import { FeatureTaskRunner } from '../features/feature-task-runner';
import type { FeatureTaskContext, PrepareFeatureTaskDraft } from '../features/types';
import { normalizeMode } from '../orchestration/agent-kits';
import { orchestrationInstructions } from '../orchestration/instructions';
import { Orchestration } from '../orchestration/orchestration';
import { OrchestrationPolicy } from '../orchestration/orchestration-policy';
import { registerOrchestrationIpc, orchestrationPush } from '../orchestration/ipc';
import { createCallbackSender, createContinuationSender } from '../orchestration/worker-callbacks';
import type { AgentRecord, BridgeCapabilities, LaunchAgent, ReportContext, WorkerRecord } from '../orchestration/types';
import { desktopPortalName, validDesktopId } from '../app/identity';
import type { OrchestrationLinkSnapshot } from '../../shared/orchestration-types';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface OrchestrationSubsystem extends DesktopSubsystem {
  /** The worker manager. The tool-bridge unit assigns its `presentation` from
   * that subsystem's `linked()` — an assignment no lazy getter can express, which
   * is why `linked()` exists (subsystems/types.ts). */
  readonly orchestration: Orchestration;
  readonly policy: OrchestrationPolicy;
  /** The feature-task accounting the Town, Portal and Channel channels share. A
   * unit registers its own channel through `methods.run(...)`; there is no
   * central list of member methods. */
  readonly methods: ReturnType<typeof createFeatureMethods>;
  readonly runner: FeatureTaskRunner;
  readonly histories: FeatureHistoryCache;
  /** Enrol one of the Being's own requests in the ledger of whoever started it
   * (BeingDesktop `registerFeatureRequest`). */
  register(record: unknown, owner?: { ledger: import('../features/types').FeatureTaskLedger; task: { id: string } } | null): void;
  /** Install the composer draft preparer. Integration plan §5.4 puts the native
   * composer in a later unit; until it calls this, `beings:feature-task-discuss`
   * refuses instead of pretending to have prepared anything. */
  setDraftPreparer(prepare: PrepareFeatureTaskDraft | null): void;
}

declare module './types' { interface SubsystemMap { 'orchestration': OrchestrationSubsystem } }

/** What this subsystem needs of the tool bridge (`DesktopTools`), declared
 * structurally because that unit lands separately. */
interface ToolsPeer {
  link?: { capabilities(): BridgeCapabilities; snapshot(): OrchestrationLinkSnapshot };
  disconnectLink?(): void;
  connectLink?(): Promise<unknown>;
}

/** Test seams. Production passes none of these; each replaces a collaborator that
 * would otherwise spawn a process or open a socket, and each is already a
 * constructor parameter of the object it belongs to, so a test drives the same
 * code production does. */
export interface OrchestrationSubsystemDeps {
  detect?: (paths: Record<string, string>) => Promise<AgentRecord[]>;
  launch?: LaunchAgent;
  /** Skip the startup detection pass (`restore()` in BeingDesktop). */
  inspectOnStart?: boolean;
}

export function installOrchestrationSubsystem(ctx: SubsystemContext, deps: OrchestrationSubsystemDeps = {}): OrchestrationSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const push = orchestrationPush(() => ({ send: ctx.push }));

  // ── Identity ────────────────────────────────────────────────────────────────
  // The same string the chat cache and the session partition use, so "the same
  // Being" means one thing across the client. Read live rather than cached: it
  // changes in the settings store, and a copy here would be one push behind.
  const address = (): string => ctx.store.connectionAddress || ctx.store.connection?.link || '';
  const identity = (): string => {
    const current = address();
    if (!current) return '';
    try { return beingIdentityKey(current); } catch { return ''; }
  };
  /** Bumped whenever the identity changes, so `discussFeatureTask` can tell "the
   * same Being re-verified" from "a different Being" (BeingDesktop's
   * `generation`). */
  let generation = 0;
  let bound = '';
  let closed = false;

  // ── The tool bridge, always through the registry ────────────────────────────
  // The tool-bridge subsystem's key is declared by its own file, which is not in
  // this worktree yet, so the registry is asked through a string. The shape is
  // the one integration plan §3.4 names — `link.capabilities()` for the policy and
  // the transport, `link.snapshot()` for the reconnect channel — and every use is
  // optional-chained: an absent bridge is a supported state, not a failure.
  const registry = ctx.registry as unknown as { get(key: string): ToolsPeer | null };
  const bridge = (): ToolsPeer | null => registry.get('tools');
  const capabilities = (): BridgeCapabilities | undefined => {
    try { return bridge()?.link?.capabilities(); }
    catch (error) { report('orchestration-bridge', error); return undefined; }
  };
  const sessions = () => ctx.registry.get('chat')?.sessions ?? null;

  // ── Manager ─────────────────────────────────────────────────────────────────
  const orchestration = new Orchestration({
    directory: path.join(ctx.userData, 'workers'),
    // BeingDesktop's `state.workspace.path` is the Desktop project directory,
    // saved here as `projectWorkspace`; `workspace` is the Portal one. Workers run
    // in the project, and fall back to the Portal directory when the profile has
    // only ever had one (settings.ts documents the pair).
    getWorkspace: () => ctx.store.settings.projectWorkspace || ctx.store.settings.workspace || '',
    // BeingDesktop unions the open chat views with the session list; this shell
    // has one conversation surface, so the session list is the whole set.
    getSessionIds: () => [...new Set(sessions()?.snapshot().sessions.map(session => session.id) ?? [])],
    getExecutionContext: () => ({ desktopId: ctx.desktopId, place: capabilities()?.place }),
    onChange: snapshot => {
      push.workers(snapshot);
      // The sidebar's per-session worker list and the conversation's result cards
      // are drawn from the session snapshot, so it has to be re-published too.
      try { sessions()?.workersChanged(); } catch (error) { report('orchestration-sessions', error); }
    },
    ...(deps.detect ? { detect: deps.detect } : {}),
    ...(deps.launch ? { launch: deps.launch } : {}),
  });

  const policy = new OrchestrationPolicy({
    getIdentity: identity,
    getDesktopId: () => ctx.desktopId,
    getBridge: () => capabilities(),
    getMode: () => orchestration.mode,
    onChange: state => { orchestration.enforcement = state; orchestration.notify(); },
    // The identity unit owns these; the policy's own defaults are a line-for-line
    // copy kept only so it can be tested alone (docs/migration/u6-orchestration.md).
    validDesktopId,
    desktopPortalName,
  });
  orchestration.assertEnforced = () => policy.assertEnforced();

  // ── Callback transport ──────────────────────────────────────────────────────
  // `getConnection` hands over the saved address, not the parsed connection: the
  // senders re-parse it themselves and compare `sessionPartition` with the owner
  // the worker was started under, which is how a completion notification is
  // refused after the user switches Beings.
  const connection = () => { const current = address(); return current ? { url: current } : null; };
  orchestration.callbacks.setTransport({
    send: createCallbackSender({ getConnection: connection, fetchImpl: ctx.electron.net.fetch, parseConnection, sessionPartition }),
    resume: createContinuationSender({
      getConnection: connection, getTarget: () => capabilities()?.place,
      fetchImpl: ctx.electron.net.fetch, parseConnection, sessionPartition,
    }),
    ready: () => !closed && Boolean(bound),
    toolsReady: () => capabilities()?.tools?.includes('desktop_worker_status') === true,
    // BeingDesktop has two delivery paths here (src/main.cjs lines 171-176): the
    // native sessions object, and `deliverWorkerReview` inside the Loom document.
    // This shell has no Loom document, so only the native one exists: the review
    // becomes visible as a result card the next time the conversation is read.
    report: async (worker: WorkerRecord, { owner, signal }: ReportContext) => {
      if (signal.aborted || identity() !== owner) throw new Error('Being identity changed');
      const current = sessions();
      if (!current?.open || current.identityKey !== owner) throw new Error('Conversation unavailable');
      if (!current.snapshot().sessions.some(item => item.id === worker.sessionId)) throw new Error('Original conversation unavailable');
      current.workersChanged();
    },
  });

  // The chat layer's request-context frame asks for these through a replaceable
  // implementation, so it never imports this subsystem (chat/frame.ts).
  setOrchestrationInstructions(orchestrationInstructions);

  // ── Feature tasks ───────────────────────────────────────────────────────────
  const histories = new FeatureHistoryCache({
    directory: path.join(ctx.userData, 'feature-tasks'),
    safeStorage: ctx.electron.safeStorage,
    getIdentity: identity,
    publish: payload => push.featureTasks(payload),
    onError: report,
  });
  const runner = new FeatureTaskRunner({
    // Throws rather than answering null, which is what `FeatureTaskRunner`
    // expects: an operation that should be accounted for must not run untracked
    // because the ledger has not finished loading.
    getLedger: () => {
      const ledger = histories.ledger;
      if (!ledger) throw Object.assign(new Error('功能任务记录尚未就绪，请稍后重试。'), { code: 'SESSION_CHANGED' });
      return ledger;
    },
  });
  const methods = createFeatureMethods({
    runner,
    current: () => histories.currentIdentity(),
    ledger: () => histories.ledger,
    exclusive: ctx.exclusive,
  });
  let prepareDraft: PrepareFeatureTaskDraft | null = null;

  // ── IPC ─────────────────────────────────────────────────────────────────────
  registerOrchestrationIpc({
    handle: ctx.handle, exclusive: ctx.exclusive, orchestration, policy,
    persist: async mode => { await ctx.store.saveExtra({ orchestration: mode }); },
    // The bridge belongs to the tool-bridge subsystem. Absent, the two channels
    // that need it say so rather than pretending the reconnect happened.
    reconnectBridge: async (): Promise<OrchestrationLinkSnapshot> => {
      const tools = bridge();
      if (!tools?.link) throw new Error('本机调度工具尚未就绪，请稍后重试。');
      tools.disconnectLink?.();
      await tools.connectLink?.();
      return tools.link.snapshot();
    },
  });
  registerFeatureTasksIpc({
    handle: ctx.handle, methods,
    ledger: () => histories.ledger,
    context: (): FeatureTaskContext => ({ connection: ctx.store.connection, generation, configured: Boolean(address()), exiting: closed }),
    persistenceError: () => histories.current?.persistenceError === true,
    prepareDraft: () => prepareDraft,
  });

  // ── Startup ─────────────────────────────────────────────────────────────────
  // BeingDesktop's `restore()`: the saved mode, then the owner, then a detection
  // pass, then the ledger (src/main.cjs lines 674, 691-695). Scheduled rather
  // than run inline, because an installer's body must stay synchronous.
  let ready: Promise<unknown> = Promise.resolve().then(async () => {
    try { orchestration.mode = normalizeMode(ctx.store.extras.orchestration as never); }
    catch (error) { report('orchestration-mode', error); }
    await bind().catch(error => report('orchestration-restore', error));
    if (deps.inspectOnStart === false) return;
    // Detection spawns `--help` for whatever is on PATH; a failure leaves the
    // agent list empty and the settings page says「尚未检测」.
    await orchestration.inspect().catch(error => report('orchestration-inspect', error));
  });

  /** The identity half of both `connect()` and `restore()`: point the manager at
   * the current Being's worker history, then load that Being's ledger. */
  async function bind(): Promise<void> {
    const next = identity();
    if (next !== bound) { bound = next; generation++; }
    await orchestration.selectOwner(next);
    await histories.load();
  }

  return {
    key: 'orchestration',
    orchestration, policy, methods, runner, histories,
    get ready() { return ready; },
    register: (record, owner = runner.currentTask()) => histories.register(record, owner),
    setDraftPreparer(prepare) { prepareDraft = prepare; },
    connectionVerified() {
      if (closed) return;
      // Fire and forget, like the chat subsystem: this runs inside main.ts's
      // `verifyConnection`, which is already inside `exclusive`, so awaiting the
      // queue here would deadlock and a slow disk read would hold up startup.
      ready = bind().catch(error => { if (!closed) report('orchestration-bind', error); });
    },
    async connectionCleared() {
      generation++;
      bound = '';
      await orchestration.selectOwner('');
      await histories.load().catch(error => report('orchestration-cleared', error));
    },
    async quitting() {
      if (closed) return;
      closed = true;
      // Stop the CLIs first: a worker still writing events would dirty the
      // history again after it was flushed.
      await orchestration.dispose().catch(error => report('orchestration-dispose', error));
      await histories.flush();
    },
  };
}
