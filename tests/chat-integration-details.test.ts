// The explanation cards and the Worker preview, through the real bridge; new on
// 2026-09-16 (integration unit I5).
//
// Ported behaviour: BeingDesktop 0.8.26 src/chat-details.cjs (the card layer) and
// src/main.cjs lines 1208-1218 (the channels it is reached through), with the
// renderer's rules taken from test/chat-selection-ui.cjs — a card belongs to one
// source conversation, at most eight are open at once, closing the last one drops
// the reader, and a Being switch clears them all with one push and no further
// close or stop request.
//
// The registry is the real one, installing the conversation subsystem and — for
// the preview channel — a real `Orchestration` behind a stand-in installer. The
// IPC wrapper is `createTrustedHandle`, the same one main.ts registers through, so
// the sender check and the envelope behave here exactly as they do in the client.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { installSubsystems } from "../desktop/main/extensions";
import { installChatSubsystem } from "../desktop/main/subsystems/chat";
import { Orchestration } from "../desktop/main/orchestration/orchestration";
import type {
  AgentExitResult, PresentationOpenContext, WorkerPresentationValue, WorkerRecord,
} from "../desktop/main/orchestration/types";
import type { SubsystemInstaller } from "../desktop/main/subsystems/types";
import { chatErrorFromEnvelope, isChatErrorEnvelope } from "../desktop/shared/chat-errors";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { Connection } from "../desktop/main/chat/connection";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const token = "c".repeat(64);
const ADDRESS = `https://echo.beings.town/cz_being/?token=${token}`;
const CONNECTION: Connection = { endpoint: "https://echo.beings.town/cz_being", being: "cz_being", token, relaySecret: token, link: ADDRESS };
const SHELL = "beings://desktop/";
const ENVELOPED = new Set([
  "beings:chat-view", "beings:chat-send", "beings:chat-stop", "beings:chat-reload", "beings:chat-forget-session",
  "beings:chat-detail-open", "beings:chat-detail-view", "beings:chat-detail-send",
  "beings:chat-detail-stop", "beings:chat-detail-close",
]);

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const sse = (frames: [string, unknown][]) =>
  new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

/** A `WorkerPresenter` as a class, because production assigns a class instance
 * here (`WorkerPresentation`, from the tool bridge's `linked()`) and an object
 * literal would hide a shape difference the client would hit. */
