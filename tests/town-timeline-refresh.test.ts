// Ported line by line from BeingDesktop 0.8.26 test/town-refresh.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style changed (node:test -> vitest).
import { expect, test } from "vitest";
import {
  TownRefresh,
  type TownRefreshOptions,
} from "../desktop/main/town/timeline/refresh";
import type {
  TownCodedError,
  TownReadRequest,
  TownRefreshStatus,
  TownTimeline,
} from "../desktop/main/town/timeline/types";

const MINUTE = 60000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}

interface FakeHandle {
  id: number;
  unreferenced: boolean;
  unref(): void;
}
interface FakeTimer {
  callback: () => void;
  due: number;
  handle: FakeHandle;
}
function fakeClock() {
  let time = 1000,
    serial = 0;
  const timers = new Map<number, FakeTimer>();
  return {
    timers,
    now: () => time,
    setTimeout(callback: () => void, delay: number): FakeHandle {
      const id = ++serial;
      const handle: FakeHandle = {
        id,
        unreferenced: false,
        unref() {
          this.unreferenced = true;
        },
      };
      timers.set(id, { callback, due: time + delay, handle });
      return handle;
    },
    clearTimeout(handle: FakeHandle) {
      timers.delete(handle.id);
    },
    async advance(amount: number) {
      const target = time + amount;
      for (;;) {
        const next = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = next.due;
        timers.delete(next.handle.id);
        next.callback();
        await settle();
      }
      time = target;
      await settle();
    },
  };
}
function entry(id: number | string, content = `Message ${id}`) {
  return {
    id: String(id),
    beingId: "alice",
    beingName: "Alice",
    content,
    createdAt: "2026-09-07T09:00:00Z",
    revisedAt: "",
    mentions: [] as string[],
  };
}
function data(
  messages: ReturnType<typeof entry>[] = [entry(1)],
  latestSeq = messages.length
    ? Math.max(...messages.map((item) => Number(item.id)))
    : 0,
) {
  return { messages, latestSeq };
}
function fault(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("PRIVATE_REMOTE_DETAIL"), { code, ...extra });
}

interface HarnessState {
  identity: unknown;
  result: unknown;
  calls: TownReadRequest[];
  snapshots: TownTimeline[];
  statuses: TownRefreshStatus[];
}
interface HarnessOptions {
  overrides?: Record<string, unknown>;
  read?: (args: TownReadRequest, state: HarnessState) => unknown;
}
function harness(options: HarnessOptions = {}) {
  const clock = fakeClock();
  const state: HarnessState = {
    identity: { beingId: "alice", connectionRevision: 1, identityRevision: 1 },
    result: data(),
    calls: [],
    snapshots: [],
    statuses: [],
  };
  const reader = new TownRefresh({
    clock,
    getIdentity: () => state.identity,
    readSnapshot: (args: TownReadRequest) => {
      state.calls.push(args);
      return options.read ? options.read(args, state) : state.result;
    },
    onSnapshot: (value: TownTimeline) => state.snapshots.push(value),
    onStatus: (value: TownRefreshStatus) => state.statuses.push(value),
    ...options.overrides,
  } as unknown as TownRefreshOptions);
  return { reader, clock, state };
}

// node:test's assert.rejects, in the two shapes the original file used.
async function caught(promise: Promise<unknown>): Promise<TownCodedError> {
  let error: unknown = null;
  let settled = false;
  try {
    await promise;
    settled = true;
  } catch (thrown) {
    error = thrown;
  }
  expect(settled, "expected the promise to reject").toBe(false);
  expect(error).toBeInstanceOf(Error);
  return error as TownCodedError;
}
async function rejects(
  promise: Promise<unknown>,
  expected: { code?: string; message?: string },
) {
  const error = await caught(promise);
  if (expected.code !== undefined) expect(error.code).toBe(expected.code);
  if (expected.message !== undefined)
    expect(error.message).toBe(expected.message);
  return error;
}

test("Being relay provenance survives cache restoration, errors and later native replacement", async () => {
  const { reader } = harness({ overrides: { cached: true, automatic: false } });
  try {
    expect(
      reader.restoreCache({
        ...data(),
        source: "being_relay",
        capturedAt: 500,
        revision: "manual:1",
        manual: true,
      }),
    ).toBe(true);
    expect(reader.snapshot().source).toBe("being_relay");
    expect(reader.cacheRecord()?.source).toBe("being_relay");
    reader.start();
    await caught(
      reader.requestRead(() => {
        throw fault("INCOMPLETE_RESULT");
      }),
    );
    expect(reader.snapshot().source).toBe("being_relay");
    await reader.requestRead(() => data());
    expect(reader.snapshot().source).toBe(undefined);
    expect(reader.cacheRecord()?.source).toBe(undefined);
  } finally {
    reader.stop();
  }
});

