// Ported from BeingDesktop 0.8.26 test/being-recovery.test.cjs (473 lines, 22 cases);
// 2026-09-16. Fixture data is copied verbatim — only the assertion style changes.
//
// The clock and the timer queue are injected rather than faked globally
// (vi.useFakeTimers): BeingRecovery already takes both as constructor
// parameters, and the live send holds a real `AbortSignal.timeout` that a global
// timer fake would also capture.
//
// The original drove a real ChatStore. The store port is a parallel stage, so
// this file carries a double implementing the four members recovery touches
// (RecoveryStore), with ChatStore's own routing and cursor rules.
import { expect, test } from "vitest";
import { BeingChat, sceneId, sessionFromScene } from "../desktop/main/chat/being-chat";
import { BeingRecovery, CATCH_UP_ABSOLUTE_MAX_MS, STALL_GIVEUP_MS, STALL_MS } from "../desktop/main/chat/recovery";
import type { RecoveryStore, RecoveryTimers } from "../desktop/main/chat/recovery";
import type { ChatContext, HistoryRow } from "../desktop/main/chat/types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sceneA = sceneId(DESKTOP, A), sceneB = sceneId(DESKTOP, B);
const token = "c".repeat(64);

type Responder = (url: URL, options: RequestInit) => Response | Promise<Response>;
const json = (value: unknown, status = 200): Responder => () =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const row = (seq: number, scene: string, content: string, role = "assistant") => ({ seq, role, content, at: "t", scene_id: scene });
const replayEvent = (seq: number, scene: string, text: string) => ({ event: "content_block_delta", seq, data: { scene_id: scene, delta: { text } } });
const stopEvent = (seq: number, scene: string) => ({ event: "message_stop", seq, data: { scene_id: scene } });
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

interface RecoveryEvent { sessionId: string; type: string; text?: string; [key: string]: unknown }

// A stream the test feeds by hand. Aborting the request errors the reader, as a real socket would.
function sse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stream = {
    open: ((url: URL, options: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(c) {
        controller = c;
        options.signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ } });
      } });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as Responder,
    push: (type: string, data: unknown) => controller!.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => { try { controller!.close(); } catch { /* already errored */ } },
    // A reset socket errors the reader; a proxy timing out closes it cleanly. Both happen.
    error: () => { try { controller!.error(new TypeError("socket reset")); } catch { /* already closed */ } },
  };
  return stream;
}

/** ChatStore's routing and cursor rules, reduced to what recovery reads: rows fan
 * out by scene, a scene that names no conversation of ours advances the cursor
 * without being stored, a baseline clears before it loads, and the cursor only
 * moves forward (BeingDesktop src/chat-store.cjs `apply`). */
class TestStore implements RecoveryStore {
  cursor = 0;
  seeded = false;
  private readonly sessions = new Map<string, HistoryRow[]>();
  constructor(private readonly desktopId: string) {}
  rows(sessionId: string): HistoryRow[] { return [...(this.sessions.get(sessionId) ?? [])]; }
  async apply({ rows, cursor, baseline }: { rows: HistoryRow[]; cursor: number; baseline: boolean }) {
    let stored = 0;
    if (baseline) this.sessions.clear();
    for (const entry of rows) {
      const target = sessionFromScene(this.desktopId, entry.scene_id);
      if (!target) continue;
      const list = this.sessions.get(target) ?? [];
      const at = list.findIndex(item => item.seq >= entry.seq);
      if (at < 0) list.push(entry);
      else if (list[at].seq === entry.seq) list[at] = entry;
      else list.splice(at, 0, entry);
      this.sessions.set(target, list);
      stored++;
    }
    if (baseline) this.seeded = true;
    this.cursor = Math.max(this.cursor, cursor);
    return { stored, cursor: this.cursor };
  }
}

