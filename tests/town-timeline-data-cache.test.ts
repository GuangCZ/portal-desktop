// Ported line by line from BeingDesktop 0.8.26 test/town-data-cache.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style and the scratch directory changed
// (node:test -> vitest, repo-local .local -> os.tmpdir, matching this repo's own test convention).
// The final case is new: it proves the reader and writer stay byte-compatible with 0.8.x files.
import { afterEach, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { TownDataCache } from "../desktop/main/town/timeline/data-cache";
import type {
  SecretStorage,
  TownCacheResult,
} from "../desktop/main/town/timeline/types";

const identity = "persist:being-example";
const resource = 'getFiresideMessages:{"id":"example","limit":100}';
const capturedAt = 1788750000000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const filename = (
  directory: string,
  identityKey = identity,
  resourceKey = resource,
) => path.join(directory, hash(identityKey), `${hash(resourceKey)}.bin`);
const miss: TownCacheResult = { cached: false, data: null, lastSuccessAt: null };
const restored = (data: unknown): TownCacheResult => ({
  cached: true,
  data,
  lastSuccessAt: capturedAt,
});

interface MutableStorage extends SecretStorage {
  encryptString(value: string): Buffer;
}

function encryptedStorage(): MutableStorage {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        decipher.update(value.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

const scratch: string[] = [];
const opened: TownDataCache[] = [];
afterEach(async () => {
  for (const cache of opened.splice(0)) await cache.flush();
  for (const dir of scratch.splice(0))
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
});

async function fixture(
  options: { safeStorage?: SecretStorage; clock?: () => number } = {},
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "town-data-cache-test-"),
  );
  scratch.push(directory);
  const safeStorage = options.safeStorage || encryptedStorage();
  const cache = new TownDataCache({
    directory,
    safeStorage,
    clock: () => capturedAt,
    ...options,
  });
  opened.push(cache);
  return { directory, safeStorage: safeStorage as MutableStorage, cache };
}

test("Town data restores in a new instance with its fetch time and encrypted content", async () => {
  const { directory, safeStorage, cache } = await fixture();
  const data = {
    messages: [
      { id: "1", content: "Previously fetched synthetic Fireside message" },
    ],
    latestSeq: 1,
  };
  expect(await cache.load(identity, resource)).toEqual(miss);
  expect(await cache.save(identity, resource, data)).toBe(true);
  expect(await cache.flush()).toBe(true);
  const raw = await fs.readFile(filename(directory));
  expect(raw.includes(Buffer.from(data.messages[0].content))).toBe(false);
  expect(raw.includes(Buffer.from(identity))).toBe(false);
  expect(raw.includes(Buffer.from(resource))).toBe(false);
  const second = new TownDataCache({ directory, safeStorage });
  expect(await second.load(identity, resource)).toEqual(restored(data));
  const loaded = await second.load(identity, resource);
  (loaded.data as typeof data).messages[0].content = "Mutated caller copy";
  expect(await second.load(identity, resource)).toEqual(restored(data));
});

test("exact identities and resource parameters have isolated cache entries", async () => {
  const { directory, cache } = await fixture();
  const otherIdentity = "persist:being-example-other";
  const otherResource = 'getFiresideMessages:{"id":"another","limit":100}';
  await Promise.all([
    cache.save(identity, resource, { content: "First room" }),
    cache.save(identity, otherResource, { content: "Second room" }),
    cache.save(otherIdentity, resource, { content: "Different account" }),
    cache.save("public", resource, { content: "Public data" }),
  ]);
  expect(await cache.load(identity, resource)).toEqual(
    restored({ content: "First room" }),
  );
  expect(await cache.load(identity, otherResource)).toEqual(
    restored({ content: "Second room" }),
  );
  expect(await cache.load(otherIdentity, resource)).toEqual(
    restored({ content: "Different account" }),
  );
  expect(await cache.load("public", resource)).toEqual(
    restored({ content: "Public data" }),
  );
  expect(await cache.load(identity.toUpperCase(), resource)).toEqual(miss);
  await fs.copyFile(
    filename(directory),
    filename(directory, identity, otherResource),
  );
  expect(await cache.load(identity, otherResource)).toEqual(miss);
  await fs.copyFile(
    filename(directory),
    filename(directory, otherIdentity, resource),
  );
  expect(await cache.load(otherIdentity, resource)).toEqual(miss);
});

test("a load immediately after concurrent saves waits for the newest immutable snapshot", async () => {
  let now = capturedAt;
  const { directory, cache } = await fixture({ clock: () => now++ });
  const pending: Promise<boolean>[] = [];
  for (let index = 0; index < 12; index++)
    pending.push(cache.save(identity, resource, { index }));
  const last = { messages: [{ content: "Last submitted value" }] };
  pending.push(cache.save(identity, resource, last));
  last.messages[0].content = "Changed after save";
  expect(await cache.load(identity, resource)).toEqual({
    cached: true,
    data: { messages: [{ content: "Last submitted value" }] },
    lastSuccessAt: capturedAt + 12,
  });
  expect((await Promise.all(pending)).every(Boolean)).toBe(true);
  expect(await cache.flush()).toBe(true);
  expect(
    (await fs.readdir(path.dirname(filename(directory)))).every((name) =>
      name.endsWith(".bin"),
    ),
  ).toBe(true);
});

test("valid empty data remains distinguishable from a cache miss", async () => {
  const { cache } = await fixture();
  for (const data of [null, false, 0, "", [], {}, { owned: [], joined: [] }]) {
    expect(await cache.save(identity, resource, data)).toBe(true);
    expect(await cache.load(identity, resource)).toEqual(restored(data));
  }
  expect(
    await cache.save(identity, resource, { value: 1, absent: undefined }),
  ).toBe(true);
  expect(await cache.load(identity, resource)).toEqual(restored({ value: 1 }));
});

test("corrupt, oversized and invalid payloads are cache misses and can recover", async () => {
  const { directory, safeStorage, cache } = await fixture();
  await cache.save(identity, resource, { valid: true });
  const file = filename(directory);
  await fs.writeFile(file, Buffer.from("Broken ciphertext"));
  expect(await cache.load(identity, resource)).toEqual(miss);
  for (const patch of [
    { version: 2 },
    { lastSuccessAt: -1 },
    { lastSuccessAt: "yesterday" },
    { identityKey: "other" },
    { resourceKey: "other" },
    { data: undefined },
  ]) {
    const payload = {
      version: 1,
      identityKey: identity,
      resourceKey: resource,
      lastSuccessAt: capturedAt,
      data: {},
      ...patch,
    };
    await fs.writeFile(file, safeStorage.encryptString(JSON.stringify(payload)));
    expect(await cache.load(identity, resource)).toEqual(miss);
  }
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  expect(await cache.load(identity, resource)).toEqual(miss);
  await fs.writeFile(file, Buffer.alloc(0));
  expect(await cache.load(identity, resource)).toEqual(miss);
  expect(await cache.save(identity, resource, { recovered: true })).toBe(true);
  expect(await cache.load(identity, resource)).toEqual(
    restored({ recovered: true }),
  );
});

test("unavailable or broken encryption never writes a plaintext fallback", async () => {
  const { directory, cache } = await fixture({
    safeStorage: { isEncryptionAvailable: () => false } as unknown as SecretStorage,
  });
  expect(
    await cache.save(identity, resource, {
      content: "Synthetic private message",
    }),
  ).toBe(false);
  expect(await cache.load(identity, resource)).toEqual(miss);
  expect(await cache.flush()).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
  cache.safeStorage = {
    isEncryptionAvailable() {
      throw new Error("Unavailable");
    },
  } as unknown as SecretStorage;
  expect(await cache.save(identity, resource, {})).toBe(false);
  expect(await cache.load(identity, resource)).toEqual(miss);
  expect(await fs.readdir(directory)).toEqual([]);
});

test("failed encryption preserves the previous entry and a later save recovers", async () => {
  const { directory, safeStorage, cache } = await fixture();
  await cache.save(identity, resource, { version: 1 });
  const original = await fs.readFile(filename(directory)),
    encrypt = safeStorage.encryptString;
  safeStorage.encryptString = () => {
    throw new Error("Encryption failed");
  };
  expect(await cache.save(identity, resource, { version: 2 })).toBe(false);
  expect(await cache.flush()).toBe(false);
  expect(await fs.readFile(filename(directory))).toEqual(original);
  expect(await cache.load(identity, resource)).toEqual(restored({ version: 1 }));
  safeStorage.encryptString = encrypt;
  expect(await cache.save(identity, resource, { version: 3 })).toBe(true);
  expect(await cache.flush()).toBe(true);
  expect(await cache.load(identity, resource)).toEqual(restored({ version: 3 }));
});

test("a failed atomic replacement preserves its previous entry and cleans up the temporary file", async () => {
  const { directory, cache } = await fixture();
  await cache.save(identity, resource, { version: 1 });
  const original = await fs.readFile(filename(directory));
  const rename = fs.rename;
  (fs as unknown as { rename: unknown }).rename = async () => {
    throw Object.assign(new Error("Replacement failed"), { code: "EACCES" });
  };
  try {
    expect(await cache.save(identity, resource, { version: 2 })).toBe(false);
  } finally {
    (fs as unknown as { rename: unknown }).rename = rename;
  }
  expect(await cache.flush()).toBe(false);
  expect(await fs.readFile(filename(directory))).toEqual(original);
  expect(await fs.readdir(path.dirname(filename(directory)))).toEqual([
    path.basename(filename(directory)),
  ]);
  expect(await cache.load(identity, resource)).toEqual(restored({ version: 1 }));
});

test("unsupported data never invokes accessors or replaces a valid entry", async () => {
  const { cache } = await fixture();
  await cache.save(identity, resource, { valid: true });
  let called = false;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      called = true;
      return "Unsafe";
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.child = cycle;
  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 14; index++) deep = { child: deep };
  for (const data of [
    getter,
    cycle,
    deep,
    new Date(),
    {
      toJSON() {
        called = true;
        return {};
      },
    },
    [undefined],
    { value: Infinity },
    { value: NaN },
    { value: 1n },
    () => {},
    Array(2),
    Array(10001).fill(0),
    "x".repeat(8 * 1024 * 1024 + 1),
  ]) {
    expect(await cache.save(identity, resource, data)).toBe(false);
  }
  expect(called).toBe(false);
  expect(await cache.load(identity, resource)).toEqual(restored({ valid: true }));
  const protoField = JSON.parse('{"__proto__":{"example":true}}') as unknown;
  expect(await cache.save(identity, resource, protoField)).toBe(true);
  expect(await cache.load(identity, resource)).toEqual(restored(protoField));
  expect(({} as Record<string, unknown>).example).toBe(undefined);
});

