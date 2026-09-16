// Ported case for case from BeingDesktop 0.8.26 test/chat-sessions.test.cjs
// (436 lines, 20 cases); 2026-09-16. Fixture data is copied verbatim; only the
// assertion style changes (node:test/assert → vitest).
import { expect, test } from "vitest";
import { sceneId } from "../desktop/main/chat/being-chat";
import { ChatSessions } from "../desktop/main/chat/sessions";
import type { ChatSessionEvent, SessionsSnapshot } from "../desktop/main/chat/sessions";
import { decode, encode } from "../desktop/shared/chat-references";
import type { ChatSnapshot } from "../desktop/main/chat/types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const token = "c".repeat(64);
const json = (value: unknown, status = 200) => () =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const sse = (frames: [string, unknown][]) => () =>
  new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

interface FixtureOptions {
  disk?: ChatSnapshot | null;
  generateTitle?: ((sessionId: string, input: string) => Promise<unknown>) | null;
  titleAvailability?: () => string;
}

function fixture({ disk = null, generateTitle = null, titleAvailability }: FixtureOptions = {}) {
  let now = 1_000_000, id = 0, uuid = 0;
  const queue = new Map<number, { at: number; fn: () => unknown }>();
  const timers = {
    setTimeout: (fn: () => unknown, ms: number) => { const t = ++id; queue.set(t, { at: now + ms, fn }); return t; },
    clearTimeout: (t: unknown) => { queue.delete(t as number); },
  };
  const advance = async (ms: number) => {
    const target = now + ms; await settle();
    for (;;) {
      const next = [...queue.entries()].filter(([, entry]) => entry.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      queue.delete(next[0]); now = next[1].at; await next[1].fn(); await settle();
    }
    now = target; await settle();
  };
  type Responder = (url: URL, options: RequestInit) => Response;
  const routes = new Map<string, Responder[]>(), defaults = new Map<string, Responder>(), calls: { path: string; body: any }[] = [];
  const on = (path: string, responder: Responder) => { if (!routes.has(path)) routes.set(path, []); routes.get(path)!.push(responder); };
  const always = (path: string, responder: Responder) => defaults.set(path, responder);
  const fetchImpl = async (url: string, options: RequestInit) => {
    const parsed = new URL(url), path = parsed.pathname.replace(/^\/cz_being/, "");
    calls.push({ path, body: options.body ? JSON.parse(options.body as string) : null });
    const responder = routes.get(path)?.shift() || defaults.get(path);
    if (!responder) throw new Error(`no route: ${path}`);
    return responder(parsed, options);
  };
  let stored: ChatSnapshot | null = disk; const saves: ChatSnapshot[] = [];
  const cache = { load: async () => stored, save: async (_key: string, value: ChatSnapshot) => { saves.push(value); stored = value; return true; } };
  const context = { connected: true, connection: { url: `https://echo.beings.town/cz_being/?token=${token}` }, revision: 1 };
  const events: ChatSessionEvent[] = [], states: SessionsSnapshot[] = [];
  const sessions = new ChatSessions({
    getContext: () => context, desktopId: DESKTOP, cache, generateTitle, titleAvailability, clientVersion: "0.8.24", fetchImpl, timers, clock: () => now,
    randomUUID: () => `${String(++uuid).padStart(8, "0")}-0000-4000-8000-000000000000`,
    onEvent: event => events.push(event), onState: state => states.push(state),
  });
  always("/api/history", json({ messages: [] }));
  always("/api/stream/active", json(null, 204));
  return { sessions, events, states, calls, on, always, advance, disk: () => stored!, saves };
}

test("selected text travels with the actual message and survives durable history without duplication", async () => {
  const f = fixture();
  try {
    await f.sessions.start("identity-a");
    const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
    const references = [{ text: "完整引用\n第二行", source: "Being" as const }], text = "解释一下";
    f.on("/api/chat/stream", sse([["meta", { scene_id: scene }], ["content_block_delta", { scene_id: scene, delta: { text: "解释" } }], ["message_stop", { scene_id: scene }]]));
    await f.sessions.send({ sessionId: id, text, references });
    await settle();
    const sent = f.calls.find(call => call.path === "/api/chat/stream")!;
    expect(decode(sent.body.message)).toEqual({ text, references });
    f.on("/api/history", json({ messages: [{ seq: 1, role: "user", content: encode(text, references), scene_id: scene }] }));
    await f.sessions.reload();
    expect(f.sessions.view(id).sent.length).toBe(0);
    expect(decode(f.sessions.view(id).rows[0].content)).toEqual({ text, references });
    expect(f.disk().sessions[0].rows[0].content).toBe(encode(text, references));
    const before = f.calls.length;
    await expect(f.sessions.send({ sessionId: id, text, references: [{ text: "x".repeat(60001) }] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.calls.length).toBe(before);
  } finally { f.sessions.end(); }
});

test("starting binds an identity, seeds a first conversation and reads the baseline", async () => {
  const f = fixture();
  f.on("/api/history", json({ messages: [{ seq: 1, role: "user", content: "早", at: "t", scene_id: sceneId(DESKTOP, "00000001-0000-4000-8000-000000000000") }] }));
  const snapshot = await f.sessions.start("identity-a");
  expect(snapshot.open).toBe(true); expect(snapshot.sessions.length).toBe(1); expect(snapshot.active).toBe(snapshot.sessions[0].id);
  expect(snapshot.cursor).toBe(1); expect(snapshot.seeded).toBe(true);
  expect(f.sessions.view(snapshot.active).rows.map(row => row.content)).toEqual(["早"]);
  expect(f.calls.filter(call => call.path === "/api/stream/active").length).toBe(1);
});

test("a sent message shows at once, streams its reply, and both are confirmed by history", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on("/api/chat/stream", sse([["meta", { scene_id: scene, stream_id: "s1" }], ["reasoning", { scene_id: scene, text: "想" }],
    ["content_block_delta", { scene_id: scene, delta: { text: "你好" } }], ["message_stop", { scene_id: scene }]]));
  // History has not caught up yet on the first sync; the confirming rows land on the reload.
  f.on("/api/history", json({ messages: [] }));
  const sending = f.sessions.send({ sessionId: id, text: "在吗" });
  await settle();
  // The body carries the human text, the scene and its label — nothing else.
  const post = f.calls.find(call => call.path === "/api/chat/stream")!.body;
  expect(post).toEqual({ message: "在吗", scene_id: scene, scene_meta: { client: "being-desktop/0.8.24", scene_label: "新会话" }, client_ref: post.client_ref });
  const result = await sending;
  expect(result.streamed).toBe(true);
  await f.advance(0);
  const before = f.sessions.view(id);
  expect(before.sent.map(item => item.text)).toEqual(["在吗"]);
  expect(before.replied.map(item => [item.text, item.think])).toEqual([["你好", "想"]]);
  f.on("/api/history", json({ messages: [{ seq: 5, role: "user", content: "在吗", at: "t", scene_id: scene }, { seq: 6, role: "assistant", content: "你好", at: "t", scene_id: scene }] }));
  await f.sessions.reload();
  const after = f.sessions.view(id);
  // History confirmed both: the transient items retire and the durable rows take their place.
  expect(after.rows.map(row => [row.role, row.content])).toEqual([["user", "在吗"], ["being", "你好"]]);
  expect(after.sent).toEqual([]); expect(after.replied).toEqual([]); expect(after.live).toBe(null);
  expect(f.events.map(event => event.type)).toEqual(["sent", "meta", "think", "delta", "reply"]);
});

test("a live reply is visible while streaming", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  f.on("/api/chat/stream", () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "Content-Type": "text/event-stream" } }));
  const sending = f.sessions.send({ sessionId: id, text: "x" });
  await settle();
  controller.enqueue(new TextEncoder().encode(`event: meta\ndata: ${JSON.stringify({ scene_id: scene, stream_id: "s1" })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ scene_id: scene, delta: { text: "正在" } })}\n\n`));
  await settle();
  expect(f.sessions.view(id).live!.text).toBe("正在");
  expect(f.sessions.snapshot().sessions[0].busy).toBe(true);
  controller.enqueue(new TextEncoder().encode(`event: message_stop\ndata: ${JSON.stringify({ scene_id: scene })}\n\n`));
  controller.close();
  await sending;
  expect(f.sessions.view(id).live).toBe(null);
});

