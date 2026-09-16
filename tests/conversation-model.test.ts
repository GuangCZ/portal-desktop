// The renderer's conversation layer: its lifecycle, the request generation that
// keeps a late read off the screen, the event stream, and the two actions that
// can refuse (send, stop). Cases follow BeingDesktop 0.8.26 renderer/chat-app.js
// (`setState`, `refresh`, `onEvent`, `send`, `stop`) and renderer/sidebar.js
// (`ordered`, `age`, the three groups); 2026-09-16.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationModel, NOTICE_KEY, keyArg,
} from "../desktop/renderer/conversation/models/conversation";
import { OrganizerModel, age, basename } from "../desktop/renderer/conversation/models/organizer";
import { clock, interleave, transcript } from "../desktop/renderer/conversation/models/transcript";
import type {
  ChatAPI, ChatEventPayload, ChatSessionSummary, ChatState, ChatStopResult, ChatView,
} from "../desktop/shared/desktop-types";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

const summary = (id: string, over: Partial<ChatSessionSummary> = {}): ChatSessionSummary => ({
  id, title: id, createdAt: 1_700_000_000_000, updatedAt: "2026-09-16T04:00:00Z",
  truncated: false, count: 0, lastSeq: 0, busy: false, inFlight: false, ...over,
});

const chatState = (over: Partial<ChatState> = {}): ChatState => ({
  open: true, version: 1, identityKey: "bound", active: "s1", cursor: 0, seeded: true,
  degraded: false, sessions: [summary("s1"), summary("s2")], recovery: { phase: "idle" }, ...over,
});

const projection = (over: Partial<ChatView> = {}): ChatView => ({
  sessionId: "s1", version: 1, rows: [], workerResults: [], sent: [], replied: [], live: null, ...over,
});

function fixture() {
  const toasts: unknown[] = [];
  const calls: { method: string; input: unknown }[] = [];
  const stateListeners: ((state: ChatState) => void)[] = [];
  const eventListeners: ((event: ChatEventPayload) => void)[] = [];
  let released = 0;
  let initial = chatState();
  let nextView: ChatView | ((id: string) => Promise<ChatView>) = projection();
  let stopResult: ChatStopResult = { stopped: true, reason: "", scene: "", ownerTitle: "" };
  let sendResult: { ok: true; streamed: boolean; spliced: boolean; recovering: string } | Error =
    { ok: true, streamed: true, spliced: false, recovering: "" };
  const chat: ChatAPI = {
    sessions: async () => initial,
    view: async (id: string) => {
      calls.push({ method: "view", input: id });
      return typeof nextView === "function" ? nextView(id) : { ...nextView, sessionId: id };
    },
    send: async (request) => {
      calls.push({ method: "send", input: request });
      if (sendResult instanceof Error) throw sendResult;
      return sendResult;
    },
    stop: async (input) => {
      calls.push({ method: "stop", input });
      return stopResult;
    },
    reload: async () => { calls.push({ method: "reload", input: null }); return { ok: true, added: 0, error: "" }; },
    changeSession: async (id) => { calls.push({ method: "changeSession", input: id }); return id || "new-session"; },
    renameSession: async (id, title) => { calls.push({ method: "renameSession", input: { id, title } }); return true; },
    forgetSession: async (id) => { calls.push({ method: "forgetSession", input: id }); return true; },
    composerData: async () => ({ kits: [], members: [], kitsError: "", membersError: "", connectionRevision: 0 }),
    onEvent: callback => { eventListeners.push(callback); return () => { released++; eventListeners.splice(eventListeners.indexOf(callback), 1); }; },
    onState: callback => { stateListeners.push(callback); return () => { released++; stateListeners.splice(stateListeners.indexOf(callback), 1); }; },
  };
  const model = new ConversationModel({
    chat,
    toast: error => toasts.push(error),
    beingName: () => "willow",
    composer: { read: async (file: File) => ({ data: file.name, thumb: "" }), randomUUID: () => "image-1" },
  });
  return {
    model, toasts, calls,
    push: (state: ChatState) => { stateListeners.forEach(listener => listener(state)); },
    emit: (event: ChatEventPayload) => { eventListeners.forEach(listener => listener(event)); },
    set initial(value: ChatState) { initial = value; },
    set view(value: ChatView | ((id: string) => Promise<ChatView>)) { nextView = value; },
    set stop(value: ChatStopResult) { stopResult = value; },
    set send(value: typeof sendResult) { sendResult = value; },
    get listeners() { return stateListeners.length + eventListeners.length; },
    get released() { return released; },
  };
}

