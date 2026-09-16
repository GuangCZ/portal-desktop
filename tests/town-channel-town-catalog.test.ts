// Ported from BeingDesktop test/town.test.cjs on 2026-09-16; rewritten against
// the native composer by integration unit I7 on the same day.
//
// WHAT CHANGED AND WHAT DID NOT
//
// The catalogue half is untouched — the two tests below it are the source's,
// assertion for assertion. The draft half was written against a Loom document
// fixture: a `vm` sandbox with `#app`, `#messages`, `#input-row`, `#input` and
// `#send-btn`, driven through `frame.executeJavaScript`. That document was
// removed with the iframe (MIGRATION.md「P1 完成状态」), so those assertions could
// only be kept by keeping a fake of something that no longer exists.
//
// Every one of them is re-aimed at the behaviour it was really about:
//
//   the fixed prompt tables and their uniqueness        → kept, against `*Draft`
//   an existing draft is never overwritten              → kept, as an `occupied` ack
//   a disconnected client never prepares anything       → kept, as the context gate
//   the user's text is data, never code                 → kept, `firesideDraft`
//   a refusal leaks no page content                     → kept, as a fixed sentence
//   `#input` is a TEXTAREA, `#app` contains `#messages` → GONE, with the document
//   the document nonce survives a navigation            → GONE, with the document
//
// The two GONE families are accounted for in docs/migration/i7-channel-drafts.md.
// What replaced them — the renderer's own refusal to overwrite a draft — is
// `placeChannelDraft` in tests/channel-integration-renderer.test.ts, which keeps
// the Loom page's own reading of「已有草稿」down to the whitespace-only composer
// (src/town.cjs line 134 compares against the EMPTY string). The transport around
// it is tests/draft-integration.test.ts. `ConversationModel.placeDraft` — covered
// by tests/conversation-model.test.ts — is the companion panel's rule and trims,
// which is why the stricter one is made in front of it and not inside it.
import { expect, it } from "vitest";
import {
  assistanceDraft, featureDraft, firesideDraft, getTownCatalog, townPageUrl,
} from "../desktop/main/town/channel/town-catalog";
import { createDraftAcks, createNativeDraft, DRAFT_PUSH } from "../desktop/main/town/channel/draft";
import type { DraftAck, NativeDraftContext } from "../desktop/main/town/channel/draft";

/** The native replacement for the Loom fixture: a push collector, a scripted
 * answer, and a mutable connection epoch. */
function composer({ ack = "placed" as DraftAck, draft = "" } = {}) {
  const pushes: { channel: string; payload: any }[] = [];
  const acks = createDraftAcks();
  let context: NativeDraftContext = { connection: { url: "https://loom.example/being/" }, generation: 4, revision: 2, configured: true, status: "connected", exiting: false };
  // The composer answers the way the renderer's bridge does: whatever it already
  // holds decides the answer, and it never overwrites it.
  const answer = draft ? "occupied" : ack;
  const prepare = createNativeDraft({
    push: (channel, payload: any) => { pushes.push({ channel, payload }); queueMicrotask(() => acks.settle(payload.id, answer)); },
    waitAck: (id, ms) => acks.wait(id, ms),
    timeoutMs: 50,
  });
  return {
    pushes,
    get text() { return pushes.at(-1)?.payload.text ?? ""; },
    getContext: () => ({ ...context }),
    change: (patch: Partial<NativeDraftContext>) => { context = { ...context, ...patch }; },
    prepare,
  };
}

