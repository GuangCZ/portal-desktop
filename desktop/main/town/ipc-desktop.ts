// Town's direct reads, timeline, pairing and sends, as IPC; 2026-09-16.
//
// Ported channel for channel from BeingDesktop 0.8.26 src/main.cjs lines
// 1256-1372 (`pairTownClient` … `sendFiresideMessage`). The names change from
// `being:<camelCase>` to `beings:<kebab-case>`, which is this shell's convention
// (MIGRATION.md); the semantics do not.
//
// Registration goes through the `handle` wrapper main.ts supplies, so every
// channel inherits the sender check (main frame of the trusted shell URL only)
// and the quitting guard. None of them takes the mutation queue: BeingDesktop
// marks no Town read or send「串行」(docs/interfaces.md §1.2) — the credential
// store serializes its own writes, and holding the application queue across a
// network read would stall settings saves behind Town.
//
// ── THE ENVELOPE ──────────────────────────────────────────────────────────────
// Every channel below except the two public-catalogue ones answers a failure with
// `{__townError:true, code, message}` rather than throwing, because a `code`
// cannot survive an Error crossing IPC. That is the same mechanism the
// conversation channels use; the catalogue of codes is Town's own
// (desktop/shared/town-desktop-errors.ts). A `NOT_SENT` rejection additionally
// carries the recipients Town offered instead.
//
// ── VALIDATION ────────────────────────────────────────────────────────────────
// Arguments are untrusted. Each is checked structurally — a plain object, no key
// outside the whitelist, declared types — before it reaches a Town module. Where
// BeingDesktop already validates inside the module (`TownSession.plainRequest`,
// `TownCachedReads.resource`, `TownClient.speak`), that check is NOT duplicated
// here: one place owns each limit, and a second copy is one more thing to drift.
// What is checked here is what BeingDesktop checked here — the read selector, the
// send envelope, the member options — plus one addition noted at `speak`.
import type { TownCachedReads } from './timeline/cached-reads';
import type { TownBackground } from './channel/town-background';
import type { TownPairing } from './channel/pairing-probe';
import type { TownClient } from './session/client';
import type { TownSession } from './session/session';
import type { TownCatalog } from './catalog';
import { TOWN_LINK, TOWN_ORIGIN } from './catalog';
import type { TownSpeakRequest } from './speak';
import { townErrorEnvelope } from '../../shared/town-desktop-errors';
import type {
  TownDesktopAppState, TownDesktopMemberCacheState, TownDesktopReadResult,
  TownDesktopRoomDirectory, TownDesktopRoomMembers,
} from '../../shared/town-desktop-types';
import type { TownQuery } from '../../shared/types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

/** The room and member caches, which live in the subsystem beside the stores they
 * read. The two `cached*` members answer from disk without a network read (they
 * are what the renderer paints before the first refresh lands); the two `read*`
 * members do the live read and update those caches. */
export interface TownRoomStore {
  cachedFiresides(): Promise<TownDesktopRoomDirectory>;
  cachedFiresideMembers(firesideId: string): Promise<TownDesktopRoomMembers>;
  readFiresides(): Promise<TownDesktopRoomDirectory>;
  readFiresideMembers(firesideId: string): Promise<TownDesktopRoomMembers>;
}

export interface TownDesktopIpcOptions {
  handle: RegisterHandler;
  client: TownClient;
  session: TownSession;
  background: TownBackground;
  pairing: TownPairing;
  cachedReads: TownCachedReads;
  rooms: TownRoomStore;
  /** The anonymous public reader (./catalog.ts). */
  catalog: TownCatalog;
  /** `createTownSpeak(...)`'s product. */
  speak: (request: TownSpeakRequest) => Promise<unknown>;
  /** The `townApp` snapshot (docs/interfaces.md §4). */
  state: () => TownDesktopAppState;
  /** The connection epoch a request is fenced against. */
  revisions: () => { generation: number; identityRevision: number };
  /** After a pairing change: BeingDesktop's `pairedTown` tail (src/main.cjs 1256). */
  paired: () => void;
  /** Clears the member caches and pushes the new metadata. */
  invalidateMembers: () => TownDesktopMemberCacheState;
  /** The shell's external opener, for the public Town pages. */
  openExternal: (url: string) => Promise<void> | void;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });
const changed = (): Error => Object.assign(new Error('Being 连接已变化。'), { code: 'SESSION_CHANGED' });

/** A plain object with no key outside `allowed`. An unknown field is refused
 * rather than dropped — it means the renderer and this contract disagree, and
 * guessing which is right is how a stale renderer silently loses a parameter. */
function fields(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!plain(value)) throw invalid(message);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) throw invalid(message);
  }
  return value as Record<string, unknown>;
}

/** src/main.cjs `memberOptions` (line 1266), unchanged. */
function memberOptions(value: unknown): { force: boolean } {
  const input = fields(value, ['force'], '成员刷新参数无效。');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw invalid('成员刷新参数无效。');
  return { force: input.force === true };
}