function fixture() {
  let now = 1_000_000, id = 0;
  const queue = new Map<number, { at: number; fn: () => unknown }>();
  const timers: RecoveryTimers = {
    setTimeout: (fn, ms) => { const t = ++id; queue.set(t, { at: now + ms, fn }); return t; },
    clearTimeout: t => { queue.delete(t as number); },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    // Let in-flight promise chains register their timers before scanning the queue.
    await settle();
    while (true) {
      const next = [...queue.entries()].filter(([, entry]) => entry.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      queue.delete(next[0]); now = next[1].at;
      await next[1].fn(); await settle();
    }
    now = target; await settle();
  };
  const routes = new Map<string, Responder[]>(), defaults = new Map<string, Responder>();
  const calls: { path: string; after: string | null; body: Record<string, unknown> | null }[] = [];
  const on = (path: string, responder: Responder) => { if (!routes.has(path)) routes.set(path, []); routes.get(path)!.push(responder); };
  const always = (path: string, responder: Responder) => defaults.set(path, responder);
  const fetchImpl = async (url: string, options: RequestInit) => {
    const parsed = new URL(url), path = parsed.pathname.replace(/^\/cz_being/, "");
    calls.push({ path, after: parsed.searchParams.get("after"), body: options.body ? JSON.parse(options.body as string) : null });
    const responder = routes.get(path)?.shift() || defaults.get(path);
    if (!responder) throw new Error(`no route: ${path}`);
    return responder(parsed, options);
  };
  const context: ChatContext = { connected: true, connection: { url: `https://echo.beings.town/cz_being/?token=${token}` }, revision: 1 };
  const chat = new BeingChat({ getContext: () => context, desktopId: DESKTOP, fetchImpl });
  const store = new TestStore(DESKTOP);
  const events: RecoveryEvent[] = [], states: string[] = [];
  const recovery = new BeingRecovery({ chat, store, timers, clock: () => now,
    onEvent: event => { events.push(event as RecoveryEvent); },
    onState: state => { states.push(state.phase + (state.hint ? `:${state.hint}` : "")); } });
  always("/api/history", json({ messages: [] }));
  return { chat, store, recovery, events, states, calls, on, always, advance, pending: () => queue.size, clock: () => now,
    replies: () => events.filter(event => event.type === "reply").map(event => [event.sessionId, event.text]),
    paths: () => calls.map(call => call.path) };
}

test("a live reply that completes is pulled into the store with its seq", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.on("/api/history", json({ messages: [row(1, sceneA, "问", "user"), row(2, sceneA, "答")] }));
  const sending = f.recovery.send({ sessionId: A, text: "问" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("content_block_delta", { scene_id: sceneA, delta: { text: "答" } });
  stream.push("message_stop", { scene_id: sceneA });
  stream.close();
  const result = await sending;
  expect(result.streamed).toBe(true);
  await f.advance(0);
  expect(f.replies()).toEqual([[A, "答"]]);
  expect(f.store.rows(A).map(item => item.seq)).toEqual([1, 2]);
  expect(f.store.cursor).toBe(2);
  expect(f.recovery.state().phase).toBe("idle");
  expect(f.pending()).toBe(0);
});

test("a spliced send watches history until this conversation gets its reply", async () => {
  const f = fixture();
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  f.always("/api/stream/active", json(null, 204));
  // Nothing yet, then another conversation's reply, then ours.
  f.on("/api/history", json({ messages: [] }));
  f.on("/api/history", json({ messages: [row(5, sceneB, "B 的")] }));
  f.on("/api/history", json({ messages: [row(6, sceneA, "A 的")] }));
  const result = await f.recovery.send({ sessionId: A, text: "x" });
  expect(result.streamed).toBe(false); expect(result.spliced).toBe(true);
  expect(f.recovery.state().catchingUp).toBe(true);
  await f.advance(2000);
  expect(f.recovery.state().catchingUp).toBe(true);
  await f.advance(4000);
  // B's reply does not satisfy A's watcher: the wait is per conversation.
  expect(f.recovery.state().catchingUp).toBe(true);
  expect(f.store.rows(B).map(item => item.seq)).toEqual([5]);
  await f.advance(8000);
  expect(f.recovery.state().catchingUp).toBe(false);
  expect(f.store.rows(A).map(item => item.seq)).toEqual([6]);
  expect(f.recovery.state().phase).toBe("idle");
  // Backoff doubled between reads: 2s, 4s, 8s.
  expect(f.calls.filter(call => call.path === "/api/history").length).toBe(3);
});

test("a spliced send takes over the running stream, where its reply surfaces as a continuation", async () => {
  const f = fixture();
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  // Another client's human stream is running; the buffer already holds their text and then ours.
  f.on("/api/stream/active", json({ stream_id: "theirs", finished: false, next_seq: 3, origin: "human", events: [replayEvent(1, "loom-being", "别人的"), stopEvent(2, "loom-being")] }));
  f.on("/api/stream/active", json({ stream_id: "theirs", finished: true, next_seq: 5, origin: "human", events: [replayEvent(3, sceneA, "我们的"), stopEvent(4, sceneA)] }));
  f.on("/api/history", json({ messages: [row(9, sceneA, "我们的")] }));
  await f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  expect(f.recovery.state().replaying).toBe(true);
  await f.advance(500);
  expect(f.replies()).toEqual([[A, "我们的"]]);
  expect(f.recovery.state().replaying).toBe(false);
  await f.advance(0);
  expect(f.store.rows(A).map(item => item.seq)).toEqual([9]);
  expect(f.recovery.state().catchingUp).toBe(false);
});

test("a stream that breaks mid-reply is resumed from the replay buffer without repeating a character", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.on("/api/stream/active", json({ stream_id: "s1", finished: false, next_seq: 4, origin: "human", events: [replayEvent(3, sceneA, "半")] }));
  f.on("/api/stream/active", json({ stream_id: "s1", finished: true, next_seq: 6, origin: "human", events: [replayEvent(4, sceneA, "句"), stopEvent(5, sceneA)] }));
  f.on("/api/history", json({ messages: [row(20, sceneA, "一半句")] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("content_block_delta", { scene_id: sceneA, delta: { text: "一" } });
  stream.push("reasoning", { scene_id: sceneA, text: "thinking" });
  await settle();
  stream.error();
  const result = await sending;
  expect(result.recovering).toBe("probe"); expect(result.liveSeq).toBe(2);
  await settle();
  // The probe resumed after our seq 2, so seq 3 onward is folded in and nothing is repeated.
  expect(f.calls.find(call => call.path === "/api/stream/active")?.after).toBe("2");
  await f.advance(500);
  expect(f.events.filter(event => event.type === "delta").map(event => event.text)).toEqual(["一", "半", "句"]);
  // The router rode along with the pending recovery, so the reply is whole, not the tail.
  expect(f.replies()).toEqual([[A, "一半句"]]);
  await f.advance(0);
  expect(f.store.rows(A).map(item => item.content)).toEqual(["一半句"]);
  expect(f.recovery.state().phase).toBe("idle");
});

test("a clean close that delivered no reply is treated like a splice, not a finished turn", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  // The breath is still running server-side; a proxy closed our socket cleanly.
  f.on("/api/stream/active", json({ stream_id: "s1", finished: true, next_seq: 4, origin: "human", events: [replayEvent(2, sceneA, "全部"), stopEvent(3, sceneA)] }));
  f.on("/api/history", json({ messages: [row(70, sceneA, "全部")] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("reasoning", { scene_id: sceneA, text: "hmm" });
  await settle();
  stream.close();
  const result = await sending;
  expect(result.streamed).toBe(true); expect(result.replies).toBe(0);
  await f.advance(0);
  expect(f.replies()).toEqual([[A, "全部"]]);
  expect(f.store.rows(A).map(item => item.seq)).toEqual([70]);
});

test("a stream that is gone after a break is recovered from history", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.on("/api/stream/active", json(null, 204));
  f.always("/api/stream/active", json(null, 204));
  f.on("/api/history", json({ messages: [row(30, sceneA, "落盘了")] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  await settle();
  stream.error();
  await sending;
  await settle();
  expect(f.store.rows(A).map(item => item.content)).toEqual(["落盘了"]);
  expect(f.recovery.state().phase).toBe("idle");
});

test("an unreachable server keeps the recovery intent and retries with backoff", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.on("/api/stream/active", () => { throw new Error("offline"); });
  f.on("/api/stream/active", () => { throw new Error("offline"); });
  f.on("/api/stream/active", json({ stream_id: "s1", finished: true, next_seq: 3, origin: "human", events: [replayEvent(1, sceneA, "回"), stopEvent(2, sceneA)] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  await settle();
  stream.error();
  await sending;
  await settle();
  expect(f.recovery.state().pending).toBe(true); expect(f.recovery.state().phase).toBe("reconnecting");
  await f.advance(2000);
  expect(f.recovery.state().pending).toBe(true);
  await f.advance(5000);
  expect(f.recovery.state().pending).toBe(false);
  expect(f.replies()).toEqual([[A, "回"]]);
});

test("the watchdog probes instead of aborting, and cuts over when the server has moved on", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.on("/api/stream/active", json({ stream_id: "s1", finished: true, next_seq: 4, origin: "human", events: [replayEvent(2, sceneA, "后半"), stopEvent(3, sceneA)] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("content_block_delta", { scene_id: sceneA, delta: { text: "前半" } });
  await settle();
  // Silence in the text phase for longer than its budget: the socket is dead but the breath is not.
  await f.advance(STALL_MS.text + WATCHDOG);
  const result = await sending;
  expect(result.recovering).toBe("replay");
  await f.advance(0);
  expect(f.events.filter(event => event.type === "delta").map(event => event.text)).toEqual(["前半", "后半"]);
  // The live half and the replayed half join into one bubble: not a character repeated or lost.
  expect(f.replies()).toEqual([[A, "前半后半"]]);
});
const WATCHDOG = 5000;

test("the watchdog respects the slower tool budget", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("tool_use", { scene_id: sceneA, name: "run_command" });
  await settle();
  await f.advance(STALL_MS.text + WATCHDOG * 2);
  // Well past the text budget, still inside the tool budget: no probe was made.
  expect(f.calls.filter(call => call.path === "/api/stream/active").length).toBe(0);
  stream.push("tool_result", { scene_id: sceneA });
  stream.push("content_block_delta", { scene_id: sceneA, delta: { text: "好了" } });
  stream.push("message_stop", { scene_id: sceneA });
  stream.close();
  expect((await sending).streamed).toBe(true);
});

test("a server that has stalled too is waited on with backoff, then given up on", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.always("/api/stream/active", json({ stream_id: "s1", finished: false, next_seq: 1, origin: "human", events: [] }));
  f.on("/api/history", json({ messages: [row(40, sceneA, "最终落盘")] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  await settle();
  await f.advance(STALL_MS.awaiting_first + WATCHDOG);
  expect(f.calls.filter(call => call.path === "/api/stream/active").length).toBe(1);
  expect(f.states.at(-1)).toMatch(/秒后再检查一次/);
  // Probes back off 30s, 60s, 120s rather than hammering a server that has nothing to say:
  // the first probe fired at 75s, so the next is due at 105s, on the tick at 105s.
  await f.advance(24000);
  expect(f.calls.filter(call => call.path === "/api/stream/active").length).toBe(1);
  await f.advance(WATCHDOG);
  expect(f.calls.filter(call => call.path === "/api/stream/active").length).toBe(2);
  await f.advance(STALL_GIVEUP_MS);
  const result = await sending;
  expect(result.gaveUp).toBe(true); expect(result.recovering).toBe("history");
  await settle();
  expect(f.store.rows(A).map(item => item.content)).toEqual(["最终落盘"]);
});

test("a replay poller that keeps failing hands off to the reconnect path", async () => {
  const f = fixture();
  f.on("/api/stream/active", json({ stream_id: "s1", finished: false, next_seq: 2, origin: "human", events: [replayEvent(1, sceneA, "x")] }));
  for (let i = 0; i < 6; i++) f.on("/api/stream/active", () => { throw new Error("offline"); });
  await f.recovery.checkActiveStream();
  expect(f.recovery.state().replaying).toBe(true);
  await f.advance(60000);
  expect(f.recovery.state().replaying).toBe(false);
  expect(f.recovery.state().pending).toBe(true);
});

test("an autonomous breath is watched, not replayed, and reconciled when it ends", async () => {
  const f = fixture();
  f.on("/api/stream/active", json({ stream_id: "auto", finished: false, next_seq: 1, origin: "beating", events: [] }));
  f.on("/api/stream/active", json({ stream_id: "auto", finished: false, next_seq: 1, origin: "beating", events: [] }));
  f.on("/api/stream/active", json(null, 204));
  f.on("/api/history", json({ messages: [row(50, sceneA, "自己想完了")] }));
  expect(await f.recovery.checkActiveStream()).toBe("autonomous");
  expect(f.recovery.state().watching).toBe(true);
  expect(f.states.at(-1)).toMatch(/自己想事情/);
  await f.advance(2000);
  expect(f.recovery.state().watching).toBe(true);
  await f.advance(2000);
  expect(f.recovery.state().watching).toBe(false);
  expect(f.store.rows(A).map(item => item.content)).toEqual(["自己想完了"]);
  expect(f.recovery.state().phase).toBe("idle");
});

test("taking over a stream at startup routes our scenes and drops the rest", async () => {
  const f = fixture();
  f.on("/api/stream/active", json({ stream_id: "s9", finished: true, next_seq: 5, origin: "human",
    events: [replayEvent(1, "loom-being", "别人"), stopEvent(2, "loom-being"), replayEvent(3, sceneB, "B 的"), stopEvent(4, sceneB)] }));
  f.on("/api/history", json({ messages: [row(60, sceneB, "B 的")] }));
  expect(await f.recovery.checkActiveStream()).toBe("cutover");
  await f.advance(0);
  expect(f.replies()).toEqual([[B, "B 的"]]);
  expect(f.store.rows(B).map(item => item.seq)).toEqual([60]);
});

test("cutting over kills a live reader that is still alive (F1)", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  await settle();
  f.recovery.cutoverToReplay({ streamId: "s1", fromSeq: 1, sessionId: A, initial: { verdict: "finished", events: [replayEvent(2, sceneA, "接管"), stopEvent(3, sceneA)] } });
  const result = await sending;
  expect(result.recovering).toBe("replay");
  expect(f.replies()).toEqual([[A, "接管"]]);
  expect(f.recovery.state().live).toBe(false);
});

test("a user who stops reading gets the reply through history, not a probe", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.always("/api/stream/active", json(null, 204));
  const controller = new AbortController();
  const sending = f.recovery.send({ sessionId: A, text: "x", signal: controller.signal });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  await settle();
  controller.abort();
  const result = await sending;
  expect(result.recovering).toBe("catch-up");
  expect(f.recovery.state().catchingUp).toBe(true); expect(f.recovery.state().pending).toBe(false);
});

test("reconcile shares one in-flight read, pages increments and reads a baseline once", async () => {
  const f = fixture();
  f.on("/api/history", json({ messages: Array.from({ length: 100 }, (unused, index) => row(index + 1, sceneA, "x")) }));
  const [one, two] = await Promise.all([f.recovery.reconcile(), f.recovery.reconcile()]);
  expect(one).toBe(two);
  expect(f.calls.filter(call => call.path === "/api/history").length).toBe(1);
  expect(f.store.cursor).toBe(100); expect(f.store.seeded).toBe(true);
  // An increment that fills its page keeps paging from the new cursor.
  f.on("/api/history", json({ messages: Array.from({ length: 100 }, (unused, index) => row(index + 101, sceneA, "y")) }));
  f.on("/api/history", json({ messages: [row(201, sceneB, "z")] }));
  const more = await f.recovery.reconcile();
  expect(more.added).toBe(101); expect(f.store.cursor).toBe(201);
  expect(f.calls.filter(call => call.path === "/api/history").map(call => call.after)).toEqual([null, "100", "200"]);
  expect([...more.beings]).toEqual([A, B]);
});

test("reconcile reports a failed read instead of throwing, and syncCursor retries it", async () => {
  const f = fixture();
  f.on("/api/history", () => { throw new Error("offline"); });
  f.on("/api/history", () => { throw new Error("offline"); });
  f.on("/api/history", json({ messages: [row(1, sceneA, "x")] }));
  const syncing = f.recovery.syncCursor();
  await f.advance(1500);
  const result = await syncing;
  expect(result.error).toBe(""); expect(f.store.cursor).toBe(1);
});

test("the catch-up watcher gives up after its deadline, and says so without blaming anyone", async () => {
  const f = fixture();
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  f.always("/api/stream/active", json(null, 204));
  await f.recovery.send({ sessionId: A, text: "x" });
  await f.advance(CATCH_UP_ABSOLUTE_MAX_MS + 30000);
  expect(f.recovery.state().catchingUp).toBe(false);
  // Silence is a legitimate outcome the wire cannot distinguish from "not yet": neutral copy.
  expect(f.recovery.state()).toEqual({ phase: "idle", sessionId: A, gaveUp: true, hint: "这口气没有留下给这个会话的话。", pending: false, live: false, replaying: false, catchingUp: false, watching: false });
  expect(f.pending()).toBe(0);
});

test("a writer that ends for good settles the bubble it left open", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.always("/api/stream/active", json(null, 204));
  f.on("/api/history", json({ messages: [row(30, sceneA, "一半")] }));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("content_block_delta", { scene_id: sceneA, delta: { text: "一半" } });
  await settle();
  stream.error();
  await sending;
  await settle();
  // The stream is gone, so the half-built reply is settled before history is read, exactly once.
  expect(f.events.filter(event => event.type === "settled").map(event => event.sessionId)).toEqual([A]);
  expect(f.store.rows(A).map(item => item.content)).toEqual(["一半"]);
  expect(f.recovery.state().phase).toBe("idle");
});

test("a takeover from seq 0 settles the pending recovery it abandons", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.on("/api/chat/stream", json({ spliced: true }, 202));
  // A's first probe finds the server unreachable and backs off; B's catch-up probes before that
  // backoff fires, so the whole buffer replays through a fresh router and A's pending is moot.
  f.on("/api/stream/active", () => { throw new Error("offline"); });
  f.on("/api/stream/active", json({ stream_id: "s1", finished: true, next_seq: 6, origin: "human",
    events: [replayEvent(1, sceneA, "一"), replayEvent(2, sceneA, "半句"), stopEvent(3, sceneA), { event: "meta", seq: 0, data: { continuation: true, scene_id: sceneB } }, replayEvent(4, sceneB, "给B"), stopEvent(5, sceneB)] }));
  f.always("/api/stream/active", json(null, 204));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  stream.push("content_block_delta", { scene_id: sceneA, delta: { text: "一" } });
  await settle();
  stream.error();
  expect((await sending).recovering).toBe("probe");
  await settle();
  expect(f.recovery.state().pending).toBe(true);
  await f.recovery.send({ sessionId: B, text: "y" });
  await settle();
  expect(f.recovery.state().pending).toBe(false);
  // A's half bubble is settled before the replay rebuilds it whole; nothing is shown twice.
  expect(f.events.filter(event => ["settled", "reply"].includes(event.type)).map(event => `${event.type}:${event.sessionId === A ? "A" : "B"}:${event.text || ""}`))
    .toEqual(["settled:A:", "reply:A:一半句", "reply:B:给B"]);
  await f.advance(10000);
  expect(f.calls.filter(call => call.path === "/api/stream/active" && call.after === "1").length).toBe(1);
});

test("dispose stops every timer and aborts the live reader", async () => {
  const f = fixture();
  const stream = sse();
  f.on("/api/chat/stream", stream.open);
  f.always("/api/stream/active", json(null, 204));
  const sending = f.recovery.send({ sessionId: A, text: "x" });
  await settle();
  stream.push("meta", { scene_id: sceneA, stream_id: "s1" });
  await settle();
  f.recovery.dispose();
  const result = await sending;
  expect(result.gaveUp).toBe(true);
  expect(f.pending()).toBe(0);
  expect(f.recovery.state().phase).toBe("idle");
});

test("a Being that goes away mid-recovery abandons it quietly", async () => {
  const f = fixture();
  f.on("/api/stream/active", json({}, 403));
  f.recovery.queueDisconnectRecovery({ streamId: "s1", localSeq: 3, sessionId: A });
  await settle();
  expect(f.recovery.state().pending).toBe(false);
  expect(f.recovery.state().phase).toBe("idle");
});
