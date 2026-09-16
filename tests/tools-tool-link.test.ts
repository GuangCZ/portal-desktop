// Ported line by line from BeingDesktop 0.8.26 test/desktop-tool-link.test.cjs on 2026-09-16.
// The `/_relay` reverse-MCP contract: see docs/interfaces.md §6 and §5「错误码」.
import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import { once } from "node:events";
import { createRequire } from "node:module";
import { DesktopToolLink, toolDefinitions, validArguments, MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, MAX_PENDING, MAX_BUFFERED_BYTES } from "../desktop/main/tools/tool-link";
import type { ToolSocketFactory } from "../desktop/main/tools/tool-link";
import { parseConnection } from "../desktop/main/tools/security";
import { LoopbackRelay, frame, until } from "./tools-portal-loopback";

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
const cleanups: (() => Promise<unknown> | unknown)[] = [];
// node:test's `t.after` still runs after a failing assertion; afterEach is the
// vitest equivalent, so a failure closes the real server instead of leaking it.
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const request = (method: string, params: unknown = {}, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, params });
const initialized = (id: unknown) => request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "local-test", version: "1.0" } }, id);
const PLACE = "being-desktop-tools-123456789abc";
const boundResult = (value: any, place = PLACE) => ({ ...value, content: [{ type: "text", text: JSON.stringify({ execution_target: { place, hostname: os.hostname(), platform: process.platform } }) }, ...value.content] });
const call = (name = "desktop_browser_tabs", args: Record<string, unknown> = {}, id: unknown = 3) => request("tools/call", { name, arguments: { place: PLACE, target_portal: PLACE, ...args } }, id);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const success = { content: [{ type: "text" as const, text: "LOCAL_RESULT" }], isError: false };
const jobId = "abcdefab-1234-5678-9abc-0123456789ab";

