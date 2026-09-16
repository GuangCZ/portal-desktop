// Ported from BeingDesktop 0.8.26 test/feature-task-history.test.cjs on 2026-09-16 (node:test -> vitest).
// Fixtures are copied verbatim; only the assertion style and the temporary directory changed
// (the source wrote under the repository's .local; here it uses os.tmpdir()).
// `normalizeTownSyncRecords` is injected, so this file carries a faithful copy of
// BeingDesktop src/loom-town-sync.cjs lines 9-29 plus src/town-library-contract.cjs `libraryRoute`.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { FeatureTaskHistory } from "../desktop/main/features/feature-task-history";
import type { SafeStorageApi, TownSyncRecord } from "../desktop/main/features/types";

const RESERVED_SCROLL_IDS = new Set(["help", "search", "graph", "match"]);
const SCROLL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
function detailId(route: string): string | null {
  if (typeof route !== "string" || !route.startsWith("/api/scrolls/")) return null;
  const id = route.slice("/api/scrolls/".length);
  return SCROLL_ID.test(id) && !RESERVED_SCROLL_IDS.has(id) ? id : null;
}
function libraryRoute(route: string): boolean { return route === "/api/beings" || route === "/api/scrolls" || detailId(route) !== null; }

function normalizeTownSyncRecords(value: unknown): TownSyncRecord[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, TownSyncRecord>(), conflicts = new Set<string>();
  const routes = new Set(["/api/bonfire/hear", "/api/bonfire/mentions", "/api/bonfire/speak", "/api/fireside/speak", "/api/fireside/list", "/api/fireside/members", "/api/fireside/hear"]);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (let index = Math.max(0, value.length - 256); index < value.length; index++) {
    const item: unknown = Object.getOwnPropertyDescriptor(value, index)?.value;
    if (!item || Object.getPrototypeOf(item) !== Object.prototype) continue;
    const fields = Object.getOwnPropertyDescriptors(item), keys = ["requestId", "route", "beingId", "prompt"];
    if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key] || !Object.hasOwn(fields[key], "value") || typeof fields[key].value !== "string")) continue;
    const next = Object.fromEntries(keys.map(key => [key, fields[key].value])) as unknown as TownSyncRecord;
    if (!uuid.test(next.requestId) || !routes.has(next.route) && !libraryRoute(next.route) && !/^\/desktop\/channel\/(feishu|wechat)\/(begin|status)$/.test(next.route) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(next.beingId)
      || next.prompt.length > 160000 || !next.prompt.startsWith(`[Being Desktop Town sync:${next.requestId}]`)) continue;
    next.prompt = next.prompt.replace(/\s+/g, " ").trim();
    if (conflicts.has(next.requestId)) continue;
    const previous = result.get(next.requestId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next)) { result.delete(next.requestId); conflicts.add(next.requestId); }
    else result.set(next.requestId, next);
  }
  return [...result.values()];
}

function encryptedStorage(): SafeStorageApi {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

const roots: string[] = [];
async function directory(): Promise<string> {
  const result = await mkdtemp(path.join(os.tmpdir(), "feature-task-history-test-"));
  roots.push(result);
  return result;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop() as string, { recursive: true, force: true });
});

function record(beingId = "cz_being") {
  const requestId = randomUUID();
  return { requestId, route: "/api/bonfire/hear", beingId, prompt: `[Being Desktop Town sync:${requestId}]\nRaw private prompt goes here.` };
}

const begin = (history: FeatureTaskHistory) => history.ledger.begin({ feature: "bonfire", operation: "read", title: "读取篝火", execution: "being" });

