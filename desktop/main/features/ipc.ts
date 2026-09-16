// The feature-task ledger's IPC surface; 2026-09-16. Channel semantics ported
// from BeingDesktop 0.8.26 src/main.cjs lines 1241-1251 (`getFeatureTasks`,
// `getFeatureTask`, `endFeatureTaskTracking`, `discussFeatureTask`) and
// docs/interfaces.md §1.2「功能任务」/ §3.9.
//
// All four are「功能任务」channels: they run through `createFeatureMethods`
// (./methods.ts), so each is refused with SESSION_CHANGED while the ledger is
// being swapped, and `discussFeatureTask` — the one 0.8.26 also lists as
// 「串行」(src/main.cjs line 134) — additionally runs on the mutation queue and
// re-checks the identity after waiting there.
//
// None of the four is a「Town 包络」channel in 0.8.26, so a failure throws.
// `handle` flattens it to a redacted message, which is exactly what the source
// does: the feature-task page shows the sentence, it does not branch on a code.

import { discussFeatureTask } from './feature-task-discussion';
import type { FeatureMethods } from './methods';
import type { FeatureTaskContext, FeatureTaskLedger, FeatureTaskRecord, PrepareFeatureTaskDraft } from './types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface FeatureTasksIpcOptions {
  handle: RegisterHandler;
  methods: FeatureMethods;
  /** The current ledger. Throws rather than answering null: every channel here is
   * already gated on `currentIdentity()`, so a missing ledger at this point means
   * the first load has not finished. */
  ledger: () => FeatureTaskLedger | null;
  /** The connection epoch `discussFeatureTask` compares before and after it
   * prepares the draft (BeingDesktop src/main.cjs line 1251). */
  context: () => FeatureTaskContext;
  /** Whether the ledger's last write reached disk. The ledger does not know; the
   * history around it does, and it is replaced on every identity change, so this
   * is read through a closure rather than passed once. */
  persistenceError: () => boolean;
  /** Puts the prepared prompt into the composer. The native composer belongs to a
   * later unit (integration plan §5.4), so it is injected and may be absent —
   * absent means the channel refuses, never that it claims success. */
  prepareDraft: () => PrepareFeatureTaskDraft | null;
}

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** 0.8.26's own bound (src/main.cjs line 1244). */
const MAX_ID = 128;

/** The three features whose Being-side reads are still「running」but may be
 * abandoned locally. Verbatim from src/main.cjs line 1247. */
const READABLE = ['bonfire', 'fireside', 'scroll'];

export function registerFeatureTasksIpc({ handle, methods, ledger, context, persistenceError, prepareDraft }: FeatureTasksIpcOptions) {
  const require = (): FeatureTaskLedger => {
    const current = ledger();
    if (!current) throw Object.assign(new Error('功能任务记录尚未就绪，请稍后重试。'), { code: 'SESSION_CHANGED' });
    return current;
  };

  handle('beings:feature-tasks', (options: unknown) => {
    if (options !== undefined && !plain(options)) throw invalid('功能任务筛选参数无效。');
    if (plain(options)) for (const key of Object.keys(options)) if (key !== 'feature') throw invalid('功能任务筛选参数无效。');
    if (plain(options) && options.feature !== undefined && (typeof options.feature !== 'string' || options.feature.length > MAX_ID)) throw invalid('功能任务筛选参数无效。');
    return methods.run([options], { operation: 'getFeatureTasks' }, () => {
      const current = require();
      return { tasks: current.list(options ?? {}), persistenceError: persistenceError() };
    });
  });

  handle('beings:feature-task', (id: unknown) =>
    methods.run([id], { operation: 'getFeatureTask' }, (): FeatureTaskRecord | null => require().get(taskId(id))));

  // BeingDesktop src/main.cjs lines 1243-1251, line for line. The `reading`
  // branch is the whole point of the rule: a Being-side read that is still
  // `running` has no local process to stop, so the user may drop it; anything
  // else that is running is a local operation and must be left alone.
  handle('beings:feature-task-end', (id: unknown) =>
    methods.run([id], { operation: 'endFeatureTaskTracking' }, (): FeatureTaskRecord | null => {
      const current = require();
      const task = current.get(taskId(id));
      if (!task) throw new Error('任务不存在或身份已变化。');
      const reading = task.status === 'running' && task.requestId && task.execution === 'being' && READABLE.includes(task.feature);
      if (!['waiting', 'needs_input'].includes(task.status) && !reading) throw new Error('只能结束读取、等待中或待处理任务的本地跟踪。');
      // Legacy read records remain viewable; SDK reads do not create Being tasks.
      return current.cancel(task.id, { detail: '本地跟踪已结束；这不会取消 Being 端的执行。' });
    }));

  handle('beings:feature-task-discuss', (id: unknown) =>
    methods.run([id], { operation: 'discussFeatureTask', serialized: true }, () => {
      const prepare = prepareDraft();
      if (!prepare) throw new Error('把任务内容放入聊天草稿的功能尚未就绪。');
      return discussFeatureTask(id, { getLedger: require, getContext: context, prepareDraft: prepare });
    }));
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_ID) throw new Error('请选择有效的功能任务。');
  return value;
}