test("a spliced send stays visible as sent and reports it was delivered", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active;
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  const result = await f.sessions.send({ sessionId: id, text: "排队" });
  expect(result).toEqual({ ok: true, streamed: false, spliced: true, recovering: "" });
  expect(f.sessions.view(id).sent.map(item => item.text)).toEqual(["排队"]);
  expect((f.sessions.snapshot().recovery as { catchingUp?: boolean }).catchingUp).toBe(true);
});

test("a send that never left is withdrawn from the transcript", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active;
  f.on("/api/chat/stream", json({}, 500));
  await expect(f.sessions.send({ sessionId: id, text: "没发出去" })).rejects.toMatchObject({ code: "SERVICE_ERROR" });
  expect(f.sessions.view(id).sent).toEqual([]);
});

test("a reply cut off mid-stream stays as a partial until history settles it", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  f.on("/api/chat/stream", () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "Content-Type": "text/event-stream" } }));
  const sending = f.sessions.send({ sessionId: id, text: "x" });
  await settle();
  controller.enqueue(new TextEncoder().encode(`event: meta\ndata: ${JSON.stringify({ scene_id: scene, stream_id: "s1" })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ scene_id: scene, delta: { text: "说到一半的一句很长的话，" } })}\n\n`));
  await settle();
  f.on("/api/history", json({ messages: [{ seq: 5, role: "assistant", content: "说到一半的一句很长的话，后面还有", at: "t", scene_id: scene }] }));
  controller.error(new TypeError("socket reset"));
  await sending;
  await settle();
  // The stream is gone: no cursor blinking forever, the text so far is a partial, and the durable
  // row it is a prefix of confirms it.
  const view = f.sessions.view(id);
  expect(view.live).toBe(null);
  expect(view.replied).toEqual([]);
  expect(view.rows.map(row => row.content)).toEqual(["说到一半的一句很长的话，后面还有"]);
});

