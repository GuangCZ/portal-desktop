// Town's direct reads, timeline and pairing, as the renderer sees them;
// 2026-09-16.
//
// Ported from BeingDesktop 0.8.26: the method catalogue in docs/interfaces.md
// §1.2「Town、篝火、围炉、卷轴、私信、Channel」, the two pushes in §1.3, the
// `townApp` snapshot in §4 and the error catalogue in §5. The DTO shapes are the
// ones the main-process modules already produce (desktop/main/town/session/types.ts,
// desktop/main/town/timeline/types.ts) — restated here because `shared` may not
// import `main`, and because these are the only fields allowed to cross: no
// credential, no fireside invite key, no scroll share token, no raw upstream body.
//
// Every name is prefixed `TownDesktop` on purpose. `desktop-types.ts` aggregates
// with `export *`, which drops a duplicate silently, and `shared/types.ts`
// already owns `TownQuery` / `TownResult` / `TownKind` for the public Town
// catalogue the shell browses without pairing.

/* ---------------------------------------------------------------- messages */

/** The quoted parent Town returns with a reply. Preview only — never the parent's
 * full body, which the renderer would otherwise be able to reconstruct. */
export interface TownDesktopReplyPreview {
  id: string;
  beingId: string;
  preview: string;
}

/** One message of a feed, after the main process validated it. `via` carries
 * `client:<name>` for a message spoken through a paired client; the renderer
 * shows 「借 <name>」 for it and nothing for `being` (docs/town-sdk-integration.md
 * 「替换范围」). */
export interface TownDesktopMessage {
  id: string;
  beingId: string;
  townId?: string;
  /** The author could not be resolved in the member directory; the renderer shows
   * the id rather than guessing a name. */
  authorUnknown?: true;
  beingName: string;
  content: string;
  createdAt: string;
  revisedAt: string;
  mentions: string[];
  via?: string;
  replyTo?: TownDesktopReplyPreview;
}

/** One page as a direct read returned it. `total` is Town's `total_count`, absent
 * on sources that do not report one. */
export interface TownDesktopMessagePage {
  messages: TownDesktopMessage[];
  latestSeq: number;
  total?: number;
  source?: string;
}

export interface TownDesktopDirectMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
  via?: string;
  replyTo?: TownDesktopReplyPreview;
}

/* ---------------------------------------------------------------- timeline */

/** Which feed a timeline call addresses. `firesideId` is Town's numeric room id
 * as a string; it is required for `fireside` and refused for `bonfire`. */
export type TownDesktopFeed =
  | { kind: 'bonfire' }
  | { kind: 'fireside'; firesideId: string };

/** The connection identity a timeline was read under. The renderer compares it
 * before painting: a snapshot from the previous Being must not land in the new
 * one's list (docs/interfaces.md §5 `SESSION_CHANGED`). */
export interface TownDesktopTimelineIdentity {
  beingId?: string;
  connectionRevision?: number;
  identityRevision?: number;
}

/** Where the previous refresh stopped. `boundarySeq` is the newest sequence the
 * client already held before that refresh, and is what the 「上次刷新到这里」
 * divider is drawn after (docs/town-sdk-integration.md「时间线累积」). */
export interface TownDesktopLastRefresh {
  at: number;
  boundarySeq: number | null;
}

/** The accumulating timeline, not a rolling window: messages older than the
 * refresh window stay until the 1000-row memory cap drops them. */
export interface TownDesktopTimeline {
  identity: TownDesktopTimelineIdentity | null;
  messages: TownDesktopMessage[];
  latestSeq: number | null;
  total: number | null;
  hasOlder: boolean;
  lastRefresh: TownDesktopLastRefresh | null;
  /** `being_relay` marks a feed that came through a Being turn rather than a
   * direct read. Such a feed cannot page, so `hasOlder` stays false. */
  source?: string;
}

export interface TownDesktopRefreshStatus {
  status: string;
  reason: string;
  intervalMs: number;
  nextRefreshAt: number | null;
  lastAttemptAt: number | null;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  revision: string | null;
  stale: boolean;
  errorCode: string;
  failureCount: number;
  running: boolean;
}

/** What every timeline channel answers with, and what `onMessages` pushes. */
export interface TownDesktopEnvelope {
  kind: string;
  firesideId: string;
  snapshot: TownDesktopTimeline;
  status: TownDesktopRefreshStatus;
}

/** The payload-free hint that the inbox may have changed. The direct-message
 * body never reaches the renderer through the stream; it re-reads instead
 * (docs/town-sdk-integration.md「私信与回复」). */
export interface TownDesktopInboxHint { kind: 'dm' }

export type TownDesktopPush = TownDesktopEnvelope | TownDesktopInboxHint;

export const isTownDesktopInboxHint = (value: TownDesktopPush): value is TownDesktopInboxHint =>
  (value as TownDesktopInboxHint).kind === 'dm' && !('snapshot' in value);

/* ------------------------------------------------------------------- rooms */

export interface TownDesktopRoom {
  id: number;
  name: string;
  member_count?: number;
}

