// The three families of BeingDesktop 0.8.26 test/town-conversation-ui.cjs that
// integration unit I1 left behind (docs/migration/i1-town.md 遗留 3, repeated as
// docs/migration/i7-channel-drafts.md 未做 4): the fireside-switch race, the draft
// that must survive what happens around it, and the background-collection status
// strip. Ported 2026-09-17 (integration unit IT).
//
// They live at the model layer because that is where the rules live in this
// shell: BeingDesktop drives one long-lived DOM through `beingTownApp.open()` and
// asserts on `.ta-message` nodes, while here `TownModel` owns every one of those
// decisions and React only prints them. The four rules that genuinely need a real
// window — draft caret, focus, list scroll position, and the rendered strip — are
// in tests/town-ui.mjs instead, and the file header there names them.
//
// Each case below carries the BeingDesktop check it came from, verbatim.
import { describe, expect, it, vi } from "vitest";
import { TownModel } from "../desktop/renderer/town/models/town";
import { refreshLabel } from "../desktop/renderer/town/page";
import { SceneStore } from "../desktop/renderer/shared/models/scene";
import type { DesktopAPI } from "../desktop/shared/types";
import type {
  TownDesktopAPI,
  TownDesktopAppState,
  TownDesktopClientState,
  TownDesktopEnvelope,
  TownDesktopIdentity,
  TownDesktopMessage,
  TownDesktopReadResult,
  TownDesktopRefreshStatus,
  TownDesktopRoomDirectory,
  TownDesktopTimeline,
} from "../desktop/shared/desktop-types";
import type { ModelSettingsState } from "../desktop/shared/model-settings-types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const refreshStatus = (overrides: Partial<TownDesktopRefreshStatus> = {}): TownDesktopRefreshStatus => ({
  status: "idle", reason: "", intervalMs: 60000, nextRefreshAt: null, lastAttemptAt: null,
  lastCheckedAt: null, lastSuccessAt: null, revision: null, stale: false, errorCode: "",
  failureCount: 0, running: true, ...overrides,
});
const identity = (overrides: Partial<TownDesktopIdentity> = {}): TownDesktopIdentity => ({
  beingId: "willow", loomBeingId: "willow", townId: "t_Willow", displayName: "柳树",
  sendAs: "t_Willow", connectionRevision: 1, identityRevision: 1, ...overrides,
});
const clientState = (overrides: Partial<TownDesktopClientState> = {}): TownDesktopClientState => ({
  status: "connected", paired: true, beingId: "willow", loomBeingId: "willow", townId: "t_Willow",
  displayName: "柳树", errorCode: "", authReason: "", pairingPending: false, pairErrorCode: "", ...overrides,
});
const appState = (overrides: Partial<TownDesktopAppState> = {}): TownDesktopAppState => ({
  identity: identity(), access: {}, accessDetail: {},
  bonfire: { status: "ready", detail: "" }, fireside: { status: "ready", detail: "" },
  scroll: { status: "ready", detail: "" }, beings: { status: "ready", detail: "" },
  inbox: { status: "ready", detail: "" }, sync: { bonfire: null, fireside: null },
  client: clientState(), pairing: { status: "idle", busy: false, errorCode: "" },
  memberDirectory: { revision: 1, expiresAt: 0 }, ...overrides,
});
const message = (id: string, content: string): TownDesktopMessage => ({
  id, beingId: "t_River", beingName: "河流", content,
  createdAt: "2026-09-12T00:00:00Z", revisedAt: "", mentions: [],
});
const envelope = (
  messages: TownDesktopMessage[],
  overrides: { kind?: string; firesideId?: string; status?: Partial<TownDesktopRefreshStatus>; snapshot?: Partial<TownDesktopTimeline> } = {},
): TownDesktopEnvelope => ({
  kind: overrides.kind || "bonfire",
  firesideId: overrides.firesideId || "",
  snapshot: {
    identity: { connectionRevision: 1 }, messages, latestSeq: Number(messages.at(-1)?.id) || null,
    total: messages.length, hasOlder: false, lastRefresh: null, ...overrides.snapshot,
  },
  status: refreshStatus(overrides.status),
});
const rooms: TownDesktopRoomDirectory = {
  owned: [{ id: 1, name: "设计小组" }], joined: [{ id: 2, name: "研究小组" }], cached: false,
};
const modelSettings = (configured: boolean | null): ModelSettingsState => ({
  connected: true, connectionId: 1,
  runtime: {
    configStatus: "connected", configError: "", configCheckedAt: null,
    model: "fixture", provider: "fixture", baseUrl: "https://fixture.invalid",
    sideBySide: { configured, active: null },
  },
});

