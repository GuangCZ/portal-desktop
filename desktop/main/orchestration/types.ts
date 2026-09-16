// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Shared contracts for the orchestration unit (src/orchestration.cjs, src/worker-callbacks.cjs,
// src/orchestration-policy.cjs, src/agent-kits.cjs, src/agent-process.cjs, src/worker-events.cjs,
// src/native-worker-results.cjs). Collaborators owned by other migration units — DesktopToolLink,
// DesktopTools, ChatSessions, DesktopTerminal and the request-context frame of
// src/orchestration-message.cjs — are declared here and injected, never imported.
// Protocol reference: docs/orchestration.md, docs/worker-callback-design.md,
// docs/architecture.md §5.5, docs/interfaces.md §3/§6.3/§7.

import type { spawn } from 'node:child_process';

/* -------------------------------------------------------------------------- */
/* Agent kits                                                                  */
/* -------------------------------------------------------------------------- */

export type AgentStatus = 'missing' | 'incompatible' | 'needs_auth' | 'ready' | 'error';

/** One CLI adapter definition (src/agent-kits.cjs `AGENTS`). */
export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly commands: readonly string[];
  readonly help: readonly string[];
  readonly features: readonly string[];
  readonly args: readonly string[];
  readonly auth?: readonly string[];
  readonly authHint?: string;
}

/** Detection result for one adapter (`AgentDto` in docs/interfaces.md §1.2). */
export interface AgentRecord {
  id: string;
  name?: string;
  path: string;
  status: AgentStatus;
  detail?: string;
  auth?: string;
}

export interface OrchestrationMode {
  enabled: boolean;
  defaultAgent: string;
  paths: Record<string, string>;
}

export interface OrchestrationModeInput {
  enabled?: unknown;
  defaultAgent?: unknown;
  paths?: Record<string, unknown> | null;
}

export interface ProbeResult {
  code: number | null;
  output: string;
  overflow?: boolean;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
  stopped?: boolean;
}

export type ExecutableFinder = (commands: readonly string[], override?: string) => Promise<string>;
export type ProbeRunner = (file: string, args: readonly string[]) => Promise<ProbeResult>;

/* -------------------------------------------------------------------------- */
/* Agent process                                                               */
/* -------------------------------------------------------------------------- */

export interface AgentExitResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
  stopped?: boolean;
}

export interface AgentChild {
  done: Promise<AgentExitResult>;
  stop(): Promise<AgentExitResult | void>;
}

export type AgentStream = 'stdout' | 'stderr';

export interface LaunchAgentOptions {
  file: string;
  args?: readonly string[];
  input?: string;
  cwd: string;
  onData?: (stream: AgentStream, text: string) => void;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  environment?: NodeJS.ProcessEnv;
  /** `common/platform.ts` owns `consoleEnvironment`; optional override, defaults to it. */
  consoleEnvironment?: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** `common/platform.ts` owns `WINDOWS_RUNNER`; optional override, defaults to it. */
  windowsRunner?: string;
}

export type LaunchAgent = (options: LaunchAgentOptions) => AgentChild;
export type DetectAgents = (paths?: Record<string, string>) => Promise<AgentRecord[]>;

/* -------------------------------------------------------------------------- */
/* Worker events                                                               */
/* -------------------------------------------------------------------------- */

export type WorkerEventKind = 'session' | 'status' | 'message' | 'tool' | 'result' | 'error' | 'log';

export interface NormalizedEvent {
  kind: WorkerEventKind;
  text?: string;
  sessionId?: string;
  append?: boolean;
  callId?: string;
  name?: string;
  status?: string;
  output?: string;
  success?: boolean;
}

export interface StoredWorkerEvent extends NormalizedEvent {
  seq: number;
  at: string;
}

/* -------------------------------------------------------------------------- */
/* Worker records                                                              */
/* -------------------------------------------------------------------------- */

export interface WorkerExecution {
  desktopId: string;
  desktopInstanceId: string;
  platform: string;
  arch: string;
  hostname: string;
  workspace: string;
  place?: string;
}

export interface ExecutionContextInput {
  desktopId?: string;
  place?: string;
}

/** What a Worker records about the tab its result is showing in.
 *
 * `null` is a value here, not an absence: `WorkerPresentation.open` writes
 * `artifactPath` and `requestedUrl` as the two inputs it was NOT given, and a tab
 * that could not be identified leaves `tabId` null. The four nullable fields and
 * `openedAt` were missing from this declaration, which is why the tool bridge had
 * to keep a structural copy of this contract to assign the presenter at all
 * (docs/migration/i2-tools.md「类型对齐实测」4). IM, 2026-09-16. */
export interface WorkerPresentationValue {
  state?: string;
  artifactPath?: string | null;
  url?: string;
  requestedUrl?: string | null;
  tabId?: string | null;
  /** ISO timestamp of the open that produced this value. */
  openedAt?: string;
  reported?: boolean;
  [key: string]: unknown;
}

