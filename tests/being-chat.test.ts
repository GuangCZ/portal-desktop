// Ported from BeingDesktop 0.8.26 test/being-chat.test.cjs (351 lines, 30 cases);
// 2026-09-16. Fixture data is copied verbatim — only the assertion style changes,
// because these fixtures are the measured protocol (docs/desktop-message-layer.md).
import { expect, test } from "vitest";
import {
  BeingChat,
  consumeEvents,
  historyRow,
  imageBlocks,
  imageBytes,
  inScene,
  sceneId,
  sessionFromScene,
} from "../desktop/main/chat/being-chat";
import type { ChatContext, ChatError, ChatEvent, ImageInput, SceneMeta } from "../desktop/main/chat/protocol-types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sceneA = sceneId(DESKTOP, A), sceneB = sceneId(DESKTOP, B);
const token = "c".repeat(64);
const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const sse = (frames: [string, unknown][]) =>
  new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

interface Call { url: URL; options: RequestInit; body: Record<string, unknown> | null }

function fixture(fetchImpl: (url: URL, options: RequestInit) => Promise<Response>) {
  let context: ChatContext = { connected: true, connection: { url: `https://echo.beings.town/cz_being/?token=${token}` }, revision: 1 };
  const calls: Call[] = [], events: ChatEvent[] = [];
  const chat = new BeingChat({
    getContext: () => context, desktopId: DESKTOP, clientVersion: "0.8.24",
    onEvent: event => { events.push(event); },
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options, body: options.body ? JSON.parse(options.body as string) : null });
      return fetchImpl(new URL(url), options);
    },
  });
  return { chat, calls, events, reconnect: () => { context = { ...context, revision: 2 }; } };
}

/** The union's passthrough member has `type: string`, so a plain filter cannot
 * narrow; Extract drops it for any literal type that names one of the others. */
function ofType<T extends string>(events: ChatEvent[], type: T): Extract<ChatEvent, { type: T }>[] {
  return events.filter(event => event.type === type) as Extract<ChatEvent, { type: T }>[];
}
const rejectsCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
function throwsCode(run: () => unknown, code: string) {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect((caught as ChatError | undefined)?.code).toBe(code);
}

test("a conversation is a scene, and the scene names the conversation back", () => {
  expect(sceneA).toBe(`desktop-${DESKTOP}-${A}`);
  expect(sessionFromScene(DESKTOP, sceneA)).toBe(A);
  expect(sessionFromScene(DESKTOP, sceneB)).toBe(B);
  // Another Desktop's scene, the Loom page's own scene, and malformed names are all not ours.
  expect(sessionFromScene(DESKTOP, sceneId(A, B))).toBe("");
  expect(sessionFromScene(DESKTOP, "loom-being")).toBe("");
  expect(sessionFromScene(DESKTOP, `desktop-${DESKTOP}-not-a-uuid`)).toBe("");
  throwsCode(() => sceneId(DESKTOP, "nope"), "INVALID_REQUEST");
});

test("unscoped history rows belong to no conversation, unlike Loom where they pass", () => {
  expect(inScene({ scene_id: sceneA }, sceneA)).toBe(true);
  expect(inScene({ scene_id: sceneB }, sceneA)).toBe(false);
  // Loom admits these; Desktop must not, or every old message shows up in every conversation.
  expect(inScene({}, sceneA)).toBe(false);
  expect(inScene({ from: "system", content: "[breath yielded to human]" }, sceneA)).toBe(false);
  expect(historyRow({ seq: 3, role: "assistant", content: "hi", at: "x", scene_id: sceneA })?.role).toBe("being");
  expect(historyRow({ seq: 0, role: "user", content: "hi" })).toBe(null);
});

