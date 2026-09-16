// Ported from BeingDesktop test/town.test.cjs on 2026-09-16. Fixtures copied verbatim.
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { expect, it } from "vitest";
import { getTownCatalog, prepareFiresideDraft, prepareTownAssistance, prepareTownFeature, townPageUrl } from "../desktop/main/town/channel/town-catalog";
import type { LoomContextReader } from "../desktop/main/town/channel/town-catalog";

function fixture({ draft = "", readyState = "complete", url = "https://loom.example/being/?token=not-for-the-catalog" } = {}) {
  const events: { type: string; bubbles?: boolean }[] = [];
  let submissions = 0, executions = 0;
  const field: any = { tagName: "TEXTAREA", value: draft, disabled: false, readOnly: false,
    dispatchEvent(event: any) { events.push({ type: event.type, bubbles: event.bubbles }); return true; }, focus() { events.push({ type: "focus" }); } };
  const send = { click() { submissions++; } };
  const messages = {};
  const row: any = { contains(value: unknown) { return value === field || value === send; } };
  const app: any = { contains(value: unknown) { return value === row || value === messages; } };
  const elements: any = { app, messages, "input-row": row, input: field, "send-btn": send };
  const sandbox: any = { document: { readyState, documentElement: { dataset: {} }, getElementById(id: string) { return elements[id]; } }, location: new URL(url), crypto: { randomUUID },
    Event: class { type: string; bubbles: boolean; constructor(type: string, options: any) { this.type = type; this.bubbles = options.bubbles; } } };
  const connection: any = { displayUrl: "https://loom.example/being/", url };
  const frame: any = { isDestroyed: () => false, detached: false,
    async executeJavaScript(this: any, script: string) { expect(this).toBe(frame); executions++; return vm.runInNewContext(script, sandbox); } };
  const contents: any = { mainFrame: frame, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => url,
    executeJavaScript() { throw new Error("Drafts must execute on the captured frame, not WebContents"); } };
  let context: any = { connection, view: { webContents: contents }, generation: 4, revision: 2, configured: true, status: "connected", exiting: false };
  return { field, elements, sandbox, contents, frame, events, getContext: (() => ({ ...context })) as LoomContextReader, change: (patch: any) => { context = { ...context, ...patch }; },
    get submissions() { return submissions; }, get executions() { return executions; } };
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

it("draft preparation rejects unknown and non-being IDs before evaluating page code", async () => {
  const loom = fixture();
  for (const id of [null, {}, ["search"], "__proto__", "constructor", "search;alert(1)", "https://evil.example/", "home", "grove", "ember", "portal", "Search"]) {
    await expect(prepareTownFeature(id, loom.getContext)).rejects.toThrow();
  }
  expect(loom.executions).toBe(0);
  expect(loom.field.value).toBe("");
});

it("each Being feature fills a fixed draft and only emits input without sending", async () => {
  const drafts: string[] = [];
  for (const feature of getTownCatalog().features.filter((item) => item.mode === "being")) {
    const loom = fixture();
    expect(await prepareTownFeature(feature.id, loom.getContext)).toEqual({ prepared: true });
    expect(loom.field.value.length > 20).toBe(true);
    expect(loom.field.value.includes(feature.name)).toBe(true);
    expect(loom.events).toEqual([{ type: "input", bubbles: true }, { type: "focus" }]);
    expect(loom.submissions).toBe(0);
    drafts.push(loom.field.value);
  }
  expect(new Set(drafts).size).toBe(drafts.length);
});

it("moved capabilities retain legacy draft IPC without restoring old navigation entries", async () => {
  const modes: Record<string, string | undefined> = { fireside: "app", search: undefined, browse: undefined };
  for (const id of ["fireside", "search", "browse"]) {
    expect(getTownCatalog().features.find((feature) => feature.id === id)?.mode).toBe(modes[id]);
    const loom = fixture();
    expect(await prepareTownFeature(id, loom.getContext)).toEqual({ prepared: true });
    expect(loom.field.value.includes(id[0].toUpperCase() + id.slice(1))).toBe(true);
    expect(loom.events).toEqual([{ type: "input", bubbles: true }, { type: "focus" }]);
    expect(loom.submissions).toBe(0);
  }
});

it("Channel and Bonfire cannot fall back to asking Being through legacy draft IPC", async () => {
  const loom = fixture();
  for (const id of ["channel", "bonfire"]) await expect(prepareTownFeature(id, loom.getContext)).rejects.toThrow();
  for (const operation of ["channel-feishu", "channel-wechat", "channel-status"]) await expect(prepareTownAssistance({ operation }, loom.getContext)).rejects.toThrow();
  expect(loom.executions).toBe(0);
  expect(loom.submissions).toBe(0);
});

it("each native module assistance operation prepares only its fixed draft without sending", async () => {
  const operations = ["fireside-list", "fireside-create", "fireside-join", "fireside-send", "grove-register", "portal-setup"];
  const drafts: string[] = [];
  for (const operation of operations) {
    const loom = fixture();
    expect(await prepareTownAssistance({ operation }, loom.getContext)).toEqual({ prepared: true });
    expect(loom.field.value.length > 35).toBe(true);
    expect(loom.events).toEqual([{ type: "input", bubbles: true }, { type: "focus" }]);
    expect(loom.submissions).toBe(0);
    drafts.push(loom.field.value);
  }
  expect(new Set(drafts).size).toBe(operations.length);
});

it("module assistance preserves existing drafts and requires a connected Loom document", async () => {
  for (const draft of ["my unsent text", " \n\t"]) {
    const loom = fixture({ draft });
    await expect(prepareTownAssistance({ operation: "fireside-send" }, loom.getContext)).rejects.toThrow(/已有草稿.*已保留原文/);
    expect(loom.field.value).toBe(draft); expect(loom.events).toEqual([]); expect(loom.submissions).toBe(0);
  }
  const loom = fixture(); loom.change({ connection: null });
  await expect(prepareTownAssistance({ operation: "fireside-list" }, loom.getContext)).rejects.toThrow(/请先连接/);
  expect(loom.executions).toBe(0);
});

it("module assistance rejects arbitrary prompts, extra keys and accessor objects before page evaluation", async () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, "operation", { enumerable: true, get() { getters++; return "fireside-send"; } });
  const symbol = Symbol("hidden");
  const invalid = [undefined, null, [], 1, "fireside-send", {}, { operation: "unknown" }, { operation: "fireside-send", message: "send arbitrary text" }, { operation: "fireside-send", token: "private" }, { operation: "fireside-send", [symbol]: true }, accessor, Object.assign(Object.create(null), { operation: "fireside-send" }), Object.create({ operation: "fireside-send" })];
  const loom = fixture();
  for (const value of invalid) await expect(prepareTownAssistance(value, loom.getContext)).rejects.toThrow(/有效的 Being 协助操作/);
  expect(getters).toBe(0); expect(loom.executions).toBe(0); expect(loom.field.value).toBe("");
});