test("confirmation tolerates a prefix in either direction, but not a short one", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  await f.sessions.send({ sessionId: id, text: "好" });
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  await f.sessions.send({ sessionId: id, text: "这一条足够长，长到服务端截掉了结尾也认得出来" });
  f.on("/api/history", json({ messages: [
    { seq: 1, role: "user", content: "好的，我知道了", at: "t", scene_id: scene },
    { seq: 2, role: "user", content: "这一条足够长，长到服务端截掉了结尾", at: "t", scene_id: scene }] }));
  await f.sessions.reload();
  // 「好」 is a prefix of row 1 but too short to prove anything; the long one is confirmed by a
  // row that is a prefix of it (the server trimmed the tail).
  expect(f.sessions.view(id).sent.map(item => item.text)).toEqual(["好"]);
});

test("transient items nobody confirms expire instead of lingering", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  await f.sessions.send({ sessionId: id, text: "幽灵" });
  for (let seq = 1; seq <= 3; seq++) {
    f.on("/api/history", json({ messages: [{ seq, role: "assistant", content: `别的 ${seq}`, at: "t", scene_id: scene }] }));
    await f.sessions.reload();
  }
  expect(f.sessions.view(id).sent).toEqual([]);
});

test("a reply that called tools is confirmed by its final text block, and remembers what it followed", async () => {
  const f = fixture();
  f.on("/api/history", json({ messages: [{ seq: 3, role: "user", content: "上一轮", at: "t", scene_id: sceneId(DESKTOP, "00000001-0000-4000-8000-000000000000") }] }));
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  // Measured 2026-09-11: after 「我去翻记忆。」→ remember → 「翻完了…」 the Being stores 「翻完了…」 alone.
  f.on("/api/chat/stream", sse([["meta", { scene_id: scene, stream_id: "s1" }],
    ["content_block_delta", { scene_id: scene, delta: { text: "我去翻记忆。" } }],
    ["tool_use", { scene_id: scene, name: "remember", input: '{"query":"时间线"}' }], ["tool_result", { scene_id: scene, name: "remember" }],
    ["content_block_delta", { scene_id: scene, delta: { text: "翻完了，这次 remember 没有命中，" } }], ["content_block_delta", { scene_id: scene, delta: { text: "只找到旁边的几条。" } }],
    ["message_stop", { scene_id: scene }]]));
  f.on("/api/history", json({ messages: [] }));
  await f.sessions.send({ sessionId: id, text: "回忆一下" });
  await f.advance(0);
  const view = f.sessions.view(id);
  // The whole of what was said stays visible until history speaks; both items follow row 3.
  expect(view.replied.map(item => [item.text, item.final, item.after])).toEqual([["我去翻记忆。翻完了，这次 remember 没有命中，只找到旁边的几条。", "翻完了，这次 remember 没有命中，只找到旁边的几条。", 3]]);
  expect(view.sent.map(item => item.after)).toEqual([3]);
  expect(view.replied[0].at).toBe(new Date(1_000_000).toISOString());
  f.on("/api/history", json({ messages: [{ seq: 3, role: "user", content: "上一轮", at: "t", scene_id: scene }, { seq: 4, role: "user", content: "回忆一下", at: "t", scene_id: scene }, { seq: 7, role: "assistant", content: "翻完了，这次 remember 没有命中，只找到旁边的几条。", at: "t", scene_id: scene }] }));
  await f.sessions.reload();
  expect(f.sessions.view(id).replied).toEqual([]);
  expect(f.sessions.view(id).rows.map(row => row.seq)).toEqual([3, 4, 7]);
});