test("one timeline read fans out to every conversation and the cursor only moves forward", async () => {
  const rows = [{ seq: 11, role: "user", content: "a?", scene_id: sceneA }, { seq: 13, role: "assistant", content: "b!", scene_id: sceneB },
    { seq: 12, role: "assistant", content: "a!", scene_id: sceneA }, { seq: 14, role: "user", content: "sep", from: "system" }];
  const f = fixture(async () => json({ messages: rows }));
  const page = await f.chat.history({ after: 10, limit: 100 });
  expect(page.rows.map(row => row.seq)).toEqual([11, 12, 13, 14]);
  expect(page.cursor).toBe(14); expect(page.more).toBe(false); expect(page.ignoredAfter).toBe(false);
  expect(f.calls[0].url.searchParams.get("after")).toBe("10");
  // The chat endpoints authenticate by query token; Authorization is rejected with 403 here.
  expect(f.calls[0].url.searchParams.get("token")).toBe(token);
  expect((f.calls[0].options.headers as Record<string, string>).Authorization).toBe(undefined);
  expect(page.rows.filter(row => inScene(row, sceneA)).map(row => row.seq)).toEqual([11, 12]);
  expect(page.rows.filter(row => inScene(row, sceneB)).map(row => row.seq)).toEqual([13]);
});

test("a server that ignores after is reported, never allowed to drag the cursor backwards", async () => {
  const f = fixture(async () => json({ messages: [{ seq: 5, role: "user", content: "old", scene_id: sceneA }] }));
  const page = await f.chat.history({ after: 100 });
  expect(page.rows).toEqual([]); expect(page.cursor).toBe(100); expect(page.ignoredAfter).toBe(true);
  const empty = await fixture(async () => json({ messages: [] })).chat.history({ after: 100 });
  expect(empty.cursor).toBe(100); expect(empty.ignoredAfter).toBe(false);
});

test("the first page omits after and reports more when it fills the limit", async () => {
  const messages = Array.from({ length: 2 }, (unused, index) => ({ seq: index + 1, role: "user", content: "x", scene_id: sceneA }));
  const f = fixture(async () => json({ messages }));
  const page = await f.chat.history({ limit: 2 });
  expect(f.calls[0].url.searchParams.has("after")).toBe(false);
  expect(page.more).toBe(true); expect(page.cursor).toBe(2);
});

test("a send carries only human text, its scene, a declaration and a ref", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1", client_ref: "ignored" }], ["content_block_delta", { scene_id: sceneA, delta: { text: "你好" } }], ["message_stop", { scene_id: sceneA }]]));
  const deltas: string[] = [];
  const result = await f.chat.send({ sessionId: A, text: "在吗", sceneMeta: { scene_label: "会话一" }, onDelta: value => deltas.push(value) });
  expect(Object.keys(f.calls[0].body ?? {}).sort()).toEqual(["client_ref", "message", "scene_id", "scene_meta"]);
  expect(f.calls[0].body?.message).toBe("在吗");
  expect(f.calls[0].body?.scene_id).toBe(sceneA);
  expect(f.calls[0].body?.scene_meta).toEqual({ client: "being-desktop/0.8.24", scene_label: "会话一" });
  expect(f.calls[0].body?.client_ref).toMatch(/^req-/);
  expect(result.streamed).toBe(true); expect(result.replies).toBe(1); expect(result.streamId).toBe("s1");
  expect(deltas).toEqual(["你好"]);
  expect(ofType(f.events, "reply")).toEqual([{ sessionId: A, type: "reply", text: "你好" }]);
});

test("client_ref confirms the stream is ours; a foreign echo does not", async () => {
  const f = fixture(async (url, options) => sse([["meta", { scene_id: sceneA, stream_id: "s1", client_ref: JSON.parse(options.body as string).client_ref }]]));
  expect((await f.chat.send({ sessionId: A, text: "x" })).confirmed).toBe(true);
  const g = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1", client_ref: "req-someone-else" }]]));
  expect((await g.chat.send({ sessionId: A, text: "x" })).confirmed).toBe(false);
});

