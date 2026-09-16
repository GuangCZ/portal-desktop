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
//
// I5 (2026-09-16) filled the four holes P1 left in that constructor —
// `prepareMessage`, `generateTitle`, `titleAvailability`, `getWorkerResults` —
// and added the explanation cards beside it (src/main.cjs line 642). All four
// need the worker manager, and the manager needs this subsystem's sessions, so
// every one of them reaches it through `ctx.registry` inside a closure. A
// construction-time lookup would resolve to null for whichever half installs
// first; that is the rule at the top of ./types.ts and this file is the reason
// it exists.
import path from 'node:path';
import { ChatCache } from '../chat/cache';
import { beingIdentityKey } from '../chat/connection';
import { composerData } from '../chat/composer-data';
import { ChatDetails } from '../chat/details';
import { chatDetailPush, registerChatDetailsIpc } from '../chat/details-ipc';
import { desktopEnvironment } from '../chat/environment';
import { chatPush, registerChatIpc } from '../chat/ipc';
import { nativeMessageContext } from '../chat/prepare-message';
import { ChatSessions } from '../chat/sessions';
import { sanitizeText } from '../common/sanitize';
import { localKits } from '../kits/catalog';
// A pure projection of the worker ledger (BeingDesktop src/native-worker-results.cjs),
// ported by the orchestration unit. Imported as a function rather than reached
// through the registry because it holds no state and belongs to neither side:
// the ledger is the manager's, the conversation it is projected into is ours.
import { nativeWorkerResults } from '../orchestration/native-worker-results';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ChatSubsystem extends DesktopSubsystem {
  /** The live conversation layer, or null when it could not be built. Later
   * subsystems reach it through the registry — Town pairing mints a scene through
   * it, orchestration reads its session ids — and so do tests. */
  readonly sessions: ChatSessions | null;
  /** The explanation cards: a separate, never-persisted scene namespace opened
   * from a selection in the transcript. */
  readonly details: ChatDetails | null;
}

declare module './types' { interface SubsystemMap { 'chat': ChatSubsystem } }

