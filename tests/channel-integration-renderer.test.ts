// The message-channel page's rules, without a DOM; 2026-09-16 (integration unit I7).
//
// BeingDesktop 0.8.26 pins these inside renderer/town-app.js, driven by
// test/town-conversation-ui.cjs in a real Electron window. That file cannot run
// here (no `renderer/index.html`, no BrowserWindow), so the same claims are made
// against the model that now owns them. The three that genuinely need a window —
// the card focus ring, the QR image actually rendering, and the wizard's scroll
// position — are listed in docs/migration/i7-channel-drafts.md as not covered.
import { expect, it } from "vitest";
import { CHANNEL_CARDS, CHANNEL_STATUS, ChannelModel, type ChannelHost } from "../desktop/renderer/channel/models/channel";
import type { DesktopAPI } from "../desktop/shared/types";
import type { ChannelDraftPush, ChannelOutcomeState, ChannelWorkerState } from "../desktop/shared/desktop-types";

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

const QR = "data:image/png;base64,iVBORw0KGgo=";

interface HarnessOptions {
  begin?: (request: { channel: string }) => Promise<ChannelOutcomeState>;
  check?: (request: { channel: string }) => Promise<any>;
  inspect?: (request: { channel: string }) => Promise<any>;
  catalog?: () => Promise<any>;
  draft?: (request: any) => Promise<any>;
  openPage?: (id: string) => Promise<any>;
}

function harness(options: HarnessOptions = {}) {
  const calls: { method: string; request: any }[] = [];
  const posts: any[] = [];
  const toasts: unknown[] = [];
  const navigations: string[] = [];
  const acks: { id: string; ack: string }[] = [];
  const navigate: { handler: ((feature: string, task: { id: string }) => void) | null } = { handler: null };
  let pushState: ((value: ChannelWorkerState) => void) | null = null;
  let pushDraft: ((value: ChannelDraftPush) => void) | null = null;
  const record = <T,>(method: string, body: ((request: any) => Promise<T>) | undefined, fallback: T) =>
    (request: any) => { calls.push({ method, request }); return body ? body(request) : Promise.resolve(fallback); };
  const api = {
    channel: {
      state: async (): Promise<ChannelWorkerState> => ({ channel: "", status: "unknown", detail: "", connectionRevision: 7, connected: true }),
      begin: record("begin", options.begin, { channel: "feishu", status: "pending", detail: "" } as ChannelOutcomeState),
      check: record("check", options.check, { channel: "feishu", status: "registered", detail: "", channels: [] }),
      inspect: record("inspect", options.inspect, { channels: [] }),
      feishu: async () => { throw new Error("never"); },
      catalog: () => { calls.push({ method: "catalog", request: null }); return options.catalog ? options.catalog() : Promise.resolve(catalogue()); },
      openPage: record("openPage", options.openPage ? (request: any) => options.openPage!(request) : undefined, { opened: true }),
      draft: record("draft", options.draft, { prepared: true }),
      draftResult: async (id: string, ack: string) => { acks.push({ id, ack }); },
      onState: (callback: (value: ChannelWorkerState) => void) => { pushState = callback; return () => { pushState = null; }; },
      onDraft: (callback: (value: ChannelDraftPush) => void) => { pushDraft = callback; return () => { pushDraft = null; }; },
    },
  } as unknown as DesktopAPI;
  const host: ChannelHost = {
    post: (data: unknown) => { posts.push(data); },
    navigate: (view: string) => { navigations.push(view); },
    toast: (error: unknown) => { toasts.push(error); },
    features: { featureTasks: { setNavigate: handler => { navigate.handler = handler; } } },
  };
  const model = new ChannelModel(api, host);
  return {
    model, calls, posts, toasts, navigations, acks, navigate,
    state: (value: Partial<ChannelWorkerState>) => pushState?.({ channel: "", status: "unknown", detail: "", connectionRevision: 7, connected: true, ...value }),
    draft: (value: ChannelDraftPush) => pushDraft?.(value),
  };
}

const catalogue = () => ({
  sourceUrl: "https://beings.town/", checkedAt: "2026-09-06",
  features: ["scroll", "ember", "bonfire", "fireside", "beings", "grove", "portal", "channel", "workspace"].map(id => ({
    id, name: id, label: id, description: "d", group: "g",
    mode: id === "ember" ? "web" : id === "workspace" ? "being" : "app",
  })),
});