test("invalid keys and clocks fail without creating cache paths", async () => {
  const { directory, cache } = await fixture();
  for (const [identityKey, resourceKey] of [
    ["", resource],
    [identity, ""],
    ["bad\nidentity", resource],
    [identity, "bad\nresource"],
    ["x".repeat(257), resource],
    [identity, "x".repeat(32769)],
  ]) {
    expect(await cache.save(identityKey, resourceKey, {})).toBe(false);
    expect(await cache.load(identityKey, resourceKey)).toEqual(miss);
    expect(await cache.invalidate(identityKey, resourceKey)).toBe(false);
  }
  cache.clock = () => -1;
  expect(await cache.save(identity, resource, {})).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
});

test("invalidation is ordered with saves and isolates other resources", async () => {
  const { cache } = await fixture();
  const first = cache.save(identity, resource, { version: 1 });
  const other = cache.save(identity, "other", { version: 2 });
  const invalidation = cache.invalidate(identity, resource);
  expect(await cache.load(identity, resource)).toEqual(miss);
  expect(
    (await Promise.all([first, other, invalidation])).every(Boolean),
  ).toBe(true);
  expect(await cache.load(identity, "other")).toEqual(restored({ version: 2 }));
  expect(await cache.invalidate(identity, resource)).toBe(true);
  const remove = cache.invalidate(identity, resource);
  const replacement = cache.save(identity, resource, { version: 3 });
  expect(await cache.load(identity, resource)).toEqual(restored({ version: 3 }));
  expect((await Promise.all([remove, replacement])).every(Boolean)).toBe(true);
});