test("persistent cache rebinds the identity and retains manual receipts against older background results", async () => {
  const { reader, state } = harness({
    overrides: { cached: true, automatic: false },
  });
  try {
    const cached = {
      ...data([entry(7, "Saved content")]),
      capturedAt: 500,
      revision: "manual:1",
      manual: true,
    };
    expect(reader.restoreCache(cached)).toBe(true);
    cached.messages[0].content = "Mutated caller";
    expect(reader.snapshot().identity).toEqual(state.identity);
    expect(reader.snapshot().messages[0].content).toBe("Saved content");
    expect(reader.status().lastSuccessAt).toBe(500);
    expect(reader.status().lastCheckedAt).toBe(null);
    expect(reader.status().stale).toBe(true);
    reader.start();
    for (const capturedAt of [400, 500]) {
      state.result = {
        ...data([entry(6, "Older data")]),
        capturedAt,
        revision: `sbs:${capturedAt}`,
      };
      await reader.refresh();
      expect(reader.snapshot().messages[0].content).toBe("Saved content");
    }
    state.result = {
      ...data([entry(8, "Fresh data")]),
      capturedAt: 900,
      revision: "sbs:new",
    };
    await reader.refresh();
    expect(reader.snapshot().messages[0].content).toBe("Fresh data");
    expect(reader.restoreCache({ ...cached, capturedAt: 9999 })).toBe(false);
  } finally {
    reader.stop();
  }
});

test("invalid disk snapshots are ignored and successful persistence observers cannot disrupt refresh", async () => {
  const saved: unknown[] = [];
  const { reader, state } = harness({
    overrides: {
      cached: true,
      automatic: false,
      onSuccess: (value: unknown) => {
        saved.push(value);
        throw new Error("Disk unavailable");
      },
    },
  });
  try {
    const valid = {
      ...data(),
      capturedAt: 500,
      revision: "sbs:1",
      manual: false,
    };
    for (const value of [
      null,
      {},
      { ...valid, latestSeq: -1 },
      { ...valid, capturedAt: "today" },
      { ...valid, manual: null },
      { ...valid, messages: [{ id: 3, content: "Invalid ID" }] },
    ]) {
      expect(reader.restoreCache(value)).toBe(false);
      expect(reader.snapshot().messages).toEqual([]);
    }
    reader.start();
    state.result = { ...valid, capturedAt: 600, revision: "sbs:2" };
    await reader.refresh();
    expect(saved.length).toBe(1);
    expect((saved[0] as { capturedAt: number }).capturedAt).toBe(600);
    expect((saved[0] as { revision: string }).revision).toBe("sbs:2");
    state.result = {};
    await rejects(reader.refresh(), { code: "INVALID_RESPONSE" });
    expect(saved.length).toBe(1);
    expect(reader.snapshot().messages.length).toBe(1);
  } finally {
    reader.stop();
  }
});

test("starts once immediately and schedules one unreferenced read after a full minute", async () => {
  const { reader, clock, state } = harness();
  reader.start();
  reader.start();
  await settle();
  expect(state.calls.length).toBe(1);
  expect(state.calls[0].limit).toBe(10);
  expect(state.calls[0].identity).toEqual(state.identity);
  expect(clock.timers.size).toBe(1);
  expect([...clock.timers.values()][0].handle.unreferenced).toBe(true);
  await clock.advance(MINUTE - 1);
  expect(state.calls.length).toBe(1);
  await clock.advance(1);
  expect(state.calls.length).toBe(2);
  reader.stop();
  expect(clock.timers.size).toBe(0);
});

test("missing native Town tools retain cached messages and expose the actionable error", async () => {
  const { reader } = harness({ overrides: { cached: true, automatic: false } });
  try {
    reader.restoreCache({
      ...data([entry(7, "Saved content")]),
      capturedAt: 500,
      revision: "manual:1",
      manual: true,
    });
    reader.start();
    const error = await caught(
      reader.requestRead(async () => {
        throw fault("TOWN_TOOL_NOT_CALLED");
      }),
    );
    expect(error.code).toBe("TOWN_TOOL_NOT_CALLED");
    expect(error.message.includes("模型设置")).toBe(true);
    expect(error.message.includes("PRIVATE_REMOTE_DETAIL")).toBe(false);
    expect(reader.status().errorCode).toBe("TOWN_TOOL_NOT_CALLED");
    expect(reader.snapshot().messages[0].content).toBe("Saved content");
  } finally {
    reader.stop();
  }
});

test("manual mode never reads on start, reset, resume or restart", async () => {
  const { reader, clock, state } = harness({ overrides: { automatic: false } });
  reader.start();
  reader.start();
  reader.pause("offline");
  reader.resume();
  reader.pause("suspended");
  reader.resume();
  reader.reset();
  reader.stop();
  reader.start();
  await clock.advance(20 * MINUTE);
  expect(state.calls.length).toBe(0);
  expect(clock.timers.size).toBe(0);
  expect(reader.status().status).toBe("waiting");
  expect(reader.status().reason).toBe("manual");
  expect(reader.status().nextRefreshAt).toBe(null);
  const result = await reader.refresh();
  expect(result.messages[0].id).toBe("1");
  await clock.advance(20 * MINUTE);
  expect(state.calls.length).toBe(1);
  expect(clock.timers.size).toBe(0);
  expect(reader.status().status).toBe("ready");
  expect(reader.status().reason).toBe("manual");
  expect(reader.status().nextRefreshAt).toBe(null);
  reader.stop();
});

