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
  errorCode: string;
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