test("a spliced send is delivered even though it gets no stream of its own", async () => {
  const f = fixture(async () => json({ spliced: true }, 202));
  const result = await f.chat.send({ sessionId: A, text: "x" });
  // Reporting this as a failure would make the user resend and queue a duplicate.
  expect(result.ok).toBe(true); expect(result.streamed).toBe(false); expect(result.spliced).toBe(true);
  expect(f.events).toEqual([{ sessionId: A, type: "spliced", scene: sceneA }]);
  expect(f.chat.inFlight(A)).toBe(false);
});

test("a spliced reply arriving on another conversation stream is routed, not dropped", async () => {
  // Measured live: after A's message_stop, a `continuation` meta handed the connection to B.
  const f = fixture(async () => sse([
    ["meta", { scene_id: sceneA, stream_id: "s1" }],
    ["content_block_delta", { scene_id: sceneA, delta: { text: "A回" } }],
    ["message_stop", { scene_id: sceneA }],
    ["meta", { continuation: true, scene_id: sceneB }],
    ["reasoning", { scene_id: sceneB, text: "想一下" }],
    ["content_block_delta", { scene_id: sceneB, delta: { text: "B回" } }],
    ["message_stop", { scene_id: sceneB }],
  ]));
  const deltas: string[] = [];
  const result = await f.chat.send({ sessionId: A, text: "x", onDelta: value => deltas.push(value) });
  // The caller asked for A, so only A's reply counts as its own and only A's text reaches onDelta.
  expect(result.replies).toBe(1); expect(deltas).toEqual(["A回"]);
  expect(ofType(f.events, "reply")).toEqual([{ sessionId: A, type: "reply", text: "A回" }, { sessionId: B, type: "reply", text: "B回" }]);
  // Reply text is buffered per conversation: B's answer must never land in A's bubble.
  expect(ofType(f.events, "delta")).toEqual([{ sessionId: A, type: "delta", text: "A回" }, { sessionId: B, type: "delta", text: "B回" }]);
  // Thinking is shown live but kept out of the reply text.
  expect(ofType(f.events, "think")).toEqual([{ sessionId: B, type: "think", text: "想一下" }]);
  expect(result.foreign).toBe(0);
});

test("another client scene on the same Being is dropped, and counted", async () => {
  const f = fixture(async () => sse([
    ["meta", { scene_id: sceneA, stream_id: "s1" }],
    ["meta", { continuation: true, scene_id: "loom-being" }],
    ["content_block_delta", { scene_id: "loom-being", delta: { text: "不属于 Desktop" } }],
    ["message_stop", { scene_id: "loom-being" }],
  ]));
  const result = await f.chat.send({ sessionId: A, text: "x" });
  expect(result.replies).toBe(0); expect(result.foreign).toBe(2);
  expect(ofType(f.events, "reply")).toEqual([]);
  // A meta for a foreign scene still reports, so the caller can see the connection was handed away.
  expect(f.events.at(-1)).toEqual({ sessionId: A, type: "meta", streamId: "s1", scene: "loom-being", confirmed: false });
});

test("meta does not consume a seq, so non-meta events stay one to one with the server", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1" }], ["reasoning", { scene_id: sceneA, text: "t" }],
    ["content_block_delta", { scene_id: sceneA, delta: { text: "x" } }], ["meta", { continuation: true, scene_id: sceneA }], ["message_stop", { scene_id: sceneA }]]));
  expect((await f.chat.send({ sessionId: A, text: "x" })).liveSeq).toBe(3);
});

test("a yielded breath emits one bubble per message_stop", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1" }],
    ["content_block_delta", { scene_id: sceneA, delta: { text: "一" } }], ["message_stop", { scene_id: sceneA }],
    ["content_block_delta", { scene_id: sceneA, delta: { text: "二" } }], ["message_stop", { scene_id: sceneA }]]));
  const result = await f.chat.send({ sessionId: A, text: "x" });
  expect(result.replies).toBe(2); expect(result.trailing).toBe("");
  expect(ofType(f.events, "reply").map(event => event.text)).toEqual(["一", "二"]);
});

