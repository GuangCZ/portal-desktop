// The per-identity feature-task ledgers, and which one is current; 2026-09-16.
// Equivalent of BeingDesktop 0.8.26 src/main.cjs's `featureHistory`,
// `featureHistories`, `openFeatureHistories`, `featureHistoryCache`,
// `loadFeatureHistory` (line 488), `publishFeatureTasks` (line 509),
// `featureHistoryCurrent` (line 511) and `registerFeatureRequest` (line 512),
// lifted out of the composition root so the rules can be tested without one.
//
// One ledger per Being identity, kept open for the life of the process:
//
//   * Switching Beings must not mix ledgers. The identity is decided by
//     `sessionPartition`, the same string the chat cache and the session
//     partition use, so "the same Being" means the same thing everywhere.
//   * A ledger is never thrown away, only set aside: a task started under the
//     previous identity is still being written when the user switches, and its
//     `flush()` has to find the object it was writing through. That is what
//     `open` is for at shutdown.
//   * The renderer is told the list is empty BEFORE the new identity's file is
//     read (BeingDesktop main.cjs line 492). Otherwise the previous Being's tasks
//     stay on screen for the length of a disk read and a decrypt, under the new
//     Being's name.
//   * A restore that finishes after the identity moved on again is discarded with
//     SESSION_CHANGED rather than published.
//
// `owner` is the only thing this file does not own: it asks for the current
// identity every time rather than being told, because the identity changes in the
// composition root and a cached copy here would be one notification behind.

import { FeatureTaskHistory } from './feature-task-history';
import { SESSION_CHANGED } from './methods';
import { normalizeTownSyncRecords } from './town-sync';
import type { FeatureTaskLedger, FeatureTasksEvent, NormalizeTownSyncRecords, SafeStorageLike, TownSyncRecord } from './types';

/** BeingDesktop's identity for "no Being is configured" (src/main.cjs line 489).
 * It is a real ledger, not a null one: local operations (Portal, kits) are
 * recorded before any Being is connected. */
export const DISCONNECTED = 'disconnected';

export interface FeatureHistoryCacheOptions {
  /** `path.join(app.getPath('userData'), 'feature-tasks')`. */
  directory: string;
  safeStorage?: SafeStorageLike;
  /** The current Being identity, or `''` when none is configured. Read on every
   * call; `DISCONNECTED` is substituted for the empty string. */
  getIdentity: () => string;
  /** One push of `{tasks, persistenceError}` to the renderer. Called with `null`
   * to push the empty list while an identity is being swapped. */
  publish: (payload: { tasks: unknown[]; persistenceError?: boolean }) => void;
  /** Injected so a test can drive the enrolment rules; production uses the port
   * of BeingDesktop's own (./town-sync.ts). */
  normalize?: NormalizeTownSyncRecords;
  onError?: (scope: string, error: unknown) => void;
}

const sessionChanged = (message: string): Error => Object.assign(new Error(message), { code: 'SESSION_CHANGED' });

export class FeatureHistoryCache {
  private readonly options: FeatureHistoryCacheOptions;
  private readonly normalize: NormalizeTownSyncRecords;
  /** identity key -> history. Kept for the life of the process. */
  private readonly cache = new Map<string, FeatureTaskHistory>();
  /** ledger -> the history that owns it, for `register` from inside a task. */
  private readonly owners = new WeakMap<FeatureTaskLedger, FeatureTaskHistory>();
  /** Every history ever opened, flushed together at shutdown. */
  private readonly opened = new Set<FeatureTaskHistory>();
  private history: FeatureTaskHistory | null = null;
  /** The enrolled sync records of the current identity (BeingDesktop's
   * `townSyncRecords`). The Loom projection that consumed them does not exist in
   * this shell; kept because `register` maintains it and later units read it. */
  private syncRecords: TownSyncRecord[] = [];
  private loading: Promise<void> | null = null;

  constructor(options: FeatureHistoryCacheOptions) {
    this.options = options;
    this.normalize = options.normalize ?? normalizeTownSyncRecords;
  }

  /** The identity a ledger would be opened under right now. */
  identity(): string { return this.options.getIdentity() || DISCONNECTED; }

  /** The live ledger, or null before the first `load()` finishes. */
  get ledger(): FeatureTaskLedger | null { return this.history ? this.history.ledger : null; }

