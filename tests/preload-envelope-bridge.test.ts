// The error envelope's two halves, end to end; 2026-09-17 (integration unit IN).
//
// The subject is the repair described in desktop/preload/main-world.ts: an error
// `code` used to die on the `contextBridge` boundary because the preload rebuilt
// the Error one step too early. What is asserted here is the contract that
// survives the measurement — the envelope crosses as data on the REJECTION path,
// and the page's own world turns it back into a real Error carrying `code`,
// `candidates` and `detail`.
//
// What this file cannot assert is the measurement itself (that needs Electron):
// tests/town-sdk.mjs and tests/town-ui.mjs do it on the packaged client.
import { expect, test, vi } from "vitest";
import {
  CHAT_ERROR_FALLBACK, chatErrorFromEnvelope, chatErrorPayload,
} from "../desktop/shared/chat-errors";
import {
  TOWN_ERROR_CODES, TOWN_ERROR_FALLBACK, townErrorFromEnvelope, townErrorPayload,
} from "../desktop/shared/town-desktop-errors";
import { installDecodedBridge } from "../desktop/preload/main-world";
import { publicErrorMessage } from "../desktop/shared/errors";
import { envelopesAreRebuiltInPreload, enveloped, townEnveloped } from "../desktop/preload/channels/bridge";

// The preload channel files are the other half of the path, so drive the real
// ones rather than a hand-written stand-in. Only `invoke` and the two listener
// calls are reached from here.
const invoked: { channel: string; args: unknown[] }[] = [];
let answer: (channel: string) => unknown = () => ({});
vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      return Promise.resolve(answer(channel));
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));
const { desktopChannels } = await import("../desktop/preload/channels/index");

let globals = 0;
/** Install under a name of its own: `Object.defineProperty` matches what
 * `exposeInMainWorld` does — `configurable:false` — so a test cannot take a name
 * back once it has used it. */
function install(raw: Record<string, unknown>): Record<string, unknown> {
  const name = `__inBridge${globals++}`;
  expect(installDecodedBridge(raw, name)).toBe(name);
  return (globalThis as unknown as Record<string, Record<string, unknown>>)[name];
}

const rejects = (value: unknown) => () => Promise.reject(value);

// ── the normalising half, in the preload ──────────────────────────────────────

test("an envelope crossing the bridge keeps the allowlist and the truncation the Error rebuild applied", () => {
  expect(chatErrorPayload({ __townError: true, code: "BUSY", message: "忙" }))
    .toEqual({ __townError: true, code: "BUSY", message: "忙" });
  // A code no subsystem may mint loses its message too: 0.8.26 refuses to forward
  // the text of a failure it cannot categorise, because that text can be upstream.
  expect(chatErrorPayload({ __townError: true, code: "PAIR_CODE_INVALID" as never, message: "上游正文" }))
    .toEqual({ __townError: true, code: "TOWN_ERROR", message: CHAT_ERROR_FALLBACK });
  expect(chatErrorPayload({ __townError: true, code: "BUSY", message: "字".repeat(4000) }).message)
    .toHaveLength(2000);
  // The two codes I6b appended to the conversation list are on it.
  expect(chatErrorPayload({ __townError: true, code: "NEEDS_KEY", message: "请先填写密钥。" }).code).toBe("NEEDS_KEY");
});

test("a NOT_SENT envelope carries the recipients Town offered, capped and cleaned", () => {
  const payload = townErrorPayload({
    __townError: true, code: "NOT_SENT", message: "收件人有歧义",
    candidates: [
      { town_id: "t_NeoA", display_name: "Neo\u0000A" },
      { town_id: "t_NeoB", display_name: "Neo B" },
      ...Array.from({ length: 200 }, (_, index) => ({ town_id: `t_${index}`, display_name: `名 ${index}` })),
    ],
    detail: "详".repeat(900),
  });
  expect(payload.candidates).toHaveLength(100);
  expect(payload.candidates?.[0]).toEqual({ town_id: "t_NeoA", display_name: "NeoA" });
  expect(payload.detail).toHaveLength(500);
  // Every other code drops the field rather than forwarding an unrelated list.
  expect(townErrorPayload({ __townError: true, code: "BUSY", message: "忙", candidates: [{ town_id: "t", display_name: "n" }] }))
    .toEqual({ __townError: true, code: "BUSY", message: "忙" });
  expect(townErrorPayload({ __townError: true, code: "NOPE" as never, message: "上游正文" }))
    .toEqual({ __townError: true, code: "TOWN_ERROR", message: TOWN_ERROR_FALLBACK });
});

test("the feature task ledger's own limit is a code that may cross", () => {
  // I7 had to spell the sentence out in its own IPC file because this list did
  // not carry the code (docs/migration/i7-channel-drafts.md R2). BeingDesktop
  // src/main.cjs line 127 has it; now so does this.
  expect(TOWN_ERROR_CODES).toContain("TASK_LIMIT_REACHED");
  expect(townErrorPayload({
    __townError: true, code: "TASK_LIMIT_REACHED", message: "功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。",
  })).toEqual({
    __townError: true, code: "TASK_LIMIT_REACHED", message: "功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。",
  });
});