const SPEAK_KINDS = ['bonfire', 'fireside', 'dm'] as const;
const SPEAK_FIELDS: Record<(typeof SPEAK_KINDS)[number], readonly string[]> = {
  bonfire: ['kind', 'content', 'mentions', 'connectionRevision', 'requestId', 'replyTo'],
  fireside: ['kind', 'firesideId', 'content', 'connectionRevision', 'requestId', 'replyTo'],
  dm: ['kind', 'recipient', 'content', 'connectionRevision', 'replyTo'],
};

export function registerTownDesktopIpc(options: TownDesktopIpcOptions) {
  const { handle, client, session, background, pairing, cachedReads, rooms, catalog, speak, state, revisions, paired, invalidateMembers, openExternal } = options;

  /** Registration for a channel that resolves with an envelope on failure. */
  const enveloped = (channel: string, callback: (...args: any[]) => unknown) =>
    handle(channel, async (...args: unknown[]) => {
      try { return await callback(...args); }
      catch (error) { return townErrorEnvelope(error); }
    });

  /** The epoch guard BeingDesktop repeats inside every multi-step handler: a
   * result assembled across two reads is discarded if the Being changed between
   * them, rather than mixed. */
  const fence = () => {
    const { generation, identityRevision } = revisions();
    return () => {
      const now = revisions();
      if (now.generation !== generation || now.identityRevision !== identityRevision) throw changed();
    };
  };

  // ── state ──────────────────────────────────────────────────────────────────
  // BeingDesktop leaves `getTownAppState` / `refreshTownApp` outside the envelope
  // (src/main.cjs line 125's `townMethods` does not list them). They are
  // enveloped here, per the integration plan §3.1 table: the refresh re-reads the
  // paired identity, which can fail with `AUTH_REQUIRED`, and that is a code the
  // pairing panel branches on rather than a sentence it prints.
  enveloped('beings:town-app', () => state());
  enveloped('beings:town-app-refresh', async () => {
    // BeingDesktop refreshed the Portal deployment here (`town.refresh()`, the
    // TownController). Integration decision §5.2 drops that module, so what this
    // refreshes is what this unit owns: the paired identity behind the state.
    try { await client.identity({ force: true }); }
    catch (error) { if ((error as { code?: unknown }).code !== 'AUTH_REQUIRED') throw error; }
    return state();
  });

  // ── timeline ───────────────────────────────────────────────────────────────
  // The cached snapshot is what the renderer paints first, before any request:
  // for a fireside the room directory has to be restored first, or the reader
  // would refuse a room it cannot yet see in the directory.
  enveloped('beings:town-timeline', async (value: unknown) => {
    if (plain(value) && value.kind === 'fireside') await rooms.cachedFiresides();
    return background.cachedSnapshot(value);
  });
  enveloped('beings:town-timeline-refresh', (value: unknown) => background.refresh(value));
  enveloped('beings:town-timeline-older', (value: unknown) => background.loadOlder(value));

  // ── one explicit read ──────────────────────────────────────────────────────
  // src/main.cjs line 1290 `requestTownRead`, including its two conditional
  // field rules: `selectionRevision` and `includeRooms` belong to a fireside read
  // and to nothing else.
  enveloped('beings:town-read', async (value: unknown): Promise<TownDesktopReadResult> => {
    const request = fields(value, ['kind', 'firesideId', 'selectionRevision', 'includeRooms'], '请选择有效的消息来源。');
    if (!['bonfire', 'fireside'].includes(request.kind as string)) throw invalid('请选择有效的消息来源。');
    if (Object.hasOwn(request, 'selectionRevision') && (request.kind !== 'fireside' || !Number.isSafeInteger(request.selectionRevision) || (request.selectionRevision as number) < 0)) throw invalid('请选择有效的消息来源。');
    if (Object.hasOwn(request, 'includeRooms') && (request.kind !== 'fireside' || typeof request.includeRooms !== 'boolean')) throw invalid('请选择有效的消息来源。');
    const current = fence();
    const firesideId = request.firesideId as string | undefined;
    if (request.kind === 'fireside' && (!firesideId || request.includeRooms)) {
      const directory = await rooms.readFiresides();
      current();
      if (!firesideId) return { rooms: directory };
      if (![...directory.owned, ...directory.joined].some(room => String(room.id) === firesideId)) return { rooms: directory, removed: true };
    }
    const feed = { kind: request.kind, ...(firesideId === undefined ? {} : { firesideId }) };
    // TownBackground describes its envelope with the loose injection type its own
    // unit was written against; the narrow DTO is what it actually produces (see
    // the seam note in subsystems/town.ts).
    const envelope = await background.requestRead(feed) as unknown as TownDesktopReadResult['envelope'];
    current();
    if (request.kind !== 'fireside') return { envelope };
    const members = await rooms.readFiresideMembers(firesideId as string);
    current();
    return { envelope, members };
  });

  // ── plain reads ────────────────────────────────────────────────────────────
  enveloped('beings:town-bonfire', (value: unknown) => session.getBonfireMessages(value));
  enveloped('beings:town-fireside-messages', (value: unknown) => session.getFiresideMessages(value));
  enveloped('beings:town-firesides', () => rooms.readFiresides());
  enveloped('beings:town-fireside-members', (value: unknown) => cachedReads.read('getFiresideMembers', value, id => session.getFiresideMembers(id)));
  enveloped('beings:town-inbox', () => session.getDirectMessages());
  enveloped('beings:town-beings', (value: unknown) => cachedReads.read('listBeings', value, query => session.listBeings(query)));
  enveloped('beings:town-scrolls', (value: unknown) => cachedReads.read('listScrolls', value, query => session.listScrolls(query)));
  enveloped('beings:town-scroll', (value: unknown) => cachedReads.read('getScroll', value, query => session.getScroll(query)));
  enveloped('beings:town-cached', (value: unknown) => cachedReads.snapshot(value));

  enveloped('beings:town-members', async (value: unknown) => {
    const data = await cachedReads.read('getBeingMembers', undefined, () => session.getMembers(memberOptions(value)));
    return { ...data, ...session.memberCacheState() };
  });

  // Called after a local rename succeeded. It performs no rename and sends no
  // message: it re-reads the authenticated profile and tells every consumer the
  // directory is stale (src/main.cjs line 1278).
  enveloped('beings:town-profile-changed', async () => {
    const metadata = invalidateMembers();
    try { await client.identity({ force: true }); }
    catch (error) { if ((error as { code?: unknown }).code !== 'AUTH_REQUIRED') throw error; }
    return metadata;
  });

  // ── sending ────────────────────────────────────────────────────────────────
  // BeingDesktop has three channels here; this shell has one, discriminated by
  // `kind`, because all three carry the same envelope and the renderer's composer
  // is one component.
  //
  // ADDITION over BeingDesktop: `connectionRevision` is required on all three and
  // checked against the live epoch before anything is sent. 0.8.26 requires it on
  // bonfire (TownSession checks it) and carries it unused on fireside, and its
  // direct-message path has no epoch at all. A message composed under the previous
  // Being must not be delivered as the current one, and the composer always knows
  // which revision it was showing — so the rule is applied to all three
  // (integration plan §3.1: 「connectionRevision 必须等于当前 revision，否则拒绝」).
  enveloped('beings:town-speak', (value: unknown) => {
    if (!plain(value) || !SPEAK_KINDS.includes(value.kind as (typeof SPEAK_KINDS)[number])) throw invalid('发送参数无效。');
    const kind = value.kind as (typeof SPEAK_KINDS)[number];
    const request = fields(value, SPEAK_FIELDS[kind], '发送参数无效。');
    if (!Number.isSafeInteger(request.connectionRevision) || (request.connectionRevision as number) < 0) throw invalid('发送参数无效。');
    if (request.connectionRevision !== revisions().generation) throw changed();
    if (kind === 'bonfire') {
      return session.sendBonfireMessage({
        content: request.content, mentions: request.mentions ?? [], connectionRevision: request.connectionRevision,
        ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      });
    }
    if (kind === 'fireside') {
      return speak({
        kind: 'fireside', content: request.content as string, firesideId: String(request.firesideId ?? ''),
        connectionRevision: request.connectionRevision, requestId: request.requestId, replyTo: request.replyTo,
      });
    }
    // A direct message has no Being-relay path at all — the relay never supported
    // one (docs/town-sdk-integration.md「私信与回复」) — so it goes straight to the
    // paired client and reports AUTH_REQUIRED when the profile is not paired.
    return client.sendDirectMessage({
      recipient: request.recipient, content: request.content,
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    });
  });

  // ── pairing ────────────────────────────────────────────────────────────────
  // src/main.cjs line 1256: after any pairing change the session is reset, the
  // lifecycle re-evaluated and a `hello` pushed at the background, so the first
  // read after pairing happens immediately rather than at the next poll.
  const pairedTown = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation();
    paired();
    return result;
  };
  const assertPairingIdle = () => {
    if (pairing.state().busy) throw Object.assign(new Error('Town 正在配对，请等待完成。'), { code: 'BUSY' });
  };
  enveloped('beings:town-client-pair', (value: unknown) => {
    assertPairingIdle();
    return pairedTown(() => client.pair(value));
  });
  enveloped('beings:town-client-auto-pair', () => pairedTown(() => pairing.connect()));
  enveloped('beings:town-client-retry-storage', () => {
    assertPairingIdle();
    return pairedTown(() => client.retryPairStorage());
  });
  enveloped('beings:town-client-forget', () => {
    assertPairingIdle();
    return client.forget();
  });

  // ── the public catalogue ───────────────────────────────────────────────────
  // The two survivors of the deleted town/ipc.ts. They read Town's public pages
  // with no credential — the square, the bookshelf, the seed garden, public
  // scrolls, the Grove market — which is a different surface from everything
  // above and has no BeingDesktop counterpart (see ./catalog.ts).
  handle('beings:town', (query: TownQuery) => catalog.query(query));
  handle('beings:town-open', async (route: string) => {
    if (typeof route !== 'string' || !TOWN_LINK.test(route)) throw new Error('不支持的 Town 链接。');
    await openExternal(TOWN_ORIGIN + route);
  });
}
