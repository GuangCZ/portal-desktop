// New in this port: BeingDesktop 0.8.26 ships src/chat-cache.cjs without a test of
// its own (only src/main.cjs wiring), so these cases are written against the
// contract the source states. The on-disk format is BeingDesktop
// docs/interfaces.md §7 「`chat-cache/<file per identity>`」: safeStorage
// ciphertext over `{version:1, identityKey, state}`, one file per Being identity,
// ≤8MB. 2026-09-16.
import { expect, test } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ChatCache } from "../desktop/main/chat/cache";
import type { SecretStorage } from "../desktop/main/app/settings";
import type { ChatSnapshot } from "../desktop/main/chat/store-types";

const IDENTITY = "https://echo.beings.town/cz_being";
const OTHER = "https://echo.beings.town/another_being";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The same shape Electron's `safeStorage` presents, backed by a local key so the
 * bytes on disk are genuinely ciphertext. Mirrors tests/settings.test.ts. */
function secretStorage(): SecretStorage & { fail: boolean } {
  const key = randomBytes(32);
  return {
    fail: false,
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      if ((this as { fail: boolean }).fail) throw new Error("encryption refused");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(data: Buffer) {
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString("utf8");
    },
  };
}

const directory = () => mkdtemp(path.join(os.tmpdir(), "beings-chat-cache-"));
const fileFor = (dir: string, identityKey: string) =>
  path.join(dir, `${createHash("sha256").update(identityKey).digest("hex")}.bin`);

const snapshotOf = (cursor: number, id: string, content: string): ChatSnapshot => ({
  version: 1,
  cursor,
  seeded: true,
  active: id,
  sessions: [
    {
      id,
      title: "会话一",
      createdAt: 1757000000000,
      truncated: false,
      rows: [{ seq: cursor, role: "being", content, at: "2026-09-11T00:00:00Z" }],
    },
  ],
});

// A file exactly as BeingDesktop 0.8.26 writes it: the envelope, the state, the key
// order and the optional fields (`titleSource`, `from`, `images`) all as its own
// `JSON.stringify` emits them. Kept as a literal so a change in this port that
// would break a 0.8.x profile fails here rather than in a user's cache directory.
const LEGACY_PLAINTEXT =
  '{"version":1,"identityKey":"https://echo.beings.town/cz_being","state":{"version":1,' +
  '"cursor":41,"seeded":true,"active":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sessions":[' +
  '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","title":"会话一","titleSource":"manual",' +
  '"createdAt":1757000000000,"truncated":false,"rows":[' +
  '{"seq":40,"role":"user","content":"看看这张图","at":"2026-09-11T00:00:00Z",' +
  '"images":[{"media_type":"image/png","name":"probe.png","thumb":"data:image/png;base64,AAAA"}]},' +
  '{"seq":41,"role":"being","content":"黄底绿圆","at":"2026-09-11T00:00:01Z"}]},' +
  '{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","title":"","createdAt":0,"truncated":true,' +
  '"rows":[{"seq":12,"role":"user","content":"[breath yielded to human]","at":"","from":"system"}]}]}}';

test("a snapshot round-trips, encrypted, one file per Being identity", async () => {
  const dir = await directory();
  const storage = secretStorage();
  const cache = new ChatCache({ directory: dir, safeStorage: storage });
  expect(await cache.save(IDENTITY, snapshotOf(7, A, "记住我"))).toBe(true);
  expect(await cache.save(OTHER, snapshotOf(9, B, "另一个身份"))).toBe(true);
  expect(await cache.flush()).toBe(true);
  // One file per identity, named by the hash of the identity key, 0600, and no
  // temporary file left behind.
  const files = (await readdir(dir)).sort();
  expect(files).toStrictEqual(
    [fileFor(dir, IDENTITY), fileFor(dir, OTHER)].map((file) => path.basename(file)).sort(),
  );
  expect((await stat(fileFor(dir, IDENTITY))).mode & 0o777).toBe(0o600);
  // The transcript is not readable without the key.
  const raw = await readFile(fileFor(dir, IDENTITY));
  expect(raw.includes(Buffer.from("记住我", "utf8"))).toBe(false);
  expect(raw.includes(Buffer.from(IDENTITY, "utf8"))).toBe(false);
  expect(await cache.load(IDENTITY)).toStrictEqual(snapshotOf(7, A, "记住我"));
  expect(await cache.load(OTHER)).toStrictEqual(snapshotOf(9, B, "另一个身份"));
  // A fresh cache over the same directory reads what the first one wrote.
  expect(await new ChatCache({ directory: dir, safeStorage: storage }).load(IDENTITY))
    .toStrictEqual(snapshotOf(7, A, "记住我"));
});

