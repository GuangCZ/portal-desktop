// Ported from BeingDesktop test/town-background.test.cjs on 2026-09-16. Fixtures copied verbatim.
//
// BeingDesktop ran these against the real TownRefresh (src/town-refresh.cjs, 531 lines), which a
// different migration unit ports. Here TownRefresh is injected, and the double below implements
// only the call surface TownBackground drives. Cases whose subject is TownRefresh itself —
// polling schedule, staleness, failure counters, reason strings, snapshot merging and cache
// receipts — keep their original names as it.skip and are listed in this unit's open issues;
// they must be re-enabled against the real TownRefresh at integration time.
import { expect, it } from "vitest";
import { TownBackground } from "../desktop/main/town/channel/town-background";
import type { TownIdentity, TownRefreshLike, TownRefreshOptions, TownSnapshot } from "../desktop/main/town/channel/types";

function deferred() {
  let resolve!: (value?: any) => void, reject!: (reason?: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let count = 0; count < 20; count++) await Promise.resolve(); }

/** node:test's assert.rejects can be held as a promise; vitest warns, so capture the reason. */
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error) => error);

function fakeClock() {
  let now = 1000, nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback: () => void, delay: number) { const id = nextId++; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: unknown) { timers.delete(id as number); },
    async advance(duration: number) {
      const target = now + duration;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback(); await settle();
      }
      now = target; await settle();
    },
    pending: () => timers.size,
  };
}

function snapshot(content: string, id = 1): TownSnapshot {
  return { messages: [{ id: String(id), beingId: "echo", beingName: "Echo", content, createdAt: "2026-09-07", revisedAt: "", mentions: [] }], latestSeq: id };
}

const EMPTY = (): TownSnapshot => ({ messages: [], latestSeq: null, identity: null });

/**
 * Stand-in for TownRefresh. It performs exactly one read per refresh/requestRead, stores the
 * result, aborts the in-flight signal on stop/reset, and reports running/reason. It deliberately
 * schedules nothing: automatic polling, staleness and receipts belong to the real module.
 */
class FakeRefresh implements TownRefreshLike {
  private cached: TownSnapshot = EMPTY();
  private running = false;
  private reason: string;
  private flights = new Set<AbortController>();
  _townDirty?: boolean;
  _townEventTimer?: any;
  _townEventFlight?: boolean;
  constructor(private options: TownRefreshOptions) { this.reason = options.automatic ? "sbs" : "manual"; }
  status() { return { running: this.running, reason: this.reason }; }
  snapshot() { return structuredClone(this.cached); }
  restoreCache(value: unknown) {
    if (this.running || !value || this.cached.latestSeq !== null) return false;
    this.cached = { ...structuredClone(value as TownSnapshot), identity: this.options.getIdentity() };
    this.options.onSnapshot();
    return true;
  }
  start() { this.running = true; this.options.onStatus(); if (this.options.automatic) void this.read(this.options.readSnapshot).catch(() => {}); }
  stop() { this.running = false; this.abortAll(); this.options.onStatus(); }
  pause(reason = "suspended") { this.reason = reason; this.options.onStatus(); }
  resume() { this.running = true; this.options.onStatus(); }
  reset() { this.abortAll(); this.cached = EMPTY(); this.options.onStatus(); }
  private abortAll() { for (const controller of this.flights) controller.abort(); this.flights.clear(); }
  refresh() { return this.read(this.options.readSnapshot); }
  requestRead(readSnapshot: TownRefreshOptions["readSnapshot"]) { return this.read(readSnapshot); }
  loadOlder() { return this.read(this.options.readSnapshot); }
  private async read(readSnapshot: TownRefreshOptions["readSnapshot"]) {
    const controller = new AbortController();
    this.flights.add(controller);
    const value = await readSnapshot({ signal: controller.signal, limit: this.options.limit });
    this.flights.delete(controller);
    this.cached = { ...structuredClone(value), identity: value.identity ?? this.options.getIdentity() };
    this.reason = "manual";
    try { this.options.onSuccess({ ...structuredClone(value), manual: true }); } catch { /* matches TownRefresh */ }
    this.options.onSnapshot();
    return value;
  }
}