it("Fireside handoff treats the exact user draft as data and only fills a Loom draft", async () => {
  const loom = fixture();
  const draft = '你好，"围炉"\n</script><img src=x onerror="globalThis.fixtureInjected=true"> ${notCode} `literal`';
  expect(await prepareFiresideDraft({ draft, connectionRevision: 4 }, loom.getContext)).toEqual({ prepared: true });
  expect(loom.field.value.endsWith("\n\n" + draft)).toBe(true);
  expect(loom.field.value).toMatch(/尚未发送.*确认目标围炉/);
  expect(loom.sandbox.fixtureInjected).toBeUndefined();
  expect(loom.events).toEqual([{ type: "input", bubbles: true }, { type: "focus" }]);
  expect(loom.submissions).toBe(0);
});

it("Fireside handoff strictly validates its two data fields without invoking accessors", async () => {
  let accesses = 0;
  const accessor: any = { connectionRevision: 4 };
  Object.defineProperty(accessor, "draft", { enumerable: true, get() { accesses++; return "secret"; } });
  const invalid = [null, undefined, [], {}, { draft: "x" }, { draft: "x", connectionRevision: "4" }, { draft: "x", connectionRevision: -1 }, { draft: "x", connectionRevision: 1.5 }, { draft: "x", connectionRevision: Infinity }, { draft: "", connectionRevision: 4 }, { draft: " \n", connectionRevision: 4 }, { draft: "x".repeat(32001), connectionRevision: 4 }, { draft: 42, connectionRevision: 4 }, { draft: "x", connectionRevision: 4, send: true }, { draft: "x", connectionRevision: 4, [Symbol("extra")]: true }, Object.assign(Object.create(null), { draft: "x", connectionRevision: 4 }), accessor];
  const loom = fixture();
  for (const value of invalid) await expect(prepareFiresideDraft(value, loom.getContext)).rejects.toThrow(/有效的围炉协助草稿/);
  expect(accesses).toBe(0); expect(loom.executions).toBe(0);
});