class PresenterDouble {
  opened: { workerId: string; artifactPath?: string | null }[] = [];
  async open(worker: WorkerRecord, args: { artifactPath?: string | null; url?: string | null }, context: PresentationOpenContext): Promise<WorkerPresentationValue> {
    this.opened.push({ workerId: worker.id, artifactPath: args.artifactPath });
    if (!context.current()) throw new Error("结果所属连接已变化。");
    return { state: "loaded", artifactPath: args.artifactPath || "", tabId: "tab-1" };
  }
  describe(value: WorkerPresentationValue | undefined) { return value; }
  async dispose() { /* Nothing is held. */ }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-details-"));
  const calls: { path: string; body: any }[] = [];
  let historyRows: unknown[] = [];
  let detailReply = "这段话区分了**保存数据**与**利用数据**。";
  const fetchImpl = (async (url: string, options: RequestInit) => {
    const parsed = new URL(url), route = parsed.pathname.replace(/^\/cz_being/, "");
    const body = options.body ? JSON.parse(options.body as string) : null;
    calls.push({ path: route, body });
    if (route === "/api/history") return json({ messages: historyRows });
    if (route === "/api/stream/active") return json(null, 204);
    if (route === "/api/stop") return json({ stopped: true });
    if (route === "/api/chat/stream")
      return sse([["meta", { scene_id: body.scene_id, stream_id: "s-" + calls.length, client_ref: body.client_ref }],
        ["content_block_delta", { scene_id: body.scene_id, delta: { text: detailReply } }],
        ["message_stop", { scene_id: body.scene_id }]]);
    throw new Error(`no route: ${route}`);
  }) as unknown as typeof fetch;

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  let destroyed = false, quitting = false;
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => destroyed, webContents };
  const store = { connection: null as Connection | null, connectionAddress: "" };
  const secretStorage = { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => quitting, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });

  const manager = new Orchestration({
    directory, getWorkspace: () => directory,
    getSessionIds: () => (extensions.chat?.snapshot().sessions ?? []).map(item => item.id),
    getExecutionContext: () => ({ desktopId: DESKTOP }),
    detect: async () => [{ id: "codex", name: "Codex CLI", path: "/fixture/codex", status: "ready" }],
    launch: options => {
      let finish!: (result: AgentExitResult) => void;
      return { ...options, done: new Promise<AgentExitResult>(resolve => { finish = resolve; }), stop: async () => finish({ code: null, stopped: true }) };
    },
  });
  const presenter = new PresenterDouble();
  manager.presentation = presenter;
  // A stand-in installer, not a stand-in manager: the instance it publishes is the
  // real `Orchestration` above. The cast covers only the members of
  // `OrchestrationSubsystem` the conversation layer never touches (the feature
  // ledger's runner and histories, which belong to that unit's own tests).
  const installOrchestration = (() => ({ key: "orchestration", orchestration: manager, policy: { inspectForMessage: async () => ({ status: "disabled", scope: "desktop" }) } })) as unknown as SubsystemInstaller;

  const extensions = installSubsystems({
    handle, exclusive: operation => operation(),
    window: () => window, store, secretStorage, userData: directory, desktopId: DESKTOP,
    clientVersion: "0.9.0", fetchImpl, onError: (scope, error) => { errors.push({ scope, error }); },
  }, [installChatSubsystem, installOrchestration]);

  const connect = async (identity = ADDRESS) => {
    store.connection = CONNECTION; store.connectionAddress = identity;
    extensions.connectionVerified(store.connection);
    await extensions.ready; await settle();
  };
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args);
  const call = async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args);
    if (ENVELOPED.has(channel) && isChatErrorEnvelope(result)) throw chatErrorFromEnvelope(result);
    return result as any;
  };
  cleanups.push(async () => { await extensions.quitting(); await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return {
    extensions, manager, presenter, calls, pushes, errors, call, connect, store,
    active: async () => (await call("beings:chat-sessions")).active as string,
    details: () => pushes.filter(push => push.channel === "beings:chat-detail-event").map(push => push.payload),
    resets: () => pushes.filter(push => push.channel === "beings:chat-detail-event" && push.payload.type === "reset").length,
    set history(value: unknown[]) { historyRows = value; },
    set reply(value: string) { detailReply = value; },
  };
}

test("a card opens against its own conversation, its own scene and its own reader", async () => {
  const f = await fixture();
  await f.connect();
  const parent = await f.active();
  const reference = { text: "而且需要更严格一点：如果“无限”只是能一直保存数据，那么它不足以形成独特的应用优势。", source: "Being" as const };
  const card = await f.call("beings:chat-detail-open", { parentSessionId: parent, reference });
  expect(card).toMatchObject({ parentSessionId: parent, reference, sending: false, rows: [], sent: [], replied: [] });
  expect(card.sessionId).not.toBe(parent);
  // The card's scene is not one the main conversation's namespace can name: the
  // card layer builds a fresh random Desktop id, so nothing it says can ever be
  // imported into a real conversation (src/chat-details.cjs).
  await f.call("beings:chat-detail-send", { sessionId: card.sessionId, text: "请解释所选文本的含义。" });
  await settle();
  const post = f.calls.filter(item => item.path === "/api/chat/stream").at(-1)!;
  expect(String(post.body.scene_id).startsWith(`desktop-${DESKTOP}-`)).toBe(false);
  // The quotation travels with the question, encoded the way the main composer
  // encodes one, so the Being is told what is being asked about.
  expect(post.body.message).toContain(reference.text);
  const view = await f.call("beings:chat-detail-view", card.sessionId);
  expect(view.replied.map((item: { text: string }) => item.text)).toEqual(["这段话区分了**保存数据**与**利用数据**。"]);
  // The main conversation never saw any of it.
  expect((await f.call("beings:chat-view", parent)).rows).toEqual([]);
});

test("cards are refused for a conversation that is not this Being's, and capped at eight", async () => {
  const f = await fixture();
  await f.connect();
  const parent = await f.active();
  const reference = { text: "一段足够长的引用文本，用来开卡片。", source: "you" as const };
  await expect(f.call("beings:chat-detail-open", { parentSessionId: randomUUID(), reference }))
    .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "来源会话不存在。" });
  // A quotation outside the reference limits is refused by the reference layer,
  // not silently truncated, and an unknown field is refused by the channel.
  await expect(f.call("beings:chat-detail-open", { parentSessionId: parent, reference: { text: "x".repeat(60001), source: "you" } }))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(f.call("beings:chat-detail-open", { parentSessionId: parent, reference: { text: "   ", source: "you" } }))
    .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "所选文本不能为空。" });
  // `source` is narrowed rather than echoed — the quotation is data, and an
  // unknown attribution reads as the Being's rather than as the user's own.
  const coerced = await f.call("beings:chat-detail-open", { parentSessionId: parent, reference: { text: "有效", source: "somebody" } });
  expect(coerced.reference).toEqual({ text: "有效", source: "Being" });
  expect(await f.call("beings:chat-detail-close", coerced.sessionId)).toBe(true);
  await expect(f.call("beings:chat-detail-open", { parentSessionId: parent, reference, extra: 1 }))
    .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "解释卡片参数无效。" });
  // Eight is the limit BeingDesktop sets, and the ninth says which way out there is.
  const opened: string[] = [];
  for (let index = 0; index < 8; index++) opened.push((await f.call("beings:chat-detail-open", { parentSessionId: parent, reference })).sessionId);
  await expect(f.call("beings:chat-detail-open", { parentSessionId: parent, reference }))
    .rejects.toMatchObject({ code: "BUSY", message: "请先关闭一个解释卡片。" });
  // Closing one makes room again, and a card closed twice is still closed.
  expect(await f.call("beings:chat-detail-close", opened[0])).toBe(true);
  expect(await f.call("beings:chat-detail-close", opened[0])).toBe(true);
  expect((await f.call("beings:chat-detail-open", { parentSessionId: parent, reference })).sessionId).toBeTruthy();
});

