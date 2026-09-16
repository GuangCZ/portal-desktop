import { describe, expect, it, vi, afterEach } from "vitest";
import { AppModel } from "../desktop/renderer/app/models/app";
import { TownModel } from "../desktop/renderer/town/models/town";
import { WorkspaceModel } from "../desktop/renderer/app/models/workspace";
import { SceneStore } from "../desktop/renderer/shared/models/scene";
import {
  feedMessages,
  filterMessages,
  inboxMessages,
  newFeedFilters,
} from "../desktop/renderer/town/models/feed";
import { liveMessage } from "../desktop/renderer/town/page";
import type { DesktopAPI, Snapshot, TownResult } from "../desktop/shared/types";
import type {
  TownDesktopAPI,
  TownDesktopAppState,
  TownDesktopClientState,
  TownDesktopDirectMessage,
  TownDesktopEnvelope,
  TownDesktopIdentity,
  TownDesktopMessage,
  TownDesktopReadResult,
  TownDesktopRefreshStatus,
  TownDesktopScroll,
  TownDesktopScrollSummary,
  TownDesktopTimeline,
} from "../desktop/shared/desktop-types";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const state = (being = "willow"): Snapshot => ({
  settings: {
    being,
    endpoint: "https://fixture.test/" + being,
    hasToken: true,
    workspace: "/workspace",
    portalBinary: "/portal",
    portalName: "portal",
    autoStart: false,
    allowExec: true,
    kitsEnabled: true,
  },
  portal: { phase: "stopped", message: "stopped", logs: [] },
});
// 2026-09-16: `TownLiveState` — phase, generation, revision, per-feed version
// counters — went with `beings:town-live` (integration unit I1, decision §5.1).
// The paired client reports the same three facts in three separate shapes, and
// the fixtures below are those: `appState` is the `townApp` snapshot the page
// reads its connection from, `envelope` is one accumulated timeline as the
// background reader pushes it, and the feed markers the version counters used to
// carry are now the envelopes themselves arriving for a feed that is not on
// screen.
const refreshStatus = (
  overrides: Partial<TownDesktopRefreshStatus> = {},
): TownDesktopRefreshStatus => ({
  status: "idle",
  reason: "",
  intervalMs: 60000,
  nextRefreshAt: null,
  lastAttemptAt: null,
  lastCheckedAt: null,
  lastSuccessAt: null,
  revision: null,
  stale: false,
  errorCode: "",
  failureCount: 0,
  running: true,
  ...overrides,
});
const identity = (
  overrides: Partial<TownDesktopIdentity> = {},
): TownDesktopIdentity => ({
  beingId: "willow",
  loomBeingId: "willow",
  townId: "t_Willow",
  displayName: "柳树",
  sendAs: "t_Willow",
  connectionRevision: 1,
  identityRevision: 1,
  ...overrides,
});
const clientState = (
  overrides: Partial<TownDesktopClientState> = {},
): TownDesktopClientState => ({
  status: "connected",
  paired: true,
  beingId: "willow",
  loomBeingId: "willow",
  townId: "t_Willow",
  displayName: "柳树",
  errorCode: "",
  authReason: "",
  pairingPending: false,
  pairErrorCode: "",
  ...overrides,
});
const appState = (
  overrides: Partial<TownDesktopAppState> = {},
): TownDesktopAppState => ({
  identity: identity(),
  access: {},
  accessDetail: {},
  bonfire: { status: "ready", detail: "" },
  fireside: { status: "ready", detail: "" },
  scroll: { status: "ready", detail: "" },
  beings: { status: "ready", detail: "" },
  inbox: { status: "ready", detail: "" },
  sync: { bonfire: null, fireside: null },
  client: clientState(),
  pairing: { status: "idle", busy: false, errorCode: "" },
  memberDirectory: { revision: 1, expiresAt: 0 },
  ...overrides,
});
const townMessage = (
  overrides: Partial<TownDesktopMessage> = {},
): TownDesktopMessage => ({
  id: "1",
  beingId: "river",
  beingName: "河流",
  content: "hello",
  createdAt: "2026-09-12T00:00:00Z",
  revisedAt: "",
  mentions: [],
  ...overrides,
});
const direct = (
  overrides: Partial<TownDesktopDirectMessage> = {},
): TownDesktopDirectMessage => ({
  id: "letter",
  senderId: "river",
  senderName: "河流",
  content: "你好",
  createdAt: "2026-09-12T00:00:00Z",
  ...overrides,
});
const envelope = (
  messages: TownDesktopMessage[] = [],
  overrides: {
    kind?: string;
    firesideId?: string;
    snapshot?: Partial<TownDesktopTimeline>;
  } = {},
): TownDesktopEnvelope => ({
  kind: overrides.kind || "bonfire",
  firesideId: overrides.firesideId || "",
  snapshot: {
    identity: { connectionRevision: 1 },
    messages,
    latestSeq: Number(messages.at(-1)?.id) || null,
    total: messages.length,
    hasOlder: false,
    lastRefresh: null,
    ...overrides.snapshot,
  },
  status: refreshStatus(),
});
/** An error as the preload envelope rebuilds it: the catalogue code in
 * docs/interfaces.md §5 on an ordinary Error, because Electron strips custom
 * fields off anything else crossing IPC. */