test("manual mode joins one requested read and never retries rejected reads", async () => {
  const gate = deferred<unknown>();
  let rejected = false;
  const { reader, clock, state } = harness({
    overrides: { automatic: false },
    read: () => (rejected ? Promise.reject(fault("BUSY")) : gate.promise),
  });
  reader.start();
  const first = reader.refresh();
  const second = reader.refresh();
  expect(first).toBe(second);
  await clock.advance(20 * MINUTE);
  expect(state.calls.length).toBe(1);
  gate.resolve(data());
  await first;
  rejected = true;
  await rejects(reader.refresh(), { code: "BUSY" });
  await clock.advance(20 * MINUTE);
  expect(state.calls.length).toBe(2);
  expect(clock.timers.size).toBe(0);
  expect(reader.status().reason).toBe("manual");
  expect(reader.status().nextRefreshAt).toBe(null);
  expect(reader.snapshot().messages[0].id).toBe("1");
  reader.stop();
});

test("automatic refresh setting accepts only explicit booleans", () => {
  for (const automatic of ["false", 0, null])
    expect(() => harness({ overrides: { automatic } })).toThrow(TypeError);
});

test("accepted requests stay pending without fault backoff or any automatic replay", async () => {
  for (const automatic of [false, true]) {
    const { reader, clock, state } = harness({
      overrides: { automatic },
      read: () => {
        throw fault("REQUEST_ACCEPTED");
      },
    });
    reader.start();
    if (!automatic)
      await rejects(reader.refresh(), {
        code: "REQUEST_ACCEPTED",
        message: "请求已送达 Being，结果待确认；不会自动重发。",
      });
    await settle();
    reader.pause("offline");
    reader.resume();
    reader.stop();
    reader.start();
    await clock.advance(30 * MINUTE);
    expect(state.calls.length).toBe(1);
    expect(clock.timers.size).toBe(0);
    expect(reader.status().status).toBe("waiting");
    expect(reader.status().reason).toBe("being_pending");
    expect(reader.status().errorCode).toBe("REQUEST_ACCEPTED");
    expect(reader.status().failureCount).toBe(0);
    expect(reader.status().nextRefreshAt).toBe(null);
    reader.stop();
  }
});

test("a busy Being waits one minute without an error banner or growing failure backoff", async () => {
  const { reader, clock, state } = harness({
    read: () => {
      throw fault("BUSY");
    },
  });
  reader.start();
  await settle();
  expect(reader.status().status).toBe("waiting");
  expect(reader.status().reason).toBe("being_busy");
  expect(reader.status().failureCount).toBe(0);
  await clock.advance(MINUTE);
  expect(state.calls.length).toBe(2);
  expect(reader.status().nextRefreshAt).toBe(clock.now() + MINUTE);
  expect(reader.status().failureCount).toBe(0);
  reader.stop();
});

test("manual and automatic requests join the same flight without an immediate queued refresh", async () => {
  const gate = deferred<unknown>();
  const { reader, clock, state } = harness({ read: () => gate.promise });
  reader.start();
  await settle();
  const first = reader.refresh();
  const second = reader.refresh();
  expect(first).toBe(second);
  await clock.advance(10 * MINUTE);
  expect(state.calls.length).toBe(1);
  expect(clock.timers.size).toBe(0);
  gate.resolve(data());
  await first;
  await settle();
  expect(state.calls.length).toBe(1);
  expect(reader.status().nextRefreshAt).toBe(clock.now() + MINUTE);
  await clock.advance(MINUTE - 1);
  expect(state.calls.length).toBe(1);
  await clock.advance(1);
  expect(state.calls.length).toBe(2);
  reader.stop();
});

test("manual refresh can run immediately while scheduled reads remain completion based", async () => {
  const { reader, clock, state } = harness();
  reader.start();
  await settle();
  await clock.advance(10);
  await reader.refresh();
  expect(state.calls.length).toBe(2);
  expect(reader.status().nextRefreshAt).toBe(clock.now() + MINUTE);
  await clock.advance(MINUTE - 1);
  expect(state.calls.length).toBe(2);
  await clock.advance(1);
  expect(state.calls.length).toBe(3);
  reader.stop();
});

test("a page shorter than the window is the whole feed: it replaces edits and deletions, deduplicates and sorts", async () => {
  const { reader, state } = harness({ overrides: { limit: 100 } });
  state.result = data([entry(3), entry(1), entry(2), entry(3, "final")]);
  reader.start();
  await settle();
  expect(
    reader.snapshot().messages.map((value) => [value.id, value.content]),
  ).toEqual([
    ["1", "Message 1"],
    ["2", "Message 2"],
    ["3", "final"],
  ]);
  state.result = data(
    [
      entry(200, "old"),
      { ...entry(200, "revised"), revisedAt: "2026-09-07T10:00:00Z" },
      entry(201),
    ],
    201,
  );
  await reader.refresh();
  expect(
    reader.snapshot().messages.map((value) => [value.id, value.content]),
  ).toEqual([
    ["200", "revised"],
    ["201", "Message 201"],
  ]);
  state.result = data([], 201);
  await reader.refresh();
  expect(reader.snapshot().messages).toEqual([]);
  expect(reader.snapshot().latestSeq).toBe(201);
  reader.stop();
});

