// Ported line by line from BeingDesktop 0.8.26 test/desktop-tools.test.cjs on 2026-09-16.
// `desktopPortalName` is injected because src/desktop-identity.cjs belongs to the
// identity unit; the fixture copies it verbatim from that file.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DesktopTools } from "../desktop/main/tools/desktop-tools";
import type { DesktopBrowserConstructor, DesktopConsoleConstructor, DesktopToolLinkConstructor, DesktopToolsOptions } from "../desktop/main/tools/desktop-tools";
import type { DesktopTerminalLike, InvokeTool, OrchestrationLike, ToolResult, ToolTextContent } from "../desktop/main/tools/types";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function desktopPortalName(id: string) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Desktop 身份无效。");
  return "being-desktop-tools-" + id.toLowerCase();
}

type Deferred<T = any> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = any>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: Partial<DesktopToolsOptions> = {}) {
  let workspace = "E:\\fixture-workspace";
  class Browser {
    onChange: () => void; tabs: any[]; actions: any[]; preparations: any[]; nextPreparation: Deferred | null; destroyed: boolean;
    constructor({ onChange }: { onChange: () => void }) { this.onChange = onChange; this.tabs = [{ id: "browser-fixture", revision: 3, url: "https://public.example.test/a", title: "Fixture" }]; this.actions = []; this.preparations = []; this.nextPreparation = null; this.destroyed = false; }
    snapshot() { return { tabs: structuredClone(this.tabs), activeTabId: this.tabs[0]?.id || null }; }
    newTab(args: unknown) { this.actions.push(["new", args]); return this.snapshot(); }
    navigate(args: unknown) { this.actions.push(["navigate", args]); return this.snapshot(); }
    async readPage(id: string, revision?: number) { this.actions.push(["read", id, revision]); return { text: "visible fixture page" }; }
    async prepareAction(args: unknown) { this.preparations.push(args); return this.nextPreparation ? this.nextPreparation.promise : { targetToken: "fixture-target-token", summary: "Fixture target" }; }
    async click(args: unknown) { this.actions.push(["click", args]); return { clicked: true }; }
    async fill(args: unknown) { this.actions.push(["fill", args]); return { filled: true }; }
    destroy() { this.destroyed = true; }
  }
  class Console {
    onChange: () => void; jobs: any[]; calls: any[]; stops: any[]; nextRun: Deferred | null; disposed: boolean;
    constructor({ onChange }: { onChange: () => void }) { this.onChange = onChange; this.jobs = []; this.calls = []; this.stops = []; this.nextRun = null; this.disposed = false; }
    snapshot() { return { jobs: structuredClone(this.jobs) }; }
    async run(args: any) {
      this.calls.push(args);
      const result: { jobId: string } = this.nextRun ? await this.nextRun.promise : { jobId: `job-${this.calls.length}` };
      this.jobs.push({ id: result.jobId, command: args.command, cwd: args.cwd, status: "running", output: [{ stream: "stdout", text: `output for ${result.jobId}` }] });
      return result;
    }
    async stop(id: unknown) { this.stops.push(id); return { stopped: true }; }
    async dispose() { this.disposed = true; }
  }
  class ToolLink {
    portalName?: string; toolAllowed: (name: string) => boolean; onChange: () => void; invokeTool: InvokeTool; status: string; controllers: AbortController[];
    constructor({ onChange, invokeTool, portalName, toolAllowed }: any) { this.portalName = portalName; this.toolAllowed = toolAllowed; this.onChange = onChange; this.invokeTool = invokeTool; this.status = "disconnected"; this.controllers = []; }
    snapshot() { return { status: this.status }; }
    async connect() { this.status = "connected"; this.onChange(); }
    disconnect() { this.status = "disconnected"; for (const controller of this.controllers) controller.abort(); this.controllers = []; this.onChange(); }
    dispose() { this.disconnect(); }
    call(name: string, args: Record<string, unknown>, requestKey?: string) {
      const controller = new AbortController();
      this.controllers.push(controller);
      return { controller, promise: this.invokeTool(name, args, { signal: controller.signal, requestKey }) as Promise<ToolResult> };
    }
  }
  const changes: any[] = [];
  const tools = new DesktopTools({ Browser: Browser as unknown as DesktopBrowserConstructor, Console: Console as unknown as DesktopConsoleConstructor, ToolLink: ToolLink as unknown as DesktopToolLinkConstructor, desktopPortalName, getWorkspace: () => workspace, getConnection: () => ({ url: "https://unused.example.test", token: "never-used" }), onChange: (state) => changes.push(state), ...options }) as DesktopTools & { browser: Browser; console: Console; link: ToolLink };
  return { tools, changes, setWorkspace: (value: string) => { workspace = value; } };
}

