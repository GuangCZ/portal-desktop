// Putting a prepared prompt into the native composer; 2026-09-16 (integration
// unit I7, plan §3.7, decision §5.4).
//
// This replaces `prepareLoomDraft` in ./town-catalog.ts, which is the same idea
// aimed at a surface that no longer exists: it reached into the sandboxed Loom
// document with `executeJavaScript`, found `#input`, and refused when that
// textarea already held text. P1 removed the iframe, so every one of its DOM
// guards addresses nothing (integration plan §1.1, u3).
//
// What survives is the part that was never about the DOM — the contract:
//
//   * the draft goes into the CURRENT conversation, never a new one;
//   * a draft the user has already started is NEVER overwritten;
//   * the identity the draft was prepared under is re-checked after the round
//     trip, because preparing one is asynchronous and the user can switch Being
//     while it is in flight.
//
// BeingDesktop's three refusals are kept verbatim, because they are what the user
// reads and each tells them to do something different. The fourth case is new and
// belongs to this transport rather than to the old one: the Loom document
// answered `executeJavaScript` or raised, while a push to the renderer can simply
// go unanswered (no window, a window that has not mounted the conversation yet).
// Silence is not success, so it has its own deadline and its own sentence — the
// shell's existing one for exactly this condition (renderer/app/models/
// workspace.ts's compose timeout).

/** The connection epoch a draft is fenced against.
 *
 * A type alias rather than an interface so it keeps an implicit index signature:
 * `FeatureTaskContext` (../../features/types.ts) has one, and the feature-task
 * discussion hands its own context through this same preparer.
 *
 * `revision` is BeingDesktop's `identityRevision` — the Being's profile changing
 * under a stable connection. Its `viewRevision`, the third axis, was the Loom
 * view's own generation and has no analogue here. */
export type NativeDraftContext = {
  connection: unknown;
  generation: unknown;
  revision: unknown;
  configured: boolean;
  /** `'connected'` once the Being has answered `/api/status`. */
  status: string;
  exiting: boolean;
};

export type NativeDraftContextReader = () => NativeDraftContext;

/** What the renderer did with the pushed draft.
 *
 * DEVIATION from integration plan §3.7, which typed `waitAck` as
 * `Promise<boolean>`: a boolean cannot separate「已有草稿」from「对话尚未就绪」,
 * and those two need different sentences — one asks the user to clear their
 * draft, the other to wait. The renderer can tell them apart (it holds the
 * conversation model) so it says which, and `'timeout'` is this side's own answer
 * when nothing comes back at all. */
export type DraftAck = 'placed' | 'occupied' | 'unavailable' | 'timeout';

/** The channel the main process pushes a prepared draft on, and the one the
 * renderer answers on. Named here so the preload file and this one cannot drift.
 *
 * Not in plan §3.7's table: that table lists the four `beings:channel-*` and the
 * three `beings:town-*` request channels, and takes the renderer half as read
 * («渲染层复用已有的 `beings:scene-draft` 三段»). Those three are renderer-internal
 * message types on `AppModel.post`, not IPC; the trip from the main process to
 * the window needs a real channel pair, and this is it. */
export const DRAFT_PUSH = 'beings:composer-draft';
export const DRAFT_ACK = 'beings:composer-draft-ack';

/** BeingDesktop 0.8.26, verbatim. The first three are its own sentences (the
 * first from src/main.cjs's own guard, the other two from src/town.cjs's
 * `prepareLoomDraft`, reworded there for Loom and given here in the form
 * integration plan §3.7 fixes); the fourth is the shell's existing sentence for
 * an unanswered conversation surface. */
export const DRAFT_REFUSED = {
  /** No Being is bound, or it has not answered yet. */
  notConnected: '请先连接 Being。',
  /** The composer already holds text the user wrote. */
  occupied: '已有草稿，已保留原文；请先发送或清空后再选择此功能。',
  /** The identity moved while the draft was in flight. */
  changed: '会话已变化，请重新选择。',
  /** Nothing answered: no window, or no conversation mounted in it. */
  unanswered: '对话页面尚未准备好，请稍后重试。',
} as const;

/** How long the renderer has to answer. BeingDesktop's own composer round trip
 * (renderer/app/models/workspace.ts) waits 3s before giving up on the same
 * reply, so the two paths into the same composer time out alike. */
export const DRAFT_TIMEOUT_MS = 3000;

const MAX_PROMPT = 32_000;

