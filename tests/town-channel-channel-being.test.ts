// Ported from BeingDesktop test/channel-being.test.cjs on 2026-09-16. Fixtures copied verbatim.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ChannelBeing, parseChannelOutcome } from "../desktop/main/town/channel/channel-being";
import { parseConnection } from "../desktop/main/common/loom-connection";
import type { ChannelBeingOptions } from "../desktop/main/town/channel/channel-being";

const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function contract(options: RequestInit) {
  const message = JSON.parse(String(options.body)).message as string;
  return { protocol: "being-desktop-channel-result/1", requestId: message.match(/^\[Being Desktop Town sync:([^\]]+)\]/)![1], route: message.match(/任务路线：([^。]+)。/)![1], beingId: message.match(/当前 Being：([^；]+)；/)![1] };
}
const turn = (reply: unknown, sessionId = "server-wechat", options?: RequestInit) =>
  (options ? event("meta", { scene_id: JSON.parse(String(options.body)).scene_id }) : "") +
  event("content_block_delta", { delta: { text: typeof reply === "string" ? reply : JSON.stringify({ ...(options ? contract(options) : {}), ...(reply as object) }) } }) +
  event("message_stop", { session_id: sessionId });
const stream = (text: string) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise((yes) => { resolve = yes as () => void; }); return { promise, resolve }; }

type Respond = (url: string, options: RequestInit, calls: { url: string; options: RequestInit; body: any }[]) => Promise<Response> | Response;

function harness(respond: Respond = async (_, options) => stream(turn({ channel: "wechat", status: "pending", detail: "请按返回的说明继续。" }, undefined, options)), overrides: Partial<ChannelBeingOptions> = {}) {
  const context: any = { configured: true, connected: true, exiting: false, connectionId: 4, identityRevision: 1, beingName: "alice", connection: parseConnection("https://being.test/alice?token=loom-test-private") };
  const calls: { url: string; options: RequestInit; body: any }[] = [];
  const changes: unknown[] = [];
  const requests: any[] = [];
  const channel = new ChannelBeing({ getContext: () => ({ ...context }), onChange: (value) => changes.push(value), onRequest: (value) => requests.push(value), fetchImpl: (async (url: string, options: RequestInit) => {
    calls.push({ url, options, body: options.body ? JSON.parse(String(options.body)) : undefined });
    return respond(url, options, calls);
  }) as unknown as typeof fetch, ...overrides });
  return { channel, context, calls, changes, requests };
}
const wechat = { channel: "wechat", connectionRevision: 4 };
const feishu = { channel: "feishu", connectionRevision: 4 };

it("channel clicks send fixed background requests only to authenticated Loom", async () => {
  const { channel, calls, requests } = harness();
  const result = await channel.beginChannelConnection(wechat);
  expect(calls.length).toBe(1);
  const call = calls[0];
  expect(call.url).toBe("https://being.test/alice/api/chat/stream?token=loom-test-private");
  expect(call.options.method).toBe("POST");
  expect(call.options.redirect).toBe("error");
  expect(call.options.credentials).toBe("omit");
  expect(call.options.referrerPolicy).toBe("no-referrer");
  expect(Object.keys(call.body)).toEqual(["message", "scene_id", "scene_meta", "client_ref"]);
  expect(call.body.scene_id).toMatch(/^desktop-channel-[0-9a-f-]+-wechat$/);
  expect(call.body.scene_meta.scene_label).toBe("微信 · Channel");
  expect(call.body.message).toMatch(/"channel":"wechat"/);
  expect(call.body.message).toMatch(/仅适用于本次请求/);
  expect(call.body.message).not.toMatch(/不要部署 Portal|不要要求用户向 Heart 申请 IP Trust/);
  expect(call.body.message).toMatch(/专用安全配置入口/);
  expect(result.status).toBe("pending");
  expect(channel.state().channel).toBe("wechat");
  expect(requests.length).toBe(1);
  expect(Object.keys(requests[0]).sort()).toEqual(["beingId", "prompt", "requestId", "route"]);
  expect(requests[0].route).toBe("/desktop/channel/wechat/begin");
  expect(requests[0].beingId).toBe("alice");
  expect(requests[0].prompt).toBe(call.body.message);
  expect(requests[0].requestId).toBe(contract(call.options).requestId);
  expect(JSON.stringify(requests).includes("loom-test-private")).toBe(false);
});