/** The Town page with Town replaced by explicit answers. `reads` records every
 * `beings:town-read` the model issued, in order, exactly as BeingDesktop's
 * `fixture.calls.reads` did. */
function harness(townOverrides: Partial<TownDesktopAPI> = {}, apiOverrides: Record<string, unknown> = {}) {
  const reads: TownDesktopReadResult[] extends never ? never : { kind: string; firesideId?: string }[] = [];
  const stops: unknown[] = [];
  const on = (callback: unknown) => { stops.push(callback); return () => {}; };
  const town = {
    appState: vi.fn(async () => appState()),
    refreshApp: vi.fn(async () => appState()),
    // A cache miss: a fresh profile has nothing on disk, and that is the path
    // that has to reach the read.
    timeline: vi.fn(async () => { throw Object.assign(new Error("尚无本机缓存"), { code: "STORAGE_ERROR" }); }),
    refreshTimeline: vi.fn(async () => envelope([])),
    loadOlder: vi.fn(async () => envelope([])),
    read: vi.fn(async (request: { kind: string; firesideId?: string }): Promise<TownDesktopReadResult> => {
      reads.push({ kind: request.kind, ...(request.firesideId ? { firesideId: request.firesideId } : {}) });
      return request.kind === "fireside" && !request.firesideId
        ? { rooms }
        : { envelope: envelope([], { kind: request.kind, firesideId: request.firesideId }) };
    }),
    firesides: vi.fn(async () => rooms),
    firesideMembers: vi.fn(async () => ({ members: [] })),
    speak: vi.fn(async () => ({ ok: true as const, id: "1" })),
    inbox: vi.fn(async () => ({ messages: [] })),
    members: vi.fn(async () => ({ members: [], revision: 1, expiresAt: 0 })),
    cached: vi.fn(async () => ({ cached: false, data: null, lastSuccessAt: null })),
    onState: on, onMessages: on, onMembersInvalidated: on,
    ...townOverrides,
  } as unknown as TownDesktopAPI;
  const api = { townDesktop: town, ...apiOverrides } as unknown as DesktopAPI;
  const model = new TownModel(api, vi.fn(), vi.fn(), new SceneStore(), vi.fn(), vi.fn());
  model.receiveState(appState());
  return { model, town, reads };
}

/** Open the fireside page and settle on the first ring, the way the sidebar does. */
async function openFiresides(model: TownModel) {
  model.show("firesides");
  await settle();
  await settle();
  await settle();
}

