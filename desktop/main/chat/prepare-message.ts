// The per-send execution context the main process owns; 2026-09-16.
//
// Ported line for line from BeingDesktop 0.8.26 src/orchestration-message.cjs
// lines 39-55 (`nativeMessageContext`; the integration plan's「24-37」names the
// file's older layout — the wrap/unwrap halves are lines 16-37 and already live
// in ./frame.ts).
//
// Why it is in the main process at all, verbatim from the original's comment:
// "IPC cannot supply a scope or override the execution policy". A renderer that
// could hand in its own orchestration scope could dispatch a worker bound to a
// conversation it does not own, so both the scope and the mode instructions are
// read here, from the live manager, at the moment of the send.
//
// The fence is `assertCurrent`. It is captured before the environment is read and
// handed back to `BeingChat.send`, which calls it again after the read and before
// the POST: four things must not have moved in between — the manager must not be
// reconfiguring, its revision, its owner and its enabled flag must all still be
// what they were. Anything else and the scope in hand belongs to a binding that
// no longer exists, which is `SESSION_CHANGED`.
import { orchestrationInstructions } from './frame';
import type { PreparedMessage } from './types';

/** The orchestration scope of one conversation, as it is stringified into the
 * frame. A type alias rather than an interface on purpose: only an alias gets
 * TypeScript's implicit index signature, which is what makes the real
 * `OrchestrationContext` assignable to `frame.ts`'s `{enabled?: boolean} &
 * Record<string, unknown>` without a cast at the call below. */
export type OrchestrationScope = { enabled: boolean };

/** The worker manager as this module reads it. Declared structurally so the chat
 * layer does not import the orchestration unit: the subsystem passes the real
 * `Orchestration` instance through a lazy getter (subsystems/types.ts).
 * `authorize` takes `unknown` because only the manager judges the scope it just
 * minted; this module hands it straight back. */
export interface MessageOrchestration {
  readonly revision: number;
  readonly owner: string;
  readonly mode: OrchestrationScope;
  readonly configuring: boolean;
  context(sessionId: string): OrchestrationScope;
  authorize(scope: unknown): void;
}

export interface NativeMessageContextOptions {
  /** Lazy by contract: the orchestration subsystem may install after this one, and
   * may not be installed at all. Absent means「直接执行模式」— no scope, no
   * orchestrator instructions — which is exactly BeingDesktop with the mode off. */
  orchestration: () => MessageOrchestration | null | undefined;
  /** `chat/environment.ts`'s `desktopEnvironment(sessionId)`. */
  environment: (sessionId: string) => Promise<string>;
}

const sessionChanged = (): Error =>
  Object.assign(new Error('编排模式或会话绑定已变化，请重新发送。'), { code: 'SESSION_CHANGED' });

export function nativeMessageContext({ orchestration, environment }: NativeMessageContextOptions) {
  return async ({ sessionId }: { sessionId: string }): Promise<PreparedMessage> => {
    const manager = orchestration();
    const revision = manager?.revision ?? 0, owner = manager?.owner ?? '';
    const enabled = manager?.mode.enabled === true;
    const assertCurrent = () => {
      const current = orchestration();
      if (current?.configuring || revision !== (current?.revision ?? 0) || owner !== (current?.owner ?? '')
        || enabled !== (current?.mode.enabled === true)) throw sessionChanged();
    };
    assertCurrent();
    const runtime = await environment(sessionId);
    assertCurrent();
    // `context()` mints this conversation's session token on first use, and
    // `authorize` re-checks the same binding it just produced — the original does
    // both here rather than at dispatch, so a scope is never handed out for a
    // conversation the manager would refuse.
    const mode = orchestration()?.context(sessionId) ?? { enabled: false };
    if (mode.enabled) orchestration()?.authorize(mode);
    return { context: runtime + orchestrationInstructions(mode), assertCurrent };
  };
}