test("a cache file written by BeingDesktop 0.8.x opens, and is written back byte for byte", async () => {
  const dir = await directory();
  const storage = secretStorage();
  await writeFile(fileFor(dir, IDENTITY), storage.encryptString(LEGACY_PLAINTEXT), { mode: 0o600 });
  const cache = new ChatCache({ directory: dir, safeStorage: storage });
  const loaded = await cache.load(IDENTITY);
  expect(loaded).toStrictEqual(JSON.parse(LEGACY_PLAINTEXT).state);
  // Every field 0.8.x may have written survives the validator: the manual title
  // source, a row's image previews, a `from: system` separator row, and a
  // conversation already marked truncated.
  expect(loaded!.sessions[0].titleSource).toBe("manual");
  expect(loaded!.sessions[0].rows[0].images).toStrictEqual([
    { media_type: "image/png", name: "probe.png", thumb: "data:image/png;base64,AAAA" },
  ]);
  expect(loaded!.sessions[1]).toMatchObject({ truncated: true, rows: [{ from: "system" }] });
  // And the other direction: what this port writes back is the same plaintext,
  // so a profile can move between 0.8.x and this build without losing a field.
  expect(await cache.save(IDENTITY, loaded!)).toBe(true);
  expect(storage.decryptString(await readFile(fileFor(dir, IDENTITY)))).toBe(LEGACY_PLAINTEXT);
});

test("a file that will not open is a cache miss, never a failure", async () => {
  const dir = await directory();
  const storage = secretStorage();
  const cache = new ChatCache({ directory: dir, safeStorage: storage });
  // Nothing on disk yet.
  expect(await cache.load(IDENTITY)).toBe(null);
  // Ciphertext this key cannot open — another machine's file, or a corrupted one.
  await writeFile(fileFor(dir, IDENTITY), randomBytes(64));
  expect(await cache.load(IDENTITY)).toBe(null);
  // An empty file.
  await writeFile(fileFor(dir, IDENTITY), Buffer.alloc(0));
  expect(await cache.load(IDENTITY)).toBe(null);
  // A well-formed envelope for a different identity: the file name is a hash, so a
  // collision or a copied file must not hand one Being another Being's transcript.
  await writeFile(
    fileFor(dir, IDENTITY),
    storage.encryptString(JSON.stringify({ version: 1, identityKey: OTHER, state: snapshotOf(7, A, "别人的") })),
  );
  expect(await cache.load(IDENTITY)).toBe(null);
  // A future envelope version, and a state the validator rejects.
  await writeFile(
    fileFor(dir, IDENTITY),
    storage.encryptString(JSON.stringify({ version: 2, identityKey: IDENTITY, state: snapshotOf(7, A, "未来") })),
  );
  expect(await cache.load(IDENTITY)).toBe(null);
  await writeFile(
    fileFor(dir, IDENTITY),
    storage.encryptString(
      JSON.stringify({ version: 1, identityKey: IDENTITY, state: { ...snapshotOf(7, A, "游标落后"), cursor: 1 } }),
    ),
  );
  expect(await cache.load(IDENTITY)).toBe(null);
});

test("without encryption nothing is read or written, and flush says so", async () => {
  const dir = await directory();
  const offline: SecretStorage = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  const cache = new ChatCache({ directory: dir, safeStorage: offline });
  expect(await cache.load(IDENTITY)).toBe(null);
  expect(await cache.save(IDENTITY, snapshotOf(7, A, "记住我"))).toBe(false);
  expect(await cache.flush()).toBe(false);
  expect(await readdir(dir)).toStrictEqual([]);
  // A safeStorage that throws on the availability probe is unavailable, not fatal.
  const hostile = new ChatCache({
    directory: dir,
    safeStorage: { isEncryptionAvailable: () => { throw new Error("no keyring"); } } as unknown as SecretStorage,
  });
  expect(await hostile.load(IDENTITY)).toBe(null);
  expect(await hostile.save(IDENTITY, snapshotOf(7, A, "记住我"))).toBe(false);
  // With no safeStorage at all the cache is inert rather than broken.
  const none = new ChatCache({ directory: dir });
  expect(await none.load(IDENTITY)).toBe(null);
  expect(await none.save(IDENTITY, snapshotOf(7, A, "记住我"))).toBe(false);
});