const refuse = (message: string): Error => new Error(message);

/** `requireCurrentContext` in ./town-catalog.ts, with the Loom view's three
 * conditions dropped and nothing else changed: same order, same meaning.
 *
 * `expected` turns it into the second half of the fence — the identity must not
 * merely be valid, it must be the one the draft was prepared under. */
export function requireDraftContext(getContext: NativeDraftContextReader, expected?: NativeDraftContext): NativeDraftContext {
  const current = getContext();
  if (current.exiting || !current.connection || !current.configured || current.status !== 'connected') throw refuse(DRAFT_REFUSED.notConnected);
  if (expected && (current.connection !== expected.connection || current.generation !== expected.generation || current.revision !== expected.revision)) {
    throw refuse(DRAFT_REFUSED.changed);
  }
  return current;
}

export interface DraftAcks {
  /** Resolves with the renderer's answer, or `'timeout'` after `ms`. */
  wait(id: string, ms: number): Promise<DraftAck>;
  /** The renderer answered. False when nothing was waiting for that id — a late
   * reply to a draft that already timed out, which is not an error. */
  settle(id: string, ack: DraftAck): boolean;
  /** Every pending wait gives up now. Used when the binding is torn down. */
  reset(): void;
  readonly pending: number;
}

/** The registry the IPC layer settles and the preparer waits on. Separate from
 * `createNativeDraft` so a test can drive either half alone, and so the timer is
 * one thing rather than one per call site. */
export function createDraftAcks(timers: {
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
} = {}): DraftAcks {
  const start = timers.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const stop = timers.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const waiting = new Map<string, { resolve: (ack: DraftAck) => void; timer: unknown }>();
  const finish = (id: string, ack: DraftAck): boolean => {
    const entry = waiting.get(id);
    if (!entry) return false;
    waiting.delete(id);
    stop(entry.timer);
    entry.resolve(ack);
    return true;
  };
  return {
    wait: (id, ms) => new Promise<DraftAck>(resolve => {
      // A repeat of an id in flight would orphan the first waiter; ids come from
      // randomUUID, so this only happens if someone injects a constant one.
      finish(id, 'timeout');
      const timer = start(() => finish(id, 'timeout'), ms);
      // A Node timer must not keep the process alive for a draft nobody is
      // waiting on any more.
      (timer as { unref?: () => void })?.unref?.();
      waiting.set(id, { resolve, timer });
    }),
    settle: (id, ack) => finish(id, ack),
    reset: () => { for (const id of [...waiting.keys()]) finish(id, 'timeout'); },
    get pending() { return waiting.size; },
  };
}

export interface NativeDraftOptions {
  /** `ctx.push`: already window-guarded, so an absent window is silence rather
   * than a throw — which is exactly the case the deadline below covers. */
  push: (channel: string, payload: unknown) => void;
  waitAck: (id: string, ms: number) => Promise<DraftAck>;
  /** Test seam. Production uses `crypto.randomUUID`. */
  newId?: () => string;
  timeoutMs?: number;
  now?: () => number;
}

/** `prepareNativeDraft(prompt, getContext)`: the replacement for
 * `prepareLoomDraft`, and the argument `discussFeatureTask` takes as
 * `prepareDraft`. */
export function createNativeDraft({ push, waitAck, newId = () => crypto.randomUUID(), timeoutMs = DRAFT_TIMEOUT_MS, now = () => Date.now() }: NativeDraftOptions) {
  return async function prepareNativeDraft(prompt: unknown, getContext: NativeDraftContextReader): Promise<{ prepared: true }> {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw refuse('草稿内容无效，未填入对话。');
    const initial = requireDraftContext(getContext);
    const id = newId();
    // `expiresAt` is the renderer's own guard: a push that arrives after this
    // side has already given up must not silently replace a newer draft.
    push(DRAFT_PUSH, { id, text: prompt, expiresAt: now() + timeoutMs });
    const ack = await waitAck(id, timeoutMs);
    // The identity is re-read BEFORE the answer is interpreted, in the source's
    // order: a draft that landed under an identity that has since changed is a
    // changed session, not a success.
    requireDraftContext(getContext, initial);
    if (ack === 'occupied') throw refuse(DRAFT_REFUSED.occupied);
    if (ack !== 'placed') throw refuse(DRAFT_REFUSED.unanswered);
    return { prepared: true };
  };
}

export type PrepareNativeDraft = ReturnType<typeof createNativeDraft>;
