// The native conversation core, as a subsystem; 2026-09-16.
//
// The body is `extensions.ts`'s, moved here unchanged when the I0 seam stage
// turned that file into a registry. It is the first user of the installer
// contract in `./types.ts`, and the template every later unit copies.
//
// Ported behaviour, unchanged from P1: BeingDesktop 0.8.26 `restore()` builds the
// sessions object (src/main.cjs line 634), `startNativeChat()` binds it once the
// connection is confirmed (line 545, called from the Loom `did-finish-load`
// handler at line 926), and `shutdown()` unbinds it (line 1590).
import path from 'node:path';
import { ChatCache } from '../chat/cache';
import { beingIdentityKey } from '../chat/connection';
import { chatPush, registerChatIpc } from '../chat/ipc';
import { ChatSessions } from '../chat/sessions';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ChatSubsystem extends DesktopSubsystem {
  /** The live conversation layer, or null when it could not be built. Later
   * subsystems reach it through the registry — Town pairing mints a scene through
   * it, orchestration reads its session ids — and so do tests. */
  readonly sessions: ChatSessions | null;
}

declare module './types' { interface SubsystemMap { 'chat': ChatSubsystem } }

export function installChatSubsystem(ctx: SubsystemContext): ChatSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  // `ctx.push` already applies the destroyed-window guard, so the target is
  // unconditional here; the two channel names stay in chat/ipc.ts.
  const push = chatPush(() => ({ send: ctx.push }));
  // One file per Being identity, beside BeingDesktop 0.8.x's own (docs/interfaces.md §7).
  const cache = new ChatCache({ directory: path.join(ctx.userData, 'chat-cache'), safeStorage: ctx.electron.safeStorage });

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
      clientVersion: ctx.clientVersion,
      cache,
      getContext: () => ({ connected: !closed && Boolean(address), connection: address, revision }),
      fetchImpl: ctx.fetchImpl,
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
    key: 'chat',
    get sessions() { return sessions; },
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
