// Ported from BeingDesktop 0.8.26 src/chat-store.cjs (290 lines),
// src/session-titles.cjs, src/session-recovery.cjs and docs/interfaces.md §7
// 「持久化格式」; 2026-09-16.
//
// These declarations are deliberately standalone. The parallel port of
// being-chat.ts / protocol-types.ts owns the wire shapes of the five Being
// endpoints; nothing here imports them, so the two stages cannot race. Where the
// same concept appears in both, this file is the one that merges away.

/** Where a conversation's title came from. `auto` is the title worker's, `manual`
 * the user's, `system` one Desktop assigned itself. Only an untouched, default
 * title is eligible for automatic naming (src/session-titles.cjs line 7). */
export type TitleSource = 'auto' | 'manual' | 'system';

/** A preview of one image a message went out with: `{media_type, name?, thumb?}`,
 * the thumb a small data URL. History never returns images (measured 2026-09-11,
 * docs/desktop-message-layer.md §十), so this is a local annotation on a durable
 * row rather than anything the Being can give back. */
export interface StoredImage { media_type: string; name?: string; thumb?: string }

/** One durable transcript row. Every stored row carries the server's `seq`: live
 * stream text is deliberately not stored, so the in-flight bubble in the renderer
 * and the durable row can never duplicate each other. */
export interface StoredRow {
  seq: number;
  role: 'user' | 'being';
  content: string;
  at: string;
  from?: string;
  images?: StoredImage[];
}

export interface StoredSession {
  id: string;
  title: string;
  titleSource?: TitleSource;
  createdAt: number;
  truncated: boolean;
  rows: StoredRow[];
}

/** The plaintext inside one Being's encrypted cache file, byte-compatible with
 * BeingDesktop 0.8.x (docs/interfaces.md §7: ≤100 conversations, ≤300 rows each,
 * ≤100000 characters per row, ≤6MB in total). */
export interface ChatSnapshot {
  version: 1;
  cursor: number;
  seeded: boolean;
  active: string;
  sessions: StoredSession[];
}

/** One conversation as the renderer sees it. `updatedAt` is the newest row's `at`
 * — a server timestamp string — and falls back to the numeric `createdAt` for a
 * conversation that has been opened but never spoken in. */
export interface SessionSummary {
  id: string;
  title: string;
  titleSource?: TitleSource;
  createdAt: number;
  updatedAt: string | number;
  truncated: boolean;
  count: number;
  lastSeq: number;
}

export interface StoreSummary {
  cursor: number;
  seeded: boolean;
  active: string;
  degraded: boolean;
  sessions: SessionSummary[];
}

/** What `ChatStore` needs of the encrypted cache. `load` returns whatever was on
 * disk: validation is the store's `snapshot()`, never the cache's. */
export interface ChatCacheLike {
  load(identityKey: string): Promise<unknown>;
  save(identityKey: string, value: ChatSnapshot): Promise<boolean>;
}

export interface ChatStoreOptions {
  cache?: ChatCacheLike;
  identityKey?: string;
  desktopId?: string;
  clock?: () => number;
  onChange?: (summary: StoreSummary) => void;
}

/** One page of `/api/history`, already read. `baseline` marks a full load rather
 * than an increment, which is what lifts the seeded gate (invariant 5). */
export interface HistoryPage {
  rows?: unknown[];
  cursor?: number;
  baseline?: boolean;
}

export interface ApplyResult {
  stored: number;
  skipped: number;
  cursor: number;
  persisted: boolean;
}

/** The subset of `ChatStore` the title worker drives. */
export interface TitleStore {
  summary(): StoreSummary;
  rows(sessionId: string): StoredRow[];
  rename(sessionId: string, title: string, options?: { source?: TitleSource }): boolean;
  touch(): Promise<boolean>;
}

/** A row as `titleInput` sees it: only conversation text crosses into the title
 * worker, so everything else stays `unknown` and is filtered out by value. */
export interface TitleRow { role?: unknown; content?: unknown; images?: unknown }

export interface SessionTitlesOptions {
  getStore: () => TitleStore | null;
  /** An opaque availability fingerprint: falsy means no worker, and a changed
   * value retries conversations whose last attempt failed. */
  available: () => string;
  generate: (sessionId: string, input: string) => Promise<unknown>;
  changed: () => void;
  delay?: number;
}

/** The connection fields `sessionPartition` hashes, as BeingDesktop's own
 * `parseConnection` produces them (src/security.cjs lines 6-23). */
export interface RecoveryConnection {
  displayUrl: string;
  apiBase: string;
  token: string;
  secret: string;
}

/** A Loom-page localStorage backup, keyed by session partition. `entries` is the
 * raw `[key, value]` pair list as it was captured. */
export interface SessionRecovery {
  id: string;
  origin: string;
  desktopId?: string;
  entries: [string, string][];
}
