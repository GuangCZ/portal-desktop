// Ported line by line from BeingDesktop 0.8.26 test/town-cached-reads.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style changed (node:test -> vitest).
// The final case is new: it pins the 60 second member TTL named in docs/interfaces.md section 7.
import { expect, test } from "vitest";
import { TownCachedReads } from "../desktop/main/town/timeline/cached-reads";
import type {
  TownCacheResult,
  TownCacheStore,
  TownCachedReadsContext,
  TownCodedError,
} from "../desktop/main/town/timeline/types";

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

function harness(now: () => number = () => 1000) {
  const data = new Map<string, TownCacheResult>();
  let context: TownCachedReadsContext = {
    identityKey: "alice-session",
    revision: 1,
    identityRevision: 1,
    connected: true,
  };
  const cache: TownCacheStore = {
    async load(identity: string, resource: string) {
      return structuredClone(
        data.get(JSON.stringify([identity, resource])) || {
          cached: false,
          data: null,
          lastSuccessAt: null,
        },
      );
    },
    async save(identity: string, resource: string, value: unknown) {
      data.set(JSON.stringify([identity, resource]), {
        cached: true,
        data: structuredClone(value),
        lastSuccessAt: 1000,
      });
      return true;
    },
  };
  const reads = new TownCachedReads({
    cache,
    getContext: () => context,
    now,
  });
  return {
    reads,
    cache,
    data,
    setContext(value: Partial<TownCachedReadsContext>) {
      context = { ...context, ...value };
    },
  };
}

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
async function rejects(promise: Promise<unknown>, code: string) {
  expect((await caught(promise)).code).toBe(code);
}

test("private pages and visibility filters use canonical distinct cache keys", async () => {
  const { reads } = harness();
  await reads.read("listScrolls", { limit: 50, offset: 0 }, async (value) => ({
    scrolls: [{ id: "first" }],
    query: value,
  }));
  const first = await reads.snapshot({ method: "listScrolls" });
  expect(first.cached).toBe(true);
  expect((first.data as { scrolls: { id: string }[] }).scrolls[0].id).toBe(
    "first",
  );
  expect((first.data as { query: unknown }).query).toEqual({
    offset: 0,
    limit: 50,
  });
  for (const value of [{ offset: 1 }, { limit: 100 }, { visibility: "shared" }])
    expect(
      (await reads.snapshot({ method: "listScrolls", value })).cached,
    ).toBe(false);
  await reads.read("getScroll", { id: "first", offset: 10000 }, async () => ({
    scroll: { id: "first", content: "Continuation" },
  }));
  expect(
    (await reads.snapshot({ method: "getScroll", value: { id: "first" } }))
      .cached,
  ).toBe(false);
  expect(
    (
      (
        await reads.snapshot({
          method: "getScroll",
          value: { id: "first", offset: 10000, limit: 10000 },
        })
      ).data as { scroll: { content: string } }
    ).scroll.content,
  ).toBe("Continuation");
  await reads.read("getFiresideMembers", "7", async () => ({
    members: [{ id: "alice" }],
  }));
  expect(
    (await reads.snapshot({ method: "getFiresideMembers", value: "8" })).cached,
  ).toBe(false);
});

test("new sessions cannot restore private data but reconnect to the same account can", async () => {
  const { reads, setContext } = harness();
  await reads.read("getFiresides", undefined, async () => ({
    owned: [{ id: "7" }],
    joined: [],
  }));
  setContext({ revision: 2 });
  expect((await reads.snapshot({ method: "getFiresides" })).cached).toBe(true);
  setContext({ identityKey: "bob-session", revision: 3, identityRevision: 2 });
  expect((await reads.snapshot({ method: "getFiresides" })).cached).toBe(false);
  setContext({ identityKey: "alice-session", connected: false });
  expect((await reads.snapshot({ method: "getFiresides" })).cached).toBe(false);
  await rejects(
    reads.read("getFiresides", undefined, () => {
      throw new Error("Disconnected private reader");
    }),
    "NOT_CONNECTED",
  );
});

test("public directories and Grove catalog remain cached when disconnected or changing Being", async () => {
  const { reads, setContext } = harness();
  for (const [method, value, data] of [
    ["listBeings", {}, { beings: [{ id: "alice" }] }],
    ["getBeingMembers", undefined, { members: [{ id: "alice" }] }],
    ["getGroveCatalog", { limit: 100 }, { kits: [{ id: "kit" }] }],
    ["getGroveDetail", "kit", { id: "kit", name: "Kit" }],
  ] as [string, unknown, unknown][])
    await reads.read(method, value, async () => data);
  setContext({ identityKey: "", connected: false, revision: 2 });
  expect(
    (
      (await reads.snapshot({ method: "listBeings" })).data as {
        beings: { id: string }[];
      }
    ).beings[0].id,
  ).toBe("alice");
  expect(
    (
      (await reads.snapshot({ method: "getBeingMembers" })).data as {
        members: { id: string }[];
      }
    ).members[0].id,
  ).toBe("alice");
  expect(
    (
      (
        await reads.snapshot({
          method: "getGroveCatalog",
          value: { offset: 0, limit: 100 },
        })
      ).data as { kits: { id: string }[] }
    ).kits[0].id,
  ).toBe("kit");
  expect(
    (
      (await reads.snapshot({ method: "getGroveDetail", value: "kit" }))
        .data as { id: string }
    ).id,
  ).toBe("kit");
});

