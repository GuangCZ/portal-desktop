// Ported line by line from BeingDesktop 0.8.26 test/town-session.test.cjs on 2026-09-16.
// Fixtures are copied verbatim; only the assertion style changes (node:test -> vitest).
import { describe, expect, it } from "vitest";
import { TOWN_AUTH_DETAIL, TownSession } from "../desktop/main/town/session/session";
import type { TownMessagePage, TownReadImpl } from "../desktop/main/town/session/types";

type Call = { url: URL; options: RequestInit };
type Overrides = {
  readImpl?: TownReadImpl;
  request?: (url: URL, options: RequestInit, calls: Call[]) => Response | Promise<Response> | undefined;
  /** The deadline on the shared public-directory read. Production uses 20 s; a
   * test that wants to watch it expire says so here. */
  membersReadTimeoutMs?: number;
};

function deferred<T = unknown>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function harness(overrides: Overrides = {}) {
  const context: Record<string, unknown> = { configured: true, connected: true, connectionId: 5, identityRevision: 1, beingName: "alice", token: "LOOM_SECRET_MUST_STAY_LOCAL" };
  const calls: Call[] = [];
  const session = new TownSession({
    getContext: () => ({ ...context }), readImpl: overrides.readImpl ?? null,
    ...(overrides.membersReadTimeoutMs === undefined ? {} : { membersReadTimeoutMs: overrides.membersReadTimeoutMs }),
    fetchImpl: (async (url: string, options: RequestInit) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, options });
      if (overrides.request) { const result = await overrides.request(parsed, options, calls); if (result !== undefined) return result; }
      if (parsed.pathname === "/api") return json({ community: [{ being_id: "alice", display_name: "Alice", about: null }, { being_id: "echo", display_name: "Echo", about: "A resident" }] });
      if (parsed.pathname === "/api/bonfire/mentions") return json({ being: "alice", mentions: [], latest_id: 0 });
      if (parsed.pathname === "/api/bonfire/hear") return json({ ok: true, global_latest_seq: 4, messages: [{ seq: 4, being: "Echo", message: "Hello", at: "2026-09-07T12:00:00+08:00", revised_at: null }] });
      if (parsed.pathname === "/api/bonfire/speak") return json({ ok: true, seq: 5, being: "alice", mentions: ["Echo"] });
      if (parsed.pathname === "/api/fireside/list") return json({ owned: [{ id: 7, name: "Our ring", member_count: 2, key: "PRIVATE_INVITE_KEY" }], joined: [{ id: 9, name: "Another ring", member_count: 3 }] });
      if (parsed.pathname === "/api/fireside/members") return json([{ being_id: "alice", display_name: "Alice", joined_at: "2026-09-07T12:00:00+08:00" }, { being_id: "echo", display_name: "Echo", joined_at: null }]);
      if (parsed.pathname === "/api/fireside/hear") return json({ being: "alice", latest_seq: 8, messages: [{ seq: 8, being: "echo", speaker_name: "Echo", message: "Welcome", at: "2026-09-07T12:00:00+08:00", revised_at: null, mentions: ["alice"] }] });
      if (parsed.pathname === "/api/channels/status") return json({ channels: [{ channel: "feishu", status: "connected", app_id: "cli_example", app_secret: "SHOULD_NOT_LEAK" }, { channel: "wechat", status: "pending" }] });
      if (parsed.pathname === "/api/channels/register") return json({ ok: true, status: "pending", qr_code_url: "https://weixin.qq.com/q/fixture" });
      if (parsed.pathname === "/api/channels/credentials") return json({ ok: true, app_secret: "SHOULD_NOT_LEAK" });
      throw new Error("Unexpected endpoint");
    }) as unknown as typeof fetch,
  });
  return { session, context, calls };
}

const scrollSummary = (changes: Record<string, unknown> = {}) => ({ id: "wer79LxF", being_id: "alice", display_name: "Alice", title: "A document", visibility: "private", created_at: "2026-09-07T00:00:00Z", updated_at: "2026-09-07T01:00:00Z", kind: "note", lifecycle: "seed", tags: ["notes"], revision: 2, share_token: "PRIVATE_SHARE_TOKEN", ...changes });

// TownRefresh (src/town-refresh.cjs) belongs to another migration unit. This stand-in
// keeps the surface the fixture below drives — start / refresh / snapshot / status /
// stop with the same injected readSnapshot, getIdentity and clock — so the Session
// contract it consumes (full fireside text, bonfire capped at 4000) is still asserted.
function fakeRefresh(options: {
  getIdentity: () => { beingId: string; connectionRevision: number; identityRevision: number };
  readSnapshot: (input: { signal?: AbortSignal; limit: number }) => Promise<TownMessagePage>;
  clock: { now: () => number; setTimeout: () => { unref(): void }; clearTimeout: () => void };
  limit?: number;
}) {
  let current: TownMessagePage = { messages: [], latestSeq: 0 };
  let errorCode = "";
  let running = false;
  return {
    start() { running = true; options.getIdentity(); options.clock.now(); },
    stop() { running = false; options.clock.clearTimeout(); },
    async refresh(): Promise<TownMessagePage> {
      try { current = await options.readSnapshot({ limit: options.limit ?? 50 }); errorCode = ""; }
      catch (error) { errorCode = (error as { code?: string }).code ?? "NETWORK_ERROR"; throw error; }
      return current;
    },
    snapshot: () => current,
    status: () => ({ stale: !running, errorCode }),
  };
}