describe("feature task history", () => {
  it("encrypts owned requests and ledger atomically, restores interrupted reads for user review", async () => {
    const dir = await directory(), safeStorage = encryptedStorage(), events: unknown[] = [];
    const first = new FeatureTaskHistory({ identityKey: "persist:first", directory: dir, safeStorage, normalizeTownSyncRecords, onChange: event => events.push(event) });
    await first.restore();
    const task = begin(first), own = record();
    expect(first.register(own)).toBe(true);
    first.ledger.update(task.id, { requestId: own.requestId, detail: "读取中" });
    expect(await first.flush()).toBe(true);
    const raw = await readFile(first.filePath);
    expect(raw.includes(Buffer.from("Raw private prompt"))).toBe(false);
    expect(raw.includes(Buffer.from("读取篝火"))).toBe(false);
    expect((await readdir(dir)).filter(name => name.endsWith(".tmp"))).toStrictEqual([]);
    expect(path.basename(first.filePath)).toBe(createHash("sha256").update("persist:first").digest("hex") + ".bin");
    expect(events.every(event => Object.keys(event as object).every(key => ["tasks", "persistenceError"].includes(key)))).toBe(true);
    expect(JSON.stringify(events).includes("Raw private prompt")).toBe(false);
    const second = new FeatureTaskHistory({ identityKey: "persist:first", directory: dir, safeStorage, normalizeTownSyncRecords });
    await second.restore();
    expect(second.ledger.get(task.id)?.status).toBe("needs_input");
    expect(second.ledger.get(task.id)?.detail).toMatch(/不会自动重发/);
    expect(second.records[0].requestId).toBe(own.requestId);
    expect(second.records[0].prompt).toBe(own.prompt.replace(/\s+/g, " "));
  });

  it("different identities have different encrypted files and exact isolation", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const a = new FeatureTaskHistory({ identityKey: "identity-a", directory: dir, safeStorage, normalizeTownSyncRecords });
    const b = new FeatureTaskHistory({ identityKey: "identity-b", directory: dir, safeStorage, normalizeTownSyncRecords });
    await Promise.all([a.restore(), b.restore()]);
    const taskA = begin(a), taskB = begin(b);
    a.ledger.complete(taskA.id, { summary: "A" }); b.ledger.complete(taskB.id, { summary: "B" });
    await Promise.all([a.flush(), b.flush()]);
    expect(a.filePath).not.toBe(b.filePath);
    const againA = new FeatureTaskHistory({ identityKey: "identity-a", directory: dir, safeStorage, normalizeTownSyncRecords });
    const againB = new FeatureTaskHistory({ identityKey: "identity-b", directory: dir, safeStorage, normalizeTownSyncRecords });
    await Promise.all([againA.restore(), againB.restore()]);
    expect(againA.ledger.get(taskA.id)?.summary).toBe("A");
    expect(againA.ledger.get(taskB.id)).toBe(null);
    expect(againB.ledger.get(taskB.id)?.summary).toBe("B");
  });

  it("corrupt or foreign ciphertext is never replaced after failed restore", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    for (const kind of ["corrupt", "foreign", "schema"]) {
      const history = new FeatureTaskHistory({ identityKey: `identity-${kind}`, directory: dir, safeStorage, normalizeTownSyncRecords });
      const original = kind === "corrupt" ? Buffer.from("corrupt ciphertext") : safeStorage.encryptString(JSON.stringify({ version: 1, identityKey: kind === "foreign" ? "other" : history.identityKey, ledger: { version: 1, identityKey: history.identityKey, records: [] }, ...(kind === "schema" ? {} : { records: [] }) }));
      await writeFile(history.filePath, original);
      await history.restore();
      begin(history); history.register(record());
      expect(await history.flush()).toBe(false);
      expect(history.persistenceError).toBe(true);
      expect((await readFile(history.filePath)).equals(original)).toBe(true);
    }
  });

  it("unavailable encryption keeps records in memory and writes no plaintext", async () => {
    const dir = await directory();
    let encryptionCalls = 0;
    const history = new FeatureTaskHistory({ identityKey: "locked", directory: dir, normalizeTownSyncRecords, safeStorage: { isEncryptionAvailable: () => false, encryptString() { encryptionCalls++; return Buffer.from("plaintext"); } } });
    await history.restore();
    const task = begin(history); history.register(record());
    expect(await history.flush()).toBe(false);
    expect(history.ledger.get(task.id)?.status).toBe("running");
    expect(encryptionCalls).toBe(0);
    expect(await readdir(dir)).toStrictEqual([]);
  });

  it("an encryption failure preserves the last complete encrypted version", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const history = new FeatureTaskHistory({ identityKey: "encrypt-failure", directory: dir, safeStorage, normalizeTownSyncRecords });
    await history.restore();
    const task = begin(history); await history.flush();
    const original = await readFile(history.filePath);
    safeStorage.encryptString = () => { throw new Error("Credential acquisition failed"); };
    history.ledger.complete(task.id, { summary: "Completed in memory" });
    expect(await history.flush()).toBe(false);
    expect((await readFile(history.filePath)).equals(original)).toBe(true);
    expect((await readdir(dir)).filter(name => name.endsWith(".tmp"))).toStrictEqual([]);
  });

  it("serialized saves retain the latest mutation even while the prior write is pending", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const history = new FeatureTaskHistory({ identityKey: "latest", directory: dir, safeStorage, normalizeTownSyncRecords });
    await history.restore();
    const encrypt = safeStorage.encryptString;
    let encryptions = 0;
    safeStorage.encryptString = value => {
      encryptions++;
      if (encryptions === 1) queueMicrotask(() => { history.ledger.complete(task.id, { summary: "The final result" }); });
      return encrypt(value);
    };
    const task = begin(history);
    for (let i = 0; i < 30; i++) history.ledger.update(task.id, { detail: `Progress ${i}` });
    await history.flush();
    expect(encryptions).toBe(2);
    const second = new FeatureTaskHistory({ identityKey: "latest", directory: dir, safeStorage, normalizeTownSyncRecords }); await second.restore();
    expect(second.ledger.get(task.id)?.status).toBe("succeeded");
    expect(second.ledger.get(task.id)?.summary).toBe("The final result");
    expect((await readdir(dir)).filter(name => name.endsWith(".tmp"))).toStrictEqual([]);
  });

  it("registration uses exact normalized owned records, rejects getters and is capped at 256", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const history = new FeatureTaskHistory({ identityKey: "records", directory: dir, safeStorage, normalizeTownSyncRecords }); await history.restore();
    const own = record();
    expect(history.register(own)).toBe(true); expect(history.register(own)).toBe(true);
    expect(history.records.length).toBe(1);
    expect(history.register({ ...own, route: "/api/chat/stream" })).toBe(false);
    let invoked = 0;
    const unsafe = { ...own }; Object.defineProperty(unsafe, "prompt", { get() { invoked++; throw new Error("Getter invoked"); } });
    expect(history.register(unsafe)).toBe(false); expect(invoked).toBe(0);
    expect(history.register({ ...own, beingId: "another" })).toBe(false);
    expect(history.records.length).toBe(0);
    for (let i = 0; i < 258; i++) history.register(record());
    expect(history.records.length).toBe(256);
    const copy = history.records; copy[0].prompt = "changed";
    expect(history.records[0].prompt).not.toBe("changed");
    await history.flush();
  });

  it("same history restore is idempotent and callback failures do not interrupt work", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const history = new FeatureTaskHistory({ identityKey: "idempotent", directory: dir, safeStorage, normalizeTownSyncRecords, onChange() { throw new Error("Observer failed"); } });
    await Promise.all([history.restore(), history.restore()]);
    const ledger = history.ledger, task = begin(history);
    await history.restore();
    expect(history.ledger).toBe(ledger);
    expect(history.ledger.get(task.id)?.status).toBe("running");
    expect(await history.flush()).toBe(true);
  });

  it("a changed ledger identity cannot overwrite the original account history", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const history = new FeatureTaskHistory({ identityKey: "identity-original", directory: dir, safeStorage, normalizeTownSyncRecords }); await history.restore();
    begin(history); await history.flush();
    const original = await readFile(history.filePath);
    history.ledger.reset({ identityKey: "identity-other" });
    expect(await history.flush()).toBe(false);
    expect((await readFile(history.filePath)).equals(original)).toBe(true);
  });

  it("unsafe identities never become filesystem paths", async () => {
    const dir = await directory();
    for (const identityKey of ["", "../other", "a/b", "a\\b", "a".repeat(129)]) expect(() => new FeatureTaskHistory({ identityKey, directory: dir, safeStorage: encryptedStorage(), normalizeTownSyncRecords })).toThrow(/identity/);
  });

  // Added for the port: BeingDesktop 0.8.x files must stay readable, and what this port writes back
  // must stay in the same schema (docs/interfaces.md §7).
  it("reads a BeingDesktop 0.8.x history file and writes the same schema back", async () => {
    const dir = await directory(), safeStorage = encryptedStorage();
    const identityKey = "legacy:0.8";
    const requestId = randomUUID();
    const legacy = {
      version: 1,
      identityKey,
      ledger: {
        version: 1,
        identityKey,
        records: [
          { id: "task-legacy-blocked", feature: "bonfire", operation: "read", title: "读取篝火", execution: "being", mayDelayChat: true, status: "waiting", detail: "Being 正在处理其他请求，本次操作尚未完成；不会自动重发。", summary: "", requestId: "", errorCode: "", createdAt: 1700000000000, updatedAt: 1700000001000, finishedAt: null },
          { id: "task-legacy-done", feature: "scroll", operation: "read", title: "读取卷轴正文", execution: "being", mayDelayChat: true, status: "succeeded", detail: "", summary: "已读取卷轴《日志》当前页。", requestId, errorCode: "", createdAt: 1700000002000, updatedAt: 1700000003000, finishedAt: 1700000003000 },
        ],
      },
      records: [{ requestId, route: "/api/bonfire/hear", beingId: "cz_being", prompt: `[Being Desktop Town sync:${requestId}] Raw private prompt goes here.` }],
    };
    const filePath = path.join(dir, `${createHash("sha256").update(identityKey).digest("hex")}.bin`);
    await writeFile(filePath, safeStorage.encryptString(JSON.stringify(legacy)));
    const history = new FeatureTaskHistory({ identityKey, directory: dir, safeStorage, normalizeTownSyncRecords });
    await history.restore();
    expect(history.filePath).toBe(filePath);
    expect(history.persistenceError).toBe(false);
    expect(history.ledger.get("task-legacy-done")?.summary).toBe("已读取卷轴《日志》当前页。");
    expect(history.ledger.get("task-legacy-done")?.finishedAt).toBe(1700000003000);
    expect(history.ledger.get("task-legacy-blocked")?.status).toBe("failed");
    expect(history.ledger.get("task-legacy-blocked")?.errorCode).toBe("READINESS_UNKNOWN");
    expect(history.ledger.list().map(task => task.id)).toStrictEqual(["task-legacy-done", "task-legacy-blocked"]);
    expect(history.records).toStrictEqual(legacy.records);
    begin(history);
    expect(await history.flush()).toBe(true);
    const written = JSON.parse(safeStorage.decryptString(await readFile(filePath))) as { version: number; identityKey: string; ledger: { version: number; identityKey: string; records: unknown[] }; records: unknown[] };
    expect(Object.keys(written)).toStrictEqual(["version", "identityKey", "ledger", "records"]);
    expect(written.version).toBe(1);
    expect(written.identityKey).toBe(identityKey);
    expect(written.ledger.version).toBe(1);
    expect(written.ledger.identityKey).toBe(identityKey);
    expect(written.ledger.records.length).toBe(3);
    expect(written.records).toStrictEqual(legacy.records);
  });
});