test("the preload rejects with the envelope itself, not with an Error", () => {
  // The whole repair in one assertion. An Error thrown HERE reaches the page with
  // own properties ["message","stack"] and nothing else, so the preload must hand
  // the envelope across as data and let the page rebuild it (main-world.ts).
  expect(envelopesAreRebuiltInPreload()).toBe(false);
  answer = () => ({ __townError: true, code: "AUTH_REQUIRED", message: "请先完成配对。" });
  const chat = enveloped("beings:chat-view", "s1").then(() => null, (reason: unknown) => reason);
  const town = townEnveloped("beings:town-bonfire", {}).then(() => null, (reason: unknown) => reason);
  return Promise.all([chat, town]).then(([one, two]) => {
    for (const reason of [one, two]) {
      expect(reason).not.toBeInstanceOf(Error);
      expect(reason).toEqual({ __townError: true, code: "AUTH_REQUIRED", message: "请先完成配对。" });
    }
    answer = () => ({});
  });
});

// ── the rebuilding half, in the page's world ──────────────────────────────────

test("a rejected envelope becomes a real Error carrying its code", async () => {
  const bridge = install({
    family: { fail: rejects(townErrorPayload({ __townError: true, code: "AUTH_REQUIRED", message: "请先完成配对。" })) },
  });
  const family = bridge.family as { fail: () => Promise<unknown> };
  const error = await family.fail().then(() => null, (reason: unknown) => reason) as Error & { code?: string };
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(error.message).toBe("请先完成配对。");
  // The reason a plain object is not enough, and why this repair could not stop
  // at「reject with the envelope」: `publicErrorMessage` reads `instanceof Error`
  // first, and everything the renderer shows goes through it (`errorText`).
  // A plain object is short enough and clean enough to pass every fallback
  // filter, so the user would be shown「[object Object]」rather than a sentence.
  expect(publicErrorMessage(error)).toBe("请先完成配对。");
  expect(publicErrorMessage(townErrorPayload({ __townError: true, code: "AUTH_REQUIRED", message: "请先完成配对。" })))
    .toBe("[object Object]");
});

test("a NOT_SENT rejection arrives with the candidates and the detail", async () => {
  const envelope = townErrorPayload({
    __townError: true, code: "NOT_SENT", message: "收件人有歧义；本次私信未发送，请选择 Town ID。",
    candidates: [{ town_id: "t_NeoA", display_name: "Neo A" }, { town_id: "t_NeoB", display_name: "Neo B" }],
    detail: "两位居民同名",
  });
  const bridge = install({ townDesktop: { speak: rejects(envelope) } });
  const town = bridge.townDesktop as { speak: () => Promise<unknown> };
  const error = await town.speak().then(() => null, (reason: unknown) => reason) as Error & {
    code?: string; candidates?: { town_id: string }[]; detail?: string;
  };
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("NOT_SENT");
  expect(error.candidates?.map((one) => one.town_id)).toEqual(["t_NeoA", "t_NeoB"]);
  expect(error.detail).toBe("两位居民同名");
  // The marker itself is not copied onto the Error: what the renderer reads is
  // exactly what `townErrorFromEnvelope` used to hand it.
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(["candidates", "code", "detail", "message", "stack"]);
});

test("everything that is not a rejected envelope passes through untouched", async () => {
  const other = new Error("普通失败");
  const unsubscribe = () => "unsubscribed";
  const resolved = { __townError: true as const, code: "AUTH_REQUIRED" as const, message: "渠道读取被拒绝。" };
  const bridge = install({
    platform: "darwin",
    top: async () => "top-level function",
    family: {
      // The channel family answers with data on purpose (ChannelAnswer<T>).
      resolvedEnvelope: async () => resolved,
      plain: async () => ({ ok: true }),
      ordinary: rejects(other),
      subscribe: () => unsubscribe,
      exploding: () => { throw other; },
    },
  });
  const family = bridge.family as Record<string, (...args: unknown[]) => unknown>;
  expect(bridge.platform).toBe("darwin");
  expect(await (bridge.top as () => Promise<string>)()).toBe("top-level function");
  expect(await (family.resolvedEnvelope as () => Promise<unknown>)()).toEqual(resolved);
  expect(await (family.plain as () => Promise<unknown>)()).toEqual({ ok: true });
  await expect((family.ordinary as () => Promise<unknown>)()).rejects.toBe(other);
  expect((family.subscribe as () => unknown)()).toBe(unsubscribe);
  expect(() => (family.exploding as () => unknown)()).toThrow(other);
});

test("the bridge the page is handed cannot be rewritten by the page", () => {
  const bridge = install({ family: { call: async () => "ok" } });
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.isFrozen(bridge.family)).toBe(true);
});