describe("desktop tool link", () => {
  it("worker optional placeholders are removed before invocation without relaxing required bindings", async () => {
    const h = harness({ toolAllowed: (name) => name.startsWith("desktop_worker_") });
    const socket = await h.ready();
    const args = { sessionId: jobId, sessionToken: jobId, requestId: jobId, title: "Read fixture", prompt: "Read only.", parentWorkerId: "", agentId: null };
    socket.message(call("desktop_worker_start", args)); await tick();
    expect(h.calls.length).toBe(1); expect(Object.hasOwn(h.calls[0].args, "parentWorkerId")).toBe(false);
    expect(Object.hasOwn(h.calls[0].args, "agentId")).toBe(false);
    expect(validArguments("desktop_worker_start", { ...args, target_portal: PLACE, sessionToken: "" })).toBe(false);
    expect(validArguments("desktop_worker_start", { ...args, target_portal: PLACE, parentWorkerId: "invalid" })).toBe(false);
    const receipt = { action: "receive", callbackId: jobId, sessionId: "", sessionToken: null, workerId: "", outcome: "", summary: "", evidence: null, target_portal: PLACE };
    expect(validArguments("desktop_worker_status", receipt)).toBe(true);
    expect(validArguments("desktop_worker_status", { ...receipt, callbackId: "" })).toBe(false);
    expect(validArguments("desktop_worker_status", { ...receipt, sessionId: jobId })).toBe(false);
    expect(validArguments("desktop_worker_status", { action: "review", sessionId: jobId, sessionToken: jobId, workerId: jobId, outcome: "passed", summary: "OK", evidence: "", callbackId: null, target_portal: PLACE })).toBe(false);
    h.link.dispose();
  });

  it("construction remains disconnected and never starts transport", () => {
    const h = harness();
    expect(h.sockets.length).toBe(0);
    expect(h.link.snapshot()).toEqual({ status: "disconnected", error: "", lastCall: null, calls: 0, pending: [] });
    expect(Object.keys(h.link)).toEqual([]);
  });
  it("orchestrator discovery exposes only worker tools and rejects stale execution calls", async () => {
    let enabled = true;
    const h = harness({ toolAllowed: (name) => name.startsWith("desktop_worker_") === enabled });
    const socket = await h.ready(); socket.message(request("tools/list", {}, 2));
    expect(socket.sent.at(-1).result.tools.map((tool: any) => tool.name)).toEqual(toolDefinitions(true).map((tool) => tool.name));
    socket.message(call("desktop_console_run", { command: "pwd" }, 3)); await tick(); expect(h.calls.length).toBe(0);
    const scope = { sessionId: jobId, sessionToken: jobId }; socket.message(call("desktop_worker_list", scope, 4)); await tick(); expect(h.calls.length).toBe(1);
    enabled = false; socket.message(call("desktop_worker_list", scope, 5)); await tick(); expect(h.calls.length).toBe(1);
  });

  it("explicit browser, console and scoped terminal schemas are defensive copies", () => {
    const definitions = toolDefinitions();
    expect(definitions.length).toBe(15);
    expect(definitions.map((item) => item.name)).toEqual(["desktop_browser_tabs", "desktop_browser_open", "desktop_browser_read", "desktop_browser_click", "desktop_browser_fill", "desktop_browser_screenshot", "desktop_console_run", "desktop_console_status", "desktop_console_stop", "desktop_terminal_create", "desktop_terminal_write", "desktop_terminal_read", "desktop_terminal_list", "desktop_terminal_show", "desktop_terminal_close"]);
    expect(definitions.every((item) => item.inputSchema.additionalProperties === false)).toBe(true);
    definitions[0].name = "changed";
    expect(toolDefinitions()[0].name).toBe("desktop_browser_tabs");
  });

  it("every advertised tool requires the exact target and rejects other hosts before dispatch", async () => {
    const h = harness(); const socket = await h.ready(); socket.message(request("tools/list", {}, 2));
    for (const tool of socket.sent.at(-1).result.tools) {
      expect(tool.inputSchema.required.includes("place")).toBe(true);
      expect(tool.inputSchema.properties.place.enum).toEqual([PLACE]);
    }
    for (const [index, place] of [undefined, null, "mac", "being-desktop"].entries()) {
      socket.message(call("desktop_browser_tabs", { target_portal: place }, 10 + index)); await tick();
      expect(h.calls.length).toBe(0);
      expect(socket.sent.at(-1).error.code).toBe(-32602);
    }
    socket.message(call("desktop_browser_tabs", { place: PLACE }, 20)); await tick();
    expect(h.calls[0].args).toEqual({});
    expect(JSON.parse(socket.sent.at(-1).result.content[0].text).execution_target.place).toBe(PLACE);
    h.link.dispose();
  });

  it("Hearth may consume place while the endpoint still requires the matching target_portal", async () => {
    const h = harness(); const socket = await h.ready();
    socket.message(request("tools/call", { name: "desktop_browser_tabs", arguments: { target_portal: PLACE } }, 51)); await tick();
    expect(h.calls.length).toBe(1); expect(h.calls[0].args).toEqual({});
    socket.message(request("tools/call", { name: "desktop_browser_tabs", arguments: { place: PLACE } }, 52)); await tick();
    expect(h.calls.length).toBe(1); expect(socket.sent.at(-1).error.code).toBe(-32602);
    socket.message(request("tools/call", { name: "desktop_browser_tabs", arguments: { target_portal: "wrong-host" } }, 53)); await tick();
    expect(h.calls.length).toBe(1); expect(socket.sent.at(-1).error.code).toBe(-32602);
    h.link.dispose();
  });

  it("connection derives the relay and first path identity without credentials in URL or snapshot", async () => {
    const h = harness();
    const connection = parseConnection("https://fixture.invalid/being-id/nested/?token=PRIVATE_TOKEN&api=https://fixture.invalid/different-api");
    const connected = h.connect(connection);
    const socket = h.sockets[0]; socket.open();
    expect(socket.url).toBe("wss://fixture.invalid/_relay");
    expect(socket.sent[0].being_id).toBe("being-id");
    expect(socket.sent[0].loom_token).toBe("PRIVATE_TOKEN");
    expect(socket.sent[0].portal_name).toMatch(/^being-desktop-tools-[a-f0-9]{12}$/);
    socket.message({ ok: true, relay_keepalive: "text-v1" }); await connected;
    expect(h.link.snapshot().status).toBe("connected");
    expect(JSON.stringify(h.changes).includes("PRIVATE_TOKEN")).toBe(false);
    expect(JSON.stringify(h.changes).includes("fixture.invalid")).toBe(false);
    expect(Object.hasOwn(h.link.snapshot(), "toolsDiscovered")).toBe(false);
    h.link.dispose();
  });

  for (const [name, value] of [
    ["null", null], ["empty", {}], ["missing token", parseConnection("https://fixture.invalid/being/")],
    ["mismatched token", { ...parseConnection("https://fixture.invalid/being/?token=one"), token: "two" }],
    ["invalid identity", parseConnection("https://fixture.invalid/being%20name/?token=one")],
    ["external HTTP", { url: "http://fixture.invalid/being/?token=one", token: "one" }],
    ["URL credentials", { url: "https://name:pass@fixture.invalid/being/?token=one", token: "one" }],
  ] as [string, unknown][]) it(`invalid connection: ${name}`, async () => {
    const h = harness(); await expect(h.link.connect(value)).rejects.toThrow(); expect(h.sockets.length).toBe(0);
  });

  it("active connection cannot be silently replaced; dispose is permanent", async () => {
    const h = harness(); await h.ready();
    await expect(h.connect()).rejects.toThrow(); expect(h.sockets.length).toBe(1);
    h.link.dispose(); await expect(h.connect()).rejects.toThrow(); expect(h.sockets.length).toBe(1);
  });

  for (const response of [{ ok: false }, { ok: true, being_id: "wrong-being" }, { ok: true, relay_keepalive: "other" }, { ok: true, relay_keepalive: "text-v1", jsonrpc: "2.0" }, { ok: true, relay_keepalive: "text-v1", token: "PRIVATE_TOKEN" }, "{"]) {
    it(`rejects unsupported relay handshake ${JSON.stringify(response)}`, async () => {
      const h = harness(); const connection = h.connect(); h.sockets[0].open(); h.sockets[0].message(response);
      await expect(connection).rejects.toThrow(); expect(h.link.snapshot().status).toBe("error"); expect(h.calls.length).toBe(0);
    });
  }

  it("the live relay handshake negotiates WebSocket ping/pong when text keepalive is absent", async () => {
    const h = harness(); const connected = h.connect(); const socket = h.sockets[0]; socket.open();
    socket.message({ being_id: "being-id", ok: true }); await connected;
    h.heartbeat(); expect(socket.pings).toBe(1); expect(socket.sent.length).toBe(1);
    h.advance(85000); socket.pong(); h.advance(10000); h.heartbeat();
    expect(h.link.snapshot().status).toBe("connected"); expect(h.calls.length).toBe(0);
    h.advance(90001); h.heartbeat(); expect(h.link.snapshot().status).toBe("error");
  });

  it("fallback heartbeat write failures revoke the authenticated connection", async () => {
    const h = harness(); const connected = h.connect(); const socket = h.sockets[0]; socket.open(); socket.message({ ok: true }); await connected;
    socket.failSend = true; h.heartbeat(); expect(h.link.snapshot().status).toBe("error");
    expect(JSON.stringify(h.changes).includes("PRIVATE_TRANSPORT_ERROR")).toBe(false);
  });

  it("a live-shaped relay authenticates and answers actual WebSocket ping frames", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let heartbeat!: () => void, now = 0;
    const link = new DesktopToolLink({ invokeTool: () => success, clock: () => now, timers: {
      setTimeout, clearTimeout, setInterval: (callback) => { heartbeat = callback; return 1; }, clearInterval: () => {},
    } });
    cleanups.push(() => { link.dispose(); server.close(); });
    await once(server, "listening");
    const accepted = once(server, "connection");
    const connected = link.connect(parseConnection(`http://127.0.0.1:${server.address().port}/being-id/?token=LOCAL_ONLY_TOKEN`));
    const [socket] = await accepted;
    const [data] = await once(socket, "message"); const auth = JSON.parse(data);
    expect(auth.loom_token).toBe("LOCAL_ONLY_TOKEN");
    socket.send(JSON.stringify({ being_id: auth.being_id, ok: true })); await connected;
    const ping = once(socket, "ping"); heartbeat(); expect((await ping)[0].toString()).toBe("bd");
    // A subsequent MCP frame establishes that the preceding Pong was processed.
    const reply = once(socket, "message"); socket.send(JSON.stringify(initialized(1))); await reply;
    now = 90001; heartbeat(); expect(link.snapshot().status).toBe("error");
  }, 10000);

  it("handshake timeout rejects and removes its timers without retrying", async () => {
    const h = harness(); const connection = h.connect(); for (const callback of [...h.timeouts.values()]) callback();
    await expect(connection).rejects.toThrow(); expect(h.timeouts.size).toBe(0); expect(h.intervals.size).toBe(0); expect(h.sockets.length).toBe(1);
  });

  it("a connecting close rejects pending connect instead of leaving it unresolved", async () => {
    const h = harness(); const connection = h.connect(); h.sockets[0].close(); await expect(connection).rejects.toThrow();
  });

  it("metadata initialization is required before tools; ping never dispatches a tool", async () => {
    const h = harness(); const socket = await h.ready(false);
    socket.message(call()); expect(socket.sent.at(-1).error.code).toBe(-32002);
    socket.message(request("ping", {}, 4)); expect(socket.sent.at(-1).result).toEqual({});
    socket.message(initialized(5)); expect(socket.sent.at(-1).result.protocolVersion).toBe("2024-11-05");
    socket.message({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    socket.message(request("tools/list", {}, 6)); expect(socket.sent.at(-1).result.tools.length).toBe(15);
    expect(h.calls.length).toBe(0); h.link.dispose();
  });

  const argumentCases: [string, Record<string, unknown>, boolean][] = [
    ["desktop_browser_tabs", {}, true], ["desktop_browser_tabs", { url: "PRIVATE" }, false],
    ["desktop_browser_open", { url: "https://example.com" }, true], ["desktop_browser_open", { url: "http://127.0.0.1:8000" }, true],
    ["desktop_browser_open", { url: "file:///C:/private" }, false], ["desktop_browser_open", { url: "javascript:alert(1)" }, false],
    ["desktop_browser_open", { url: "https://user:pass@example.com" }, false], ["desktop_browser_open", { url: "https://example.com/\n" }, false],
    ["desktop_browser_read", { tabId: "tab-1" }, true], ["desktop_browser_read", {}, false],
    ["desktop_browser_click", { tabId: "tab-1", selector: "button", expectedRevision: 2 }, true],
    ["desktop_browser_click", { tabId: "tab-1", selector: "button" }, false],
    ["desktop_browser_click", { tabId: "tab-1", selector: "button", expectedRevision: "2" }, false],
    ["desktop_browser_click", { tabId: "tab-1", selector: "x".repeat(513), expectedRevision: 2 }, false],
    ["desktop_browser_fill", { tabId: "tab-1", selector: "input", text: "", expectedRevision: 0 }, true],
    ["desktop_browser_fill", { tabId: "tab-1", selector: "input", text: "x".repeat(8001), expectedRevision: 0 }, false],
    ["desktop_browser_screenshot", { tabId: "tab-1", expectedRevision: 0 }, true],
    ["desktop_browser_screenshot", { tabId: "tab-1", expectedRevision: -1 }, false],
    ["desktop_console_run", { command: "Write-Output TEST", cwd: "E:\\workspace" }, true],
    ["desktop_console_run", { command: "" }, false], ["desktop_console_run", { command: "bad\0command" }, false],
    ["desktop_console_run", { command: "safe", env: { TOKEN: "PRIVATE" } }, false],
    ["desktop_console_status", {}, true], ["desktop_console_status", { jobId }, true],
    ["desktop_console_stop", { jobId }, true], ["desktop_console_stop", { jobId: "123" }, false],
    ["desktop_console_stop", { pid: 123 }, false], ["portal_exec", { command: "anything" }, false],
  ];
  for (const [index, [name, args, accepted]] of argumentCases.entries()) it(`tool argument contract ${index + 1}: ${name}`, () => expect(validArguments(name, { place: PLACE, target_portal: PLACE, ...args })).toBe(accepted));

  it("only a valid call reaches the host with an abort signal and opaque request key", async () => {
    const h = harness(); const socket = await h.ready();
    socket.message(call("desktop_browser_open", { url: "https://example.com/PRIVATE_URL" })); await tick();
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].context.signal instanceof AbortSignal).toBe(true);
    expect(h.calls[0].context.requestKey).toMatch(new RegExp("^[a-f0-9-]{36}$"));
    expect(h.calls[0].args.url).toBe("https://example.com/PRIVATE_URL");
    expect(socket.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 3, result: boundResult(success) });
    expect(h.link.snapshot().lastCall!.status).toBe("completed"); expect(h.link.snapshot().pending.length).toBe(0);
    expect(JSON.stringify(h.changes).includes("PRIVATE_URL")).toBe(false); expect(JSON.stringify(h.changes).includes("LOCAL_RESULT")).toBe(false);
    h.link.dispose();
  });

  it("host errors are replaced by a fixed MCP error without exception text", async () => {
    const h = harness({ invokeTool: () => { throw new Error("PRIVATE_FILE_AND_TOKEN"); } }); const socket = await h.ready();
    socket.message(call()); await tick(); expect(socket.sent.at(-1).result.isError).toBe(true);
    expect(JSON.stringify(socket.sent).includes("PRIVATE_FILE_AND_TOKEN")).toBe(false); expect(h.link.snapshot().lastCall!.status).toBe("failed"); h.link.dispose();
  });

  it("images stay native MCP image blocks", async () => {
    const content = [{ type: "image", mimeType: "image/png", data: Buffer.from("LOCAL_FIXTURE").toString("base64") }];
    const h = harness({ invokeTool: () => ({ content }) }); const socket = await h.ready(); socket.message(call("desktop_browser_screenshot", { tabId: "tab-1", expectedRevision: 1 })); await tick();
    expect(socket.sent.at(-1).result).toEqual(boundResult({ content, isError: false })); h.link.dispose();
  });

  it("combined tool content is capped by the full serialized response limit", async () => {
    const text = "x".repeat(1024 * 1024);
    const h = harness({ invokeTool: () => ({ content: Array.from({ length: 9 }, () => ({ type: "text", text })) }) });
    const socket = await h.ready(); socket.message(call()); await tick();
    expect(socket.sent.at(-1).result.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(socket.sent.at(-1))) < MAX_RESPONSE_BYTES).toBe(true);
    expect(h.link.snapshot().lastCall!.status).toBe("failed"); h.link.dispose();
  });

  it("a realistic large image result is validated and returned within the byte cap", async () => {
    const data = Buffer.alloc(1024 * 1024, 17).toString("base64");
    const h = harness({ invokeTool: () => ({ content: [{ type: "image", mimeType: "image/png", data }] }) });
    const socket = await h.ready(); socket.message(call("desktop_browser_screenshot", { tabId: "tab-1", expectedRevision: 1 })); await tick();
    expect(socket.sent.at(-1).result.content[1].data).toBe(data); expect(h.link.snapshot().lastCall!.status).toBe("completed"); h.link.dispose();
  });

  for (const [index, value] of [null, { content: "text" }, { content: [{ type: "resource", resource: { uri: "file:///private" } }] }, { content: [{ type: "image", mimeType: "image/svg+xml", data: "QUJD" }] }, { content: [{ type: "image", mimeType: "image/png", data: "not base64" }] }, { content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }] }, { content: [], extra: "PRIVATE" }].entries()) {
    it(`invalid output is bounded and rejected ${index + 1}`, async () => {
      const h = harness({ invokeTool: () => value as any }); const socket = await h.ready(); socket.message(call()); await tick(); expect(socket.sent.at(-1).result.isError).toBe(true); h.link.dispose();
    });
  }

  it("concurrency is bounded before the host receives additional calls", async () => {
    const h = harness({ invokeTool: () => new Promise(() => {}) }); const socket = await h.ready();
    for (let id = 3; id < 3 + MAX_PENDING + 1; id++) socket.message(call("desktop_browser_tabs", {}, id));
    await tick(); expect(h.calls.length).toBe(MAX_PENDING); expect(h.link.snapshot().pending.length).toBe(MAX_PENDING);
    expect(socket.sent.at(-1).error.code).toBe(-32000);
    const snapshot = h.link.snapshot(); snapshot.pending[0].name = "changed"; expect(h.link.snapshot().pending[0].name).toBe("desktop_browser_tabs");
    h.link.dispose(); await tick(); expect(h.calls.every((item) => item.context.signal.aborted)).toBe(true); expect(h.link.snapshot().pending.length).toBe(0);
  });

  it("duplicate request IDs cannot replay tool calls, including after completion", async () => {
    const h = harness(); const socket = await h.ready(); socket.message(call()); await tick(); socket.message(call()); await tick();
    expect(h.calls.length).toBe(1); expect(socket.sent.at(-1).error.code).toBe(-32600); h.link.dispose();
  });

  it("disconnect aborts pending approvals and drops results after reconnect", async () => {
    let finish!: (value: unknown) => void; const h = harness({ invokeTool: () => new Promise((resolve) => { finish = resolve; }) }); const old = await h.ready();
    old.message(call("desktop_browser_tabs", {}, "private-request-id")); await tick(); h.link.disconnect();
    expect(h.calls[0].context.signal.aborted).toBe(true);
    const oldLength = old.sent.length; const fresh = await h.ready(); const freshLength = fresh.sent.length;
    finish(success); old.message(call()); await tick();
    expect(old.sent.length).toBe(oldLength); expect(fresh.sent.length).toBe(freshLength); expect(h.calls.length).toBe(1);
    expect(JSON.stringify(h.changes).includes("private-request-id")).toBe(false); h.link.dispose();
  });

  it("MCP cancellation aborts only its request and suppresses the late result", async () => {
    let finish!: (value: unknown) => void; const h = harness({ invokeTool: () => new Promise((resolve) => { finish = resolve; }) }); const socket = await h.ready(); socket.message(call()); await tick();
    const count = socket.sent.length; socket.message({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3, reason: "PRIVATE_REASON" } });
    expect(h.calls[0].context.signal.aborted).toBe(true); expect(h.link.snapshot().pending.length).toBe(0); expect(h.link.snapshot().lastCall!.status).toBe("cancelled");
    finish(success); await tick(); expect(socket.sent.length).toBe(count); expect(JSON.stringify(h.changes).includes("PRIVATE_REASON")).toBe(false); h.link.dispose();
  });

  it("notifications never run tools; unknown methods and extra fields are rejected", async () => {
    const h = harness(); const socket = await h.ready(); const start = socket.sent.length;
    socket.message({ jsonrpc: "2.0", method: "tools/call", params: { name: "desktop_browser_tabs", arguments: {} } });
    expect(socket.sent.length).toBe(start);
    for (const frame of [request("resources/read", {}, 3), { ...call("desktop_browser_tabs", {}, 4), extra: "PRIVATE" }, call("desktop_browser_tabs", { constructor: "PRIVATE" }, 5), request("tools/list", { cursor: "PRIVATE" }, 6), request("ping", { message: "PRIVATE" }, 7)]) socket.message(frame);
    await tick(); expect(h.calls.length).toBe(0); expect(socket.sent.slice(start).every((item: any) => item.error)).toBe(true); h.link.dispose();
  });

  it("malformed IDs, batches and prototype fields never dispatch", async () => {
    const h = harness(); const socket = await h.ready();
    for (const frame of [[], null, "null", "PRIVATE_INVALID_JSON", { ...call(), id: null }, { ...call(), id: -1 }, { ...call(), id: 2.5 }, { ...call(), id: {} }, { ...call(), id: "x".repeat(129) }, JSON.stringify(call()).replace('"arguments":{', '"arguments":{"__proto__":{},')]) socket.message(frame);
    await tick(); expect(h.calls.length).toBe(0); expect(h.link.snapshot().pending.length).toBe(0); h.link.dispose();
  });

  it("binary or oversized frames revoke the connection instead of coercing data", async () => {
    for (const input of [new ArrayBuffer(2), "中".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3))]) {
      const h = harness(); const socket = await h.ready(); socket.message(input); expect(h.link.snapshot().status).toBe("error"); expect(h.calls.length).toBe(0);
    }
  });

  it("mixed keepalive/MCP frames cannot extend liveness or invoke tools", async () => {
    const h = harness(); const socket = await h.ready(); h.advance(85000); socket.message({ type: "keepalive_ack", ...call() }); h.advance(6000); h.heartbeat();
    expect(h.link.snapshot().status).toBe("error"); expect(h.calls.length).toBe(0); expect(h.sockets.length).toBe(1);
  });

  it("valid keepalive acknowledges liveness without execution or automatic retry", async () => {
    const h = harness(); const socket = await h.ready(); h.advance(85000); socket.message({ type: "keepalive_ack" }); h.advance(10000); h.heartbeat();
    expect(h.link.snapshot().status).toBe("connected"); expect(socket.sent.at(-1)).toEqual({ type: "keepalive" }); h.advance(90001); h.heartbeat(); expect(h.link.snapshot().status).toBe("error"); expect(h.sockets.length).toBe(1);
  });

  it("backpressure and send failures revoke the session with no raw network error", async () => {
    for (const failure of ["buffer", "send"]) {
      const h = harness(); const socket = await h.ready(); if (failure === "buffer") socket.bufferedAmount = MAX_BUFFERED_BYTES + 1; else socket.failSend = true;
      socket.message(request("ping", {}, 3)); expect(h.link.snapshot().status).toBe("error"); expect(JSON.stringify(h.changes).includes("PRIVATE_TRANSPORT_ERROR")).toBe(false);
    }
  });

  it("onChange disconnection before dispatch prevents invocation", async () => {
    const h = harness({ onChange: (snapshot, link) => { if (snapshot.pending.length) link.disconnect(); } }); const socket = await h.ready(); socket.message(call()); await tick(); expect(h.calls.length).toBe(0); expect(h.link.snapshot().status).toBe("disconnected");
  });

  it("onChange disconnection during handshake rejects the connect result", async () => {
    const h = harness({ onChange: (snapshot, link) => { if (snapshot.status === "connected") link.disconnect(); } });
    const connected = h.connect(); h.sockets[0].open(); h.sockets[0].message({ ok: true, relay_keepalive: "text-v1" });
    await expect(connected).rejects.toThrow(); expect(h.link.snapshot().status).toBe("disconnected"); expect(h.intervals.size).toBe(0);
  });

  it("a local relay performs real native-WebSocket tool discovery and a fixed call", async () => {
    const relay = new LoopbackRelay("LOCAL_ONLY_TOKEN", { beingId: "local-desktop-tool-test" });
    class LocalWebSocket extends WebSocket {
      constructor(url: string) { expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:[0-9]+\/_relay$/); super(url); }
      send(text: string) {
        const value = JSON.parse(text);
        if (Object.hasOwn(value, "portal_name")) { expect(value.portal_name).toMatch(/^being-desktop-tools-[a-f0-9]{12}$/); relay.portalName = value.portal_name; }
        return super.send(text);
      }
    }
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const link = new DesktopToolLink({ WebSocketImpl: LocalWebSocket as unknown as ToolSocketFactory, invokeTool: async (name, args) => { calls.push({ name, args }); return success; } });
    cleanups.push(async () => { link.dispose(); await relay.pause(); });
    await relay.listen();
    await link.connect(parseConnection(`http://127.0.0.1:${relay.port}/local-desktop-tool-test/?token=LOCAL_ONLY_TOKEN`));
    await until(relay, () => relay.metadataReplies === 1, "desktop tool metadata", 5000);
    expect(relay.toolNames).toEqual(toolDefinitions().map((item) => item.name));
    const response = new Promise((resolve) => relay.on("rpc_response", (value) => { if (value.id === "local-call") resolve(value); }));
    for (const socket of relay.sockets) socket.write(frame(1, JSON.stringify(call("desktop_browser_tabs", { place: relay.portalName, target_portal: relay.portalName }, "local-call"))));
    expect(await response).toEqual({ jsonrpc: "2.0", id: "local-call", result: boundResult(success, relay.portalName) });
    expect(calls).toEqual([{ name: "desktop_browser_tabs", args: {} }]);
    expect(link.snapshot().status).toBe("connected"); expect(link.snapshot().lastCall!.status).toBe("completed");
  }, 15000);

  it("tool initialization notifies configuration observers before the first tool call", async () => {
    const observations: string[][] = [];
    const h = harness({ toolAllowed: (name) => name.startsWith("desktop_worker_"), onChange: (_state, link) => observations.push(link.capabilities().tools) });
    const socket = await h.ready(false);
    expect(observations.at(-1)!.length).toBe(0);
    socket.message(initialized(1));
    expect(observations.at(-1)!.includes("desktop_worker_start")).toBe(true);
    expect(h.calls.length).toBe(0);
    h.link.dispose();
  });

  it("orchestration reconnects a lost transport with backoff and requires a fresh initialize", async () => {
    const h = harness({ shouldReconnect: () => true, toolAllowed: (name) => name.startsWith("desktop_worker_") });
    const socket = await h.ready(); socket.close();
    expect(h.link.snapshot().reconnect).toEqual({ attempt: 1, delayMs: 2000 });
    expect(h.link.capabilities().tools).toEqual([]);
    const fire = () => { const [id, callback] = h.timeouts.entries().next().value as [number, () => void]; h.timeouts.delete(id); callback(); };
    fire(); await tick(); expect(h.sockets.length).toBe(2);
    // An unsuccessful handshake times out and backs off rather than looping at full speed.
    fire(); await tick(); expect(h.link.snapshot().reconnect).toEqual({ attempt: 2, delayMs: 4000 });
    fire(); await tick(); expect(h.sockets.length).toBe(3);
    const next = h.sockets.at(-1)!; next.open(); next.message({ ok: true, relay_keepalive: "text-v1" }); await tick();
    expect(h.link.capabilities().tools).toEqual([]);
    next.message(initialized(1)); expect(h.link.capabilities().tools.includes("desktop_worker_start")).toBe(true);
    next.close(); expect(h.link.snapshot().reconnect!.delayMs).toBe(2000);
    expect(h.calls.length, "Reconnecting must not replay tool requests or start Workers").toBe(0);
    h.link.dispose(); expect(h.timeouts.size).toBe(0);
  });

  for (const reason of ["disconnect", "disable", "dispose", "identity"]) it(`scheduled reconnect respects ${reason}`, async () => {
    let enabled = true; const h = harness({ shouldReconnect: () => enabled });
    const socket = await h.ready(); socket.close(); const pending = [...h.timeouts.values()][0];
    if (reason === "disable") enabled = false;
    if (reason === "disconnect" || reason === "identity") h.link.disconnect();
    if (reason === "dispose") h.link.dispose();
    if (reason === "identity") {
      const connect = h.connect(parseConnection("https://fixture.invalid/other-being/?token=NEW_PRIVATE_TOKEN"));
      const next = h.sockets.at(-1)!; next.open(); next.message({ ok: true, relay_keepalive: "text-v1" }); await connect;
    }
    const before = h.sockets.length; pending(); await tick(); expect(h.sockets.length).toBe(before);
    h.link.dispose();
  });

  it("protocol rejection does not repeatedly authenticate in the background", async () => {
    const h = harness({ shouldReconnect: () => true }), connect = h.connect();
    h.sockets[0].open(); h.sockets[0].message({ ok: false }); await expect(connect).rejects.toThrow();
    expect(h.timeouts.size).toBe(0); expect(h.link.snapshot().reconnect).toBeUndefined(); h.link.dispose();
  });
});

