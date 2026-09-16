// The half of the error envelope that has to run inside the page's own world;
// 2026-09-17 (integration unit IN).
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
//
// An error code crosses two boundaries on its way to the renderer, and the shell
// used to lose it on the second one.
//
//   main process ──IPC──> preload ──contextBridge──> page
//
// The first boundary is why the envelope exists at all: Electron replaces an
// Error crossing IPC with its message (desktop/shared/chat-errors.ts), so a
// failing「Town 包络」channel resolves with `{__townError, code, message}` instead
// of throwing. The preload then rebuilt an Error from it — one step short. It is
// the SECOND boundary that this repair is about.
//
// MEASURED on this repo's Electron 44.2.0, with a standalone two-file fixture
// that imports nothing from this repository (docs/migration/in-shell-errors.md
// §2; the same result IM measured, docs/migration/im-integration.md §4.4):
//
//   throw Object.assign(new Error(m), {code, candidates})  → page sees own
//     properties ["message","stack"] — `code` and `candidates` are GONE
//   throw {__townError:true, code, message, candidates}    → page sees all four
//   an Error built inside the page's world                  → keeps everything
//
// So `contextBridge` copies an Error by message and stack alone, and a plain
// object whole. Rebuilding the Error in the preload therefore undid the envelope:
// every `error.code === 'AUTH_REQUIRED' | 'NOT_SENT' | 'SESSION_CHANGED' |
// 'NEEDS_KEY'` branch in the renderer was unreachable, and an ambiguous direct
// message never showed the recipients Town offered. BeingDesktop 0.8.26 has the
// same hole (src/preload.cjs lines 60-76, whose own comment says「Electron strips
// custom Error fields」, and renderer/town-app.js lines 308 and 1027 branch on
// codes that never arrive), so this is inherited rather than introduced.
//
// Rejecting with the plain envelope alone is NOT enough: desktop/shared/errors.ts
// `publicErrorMessage` reads `error instanceof Error ? error.message : error`, so
// a plain object reaches the user as「[object Object]」through `errorText`. The
// renderer needs a real Error — built on its own side.
//
// The page's world cannot take the name over by itself: `exposeInMainWorld`
// defines it `writable:false, configurable:false` (measured), so a renderer-side
// wrapper could only cover callers that go through `AppModel` and not
// `window.beings.townDesktop.bonfire()` as tests/town-sdk.mjs calls it. Hence
// `contextBridge.executeInMainWorld`, which runs the function below inside that
// world and lets it define the name itself.
//
// ── THE ONE RULE FOR EDITING THIS FILE ────────────────────────────────────────
//
// `installDecodedBridge` is SERIALIZED and re-evaluated in the page's world
// (electron.d.ts: "This function will be serialized which means that any bound
// parameters and execution context will be lost"). MEASURED: a reference to a
// module-scope constant becomes `ReferenceError: OUTER is not defined` at
// runtime, in the packaged client, with no build-time warning. So it must stay
// self-contained — no imports, no module-scope helpers, no shared constants.
// Everything it needs arrives in `args`. `tests/preload-envelope-bridge.test.ts`
// re-evaluates it from its own source text the way Electron does, which is what
// turns that rule into a failing test rather than a comment.
//
// This file imports nothing, which is also what lets it be unit-tested at all:
// tests/architecture.test.ts forbids the shared layer from touching Electron, and
// a preload module that imports `electron` cannot be loaded under vitest.

/** What the renderer catches: BeingDesktop's error with its code attached. */
export interface DecodedBridgeError extends Error {
  code?: string;
  candidates?: unknown[];
  detail?: string;
}

/**
 * Build the page's `window.<name>` from the preload's API and install it.
 *
 * Every function found on `raw`, and on each of its one-level-deep members, is
 * wrapped so that a rejection carrying the `__townError` marker becomes an Error
 * built HERE, in the page's world, with `code`, `candidates` and `detail` intact.
 * Everything else is passed through untouched:
 *
 *   · a resolved value, including a resolved envelope — the channel family in
 *     `channels/channel.ts` answers with data on purpose (`ChannelAnswer<T>`),
 *     and `feishu` always does. Only the rejection path is decoded.
 *   · a rejection that is not an envelope — an ordinary Error from a plain
 *     `invoke` already carries everything it has, which is its message.
 *   · a synchronous return — `subscribe` hands back an unsubscribe function, and
 *     wrapping must not turn that into a promise.
 *   · a plain value such as `platform`.
 *
 * Returns the name it defined, so a test can read the bridge back off the global
 * it was given. SELF-CONTAINED: see the rule above.
 */
export function installDecodedBridge(raw: Record<string, unknown>, name: string): string {
  const decode = (reason: unknown): unknown => {
    if (!reason || typeof reason !== 'object') return reason;
    const envelope = reason as {
      __townError?: unknown; code?: unknown; message?: unknown; candidates?: unknown; detail?: unknown;
    };
    if (envelope.__townError !== true) return reason;
    // `DecodedBridgeError` is a type, so naming it here costs nothing at runtime:
    // types are erased before the function is serialized.
    const error = new Error(typeof envelope.message === 'string' ? envelope.message : '') as DecodedBridgeError;
    if (typeof envelope.code === 'string') error.code = envelope.code;
    if (Array.isArray(envelope.candidates)) error.candidates = envelope.candidates;
    if (typeof envelope.detail === 'string') error.detail = envelope.detail;
    return error;
  };
  const wrap = (fn: (...args: unknown[]) => unknown) => (...args: unknown[]): unknown => {
    let answer: unknown;
    try {
      answer = fn(...args);
    } catch (reason) {
      throw decode(reason);
    }
    if (!answer || typeof (answer as { then?: unknown }).then !== 'function') return answer;
    return (answer as Promise<unknown>).then(undefined, (reason: unknown) => {
      throw decode(reason);
    });
  };
  const walk = (source: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (typeof value === 'function') target[key] = wrap(value as (...args: unknown[]) => unknown);
      else if (depth > 0 && value && typeof value === 'object')
        target[key] = walk(value as Record<string, unknown>, depth - 1);
      else target[key] = value;
    }
    return Object.freeze(target);
  };
  Object.defineProperty(globalThis, name, { value: walk(raw, 1), enumerable: true });
  return name;
}