test("a full tail page is authoritative only from its first sequence on: older history accumulates", async () => {
  const { reader, state } = harness({ overrides: { limit: 3 } });
  state.result = data([entry(5), entry(6), entry(7)], 7);
  reader.start();
  await settle();
  // The window moved on; 5 and 6 are history now and stay, whatever happened to them upstream.
  state.result = data([entry(7), entry(8), entry(9)], 9);
  await reader.refresh();
  expect(reader.snapshot().messages.map((value) => value.id)).toEqual([
    "5",
    "6",
    "7",
    "8",
    "9",
  ]);
  expect(reader.snapshot().lastRefresh?.boundarySeq).toBe(7);
  // Inside the window a deletion (8) and an edit (9) both land; the marker moves to the newest
  // message held before this refresh.
  state.result = data(
    [
      entry(7),
      { ...entry(9, "revised"), revisedAt: "2026-09-07T10:00:00Z" },
      entry(10),
    ],
    10,
  );
  await reader.refresh();
  expect(
    reader.snapshot().messages.map((value) => [value.id, value.content]),
  ).toEqual([
    ["5", "Message 5"],
    ["6", "Message 6"],
    ["7", "Message 7"],
    ["9", "revised"],
    ["10", "Message 10"],
  ]);
  expect(reader.snapshot().lastRefresh?.boundarySeq).toBe(9);
  // A refresh that brings nothing new keeps the marker where it was.
  await reader.refresh();
  expect(reader.snapshot().lastRefresh?.boundarySeq).toBe(9);
  reader.stop();
});

test("loading older walks back through sparse sequences and stops at the beginning", async () => {
  // Bonfire sequences have gaps (deletions); fireside sequences are one counter shared by every room.
  const feed = [1, 2, 3, 4, 41, 42, 43, 53, 79, 80, 81, 82];
  const read = ({ since, limit }: TownReadRequest) => {
    const seqs =
      since === undefined
        ? feed.slice(-limit)
        : feed.filter((seq) => seq > since).slice(0, limit);
    return {
      messages: seqs.map((seq) => entry(seq)),
      latestSeq: 82,
      total: feed.length,
    };
  };
  const { reader, state } = harness({
    overrides: { limit: 3, pageable: true },
    read,
  });
  reader.start();
  await settle();
  expect(reader.snapshot().messages.map((value) => Number(value.id))).toEqual([
    80, 81, 82,
  ]);
  expect(reader.snapshot().hasOlder).toBe(true);
  // Dense guess first: the page before 80 holds 79 and overlaps what we have.
  await reader.loadOlder();
  expect(reader.snapshot().messages.map((value) => Number(value.id))).toEqual([
    79, 80, 81, 82,
  ]);
  expect(state.calls.length).toBe(2);
  // Then the gap below 79: widen until 41–43 appear, walk forward to close the stretch up to 79.
  await reader.loadOlder();
  expect(reader.snapshot().messages.map((value) => Number(value.id))).toEqual([
    41, 42, 43, 53, 79, 80, 81, 82,
  ]);
  expect(state.calls.length - 2).toBeLessThanOrEqual(6);
  await reader.loadOlder();
  expect(reader.snapshot().messages.map((value) => Number(value.id))).toEqual([
    1, 2, 3, 4, 41, 42, 43, 53, 79, 80, 81, 82,
  ]);
  expect(reader.snapshot().hasOlder).toBe(false);
  const calls = state.calls.length;
  await reader.loadOlder();
  expect(state.calls.length).toBe(calls);
  // Every request stayed within the SDK's bounds and only ever asked for what lies above `since`.
  expect(
    state.calls.every(
      (call) => call.limit === 3 && (call.since === undefined || call.since >= 0),
    ),
  ).toBe(true);
  reader.stop();
});

test("a walk that runs out of pages resumes where it stopped instead of starting over", async () => {
  const feed = [1, 100000, 100001, 100002];
  const read = ({ since, limit }: TownReadRequest) => {
    const seqs =
      since === undefined
        ? feed.slice(-limit)
        : feed.filter((seq) => seq > since).slice(0, limit);
    return {
      messages: seqs.map((seq) => entry(seq)),
      latestSeq: 100002,
      total: feed.length,
    };
  };
  const { reader, state } = harness({
    overrides: { limit: 3, pageable: true },
    read,
  });
  reader.start();
  await settle();
  await reader.loadOlder();
  expect(reader.snapshot().messages.length).toBe(3);
  expect(reader.snapshot().hasOlder).toBe(true);
  const probed = state.calls.slice(1).map((call) => call.since);
  expect(probed.length).toBe(6);
  await reader.loadOlder();
  const resumed = state.calls.slice(7).map((call) => call.since);
  expect(resumed[0]).toBeLessThan(probed[probed.length - 1] as number);
  let guard = 0;
  while (reader.snapshot().hasOlder && guard++ < 10) await reader.loadOlder();
  expect(reader.snapshot().messages.map((value) => Number(value.id))).toEqual(
    feed,
  );
  expect(reader.snapshot().hasOlder).toBe(false);
  reader.stop();
});