it("every channel uses its own scene from the first request and ignores legacy server session IDs", async () => {
  const { channel, calls } = harness(async (_, options) => {
    const target = JSON.parse(String(options.body)).message.includes('"channel":"feishu"') ? "feishu" : "wechat";
    return stream(turn({ channel: target, status: "connected", detail: "实际服务已连接。" }, `actual-${target}`, options));
  });
  await channel.beginChannelConnection(wechat);
  await channel.beginChannelConnection(feishu);
  const result = await channel.getChannelStatus(wechat);
  expect(calls[0].body.session_id).toBeUndefined();
  expect(calls[1].body.session_id).toBeUndefined();
  expect(calls[2].body.session_id).toBeUndefined();
  expect(calls[0].body.scene_id).not.toBe(calls[1].body.scene_id);
  expect(calls[2].body.scene_id).toBe(calls[0].body.scene_id);
  expect(result.channels[0].status).toBe("connected");
  expect(calls[2].body.message).toMatch(/只读检查/);
  expect(calls[2].body.message).toMatch(/不要登记渠道/);
});

it("202 only means pending and does not replay automatically", async () => {
  const { channel, calls } = harness(async () => new Response("{}", { status: 202 }));
  expect((await channel.beginChannelConnection(wechat)).status).toBe("pending");
  expect(calls.length).toBe(1);
  expect(channel.state().detail).toMatch(/尚未确认/);
});

it("every reply is consumed until EOF and only the final completed reply supplies the outcome", async () => {
  const { channel } = harness(async (_, options) => stream(turn("正在检查。") + turn({ channel: "wechat", status: "unsupported", detail: "实际服务尚不支持。" }, undefined, options)));
  expect((await channel.beginChannelConnection(wechat)).status).toBe("unsupported");
});

it("prose, malformed schema, and mismatched channel never imply connection success", async () => {
  for (const reply of ["已连接 connected", "{bad json}", { channel: "feishu", status: "connected", detail: "wrong target" }, { channel: "wechat", status: "connected", detail: null }]) {
    const { channel } = harness(async () => stream(turn(reply)));
    expect((await channel.beginChannelConnection(wechat)).status).toBe("unknown");
  }
});

