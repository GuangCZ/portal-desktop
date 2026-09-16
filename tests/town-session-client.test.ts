// Ported line by line from BeingDesktop 0.8.26 test/town-client.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style changes (node:test -> vitest).
import { describe, expect, it } from "vitest";
import { consumeEvents, TownClient } from "../desktop/main/town/session/client";
import { TownSession } from "../desktop/main/town/session/session";
import type { TownClientContext, TownClientEvent, TownCredentialStore } from "../desktop/main/town/session/types";

type Fetcher = (url: string, options: RequestInit) => Promise<Response>;
const token = "a".repeat(64);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const bonfire = { ok: true, messages: [{ seq: 1, being: "alice", message: "原文", at: "2026-09-10T00:00:00Z" }], global_latest_seq: 1 };
const tick = () => new Promise(r => setImmediate(r));

function fixture(fetchImpl?: Fetcher) {
  let context: TownClientContext = { key: "account-a", beingId: "alice", revision: 1, connected: true };
  const calls: { url: URL; options: RequestInit }[] = [], saved: unknown[][] = [], events: TownClientEvent[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const store: TownCredentialStore = { load: async () => token, save: async (...v: unknown[]) => { saved.push(v); }, remove: async () => {} };
  const client = new TownClient({
    getContext: () => context, store, retryMs: 10,
    onEvent: e => events.push(e),
    fetchImpl: (async (url: string, options: RequestInit) => {
      calls.push({ url: new URL(url), options });
      if (fetchImpl) return fetchImpl(url, options);
      if (new URL(url).pathname === "/api/client/stream") return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; options.signal!.addEventListener("abort", () => { try { c.close(); } catch { /* already closed */ } }); } }), { headers: { "Content-Type": "text/event-stream" } });
      if (new URL(url).pathname === "/api/bonfire/mentions") return json({ being: "alice", mentions: [] });
      return json(bonfire);
    }) as unknown as typeof fetch,
  });
  return {
    client, calls, saved, events, store,
    switch: () => { context = { ...context, beingId: "bob", key: "account-b", revision: 2 }; client.reset(); },
    end: () => stream.close(),
    push: (type: string, data: unknown) => stream.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
  };
}
const writeFixture = (fetchImpl: Fetcher) => fixture((url, options) => new URL(url).pathname === "/api/bonfire/mentions" ? Promise.resolve(json({ being: "alice", mentions: [] })) : fetchImpl(url, options));
const readSession = (f: ReturnType<typeof fixture>) => new TownSession({
  getContext: () => ({ configured: true, connected: true, beingName: "alice", connectionId: 1 }),
  readImpl: (route, options) => f.client.read(route, options),
  fetchImpl: (async () => json({ community: [] })) as unknown as typeof fetch,
});

