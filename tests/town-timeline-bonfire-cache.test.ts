// Ported line by line from BeingDesktop 0.8.26 test/bonfire-cache.test.cjs on 2026-09-16.
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
import { BonfireCache } from "../desktop/main/town/timeline/bonfire-cache";
import type { SecretStorage } from "../desktop/main/town/timeline/types";

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
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
async function directory() {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), "bonfire-cache-test-"));
  scratch.push(result);
  return result;
}

function snapshot(
  content = "Previously fetched Bonfire message",
  latestSeq = 1,
) {
  return {
    messages: [
      {
        id: String(latestSeq),
        beingId: "echo",
        beingName: "Echo",
        content,
        createdAt: "2026-09-07",
        revisedAt: "",
        mentions: [] as string[],
      },
    ],
    latestSeq,
    capturedAt: 1788750000000 + latestSeq,
    revision: `manual:${latestSeq}`,
    manual: true,
  };
}

const filename = (directory: string, key: string) =>
  path.join(directory, createHash("sha256").update(key).digest("hex") + ".bin");

test("persisted Being relay snapshots retain their unverified source label", async () => {
  const dir = await directory(),
    safeStorage = encryptedStorage();
  const cache = new BonfireCache({ directory: dir, safeStorage });
  const value = { ...snapshot(), source: "being_relay" };
  expect(await cache.save("relay-test", value)).toBe(true);
  expect(
    await new BonfireCache({ directory: dir, safeStorage }).load("relay-test"),
  ).toEqual(value);
});

test("encrypted snapshots survive a new store instance without exposing message text", async () => {
  const dir = await directory(),
    safeStorage = encryptedStorage(),
    identityKey = "persist:being-alice";
  const first = new BonfireCache({ directory: dir, safeStorage });
  expect(await first.load(identityKey)).toBe(null);
  const expected = snapshot();
  expect(await first.save(identityKey, expected)).toBe(true);
  expect(await first.flush()).toBe(true);
  const raw = await fs.readFile(filename(dir, identityKey));
  expect(raw.includes(Buffer.from(expected.messages[0].content))).toBe(false);
  expect(await fs.readdir(dir)).toEqual([
    path.basename(filename(dir, identityKey)),
  ]);
  const second = new BonfireCache({ directory: dir, safeStorage });
  expect(await second.load(identityKey)).toEqual(expected);
  const loaded = await second.load(identityKey);
  loaded!.messages[0].content = "Mutated caller copy";
  expect(await second.load(identityKey)).toEqual(expected);
});

test("identities are isolated and a file copied under a different key is rejected", async () => {
  const dir = await directory(),
    safeStorage = encryptedStorage(),
    cache = new BonfireCache({ directory: dir, safeStorage });
  await Promise.all([
    cache.save("persist:being-alice", snapshot("Alice cache")),
    cache.save("persist:being-bob", snapshot("Bob cache")),
  ]);
  expect((await cache.load("persist:being-alice"))!.messages[0].content).toBe(
    "Alice cache",
  );
  expect((await cache.load("persist:being-bob"))!.messages[0].content).toBe(
    "Bob cache",
  );
  await fs.copyFile(
    filename(dir, "persist:being-alice"),
    filename(dir, "persist:being-carol"),
  );
  expect(await cache.load("persist:being-carol")).toBe(null);
  expect(await cache.load("persist:being-other")).toBe(null);
});

test("corruption, invalid schema and oversized files are cache misses", async () => {
  const dir = await directory(),
    safeStorage = encryptedStorage(),
    cache = new BonfireCache({ directory: dir, safeStorage }),
    identityKey = "persist:being-alice";
  const file = filename(dir, identityKey);
  await fs.writeFile(file, Buffer.from("Broken ciphertext"));
  expect(await cache.load(identityKey)).toBe(null);
  for (const value of [
    { ...snapshot(), latestSeq: -1 },
    { ...snapshot(), capturedAt: "yesterday" },
    { ...snapshot(), messages: [{ id: "1", content: 123 }] },
  ]) {
    await fs.writeFile(
      file,
      safeStorage.encryptString(
        JSON.stringify({ version: 1, identityKey, snapshot: value }),
      ),
    );
    expect(await cache.load(identityKey)).toBe(null);
  }
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  expect(await cache.load(identityKey)).toBe(null);
  expect(await cache.save(identityKey, snapshot("Recovered cache"))).toBe(true);
  expect((await cache.load(identityKey))!.messages[0].content).toBe(
    "Recovered cache",
  );
});

test("unavailable encryption never falls back to a plaintext file", async () => {
  const dir = await directory();
  const cache = new BonfireCache({
    directory: dir,
    safeStorage: { isEncryptionAvailable: () => false } as unknown as SecretStorage,
  });
  expect(await cache.save("persist:being-alice", snapshot())).toBe(false);
  expect(await cache.load("persist:being-alice")).toBe(null);
  expect(await cache.flush()).toBe(false);
  expect(await fs.readdir(dir)).toEqual([]);
});

test("concurrent writes keep the last submitted snapshot and snapshot the caller value", async () => {
  const dir = await directory(),
    cache = new BonfireCache({ directory: dir, safeStorage: encryptedStorage() });
  const pending: Promise<boolean>[] = [];
  for (let count = 1; count <= 12; count++)
    pending.push(
      cache.save("persist:being-alice", snapshot(`Version ${count}`, count)),
    );
  const expected = snapshot("Final version", 13);
  pending.push(cache.save("persist:being-alice", expected));
  expected.messages[0].content = "Mutation after save";
  expect(await cache.load("persist:being-alice")).toEqual(
    snapshot("Final version", 13),
  );
  expect(await cache.flush()).toBe(true);
  expect((await Promise.all(pending)).every(Boolean)).toBe(true);
  expect(await cache.load("persist:being-alice")).toEqual(
    snapshot("Final version", 13),
  );
  expect((await fs.readdir(dir)).every((file) => !file.endsWith(".tmp"))).toBe(
    true,
  );
});

