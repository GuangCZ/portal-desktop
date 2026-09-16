// Ported from BeingDesktop test/town-background.test.cjs on 2026-09-16. Fixtures copied verbatim.
//
// BeingDesktop ran these against the real TownRefresh (src/town-refresh.cjs, 531 lines), which a
// different migration unit ported; integration unit I1 brought it in as
// desktop/main/town/timeline/refresh.ts, so `createRefresh` now builds the real one and the
// fifteen cases whose subject IS TownRefresh — polling schedule, staleness, failure counters,
// reason strings, snapshot merging and cache receipts — are live again rather than carried as
// it.skip. `FakeRefresh` below is kept for the one case that needs a refresh double it can hold
// open; every other case drives the real scheduler through the fake clock.
import { expect, it } from "vitest";
import { TownBackground } from "../desktop/main/town/channel/town-background";
import { TownRefresh } from "../desktop/main/town/timeline/refresh";
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

/** `TownSnapshot.messages` is `unknown[]` in the injection contract — the message
 * DTO belongs to the session unit, not to this one — so a body read says so once
 * here rather than casting at every assertion. */
const body = (value: unknown) => (value as { content?: string } | undefined)?.content;

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
  const background: TownBackground = new TownBackground({
    townSession, getIdentity: () => identity, clock, bonfireCache, getCacheKey, ...(readCachedSnapshot ? { readCachedSnapshot } : {}),
    createRefresh: (options) => new TownRefresh(options as unknown as ConstructorParameters<typeof TownRefresh>[0]) as unknown as TownRefreshLike,
    onUpdate(value) { updates.push(structuredClone(value)); onUpdate?.(value); },
    onStatus() { statuses.push(background.metadata()); },
  });
  return { background, clock, calls, updates, statuses, setIdentity(value: TownIdentity | null) { identity = value; } };
}

it("startup restores persistent Bonfire messages before polling or an explicit Being read", async () => {
  const disk = deferred(), upstream = deferred(), events: string[] = [];
  const cached = { ...snapshot("Saved before exit", 7), capturedAt: 500, revision: "manual:1", manual: true };
  const { background, calls, updates } = harness({
    bonfireCache: { load: () => disk.promise, save: () => {} }, getCacheKey: () => "alice-session",
    readCachedSnapshot: () => { events.push("poll"); return upstream.promise; },
    onUpdate: (value) => { if (value.snapshot.messages[0]?.content === "Saved before exit") events.push("restored"); },
  });
  try {
    background.lifecycle({ enabled: true });
    const requested = background.requestRead({ kind: "bonfire" });
    await settle();
    expect(calls.length).toBe(0);
    expect(events).toEqual([]);
    disk.resolve(cached);
    await background.restore();
    expect(body(background.snapshot({ kind: "bonfire" }).snapshot.messages[0])).toBe("Saved before exit");
    expect(events[0]).toBe("restored");
    await requested;
    expect(calls.length).toBe(1);
    expect(updates.some((value) => value.snapshot.messages[0]?.content === "Saved before exit" && value.status.stale)).toBe(true);
    expect(body(background.snapshot({ kind: "bonfire" }).snapshot.messages[0])).toBe("Town message");
    upstream.resolve({ ...snapshot("Older collection"), capturedAt: 100, revision: "sbs:old" });
    await settle();
    expect(body(background.snapshot({ kind: "bonfire" }).snapshot.messages[0])).toBe("Town message");
  } finally { background.stop(); }
});

it("Fireside restores its own persistent messages before polling and an explicit read", async () => {
  const disk = deferred(), poll = deferred(), saved: { key: string; value: any }[] = [], events: string[] = [];
  const cached = { ...snapshot("Saved room seven", 7), capturedAt: 500, revision: "room-seven", manual: true };
  const { background, calls } = harness({
    bonfireCache: { load: (key) => key.endsWith(":fireside:7") ? disk.promise : null, save: (key, value) => saved.push({ key, value }) },
    getCacheKey: () => "alice-session",
    readCachedSnapshot: (value) => { if (value.kind === "fireside") events.push("poll"); return poll.promise; },
    onUpdate: (value) => { if (value.snapshot.messages[0]?.content === "Saved room seven") events.push("restored"); },
  });
  try {
    background.lifecycle({ enabled: true }); await background.restore();
    background.reconcileRooms({ owned: [{ id: 7 }], joined: [] });
    const restoring = background.cachedSnapshot({ kind: "fireside", firesideId: "7" });
    const requested = background.requestRead({ kind: "fireside", firesideId: "7" });
    await settle();
    expect(calls.length).toBe(0);
    expect(events).toEqual([]);
    disk.resolve(cached);
    const restored = await restoring;
    expect(body(restored.snapshot.messages[0])).toBe("Saved room seven");
    expect(events[0]).toBe("restored");
    await requested;
    expect(saved.map((value) => value.key)).toEqual(["alice-session:fireside:7"]);
    expect(saved[0].value.messages[0].content).toBe("Town message");
  } finally { background.stop(); }
});