export function installChatSubsystem(ctx: SubsystemContext): ChatSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  // `ctx.push` already applies the destroyed-window guard, so the target is
  // unconditional here; the two channel names stay in chat/ipc.ts.
  const push = chatPush(() => ({ send: ctx.push }));
  const pushDetail = chatDetailPush(() => ({ send: ctx.push }));
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

  // ── The peers, every one of them lazy (./types.ts, THE ONE RULE) ────────────
  const orchestration = () => ctx.registry.get('orchestration')?.orchestration ?? null;
  const tools = () => ctx.registry.get('tools')?.tools ?? null;
  const town = () => ctx.registry.get('town') ?? null;
  const context = () => ({ connected: !closed && Boolean(address), connection: address, revision });
  /** The worker ledger is this Being's only while the conversation layer and the
   * manager agree on whose it is. BeingDesktop checks the same pair before every
   * projection and before every preview (src/main.cjs lines 637 and 1210): a
   * Worker started under the previous Being must not surface under this one. */
  const sameIdentity = () => {
    const manager = orchestration();
    return Boolean(address) && !closed && Boolean(manager) && sessions?.identityKey === manager!.owner;
  };

  let sessions: ChatSessions | null = null;
  try {
    sessions = new ChatSessions({
      desktopId: ctx.desktopId,
      clientVersion: ctx.clientVersion,
      cache,
      getContext: context,
      fetchImpl: ctx.fetchImpl,
      onEvent: event => push.event(event),
      onState: snapshot => push.state(snapshot),
      // The request context frame. Everything in it is read here, in the main
      // process, at the moment of the send — IPC cannot supply a scope or
      // override the execution policy (src/orchestration-message.cjs line 39).
      prepareMessage: nativeMessageContext({
        orchestration,
        environment: desktopEnvironment({
          desktopId: ctx.desktopId,
          clientVersion: ctx.clientVersion,
          settings: () => ctx.store.settings,
          bridge: () => tools()?.link.capabilities(),
          terminalTools: () => tools()?.terminalTools,
          orchestration,
          inspectPolicy: async () => ctx.registry.get('orchestration')?.policy.inspectForMessage() ?? { status: 'disabled', scope: 'desktop' },
          // NOT WIRED, and the frame says so in the safe direction: every
          // message currently tells the Being「Portal 未配置 / 健康状况未知」.
          //
          // Integration decision §5.2 assigns this mapping to this unit and
          // `chat/environment.ts` carries it in full — `portalRuntime`, nine
          // rows, pinned line by line by tests/chat-integration-environment.ts.
          // The input arrived on 2026-09-17 (integration unit IN): main.ts keeps
          // `PortalSupervisor` in its own closure and passes a reader for it as
          // `SubsystemContext.portalState`. Read at call time, never captured —
          // the supervisor replaces `state` on every transition, so holding the
          // object would freeze the frame at whatever the Portal was doing when
          // this subsystem was installed. Absent in a context that models no
          // supervisor, and「未配置 / 未知」is what the frame said before this
          // existed (docs/migration/i5-conversation.md §7.1).
          getPortalState: () => ctx.portalState?.() ?? null,
        }),
      }),
      // A conversation names itself from its first exchange, through whichever
      // CLI worker is installed. The input is redacted first: a title job runs an
      // external process, and this Being's credentials must not travel in its
      // prompt (src/main.cjs line 635).
      generateTitle: (id, input) => {
        const manager = orchestration();
        if (!manager) return Promise.resolve('');
        const connection = ctx.store.connection;
        return manager.generateTitle(id, sanitizeText(input, [connection?.token, connection?.relaySecret]));
      },
      // A fingerprint, not a flag: the title scheduler re-runs when it changes.
      // It moves when the manager's revision does or when the set of ready agents
      // does, and it is empty — meaning「现在没有可用的命名器」— while the
      // ledger belongs to another Being (src/main.cjs line 636).
      titleAvailability: () => {
        const manager = orchestration();
        if (closed || !manager || !sameIdentity()) return '';
        const ready = manager.agents.filter(agent => agent.status === 'ready');
        return ready.length ? JSON.stringify([manager.revision, ready.map(agent => [agent.id, agent.path])]) : '';
      },
      getWorkerResults: id => {
        const manager = orchestration();
        return manager && sameIdentity() ? nativeWorkerResults(manager.workers, id) : [];
      },
    });
  } catch (error) {
    // The only way this throws is a Desktop identity that is not a UUID, which
    // means `desktop-id.json` could not be read or written. Scene names are built
    // from it, so there is nothing to fall back to — say which thing is broken.
    blocked = 'Desktop 身份不可用，原生对话暂时无法使用。请检查客户端配置目录后重启。';
    report('chat-identity', error);
  }

  // The cards share this subsystem's connection but not its store: a fresh random
  // Desktop id per generation means `sessionFromScene` can never resolve one of
  // their scenes, and no cache is passed, so nothing they say reaches disk.
  const details = new ChatDetails({
    clientVersion: ctx.clientVersion,
    getContext: context,
    hasParent: id => Boolean(sessions?.open) && sessions!.snapshot().sessions.some(item => item.id === id),
    fetchImpl: ctx.fetchImpl,
    onEvent: event => pushDetail(event),
  });

  registerChatIpc({
    handle: ctx.handle, exclusive: ctx.exclusive, sessions: () => sessions, blocked: () => blocked,
    // `connection().revision` is echoed to the renderer as `connectionRevision`
    // and comes back on a public mention, where main/town/ipc-desktop.ts compares
    // it with the TOWN subsystem's own generation. BeingDesktop reads one
    // shell-wide `generation` at both ends (src/main.cjs line 1336); here they are
    // two counters that have to move together, which they do because both are
    // driven by the same `connectionVerified`/`connectionCleared` fan-out and both
    // move exactly when the bound identity does. Drift would be silent — every
    // `@` mention refused as「Being 连接已变化。」 — so the pair is asserted end to
    // end in tests/chat-integration-composer.test.ts rather than left to reading.
    composerData: composerData({
      readKits: () => localKits(ctx.store.settings),
      readMembers: async options => {
        const session = town()?.session;
        // Not installed and not paired read the same way to the composer: the
        // directory is unavailable, the built-in abilities still are not.
        if (!session) throw new Error('Being 成员暂时无法加载。');
        return session.getMembers(options);
      },
      memberCacheState: () => town()?.session.memberCacheState() ?? { revision: 0, expiresAt: 0 },
      connection: () => ({ connected: !closed && Boolean(address), revision }),
    }),
  });
  registerChatDetailsIpc({
    handle: ctx.handle,
    details: () => details,
    openWorkerResult: async ({ sessionId, workerId }) => {
      // The conversation first, exactly as src/main.cjs line 1209 does it: a
      // preview for a conversation this Being does not have is refused by the
      // conversation layer's own「会话不存在。」rather than by the manager.
      const current = sessions;
      if (!current || !current.open) throw Object.assign(new Error(blocked || '请先连接 Being。'), { code: 'NOT_CONNECTED' });
      current.view(sessionId);
      const manager = orchestration();
      if (!manager || !sameIdentity()) throw new Error('Being 连接已变化。');
      return manager.openResult(workerId, sessionId);
    },
  });

  const settle = async () => {
    // The cards first: they hold their own reader and their own scenes, and a card
    // still streaming would keep writing into a layer that is being taken down.
    details.reset();
    sessions?.end();
    // Rows already queued: ChatStore hands every change to the cache
    // synchronously, so by now flush() is waiting for writes, not racing them.
    try { await cache.flush(); } catch (error) { report('chat-cache-flush', error); }
  };

  return {
    key: 'chat',
    get sessions() { return sessions; },
    get details() { return details; },
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
      // A rebinding takes the cards with it (src/main.cjs line 549, inside
      // `startNativeChat`): their parent conversations belong to the Being that
      // is being replaced.
      details.reset();
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