  get current(): FeatureTaskHistory | null { return this.history; }

  get records(): TownSyncRecord[] { return this.syncRecords; }

  /** BeingDesktop `featureHistoryCurrent()`: the open ledger belongs to the
   * identity that is connected now. Every `featureMethods` channel is refused
   * while this is false. */
  currentIdentity(): boolean { return this.history?.ledger.identityKey === this.identity(); }

  /** BeingDesktop `publishFeatureTasks()`. Silent unless the open ledger is the
   * current identity's, so a late change from the previous Being cannot repaint
   * the new one's list. */
  publish(): void {
    if (!this.history || !this.currentIdentity()) return;
    this.options.publish({ tasks: this.history.ledger.list(), persistenceError: this.history.persistenceError });
  }

  /**
   * BeingDesktop `loadFeatureHistory()`. Same identity: nothing happens. A
   * different one: the renderer is emptied first, the file is read, and the
   * result is published only if the identity has not moved again meanwhile.
   *
   * Concurrent calls share one load, and a load that is superseded still settles
   * — its caller is told with SESSION_CHANGED, which is the same error the source
   * raises from inside `connect()`.
   */
  async load(): Promise<void> {
    // Serialize: two verifications in a row must not race each other's publish.
    // `loading` never rejects, so a failed load does not poison the queue.
    while (this.loading) await this.loading;
    const identity = this.identity();
    if (this.history?.ledger.identityKey === identity) return;
    const run = this._load(identity);
    const queued = run.then(() => {}, () => {}).finally(() => { this.loading = null; });
    this.loading = queued;
    try { await run; } finally { await queued; }
  }

  private async _load(identity: string): Promise<void> {
    // Before the read, not after: the previous Being's tasks must not stay on
    // screen under the new Being's name (BeingDesktop main.cjs line 492).
    this.options.publish({ tasks: [] });
    let history = this.cache.get(identity);
    if (!history) {
      history = new FeatureTaskHistory({
        identityKey: identity,
        directory: this.options.directory,
        safeStorage: this.options.safeStorage,
        normalizeTownSyncRecords: this.normalize,
        // Guarded on identity, not on `history === this.history`, because the
        // change may arrive while this very load is still running.
        onChange: (event: FeatureTasksEvent) => {
          if (this.history !== history) return;
          this.publishEvent(event);
        },
      });
      this.cache.set(identity, history);
      this.opened.add(history);
    }
    await history.restore();
    // The same constant the「功能任务」channels refuse with, not a second copy of
    // the sentence: this is the only place that raises it in production, so a
    // literal here would leave the wording the user actually sees untested.
    if (this.identity() !== identity) throw sessionChanged(SESSION_CHANGED.restore);
    this.history = history;
    this.owners.set(history.ledger, history);
    this.syncRecords = history.records;
    this.publish();
  }

  /** A change reported by the ledger itself. Identical to `publish()` except that
   * it forwards the event the history already built, rather than rebuilding it. */
  private publishEvent(event: FeatureTasksEvent): void {
    if (!this.currentIdentity()) return;
    this.options.publish({ tasks: event.tasks as unknown[], persistenceError: event.persistenceError });
  }

  /**
   * BeingDesktop `registerFeatureRequest(record, owner)`. The record is enrolled
   * in the ledger of whoever started the operation — which is not necessarily the
   * current one, if the user switched Beings mid-flight — and the task that is
   * waiting on it is told a request id exists.
   */
  register(record: unknown, owner: { ledger: FeatureTaskLedger; task: { id: string } } | null = null): void {
    const history = owner ? this.owners.get(owner.ledger) : this.history;
    if (!history) return;
    if (owner) owner.ledger.update(owner.task.id, { requestId: (record as { requestId?: unknown })?.requestId, detail: 'Being 正在处理，结果将显示在功能页；聊天可能等待。' });
    history.register(record);
    if (history !== this.history) return;
    this.syncRecords = history.records;
  }

  /** Every ledger ever opened, flushed together (BeingDesktop main.cjs line 1623).
   * One failure does not stop the rest: a file that cannot be written is already
   * reported through `persistenceError`. */
  async flush(): Promise<void> {
    await Promise.all([...this.opened].map(history => history.flush().catch(error => { this.options.onError?.('feature-tasks-flush', error); })));
  }
}
