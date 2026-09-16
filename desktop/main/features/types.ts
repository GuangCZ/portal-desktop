// Ported from BeingDesktop 0.8.26 (src/feature-tasks.cjs, src/feature-task-runner.cjs,
// src/feature-task-history.cjs, src/feature-task-discussion.cjs) on 2026-09-16.
// Shared contracts of the feature task ledger: BeingDesktop docs/architecture.md §4
// 「功能任务账本」 and docs/interfaces.md §3.9 / §5 / §7.
// Collaborators that do not live in this unit — Town sync record normalisation
// (loom-town-sync.cjs), Loom draft preparation (town.cjs) and Electron safeStorage —
// are injected through these interfaces so every module stays testable without Electron.

/** docs/interfaces.md §1.2 `TaskDto.status`. */
export type FeatureTaskStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'needs_input';
/** `being` work runs inside the connected Being and may delay chat; `local` work does not. */
export type FeatureTaskExecution = 'being' | 'local';

/** docs/interfaces.md §1.2 `TaskDto`; also the persisted row shape of §7. */
export interface FeatureTaskRecord {
  id: string;
  feature: string;
  operation: string;
  title: string;
  execution: FeatureTaskExecution;
  mayDelayChat: boolean;
  status: FeatureTaskStatus;
  detail: string;
  summary: string;
  requestId: string;
  errorCode: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** Persisted ledger envelope: `{version:1, identityKey, records:[TaskDto]}`. */
export interface FeatureTaskSnapshot {
  version: 1;
  identityKey: string;
  records: FeatureTaskRecord[];
}

export interface FeatureTaskInput {
  feature: string;
  operation: string;
  title: string;
  execution?: FeatureTaskExecution;
}

export interface FeatureTaskPatch {
  status?: FeatureTaskStatus;
  detail?: string;
  requestId?: string;
}

export interface FeatureTasksOptions {
  onChange?: (snapshot: FeatureTaskSnapshot) => void;
  now?: () => number;
  createId?: () => string;
  maxRecords?: number;
  identityKey?: string;
  initialSnapshot?: unknown;
  initialRecords?: unknown;
  initialIdentityKey?: unknown;
}

/**
 * The call surface `FeatureTaskRunner` and `discussFeatureTask` require of a ledger.
 * `FeatureTasks` implements it; the runner still checks the methods at run time
 * because the ledger arrives through an injected getter.
 */
export interface FeatureTaskLedger {
  readonly identityKey: string;
  begin(input: FeatureTaskInput): FeatureTaskRecord;
  update(id: string, patch: FeatureTaskPatch): FeatureTaskRecord | null;
  complete(id: string, options?: { summary?: string }): FeatureTaskRecord | null;
  fail(id: string, error: unknown): FeatureTaskRecord | null;
  cancel(id: string, options?: { detail?: string }): FeatureTaskRecord | null;
  get(id: string): FeatureTaskRecord | null;
  list(options?: { feature?: string }): FeatureTaskRecord[];
  snapshot(): FeatureTaskSnapshot;
  reset(options?: { identityKey?: string }): FeatureTaskSnapshot;
}

export interface FeatureTaskRunnerOptions {
  getLedger: () => FeatureTaskLedger | null | undefined;
}

/** The owning ledger plus the task record of the running `FeatureTaskRunner.run` callback. */
export interface ActiveFeatureTask {
  ledger: FeatureTaskLedger;
  task: FeatureTaskRecord;
}

/**
 * One owned Town sync request, as produced by BeingDesktop `loom-town-sync.cjs`.
 * The history only stores records that the injected normaliser accepted.
 */
export interface TownSyncRecord {
  requestId: string;
  route: string;
  beingId: string;
  prompt: string;
}

/** BeingDesktop `normalizeTownSyncRecords` from src/loom-town-sync.cjs. */
export type NormalizeTownSyncRecords = (value: unknown) => TownSyncRecord[];

/** The subset of Electron `safeStorage` the history uses. */
export interface FeatureTaskSecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Payload of the `being:feature-tasks` push (docs/interfaces.md §1.4). */
export interface FeatureTaskHistoryEvent {
  tasks: FeatureTaskRecord[];
  persistenceError: boolean;
}

export interface FeatureTaskHistoryOptions {
  identityKey: string;
  directory: string;
  safeStorage?: Partial<FeatureTaskSecretStorage>;
  onChange?: (event: FeatureTaskHistoryEvent) => void;
  /** Injected BeingDesktop `normalizeTownSyncRecords`; see NormalizeTownSyncRecords. */
  normalizeRecords: NormalizeTownSyncRecords;
}

/**
 * The connection epoch guarded during discussion (docs/architecture.md §8.1):
 * a changed `connection` or `generation` aborts the hand-off with SESSION_CHANGED wording.
 */
export interface FeatureTaskDiscussionContext {
  connection: unknown;
  generation: unknown;
}

export interface DiscussFeatureTaskOptions<Context extends FeatureTaskDiscussionContext = FeatureTaskDiscussionContext> {
  getLedger: () => FeatureTaskLedger;
  getContext: () => Context;
  /** Injected BeingDesktop `prepareLoomDraft` from src/town.cjs. */
  prepareDraft: (prompt: string, getContext: () => Context) => Promise<unknown>;
}

export interface DiscussFeatureTaskResult {
  prepared: true;
  taskId: string;
}
