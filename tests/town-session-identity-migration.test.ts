// Ported line by line from BeingDesktop 0.8.26 test/town-identity-migration.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style changes (node:test -> vitest).
// Measured behaviour: docs/town-sdk-integration.md "Town 身份迁移兼容（2026-09-13）" —
// a new town_id is bound only when the authenticated REST read and the SSE hello agree.
import { describe, expect, it } from "vitest";
import { TownClient } from "../desktop/main/town/session/client";
import { TownSession } from "../desktop/main/town/session/session";
import { beingsDto, scrollListDto } from "../desktop/main/town/session/library-contract";
import type { TownClientContext, TownClientEvent, TownCredentialStore } from "../desktop/main/town/session/types";

const token = "a".repeat(64), townId = "t_alice", otherId = "t_bob";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const tick = () => new Promise(resolve => setImmediate(resolve));

type FixtureOptions = {
  pinned?: string;
  identity?: Record<string, unknown> | (() => Promise<Record<string, unknown>>);
  hello?: Record<string, unknown>;
  respond?: (route: string, options: RequestInit) => unknown;
};

function fixture({ pinned = "", identity = { town_id: townId, mentions: [] }, hello = { town_id: townId, anonymous: false, token_kind: "client" }, respond }: FixtureOptions = {}) {
  let context: TownClientContext = { key: "loom-alice", beingId: "alice", revision: 1, connected: true };
  const calls: { route: string; method: string }[] = [], pins: string[] = [], events: TownClientEvent[] = [];
  const saved = { token, townId: pinned };
  const store: TownCredentialStore = {
    loadCredential: async () => ({ ...saved }),
    bindTownId: async (key, beingId, credential, id, current) => {
      expect(current()).toBe(true); expect(key).toBe(context.key); expect(beingId).toBe(context.beingId); expect(credential === token).toBe(true);
      pins.push(id); saved.townId = id;
    },
  };
  const client = new TownClient({
    getContext: () => context, store, onEvent: event => events.push(event),
    fetchImpl: (async (url: string, options: RequestInit) => {
      const route = new URL(url).pathname; calls.push({ route, method: options.method || "GET" });
      expect((options.headers as Record<string, string>).Authorization === `Bearer ${token}`).toBe(true);
      expect(new URL(url).searchParams.has("token")).toBe(false);
      if (route === "/api/bonfire/mentions") return json(typeof identity === "function" ? await identity() : identity);
      if (route === "/api/client/stream") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify(hello)}\n\nevent: bonfire\ndata: {"message":"not a trusted snapshot"}\n\n`));
        options.signal!.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } });
      } }), { headers: { "Content-Type": "text/event-stream" } });
      return json(respond ? respond(route, options) : { ok: true, town_id: townId, global_latest_seq: 1, messages: [] });
    }) as unknown as typeof fetch,
  });
  const session = new TownSession({
    getContext: () => ({ configured: true, connected: true, beingName: context.beingId, connectionId: context.revision as number }),
    readImpl: (route, options) => client.read(route, options),
    fetchImpl: (async () => json({ community: [{ town_id: otherId, display_name: "Bob" }] })) as unknown as typeof fetch,
  });
  return { client, session, calls, pins, events, saved, store, switch() { context = { ...context, key: "loom-bob", beingId: "bob", revision: 2 }; client.reset(); } };
}

describe("Town identity migration", () => {
  it("existing paired credential resolves a different Town namespace only after REST and SSE agree", async () => {
    const f = fixture();
    try {
      await f.client.read("/api/bonfire/hear");
      expect(f.pins).toEqual([townId]); expect(f.saved.token === token).toBe(true);
      expect(f.calls.map(call => call.route)).toEqual(["/api/bonfire/mentions", "/api/client/stream", "/api/bonfire/hear"]);
      expect(f.client.state().beingId).toBe("alice"); expect(JSON.stringify(f.client.state()).includes(token)).toBe(false);
      f.client.reset(); await f.client.read("/api/bonfire/hear");
      expect(f.pins.length).toBe(1); expect(f.calls.filter(call => call.route.endsWith("/stream")).length).toBe(1);
    } finally { f.client.reset(); }
  });

  it("SSE migration waits for REST verification before delivering the following events", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const f = fixture({ identity: () => new Promise<Record<string, unknown>>(done => { resolve = done; }) });
    try {
      f.client.lifecycle({ enabled: true }); await tick();
      expect(f.client.state().status).toBe("connecting"); expect(f.events).toEqual([]);
      resolve({ town_id: townId, mentions: [] }); await tick();
      expect(f.client.state().status).toBe("connected"); expect(f.events).toEqual([{ type: "hello" }, { type: "bonfire" }]);
      expect(f.pins).toEqual([townId]);
    } finally { f.client.reset(); }
  });

  it("disagreeing REST and SSE identities never pin, read protected history, or send", async () => {
    const f = fixture({ hello: { town_id: otherId, anonymous: false, token_kind: "client" } });
    try {
      await expect(f.client.speak({ kind: "bonfire", message: "fixture only" })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
      expect(f.pins).toEqual([]); expect(f.calls.some(call => call.method === "POST" || call.route.endsWith("/hear"))).toBe(false);
    } finally { f.client.reset(); }
  });

  it("a new SSE identity cannot be accepted against an unrelated legacy REST format", async () => {
    const f = fixture({ identity: { being: "alice", mentions: [] } });
    try {
      f.client.lifecycle({ enabled: true }); await tick();
      expect(f.client.state().status).toBe("identity_mismatch"); expect(f.pins).toEqual([]); expect(f.events).toEqual([]);
    } finally { f.client.reset(); }
  });

  it("a persisted Town identity cannot be replaced by a later credential response", async () => {
    const f = fixture({ pinned: townId, identity: { town_id: otherId, mentions: [] }, hello: { town_id: otherId, anonymous: false, token_kind: "client" } });
    try {
      await expect(f.client.read("/api/bonfire/hear")).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
      f.client.lifecycle({ enabled: true }); await tick();
      expect(f.client.state().status).toBe("identity_mismatch"); expect(f.events).toEqual([]); expect(f.pins).toEqual([]);
    } finally { f.client.reset(); }
  });

  it("missing identity is a protocol error, while conflicting legacy identity still blocks migration", async () => {
    for (const [identity, code] of [
      [{ mentions: [] }, "INVALID_RESPONSE"],
      [{ town_id: townId, being: "mallory", mentions: [] }, "IDENTITY_MISMATCH"],
      [{ town_id: null, being: "alice", mentions: [] }, "INVALID_RESPONSE"],
    ] as [Record<string, unknown>, string][]) {
      const f = fixture({ identity });
      try {
        await expect(f.client.read("/api/bonfire/hear")).rejects.toMatchObject({ code });
        expect(f.pins).toEqual([]); expect(f.calls.length).toBe(1);
      } finally { f.client.reset(); }
    }
  });

  it("Being switch during migration cannot bind or publish an old response", async () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const f = fixture({ identity: () => new Promise<Record<string, unknown>>(done => { resolve = done; }) });
    try {
      const pending = f.client.read("/api/bonfire/hear"); await tick(); f.switch(); resolve({ town_id: townId, mentions: [] });
      await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
      expect(f.pins).toEqual([]); expect(f.events).toEqual([]);
    } finally { f.client.reset(); }
  });

  it("storage failure preserves pairing and blocks migration without fetching history", async () => {
    const f = fixture();
    try {
      f.store.bindTownId = async () => { throw new Error("private storage diagnostic"); };
      await expect(f.client.read("/api/bonfire/hear")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
      expect(f.saved.townId).toBe(""); expect(f.saved.token === token).toBe(true);
      expect(f.calls.some(call => call.route.endsWith("/hear"))).toBe(false);
    } finally { f.client.reset(); }
  });

  it("Town message, reply, member, and inbox identities survive the full DTO pipeline", async () => {
    const f = fixture({ pinned: townId, respond: route => {
      if (route === "/api/fireside/members") return [{ town_id: otherId, display_name: "Bob", key: "hidden" }];
      if (route === "/api/messages") return { messages: [{ id: "dm1", sender_town_id: otherId, sender_display: "Bob", recipient_town_id: townId, content: "private fixture", reply_to: "dm0", reply_to_sender: townId, reply_to_preview: "earlier" }] };
      const messages = [{ seq: 1, town_id: otherId, speaker_name: "Bob", message: "fixture", reply_to: 0, reply_to_town_id: townId, reply_to_preview: "original" }];
      return { ok: true, town_id: townId, messages, global_latest_seq: 1, latest_seq: 1 };
    } });
    try {
      for (const result of [await f.session.getBonfireMessages(), await f.session.getFiresideMessages({ firesideId: 7 })]) {
        expect(result.messages.length).toBe(1); expect(result.messages[0].beingId).toBe(otherId);
        expect(result.messages[0].beingName).toBe("Bob"); expect(result.messages[0].replyTo!.beingId).toBe(townId);
      }
      const members = await f.session.getFiresideMembers(7);
      expect(members.members[0].being_id).toBe(otherId); expect(JSON.stringify(members).includes("hidden")).toBe(false);
      const inbox = await f.session.getDirectMessages();
      expect(inbox.messages[0].senderId).toBe(otherId); expect(inbox.messages[0].senderName).toBe("Bob");
      // The addressee migrates with the author: `recipient_town_id` reaches the DTO.
      expect(inbox.messages[0].recipientId).toBe(townId);
      expect((await f.session.getMembers()).members[0].id).toBe(otherId);
      expect((await f.session.listBeings()).beings[0].id).toBe(otherId);
    } finally { f.client.reset(); }
  });

  it("modern read envelopes cannot normalize away an authenticated identity mismatch", async () => {
    const f = fixture({ pinned: townId, respond: () => ({ town_id: otherId, ok: true, messages: [], global_latest_seq: 0 }) });
    try { await expect(f.session.getBonfireMessages()).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" }); }
    finally { f.client.reset(); }
  });

  it("modern send receipts keep unknown results distinct and never repeat a POST", async () => {
    let receiptId = townId;
    const f = fixture({ pinned: townId, respond: () => ({ ok: true, town_id: receiptId, seq: 1, mentions: [], via: "client:fixture" }) });
    try {
      expect((await f.client.speak({ kind: "bonfire", message: "fixture" })).ok).toBe(true);
      receiptId = otherId;
      await expect(f.client.speak({ kind: "bonfire", message: "second fixture" })).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
      expect(f.calls.filter(call => call.method === "POST").length).toBe(2);
      await expect(f.client.sendDirectMessage({ recipient: townId, content: "fixture" })).rejects.toMatchObject({ code: "NOT_SENT" });
      expect(f.calls.filter(call => call.method === "POST").length).toBe(2);
    } finally { f.client.reset(); }
  });

  it("public directories and scrolls use Town identities without leaking private fields", () => {
    expect(beingsDto([{ town_id: otherId, display_name: "Bob" }])[0].id).toBe(otherId);
    expect(() => beingsDto([{ town_id: null, being_id: "bob", display_name: "Bob" }])).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
    const value = scrollListDto({ scrolls: [{ id: "note1", title: "Fixture", town_id: otherId, display_name: "Bob", visibility: "private", revision: 1, share_token: "private" }], total: 1, offset: 0, limit: 1 }, { limit: 1 });
    expect(value.scrolls[0].beingId).toBe(otherId); expect(Object.hasOwn(value.scrolls[0], "share_token")).toBe(false);
  });
});