it("Fireside handoff preserves existing Loom drafts and rejects stale connection revisions", async () => {
  const loom = fixture({ draft: "An existing Loom draft" });
  await expect(prepareFiresideDraft({ draft: "new draft", connectionRevision: 4 }, loom.getContext)).rejects.toThrow(/已有草稿.*已保留原文/);
  expect(loom.field.value).toBe("An existing Loom draft"); expect(loom.events).toEqual([]);
  const stale = fixture();
  await expect(prepareFiresideDraft({ draft: "new draft", connectionRevision: 3 }, stale.getContext)).rejects.toThrow(/连接身份已变化/);
  expect(stale.executions).toBe(0); expect(stale.field.value).toBe("");
});

it("Fireside handoff rejects a connection change during the document handshake before filling text", async () => {
  for (const change of [{ generation: 5 }, { revision: 3 }, { status: "disconnected" }, { connection: null }]) {
    const loom = fixture(); const execute = loom.frame.executeJavaScript;
    loom.frame.executeJavaScript = async function (this: any, script: string) { const result = await execute.call(this, script); loom.change(change); return result; };
    await expect(prepareFiresideDraft({ draft: "local draft", connectionRevision: 4 }, loom.getContext)).rejects.toThrow();
    expect(loom.field.value).toBe(""); expect(loom.events).toEqual([]); expect(loom.submissions).toBe(0);
  }
});

it("existing text and whitespace drafts are preserved with no input or focus event", async () => {
  for (const draft of ["my unsent message", " \n\t", "<script>alert(1)</script>"]) {
    const loom = fixture({ draft });
    await expect(prepareTownFeature("search", loom.getContext)).rejects.toThrow(/已有草稿.*已保留原文/);
    expect(loom.field.value).toBe(draft);
    expect(loom.events).toEqual([]);
    expect(loom.submissions).toBe(0);
  }
});

it("draft requires an active editable Loom document with the known structure", async () => {
  for (const mutate of [
    (loom: any) => { loom.sandbox.document.readyState = "loading"; },
    (loom: any) => { delete loom.elements.messages; },
    (loom: any) => { delete loom.elements["send-btn"]; },
    (loom: any) => { loom.elements.app.contains = () => false; },
    (loom: any) => { loom.elements["input-row"].contains = () => false; },
    (loom: any) => { loom.field.tagName = "DIV"; },
    (loom: any) => { loom.field.disabled = true; },
    (loom: any) => { loom.field.readOnly = true; },
    (loom: any) => { loom.sandbox.location = new URL("https://loom.example/login"); },
  ]) {
    const loom = fixture(); mutate(loom);
    await expect(prepareTownFeature("scroll", loom.getContext)).rejects.toThrow(/未找到可用的 Loom 输入框|无法确认 Loom 当前文档/);
    expect(loom.field.value).toBe(""); expect(loom.events).toEqual([]);
  }
});

