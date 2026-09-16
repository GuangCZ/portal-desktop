// Ported from BeingDesktop 0.8.26 test/worker-callbacks.test.cjs on 2026-09-16.
// All 18 cases, names preserved; case 10 is a desktop-tool-link schema check owned by another
// migration unit and is carried as it.skip. Fixtures and wire payloads are copied verbatim.
// Wire protocol: docs/worker-callback-design.md ("Native transport evidence", "Continuation"),
// docs/interfaces.md §6.3.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestration } from "../desktop/main/orchestration/orchestration";
import { callbackPayload, createCallbackSender, createContinuationSender } from "../desktop/main/orchestration/worker-callbacks";
// `src/security.cjs`'s two functions, which this unit injects into both senders.
// They used to be copied into this file; `main/common/loom-connection.ts` is the
// one implementation now, and injecting the real thing is what makes the
// `sessionPartition` assertions below mean anything (IM, 2026-09-16).
import { parseConnection, sessionPartition } from "../desktop/main/common/loom-connection";
import type {
  AgentExitResult, AgentStream, CallbackPayload, CallbackWorkerView, LaunchAgentOptions,
  LoomConnection, SendResult, WorkerRecord, WorkerReporter, WorkerToolArgs,
} from "../desktop/main/orchestration/types";


const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

interface FakeChild extends LaunchAgentOptions {
  onData: (stream: AgentStream, text: string) => void;
  done: Promise<AgentExitResult>;
  finish: (result: AgentExitResult) => void;
  stop: () => Promise<void>;
}

type Args = WorkerToolArgs & { sessionId: string; sessionToken: string; requestId: string };

interface Fixture {
  manager: Orchestration;
  directory: string;
  args: Args;
  sessionId: string;
  otherId: string;
  children: FakeChild[];
  complete: (worker: WorkerRecord, code?: number) => Promise<WorkerRecord>;
  enable: () => void;
  advance: () => void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture({
  send = async () => ({ accepted: true, status: 202, inboxId: "42", detail: "accepted" }),
  report = async () => {},
}: { send?: (worker: WorkerRecord, context: { owner: string; signal: AbortSignal }) => Promise<SendResult>; report?: WorkerReporter } = {}): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "being-callbacks-"));
  const sessionId = randomUUID(), otherId = randomUUID(), desktopId = randomUUID(), children: FakeChild[] = [];
  let available = false, now = 1000;
  const manager = new Orchestration({
    directory, getWorkspace: () => directory, getSessionIds: () => [sessionId, otherId], getExecutionContext: () => ({ desktopId, place: "being-desktop-tools-" + desktopId }),
    detect: async () => [{ id: "codex", path: "fixture", status: "ready" }], callbacks: { send, ready: () => available, report, now: () => now },
    launch: (options) => {
      let finish!: (result: AgentExitResult) => void;
      const child = { ...options, done: new Promise<AgentExitResult>((resolve) => { finish = resolve; }), finish, stop: async () => finish({ code: null, stopped: true }) } as FakeChild;
      children.push(child); return child;
    },
  });
  await manager.selectOwner("owner"); await manager.configure({ enabled: true }, async () => {});
  const args = { ...manager.context(sessionId), requestId: randomUUID(), title: "Verify fixture", prompt: "Read the fixture and require exact text EXPECTED. Do not edit." } as Args;
  async function complete(worker: WorkerRecord, code = 0): Promise<WorkerRecord> {
    const child = children.at(-1)!;
    child.onData("stdout", '{"type":"item.completed","item":{"type":"agent_message","text":"EXPECTED"}}\n{"type":"turn.completed"}\n');
    child.finish({ code }); await manager.finalizing.get(worker.id); return manager.get(worker.id);
  }
  cleanups.push(async () => { await manager.dispose(); expect(directory.startsWith(os.tmpdir())).toBe(true); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, directory, args, sessionId, otherId, children, complete, enable: () => { available = true; }, advance: () => { now += 120000; } };
}