beforeEach(() => {
  try { localStorage.removeItem(NOTICE_KEY); } catch { /* Optional preference. */ }
});

describe("the conversation layer", () => {
  it("subscribes to both pushes, reads the list once, and lets go of everything when the page unmounts", async () => {
    const test = fixture();
    const stop = test.model.start();
    expect(test.listeners).toBe(2);
    await settle();
    expect(test.model.sessions.map(item => item.id)).toEqual(["s1", "s2"]);
    expect(test.model.activeId).toBe("s1");
    stop();
    expect(test.released).toBe(2);
    expect(test.listeners).toBe(0);
  });

  it("reads the projection again only when the list says its version moved", async () => {
    const test = fixture();
    test.model.accept(chatState({ version: 4 }));
    await settle();
    test.model.accept(chatState({ version: 4 }));
    await settle();
    expect(test.calls.filter(call => call.method === "view")).toHaveLength(1);
    test.model.accept(chatState({ version: 5 }));
    await settle();
    expect(test.calls.filter(call => call.method === "view")).toHaveLength(2);
  });

  it("drops a projection that a newer read has already superseded", async () => {
    const test = fixture();
    const pending: { id: string; resolve: (view: ChatView) => void }[] = [];
    test.view = (id: string) => new Promise<ChatView>(resolve => pending.push({ id, resolve }));
    test.model.accept(chatState({ version: 1 }));
    test.model.accept(chatState({ version: 2 }));
    await settle();
    expect(pending).toHaveLength(2);
    // The newer read answers first; the older one arrives afterwards and must
    // not put the stale window back on screen.
    pending[1].resolve(projection({ version: 2, rows: [{ seq: 9, role: "being", content: "新的", at: "2026-09-16T04:00:09Z" }] }));
    await settle();
    pending[0].resolve(projection({ version: 1, rows: [{ seq: 1, role: "being", content: "旧的", at: "2026-09-16T04:00:01Z" }] }));
    await settle();
    expect(test.model.view?.rows.map(row => row.content)).toEqual(["新的"]);
  });

  it("drops a projection that answers for the conversation the user has left", async () => {
    const test = fixture();
    const pending: ((view: ChatView) => void)[] = [];
    test.view = () => new Promise<ChatView>(resolve => pending.push(resolve));
    test.model.accept(chatState({ active: "s1", version: 1 }));
    await settle();
    test.model.accept(chatState({ active: "s2", version: 2 }));
    await settle();
    pending[0](projection({ sessionId: "s1", rows: [{ seq: 1, role: "user", content: "给 s1 的", at: "2026-09-16T04:00:01Z" }] }));
    await settle();
    expect(test.model.view).toBe(null);
  });

  it("moves the composer's draft with the active conversation and clears what was on screen", async () => {
    const test = fixture();
    test.model.accept(chatState({ active: "s1" }));
    await settle();
    test.model.composer.setText("给 s1 的草稿");
    test.model.receive({ sessionId: "s1", type: "delta", text: "半句" });
    expect(test.model.live?.text).toBe("半句");
    test.model.accept(chatState({ active: "s2", version: 2 }));
    expect(test.model.live).toBe(null);
    expect(test.model.activity).toBe(null);
    expect(test.model.composer.text).toBe("");
    test.model.accept(chatState({ active: "s1", version: 3 }));
    expect(test.model.composer.text).toBe("给 s1 的草稿");
  });

  it("accumulates the reply as it arrives and keeps reasoning out of the body", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.receive({ sessionId: "s1", type: "think", text: "先想想" });
    test.model.receive({ sessionId: "s1", type: "delta", text: "你好" });
    test.model.receive({ sessionId: "s1", type: "delta", text: "，我在" });
    test.model.receive({ sessionId: "s2", type: "delta", text: "别的会话" });
    expect(test.model.live).toMatchObject({ text: "你好，我在", think: "先想想" });
    const live = test.model.items.at(-1)!;
    expect(live.live).toBe(true);
    expect(live.text).toBe("你好，我在");
    expect(live.think).toBe("先想想");
  });

  it("shows the tool the Being is using, and marks the one that failed", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.receive({ sessionId: "s1", type: "tool_use", data: { name: "search_web", input: { query: "小镇" } } });
    expect(test.model.activity?.current).toEqual({ label: "在搜索", arg: "小镇", done: false, error: false });
    test.model.receive({ sessionId: "s1", type: "tool_result", data: { is_error: true } });
    expect(test.model.activity?.log).toEqual([{ label: "在搜索", arg: "小镇", done: true, error: true }]);
    expect(test.model.activity?.current?.error).toBe(true);
  });

  it("forgets the live bubble when the reply closes and reads the durable rows instead", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.receive({ sessionId: "s1", type: "delta", text: "你好" });
    test.view = projection({ version: 2, rows: [{ seq: 7, role: "being", content: "你好", at: "2026-09-16T04:00:07Z" }] });
    test.model.receive({ sessionId: "s1", type: "reply", text: "你好" });
    await settle();
    expect(test.model.live).toBe(null);
    expect(test.model.activity).toBe(null);
    expect(test.model.items.map(item => item.text)).toEqual(["你好"]);
    expect(test.model.items[0].live).toBeFalsy();
  });

  it("names the tool argument worth showing, whatever shape the call came in", () => {
    expect(keyArg('{"query":"小镇是什么"}')).toBe("小镇是什么");
    expect(keyArg({ file_path: "/home/me/notes/today.md" })).toBe("today.md");
    expect(keyArg({ url: "https://beings.town/bonfire" })).toBe("beings.town");
    expect(keyArg({ url: "not a url at all, just a long line of text that runs on" })).toBe("not a url at all, just a long line of t…");
    expect(keyArg({ url: "still not a url" })).toBe("still not a url");
    expect(keyArg("not json")).toBe("");
    expect(keyArg({ nothing: 3, something: "有" })).toBe("有");
  });

  it("says what the recovery machine is doing, and never puts another conversation's hint under this one", async () => {
    const test = fixture();
    test.model.accept(chatState({ recovery: { phase: "streaming" } }));
    expect(test.model.status).toBe("Being 正在回复…");
    test.model.accept(chatState({ version: 2, recovery: { phase: "catching-up", sessionId: "s2", hint: "s2 的提示" } }));
    expect(test.model.status).toBe("消息已送达，Being 正在处理其他会话，等它回到这里…");
    test.model.accept(chatState({ version: 3, recovery: { phase: "reconnecting", sessionId: "s1", hint: "第 2 次重连" } }));
    expect(test.model.status).toBe("第 2 次重连");
    test.model.accept(chatState({ version: 4, degraded: true, recovery: { phase: "idle" } }));
    expect(test.model.status).toBe("本机未加密，记录仅保留在内存");
    test.model.accept(chatState({ version: 5, degraded: true, recovery: { phase: "streaming" } }));
    expect(test.model.status).toBe("Being 正在回复… · 本机未加密，记录仅保留在内存");
    test.model.accept(chatState({ version: 6, open: false }));
    expect(test.model.status).toBe("尚未连接");
    expect(test.model.disabled).toBe(true);
    await settle();
  });

  it("lights the stop button while our reader is up and hides it when nothing is running", async () => {
    const test = fixture();
    test.model.accept(chatState());
    expect(test.model.stopVisible).toBe(false);
    expect(test.model.waiting).toBe(false);
    test.model.accept(chatState({ version: 2, sessions: [summary("s1", { inFlight: true }), summary("s2")] }));
    expect(test.model.stopVisible).toBe(true);
    expect(test.model.waiting).toBe(true);
    // The phase leads `inFlight` by one broadcast, so it counts on its own.
    test.model.accept(chatState({ version: 3, recovery: { phase: "replaying", sessionId: "s1" } }));
    expect(test.model.stopVisible).toBe(true);
    expect(test.model.waiting).toBe(true);
    // A breath belonging to another conversation is not ours to wait for.
    test.model.accept(chatState({ version: 4, recovery: { phase: "streaming", sessionId: "s2" } }));
    expect(test.model.waiting).toBe(false);
    await settle();
  });

  it("sends what the composer holds, empties it, and shows the Being at work at once", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.composer.setText("在吗");
    test.model.composer.addReference({ text: "这段话", source: "Being" });
    await test.model.composer.addFiles([new File([new Uint8Array(8)], "a.png", { type: "image/png" })]);
    await test.model.send();
    expect(test.calls.find(call => call.method === "send")?.input).toEqual({
      sessionId: "s1", text: "在吗",
      references: [{ text: "这段话", source: "Being" }],
      images: [{ name: "a.png", media_type: "image/png", data: "a.png", thumb: "" }],
    });
    expect(test.model.composer.text).toBe("");
    expect(test.model.composer.images).toEqual([]);
    expect(test.model.composer.references).toEqual([]);
    expect(test.model.waiting).toBe(true);
    expect(test.toasts).toEqual([]);
  });

  it("leaves references and images out of the request when there are none", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.composer.setText("在吗");
    await test.model.send();
    expect(test.calls.find(call => call.method === "send")?.input).toEqual({ sessionId: "s1", text: "在吗" });
  });

  it("says a message joined the breath already running rather than claiming it was answered", async () => {
    const test = fixture();
    test.send = { ok: true, streamed: false, spliced: true, recovering: "" };
    test.model.accept(chatState());
    await settle();
    test.model.composer.setText("在吗");
    await test.model.send();
    expect(test.toasts).toEqual(["消息已送达，Being 正在处理其他会话，回复稍后到达。"]);
  });

  it("puts a refused message back and stops claiming the Being is at work", async () => {
    const test = fixture();
    test.send = Object.assign(new Error("请先连接 Being。"), { code: "NOT_CONNECTED" });
    test.model.accept(chatState());
    await settle();
    test.model.composer.setText("在吗");
    test.model.composer.addReference({ text: "这段话", source: "you" });
    await test.model.send();
    expect(test.model.composer.text).toBe("在吗");
    expect(test.model.composer.references).toEqual([{ text: "这段话", source: "you" }]);
    expect(test.model.waiting).toBe(false);
    expect(test.toasts).toHaveLength(1);
  });

  it("refuses to send what cannot be sent, without reaching the network", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    await test.model.send();
    expect(test.calls.some(call => call.method === "send")).toBe(false);
    expect(test.toasts).toEqual([]);
    await test.model.composer.addFiles([new File([new Uint8Array(8)], "a.png", { type: "image/png" })]);
    await test.model.send();
    expect(test.calls.some(call => call.method === "send")).toBe(false);
    expect(test.toasts).toEqual(["给图片配一句话再发送。"]);
  });

  it("asks before stopping a reply that belongs to another conversation, then retries with force", async () => {
    const test = fixture();
    test.stop = { stopped: false, reason: "other-scene", scene: "desktop:s2", ownerTitle: "昨天的事" };
    test.model.accept(chatState());
    await settle();
    const stopping = test.model.stop();
    await settle();
    expect(test.model.confirm?.message).toBe("Being 正在回复的是「昨天的事」，不是这个会话。要停止那边的回复吗？");
    test.model.confirm!.resolve(true);
    await stopping;
    expect(test.calls.filter(call => call.method === "stop").map(call => call.input)).toEqual([
      { sessionId: "s1" }, { sessionId: "s1", force: true },
    ]);
  });

  it("does not force a stop the user declined", async () => {
    const test = fixture();
    test.stop = { stopped: false, reason: "other-scene", scene: "desktop:s2", ownerTitle: "" };
    test.model.accept(chatState());
    await settle();
    const stopping = test.model.stop();
    await settle();
    expect(test.model.confirm?.message).toBe("Being 正在回复的是另一个会话，不是这个会话。要停止那边的回复吗？");
    test.model.confirm!.resolve(false);
    await stopping;
    expect(test.calls.filter(call => call.method === "stop")).toHaveLength(1);
    expect(test.model.confirm).toBe(null);
    expect(test.model.stopping).toBe(false);
  });

  it("explains a stop it cannot attribute", async () => {
    const test = fixture();
    test.stop = { stopped: false, reason: "unknown", scene: "", ownerTitle: "昨天的事" };
    test.model.accept(chatState());
    await settle();
    const stopping = test.model.stop();
    await settle();
    expect(test.model.confirm?.message).toBe("刚说完的是「昨天的事」，接下来轮到谁还不确定。仍要停止当前这口气吗？");
    test.model.confirm!.resolve(false);
    await stopping;
    test.stop = { stopped: false, reason: "unknown", scene: "", ownerTitle: "" };
    const second = test.model.stop();
    await settle();
    expect(test.model.confirm?.message).toBe("无法确认 Being 正在回复哪个会话。仍要停止当前这口气吗？");
    test.model.confirm!.resolve(false);
    await second;
  });

  it("says nothing was stopped when the Being was only thinking to itself, or doing nothing at all", async () => {
    const test = fixture();
    test.stop = { stopped: false, reason: "autonomous", scene: "", ownerTitle: "" };
    test.model.accept(chatState());
    await settle();
    await test.model.stop();
    test.stop = { stopped: false, reason: "idle", scene: "", ownerTitle: "" };
    await test.model.stop();
    expect(test.toasts).toEqual([
      "Being 正在自己思考，没有属于会话的回复可以停止。",
      "当前没有正在进行的回复。",
    ]);
    expect(test.model.confirm).toBe(null);
  });

  it("offers the questions the search panel looks through", async () => {
    const test = fixture();
    test.view = projection({
      rows: [
        { seq: 1, role: "user", content: "小镇是什么？", at: "2026-09-16T04:00:01Z" },
        { seq: 2, role: "being", content: "小镇是…", at: "2026-09-16T04:00:02Z" },
        { seq: 3, role: "user", content: "   ", at: "2026-09-16T04:00:03Z" },
        { seq: 4, role: "user", content: "好".repeat(300), at: "2026-09-16T04:00:04Z" },
      ],
    });
    test.model.accept(chatState());
    await settle();
    const questions = test.model.questions();
    expect(questions.map(item => item.id)).toEqual(["row-1", "row-4"]);
    expect(questions[1].text).toHaveLength(240);
  });

  it("holds on to the row the search panel jumped to until the highlight is done", () => {
    const test = fixture();
    test.model.accept(chatState());
    test.model.jump("row-4");
    expect(test.model.jumpTo).toBe("row-4");
    test.model.jumped();
    expect(test.model.jumpTo).toBe("");
    // Letting go twice is not a change, so it cannot loop a re-render.
    const version = test.model.getVersion();
    test.model.jumped();
    expect(test.model.getVersion()).toBe(version);
  });

  it("stops pointing at a row once the conversation changes under it", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.jump("row-4");
    test.model.accept(chatState({ active: "s2", version: 2 }));
    expect(test.model.jumpTo).toBe("");
  });

  it("remembers that the one-time explanation was dismissed", () => {
    const store = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      },
    });
    try {
      const test = fixture();
      test.model.accept(chatState());
      expect(test.model.noticeVisible).toBe(true);
      test.model.dismissNotice();
      expect(test.model.noticeVisible).toBe(false);
      expect(store.get(NOTICE_KEY)).toBe("1");
      expect(fixture().model.noticeDismissed).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("still closes the explanation when this browser refuses to remember anything", () => {
    // The vitest environment has a `localStorage` whose methods are missing,
    // which is the same shape as a private window with site data blocked.
    const test = fixture();
    test.model.accept(chatState());
    expect(test.model.noticeVisible).toBe(true);
    test.model.dismissNotice();
    expect(test.model.noticeVisible).toBe(false);
  });

  it("does nothing at all when the page was not opened by the desktop client", async () => {
    const model = new ConversationModel({ chat: undefined, toast: vi.fn(), beingName: () => "" });
    const stop = model.start();
    stop();
    await model.send();
    await model.stop();
    await model.reload();
    expect(await model.create()).toBe("");
    expect(await model.rename("s1", "x")).toBe(false);
    expect(await model.forget("s1")).toBe(false);
    expect(model.beingName).toBe("being");
  });

  it("puts a quotation into an empty draft and refuses to overwrite one the user is writing", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    expect(test.model.placeDraft("一起看看这段：\n\n> 引用")).toBe(true);
    expect(test.model.composer.text).toBe("一起看看这段：\n\n> 引用");
    expect(test.model.placeDraft("另一段")).toBe(false);
    expect(test.model.composer.text).toBe("一起看看这段：\n\n> 引用");
    test.model.composer.setText("   ");
    expect(test.model.placeDraft("第三段")).toBe(true);
    // Nothing to type into: no conversation is open.
    test.model.accept(chatState({ version: 9, open: false }));
    expect(test.model.placeDraft("第四段")).toBe(false);
  });

  it("files a new conversation into the project it was created in", async () => {
    const test = fixture();
    expect(await test.model.create()).toBe("new-session");
    expect(test.calls.find(call => call.method === "changeSession")?.input).toBe(null);
  });

  it("forgets a conversation's draft and sidebar metadata along with the conversation", async () => {
    const test = fixture();
    test.model.accept(chatState());
    await settle();
    test.model.composer.setText("给 s1 的草稿");
    test.model.organizer.pin("s1");
    expect(await test.model.forget("s1")).toBe(true);
    expect(test.model.organizer.metadata("s1").pinned).toBe(false);
    expect(test.model.composer.text).toBe("");
  });
});

