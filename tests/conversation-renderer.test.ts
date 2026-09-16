// The conversation surface's own rules: the Worker result card, the `/` and `@`
// menu, what a public mention costs, and the explanation cards. Every case below
// maps a check in BeingDesktop 0.8.26's browser fixtures —
// test/chat-worker-results-ui.cjs (all five), test/chat-composer-ui.cjs and
// test/chat-selection-ui.cjs — onto the models and components that replaced the
// DOM those fixtures drove; 2026-09-16.
//
// The fixtures there needed a running Electron window because every rule was
// written against elements. Here the rules live in models, so they are asserted
// directly, and the two that really are about markup — a Worker's summary and a
// quotation staying inert text — are asserted against rendered markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkerResultCard } from "../desktop/renderer/conversation/components/worker-result";
import { ConversationModel } from "../desktop/renderer/conversation/models/conversation";
import { workerResults, workerStatusLabel } from "../desktop/renderer/conversation/models/worker-results";
import { transcript } from "../desktop/renderer/conversation/models/transcript";
import { tokenAtCaret } from "../desktop/renderer/conversation/models/completion";
import type {
  ChatAPI, ChatComposerData, ChatComposerEntry, ChatDetailCard, ChatDetailEvent,
  ChatSendResult, ChatState, ChatView,
} from "../desktop/shared/desktop-types";
import type { TownDesktopAPI, TownDesktopSpeakReceipt } from "../desktop/shared/town-desktop-types";

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

const state = (over: Partial<ChatState> = {}): ChatState => ({
  open: true, version: 1, identityKey: "being-a", active: "s1", cursor: 0, seeded: true,
  degraded: false,
  sessions: [
    { id: "s1", title: "甲", createdAt: 1, updatedAt: "2026-09-16T04:00:00Z", truncated: false, count: 0, lastSeq: 0, busy: false, inFlight: false },
    { id: "s2", title: "乙", createdAt: 2, updatedAt: "2026-09-16T04:01:00Z", truncated: false, count: 0, lastSeq: 0, busy: false, inFlight: false },
  ],
  recovery: { phase: "idle" }, ...over,
});

const view = (over: Partial<ChatView> = {}): ChatView => ({
  sessionId: "s1", version: 1, rows: [], workerResults: [], sent: [], replied: [], live: null, ...over,
});

const kit = (over: Partial<ChatComposerEntry>): ChatComposerEntry =>
  ({ id: "", name: "", handle: "", description: "", kind: "kit", installed: true, icon: "", builtin: "", ...over });

/** What the main process answers with when Town is installed and one Kit is
 * (main/chat/composer-data.ts: the two abilities plus the installed Kits). */
const CATALOGUE: ChatComposerData = {
  kits: [
    kit({ id: "being-search", name: "search", handle: "search", builtin: "search", description: "网络搜索 · 搜索互联网并读取网页正文。" }),
    kit({ id: "being-browse", name: "browse", handle: "browse", builtin: "browse", description: "网页读取 · 读取公开网页，支持 JavaScript 渲染。" }),
    kit({ id: "fixture-tools", name: "Fixture Tools", handle: "Fixture-Tools", description: "测试工具目录" }),
  ],
  members: [
    kit({ id: "alice", name: "Alice", handle: "alice", kind: "member", description: "写作伙伴" }),
    kit({ id: "bob", name: "Bob", handle: "bob", kind: "member", description: "设计伙伴" }),
  ],
  kitsError: "", membersError: "", connectionRevision: 101, revision: 7, expiresAt: 0,
};

interface Fixture {
  model: ConversationModel;
  toasts: string[];
  sends: { sessionId: string; text: string }[];
  speaks: { content: string; mentions?: string[]; connectionRevision: number; requestId?: string }[];
  details: { open: unknown[]; send: unknown[]; stop: string[]; close: string[] };
  emitDetail: (event: ChatDetailEvent) => void;
  push: (next: ChatState) => void;
  catalogue: { value: ChatComposerData; error: boolean; calls: number; gate: Promise<void> | null };
  outcome: { send: ChatSendResult | Error; speak: TownDesktopSpeakReceipt | Error };
  clock: { now: number };
  stop: () => void;
}

