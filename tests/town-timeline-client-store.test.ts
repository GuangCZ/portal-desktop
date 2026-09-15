// Ported line by line from BeingDesktop 0.8.26 test/town-client-store.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style changed (node:test -> vitest).
// The final case is new: it proves the reader and writer stay byte-compatible with 0.8.x files.
import { afterEach, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { TownClientStore } from "../desktop/main/town/timeline/client-store";
import type {
  TownCodedError,
  TownSecretStorage,
} from "../desktop/main/town/timeline/types";

const key = crypto.randomBytes(32);
const safeStorage: TownSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) {
    const iv = crypto.randomBytes(16),
      c = crypto.createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([iv, c.update(value), c.final()]);
  },
  decryptString(bytes: Buffer) {
    const d = crypto.createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16));
    return Buffer.concat([
      d.update(bytes.subarray(16)),
      d.final(),
    ]).toString();
  },
};

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});
async function directory(prefix: string) {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratch.push(result);
  return result;
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

test("client token store encrypts, isolates connection identities, persists restart and removes locally", async () => {
  const dir = await directory("town-sdk-");
  const store = new TownClientStore({ directory: dir, safeStorage }),
    token = "a".repeat(64);
  await store.save("key-a", "alice", token);
  const file = path.join(dir, (await fs.readdir(dir))[0]),
    wire = await fs.readFile(file, "utf8");
  expect(wire.includes(token)).toBe(false);
  expect(wire.includes("alice")).toBe(false);
  if (process.platform !== "win32")
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(
    await new TownClientStore({ directory: dir, safeStorage }).load(
      "key-a",
      "alice",
    ),
  ).toBe(token);
  expect(await store.load("key-a", "bob")).toBe(null);
  expect(await store.load("key-b", "alice")).toBe(null);
  await fs.copyFile(file, store._file("key-b"));
  expect(await store.load("key-b", "alice")).toBe(null);
  await store.remove("key-a");
  expect(await store.load("key-a", "alice")).toBe(null);
});

test("unavailable and plaintext backends never persist client tokens", async () => {
  const dir = await directory("town-sdk-");
  for (const storage of [
    { ...safeStorage, isEncryptionAvailable: () => false },
    { ...safeStorage, getSelectedStorageBackend: () => "basic_text" },
  ]) {
    const store = new TownClientStore({ directory: dir, safeStorage: storage });
    await rejects(
      store.save("key", "alice", "a".repeat(64)),
      "AUTH_REQUIRED",
    );
  }
  expect(await fs.readdir(dir)).toEqual([]);
});

test("Town identity migration preserves the token, pins across restart, and rejects stale or foreign bindings", async () => {
  const dir = await directory("town-binding-");
  const store = new TownClientStore({ directory: dir, safeStorage }),
    token = "a".repeat(64);
  await store.save("key", "alice", token);
  const before = await fs.readFile(store._file("key"));
  await rejects(
    store.bindTownId("key", "alice", token, "t_alice", () => false),
    "SESSION_CHANGED",
  );
  expect((await fs.readFile(store._file("key"))).equals(before)).toBe(true);
  await store.bindTownId("key", "alice", token, "t_alice");
  const fresh = new TownClientStore({ directory: dir, safeStorage }),
    restored = await fresh.loadCredential("key", "alice");
  expect(restored!.token === token).toBe(true);
  expect(restored!.townId).toBe("t_alice");
  const pinned = await fs.readFile(store._file("key"));
  await rejects(
    fresh.bindTownId("key", "alice", token, "t_foreign"),
    "IDENTITY_MISMATCH",
  );
  await rejects(
    fresh.bindTownId("key", "alice", "b".repeat(64), "t_alice"),
    "SESSION_CHANGED",
  );
  expect((await fs.readFile(store._file("key"))).equals(pinned)).toBe(true);
  expect(pinned.includes(Buffer.from(token))).toBe(false);
  expect(pinned.includes(Buffer.from("t_alice"))).toBe(false);
});

test("new pairing persists display encrypted with the binding and a stale save preserves the old file", async () => {
  const dir = await directory("town-pair-save-");
  const store = new TownClientStore({ directory: dir, safeStorage }),
    token = "b".repeat(64);
  await store.save("key", "alice", token, "t_alice", "Alice (t_alice)");
  const before = await fs.readFile(store._file("key"));
  expect(before.includes(Buffer.from("Alice"))).toBe(false);
  const restored = await new TownClientStore({
    directory: dir,
    safeStorage,
  }).loadCredential("key", "alice");
  expect(restored).toEqual({
    token,
    townId: "t_alice",
    display: "Alice (t_alice)",
  });
  await rejects(
    store.save("key", "alice", "c".repeat(64), "t_other", "", () => false),
    "SESSION_CHANGED",
  );
  expect((await fs.readFile(store._file("key"))).equals(before)).toBe(true);
  expect((await fs.readdir(dir)).length).toBe(1);
});

// New for the port: a 0.8.x credential file must still load, and this writer must still produce
// the exact plaintext 0.8.x encrypted (same field order, same optional townId/display handling).
test("a credential written by BeingDesktop 0.8.x loads and is rewritten byte for byte", async () => {
  const dir = await directory("town-legacy-");
  const store = new TownClientStore({ directory: dir, safeStorage });
  const token = "d".repeat(64);
  const legacy =
    '{"key":"legacy-key","beingId":"alice","token":"' +
    token +
    '","townId":"t_alice","display":"Alice (t_alice)"}';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    store._file("legacy-key"),
    JSON.stringify({
      version: 1,
      encrypted: safeStorage.encryptString(legacy).toString("base64"),
    }),
  );
  expect(await store.loadCredential("legacy-key", "alice")).toEqual({
    token,
    townId: "t_alice",
    display: "Alice (t_alice)",
  });
  await store.save(
    "legacy-key",
    "alice",
    token,
    "t_alice",
    "Alice (t_alice)",
  );
  const rewritten = JSON.parse(
    await fs.readFile(store._file("legacy-key"), "utf8"),
  ) as { version: number; encrypted: string };
  expect(rewritten.version).toBe(1);
  expect(
    safeStorage.decryptString(Buffer.from(rewritten.encrypted, "base64")),
  ).toBe(legacy);
});