/** The fireside directory, plus whether it came from the encrypted cache and
 * when that cache was last confirmed. */
export interface TownDesktopRoomDirectory {
  owned: TownDesktopRoom[];
  joined: TownDesktopRoom[];
  cached: boolean;
  lastSuccessAt?: number | null;
}

export interface TownDesktopRoomMember {
  being_id: string;
  display_name: string;
  joined_at: string;
}

/** A cached member list. `cached: false` with an empty list means the room is no
 * longer in the directory — not that it has no members. */
export interface TownDesktopRoomMembers {
  members: TownDesktopRoomMember[];
  cached?: boolean;
  lastSuccessAt?: number | null;
}

/* --------------------------------------------------------------- directory */

export interface TownDesktopMember {
  id: string;
  name: string;
  description: string;
}

export interface TownDesktopMemberCacheState {
  revision: number;
  expiresAt: number;
}

export interface TownDesktopMemberDirectory extends TownDesktopMemberCacheState {
  members: TownDesktopMember[];
}

export interface TownDesktopBeing {
  id: string;
  name: string;
  description: string;
  status: string;
  human: null;
}

export interface TownDesktopBeingList {
  beings: TownDesktopBeing[];
  source: string;
  detail: string;
}

/* ----------------------------------------------------------------- scrolls */