test("cache reads cannot invoke writes or accept arbitrary methods, getters or malformed selectors", async () => {
  const { reads, data } = harness();
  for (const value of [
    null,
    {},
    { method: "sendBonfireMessage" },
    { method: "getState" },
    { method: "getScroll", value: { id: "../secret" } },
    { method: "listScrolls", value: { offset: -1 } },
    { method: "getGroveCatalog", value: { limit: 101 } },
    { method: "getFiresideMembers", value: "01" },
    { method: "listBeings", value: { token: "secret" } },
    { method: "listBeings", arbitrary: true },
    {
      get method(): string {
        throw new Error("Getter must not execute");
      },
    },
  ]) {
    await rejects(reads.snapshot(value), "INVALID_REQUEST");
  }
  expect(data.size).toBe(0);
});

test("failed live requests retain cached data and authoritative empty results replace it", async () => {
  const { reads } = harness();
  await reads.read("listScrolls", {}, async () => ({
    scrolls: [{ id: "old" }],
  }));
  await expect(
    reads.read("listScrolls", {}, async () => {
      throw new Error("Offline");
    }),
  ).rejects.toThrow(/Offline/);
  expect(
    (
      (await reads.snapshot({ method: "listScrolls" })).data as {
        scrolls: { id: string }[];
      }
    ).scrolls[0].id,
  ).toBe("old");
  await reads.read("listScrolls", {}, async () => ({ scrolls: [] }));
  expect(
    (
      (await reads.snapshot({ method: "listScrolls" })).data as {
        scrolls: unknown[];
      }
    ).scrolls,
  ).toEqual([]);
});

test("late private reads and disk loads are rejected across identity changes", async () => {
  const { reads, cache, data, setContext } = harness();
  const live = deferred<{ scrolls: { id: string }[] }>();
  const request = reads.read("listScrolls", {}, () => live.promise);
  setContext({ identityKey: "bob-session", revision: 2, identityRevision: 2 });
  live.resolve({ scrolls: [{ id: "alice-private" }] });
  await rejects(request, "SESSION_CHANGED");
  expect(data.size).toBe(0);
  const disk = deferred<TownCacheResult>();
  cache.load = () => disk.promise;
  const snapshot = reads.snapshot({ method: "getFiresides" });
  setContext({ identityKey: "carol-session", revision: 3, identityRevision: 3 });
  disk.resolve({
    cached: true,
    data: { owned: [{ id: "bob-private" }] },
  } as TownCacheResult);
  await rejects(snapshot, "SESSION_CHANGED");
});

test("an older overlapping live read cannot overwrite a newer saved response", async () => {
  const { reads } = harness();
  const old = deferred<{ kits: { id: string }[] }>();
  const pending = reads.read("getGroveCatalog", {}, () => old.promise);
  await reads.read("getGroveCatalog", {}, async () => ({
    kits: [{ id: "new" }],
  }));
  old.resolve({ kits: [{ id: "old" }] });
  await pending;
  expect(
    (
      (await reads.snapshot({ method: "getGroveCatalog" })).data as {
        kits: { id: string }[];
      }
    ).kits[0].id,
  ).toBe("new");
});

test("persistence failures do not reject a validated live result", async () => {
  const { reads, cache } = harness();
  for (const save of [
    () => {
      throw new Error("Unavailable");
    },
    async () => {
      throw new Error("Disk full");
    },
    async () => false,
  ] as TownCacheStore["save"][]) {
    cache.save = save;
    expect(await reads.read("listBeings", {}, async () => ({ beings: [] }))).toEqual(
      { beings: [] },
    );
  }
});

// New for the port: the member TTL and invalidation stamp named in docs/interfaces.md section 7.
test("member reads expire after sixty seconds and after an explicit invalidation", async () => {
  let now = 1000;
  const { reads } = harness(() => now);
  await reads.read("getFiresideMembers", "7", async () => ({
    members: [{ id: "alice" }],
  }));
  expect(
    (await reads.snapshot({ method: "getFiresideMembers", value: "7" })).cached,
  ).toBe(true);
  now = 1000 + 59999;
  expect(
    (await reads.snapshot({ method: "getFiresideMembers", value: "7" })).cached,
  ).toBe(true);
  now = 1000 + 60000;
  expect(
    (await reads.snapshot({ method: "getFiresideMembers", value: "7" })).cached,
  ).toBe(false);
  now = 1000;
  expect(
    (await reads.snapshot({ method: "getFiresideMembers", value: "7" })).cached,
  ).toBe(true);
  reads.invalidateMembers();
  expect(
    (await reads.snapshot({ method: "getFiresideMembers", value: "7" })).cached,
  ).toBe(false);
});