test("a burst that outran the window is filled from the server before the timeline shows a hole", async () => {
  let feed = [1, 2, 3];
  const read = ({ since, limit }: TownReadRequest) => {
    const seqs =
      since === undefined
        ? feed.slice(-limit)
        : feed.filter((seq) => seq > since).slice(0, limit);
    return {
      messages: seqs.map((seq) => entry(seq)),
      latestSeq: feed[feed.length - 1],
      total: feed.length,
    };
  };
  const { reader, state } = harness({
    overrides: { limit: 3, pageable: true },
    read,
  });
  reader.start();
  await settle();
  feed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  await reader.refresh();
  await settle();
  expect(reader.snapshot().messages.map((value) => Number(value.id))).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  expect(state.calls.slice(1).map((call) => call.since)).toEqual([
    undefined,
    3,
    6,
  ]);
  reader.stop();
});

test("loading older is refused where the transport cannot page, and never runs twice at once", async () => {
  const { reader } = harness();
  reader.start();
  await settle();
  await rejects(reader.loadOlder(), { code: "BACKGROUND_UNAVAILABLE" });
  expect(reader.snapshot().hasOlder).toBe(false);
  const gate = deferred<void>();
  const paged = harness({
    overrides: { limit: 2, pageable: true },
    read: ({ since }: TownReadRequest) =>
      since === undefined
        ? data([entry(8), entry(9)], 9)
        : gate.promise.then(() => ({
            messages: [entry(6), entry(7)],
            latestSeq: 9,
            total: 9,
          })),
  });
  paged.reader.start();
  await settle();
  const first = paged.reader.loadOlder(),
    second = paged.reader.loadOlder();
  expect(first).toBe(second);
  gate.resolve();
  await first;
  expect(
    paged.reader.snapshot().messages.map((value) => Number(value.id)),
  ).toEqual([6, 7, 8, 9]);
  paged.reader.stop();
  await rejects(paged.reader.loadOlder(), { code: "NOT_RUNNING" });
  reader.stop();
});

test("unchanged snapshots do not publish new messages and returned values cannot mutate the cache", async () => {
  const { reader, state } = harness();
  state.result = data([entry(1, "PRIVATE_MESSAGE_SENTINEL")]);
  reader.start();
  await settle();
  await reader.refresh();
  expect(state.snapshots.length).toBe(1);
  const snapshot = reader.snapshot();
  snapshot.messages[0].content = "changed";
  (snapshot.identity as { beingId: string }).beingId = "bob";
  state.snapshots[0].messages.length = 0;
  expect(reader.snapshot().messages[0].content).toBe(
    "PRIVATE_MESSAGE_SENTINEL",
  );
  expect(reader.snapshot().identity?.beingId).toBe("alice");
  expect(
    JSON.stringify(reader.status()).includes("PRIVATE_MESSAGE_SENTINEL"),
  ).toBe(false);
  expect(
    JSON.stringify(state.statuses).includes("PRIVATE_MESSAGE_SENTINEL"),
  ).toBe(false);
  reader.stop();
});

test("transient failures preserve prior content and success time with bounded minute backoff", async () => {
  let broken = false;
  const { reader, clock, state } = harness({
    read: () => {
      if (broken) throw fault("NETWORK_ERROR");
      return data();
    },
  });
  reader.start();
  await settle();
  const successAt = reader.status().lastSuccessAt;
  broken = true;
  for (const delay of [MINUTE, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE]) {
    await rejects(reader.refresh(), { code: "NETWORK_ERROR" });
    expect(reader.status().nextRefreshAt).toBe(clock.now() + delay);
    expect(reader.status().lastSuccessAt).toBe(successAt);
    expect(reader.status().stale).toBe(true);
    expect(reader.snapshot().messages.length).toBe(1);
    expect(JSON.stringify(reader.status()).includes("PRIVATE_REMOTE_DETAIL")).toBe(
      false,
    );
  }
  broken = false;
  await reader.refresh();
  expect(reader.status().failureCount).toBe(0);
  expect(reader.status().stale).toBe(false);
  expect(reader.status().nextRefreshAt).toBe(clock.now() + MINUTE);
  expect(state.snapshots.length).toBe(1);
  reader.stop();
});

test("rate limiting honors bounded retry delay and never retries sooner than a minute", async () => {
  const { reader, clock } = harness({
    read: () => {
      throw fault("RATE_LIMITED", { retryAfterMs: 180000 });
    },
  });
  reader.start();
  await settle();
  expect(reader.status().nextRefreshAt).toBe(clock.now() + 180000);
  reader.stop();
  const fast = harness({
    read: () => {
      throw fault("RATE_LIMITED", { retryAfterMs: 2 });
    },
  });
  fast.reader.start();
  await settle();
  expect(fast.reader.status().nextRefreshAt).toBe(fast.clock.now() + MINUTE);
  fast.reader.stop();
});