it("Fireside cache survives switching rooms and reconnects with the current identity", async () => {
  const records = new Map<string, any>();
  let key = "alice-session";
  const { background, setIdentity } = harness({
    bonfireCache: { load: async (name: string) => records.get(name), save: (name, value) => records.set(name, structuredClone(value)) },
    getCacheKey: () => key,
    read: (call) => snapshot(`Private room ${call.value.firesideId}`, Number(call.value.firesideId)),
  });
  try {
    background.lifecycle({ enabled: true }); await background.restore();
    await background.requestRead({ kind: "fireside", firesideId: "7" });
    await background.requestRead({ kind: "fireside", firesideId: "8" });
    expect(body((await background.cachedSnapshot({ kind: "fireside", firesideId: "7" })).snapshot.messages[0])).toBe("Private room 7");
    const identity = { beingId: "alice", connectionRevision: 2, identityRevision: 1 };
    setIdentity(identity); background.lifecycle({ enabled: true }); await background.restore();
    const restored = await background.cachedSnapshot({ kind: "fireside", firesideId: "8" });
    expect(body(restored.snapshot.messages[0])).toBe("Private room 8");
    expect(restored.snapshot.identity).toEqual(identity);
    key = "another-alice-session";
    setIdentity({ ...identity, connectionRevision: 3, identityRevision: 2 });
    background.lifecycle({ enabled: true }); await background.restore();
    expect((await background.cachedSnapshot({ kind: "fireside", firesideId: "8" })).snapshot.messages).toEqual([]);
    expect(records.size).toBe(2);
  } finally { background.stop(); }
});

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

it("persisted receipt stays paired with validated messages and errors never replace the disk record", async () => {
  const saved: { key: string; record: any }[] = [];
  let value: any = { ...snapshot("Fresh collection", 8), capturedAt: 600, revision: "sbs:8" };
  const { background } = harness({
    bonfireCache: { load: async () => null, save: (key, record) => saved.push({ key, record }) },
    getCacheKey: () => "alice-session",
    readCachedSnapshot: async () => { if (value instanceof Error) throw value; return value; },
  });
  try {
    background.lifecycle({ enabled: true }); await background.restore(); await settle();
    expect(saved.length).toBe(1);
    expect(saved[0]).toEqual({ key: "alice-session", record: { ...snapshot("Fresh collection", 8), capturedAt: 600, revision: "sbs:8", manual: false } });
    value = Object.assign(new Error("Unavailable"), { code: "WAITING_SBS" });
    expect(await rejection(background.refresh({ kind: "bonfire" }))).toMatchObject({ code: "WAITING_SBS" });
    expect(saved.length).toBe(1);
    expect(body(background.snapshot({ kind: "bonfire" }).snapshot.messages[0])).toBe("Fresh collection");
    value = { messages: [], latestSeq: 8, capturedAt: 800, revision: "sbs:empty" };
    await background.refresh({ kind: "bonfire" });
    expect(saved.at(-1)!.record).toEqual({ ...value, manual: false });
  } finally { background.stop(); }
});

it("reconnect restores the same connection cache with current revisions and switching sessions isolates it", async () => {
  const records = new Map<string, any>();
  let key = "alice-session";
  const { background, setIdentity } = harness({
    bonfireCache: { load: async (name: string) => records.get(name), save: (name, value) => records.set(name, structuredClone(value)) },
    getCacheKey: () => key,
  });
  try {
    background.lifecycle({ enabled: true }); await background.restore();
    await background.requestRead({ kind: "bonfire" });
    const identity = { beingId: "alice", connectionRevision: 2, identityRevision: 1 };
    setIdentity(identity); background.lifecycle({ enabled: true }); await background.restore();
    const restored = background.snapshot({ kind: "bonfire" });
    expect(body(restored.snapshot.messages[0])).toBe("Town message");
    expect(restored.snapshot.identity).toEqual(identity);
    expect(restored.status.stale).toBe(true);
    key = "another-alice-session";
    setIdentity({ ...identity, connectionRevision: 3, identityRevision: 2 });
    background.lifecycle({ enabled: true }); await background.restore();
    expect(background.snapshot({ kind: "bonfire" }).snapshot.messages).toEqual([]);
    expect(records.size).toBe(1);
  } finally { background.stop(); }
});

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