test("a reply history already holds retires the moment it closes", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  f.on("/api/chat/stream", () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "Content-Type": "text/event-stream" } }));
  const sending = f.sessions.send({ sessionId: id, text: "慢一点" });
  await settle();
  controller.enqueue(new TextEncoder().encode(`event: meta\ndata: ${JSON.stringify({ scene_id: scene, stream_id: "s1" })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ scene_id: scene, delta: { text: "这一句先到了记录里" } })}\n\n`));
  await settle();
  // A read lands the row while the bubble is still open (another window reconciled, say).
  f.on("/api/history", json({ messages: [{ seq: 5, role: "user", content: "慢一点", at: "t", scene_id: scene }, { seq: 6, role: "assistant", content: "这一句先到了记录里", at: "t", scene_id: scene }] }));
  await f.sessions.reload();
  expect(f.sessions.view(id).live!.text).toBe("这一句先到了记录里");
  controller.enqueue(new TextEncoder().encode(`event: message_stop\ndata: ${JSON.stringify({ scene_id: scene })}\n\n`));
  controller.close();
  await sending;
  await f.advance(0);
  // No duplicate bubble under the row, and no wait for the next read.
  expect(f.sessions.view(id).replied).toEqual([]);
  expect(f.sessions.view(id).live).toBe(null);
});

test("expiry counts reads that landed rows, per item, and ignores renames", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  await f.sessions.send({ sessionId: id, text: "幽灵" });
  // Metadata changes are not evidence: the message is still waiting for its row.
  for (const title of ["一", "二", "三"]) f.sessions.rename(id, title);
  await settle();
  expect(f.sessions.view(id).sent.map(item => item.text)).toEqual(["幽灵"]);
  // Neither are reads that land nothing new for this conversation.
  for (let pass = 0; pass < 3; pass++) { f.on("/api/history", json({ messages: [] })); await f.sessions.reload(); }
  expect(f.sessions.view(id).sent.map(item => item.text)).toEqual(["幽灵"]);
  // A neighbour being confirmed no longer gives the ghost another life.
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  await f.sessions.send({ sessionId: id, text: "正常" });
  f.on("/api/history", json({ messages: [{ seq: 1, role: "user", content: "正常", at: "t", scene_id: scene }] }));
  await f.sessions.reload();
  for (let seq = 2; seq <= 3; seq++) {
    f.on("/api/history", json({ messages: [{ seq, role: "assistant", content: `别的 ${seq}`, at: "t", scene_id: scene }] }));
    await f.sessions.reload();
  }
  expect(f.sessions.view(id).sent).toEqual([]);
});