describe("the transcript", () => {
  const rows = [
    { seq: 1, role: "user" as const, content: "一", at: "2026-09-16T04:00:00Z" },
    { seq: 2, role: "being" as const, content: "二", at: "2026-09-16T04:00:30Z" },
  ];

  it("places an unconfirmed item after what it followed, not under whatever landed later", () => {
    // `after: 1` was made when only row 1 existed, so it belongs between the two
    // rows even though its clock says otherwise.
    const placed = interleave(rows, [{ at: "2026-09-16T03:59:00Z", after: 1, text: "暂存" }]);
    expect(placed.map(item => ("content" in item ? item.content : item.text))).toEqual(["一", "暂存", "二"]);
  });

  it("orders the whole projection: rows, what was sent, what was replied, then the live reply", () => {
    const items = transcript(
      {
        sessionId: "s1", version: 1, rows, workerResults: [],
        sent: [{ text: "三", at: "2026-09-16T04:01:00Z", after: 2 }],
        replied: [{ text: "四", final: "四", think: "", at: "2026-09-16T04:01:10Z", after: 2, partial: true }],
        live: null,
      },
      { text: "五", think: "", at: "2026-09-16T04:01:20Z" },
    );
    expect(items.map(item => item.text)).toEqual(["一", "二", "三", "四", "五"]);
    expect(items.map(item => item.id)).toEqual(["row-1", "row-2", "sent-0", "replied-0", "live"]);
    expect(items[3].partial).toBe(true);
    expect(items[4].live).toBe(true);
  });

  it("groups one speaker's consecutive messages and draws a divider after a long silence", () => {
    const items = transcript({
      sessionId: "s1", version: 1, workerResults: [], sent: [], replied: [], live: null,
      rows: [
        { seq: 1, role: "being", content: "一", at: "2026-09-16T04:00:00Z" },
        { seq: 2, role: "being", content: "二", at: "2026-09-16T04:00:30Z" },
        { seq: 3, role: "being", content: "三", at: "2026-09-16T04:02:00Z" },
        { seq: 4, role: "being", content: "四", at: "2026-09-16T04:30:00Z" },
      ],
    }, null);
    expect(items.map(item => item.consecutive)).toEqual([false, true, false, false]);
    // The divider is anchored to the last thing said before the silence, and is
    // drawn in the reader's own clock — hence `clock` rather than a literal.
    expect(items.map(item => item.gap)).toEqual([undefined, undefined, undefined, `— ${clock("2026-09-16T04:02:00Z")} —`]);
    expect(clock("2026-09-16T04:02:00Z")).toMatch(/^\d{2}:\d{2}:00$/);
    expect(clock("not a time")).toBe("");
    expect(clock(undefined)).toBe("");
  });

  it("keeps an unconfirmed bubble's own meta line even when it follows the same speaker", () => {
    const items = transcript({
      sessionId: "s1", version: 1, workerResults: [], replied: [], live: null,
      rows: [{ seq: 1, role: "user", content: "一", at: "2026-09-16T04:00:00Z" }],
      sent: [{ text: "二", at: "2026-09-16T04:00:10Z", after: 1 }],
    }, null);
    expect(items.map(item => item.consecutive)).toEqual([false, false]);
    expect(items[1].pending).toBe(true);
  });
});