interface HarnessOptions {
  read?: (entry: { kind: string; value: any; signal: AbortSignal }, count: number) => any;
  readCachedSnapshot?: (value: any) => any;
  bonfireCache?: { load: (key: string) => any; save: (key: string, value: any) => any };
  getCacheKey?: () => string;
  onUpdate?: (value: any) => void;
}

function harness({ read = () => snapshot("Town message"), readCachedSnapshot, bonfireCache, getCacheKey, onUpdate }: HarnessOptions = {}) {
  let identity: TownIdentity | null = { beingId: "alice", connectionRevision: 1, identityRevision: 1 };
  const calls: { kind: string; value: any; signal: AbortSignal }[] = [], updates: any[] = [], statuses: any[] = [], clock = fakeClock();
  const call = async (kind: string, value: any, options: { signal: AbortSignal }) => {
    const entry = { kind, value, signal: options.signal }; calls.push(entry);
    return read(entry, calls.length);
  };
  const townSession = {
    getBonfireMessages: (value: any, options: any) => call("bonfire", value, options),
    getFiresideMessages: (value: any, options: any) => call("fireside", value, options),
  };
  const background = new TownBackground({
    townSession, getIdentity: () => identity, clock, bonfireCache, getCacheKey, ...(readCachedSnapshot ? { readCachedSnapshot } : {}),
    createRefresh: (options) => new FakeRefresh(options),
    onUpdate(value) { updates.push(structuredClone(value)); onUpdate?.(value); },
    onStatus() { statuses.push(background.metadata()); },
  });
  return { background, clock, calls, updates, statuses, setIdentity(value: TownIdentity | null) { identity = value; } };
}

it.skip("startup restores persistent Bonfire messages before polling or an explicit Being read", () => { /* TownRefresh: cache merge and staleness */ });
it.skip("Fireside restores its own persistent messages before polling and an explicit read", () => { /* TownRefresh: restoreCache merge and receipts */ });
it.skip("Fireside cache survives switching rooms and reconnects with the current identity", () => { /* TownRefresh: cache merge */ });

it("switching rooms while disk restore is pending rejects the old request before it can read or publish", async () => {
  const disk = deferred();
  const { background, calls, updates } = harness({
    bonfireCache: { load: (key) => key.endsWith(":fireside:7") ? disk.promise : null, save: () => {} }, getCacheKey: () => "alice-session",
  });
  try {
    background.lifecycle({ enabled: true }); await background.restore();
    const oldSnapshot = rejection(background.cachedSnapshot({ kind: "fireside", firesideId: "7" }));
    const oldRead = rejection(background.requestRead({ kind: "fireside", firesideId: "7" }));
    await settle();
    await background.cachedSnapshot({ kind: "fireside", firesideId: "8" });
    const cut = updates.length;
    disk.resolve({ ...snapshot("Removed private content"), capturedAt: 500, revision: "old", manual: true });
    expect(await oldSnapshot).toMatchObject({ code: "SESSION_CHANGED" });
    expect(await oldRead).toMatchObject({ code: "SESSION_CHANGED" });
    expect(calls.length).toBe(0);
    expect(JSON.stringify(updates.slice(cut)).includes("Removed private content")).toBe(false);
    expect(background.snapshot({ kind: "fireside", firesideId: "8" }).snapshot.messages).toEqual([]);
  } finally { background.stop(); }
});

