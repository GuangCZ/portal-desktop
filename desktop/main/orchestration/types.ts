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
  /** DesktopTerminal owns `consoleEnvironment`; optional override, defaults to the vendored copy. */
  consoleEnvironment?: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** DesktopTerminal owns `WINDOWS_RUNNER`; optional override, defaults to the vendored copy. */
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

export interface WorkerPresentationValue {
  state?: string;
  artifactPath?: string;
  url?: string;
  requestedUrl?: string;
  tabId?: string;
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

export interface WorkerPresenter {
  open(
    worker: WorkerRecord,
    args: { artifactPath?: string | null; url?: string | null },
    context: PresentationOpenContext,
  ): Promise<WorkerPresentationValue>;
  describe(value: WorkerPresentationValue | undefined): WorkerPresentationValue | undefined;
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
  presentation: WorkerPresentationValue;
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