it("the three cards read out what is bound without asking the Being", async () => {
  const f = harness({ inspect: async () => ({ channels: [{ channel: "feishu", status: "connected", detail: "已连接。" }] }) });
  const stop = f.model.start();
  await settle();
  expect(f.model.connectionRevision).toBe(7);
  expect(CHANNEL_CARDS.map(card => card.id)).toEqual(["feishu", "wechat", "wecom"]);
  // 企业微信 never reads and never asks, whatever its neighbours are doing.
  expect(f.model.cardStatus("wecom")).toBe("暂不支持");
  f.model.show(true, "channel");
  await settle();
  expect(f.calls.map(call => call.method)).toEqual(["inspect"]);
  expect(f.model.status).toBe("connected");
  expect(f.model.cardStatus("feishu")).toBe("已连接");
  f.model.select("wecom");
  await settle();
  expect(f.calls.map(call => call.method)).toEqual(["inspect"]);
  // Switching back restores what that card last confirmed rather than starting
  // from unknown (renderer/town-app.js `channelStates`).
  f.model.select("feishu");
  await settle();
  expect(f.model.status).toBe("connected");
  stop();
});

it("an unreadable channel keeps its last confirmed state and never reads as unbound", async () => {
  let answer: any = { channels: [{ channel: "feishu", status: "registered", detail: "已登记。" }] };
  const f = harness({ inspect: async () => { const value = answer; if (value instanceof Error) throw value; return value; } });
  const stop = f.model.start();
  await settle();
  await f.model.inspect();
  expect(f.model.status).toBe("registered");
  expect(f.model.cardStatus("feishu")).toBe("已有渠道登记");

  // The service answered, but with nothing it could confirm.
  answer = { channels: [{ channel: "feishu", status: "unknown", detail: "" }] };
  await f.model.inspect();
  expect(f.model.status).toBe("registered");
  expect(f.model.readError).toBe("当前接口未能确认最新状态，暂时保留上次确认结果。");

  // The read failed outright, and this client is not allowed to read it at all.
  answer = Object.assign(new Error("no"), { code: "AUTH_REQUIRED" });
  await f.model.inspect();
  expect(f.model.status).toBe("registered");
  expect(f.model.readError).toBe("保留上次确认的状态。Desktop 暂无权限直接读取渠道状态。这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。");

  // Any other read failure says so differently, and still does not judge.
  answer = new Error("network");
  await f.model.inspect();
  expect(f.model.readError).toBe("保留上次确认的状态。暂时未能读取渠道状态。这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。");
  stop();
});

it("a failure that arrives as DATA still separates the two read refusals", async () => {
  // This is the form the real bridge delivers: the preload resolves with the
  // envelope, because an Error loses its `code` crossing `contextBridge`
  // (measured — desktop/shared/channel-types.ts). The model must read the code
  // out of the data, or the AUTH_REQUIRED branch is dead in the packaged client.
  let envelope: any = { __townError: true, code: 'AUTH_REQUIRED', message: 'no' };
  const f = harness({ inspect: async () => envelope });
  const stop = f.model.start();
  await settle();
  await f.model.inspect();
  expect(f.model.readError).toBe("Desktop 暂无权限直接读取渠道状态。这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。");
  envelope = { __townError: true, code: 'SERVICE_ERROR', message: 'no' };
  await f.model.inspect();
  expect(f.model.readError).toBe("暂时未能读取渠道状态。这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。");
  stop();
});

it("nothing confirmed at all stays unknown, and a Being-facing failure is an error", async () => {
  const f = harness({
    inspect: async () => { throw new Error("network"); },
    check: async () => { throw new Error("Being 拒绝了这次核对。"); },
  });
  const stop = f.model.start();
  await settle();
  await f.model.inspect();
  expect(f.model.status).toBe("unknown");
  expect(f.model.readError).toBe("暂时未能读取渠道状态。这不代表未绑定，无需重复连接。可请 Being 核对绑定状态。");
  await f.model.check();
  expect(f.model.status).toBe("error");
  expect(f.model.detail).toBe("Being 拒绝了这次核对。");
  expect(CHANNEL_STATUS[f.model.status]).toBe("操作失败");
  stop();
});

