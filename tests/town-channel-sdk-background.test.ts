// Ported from BeingDesktop test/town-sdk-background.test.cjs on 2026-09-16. Fixtures copied verbatim.
// TownRefresh is injected here; the double mirrors the automatic first read and one read per
// refresh, which is all these two cases depend on. The 250 ms coalescing window inside
// notifyEvent uses the global timer, not the injected clock, so these use real delays.
import { expect, it } from "vitest";
import { TownBackground } from "../desktop/main/town/channel/town-background";
import type { TownRefreshLike, TownRefreshOptions, TownSnapshot } from "../desktop/main/town/channel/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const identity = { beingId: "alice", connectionRevision: 1, identityRevision: 1 };
const snapshot = (n: number): TownSnapshot => ({ messages: [{ id: String(n), content: "message " + n, beingId: "alice" }], latestSeq: n });

const EMPTY = (): TownSnapshot => ({ messages: [], latestSeq: null, identity: null });

class FakeRefresh implements TownRefreshLike {
  private cached: TownSnapshot = EMPTY();
  private running = false;
  private flights = new Set<AbortController>();
  _townDirty?: boolean;
  _townEventTimer?: any;
  _townEventFlight?: boolean;
  constructor(private options: TownRefreshOptions) {}
  status() { return { running: this.running }; }
  snapshot() { return structuredClone(this.cached); }
  restoreCache() { return false; }
  start() { this.running = true; this.options.onStatus(); if (this.options.automatic) void this.read().catch(() => {}); }
  stop() { this.running = false; this.abortAll(); this.options.onStatus(); }
  pause() { this.options.onStatus(); }
  resume() { this.running = true; this.options.onStatus(); }
  reset() { this.abortAll(); this.cached = EMPTY(); this.options.onStatus(); }
  private abortAll() { for (const controller of this.flights) controller.abort(); this.flights.clear(); }
  refresh() { return this.read(); }
  requestRead(readSnapshot: TownRefreshOptions["readSnapshot"]) { return this.read(readSnapshot); }
  loadOlder() { return this.read(); }
  private async read(readSnapshot: TownRefreshOptions["readSnapshot"] = this.options.readSnapshot) {
    const controller = new AbortController();
    this.flights.add(controller);
    const value = await readSnapshot({ signal: controller.signal, limit: this.options.limit });
    this.flights.delete(controller);
    if (controller.signal.aborted) return value;
    this.cached = { ...structuredClone(value), identity: value.identity ?? this.options.getIdentity() };
    this.options.onSuccess(structuredClone(value));
    this.options.onSnapshot();
    return value;
  }
}

const createRefresh = (options: TownRefreshOptions) => new FakeRefresh(options);

it("SDK background starts without SBS; an event during REST triggers a second authoritative read", async () => {
  let calls = 0, resolve!: (value: TownSnapshot) => void;
  const feed = new TownBackground({ direct: true, getIdentity: () => identity, createRefresh, townSession: { getBonfireMessages: async () => { calls++; if (calls === 2) return new Promise<TownSnapshot>((r) => { resolve = r; }); return snapshot(calls); }, getFiresideMessages: async () => snapshot(0) } });
  try {
    feed.lifecycle({ enabled: true }); await delay(10); expect(calls).toBe(1);
    feed.notifyEvent({ type: "bonfire" }); await delay(280); expect(calls).toBe(2);
    feed.notifyEvent({ type: "bonfire" }); resolve(snapshot(2)); await delay(10);
    expect(calls).toBe(3); expect((await feed.cachedSnapshot({ kind: "bonfire" })).snapshot.latestSeq).toBe(3);
  } finally { feed.stop(); }
});

it("SSE reconciliation after resume does not publish a response from the prior identity", async () => {
  let current = identity, calls = 0;
  const feed = new TownBackground({ direct: true, getIdentity: () => current, createRefresh, townSession: { getBonfireMessages: async () => snapshot(++calls), getFiresideMessages: async () => snapshot(0) } });
  try {
    feed.lifecycle({ enabled: true }); await delay(10); feed.notifyEvent({ type: "hello" });
    current = { ...identity, beingId: "bob", identityRevision: 2 }; feed.lifecycle({ enabled: true }); await delay(280);
    const data = await feed.cachedSnapshot({ kind: "bonfire" });
    expect(data.snapshot.identity!.beingId).toBe("bob"); expect(calls).toBe(2);
  } finally { feed.stop(); }
});
