// Ported from BeingDesktop 0.8.26 test/orchestration.test.cjs on 2026-09-16.
// All 24 cases, names preserved. Two of them exercise desktop-tool-link / desktop-tools, which
// belong to another migration unit, and are carried as it.skip with the reason inline.
// Fixtures are copied verbatim; only the assertion style changes (node:test -> vitest).
// Protocol reference: docs/orchestration.md, docs/architecture.md §5.5, docs/interfaces.md §3/§7.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestration } from "../desktop/main/orchestration/orchestration";
import { normalizeEvent } from "../desktop/main/orchestration/worker-events";
import { detectAgents } from "../desktop/main/orchestration/agent-kits";
import { OrchestrationPolicy } from "../desktop/main/orchestration/orchestration-policy";
import type {
  AgentExitResult, AgentRecord, AgentStream, ExecutionContextInput, LaunchAgentOptions,
  NormalizedEvent, WorkerPresentationValue, WorkerRecord, WorkerToolArgs,
} from "../desktop/main/orchestration/types";

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** The fake child BeingDesktop's fixture returns: the launch options plus a settleable `done`. */
interface FakeChild extends LaunchAgentOptions {
  onData: (stream: AgentStream, text: string) => void;
  done: Promise<AgentExitResult>;
  finish: (result: AgentExitResult) => void;
  stop: () => Promise<void>;
}

/** Session scope plus dispatch fields; `manager.context()` also carries display-only fields. */
type Args = WorkerToolArgs & { sessionId: string; sessionToken: string; requestId: string };
const scope = (manager: Orchestration, id: string): WorkerToolArgs => manager.context(id) as WorkerToolArgs;

interface Fixture {
  manager: Orchestration;
  args: Args;
  sessionId: string;
  otherId: string;
  children: FakeChild[];
  directory: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture(): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "being-workers-"));
  const sessionId = randomUUID(), otherId = randomUUID(), children: FakeChild[] = [];
  const agents: AgentRecord[] = [{ id: "codex", name: "Codex CLI", path: "fixture", status: "ready" }];
  const manager = new Orchestration({
    directory, getWorkspace: () => directory, getSessionIds: () => [sessionId, otherId], detect: async () => agents,
    launch: (options) => {
      let finish!: (result: AgentExitResult) => void;
      const child = { ...options, done: new Promise<AgentExitResult>((resolve) => { finish = resolve; }), finish: (result: AgentExitResult) => finish(result), stop: async () => { finish({ code: null, stopped: true }); } } as FakeChild;
      children.push(child); return child;
    },
  });
  await manager.selectOwner("owner-one");
  await manager.configure({ enabled: true }, async () => {});
  const args = { ...manager.context(sessionId), requestId: randomUUID(), title: "Test worker", prompt: "Inspect only the fixture." } as Args;
  cleanups.push(async () => { await manager.dispose(); expect(directory.startsWith(os.tmpdir())).toBe(true); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, args, sessionId, otherId, children, directory };
}