test("a dispatched send whose stream breaks is never reported as not sent", async () => {
  const f = fixture(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("reset")); } }), { headers: { "Content-Type": "text/event-stream" } }));
  await rejectsCode(f.chat.send({ sessionId: A, text: "x" }), "RESULT_UNKNOWN");
  const g = fixture(async () => { throw new Error("offline"); });
  await rejectsCode(g.chat.send({ sessionId: A, text: "x" }), "NETWORK_ERROR");
  expect(g.calls.length).toBe(1);
});

test("a send refuses malformed input before touching the network", async () => {
  const f = fixture(async () => json({}));
  for (const args of [{ sessionId: "x", text: "y" }, { sessionId: A, text: "   " }, { sessionId: A, text: "a\0b" },
    { sessionId: A, text: "y", sceneMeta: [] as unknown as SceneMeta }]) {
    await rejectsCode(f.chat.send(args), "INVALID_REQUEST");
  }
  expect(f.calls.length).toBe(0);
});

test("reconnecting mid-stream stops reading rather than mixing two timelines", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1" }],
    ["content_block_delta", { scene_id: sceneA, delta: { text: "一" } }], ["content_block_delta", { scene_id: sceneA, delta: { text: "二" } }], ["message_stop", { scene_id: sceneA }]]));
  // The message was already accepted, so the failure must not claim it was never sent.
  await rejectsCode(f.chat.send({ sessionId: A, text: "x", onDelta: () => f.reconnect() }), "RESULT_UNKNOWN");
  expect(ofType(f.events, "delta").map(event => event.text)).toEqual(["一"]);
  expect(ofType(f.events, "reply")).toEqual([]);
});

test("a send cancelled after dispatch reports an unknown result, never a failure", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1" }],
    ["content_block_delta", { scene_id: sceneA, delta: { text: "x" } }], ["content_block_delta", { scene_id: sceneA, delta: { text: "y" } }], ["message_stop", { scene_id: sceneA }]]));
  const controller = new AbortController();
  await rejectsCode(f.chat.send({ sessionId: A, text: "x", signal: controller.signal, onDelta: () => controller.abort() }), "RESULT_UNKNOWN");
  // A send cancelled before dispatch never reached the Being, and says so.
  const g = fixture(async () => sse([]));
  await rejectsCode(g.chat.send({ sessionId: A, text: "x", signal: AbortSignal.abort() }), "ABORTED");
});

test("a probe reads the replay buffer, its scene and where to resume", async () => {
  const f = fixture(async () => json({
    stream_id: "s1", finished: false, next_seq: 4, origin: "human", trigger_message: "问题",
    events: [{ event: "reasoning", seq: 1, data: { scene_id: sceneA, text: "The" } }, { event: "content_block_delta", seq: 2, data: { scene_id: sceneA, delta: { text: "x" } } },
      { event: "reasoning", seq: 3, data: { scene_id: sceneB, text: "now B" } }],
  }));
  const active = await f.chat.probe({ localSeq: 2 });
  expect(active.verdict).toBe("progressing"); expect(active.nextSeq).toBe(4); expect(active.serverSeq).toBe(3); expect(active.streamId).toBe("s1");
  expect(active.origin).toBe("human"); expect(active.autonomous).toBe(false); expect(active.trigger).toBe("问题");
  // Caught up with the server means stalled, not progressing: Loom's watchdog keeps waiting.
  expect((await f.chat.probe({ localSeq: 3 })).verdict).toBe("stalled");
  // Replay events carry scene_id, so recovery fans out exactly like a live stream. The newest
  // event names the conversation currently being spoken to.
  expect(active.scenes).toEqual([sceneA, sceneB]); expect(active.scene).toBe(sceneB);
  expect(active.events.map(event => event.type)).toEqual(["reasoning", "content_block_delta", "reasoning"]);
  expect(active.events.map(event => sessionFromScene(DESKTOP, (event.data as { scene_id: string }).scene_id))).toEqual([A, A, B]);
});

