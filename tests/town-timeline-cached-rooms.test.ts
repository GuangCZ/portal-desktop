// Ported line by line from BeingDesktop 0.8.26 test/town-cache-handlers.test.cjs on 2026-09-16.
// The original sliced loadCachedFiresides / loadCachedFiresideMembers out of src/main.cjs with
// new Function; here they come from the factory those closures were lifted into. Fixtures and
// case names are unchanged; only the assertion style and the harness wiring differ.
import { expect, test } from "vitest";
import { createCachedRoomLoaders } from "../desktop/main/town/timeline/cached-rooms";
import type {
  TownMemberCache,
  TownRoomCache,
} from "../desktop/main/town/timeline/cached-rooms";
import type {
  TownCacheResult,
  TownCodedError,
} from "../desktop/main/town/timeline/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

type Snapshot = (request: {
  method: string;
  value?: unknown;
}) => Promise<TownCacheResult> | TownCacheResult;

function harness(snapshot: Snapshot) {
  let generation = 1,
    identityRevision = 1;
  let townRoomCache: TownRoomCache = { owned: [], joined: [], cached: false };
  const townMemberCache = new Map<string, TownMemberCache>();
  const reconciled: unknown[] = [];
  const loaders = createCachedRoomLoaders({
    reads: {
      snapshot: async (value) =>
        snapshot(value as { method: string; value?: unknown }),
    },
    getRooms: () => townRoomCache,
    setRooms: (value) => {
      townRoomCache = value;
    },
    members: townMemberCache,
    getRevisions: () => ({ generation, identityRevision }),
    reconcileRooms: (value) => reconciled.push(value),
  });
  return {
    rooms: loaders.loadCachedFiresides,
    members: loaders.loadCachedFiresideMembers,
    reconciled,
    setRooms: (value: TownRoomCache) => {
      townRoomCache = value;
    },
    setMembers: (id: string, value: TownMemberCache) =>
      townMemberCache.set(id, value),
    switchIdentity: () => {
      generation++;
      identityRevision++;
      townRoomCache = { owned: [], joined: [], cached: false };
      townMemberCache.clear();
    },
    getMembers: (id: string) => townMemberCache.get(id),
  };
}

async function rejects(promise: Promise<unknown>, code: string) {
  let error: unknown = null;
  let settled = false;
  try {
    await promise;
    settled = true;
  } catch (thrown) {
    error = thrown;
  }
  expect(settled, "expected the promise to reject").toBe(false);
  expect((error as TownCodedError).code).toBe(code);
}

const rooms = { owned: [{ id: "7", name: "Saved room" }], joined: [] };
const savedRooms: TownCacheResult = {
  cached: true,
  data: rooms,
  lastSuccessAt: 1000,
};

test("a cold room list restores locally and reconciles memberships before a room is selected", async () => {
  const app = harness(async (request) => {
    expect(request.method).toBe("getFiresides");
    return savedRooms;
  });
  expect(await app.rooms()).toEqual({
    ...rooms,
    cached: true,
    lastSuccessAt: 1000,
  });
  expect(app.reconciled).toEqual([rooms]);
  const copy = await app.rooms();
  copy.owned.length = 0;
  expect((await app.rooms()).owned.length).toBe(1);
});

test("new live room data wins over an older disk read", async () => {
  const gate = deferred<TownCacheResult>();
  const app = harness(() => gate.promise);
  const pending = app.rooms();
  const fresh: TownRoomCache = {
    owned: [{ id: "8" }],
    joined: [],
    cached: true,
    lastSuccessAt: 2000,
  };
  app.setRooms(fresh);
  gate.resolve(savedRooms);
  expect(await pending).toEqual(fresh);
  expect(app.reconciled).toEqual([]);
});

test("room members restore separately and removed rooms do not restore old members", async () => {
  const requests: { method: string }[] = [];
  const app = harness(async (request) => {
    requests.push(request);
    return request.method === "getFiresides"
      ? savedRooms
      : {
          cached: true,
          data: { members: [{ id: "alice" }] },
          lastSuccessAt: 1100,
        };
  });
  expect(
    ((await app.members("7")).members[0] as { id: string }).id,
  ).toBe("alice");
  expect(await app.members("8")).toEqual({ members: [], cached: false });
  expect(
    requests.filter((request) => request.method === "getFiresideMembers")
      .length,
  ).toBe(1);
});

test("an identity switch between a validated disk result and the helper continuation cannot restore old members", async () => {
  const gate = deferred<TownCacheResult>();
  const app = harness((request) =>
    request.method === "getFiresides" ? Promise.resolve(savedRooms) : gate.promise,
  );
  await app.rooms();
  const pending = app.members("7");
  await Promise.resolve();
  // Simulate a result which has already passed the cache coordinator check.
  app.switchIdentity();
  gate.resolve({
    cached: true,
    data: { members: [{ id: "old-private" }] },
    lastSuccessAt: 1000,
  });
  await rejects(pending, "SESSION_CHANGED");
  expect(app.getMembers("7")).toBe(undefined);
});

test("identity switches during room restoration also reject a member load", async () => {
  const gate = deferred<TownCacheResult>();
  const app = harness(() => gate.promise);
  const pending = app.members("7");
  app.switchIdentity();
  gate.resolve(savedRooms);
  await rejects(pending, "SESSION_CHANGED");
  expect(app.getMembers("7")).toBe(undefined);
});