export interface WorkerReview {
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

export interface WorkerContinuation {
  state: string;
  attempts: number;
  startedAt?: string;
  nextAttemptAt?: number;
  status?: number;
}

export interface WorkerCompletion {
  id: string;
  state: string;
  attempts: number;
  nextAttemptAt: number;
  detail: string;
  inboxId: string | null;
  acceptedAt?: string;
  continuation?: WorkerContinuation;
}

export interface WorkerRecord {
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  title: string;
  taskPrompt: string;
  parentWorkerId: string | null;
  cwd: string;
  status: string;
  detail: string;
  events: StoredWorkerEvent[];
  sequence: number;
  result: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  agentSessionId?: string;
  exitCode?: number | null;
  truncated?: boolean;
  execution?: WorkerExecution;
  presentation?: WorkerPresentationValue;
  completion?: WorkerCompletion;
  review?: WorkerReview;
}

export interface WorkerSummary extends Omit<WorkerRecord, 'events' | 'result' | 'taskPrompt'> {
  eventCount: number;
}

/* -------------------------------------------------------------------------- */
/* Presentation (WorkerPresentation lives in the browser unit)                 */
/* -------------------------------------------------------------------------- */

export interface PresentationOpenContext {
  current: () => boolean;
  reveal?: boolean;
}

/** The three fields `WorkerPresentation.open` actually reads off a Worker: its id
 * (to key the pending map and the static server), its working directory (the root
 * an artifact path must stay inside) and the previous presentation (to reuse the
 * tab it already opened). Declaring the whole `WorkerRecord` here said the
 * presenter needed all of it, and made the real class unassignable. */
export interface PresentationTarget {
  id: string;
  cwd: string;
  presentation?: WorkerPresentationValue | null;
}

/** The browser unit's `WorkerPresentation`, as orchestration uses it.
 *
 * NULL AND UNDEFINED ARE BOTH ALLOWED ON THE WAY BACK, deliberately: `describe`
 * answers null for a value it was given nothing for, and `open` returns whatever
 * `describe` returned. Orchestration reads both as `this.presentation?.describe(x)
 * || x`, where the two take the same branch, so widening the declaration changed
 * no behaviour — it only stopped the tool bridge having to restate this contract
 * structurally to get past the compiler. */
export interface WorkerPresenter {
  open(
    worker: PresentationTarget,
    args: { artifactPath?: unknown; url?: unknown },
    context: PresentationOpenContext,
  ): Promise<WorkerPresentationValue | null>;
  describe(value: WorkerPresentationValue | null | undefined): WorkerPresentationValue | null | undefined;
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Tool surface (DesktopToolLink / DesktopTools inject these argument shapes)  */
/* -------------------------------------------------------------------------- */

export interface WorkerToolArgs {
  sessionId?: string;
  sessionToken?: string;
  workerId?: string;
  requestId?: string;
  parentWorkerId?: string;
  agentId?: string;
  title?: string;
  prompt?: string;
  action?: string;
  callbackId?: string;
  artifactPath?: string | null;
  url?: string | null;
  outcome?: string;
  summary?: string;
  evidence?: string;
  place?: string;
  target_portal?: string;
}

export interface OrchestrationContext {
  enabled: boolean;
  sessionId?: string;
  sessionToken?: string;
  defaultAgent?: string;
  execution?: WorkerExecution;
  agents?: { id: string; name?: string }[];
}

export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

export interface PresentResult {
  workerId: string;
  /** Whatever `WorkerPresenter.open` answered. In practice it is always a value —
   * `open` describes a tab it has just opened — but the declaration follows the
   * presenter's own return type rather than asserting past it. */
  presentation: WorkerPresentationValue | null;
  instruction: string;
}

export interface WorkerListItem {
  id: string;
  title: string;
  agentId: string;
  status: string;
  detail: string;
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

export interface PolicyState {
  status: string;
  scope: string;
  detail?: string;
}

/** DesktopToolLink capability snapshot (`link.capabilities()`), injected. */
export interface BridgeCapabilities {
  status?: string;
  place?: string;
  tools?: string[];
}

export interface OrchestrationPolicyOptions {
  getIdentity: () => string;
  getDesktopId: () => string;
  getBridge: () => BridgeCapabilities | null | undefined;
  getMode: () => OrchestrationMode | null | undefined;
  onChange?: (state: PolicyState) => void;
  /** src/desktop-identity.cjs is owned by the identity unit; injected with a faithful default. */
  validDesktopId?: (value: string) => boolean;
  desktopPortalName?: (id: string) => string;
}

/* -------------------------------------------------------------------------- */
/* Callback transports                                                         */
/* -------------------------------------------------------------------------- */

/** Loose worker projection accepted by the native senders (src/worker-callbacks.cjs). */
export interface CallbackWorkerView {
  id: string;
  sessionId: string;
  requestId?: string;
  status?: string;
  endedAt?: string | null;
  title?: string;
  execution?: { desktopId?: string; place?: string };
  completion?: { id: string };
}

export interface CallbackPayload {
  source: string;
  task_id: string;
  summary: string;
  result: {
    protocol: string;
    desktop_id?: string;
    target_portal?: string;
    callback_id: string;
    worker_id: string;
    desktop_session_id: string;
    start_request_id?: string;
    status?: string;
    finished_at?: string | null;
    title?: string;
  };
}

export interface SendContext {
  owner: string;
  signal: AbortSignal;
}

export interface SendResult {
  accepted: boolean;
  status?: number;
  inboxId?: string | null;
  retryable?: boolean;
  detail?: string;
}

export interface ResumeContext extends SendContext {
  beforeSend: () => Promise<boolean>;
}

export interface ResumeResult {
  accepted?: boolean;
  busy?: boolean;
  skipped?: boolean;
  failed?: boolean;
  retryable?: boolean;
  status?: number;
}

export interface ReportContext extends SendContext {
  presentationOnly?: boolean;
}

export type CallbackSender = (worker: WorkerRecord, context: SendContext) => Promise<SendResult>;
export type ContinuationSender = (worker: WorkerRecord, context: ResumeContext) => Promise<ResumeResult>;
/** ChatSessions delivers the review card to the original conversation; injected. */
export type WorkerReporter = (worker: WorkerRecord, context: ReportContext) => Promise<void>;

/** src/security.cjs connection helpers, owned by the connection unit. */
export interface LoomConnection {
  url: string;
  apiBase: string;
  token: string;
  secret: string;
  displayUrl: string;
  beingName: string;
}

export type ParseConnection = (input: string) => LoomConnection;
export type SessionPartition = (connection: LoomConnection) => string;

export interface CallbackSenderOptions {
  getConnection: () => { url: string } | null | undefined;
  fetchImpl?: typeof fetch;
  parseConnection: ParseConnection;
  sessionPartition: SessionPartition;
}

export interface ContinuationSenderOptions extends CallbackSenderOptions {
  getTarget: () => string | null | undefined;
}

export interface WorkerCallbackTransport {
  send?: CallbackSender | null;
  resume?: ContinuationSender | null;
  ready?: () => boolean;
  toolsReady?: () => boolean;
  report?: WorkerReporter | null;
  now?: () => number;
}

export interface ReceiveResult {
  alreadyReviewed: boolean;
  workerId?: string;
  review?: WorkerReview;
  worker?: {
    id: string;
    sessionId: string;
    title: string;
    status: string;
    taskPrompt: string;
    review: WorkerReview;
    completion: WorkerCompletion;
  };
  scope?: OrchestrationContext;
  instruction: string;
}

export interface ReviewResult {
  recorded: true;
  alreadyReviewed?: boolean;
  review: WorkerReview;
  instruction: string;
}

/**
 * The subset of `Orchestration` that `WorkerCallbacks` drives. Declared so the two modules stay
 * independently typed even though BeingDesktop wires them together in the manager constructor.
 */
export interface CallbackManager {
  workers: WorkerRecord[];
  mode: OrchestrationMode;
  owner: string;
  error: string;
  revision: number;
  configuring: boolean;
  assertEnforced?: () => Promise<void>;
  getSessionIds: () => string[];
  get(id: string): WorkerRecord;
  context(sessionId: string): OrchestrationContext;
  authorize(args: WorkerToolArgs): void;
  flush(): Promise<void>;
  notify(): void;
  scheduleSave(): void;
}

/* -------------------------------------------------------------------------- */
/* Request-context frame (src/orchestration-message.cjs -> chat/frame.ts, P1)  */
/* -------------------------------------------------------------------------- */

/**
 * `[Being Desktop request context v1; length=N]\n<context>\n[/Being Desktop request context v1]\n\n<text>`.
 * Ported by the chat-core unit; declared here so the integration phase can inject it.
 */
export type WrapMessage = (text: string, context: string) => string;
export type UnwrapMessage = (wire: string) => string;

/* -------------------------------------------------------------------------- */
/* Native worker results                                                       */
/* -------------------------------------------------------------------------- */

export interface WorkerResultSource {
  id: string;
  sessionId: string;
  title: string;
  endedAt?: string | null;
  updatedAt?: string;
  presentation?: WorkerPresentationValue;
  review?: { status?: string; summary?: string; evidence?: string };
}

export interface NativeWorkerResult {
  workerId: string;
  sessionId: string;
  title: string;
  at: string | undefined;
  preview: boolean;
  status: string;
  summary: string;
  evidence: string;
}
