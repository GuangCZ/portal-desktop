// Injection contracts for the ported BeingDesktop Channel/Town modules. Written 2026-09-16.
//
// TownRefresh, TownSession, TownClient, BonfireCache and ChatSessions are ported by other
// migration units and are not present in this worktree. Each is described here by the exact
// call surface BeingDesktop used, so the integration stage can drop the real objects in.

/* ------------------------------------------------------------------ pairing */

/** BeingDesktop src/town-pairing.cjs: `getContext()` in main.cjs boot(). */
export interface PairingConnectionContext {
  connected?: boolean;
  connection?: string | { url?: string } | null;
  revision?: unknown;
}

/** BeingDesktop src/town-client.cjs (ported by the TownClient unit). */
export interface PairingClient {
  pairing?: boolean;
  store: { assertAvailable?: () => void };
  state: () => { pairingPending?: boolean };
  pair: (value: { code: string }) => Promise<unknown>;
  retryPairStorage?: () => Promise<unknown>;
}

export interface TownPairingState {
  status: 'idle' | 'requesting' | 'complete' | 'manual_required';
  busy: boolean;
  /** A rejected fetch contributes a DOMException's numeric legacy code (AbortError 20, TimeoutError 23). */
  errorCode: string | number;
}

/* ---------------------------------------------------- Loom view (town.cjs) */

/** Electron WebContents, reduced to what BeingDesktop src/town.cjs actually calls. */
export interface WebContentsLike {
  mainFrame: WebFrameLike | null;
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  getURL(): string;
}

