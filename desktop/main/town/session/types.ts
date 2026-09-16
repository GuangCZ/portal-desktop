// Ported from BeingDesktop 0.8.26 (src/town-client.cjs, src/town-session.cjs,
// src/town-wire.cjs, src/town-library-contract.cjs) on 2026-09-16.
// Shared contract types for the Town session unit. Every external dependency
// (fetch, clock, credential storage, text sanitizer, relay result validation)
// is a constructor parameter so the modules stay testable outside Electron.
//
// Protocol references: docs/town-sdk-integration.md ("替换范围", "发送路径",
// "时间线累积"), docs/interfaces.md §6.4 and docs/architecture.md §5.3 / §7.

/** Injected text redaction. BeingDesktop wires `services.sanitizeText`. */
export type SanitizeText = (value: unknown, secrets?: string[]) => string;

/** Errors carry the code catalogue from docs/interfaces.md §5. */
export class TownError extends Error {
  code: string;
  /** Credential load reason surfaced by TownClientStore (`SECURE_STORAGE_UNAVAILABLE` | `CREDENTIAL_UNREADABLE`). */
  reason?: string;
  /** Redacted upstream rejection detail for an ambiguous direct-message recipient. */
  detail?: string;
  /** Disambiguation choices taken from `recipient_warning.candidates`. */
  candidates?: TownCandidate[];
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TownError';
    this.code = code;
  }
}

/** Reads `error.code` without assuming the thrown value is an object. */
export const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : '';
};

/** Reads `error.message` for state details without assuming an Error instance. */
export const errorMessage = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : '';
};

export type WireRecord = Record<string, unknown>;

/** Non-null, non-array object. Matches town-wire.cjs / town-session.cjs `record`. */
export const isRecord = (value: unknown): value is WireRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Plain object literal only. Matches town-library-contract.cjs `record`. */
export const isPlainRecord = (value: unknown): value is WireRecord =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

export const isSequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** A disambiguation choice from a rejected direct message. */
export interface TownCandidate {
  town_id: string;
  display_name: string;
}

/** Verified identity a wire envelope is checked against. */
export interface TownVerifiedIdentity {
  loomBeingId: string;
  townId: string;
}

// --- TownClient ---------------------------------------------------------

/** What TownClient reads from the live Loom connection. */
export interface TownClientContext {
  key?: string;
  beingId?: string;
  loomBeingId?: string;
  revision?: unknown;
  connected?: boolean;
}

/** Epoch-pinned snapshot captured at the start of an asynchronous operation. */
export interface TownClientPin {
  key: string;
  loomBeingId: string;
  revision: unknown;
  epoch: number;
}

export interface TownStoredCredential {
  token?: string | null;
  townId?: string;
  display?: string;
}

/**
 * TownClientStore surface used here (the store itself is migrated separately).
 * Every member is optional because production and test wiring supply subsets.
 */
export interface TownCredentialStore {
  load?: (key: string, beingId: string) => Promise<string | null | undefined>;
  loadCredential?: (key: string, beingId: string) => Promise<TownStoredCredential | null | undefined>;
  save?: (key: string, beingId: string, token: string, townId: string, display: string, current: () => boolean) => Promise<void>;
  bindTownId?: (key: string, beingId: string, token: string, townId: string, current: () => boolean) => Promise<void>;
  remove?: (key: string) => Promise<void>;
  assertAvailable?: () => void;
}

export type TownClientStatus =
  | 'unpaired' | 'connecting' | 'connected' | 'reconnecting'
  | 'paused' | 'auth_required' | 'identity_mismatch' | 'pair_storage_error';

export interface TownClientState {
  status: TownClientStatus;
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

/** Invalidation hints only. Event payloads never leave the main process. */
export type TownClientEvent =
  | { type: 'hello' }
  | { type: 'bonfire' }
  | { type: 'fireside'; firesideId: string }
  | { type: 'dm' }
  | { type: 'profile_changed'; townId: string };

export interface TownClientIdentity {
  loomBeingId: string;
  townId: string;
  displayName: string;
}

export interface TownSpeakReceipt {
  ok: true;
  id: string;
  seq: number;
  mentions: string[];
  mention_warnings?: unknown;
  via: string;
}

export interface TownDirectReceipt {
  ok: true;
  id: string;
  recipient: string;
  via: string;
}

// --- TownSession --------------------------------------------------------

/** What TownSession reads from the live Loom connection. */
export interface TownSessionContext {
  configured?: boolean;
  connected?: boolean;
  exiting?: boolean;
  connectionId?: unknown;
  identityRevision?: unknown;
  beingId?: string;
  loomBeingId?: string;
  beingName?: string;
  townId?: string;
}

export interface TownSessionPin {
  beingId: string;
  loomBeingId: string;
  connectionId: unknown;
  identityRevision: unknown;
  epoch: number;
}

export type TownSessionArea = 'bonfire' | 'fireside' | 'channel' | 'scroll' | 'beings' | 'inbox';

export interface TownAreaState {
  status: string;
  detail: string;
}

export type TownSessionState = Record<string, TownAreaState>;

export interface TownMember {
  id: string;
  name: string;
  description: string;
}

export interface TownReplyPreview {
  id: string;
  beingId: string;
  preview: string;
}

export interface TownMessage {
  id: string;
  beingId: string;
  townId?: string;
  authorUnknown?: true;
  beingName: string;
  content: string;
  createdAt: string;
  revisedAt: string;
  mentions: string[];
  via?: string;
  replyTo?: TownReplyPreview;
}

export interface TownMessagePage {
  messages: TownMessage[];
  latestSeq: number;
  total?: number;
  source?: string;
}

export interface TownDirectMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
  via?: string;
  replyTo?: TownReplyPreview;
}

export interface TownFiresideRoom {
  id: number;
  name: string;
  member_count?: number;
}

export interface TownFiresideMember {
  being_id: string;
  display_name: string;
  joined_at: string;
}

export interface TownChannelStatus {
  channel: string;
  status: string;
  detail: string;
  appId?: string;
  qrCodeDataUrl?: string;
  qrCodeUrl?: string;
}

export interface TownScrollSummary {
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

export interface TownScrollDetail extends TownScrollSummary {
  content: string;
  totalLength: number;
  offset: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
}

export interface TownScrollList {
  scrolls: TownScrollSummary[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface TownBeingEntry {
  id: string;
  name: string;
  description: string;
  status: string;
  human: null;
}

/** Bonfire send receipt as TownSession returns it (relay and direct share the shape). */
export interface TownSendResult {
  ok: true;
  id: string;
  mention_warnings?: unknown;
  mentions: string[];
}

/** The Being relay writer injected as `writeImpl` (migrated separately). */
export type TownWriteImpl = (request: {
  kind: string;
  content: string;
  connectionRevision: unknown;
  requestId?: unknown;
  replyTo?: unknown;
}) => Promise<unknown>;

/** TownClient.read injected as `readImpl`. */
export type TownReadImpl = (
  route: string,
  options: { query?: Record<string, unknown>; signal?: AbortSignal },
) => Promise<unknown>;

/** TownClient.identity injected as `getIdentity`. */
export type TownGetIdentity = (options: { signal?: AbortSignal }) => Promise<TownClientIdentity>;