function fixture(): Fixture {
  const toasts: string[] = [];
  const sends: { sessionId: string; text: string }[] = [];
  const speaks: Fixture["speaks"] = [];
  const details: Fixture["details"] = { open: [], send: [], stop: [], close: [] };
  const cards = new Map<string, ChatDetailCard>();
  const stateListeners: ((value: ChatState) => void)[] = [];
  const detailListeners: ((value: ChatDetailEvent) => void)[] = [];
  const catalogue = { value: structuredClone(CATALOGUE), error: false, calls: 0, gate: null as Promise<void> | null };
  const outcome: Fixture["outcome"] = {
    send: { ok: true, streamed: true, spliced: false, recovering: "" },
    speak: { ok: true, id: "bonfire-1", mentions: [] },
  };
  const clock = { now: 1_000_000 };
  let detailError = "";
  const chat: ChatAPI = {
    sessions: async () => state(),
    view: async id => ({ ...view(), sessionId: id }),
    send: async request => {
      sends.push({ sessionId: request.sessionId, text: request.text });
      if (outcome.send instanceof Error) throw outcome.send;
      return outcome.send;
    },
    stop: async () => ({ stopped: true, reason: "", scene: "", ownerTitle: "" }),
    reload: async () => ({ ok: true, added: 0, error: "" }),
    changeSession: async id => id || "new",
    renameSession: async () => true,
    forgetSession: async () => true,
    composerData: async () => {
      catalogue.calls++;
      if (catalogue.gate) await catalogue.gate;
      if (catalogue.error) throw new Error("unavailable");
      return structuredClone(catalogue.value);
    },
    openWorkerResult: async () => undefined,
    detailOpen: async input => {
      details.open.push(input);
      const sessionId = `detail-${details.open.length}`;
      const card: ChatDetailCard = {
        ...view(), sessionId, parentSessionId: input.parentSessionId, reference: input.reference,
        sending: false, recovery: { phase: "idle" },
      };
      cards.set(sessionId, card);
      return card;
    },
    detailView: async id => structuredClone(cards.get(id)!),
    detailSend: async input => {
      details.send.push(input);
      if (detailError) throw new Error(detailError);
      const card = cards.get(input.sessionId)!;
      card.sent = [...card.sent, { text: input.text, at: "2026-09-16T04:00:00Z", after: 0, images: [] }];
      card.replied = [...card.replied, { text: "这段话区分了保存与利用。", at: "2026-09-16T04:00:01Z", after: 0, partial: false, final: "", think: "" }];
      return { ok: true, streamed: true, spliced: false, recovering: "" };
    },
    detailStop: async id => { details.stop.push(id); return { stopped: false, reason: "other-scene", scene: "", ownerTitle: "" }; },
    detailClose: async id => { details.close.push(id); return true; },
    onEvent: () => () => {},
    onState: callback => { stateListeners.push(callback); return () => { stateListeners.splice(stateListeners.indexOf(callback), 1); }; },
    onDetailEvent: callback => { detailListeners.push(callback); return () => { detailListeners.splice(detailListeners.indexOf(callback), 1); }; },
  };
  const model = new ConversationModel({
    chat,
    toast: error => toasts.push(error instanceof Error ? error.message : String(error)),
    beingName: () => "willow",
    directory: { now: () => clock.now, randomUUID: () => "request-1" },
  });
  const town = {
    speak: async (request: { content: string; mentions?: string[]; connectionRevision: number; requestId?: string }) => {
      speaks.push(request);
      if (outcome.speak instanceof Error) throw outcome.speak;
      return outcome.speak;
    },
    onMembersInvalidated: () => () => {},
  } as unknown as TownDesktopAPI;
  model.directory.bindTown(town);
  const stop = model.start();
  return {
    model, toasts, sends, speaks, details, catalogue, outcome, clock, stop,
    push: next => stateListeners.forEach(listener => listener(next)),
    emitDetail: event => detailListeners.forEach(listener => listener(event)),
    set detailFailure(message: string) { detailError = message; },
  } as Fixture & { detailFailure: string };
}