test("a failed save preserves the previous file and a later save can recover", async () => {
  const dir = await directory(),
    safeStorage = encryptedStorage(),
    cache = new BonfireCache({ directory: dir, safeStorage }),
    identityKey = "persist:being-alice";
  await cache.save(identityKey, snapshot("Previous version"));
  const file = filename(dir, identityKey),
    original = await fs.readFile(file),
    encrypt = safeStorage.encryptString;
  safeStorage.encryptString = () => {
    throw new Error("Encryption failed");
  };
  expect(await cache.save(identityKey, snapshot("Unsaved version", 2))).toBe(
    false,
  );
  expect(await cache.flush()).toBe(false);
  expect(await fs.readFile(file)).toEqual(original);
  expect((await cache.load(identityKey))!.messages[0].content).toBe(
    "Previous version",
  );
  safeStorage.encryptString = encrypt;
  expect(await cache.save(identityKey, snapshot("Recovered version", 3))).toBe(
    true,
  );
  expect(await cache.flush()).toBe(true);
  expect((await cache.load(identityKey))!.messages[0].content).toBe(
    "Recovered version",
  );
});

test("a failed atomic replacement retains the previous snapshot and removes its temporary file", async () => {
  const dir = await directory(),
    cache = new BonfireCache({ directory: dir, safeStorage: encryptedStorage() }),
    identityKey = "persist:being-alice";
  await cache.save(identityKey, snapshot("Last complete snapshot"));
  const original = await fs.readFile(filename(dir, identityKey));
  const rename = fs.rename;
  (fs as unknown as { rename: unknown }).rename = async () => {
    throw Object.assign(new Error("Replacement failed"), { code: "EACCES" });
  };
  try {
    expect(
      await cache.save(identityKey, snapshot("Incomplete replacement", 2)),
    ).toBe(false);
  } finally {
    (fs as unknown as { rename: unknown }).rename = rename;
  }
  expect(await fs.readFile(filename(dir, identityKey))).toEqual(original);
  expect((await fs.readdir(dir)).every((file) => !file.endsWith(".tmp"))).toBe(
    true,
  );
  expect((await cache.load(identityKey))!.messages[0].content).toBe(
    "Last complete snapshot",
  );
});

test("authoritative empty snapshots persist and malformed values do not overwrite them", async () => {
  const dir = await directory(),
    cache = new BonfireCache({ directory: dir, safeStorage: encryptedStorage() }),
    identityKey = "persist:being-alice";
  const empty = { ...snapshot(), messages: [], latestSeq: 0 };
  expect(await cache.save(identityKey, empty)).toBe(true);
  for (const value of [
    {
      ...snapshot(),
      messages: Array.from({ length: 501 }, () => snapshot().messages[0]),
    },
    snapshot("x".repeat(32001)),
    { ...snapshot(), revision: "invalid\nrevision" },
    {
      ...snapshot(),
      messages: [
        {
          ...snapshot().messages[0],
          replyTo: { id: "p", beingId: "x".repeat(101), preview: "" },
        },
      ],
    },
  ]) {
    expect(await cache.save(identityKey, value)).toBe(false);
  }
  expect(await cache.save("", snapshot())).toBe(false);
  expect(await cache.load("invalid\nkey")).toBe(null);
  expect(await cache.load(identityKey)).toEqual(empty);
});

// New for the port: a 0.8.x file must still load, and this writer must still produce the exact
// plaintext 0.8.x produced (same field order, same optional-field handling for via/replyTo).
test("a cache written by BeingDesktop 0.8.x loads and is rewritten byte for byte", async () => {
  const dir = await directory(),
    safeStorage = encryptedStorage(),
    identityKey = "persist:being-legacy";
  const legacy =
    '{"version":1,"identityKey":"persist:being-legacy","snapshot":{"messages":' +
    '[{"id":"41","content":"围炉里的一条旧消息","beingId":"echo","beingName":"Echo",' +
    '"createdAt":"2026-09-11T02:00:00Z","revisedAt":"","via":"Portal","mentions":["alice"],' +
    '"replyTo":{"id":"40","beingId":"alice","preview":"上一条"}}],' +
    '"latestSeq":41,"capturedAt":1788750000041,"revision":"manual:41","manual":true}}';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    filename(dir, identityKey),
    safeStorage.encryptString(legacy),
  );
  const cache = new BonfireCache({ directory: dir, safeStorage });
  const restored = await cache.load(identityKey);
  expect(restored).toEqual({
    messages: [
      {
        id: "41",
        content: "围炉里的一条旧消息",
        beingId: "echo",
        beingName: "Echo",
        createdAt: "2026-09-11T02:00:00Z",
        revisedAt: "",
        via: "Portal",
        mentions: ["alice"],
        replyTo: { id: "40", beingId: "alice", preview: "上一条" },
      },
    ],
    latestSeq: 41,
    capturedAt: 1788750000041,
    revision: "manual:41",
    manual: true,
  });
  expect(await cache.save(identityKey, restored)).toBe(true);
  expect(await cache.flush()).toBe(true);
  expect(
    safeStorage.decryptString(await fs.readFile(filename(dir, identityKey))),
  ).toBe(legacy);
});
