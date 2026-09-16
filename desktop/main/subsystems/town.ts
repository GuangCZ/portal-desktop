// Town's direct reads, accumulating timeline, caches and pairing, as a
// subsystem; 2026-09-16.
//
// This is BeingDesktop 0.8.26's `boot()` lines 371-470 — the Town half of it —
// re-expressed against the installer contract in ./types.ts. Every construction
// below has a line in that file behind it, and the shapes are deliberately
// identical: the modules are ports, not rewrites, and a parameter that looks
// redundant here is usually load-bearing there.
//
// The three things that are NOT BeingDesktop, each for a settled reason:
//
//   * No Being relay. BeingDesktop falls back to `BeingTownWriter` when the
//     profile holds no client credential; integration decision §5.7 drops that
//     path, so an unpaired send raises AUTH_REQUIRED (../town/speak.ts).
//   * No `TownController`. Decision §5.2 keeps portal-desktop's own Portal
//     ownership model, so the `townApp` snapshot here carries identity, access,
//     sync, client, pairing and the member directory — not `portalInstall` or
//     `portalWorkspace`, which belong to the Portal unit.
//   * No `ChannelBeing`. The Feishu/WeChat channel belongs to a later unit; the
//     `channel` area of the session state is therefore reported as it stands
//     (`unknown` until something reads it) rather than fabricated.
//
// Everything a cache is keyed by is the Being identity — `beingIdentityKey`, the
// same string the conversation cache and the feature-task ledger bucket by, which
// is a disk format (docs/migration/i0-seams.md §G). Switching Being changes the
// key, which is what makes a stale read from the previous profile impossible to
// mistake for a current one rather than merely unlikely.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beingIdentityKey } from '../chat/connection';
import { TownBackground } from '../town/channel/town-background';
import { TownPairing } from '../town/channel/pairing-probe';
import { TownCatalog } from '../town/catalog';
import { registerTownDesktopIpc, type TownRoomStore } from '../town/ipc-desktop';
import { TownClient } from '../town/session/client';
import { TownSession } from '../town/session/session';
import { createTownSpeak } from '../town/speak';
import { BonfireCache } from '../town/timeline/bonfire-cache';
import { createCachedRoomLoaders } from '../town/timeline/cached-rooms';
import { TownCachedReads } from '../town/timeline/cached-reads';
import { TownClientStore } from '../town/timeline/client-store';
import { TownDataCache } from '../town/timeline/data-cache';
import { TownRefresh } from '../town/timeline/refresh';
import type { TownRefreshFactory } from '../town/channel/types';
import type { TownMemberCache, TownRoomCache } from '../town/timeline/cached-rooms';
import type {
  TownDesktopAppState, TownDesktopMemberCacheState, TownDesktopRefreshStatus,
  TownDesktopRoomDirectory, TownDesktopRoomMembers,
} from '../../shared/town-desktop-types';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface TownSubsystem extends DesktopSubsystem {
  readonly key: 'town';
  readonly client: TownClient;
  readonly session: TownSession;
  readonly background: TownBackground;
  readonly pairing: TownPairing;
  readonly cachedReads: TownCachedReads;
  /** `sessionPartition(connection)`. The bucket every Town cache, and every later
   * unit that partitions by Being, has to agree on. Empty when nothing is bound. */
  identityKey(): string;
  /** Drops the member caches and pushes the new metadata; returns it. */
  invalidateMembers(): TownDesktopMemberCacheState;
}

declare module './types' { interface SubsystemMap { 'town': TownSubsystem } }

/** The two pushes (docs/interfaces.md §1.3). Named here rather than inline so the
 * preload channel file and this one cannot drift apart silently. */
const MESSAGES = 'beings:town-messages';
const MEMBERS_INVALIDATED = 'beings:town-members-invalidated';

const EMPTY_ROOMS = (): TownRoomCache => ({ owned: [], joined: [], cached: false });