it("connecting, selecting rooms, recovering and advancing minutes never wake Being", async () => {
  const { background, clock, calls } = harness();
  try {
    background.lifecycle({ enabled: true });
    await settle();
    expect(background.metadata().bonfire!.reason).toBe("manual");
    background.snapshot({ kind: "fireside", firesideId: "7" });
    await clock.advance(600000);
    background.snapshot({ kind: "fireside", firesideId: "8" });
    background.lifecycle({ enabled: false, reason: "offline" });
    background.lifecycle({ enabled: true });
    background.lifecycle({ enabled: false, reason: "suspended" });
    background.lifecycle({ enabled: true });
    await clock.advance(600000);
    expect(calls.length).toBe(0);
    expect(clock.pending()).toBe(0);
    expect(background.metadata().fireside!.reason).toBe("manual");
    expect(background.metadata().bonfire!.nextRefreshAt).toBe(null);
    await background.refresh({ kind: "bonfire" });
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe("bonfire");
    expect(calls[0].value).toEqual({ limit: 10 });
    expect(calls[0].signal instanceof AbortSignal).toBe(true);
    await clock.advance(600000);
    expect(calls.length).toBe(1);
    expect(clock.pending()).toBe(0);
    expect(background.metadata().bonfire!.reason).toBe("manual");
    expect(background.metadata().bonfire!.intervalMs).toBe(60000);
  } finally { background.stop(); }
});

it("one selected room shares in-flight reads and switching aborts only the previous room", async () => {
  const oldRoom = deferred();
  const { background, calls, updates, clock } = harness({
    read: (call) => call.value.firesideId === "7" ? oldRoom.promise : snapshot(call.kind === "fireside" ? "Room eight" : "Bonfire"),
  });
  try {
    background.lifecycle({ enabled: true }); await settle();
    await background.refresh({ kind: "bonfire" });
    background.snapshot({ kind: "fireside", firesideId: "7" });
    await settle();
    const first = rejection(background.refresh({ kind: "fireside", firesideId: "7" }));
    const second = rejection(background.refresh({ kind: "fireside", firesideId: "7" }));
    await clock.advance(60000);
    expect(calls.filter((call) => call.value.firesideId === "7").length).toBe(1);
    const oldCall = calls.find((call) => call.value.firesideId === "7")!;
    const updateCount = updates.length;
    background.snapshot({ kind: "fireside", firesideId: "8" }); await settle();
    await background.refresh({ kind: "fireside", firesideId: "8" });
    expect(oldCall.signal.aborted).toBe(true);
    expect(calls.filter((call) => call.value.firesideId === "8").length).toBe(1);
    oldRoom.resolve(snapshot("OLD PRIVATE ROOM"));
    expect(await first).toMatchObject({ code: "SESSION_CHANGED" });
    expect(await second).toMatchObject({ code: "SESSION_CHANGED" });
    await settle();
    expect(updates.slice(updateCount).every((update) => update.firesideId !== "7")).toBe(true);
    expect(JSON.stringify(updates.slice(updateCount)).includes("OLD PRIVATE ROOM")).toBe(false);
    expect(body(background.snapshot({ kind: "fireside", firesideId: "8" }).snapshot.messages[0])).toBe("Room eight");
    expect(background.metadata().bonfire!.status).toBe("ready");
  } finally { background.stop(); }
});

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

it("offline and sleep pauses retain stale data without reading on resume", async () => {
  const { background, calls, clock } = harness();
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    await background.refresh({ kind: "bonfire" });
    await background.refresh({ kind: "fireside", firesideId: "7" });
    background.lifecycle({ enabled: false, reason: "offline" });
    expect(background.metadata().bonfire!.status).toBe("paused");
    expect(background.metadata().fireside!.status).toBe("paused");
    expect(background.metadata().bonfire!.stale).toBe(true);
    expect(background.snapshot({ kind: "fireside", firesideId: "7" }).snapshot.messages.length).toBe(1);
    await clock.advance(180000);
    expect(calls.length).toBe(2);
    expect(await rejection(background.refresh({ kind: "bonfire" }))).toMatchObject({ code: "NOT_CONNECTED" });
    background.lifecycle({ enabled: true }); await settle();
    expect(calls.length).toBe(2);
    background.lifecycle({ enabled: true }); await settle();
    expect(calls.length).toBe(2);
    background.lifecycle({ enabled: false, reason: "suspended" });
    expect(background.metadata().bonfire!.reason).toBe("suspended");
    await clock.advance(180000);
    expect(calls.length).toBe(2);
  } finally { background.stop(); }
});

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