test("conversations are created, selected, renamed and forgotten, and persist", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const first = f.sessions.snapshot().active;
  const second = f.sessions.create({ title: "  第二个  " });
  expect(f.sessions.snapshot().active).toBe(second);
  expect(f.sessions.rename(second, "改名")).toBe(true);
  expect(() => f.sessions.rename(second, "")).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(f.sessions.select(first)).toBe(true);
  expect(() => f.sessions.select("cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(f.sessions.forget(second)).toBe(true);
  expect(f.sessions.snapshot().sessions.map(session => session.id)).toEqual([first]);
  await settle();
  // The list is persisted with the transcripts: a fresh start on the same identity sees it.
  const again = fixture({ disk: f.disk() });
  const snapshot = await again.sessions.start("identity-a");
  expect(snapshot.sessions.map(session => session.id)).toEqual([first]); expect(snapshot.active).toBe(first);
  // Forgetting the last conversation leaves a fresh one rather than an empty list.
  again.sessions.forget(first);
  expect(again.sessions.snapshot().sessions.length).toBe(1);
});

test("stop names the conversation whose breath it refused to interrupt", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const a = f.sessions.snapshot().active, b = f.sessions.create({ title: "乙" });
  f.on("/api/stream/active", json({ stream_id: "s1", finished: false, next_seq: 2, origin: "human", events: [{ event: "reasoning", seq: 1, data: { scene_id: sceneId(DESKTOP, b), text: "x" } }] }));
  const refused = await f.sessions.stop({ sessionId: a });
  expect(refused.stopped).toBe(false); expect(refused.reason).toBe("other-scene"); expect(refused.ownerTitle).toBe("乙");
  f.on("/api/stop", json({ ok: true }));
  expect((await f.sessions.stop({ sessionId: a, force: true })).stopped).toBe(true);
});

test("stopping the binding disposes recovery and forgets everything in memory", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active;
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  await f.sessions.send({ sessionId: id, text: "x" });
  f.sessions.end();
  expect(f.sessions.open).toBe(false);
  expect(() => f.sessions.view(id)).toThrow(expect.objectContaining({ code: "NOT_CONNECTED" }));
  await expect(f.sessions.send({ sessionId: id, text: "x" })).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  expect(f.sessions.snapshot().sessions.length).toBe(0);
});