test("a card that is already replying refuses a second question rather than queueing it", async () => {
  const f = await fixture();
  await f.connect();
  const parent = await f.active();
  const card = await f.call("beings:chat-detail-open", { parentSessionId: parent, reference: { text: "一段足够长的引用文本。", source: "Being" } });
  const first = f.call("beings:chat-detail-send", { sessionId: card.sessionId, text: "第一问" });
  await expect(f.call("beings:chat-detail-send", { sessionId: card.sessionId, text: "第二问" }))
    .rejects.toMatchObject({ code: "BUSY", message: "这张卡片正在回复，请稍候。" });
  await first;
});

test("binding another Being drops every card with one push and no further requests", async () => {
  const f = await fixture();
  await f.connect();
  const parent = await f.active();
  const card = await f.call("beings:chat-detail-open", { parentSessionId: parent, reference: { text: "一段足够长的引用文本。", source: "Being" } });
  // One reset so far: binding this Being cleared the (empty) set of cards.
  expect(f.resets()).toBe(1);
  const before = f.calls.length;
  await f.connect(`https://echo.beings.town/other_being/?token=${token}`);
  // One more `reset`, and nothing else: no close, no stop, no request of any kind
  // for the cards that just went away (test/chat-selection-ui.cjs, last check).
  expect(f.resets()).toBe(2);
  expect(f.details().at(-1)).toEqual({ type: "reset" });
  expect(f.calls.slice(before).some(item => item.path === "/api/stop")).toBe(false);
  await expect(f.call("beings:chat-detail-view", card.sessionId))
    .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "解释卡片已关闭。" });
});