test("authorization, identity and unavailable errors pause until manual retry or reset", async () => {
  for (const code of [
    "AUTH_REQUIRED",
    "IDENTITY_MISMATCH",
    "BACKGROUND_UNAVAILABLE",
  ]) {
    let broken = true;
    const { reader, clock, state } = harness({
      read: () => {
        if (broken) throw fault(code);
        return data();
      },
    });
    reader.start();
    await settle();
    expect(reader.status().status).toBe("paused");
    expect(reader.status().errorCode).toBe(code);
    expect(clock.timers.size).toBe(0);
    await clock.advance(60 * MINUTE);
    reader.resume();
    await settle();
    expect(state.calls.length).toBe(1);
    reader.pause("suspended");
    reader.resume();
    await settle();
    expect(state.calls.length).toBe(1);
    broken = false;
    await reader.refresh();
    expect(state.calls.length).toBe(2);
    expect(reader.status().status).toBe("ready");
    reader.stop();
  }
});

test("pause aborts in-flight work and resume coalesces without replaying missed ticks", async () => {
  const gate = deferred<unknown>();
  const { reader, clock, state } = harness({
    read: (_args, current) =>
      current.calls.length === 1 ? gate.promise : data([entry(2)]),
  });
  reader.start();
  await settle();
  const pending = reader.refresh();
  const rejected = rejects(pending, { code: "SESSION_CHANGED" });
  reader.pause("suspended");
  expect(state.calls[0].signal.aborted).toBe(true);
  await clock.advance(20 * MINUTE);
  expect(state.calls.length).toBe(1);
  await rejects(reader.refresh(), { code: "PAUSED" });
  reader.resume();
  reader.resume();
  await settle();
  expect(state.calls.length).toBe(2);
  gate.resolve(data([entry(1, "STALE")]));
  await rejected;
  expect(reader.snapshot().messages[0].id).toBe("2");
  expect(clock.timers.size).toBe(1);
  reader.stop();
});

test("stop and restart cannot silently retry a blocked authorization failure", async () => {
  const { reader, clock, state } = harness({
    read: () => {
      throw fault("AUTH_REQUIRED");
    },
  });
  reader.start();
  await settle();
  reader.stop();
  await clock.advance(10 * MINUTE);
  reader.start();
  await settle();
  expect(state.calls.length).toBe(1);
  expect(reader.status().status).toBe("paused");
  expect(clock.timers.size).toBe(0);
  reader.reset();
  await settle();
  expect(state.calls.length).toBe(2);
  reader.stop();
});

test("brief pause and repeated resume cannot shorten the automatic interval", async () => {
  const { reader, clock, state } = harness();
  reader.start();
  await settle();
  await clock.advance(1000);
  reader.pause();
  reader.resume();
  reader.resume();
  await settle();
  expect(state.calls.length).toBe(1);
  expect(reader.status().status).toBe("waiting");
  expect(reader.status().reason).toBe("");
  await clock.advance(MINUTE - 1);
  expect(state.calls.length).toBe(1);
  await clock.advance(1);
  expect(state.calls.length).toBe(2);
  reader.stop();
});

test("identity reset aborts old transport and cannot let its finally replace the new timer", async () => {
  const gate = deferred<unknown>();
  const { reader, clock, state } = harness({
    read: (_args, current) =>
      current.calls.length === 1
        ? gate.promise
        : data([entry(2, "NEW_IDENTITY")]),
  });
  reader.start();
  await settle();
  const pending = reader.refresh();
  const rejected = rejects(pending, { code: "SESSION_CHANGED" });
  state.identity = { beingId: "bob", connectionRevision: 2, identityRevision: 2 };
  reader.reset();
  await settle();
  expect(state.calls[0].signal.aborted).toBe(true);
  expect(state.calls[1].identity.beingId).toBe("bob");
  gate.resolve(data([entry(1, "OLD_IDENTITY")]));
  await rejected;
  expect(reader.snapshot().identity?.beingId).toBe("bob");
  expect(reader.snapshot().messages[0].content).toBe("NEW_IDENTITY");
  expect(clock.timers.size).toBe(1);
  reader.stop();
});

test("identity change without an explicit reset is checked before committing a response", async () => {
  const gate = deferred<unknown>();
  const { reader, state } = harness({
    read: (_args, current) =>
      current.calls.length === 1 ? gate.promise : data([entry(2)]),
  });
  reader.start();
  await settle();
  state.identity = { beingId: "bob", connectionRevision: 2, identityRevision: 2 };
  gate.resolve(data([entry(1)]));
  await settle();
  expect(state.calls.length).toBe(2);
  expect(reader.snapshot().identity?.beingId).toBe("bob");
  expect(reader.snapshot().messages[0].id).toBe("2");
  reader.stop();
});

