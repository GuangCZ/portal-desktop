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
