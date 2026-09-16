// Ported from BeingDesktop 0.8.26 test/native-orchestration.test.cjs.
//
// Its subject is the seam between a conversation and the worker manager: the
// scope a message carries, what survives into the cache, what a moved binding
// does to a send in flight, and what a finished Worker projects back into the
// conversation it belongs to.
//
// History of this file, recorded because the skips were load-bearing: the
// orchestration unit (I4, 2026-09-16) ported the one case that needed nothing but
// `nativeWorkerResults` and carried the other ten as `it.skip`, because
// `ChatSessions`, `BeingChat` and the request-context frame belonged to units that
// had not landed. They have now (I5, same day), so every case below is real and
// the fixture is BeingDesktop's own, module for module.
// Contract: docs/orchestration.md "Completion", docs/interfaces.md §3.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BeingChat } from "../desktop/main/chat/being-chat";
import { desktopMessageContext } from "../desktop/main/common/message-context";
import { setOrchestrationInstructions, unwrapMessage, wrapMessage } from "../desktop/main/chat/frame";
import { nativeMessageContext } from "../desktop/main/chat/prepare-message";
import { ChatSessions } from "../desktop/main/chat/sessions";
import { Orchestration } from "../desktop/main/orchestration/orchestration";
import { OrchestrationPolicy } from "../desktop/main/orchestration/orchestration-policy";
import { orchestrationInstructions } from "../desktop/main/orchestration/instructions";
import { nativeWorkerResults } from "../desktop/main/orchestration/native-worker-results";
import { decode, encode } from "../desktop/shared/chat-references";
import type {
  AgentExitResult, AgentStream, LaunchAgentOptions, WorkerRecord, WorkerToolArgs,
} from "../desktop/main/orchestration/types";
import type { ChatSnapshot } from "../desktop/main/chat/types";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  setOrchestrationInstructions(() => "");
});