// Measured 2026-09-11: images reach the Being as content blocks and never come back — history
// holds the text alone. The previews ride the pending item, then move onto the row that confirms it.
test("a message with images is sent as content blocks, and its previews land on the confirming row", async () => {
  const f = fixture();
  // The same words were sent once before, without images: that row must not take the previews.
  f.on("/api/history", json({ messages: [{ seq: 3, role: "user", content: "这是什么？", at: "t", scene_id: sceneId(DESKTOP, "00000001-0000-4000-8000-000000000000") }] }));
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active, scene = sceneId(DESKTOP, id);
  f.on("/api/chat/stream", sse([["meta", { scene_id: scene, stream_id: "s1" }], ["content_block_delta", { scene_id: scene, delta: { text: "黄底绿圆" } }], ["message_stop", { scene_id: scene }]]));
  f.on("/api/history", json({ messages: [] }));
  const data = Buffer.from("png").toString("base64"), thumb = `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`;
  const result = await f.sessions.send({ sessionId: id, text: "这是什么？", images: [{ media_type: "image/png", data, name: "probe.png", thumb }, { media_type: "image/webp", data, thumb: "not a data url" }] });
  expect(result.streamed).toBe(true);
  const post = f.calls.find(call => call.path === "/api/chat/stream")!.body;
  expect(post.content).toEqual([{ type: "text", text: "这是什么？" }, { type: "image", media_type: "image/png", data }, { type: "image", media_type: "image/webp", data }]);
  expect(post.message).toBeUndefined();
  expect(f.events[0]).toEqual({ sessionId: id, type: "sent", text: "这是什么？", images: 2 });
  await f.advance(0);
  const pending = f.sessions.view(id).sent;
  expect(pending.map(item => item.images)).toEqual([[{ media_type: "image/png", name: "probe.png", thumb }, { media_type: "image/webp" }]]);
  // The older row with the same text is not the one: the previews go to the row that landed after.
  f.on("/api/history", json({ messages: [{ seq: 3, role: "user", content: "这是什么？", at: "t", scene_id: scene }, { seq: 5, role: "user", content: "这是什么？", at: "t", scene_id: scene }, { seq: 6, role: "assistant", content: "黄底绿圆", at: "t", scene_id: scene }] }));
  await f.sessions.reload();
  const view = f.sessions.view(id);
  expect(view.sent).toEqual([]); expect(view.replied).toEqual([]);
  expect(view.rows.map(row => [row.seq, row.images ? row.images.length : 0])).toEqual([[3, 0], [5, 2], [6, 0]]);
  expect(f.saves.at(-1)!.sessions[0].rows.find(row => row.seq === 5)!.images![0]).toEqual({ media_type: "image/png", name: "probe.png", thumb });
});