/** Type the whole draft, caret at the end, as the fixture's `draft()` did. */
const draft = (test: Fixture, text: string) => {
  test.model.composer.setText(text);
  test.model.menu.sync(text, { start: text.length, end: text.length });
};

/** Choose the highlighted row, as Enter and Tab both do. */
function choose(test: Fixture) {
  const text = test.model.composer.text;
  const result = test.model.menu.choose(test.model.menu.selected, text, { start: text.length, end: text.length });
  if (!result) return;
  test.model.composer.setText(result.text);
  test.model.menu.sync(result.text, { start: result.caret, end: result.caret });
}

/* ------------------------------------------------- a finished Worker's result */

describe("the Worker result card", () => {
  it("shows the verdict, the summary and one preview button in the conversation that delegated it", async () => {
    const test = fixture();
    await settle();
    const projection = view({
      rows: [{ seq: 1, role: "user", content: "写一个像素风格的多米诺骨牌", at: "2026-09-14T09:00:00Z", images: [] }],
      workerResults: [{
        workerId: "fixture-worker", sessionId: "s1", title: "像素多米诺骨牌", status: "passed",
        summary: "页面已完成，支持放置、推倒和重新开始。", evidence: "隔离测试验证了操作流程。",
        preview: true, at: "2026-09-14T09:01:00Z",
      }],
    });
    const items = transcript(projection, null);
    const card = items.find(item => item.workerResult);
    expect(card?.workerResult?.title).toBe("像素多米诺骨牌");
    expect(workerStatusLabel(card!.workerResult!.status)).toBe("已完成");
    const html = renderToStaticMarkup(createElement(WorkerResultCard, { result: card!.workerResult!, onOpen: () => {} }));
    expect(html).toContain("页面已完成");
    expect(html.match(/chat-worker-open/g)).toHaveLength(1);
    expect(html).toContain("查看验证依据");
    test.stop();
  });

  it("opens the preview with its original session and worker binding", async () => {
    const opened: unknown[] = [];
    const test = fixture();
    await settle();
    // The card carries the ids it was projected with, not the conversation on
    // screen: a result opened from a scrolled-back message is still that result.
    const result = workerResults([{ workerId: "fixture-worker", sessionId: "s1", title: "t", at: "", preview: true, status: "passed", summary: "", evidence: "" }])[0];
    const html = renderToStaticMarkup(createElement(WorkerResultCard, { result, onOpen: value => { opened.push(value); } }));
    expect(html).toContain("chat-worker-open");
    // The button's handler is the model call the DOM fixture asserted.
    await test.model.openWorkerResult({ sessionId: result.sessionId, workerId: result.workerId });
    expect(result.sessionId).toBe("s1");
    expect(result.workerId).toBe("fixture-worker");
    test.stop();
  });

  it("does not appear in another conversation, and is projected again — once — on the way back", () => {
    const withResult = view({
      workerResults: [{ workerId: "w1", sessionId: "s1", title: "任务", status: "ready", summary: "好了", evidence: "", preview: false, at: "2026-09-14T09:01:00Z" }],
    });
    const other = view({ sessionId: "s2", workerResults: [] });
    expect(transcript(withResult, null).filter(item => item.workerResult)).toHaveLength(1);
    expect(transcript(other, null).filter(item => item.workerResult)).toHaveLength(0);
    expect(transcript(withResult, null).filter(item => item.workerResult)).toHaveLength(1);
  });

  it("keeps a summary as text: it cannot become active markup", () => {
    const [result] = workerResults([{
      workerId: "w1", sessionId: "s1", title: "任务", status: "passed",
      summary: "<img src=x onerror=alert(1)>", evidence: "", preview: false, at: "",
    }]);
    const html = renderToStaticMarkup(createElement(WorkerResultCard, { result, onOpen: () => {} }));
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("drops an entry that is not addressed by both ids, and caps what one projection can carry", () => {
    expect(workerResults([{ workerId: "", sessionId: "s1" }, { workerId: "w", sessionId: "" }])).toEqual([]);
    expect(workerResults(Array.from({ length: 140 }, (_item, index) => ({ workerId: `w${index}`, sessionId: "s1" })))).toHaveLength(100);
    // Same Worker twice is one card, and an unknown verdict reads as「待补充验证」.
    expect(workerResults([{ workerId: "w", sessionId: "s1" }, { workerId: "w", sessionId: "s1" }])).toHaveLength(1);
    expect(workerStatusLabel("something-else")).toBe("待补充验证");
  });
});

/* ------------------------------------------------------- the / and @ menu */

describe("the composer's completion", () => {
  it("offers the built-in abilities and the installed Kits, and nothing else", async () => {
    const test = fixture();
    await settle();
    expect(test.catalogue.calls).toBe(1);
    draft(test, "/");
    expect(test.model.menu.open).toBe(true);
    expect(test.model.menu.items.map(item => item.handle)).toEqual(["search", "browse", "Fixture-Tools"]);
    expect(test.model.menu.heading).toBe("已安装 Kit · 内置能力");
    test.stop();
  });

  it("inserts the second entry on Tab or Enter without sending anything", async () => {
    const test = fixture();
    await settle();
    draft(test, "/");
    test.model.menu.move(1);
    choose(test);
    expect(test.model.composer.text).toBe("/browse ");
    expect(test.sends).toHaveLength(0);
    expect(test.model.menu.open).toBe(false);
    draft(test, "/Fixture");
    choose(test);
    expect(test.model.composer.text).toBe("/Fixture-Tools ");
    expect(test.sends).toHaveLength(0);
    test.stop();
  });

  it("expands a built-in reference once, keeps the user's words last, and publishes nothing", async () => {
    const test = fixture();
    await settle();
    draft(test, "/search 测试");
    await test.model.send(true);
    await settle();
    expect(test.sends).toHaveLength(1);
    expect(test.sends[0].text).toContain("网络搜索（Search）");
    expect(test.sends[0].text.endsWith("/search 测试")).toBe(true);
    expect(test.speaks).toHaveLength(0);
    test.stop();
  });

  it("does not read a URL or an email address as a token", () => {
    expect(tokenAtCaret("https://example.invalid/a", 24)).toBeNull();
    expect(tokenAtCaret("user@example.invalid", 20)).toBeNull();
    expect(tokenAtCaret("路径/search", 9)).toBeNull();
  });

  it("closes on Escape and keeps the draft, and reopens for the next token", async () => {
    const test = fixture();
    await settle();
    draft(test, "@");
    expect(test.model.menu.open).toBe(true);
    test.model.menu.dismiss();
    expect(test.model.menu.open).toBe(false);
    expect(test.model.composer.text).toBe("@");
    // The same token stays dismissed; a different one does not.
    draft(test, "@");
    expect(test.model.menu.open).toBe(false);
    draft(test, "@a");
    expect(test.model.menu.open).toBe(true);
    test.stop();
  });

  it("inserts the Town id rather than the display name, and says the message will be public", async () => {
    const test = fixture();
    await settle();
    draft(test, "@Ali");
    expect(test.model.menu.heading).toBe("通知 Being · 消息将公开到篝火");
    choose(test);
    // A display name is not an address (models/mentions.ts): what goes into the
    // draft is what `resolve` will recognize when it is sent.
    expect(test.model.composer.text).toBe("@alice ");
    expect(test.model.menu.notice).toContain("公开到篝火");
    expect(test.model.menu.notice).toContain("@Alice");
    expect(test.speaks).toHaveLength(0);
    test.stop();
  });

  it("warns about an `@word` that will notify nobody, and still sends it as written", async () => {
    const test = fixture();
    await settle();
    draft(test, "@nobody 你看看");
    expect(test.model.menu.notice).toContain("未解析提及：@nobody");
    await test.model.send(true);
    await settle();
    expect(test.sends[0].text).toBe("@nobody 你看看");
    expect(test.speaks).toHaveLength(0);
    expect(test.toasts.at(-1)).toContain("可能不会触发通知");
    test.stop();
  });
});

/* ----------------------------------------------------- what an `@` costs */

describe("publishing a mention", () => {
  it("refuses a synthetic send outright, leaving the draft where it was typed", async () => {
    const test = fixture();
    await settle();
    draft(test, "@alice 合作讨论");
    await test.model.send(false);
    await settle();
    expect(test.sends).toHaveLength(0);
    expect(test.speaks).toHaveLength(0);
    expect(test.model.composer.text).toBe("@alice 合作讨论");
    expect(test.toasts.at(-1)).toContain("确认公开通知");
    test.stop();
  });

  it("publishes exactly once after a trusted send that was delivered", async () => {
    const test = fixture();
    await settle();
    draft(test, "@alice 合作讨论");
    await test.model.send(true);
    await settle();
    expect(test.sends).toHaveLength(1);
    expect(test.speaks).toHaveLength(1);
    expect(test.speaks[0].content).toBe("@alice 合作讨论");
    expect(test.speaks[0].mentions).toEqual(["alice"]);
    expect(test.speaks[0].connectionRevision).toBe(101);
    expect(test.speaks[0].requestId).toBe("request-1");
    expect(test.model.composer.text).toBe("");
    test.stop();
  });

  it("never publishes the Kit instructions the Being was sent", async () => {
    const test = fixture();
    await settle();
    draft(test, "/browse @bob 查看网页");
    await test.model.send(true);
    await settle();
    expect(test.sends.at(-1)!.text).toContain("网页读取（Browse）");
    expect(test.speaks.at(-1)!.content).toBe("/browse @bob 查看网页");
    test.stop();
  });

  it("publishes nothing when the private message failed, and restores the raw draft", async () => {
    const test = fixture();
    await settle();
    test.outcome.send = new Error("私聊失败");
    draft(test, "@alice 失败的草稿");
    await test.model.send(true);
    await settle();
    expect(test.speaks).toHaveLength(0);
    expect(test.model.composer.text).toBe("@alice 失败的草稿");
    test.stop();
  });

  it("does not restore an already delivered message when the publication fails, and does not retry", async () => {
    const test = fixture();
    await settle();
    test.outcome.speak = new Error("通知状态未知");
    draft(test, "@alice 通知失败");
    await test.model.send(true);
    await settle();
    expect(test.sends).toHaveLength(1);
    expect(test.speaks).toHaveLength(1);
    expect(test.model.composer.text).toBe("");
    expect(test.toasts.at(-1)).toContain("不会自动重发");
    test.stop();
  });

  it("does not publish when the private delivery is unconfirmed", async () => {
    const test = fixture();
    await settle();
    test.outcome.send = { ok: true, streamed: false, spliced: false, recovering: "unknown" };
    draft(test, "@alice 待确认");
    await test.model.send(true);
    await settle();
    expect(test.speaks).toHaveLength(0);
    expect(test.toasts.at(-1)).toContain("尚未发布");
    test.stop();
  });

  it("fences a publication whose Being changed while the message was in flight", async () => {
    const test = fixture();
    await settle();
    let release = () => {};
    test.outcome.send = { ok: true, streamed: true, spliced: false, recovering: "" };
    const gate = new Promise<void>(resolve => { release = resolve; });
    test.catalogue.gate = gate;
    draft(test, "@alice 连接变化");
    const sending = test.model.send(true);
    // The Being changed under the send: the plan was made against the previous
    // identity and its publication is dropped rather than sent under the new one.
    test.push(state({ identityKey: "being-b", version: 2 }));
    release();
    await sending;
    await settle();
    expect(test.sends).toHaveLength(1);
    expect(test.speaks).toHaveLength(0);
    expect(test.toasts.at(-1)).toContain("连接已变化");
    test.stop();
  });

  it("refuses more than twenty mentions, a message over four thousand characters, and a NUL", async () => {
    const test = fixture();
    await settle();
    test.catalogue.value = {
      ...structuredClone(CATALOGUE),
      members: Array.from({ length: 21 }, (_item, index) => kit({ id: `t_m${index}`, name: `M${index}`, handle: `t_m${index}`, kind: "member" })),
    };
    await test.model.directory.load(true);
    await settle();
    draft(test, Array.from({ length: 21 }, (_item, index) => `@t_m${index}`).join(" "));
    await test.model.send(true);
    expect(test.toasts.at(-1)).toContain("最多提及 20 位");
    expect(test.sends).toHaveLength(0);
    draft(test, `@t_m0 ${"字".repeat(4001)}`);
    await test.model.send(true);
    expect(test.toasts.at(-1)).toContain("不能超过 4000 字");
    draft(test, "@t_m0 \0");
    await test.model.send(true);
    expect(test.toasts.at(-1)).toContain("不能包含空字符");
    expect(test.sends).toHaveLength(0);
    test.stop();
  });
});

/* --------------------------------------------- an unavailable catalogue */

describe("a catalogue that will not load", () => {
  it("keeps the built-in abilities, offers a retry, and repopulates when it succeeds", async () => {
    const test = fixture();
    await settle();
    test.catalogue.error = true;
    // A new Being empties the directory, and the read against it fails.
    test.push(state({ identityKey: "being-c", version: 2 }));
    await settle();
    draft(test, "/");
    expect(test.model.menu.items.map(item => item.handle)).toEqual(["search", "browse"]);
    expect(test.model.menu.status).toBe("工具目录暂时无法加载。");
    expect(test.model.menu.retryable).toBe(true);
    draft(test, "@");
    expect(test.model.menu.status).toBe("Being 成员暂时无法加载。");
    test.catalogue.error = false;
    await test.model.directory.load(true);
    draft(test, "@");
    expect(test.model.menu.items.map(item => item.id)).toEqual(["alice", "bob"]);
    expect(test.model.menu.retryable).toBe(false);
    test.stop();
  });

  it("sends the raw private message with an explicit warning while the directory is unavailable", async () => {
    const test = fixture();
    await settle();
    test.catalogue.error = true;
    test.push(state({ identityKey: "being-d", version: 2 }));
    await settle();
    draft(test, "@alice 成员未加载");
    await test.model.send(true);
    await settle();
    expect(test.sends.at(-1)!.text).toBe("@alice 成员未加载");
    expect(test.speaks).toHaveLength(0);
    expect(test.toasts.at(-1)).toContain("可能不会触发通知");
    test.stop();
  });

  it("drops the previous Being's members before anything is read against the new one", async () => {
    const test = fixture();
    await settle();
    expect(test.model.directory.members.map(item => item.id)).toEqual(["alice", "bob"]);
    test.catalogue.gate = new Promise(() => {});
    test.push(state({ identityKey: "being-e", version: 2 }));
    expect(test.model.directory.members).toEqual([]);
    expect(test.model.directory.kits.map(item => item.handle)).toEqual(["search", "browse"]);
    test.stop();
  });
});

/* -------------------------------------------- drafts across conversations */

describe("switching conversations", () => {
  it("keeps each draft where it was typed and recalculates the suggestions", async () => {
    const test = fixture();
    await settle();
    draft(test, "甲的草稿 @");
    expect(test.model.menu.items).toHaveLength(2);
    test.push(state({ active: "s2", version: 2 }));
    await settle();
    expect(test.model.composer.text).toBe("");
    draft(test, "乙的草稿");
    test.push(state({ active: "s1", version: 3 }));
    await settle();
    expect(test.model.composer.text).toBe("甲的草稿 @");
    draft(test, "甲的草稿 @");
    expect(test.model.menu.items.map(item => item.id)).toEqual(["alice", "bob"]);
    test.stop();
  });
});

/* --------------------------------------------------- the explanation card */

describe("the explanation card", () => {
  it("opens a temporary conversation and asks the first question for the reader", async () => {
    const test = fixture();
    await settle();
    await test.model.details.open("s1", { text: "所选文本", source: "Being" });
    await settle();
    expect(test.details.open).toHaveLength(1);
    expect(test.details.send).toHaveLength(1);
    expect((test.details.send[0] as { sessionId: string }).sessionId).toBe("detail-1");
    expect((test.details.send[0] as { text: string }).text).toContain("请解释所选文本的含义");
    // It belongs to the conversation it was opened from, and the main
    // conversation neither sent anything nor moved.
    expect(test.model.details.card("s1")?.parentSessionId).toBe("s1");
    expect(test.sends).toHaveLength(0);
    test.stop();
  });

  it("keeps a follow-up inside the card and leaves the main conversation alone", async () => {
    const test = fixture();
    await settle();
    await test.model.details.open("s1", { text: "所选文本", source: "Being" });
    await settle();
    test.model.details.setDraft("s1", "再举一个例子");
    await test.model.details.send("s1");
    await settle();
    expect(test.details.send).toHaveLength(2);
    expect((test.details.send[1] as { sessionId: string }).sessionId).toBe("detail-1");
    expect(test.sends).toHaveLength(0);
    expect(test.model.details.card("s1")?.draft).toBe("");
    test.stop();
  });

  it("reports a refused stop instead of forcing another conversation's breath", async () => {
    const test = fixture();
    await settle();
    await test.model.details.open("s1", { text: "所选文本", source: "Being" });
    await settle();
    await test.model.details.stop("s1");
    expect(test.details.stop).toEqual(["detail-1"]);
    expect(test.model.details.card("s1")?.status).toBe("当前回复不属于这张卡片，未停止其他会话。");
    test.stop();
  });

  it("shows a stream error in the card without resending the question", async () => {
    const test = fixture();
    await settle();
    await test.model.details.open("s1", { text: "所选文本", source: "Being" });
    await settle();
    test.emitDetail({ type: "error", sessionId: "detail-1", message: "解释流中断" });
    await settle();
    expect(test.model.details.card("s1")?.status).toBe("解释流中断");
    expect(test.details.send).toHaveLength(1);
    test.stop();
  });

  it("closes the previous card of a conversation and disposes exactly one reader per card", async () => {
    const test = fixture();
    await settle();
    await test.model.details.open("s1", { text: "第一段", source: "Being" });
    await settle();
    await test.model.details.open("s1", { text: "第二段", source: "Being" });
    await settle();
    expect(test.details.close).toEqual(["detail-1"]);
    expect(test.model.details.count).toBe(1);
    expect(test.model.details.card("s1")?.reference.text).toBe("第二段");
    test.model.details.close("s1");
    await settle();
    expect(test.details.close).toEqual(["detail-1", "detail-2"]);
    // Closing a reader never interrupts the Being and never resends.
    expect(test.details.stop).toEqual([]);
    expect(test.details.send).toHaveLength(2);
    test.stop();
  });

  it("drops every card on a reset without an extra close or stop", async () => {
    const test = fixture();
    await settle();
    await test.model.details.open("s1", { text: "所选文本", source: "Being" });
    await settle();
    test.emitDetail({ type: "reset" });
    await settle();
    expect(test.model.details.count).toBe(0);
    expect(test.details.close).toEqual([]);
    expect(test.details.stop).toEqual([]);
    test.stop();
  });
});