const townError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
const result = (data: Record<string, unknown>): TownResult => ({
  ok: true,
  data,
  fetchedAt: "2026-09-12T00:00:00Z",
});
const scrollSummary = (
  overrides: Partial<TownDesktopScrollSummary> = {},
): TownDesktopScrollSummary => ({
  id: "letter",
  title: "私人卷轴",
  beingId: "t_Willow",
  beingName: "柳树",
  visibility: "private",
  kind: "note",
  lifecycle: "seed",
  tags: ["笔记"],
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T01:00:00Z",
  revision: 3,
  ...overrides,
});
const scrollDetail = (
  overrides: Partial<TownDesktopScroll> = {},
): TownDesktopScroll => ({
  ...scrollSummary(),
  content: "只有配对后才读得到的正文",
  totalLength: 15,
  offset: 0,
  limit: 10000,
  nextOffset: 15,
  hasMore: false,
  ...overrides,
});
function api(
  overrides: Partial<DesktopAPI> = {},
  townOverrides: Partial<TownDesktopAPI> = {},
) {
  const subscriptions = new Set<unknown>();
  const on = (callback: unknown) => {
    subscriptions.add(callback);
    return () => {
      subscriptions.delete(callback);
    };
  };
  const townDesktop = {
    appState: vi.fn(async () => appState()),
    refreshApp: vi.fn(async () => appState()),
    // A cache miss by default: the first open of a feed on a fresh profile has
    // nothing on disk yet, and that is the path that must still reach the read.
    timeline: vi.fn(async (): Promise<TownDesktopEnvelope> => {
      throw townError("STORAGE_ERROR", "尚无本机缓存");
    }),
    refreshTimeline: vi.fn(async () => envelope()),
    loadOlder: vi.fn(async () => envelope()),
    read: vi.fn(async (): Promise<TownDesktopReadResult> => ({ envelope: envelope() })),
    firesides: vi.fn(async () => ({ owned: [], joined: [], cached: false })),
    firesideMembers: vi.fn(async () => ({ members: [] })),
    speak: vi.fn(async () => ({ ok: true as const, id: "1" })),
    inbox: vi.fn(async () => ({ messages: [] })),
    members: vi.fn(async () => ({ members: [], revision: 1, expiresAt: 0 })),
    scrolls: vi.fn(async () => ({ scrolls: [], total: 0, offset: 0, limit: 50, hasMore: false })),
    scroll: vi.fn(async () => ({ scroll: scrollDetail() })),
    cached: vi.fn(async () => ({ cached: false, data: null, lastSuccessAt: null })),
    pair: vi.fn(async () => clientState()),
    autoPair: vi.fn(async () => clientState()),
    retryPairStorage: vi.fn(async () => clientState()),
    forget: vi.fn(async () => clientState({ status: "unpaired", paired: false })),
    onState: on,
    onMessages: on,
    onMembersInvalidated: on,
    ...townOverrides,
  } as unknown as TownDesktopAPI;
  const value = {
    snapshot: vi.fn(async () => state()),
    appearance: vi.fn(async () => "light"),
    updateState: vi.fn(async () => ({ phase: "idle" })),
    onPortal: on,
    onUpdate: on,
    town: vi.fn(async () => result({ messages: [] })),
    townDesktop,
    connectionDefaults: vi.fn(async () => ({ portalName: "original-portal" })),
    ...overrides,
  } as unknown as DesktopAPI;
  return { value, subscriptions, townDesktop };
}
function town(
  overrides: Partial<DesktopAPI> = {},
  townOverrides: Partial<TownDesktopAPI> = {},
) {
  const fixture = api(overrides, townOverrides);
  return {
    ...fixture,
    model: new TownModel(
      fixture.value,
      vi.fn(),
      vi.fn(),
      new SceneStore(),
      vi.fn(),
      vi.fn(),
    ),
  };
}
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
afterEach(() => vi.useRealTimers());
describe("React desktop state lifecycle", () => {
  // The scene the conversation reports is minted in the main process now, and
  // the surface identity the shell keeps is only a change token: the sandboxed
  // document it used to address — and the endpoint and scene labels it had to
  // carry across that boundary — went with the iframe on 2026-09-16.
  it("identifies the conversation surface without carrying anything about the connection", () => {
    const app = new AppModel(api().value);
    app.applySnapshot(state());
    const first = app.chatSource;
    expect(first).not.toBe("");
    expect(first).not.toContain("://");
    expect(first).not.toContain(state().settings.endpoint);
    app.applySnapshot(state("other"), true);
    expect(app.chatSource).not.toBe(first);
  });
  it("previews Portal logs through Together without posting until the user composes a reference", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ endpoint: string; text: string }>();
    const getLogs = vi.fn(() => pending.promise);
    const app = new AppModel(api({ portalLogReference: getLogs }).value), post = vi.fn();
    const messages = () => post.mock.calls.map(call => call[0]).filter(message => message.type !== 'beings:town-activity');
    app.post = post;
    app.applySnapshot(state()); app.frameLoaded(); app.connection = 'online';
    post.mockClear();
    const selecting = app.sharePortalLogs();
    await app.sharePortalLogs();
    expect(getLogs).toHaveBeenCalledOnce();
    pending.resolve({ endpoint: state().settings.endpoint, text: 'redacted log fixture' });
    await selecting;
    expect(messages()).toEqual([]);
    expect(app.logsLoading).toBe(false);
    expect(app.view).toBe('chat');
    expect(app.workspace.open).toBe(true);
    expect(app.workspace.scenes.reference).toMatchObject({ view: 'portal', title: 'Portal 设置',
      selection: { title: 'Portal 日志', author: '本机 Portal', excerpt: 'redacted log fixture', private: true } });
    app.applySnapshot({ ...state(), portal: { phase: 'connected', message: 'new state', logs: ['later output'] } });
    expect(app.workspace.scenes.reference?.selection?.excerpt).toBe('redacted log fixture');
    app.workspace.compose();
    expect(messages()).toHaveLength(1);
    const message = messages()[0];
    expect(message).toMatchObject({ type: 'beings:scene-draft',
      text: '一起看看Portal 设置里的这段（本机 Portal）：\n\n> redacted log fixture' });
    app.workspace.receive({ type: 'beings:scene-draft-result', id: message.id, ok: true });
    expect(app.workspace.open).toBe(false);
    expect(messages()).toHaveLength(1);
  });
  it("discards a Portal log reference collected before an identity change", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ endpoint: string; text: string }>();
    const app = new AppModel(api({ portalLogReference: () => pending.promise }).value), post = vi.fn();
    app.post = post;
    app.applySnapshot(state()); app.frameLoaded(); app.connection = 'online'; post.mockClear();
    const selecting = app.sharePortalLogs();
    app.applySnapshot(state('other'), true);
    pending.resolve({ endpoint: state().settings.endpoint, text: 'old logs' });
    await selecting;
    expect(post).not.toHaveBeenCalled();
    expect(app.logsLoading).toBe(false);
    expect(app.workspace.scenes.reference).toBeNull();
    expect(app.workspace.open).toBe(false);
  });
  it("refreshes each place navigation and clears pending details when changing features", async () => {
    const pending = deferred<TownResult>();
    const query = vi.fn<DesktopAPI['town']>(async query =>
      query.kind === 'seed' ? pending.promise : result({ seeds: [], count: 0 }));
    const read = vi.fn(async (): Promise<TownDesktopReadResult> =>
      ({ envelope: envelope([townMessage({ content: 'fresh bonfire' })]) }));
    const app = new AppModel(api({ town: query }, { read }).value);
    app.navigate('seeds', 'pending-seed');
    await settle();
    expect(app.town.detailLoading).toBe(true);
    app.navigate('bonfire');
    await settle();
    expect(app.view).toBe('bonfire');
    expect(app.town.directId).toBeUndefined();
    expect(app.town.detailLoading).toBe(false);
    app.navigate('seeds');
    await settle();
    expect(app.town.detailLoading).toBe(false);
    expect(app.town.data).toEqual({ seeds: [], count: 0 });
    pending.resolve(result({ brief: 'old seed' }));
    await settle();
    expect(app.town.detail).toBeUndefined();
    app.navigate('bonfire');
    await settle();
    app.navigate('bonfire');
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    expect(app.town.messages().map(message => message.content)).toEqual(['fresh bonfire']);
    // And the bonfire never reached the anonymous catalogue channel: the public
    // reader has no credential, so a private feed asked through it would either
    // fail or — worse — succeed as somebody else (decision §5.1).
    expect(query.mock.calls.map(([query]) => query.kind)).toEqual(['seed', 'seeds']);
  });

  it("releases IPC subscriptions and ignores startup reads from an earlier mount", async () => {
    const old = deferred<Snapshot>(),
      fresh = deferred<Snapshot>();
    const fixture = api({
      snapshot: vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise),
    });
    const app = new AppModel(fixture.value),
      stop = app.start();
    // Six now, three before 2026-09-16: `onPortal` and `onUpdate` as ever, plus
    // the paired Town client's `onState`, `onMessages` and `onMembersInvalidated`
    // where the single `onTownLive` used to be, plus the conversation's
    // explanation-card stream (I5). The count is incidental; that every one of
    // them is released on unmount is the test.
    expect(fixture.subscriptions.size).toBe(6);
    stop();
    expect(fixture.subscriptions.size).toBe(0);
    const stopAgain = app.start();
    expect(fixture.subscriptions.size).toBe(6);
    fresh.resolve(state("river"));
    await settle();
    old.resolve(state("willow"));
    await settle();
    expect(app.snapshot?.settings.being).toBe("river");
    expect(app.startup).toBe("ready");
    stopAgain();
    expect(fixture.subscriptions.size).toBe(0);
  });
  it("preserves the chat document during status updates and reloads explicitly", () => {
    const app = new AppModel(api().value);
    app.applySnapshot(state());
    const src = app.chatSource;
    app.applySnapshot({
      ...state(),
      portal: { phase: "connected", message: "online", logs: ["ready"] },
    });
    expect(app.chatSource).toBe(src);
    app.applySnapshot(state(), true);
    expect(app.chatSource).not.toBe(src);
    app.applySnapshot({
      ...state(),
      settings: { ...state().settings, hasToken: false },
    });
    expect(app.chatSource).toBe("");
  });
  it("does not overwrite an edited Portal name with late defaults", async () => {
    const pending = deferred<{ portalName: string; source: string }>();
    const app = new AppModel(
      api({ connectionDefaults: () => pending.promise }).value,
    );
    app.applySnapshot(state());
    app.showSettings();
    app.editForm("portalName", "my-portal");
    pending.resolve({ portalName: "detected", source: "old config" });
    await settle();
    expect(app.form?.portalName).toBe("my-portal");
    expect(app.portalNameHelp).toContain("保留你填写的名称");
    app.closeSettings();
  });
  it("invalidates closed forms and clears the connection secret", async () => {
    const pending = deferred<{ portalName: string }>();
    const app = new AppModel(
      api({ connectionDefaults: () => pending.promise }).value,
    );
    app.applySnapshot(state());
    app.showSettings();
    app.editForm("connectionLink", "https://fixture.test/?token=secret");
    app.closeSettings();
    pending.resolve({ portalName: "late" });
    await settle();
    expect(app.form?.connectionLink).toBe("");
    expect(app.form?.portalName).toBe("portal");
  });
});
describe("Town request and identity isolation", () => {
  // REWRITTEN 2026-09-16 for the direct Town client (integration unit I1,
  // decision §5.1). Every case below is the case it was; what changed under it
  // is the surface. `townAuth`/`pairTown`/`autoPairTown`/`cancelTownPair`/
  // `sendTown`/`onTownLive` were nine channels around a Being-relayed Town; the
  // client now pairs itself, speaks for itself and reads for itself, so the same
  // questions are asked of `window.beings.townDesktop`.
  it("offers one-click pairing and keeps the six-digit code as the fallback", async () => {
    const autoPair = vi.fn(async () => {
      throw new Error("自动配对超时");
    });
    const { model } = town(
      {},
      {
        appState: vi.fn(async () =>
          appState({
            client: clientState({ status: "unpaired", paired: false, townId: "", displayName: "" }),
            identity: identity({ townId: "", displayName: "" }),
          }),
        ),
        autoPair,
      },
    );
    model.view = "bonfire";
    await model.auth();
    expect(model.authOpen).toBe(true);
    expect(model.authState).toBe("尚未配对。");
    await model.autoPair();
    // No arguments at all. The renderer used to name the Being to pair as, which
    // was a way to pair the wrong one; the connection the client is bound to is
    // the only answer the main process will accept.
    expect(autoPair).toHaveBeenCalledWith();
    expect(model.authOpen).toBe(true);
    expect(model.authError).toContain("超时");
    expect(model.authBusy).toBe(false);
    expect(model.pairCode).toBe("");
  });
  it("never runs two pairing requests at once and refuses to close over one", async () => {
    // `cancelTownPair` went with the old pairing layer: the code is spent in the
    // main process, and letting the renderer abandon a request could only ever
    // have thrown away a token Town had already minted. What the cancel path
    // existed to protect is kept — a dialog that cannot be closed out from under
    // a request, and a request that is never started twice.
    const pending = deferred<TownDesktopClientState>();
    const autoPair = vi.fn(() => pending.promise);
    const { model } = town(
      {},
      {
        appState: vi
          .fn()
          .mockResolvedValueOnce(
            appState({ client: clientState({ status: "unpaired", paired: false }) }),
          )
          .mockResolvedValue(appState()),
        autoPair,
      },
    );
    model.view = "bonfire";
    await model.auth();
    const run = model.autoPair();
    await model.autoPair();
    expect(autoPair).toHaveBeenCalledOnce();
    await model.closeAuth();
    expect(model.authOpen).toBe(true);
    expect(model.authBusy).toBe(true);
    pending.resolve(clientState());
    await run;
    expect(model.authOpen).toBe(false);
    expect(model.authBusy).toBe(false);
    expect(model.authError).toBe("");
  });
  it("keeps a pairing whose credential could not be stored and never asks for a second code", async () => {
    const appStates = vi
      .fn()
      .mockResolvedValueOnce(
        appState({ client: clientState({ status: "unpaired", paired: false }) }),
      )
      .mockResolvedValueOnce(
        appState({
          client: clientState({
            status: "pair_storage_error",
            paired: false,
            pairingPending: true,
            pairErrorCode: "PAIR_STORAGE_ERROR",
          }),
        }),
      )
      .mockResolvedValue(appState());
    const autoPair = vi.fn(async () => clientState({ pairingPending: true }));
    const retryPairStorage = vi.fn(async () => clientState());
    const { model } = town({}, { appState: appStates, autoPair, retryPairStorage });
    model.view = "bonfire";
    await model.auth();
    await model.autoPair();
    expect(model.authOpen).toBe(true);
    expect(model.authState).toContain("重试保存配对");
    await model.retryPairStorage();
    expect(retryPairStorage).toHaveBeenCalledOnce();
    expect(autoPair).toHaveBeenCalledOnce();
    expect(model.authOpen).toBe(false);
    expect(model.authError).toBe("");
  });
  it("refuses a pairing code that is not six characters before spending it", async () => {
    const pair = vi.fn(async () => clientState());
    const { model } = town({}, { pair });
    model.view = "bonfire";
    await model.auth();
    model.pairCode = "ABC";
    await model.pair();
    expect(pair).not.toHaveBeenCalled();
    expect(model.authError).toContain("6 位配对码");
    model.pairCode = "k7m2n4";
    await model.pair();
    expect(pair).toHaveBeenCalledWith({ code: "K7M2N4" });
  });
  it("ignores a response from the previous page", async () => {
    const pending = deferred<TownDesktopReadResult>();
    const { model } = town(
      { town: vi.fn(async () => result({ scrolls: [{ id: "story" }] })) },
      { read: () => pending.promise },
    );
    model.show("bonfire");
    await settle();
    model.show("embers");
    await settle();
    pending.resolve({
      envelope: envelope([townMessage({ content: "old private content" })]),
    });
    await settle();
    expect(model.view).toBe("embers");
    expect(model.data).toEqual({ scrolls: [{ id: "story" }] });
    expect(model.timeline).toBeNull();
    expect(model.loading).toBe(false);
  });
  it("joins the one in-flight read rather than starting a second", async () => {
    const pending = deferred<TownDesktopReadResult>();
    const read = vi.fn(() => pending.promise);
    const { model } = town({}, { read });
    model.receiveState(appState());
    model.show("bonfire");
    await settle();
    model.show("bonfire");
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(model.reading).toBe(true);
    pending.resolve({ envelope: envelope([townMessage({ content: "shared" })]) });
    await settle();
    expect(model.reading).toBe(false);
    expect(model.messages().map((message) => message.content)).toEqual(["shared"]);
  });
  it("paints the cached timeline before asking Town for anything", async () => {
    const order: string[] = [];
    const { model } = town(
      {},
      {
        timeline: vi.fn(async () => {
          order.push("cache");
          return envelope([townMessage({ content: "from disk" })]);
        }),
        read: vi.fn(async () => {
          order.push("read");
          expect(model.messages().map((message) => message.content)).toEqual(["from disk"]);
          return { envelope: envelope([townMessage({ content: "from town" })]) };
        }),
      },
    );
    model.receiveState(appState());
    model.show("bonfire");
    await settle();
    expect(order).toEqual(["cache", "read"]);
    expect(model.messages().map((message) => message.content)).toEqual(["from town"]);
  });
  it("discards stale details and private drafts when the identity changes", async () => {
    const pending = deferred<{ scroll: TownDesktopScroll }>();
    const { model } = town({}, { scroll: () => pending.promise });
    model.receiveState(appState());
    model.view = "chat";
    model.content = "private draft";
    model.recipient = "friend";
    model.mentionNames = new Map([["t_Friend", { name: "私信伙伴", at: 0 }]]);
    model.sendTarget = { kind: "dm", connectionRevision: 1, beingId: "t_Willow" };
    model.sendOpen = true;
    const read = model.loadDetail({ kind: "scroll", id: "private" });
    model.receiveState(
      appState({ identity: identity({ townId: "t_River", connectionRevision: 2 }) }),
    );
    pending.resolve({
      scroll: scrollDetail({ id: "private", title: "private", content: "must not appear" }),
    });
    await read;
    expect(model.detail).toBeUndefined();
    expect(model.content).toBe("");
    expect(model.recipient).toBe("");
    expect(model.sendTarget).toBeUndefined();
    expect(model.sendOpen).toBe(false);
    expect(model.mentionNames.size).toBe(0);
    expect(model.timeline).toBeNull();
  });
  it("reads a private scroll body over the paired client and a public one without a credential", async () => {
    // The catalogue reader carries no token at all (desktop/main/town/catalog.ts),
    // so 「我的卷轴」 would list rows whose bodies answer 401. The list already
    // came from the paired client; the body has to follow it.
    const scroll = vi.fn(async () => ({ scroll: scrollDetail({ id: "letter" }) }));
    const scrolls = vi.fn(async () => ({
      scrolls: [scrollSummary({ id: "letter" })],
      total: 1, offset: 0, limit: 50, hasMore: false,
    }));
    const anonymous = vi.fn(async () =>
      result({ scrolls: [{ id: "note", visibility: "public", title: "\u516c\u5f00\u5377\u8f74" }] }),
    );
    const { model } = town({ town: anonymous }, { scroll, scrolls });
    model.receiveState(appState());
    model.show("scrolls");
    model.selectTab("my-scrolls");
    await settle();
    // The DTO is projected onto the shape the rows read, so the author and the
    // date are not blank where the catalogue would have filled them.
    expect(model.data?.scrolls).toEqual([
      expect.objectContaining({ id: "letter", display_name: "\u67f3\u6811", being_id: "t_Willow", updated_at: "2026-09-12T01:00:00Z" }),
    ]);
    await model.loadDetail({ kind: "scroll", id: "letter" });
    expect(scroll).toHaveBeenCalledWith({ id: "letter" });
    expect(model.detail?.fragments[0]).toMatchObject({
      id: "letter",
      content: "\u53ea\u6709\u914d\u5bf9\u540e\u624d\u8bfb\u5f97\u5230\u7684\u6b63\u6587",
      has_more: false,
    });
    const credentialed = anonymous.mock.calls.length;

    // A scroll the catalogue itself listed as public stays on the anonymous
    // route: the validated DTO does not carry `trigger_context`/`outcome`, and
    // the public reading pane renders them.
    model.selectTab("scrolls");
    await settle();
    await model.loadDetail({ kind: "scroll", id: "note" });
    expect(anonymous).toHaveBeenCalledWith({ kind: "scroll", id: "note" });
    expect(anonymous.mock.calls.length).toBeGreaterThan(credentialed);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("offers pairing rather than a retry when a scroll body needs a credential", async () => {
    const scroll = vi.fn(async () => {
      throw townError("AUTH_REQUIRED", "\u8bf7\u7528 Being \u63d0\u4f9b\u7684\u516d\u4f4d\u914d\u5bf9\u7801\u8fde\u63a5 Town\u3002");
    });
    const { model } = town({}, { scroll });
    model.receiveState(appState());
    await model.loadDetail({ kind: "scroll", id: "letter" });
    expect(model.detailError?.auth).toBe(true);
    expect(model.detail).toBeUndefined();
  });
  it("sends once and never retries an uncertain result automatically", async () => {
    let fail!: (error: unknown) => void;
    const speak = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    );
    const { model } = town({}, { speak });
    model.receiveState(appState());
    model.view = "bonfire";
    model.compose();
    model.content = "hello";
    const send = model.send();
    await model.send();
    expect(speak).toHaveBeenCalledTimes(1);
    fail(townError("RESULT_UNKNOWN", "请先核对是否送达"));
    await send;
    expect(model.sendOpen).toBe(true);
    expect(model.content).toBe("hello");
    expect(model.sendError).toContain("核对");
    expect(model.sendNotice).toContain("不要直接重发");
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it("keeps successful mention warnings visible and clears the sent draft so it cannot be resent by another click", async () => {
    const speak = vi.fn(async () => ({
      ok: true as const,
      id: "7",
      seq: 7,
      mention_warnings: [
        {
          mention: "Neo",
          candidates: [
            { town_id: "t_NeoA", display_name: "Neo A" },
            { town_id: "t_NeoB", display_name: "Neo B" },
          ],
        },
      ],
    }));
    const { model } = town({}, { speak });
    model.receiveState(appState());
    model.view = "bonfire";
    model.compose();
    model.content = "@Neo 你好";
    await model.send();
    expect(model.sendOpen).toBe(true);
    expect(model.sendNotice).toContain("消息已发送");
    expect(model.sendNotice).toContain("@Neo");
    expect(model.sendNotice).toContain("不要重发原消息");
    expect(model.sendCandidates.map((candidate) => candidate.town_id)).toEqual([
      "t_NeoA",
      "t_NeoB",
    ]);
    expect(model.sendError).toBe("");
    expect(model.content).toBe("");
    expect(model.canSend).toBe(false);
    await model.send();
    expect(speak).toHaveBeenCalledTimes(1);
    model.compose();
    expect(model.content).toBe("");
    expect(model.sendNotice).toBe("");
    expect(model.sendCandidates).toEqual([]);
  });
  it("loads the private All tab from the one read that carries both directions", async () => {
    const inbox = vi.fn(async () => ({
      messages: [
        direct({ id: "incoming", senderId: "t_River", senderName: "河流" }),
        direct({ id: "outgoing", senderId: "t_Willow", senderName: "柳树" }),
      ],
    }));
    const { model } = town({}, { inbox });
    model.receiveState(appState());
    model.show("mail");
    await settle();
    expect(model.tab).toBe("all");
    // Town answers `/api/messages` with both directions, so the shell's old pair
    // of `inbox` + `sent` reads is one read and a filter (docs/interfaces.md §1.2).
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(model.messages()).toHaveLength(2);
    model.tab = "inbox";
    expect(model.messages().map((message) => message.id)).toEqual(["incoming"]);
    model.tab = "sent";
    expect(model.messages().map((message) => message.id)).toEqual(["outgoing"]);
  });
  it("keeps the private-message tab selected after sending", async () => {
    const speak = vi.fn(async () => ({ ok: true as const, id: "dm-1" }));
    const inbox = vi.fn(async () => ({ messages: [] }));
    const { model } = town({}, { speak, inbox });
    model.receiveState(appState());
    model.view = "mail";
    model.tab = "all";
    model.tabs.mail = "all";
    model.compose();
    model.recipient = "t_River";
    model.content = "reply without changing my view";
    await model.send();
    expect(speak).toHaveBeenCalledWith({
      kind: "dm",
      recipient: "t_River",
      content: "reply without changing my view",
      connectionRevision: 1,
    });
    expect(model.tab).toBe("all");
    expect(model.tabs.mail).toBe("all");
    expect(inbox).toHaveBeenCalled();
  });
  it("rejects a stale sender identity and keeps no credential of its own to clear", async () => {
    const speak = vi.fn();
    const { model } = town({}, { speak });
    model.receiveState(appState());
    model.view = "mail";
    model.compose();
    model.content = "hello";
    model.recipient = "t_River";
    model.sendTarget = { ...model.sendTarget!, connectionRevision: 0 };
    await model.send();
    expect(speak).not.toHaveBeenCalled();
    expect(model.sendError).toContain("身份已改变");
    // The old dialog held a Town token in renderer memory and had to wipe it on
    // close. The direct client mints its own credential in the main process and
    // never hands one down, so the only thing left to clear is the typed code.
    expect("token" in model).toBe(false);
    model.authOpen = true;
    model.pairCode = "K7M2N4";
    await model.closeAuth();
    expect(model.pairCode).toBe("");
    expect(model.authOpen).toBe(false);
    // And the composer goes with the identity, through the real path.
    model.receiveState(
      appState({ identity: identity({ townId: "t_River", connectionRevision: 2 }) }),
    );
    expect(model.sendTarget).toBeUndefined();
    expect(model.content).toBe("");
  });
  it("shows the saved pairing while keeping writes closed until the connection confirms it", async () => {
    const appStates = vi
      .fn()
      .mockResolvedValueOnce(
        appState({ client: clientState({ status: "connecting" }) }),
      )
      .mockResolvedValue(
        appState({
          client: clientState({ status: "unpaired", paired: false, townId: "", displayName: "" }),
          identity: identity({ townId: "", displayName: "" }),
        }),
      );
    const { model } = town({}, { appState: appStates });
    model.view = "mail";
    await model.auth();
    expect(model.authState).toBe("已保存 Town 配对，等待身份确认。");
    expect(model.paired).toBe(true);
    expect(model.connected).toBe(false);
    model.compose();
    expect(model.sendTarget).toBeUndefined();
    expect(model.sendOpen).toBe(false);
    await model.closeAuth();
    await model.auth();
    expect(model.authState).toBe("尚未配对。");
    expect(model.paired).toBe(false);
  });
  it("keeps loaded text while reconciling new activity", () => {
    const read = vi.fn(async (): Promise<TownDesktopReadResult> => ({ envelope: envelope() }));
    const { model } = town({}, { read });
    model.receiveState(appState());
    model.view = "bonfire";
    model.tab = "bonfire";
    model.receivePush(envelope([townMessage({ id: "1", content: "reading" })]));
    expect(model.messages().map((message) => message.content)).toEqual(["reading"]);
    // A timeline for a feed that is not on screen is a marker, not a repaint.
    model.receivePush(
      envelope([townMessage({ id: "9", content: "别处的消息" })], {
        kind: "fireside",
        firesideId: "12",
      }),
    );
    expect(model.messages().map((message) => message.content)).toEqual(["reading"]);
    expect(model.unread("fireside")).toBe(true);
    // The inbox hint carries no payload at all; the page re-reads or marks.
    model.receivePush({ kind: "dm" });
    expect(model.unread("dm")).toBe(true);
    // The timeline accumulates rather than rolling, and says where the previous
    // refresh stopped so the divider is a position rather than a guess.
    model.receivePush(
      envelope(
        [
          townMessage({ id: "1", content: "reading" }),
          townMessage({ id: "2", content: "new" }),
        ],
        { snapshot: { lastRefresh: { at: 1, boundarySeq: 1 } } },
      ),
    );
    expect(model.messages().map((message) => message.content)).toEqual(["reading", "new"]);
    expect(model.timeline?.lastRefresh?.boundarySeq).toBe(1);
    // A snapshot read under the previous connection never lands in this one.
    model.receivePush(
      envelope([townMessage({ id: "9", content: "上一个 Being 的消息" })], {
        snapshot: { identity: { connectionRevision: 2 } },
      }),
    );
    expect(model.messages().map((message) => message.content)).toEqual(["reading", "new"]);
    // None of it cost a read: a push is already the content.
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps the last Town snapshot readable when the connection loses its credential", () => {
    const { model } = town();
    model.receiveState(appState());
    model.view = "bonfire";
    model.receivePush(envelope([townMessage({ content: "story" })]));
    model.receiveState(
      appState({
        client: clientState({ status: "auth_required", errorCode: "AUTH_REQUIRED" }),
      }),
    );
    expect(model.messages().map((message) => message.content)).toEqual(["story"]);
    expect(model.error).toBeUndefined();
    expect(liveMessage(model)).toContain("仍可阅读");
  });
});
describe("shared reading behavior", () => {
  // The envelope-spelling archaeology these three cases used to do is gone: the
  // main process validates every message against the DTO before it crosses IPC
  // (desktop/main/town/session/session.ts), so an absent field is absent because
  // Town did not send it. The rules they were actually about — exact identity
  // matching, stable ordering, and never printing 「未知」 over an id that is
  // right there — are the rules below, restated against those DTOs.
  it("matches exact identities and preserves stable chronological ordering", () => {
    const messages = feedMessages(
      [
        townMessage({
          id: "1",
          beingId: "river",
          content: "@willow_work unrelated",
          createdAt: "2026-09-12T01:00:00Z",
        }),
        townMessage({
          id: "2",
          beingId: "river",
          content: "@willow hello",
          createdAt: "2026-09-12T01:00:00Z",
        }),
        townMessage({
          id: "3",
          beingId: "willow",
          content: "mine",
          createdAt: "2026-09-12T02:00:00Z",
        }),
      ],
      { me: "Willow" },
    );
    const filters = { ...newFeedFilters(), relation: "about" };
    expect(filterMessages(messages, filters, "").map((m) => m.seq)).toEqual([3, 2]);
    expect(
      filterMessages(messages, { ...filters, order: "oldest" }, "").map((m) => m.seq),
    ).toEqual([2, 3]);
  });
  it("prefers the mention list Town resolved over anything read out of the text", () => {
    // Town resolves mentions server-side. A feed that carried the list is
    // answered from it; only a feed without one falls back to exact `@id` tokens,
    // and then never to a prefix or a display name.
    const [resolved, textOnly] = feedMessages(
      [
        townMessage({ id: "1", content: "没有写出名字", mentions: ["t_Willow"] }),
        townMessage({ id: "2", content: "@t_Willow_more 不是我" }),
      ],
      { me: "t_Willow" },
    );
    expect(resolved.mentioned).toBe(true);
    expect(textOnly.mentioned).toBe(false);
  });
  it("reads private message names from the validated direct-message DTO", () => {
    const [incoming, outgoing] = inboxMessages(
      [
        direct({ id: "letter-1", senderId: "river", senderName: "河流", content: "你好" }),
        direct({ id: "letter-2", senderId: "willow", senderName: "柳树", content: "好" }),
      ],
      { me: "willow" },
    );
    expect(incoming).toMatchObject({
      author: "河流",
      authorId: "river",
      received: true,
      mine: false,
    });
    expect(outgoing).toMatchObject({ author: "柳树", authorId: "willow", mine: true, received: false });
  });
  it("does not fall back to unknown when a direct message carries only ids", () => {
    const [message] = inboxMessages(
      [direct({ id: "letter-3", senderId: "weiguo_being", senderName: "", content: "好" })],
      { me: "t_Fqm2l4" },
    );
    expect(message.author).toBe("weiguo_being");
    expect(message.author).not.toBe("未知");
    expect(message.recipientId).toBe("t_Fqm2l4");
    expect(message.received).toBe(true);
  });
  it.each(['river', 't_WillowFull', ''])("drafts explicitly selected private content with source identity %j", (identity) => {
    const post = vi.fn(),
      toast = vi.fn(),
      workspace = new WorkspaceModel(vi.fn(), toast, post, () => true);
    const stop = workspace.start();
    workspace.scenes.configure("willow", "https://fixture.test");
    workspace.scenes.enter("mail");
    workspace.scenes.update({ identity });
    workspace.scenes.select({
      id: "private",
      title: "letter",
      excerpt: "private text",
      private: true,
    });
    workspace.scenes.pin();
    expect(post).not.toHaveBeenCalled();
    workspace.compose();
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'beings:scene-draft', text: '一起看看私信里的这段：\n\n> private text' }));
    expect(toast).not.toHaveBeenCalled();
    workspace.scenes.resetIdentity();
    expect(workspace.open).toBe(false);
    expect(workspace.scenes.reference).toBeNull();
    stop();
  });
  it.each(['missing-being', 'missing-frame'])('still requires an available chat before drafting: %s', (missing) => {
    const post = vi.fn(), toast = vi.fn();
    const workspace = new WorkspaceModel(vi.fn(), toast, post, () => missing !== 'missing-frame');
    workspace.scenes.configure(missing === 'missing-being' ? '' : 'willow', 'https://fixture.test');
    workspace.scenes.enter('mail');
    workspace.scenes.select({ id: 'letter', title: 'letter', excerpt: 'private text', private: true });
    workspace.compose();
    expect(post).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('请先连接对话 Being。');
  });
});

