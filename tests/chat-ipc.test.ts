// New on 2026-09-16: the chat layer's IPC surface and the main-process hook that
// owns it. Not a port — BeingDesktop registers these handlers inline in
// src/main.cjs (lines 1207-1221) — but every channel's behaviour is the one
// measured there, and the request shapes come from BeingDesktop
// docs/interfaces.md §1.2「对话（原生模式）」and §1.3「主进程 → 渲染层推送」.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { sceneId } from "../desktop/main/chat/being-chat";
import { beingIdentityKey } from "../desktop/main/chat/connection";
import { unwrapMessage } from "../desktop/main/chat/frame";
import { installSubsystems } from "../desktop/main/extensions";
import { installChatSubsystem } from "../desktop/main/subsystems/chat";
import { chatErrorEnvelope, chatErrorFromEnvelope, isChatErrorEnvelope } from "../desktop/shared/chat-errors";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { Connection } from "../desktop/main/chat/connection";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const token = "c".repeat(64);
const ADDRESS = `https://echo.beings.town/cz_being/?token=${token}`;
const CONNECTION: Connection = { endpoint: "https://echo.beings.town/cz_being", being: "cz_being", token, relaySecret: token, link: `https://echo.beings.town/cz_being/?token=${token}` };
const CHANNELS = [
  "beings:chat-sessions", "beings:chat-view", "beings:chat-send", "beings:chat-stop", "beings:chat-reload",
  "beings:chat-change-session", "beings:chat-rename-session", "beings:chat-forget-session", "beings:chat-composer-data",
  // The explanation cards and the Worker preview (I5, 2026-09-16): registered by
  // the same subsystem, after the nine above.
  "beings:chat-detail-open", "beings:chat-detail-view", "beings:chat-detail-send",
  "beings:chat-detail-stop", "beings:chat-detail-close", "beings:chat-worker-result",
  // Only the conversation layer's channels: the fixture below installs the chat
  // subsystem alone, so the sidebar ledger's three (I6) are asserted in
  // tests/shell-state-ipc.test.ts, not here (merge of I3/I2/I4/I6, 2026-09-16).
];
// The five BeingDesktop 0.8.26 answers with `{__townError:true, code, message}`
// instead of throwing (src/main.cjs line 125 `townMethods`; docs/interfaces.md
// §1.2「Town 包络」). Only these can tell the renderer *why* a call failed: the
// wrapper around every channel replaces a thrown Error with its message alone.
const ENVELOPED = new Set([
  "beings:chat-view", "beings:chat-send", "beings:chat-stop", "beings:chat-reload", "beings:chat-forget-session",
  // The five card channels are in the same `townMethods` set (src/main.cjs line 126).
  "beings:chat-detail-open", "beings:chat-detail-view", "beings:chat-detail-send",
  "beings:chat-detail-stop", "beings:chat-detail-close",
]);
const SHELL = "beings://desktop/";
const json = (value: unknown, status = 200) => () =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const sse = (frames: [string, unknown][]) => () =>
  new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture({ desktopId = DESKTOP, address = ADDRESS }: { desktopId?: string; address?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-ipc-test-"));
  type Responder = (url: URL, options: RequestInit) => Response;
  const routes = new Map<string, Responder[]>(), defaults = new Map<string, Responder>();
  const calls: { path: string; body: any }[] = [];
  const on = (route: string, responder: Responder) => { if (!routes.has(route)) routes.set(route, []); routes.get(route)!.push(responder); };
  const always = (route: string, responder: Responder) => defaults.set(route, responder);
  const fetchImpl = (async (url: string, options: RequestInit) => {
    const parsed = new URL(url), route = parsed.pathname.replace(/^\/cz_being/, "");
    calls.push({ path: route, body: options.body ? JSON.parse(options.body as string) : null });
    const responder = routes.get(route)?.shift() || defaults.get(route);
    if (!responder) throw new Error(`no route: ${route}`);
    return responder(parsed, options);
  }) as unknown as typeof fetch;
  always("/api/history", json({ messages: [] }));
  always("/api/stream/active", json(null, 204));

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  let destroyed = false, quitting = false;
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => destroyed, webContents };
  const store = { connection: null as Connection | null, connectionAddress: "" };
  const secretStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  // The wrapper production registers through, not a re-creation of it: main.ts
  // hands `createTrustedHandle` to `installDesktopExtensions`, and its catch
  // replaces whatever a handler throws with `new Error(errorLog.report(channel,
  // error))` — which is `publicErrorMessage`, a short string and nothing else.
  // Calling the raw callbacks instead would let a `code` assertion pass on a path
  // that does not exist in the running client.
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => quitting, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  // The real registry machinery, installing only the subsystem under test.
  // `installDesktopExtensions` would install every subsystem in `INSTALLERS`, and
  // the channel-set assertion below — which is the point of this file — would then
  // answer for whichever integration units happen to have landed (2026-09-16, I3).
  const extensions = installSubsystems({
    handle, exclusive: operation => operation(),
    window: () => window, store, secretStorage, userData: directory, desktopId,
    clientVersion: "0.9.0", fetchImpl, onError: (scope, error) => { errors.push({ scope, error }); },
  }, [installChatSubsystem]);
  // The application only ever notifies after `verifyBeingConnection` resolved,
  // which is exactly when the address it verified is the one saved in the store.
  const connect = async (value = address) => {
    store.connection = CONNECTION; store.connectionAddress = value;
    extensions.connectionVerified(store.connection);
    await extensions.ready; await settle();
  };
  /** One `ipcRenderer.invoke`, from the sender the client trusts. */
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args);
  /** The renderer's view of the same call: desktop/preload/desktop-channels.ts
   * turns the envelope the five enveloped channels resolve with back into an
   * Error carrying `code`, and leaves every other channel alone. */
  const call = async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args);
    if (ENVELOPED.has(channel) && isChatErrorEnvelope(result)) throw chatErrorFromEnvelope(result);
    return result as any;
  };
  return {
    extensions, handlers, pushes, errors, calls, on, always, connect, call, invoke, directory, store,
    destroy: () => { destroyed = true; },
    quit: () => { quitting = true; },
    untrusted: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {}, senderFrame: { url: "https://elsewhere.example/" } }, ...args),
    cleanup: async () => { await extensions.quitting(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("the bridge registers the documented channel set and refuses to work before a Being is bound", async () => {
  const f = await fixture();
  try {
    expect([...f.handlers.keys()]).toEqual(CHANNELS);
    // Listing and the composer catalogue answer while disconnected: an empty
    // sidebar is the truth, and a refusal there would look like a failure.
    expect(await f.call("beings:chat-sessions")).toEqual({ open: false, version: 0, identityKey: "", active: "", cursor: 0, seeded: false, degraded: false, sessions: [], recovery: { phase: "idle" } });
    // CHANGED by I5 (2026-09-16): the composer catalogue is no longer a stub that
    // answers an empty shape to everyone. BeingDesktop refuses it outright while
    // nothing is bound (src/main.cjs line 1337), and its own composer never asks
    // while disconnected, so the refusal is what the renderer contract is now.
    await expect(f.call("beings:chat-composer-data")).rejects.toThrow("请先连接 Being。");
    const id = "22222222-2222-4222-8222-222222222222";
    for (const [channel, args] of [
      ["beings:chat-view", [id]], ["beings:chat-send", [{ sessionId: id, text: "早" }]],
      ["beings:chat-stop", [{ sessionId: id }]], ["beings:chat-reload", []],
      ["beings:chat-change-session", [null]], ["beings:chat-rename-session", [id, "名字"]],
      ["beings:chat-forget-session", [id]],
    ] as [string, unknown[]][]) {
      // Every channel refuses with the same sentence; only the enveloped five
      // still carry the code that says it was the connection, and that is the
      // split BeingDesktop 0.8.26 ships.
      if (ENVELOPED.has(channel)) await expect(f.call(channel, ...args)).rejects.toMatchObject({ code: "NOT_CONNECTED", message: "请先连接 Being。" });
      else await expect(f.call(channel, ...args)).rejects.toThrow("请先连接 Being。");
    }
    // The card channels refuse for their own reason, which is BeingDesktop's: the
    // card layer holds no Being binding of its own, so with nothing bound the
    // source conversation simply does not exist and no card can be open (I5).
    await expect(f.call("beings:chat-detail-open", { parentSessionId: id, reference: { text: "一段引用", source: "Being" } }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "来源会话不存在。" });
    for (const [channel, args] of [
      ["beings:chat-detail-view", [id]], ["beings:chat-detail-send", [{ sessionId: id, text: "追问" }]],
      ["beings:chat-detail-stop", [id]],
    ] as [string, unknown[]][])
      await expect(f.call(channel, ...args)).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "解释卡片已关闭。" });
    // Closing is the exception, and deliberately so: the renderer removes the
    // card either way, so a card the main process has never heard of closes
    // successfully rather than stranding a reader (src/chat-details.cjs `close`).
    expect(await f.call("beings:chat-detail-close", id)).toBe(true);
    // The Worker preview is bare, as `chatOpenWorkerResult` is in 0.8.26.
    await expect(f.call("beings:chat-worker-result", { sessionId: id, workerId: "w-1" })).rejects.toThrow("请先连接 Being。");
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a profile with no Desktop identity says so instead of blaming the connection", async () => {
  const f = await fixture({ desktopId: "" });
  try {
    expect(f.errors.map(entry => entry.scope)).toEqual(["chat-identity"]);
    await f.connect();
    // Still refused after a good connection: the scene namespace is what is missing.
    await expect(f.call("beings:chat-reload")).rejects.toMatchObject({ code: "NOT_CONNECTED", message: "Desktop 身份不可用，原生对话暂时无法使用。请检查客户端配置目录后重启。" });
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a verified connection reads a baseline, probes for a breath already running, and never exposes the address", async () => {
  const f = await fixture();
  try {
    await f.connect();
    expect(f.calls.map(call => call.path)).toEqual(["/api/history", "/api/stream/active"]);
    const state = await f.call("beings:chat-sessions");
    expect(state).toMatchObject({ open: true, active: expect.any(String), cursor: 0, seeded: true, degraded: false });
    // `identityKey` is a connection address. Only whether one is bound crosses IPC.
    expect(state.identityKey).toBe("bound");
    expect(JSON.stringify(state)).not.toContain(token);
    // A row belongs to the conversation its scene names. One the Being wrote
    // elsewhere still moves the cursor, but it is not in this transcript.
    f.on("/api/history", json({ messages: [
      { seq: 4, role: "user", content: "早", at: "t", scene_id: sceneId(DESKTOP, state.active) },
      { seq: 5, role: "being", content: "在别处", at: "t", scene_id: "loom-elsewhere" },
    ] }));
    expect(await f.call("beings:chat-reload")).toEqual({ ok: true, added: 1, error: "" });
    const view = await f.call("beings:chat-view", state.active);
    expect(view).toMatchObject({ sessionId: state.active, rows: [{ seq: 4, role: "user", content: "早" }], sent: [], replied: [], live: null, workerResults: [] });
    expect((await f.call("beings:chat-sessions")).cursor).toBe(5);
    // A closed whitelist, not a filter: the conversation layer pushes state, and
    // the sidebar ledger answers a new binding with its own (I6). Anything else
    // appearing here would be a channel nobody declared.
    // `beings:chat-detail-event` joined the whitelist with I5: binding a Being
    // drops every explanation card, because their source conversations belong to
    // the Being being replaced (BeingDesktop src/main.cjs line 549).
    expect(f.pushes.every(push => ["beings:chat-state", "beings:chat-detail-event", "beings:sidebar"].includes(push.channel))).toBe(true);
    expect(f.pushes.filter(push => push.channel === "beings:chat-detail-event").map(push => push.payload)).toEqual([{ type: "reset" }]);
    expect(f.pushes.filter(push => push.channel === "beings:chat-state").at(-1)!.payload).toMatchObject({ open: true, identityKey: "bound" });
    // Re-verifying the same Being keeps the timeline instead of rebuilding it.
    const before = f.calls.length;
    await f.connect();
    expect(f.calls.length).toBe(before);
    expect((await f.call("beings:chat-sessions")).active).toBe(state.active);
  } finally { await f.cleanup(); }
});

test("input the renderer should never send is refused before it reaches the network", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const id = (await f.call("beings:chat-sessions")).active;
    const before = f.calls.length;
    const refuse = async (channel: string, ...args: unknown[]) => {
      const rejects = expect(f.call(channel, ...args)).rejects;
      await (ENVELOPED.has(channel) ? rejects.toMatchObject({ code: "INVALID_REQUEST" }) : rejects.toThrowError(Error));
    };
    // A session id that is not a UUID never reaches the store.
    for (const bad of ["", "not-a-uuid", 7, null, { id }, `${id}\n`]) await refuse("beings:chat-view", bad);
    await refuse("beings:chat-change-session", "not-a-uuid");
    await refuse("beings:chat-forget-session", "not-a-uuid");
    // An unknown field means the caller and this contract disagree; guessing
    // which of the two is right is how a stale renderer loses a parameter.
    await refuse("beings:chat-send", { sessionId: id, text: "早", tone: "cheerful" });
    await refuse("beings:chat-send", "早");
    await refuse("beings:chat-send", { sessionId: id, text: 7 });
    await refuse("beings:chat-send", { sessionId: id, text: "早", images: "one" });
    await refuse("beings:chat-send", { sessionId: id, text: "早", references: "quote" });
    await refuse("beings:chat-stop", { sessionId: id, force: "yes" });
    await refuse("beings:chat-stop", { sessionId: id, reason: "bored" });
    await refuse("beings:chat-rename-session", id, 7);
    // The measured envelope belongs to the session layer, and holds all the same.
    await refuse("beings:chat-send", { sessionId: id, text: "" });
    await refuse("beings:chat-send", { sessionId: id, text: "早", images: Array.from({ length: 9 }, () => ({ media_type: "image/png", data: "AAAA" })) });
    await refuse("beings:chat-send", { sessionId: id, text: "早", images: [{ media_type: "image/tiff", data: "AAAA" }] });
    await refuse("beings:chat-send", { sessionId: id, text: "", images: [{ media_type: "image/png", data: "AAAA" }] });
    await refuse("beings:chat-send", { sessionId: id, text: "早", references: Array.from({ length: 13 }, () => ({ text: "引用" })) });
    await refuse("beings:chat-send", { sessionId: id, text: "早", references: [{ text: "x".repeat(60001) }] });
    // 200000 code points, not UTF-16 units: an emoji counts once.
    await refuse("beings:chat-send", { sessionId: id, text: "🙂".repeat(200001) });
    // BeingDesktop 0.8.26 src/main.cjs line 1152 and docs/interfaces.md line 89:
    // 1–80 characters, no control characters. Both halves have to be checked
    // before the title is collapsed — `ChatSessions.rename` folds whitespace runs
    // first, which would let 82 typed characters through as 80, and JS `\s`
    // covers none of NUL, BEL or DEL, so those would land in the encrypted cache
    // and the sidebar verbatim.
    const TITLE_REFUSAL = "会话名须为 1–80 个字符，且不能包含换行。";
    for (const bad of ["  ", "名".repeat(81), "a\u0000b", "a\u0007b", "a\u007fb", "a\nb", `${"x".repeat(78)}   y`])
      await expect(f.call("beings:chat-rename-session", id, bad)).rejects.toThrow(TITLE_REFUSAL);
    // …and 80 characters that are only long, not malformed, are still a title.
    expect(await f.call("beings:chat-rename-session", id, "名".repeat(80))).toBe(true);
    expect(f.calls.length).toBe(before);
  } finally { await f.cleanup(); }
});