/** Electron WebFrameMain, reduced to what src/town.cjs actually calls. */
export interface WebFrameLike {
  isDestroyed(): boolean;
  detached: boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

/** main.cjs boot(): `() => ({connection, generation, revision: viewRevision, view, configured, status, exiting})`. */
export interface LoomDraftContext {
  connection?: { displayUrl: string; url?: string } | null;
  generation?: unknown;
  revision?: unknown;
  view?: { webContents: WebContentsLike } | null;
  configured?: boolean;
  status?: string;
  exiting?: boolean;
}

/* --------------------------------------------- channel (channel-being.cjs) */

/** main.cjs boot(): the Loom identity snapshot the Channel request is fenced against. */
export interface ChannelBeingContext {
  configured?: boolean;
  connected?: boolean;
  exiting?: boolean;
  connectionId?: unknown;
  identityRevision?: unknown;
  beingName?: string;
  connection?: { url: string; token?: string; secret?: string } | null;
}

/** BeingDesktop ChatSessions.ensureChannel(channel) (ported by the chat unit). */
export interface ChannelSession { sceneId: string }

/** BeingDesktop main.cjs readStatus: a read-only channel snapshot from the service. */
export type ChannelStatusReader = (options: { signal: AbortSignal }) => Promise<unknown>;

/** Task bookkeeping hook: main.cjs records the outgoing Channel request. */
export interface RequestRecord { requestId: string; route: string; beingId: string; prompt: string }

export interface ChannelOutcome {
  channel: string;
  status: string;
  detail: string;
  qrCodeUrl?: string;
  qrCodeDataUrl?: string;
}

/** The send-only slice of BeingClient that ChannelBeing uses. */
export interface ChannelClient {
  send(request: {
    message: string;
    signal?: AbortSignal;
    onEvent?: (event: { type: string; data: Record<string, any> }) => void;
  }): Promise<{ accepted: boolean }>;
}

/** BeingDesktop loaded extensions/being-anywhere/being-client.mjs lazily; here it is injected. */
export type ChannelClientFactory = (url: string, fetchImpl: typeof fetch) => ChannelClient;

/* ----------------------------------------- background (town-background.cjs) */

export interface TownIdentity { beingId?: string; connectionRevision?: number; identityRevision?: number; [key: string]: unknown }

/** BeingDesktop src/town-session.cjs (ported by the Town timeline unit). */
export interface TownSession {
  getBonfireMessages(page: { limit: number; since?: unknown }, options: { signal: AbortSignal }): Promise<TownSnapshot> | TownSnapshot;
  getFiresideMessages(page: { firesideId: string; limit: number; since?: unknown }, options: { signal: AbortSignal }): Promise<TownSnapshot> | TownSnapshot;
}

/** BeingDesktop src/bonfire-cache.cjs (ported by the Town timeline unit). */
export interface BonfireCache {
  load(key: string): Promise<unknown> | unknown;
  save(key: string, value: unknown): Promise<unknown> | unknown;
}

export interface TownSnapshot {
  messages: unknown[];
  latestSeq?: unknown;
  identity?: TownIdentity | null;
  [key: string]: unknown;
}

export interface TownRefreshStatus { running?: boolean; [key: string]: unknown }

export interface TownEnvelope { kind: string; firesideId: string; snapshot: TownSnapshot; status: TownRefreshStatus }

export interface TownReadOptions { signal: AbortSignal; limit: number; since?: unknown }

/** Injected clock; BeingDesktop defaulted every field inside TownRefresh. */
export interface TownBackgroundClock {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

/**
 * BeingDesktop src/town-refresh.cjs (ported by the Town timeline unit). TownBackground also
 * stores three private bookkeeping fields on each reader to coalesce live-event bursts.
 */
export interface TownRefreshLike {
  status(): TownRefreshStatus;
  snapshot(): TownSnapshot;
  restoreCache(value: unknown): unknown;
  start(): void;
  stop(): void;
  pause(reason?: string): void;
  resume(): void;
  reset(): void;
  refresh(): Promise<unknown>;
  requestRead(readSnapshot: (options: TownReadOptions) => Promise<TownSnapshot> | TownSnapshot): Promise<unknown>;
  loadOlder(): Promise<unknown>;
  _townDirty?: boolean;
  _townEventTimer?: (ReturnType<typeof setTimeout> & { unref?: () => void }) | null;
  _townEventFlight?: boolean;
}

export interface TownRefreshOptions {
  getIdentity: () => TownIdentity | null;
  clock: TownBackgroundClock;
  limit: number;
  automatic: boolean;
  cached: boolean;
  pageable: boolean;
  readSnapshot: (options: TownReadOptions) => Promise<TownSnapshot> | TownSnapshot;
  onSnapshot: () => void;
  onSuccess: (value: unknown) => void;
  onStatus: () => void;
}

export type TownRefreshFactory = (options: TownRefreshOptions) => TownRefreshLike;

/* ------------------------------------------ controller (town-controller.cjs) */

/** main.cjs boot(): settings plus the live connection identity. */
export interface TownControllerContext {
  configured?: boolean;
  connected?: boolean;
  exiting?: boolean;
  beingName?: string;
  townId?: string;
  displayName?: string;
  connectionId?: unknown;
  identityRevision?: unknown;
  portalIdentityRevision?: unknown;
  portalWorkspace?: string;
  portalExecutable?: string;
  portalConfig?: string;
  managedPortal?: {
    executable?: string;
    configPath?: string;
    workspace?: string;
    permissions?: unknown;
    groveKitsDir?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface PortalInstallProgress { phase: string; receivedBytes?: unknown; totalBytes?: unknown }

/** BeingDesktop src/portal-installer.cjs PortalInstaller (download/verify pipeline). */
export interface PortalInstaller {
  release?: { version: string; apiUrl: string; url: string; size: number; sha256: string };
  inspect(): Promise<any>;
  install(options: { onProgress: (progress: PortalInstallProgress) => void }): Promise<any>;
}

/** BeingDesktop src/portal-process.cjs: the live heart-portal process observer. */
export interface PortalProcess {
  state: { status: string; owned?: boolean; detail?: string; management?: string; deployment?: { workspace?: string } | null };
  inspect(): Promise<unknown>;
}