export function installTownSubsystem(ctx: SubsystemContext): TownSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const safeStorage = ctx.electron.safeStorage;

  // The live connection, as every Town module reads it. `revision` is the epoch a
  // request is fenced against: it changes when the bound identity does, so a read
  // in flight is discarded across a Being switch but survives re-verifying the
  // same Being (reconnect, manual Portal start). `identityRevision` is the second
  // axis BeingDesktop fences on — the Being's own profile changing under a stable
  // connection — and moves when the member directory is invalidated.
  let address = '';
  let identityKey = '';
  let beingName = '';
  let revision = 0;
  let identityRevision = 0;
  let connected = false;
  let exiting = false;
  let suspended = false;

  let roomCache: TownRoomCache = EMPTY_ROOMS();
  const memberCache = new Map<string, TownMemberCache>();

  // <userData>/town-client, byte-compatible with BeingDesktop 0.8.x's own file.
  const store = new TownClientStore({ directory: path.join(ctx.userData, 'town-client'), safeStorage });

  const publish = () => { try { ctx.push('beings:town-state', state()); } catch (error) { report('town-publish', error); } };

  const client = new TownClient({
    getContext: () => ({ key: identityKey, beingId: beingName, revision, connected: !exiting && connected }),
    store,
    fetchImpl: (url, options) => ctx.electron.net.fetch(url as string, options),
    onChange: () => publish(),
    onEvent: event => {
      // A profile rename invalidates the directory and nothing else: the feeds
      // themselves have not changed, so they are deliberately not disturbed.
      if (event?.type === 'profile_changed') { invalidateMembers(); return; }
      background.notifyEvent(event);
      // The inbox is not part of background collection. The renderer re-reads it
      // on this hint; the direct message itself never leaves the main process
      // (docs/town-sdk-integration.md「私信与回复」).
      if (event?.type === 'dm') ctx.push(MESSAGES, { kind: 'dm' });
    },
  });

  // ── THE WRAPPER THAT MUST STAY ─────────────────────────────────────────────
  // `TownSession._request` sets no `referrerPolicy` of its own; BeingDesktop adds
  // it in the injected fetcher (src/main.cjs line 399). Drop this wrapper and
  // every Town read carries a referrer.
  const session = new TownSession({
    getContext: () => ({
      configured: Boolean(address), connected, exiting,
      connectionId: revision, identityRevision, beingName,
      townId: client.state().townId,
    }),
    writeImpl: request => townSpeak(request),
    getIdentity: options => client.identity(options),
    fetchImpl: (url, options) => ctx.electron.net.fetch(url as string, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer' }),
    readImpl: (route, options) => client.read(route, options),
    onChange: () => publish(),
  });

  const townSpeak = createTownSpeak({ client });

  const bonfireCache = new BonfireCache({ directory: path.join(ctx.userData, 'bonfire-cache'), safeStorage });
  const dataCache = new TownDataCache({ directory: path.join(ctx.userData, 'town-data-cache'), safeStorage });
  const cachedReads = new TownCachedReads({
    cache: dataCache,
    getContext: () => ({ identityKey, revision, identityRevision, connected: !exiting && connected }),
  });

  // ── THE LOOSE SEAMS ────────────────────────────────────────────────────────
  // The three ported units were written against each other without being able to
  // see each other: TownBackground declares the reader, the session and the room
  // caches as the CALL SURFACE it uses (../town/channel/types.ts), with index
  // signatures and `unknown[]` where a field's shape belongs to the other unit.
  // The real objects are narrower than those declarations, not wider — this is
  // the assembly point where the two descriptions of one object meet, and the
  // conversions below are that and nothing else. Each is a `structurally the same
  // value, differently described` cast, made once, named, and never spread into
  // the modules themselves; the runtime shapes are the ones the ported units'
  // own tests pin down.
  const asRefresh = (value: TownRefresh) => value as unknown as ReturnType<TownRefreshFactory>;
  const asBackgroundSession = (value: TownSession) => value as unknown as ConstructorParameters<typeof TownBackground>[0]['townSession'];
  const asDirectory = (value: TownRoomCache) => value as unknown as TownDesktopRoomDirectory;
  const asMembers = (value: TownMemberCache) => value as unknown as TownDesktopRoomMembers;
  const asStatus = (value: unknown) => value as TownDesktopRefreshStatus | null;

  const createRefresh: TownRefreshFactory = options => asRefresh(new TownRefresh(options as unknown as ConstructorParameters<typeof TownRefresh>[0]));

  const background = new TownBackground({
    townSession: asBackgroundSession(session), bonfireCache, getCacheKey: () => identityKey,
    // `direct: true` is what makes this an SDK client rather than a Being relay:
    // it polls, it pages backwards, and it reacts to stream events.
    direct: true, limit: 50,
    getIdentity: () => address ? { beingId: beingName, connectionRevision: revision, identityRevision } : null,
    onStatus: () => publish(),
    onUpdate: value => ctx.push(MESSAGES, value),
    createRefresh,
  });

  const pairing = new TownPairing({
    client,
    getContext: () => ({ connection: address, revision, connected: !exiting && connected }),
    // The one-time code arrives as an ordinary Being reply, so it needs a scene of
    // its own; in native mode that scene is a real conversation the user can open
    // to read a late answer (docs/town-sdk-integration.md「配对与权限」).
    createScene: () => {
      const sessions = ctx.registry.get('chat')?.sessions;
      const id = sessions?.open ? sessions.create({ title: 'Town 配对' }) : '';
      return `desktop-${ctx.desktopId}-${id || randomUUID()}`;
    },
    fetchImpl: (url, options) => ctx.electron.net.fetch(url as string, options),
    onChange: () => publish(),
  });

  const roomLoaders = createCachedRoomLoaders({
    reads: cachedReads,
    getRooms: () => roomCache,
    setRooms: value => { roomCache = value; },
    members: memberCache,
    getRevisions: () => ({ generation: revision, identityRevision }),
    reconcileRooms: value => background.reconcileRooms(value as { owned?: { id: unknown }[]; joined?: { id: unknown }[] }),
  });

  /** The live half of the room store: a real read, then the caches the cached
   * half answers from. src/main.cjs lines 1359 and 1305. */
  const rooms: TownRoomStore = {
    async cachedFiresides() { return asDirectory(await roomLoaders.loadCachedFiresides()); },
    async cachedFiresideMembers(value) { return asMembers(await roomLoaders.loadCachedFiresideMembers(value)); },
    async readFiresides() {
      const directory = await cachedReads.read('getFiresides', undefined, () => session.getFiresides());
      roomCache = { ...directory, cached: true, lastSuccessAt: Date.now() } as unknown as TownRoomCache;
      background.reconcileRooms(directory);
      return asDirectory(structuredClone(roomCache));
    },
    async readFiresideMembers(firesideId) {
      const members = await cachedReads.read('getFiresideMembers', firesideId, id => session.getFiresideMembers(id));
      memberCache.set(firesideId, { ...members, cached: true, lastSuccessAt: Date.now() });
      return asMembers(structuredClone(memberCache.get(firesideId)!));
    },
  };

  function invalidateMembers(): TownDesktopMemberCacheState {
    memberCache.clear();
    cachedReads.invalidateMembers();
    const metadata = session.invalidateMembers();
    // `identityRevision` is deliberately NOT bumped here, and BeingDesktop does not
    // bump it either (src/main.cjs line 455): it is part of `background.getIdentity()`,
    // so raising it would read as a new identity three layers down — TownRefresh
    // would drop the accumulated timeline (town/timeline/refresh.ts line 533),
    // TownBackground would stop and reset the bonfire reader (town/channel/
    // town-background.ts line 163), and every in-flight read would fail
    // `_assertCurrent` with SESSION_CHANGED. A rename changes names, not feeds.
    // The two caches fence themselves: TownCachedReads bumps its own members
    // revision and TownSession fences its own directory.
    ctx.push(MEMBERS_INVALIDATED, metadata);
    publish();
    return metadata;
  }

  function state(): TownDesktopAppState {
    const areas = session.state();
    const clientState = client.state();
    const area = (name: string) => areas[name] ?? { status: 'unknown', detail: '' };
    const sync = background.metadata();
    return {
      identity: {
        beingId: clientState.townId || beingName,
        loomBeingId: beingName,
        townId: clientState.townId || '',
        displayName: session.memberDisplayName(clientState.townId) || clientState.displayName || '',
        sendAs: clientState.townId || beingName,
        connectionRevision: revision,
        identityRevision,
      },
      access: {
        bonfire: area('bonfire').status,
        fireside: area('fireside').status,
        firesideRead: area('fireside').status,
        // Sending needs the connection, not a previous read: an area nobody has
        // read yet is `unknown`, which would otherwise disable the composer.
        firesideSend: connected ? 'ready' : 'disconnected',
        scroll: area('scroll').status,
        beings: area('beings').status,
        inbox: area('inbox').status,
      },
      accessDetail: {
        bonfire: area('bonfire').detail,
        fireside: area('fireside').detail,
        scroll: area('scroll').detail,
        beings: area('beings').detail,
        inbox: area('inbox').detail,
      },
      bonfire: area('bonfire'),
      fireside: area('fireside'),
      scroll: area('scroll'),
      beings: area('beings'),
      inbox: area('inbox'),
      sync: { bonfire: asStatus(sync.bonfire), fireside: asStatus(sync.fireside) },
      client: clientState,
      pairing: pairing.state(),
      memberDirectory: session.memberCacheState(),
    };
  }

  /** src/main.cjs `syncTownLifecycle` (line 461), including its two conditions.
   * `net.isOnline()` is in there because a poll against a down interface is not a
   * failure worth counting — the reader pauses instead, and `reason` says why. */
  function syncLifecycle() {
    const enabled = !exiting && !suspended && Boolean(address) && connected && ctx.electron.net.isOnline();
    try { client.lifecycle({ enabled }); } catch (error) { report('town-client-lifecycle', error); }
    try { background.lifecycle({ enabled, reason: suspended ? 'suspended' : 'offline' }); } catch (error) { report('town-background-lifecycle', error); }
  }

  ctx.electron.powerMonitor?.on('suspend', () => { suspended = true; syncLifecycle(); });
  // Waking re-establishes the stream and recalibrates. It deliberately does not
  // resend anything: BeingDesktop's resume path is read-only (src/main.cjs 1734).
  ctx.electron.powerMonitor?.on('resume', () => { suspended = false; syncLifecycle(); });

  registerTownDesktopIpc({
    handle: ctx.handle, client, session, background, pairing, cachedReads, rooms,
    catalog: new TownCatalog(ctx.fetchImpl),
    speak: townSpeak,
    state,
    revisions: () => ({ generation: revision, identityRevision }),
    paired: () => {
      // src/main.cjs `pairedTown`: the session's cached areas were decided under
      // the previous credential, the lifecycle may now be allowed to run, and the
      // first read should happen now rather than at the next poll.
      session.reset();
      syncLifecycle();
      void background.notifyEvent({ type: 'hello' });
      publish();
    },
    invalidateMembers,
    // A TOWN PAGE OPENS IN THE TOOL BROWSER, not the system browser.
    // BeingDesktop 0.8.26: `handle('openTownPage', id => browserLinks().open(
    // townPageUrl(id)))` (src/main.cjs:1252) — the page lands in a tab beside the
    // conversation, where the Being can also read it, and the panel comes forward.
    // I1 had no tool bridge in its worktree and used `shell.openExternal`,
    // recorded as a deviation (docs/migration/i1-town.md 遗留 2); the bridge is
    // merged now, so this is the deviation being closed (IM, 2026-09-16).
    //
    // Resolved lazily — `INSTALLERS` order carries no meaning — and the fallback
    // is only for a build with no tool bridge at all (no Electron to give it a
    // browser, or its installation failed): a link the user asked for should still
    // open somewhere rather than silently do nothing. A failure INSIDE `open`
    // (the window is gone, the address is refused) throws, exactly as 0.8.26's
    // does; it is not a reason to send the user to another browser.
    // The route allow-list stays in town/ipc-desktop.ts, untouched.
    openExternal: url => {
      const links = ctx.registry.get('tools')?.links;
      if (links) { links.open(url); return; }
      return ctx.electron.shell.openExternal(url);
    },
  });

  let ready: Promise<unknown> = Promise.resolve();

  const clearIdentity = () => {
    roomCache = EMPTY_ROOMS();
    memberCache.clear();
  };

  return {
    key: 'town',
    client, session, background, pairing, cachedReads,
    identityKey: () => identityKey,
    invalidateMembers,
    get ready() { return ready; },
    connectionVerified(connection) {
      if (exiting) return;
      const next = ctx.store.connectionAddress || connection?.link || '';
      if (!next) {
        // Verified with nothing bound: end what is open rather than keep polling
        // a Being that is no longer configured.
        address = ''; identityKey = ''; beingName = ''; connected = false;
        revision++; identityRevision++;
        pairing.reset(); client.reset(); session.reset(); clearIdentity();
        background.lifecycle({ enabled: false, reason: 'offline' });
        publish();
        return;
      }
      let key: string;
      try { key = beingIdentityKey(next); }
      catch (error) { report('town-identity', error); return; }
      const switched = key !== identityKey;
      address = next;
      beingName = connection?.being || beingName;
      connected = true;
      if (switched) {
        identityKey = key;
        revision++;
        identityRevision++;
        pairing.reset();
        client.reset();
        session.reset();
        clearIdentity();
      }
      syncLifecycle();
      // Restoring the encrypted timeline is what puts messages on screen before
      // the first network read. It is awaited by tests only; the application is
      // driven by the pushes that follow it.
      ready = background.restore().catch(error => report('town-restore', error));
      publish();
    },
    async connectionCleared() {
      address = ''; identityKey = ''; beingName = ''; connected = false;
      revision++; identityRevision++;
      pairing.reset();
      client.reset();
      session.reset();
      background.stop();
      clearIdentity();
      publish();
    },
    async quitting() {
      if (exiting) return;
      exiting = true;
      connected = false;
      try { client.lifecycle({ enabled: false }); } catch (error) { report('town-client-lifecycle', error); }
      background.stop();
      // Rows already queued: both caches hand every change to their own writer
      // synchronously, so by now flush() waits for writes rather than racing them.
      try { await bonfireCache.flush(); } catch (error) { report('town-bonfire-flush', error); }
      try { await dataCache.flush(); } catch (error) { report('town-data-flush', error); }
    },
  };
}