test("a probe distinguishes gone, finished, superseded and autonomous", async () => {
  expect((await fixture(async () => json(null, 204)).chat.probe({})).verdict).toBe("gone");
  expect((await fixture(async () => json({ stream_id: "s1", finished: true, events: [] })).chat.probe({})).verdict).toBe("finished");
  const taken = await fixture(async () => json({ stream_id: "s2", events: [{ event: "reasoning", seq: 1, data: { scene_id: sceneA, text: "x" } }] })).chat.probe({ streamId: "s1" });
  expect(taken.verdict).toBe("superseded"); expect(taken.events).toEqual([]);
  // An autonomous breath has a stream but no events; only waiting and history can follow it.
  const own = await fixture(async () => json({ stream_id: "s3", finished: false, next_seq: 1, origin: "beating", events: [] })).chat.probe({});
  expect(own.autonomous).toBe(true); expect(own.verdict).toBe("stalled"); expect(own.scene).toBe("");
});

test("a probe resumes from after, and the resume point comes from next_seq not the tail", async () => {
  const f = fixture(async () => json({ stream_id: "s1", finished: false, next_seq: 9, origin: "human", events: [{ event: "content_block_delta", seq: 8, data: { scene_id: sceneA, delta: { text: "x" } } }] }));
  const active = await f.chat.probe({ after: 7, localSeq: 7 });
  expect(f.calls[0].url.searchParams.get("after")).toBe("7");
  expect(active.nextSeq).toBe(9); expect(active.serverSeq).toBe(8); expect(active.verdict).toBe("progressing");
  const untold = await fixture(async () => json({ stream_id: "s1", events: [{ event: "reasoning", seq: 8, data: { scene_id: sceneA, text: "x" } }] })).chat.probe({ after: 7 });
  expect(untold.nextSeq).toBe(9);
});

test("a replay buffer is folded in by the same routing as a live stream", async () => {
  const f = fixture(async () => json({}));
  const result = f.chat.replay({ from: 1, events: [
    { type: "reasoning", seq: 1, data: { scene_id: sceneA, text: "already delivered" } },
    { type: "content_block_delta", seq: 2, data: { scene_id: sceneA, delta: { text: "A回" } } },
    { type: "message_stop", seq: 3, data: { scene_id: sceneA } },
    { type: "content_block_delta", seq: 4, data: { scene_id: sceneB, delta: { text: "B回" } } },
    { type: "message_stop", seq: 5, data: { scene_id: sceneB } },
    { type: "content_block_delta", seq: 6, data: { scene_id: "loom-being", delta: { text: "别人的" } } },
  ] });
  expect(result.cursor).toBe(6); expect(result.liveSeq).toBe(5); expect(result.foreign).toBe(1);
  expect(ofType(f.events, "reply")).toEqual([{ sessionId: A, type: "reply", text: "A回" }, { sessionId: B, type: "reply", text: "B回" }]);
  // Nothing at or before `from` is delivered twice.
  expect(ofType(f.events, "think")).toEqual([]);
});

test("stop refuses to interrupt a breath that belongs to another conversation", async () => {
  const active = { stream_id: "s1", finished: false, events: [{ event: "reasoning", seq: 1, data: { scene_id: sceneB, text: "x" } }] };
  const f = fixture(async url => url.pathname.endsWith("/api/stop") ? json({ ok: true }) : json(active));
  const refused = await f.chat.stop({ sessionId: A });
  expect(refused).toEqual({ stopped: false, reason: "other-scene", scene: sceneB });
  expect(f.calls.map(call => call.url.pathname)).toEqual(["/cz_being/api/stream/active"]);
  // Once the user answers the prompt that refusal produces, force stops it.
  expect((await f.chat.stop({ sessionId: A, force: true })).stopped).toBe(true);
  expect(f.calls.at(-1)?.url.pathname).toBe("/cz_being/api/stop");
});