it("reconciled room removal prevents an outstanding or later persistent restore", async () => {
  const disk = deferred(), loaded: string[] = [];
  const { background, updates } = harness({
    bonfireCache: { load: (key) => { loaded.push(key); return key.endsWith(":fireside:7") ? disk.promise : null; }, save: () => {} }, getCacheKey: () => "alice-session",
  });
  try {
    background.lifecycle({ enabled: true }); await background.restore();
    background.reconcileRooms({ owned: [{ id: 7 }], joined: [] });
    const pending = rejection(background.cachedSnapshot({ kind: "fireside", firesideId: "7" }));
    await settle();
    background.reconcileRooms({ owned: [], joined: [{ id: 8 }] });
    const cut = updates.length;
    disk.resolve({ ...snapshot("Removed private content"), capturedAt: 500, revision: "old", manual: true });
    expect(await pending).toMatchObject({ code: "SESSION_CHANGED" });
    await expect(background.cachedSnapshot({ kind: "fireside", firesideId: "7" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(background.requestRead({ kind: "fireside", firesideId: "7" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(loaded.filter((key) => key.endsWith(":fireside:7")).length).toBe(1);
    expect(JSON.stringify(updates.slice(cut)).includes("Removed private content")).toBe(false);
    expect(background.metadata().fireside).toBeNull();
  } finally { background.stop(); }
});

it.skip("persisted receipt stays paired with validated messages and errors never replace the disk record", () => { /* TownRefresh: cacheRecord */ });
it.skip("reconnect restores the same connection cache with current revisions and switching sessions isolates it", () => { /* TownRefresh: cache merge and staleness */ });

it("late disk loads and reads cannot cross a connection change or restart work after stop", async () => {
  const old = deferred();
  let key = "alice-session";
  const { background, setIdentity, calls, updates } = harness({
    bonfireCache: { load: (key) => key === "alice-session" ? old.promise : null, save: () => {} }, getCacheKey: () => key,
  });
  background.lifecycle({ enabled: true });
  const rejected = rejection(background.requestRead({ kind: "bonfire" }));
  await settle();
  key = "bob-session"; setIdentity({ beingId: "bob", connectionRevision: 2, identityRevision: 2 });
  background.lifecycle({ enabled: true }); await background.restore();
  const cut = updates.length;
  old.resolve({ ...snapshot("Private old content"), capturedAt: 500, revision: "old", manual: true });
  expect(await rejected).toMatchObject({ code: "SESSION_CHANGED" });
  expect(background.snapshot({ kind: "bonfire" }).snapshot.messages).toEqual([]);
  expect(JSON.stringify(updates.slice(cut)).includes("Private old content")).toBe(false);
  background.stop();
  expect(calls.length).toBe(0);

  const pending = deferred();
  const stopped = harness({ bonfireCache: { load: () => pending.promise, save: () => {} }, getCacheKey: () => "stopped",
    readCachedSnapshot: () => { throw new Error("Must not poll"); } });
  stopped.background.lifecycle({ enabled: true }); stopped.background.stop();
  pending.resolve({ ...snapshot("Old content"), capturedAt: 500, revision: "old", manual: true });
  await stopped.background.restore(); await settle();
  expect(stopped.background.metadata().bonfire.running).toBe(false);
  expect(stopped.background.snapshot({ kind: "bonfire" }).snapshot.messages).toEqual([]);
});

it.skip("connecting, selecting rooms, recovering and advancing minutes never wake Being", () => { /* TownRefresh: poll schedule, intervalMs, reason */ });
it.skip("one selected room shares in-flight reads and switching aborts only the previous room", () => { /* TownRefresh: in-flight sharing */ });

it("repeated snapshots of the current room stay local before and after a manual read", async () => {
  const { background, calls } = harness();
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    for (let count = 0; count < 10; count++) background.snapshot({ kind: "fireside", firesideId: "7" });
    await settle();
    expect(calls.length).toBe(0);
    await background.refresh({ kind: "fireside", firesideId: "7" });
    for (let count = 0; count < 10; count++) background.snapshot({ kind: "fireside", firesideId: "7" });
    expect(calls.length).toBe(1);
    expect(background.snapshot({ kind: "fireside", firesideId: "7" }).snapshot.messages.length).toBe(1);
  } finally { background.stop(); }
});

it("a room change after transport completion cannot relabel the new room as the old request", async () => {
  const gate = deferred();
  const { background } = harness({ read: (call) => call.value.firesideId === "7" ? gate.promise : snapshot("Room eight") });
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    const flight = (background as any)._room.refresh();
    await settle();
    // Resolve the reader and switch rooms before the outer IPC refresh resumes.
    const switched = flight.then(() => background.snapshot({ kind: "fireside", firesideId: "8" }));
    const rejected = rejection(background.refresh({ kind: "fireside", firesideId: "7" }));
    gate.resolve(snapshot("Room seven")); await switched;
    expect(await rejected).toMatchObject({ code: "SESSION_CHANGED" });
    await settle();
    await background.refresh({ kind: "fireside", firesideId: "8" });
    const current = background.snapshot({ kind: "fireside", firesideId: "8" });
    expect(current.firesideId).toBe("8");
    expect(current.snapshot.messages[0]).toMatchObject({ content: "Room eight" });
  } finally { background.stop(); }
});

it.skip("offline and sleep pauses retain stale data without reading on resume", () => { /* TownRefresh: paused status and staleness */ });

it("disconnect clears all cached messages and reconnect cannot expose the previous identity", async () => {
  const { background, setIdentity, calls, updates, clock } = harness({ read: () => snapshot("PRIVATE ALICE MESSAGE") });
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    await background.refresh({ kind: "bonfire" });
    await background.refresh({ kind: "fireside", firesideId: "7" });
    setIdentity(null); background.lifecycle({ enabled: false });
    const disconnected = background.snapshot({ kind: "bonfire" });
    expect(disconnected.snapshot.identity).toBeNull();
    expect(disconnected.snapshot.messages).toEqual([]);
    expect(background.metadata().fireside).toBeNull();
    const cut = updates.length;
    setIdentity({ beingId: "bob", connectionRevision: 2, identityRevision: 2 });
    background.lifecycle({ enabled: false });
    expect(background.snapshot({ kind: "bonfire" }).snapshot.messages).toEqual([]);
    expect(JSON.stringify(updates.slice(cut)).includes("PRIVATE ALICE MESSAGE")).toBe(false);
    await clock.advance(120000); expect(calls.length).toBe(2);
    background.lifecycle({ enabled: true }); await settle();
    expect(calls.length).toBe(2);
    await background.refresh({ kind: "bonfire" });
    expect(calls.length).toBe(3);
    expect(background.snapshot({ kind: "bonfire" }).snapshot.identity!.beingId).toBe("bob");
  } finally { background.stop(); }
});

it("connection revision changes abort pending reads and clear the selected private room", async () => {
  const gate = deferred();
  const { background, setIdentity, calls, updates } = harness({ read: (call) => call.value.firesideId === "7" ? gate.promise : snapshot("Bonfire") });
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    const rejected = rejection(background.refresh({ kind: "fireside", firesideId: "7" }));
    await settle();
    const previous = calls.find((call) => call.kind === "fireside")!;
    const cut = updates.length;
    setIdentity({ beingId: "alice", connectionRevision: 2, identityRevision: 1 });
    background.lifecycle({ enabled: false });
    expect(previous.signal.aborted).toBe(true);
    expect(background.metadata().fireside).toBeNull();
    expect(background.snapshot({ kind: "bonfire" }).snapshot.messages).toEqual([]);
    gate.resolve(snapshot("LATE PRIVATE MESSAGE"));
    expect(await rejected).toMatchObject({ code: "SESSION_CHANGED" });
    await settle();
    expect(JSON.stringify(updates.slice(cut)).includes("LATE PRIVATE MESSAGE")).toBe(false);
  } finally { background.stop(); }
});

it("removal from the room list discards its cache without any further private reads", async () => {
  const { background, calls, clock } = harness();
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    await background.refresh({ kind: "fireside", firesideId: "7" });
    background.reconcileRooms({ owned: [{ id: 7 }], joined: [] });
    expect(background.metadata().fireside).not.toBeNull();
    background.reconcileRooms({ owned: [], joined: [{ id: 8 }] });
    expect(background.metadata().fireside).toBeNull();
    await clock.advance(180000);
    expect(calls.filter((call) => call.kind === "fireside").length).toBe(1);
  } finally { background.stop(); }
});

it.skip("diagnostic metadata omits messages and observer mutations cannot change cached data", () => { /* TownRefresh: snapshot copying */ });
it.skip("authorization failures require manual retry using only the read transport", () => { /* TownRefresh: failure state machine */ });
it.skip("busy and transient failures never enqueue an automatic retry", () => { /* TownRefresh: retry scheduling */ });

it("malformed read selectors reject getters and extra keys without starting requests", async () => {
  const { background, calls } = harness();
  try {
    let invoked = false;
    const values = [
      { get kind() { invoked = true; return "bonfire"; } },
      { kind: "bonfire", signal: {} },
      { kind: "fireside", firesideId: "not-a-number" },
      { kind: "fireside", firesideId: "07" },
      { kind: "fireside", firesideId: "9007199254740992" },
      { kind: "fireside", firesideId: "7", extra: true },
      Object.assign(Object.create({ kind: "bonfire" }), {}),
    ];
    for (const value of values) expect(() => background.snapshot(value)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }) as unknown as Error);
    expect(invoked).toBe(false);
    expect(calls.length).toBe(0);
  } finally { background.stop(); }
});