function requestId(tools: DesktopTools) { return tools.snapshot().requests.at(-1)!.id; }
function body(result: ToolResult) { return JSON.parse((result.content[0] as ToolTextContent).text); }
function nextTurn() { return new Promise((resolve) => setImmediate(resolve)); }

describe("desktop tools", () => {
  it("scoped terminal commands run without a second approval and survive tool reconnects", async () => {
    const sessions: any[] = [], writes: any[] = [], shown: string[] = [];
    const id = randomUUID();
    const terminal = { snapshot: () => ({ sessions }), async create() { sessions.push({ id, status: "running" }); return { sessionId: id }; },
      readSince: () => ({ id, sequence: 0, data: "" }), write: (value: any) => { writes.push(value); return { written: true }; } } as unknown as DesktopTerminalLike;
    const { tools } = fixture({ getTerminal: () => terminal, showTerminal: (id) => shown.push(id) }); cleanups.push(() => tools.dispose());
    const scope = tools.terminalTools.scope(randomUUID());
    const created = await tools.link.call("desktop_terminal_create", { ...scope, requestId: randomUUID() }).promise;
    expect(body(created).terminalId).toBe(id); expect(shown).toEqual([id]); expect(tools.snapshot().requests.length).toBe(0);
    tools.disconnectLink();
    const written = await tools.link.call("desktop_terminal_write", { ...scope, terminalId: id, requestId: randomUUID(), data: "test\r" }).promise;
    expect(body(written).written).toBe(true); expect(writes.length).toBe(1); expect(sessions.length).toBe(1);
    const rejected = await tools.link.call("desktop_terminal_read", { ...scope, sessionToken: randomUUID(), terminalId: id }).promise;
    expect(rejected.isError).toBe(true); expect((rejected.content[0] as ToolTextContent).text).toMatch(/会话绑定/);
  });

  it("remote command stays pending until an explicit approval and freezes its reviewed cwd", async () => {
    const { tools, setWorkspace } = fixture();
    cleanups.push(() => tools.dispose());
    const args = { command: "Write-Output fixture" };
    const call = tools.link.call("desktop_console_run", args);
    const id = requestId(tools);
    args.command = "mutated after request";
    setWorkspace("E:\\different-workspace");
    expect(tools.console.calls.length).toBe(0);
    expect(tools.snapshot().requests[0].args.command).toBe("Write-Output fixture");
    expect(tools.snapshot().requests[0].args.cwd).toBe("E:\\fixture-workspace");
    await tools.perform("request.allow", id);
    expect(body(await call.promise).jobId).toBe("job-1");
    expect(tools.console.calls.length).toBe(1);
    expect(tools.console.calls[0].cwd).toBe("E:\\fixture-workspace");
    expect(tools.snapshot().requests.length).toBe(0);
  });

  it("duplicate approval or denial clicks cannot execute an approved command twice", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    tools.console.nextRun = deferred();
    const call = tools.link.call("desktop_console_run", { command: "Write-Output fixture" });
    const id = requestId(tools);
    const first = tools.perform("request.allow", id);
    await expect(tools.perform("request.allow", id)).rejects.toThrow(/处理|执行/);
    await expect(tools.perform("request.deny", id)).rejects.toThrow(/处理|执行/);
    expect(tools.console.calls.length).toBe(1);
    tools.console.nextRun.resolve({ jobId: "only-job" });
    await first;
    expect(body(await call.promise).jobId).toBe("only-job");
  });

  it("denial and signal cancellation never launch pending work", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    const denied = tools.link.call("desktop_console_run", { command: "first" });
    const deniedResult = expect(denied.promise).rejects.toThrow(/拒绝/);
    await tools.perform("request.deny", requestId(tools));
    await deniedResult;
    const cancelled = tools.link.call("desktop_console_run", { command: "second" });
    const cancelledResult = expect(cancelled.promise).rejects.toThrow(/取消|断开|结束/);
    cancelled.controller.abort();
    await cancelledResult;
    expect(tools.console.calls.length).toBe(0);
    expect(tools.snapshot().requests.length).toBe(0);
  });

  it("disconnect revokes every pending approval without launching commands", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    const calls = Array.from({ length: 3 }, (_, index) => tools.link.call("desktop_console_run", { command: `fixture ${index}` }));
    const results = calls.map((call) => expect(call.promise).rejects.toThrow(/取消|断开|结束/));
    await tools.perform("link.disconnect");
    await Promise.all(results);
    expect(tools.snapshot().requests.length).toBe(0);
    expect(tools.console.calls.length).toBe(0);
  });

  it("Being output reads include only jobs approved for the current connection", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    await tools.perform("link.connect");
    await tools.perform("console.run", { command: "local-only", cwd: "E:\\fixture-workspace" });
    const remote = tools.link.call("desktop_console_run", { command: "remote-approved" });
    await tools.perform("request.allow", requestId(tools));
    const remoteId = body(await remote.promise).jobId;
    await expect(tools.link.call("desktop_console_status", { jobId: "job-1" }).promise).rejects.toThrow(/只能读取/);
    await expect(tools.link.call("desktop_console_stop", { jobId: "job-1" }).promise).rejects.toThrow(/只能停止/);
    const status = tools.link.call("desktop_console_status", {});
    await tools.perform("request.allow", requestId(tools));
    expect(body(await status.promise).jobs.map((job: any) => job.id)).toEqual([remoteId]);
    await tools.perform("link.disconnect");
    await tools.perform("link.connect");
    await expect(tools.link.call("desktop_console_status", { jobId: remoteId }).promise).rejects.toThrow(/只能读取/);
  });

  it("an old approved run finishing after reconnect cannot grant its output to the new Being session", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    await tools.perform("link.connect");
    tools.console.nextRun = deferred();
    const old = tools.link.call("desktop_console_run", { command: "old session delayed start" });
    const rejected = expect(old.promise).rejects.toThrow(/取消|断开|结束/);
    const allowing = tools.perform("request.allow", requestId(tools));
    await tools.perform("link.disconnect");
    await rejected;
    await tools.perform("link.connect");
    tools.console.nextRun.resolve({ jobId: "old-session-job" });
    await allowing;
    const status = tools.link.call("desktop_console_status", {});
    await tools.perform("request.allow", requestId(tools));
    expect(body(await status.promise).jobs).toEqual([]);
  });

  it("approval cannot navigate a tab whose reviewed page revision changed while waiting", async () => {
    const { tools, changes } = fixture();
    cleanups.push(() => tools.dispose());
    const call = tools.link.call("desktop_browser_open", { tabId: "browser-fixture", url: "https://public.example.test/target" });
    const id = requestId(tools);
    tools.browser.tabs[0].revision++;
    const rejected = expect(call.promise).rejects.toThrow(/变化|版本|重新读取/);
    await tools.perform("request.allow", id);
    await rejected;
    expect(tools.browser.actions.length).toBe(0);
    expect(tools.snapshot().requestResult!.id).toBe(id);
    expect(tools.snapshot().requestResult!.status).toBe("failed");
    expect(tools.snapshot().requestResult!.message).toMatch(/过期.*变化/);
    await nextTurn();
    expect(changes.some((state) => state.requestResult?.id === id && /过期/.test(state.requestResult.message))).toBe(true);
  });

  it("approval queue is bounded and missing tabs are never offered for approval", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    await expect(tools.link.call("desktop_browser_read", { tabId: "already-closed" }).promise).rejects.toThrow(/关闭/);
    const calls = Array.from({ length: 8 }, () => tools.link.call("desktop_browser_tabs", {}));
    const results = calls.map((call) => expect(call.promise).rejects.toThrow(/取消|断开|结束/));
    await expect(tools.link.call("desktop_browser_tabs", {}).promise).rejects.toThrow(/过多/);
    tools.disconnectLink();
    await Promise.all(results);
    expect(tools.snapshot().requests.length).toBe(0);
  });

  it("disposal revokes pending calls and rejects future local or remote operations", async () => {
    const { tools } = fixture();
    const pending = tools.link.call("desktop_console_run", { command: "pending at exit" });
    const rejected = expect(pending.promise).rejects.toThrow(/取消|断开|结束/);
    await tools.dispose();
    await rejected;
    expect(tools.console.disposed).toBe(true);
    expect(tools.browser.destroyed).toBe(true);
    await expect(tools.perform("console.run", { command: "too late" })).rejects.toThrow(/关闭/);
    await expect(tools.link.call("desktop_console_run", { command: "too late" }).promise).rejects.toThrow(/取消|关闭/);
  });

  for (const kind of ["click", "fill"]) {
    it(`${kind} waits for target preparation and approval passes the frozen target token`, async () => {
      const { tools } = fixture();
      cleanups.push(() => tools.dispose());
      tools.browser.nextPreparation = deferred();
      const args: any = { tabId: "browser-fixture", selector: "#reviewed-target", expectedRevision: 3, ...(kind === "fill" ? { text: "reviewed text" } : {}) };
      const call = tools.link.call(`desktop_browser_${kind}`, args);
      expect(tools.snapshot().requests.length).toBe(0);
      expect(tools.browser.actions.length).toBe(0);
      expect(tools.browser.preparations).toEqual([{ id: "browser-fixture", selector: "#reviewed-target", expectedRevision: 3, kind }]);
      args.selector = "#changed-after-request";
      if (kind === "fill") args.text = "changed after request";
      const prepared = { targetToken: `${kind}-original-target-token`, summary: `Reviewed ${kind} target` };
      tools.browser.nextPreparation.resolve(prepared);
      await nextTurn();
      expect(tools.snapshot().requests.length).toBe(1);
      expect(tools.snapshot().requests[0].targetSummary).toBe(`Reviewed ${kind} target`);
      expect(tools.browser.actions.length).toBe(0);
      prepared.targetToken = "mutated-after-enqueue";
      const id = requestId(tools);
      await tools.perform("request.allow", id);
      expect((await call.promise).isError).toBe(false);
      expect(tools.browser.actions).toEqual([[kind, {
        id: "browser-fixture", selector: "#reviewed-target", expectedRevision: 3,
        targetToken: `${kind}-original-target-token`, ...(kind === "fill" ? { text: "reviewed text" } : {}),
      }]]);
    });
  }

  it("disconnect while a target is being prepared prevents a late approval card or page action", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    await tools.perform("link.connect");
    tools.browser.nextPreparation = deferred();
    const call = tools.link.call("desktop_browser_click", { tabId: "browser-fixture", selector: "#target", expectedRevision: 3 });
    const rejected = expect(call.promise).rejects.toThrow(/取消|断开|结束/);
    expect(tools.snapshot().requests.length).toBe(0);
    await tools.perform("link.disconnect");
    await tools.perform("link.connect");
    tools.browser.nextPreparation.resolve({ targetToken: "obsolete-target", summary: "Old session target" });
    await rejected;
    await nextTurn();
    expect(tools.snapshot().requests.length).toBe(0);
    expect(tools.browser.actions.length).toBe(0);
  });

  it("an all-job output approval includes only the job range displayed when requested", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    const first = tools.link.call("desktop_console_run", { command: "first reviewed command" });
    await tools.perform("request.allow", requestId(tools));
    const firstId = body(await first.promise).jobId;
    const status = tools.link.call("desktop_console_status", {});
    const statusId = requestId(tools);
    expect(tools.snapshot().requests.find((request) => request.id === statusId)!.reviewJobs).toEqual([{ id: firstId, command: "first reviewed command", cwd: "E:\\fixture-workspace" }]);
    const later = tools.link.call("desktop_console_run", { command: "later separately approved command" });
    await tools.perform("request.allow", requestId(tools));
    const laterId = body(await later.promise).jobId;
    expect(firstId).not.toBe(laterId);
    tools.console.jobs.find((job) => job.id === firstId).output.push({ stream: "stdout", text: "new output from the reviewed job" });
    await tools.perform("request.allow", statusId);
    const jobs = body(await status.promise).jobs;
    expect(jobs.map((job: any) => job.id)).toEqual([firstId]);
    expect(jobs[0].output.at(-1).text).toBe("new output from the reviewed job");
  });

  it("an empty output range cannot expand to commands started while approval waits", async () => {
    const { tools } = fixture();
    cleanups.push(() => tools.dispose());
    const status = tools.link.call("desktop_console_status", {});
    const statusId = requestId(tools);
    expect(tools.snapshot().requests[0].reviewJobs).toEqual([]);
    const later = tools.link.call("desktop_console_run", { command: "first command after empty read request" });
    await tools.perform("request.allow", requestId(tools));
    await later.promise;
    await tools.perform("request.allow", statusId);
    expect(body(await status.promise).jobs).toEqual([]);
  });

  it("stable Desktop tool targets and advertised modes remain independent", async () => {
    const id = randomUUID(), otherId = randomUUID(), mode = { enabled: true };
    const direct = fixture({ desktopId: id }), orchestrator = fixture({ desktopId: otherId, orchestration: { mode } as unknown as OrchestrationLike });
    cleanups.push(() => direct.tools.dispose()); cleanups.push(() => orchestrator.tools.dispose());
    expect(direct.tools.link.portalName).toBe("being-desktop-tools-" + id);
    expect(orchestrator.tools.link.portalName).toBe("being-desktop-tools-" + otherId);
    expect(direct.tools.link.toolAllowed("desktop_worker_start")).toBe(false);
    expect(direct.tools.link.toolAllowed("desktop_browser_open")).toBe(true);
    expect(orchestrator.tools.link.toolAllowed("desktop_worker_start")).toBe(true);
    expect(orchestrator.tools.link.toolAllowed("desktop_browser_open")).toBe(false);
    mode.enabled = false;
    expect(orchestrator.tools.link.toolAllowed("desktop_worker_start")).toBe(false);
    expect(direct.tools.link.toolAllowed("desktop_browser_open")).toBe(true);
  });
});