it("new channel flows reject stale UUID, wrong route or Being, legacy untagged and extra-field replies", async () => {
  for (const patch of [{ requestId: randomUUID() }, { requestId: null }, { route: "/desktop/channel/wechat/status" }, { beingId: "another" }, { protocol: "legacy" }, { channel: "feishu" }, { unexpected: "private detail" }]) {
    const { channel, changes, calls } = harness(async (_, options) => stream(turn({ channel: "wechat", status: "connected", detail: "Never trust this stale result", qrCodeUrl: "https://beings.town/should-not-fetch.png", ...patch }, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    expect(result.status).toBe("unknown");
    expect(calls.length).toBe(1);
    expect(JSON.stringify([result, changes]).includes("Never trust this stale result")).toBe(false);
  }
  const untagged = harness(async () => stream(turn({ channel: "wechat", status: "connected", detail: "legacy reply" })));
  expect((await untagged.channel.beginChannelConnection(wechat)).status).toBe("unknown");
  let previous: any;
  const reused = harness(async (_, options) => {
    const metadata = previous ?? contract(options);
    previous = metadata;
    return stream(turn({ ...metadata, channel: "wechat", status: "connected", detail: "First request response" }, undefined, options));
  });
  expect((await reused.channel.beginChannelConnection(wechat)).status).toBe("connected");
  expect((await reused.channel.beginChannelConnection(wechat)).status).toBe("unknown");
});

it("channel enrollment runs exactly before sending, stays four-field and cannot permit a stale POST", async () => {
  const ordered: string[] = [];
  const instance = harness(async (_, options) => {
    ordered.push("post");
    return stream(turn({ channel: "wechat", status: "connected", detail: "Confirmed" }, undefined, options));
  }, { onRequest: (record) => { ordered.push("enroll"); expect(record.route).toBe("/desktop/channel/wechat/begin"); } });
  await instance.channel.beginChannelConnection(wechat);
  expect(ordered).toEqual(["enroll", "post"]);
  const stale = harness(undefined, { onRequest: () => stale.channel.reset() });
  await expect(stale.channel.beginChannelConnection(wechat)).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(stale.calls.length).toBe(0);
});

it("correlated JSON fences are parsed and legacy outcome parsing still omits private unknown fields", async () => {
  const { channel, changes } = harness(async (_, options) => stream(turn("```json\n" + JSON.stringify({ ...contract(options), channel: "wechat", status: "connected", detail: "实际服务已连接。" }) + "\n```", undefined, options)));
  const result = await channel.beginChannelConnection(wechat);
  expect(result.status).toBe("connected");
  expect(JSON.stringify([result, changes]).includes("DO_NOT_EXPOSE")).toBe(false);
  const legacy = parseChannelOutcome(JSON.stringify({ channel: "wechat", status: "connected", detail: "Legacy result", secret: "DO_NOT_EXPOSE" }), "wechat", []);
  expect(legacy.status).toBe("connected");
  expect(JSON.stringify(legacy).includes("DO_NOT_EXPOSE")).toBe(false);
});

it("connection credential echoes and credential fields are redacted in structured and prose replies", async () => {
  for (const reply of ["token=unexpected-private app_secret=other-private loom-test-private", { channel: "wechat", status: "unknown", detail: "loom-test-private app_secret=other-private" }]) {
    const { channel, changes } = harness(async (_, options) => stream(turn(reply, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    expect(JSON.stringify([result, changes]).includes("loom-test-private")).toBe(false);
    expect(JSON.stringify([result, changes]).includes("other-private")).toBe(false);
  }
});

it("credential entry rejects locally without reading getters or contacting a server", () => {
  const { channel, calls } = harness();
  expect(() => channel.updateFeishuCredentials({ get appSecret() { throw new Error("must not read"); } })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }) as unknown as Error);
  expect(calls.length).toBe(0);
});

it("strict channel requests reject extra fields, getters, unsupported channels, and stale identity before sending", async () => {
  const { channel, calls } = harness();
  for (const value of [{ ...wechat, prompt: "custom instruction" }, { ...wechat, channel: "wecom" }, { ...wechat, connectionRevision: -1 }, { get channel() { throw new Error("must not read"); }, connectionRevision: 4 }]) {
    expect(() => channel.beginChannelConnection(value)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }) as unknown as Error);
  }
  await expect(channel.beginChannelConnection({ ...wechat, connectionRevision: 3 })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(calls.length).toBe(0);
});

it("duplicate requests are rejected while an HTTP stream is running", async () => {
  const gate = deferred();
  const arrived = deferred();
  const { channel, calls } = harness(async () => { arrived.resolve(); await gate.promise; return stream(turn({ channel: "wechat", status: "pending", detail: "待扫码" })); });
  const first = channel.beginChannelConnection(wechat);
  await arrived.promise;
  await expect(channel.getChannelStatus(feishu)).rejects.toMatchObject({ code: "BUSY" });
  expect(calls.length).toBe(1);
  gate.resolve();
  await first;
});

it("reset aborts pending streams and stale outcomes cannot replace the cleared state", async () => {
  const gate = deferred();
  const arrived = deferred();
  const { channel, calls } = harness(async () => { arrived.resolve(); await gate.promise; return stream(turn({ channel: "wechat", status: "connected", detail: "old reply" })); });
  const pending = channel.beginChannelConnection(wechat);
  await arrived.promise;
  channel.reset();
  expect(calls[0].options.signal!.aborted).toBe(true);
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(channel.state()).toEqual({ channel: "", status: "unknown", detail: "" });
});

it("identity changes without reset are fenced before final results", async () => {
  const gate = deferred();
  const arrived = deferred();
  const { channel, context } = harness(async () => { arrived.resolve(); await gate.promise; return stream(turn({ channel: "wechat", status: "connected", detail: "old reply" })); });
  const pending = channel.beginChannelConnection(wechat);
  await arrived.promise;
  context.identityRevision++;
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(channel.state().status).not.toBe("connected");
});

it("truncated or errored operations report result unknown, retain no sensitive error, and never retry", async () => {
  for (const response of [() => stream(event("content_block_delta", { delta: { text: "connected" } })), () => { throw new Error("secret=do-not-print"); }, () => new Response("secret=do-not-print", { status: 503 })]) {
    const { channel, calls } = harness(async () => response() as Response);
    await expect(channel.beginChannelConnection(wechat)).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
    expect(calls.length).toBe(1);
    expect(JSON.stringify(channel.state()).includes("do-not-print")).toBe(false);
  }
});

it("failed status checks and invalid Loom credentials use distinct fixed errors", async () => {
  const failed = harness(async () => new Response("", { status: 500 }));
  await expect(failed.channel.getChannelStatus(wechat)).rejects.toMatchObject({ code: "SERVICE_ERROR" });
  const expired = harness(async () => new Response("", { status: 401 }));
  await expect(expired.channel.beginChannelConnection(wechat)).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: "连接凭据无效或已过期，请更新 Loom 连接地址。" });
});

it("only bounded raster data URLs are displayed and URL-only QR replies trigger no download", async () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  for (const [qr, expected] of [[png, png], ["data:image/svg+xml;base64,PHN2Zz4=", undefined], ["data:image/png;base64,PHN2Zz4=", undefined], ["https://weixin.qq.com/q/example", undefined]] as [string, string | undefined][]) {
    const { channel, calls } = harness(async (_, options) => stream(turn({ channel: "wechat", status: "pending", detail: "待扫码", qrCodeDataUrl: qr }, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    expect(result.qrCodeDataUrl).toBe(expected);
    expect(channel.state().qrCodeDataUrl, "Returning to the channel must retain its validated QR image").toBe(expected);
    channel.reset();
    expect(channel.state().qrCodeDataUrl, "A new Being must not see the previous QR image").toBeUndefined();
    expect(calls.length).toBe(1);
  }
});

it("documented QR image URLs load without Loom credentials, redirects or cookies", async () => {
  const png = Buffer.from("iVBORw0KGgo=", "base64");
  const { channel, calls } = harness(async (_url, options) => options.method === "GET"
    ? new Response(png, { headers: { "Content-Type": "image/png" } })
    : stream(turn({ channel: "wechat", status: "pending", detail: "待扫码", qrCodeUrl: "https://weixin.qq.com/q/actual-service-image" }, undefined, options)));
  const result = await channel.beginChannelConnection(wechat);
  expect(result.qrCodeDataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
  expect(result.qrCodeUrl).toBeUndefined();
  expect(calls.length).toBe(2);
  const image = calls[1];
  expect(image.options.credentials).toBe("omit");
  expect(image.options.redirect).toBe("error");
  expect(image.options.referrerPolicy).toBe("no-referrer");
  expect(JSON.stringify(image).includes("loom-test-private")).toBe(false);
});

it("private, credential-echo, wrong-domain, and non-HTTPS QR addresses never trigger a fetch", async () => {
  for (const url of ["http://weixin.qq.com/q/test", "https://127.0.0.1/q/test", "https://weixin.qq.com.evil.test/q/test", "https://user@weixin.qq.com/q/test", "https://weixin.qq.com/q/loom-test-private"]) {
    const { channel, calls } = harness(async (_, options) => stream(turn({ channel: "wechat", status: "pending", detail: "待扫码", qrCodeUrl: url }, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    expect(calls.length).toBe(1);
    expect(result.qrCodeUrl).toBeUndefined();
    expect(result.qrCodeDataUrl).toBeUndefined();
  }
});

it("unsafe or oversized QR content does not invalidate an accepted channel operation", async () => {
  for (const image of [() => new Response("<html>", { headers: { "Content-Type": "text/html" } }), () => new Response("bad", { headers: { "Content-Type": "image/png" } }), () => new Response("too big", { headers: { "Content-Type": "image/png", "Content-Length": "9999999" } })]) {
    const { channel } = harness(async (_url, options) => options.method === "GET" ? image() : stream(turn({ channel: "wechat", status: "pending", detail: "已登记", qrCodeUrl: "https://beings.town/actual.png" }, undefined, options)));
    const result = await channel.beginChannelConnection(wechat);
    expect(result.status).toBe("pending");
    expect(result.qrCodeDataUrl).toBeUndefined();
    expect(result.detail).toMatch(/扫码图像暂时无法读取/);
  }
});

it("an accepted or broken first request keeps its allocated channel scene without replay", async () => {
  for (const first of [() => new Response("{}", { status: 202 }), () => { throw new Error("offline"); }]) {
    const f = harness(async (_, options, calls) => calls.length === 1 ? first() as Response : stream(turn({ channel: "wechat", status: "connected", detail: "已核对" }, undefined, options)));
    try { await f.channel.beginChannelConnection(wechat); } catch (error: any) { expect(error.code).toBe("RESULT_UNKNOWN"); }
    expect(f.calls.length).toBe(1);
    await f.channel.getChannelStatus(wechat);
    expect(f.calls.length).toBe(2);
    expect(f.calls[0].body.scene_id).toBe(f.calls[1].body.scene_id);
    expect(f.calls[1].body.message).toMatch(/只读检查/);
  }
});

it("foreign and unscoped replies cannot supply channel results even with matching JSON", async () => {
  for (const scene of ["loom-current", "desktop-another-conversation", ""]) {
    const f = harness(async (_, options) => stream(event("meta", { scene_id: scene }) + turn({ channel: "wechat", status: "connected", detail: "Wrong conversation", ...contract(options) })));
    expect((await f.channel.beginChannelConnection(wechat)).status).toBe("unknown");
  }
  const f = harness(async (_, options) => stream(
    turn({ channel: "wechat", status: "connected", detail: "Channel result" }, undefined, options) +
    event("meta", { scene_id: "loom-current", continuation: true }) +
    turn({ channel: "wechat", status: "error", detail: "Foreign result", ...contract(options) }),
  ));
  const result = await f.channel.beginChannelConnection(wechat);
  expect(result.status).toBe("connected"); expect(result.detail).toBe("Channel result");
});

it("allocated Desktop channel scenes are used directly and a missing session fails before POST", async () => {
  const target = "desktop-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222";
  const f = harness(undefined, { getSession: (channel) => { expect(channel).toBe("wechat"); return { sceneId: target }; } });
  await f.channel.beginChannelConnection(wechat);
  expect(f.calls[0].body.scene_id).toBe(target);
  for (const value of [null, {}, { sceneId: "invalid scene" }]) {
    const missing = harness(undefined, { getSession: () => value as any });
    await expect(missing.channel.beginChannelConnection(wechat)).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(missing.calls.length).toBe(0);
  }
});

it("an identity change without reset does not reuse the previous channel scene", async () => {
  const f = harness();
  await f.channel.beginChannelConnection(wechat);
  f.context.identityRevision++; f.context.beingName = "bob";
  await f.channel.beginChannelConnection(wechat);
  expect(f.calls[0].body.scene_id).not.toBe(f.calls[1].body.scene_id);
});

it("automatic channel inspection reads existing binding without allocating a session or sending a message", async () => {
  let reads = 0;
  const f = harness(undefined, { getSession: () => { throw new Error("Read-only inspection must not allocate a session"); }, readStatus: async ({ signal }) => {
    expect(signal.aborted).toBe(false); reads++; return { channels: [{ channel: "feishu", status: "connected" }] };
  } });
  expect(await f.channel.inspectChannelStatus(feishu)).toEqual({ channels: [{ channel: "feishu", status: "connected" }] });
  expect(reads).toBe(1); expect(f.calls.length).toBe(0); expect(f.requests.length).toBe(0);
  await expect(f.channel.inspectChannelStatus({ ...feishu, extra: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

it("inspection permission errors do not trigger a Being request and reset cancels stale inspection", async () => {
  const denied = harness(undefined, { readStatus: async () => { throw Object.assign(new Error("No status access"), { code: "AUTH_REQUIRED" }); } });
  await expect(denied.channel.inspectChannelStatus(feishu)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(denied.calls.length).toBe(0);
  const gate = deferred(); let signal!: AbortSignal;
  const f = harness(undefined, { readStatus: async (options) => { signal = options.signal; await gate.promise; return { channels: [{ channel: "feishu", status: "connected" }] }; } });
  const pending = f.channel.inspectChannelStatus(feishu); f.channel.reset(); expect(signal.aborted).toBe(true); gate.resolve();
  await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
  expect(f.calls.length).toBe(0);
});
