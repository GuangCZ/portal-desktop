// The accounting wrapper every「功能任务」channel is registered through;
// 2026-09-16. Ported from BeingDesktop 0.8.26 src/main.cjs's `handle` (lines
// 721-735) and the `featureMethods` / `serialized` sets it consults (lines
// 118-121, 134-146). BeingDesktop docs/interfaces.md §1.1 describes the contract.
//
// WHY THIS IS A FUNCTION AND NOT A SET OF CHANNEL NAMES
//
// BeingDesktop keeps one central `featureMethods` set beside one central
// `handle`, because it has one composition root registering every channel. Here
// the channels are spread across integration units — Town's reads (I1), the
// feature-task channels below (I4), Portal and Channel (I7) — and a central set
// would be a shared line each of them edits. So membership is expressed where the
// channel is registered: a unit wraps its own handler in `methods.run(...)` and
// is thereby a member. There is no list to keep in step.
//
// THE TWO NAMES
//
// `channel` is this shell's name (`beings:feature-tasks`). `operation` is
// BeingDesktop's method name (`getFeatureTasks`, `requestTownRead`,
// `startPortal`…) and it is the one the runner is given, because
// `FeatureTaskRunner`'s OPERATIONS table is keyed by it: pass the kebab channel
// and every ledger definition silently returns null, so nothing is ever recorded.
// A method with no definition — the four feature-task channels among them — still
// goes through `run`, which passes it straight through; that is BeingDesktop's
// behaviour too.

import type { FeatureTaskLedger, FeatureTaskOwner } from './types';
import type { FeatureTaskRunner } from './feature-task-runner';

export interface FeatureMethodsOptions {
  runner: FeatureTaskRunner;
  /** `featureHistoryCurrent()`: the open ledger is the connected Being's. */
  current: () => boolean;
  /** The live ledger, compared against the task owner's before a serialized body
   * runs. Null while none is open. */
  ledger: () => FeatureTaskLedger | null;
  /** main.ts's mutation queue, this shell's `mutationTail`. */
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  /** BeingDesktop's `exitStarted` (src/main.cjs line 730), re-read AFTER the
   * mutation queue hands the turn over. `ctx.handle`'s quitting guard covers only
   * the moment the call arrives, and a serialized body waits behind every other
   * mutation — shutdown normally starts while one is queued. Optional: a caller
   * that has no shutdown of its own is not made to invent one. */
  exiting?: () => boolean;
}

export interface FeatureMethodOptions {
  /** BeingDesktop's method name, the key `FeatureTaskRunner` looks up. */
  operation: string;
  /** BeingDesktop's `serialized` set: the body runs on the mutation queue. */
  serialized?: boolean;
}

const sessionChanged = (message: string): Error => Object.assign(new Error(message), { code: 'SESSION_CHANGED' });

/** The three refusals, verbatim from BeingDesktop 0.8.26. They are three
 * different sentences on purpose — each says which stage the identity moved at,
 * and the user acts on them differently. */
export const SESSION_CHANGED = {
  /** src/main.cjs line 505: the ledger finished loading under an identity that is
   * no longer current. */
  restore: '连接身份已变化，请重新读取功能任务。',
  /** src/main.cjs line 726: the call arrived while the ledger was being swapped. */
  entry: '连接身份正在切换，请稍后重新选择功能。',
  /** src/main.cjs line 732: the call waited on the mutation queue and the
   * identity changed while it waited. */
  queued: '连接身份已变化，请重新选择功能。',
} as const;

/** BeingDesktop says「桌面端正在退出。」here (src/main.cjs line 730). This shell
 * calls itself 客户端 and already refuses queued calls with this exact sentence
 * in `app/ipc.ts`; the same condition should not have two names. */
export const EXITING = '客户端正在退出，请稍候。';

export function createFeatureMethods({ runner, current, ledger, exclusive, exiting }: FeatureMethodsOptions) {
  return {
    /**
     * Run one「功能任务」channel's body under the ledger.
     *
     * Order is the contract (src/main.cjs lines 725-736): the identity gate
     * first, then the runner opens the ledger entry, and only inside the runner
     * does a serialized body join the queue — so the task is recorded as running
     * while it waits, and the owner captured for the wait is the one the second
     * identity check compares against.
     */
    run<T>(args: unknown[], { operation, serialized = false }: FeatureMethodOptions, body: () => T | Promise<T>): Promise<T> {
      if (!current()) throw sessionChanged(SESSION_CHANGED.entry);
      return Promise.resolve(runner.run(operation, args, (): T | Promise<T> => {
        if (!serialized) return body();
        const owner: FeatureTaskOwner | null = runner.currentTask();
        return exclusive(async () => {
          // Both checks are re-read here, in the source's order (src/main.cjs
          // lines 730-731): what was true when the call arrived says nothing
          // about what is true when the queue gets to it.
          if (exiting?.()) throw new Error(EXITING);
          if (owner && owner.ledger !== ledger()) throw sessionChanged(SESSION_CHANGED.queued);
          return body();
        });
      })) as Promise<T>;
    },
  };
}

export type FeatureMethods = ReturnType<typeof createFeatureMethods>;