test("images need words with them and stay inside the measured envelope", async () => {
  const f = fixture();
  await f.sessions.start("identity-a");
  const id = f.sessions.snapshot().active;
  const data = Buffer.from("png").toString("base64");
  await expect(f.sessions.send({ sessionId: id, text: "", images: [{ media_type: "image/png", data }] })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "图片需要配一句话一起发送。" });
  await expect(f.sessions.send({ sessionId: id, text: "x", images: [{ media_type: "audio/wav", data }] })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "图片格式仅支持 PNG、JPEG、WebP、GIF。" });
  await expect(f.sessions.send({ sessionId: id, text: "x", images: [{ media_type: "image/png", data: "abc" }] })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "图片数据无效，请重新添加。" });
  const big = Buffer.alloc(6 * 1024 * 1024).toString("base64");
  await expect(f.sessions.send({ sessionId: id, text: "x", images: [{ media_type: "image/png", data: big }, { media_type: "image/png", data: big }] })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "一条消息的图片合计不能超过 10 MB。" });
  await expect(f.sessions.send({ sessionId: id, text: "x", images: Array.from({ length: 9 }, () => ({ media_type: "image/png", data })) })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "一条消息最多 8 张图片。" });
  await expect(f.sessions.send({ sessionId: id, text: "x", images: "nope" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(f.calls.some(call => call.path === "/api/chat/stream")).toBe(false);
  expect(f.sessions.view(id).sent).toEqual([]);
});

test("channel conversations are distinct, durable across restart and never steal selection", async () => {
  const f = fixture();
  try {
    await f.sessions.start("identity-a");
    const active = f.sessions.snapshot().active;
    const wechat = f.sessions.ensureChannel("wechat"), feishu = f.sessions.ensureChannel("feishu");
    expect(wechat.sessionId).not.toBe(feishu.sessionId);
    expect(wechat.sessionId).not.toBe(active);
    expect(f.sessions.ensureChannel("wechat")).toEqual(wechat);
    expect(f.sessions.snapshot().active).toBe(active);
    f.sessions.rename(wechat.sessionId, "我的微信");
    await settle();
    const restored = fixture({ disk: f.disk() });
    try {
      await restored.sessions.start("identity-a");
      expect(restored.sessions.ensureChannel("wechat")).toEqual(wechat);
      expect(restored.sessions.snapshot().sessions.find(s => s.id === wechat.sessionId)!.title).toBe("我的微信");
      expect(restored.sessions.snapshot().active).toBe(active);
    } finally { restored.sessions.end(); }
    const other = fixture();
    try {
      await other.sessions.start("identity-b");
      expect(other.sessions.ensureChannel("wechat").sessionId).not.toBe(wechat.sessionId);
    } finally { other.sessions.end(); }
    expect(() => f.sessions.ensureChannel("unknown")).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  } finally { f.sessions.end(); }
});

test("channel history and replies stay in their own sessions and follow-up sends use the same scene", async () => {
  const f = fixture();
  try {
    await f.sessions.start("identity-a");
    const active = f.sessions.snapshot().active;
    const wechat = f.sessions.ensureChannel("wechat"), feishu = f.sessions.ensureChannel("feishu");
    f.on("/api/history", json({ messages: [
      { seq: 1, role: "user", content: "微信消息", scene_id: wechat.sceneId },
      { seq: 2, role: "assistant", content: "飞书回复", scene_id: feishu.sceneId },
      { seq: 3, role: "assistant", content: "微信回复", scene_id: wechat.sceneId },
      { seq: 4, role: "assistant", content: "主对话回复", scene_id: sceneId(DESKTOP, active) },
      { seq: 5, role: "assistant", content: "其他客户端", scene_id: "loom-foreign" },
    ] }));
    await f.sessions.syncChannel();
    expect(f.sessions.snapshot().active).toBe(active);
    expect(f.sessions.view(wechat.sessionId).rows.map(r => r.content)).toEqual(["微信消息", "微信回复"]);
    expect(f.sessions.view(feishu.sessionId).rows.map(r => r.content)).toEqual(["飞书回复"]);
    expect(f.sessions.view(active).rows.map(r => r.content)).toEqual(["主对话回复"]);
    f.on("/api/chat/stream", sse([
      ["meta", { scene_id: wechat.sceneId }], ["content_block_delta", { scene_id: wechat.sceneId, delta: { text: "微信继续" } }], ["message_stop", { scene_id: wechat.sceneId }],
      ["meta", { scene_id: feishu.sceneId, continuation: true }], ["content_block_delta", { scene_id: feishu.sceneId, delta: { text: "飞书继续" } }], ["message_stop", { scene_id: feishu.sceneId }],
    ]));
    await f.sessions.send({ sessionId: wechat.sessionId, text: "继续" });
    expect(f.calls.find(c => c.path === "/api/chat/stream")!.body.scene_id).toBe(wechat.sceneId);
    expect(f.sessions.view(active).live).toBe(null);
    expect(f.events.some(e => e.type === "reply" && e.sessionId === wechat.sessionId && e.text === "微信继续")).toBe(true);
    expect(f.events.some(e => e.type === "reply" && e.sessionId === feishu.sessionId && e.text === "飞书继续")).toBe(true);
    expect(f.sessions.snapshot().active).toBe(active);
  } finally { f.sessions.end(); }
});

test("native history automatically schedules titles for background sessions without changing the active conversation", async () => {
  const calls: { id: string; input: string }[] = [];
  const f = fixture({ generateTitle: async (id, input) => { calls.push({ id, input }); return "登录流程优化"; }, titleAvailability: () => "worker-v1" });
  try {
    f.on("/api/history", json({ messages: [{ seq: 1, role: "user", content: "优化登录按钮和报错提示", scene_id: sceneId(DESKTOP, "00000001-0000-4000-8000-000000000000") }] }));
    await f.sessions.start("identity-a");
    const first = f.sessions.snapshot().active;
    const active = f.sessions.create();
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(f.sessions.snapshot().active).toBe(active);
    expect(f.sessions.snapshot().sessions.find(s => s.id === first)!.title).toBe("登录流程优化");
    expect(calls.length).toBe(1); expect(calls[0].input).toMatch(/优化登录按钮/);
    expect(f.calls.filter(c => c.path === "/api/chat/stream").length).toBe(0);
  } finally { f.sessions.end(); }
});