test("stopping a card never forces its way into another conversation's breath", async () => {
  const f = await fixture();
  await f.connect();
  const parent = await f.active();
  const card = await f.call("beings:chat-detail-open", { parentSessionId: parent, reference: { text: "一段足够长的引用文本。", source: "Being" } });
  const result = await f.call("beings:chat-detail-stop", card.sessionId);
  expect(result).toMatchObject({ stopped: expect.any(Boolean) });
  // `force` is not a parameter of this channel at all: the card can only ever
  // stop its own breath (src/main.cjs line 1217 passes the id alone).
  await expect(f.call("beings:chat-detail-stop", { sessionId: card.sessionId, force: true }))
    .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "解释卡片已关闭。" });
});

test("a Worker preview opens only for this Being, and only for its own conversation", async () => {
  const f = await fixture();
  await f.connect();
  const parent = await f.active();
  const workerId = randomUUID();
  f.manager.workers.push({
    id: workerId, sessionId: parent, title: "像素多米诺骨牌", endedAt: "2026-09-14T09:01:00Z",
    taskPrompt: "PRIVATE", sessionToken: "PRIVATE", events: [], status: "completed",
    presentation: { artifactPath: "index.html" },
    review: { status: "passed", summary: "页面已完成。", evidence: "隔离测试验证了操作流程。" },
  } as unknown as WorkerRecord);

  // The ledger belongs to nobody yet: the projection is empty and the preview is
  // refused, because a Worker started under another Being must not surface here.
  expect((await f.call("beings:chat-view", parent)).workerResults).toEqual([]);
  await expect(f.call("beings:chat-worker-result", { sessionId: parent, workerId })).rejects.toThrow("Being 连接已变化。");

  await f.manager.selectOwner(f.extensions.chat!.identityKey);
  f.manager.workers.push({
    id: workerId, sessionId: parent, title: "像素多米诺骨牌", endedAt: "2026-09-14T09:01:00Z",
    taskPrompt: "PRIVATE", sessionToken: "PRIVATE", events: [], status: "completed",
    presentation: { artifactPath: "index.html" },
    review: { status: "passed", summary: "页面已完成。", evidence: "隔离测试验证了操作流程。" },
  } as unknown as WorkerRecord);
  const results = (await f.call("beings:chat-view", parent)).workerResults;
  expect(results).toEqual([{
    workerId, sessionId: parent, title: "像素多米诺骨牌", at: "2026-09-14T09:01:00Z",
    preview: true, status: "passed", summary: "页面已完成。", evidence: "隔离测试验证了操作流程。",
  }]);
  // Display fields only: the prompt, the session token and the artifact path stay
  // in the Worker ledger (src/native-worker-results.cjs).
  expect(JSON.stringify(results)).not.toContain("PRIVATE");
  expect(JSON.stringify(results)).not.toContain("artifactPath");

  await f.call("beings:chat-worker-result", { sessionId: parent, workerId });
  expect(f.presenter.opened).toEqual([{ workerId, artifactPath: "index.html" }]);
  // Another conversation's id refuses before the manager is reached.
  await expect(f.call("beings:chat-worker-result", { sessionId: randomUUID(), workerId }))
    .rejects.toThrow("会话不存在。");
  for (const bad of [{ sessionId: parent }, { sessionId: parent, workerId: 7 }, { sessionId: parent, workerId: "w".repeat(101) }, { sessionId: parent, workerId, extra: 1 }])
    await expect(f.call("beings:chat-worker-result", bad)).rejects.toThrow(Error);
});

test("a finished Worker moves the snapshot, so the conversation re-reads and the card appears", async () => {
  const f = await fixture();
  await f.connect();
  const sessions = f.extensions.chat!;
  // The assertion BeingDesktop's test/native-orchestration.test.cjs ends its
  // projection case with, and the one tests/orchestration-native-results.test.ts
  // deferred to this unit: `workersChanged()` is how a review reaches the
  // conversation it belongs to — the orchestration subsystem calls it from
  // `onChange`, and without a version bump the renderer never re-reads the view.
  const before = sessions.snapshot().version;
  sessions.workersChanged();
  expect(sessions.snapshot().version).toBeGreaterThan(before);
  expect(f.pushes.filter(push => push.channel === "beings:chat-state").at(-1)!.payload.version).toBe(sessions.snapshot().version);
});