test("a message sent through the bridge streams its reply to the window in the documented shape", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const id = (await f.call("beings:chat-sessions")).active, scene = sceneId(DESKTOP, id);
    // The server echoes the `client_ref` we minted; that echo is what turns a
    // stream from "someone is speaking" into "this is the answer to my message"
    // (docs/desktop-message-layer.md §一).
    f.on("/api/chat/stream", (_url, options) => sse([
      ["meta", { scene_id: scene, stream_id: "s-1", client_ref: JSON.parse(options.body as string).client_ref }],
      ["content_block_delta", { scene_id: scene, delta: { text: "早" } }],
      ["message_stop", { scene_id: scene }],
    ])());
    expect(await f.call("beings:chat-send", { sessionId: id, text: "在吗" })).toMatchObject({ ok: true, streamed: true, spliced: false });
    await settle();
    const post = f.calls.find(call => call.path === "/api/chat/stream")!;
    // CHANGED by I5 (2026-09-16): the wire text now carries the request context
    // frame, which is the whole point of `prepareMessage`. What the Being is sent
    // is the frame plus the human's words; what `unwrapMessage` gives back is the
    // words alone, and that is what the transcript and the cache keep.
    expect(post.body.message.startsWith("[Being Desktop request context v1; length=")).toBe(true);
    expect(unwrapMessage(post.body.message)).toBe("在吗");
    expect(post.body).toMatchObject({ scene_id: scene, scene_meta: { scene_label: "新会话" } });
    const events = f.pushes.filter(push => push.channel === "beings:chat-event").map(push => push.payload);
    expect(events.map(event => event.type)).toEqual(["sent", "meta", "delta", "reply"]);
    expect(events[0]).toEqual({ sessionId: id, type: "sent", text: "在吗", images: 0 });
    expect(events[1]).toMatchObject({ sessionId: id, type: "meta", streamId: "s-1", scene, confirmed: true });
    expect(events[2]).toEqual({ sessionId: id, type: "delta", text: "早" });
    expect(events[3]).toMatchObject({ sessionId: id, type: "reply", text: "早" });
    const view = await f.call("beings:chat-view", id);
    expect(view.sent).toEqual([{ text: "在吗", at: expect.any(String), after: 0 }]);
    expect(view.replied).toEqual([{ text: "早", final: "早", think: "", at: expect.any(String), after: 0 }]);
    // `misses` is how expiry is counted. It stays inside the session layer.
    expect(JSON.stringify(view)).not.toContain("misses");
    expect(view.live).toBe(null);
  } finally { await f.cleanup(); }
});