export interface TownDesktopScrollSummary {
  id: string;
  title: string;
  beingId: string;
  beingName: string;
  visibility: string;
  kind: string;
  lifecycle: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TownDesktopScroll extends TownDesktopScrollSummary {
  content: string;
  totalLength: number;
  offset: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
}

export interface TownDesktopScrollList {
  scrolls: TownDesktopScrollSummary[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** `limit` 1-200, default 50. `visibility` is one of private | shared | public. */
export interface TownDesktopScrollQuery {
  offset?: number;
  limit?: number;
  visibility?: string;
}

/** `limit` 1-10000, default 10000 — the whole body unless the caller pages. */
export interface TownDesktopScrollRequest {
  id: string;
  offset?: number;
  limit?: number;
}

/* ------------------------------------------------------------------- reads */

/** One SDK read of a feed, skipping the feature-task ledger. `includeRooms`
 * refreshes the fireside directory first, so a room that has been left is
 * reported as removed rather than read again. */
export interface TownDesktopReadRequest {
  kind: 'bonfire' | 'fireside';
  firesideId?: string;
  selectionRevision?: number;
  includeRooms?: boolean;
}

/** A read of the bonfire returns the envelope alone; a read of a fireside also
 * carries the directory and the room's members, or `removed` when the room is no
 * longer reachable. */
export interface TownDesktopReadResult {
  envelope?: TownDesktopEnvelope;
  rooms?: TownDesktopRoomDirectory;
  members?: TownDesktopRoomMembers;
  removed?: true;
}

/** `limit` 1-200. `since` asks for the EARLIEST messages after that sequence —
 * measured, not inferred: there is no `before` (docs/town-sdk-integration.md
 * 「时间线累积」). */
export interface TownDesktopPageRequest {
  limit?: number;
  since?: number;
}

export interface TownDesktopFiresidePageRequest extends TownDesktopPageRequest {
  firesideId: string;
}

/** The eight methods `beings:town-cached` will answer for. */
export type TownDesktopCachedMethod =
  | 'listBeings' | 'getBeingMembers' | 'getFiresides' | 'listScrolls'
  | 'getScroll' | 'getGroveCatalog' | 'getGroveDetail' | 'getFiresideMembers';

export interface TownDesktopCacheSelector {
  method: TownDesktopCachedMethod;
  value?: unknown;
}

/** A miss is `{cached: false, data: null}`. A cached `null` payload is still a
 * hit, so read `cached` and never truth-test `data`. */
export interface TownDesktopCacheResult {
  cached: boolean;
  data: unknown;
  lastSuccessAt: number | null;
}

/* ------------------------------------------------------------------ speaking */

/** One outgoing message. `connectionRevision` must equal the revision the
 * renderer was showing; a send composed against the previous Being is refused
 * rather than delivered under the new identity.
 *
 * Length caps are enforced in the main process, by code point: bonfire 4000,
 * fireside 32000 (Town silently truncates the first and answers 400 on the
 * second, so neither is left to the server). */
export type TownDesktopSpeakRequest =
  | { kind: 'bonfire'; content: string; connectionRevision: number; mentions?: string[]; requestId?: string; replyTo?: string }
  | { kind: 'fireside'; firesideId: string; content: string; connectionRevision: number; requestId?: string; replyTo?: string }
  | { kind: 'dm'; recipient: string; content: string; connectionRevision: number; replyTo?: string };

/** A receipt Town confirmed. An unconfirmed write raises `RESULT_UNKNOWN`
 * instead — it may well have arrived, and must not be resent. */
export interface TownDesktopSpeakReceipt {
  ok: true;
  id: string;
  seq?: number;
  recipient?: string;
  mentions?: string[];
  mention_warnings?: unknown;
  via?: string;
}

/** A recipient the upstream rejection offered instead. Reaches the renderer on a
 * `NOT_SENT` error so the user can pick one. */
export interface TownDesktopCandidate {
  town_id: string;
  display_name: string;
}

/* ------------------------------------------------------------------- state */

export type TownDesktopClientStatus =
  | 'unpaired' | 'connecting' | 'connected' | 'reconnecting'
  | 'paused' | 'auth_required' | 'identity_mismatch' | 'pair_storage_error';

/** The paired client's public state. No token, ever: `pairingPending` says a
 * token exists in memory that could not be written to disk, and the only cure is
 * `retryPairStorage` — never another code. */
export interface TownDesktopClientState {
  status: TownDesktopClientStatus;
  paired: boolean;
  beingId: string;
  loomBeingId: string;
  townId: string;
  displayName: string;
  errorCode: string;
  authReason: string;
  pairingPending: boolean;
  pairErrorCode: string;
}

export interface TownDesktopPairingState {
  status: 'idle' | 'requesting' | 'complete' | 'manual_required';
  busy: boolean;
  /** A rejected fetch contributes a DOMException's numeric legacy code. */
  errorCode: string | number;
}

export interface TownDesktopIdentity {
  beingId: string;
  loomBeingId: string;
  townId: string;
  displayName: string;
  sendAs: string;
  connectionRevision: number;
  identityRevision: number;
}

export interface TownDesktopAreaState {
  status: string;
  detail: string;
}

/** `townApp` of BeingDesktop's `publicState` (docs/interfaces.md §4), restricted
 * to the fields this unit owns. `portalInstall` and `portalWorkspace` belong to
 * the Portal unit and are deliberately absent. */
export interface TownDesktopAppState {
  identity: TownDesktopIdentity;
  /** Per-area readiness: bonfire, fireside, firesideRead, firesideSend, scroll,
   * beings, channel. Values are the area statuses, not sentences. */
  access: Record<string, string>;
  accessDetail: Record<string, string>;
  bonfire: TownDesktopAreaState;
  fireside: TownDesktopAreaState;
  scroll: TownDesktopAreaState;
  beings: TownDesktopAreaState;
  inbox: TownDesktopAreaState;
  sync: { bonfire: TownDesktopRefreshStatus | null; fireside: TownDesktopRefreshStatus | null };
  client: TownDesktopClientState;
  pairing: TownDesktopPairingState;
  memberDirectory: TownDesktopMemberCacheState;
}

/* --------------------------------------------------------------------- API */

/** `window.beings.townDesktop`. Every method whose main-process channel is
 * marked「Town 包络」rejects with an `Error` carrying `code` from the catalogue
 * in desktop/shared/town-desktop-errors.ts; the rest reject with a plain Error. */
export interface TownDesktopAPI {
  appState(): Promise<TownDesktopAppState>;
  refreshApp(): Promise<TownDesktopAppState>;
  timeline(feed: TownDesktopFeed): Promise<TownDesktopEnvelope>;
  refreshTimeline(feed: TownDesktopFeed): Promise<TownDesktopEnvelope>;
  loadOlder(feed: TownDesktopFeed): Promise<TownDesktopEnvelope>;
  read(request: TownDesktopReadRequest): Promise<TownDesktopReadResult>;
  bonfire(page?: TownDesktopPageRequest): Promise<TownDesktopMessagePage>;
  firesideMessages(request: TownDesktopFiresidePageRequest): Promise<TownDesktopMessagePage>;
  firesides(): Promise<TownDesktopRoomDirectory>;
  firesideMembers(firesideId: string): Promise<TownDesktopRoomMembers>;
  speak(request: TownDesktopSpeakRequest): Promise<TownDesktopSpeakReceipt>;
  inbox(): Promise<{ messages: TownDesktopDirectMessage[] }>;
  beings(): Promise<TownDesktopBeingList>;
  members(input?: { force?: boolean }): Promise<TownDesktopMemberDirectory>;
  profileChanged(): Promise<TownDesktopMemberCacheState>;
  scrolls(query?: TownDesktopScrollQuery): Promise<TownDesktopScrollList>;
  scroll(request: TownDesktopScrollRequest): Promise<{ scroll: TownDesktopScroll }>;
  cached(selector: TownDesktopCacheSelector): Promise<TownDesktopCacheResult>;
  pair(input: { code: string }): Promise<TownDesktopClientState>;
  autoPair(): Promise<TownDesktopClientState>;
  retryPairStorage(): Promise<TownDesktopClientState>;
  forget(): Promise<TownDesktopClientState>;
  /** A new timeline for the feed on screen, or the payload-free inbox hint. */
  onMessages(callback: (value: TownDesktopPush) => void): () => void;
  /** The member directory was invalidated — by a `profile_changed` event or by
   * `profileChanged()`. Carries the new cache metadata, no members. */
  onMembersInvalidated(callback: (value: TownDesktopMemberCacheState) => void): () => void;
}
