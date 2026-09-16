// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Shapes shared by the feature task ledger, runner, history and discussion modules.
// Sources: src/feature-tasks.cjs, src/feature-task-runner.cjs, src/feature-task-history.cjs,
// src/feature-task-discussion.cjs. Behaviour follows the measured records in BeingDesktop
// docs/architecture.md (§4 subsystem table, §6 persistence, §8 concurrency) and
// docs/interfaces.md (§3.9 interfaces, §5 error codes, §7 persisted format).
//
// Dependencies that live in other migration units (Town/Loom sync, Loom drafts, the
// connection context owned by main) are declared here as injected call surfaces so the
// modules stay testable without electron.

export type FeatureTaskStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'needs_input';
export type FeatureTaskExecution = 'being' | 'local';

/** One row of the ledger; persisted verbatim in the encrypted history file. */
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

/** Persisted ledger payload: `{version: 1, identityKey, records}`. */
export interface FeatureTaskSnapshot {
  version: 1;
  identityKey: string;
  records: FeatureTaskRecord[];
}

/** Input accepted by `FeatureTasks.begin`; still validated at runtime because it crosses IPC. */
export interface FeatureTaskBeginInput {
  feature: string;
  operation: string;
  title: string;
  execution?: FeatureTaskExecution;
}

/** The ledger surface the runner, history and discussion modules depend on. */
export interface FeatureTaskLedger {
  readonly identityKey: string;
  begin(input: FeatureTaskBeginInput): FeatureTaskRecord;
  update(id: string, patch: unknown): FeatureTaskRecord | null;
  complete(id: string, options?: unknown): FeatureTaskRecord | null;
  fail(id: string, error: unknown): FeatureTaskRecord | null;
  cancel(id: string, options?: unknown): FeatureTaskRecord | null;
  get(id: string): FeatureTaskRecord | null;
  list(options?: unknown): FeatureTaskRecord[];
  snapshot(): FeatureTaskSnapshot;
  reset(options?: { identityKey?: string }): FeatureTaskSnapshot;
}

/** The task the current asynchronous operation owns, together with its originating ledger. */
export interface FeatureTaskOwner {
  ledger: FeatureTaskLedger;
  task: FeatureTaskRecord;
}

/** Payload pushed on the dedicated `being:feature-tasks` channel. */
export interface FeatureTasksEvent {
  tasks: FeatureTaskRecord[];
  persistenceError: boolean;
}

/**
 * One owned Town request retained beside the ledger.
 * Produced and validated by `normalizeTownSyncRecords` (BeingDesktop src/loom-town-sync.cjs),
 * which belongs to the Town/Loom migration unit and is therefore injected.
 */
export interface TownSyncRecord {
  requestId: string;
  route: string;
  beingId: string;
  prompt: string;
}

export type NormalizeTownSyncRecords = (value: unknown) => TownSyncRecord[];

/** The subset of electron's safeStorage the history probes for and uses. */
export interface SafeStorageLike {
  isEncryptionAvailable?: () => boolean;
  encryptString?: (value: string) => Buffer;
  decryptString?: (value: Buffer) => string;
}

/** safeStorage once every probed member has been confirmed to be a function. */
export interface SafeStorageApi extends SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

/**
 * The connection epoch main hands to the discussion module.
 * Only `connection` and `generation` are compared; the index signature keeps main's richer
 * context object (revision, view, configured, status, exiting) assignable.
 */
export interface FeatureTaskContext {
  connection: unknown;
  generation: unknown;
  [key: string]: unknown;
}

/** `prepareLoomDraft(prompt, current)` in BeingDesktop src/town.cjs; injected here. */
export type PrepareFeatureTaskDraft = (prompt: string, current: () => FeatureTaskContext) => unknown;