test("missing or malformed identity clears cached messages and last success before pausing", async () => {
  for (const identity of [
    null,
    { beingId: "bob" },
    {
      beingId: "bob",
      connectionRevision: 2,
      identityRevision: 2,
      token: "DO_NOT_LEAK",
    },
  ]) {
    const { reader, state, clock } = harness();
    reader.start();
    await settle();
    expect(reader.snapshot().messages.length).toBe(1);
    state.identity = identity;
    await rejects(reader.refresh(), {
      code: identity ? "IDENTITY_MISMATCH" : "NOT_CONNECTED",
    });
    expect(reader.snapshot()).toEqual({
      identity: null,
      messages: [],
      latestSeq: null,
      total: null,
      hasOlder: false,
      lastRefresh: null,
    });
    expect(reader.status().lastSuccessAt).toBe(null);
    expect(clock.timers.size).toBe(0);
    expect(JSON.stringify(state.statuses).includes("DO_NOT_LEAK")).toBe(false);
    expect(state.calls.length).toBe(1);
    reader.stop();
  }
});

test("getIdentity exceptions and getters cannot retain previous identity or leak details", async () => {
  let broken = false;
  const { reader } = harness({
    overrides: {
      getIdentity: () => {
        if (broken) throw new Error("PRIVATE_IDENTITY_ERROR");
        return { beingId: "alice", connectionRevision: 1, identityRevision: 1 };
      },
    },
  });
  reader.start();
  await settle();
  broken = true;
  const error = await caught(reader.refresh());
  expect(error.code).toBe("IDENTITY_MISMATCH");
  expect(error.message.includes("PRIVATE")).toBe(false);
  expect(reader.status().lastSuccessAt).toBe(null);
  expect(reader.snapshot().messages.length).toBe(0);
  reader.stop();
  let getterUsed = false;
  const invalid = harness();
  invalid.state.identity = {
    get beingId() {
      getterUsed = true;
      return "alice";
    },
    connectionRevision: 1,
    identityRevision: 1,
  };
  invalid.reader.start();
  await settle();
  expect(getterUsed).toBe(false);
  expect(invalid.state.calls.length).toBe(0);
  invalid.reader.stop();
});

test("stop then reset clears data without issuing a new request", async () => {
  const { reader, state, clock } = harness();
  reader.start();
  await settle();
  reader.stop();
  reader.reset();
  await clock.advance(20 * MINUTE);
  expect(state.calls.length).toBe(1);
  expect(reader.status().status).toBe("stopped");
  expect(reader.snapshot().messages.length).toBe(0);
  await rejects(reader.refresh(), { code: "NOT_RUNNING" });
});

test("malformed transport results preserve the previous complete window", async () => {
  const { reader, state } = harness();
  reader.start();
  await settle();
  const malformed = [
    null,
    { messages: [], latestSeq: -1 },
    data([entry(3)], 2),
    data([{ id: "bad", content: "x" } as unknown as ReturnType<typeof entry>], 5),
    data(Array.from({ length: 201 }, (_, index) => entry(index))),
  ];
  for (const value of malformed) {
    state.result = value;
    await rejects(reader.refresh(), { code: "INVALID_RESPONSE" });
    expect(reader.snapshot().messages[0].id).toBe("1");
    expect(reader.status().stale).toBe(true);
  }
  reader.stop();
});

test("limits are configurable only within the supported minute and message bounds", async () => {
  for (const options of [
    { intervalMs: 59999 },
    { intervalMs: 300001 },
    { limit: 0 },
    { limit: 201 },
  ]) {
    expect(
      () =>
        new TownRefresh({
          readSnapshot: () => data(),
          getIdentity: () => null,
          ...options,
        }),
    ).toThrow(RangeError);
  }
  const { reader, state } = harness({ overrides: { limit: 200 } });
  state.result = data(Array.from({ length: 200 }, (_, index) => entry(index)));
  reader.start();
  await settle();
  expect(reader.snapshot().messages.length).toBe(200);
  expect(state.calls[0].limit).toBe(200);
  reader.stop();
});

test("snapshot and status observers cannot alter results by throwing", async () => {
  const { reader, clock } = harness({
    overrides: {
      onSnapshot: () => {
        throw new Error("Observer failed");
      },
      onStatus: () => {
        throw new Error("Observer failed");
      },
    },
  });
  reader.start();
  await settle();
  expect(reader.status().status).toBe("ready");
  expect(reader.snapshot().messages.length).toBe(1);
  expect(clock.timers.size).toBe(1);
  reader.stop();
});

test("cached revisions preserve capture time and cannot overwrite data with repeated or older results", async () => {
  const { reader, clock, state } = harness({ overrides: { cached: true } });
  state.result = {
    ...data([entry(1, "Original")]),
    capturedAt: 500,
    revision: "capture:one",
  };
  reader.start();
  await settle();
  expect(reader.status().lastSuccessAt).toBe(500);
  expect(reader.status().lastCheckedAt).toBe(1000);
  expect(reader.status().revision).toBe("capture:one");
  state.result = {
    ...data([entry(2, "Different content under the same revision")]),
    capturedAt: 900,
    revision: "capture:one",
  };
  await clock.advance(MINUTE);
  expect(reader.status().lastSuccessAt).toBe(500);
  expect(reader.status().lastCheckedAt).toBe(clock.now());
  expect(reader.snapshot().messages[0].content).toBe("Original");
  expect(state.snapshots.length).toBe(1);
  state.result = {
    ...data([entry(3, "Older capture")]),
    capturedAt: 400,
    revision: "capture:old",
  };
  await reader.refresh();
  expect(reader.status().revision).toBe("capture:one");
  expect(reader.snapshot().messages[0].content).toBe("Original");
  state.result = {
    ...data([], 3),
    capturedAt: clock.now() - 10,
    revision: "capture:two",
  };
  await reader.refresh();
  expect(reader.status().lastSuccessAt).toBe(clock.now() - 10);
  expect(reader.status().revision).toBe("capture:two");
  expect(reader.snapshot().messages).toEqual([]);
  expect(reader.status().reason).toBe("sbs");
  reader.stop();
});