it("Town catalog exposes nine navigation features and only public static URLs", () => {
  const catalog = getTownCatalog();
  expect(catalog.features.map((item) => item.id).sort()).toEqual(["scroll", "ember", "bonfire", "fireside", "beings", "grove", "portal", "channel", "workspace"].sort());
  expect(catalog.checkedAt).toBe("2026-09-06");
  expect(catalog.sourceUrl).toBe("https://beings.town/");
  const publicUrls = [catalog.sourceUrl, ...catalog.features.filter((item) => item.url).map((item) => item.url!)];
  expect(publicUrls.slice().sort()).toEqual(["https://beings.town/", "https://beings.town/embers", "https://beings.town/grove"].sort());
  for (const value of publicUrls) {
    const url = new URL(value);
    expect(url.protocol).toBe("https:"); expect(url.host).toBe("beings.town");
    expect(url.search).toBe(""); expect(url.hash).toBe(""); expect(url.username).toBe(""); expect(url.password).toBe("");
  }
  expect(catalog.features.filter((item) => item.mode === "app").map((item) => item.id).sort()).toEqual(["beings", "bonfire", "channel", "fireside", "grove", "portal", "scroll"]);
  expect(catalog.features.filter((item) => item.mode === "being").length).toBe(1);
  expect(catalog.features.filter((item) => item.mode === "web").map((item) => item.id)).toEqual(["ember"]);
  expect(catalog.features.find((item) => item.id === "fireside")!.description).not.toBe(catalog.features.find((item) => item.id === "bonfire")!.description);
  catalog.features[0].url = "https://evil.example/";
  catalog.features.splice(1);
  expect(getTownCatalog().features.length).toBe(9);
  expect(getTownCatalog().features[0].url).toBeUndefined();
});

it("Town public page whitelist rejects URLs, credential parameters and prototype keys", () => {
  expect(townPageUrl("home")).toBe("https://beings.town/");
  expect(townPageUrl("grove")).toBe("https://beings.town/grove");
  expect(townPageUrl("ember")).toBe("https://beings.town/embers");
  for (const id of [null, undefined, {}, ["grove"], 42, "", "Grove", "__proto__", "constructor", "toString", "grove?token=secret", "https://beings.town/grove", "javascript:alert(1)", "../grove", "embers", "portal", "scroll", "a".repeat(500)]) {
    expect(() => townPageUrl(id)).toThrow(Error);
  }
});

it("draft preparation rejects unknown and non-being IDs before pushing anything", async () => {
  const loom = composer();
  for (const id of [null, {}, ["search"], "__proto__", "constructor", "search;alert(1)", "https://evil.example/", "home", "grove", "ember", "portal", "Search"]) {
    expect(() => featureDraft(id)).toThrow();
  }
  expect(loom.pushes).toEqual([]);
});

it("each Being feature fills a fixed draft and only prepares it, never sends", async () => {
  const drafts: string[] = [];
  for (const feature of getTownCatalog().features.filter((item) => item.mode === "being")) {
    const loom = composer();
    expect(await loom.prepare(featureDraft(feature.id), loom.getContext)).toEqual({ prepared: true });
    expect(loom.text.length > 20).toBe(true);
    expect(loom.text.includes(feature.name)).toBe(true);
    // One push, on the draft channel, and nothing that could send it.
    expect(loom.pushes.map((entry) => entry.channel)).toEqual([DRAFT_PUSH]);
    drafts.push(loom.text);
  }
  expect(new Set(drafts).size).toBe(drafts.length);
});

it("moved capabilities retain legacy draft IPC without restoring old navigation entries", async () => {
  const modes: Record<string, string | undefined> = { fireside: "app", search: undefined, browse: undefined };
  for (const id of ["fireside", "search", "browse"]) {
    expect(getTownCatalog().features.find((feature) => feature.id === id)?.mode).toBe(modes[id]);
    const loom = composer();
    expect(await loom.prepare(featureDraft(id), loom.getContext)).toEqual({ prepared: true });
    expect(loom.text.includes(id[0].toUpperCase() + id.slice(1))).toBe(true);
    expect(loom.pushes.length).toBe(1);
  }
});

it("Channel and Bonfire cannot fall back to asking Being through legacy draft IPC", async () => {
  const loom = composer();
  for (const id of ["channel", "bonfire"]) expect(() => featureDraft(id)).toThrow();
  for (const operation of ["channel-feishu", "channel-wechat", "channel-status"]) expect(() => assistanceDraft(operation)).toThrow();
  expect(loom.pushes).toEqual([]);
});

it("each native module assistance operation prepares only its fixed draft without sending", async () => {
  const operations = ["fireside-list", "fireside-create", "fireside-join", "fireside-send", "grove-register", "portal-setup"];
  const drafts: string[] = [];
  for (const operation of operations) {
    const loom = composer();
    expect(await loom.prepare(assistanceDraft(operation), loom.getContext)).toEqual({ prepared: true });
    expect(loom.text.length > 35).toBe(true);
    expect(loom.pushes.length).toBe(1);
    drafts.push(loom.text);
  }
  expect(new Set(drafts).size).toBe(operations.length);
});

