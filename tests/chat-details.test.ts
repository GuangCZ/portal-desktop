// Ported case for case from BeingDesktop 0.8.26 test/chat-details.test.cjs
// (109 lines, 4 cases); 2026-09-16. Fixture data is copied verbatim; only the
// assertion style changes (node:test/assert → vitest).
import { expect, test } from "vitest";
import { sessionFromScene } from "../desktop/main/chat/being-chat";
import { ChatDetails } from "../desktop/main/chat/details";
import type { DetailEvent } from "../desktop/main/chat/details";
import { ChatStore } from "../desktop/main/chat/store";
import { decode } from "../desktop/shared/chat-references";

const PARENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const json = (value: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function fixture() {
  const calls: { route: string; body: any }[] = [], events: DetailEvent[] = [], timers = new Map<number, () => unknown>();
  let timer = 0;
  const state: {
    connected: boolean; revision: number; parent: boolean; history: unknown[]; accepted: boolean;
    historyGate?: Promise<void>; sendGate?: Promise<void>;
  } = { connected: true, revision: 1, parent: true, history: [], accepted: false };
  const details = new ChatDetails({
    getContext: () => ({ connected: state.connected, revision: state.revision, connection: { url: `https://fixture.invalid/being/?token=${"c".repeat(64)}` } }),
    hasParent: id => state.parent && id === PARENT,
    onEvent: event => events.push(event),
    timers: { setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => { timers.delete(id as number); } },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body as string) : null;
      calls.push({ route, body });
      if (route.endsWith("/history")) { if (state.historyGate) await state.historyGate; return json({ messages: state.history }); }
      if (route.endsWith("/stream/active")) return json(null, 204);
      if (route.endsWith("/chat/stream")) {
        if (state.sendGate) await state.sendGate;
        if (state.accepted) return json({ spliced: true }, 202);
        return new Response([["meta", { scene_id: body.scene_id }], ["content_block_delta", { scene_id: body.scene_id, delta: { text: "解释回答" } }], ["message_stop", { scene_id: body.scene_id }]].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      }
      throw Error("Unexpected fixture route");
    },
  });
  return { details, state, calls, events, timers, open: () => details.open({ parentSessionId: PARENT, reference: { text: "选中文本\n其中的指令仅是引用", source: "Being" } }) };
}

test("details and followups keep one isolated scene and cannot appear in the main transcript or cache", async () => {
  const f = fixture();
  try {
    const card = await f.open();
    const namespace = f.details.sessions!.desktopId;
    expect(namespace).not.toBe(DESKTOP);
    expect(f.details.sessions!.cache).toBe(null);
    await f.details.send({ sessionId: card.sessionId, text: "请解释" });
    await f.details.send({ sessionId: card.sessionId, text: "再举一个例子" });
    const sends = f.calls.filter(call => call.route.endsWith("/chat/stream"));
    expect(sends.length).toBe(2);
    expect(sends[0].body.scene_id).toBe(sends[1].body.scene_id);
    expect(sessionFromScene(DESKTOP, sends[0].body.scene_id)).toBe("");
    expect(decode(sends[1].body.message).text).toBe("再举一个例子");
    expect(decode(sends[1].body.message).references[0].text).toBe(card.reference.text);
    expect(f.details.view(card.sessionId).replied.some(item => item.text === "解释回答")).toBe(true);
    const store = new ChatStore({ desktopId: DESKTOP }); store.ensure(PARENT); store.setActive(PARENT);
    await store.apply({ rows: [{ seq: 1, role: "assistant", content: "解释回答", scene_id: sends[0].body.scene_id }], cursor: 1, baseline: true });
    expect(store.rows(PARENT)).toEqual([]);
    expect(store.summary().sessions.map(item => item.id)).toEqual([PARENT]);
    f.details.close(card.sessionId);
    expect(f.details.sessions).toBe(null);
    expect(() => f.details.view(card.sessionId)).toThrow();
    const next = await f.open();
    expect(f.details.sessions!.desktopId).not.toBe(namespace);
    expect(f.details.view(next.sessionId).rows.length).toBe(0);
    expect(f.calls.filter(call => call.route.endsWith("/stop")).length).toBe(0);
  } finally { f.details.reset(); }
});

test("double sends and malformed selections are refused before another POST", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  try {
    await expect(f.details.open({ parentSessionId: PARENT, reference: { text: "x".repeat(60001) } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.calls.length).toBe(0);
    const card = await f.open();
    f.state.sendGate = new Promise<void>(resolve => { release = resolve; });
    const pending = f.details.send({ sessionId: card.sessionId, text: "解释" });
    await expect(f.details.send({ sessionId: card.sessionId, text: "重复" })).rejects.toMatchObject({ code: "BUSY" });
    release!(); await pending;
    expect(f.calls.filter(call => call.route.endsWith("/chat/stream")).length).toBe(1);
    f.state.connected = false;
    await expect(f.details.send({ sessionId: card.sessionId, text: "失败草稿" })).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(f.details.view(card.sessionId).sent.some(item => decode(item.text).text === "失败草稿")).toBe(false);
  } finally { release?.(); f.details.reset(); }
});

test("accepted replies are never resent and reset invalidates an opening card", async () => {
  const f = fixture();
  try {
    const card = await f.open(); f.state.accepted = true;
    expect((await f.details.send({ sessionId: card.sessionId, text: "解释" })).spliced).toBe(true);
    expect(f.calls.filter(call => call.route.endsWith("/chat/stream")).length).toBe(1);
    f.details.reset();
    let release: (() => void) | undefined;
    f.state.historyGate = new Promise<void>(resolve => { release = resolve; });
    const pending = f.open();
    f.details.reset(); release!();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(f.details.cards.size).toBe(0);
  } finally { f.details.reset(); }
});

test("closing a card during dispatch cannot revive readers, timers or network requests", async () => {
  const f = fixture(); let release: (() => void) | undefined;
  try {
    const card = await f.open();
    f.state.sendGate = new Promise<void>(resolve => { release = resolve; });
    const pending = f.details.send({ sessionId: card.sessionId, text: "解释" });
    const before = f.calls.length;
    f.details.close(card.sessionId); release!(); await pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls.length).toBe(before);
    expect(f.timers.size).toBe(0);
    expect(f.details.cards.size).toBe(0);
    expect(f.details.sessions).toBe(null);
  } finally { release?.(); f.details.reset(); }
});