it("stop and restart preserve selected room metadata without starting reads", async () => {
  const { background, calls, clock } = harness();
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    background.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(300000); expect(calls.length).toBe(0);
    background.lifecycle({ enabled: true }); await settle();
    expect(calls.length).toBe(0);
    // The original also asserted status.reason === 'manual'; that value is TownRefresh state.
    expect(background.snapshot({ kind: "fireside", firesideId: "7" }).firesideId).toBe("7");
    await background.refresh({ kind: "fireside", firesideId: "7" });
    expect(calls.length).toBe(1);
    expect(calls[0].value.firesideId).toBe("7");
    await clock.advance(300000);
    expect(calls.length).toBe(1);
  } finally { background.stop(); }
});

it.skip("SBS polling, navigation and refresh only read cached results over multiple minutes", () => { /* TownRefresh: poll schedule and lastCheckedAt */ });
it.skip("explicit reads supersede a pending cache read and cannot be overwritten by old cache", () => { /* TownRefresh: read supersession */ });
it.skip("missing or failed cached results never fall back to a Being chat request", () => { /* TownRefresh: failure reasons and counters */ });

it("late cached and explicit private reads cannot cross room or identity changes", async () => {
  const cacheGate = deferred(), manualGate = deferred();
  const cachedCalls: any[] = [];
  const { background, calls, setIdentity, updates } = harness({ read: () => manualGate.promise, readCachedSnapshot: (value) => {
    cachedCalls.push(value);
    return value.firesideId === "7" ? cacheGate.promise : { ...snapshot("Current cache"), capturedAt: 500, revision: "cache:current" };
  } });
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    const rejected = rejection(background.requestRead({ kind: "fireside", firesideId: "7" }));
    await settle();
    background.snapshot({ kind: "fireside", firesideId: "8" }); await settle();
    expect(calls[0].signal.aborted).toBe(true);
    expect(cachedCalls.find((value) => value.firesideId === "7").signal.aborted).toBe(true);
    const cut = updates.length;
    setIdentity({ beingId: "bob", connectionRevision: 2, identityRevision: 2 });
    background.lifecycle({ enabled: true }); await settle();
    manualGate.resolve(snapshot("LATE PRIVATE MANUAL"));
    cacheGate.resolve({ ...snapshot("LATE PRIVATE CACHE"), capturedAt: 900, revision: "old:private" });
    expect(await rejected).toMatchObject({ code: "SESSION_CHANGED" });
    await settle();
    expect(JSON.stringify(updates.slice(cut)).includes("LATE PRIVATE")).toBe(false);
    expect(background.snapshot({ kind: "bonfire" }).snapshot.identity!.beingId).toBe("bob");
    expect(background.metadata().fireside).toBeNull();
  } finally { background.stop(); }
});

it.skip("an accepted explicit read is never replayed while cache polling continues", () => { /* TownRefresh: pending-request state */ });
