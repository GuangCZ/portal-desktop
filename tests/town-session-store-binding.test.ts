// Regression cover for the 2026-09-16 review of the BeingDesktop 0.8.26 port
// (src/town-client.cjs, src/town-session.cjs, error shape from town-library-contract.cjs).
// The ported suites wire the credential store as an object of arrow functions, which cannot
// observe a lost `this`. Production injects a class instance (src/main.cjs:373
// `new TownClientStore({...})`) whose load/save/remove all delegate to other members, so these
// cases construct the store the same way and assert the CJS behaviour.
import { describe, expect, it } from "vitest";
import { TownClient } from "../desktop/main/town/session/client";
import { TownSession } from "../desktop/main/town/session/session";
import { TownError } from "../desktop/main/town/session/types";
import type { TownClientContext, TownStoredCredential } from "../desktop/main/town/session/types";

const token = "a".repeat(64);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

/**
 * Mirrors src/town-client-store.cjs: every public method reaches for another member through
 * `this`, so a receiver-less call throws TypeError instead of touching the file.
 */
class ClassStore {
  files = new Map<string, TownStoredCredential>();
  saves: unknown[][] = [];
  removed: string[] = [];
  constructor(seed?: TownStoredCredential) { if (seed) this.files.set("account-a", seed); }
  _file(key: string) { return this.files.get(key) || null; }
  _mutate<T>(action: () => Promise<T> | T) { return Promise.resolve().then(action); }
  async loadCredential(key: string, _beingId: string) { return this._file(key); }
  async load(key: string, beingId: string) { return (await this.loadCredential(key, beingId))?.token || null; }
  save(key: string, beingId: string, value: string, townId = "", display = "", isCurrent = () => true) {
    return this._mutate(() => { this.saves.push([key, beingId, value, townId, display, isCurrent]); this.files.set(key, { token: value, townId, display }); });
  }
  remove(key: string) { return this._mutate(() => { this.removed.push(key); this.files.delete(key); }); }
}

const context: TownClientContext = { key: "account-a", beingId: "alice", revision: 1, connected: true };
function client(store: ClassStore, fetchImpl: (url: string, options: RequestInit) => Promise<Response>) {
  const calls: URL[] = [];
  const instance = new TownClient({
    getContext: () => context, store, retryMs: 10,
    fetchImpl: (async (url: string, options: RequestInit) => { calls.push(new URL(url)); return fetchImpl(url, options); }) as unknown as typeof fetch,
  });
  return { instance, calls };
}

describe("Town credential store is called through its receiver", () => {
  it("pair saves through a class-based store instead of failing with PAIR_STORAGE_ERROR", async () => {
    const store = new ClassStore();
    const { instance } = client(store, async url => new URL(url).pathname.endsWith("/confirm")
      ? json({ ok: true, being_id: "alice", token })
      : new Response("", { status: 401 }));
    const state = await instance.pair({ code: "AB3XY9" });
    expect(state.status).toBe("connecting");
    expect(state.paired).toBe(true);
    expect(store.saves.map(args => args.slice(0, 5))).toEqual([["account-a", "alice", token, "", ""]]);
    instance.reset();
  });

  it("forget removes the stored credential through a class-based store", async () => {
    const store = new ClassStore({ token });
    const { instance } = client(store, async () => json({ ok: true }));
    const state = await instance.forget();
    expect(state.status).toBe("unpaired");
    expect(store.removed).toEqual(["account-a"]);
    expect(store.files.has("account-a")).toBe(false);
  });

  it("the store.load fallback keeps its receiver when loadCredential is absent", async () => {
    // A store exposing only `load`, as a class method that reaches the token through `this`.
    class LoadOnlyStore {
      inner = new ClassStore({ token });
      async load(key: string, beingId: string) { return this.inner.load(key, beingId); }
    }
    const { instance, calls } = client(new LoadOnlyStore() as unknown as ClassStore, async url =>
      new URL(url).pathname === "/api/bonfire/mentions" ? json({ being: "alice", mentions: [] }) : json({ ok: true, messages: [], global_latest_seq: 0 }));
    await instance.read("/api/bonfire/hear");
    expect(calls.map(url => url.pathname)).toEqual(["/api/bonfire/mentions", "/api/bonfire/hear"]);
    instance.reset();
  });
});

describe("Town error and session construction keep the CJS shape", () => {
  it("TownError carries code as its only own key, like Object.assign(new Error(m), {code})", () => {
    const error = new TownError("SERVICE_ERROR", "Town 暂时不可用，请稍后重试。");
    expect(Object.keys(error)).toEqual(["code"]);
    expect(JSON.stringify(error)).toBe('{"code":"SERVICE_ERROR"}');
    expect(Object.hasOwn(error, "detail")).toBe(false);
    expect(Object.hasOwn(error, "candidates")).toBe(false);
    expect(error.message).toBe("Town 暂时不可用，请稍后重试。");
  });

  it("TownSession built with no options reports the business error, not a TypeError", () => {
    expect(() => new TownSession()).toThrow("Town 会话配置无效。");
    expect(() => new TownSession()).not.toThrow(TypeError);
  });
});