test("a failed write keeps the previous file intact and leaves no temporary behind", async () => {
  const dir = await directory();
  const storage = secretStorage();
  const cache = new ChatCache({ directory: dir, safeStorage: storage });
  expect(await cache.save(IDENTITY, snapshotOf(7, A, "第一次"))).toBe(true);
  storage.fail = true;
  expect(await cache.save(IDENTITY, snapshotOf(8, A, "第二次"))).toBe(false);
  expect(await cache.flush()).toBe(false);
  expect(await readdir(dir)).toStrictEqual([path.basename(fileFor(dir, IDENTITY))]);
  expect(await cache.load(IDENTITY)).toStrictEqual(snapshotOf(7, A, "第一次"));
  // Recovering clears the failure: `flush` reports the current state, not a latch.
  storage.fail = false;
  expect(await cache.save(IDENTITY, snapshotOf(8, A, "第二次"))).toBe(true);
  expect(await cache.flush()).toBe(true);
  expect(await cache.load(IDENTITY)).toStrictEqual(snapshotOf(8, A, "第二次"));
});

test("writes for one identity serialize, and a read waits for them", async () => {
  const dir = await directory();
  const cache = new ChatCache({ directory: dir, safeStorage: secretStorage() });
  const first = cache.save(IDENTITY, snapshotOf(1, A, "一"));
  const second = cache.save(IDENTITY, snapshotOf(2, A, "二"));
  const third = cache.save(IDENTITY, snapshotOf(3, A, "三"));
  // `load` awaits the queue, so it can never observe a half-written window.
  expect(await cache.load(IDENTITY)).toStrictEqual(snapshotOf(3, A, "三"));
  expect(await Promise.all([first, second, third])).toStrictEqual([true, true, true]);
  expect(await cache.flush()).toBe(true);
});

test("a state the validator rejects is never written", async () => {
  const dir = await directory();
  const cache = new ChatCache({ directory: dir, safeStorage: secretStorage() });
  // A cursor behind its own rows: the corruption the single-transaction invariant
  // exists to prevent, refused on the way out as well as on the way in.
  expect(await cache.save(IDENTITY, { ...snapshotOf(7, A, "坏的"), cursor: 1 })).toBe(false);
  expect(await cache.save(IDENTITY, null as unknown as ChatSnapshot)).toBe(false);
  expect(await readdir(dir)).toStrictEqual([]);
});

test("identity keys and directories are checked before the disk is touched", async () => {
  const dir = await directory();
  const cache = new ChatCache({ directory: dir, safeStorage: secretStorage() });
  const snapshot = snapshotOf(7, A, "记住我");
  for (const key of ["", "x".repeat(257), "line\nbreak", "null byte"]) {
    expect(await cache.save(key, snapshot)).toBe(false);
    expect(await cache.load(key)).toBe(null);
    expect(await cache.remove(key)).toBe(false);
  }
  expect(await readdir(dir)).toStrictEqual([]);
  expect(() => new ChatCache({ directory: "" })).toThrow(TypeError);
  expect(() => new ChatCache({})).toThrow(TypeError);
});

test("remove deletes one identity's file and tolerates a missing one", async () => {
  const dir = await directory();
  const cache = new ChatCache({ directory: dir, safeStorage: secretStorage() });
  expect(await cache.save(IDENTITY, snapshotOf(7, A, "记住我"))).toBe(true);
  expect(await cache.save(OTHER, snapshotOf(9, B, "另一个身份"))).toBe(true);
  expect(await cache.remove(IDENTITY)).toBe(true);
  expect(await cache.load(IDENTITY)).toBe(null);
  // Forgetting one Being leaves the others alone.
  expect(await cache.load(OTHER)).toStrictEqual(snapshotOf(9, B, "另一个身份"));
  // Removing what is not there already succeeded.
  expect(await cache.remove(IDENTITY)).toBe(true);
});