it("module assistance preserves existing drafts and requires a connected conversation", async () => {
  // The composer already holds the user's text: the refusal is the source's
  // sentence, and it says the original was kept.
  const held = composer({ draft: "my unsent text" });
  await expect(held.prepare(assistanceDraft("fireside-send"), held.getContext)).rejects.toThrow(/已有草稿.*已保留原文/);
  const loom = composer(); loom.change({ connection: null });
  await expect(loom.prepare(assistanceDraft("fireside-list"), loom.getContext)).rejects.toThrow(/请先连接/);
  expect(loom.pushes).toEqual([]);
});

it("module assistance rejects arbitrary prompts and unknown operations", async () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, "toString", { enumerable: true, get() { getters++; return () => "fireside-send"; } });
  const loom = composer();
  for (const value of [undefined, null, [], 1, {}, "unknown", "send arbitrary text", "__proto__", "constructor", "FIRESIDE-SEND", accessor]) {
    expect(() => assistanceDraft(value)).toThrow(/有效的 Being 协助操作/);
  }
  expect(getters).toBe(0);
  expect(loom.pushes).toEqual([]);
});

it("Fireside handoff treats the exact user draft as data and only fills a draft", async () => {
  const loom = composer();
  const draft = '你好，"围炉"\n</script><img src=x onerror="globalThis.fixtureInjected=true"> ${notCode} `literal`';
  expect(await loom.prepare(firesideDraft(draft), loom.getContext)).toEqual({ prepared: true });
  expect(loom.text.endsWith("\n\n" + draft)).toBe(true);
  expect(loom.text).toMatch(/尚未发送.*确认目标围炉/);
  // The draft crosses as a string on a structured-clone channel; there is no
  // evaluation anywhere on this path for it to escape from.
  expect((globalThis as Record<string, unknown>).fixtureInjected).toBeUndefined();
  expect(loom.pushes.length).toBe(1);
});

it("Fireside handoff strictly validates its draft field", async () => {
  const loom = composer();
  for (const value of [null, undefined, [], {}, 42, "", " \n", "x".repeat(32001)]) {
    expect(() => firesideDraft(value)).toThrow(/有效的围炉协助草稿/);
  }
  expect(loom.pushes).toEqual([]);
});

it("Fireside handoff preserves an existing draft", async () => {
  const loom = composer({ draft: "An existing draft" });
  await expect(loom.prepare(firesideDraft("new draft"), loom.getContext)).rejects.toThrow(/已有草稿.*已保留原文/);
  expect(loom.pushes.length).toBe(1);
});

it("a connection change during preparation is refused rather than delivered", async () => {
  for (const change of [{ generation: 5 }, { revision: 3 }, { status: "disconnected" }, { connection: null }]) {
    const pushes: any[] = [];
    const acks = createDraftAcks();
    let context: NativeDraftContext = { connection: { url: "https://loom.example/being/" }, generation: 4, revision: 2, configured: true, status: "connected", exiting: false };
    const prepare = createNativeDraft({
      // The identity moves while the answer is in flight: the source re-reads it
      // after the round trip for exactly this case.
      push: (_channel, payload: any) => { pushes.push(payload); queueMicrotask(() => { context = { ...context, ...change }; acks.settle(payload.id, "placed"); }); },
      waitAck: (id, ms) => acks.wait(id, ms),
      timeoutMs: 50,
    });
    await expect(prepare(firesideDraft("local draft"), () => ({ ...context }))).rejects.toThrow(/会话已变化|请先连接/);
    expect(pushes.length).toBe(1);
  }
});

it("a refusal says only its own sentence, never the prompt or the connection", async () => {
  const loom = composer({ draft: "existing" });
  const secret = "private-token-9c2f";
  const error: Error = await loom.prepare(assistanceDraft("portal-setup") + secret, loom.getContext)
    .then(() => { throw new Error("must reject"); }, (reason) => reason);
  expect(error.message).not.toMatch(/private-token|loom\.example/);
  expect(error.message).toBe("已有草稿，已保留原文；请先发送或清空后再选择此功能。");
});
