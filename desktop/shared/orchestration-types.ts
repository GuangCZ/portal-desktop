// The orchestration and feature-task contract between the main process and the
// renderer; 2026-09-16. Shapes ported from BeingDesktop 0.8.26
// docs/interfaces.md §1.2 (`getOrchestration`, `getWorker`, `getFeatureTasks`)
// and §1.3 (the `being:workers` / `being:feature-tasks` pushes).
//
// Every name is prefixed, because `desktop-types.ts` re-exports these with
// `export *` and a collision there is silently dropped rather than reported.
//
// These are declarations only: no node, no electron, no main-process import. The
// main process asserts its handlers' return types against them, which is what
// keeps the two halves in step (see desktop/main/orchestration/ipc.ts).

/** One CLI adapter as the settings page sees it (`AgentDto`). */
export interface OrchestrationAgent {
  id: string;
  name?: string;
  path: string;
  status: 'missing' | 'incompatible' | 'needs_auth' | 'ready' | 'error';
  detail?: string;
  auth?: string;
}

export interface OrchestrationModeState {
  enabled: boolean;
  defaultAgent: string;
  paths: Record<string, string>;
}

/** What the mode editor sends back. Every field optional: the manager
 * (`normalizeMode`) fills in what is missing, exactly as 0.8.26 does. */
export interface OrchestrationModeInputState {
  enabled?: boolean;
  defaultAgent?: string;
  paths?: Record<string, string>;
}

/** `OrchestrationPolicy.state`. `status` is one of `unchecked` / `disabled` /
 * `pending` / `enforced` / `blocked`, kept open because the policy publishes it
 * as a string and the renderer only branches on the two it styles. */
export interface OrchestrationPolicyState {
  status: string;
  scope?: string;
  detail?: string;
}

export interface OrchestrationWorkerEvent {
  seq: number;
  at: string;
  kind: 'session' | 'status' | 'message' | 'tool' | 'result' | 'error' | 'log';
  text?: string;
  sessionId?: string;
  append?: boolean;
  callId?: string;
  name?: string;
  status?: string;
  output?: string;
  success?: boolean;
}

export interface OrchestrationWorkerReview {
  status: string;
  requestId: string;
  followUpRequestId: string;
  summary: string;
  evidence: string;
  reported: boolean;
  finishedAt?: string;
  receivedAt?: string;
  deliveryError?: string;
}

export interface OrchestrationWorkerContinuation {
  state: string;
  attempts: number;
  startedAt?: string;
  nextAttemptAt?: number;
  status?: number;
}

export interface OrchestrationWorkerCompletion {
  id: string;
  state: string;
  attempts: number;
  nextAttemptAt: number;
  detail: string;
  inboxId: string | null;
  acceptedAt?: string;
  continuation?: OrchestrationWorkerContinuation;
}

/** What the presenter chose to disclose about an opened result. Open-ended
 * because `WorkerPresentation` (the tool-bridge unit) owns its fields. */
export interface OrchestrationWorkerPresentation {
  state?: string;
  artifactPath?: string;
  url?: string;
  requestedUrl?: string;
  tabId?: string;
  reported?: boolean;
  [key: string]: unknown;
}

export interface OrchestrationWorkerExecution {
  desktopId: string;
  desktopInstanceId: string;
  platform: string;
  arch: string;
  hostname: string;
  workspace: string;
  place?: string;
}

/** A worker in the snapshot: everything but the transcript, the final result and
 * the task prompt, plus how many events there are. */
export interface OrchestrationWorkerSummary {
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  title: string;
  parentWorkerId: string | null;
  cwd: string;
  status: string;
  detail: string;
  sequence: number;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  eventCount: number;
  agentSessionId?: string;
  exitCode?: number | null;
  truncated?: boolean;
  execution?: OrchestrationWorkerExecution;
  presentation?: OrchestrationWorkerPresentation;
  completion?: OrchestrationWorkerCompletion;
  review?: OrchestrationWorkerReview;
}

/** One worker in full, as `beings:worker` answers. */
export interface OrchestrationWorker extends OrchestrationWorkerSummary {
  taskPrompt: string;
  result: string;
  events: OrchestrationWorkerEvent[];
}

export interface OrchestrationSnapshotState {
  mode: OrchestrationModeState;
  enforcement: OrchestrationPolicyState;
  agents: OrchestrationAgent[];
  workers: OrchestrationWorkerSummary[];
  error: string;
  linkRequired: true;
}

/** `DesktopToolLink.snapshot()`, which `beings:workers-reconnect` answers with.
 * The tool-bridge unit owns the real shape; only the two fields the settings page
 * reads are named, and the rest is carried through. */
export interface OrchestrationLinkSnapshot {
  status?: string;
  error?: string;
  reconnect?: { delayMs?: number } | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Feature tasks                                                               */
/* -------------------------------------------------------------------------- */

export type FeatureTaskState = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'needs_input';

/** `TaskDto` in docs/interfaces.md §1.2. */
export interface FeatureTask {
  id: string;
  feature: string;
  operation: string;
  title: string;
  execution: 'being' | 'local';
  mayDelayChat: boolean;
  status: FeatureTaskState;
  detail: string;
  summary: string;
  requestId: string;
  errorCode: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string;
}

export interface FeatureTasksState {
  tasks: FeatureTask[];
  /** The ledger could not be written. The work still ran; the record may not
   * survive a restart. */
  persistenceError?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The renderer bridge                                                         */
/* -------------------------------------------------------------------------- */

export interface OrchestrationAPI {
  /** The whole snapshot: mode, enforcement, detected agents, worker summaries. */
  snapshot(): Promise<OrchestrationSnapshotState>;
  /** Re-detect the four CLI adapters with these path overrides. */
  inspectAgents(paths: Record<string, string>): Promise<OrchestrationAgent[]>;
  /** Save the mode. Serialized; refuses while a worker is running. */
  save(mode: OrchestrationModeInputState): Promise<OrchestrationSnapshotState>;
  worker(id: string): Promise<OrchestrationWorker>;
  cancelWorker(id: string): Promise<OrchestrationWorker>;
  /** Retry the completion notification. Never re-runs the CLI. */
  retryWorker(id: string): Promise<OrchestrationWorker>;
  /** Drop and re-establish the tool bridge, answering with its snapshot. */
  reconnect(): Promise<OrchestrationLinkSnapshot>;
  onWorkers(callback: (state: OrchestrationSnapshotState) => void): () => void;
  featureTasks(options?: { feature?: string }): Promise<FeatureTasksState>;
  featureTask(id: string): Promise<FeatureTask | null>;
  /** Stop following a task locally. Does not cancel anything on the Being. */
  endFeatureTask(id: string): Promise<FeatureTask | null>;
  /** Put the task's result into the composer as a draft. Serialized. */
  discussFeatureTask(id: string): Promise<{ prepared: true; taskId: string }>;
  onFeatureTasks(callback: (state: FeatureTasksState) => void): () => void;
}