test("waiting for SBS preserves the last snapshot and capture time without counting a failure", async () => {
  let waiting = false;
  const { reader, clock, state } = harness({
    overrides: { cached: true },
    read: () => {
      if (waiting) throw fault("WAITING_SBS");
      return { ...data(), capturedAt: 500, revision: "capture:one" };
    },
  });
  reader.start();
  await settle();
  waiting = true;
  await clock.advance(3 * MINUTE);
  expect(state.calls.length).toBe(4);
  expect(reader.status().lastSuccessAt).toBe(500);
  expect(reader.status().lastCheckedAt).toBe(clock.now());
  expect(reader.status().reason).toBe("waiting_sbs");
  expect(reader.status().status).toBe("waiting");
  expect(reader.status().failureCount).toBe(0);
  expect(reader.status().stale).toBe(true);
  expect(reader.status().revision).toBe("capture:one");
  expect(reader.snapshot().messages[0].id).toBe("1");
  expect(reader.status().nextRefreshAt).toBe(clock.now() + MINUTE);
  reader.stop();
});

test("missing or malformed cache receipts cannot masquerade as fresh snapshots", async () => {
  const { reader, state } = harness({ overrides: { cached: true } });
  state.result = { ...data(), capturedAt: 500, revision: "capture:one" };
  reader.start();
  await settle();
  for (const receipt of [
    {},
    { capturedAt: "500", revision: "x" },
    { capturedAt: -1, revision: "x" },
    { capturedAt: 8640000000000001, revision: "x" },
    { capturedAt: 500, revision: "" },
    { capturedAt: 500, revision: "x\n" },
    { capturedAt: 500, revision: "x".repeat(129) },
  ]) {
    state.result = { ...data([entry(2)]), ...receipt };
    await rejects(reader.refresh(), { code: "INVALID_RESPONSE" });
    expect(reader.snapshot().messages[0].id).toBe("1");
    expect(reader.status().lastSuccessAt).toBe(500);
    expect(reader.status().revision).toBe("capture:one");
  }
  reader.stop();
});

test("cache identity reset clears the receipt and allows the new identity older capture", async () => {
  const { reader, state } = harness({ overrides: { cached: true } });
  state.result = {
    ...data([entry(1, "Alice")]),
    capturedAt: 900,
    revision: "alice:one",
  };
  reader.start();
  await settle();
  state.identity = { beingId: "bob", connectionRevision: 2, identityRevision: 2 };
  state.result = {
    ...data([entry(2, "Bob")]),
    capturedAt: 400,
    revision: "bob:one",
  };
  reader.reset();
  await settle();
  expect(reader.snapshot().identity?.beingId).toBe("bob");
  expect(reader.snapshot().messages[0].content).toBe("Bob");
  expect(reader.status().lastSuccessAt).toBe(400);
  expect(reader.status().revision).toBe("bob:one");
  reader.stop();
});

test("an unconfigured SBS source remains distinct from waiting for a scheduled capture", async () => {
  let code = "";
  const { reader, clock, state } = harness({
    overrides: { cached: true },
    read: () => {
      if (code) throw fault(code);
      return { ...data(), capturedAt: 500, revision: "capture:one" };
    },
  });
  reader.start();
  await settle();
  code = "SBS_NOT_CONFIGURED";
  await rejects(reader.refresh(), {
    code,
    message: "后台采集尚未设置，可请 Being 读取一次",
  });
  reader.pause("offline");
  reader.resume();
  expect(reader.status().status).toBe("waiting");
  expect(reader.status().reason).toBe("sbs_not_configured");
  await clock.advance(3 * MINUTE);
  expect(reader.status().reason).toBe("sbs_not_configured");
  expect(reader.status().failureCount).toBe(0);
  expect(reader.status().lastSuccessAt).toBe(500);
  expect(reader.status().lastCheckedAt).toBe(clock.now());
  expect(reader.snapshot().messages[0].id).toBe("1");
  expect(reader.status().stale).toBe(true);
  expect(state.calls.length).toBe(5);
  code = "WAITING_SBS";
  await clock.advance(MINUTE);
  expect(reader.status().reason).toBe("waiting_sbs");
  expect(reader.status().failureCount).toBe(0);
  expect(reader.status().nextRefreshAt).toBe(clock.now() + MINUTE);
  reader.stop();
});