test("conversations are created, renamed, selected and forgotten through their own channels", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const first = (await f.call("beings:chat-sessions")).active;
    const second = await f.call("beings:chat-change-session", null);
    expect(second).not.toBe(first);
    expect((await f.call("beings:chat-sessions")).active).toBe(second);
    expect(await f.call("beings:chat-rename-session", second, "  下午的   讨论  ")).toBe(true);
    expect(await f.call("beings:chat-change-session", first)).toBe(first);
    const listed = (await f.call("beings:chat-sessions")).sessions;
    expect(listed.find((item: any) => item.id === second)).toMatchObject({ title: "下午的 讨论", titleSource: "manual", busy: false, inFlight: false });
    expect(await f.call("beings:chat-forget-session", second)).toBe(true);
    expect((await f.call("beings:chat-sessions")).sessions.map((item: any) => item.id)).toEqual([first]);
    f.on("/api/history", json({ messages: [{ seq: 9, role: "being", content: "回来了", at: "t", scene_id: sceneId(DESKTOP, first) }] }));
    expect(await f.call("beings:chat-reload")).toEqual({ ok: true, added: 1, error: "" });
    expect((await f.call("beings:chat-view", first)).rows).toMatchObject([{ seq: 9, role: "being", content: "回来了" }]);
  } finally { await f.cleanup(); }
});