describe("Town session (direct reads, writes and channels)", () => {
  it("public member directory uses homepage without credentials and filters malformed IDs", async () => {
    const { session, context, calls } = harness({ request: url => url.pathname === "/api" ? json({ community: [{ being_id: "echo", display_name: "Echo" }, { being_id: "../secret", display_name: "Invalid" }, { being_id: "echo", display_name: "Duplicate" }] }) : undefined });
    context.connected = false;
    expect(await session.getMembers()).toEqual({ members: [{ id: "echo", name: "Echo", description: "" }], source: "public" });
    expect(calls.length).toBe(1);
    expect(calls[0].url.href).toBe("https://beings.town/api");
    expect(calls[0].options.credentials).toBe("omit");
    expect(calls[0].options.redirect).toBe("error");
    expect(JSON.stringify(calls).includes(context.token as string)).toBe(false);
  });

  it("untrusted Town network reports auth_required without sending a message", async () => {
    const { session, calls } = harness({ request: url => url.pathname === "/api/bonfire/mentions" ? json({ error: "private upstream detail" }, 401) : undefined });
    await expect(session.sendBonfireMessage({ content: "Hi", mentions: ["echo"], connectionRevision: 5 })).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: TOWN_AUTH_DETAIL });
    expect(calls.length).toBe(1);
    expect(session.state().bonfire.status).toBe("auth_required");
  });

  it("IP Trust identity must match the selected Loom identity", async () => {
    const { session, calls } = harness({ request: url => url.pathname === "/api/bonfire/mentions" ? json({ being: "somebody-else", mentions: [] }) : undefined });
    await expect(session.beginChannelConnection({ channel: "wechat", connectionRevision: 5 })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(calls.length).toBe(1);
    expect(session.state().channel.status).toBe("error");
  });

  it("Bonfire reads use documented since and limit and normalize full messages", async () => {
    const { session, calls } = harness();
    const result = await session.getBonfireMessages({ since: 3, limit: 20 });
    expect(result.messages[0]).toEqual({ id: "4", beingId: "", authorUnknown: true, beingName: "Echo", content: "Hello", createdAt: "2026-09-07T12:00:00+08:00", revisedAt: "", mentions: [] });
    expect(result.latestSeq).toBe(4);
    expect(calls[0].url.searchParams.get("since_id")).toBe("9223372036854775807");
    // Addressed by route rather than by position: the member directory is now
    // started alongside the feed read (IT, 2026-09-17) and may land in `calls`
    // on either side of it. Every parameter this case asserted still is.
    const hear = calls.find(call => call.url.pathname === "/api/bonfire/hear");
    expect(hear?.url.searchParams.get("since")).toBe("3");
    expect(hear?.url.searchParams.get("limit")).toBe("20");
  });

  // The TownRefresh accumulator is migrated by a separate unit; this case keeps the
  // Session contract it depends on (full 32000-character fireside text, bonfire capped
  // at 4000) and drives it through a stand-in refresher with the same shape.
  it("Session to Refresh preserves a complete 32000-character Fireside message and Bonfire keeps its 4000 limit", async () => {
    const content = "围".repeat(31993) + "THE_END";
    for (const kind of ["fireside", "bonfire"]) {
      const { session } = harness({ readImpl: async route => {
        expect(route).toBe(`/api/${kind}/hear`);
        return { ok: true, being: "alice", latest_seq: 8, global_latest_seq: 8, messages: [{ seq: 8, being: "echo", speaker_name: "Echo", message: content, at: "2026-09-07T12:00:00+08:00" }] };
      } });
      const reader = fakeRefresh({
        getIdentity: () => ({ beingId: "alice", connectionRevision: 5, identityRevision: 1 }),
        readSnapshot: ({ signal, limit }) => kind === "fireside"
          ? session.getFiresideMessages({ firesideId: 7, limit }, { signal })
          : session.getBonfireMessages({ limit }, { signal }),
        clock: { now: () => 1000, setTimeout: () => ({ unref() {} }), clearTimeout() {} },
      });
      try {
        reader.start();
        const snapshot = await reader.refresh();
        const expected = kind === "fireside" ? content : content.slice(0, 4000);
        expect(snapshot.messages[0].content).toBe(expected);
        expect(reader.snapshot().messages[0].content).toBe(expected);
        expect(snapshot.latestSeq).toBe(8);
        expect(reader.status().stale).toBe(false);
        expect(reader.status().errorCode).toBe("");
      } finally { reader.stop(); }
    }
  });

  it("only explicit Bonfire submit sends, with each selected member represented once", async () => {
    const { session, calls, context } = harness();
    await session.getMembers();
    await session.getBonfireMessages();
    expect(calls.filter(call => call.options.method === "POST").length).toBe(0);
    const result = await session.sendBonfireMessage({ content: "@echo hello", mentions: ["echo", "echo"], connectionRevision: 5 });
    expect(result).toEqual({ ok: true, id: "5", mentions: ["Echo"] });
    const write = calls.find(call => call.options.method === "POST")!;
    expect(JSON.parse(write.options.body as string)).toEqual({ message: "@echo hello" });
    expect(write.url.pathname).toBe("/api/bonfire/speak");
    expect(JSON.stringify(calls).includes(context.token as string)).toBe(false);
  });

  it("mentions are verified from the real directory and added without substring confusion", async () => {
    const { session, calls } = harness();
    await session.sendBonfireMessage({ content: "@echo-extra hello", mentions: ["echo"], connectionRevision: 5 });
    expect(JSON.parse(calls.at(-1)!.options.body as string).message).toBe("@echo\n@echo-extra hello");
    await expect(session.sendBonfireMessage({ content: "Hello", mentions: ["invented-being"], connectionRevision: 5 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls.filter(call => call.options.method === "POST").length).toBe(1);
  });

  it("stale revision is rejected before any network request", async () => {
    const { session, calls } = harness();
    await expect(session.sendBonfireMessage({ content: "Hi", mentions: [], connectionRevision: 4 })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await expect(session.updateFeishuCredentials({ appId: "cli_fixture", appSecret: "secret", connectionRevision: 4 })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(calls.length).toBe(0);
  });

  it("connection switch during authorization cannot send or repopulate state", async () => {
    const gate = deferred<Response>();
    const { session, calls, context } = harness({ request: url => url.pathname === "/api/bonfire/mentions" ? gate.promise : undefined });
    const sending = session.sendBonfireMessage({ content: "Hi", mentions: [], connectionRevision: 5 });
    context.connectionId = (context.connectionId as number) + 1;
    session.reset();
    gate.resolve(json({ being: "alice", mentions: [] }));
    await expect(sending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(calls.length).toBe(1);
    expect(session.state().bonfire.status).toBe("unknown");
  });

  it("uncertain send is never retried and duplicate in-flight writes are rejected", async () => {
    const gate = deferred<Response>();
    const started = deferred<void>();
    const { session, calls } = harness({ request: url => {
      if (url.pathname === "/api/bonfire/speak") { started.resolve(); return gate.promise; }
      return undefined;
    } });
    const value = { content: "Hello", mentions: [], connectionRevision: 5 };
    const sending = session.sendBonfireMessage(value);
    await started.promise;
    await expect(session.sendBonfireMessage(value)).rejects.toMatchObject({ code: "BUSY" });
    gate.resolve(new Response("lost", { status: 502 }));
    await expect(sending).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(calls.filter(call => call.options.method === "POST").length).toBe(1);
  });

  it("channel fixed flow uses documented bodies and never returns submitted secrets", async () => {
    const { session, calls } = harness();
    const started = await session.beginChannelConnection({ channel: "wechat", connectionRevision: 5 });
    expect(started.qrCodeUrl).toBe("https://weixin.qq.com/q/fixture");
    expect(JSON.parse(calls.find(call => call.url.pathname === "/api/channels/register")!.options.body as string)).toEqual({ channel: "wechat", being_id: "alice" });
    const saved = await session.updateFeishuCredentials({ appId: "cli_fixture", appSecret: "PRIVATE_APP_SECRET", connectionRevision: 5 });
    expect(JSON.parse(calls.at(-1)!.options.body as string)).toEqual({ channel: "feishu", app_id: "cli_fixture", app_secret: "PRIVATE_APP_SECRET" });
    expect(saved.status).toBe("pending");
    const state = await session.getChannelStatus();
    expect(state.channels[0].status).toBe("connected");
    expect(JSON.stringify({ saved, state, session: session.state() }).includes("SECRET")).toBe(false);
    expect(JSON.stringify(state).includes("SHOULD_NOT_LEAK")).toBe(false);
  });

  it("channel unknown status stays unknown and untrusted QR links never reach UI", async () => {
    const { session } = harness({ request: url => url.pathname === "/api/channels/register" ? json({ ok: true, message: "app_secret=DO_NOT_SHOW", qr_code_url: "https://attacker.invalid/qr", status: "magic-success" }) : undefined });
    const result = await session.beginChannelConnection({ channel: "wechat", connectionRevision: 5 });
    expect(result.status).toBe("unknown");
    expect(result.qrCodeUrl).toBe(undefined);
    expect(JSON.stringify(result).includes("DO_NOT_SHOW")).toBe(false);
  });

  it("verified QR images are proxied as bounded data images without renderer network access", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPwAAAAASUVORK5CYII=";
    const { session, calls } = harness({ request: url => url.hostname === "weixin.qq.com" ? new Response(Buffer.from(png, "base64"), { headers: { "Content-Type": "image/png" } }) : undefined });
    const result = await session.beginChannelConnection({ channel: "wechat", connectionRevision: 5 });
    expect(result.qrCodeDataUrl).toBe(`data:image/png;base64,${png}`);
    expect(calls.at(-1)!.options.credentials).toBe("omit");
    expect(calls.at(-1)!.options.redirect).toBe("error");
    expect(calls.at(-1)!.options.body).toBe(undefined);
    expect(calls.filter(call => call.options.method === "POST").length).toBe(1);
  });

  it("inline SVG and malformed raster QR responses never become renderable data", async () => {
    const { session } = harness({ request: url => url.pathname === "/api/channels/register" ? json({ ok: true, qr_code: "data:image/svg+xml;base64,PHN2Zy8+" }) : undefined });
    const result = await session.beginChannelConnection({ channel: "wechat", connectionRevision: 5 });
    expect(result.qrCodeDataUrl).toBe(undefined);
    const raster = harness({ request: url => url.hostname === "weixin.qq.com" ? new Response("<script/>", { headers: { "Content-Type": "image/png" } }) : undefined });
    const invalid = await raster.session.beginChannelConnection({ channel: "wechat", connectionRevision: 5 });
    expect(invalid.qrCodeDataUrl).toBe("");
    expect(invalid.detail).toMatch(/扫码图像暂时无法读取/);
  });

  it("oversized or HTML responses fail closed", async () => {
    const large = harness({ request: () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(1024 * 1024 + 1) } }) });
    await expect(large.session.getMembers()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const html = harness({ request: () => new Response("<html>Login</html>", { headers: { "Content-Type": "text/html" } }) });
    await expect(html.session.getMembers()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("invalid and accessor requests are rejected without invoking getters or the network", async () => {
    const { session, calls } = harness();
    let invoked = false;
    await expect(session.sendBonfireMessage({ get content() { invoked = true; return "bad"; }, mentions: [], connectionRevision: 5 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.getBonfireMessages({ since: -1 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.beginChannelConnection({ channel: "other", connectionRevision: 5 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.updateFeishuCredentials({ appId: "cli_fixture", appSecret: "line\nbreak", connectionRevision: 5 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(invoked).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("Fireside list and members keep display data while stripping invite keys and extra fields", async () => {
    const { session, calls, context } = harness({ request: url => {
      if (url.pathname === "/api/fireside/list") return json({ owned: [{ id: 7, name: "Our  ring", member_count: 2, key: "PRIVATE_INVITE_KEY" }, { id: "../bad", name: "Invalid" }], joined: [{ id: 7, name: "Duplicate" }, { id: 9, name: "Another ring", secret: "PRIVATE_SECRET" }] });
      if (url.pathname === "/api/fireside/members") return json([{ being_id: "alice", display_name: "Alice", joined_at: "2026-09-07", secret: "PRIVATE_SECRET" }, { being_id: "alice", display_name: "Duplicate" }, { being_id: "../bad" }, { being_id: "echo", display_name: "Echo‮" }]);
      return undefined;
    } });
    const rooms = await session.getFiresides();
    expect(rooms).toEqual({ owned: [{ id: 7, name: "Our ring", member_count: 2 }], joined: [{ id: 9, name: "Another ring" }] });
    const members = await session.getFiresideMembers("7");
    expect(members).toEqual({ members: [{ being_id: "alice", display_name: "Alice", joined_at: "2026-09-07" }, { being_id: "echo", display_name: "Echo", joined_at: "" }] });
    expect(calls.at(-1)!.url.href).toBe("https://beings.town/api/fireside/members?fireside_id=7");
    expect(session.state().fireside.status).toBe("ready");
    expect(calls.every(call => call.options.method === "GET" && call.options.credentials === "omit" && !call.url.searchParams.has("token"))).toBe(true);
    expect(JSON.stringify({ rooms, members, calls }).includes(context.token as string)).toBe(false);
    expect(JSON.stringify({ rooms, members }).includes("PRIVATE")).toBe(false);
  });

  it("Fireside hear validates identity and normalizes complete ordered snapshots", async () => {
    const { session, calls } = harness({ request: url => url.pathname === "/api/fireside/hear" ? json({ being: "alice", latest_seq: 8, messages: [
      { seq: 8, being: "echo", speaker_name: "Echo", message: "Welcome ", at: "2026-09-07", revised_at: "2026-09-08", mentions: ["alice", "alice", "../bad"], key: "SECRET" },
      { seq: 6, being: "alice", message: "Earlier", mentions: [] },
      { seq: 8, being: "echo", message: "Duplicate" },
      { seq: -1, being: "echo", message: "Invalid" },
    ] }) : undefined });
    const result = await session.getFiresideMessages({ firesideId: "7" });
    expect(result).toEqual({ messages: [
      { id: "6", beingId: "alice", beingName: "alice", content: "Earlier", createdAt: "", revisedAt: "", mentions: [] },
      { id: "8", beingId: "echo", beingName: "Echo", content: "Welcome", createdAt: "2026-09-07", revisedAt: "2026-09-08", mentions: ["alice"] },
    ], latestSeq: 8 });
    expect(calls[1].url.href).toBe("https://beings.town/api/fireside/hear?fireside_id=7&limit=10");
    expect(calls[1].options.body).toBe(undefined);
    await session.getFiresideMessages({ firesideId: 7, since: 6, limit: 20 });
    expect(calls.at(-1)!.url.searchParams.get("since")).toBe("6");
    expect(calls.at(-1)!.url.searchParams.get("limit")).toBe("20");
  });

  it("Fireside reads keep real authorization errors and never fall back to chat or callback", async () => {
    for (const status of [401, 403]) {
      const { session, calls } = harness({ request: url => url.pathname === "/api/bonfire/mentions" ? json({ error: "private detail" }, status) : undefined });
      await expect(session.getFiresides()).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: TOWN_AUTH_DETAIL });
      await expect(session.getFiresideMembers("7")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(session.getFiresideMessages({ firesideId: "7" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(session.state().fireside.status).toBe("auth_required");
      expect(calls.length).toBe(3);
      expect(calls.every(call => call.url.pathname === "/api/bonfire/mentions" && call.options.method === "GET")).toBe(true);
    }
    const wrong = harness({ request: url => url.pathname === "/api/fireside/hear" ? json({ being: "another-being", latest_seq: 8, messages: [] }) : undefined });
    await expect(wrong.session.getFiresideMessages({ firesideId: 7 })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(wrong.session.state().fireside.status).toBe("error");
  });

  it("Fireside rejects malformed, truncated and wrapped member responses", async () => {
    const cases: [string, unknown, (session: TownSession) => Promise<unknown>][] = [
      ["/api/fireside/list", { owned: [], joined: "bad" }, session => session.getFiresides()],
      ["/api/fireside/members", { members: [] }, session => session.getFiresideMembers(7)],
      ["/api/fireside/hear", { being: "alice", latest_seq: "8", messages: [] }, session => session.getFiresideMessages({ firesideId: 7 })],
      ["/api/fireside/hear", { being: "alice", latest_seq: 8, messages: [{ seq: 8, being: "echo", message: "Partial", truncated: true }] }, session => session.getFiresideMessages({ firesideId: 7 })],
    ];
    for (const [route, response, read] of cases) {
      const { session } = harness({ request: url => url.pathname === route ? json(response) : undefined });
      await expect(read(session)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("room identifiers and signal properties cannot enter renderer-controlled request JSON", async () => {
    const { session, calls } = harness();
    for (const id of [0, -1, 1.5, "../7", "07", "7?token=x", "9007199254740992", { id: 7 }]) {
      await expect(session.getFiresideMembers(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(session.getFiresideMessages({ firesideId: id })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(session.getFiresides({ signal: {} })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.getBonfireMessages({ signal: {} })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.getFiresideMessages({ firesideId: 7, signal: {} })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.getFiresideMessages({ firesideId: 7, limit: 201 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls.length).toBe(0);
  });

  it("a cancelled background read never starts network requests or changes state", async () => {
    const { session, calls } = harness();
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal };
    await expect(session.getBonfireMessages({}, options)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(session.getFiresides({}, options)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(session.getFiresideMembers(7, options)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(session.getFiresideMessages({ firesideId: 7 }, options)).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls.length).toBe(0);
    expect(session.state().bonfire.status).toBe("unknown");
    expect(session.state().fireside.status).toBe("unknown");
  });

  it("cancelling authorization aborts the request and never advances to hear", async () => {
    const started = deferred<void>();
    const controller = new AbortController();
    const { session, calls } = harness({ request: (url, options) => {
      if (url.pathname === "/api/bonfire/mentions") return new Promise<Response>((resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        started.resolve();
      });
      return undefined;
    } });
    const reading = session.getBonfireMessages({}, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls.length).toBe(1);
    expect(calls[0].options.signal!.aborted).toBe(true);
    expect(session.state().bonfire.status).toBe("unknown");
    expect(session._requests.size).toBe(0);
  });

  it("cancelling a hear body stops its stream without a service error or cached partial result", async () => {
    const started = deferred<void>();
    const controller = new AbortController();
    const { session, calls } = harness({ request: (url, options) => {
      if (url.pathname === "/api/fireside/hear") return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new TextEncoder().encode("{\"being\":\"alice\","));
        options.signal!.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), { once: true });
        started.resolve();
      } }), { headers: { "Content-Type": "application/json" } });
      return undefined;
    } });
    const reading = session.getFiresideMessages({ firesideId: "7" }, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls.at(-1)!.options.signal!.aborted).toBe(true);
    expect(session.state().fireside.status).toBe("ready");
    expect(session._requests.size).toBe(0);
  });

  it("identity reset during a Fireside read rejects late responses and preserves reset state", async () => {
    const gate = deferred<Response>();
    const started = deferred<void>();
    const { session, calls, context } = harness({ request: url => {
      if (url.pathname === "/api/fireside/hear") { started.resolve(); return gate.promise; }
      return undefined;
    } });
    const reading = session.getFiresideMessages({ firesideId: 7 });
    await started.promise;
    context.connectionId = (context.connectionId as number) + 1;
    session.reset();
    gate.resolve(json({ being: "alice", latest_seq: 8, messages: [] }));
    await expect(reading).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(calls.at(-1)!.options.signal!.aborted).toBe(true);
    expect(session.state().fireside.status).toBe("unknown");
  });

  it("Heart reads bypass the desktop IP Trust probe and retain the Town message contract", async () => {
    const reads: { route: string; options: { query?: Record<string, unknown> } }[] = [];
    const { session, calls } = harness({ readImpl: async (route, options) => {
      reads.push({ route, options });
      return { ok: true, global_latest_seq: 9, messages: [{ seq: 9, being: "echo", message: "From Heart" }] };
    } });
    const result = await session.getBonfireMessages({ limit: 20, since: 7 });
    expect(result.messages[0].content).toBe("From Heart");
    expect(reads.map(read => read.route)).toEqual(["/api/bonfire/hear"]);
    expect(reads[0].options.query).toEqual({ limit: 20, since: 7 });
    expect(calls.map(call => call.url.pathname)).toEqual(["/api"]);
    expect(session.state().bonfire.status).toBe("ready");
  });

  it("an unavailable Heart reader never falls back to a protected desktop Town request", async () => {
    const { session, calls } = harness({ readImpl: async () => { throw Object.assign(new Error("Heart reader is not deployed"), { code: "BACKGROUND_UNAVAILABLE" }); } });
    await expect(session.getFiresides()).rejects.toMatchObject({ code: "BACKGROUND_UNAVAILABLE" });
    expect(calls.length).toBe(0);
    expect(session.state().fireside.status).toBe("error");
  });

  it("reset aborts Heart requests and cannot publish a late private room response", async () => {
    const gate = deferred<unknown>(), started = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const { session, context, calls } = harness({ readImpl: async (_route, options) => {
      requestSignal = options.signal; started.resolve(); return gate.promise;
    } });
    const reading = session.getFiresideMessages({ firesideId: "7" });
    await started.promise;
    context.connectionId = (context.connectionId as number) + 1;
    session.reset();
    expect(requestSignal!.aborted).toBe(true);
    gate.resolve({ being: "alice", latest_seq: 0, messages: [] });
    await expect(reading).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(calls.length).toBe(0);
    expect(session.state().fireside.status).toBe("unknown");
    expect(session._requests.size).toBe(0);
  });

  it("cancelling the native scheduler cancels its Heart read without changing access state", async () => {
    const started = deferred<void>();
    const controller = new AbortController();
    const { session } = harness({ readImpl: (_route, options) => new Promise<unknown>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      started.resolve();
    }) });
    const reading = session.getFiresides({}, { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "ABORTED" });
    expect(session.state().fireside.status).toBe("unknown");
    expect(session._requests.size).toBe(0);
  });

  it("adding a read-only Heart transport cannot move writes or channel settings into it", async () => {
    let reads = 0;
    const { session, calls } = harness({ readImpl: async () => { reads++; throw new Error("Unexpected bridge call"); } });
    await session.sendBonfireMessage({ content: "Explicit fixture send", mentions: [], connectionRevision: 5 });
    await session.getChannelStatus();
    expect(reads).toBe(0);
    expect(calls.filter(call => call.options.method === "POST").length).toBe(1);
    expect(calls.some(call => call.url.pathname === "/api/channels/status")).toBe(true);
  });

  it("Scroll browsing uses authenticated read routes and keeps only display fields", async () => {
    const reads: { route: string; query?: Record<string, unknown> }[] = [];
    const { session, calls } = harness({ readImpl: async (route, options) => {
      reads.push({ route, query: options.query });
      return route === "/api/scrolls"
        ? { scrolls: [scrollSummary(), scrollSummary({ id: "another-note" })], total: 8, offset: 2, limit: 2 }
        : scrollSummary({ content: "🧭A", total_length: 3, offset: 0, limit: 2, has_more: true, source_context: "INTERNAL_CONTEXT" });
    } });
    const list = await session.listScrolls({ offset: 2, limit: 2, visibility: "private" });
    expect(list.scrolls[0].beingId).toBe("alice");
    expect(list.scrolls[0].beingName).toBe("Alice");
    expect(list.hasMore).toBe(true);
    const detail = await session.getScroll({ id: "wer79LxF", limit: 2 });
    expect(detail.scroll.content).toBe("🧭A");
    expect(detail.scroll.totalLength).toBe(3);
    expect(detail.scroll.nextOffset).toBe(2);
    expect(detail.scroll.hasMore).toBe(true);
    expect(reads).toEqual([
      { route: "/api/scrolls", query: { offset: 2, limit: 2, visibility: "private" } },
      { route: "/api/scrolls/wer79LxF", query: { offset: 0, limit: 2 } },
    ]);
    expect(calls.length).toBe(0);
    expect(session.state().scroll.status).toBe("ready");
    expect(JSON.stringify({ list, detail }).includes("PRIVATE_SHARE_TOKEN")).toBe(false);
    expect(JSON.stringify(detail).includes("INTERNAL_CONTEXT")).toBe(false);
  });

  it("Scroll malformed metadata, duplicate entries and incomplete content cannot become documents", async () => {
    const cases: [unknown, (session: TownSession) => Promise<unknown>][] = [
      [{ scrolls: [scrollSummary()], total: 1, offset: 1, limit: 50 }, session => session.listScrolls()],
      [{ scrolls: [scrollSummary(), scrollSummary()], total: 2, offset: 0, limit: 50 }, session => session.listScrolls()],
      [{ scrolls: [], total: 1, offset: 0, limit: 50 }, session => session.listScrolls()],
      [{ scrolls: [scrollSummary({ being_id: undefined })], total: 1, offset: 0, limit: 50 }, session => session.listScrolls()],
      [scrollSummary({ id: "another", content: "", total_length: 0, offset: 0, limit: 10000, has_more: false }), session => session.getScroll({ id: "wer79LxF" })],
      [scrollSummary({ content: "Partial", total_length: 999, offset: 0, limit: 10000, has_more: false }), session => session.getScroll({ id: "wer79LxF" })],
      [scrollSummary({ content: "Partial", total_length: 20000, offset: 0, limit: 10000, has_more: true }), session => session.getScroll({ id: "wer79LxF" })],
    ];
    for (const [raw, read] of cases) {
      const { session } = harness({ readImpl: async () => raw });
      await expect(read(session)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("Scroll request capabilities, reserved routes and invalid pagination never reach a transport", async () => {
    let count = 0;
    const { session, calls } = harness({ readImpl: async () => { count++; return undefined; } });
    for (const id of ["../private", "help", "search", "graph", "match", "a?token=x", "", 7]) await expect(session.getScroll({ id })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const value of [{ offset: -1 }, { offset: 4294967296 }, { limit: 201 }, { limit: "50" }, { visibility: "all" }, { token: "secret" }, { signal: {} }]) await expect(session.listScrolls(value)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.getScroll({ id: "wer79LxF", limit: 10001 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.getScroll({ get id(): string { throw new Error("Getter ran"); } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(session.listBeings({ headers: {} })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(count).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("a connection switch discards a private Scroll response and clears its access state", async () => {
    const started = deferred<void>(), gate = deferred<unknown>();
    const { session, context } = harness({ readImpl: async () => { started.resolve(); return gate.promise; } });
    const pending = session.getScroll({ id: "wer79LxF" });
    await started.promise;
    context.connectionId = (context.connectionId as number) + 1;
    session.reset();
    gate.resolve(scrollSummary({ content: "Old private document", total_length: 20, offset: 0, limit: 10000, has_more: false }));
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(session.state().scroll.status).toBe("unknown");
  });

  it("directory data never infers a human relationship from IDs or unsupported response fields", async () => {
    const { session, calls } = harness({ request: url => url.pathname === "/api" ? json({ community: [{ being_id: "alice", display_name: "Alice", about: "A resident", human_name: "Unsupported", token: "SECRET" }] }) : undefined });
    const result = await session.listBeings({});
    expect(result.beings).toEqual([{ id: "alice", name: "Alice", description: "A resident", status: "", human: null }]);
    expect(result.source).toBe("public");
    expect(result.detail).toMatch(/人类伙伴信息暂未公开/);
    expect(calls.length).toBe(1);
    expect(JSON.stringify(result).includes("SECRET")).toBe(false);
    expect(JSON.stringify(result).includes("Unsupported")).toBe(false);
  });

  it("periodic directory reads show all public residents without occupying the Being conversation", async () => {
    let protectedReads = 0;
    const { session, calls, context } = harness({ readImpl: async () => { protectedReads++; throw new Error("Must not occupy Being"); } });
    for (let refresh = 0; refresh < 2; refresh++) {
      const result = await session.listBeings();
      expect(result.source).toBe("public");
      expect(result.beings.map(being => being.id)).toEqual(["alice", "echo"]);
      expect(result.beings.every(being => being.human === null && being.status === "")).toBe(true);
      expect(session.state().beings.status).toBe("ready");
    }
    expect(calls.map(call => call.url.pathname)).toEqual(["/api", "/api"]);
    expect(protectedReads).toBe(0);
    context.connected = false;
    expect((await session.listBeings()).beings.length).toBe(2);
  });

  it("public directory rejects stale identity and malformed partial records", async () => {
    const gate = deferred<Response>(), started = deferred<void>();
    const { session, context } = harness({ readImpl: async () => { throw Object.assign(new Error("busy"), { code: "BUSY" }); }, request: url => {
      if (url.pathname === "/api") { started.resolve(); return gate.promise; }
      return undefined;
    } });
    const pending = session.listBeings();
    await started.promise;
    context.identityRevision = (context.identityRevision as number) + 1;
    gate.resolve(json({ community: [{ being_id: "alice", display_name: "Alice" }] }));
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    const invalid = harness({ readImpl: async () => ({}), request: url => url.pathname === "/api" ? json({ community: [{ being_id: "../bad", display_name: "Bad" }] }) : undefined });
    await expect(invalid.session.listBeings()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("cancelled library reads cannot start requests or publish access state", async () => {
    const { session, calls } = harness();
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal };
    await expect(session.listScrolls({}, options)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(session.getScroll({ id: "wer79LxF" }, options)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(session.listBeings({}, options)).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls.length).toBe(0);
    expect(session.state().scroll.status).toBe("unknown");
    expect(session.state().beings.status).toBe("unknown");
  });

  // ── the member directory never holds up the messages (IT, 2026-09-17) ──────
  //
  // BeingDesktop src/town-session.cjs:335-336 puts `/api/bonfire/hear` and
  // `getMembers()` in one `Promise.all`. Its `.catch` handles a directory that
  // REFUSES and cannot handle one that is merely slow, so the feed stayed empty
  // for as long as the directory took (packaged evidence: tests/town-ui.mjs
  // 「messages render while the member directory is still pending」).
  // The rule BeingDesktop keeps is one layer up, in renderer/town-app.js:1607
  // (`loadBonfire` = two independent loads) and :1581 (`loadBonfireMembers`
  // paints from the cache first, re-renders when the fresh directory lands).
  it("a pending member directory does not hold up the bonfire messages", async () => {
    const held = deferred<Response>();
    const { session, calls } = harness({ request: url => url.pathname === "/api" ? held.promise : undefined });
    const started = Date.now();
    const page = await session.getBonfireMessages({ limit: 10 });
    expect(page.messages.map(message => message.id)).toEqual(["4"]);
    // Started alongside — the request is out — but nothing waited for it.
    expect(calls.some(call => call.url.pathname === "/api")).toBe(true);
    // This fixture's payload names its author only by display name, so the page
    // does spend the bounded grace below on it (MEMBERS_GRACE_MS, 300 ms). The
    // rule this case is here for is that the wait is BOUNDED: the directory never
    // lands at all, and the messages arrive regardless.
    expect(Date.now() - started).toBeLessThan(2000);
    held.resolve(json({ community: [] }));
  });

  // The narrow case the directory still matters for after the merge above: a
  // payload that carries neither `town_id` nor `being_id`. A bonfire page becomes
  // the accumulated timeline and is written to disk, and when the Town page is
  // closed no renderer will fetch the directory and re-render — so a cold first
  // background collection would persist those authors as unknown.
  it("a directory that lands inside the grace still names an author the payload only spells", async () => {
    const { session } = harness({ request: url => {
      if (url.pathname === "/api") return new Promise<Response>(resolve => setTimeout(() => resolve(json({ community: [{ being_id: "echo", display_name: "Echo", about: null }] })), 30));
      if (url.pathname === "/api/bonfire/hear") return json({ ok: true, global_latest_seq: 4, messages: [{ seq: 4, being: "echo", message: "Hello", at: "2026-09-07T12:00:00+08:00", revised_at: null }] });
      return undefined;
    } });
    const page = await session.getBonfireMessages({ limit: 10 });
    expect(page.messages[0]).toMatchObject({ beingId: "echo" });
    expect(Object.hasOwn(page.messages[0], "authorUnknown")).toBe(false);
  });

  it("a directory that never lands costs the page the grace and no more, and the author stays unknown", async () => {
    const held = deferred<Response>();
    const { session } = harness({ request: url => {
      if (url.pathname === "/api") return held.promise;
      if (url.pathname === "/api/bonfire/hear") return json({ ok: true, global_latest_seq: 4, messages: [{ seq: 4, being: "echo", message: "Hello", at: "2026-09-07T12:00:00+08:00", revised_at: null }] });
      return undefined;
    } });
    const started = Date.now();
    const page = await session.getBonfireMessages({ limit: 10 });
    const elapsed = Date.now() - started;
    expect(page.messages[0]).toMatchObject({ beingId: "", authorUnknown: true, content: "Hello" });
    expect(elapsed).toBeLessThan(2000);
    held.resolve(json({ community: [] }));
  });

  // …and a page whose authors are all resolvable never waits for the directory at
  // all, cold cache or not: the grace is spent only where it can change something.
  it("a payload that names its own author waits for no directory even on a cold cache", async () => {
    const held = deferred<Response>();
    const { session, calls } = harness({ request: url => {
      if (url.pathname === "/api") return held.promise;
      if (url.pathname === "/api/bonfire/hear") return json({ ok: true, global_latest_seq: 4, messages: [{ seq: 4, being: "Echo", town_id: "t_Echo", message: "Hello", at: "2026-09-07T12:00:00+08:00", revised_at: null }] });
      return undefined;
    } });
    const started = Date.now();
    const page = await session.getBonfireMessages({ limit: 10 });
    expect(page.messages[0]).toMatchObject({ beingId: "t_Echo", townId: "t_Echo" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls.some(call => call.url.pathname === "/api")).toBe(true);
    held.resolve(json({ community: [] }));
  });

  it("a directory that is already warm still resolves an author the payload only names", async () => {
    const { session } = harness({ request: url => url.pathname === "/api/bonfire/hear"
      ? json({ ok: true, global_latest_seq: 4, messages: [{ seq: 4, being: "echo", message: "Hello", at: "2026-09-07T12:00:00+08:00", revised_at: null }] })
      : undefined });
    await session.getMembers();
    const page = await session.getBonfireMessages({ limit: 10 });
    expect(page.messages[0]).toMatchObject({ beingId: "echo" });
    expect(Object.hasOwn(page.messages[0], "authorUnknown")).toBe(false);
  });

  // MEASURED (IM, 2026-09-16, packaged build): one clean opening of the bonfire
  // asked https://beings.town/api four times, nine to twelve while it failed,
  // because the cache above `getMembers` is only written AFTER a success.
  it("concurrent directory reads share one request, and a failure is not sticky", async () => {
    const held = deferred<Response>();
    let opened = 0;
    const { session } = harness({ request: url => { if (url.pathname !== "/api") return undefined; opened++; return held.promise; } });
    const first = session.getMembers(), second = session.getMembers(), third = session.getMembers({ force: true });
    expect(opened).toBe(1);
    held.resolve(json({ community: [{ being_id: "echo", display_name: "Echo" }] }));
    for (const result of [await first, await second, await third]) expect(result.members).toEqual([{ id: "echo", name: "Echo", description: "" }]);
    expect(opened).toBe(1);

    const failing = harness({ request: url => url.pathname === "/api" ? json({ error: "nope" }, 503) : undefined });
    await expect(failing.session.getMembers()).rejects.toBeTruthy();
    await expect(failing.session.getMembers()).rejects.toBeTruthy();
    expect(failing.calls.filter(call => call.url.pathname === "/api").length).toBe(2);
  });

  it("one caller giving up on the directory leaves the shared read running for the others", async () => {
    const held = deferred<Response>();
    let opened = 0;
    const { session } = harness({ request: url => { if (url.pathname !== "/api") return undefined; opened++; return held.promise; } });
    const controller = new AbortController();
    const abandoned = session.getMembers({ signal: controller.signal });
    const patient = session.getMembers();
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ code: "ABORTED" });
    held.resolve(json({ community: [{ being_id: "echo", display_name: "Echo" }] }));
    expect((await patient).members).toEqual([{ id: "echo", name: "Echo", description: "" }]);
    expect(opened).toBe(1);
  });

  // The shared slot is the reason this deadline has to exist. Before the merge,
  // each caller opened its own request, and one that never landed cost only that
  // caller; now everybody waits on the same promise, and `_request` sets no
  // timeout of its own — it honours the CALLER's signal, and the shared read
  // deliberately carries none. The 20 s in session/client.ts is on another route
  // (the token reads); this public one never goes near it.
  it("a directory read that never lands frees the shared slot instead of stranding every later caller", async () => {
    let opened = 0;
    const { session } = harness({
      membersReadTimeoutMs: 40,
      request: (url, options) => {
        if (url.pathname !== "/api") return undefined;
        opened++;
        // A request that answers nothing and only ever ends by being aborted.
        return new Promise<Response>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      },
    });
    const first = session.getMembers(), joined = session.getMembers();
    expect(opened).toBe(1);
    await expect(first).rejects.toMatchObject({ code: "ABORTED" });
    await expect(joined).rejects.toMatchObject({ code: "ABORTED" });
    // And the slot is free again: the next caller opens its own read rather than
    // awaiting a promise that will never settle.
    await expect(session.getMembers()).rejects.toMatchObject({ code: "ABORTED" });
    expect(opened).toBe(2);
  });

  it("invalidating the directory starts a fresh read rather than joining the doomed one", async () => {
    const held = deferred<Response>();
    let opened = 0;
    const { session } = harness({ request: url => { if (url.pathname !== "/api") return undefined; opened++; return opened === 1 ? held.promise : json({ community: [{ being_id: "echo", display_name: "Echo" }] }); } });
    const stale = session.getMembers();
    session.invalidateMembers();
    const fresh = await session.getMembers();
    expect(opened).toBe(2);
    expect(fresh.members).toEqual([{ id: "echo", name: "Echo", description: "" }]);
    held.resolve(json({ community: [{ being_id: "old", display_name: "Old" }] }));
    await expect(stale).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  });

  it("channel status accepts current ready booleans without mistaking missing data for an unbound channel", async () => {
    for (const [source, status] of [[{ ready: true }, "connected"], [{ ready: false }, "registered"], [{ ready: "true" }, "unknown"], [{}, "unknown"], [{ status: "disabled", ready: true }, "disabled"]] as [Record<string, unknown>, string][]) {
      const f = harness({ request: url => url.pathname === "/api/channels/status" ? json({ channels: [{ channel: "feishu", ...source, app_secret: "PRIVATE_CHANNEL_SECRET" }] }) : undefined });
      const result = await f.session.getChannelStatus();
      expect(result.channels[0].status).toBe(status);
      expect(result.channels[1].status).toBe("unknown");
      expect(JSON.stringify(result).includes("PRIVATE_CHANNEL_SECRET")).toBe(false);
      expect(f.calls.every(call => call.options.method === "GET")).toBe(true);
    }
  });
});