it("a result decides the wizard step, the detail and whether a QR may be shown", async () => {
  const outcomes: ChannelOutcomeState[] = [];
  const f = harness({ check: async () => outcomes.shift()! });
  const stop = f.model.start();
  await settle();

  outcomes.push({ channel: "feishu", status: "pending", detail: "已排队。" });
  await f.model.check();
  // 「pending」is rewritten, because「等待确认」alone would read as a confirmed state.
  expect(f.model.detail).toBe("Being 已收到请求，实际连接状态仍待确认。 已排队。");
  expect(f.model.step).toBe(1);

  outcomes.push({ channel: "feishu", status: "waiting", detail: "", qrCodeDataUrl: QR });
  await f.model.check();
  expect(f.model.detail).toBe("等待扫码");
  expect(f.model.qr).toBe(QR);

  // An expired code must not leave a scannable image behind.
  outcomes.push({ channel: "feishu", status: "expired", detail: "二维码已过期。", qrCodeDataUrl: QR });
  await f.model.check();
  expect(f.model.qr).toBe("");

  // Anything that is not a validated data URL is not an image.
  for (const value of ["https://evil.example/qr.png", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,PHN2Zz4=", "x".repeat(2_000_100)]) {
    outcomes.push({ channel: "feishu", status: "waiting", detail: "", qrCodeDataUrl: value });
    await f.model.check();
    expect(f.model.qr).toBe("");
  }

  outcomes.push({ channel: "feishu", status: "connected", detail: "已连接。" });
  await f.model.check();
  expect(f.model.step).toBe(2);
  stop();
});

it("a late answer never lands on the wrong card, epoch or request", async () => {
  // Every read is held open; `release` answers every one of them at once, which
  // is the point: a switch starts another read, and BOTH answers are late.
  const held: ((value: any) => void)[] = [];
  const connected = { channels: [{ channel: "feishu", status: "connected", detail: "" }] };
  const release = () => { while (held.length) held.shift()!(connected); };
  const f = harness({ inspect: () => new Promise(resolve => { held.push(resolve); }) });
  const stop = f.model.start();
  await settle();

  // 1 · The user switched card while the read was in flight.
  const first = f.model.inspect();
  f.model.select("wechat");
  release();
  await first;
  await settle();
  expect(f.model.selected).toBe("wechat");
  expect(f.model.status).toBe("unknown");

  // 2 · The identity changed while the read was in flight: everything confirmed
  // under the previous Being is dropped rather than shown under this one.
  f.model.select("feishu");
  await settle();
  const second = f.model.inspect();
  f.state({ connectionRevision: 8 });
  release();
  await second;
  await settle();
  expect(f.model.connectionRevision).toBe(8);
  expect(f.model.status).toBe("unknown");
  expect(f.model.cardStatus("feishu")).toBe("查看绑定状态");
  stop();
});

it("a request carries the epoch the main process gave it, and one at a time", async () => {
  let release!: (value: any) => void;
  const f = harness({ check: () => new Promise(resolve => { release = resolve; }) });
  const stop = f.model.start();
  await settle();
  const pending = f.model.check();
  // A second click while the Being is thinking is ignored, not queued.
  await f.model.check();
  await f.model.begin();
  expect(f.calls.filter(call => call.method !== "state").length).toBe(1);
  expect(f.calls[0].request).toEqual({ channel: "feishu", connectionRevision: 7 });
  release({ channel: "feishu", status: "registered", detail: "已登记。", channels: [] });
  await pending;
  expect(f.model.pending).toBe(false);
  stop();
});

it("nothing is asked of the Being while no Being is bound", async () => {
  const f = harness();
  const stop = f.model.start();
  await settle();
  f.state({ connected: false });
  await f.model.check();
  await f.model.begin();
  await f.model.inspect();
  expect(f.calls.filter(call => call.method !== "state")).toEqual([]);
  stop();
});

it("the catalogue is drawn only when it is complete", async () => {
  const short = harness({ catalog: async () => ({ ...catalogue(), features: catalogue().features.slice(0, 5) }) });
  await short.model.loadCatalog();
  expect(short.model.catalogStatus).toBe("error");
  expect(short.model.catalogError).toBe("Town 功能目录不完整或格式不正确，请重新读取。");

  const wrong = harness({ catalog: async () => ({ ...catalogue(), features: catalogue().features.map(feature => ({ ...feature, mode: "local" })) }) });
  await wrong.model.loadCatalog();
  expect(wrong.model.catalogStatus).toBe("error");

  const good = harness();
  await good.model.loadCatalog();
  expect(good.model.catalogStatus).toBe("ready");
  expect(good.model.catalog.length).toBe(9);
  expect(good.model.checkedAt).toBe("2026-09-06");
});

it("each catalogue mode does its own thing, and only four features offer a draft", async () => {
  const f = harness();
  const stop = f.model.start();
  await f.model.loadCatalog();
  const feature = (id: string) => f.model.catalog.find(entry => entry.id === id)!;

  f.model.activate(feature("ember"));
  await settle();
  expect(f.calls.filter(call => call.method === "openPage").map(call => call.request)).toEqual(["ember"]);

  f.model.activate(feature("bonfire"));
  expect(f.navigations).toEqual(["bonfire"]);

  f.model.activate(feature("workspace"));
  await settle();
  expect(f.calls.filter(call => call.method === "draft").map(call => call.request)).toEqual([{ kind: "feature", id: "workspace" }]);
  expect(f.model.draftReady).toBe("已填入对话草稿，补充需求后发送");
  // The draft goes into the conversation the user then sees; it is never sent.
  expect(f.navigations.at(-1)).toBe("chat");

  expect(["scroll", "fireside", "beings", "workspace"].every(id => f.model.hasDraft(id))).toBe(true);
  expect(["channel", "bonfire", "grove", "portal", "ember"].some(id => f.model.hasDraft(id))).toBe(false);
  stop();
});

it("a pushed draft is routed through the shell’s composer and answered", async () => {
  const f = harness();
  const stop = f.model.start();
  await settle();
  f.draft({ id: "d1", text: "把这段放进草稿", expiresAt: Date.now() + 3000 });
  expect(f.posts.length).toBe(1);
  expect(f.posts[0]).toMatchObject({ type: "beings:scene-draft", id: "d1", text: "把这段放进草稿" });
  // The bridge answers with which of the two refusals applies; the model forwards
  // it verbatim, because the main process's sentence depends on it.
  f.posts[0].ack("occupied");
  expect(f.acks).toEqual([{ id: "d1", ack: "occupied" }]);

  // A push that outlived its deadline must not replace whatever the user has
  // since typed.
  f.draft({ id: "d2", text: "过期草稿", expiresAt: Date.now() - 1 });
  expect(f.posts.length).toBe(1);
  expect(f.acks.at(-1)).toEqual({ id: "d2", ack: "unavailable" });
  stop();
});

it("a conversation that never answers is reported as unavailable rather than left hanging", async () => {
  const f = harness();
  // The shell's `post` is a no-op until the conversation bridge mounts.
  const stop = f.model.start();
  await settle();
  f.draft({ id: "d3", text: "草稿", expiresAt: Date.now() + 3000 });
  await settle();
  expect(f.acks).toEqual([{ id: "d3", ack: "unavailable" }]);
  stop();
});

it("installs the feature-task page’s destination and takes it away again", async () => {
  const f = harness();
  const stop = f.model.start();
  expect(typeof f.navigate.handler).toBe("function");
  f.navigate.handler!("channel", { id: "t1" });
  expect(f.model.open).toBe(true);
  expect(f.model.tab).toBe("channel");
  for (const [feature, view] of [["bonfire", "bonfire"], ["fireside", "firesides"], ["scroll", "scrolls"], ["grove", "kits"], ["portal", "portal"], ["beings", "town"]]) {
    f.navigate.handler!(feature, { id: "t1" });
    expect(f.navigations.at(-1)).toBe(view);
  }
  // A feature with no page in this client says so instead of navigating nowhere.
  f.navigate.handler!("model", { id: "t1" });
  expect(f.toasts).toEqual(["该功能暂时没有可打开的页面。"]);
  stop();
  expect(f.navigate.handler).toBe(null);
});
