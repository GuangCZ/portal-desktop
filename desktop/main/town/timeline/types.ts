// Ported from BeingDesktop 0.8.26 on 2026-09-16. The shapes below mirror the call surface the
// CommonJS modules relied on (src/town-refresh.cjs, src/town-data-cache.cjs,
// src/town-cached-reads.cjs, src/town-client-store.cjs, src/bonfire-cache.cjs). TownSession and
// TownClient are ported by a different unit, so the session object only ever reaches this unit
// through injected callbacks.
// Measured protocol notes: docs/town-sdk-integration.md "同步行为 / 时间线累积（2026-09-11）";
// persistence formats: docs/interfaces.md section 7 (bonfire-cache/, town-data-cache/).
import type { SecretStorage } from '../../app/settings';

export type { SecretStorage };

// Electron's safeStorage exposes getSelectedStorageBackend on Linux only; TownClientStore refuses
// to persist a pairing credential when the backend is plain text.
export interface TownSecretStorage extends SecretStorage {
  getSelectedStorageBackend?(): string;
}

// Only public identity fields cross the transport boundary.
export interface TownIdentity {
  beingId: string;
  connectionRevision: number;
  identityRevision: number;
}

export interface TownReplyTo {
  id: string;
  beingId: string;
  preview: string;
}

// One row as TownRefresh holds it: every display field is present after pageDto normalization.
export interface TownMessage {
  id: string;
  beingId: string;
  beingName: string;
  content: string;
  createdAt: string;
  revisedAt: string;
  mentions: string[];
  via?: string;
  replyTo?: TownReplyTo;
}

// One page of a feed as the transport returned it, validated and sorted by pageDto.
export interface TownPage {
  messages: TownMessage[];
  latestSeq: number;
  total: number | null;
  source?: 'being_relay';
}

export interface TownLastRefresh {
  at: number;
  boundarySeq: number | null;
}

export interface TownTimeline {
  identity: TownIdentity | null;
  messages: TownMessage[];
  latestSeq: number | null;
  total: number | null;
  hasOlder: boolean;
  lastRefresh: TownLastRefresh | null;
  source?: 'being_relay';
}

export interface TownReceipt {
  capturedAt: number;
  revision: string;
  manual: boolean;
}

// What TownRefresh hands to onSuccess and what BonfireCache persists.
export interface TownCacheRecord {
  messages: TownMessage[];
  latestSeq: number;
  capturedAt: number;
  revision: string;
  manual: boolean;
  source?: 'being_relay';
}

// What BonfireCache accepts and returns: every display field is optional on disk because 0.8.x
// wrote only the fields it had.
export interface BonfireCachedMessage {
  id: string;
  content: string;
  beingId?: string;
  beingName?: string;
  createdAt?: string;
  revisedAt?: string;
  via?: string;
  mentions?: string[];
  replyTo?: TownReplyTo;
}

export interface BonfireCachedSnapshot {
  messages: BonfireCachedMessage[];
  latestSeq: number;
  capturedAt: number;
  revision: string;
  manual: boolean;
  source?: 'being_relay';
}

export interface TownRefreshStatus {
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

export interface TownReadRequest {
  signal: AbortSignal;
  identity: TownIdentity;
  limit: number;
  since?: number;
}

export type TownReadSnapshot = (request: TownReadRequest) => unknown;

export interface TownTimerHandle {
  unref?(): unknown;
}

export interface TownClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): TownTimerHandle;
  clearTimeout(handle: TownTimerHandle): void;
}

export interface TownCodedError extends Error {
  code: string;
  reason?: string;
  retryAfterMs?: number;
}

// TownDataCache read result. `cached: false` and `data: null` mean a miss; a cached `null` payload
// is still a hit, so callers must read `cached` and never truth-test `data`.
export interface TownCacheResult {
  cached: boolean;
  data: unknown;
  lastSuccessAt: number | null;
}

// The connection facts TownCachedReads needs from the running session (main.cjs supplied these
// from its boot() closure).
export interface TownCachedReadsContext {
  identityKey: string;
  revision: number;
  identityRevision: number;
  connected: boolean;
}

export interface TownCacheStore {
  load(identityKey: string, resourceKey: string): Promise<TownCacheResult>;
  save(identityKey: string, resourceKey: string, data: unknown): Promise<boolean> | boolean;
}

export interface TownClientCredential {
  token: string;
  townId: string;
  display?: string;
}