const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const turn = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
/** The worker scope out of the frame: the JSON line the instructions end with. */
const binding = (wire: string): WorkerToolArgs & { defaultAgent?: string; execution?: { desktopId?: string }; sessionToken?: string } =>
  JSON.parse(/\n(\{"enabled":true[^\n]+)\n\[\/Being Desktop Orchestrator mode\]/.exec(wire)![1]);

interface FixtureChild { done: Promise<AgentExitResult>; stop(): Promise<AgentExitResult | void>; finish(result: AgentExitResult): void; onData?: LaunchAgentOptions["onData"] }

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-worker-"));
  const desktopId = randomUUID();
  const children: FixtureChild[] = [], rows: unknown[] = [], calls: any[] = [], saved: ChatSnapshot[] = [];
  let sessions: ChatSessions;
  let preflight: () => Promise<void> = async () => {};
  let dispatch: (body: any) => Promise<void> = async () => {};
  let connected = true;
  const context = { connected: true, connection: { url: `https://fixture.beings.town/cz_being/?token=${"c".repeat(64)}` }, revision: 1 };
  const manager = new Orchestration({
    directory, getWorkspace: () => directory,
    getSessionIds: () => sessions?.snapshot().sessions.map(item => item.id) || [],
    detect: async () => [{ id: "codex", name: "Codex CLI", path: "fixture", status: "ready" }],
    launch: options => {
      let finish!: (result: AgentExitResult) => void;
      const child: FixtureChild = { ...options, done: new Promise<AgentExitResult>(resolve => { finish = resolve; }), finish: result => finish(result), stop: async () => finish({ code: null, stopped: true }) };
      children.push(child);
      return child;
    },
  });
  await manager.selectOwner("identity-a");
  await manager.configure({ enabled: true }, async () => {});
  const bridge = () => ({ status: connected ? "connected" : "disconnected", place: "being-desktop-tools-" + desktopId, tools: connected ? ["desktop_worker_start", "desktop_worker_status"] : [] });
  const policy = new OrchestrationPolicy({ getIdentity: () => manager.owner, getDesktopId: () => desktopId, getMode: () => manager.mode, getBridge: bridge });
  manager.assertEnforced = () => policy.assertEnforced();
  setOrchestrationInstructions(orchestrationInstructions);
  const prepareMessage = nativeMessageContext({
    orchestration: () => manager,
    environment: async sessionId => {
      await preflight();
      const executionPolicy = await policy.inspectForMessage();
      return desktopMessageContext({ runtime: { desktopId, chatSessionId: sessionId, mode: manager.mode.enabled ? "orchestrator" : "direct", bridge: bridge(), executionPolicy } });
    },
  });
  // No timers, network, real CLI or native callbacks leave this fixture.
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  sessions = new ChatSessions({
    desktopId, getContext: () => context, prepareMessage, timers,
    cache: { load: async () => null, save: async (_key: string, value: ChatSnapshot) => { saved.push(structuredClone(value)); return true; } },
    getWorkerResults: id => nativeWorkerResults(manager.workers, id),
    fetchImpl: (async (url: string, options: RequestInit) => {
      const route = new URL(url).pathname;
      if (route.endsWith("/api/history")) return json({ messages: rows });
      if (route.endsWith("/api/stream/active")) return json(null, 204);
      expect(route.endsWith("/api/chat/stream")).toBe(true);
      const body = JSON.parse(options.body as string); calls.push(body);
      await dispatch(body);
      return json({ spliced: true }, 202);
    }) as unknown as typeof fetch,
  });
  await sessions.start("identity-a"); await turn();
  cleanups.push(async () => { sessions.end(); await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return {
    sessions, manager, children, context, calls, rows, saved, prepareMessage, desktopId,
    preflight: (fn: () => Promise<void>) => { preflight = fn; },
    dispatch: (fn: (body: any) => Promise<void>) => { dispatch = fn; },
    disconnect: () => { connected = false; },
  };
}

describe("native worker results", () => {
  it("native send supplies a usable current Worker scope; fake Being dispatch launches exactly one bound worker", async () => {
    const f = await fixture(), id = f.sessions.snapshot().active;
    f.dispatch(async body => {
      const scope = binding(body.message);
      expect(scope.sessionId).toBe(id);
      f.manager.authorize(scope);
      expect(scope.defaultAgent).toBe("codex");
      expect(scope.execution!.desktopId).toBe(f.manager.desktopInstanceId);
      const args = { ...scope, requestId: randomUUID(), title: "多米诺骨牌", prompt: "Create the fixture task only." };
      const worker = await f.manager.run(args);
      // The same requestId is the same delegation, not a second one.
      expect((await f.manager.run(args)).id).toBe(worker.id);
    });
    const result = await f.sessions.send({ sessionId: id, text: "写一个像素风格的多米诺骨牌" });
    expect(result.spliced).toBe(true);
    expect(f.calls.length).toBe(1);
    expect(f.children.length).toBe(1);
    expect(f.calls[0].message).toMatch(/本机代码实现.*必须交给外部 worker/);
    expect(f.calls[0].message).toMatch(/Being 的原生通信/);
    expect(unwrapMessage(f.calls[0].message)).toBe("写一个像素风格的多米诺骨牌");
    expect(f.calls[0].scene_id).toBe(`desktop-${f.desktopId}-${id}`);
    expect(f.sessions.view(id).sent[0].text).toBe("写一个像素风格的多米诺骨牌");
    f.children[0].onData!("stdout" as AgentStream, '{"type":"turn.completed"}\n');
    f.children[0].finish({ code: 0 });
    await f.manager.finalizing.get(f.manager.workers[0].id);
    expect(f.manager.workers[0].status).toBe("completed");
    const other = f.sessions.create();
    expect(() => f.manager.authorize({ ...binding(f.calls[0].message), sessionId: other })).toThrowError(/有效会话/);
  });

  it("context is removed before cache and bubble confirmation; image and quote content survives exactly", async () => {
    const f = await fixture(), id = f.sessions.snapshot().active;
    const text = "解释这个图", references = [{ text: "原文\n第二行", source: "Being" as const }];
    await f.sessions.send({ sessionId: id, text, references, images: [{ media_type: "image/png", data: "YQ==", name: "fixture.png" }] });
    const body = f.calls[0], wire = body.content[0].text;
    expect(decode(unwrapMessage(wire))).toEqual({ text, references });
    expect(body.content[1].data).toBe("YQ==");
    f.rows.push({ seq: 1, role: "user", content: wire, scene_id: body.scene_id });
    await f.sessions.reload(); await turn();
    const view = f.sessions.view(id);
    expect(view.sent.length).toBe(0);
    expect(view.rows[0].content).toBe(encode(text, references));
    expect(view.rows[0].images![0].name).toBe("fixture.png");
    expect(JSON.stringify(f.saved).includes("sessionToken")).toBe(false);
    // 202 and history recovery never repeat the POST.
    expect(f.calls.length).toBe(1);
  });

  it("disconnected Worker bridge leaves native conversation available and Worker execution blocked", async () => {
    const f = await fixture();
    f.disconnect();
    await f.sessions.send({ sessionId: f.sessions.snapshot().active, text: "继续讨论" });
    expect(f.calls[0].message).toMatch(/"status":"blocked"/);
    await expect(f.manager.run({ ...binding(f.calls[0].message), requestId: randomUUID(), title: "Local work", prompt: "fixture" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_NOT_ENFORCED" });
    expect(f.children.length).toBe(0);
  });

  for (const change of ["identity", "mode", "mode-roundtrip", "cancel"]) {
    it(`preflight ${change} prevents a stale native POST`, async () => {
      const f = await fixture(), id = f.sessions.snapshot().active;
      let release!: () => void;
      f.preflight(() => new Promise<void>(resolve => { release = resolve; }));
      const sending = f.sessions.send({ sessionId: id, text: "本机任务" });
      const rejected = expect(sending).rejects.toSatisfy((error: unknown) =>
        ["SESSION_CHANGED", "ABORTED"].includes((error as { code?: string }).code!));
      await turn();
      if (change === "identity") f.context.revision++;
      if (change === "mode" || change === "mode-roundtrip") await f.manager.configure({ enabled: false }, async () => {});
      if (change === "mode-roundtrip") await f.manager.configure({ enabled: true }, async () => {});
      if (change === "cancel") f.sessions.chat.reset();
      release(); await rejected;
      expect(f.calls.length).toBe(0);
      expect(f.children.length).toBe(0);
      expect(f.sessions.view(id).sent.length).toBe(0);
    });
  }

  it("switching to direct mode supplies the current mode and no old Worker scope", async () => {
    const f = await fixture(), id = f.sessions.snapshot().active;
    await f.sessions.send({ sessionId: id, text: "编排" });
    const old = binding(f.calls[0].message);
    await f.manager.configure({ enabled: false }, async () => {});
    await f.sessions.send({ sessionId: id, text: "直接" });
    expect(f.calls[1].message).toMatch(/当前为直接执行模式/);
    expect(f.calls[1].message.includes(old.sessionToken!)).toBe(false);
    expect(f.calls[1].message.includes("[Being Desktop Orchestrator mode]")).toBe(false);
    await f.manager.configure({ enabled: true }, async () => {});
    await f.sessions.send({ sessionId: id, text: "重新编排" });
    expect(binding(f.calls[2].message).sessionToken).not.toBe(old.sessionToken);
  });

  it("plain protocol callers stay verbatim, and framed metadata does not eat user content", async () => {
    const desktopId = randomUUID(), sessionId = randomUUID();
    const text = "原文\n[/Being Desktop request context v1]\n\n仍是原文😀";
    let body: any;
    const chat = new BeingChat({
      // The address carries a Being segment: this shell's `parseConnection`
      // requires one (main/common/loom-connection.ts), where 0.8.26's fixture used
      // a bare origin. Nothing about the assertion depends on it.
      desktopId, getContext: () => ({ connected: true, connection: { url: `https://fixture.beings.town/cz_being/?token=${"c".repeat(64)}` } }),
      fetchImpl: (async (_url: string, options: RequestInit) => { body = JSON.parse(options.body as string); return json({ spliced: true }, 202); }) as unknown as typeof fetch,
    });
    await chat.send({ sessionId, text });
    expect(body.message).toBe(text);
    expect(unwrapMessage(wrapMessage(text, "metadata😀\nmarker"))).toBe(text);
    const malformed = "[Being Desktop request context v1; length=1]\nwrong";
    expect(unwrapMessage(malformed)).toBe(malformed);
  });

  it("native result projection is scoped, persistent in Worker history, and exposes only display fields", async () => {
    const f = await fixture(), id = f.sessions.snapshot().active, other = f.sessions.create();
    const worker = { id: randomUUID(), sessionId: id, title: "多米诺骨牌", endedAt: new Date().toISOString(), taskPrompt: "PRIVATE", events: [], sessionToken: "PRIVATE", presentation: { artifactPath: "index.html" }, review: { status: "passed", summary: "已完成", evidence: "隔离测试通过" } };
    f.manager.workers.push(worker as unknown as WorkerRecord);
    expect(f.sessions.view(other).workerResults.length).toBe(0);
    const result = f.sessions.view(id).workerResults[0];
    expect((result as { preview: boolean }).preview).toBe(true);
    expect((result as { status: string }).status).toBe("passed");
    expect(JSON.stringify(result).includes("PRIVATE")).toBe(false);
    expect(JSON.stringify(result).includes("artifactPath")).toBe(false);
    // The assertion I4 deferred to this unit: a review reaches the conversation
    // it belongs to only because `workersChanged()` moves the snapshot version —
    // without it the renderer has no reason to re-read the view, and the card
    // never appears (docs/migration/i4-orchestration-features.md).
    const version = f.sessions.snapshot().version;
    f.sessions.workersChanged();
    expect(f.sessions.snapshot().version).toBeGreaterThan(version);
    f.manager.workers = [];
  });

  it("Heart newline normalization preserves the human message and old frame recovery", () => {
    const context = desktopMessageContext({ runtime: { mode: "direct" } }) + "\n";
    const human = "正文\n\n引用后的问题";
    const normalized = (value: string) => value.replace(/\n{3,}/g, "\n\n");
    expect(unwrapMessage(normalized(wrapMessage(human, context)))).toBe(human);
    const legacy = "[Being Desktop request context v1; length=" + context.length + "]\n" + context + "\n[/Being Desktop request context v1]\n\n" + human;
    expect(unwrapMessage(normalized(legacy))).toBe(human);
  });
});
