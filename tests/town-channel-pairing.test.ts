// Ported from BeingDesktop test/town-pairing.test.cjs on 2026-09-16. Fixtures copied verbatim.
import { expect, it } from "vitest";
import { TownPairing } from "../desktop/main/town/channel/pairing-probe";
import { TownClient } from "../desktop/main/town/session/client";
import type { PairingClient, PairingConnectionContext } from "../desktop/main/town/channel/types";
import type { TownClientContext, TownCredentialStore } from "../desktop/main/town/session/types";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The first eight cases of the BeingDesktop file exercise TownClient
// (src/town-client.cjs). They were carried as `it.skip` until that module had a
// port; integration unit I1 brought it in as
// desktop/main/town/session/client.ts, so they are live again, against the real
// client and with BeingDesktop's fixtures copied verbatim.
const token = "b".repeat(64);
interface ClientFixtureOptions {
  reply?: Record<string, unknown>;
  confirm?: () => Promise<Response> | Response;
  save?: (...args: unknown[]) => Promise<void>;
  beingId?: string;
}
function clientFixture({
  reply = { ok: true, token, town_id: "t_alice", display: "Alice (t_alice)" },
  confirm, save, beingId = "alice",
}: ClientFixtureOptions = {}) {
  let context: TownClientContext = { connected: true, key: "loom-a", beingId, revision: 1 };
  const calls: { route: string; options: RequestInit }[] = [];
  const saved: unknown[][] = [];
  const store: TownCredentialStore = {
    assertAvailable() {},
    loadCredential: async () => null,
    save: async (...args: unknown[]) => { saved.push(args); if (save) await save(...args); },
  };
  const client = new TownClient({
    getContext: () => context, store,
    fetchImpl: (async (url: string, options: RequestInit) => {
      const route = new URL(url).pathname;
      calls.push({ route, options });
      if (route.endsWith("/confirm")) return confirm ? confirm() : json(reply);
      // The one-time token is persisted BEFORE another connection is opened; a
      // stream request that arrives first means a token was minted and lost.
      expect(saved.length > 0).toBe(true);
      if (route.endsWith("/stream")) return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify({ town_id: reply.town_id, anonymous: false, token_kind: "client" })}\n\n`));
          options.signal!.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
      throw new Error("Unexpected request");
    }) as unknown as typeof fetch,
  });
  return {
    client, calls, saved, store,
    switch() { context = { ...context, key: "loom-b", beingId: "bob", revision: 2 }; client.reset(); },
  };
}

it("current SDK confirm response persists Town ID and display without requiring removed being_id", async () => {
  const f = clientFixture();
  try {
    const result = await f.client.pair({ code: "AB01XY" });
    await tick();
    expect(result.townId).toBe("t_alice");
    expect(result.loomBeingId).toBe("alice");
    expect(f.saved[0].slice(0, 5)).toEqual(["loom-a", "alice", token, "t_alice", "Alice (t_alice)"]);
    expect(JSON.parse(String(f.calls[0].options.body))).toEqual({ being_id: "alice", code: "AB01XY" });
    expect((f.calls[0].options.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(f.client.state().status).toBe("connected");
    expect(JSON.stringify(f.client.state()).includes(token)).toBe(false);
  } finally { f.client.reset(); }
});

it("Town-prefixed identities use the town_id confirm field", async () => {
  const f = clientFixture({ beingId: "t_alice" });
  try {
    await f.client.pair({ code: "AB3XY9" });
    expect(JSON.parse(String(f.calls[0].options.body))).toEqual({ town_id: "t_alice", code: "AB3XY9" });
  } finally { f.client.reset(); }
});

it("a saved Town binding is checked even before the background stream has loaded it", async () => {
  const f = clientFixture();
  try {
    f.store.loadCredential = async () => ({ token: "a".repeat(64), townId: "t_other" });
    await expect(f.client.pair({ code: "AB3XY9" })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(f.saved).toHaveLength(0);
    expect(f.client.state().pairErrorCode).toBe("IDENTITY_MISMATCH");
  } finally { f.client.reset(); }
});

it("invalid or conflicting confirm identities cannot replace saved credentials", async () => {
  for (const reply of [
    { ok: true, token, town_id: null },
    { ok: true, token, town_id: "alice" },
    { ok: true, token, town_id: "t_alice", being_id: "bob" },
    { ok: true, token },
    { ok: true, town_id: "t_alice", token: 123 },
  ]) {
    const f = clientFixture({ reply });
    try {
      await expect(f.client.pair({ code: "AB3XY9" })).rejects.toThrow();
      expect(f.saved).toHaveLength(0);
      expect(f.calls).toHaveLength(1);
    } finally { f.client.reset(); }
  }
});

it("a new token survives storage failure in memory and retry never consumes another code", async () => {
  let failed = true;
  const f = clientFixture({ save: async () => { if (failed) throw new Error("disk full"); } });
  try {
    await expect(f.client.pair({ code: "AB3XY9" })).rejects.toMatchObject({ code: "PAIR_STORAGE_ERROR" });
    expect(f.client.state().pairingPending).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.client.state()).includes(token)).toBe(false);
    await expect(f.client.pair({ code: "NEW123" })).rejects.toMatchObject({ code: "PAIR_STORAGE_ERROR" });
    failed = false;
    await f.client.retryPairStorage();
    expect(f.calls.filter(call => call.route.endsWith("/confirm"))).toHaveLength(1);
    expect(f.saved).toHaveLength(2);
    expect(f.saved[1][2]).toBe(token);
    expect(f.client.state().pairingPending).toBe(false);
  } finally { f.client.reset(); }
});

it("pair errors distinguish consumed-code uncertainty, invalid code, and rate limit without retry", async () => {
  const cases: [() => Response, string][] = [
    [() => json({ error: "invalid" }, 400), "PAIR_CODE_INVALID"],
    [() => json({ error: "rate" }, 429), "RATE_LIMITED"],
    [() => { throw new Error("connection lost"); }, "PAIR_RESULT_UNKNOWN"],
  ];
  for (const [confirm, code] of cases) {
    const f = clientFixture({ confirm });
    try {
      await expect(f.client.pair({ code: "AB3XY9" })).rejects.toMatchObject({ code });
      expect(f.calls).toHaveLength(1);
      expect(f.saved).toHaveLength(0);
    } finally { f.client.reset(); }
  }
});

it("changing Being while confirm is pending cannot save or publish its response", async () => {
  let resolve!: (value: Response) => void;
  const f = clientFixture({ confirm: () => new Promise<Response>(done => { resolve = done; }) });
  try {
    const pending = f.client.pair({ code: "AB3XY9" });
    await tick();
    f.switch();
    resolve(json({ ok: true, token, town_id: "t_alice" }));
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(f.saved).toHaveLength(0);
  } finally { f.client.reset(); }
});

it("credential diagnostics distinguish missing, unreadable and unavailable storage without secrets", async () => {
  for (const reason of ["NO_SAVED_CREDENTIAL", "CREDENTIAL_UNREADABLE", "SECURE_STORAGE_UNAVAILABLE"]) {
    const f = clientFixture();
    try {
      f.store.loadCredential = async () => {
        if (reason === "NO_SAVED_CREDENTIAL") return null;
        throw Object.assign(new Error("private error"), { code: "AUTH_REQUIRED", reason });
      };
      f.client.lifecycle({ enabled: true });
      await tick();
      expect(f.client.state().authReason).toBe(reason);
      expect(f.client.state().paired).toBe(false);
      expect(f.calls).toHaveLength(0);
      expect(JSON.stringify(f.client.state()).includes("private")).toBe(false);
    } finally { f.client.reset(); }
  }
});

type Frame = [string, Record<string, unknown>];
interface PairingFixtureOptions {
  events?: (scene: string) => Frame[];
  response?: (url: string, options: RequestInit) => Promise<Response> | Response;
  active?: () => Response;
  timeoutMs?: number;
}

function pairingFixture({ events, response, active = () => new Response(null, { status: 204 }), timeoutMs = 90000 }: PairingFixtureOptions = {}) {
  let context: PairingConnectionContext = { connected: true, connection: "https://echo.example/alice?token=loom-fixture", revision: 1 };
  const calls: { url: string; options: RequestInit }[] = [];
  const pairs: { code: string }[] = [];
  const client: PairingClient = {
    store: { assertAvailable() {} },
    state: () => ({}),
    pair: async (value) => { pairs.push(value); return { paired: true }; },
  };
  const pairing = new TownPairing({
    getContext: () => context,
    client,
    timeoutMs,
    fetchImpl: (async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (new URL(url).pathname.endsWith("/active")) return active();
      if (response) return response(url, options);
      const { scene_id: scene } = JSON.parse(String(options.body));
      const frames: Frame[] = events ? events(scene) : [["meta", { scene_id: scene }], ["text", { text: "AB0" }], ["text", { text: "1XY" }], ["done", {}]];
      return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch,
  });
  return { pairing, client, pairs, calls, switch() { context = { ...context, revision: 2, connection: "https://echo.example/bob?token=other" }; pairing.reset(); } };
}

it("one click pairs once from a complete, scene-bound reply and exposes no code or credential", async () => {
  const f = pairingFixture();
  expect(await f.pairing.connect()).toEqual({ paired: true });
  expect(f.pairs).toEqual([{ code: "AB01XY" }]);
  expect(f.calls.length).toBe(2);
  expect(f.pairing.state().busy).toBe(false);
  expect(JSON.stringify(f.pairing.state()).includes("AB01XY")).toBe(false);
  expect(JSON.stringify(f.pairing.state()).includes("loom-fixture")).toBe(false);
  expect(f.calls[1].options.redirect).toBe("error");
});

it("content_block_delta supports fragmented codes and ignores reasoning and tool results", async () => {
  const f = pairingFixture({ events: (scene) => [["meta", { scene_id: scene }], ["reasoning", { text: "SECRET" }], ["tool_result", { text: "WRONG1" }], ["content_block_delta", { delta: { text: "AB3" } }], ["content_block_delta", { delta: { text: "XY9" } }], ["message_stop", {}]] });
  await f.pairing.connect();
  expect(f.pairs).toEqual([{ code: "AB3XY9" }]);
});

it("foreign, unscoped, incomplete, ambiguous and errored replies never authorize a client", async () => {
  for (const events of [
    (_scene: string): Frame[] => [["meta", { scene_id: "foreign" }], ["text", { text: "AB3XY9" }], ["done", {}]],
    (_scene: string): Frame[] => [["text", { text: "AB3XY9" }], ["done", {}]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9" }]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9 CD4YZ8" }], ["done", {}]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9" }], ["error", { message: "failed" }], ["done", {}]],
    (scene: string): Frame[] => [["meta", { scene_id: scene }], ["text", { text: "AB3XY9" }], ["meta", { scene_id: "foreign" }], ["done", {}]],
  ]) {
    const f = pairingFixture({ events });
    await expect(f.pairing.connect()).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
    expect(f.pairs.length).toBe(0);
    expect(f.calls.length).toBe(2);
  }
});

it("202 queues only one request and falls back without extracting or resending", async () => {
  const f = pairingFixture({ response: () => json({ spliced: true }, 202) });
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(2);
});

it("busy Being and unavailable safe storage block before sending a chat message", async () => {
  const f = pairingFixture({ active: () => json({ finished: false }) });
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "BUSY" });
  expect(f.calls.length).toBe(1);
  const g = pairingFixture();
  g.client.store.assertAvailable = () => { throw Object.assign(new Error("unavailable"), { code: "AUTH_REQUIRED" }); };
  await expect(g.pairing.connect()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(g.calls.length).toBe(0);
  const h = pairingFixture();
  h.client.pairing = true;
  await expect(h.pairing.connect()).rejects.toMatchObject({ code: "BUSY" });
  expect(h.calls.length).toBe(0);
});

it("concurrent clicks and switching Being cannot confirm a stale code", async () => {
  let resolve!: (value: Response) => void;
  const f = pairingFixture({ response: () => new Promise<Response>((r) => { resolve = r; }) });
  const pending = f.pairing.connect();
  await tick();
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "BUSY" });
  f.switch();
  resolve(json({}, 202));
  await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(f.pairs.length).toBe(0);
  expect(f.pairing.state().busy).toBe(false);
});

it("a timeout ignores a late response and never repeats the chat or confirm request", async () => {
  let resolve!: (value: Response) => void;
  const f = pairingFixture({ timeoutMs: 1, response: () => new Promise<Response>((r) => { resolve = r; }) });
  const pending = f.pairing.connect();
  await new Promise((r) => setTimeout(r, 10));
  const scene = JSON.parse(String(f.calls[1].options.body)).scene_id;
  resolve(new Response(`event: meta\ndata: ${JSON.stringify({ scene_id: scene })}\n\nevent: text\ndata: {"text":"AB3XY9"}\n\nevent: done\ndata: {}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  await expect(pending).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(2);
});

// The three cases below are not in the BeingDesktop file. They pin behaviour this port first got
// wrong; each expectation was measured against src/town-pairing.cjs itself on 2026-09-16.

// Measured: REJECTED code="PAIRING_INCOMPLETE" state.errorCode="PAIRING_INCOMPLETE" pairs=0 calls=2.
// consumeEvents hands `null` to the handler, whose `data.scene_id` read throws; that TypeError is
// what refuses the reply. Replacing the payload with `{}` would pair on this stream instead.
it("a null SSE payload cannot authorize pairing", async () => {
  const f = pairingFixture({
    response: (_url, options) => {
      const { scene_id: scene } = JSON.parse(String(options.body));
      return new Response(`event: meta\ndata: ${JSON.stringify({ scene_id: scene })}\n\nevent: text\ndata: {"text":"AB3XY9"}\n\nevent: done\ndata: null\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "PAIRING_INCOMPLETE" });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(2);
  expect(f.pairing.state()).toEqual({ status: "manual_required", busy: false, errorCode: "PAIRING_INCOMPLETE" });
});

// Measured: REJECTED name=TimeoutError code=23 state.errorCode=23 pairs=0 calls=1. A real fetch
// rejects the 90-second timeout with a DOMException, whose legacy code is a number; the original
// error reaches the caller because no PAIRING_ERRORS entry matches it.
it("a timed out request keeps its own abort error and numeric code", async () => {
  const f = pairingFixture({ active: () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } });
  const error = await f.pairing.connect().then(() => null, (value: unknown) => value);
  expect((error as DOMException).name).toBe("TimeoutError");
  expect((error as DOMException).code).toBe(23);
  expect(f.pairing.state()).toEqual({ status: "manual_required", busy: false, errorCode: 23 });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(1);
});

// Measured: REJECTED code="READINESS_UNKNOWN" state.errorCode="READINESS_UNKNOWN" pairs=0 calls=1.
// A JSON `null` verdict is not a readable readiness answer, so it is unknown rather than BUSY.
it("a null readiness body leaves readiness unknown and sends no chat message", async () => {
  const f = pairingFixture({ active: () => json(null) });
  await expect(f.pairing.connect()).rejects.toMatchObject({ code: "READINESS_UNKNOWN" });
  expect(f.pairing.state()).toEqual({ status: "manual_required", busy: false, errorCode: "READINESS_UNKNOWN" });
  expect(f.pairs.length).toBe(0);
  expect(f.calls.length).toBe(1);
});
