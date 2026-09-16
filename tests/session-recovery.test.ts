// Ported from BeingDesktop 0.8.26 test/session-recovery.test.cjs (38 lines); 2026-09-16.
// Fixture data is copied verbatim; only the assertion style changes (node:test +
// node:assert/strict -> vitest).
//
// `importSessionRecovery` is serialized with `.toString()` and injected into the
// Loom page, so both original cases run it through `node:vm` rather than calling it
// directly — that is the only form in which it ever executes. The cases added below
// cover `readSessionRecovery`, the main-process half, which BeingDesktop's own file
// does not exercise.
import { expect, test } from "vitest";
import vm from "node:vm";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, webcrypto } from "node:crypto";
import { importSessionRecovery, readSessionRecovery, sessionPartition } from "../desktop/main/chat/session-recovery";
import type { RecoveryConnection } from "../desktop/main/chat/store-types";

test("recovery preserves current sessions, retains conflicts separately, and imports only once", () => {
  const key = "being-desktop-sessions-v1:/loom/Being";
  const original = { id: "one", title: "Existing", context: "", messages: [{ role: "user", content: "new" }] };
  const storage = new Map<string, string>([
    [key, JSON.stringify({ active: "one", items: [{ id: "one", title: "Existing" }] })],
    [key + ":one", JSON.stringify(original)],
  ]);
  const context = vm.createContext({
    crypto: webcrypto,
    location: { origin: "https://fixture.invalid", pathname: "/loom/Being" },
    localStorage: {
      getItem: (k: string) => storage.get(k),
      setItem: (k: string, v: string) => storage.set(k, v),
    },
  });
  vm.runInContext("window=globalThis; window.top=window", context);
  const recovery = {
    origin: "https://fixture.invalid",
    id: "backup-1",
    entries: [
      [key, JSON.stringify({ active: "one", items: [{ id: "one", title: "Old" }, { id: "two", title: "Second" }] })],
      [key + ":one", JSON.stringify({ ...original, messages: [{ role: "user", content: "old" }] })],
      [key + ":two", JSON.stringify({ id: "two", title: "Second", messages: [] })],
    ],
  };
  const run = () =>
    vm.runInContext(`(${importSessionRecovery.toString()})(${JSON.stringify(recovery)})`, context);
  run();
  run();
  const index = JSON.parse(storage.get(key)!);
  expect(index.active).toBe("one");
  expect(index.items.length).toBe(3);
  // The conversation the user has in front of them is never overwritten.
  expect(JSON.parse(storage.get(key + ":one")!)).toStrictEqual(original);
  const restored = index.items.find((item: { id: string }) => !["one", "two"].includes(item.id));
  expect(JSON.parse(storage.get(key + ":" + restored.id)!).messages[0].content).toBe("old");
  recovery.origin = "https://foreign.invalid";
  recovery.id = "backup-2";
  run();
  expect(JSON.parse(storage.get(key)!).items.length).toBe(3);
});

test("post-migration recovery reaches only its owning Desktop namespace", () => {
  const id = webcrypto.randomUUID(),
    other = webcrypto.randomUUID();
  const legacy = "being-desktop-sessions-v1:/loom/Being",
    key = "being-desktop-sessions-v2:" + id + ":/loom/Being";
  const storage = new Map<string, string>([
    [key, JSON.stringify({ active: "current", items: [{ id: "current" }] })],
    [legacy + ":desktop-owner", id],
  ]);
  const context = vm.createContext({
    crypto: webcrypto,
    location: { origin: "https://fixture.invalid", pathname: "/loom/Being" },
    localStorage: {
      getItem: (k: string) => storage.get(k),
      setItem: (k: string, v: string) => storage.set(k, v),
    },
  });
  vm.runInContext("window=globalThis;window.top=window", context);
  const recovery = {
    origin: "https://fixture.invalid",
    id: "new-backup",
    entries: [
      [legacy, JSON.stringify({ active: "recovered", items: [{ id: "recovered", title: "Recovered", messages: [] }] })],
    ],
  };
  const run = (desktop: string) =>
    vm.runInContext(
      `(${importSessionRecovery.toString()})(${JSON.stringify(recovery)},'${desktop}')`,
      context,
    );
  run(other);
  expect(storage.size).toBe(2);
  run(id);
  run(id);
  expect(JSON.parse(storage.get(key)!).items.length).toBe(2);
  expect(JSON.parse(storage.get(key + ":recovered")!).title).toBe("Recovered");
  // After migration the legacy store is not resurrected.
  expect(storage.has(legacy)).toBe(false);
});

// New in this port: the main-process reader. The file name is part of the on-disk
// contract — it is the Loom page's own session partition minus the `persist:`
// prefix — so it is reproduced here rather than asked of the implementation.
const connection: RecoveryConnection = {
  displayUrl: "https://echo.beings.town/cz_being",
  apiBase: "https://echo.beings.town/api",
  token: "private-test-credential",
  secret: "relay-secret",
};

test("the recovery file is found by session partition, and a foreign one is refused", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beings-session-recovery-"));
  // BeingDesktop src/security.cjs lines 45-48, recomputed independently.
  const expected =
    "persist:loom-v1-" +
    createHash("sha256")
      .update(JSON.stringify(["v1", connection.displayUrl, connection.apiBase, connection.token, connection.secret]))
      .digest("hex")
      .slice(0, 32);
  expect(sessionPartition(connection)).toBe(expected);
  // Nothing on disk is not an error: there is simply no backup to import.
  expect(await readSessionRecovery(directory, connection)).toBe(null);
  const file = path.join(directory, "session-recovery", expected.slice(8) + ".json");
  await mkdir(path.dirname(file), { recursive: true });
  const recovery = {
    id: "backup-1",
    origin: "https://echo.beings.town",
    desktopId: "11111111-1111-4111-8111-111111111111",
    entries: [["being-desktop-sessions-v1:/cz_being", JSON.stringify({ active: "one", items: [] })]],
  };
  await writeFile(file, JSON.stringify(recovery));
  expect(await readSessionRecovery(directory, connection)).toStrictEqual(recovery);
  // A backup captured against another origin is not this Being's, whatever the
  // file name says.
  await writeFile(file, JSON.stringify({ ...recovery, origin: "https://foreign.invalid" }));
  expect(await readSessionRecovery(directory, connection)).toBe(null);
  // Shapes that cannot be imported are refused rather than half-applied.
  await writeFile(file, JSON.stringify({ ...recovery, entries: "nope" }));
  expect(await readSessionRecovery(directory, connection)).toBe(null);
  await writeFile(file, JSON.stringify({ ...recovery, id: 7 }));
  expect(await readSessionRecovery(directory, connection)).toBe(null);
  // A file that is there but unreadable is a real failure: silently treating it as
  // "no backup" would drop the conversations it holds.
  await writeFile(file, "{ not json");
  await expect(readSessionRecovery(directory, connection)).rejects.toThrow();
});