interface HarnessOptions {
  toolAllowed?: (name: string) => boolean;
  shouldReconnect?: () => boolean;
  onChange?: (snapshot: any, link: DesktopToolLink) => void;
  invokeTool?: (name: string, args: any, context: any) => any;
}
function harness(options: HarnessOptions = {}) {
  const sockets: any[] = [], changes: any[] = [], calls: any[] = [], timeouts = new Map<number, () => void>(), intervals = new Map<number, () => void>();
  let time = 0, timerId = 0;
  class FakeSocket extends EventTarget {
    url: string; readyState: number; bufferedAmount: number; sent: any[]; failSend?: boolean; pings?: number;
    constructor(url: string) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value) })); }
    send(text: string) { if (this.failSend) throw new Error("PRIVATE_TRANSPORT_ERROR"); this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    on(event: string, callback: (event: any) => void) { this.addEventListener(event, callback); }
    ping() { if (this.failSend) throw new Error("PRIVATE_TRANSPORT_ERROR"); this.pings = (this.pings || 0) + 1; }
    pong() { this.dispatchEvent(new Event("pong")); }
  }
  const link = new DesktopToolLink({
    portalName: PLACE, toolAllowed: options.toolAllowed, shouldReconnect: options.shouldReconnect,
    onChange: (snapshot) => { changes.push(snapshot); options.onChange?.(snapshot, link); },
    invokeTool: (name, args, context) => { calls.push({ name, args, context }); return options.invokeTool ? options.invokeTool(name, args, context) : structuredClone(success); },
    WebSocketImpl: FakeSocket as unknown as ToolSocketFactory, clock: () => time,
    timers: { setTimeout: (callback) => { const id = ++timerId; timeouts.set(id, callback); return id; }, clearTimeout: (id) => timeouts.delete(id), setInterval: (callback) => { const id = ++timerId; intervals.set(id, callback); return id; }, clearInterval: (id) => intervals.delete(id) },
  });
  const connect = (value?: unknown) => link.connect(value || parseConnection("https://fixture.invalid/being-id/?token=PRIVATE_TOKEN"));
  const ready = async (initialize = true) => {
    const connected = connect();
    const socket = sockets.at(-1);
    socket.open(); socket.message({ ok: true, relay_keepalive: "text-v1" });
    await connected;
    if (initialize) socket.message(initialized(1));
    return socket;
  };
  return { link, sockets, changes, calls, timeouts, intervals, connect, ready, advance: (value: number) => { time += value; }, heartbeat: () => { for (const callback of [...intervals.values()]) callback(); } };
}