test("stop proceeds for its own breath, and asks when ownership cannot be proven", async () => {
  const mine = { stream_id: "s1", finished: false, events: [{ event: "reasoning", seq: 1, data: { scene_id: sceneA, text: "x" } }] };
  const f = fixture(async url => url.pathname.endsWith("/api/stop") ? json({ ok: true }) : json(mine));
  expect(await f.chat.stop({ sessionId: A })).toEqual({ stopped: true, reason: "matched", scene: sceneA });
  const blind = fixture(async () => json({ stream_id: "s1", finished: false, events: [] }));
  expect(await blind.chat.stop({ sessionId: A })).toEqual({ stopped: false, reason: "unknown", scene: "" });
  expect(blind.calls.map(call => call.url.pathname)).toEqual(["/cz_being/api/stream/active"]);
  const idle = fixture(async () => json(null, 204));
  expect((await idle.chat.stop({ sessionId: A })).reason).toBe("idle");
  const own = fixture(async () => json({ stream_id: "s1", finished: false, origin: "beating", events: [] }));
  expect((await own.chat.stop({ sessionId: A })).reason).toBe("autonomous");
});

test("stop asks when a bubble just closed, because the next speaker may be another scene", async () => {
  // Our message_stop is the last thing in the buffer: a continuation for another conversation may
  // be the very next event, so "our scene" proves nothing about what a stop would interrupt.
  const closed = { stream_id: "s1", finished: false, events: [{ event: "content_block_delta", seq: 1, data: { scene_id: sceneA, delta: { text: "x" } } }, { event: "message_stop", seq: 2, data: { scene_id: sceneA } }] };
  const f = fixture(async () => json(closed));
  expect((await f.chat.probe({})).speaking).toBe(false);
  expect(await f.chat.stop({ sessionId: A })).toEqual({ stopped: false, reason: "unknown", scene: sceneA });
  expect(f.calls.some(call => call.url.pathname.endsWith("/api/stop"))).toBe(false);
  const forced = fixture(async url => url.pathname.endsWith("/api/stop") ? json({ ok: true }) : json(closed));
  expect(await forced.chat.stop({ sessionId: A, force: true })).toEqual({ stopped: true, reason: "forced", scene: sceneA });
});

test("a settled router names the conversations it left mid-bubble, once", () => {
  const f = fixture(async () => json(null, 204));
  const router = f.chat.router({ scene: sceneA, sessionId: A });
  router.handle("meta", { scene_id: sceneA, stream_id: "s1" });
  router.handle("content_block_delta", { scene_id: sceneA, delta: { text: "一半" } });
  router.handle("meta", { continuation: true, scene_id: sceneB });
  router.handle("content_block_delta", { scene_id: sceneB, delta: { text: "完整" } });
  router.handle("message_stop", { scene_id: sceneB });
  expect(router.settle()).toEqual([A]);
  expect(router.settle()).toEqual([]);
  expect(router.state().trailing).toBe("");
});

test("an unreachable Being reports plainly, and a bad token asks to reconnect", async () => {
  await rejectsCode(fixture(async () => json({}, 403)).chat.status(), "AUTH_REQUIRED");
  await rejectsCode(fixture(async () => json({}, 500)).chat.status(), "SERVICE_ERROR");
  await rejectsCode(fixture(async () => new Response("<html>", { headers: { "Content-Type": "text/html" } })).chat.status(), "INVALID_RESPONSE");
  const f = fixture(async () => json({ being_name: "cz_being" }));
  expect(await f.chat.status()).toEqual({ beingName: "cz_being" });
});

