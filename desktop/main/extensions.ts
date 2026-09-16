// The Being Desktop subsystems the portal-desktop shell has no equivalent of.
// New on 2026-09-16; today that is the native conversation core (`chat/*`,
// ported from BeingDesktop 0.8.26), and the orchestration and tool bridges land
// here in later stages.
//
// It exists so `main.ts` grows three lines rather than fifty. Everything these
// subsystems need arrives as one context, and everything they need to be told
// about goes back as three lifecycle notifications — mirroring the three points
// BeingDesktop itself acts on: `restore()` builds the sessions object
// (src/main.cjs line 634), `startNativeChat()` binds it once the connection is
// confirmed (line 545, called from the Loom `did-finish-load` handler at line
// 926), and `shutdown()` unbinds it (line 1590).
//
// Nothing here imports electron: the window, the fetcher, the secret storage and
// the queue are all passed in, which is what lets the whole hook be exercised
// from a test without a running application.
import path from 'node:path';
import type { SecretStorage } from './app/settings';
import { ChatCache } from './chat/cache';
import { beingIdentityKey, type Connection } from './chat/connection';
import { chatPush, registerChatIpc } from './chat/ipc';
import { ChatSessions } from './chat/sessions';

/** Structural, so a `BrowserWindow` satisfies it and a test's stub does too. */
export interface ExtensionWindow {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void };
}

/** The part of `SettingsStore` these subsystems read. `connectionAddress` is the
 * address exactly as saved, including the `api=` and `relay_secret=` parameters
 * `Connection` does not model — both feed the cache identity, so the parsed
 * connection alone is not enough. */
export interface ExtensionSettings {
  connection: Connection | null;
  connectionAddress: string;
}

export interface DesktopExtensionsContext {
  /** main.ts's trusted-sender IPC wrapper: registration goes through it so every
   * channel added here inherits the same origin check and quitting guard. */
  handle: (channel: string, callback: (...args: any[]) => unknown) => void;
  /** The application's mutation queue. Handlers that change saved state use it;
   * `connectionVerified` deliberately does not — see below. */
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  window: () => ExtensionWindow | null;
  store: ExtensionSettings;
  secretStorage: SecretStorage;
  userData: string;
  desktopId: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  /** main.ts's error log. Failures here are reported, never thrown: a broken
   * conversation cache must not stop the client opening. */
  onError?: (scope: string, error: unknown) => void;
}

export interface DesktopExtensions {
  /** The Being at `store.connectionAddress` answered `/api/status`. Binds the
   * conversation layer to it — reading `/api/history` for a baseline and probing
   * for a breath already in progress — unless it is already bound to that same
   * identity, in which case the open timeline is kept as it is.
   *
   * Returns immediately. It is called from inside main.ts's `verifyConnection`,
   * which itself runs inside `exclusive`, so this must neither await the queue
   * (that would deadlock on the operation calling it) nor hold up startup while
   * a history window loads. BeingDesktop's `startNativeChat` is fire-and-forget
   * for the same reason (src/main.cjs line 550). */
  connectionVerified(connection: Connection | null): void;
  /** No Being is configured any more. Ends the conversations and flushes what is
   * still being written, so the next binding starts from a complete file. */
  connectionCleared(): Promise<void>;
  quitting(): Promise<void>;
  /** The live conversation layer, or null when it could not be built. For later
   * subsystems (Town pairing mints a scene through it) and for tests. */
  readonly chat: ChatSessions | null;
  /** Settles when the binding started by the last `connectionVerified` has
   * finished. Only tests need it; the application is driven by `onState`. */
  readonly ready: Promise<unknown>;
}

export function installDesktopExtensions(ctx: DesktopExtensionsContext): DesktopExtensions {
  const report = (scope: string, error: unknown) => { try { ctx.onError?.(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const push = chatPush(() => {
    const target = ctx.window();
    return target && !target.isDestroyed() && !target.webContents.isDestroyed() ? target.webContents : null;
  });
  // One file per Being identity, beside BeingDesktop 0.8.x's own (docs/interfaces.md §7).
  const cache = new ChatCache({ directory: path.join(ctx.userData, 'chat-cache'), safeStorage: ctx.secretStorage });

  // The verified connection, as a context the chat client re-parses per request.
  // `revision` changes only when the identity does, so a send in flight is
  // abandoned when the user switches Beings but survives re-verifying the same
  // one (reconnect, manual Portal start).
  let address = '';
  let identityKey = '';
  let revision = 0;
  let closed = false;
  let ready: Promise<unknown> = Promise.resolve();
  let blocked = '';

  let sessions: ChatSessions | null = null;
  try {
    sessions = new ChatSessions({
      desktopId: ctx.desktopId,
      clientVersion: ctx.clientVersion ?? '',
      cache,
      getContext: () => ({ connected: !closed && Boolean(address), connection: address, revision }),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      onEvent: event => push.event(event),
      onState: snapshot => push.state(snapshot),
    });
  } catch (error) {
    // The only way this throws is a Desktop identity that is not a UUID, which
    // means `desktop-id.json` could not be read or written. Scene names are built
    // from it, so there is nothing to fall back to — say which thing is broken.
    blocked = 'Desktop 身份不可用，原生对话暂时无法使用。请检查客户端配置目录后重启。';
    report('chat-identity', error);
  }

  registerChatIpc({ handle: ctx.handle, exclusive: ctx.exclusive, sessions: () => sessions, blocked: () => blocked });

  const settle = async () => {
    sessions?.end();
    // Rows already queued: ChatStore hands every change to the cache
    // synchronously, so by now flush() is waiting for writes, not racing them.
    try { await cache.flush(); } catch (error) { report('chat-cache-flush', error); }
  };

  return {
    get chat() { return sessions; },
    get ready() { return ready; },
    connectionVerified(connection) {
      const current = sessions;
      if (closed || !current) return;
      const next = ctx.store.connectionAddress || connection?.link || '';
      if (!next) return;
      let key: string;
      try { key = beingIdentityKey(next); }
      catch (error) { report('chat-identity', error); return; }
      // Set before starting: the first request reads this through getContext.
      address = next;
      if (current.open && key === identityKey) return;
      identityKey = key;
      const epoch = ++revision;
      ready = current.start(key).catch(error => {
        // A binding that has already been replaced fails by design. Only the
        // current one's failure is the user's problem.
        if (epoch === revision && !closed) report('chat-sessions-start', error);
      });
    },
    async connectionCleared() {
      address = ''; identityKey = ''; revision++;
      await settle();
    },
    async quitting() {
      if (closed) return;
      closed = true;
      await settle();
    },
  };
}