test("the decoder survives being serialized and re-evaluated, as Electron does it", async () => {
  // MEASURED: `contextBridge.executeInMainWorld` stringifies the function and
  // re-evaluates it in the page's world, so a reference to anything outside it —
  // an import, a module constant, a bundler helper — becomes a ReferenceError at
  // runtime in the packaged client, with no build-time warning
  // (docs/migration/in-shell-errors.md §2). This reproduces that exact step.
  const rebuilt = new Function(`"use strict"; return (${installDecodedBridge.toString()});`)() as typeof installDecodedBridge;
  const name = `__inBridgeSerialized${globals++}`;
  expect(rebuilt({ family: { fail: rejects({ __townError: true, code: "SESSION_CHANGED", message: "Being 连接已变化。" }) } }, name)).toBe(name);
  const bridge = (globalThis as unknown as Record<string, Record<string, unknown>>)[name];
  const family = bridge.family as { fail: () => Promise<unknown> };
  const error = await family.fail().then(() => null, (reason: unknown) => reason) as Error & { code?: string };
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("SESSION_CHANGED");
});

// ── the whole path, one case per channel family ───────────────────────────────

test("every enveloped channel family carries its code to the page", async () => {
  // The real preload objects, the real bridge helpers, the real decoder: only
  // `ipcRenderer.invoke` is a fixture. Each family is listed with the envelope
  // its own IPC layer resolves with and the code its renderer branches on.
  const envelopes: Record<string, { __townError: true; code: string; message: string; candidates?: unknown[] }> = {
    "beings:chat-send": { __townError: true, code: "SESSION_CHANGED", message: "Being 连接已变化。" },
    "beings:chat-detail-open": { __townError: true, code: "BUSY", message: "正在处理上一条，请稍候。" },
    "beings:town-speak": {
      __townError: true, code: "NOT_SENT", message: "收件人有歧义；本次私信未发送，请选择 Town ID。",
      candidates: [{ town_id: "t_NeoA", display_name: "Neo A" }],
    },
    "beings:town-bonfire": { __townError: true, code: "AUTH_REQUIRED", message: "请先完成配对。" },
    "beings:model-config-save": { __townError: true, code: "NEEDS_KEY", message: "请先填写该服务商的 API Key。" },
    "beings:sbs-set": { __townError: true, code: "ROLLED_BACK", message: "Being 撤销了这次改动。" },
  };
  answer = (channel) => envelopes[channel] ?? {};
  const before = invoked.length;
  const bridge = install({ ...desktopChannels } as unknown as Record<string, unknown>);
  const chat = bridge.chat as { send: (input: unknown) => Promise<unknown>; detailOpen: (input: unknown) => Promise<unknown> };
  const town = bridge.townDesktop as { speak: (input: unknown) => Promise<unknown>; bonfire: () => Promise<unknown> };
  const models = bridge.modelSettings as {
    saveModelConfig: (patch: unknown) => Promise<unknown>;
    setSideBySide: (enabled: boolean, revision: number) => Promise<unknown>;
  };
  const caught = async (call: Promise<unknown>) =>
    await call.then(() => null, (reason: unknown) => reason) as Error & { code?: string; candidates?: unknown[] };

  const send = await caught(chat.send({}));
  expect([send instanceof Error, send.code]).toEqual([true, "SESSION_CHANGED"]);
  const card = await caught(chat.detailOpen({}));
  expect([card instanceof Error, card.code]).toEqual([true, "BUSY"]);
  const speak = await caught(town.speak({}));
  expect([speak instanceof Error, speak.code, speak.candidates]).toEqual([true, "NOT_SENT", [{ town_id: "t_NeoA", display_name: "Neo A" }]]);
  const bonfire = await caught(town.bonfire());
  expect([bonfire instanceof Error, bonfire.code]).toEqual([true, "AUTH_REQUIRED"]);
  const save = await caught(models.saveModelConfig({}));
  expect([save instanceof Error, save.code]).toEqual([true, "NEEDS_KEY"]);
  const sbs = await caught(models.setSideBySide(true, 1));
  expect([sbs instanceof Error, sbs.code]).toEqual([true, "ROLLED_BACK"]);
  // Each family reached its own channel, in order, and nothing else was invoked.
  expect(invoked.slice(before).map((one) => one.channel)).toEqual(Object.keys(envelopes));
  answer = () => ({});
});

// ── the fallback, for a build without executeInMainWorld ──────────────────────

test("the fallback rebuild keeps the sentence a user acts on", () => {
  // Not the default path and not reachable on this Electron, but it is what a
  // build without `contextBridge.executeInMainWorld` falls back to, and the point
  // of the fallback is that the message survives even though the code does not.
  const chat = chatErrorFromEnvelope({ __townError: true, code: "NEEDS_KEY", message: "请先填写该服务商的 API Key。" });
  expect([chat instanceof Error, chat.code, publicErrorMessage(chat)])
    .toEqual([true, "NEEDS_KEY", "请先填写该服务商的 API Key。"]);
  const town = townErrorFromEnvelope({
    __townError: true, code: "NOT_SENT", message: "收件人有歧义。",
    candidates: [{ town_id: "t_NeoA", display_name: "Neo A" }], detail: "两位同名",
  });
  expect([town.code, town.candidates?.length, town.detail]).toEqual(["NOT_SENT", 1, "两位同名"]);
});