it("diagnostic metadata omits messages and observer mutations cannot change cached data", async () => {
  const { background, statuses } = harness({
    read: () => ({ ...snapshot("PRIVATE MESSAGE"), token: "PRIVATE_TOKEN" }),
    onUpdate: (value) => { value.snapshot.messages.splice(0); value.snapshot.identity = { beingId: "attacker" }; },
  });
  try {
    background.lifecycle({ enabled: true }); await settle();
    await background.refresh({ kind: "bonfire" });
    expect(JSON.stringify({ metadata: background.metadata(), statuses }).includes("PRIVATE")).toBe(false);
    const result = background.snapshot({ kind: "bonfire" });
    expect(body(result.snapshot.messages[0])).toBe("PRIVATE MESSAGE");
    expect(result.snapshot.identity!.beingId).toBe("alice");
    expect((result.snapshot as Record<string, unknown>).token).toBeUndefined();
  } finally { background.stop(); }
});

it("authorization failures require manual retry using only the read transport", async () => {
  let allowed = false;
  const { background, calls, clock } = harness({
    read: () => {
      if (!allowed) throw Object.assign(new Error("REMOTE_PRIVATE_DETAIL"), { code: "AUTH_REQUIRED" });
      return snapshot("Now authorized");
    },
  });
  try {
    background.lifecycle({ enabled: true }); await settle();
    expect(await rejection(background.refresh({ kind: "bonfire" }))).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(background.metadata().bonfire!.errorCode).toBe("AUTH_REQUIRED");
    expect(background.metadata().bonfire!.status).toBe("paused");
    await clock.advance(600000);
    expect(calls.length).toBe(1);
    allowed = true;
    const result = await background.refresh({ kind: "bonfire" });
    expect(body(result.snapshot.messages[0])).toBe("Now authorized");
    expect(calls.length).toBe(2);
    expect(calls.every((call) => call.kind === "bonfire")).toBe(true);
    expect(JSON.stringify(result).includes("REMOTE_PRIVATE_DETAIL")).toBe(false);
  } finally { background.stop(); }
});

it("busy and transient failures never enqueue an automatic retry", async () => {
  for (const code of ["BUSY", "NETWORK_ERROR", "INCOMPLETE_RESULT", "RESULT_SOURCE_UNAVAILABLE"]) {
    const { background, calls, clock } = harness({ read: () => { throw Object.assign(new Error("Remote failure"), { code }); } });
    try {
      background.lifecycle({ enabled: true });
      const error = await rejection(background.refresh({ kind: "bonfire" })) as { code: string; message: string };
      expect(error.code).toBe(code);
      // A manual read never promises an automatic retry it will not perform.
      expect(error.message.includes("自动重试")).toBe(false);
      await clock.advance(1800000);
      background.lifecycle({ enabled: false });
      background.lifecycle({ enabled: true });
      await clock.advance(1800000);
      expect(calls.length).toBe(1);
      expect(clock.pending()).toBe(0);
      expect(background.metadata().bonfire!.reason).toBe("manual");
      expect(background.metadata().bonfire!.nextRefreshAt).toBe(null);
    } finally { background.stop(); }
  }
});

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

it("SBS polling, navigation and refresh only read cached results over multiple minutes", async () => {
  const cachedCalls: any[] = [];
  const { background, calls, clock } = harness({
    readCachedSnapshot: async (value) => {
      cachedCalls.push(value);
      return { ...snapshot(`Cached ${value.kind}`), capturedAt: 500, revision: `${value.kind}:${value.firesideId}:1` };
    },
  });
  try {
    background.lifecycle({ enabled: true }); await settle();
    background.snapshot({ kind: "fireside", firesideId: "7" }); await settle();
    await clock.advance(3 * 60000);
    expect(cachedCalls.length).toBe(8);
    expect(calls.length).toBe(0);
    expect(cachedCalls.every((value) => value.limit === 10 && value.signal instanceof AbortSignal)).toBe(true);
    await background.refresh({ kind: "bonfire" });
    expect(cachedCalls.length).toBe(9);
    background.snapshot({ kind: "fireside", firesideId: "8" }); await settle();
    background.lifecycle({ enabled: false, reason: "offline" });
    await clock.advance(120000);
    background.lifecycle({ enabled: true }); await settle();
    await clock.advance(120000);
    expect(calls.length).toBe(0);
    expect(background.metadata().bonfire!.reason).toBe("sbs");
    expect(background.metadata().bonfire!.lastSuccessAt).toBe(500);
    expect(background.metadata().bonfire!.lastCheckedAt).toBe(clock.now());
  } finally { background.stop(); }
});