describe("Town conversation rules ported from BeingDesktop test/town-conversation-ui.cjs", () => {
  // ── the fireside switch race ───────────────────────────────────────────────

  // 「switching rooms requests the new target even while the previous room read
  //   is pending」
  it("switching rings asks for the new ring even while the previous ring's read is still pending", async () => {
    const held = deferred<TownDesktopReadResult>();
    const asked: { kind: string; firesideId?: string }[] = [];
    const { model } = harness({
      read: vi.fn(async (request: { kind: string; firesideId?: string }) => {
        asked.push({ kind: request.kind, ...(request.firesideId ? { firesideId: request.firesideId } : {}) });
        if (!request.firesideId) return { rooms } as TownDesktopReadResult;
        if (request.firesideId === "1") return held.promise;
        return { envelope: envelope([message("9", "第二个围炉的消息")], { kind: "fireside", firesideId: request.firesideId }) } as TownDesktopReadResult;
      }) as unknown as TownDesktopAPI["read"],
    });
    await openFiresides(model);
    expect(model.selectedRing).toBe("1");
    void model.loadFireside("2", "研究小组");
    await settle();
    expect(asked.filter(read => read.firesideId).map(read => read.firesideId)).toEqual(["1", "2"]);
    expect(model.selectedRing).toBe("2");
    expect(model.messages().map(entry => entry.content)).toEqual(["第二个围炉的消息"]);
  });

  // 「late previous-room events and read completion cannot overwrite the selected
  //   room」 and 「the selected room completion updates its content and unlocks
  //   read controls」
  it("a late answer for the ring that was left cannot replace the ring on screen, nor unlock its controls", async () => {
    const held = deferred<TownDesktopReadResult>();
    const { model } = harness({
      read: vi.fn(async (request: { kind: string; firesideId?: string }) => {
        if (!request.firesideId) return { rooms } as TownDesktopReadResult;
        if (request.firesideId === "1") return held.promise;
        return new Promise<TownDesktopReadResult>(() => {}); // ring 2 keeps reading
      }) as unknown as TownDesktopAPI["read"],
    });
    await openFiresides(model);
    void model.loadFireside("2", "研究小组");
    await settle();
    held.resolve({ envelope: envelope([message("5", "旧围炉请求结果不应显示")], { kind: "fireside", firesideId: "1" }) });
    await settle();
    expect(model.messages().map(entry => entry.content)).not.toContain("旧围炉请求结果不应显示");
    // The ring on screen is still reading, so the read controls stay busy.
    expect(model.reading).toBe(true);
  });

  // 「repeated clicks on the selected room deduplicate the same selection
  //   revision」
  it("repeated clicks on the ring already selected join the one read", async () => {
    const held = deferred<TownDesktopReadResult>();
    let asked = 0;
    const { model } = harness({
      read: vi.fn(async (request: { kind: string; firesideId?: string }) => {
        if (!request.firesideId) return { rooms } as TownDesktopReadResult;
        asked++;
        return held.promise;
      }) as unknown as TownDesktopAPI["read"],
    });
    await openFiresides(model);
    expect(asked).toBe(1);
    void model.loadFireside("1", "设计小组");
    void model.loadFireside("1", "设计小组");
    await settle();
    expect(asked).toBe(1);
    held.resolve({ envelope: envelope([message("5", "第一个围炉的消息")], { kind: "fireside", firesideId: "1" }) });
    await settle();
    // Shared read, unshared result: every caller applied the same answer.
    expect(model.messages().map(entry => entry.content)).toEqual(["第一个围炉的消息"]);
    expect(model.reading).toBe(false);
  });

  // 「old completions after a room round trip cannot replace content or unlock the
  //   new read」 and 「the current room read survives the round trip and displays
  //   its own result」
  it("a ring round trip lands its own answer and refuses the one it left behind", async () => {
    const two = deferred<TownDesktopReadResult>();
    const one = deferred<TownDesktopReadResult>();
    const { model } = harness({
      read: vi.fn(async (request: { kind: string; firesideId?: string }) => {
        if (!request.firesideId) return { rooms } as TownDesktopReadResult;
        return request.firesideId === "2" ? two.promise : one.promise;
      }) as unknown as TownDesktopAPI["read"],
    });
    await openFiresides(model);            // ring 1, read in flight
    void model.loadFireside("2", "研究小组");
    await settle();
    void model.loadFireside("1", "设计小组");
    await settle();
    two.resolve({ envelope: envelope([message("6", "第二个围炉的消息")], { kind: "fireside", firesideId: "2" }) });
    await settle();
    expect(model.messages().map(entry => entry.content)).not.toContain("第二个围炉的消息");
    expect(model.reading).toBe(true);
    one.resolve({ envelope: envelope([message("7", "重新选中的围炉读取结果")], { kind: "fireside", firesideId: "1" }) });
    await settle();
    expect(model.messages().map(entry => entry.content)).toEqual(["重新选中的围炉读取结果"]);
    expect(model.reading).toBe(false);
  });

  // 「Fireside background changes preserve draft focus and scroll」, model half: a
  // pushed envelope for a feed that is NOT on screen changes nothing on screen.
  it("a pushed envelope for another feed marks it unread instead of replacing what is on screen", async () => {
    const { model } = harness();
    await openFiresides(model);
    const before = model.messages();
    model.receivePush(envelope([message("3", "另一个围炉的消息")], { kind: "fireside", firesideId: "2" }));
    expect(model.messages()).toEqual(before);
    expect(model.unread("fireside")).toBe(true);
  });

  // ── the draft ──────────────────────────────────────────────────────────────

  // 「Bonfire background changes preserve the draft」 / 「opening hidden Bonfire
  //   requests once and preserves the cached draft」, model half.
  it("a background envelope never touches the draft being typed", async () => {
    const { model } = harness();
    model.show("bonfire");
    await settle();
    model.compose();
    model.content = "尚未发送的草稿";
    model.receivePush(envelope([message("8", "背景同步消息")], { kind: "bonfire" }));
    expect(model.content).toBe("尚未发送的草稿");
    expect(model.sendOpen).toBe(true);
    expect(model.messages().map(entry => entry.content)).toEqual(["背景同步消息"]);
  });

  // 「late successful receipt clears only its original room draft」 and
  // 「returning to confirmed room shows a cleared draft without resending」
  it("a receipt clears the draft of the ring it was sent for and leaves the other ring's alone", async () => {
    const receipt = deferred<{ ok: true; id: string }>();
    const speak = vi.fn(async () => receipt.promise);
    const { model } = harness({ speak: speak as unknown as TownDesktopAPI["speak"] });
    await openFiresides(model);
    model.compose();
    model.content = "围炉发送原文";
    const sending = model.send();
    // The composer moves to the other ring while the receipt is still out.
    model.selectedRing = "2";
    model.sendBusy = false;
    model.compose();
    model.content = "另一个围炉的新草稿";
    receipt.resolve({ ok: true, id: "1" });
    await sending;
    await settle();
    expect(model.content).toBe("另一个围炉的新草稿");
    expect(speak).toHaveBeenCalledTimes(1);
    // Back on the ring that was sent from: its draft is gone, and nothing resent.
    model.selectedRing = "1";
    model.compose();
    expect(model.content).toBe("");
    expect(speak).toHaveBeenCalledTimes(1);
  });

  // 「the draft survives a refused send」 (tests/town-ui.mjs keeps the DOM half)
  it("a refused send keeps the draft and does not resend", async () => {
    const speak = vi.fn(async () => { throw Object.assign(new Error("收件人有歧义；本次私信未发送，请选择 Town ID。"), { code: "NOT_SENT" }); });
    const { model } = harness({ speak: speak as unknown as TownDesktopAPI["speak"] });
    model.show("bonfire");
    await settle();
    model.compose();
    model.content = "你好";
    await model.send();
    expect(model.content).toBe("你好");
    expect(model.sendError).toContain("收件人有歧义");
    expect(speak).toHaveBeenCalledTimes(1);
  });

  // ── the background-collection status strip ─────────────────────────────────
  // BeingDesktop renderer/town-app.js `refreshLabel` (:163) and
  // `backgroundNotConfigured` (:161).

  it("says nothing at all before there is a status to report", () => {
    const { model } = harness();
    expect(refreshLabel(model)).toBe("");
  });

  // 「empty background cache uses the message placeholder without a status strip」
  it("an empty background cache waits for Town rather than claiming a result", async () => {
    const { model } = harness({
      read: vi.fn(async () => ({ envelope: envelope([], { status: { status: "waiting", reason: "waiting_sbs", lastCheckedAt: null, lastSuccessAt: null } }) })) as unknown as TownDesktopAPI["read"],
    });
    model.show("bonfire");
    await settle();
    await settle();
    expect(refreshLabel(model)).toBe("等待 Town 同步");
  });

  // 「missing background registration is shown in the empty message area」 and
  // 「missing background registration retains messages without the redundant
  //   status strip」
  it("a missing background registration says so, and keeps saying so when stale with messages", async () => {
    const { model } = harness();
    model.show("bonfire");
    await settle();
    model.receivePush(envelope([], { status: { status: "waiting", reason: "sbs_not_configured", errorCode: "SBS_NOT_CONFIGURED", lastCheckedAt: null, lastSuccessAt: null } }));
    expect(refreshLabel(model)).toBe("后台采集尚未设置，可立即同步");
    model.receivePush(envelope([message("8", "上次同步到的消息")], { status: { status: "waiting", reason: "sbs_not_configured", errorCode: "SBS_NOT_CONFIGURED", lastSuccessAt: Date.parse("2026-09-07T09:01:00Z"), lastCheckedAt: Date.parse("2026-09-07T09:06:00Z"), stale: true } }));
    const label = refreshLabel(model);
    expect(label.startsWith("后台采集尚未设置，可立即同步")).toBe(true);
    expect(label.endsWith("显示上次同步内容")).toBe(true);
    expect(model.messages().map(entry => entry.content)).toEqual(["上次同步到的消息"]);
  });

  // 「authorization pause labels retained snapshot stale instead of claiming empty
  //   or fresh」
  it("an authorization pause asks for pairing and still admits the content is the last one collected", async () => {
    const { model } = harness();
    model.show("bonfire");
    await settle();
    model.receivePush(envelope([message("8", "上次同步到的消息")], { status: { status: "paused", reason: "AUTH_REQUIRED", errorCode: "AUTH_REQUIRED", lastSuccessAt: Date.parse("2026-09-07T09:01:00Z"), stale: true } }));
    const label = refreshLabel(model);
    expect(label.startsWith("Town 需要配对")).toBe(true);
    expect(label.endsWith("显示上次同步内容")).toBe(true);
    expect(model.messages().length).toBe(1);
  });

  it("reports a busy Being and an accepted request as themselves, never as a completed read", async () => {
    const { model } = harness();
    model.show("bonfire");
    await settle();
    model.receivePush(envelope([], { status: { status: "waiting", errorCode: "REQUEST_ACCEPTED", lastSuccessAt: null } }));
    expect(refreshLabel(model)).toBe("请求已送达 · 等待 Being 完成");
    model.receivePush(envelope([], { status: { status: "waiting", reason: "being_busy", lastSuccessAt: null } }));
    expect(refreshLabel(model)).toBe("Being 正忙 · 稍后可读取一次");
  });

  // The one addition over BeingDesktop: the fact arrives on
  // `beings:model-settings-state` rather than only from a read that already
  // failed. The sentence is BeingDesktop's own.
  it("takes the side-by-side fact from the model-settings channel and opens no reader of its own", async () => {
    const onModelSettings = vi.fn(() => () => {});
    const modelSettingsState = vi.fn(async () => modelSettings(false));
    const { model, town } = harness({}, { modelSettings: { onModelSettings, modelSettingsState } });
    const stop = model.start();
    await settle();
    model.show("bonfire");
    await settle();
    model.receivePush(envelope([], { status: { status: "idle", lastSuccessAt: null } }));
    expect(refreshLabel(model)).toBe("后台采集尚未设置，可立即同步");
    expect(onModelSettings).toHaveBeenCalledTimes(1);
    expect(modelSettingsState).toHaveBeenCalledTimes(1);
    // No second reader of /api/llm/config, and no Town channel pressed into
    // answering it either.
    expect(Object.keys(town)).not.toContain("modelConfig");
    stop();
  });

  it("never lets a configured loop contradict a reader that is not collecting", async () => {
    const { model } = harness();
    model.receiveModelSettings(modelSettings(true));
    model.show("bonfire");
    await settle();
    model.receivePush(envelope([], { status: { status: "error", errorCode: "NETWORK_ERROR", lastSuccessAt: null } }));
    expect(refreshLabel(model)).toBe("结果检查失败 · 可刷新显示");
  });

  // ── one read per opening ───────────────────────────────────────────────────
  // BeingDesktop acceptTownState (renderer/town-app.js:1701) never starts a feed
  // read from a state update, and treats an identity that merely arrived as no
  // change: `Boolean(previousId && nextId && nextId !== previousId)`.
  it("an identity arriving after the page opened does not start a second read", async () => {
    const { model, reads } = harness();
    model.receiveState(appState({ identity: identity({ townId: "", loomBeingId: "", beingId: "" }), client: clientState({ townId: "", paired: false, status: "unpaired" }) }));
    model.show("bonfire");
    await settle();
    await settle();
    expect(reads.length).toBe(1);
    model.receiveState(appState());
    await settle();
    await settle();
    expect(reads.length).toBe(1);
    expect(model.me).toBe("t_Willow");
  });

  it("an identity that actually changed re-reads the feed on screen", async () => {
    const { model, reads } = harness();
    model.show("bonfire");
    await settle();
    await settle();
    expect(reads.length).toBe(1);
    model.receiveState(appState({
      identity: identity({ beingId: "river", loomBeingId: "river", townId: "t_River", connectionRevision: 2 }),
      client: clientState({ beingId: "river", loomBeingId: "river", townId: "t_River" }),
    }));
    await settle();
    await settle();
    expect(reads.length).toBe(2);
    expect(model.me).toBe("t_River");
  });
});