describe("Town client (SDK protocol)", () => {
  it("SDK direct reads use only Town client bearer auth, verify identity, preserve full text", async () => {
    const f = fixture();
    const session = readSession(f);
    const result = await session.getBonfireMessages({ limit: 10 });
    expect(result.messages[0].content).toBe("原文");
    expect(f.calls.length).toBe(2);
    for (const { url, options } of f.calls) {
      expect(url.origin).toBe("https://beings.town"); expect(url.searchParams.has("token")).toBe(false);
      expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
      expect(options.redirect).toBe("error"); expect(options.credentials).toBe("omit");
    }
    expect(f.calls[0].url.searchParams.get("since_id")).toBe("9223372036854775807");
  });

  it("unpaired reads never dispatch to Being or fall back to anonymous Town", async () => {
    const f = fixture(); f.store.load = async () => null;
    await expect(f.client.read("/api/bonfire/hear")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(f.calls.length).toBe(0);
  });

  it("wrong identity stops before fetching message history", async () => {
    const f = fixture(async () => json({ being: "bob", mentions: [] }));
    await expect(f.client.read("/api/bonfire/hear")).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(f.calls.length).toBe(1);
  });

  it("stale REST response cannot cross a Being switch", async () => {
    let resolve!: (value: Response) => void;
    const f = fixture(() => new Promise<Response>(r => { resolve = r; }));
    const pending = f.client.read("/api/bonfire/hear"); await tick(); f.switch(); resolve(json({ being: "alice", mentions: [] }));
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });

  it("REST failures redact upstream messages and do not retry or return partial results", async () => {
    for (const status of [401, 403, 429, 500]) {
      const f = fixture(async () => json({ error: token }, status));
      const error = await f.client.read("/api/bonfire/hear").catch((e: unknown) => e) as Error & { code: string };
      expect(error.message.includes(token)).toBe(false);
      expect(error.code).toBe([401, 403].includes(status) ? "AUTH_REQUIRED" : status === 429 ? "RATE_LIMITED" : "SERVICE_ERROR");
      expect(f.calls.length).toBe(1);
    }
  });

  it("route allowlist excludes token management and arbitrary hosts", async () => {
    const f = fixture();
    for (const route of ["/api/client/token", "/api/token", "https://evil.test/api", "//evil.test/api"]) await expect(f.client.read(route)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // The inbox is allowed now, but still takes no caller-supplied query parameters.
    for (const query of [{ limit: 10 }, { since: 1 }, { token: "injected" }]) await expect(f.client.read("/api/messages", { query })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const query of [{ limit: false }, { limit: {} }, { limit: 201 }, { limit: "1e2" }, { token: "injected" }]) await expect(f.client.read("/api/bonfire/hear", { query })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.calls.length).toBe(0);
  });

  it("pair persists only encrypted-store input and returns public status without token", async () => {
    const f = fixture(async url => new URL(url).pathname.endsWith("/confirm") ? json({ ok: true, being_id: "alice", token }) : new Response("", { status: 401 }));
    const result = await f.client.pair({ code: "AB3XY9" });
    expect(f.saved.map(args => args.slice(0, 5))).toEqual([["account-a", "alice", token, "", ""]]);
    expect((f.saved[0][5] as () => boolean)()).toBe(false); // The successful pair reset invalidates the old request guard.
    expect(JSON.stringify(result).includes(token)).toBe(false);
    expect((f.calls[0].options.headers as Record<string, string>).Authorization).toBe(undefined);
    expect(JSON.parse(f.calls[0].options.body as string)).toEqual({ being_id: "alice", code: "AB3XY9" });
    f.client.reset();
  });

  it("secure storage unavailable fails before consuming the one-time pairing code", async () => {
    const f = fixture();
    f.store.assertAvailable = () => { throw Object.assign(new Error("Unavailable"), { code: "AUTH_REQUIRED" }); };
    await expect(f.client.pair({ code: "AB3XY9" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(f.calls.length).toBe(0);
  });

  it("SSE authenticates hello, emits only safe invalidation hints, and stops on identity change", async () => {
    const f = fixture(); f.client.lifecycle({ enabled: true }); await tick();
    f.push("hello", { being_id: "alice", token_kind: "client", anonymous: false });
    f.push("bonfire", { message: "untrusted content", seq: 10 }); f.push("fireside", { fireside_id: 7, message: token }); f.push("dm", { content: token }); await tick();
    // dm now reaches the app as a bare invalidation hint: the inbox is re-read over REST,
    // and no part of the pushed payload is carried into the emitted event.
    expect(f.events).toEqual([{ type: "hello" }, { type: "bonfire" }, { type: "fireside", firesideId: "7" }, { type: "dm" }]);
    expect(JSON.stringify(f.events).includes(token)).toBe(false);
    expect(f.client.state().status).toBe("connected"); expect(JSON.stringify(f.client.state()).includes(token)).toBe(false);
    f.switch(); await tick(); expect(f.client.state().paired).toBe(false);
  });

  it("SSE distinguishes anonymous, protocol errors and foreign identities without accepting hints", async () => {
    for (const [hello, status] of [
      [{ being_id: "alice", token_kind: "being", anonymous: false }, "reconnecting"],
      [{ being_id: "bob", token_kind: "client", anonymous: false }, "identity_mismatch"],
      [{ anonymous: true }, "auth_required"],
    ] as [Record<string, unknown>, string][]) {
      const f = fixture(); f.client.lifecycle({ enabled: true }); await tick(); f.push("hello", hello); await tick();
      try {
        expect(f.client.state().status).toBe(status);
        if (status !== "reconnecting") expect(f.client._timer).toBe(null);
        expect(f.events.length).toBe(0);
      } finally { f.client.reset(); }
    }
  });

  it("SSE data before hello is rejected; network EOF reconnects and hello requests reconciliation", async () => {
    const f = fixture(); f.client.lifecycle({ enabled: true }); await tick(); f.push("bonfire", { seq: 1 }); await tick();
    expect(f.events.length).toBe(0); expect(f.client.state().status).toBe("reconnecting"); expect(f.client._timer).toBeTruthy(); f.client.reset();
  });

  it("fragmented UTF-8, CRLF, comments, multiline data and incomplete EOF are parsed safely", async () => {
    const input = ": heartbeat\r\nevent: bonfire\r\ndata: {\"message\":\r\ndata: \"中文\"}\r\n\r\nevent: dm\ndata: {\"partial\":true}";
    const bytes = new TextEncoder().encode(input), events: { type: string; data: unknown }[] = [];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
    await consumeEvents(body, (type, data) => { events.push({ type, data }); });
    expect(events).toEqual([{ type: "bonfire", data: { message: "中文" } }]);
  });

  it("oversized SSE event is cancelled without publishing", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: " + "a".repeat(1024 * 1024 + 1))); }, cancel() { cancelled = true; } });
    await expect(consumeEvents(body, () => { throw new Error("must not publish"); })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(cancelled).toBe(true);
  });

  it("SSE EOF reconnects once and revalidates hello before reconciling", async () => {
    const f = fixture();
    try {
      f.client.lifecycle({ enabled: true }); await tick();
      f.push("hello", { being_id: "alice", token_kind: "client", anonymous: false }); await tick();
      f.client.retryMs = 10; f.end(); await new Promise(r => setTimeout(r, 30));
      expect(f.calls.length).toBe(2); expect(f.client.state().status).toBe("connecting");
      f.push("hello", { being_id: "alice", token_kind: "client", anonymous: false }); await tick();
      expect(f.events).toEqual([{ type: "hello" }, { type: "hello" }]);
      expect(f.calls.every(call => !call.url.searchParams.has("token") && (call.options.headers as Record<string, string>).Authorization === `Bearer ${token}`)).toBe(true);
      f.client.lifecycle({ enabled: false }); await tick();
      expect(f.client._stream).toBe(null); expect(f.client._timer).toBe(null);
    } finally { f.client.reset(); }
  });

  it("paired speak posts directly with the client token and never dispatches a Being turn", async () => {
    const f = writeFixture(async url => new URL(url).pathname === "/api/bonfire/speak"
      ? json({ ok: true, seq: 892, being: "alice", mentions: ["bob"], via: "client:my-desktop" })
      : json(bonfire));
    const receipt = await f.client.speak({ kind: "bonfire", message: "大家好" });
    expect(receipt).toEqual({ ok: true, id: "892", seq: 892, mentions: ["bob"], via: "client:my-desktop" });
    expect(f.calls.length).toBe(2);
    const { url, options } = f.calls[1];
    expect(url.href).toBe("https://beings.town/api/bonfire/speak");
    expect(url.searchParams.has("token")).toBe(false);
    expect(options.method).toBe("POST");
    expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(options.body as string)).toEqual({ message: "大家好" });
  });

  it("fireside speak carries the ring id and reports non-membership as not sent", async () => {
    const ok = writeFixture(async () => json({ ok: true, seq: 6, being: "alice", mentions: [], via: "client:my-desktop" }));
    expect((await ok.client.speak({ kind: "fireside", message: "在圈里说话", firesideId: "10" })).seq).toBe(6);
    expect(JSON.parse(ok.calls[1].options.body as string)).toEqual({ message: "在圈里说话", fireside_id: 10 });

    const denied = writeFixture(async () => json({ error: "not a member" }, 403));
    await expect(denied.client.speak({ kind: "fireside", message: "hi", firesideId: "10" })).rejects.toMatchObject({ code: "NOT_SENT" });
  });

  it("speak rejects over-limit text locally instead of letting bonfire truncate it silently", async () => {
    const f = writeFixture(async () => json({ ok: true, seq: 1, being: "alice", mentions: [] }));
    await expect(f.client.speak({ kind: "bonfire", message: "x".repeat(4001) })).rejects.toMatchObject({ code: "NOT_SENT" });
    await expect(f.client.speak({ kind: "fireside", message: "x".repeat(32001), firesideId: "1" })).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(f.calls.length).toBe(0);
    // The bonfire limit counts code points, so text just inside it still dispatches.
    await f.client.speak({ kind: "bonfire", message: "字".repeat(4000) });
    expect(f.calls.length).toBe(2);
  });

  it("an unconfirmed write is never reported as unsent, and an unpaired one asks for pairing", async () => {
    const lost = writeFixture(async () => { throw new TypeError("network down"); });
    await expect(lost.client.speak({ kind: "bonfire", message: "hi" })).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });

    const unpaired = fixture(); unpaired.store.load = async () => null;
    await expect(unpaired.client.speak({ kind: "bonfire", message: "hi" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(unpaired.calls.length).toBe(0);
  });

  it("a receipt for another being is treated as unconfirmed rather than accepted", async () => {
    const f = writeFixture(async () => json({ ok: true, seq: 5, being: "mallory", mentions: [] }));
    await expect(f.client.speak({ kind: "bonfire", message: "hi" })).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  });

  it("an IP-trusted host reporting via=being is surfaced, not rejected", async () => {
    const f = writeFixture(async () => json({ ok: true, seq: 7, being: "alice", mentions: [], via: "being" }));
    expect((await f.client.speak({ kind: "bonfire", message: "hi" })).via).toBe("being");
  });

  it("bonfire shows the server display name, matching fireside, instead of the being id", async () => {
    const f = fixture(async url => new URL(url).pathname === "/api/bonfire/mentions"
      ? json({ being: "alice", mentions: [] })
      : json({ ok: true, global_latest_seq: 1, messages: [{ seq: 1, being: "alice", speaker_name: "Alice", message: "hi", at: "2026-09-10T00:00:00Z" }] }));
    const session = readSession(f);
    const { messages } = await session.getBonfireMessages({ limit: 10 });
    expect(messages[0].beingName).toBe("Alice");
    expect(messages[0].beingId).toBe(""); expect(messages[0].authorUnknown).toBe(true);
  });

  it("reply metadata is carried on reads and sent on speak, and only for a real parent", async () => {
    const f = fixture(async url => new URL(url).pathname === "/api/bonfire/mentions"
      ? json({ being: "alice", mentions: [] })
      : json({ ok: true, global_latest_seq: 2, messages: [
        { seq: 1, being: "alice", message: "原帖", at: "2026-09-10T00:00:00Z" },
        { seq: 2, being: "bob", message: "回复", at: "2026-09-10T00:01:00Z", reply_to: 1, reply_to_being: "alice", reply_to_preview: "原帖" }] }));
    const session = readSession(f);
    const { messages } = await session.getBonfireMessages({ limit: 10 });
    expect(messages[0].replyTo).toBe(undefined);
    expect(messages[1].replyTo).toEqual({ id: "1", beingId: "alice", preview: "原帖" });

    const w = writeFixture(async () => json({ ok: true, seq: 3, being: "alice", mentions: [], via: "client:desk", reply_to: 1 }));
    await w.client.speak({ kind: "bonfire", message: "我也说一句", replyTo: "1" });
    expect(JSON.parse(w.calls[1].options.body as string)).toEqual({ message: "我也说一句", reply_to: 1 });
    await expect(w.client.speak({ kind: "bonfire", message: "x", replyTo: "abc" })).rejects.toMatchObject({ code: "NOT_SENT" });
  });

  it("inbox reads over the client token and keeps the order Town returned", async () => {
    const f = fixture(async url => new URL(url).pathname === "/api/bonfire/mentions" ? json({ being: "alice", mentions: [] }) : json({ messages: [
      { id: "m2", sender: "bob", sender_name: "Bob", recipient: "alice", content: "第二条", created_at: "2026-09-10T02:00:00Z", via: "client:phone" },
      { id: "m1", sender: "carol", recipient: "alice", content: "第一条", created_at: "2026-09-10T01:00:00Z", via: "being", reply_to: "m0", reply_to_sender: "alice", reply_to_preview: "更早" }] }));
    const session = readSession(f);
    const { messages } = await session.getDirectMessages();
    expect(messages.map(m => m.id)).toEqual(["m2", "m1"]);
    expect(messages[0].senderName).toBe("Bob");
    expect(messages[1].senderName).toBe("carol");
    // Who the letter was addressed to travels with it: a letter of mine is
    // answered to the other end, never to its sender, which would be me.
    expect(messages[0].recipientId).toBe("alice");
    expect(messages[0].via).toBe("client:phone");
    expect(messages[1].replyTo).toEqual({ id: "m0", beingId: "alice", preview: "更早" });
    expect(f.calls.at(-1)!.url.href).toBe("https://beings.town/api/messages");
    expect((f.calls.at(-1)!.options.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it("a private message to yourself is refused locally, before any request", async () => {
    const f = writeFixture(async () => json({ ok: true, message_id: "m9", recipient: "bob", via: "client:desk" }));
    await expect(f.client.sendDirectMessage({ recipient: "alice", content: "hi" })).rejects.toMatchObject({ code: "NOT_SENT" });
    expect(f.calls.length).toBe(0);
    const receipt = await f.client.sendDirectMessage({ recipient: "bob", content: "hi" });
    expect(receipt).toEqual({ ok: true, id: "m9", recipient: "bob", via: "client:desk" });
    expect(JSON.parse(f.calls[1].options.body as string)).toEqual({ recipient: "bob", content: "hi" });
  });
});