test("a disconnected Being never reaches the network", async () => {
  const chat = new BeingChat({ getContext: () => ({ connected: false }), desktopId: DESKTOP, fetchImpl: async () => { throw new Error("should not fetch"); } });
  await rejectsCode(chat.status(), "NOT_CONNECTED");
  await rejectsCode(chat.send({ sessionId: A, text: "x" }), "NOT_CONNECTED");
});

test("the SSE reader rejects an oversized or malformed frame", async () => {
  const seen: [string, unknown][] = [];
  await consumeEvents(new Response('event: a\r\ndata: {"n":1}\r\n\r\n:comment\n\ndata: {"n":2}\n\n').body, (type, data) => seen.push([type, (data as { n: number }).n]));
  expect(seen).toEqual([["a", 1], ["message", 2]]);
  await rejectsCode(consumeEvents(new Response("data: {oops\n\n").body, () => {}), "INVALID_RESPONSE");
});

// Measured 2026-09-11: images travel as content blocks beside the text, the server accepts only
// `text`, `image` and `image_url` blocks (an `audio` block is refused with 422 before anything is
// recorded), a 9.5 MB PNG went through, and history keeps the text alone.
test("images go as content blocks with the text, in place of message", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1" }], ["content_block_delta", { scene_id: sceneA, delta: { text: "黄底绿圆" } }], ["message_stop", { scene_id: sceneA }]]));
  const data = Buffer.from("png-bytes").toString("base64");
  const result = await f.chat.send({ sessionId: A, text: "这是什么？", images: [{ media_type: "image/png", data, name: "ignored.png", thumb: "ignored" }] });
  expect(result.replies).toBe(1);
  const body = f.calls[0].body;
  expect(Object.keys(body ?? {}).sort()).toEqual(["client_ref", "content", "scene_id", "scene_meta"]);
  expect(body?.content).toEqual([{ type: "text", text: "这是什么？" }, { type: "image", media_type: "image/png", data }]);
  // Only the bytes and their type reach the Being; previews and names are the transcript's business.
  expect(JSON.stringify(body).includes("ignored")).toBe(false);
});

test("a send without images keeps the plain message body", async () => {
  const f = fixture(async () => sse([["meta", { scene_id: sceneA, stream_id: "s1" }], ["message_stop", { scene_id: sceneA }]]));
  await f.chat.send({ sessionId: A, text: "在吗", images: [] });
  expect(Object.keys(f.calls[0].body ?? {}).sort()).toEqual(["client_ref", "message", "scene_id", "scene_meta"]);
});

test("images outside the measured envelope are refused before the network", async () => {
  const f = fixture(async () => json({}));
  const data = Buffer.from("png-bytes").toString("base64");
  const big = Buffer.alloc(6 * 1024 * 1024).toString("base64");
  for (const images of [
    "nope", [null], [{ media_type: "image/svg+xml", data }], [{ media_type: "audio/wav", data }], [{ media_type: "image/png", data: "" }],
    [{ media_type: "image/png", data: "not base64!" }], [{ media_type: "image/png", data: "abc" }],
    [{ media_type: "image/png", data: big }, { media_type: "image/png", data: big }],
    Array.from({ length: 9 }, () => ({ media_type: "image/png", data })),
  ]) await rejectsCode(f.chat.send({ sessionId: A, text: "x", images: images as ImageInput[] }), "INVALID_REQUEST");
  // Text is required with images: a block list of images alone lands no row (measured).
  await rejectsCode(f.chat.send({ sessionId: A, text: "  ", images: [{ media_type: "image/png", data }] }), "INVALID_REQUEST");
  expect(f.calls.length).toBe(0);
  expect(imageBytes(big)).toBe(6 * 1024 * 1024);
  expect(imageBlocks([{ media_type: "image/jpeg", data }])).toEqual([{ type: "image", media_type: "image/jpeg", data }]);
});