describe("orchestration manager", () => {
  it("result presentation is bound to a completed worker and preserves its review and CLI execution count", async () => {
    const { manager, args, children, otherId } = await fixture(), worker = await manager.run(args);
    let presentations = 0;
    manager.presentation = {
      open: async (_value: WorkerRecord, input: { artifactPath?: string | null; url?: string | null }, { current }) => { expect(current()).toBe(true); expect(input.artifactPath).toBe("game/index.html"); presentations++; return { state: "loading", artifactPath: input.artifactPath ?? undefined, tabId: "fixture" }; },
      describe: (value?: WorkerPresentationValue) => value,
      dispose: async () => {},
    };
    await expect(manager.present({ ...args, workerId: worker.id, artifactPath: "game/index.html" })).rejects.toThrow(/完成/);
    children[0].onData("stdout", '{"type":"turn.completed"}\n'); children[0].finish({ code: 0 }); await manager.finalizing.get(worker.id);
    await expect(manager.present({ ...scope(manager, otherId), workerId: worker.id, artifactPath: "game/index.html" })).rejects.toThrow(/本会话/);
    const before = manager.get(worker.id).review;
    const result = await manager.tool("desktop_worker_status", { ...args, workerId: worker.id, action: "present", artifactPath: "game/index.html" });
    expect(JSON.parse(result.content[0].text).presentation.state).toBe("loading");
    expect(manager.get(worker.id).review).toEqual(before); expect(children.length).toBe(1); expect(presentations).toBe(1);
    const saved = JSON.parse(await fs.readFile(manager.historyPath(), "utf8")); expect(saved[0].presentation.artifactPath).toBe("game/index.html");
    await expect(manager.present({ ...args, workerId: worker.id, artifactPath: "game/index.html" }, { signal: AbortSignal.abort() })).rejects.toThrow(/取消/);
    expect(presentations).toBe(1);
    await expect(manager.openResult(worker.id, otherId)).rejects.toThrow(/没有可打开/);
    manager.mode.enabled = false;
    await manager.openResult(worker.id, args.sessionId); expect(presentations).toBe(2); expect(children.length).toBe(1);
  });

  // Pure `validArguments` schema check over desktop-tool-link, which another migration unit ports.
  it.skip("presentation schema accepts one nullable target only for the presentation action", () => {});

  it("enabling requires an executable default agent and persistence succeeds before changing mode", async () => {
    const { manager } = await fixture();
    await manager.configure({ enabled: false }, async () => {});
    manager.detect = async () => [];
    await expect(manager.configure({ enabled: true }, async () => { throw new Error("must not save"); })).rejects.toThrow(/没有可执行/);
    expect(manager.mode.enabled).toBe(false);
    await expect(manager.configure({ enabled: false }, async () => { throw new Error("disk failed"); })).rejects.toThrow(/disk failed/);
    expect(manager.mode.enabled).toBe(false);
  });

  it("an unavailable bridge still prevents worker launch after chat readiness is inspected", async () => {
    const { manager, args, children } = await fixture(), desktopId = randomUUID();
    const gate = new OrchestrationPolicy({
      getIdentity: () => manager.owner, getDesktopId: () => desktopId, getMode: () => manager.mode,
      getBridge: () => ({ status: "disconnected", place: "being-desktop-tools-" + desktopId, tools: [] }),
    });
    manager.assertEnforced = () => gate.assertEnforced();
    expect((await gate.inspectForMessage()).status).toBe("blocked");
    await expect(manager.run(args)).rejects.toMatchObject({ code: "ORCHESTRATION_NOT_ENFORCED" });
    expect(children.length).toBe(0); expect(manager.workers.length).toBe(0);
  });

  it("worker dispatch is session bound, deduplicated, and serializes the shared checkout", async () => {
    const { manager, args, otherId, children } = await fixture();
    await expect(manager.run({ ...args, sessionToken: randomUUID() })).rejects.toThrow(/有效会话/);
    const worker = await manager.run(args);
    expect((await manager.run(args)).id).toBe(worker.id); expect(children.length).toBe(1);
    await expect(manager.tool("desktop_worker_status", { ...scope(manager, otherId), workerId: worker.id })).rejects.toThrow(/其他会话/);
    await expect(manager.run({ ...args, requestId: randomUUID() })).rejects.toThrow(/工作区已有/);
    expect(children[0].input!.endsWith("\n\n" + args.prompt)).toBe(true);
    expect(JSON.parse(children[0].input!.split("\n")[1]).workspace).toBe(children[0].cwd);
    expect(children[0].args!.includes("--skip-git-repo-check")).toBe(true);
    expect(children[0].args![children[0].args!.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(children[0].args!.some((arg) => arg.includes("dangerously"))).toBe(false);
    children[0].onData("stdout", '{"type":"item.started","item":{"id":"t1","type":"command_execution","command":"pwd"}}\n{"type":"item.com');
    children[0].onData("stdout", 'pleted","item":{"id":"t1","type":"command_execution","status":"completed","aggregated_output":"fixture"}}\n{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Verified fixture"}}\n{"type":"turn.completed"}\n');
    children[0].finish({ code: 0 }); await tick();
    const result = manager.get(worker.id); expect(result.status).toBe("completed"); expect(result.result).toBe("Verified fixture");
    expect(result.events.filter((event) => event.kind === "tool").length).toBe(2);
    expect(result.sessionId).toBe(args.sessionId);
  });

  it("exit zero without a success event fails; cancel and process errors are terminal", async () => {
    const { manager, args, children } = await fixture();
    let worker = await manager.run(args); children[0].finish({ code: 0 }); await tick(); expect(manager.get(worker.id).status).toBe("failed");
    worker = await manager.run({ ...args, requestId: randomUUID() }); await manager.stop(worker.id); await tick(); expect(manager.get(worker.id).status).toBe("cancelled");
    worker = await manager.run({ ...args, requestId: randomUUID() }); children[2].onData("stdout", '{"type":"turn.failed","error":{"message":"Login required"}}\n'); children[2].finish({ code: 1 }); await tick();
    expect(manager.get(worker.id).status).toBe("failed");
  });

  it("Codex reconnection progress does not mark a subsequently completed worker failed", async () => {
    const { manager, args, children } = await fixture();
    const worker = await manager.run(args);
    children[0].onData("stdout", '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}\n{"type":"turn.completed"}\n');
    children[0].finish({ code: 0 }); await tick();
    const result = manager.get(worker.id);
    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.kind === "status" && event.text!.startsWith("Reconnecting"))).toBe(true);
    expect(result.events.some((event) => event.kind === "error")).toBe(false);
    expect((normalizeEvent("codex", { type: "error", message: "Authentication failed" }) as NormalizedEvent).kind).toBe("error");
  });

  it("wait returns final evidence and changing identity prevents cross-owner access", async () => {
    const { manager, args, children } = await fixture(); const worker = await manager.run(args);
    const waited = manager.tool("desktop_worker_wait", { ...args, workerId: worker.id });
    children[0].onData("stdout", '{"type":"turn.completed"}\n'); children[0].finish({ code: 0 });
    expect(JSON.parse((await waited).content[0].text).status).toBe("completed");
    await manager.selectOwner("owner-two"); expect(manager.snapshot().workers.length).toBe(0);
    await expect(manager.tool("desktop_worker_status", { ...args, workerId: worker.id })).rejects.toThrow(/有效会话/);
    await manager.selectOwner("owner-one"); expect(manager.get(worker.id).status).toBe("completed");
  });

  it("restart marks running records interrupted without relaunch", async () => {
    const { manager, args, children } = await fixture(); const worker = await manager.run(args);
    await manager.flush(); const file = manager.historyPath(), saved = await fs.readFile(file, "utf8");
    await manager.stopAll(); await tick(); await manager.flush();
    await fs.writeFile(file, saved); await manager.selectOwner("owner-two"); await manager.selectOwner("owner-one");
    // Switching away persists the live ledger, so explicitly restore the simulated crash record before reopening.
    await manager.selectOwner("owner-two"); await fs.writeFile(file, saved); await manager.selectOwner("owner-one");
    expect(manager.get(worker.id).status).toBe("interrupted"); expect(children.length).toBe(1);
  });

  it("mode cannot switch during a worker and cancelled acquisition cannot launch", async () => {
    const { manager, args, children } = await fixture(); let release!: (agents: AgentRecord[]) => void;
    manager.detect = () => new Promise<AgentRecord[]>((resolve) => { release = resolve; });
    const controller = new AbortController(), pending = manager.run(args, { signal: controller.signal });
    await expect(manager.configure({ enabled: false }, async () => {})).rejects.toThrow(/停止/);
    controller.abort(); release([{ id: "codex", path: "fixture", status: "ready" }]);
    await expect(pending).rejects.toThrow(/取消/); expect(children.length).toBe(0);
  });

  it("Codex, Cursor and Grok events preserve call IDs and redact credential-shaped text", () => {
    const cursor = normalizeEvent("cursor", { type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { readToolCall: { args: { path: "a.txt" }, result: { success: { content: "secret=PRIVATE" } } } } }) as NormalizedEvent;
    expect(cursor.kind).toBe("tool"); expect(cursor.callId).toBe("c1"); expect(cursor.output!.includes("PRIVATE")).toBe(false);
    const grok = normalizeEvent("grok", { type: "tool_call_update", toolCallId: "g1", status: "completed", rawOutput: { lines: 42 } }) as NormalizedEvent;
    expect(grok.callId).toBe("g1"); expect(grok.status).toBe("completed");
    expect((normalizeEvent("grok", { type: "end", stopReason: "max_tokens" }) as NormalizedEvent).success).toBe(false);
    expect(normalizeEvent("codex", { type: "future.event" })).toBe(null);
  });

  it("detection distinguishes missing, incompatible and unauthenticated agents", async () => {
    const result = await detectAgents({}, {
      find: async (commands) => commands[0] === "grok" ? "" : commands[0],
      run: async (file, args) => file === "codex" ? args[0] === "exec" ? { code: 0, output: "--json --sandbox --skip-git-repo-check" } : { code: 1, output: "Login required" }
        : file === "claude" ? args[0] === "--help" ? { code: 0, output: "--output-format --print --permission-mode --settings" } : { code: 0, output: '{"loggedIn":true}' } : { code: 0, output: "unrelated executable" },
    });
    expect(result.map((agent) => agent.status)).toEqual(["needs_auth", "ready", "incompatible", "missing"]);
    expect(result[1].auth).toBe("configured");
    // `claude auth status` exits 1 when signed out (measured 2026-09-11): that is the only signal trusted.
    const signedOut = await detectAgents({}, {
      find: async (commands) => commands[0] === "claude" ? "claude" : "",
      run: async (_file, args) => args[0] === "--help" ? { code: 0, output: "--output-format --print --permission-mode --settings" } : { code: 1, output: '{"loggedIn":false}' },
    });
    expect(signedOut[1].status).toBe("needs_auth"); expect(signedOut[1].detail!.includes("claude auth login")).toBe(true);
  });

  it("Claude Code events map sessions, tool calls, refusals and failed results", () => {
    expect(normalizeEvent("claude", { type: "system", subtype: "init", session_id: "s1", tools: ["Bash"] })).toEqual({ kind: "session", sessionId: "s1" });
    const started = normalizeEvent("claude", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "先看一眼" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] }, session_id: "s1" }) as NormalizedEvent[];
    expect(started.map((event) => [event.kind, event.callId || "", event.status || ""])).toEqual([["message", "", ""], ["tool", "toolu_1", "running"]]);
    expect(started[0].text).toBe("先看一眼"); expect(started[1].name).toBe("Bash"); expect(started[1].text!.includes("ls")).toBe(true);
    const finished = normalizeEvent("claude", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.txt" }], is_error: false }] } }) as NormalizedEvent[];
    expect(finished.map((event) => [event.kind, event.callId, event.status, event.output])).toEqual([["tool", "toolu_1", "completed", "a.txt"]]);
    const refused = normalizeEvent("claude", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "This command requires approval", is_error: true }] } }) as NormalizedEvent[];
    expect(refused[0].status).toBe("failed");
    expect((normalizeEvent("claude", { type: "system", subtype: "permission_denied", tool_name: "Bash", message: "This command requires approval" }) as NormalizedEvent).kind).toBe("status");
    expect(normalizeEvent("claude", { type: "rate_limit_event", rate_limit_info: {} })).toBe(null);
    // A signed-out run ends with subtype success but is_error true (measured 2026-09-11).
    const failed = normalizeEvent("claude", { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: "s1" }) as NormalizedEvent;
    expect(failed.success).toBe(false); expect(failed.text).toBe("Not logged in · Please run /login");
    expect((normalizeEvent("claude", { type: "result", subtype: "error_max_turns", is_error: true }) as NormalizedEvent).success).toBe(false);
    expect(normalizeEvent("claude", { type: "result", subtype: "success", is_error: false, result: "完成", session_id: "s1" })).toEqual({ kind: "result", success: true, text: "完成", sessionId: "s1" });
  });

  it("a Claude Code worker runs unattended inside its sandbox and recalls tool names for results", async () => {
    const { manager, args, children } = await fixture();
    manager.detect = async () => [{ id: "codex", name: "Codex CLI", path: "fixture", status: "ready" }, { id: "claude", name: "Claude Code CLI", path: "/opt/homebrew/bin/claude", status: "ready" }];
    const worker = await manager.run({ ...args, agentId: "claude" });
    const child = children[0];
    expect(child.file).toBe("/opt/homebrew/bin/claude");
    expect(child.args!.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(child.args!.slice(child.args!.indexOf("--permission-mode"), child.args!.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(JSON.parse(child.args![child.args!.indexOf("--settings") + 1])).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
    expect(child.input!.startsWith("[Desktop execution context]")).toBe(true); expect(child.input!.endsWith(args.prompt!)).toBe(true);
    child.onData("stdout", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-claude" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "测试通过。" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "测试通过。", session_id: "s-claude" }),
    ].join("\n") + "\n");
    child.finish({ code: 0 }); await manager.finalizing.get(worker.id);
    const done = manager.get(worker.id);
    expect(done.status).toBe("completed"); expect(done.agentSessionId).toBe("s-claude"); expect(done.result).toBe("测试通过。");
    expect(done.events.filter((event) => event.kind === "tool").map((event) => `${event.name} · ${event.status}`)).toEqual(["Bash · running", "Bash · completed"]);
  });

  it("a Claude Code run that ends in error is a failed worker even at exit code 0", async () => {
    const { manager, args, children } = await fixture();
    manager.detect = async () => [{ id: "claude", name: "Claude Code CLI", path: "/opt/homebrew/bin/claude", status: "ready" }];
    const worker = await manager.run({ ...args, agentId: "claude" });
    children[0].onData("stdout", JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }) + "\n");
    children[0].finish({ code: 0 }); await manager.finalizing.get(worker.id);
    expect(manager.get(worker.id).status).toBe("failed");
  });

  // Exercises DesktopTools.request/invoke and desktop-tool-link's toolDefinitions/validArguments,
  // both owned by another migration unit.
  it.skip("desktop execution is denied in orchestrator mode and worker schemas require session binding", () => {});

  it("title generation uses an isolated CLI, ignores duplicate requests and cleans up", async () => {
    const { manager, sessionId, children, directory } = await fixture();
    const pending = manager.generateTitle(sessionId, "修复登录");
    expect(await manager.generateTitle(sessionId, "duplicate")).toBe("");
    while (!children.length) await tick();
    const child = children[0];
    expect(child.cwd).not.toBe(directory);
    expect(child.args!.includes("read-only")).toBe(true);
    expect(child.input!.includes("修复登录")).toBe(true);
    child.onData("stdout", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "登录修复" } }) + "\n");
    child.onData("stdout", JSON.stringify({ type: "turn.completed" }) + "\n");
    child.finish({ code: 0 });
    expect(await pending).toBe("登录修复");
    expect(manager.workers.length).toBe(0);
    await expect(fs.stat(child.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Claude Code titles run with no tools, one turn and no saved session", async () => {
    const { manager, sessionId, children } = await fixture();
    manager.detect = async () => [{ id: "claude", name: "Claude Code CLI", path: "/opt/homebrew/bin/claude", status: "ready" }];
    manager.mode.defaultAgent = "claude";
    const pending = manager.generateTitle(sessionId, "把篝火时间线做成增量累积");
    while (!children.length) await tick();
    const child = children[0];
    expect(child.args!.slice(-5)).toEqual(["--tools", "", "--max-turns", "1", "--no-session-persistence"]);
    expect(child.input!.includes("把篝火时间线做成增量累积")).toBe(true);
    child.onData("stdout", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "篝火时间线增量累积" }] } }) + "\n" + JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "篝火时间线增量累积" }) + "\n");
    child.finish({ code: 0 });
    expect(await pending).toBe("篝火时间线增量累积");
  });

  it("failed CLI naming keeps the default title and missing workers never launch", async () => {
    const { manager, sessionId, children } = await fixture();
    const pending = manager.generateTitle(sessionId, "task");
    while (!children.length) await tick();
    children[0].finish({ code: 1 });
    expect(await pending).toBe("");
    await manager.configure({ enabled: false }, async () => {});
    manager.detect = async () => [];
    expect(await manager.generateTitle(sessionId, "task")).toBe("");
    expect(children.length).toBe(1);
  });

  it("separate Desktops reject each other capabilities and keep tasks and execution targets local", async () => {
    const a = await fixture(), b = await fixture();
    const aId = randomUUID(), bId = randomUUID();
    a.manager.getExecutionContext = () => ({ desktopId: aId, place: "desktop-a", apiKey: "must-not-enter-prompt" } as ExecutionContextInput);
    b.manager.getExecutionContext = () => ({ desktopId: bId, place: "desktop-b", apiKey: "must-not-enter-prompt" } as ExecutionContextInput);
    // Even identical conversation IDs do not make per-Desktop capabilities interchangeable.
    b.manager.getSessionIds = () => [a.sessionId];
    const bArgs = { ...b.manager.context(a.sessionId), requestId: randomUUID(), title: "B", prompt: "Task B" } as Args;
    await expect(b.manager.run(a.args)).rejects.toThrow(/有效会话/);
    await expect(a.manager.run(bArgs)).rejects.toThrow(/有效会话/);
    const wa = await a.manager.run(a.args), wb = await b.manager.run(bArgs);
    expect(a.children.length).toBe(1); expect(b.children.length).toBe(1);
    expect(wa.execution!.desktopInstanceId).not.toBe(wb.execution!.desktopInstanceId);
    expect(wa.execution!.workspace).toBe(await fs.realpath(a.directory)); expect(wb.execution!.workspace).toBe(await fs.realpath(b.directory));
    expect(wa.execution!.place).toBe("desktop-a"); expect(wb.execution!.place).toBe("desktop-b");
    expect(wa.execution!.desktopId).toBe(aId); expect(wb.execution!.desktopId).toBe(bId);
    expect(a.children[0].input).not.toMatch(/must-not-enter-prompt/);
    expect(() => a.manager.get(wb.id)).toThrow(/不存在/);
    await a.manager.stop(wa.id); expect(b.manager.get(wb.id).status).toBe("running");
    await a.manager.configure({ enabled: false }, async () => {}); expect(b.manager.mode.enabled).toBe(true);
  });

  it("copied foreign Desktop worker history cannot be read or resume callbacks", async () => {
    const a = await fixture(), b = await fixture();
    const id = randomUUID(); a.manager.getExecutionContext = () => ({ desktopId: id });
    const worker = await a.manager.run(a.args); await a.manager.stop(worker.id); await a.manager.flush();
    await b.manager.selectOwner("other");
    b.manager.getExecutionContext = () => ({ desktopId: randomUUID() });
    await fs.mkdir(b.directory, { recursive: true });
    await fs.copyFile(a.manager.historyPath(), path.join(b.manager.directory, path.basename(a.manager.historyPath())));
    await b.manager.selectOwner("owner-one");
    expect(b.manager.workers.length).toBe(0); expect(() => b.manager.get(worker.id)).toThrow(/不存在/);
    await expect(b.manager.callbacks.receive(randomUUID())).rejects.toThrow(/有效任务/);
  });

  it("titles work without orchestration mode and serialize separate sessions", async () => {
    const { manager, sessionId, otherId, children } = await fixture();
    await manager.configure({ enabled: false }, async () => {});
    const first = manager.generateTitle(sessionId, "登录故障");
    const second = manager.generateTitle(otherId, "消息搜索");
    while (!children.length) await tick();
    await tick(); expect(children.length).toBe(1);
    children[0].onData("stdout", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "登录故障修复" } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n");
    children[0].finish({ code: 0 }); expect(await first).toBe("登录故障修复");
    while (children.length < 2) await tick();
    children[1].onData("stdout", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "消息搜索优化" } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n");
    children[1].finish({ code: 0 }); expect(await second).toBe("消息搜索优化");
    expect(manager.workers.length).toBe(0);
  });

  it("stopping title jobs cancels running and queued work without launching another CLI", async () => {
    const { manager, sessionId, otherId, children } = await fixture();
    const first = manager.generateTitle(sessionId, "one"), second = manager.generateTitle(otherId, "two");
    while (!children.length) await tick();
    await manager.stopAll();
    expect(await first).toBe(""); expect(await second).toBe(""); expect(children.length).toBe(1);
  });

  it("title generation falls back to another installed worker and cools down a failed provider", async () => {
    const { manager, sessionId, otherId, children } = await fixture();
    manager.detect = async () => [{ id: "codex", path: "codex-fixture", status: "ready" }, { id: "claude", path: "claude-fixture", status: "ready" }];
    const pending = manager.generateTitle(sessionId, "登录页面");
    while (!children.length) await tick(); children[0].finish({ code: 1 });
    while (children.length < 2) await tick(); expect(children[1].file).toBe("claude-fixture");
    const complete = (child: FakeChild): void => { child.onData("stdout", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "登录页面改进" }) + "\n"); child.finish({ code: 0 }); };
    complete(children[1]); expect(await pending).toBe("登录页面改进");
    const next = manager.generateTitle(otherId, "第二个会话");
    while (children.length < 3) await tick(); expect(children[2].file).toBe("claude-fixture"); complete(children[2]);
    expect(await next).toBe("登录页面改进"); expect(children.length).toBe(3);
  });
});