describe("pending work on renderer disposal", () => {
  it("discards a Kit prepared after the renderer was unmounted", async () => {
    const pending = deferred<import("../desktop/shared/types").KitInstallPlan>();
    const discardKit = vi.fn(async () => {});
    const { model } = town({ prepareKit: () => pending.promise, discardKit });
    const stop = model.start();
    const preparing = model.prepareKit("kit");
    stop();
    pending.resolve({
      ticket: "staged-ticket",
      name: "kit",
      version: "1",
      description: "",
      tools: 0,
      command: [],
      environment: [],
      dependency: "none",
      sha256: "",
      notes: "",
    });
    await preparing;
    expect(discardKit).toHaveBeenCalledWith("staged-ticket");
    expect(model.plan).toBeUndefined();
  });
  it("does not apply a Portal snapshot requested by an earlier mount", async () => {
    const pending = deferred<Snapshot>();
    let callback!: Parameters<DesktopAPI["onPortal"]>[0];
    const fixture = api({
      onPortal: (listener) => {
        callback = listener;
        return () => {};
      },
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(state())
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(state("river")),
    });
    const app = new AppModel(fixture.value);
    const stop = app.start();
    await settle();
    callback(state().portal);
    stop();
    const stopAgain = app.start();
    await settle();
    pending.resolve(state("willow"));
    await settle();
    expect(app.snapshot?.settings.being).toBe("river");
    stopAgain();
  });
});