test("the cache is filed under BeingDesktop 0.8.x's own identity, and quitting flushes it before the layer closes", async () => {
  const f = await fixture();
  try {
    // Golden values taken from BeingDesktop 0.8.26 src/security.cjs
    // sessionPartition on 2026-09-16. The trailing slash and the `api=` /
    // `relay_secret=` parameters all change the file a profile reads.
    expect(beingIdentityKey(ADDRESS)).toBe("persist:loom-v1-f7de495408e96692cad3d377cebea48d");
    expect(beingIdentityKey(`https://echo.beings.town/cz_being?token=${token}`)).toBe("persist:loom-v1-9858af24a3d66ada7b19ee067f57ab0f");
    expect(beingIdentityKey(`${ADDRESS}&api=https://echo.beings.town/api-root/&relay_secret=s3cret`)).toBe("persist:loom-v1-f828057408066361ee69ba2004d910e0");
    f.on("/api/history", json({ messages: [{ seq: 2, role: "user", content: "记住这句", at: "t" }] }));
    await f.connect();
    await f.extensions.quitting();
    expect(await readdir(path.join(f.directory, "chat-cache"))).toEqual(["88de5aab1dd5808ab15a86c9fb6fdc1d9c22ab90d2cfa5af9d20b0cfb68cc4ac.bin"]);
    expect((await f.call("beings:chat-sessions")).open).toBe(false);
    await expect(f.call("beings:chat-reload")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    // A window that has gone away is not a place to push to.
    f.destroy();
    await f.extensions.connectionCleared();
  } finally { await f.cleanup(); }
});

test("a conversation channel answers a refusal with data, because a code thrown from a handler does not survive", async () => {
  const f = await fixture();
  try {
    await f.connect();
    // What actually crosses IPC on the five enveloped channels, byte for byte:
    // BeingDesktop 0.8.26 returns this object from its own handler rather than
    // throwing (src/main.cjs line 741), and src/preload.cjs line 60 rebuilds the
    // Error from it.
    expect(await f.invoke("beings:chat-view", "not-a-uuid")).toEqual({ __townError: true, code: "INVALID_REQUEST", message: "会话不存在。" });
    await f.extensions.connectionCleared();
    expect(await f.invoke("beings:chat-reload")).toEqual({ __townError: true, code: "NOT_CONNECTED", message: "请先连接 Being。" });
    // The same refusal on a bare channel is what the envelope exists to avoid:
    // `createTrustedHandle` rebuilds the Error out of `report()` alone, so by the
    // time the renderer sees it the code is gone and only the sentence is left.
    const bare = await f.call("beings:chat-change-session", null).then(() => null, (error: Error & { code?: string }) => error);
    expect(bare).toMatchObject({ message: "请先连接 Being。" });
    expect(bare!.code).toBeUndefined();
    // A code from somewhere else is not forwarded, and neither is its text.
    expect(chatErrorEnvelope(Object.assign(new Error("内部细节"), { code: "SOMETHING_ELSE" })))
      .toEqual({ __townError: true, code: "TOWN_ERROR", message: "Town 操作未完成，请稍后重试。" });
    expect(chatErrorFromEnvelope({ __townError: true, code: "TOWN_ERROR", message: "内部细节" }).message).toBe("Town 操作未完成，请稍后重试。");
  } finally { await f.cleanup(); }
});

test("the wrapper every channel is registered through refuses an untrusted sender and a client that is quitting", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const reads = f.calls.length;
    // A frame that is not the trusted shell's own main frame gets no answer at
    // all — not even the empty session list this channel hands the renderer.
    await expect(f.untrusted("beings:chat-sessions")).rejects.toThrow("Untrusted IPC sender");
    f.quit();
    // Both guards run before the handler, so their refusal is a plain Error on
    // every channel alike: there is no handler result left to put in an envelope.
    for (const channel of CHANNELS) await expect(f.call(channel)).rejects.toThrow("客户端正在退出，请稍候。");
    expect(f.calls.length).toBe(reads);
  } finally { await f.cleanup(); }
});