test("each identity retains at most 128 entries and preserves the newly saved resource", async () => {
  const { directory, safeStorage, cache } = await fixture();
  await cache.save(identity, resource, { current: true });
  const identityDirectory = path.dirname(filename(directory));
  const old = new Date(capturedAt - 1000);
  await Promise.all(
    Array.from({ length: 130 }, async (_, index) => {
      const resourceKey = `old-resource:${index}`,
        file = filename(directory, identity, resourceKey);
      await fs.writeFile(
        file,
        safeStorage.encryptString(
          JSON.stringify({
            version: 1,
            identityKey: identity,
            resourceKey,
            lastSuccessAt: capturedAt,
            data: { index },
          }),
        ),
      );
      await fs.utimes(file, old, old);
    }),
  );
  await cache.save("public", resource, { unrelated: true });
  expect(await cache.save(identity, resource, { current: "refreshed" })).toBe(
    true,
  );
  expect((await fs.readdir(identityDirectory)).length).toBe(128);
  expect(await cache.load(identity, resource)).toEqual(
    restored({ current: "refreshed" }),
  );
  expect(await cache.load("public", resource)).toEqual(
    restored({ unrelated: true }),
  );
});

test("each identity keeps encrypted entry bytes below the disk budget", async () => {
  const { directory, cache } = await fixture();
  await cache.save(identity, resource, { current: true });
  const identityDirectory = path.dirname(filename(directory));
  const old = new Date(capturedAt - 1000);
  await Promise.all(
    Array.from({ length: 9 }, async (_, index) => {
      const file = filename(directory, identity, `old-resource:${index}`);
      await fs.writeFile(file, Buffer.alloc(0));
      await fs.truncate(file, 8 * 1024 * 1024);
      await fs.utimes(file, old, old);
    }),
  );
  expect(await cache.save(identity, resource, { current: "refreshed" })).toBe(
    true,
  );
  const stats = await Promise.all(
    (await fs.readdir(identityDirectory)).map((name) =>
      fs.stat(path.join(identityDirectory, name)),
    ),
  );
  expect(
    stats.reduce((sum, stat) => sum + stat.size, 0) <= 64 * 1024 * 1024,
  ).toBe(true);
  expect(await cache.load(identity, resource)).toEqual(
    restored({ current: "refreshed" }),
  );
});

// New for the port: a 0.8.x entry must still load, and this writer must still produce the exact
// plaintext 0.8.x produced (same field order, same nested-directory layout).
test("an entry written by BeingDesktop 0.8.x loads and is rewritten byte for byte", async () => {
  const { directory, safeStorage, cache } = await fixture();
  const legacy =
    '{"version":1,"identityKey":"persist:being-example","resourceKey":' +
    '"getFiresideMessages:{\\"id\\":\\"example\\",\\"limit\\":100}","data":' +
    '{"owned":[{"id":"7","name":"围炉"}],"joined":[]},"lastSuccessAt":1788750000000}';
  await fs.mkdir(path.dirname(filename(directory)), { recursive: true });
  await fs.writeFile(filename(directory), safeStorage.encryptString(legacy));
  expect(await cache.load(identity, resource)).toEqual(
    restored({ owned: [{ id: "7", name: "围炉" }], joined: [] }),
  );
  expect(
    await cache.save(identity, resource, {
      owned: [{ id: "7", name: "围炉" }],
      joined: [],
    }),
  ).toBe(true);
  expect(await cache.flush()).toBe(true);
  expect(safeStorage.decryptString(await fs.readFile(filename(directory)))).toBe(
    legacy,
  );
});