describe("the sidebar's arrangement", () => {
  const list = [
    summary("old", { updatedAt: "2026-09-16T03:00:00Z" }),
    summary("new", { updatedAt: "2026-09-16T05:00:00Z" }),
    summary("same-a", { updatedAt: "2026-09-16T04:00:00Z" }),
    summary("same-b", { updatedAt: "2026-09-16T04:00:00Z" }),
  ];

  it("orders conversations by their newest message and leaves ties where they were", () => {
    const organizer = new OrganizerModel();
    expect(organizer.ordered(list).map(item => item.id)).toEqual(["new", "same-a", "same-b", "old"]);
  });

  it("falls back to a never-spoken-in conversation's creation time", () => {
    const organizer = new OrganizerModel();
    const fresh = summary("fresh", { updatedAt: 0 as unknown as number, createdAt: Date.parse("2026-09-16T06:00:00Z") });
    expect(organizer.ordered([...list, fresh])[0].id).toBe("fresh");
  });

  it("says how long ago a conversation last spoke", () => {
    const now = Date.parse("2026-09-16T05:00:00Z");
    expect(age(summary("a", { updatedAt: "2026-09-16T04:59:40Z" }), now)).toBe("刚刚");
    expect(age(summary("a", { updatedAt: "2026-09-16T04:30:00Z" }), now)).toBe("30分");
    expect(age(summary("a", { updatedAt: "2026-09-16T02:00:00Z" }), now)).toBe("3时");
    expect(age(summary("a", { updatedAt: "2026-09-13T05:00:00Z" }), now)).toBe("3天");
    expect(age(summary("a", { updatedAt: "", createdAt: 0 }), now)).toBe("");
  });

  it("splits the list into pinned, project and standalone, and keeps archived out of all three", () => {
    const organizer = new OrganizerModel();
    organizer.setProjects(["/home/me/work"]);
    organizer.pin("new");
    organizer.move("same-a", "/home/me/work");
    organizer.archive("old");
    const groups = organizer.groups(list);
    expect(groups.pinned.map(item => item.id)).toEqual(["new"]);
    expect(groups.projects[0]).toMatchObject({ name: "work", path: "/home/me/work" });
    expect(groups.projects[0].sessions.map(item => item.id)).toEqual(["same-a"]);
    expect(groups.standalone.map(item => item.id)).toEqual(["same-b"]);
  });

  it("finds an archived conversation only in the archived category", () => {
    const organizer = new OrganizerModel();
    organizer.archive("old");
    expect(organizer.search(list, "", "active").map(item => item.id)).toEqual(["new", "same-a", "same-b"]);
    expect(organizer.search(list, "", "archived").map(item => item.id)).toEqual(["old"]);
    expect(organizer.search(list, "OLD", "archived").map(item => item.id)).toEqual(["old"]);
    organizer.archive("old");
    expect(organizer.search(list, "", "archived")).toEqual([]);
  });

  it("matches a conversation by the project it is filed under", () => {
    const organizer = new OrganizerModel();
    organizer.setProjects(["/home/me/work"]);
    organizer.move("same-a", "/home/me/work");
    expect(organizer.search(list, "work", "active").map(item => item.id)).toEqual(["same-a"]);
    expect(basename("/home/me/work/")).toBe("work");
    expect(basename("")).toBe("项目");
  });

  it("takes a conversation out of a project without touching the project", () => {
    const organizer = new OrganizerModel();
    organizer.setProjects(["/home/me/work"]);
    organizer.move("same-a", "/home/me/work");
    organizer.move("same-a", "");
    expect(organizer.groups(list).projects[0].sessions).toEqual([]);
    expect(organizer.projects).toEqual(["/home/me/work"]);
  });
});