describe("worker callbacks", () => {
  it("terminal result and stable notification are on disk before native delivery", async () => {
    const sent: CallbackPayload[] = []; let f!: Fixture;
    f = await fixture({ send: async (worker) => {
      const disk = JSON.parse(await fs.readFile(f.manager.historyPath(), "utf8"));
      expect(disk[0].status).toBe("completed"); expect(disk[0].result).toBe("EXPECTED");
      expect(disk[0].completion.id).toBe(worker.completion!.id); sent.push(callbackPayload(worker));
      return { accepted: true, status: 202, inboxId: "7", detail: "accepted" };
    } });
    const worker = await f.manager.run(f.args); await f.complete(worker);
    expect(sent.length).toBe(0); f.enable(); await f.manager.callbacks.pump();
    expect(sent.length).toBe(1); expect(sent[0].task_id).toBe(worker.id);
    expect(sent[0].result.desktop_session_id).toBe(f.sessionId);
    expect(sent[0].result.desktop_id).toBe(worker.execution!.desktopId);
    expect(sent[0].result.target_portal).toBe("being-desktop-tools-" + worker.execution!.desktopId);
    expect(JSON.stringify(sent[0])).not.toMatch(/sessionToken|taskPrompt|EXPECTED/);
    expect(f.manager.get(worker.id).completion!.state).toBe("accepted");
    await f.manager.callbacks.pump(); expect(sent.length).toBe(1);
  });

  it("response loss retries the same logical signal without launching the CLI again", async () => {
    const sent: CallbackPayload[] = [];
    const f = await fixture({ send: async (worker) => { sent.push(callbackPayload(worker)); if (sent.length === 1) throw new Error("response lost"); return { accepted: true, inboxId: "9" }; } });
    const worker = await f.manager.run(f.args); await f.complete(worker); f.enable(); await f.manager.callbacks.pump();
    expect(f.manager.get(worker.id).status).toBe("completed"); expect(f.manager.get(worker.id).completion!.state).toBe("retrying");
    f.advance(); await f.manager.callbacks.pump(); expect(sent[0]).toEqual(sent[1]); expect(f.children.length).toBe(1);
  });

  it("callback restores current original-session scope and cannot access a different owner or cancelled task", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); const final = await f.complete(worker);
    f.manager.sessions.clear();
    const received = await f.manager.callbacks.receive(final.completion!.id);
    expect(received.scope!.sessionId).toBe(f.sessionId); expect(received.scope!.sessionToken).not.toBe(f.args.sessionToken);
    expect(received.worker!.taskPrompt).toBe(f.args.prompt);
    await expect(f.manager.tool("desktop_worker_status", { ...f.manager.context(f.otherId) as WorkerToolArgs, workerId: worker.id })).rejects.toThrow(/其他会话/);
    await f.manager.stop(worker.id); await expect(f.manager.callbacks.receive(final.completion!.id)).rejects.toThrow(/有效任务/);
    await f.manager.selectOwner("different-owner"); await expect(f.manager.callbacks.receive(final.completion!.id)).rejects.toThrow(/有效任务/);
  });

  it("wait and native receive share a single durable review and original-session report", async () => {
    const reports: WorkerRecord[] = [];
    const f = await fixture({ report: async (worker) => { reports.push(worker); } }), worker = await f.manager.run(f.args);
    const wait = f.manager.tool("desktop_worker_wait", { ...f.args, workerId: worker.id }); await f.complete(worker);
    const polled = JSON.parse((await wait).content[0].text);
    const received = await f.manager.callbacks.receive(polled.completion.id);
    const review = { ...received.scope, workerId: worker.id, outcome: "passed", summary: "The fixture matches.", evidence: "CLI read returned exactly EXPECTED." } as WorkerToolArgs;
    await f.manager.callbacks.review(review);
    await f.manager.callbacks.review({ ...review, summary: "duplicate must not replace the first conclusion" });
    f.enable(); await f.manager.callbacks.pump(); await f.manager.callbacks.pump();
    expect(reports.length).toBe(1); expect(reports[0].sessionId).toBe(f.sessionId); expect(reports[0].review!.summary).toBe(review.summary);
    const duplicate = await f.manager.callbacks.receive(polled.completion.id); expect(duplicate.alreadyReviewed).toBe(true); expect(duplicate.scope).toBe(undefined);
  });

  it("insufficient evidence is distinct from passing and follow-up dispatch cannot duplicate", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); const final = await f.complete(worker);
    await f.manager.callbacks.review({ ...f.args, workerId: worker.id, outcome: "needs_verification", summary: "Artifact has not been checked.", evidence: "Worker preview was truncated." });
    expect(f.manager.get(worker.id).review!.status).toBe("needs_verification");
    await expect(f.manager.run({ ...f.args, parentWorkerId: worker.id, requestId: randomUUID() })).rejects.toThrow(/followUpRequestId/);
    const follow = { ...f.args, parentWorkerId: worker.id, requestId: final.review!.followUpRequestId };
    const child = await f.manager.run(follow); const duplicate = await f.manager.run({ ...follow, requestId: randomUUID() });
    expect(child.id).toBe(duplicate.id); expect(f.children.length).toBe(2);
  });

  it("restart recovers an interrupted notification and a fresh tool binding without replaying execution", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); const final = await f.complete(worker);
    f.manager.workers[0].completion!.state = "sending"; f.manager.workers[0].review!.status = "processing"; await f.manager.flush();
    await f.manager.selectOwner("other"); await f.manager.selectOwner("owner");
    const restored = f.manager.get(worker.id); expect(restored.completion!.state).toBe("pending"); expect(restored.review!.status).toBe("pending");
    const received = await f.manager.callbacks.receive(final.completion!.id); expect(received.scope!.sessionId).toBe(f.sessionId); expect(f.children.length).toBe(1);
  });

  it("cancellation during transport suppresses the late receipt and mode-off pauses delivery", async () => {
    let resolve: ((value: SendResult) => void) | undefined;
    const f = await fixture({ send: () => new Promise<SendResult>((done) => { resolve = done; }) }), worker = await f.manager.run(f.args); await f.complete(worker);
    await f.manager.configure({ enabled: false }, async () => {}); f.enable(); await f.manager.callbacks.pump(); expect(resolve).toBe(undefined);
    await f.manager.configure({ enabled: true }, async () => {});
    const pump = f.manager.callbacks.pump(); while (!resolve) await settle();
    await f.manager.stop(worker.id); resolve({ accepted: true, inboxId: "10" }); await pump;
    expect(f.manager.get(worker.id).completion!.state).toBe("suppressed"); expect(f.manager.get(worker.id).review!.status).toBe("cancelled");
  });

  it("report retries preserve accepted callback state and committed evaluation", async () => {
    let reports = 0;
    const f = await fixture({ report: async () => { if (++reports === 1) throw new Error("renderer unavailable"); } }), worker = await f.manager.run(f.args);
    await f.complete(worker); f.enable(); await f.manager.callbacks.pump();
    await f.manager.callbacks.review({ ...f.args, workerId: worker.id, outcome: "failed", summary: "Criteria not met.", evidence: "No expected artifact." });
    while (f.manager.callbacks.pending) await settle();
    expect(f.manager.get(worker.id).completion!.state).toBe("accepted"); expect(f.manager.get(worker.id).review!.status).toBe("failed");
    await f.manager.callbacks.pump(); expect(f.manager.get(worker.id).review!.reported).toBe(true); expect(reports).toBe(2);
  });

  it("native sender uses owning Loom token, rejects HTML success, and classifies HTTP retries", async () => {
    const connection = parseConnection("https://fixture.invalid/being/?token=fixture-secret");
    const worker: CallbackWorkerView = { id: randomUUID(), sessionId: randomUUID(), requestId: randomUUID(), status: "completed", endedAt: "2026-09-09T00:00:00Z", title: "Fixture", completion: { id: randomUUID() } };
    const requests: { url: string; options: RequestInit }[] = []; let response = (): Response => Response.json({ accepted: true, inbox_id: 3 }, { status: 202 });
    const send = createCallbackSender({ getConnection: () => connection, fetchImpl: async (url, options) => { requests.push({ url: String(url), options: options! }); return response(); }, parseConnection, sessionPartition });
    const context = { owner: sessionPartition(connection), signal: new AbortController().signal };
    expect((await send(worker, context)).accepted).toBe(true);
    const url = new URL(requests[0].url); expect(url.pathname).toBe("/being/api/callback"); expect(url.searchParams.get("token")).toBe("fixture-secret");
    expect(requests[0].options.redirect).toBe("error"); expect(String(requests[0].options.body)).not.toMatch(/fixture-secret|sessionToken/);
    response = () => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }); expect((await send(worker, context)).accepted).toBe(false);
    response = () => Response.json({ error: "busy" }, { status: 503 }); expect((await send(worker, context)).retryable).toBe(true);
    response = () => Response.json({ error: "forbidden" }, { status: 403 }); expect((await send(worker, context)).retryable).toBe(false);
    await expect(send(worker, { ...context, owner: "different" })).rejects.toThrow(/身份已变化/);
  });

  // Pure `validArguments` / `toolDefinitions` schema check over desktop-tool-link, which another
  // migration unit ports.
  it.skip("receive is the only callback tool without a historical session token; review still requires scope", () => {});

  it("accepted results schedule one explicit continuation after idle without rerunning the worker", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); await f.complete(worker); f.enable(); await f.manager.callbacks.pump();
    let busy = true, sends = 0;
    f.manager.callbacks.resume = async (value, { beforeSend }) => {
      if (busy) return { busy: true };
      expect(value.sessionId).toBe(f.sessionId); expect(await beforeSend()).toBe(true);
      const saved = JSON.parse(await fs.readFile(f.manager.historyPath(), "utf8"));
      expect(saved[0].completion.continuation.state).toBe("sending"); sends++; return { accepted: true };
    };
    await f.manager.callbacks.pump(); expect(sends).toBe(0); busy = false;
    await f.manager.callbacks.pump(); await f.manager.callbacks.pump(); expect(sends).toBe(1); expect(f.children.length).toBe(1);
    expect(f.manager.get(worker.id).review!.status).toBe("pending"); expect(f.manager.get(worker.id).completion!.continuation!.state).toBe("accepted");
  });

  it("uncertain continuation delivery is not blindly posted again and cancellation wins before dispatch", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); await f.complete(worker); f.enable(); await f.manager.callbacks.pump();
    let sends = 0; f.manager.callbacks.resume = async (_value, { beforeSend }) => { await beforeSend(); sends++; throw new Error("response lost"); };
    await f.manager.callbacks.pump(); await f.manager.callbacks.pump(); expect(sends).toBe(1);
    expect(f.manager.get(worker.id).completion!.state).toBe("accepted"); expect(f.manager.get(worker.id).completion!.continuation!.state).toBe("uncertain");
    const stored = f.manager.workers[0]; delete stored.completion!.continuation;
    f.manager.callbacks.resume = async (_value, { beforeSend }) => { await f.manager.stop(worker.id); expect(await beforeSend()).toBe(false); return { skipped: true }; };
    await f.manager.callbacks.pump(); expect(f.manager.get(worker.id).review!.status).toBe("cancelled");
  });

  it("continuation sender uses explicit original-task notification and never changes SBS", async () => {
    const connection = parseConnection("https://fixture.invalid/being/?token=fixture-secret"), requests: { url: string; options: RequestInit }[] = [];
    const worker: CallbackWorkerView = { id: randomUUID(), sessionId: randomUUID(), completion: { id: randomUUID() } }; let committed = false;
    const send = createContinuationSender({ getConnection: () => connection, getTarget: () => "desktop-fixture", parseConnection, sessionPartition, fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options: options! }); if (String(url).includes("/active")) return new Response(null, { status: 204 });
      expect(committed).toBe(true); return new Response("event: done\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
    } });
    const context = { owner: sessionPartition(connection), signal: new AbortController().signal, beforeSend: async () => { committed = true; return true; } };
    expect((await send(worker, context)).accepted).toBe(true); expect(requests.length).toBe(2);
    expect(JSON.parse(String(requests[1].options.body)).message).toMatch(/automatic Desktop notification/);
    expect(String(requests[1].options.body).includes(worker.sessionId)).toBe(true); expect(String(requests[1].options.body).includes(worker.completion!.id)).toBe(true);
    expect(String(requests[1].options.body)).not.toMatch(/fixture-secret|sessionToken/);
    expect(new URL(requests[1].url).pathname).toBe("/being/api/chat/stream");
    await expect(send(worker, { ...context, owner: "different" })).rejects.toThrow(/identity/);
  });

  it("continuation treats an SSE model error as failure even when HTTP transport succeeds", async () => {
    const connection = parseConnection("https://fixture.invalid/being/?token=fixture-secret");
    const worker: CallbackWorkerView = { id: randomUUID(), sessionId: randomUUID(), completion: { id: randomUUID() } };
    let response = (): Response => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of ["event: err", 'or\r\ndata: {"message":"LLM API error 525 <html>UPSTREAM_HTML</html>"}\r\n', "\r\nevent: done\ndata: {}\n\n"]) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
    const send = createContinuationSender({ getConnection: () => connection, getTarget: () => "desktop-fixture", parseConnection, sessionPartition, fetchImpl: async (url) => String(url).includes("/active") ? new Response(null, { status: 204 }) : response() });
    const context = { owner: sessionPartition(connection), signal: new AbortController().signal, beforeSend: async () => true };
    expect(await send(worker, context)).toEqual({ accepted: false, failed: true, retryable: true, status: 525 });
    response = () => new Response("busy", { status: 503 });
    expect(await send(worker, context)).toEqual({ accepted: false, failed: true, retryable: true, status: 503 });
    response = () => new Response("forbidden", { status: 403 });
    expect(await send(worker, context)).toEqual({ accepted: false, failed: true, retryable: false, status: 403 });
  });

  it("explicit model failures retry only evaluation with backoff and stop after three attempts", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); await f.complete(worker); f.enable(); await f.manager.callbacks.pump();
    let sends = 0;
    f.manager.callbacks.resume = async (value, { beforeSend }) => {
      expect(await beforeSend()).toBe(true); sends++;
      await f.manager.callbacks.receive(value.completion!.id);
      return { accepted: false, failed: true, retryable: true, status: 525 };
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.manager.callbacks.pump();
      const saved = f.manager.get(worker.id);
      expect(saved.completion!.state).toBe("accepted"); expect(saved.review!.status).toBe("pending");
      expect(saved.completion!.continuation!.attempts).toBe(attempt);
      expect(saved.completion!.continuation!.state).toBe(attempt === 3 ? "failed" : "retrying");
      await f.manager.callbacks.pump(); expect(sends, "A retry must wait for backoff").toBe(attempt); f.advance();
    }
    await f.manager.callbacks.pump(); expect(sends).toBe(3); expect(f.children.length).toBe(1);
    expect(f.manager.get(worker.id).result).toBe("EXPECTED");
  });

  it("a committed review survives a later model failure and is delivered without another continuation", async () => {
    const f = await fixture(), worker = await f.manager.run(f.args); await f.complete(worker); f.enable(); await f.manager.callbacks.pump();
    let sends = 0; f.manager.callbacks.resume = async (_value, { beforeSend }) => {
      await beforeSend(); sends++;
      await f.manager.callbacks.review({ ...f.args, workerId: worker.id, outcome: "passed", summary: "Verified.", evidence: "EXPECTED" });
      return { accepted: false, failed: true, retryable: true, status: 525 };
    };
    await f.manager.callbacks.pump(); f.advance(); await f.manager.callbacks.pump(); await f.manager.callbacks.pump();
    expect(f.manager.get(worker.id).review!.status).toBe("passed"); expect(f.manager.get(worker.id).review!.reported).toBe(true);
    expect(sends).toBe(1); expect(f.children.length).toBe(1);
  });

  it("result previews are delivered to the original chat once and merged with a later review", async () => {
    const reports: { worker: WorkerRecord; preview?: boolean }[] = [];
    const f = await fixture({ report: async (worker, context) => { reports.push({ worker, preview: context.presentationOnly }); } });
    const worker = await f.manager.run(f.args); await f.complete(worker);
    f.manager.workers[0].presentation = { artifactPath: "game/index.html", reported: false };
    f.enable(); await f.manager.callbacks.pump(); await f.manager.callbacks.pump();
    expect(reports.length).toBe(1); expect(reports[0].preview).toBe(true); expect(reports[0].worker.sessionId).toBe(f.sessionId);
    expect(f.manager.get(worker.id).presentation!.reported).toBe(true);
    await f.manager.callbacks.review({ ...f.args, workerId: worker.id, outcome: "passed", summary: "Game ready.", evidence: "Rules passed." });
    while (f.manager.callbacks.pending) await settle();
    expect(reports.length).toBe(2); expect(reports[1].preview).toBe(undefined);
    expect(reports[1].worker.id).toBe(reports[0].worker.id); expect(reports[1].worker.review!.requestId).toBe(reports[0].worker.review!.requestId);
    await f.manager.callbacks.pump(); expect(reports.length).toBe(2); expect(f.children.length).toBe(1);
  });

  it("native completion delivery is independent of Worker bridge readiness; evaluation waits for its recovery", async () => {
    let deliveries = 0, continuations = 0, bridge = false;
    const f = await fixture({ send: async () => { deliveries++; return { accepted: true, inboxId: "native-receipt" }; } });
    const worker = await f.manager.run(f.args); await f.complete(worker);
    f.manager.callbacks.toolsReady = () => bridge;
    f.manager.assertEnforced = async () => { if (!bridge) throw Object.assign(new Error("bridge offline"), { code: "ORCHESTRATION_NOT_ENFORCED" }); };
    f.manager.callbacks.resume = async (value, { beforeSend }) => { expect(value.id).toBe(worker.id); expect(await beforeSend()).toBe(true); continuations++; return { accepted: true }; };
    f.enable(); await f.manager.callbacks.pump();
    expect(deliveries).toBe(1); expect(f.manager.get(worker.id).completion!.state).toBe("accepted");
    await f.manager.callbacks.pump(); expect(continuations).toBe(0);
    bridge = true; await f.manager.callbacks.pump(); await f.manager.callbacks.pump();
    expect(deliveries).toBe(1); expect(continuations).toBe(1); expect(f.children.length).toBe(1);
  });
});