it("disconnected, loading, exiting and foreign pages never receive a draft script", async () => {
  for (const mutate of [
    (loom: any) => loom.change({ connection: null }), (loom: any) => loom.change({ configured: false }),
    (loom: any) => loom.change({ status: "connecting" }), (loom: any) => loom.change({ status: "error" }),
    (loom: any) => loom.change({ exiting: true }), (loom: any) => loom.change({ view: null }),
    (loom: any) => { loom.contents.isDestroyed = () => true; }, (loom: any) => { loom.contents.isLoadingMainFrame = () => true; },
    (loom: any) => { loom.frame.isDestroyed = () => true; }, (loom: any) => { loom.frame.detached = true; },
    (loom: any) => { loom.contents.mainFrame = null; },
    (loom: any) => { loom.contents.getURL = () => "https://evil.example/being/"; },
  ]) {
    const loom = fixture(); mutate(loom);
    await expect(prepareTownFeature("search", loom.getContext)).rejects.toThrow();
    expect(loom.executions).toBe(0); expect(loom.field.value).toBe("");
  }
});

it("an asynchronous result from an old view, generation or document is never accepted", async () => {
  const changes: ((loom: any) => void)[] = [{ generation: 5 }, { revision: 3 }, { status: "error" }, { connection: { displayUrl: "https://loom.example/other/" } }, { view: { webContents: { isDestroyed: () => false } } }]
    .map((patch) => (loom: any) => loom.change(patch));
  changes.push((loom: any) => { loom.contents.mainFrame = { ...loom.frame }; }, (loom: any) => { loom.frame.isDestroyed = () => true; }, (loom: any) => { loom.frame.detached = true; });
  for (const phase of [1, 2]) {
    for (const change of changes) {
      const loom = fixture();
      const execute = loom.frame.executeJavaScript;
      let complete!: (value: unknown) => void, reached!: () => void, calls = 0;
      const waiting = new Promise<void>((resolve) => { reached = resolve; });
      loom.frame.executeJavaScript = function (this: any, script: string) {
        if (++calls === phase) return new Promise((resolve) => { complete = resolve; reached(); });
        return execute.call(this, script);
      };
      const pending = prepareTownFeature("search", loom.getContext);
      await Promise.race([waiting, pending.then(() => { throw new Error("The chosen frame operation must be reached"); })]);
      change(loom); complete(phase === 1 ? randomUUID() : "prepared");
      await expect(pending).rejects.toThrow();
    }
  }
  // Reuse the same frame and main-process revision, but replace its document
  // between the nonce read and the write. No input may reach the new document.
  for (const replacement of [{}, { beingDesktopTownDocument: randomUUID() }]) {
    const loom = fixture();
    const nextDocument = fixture();
    nextDocument.sandbox.document.documentElement.dataset = replacement;
    const execute = loom.frame.executeJavaScript;
    let calls = 0;
    loom.frame.executeJavaScript = async function (this: any, script: string) {
      if (++calls === 2) loom.sandbox.document = nextDocument.sandbox.document;
      return execute.call(this, script);
    };
    await expect(prepareTownFeature("search", loom.getContext)).rejects.toThrow(/未找到可用的 Loom 输入框/);
    expect(calls).toBe(2);
    expect(loom.field.value).toBe("");
    expect(loom.events).toEqual([]);
    expect(loom.submissions).toBe(0);
    expect(nextDocument.field.value).toBe("");
    expect(nextDocument.events).toEqual([]);
    expect(nextDocument.submissions).toBe(0);
  }
  for (const invalid of ["not-a-uuid", "private-token", {}, null]) {
    const loom = fixture();
    let calls = 0;
    loom.frame.executeJavaScript = async () => { calls++; return invalid; };
    await expect(prepareTownFeature("search", loom.getContext)).rejects.toThrow(/无法确认 Loom 当前文档/);
    expect(calls).toBe(1);
    expect(loom.field.value).toBe("");
  }
});

it("page execution errors cannot leak page content or secrets through the native error", async () => {
  const loom = fixture();
  loom.frame.executeJavaScript = async () => { throw new Error("private-token page body"); };
  const error: Error = await prepareTownFeature("search", loom.getContext).then(() => { throw new Error("must reject"); }, (reason) => reason);
  expect(error.message).not.toMatch(/private-token|page body/);
  expect(error.message).toMatch(/无法确认 Loom 当前文档/);
});