it("explicit reads supersede a pending cache read and cannot be overwritten by old cache", async () => {
  const cacheGate = deferred(), manualGate = deferred();
  const cachedCalls: any[] = [];
  const { background, calls, clock } = harness({
    read: () => manualGate.promise,
    readCachedSnapshot: async (value) => {
      cachedCalls.push(value);
      return cachedCalls.length === 1 ? cacheGate.promise : { ...snapshot("OLD CACHE"), capturedAt: 500, revision: "cache:old" };
    },
  });
  try {
    background.lifecycle({ enabled: true }); await settle();
    const first = background.requestRead({ kind: "bonfire" });
    const second = background.requestRead({ kind: "bonfire" });
    await settle();
    expect(calls.length).toBe(1);
    expect(cachedCalls[0].signal.aborted).toBe(true);
    manualGate.resolve(snapshot("EXPLICIT RESULT", 2));
    await Promise.all([first, second]);
    cacheGate.resolve({ ...snapshot("LATE CACHE"), capturedAt: 500, revision: "cache:late" }); await settle();
    expect(body(background.snapshot({ kind: "bonfire" }).snapshot.messages[0])).toBe("EXPLICIT RESULT");
    expect(background.metadata().bonfire!.reason).toBe("manual");
    const capturedAt = background.metadata().bonfire!.lastSuccessAt;
    await clock.advance(120000);
    expect(calls.length).toBe(1);
    expect(cachedCalls.length).toBe(3);
    expect(background.metadata().bonfire!.lastSuccessAt).toBe(capturedAt);
    expect(body(background.snapshot({ kind: "bonfire" }).snapshot.messages[0])).toBe("EXPLICIT RESULT");
  } finally { background.stop(); }
});

it("missing or failed cached results never fall back to a Being chat request", async () => {
  for (const code of ["WAITING_SBS", "SBS_NOT_CONFIGURED", "NETWORK_ERROR", "INCOMPLETE_RESULT", "RESULT_SOURCE_UNAVAILABLE"]) {
    let checks = 0;
    const { background, calls, clock } = harness({
      readCachedSnapshot: () => { checks++; throw Object.assign(new Error("Private cache detail"), { code }); },
    });
    try {
      background.lifecycle({ enabled: true }); await settle();
      await clock.advance(5 * 60000);
      expect(await rejection(background.refresh({ kind: "bonfire" }))).toMatchObject({ code });
      expect(calls.length).toBe(0);
      expect(checks > 1).toBe(true);
      expect(JSON.stringify(background.metadata()).includes("Private")).toBe(false);
      if (["WAITING_SBS", "SBS_NOT_CONFIGURED"].includes(code)) {
        expect(background.metadata().bonfire!.reason).toBe(code === "WAITING_SBS" ? "waiting_sbs" : "sbs_not_configured");
        expect(background.metadata().bonfire!.failureCount).toBe(0);
        expect(background.metadata().bonfire!.lastSuccessAt).toBe(null);
        expect(background.metadata().bonfire!.lastCheckedAt).toBe(clock.now());
        expect(background.snapshot({ kind: "bonfire" }).snapshot.messages).toEqual([]);
      }
    } finally { background.stop(); }
  }
});

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

it("an accepted explicit read is never replayed while cache polling continues", async () => {
  let checks = 0;
  const { background, calls, clock } = harness({
    read: () => { throw Object.assign(new Error("Accepted"), { code: "REQUEST_ACCEPTED" }); },
    readCachedSnapshot: () => { checks++; throw Object.assign(new Error("Not captured yet"), { code: "WAITING_SBS" }); },
  });
  try {
    background.lifecycle({ enabled: true }); await settle();
    expect(await rejection(background.requestRead({ kind: "bonfire" }))).toMatchObject({ code: "REQUEST_ACCEPTED" });
    expect(background.metadata().bonfire!.reason).toBe("being_pending");
    expect(background.metadata().bonfire!.failureCount).toBe(0);
    await clock.advance(5 * 60000);
    expect(calls.length).toBe(1);
    expect(checks).toBe(6);
    expect(background.metadata().bonfire!.reason).toBe("waiting_sbs");
    expect(background.metadata().bonfire!.failureCount).toBe(0);
  } finally { background.stop(); }
});
