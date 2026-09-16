// The tool bridge's IPC surface and its assembly into the subsystem registry;
// 2026-09-16.
//
// Two subjects, both of which only exist once the ported modules are wired up:
//
//  1. THE CHANNELS. What crosses `beings:tools-action` is a verb and a payload
//     the renderer chose, so the whitelist, the type checks and the refusals are
//     the boundary. The approval channels get their own case: `request.allow` is
//     the single point where a Being's call stops being a proposal, and it must
//     reach `DesktopTools.decide` and nothing else.
//  2. THE WIRING. The orchestration façade, the lazily-resolved terminal, and the
//     `linked()` assignment are each a way this subsystem could be wrong while
//     every unit test in tools-*.test.ts still passes. The peers are class
//     instances, because production hands class instances through the registry.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installToolsSubsystem } from "../desktop/main/subsystems/tools";
import { WorkerPresentation } from "../desktop/main/tools/worker-presentation";
import { IDLE_TOOLS_STATE } from "../desktop/shared/tools-types";
import type { DesktopToolsState } from "../desktop/shared/tools-types";
import type { Connection } from "../desktop/main/chat/connection";
import type { ToolResult } from "../desktop/main/tools/types";
import type {
  DesktopSubsystem, SubsystemContext, SubsystemMap, SubsystemRegistry,
} from "../desktop/main/subsystems/types";
import type { Settings } from "../desktop/shared/types";

const DESKTOP_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS = "https://loom.example.test/agatha?token=secret-token";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/* -------------------------------------------------------------------------- */
/* The electron touchpoints DesktopBrowser validates, and nothing more.        */
/* -------------------------------------------------------------------------- */

class FakeView {
  static created: FakeView[] = [];
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  listeners = new Map<string, ((...args: any[]) => void)[]>();
  url = "";
  webContents = {
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    on: (event: string, listener: (...args: any[]) => void) => { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); },
    removeListener: () => {},
    setWindowOpenHandler: () => {},
    loadURL: (url: string) => { this.url = url; },
    getURL: () => this.url,
    isLoading: () => false,
    isDestroyed: () => false,
    reload: () => {}, stop: () => {}, close: () => {},
    capturePage: async () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize() { return this; }, toPNG: () => Buffer.alloc(0) }),
    executeJavaScriptInIsolatedWorld: async () => ({}),
  };
  constructor() { FakeView.created.push(this); }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
  setVisible(visible: boolean) { this.visible = visible; }
  setBackgroundColor() {}
}
class FakeSession {
  static partitions: string[] = [];
  webRequest = { onBeforeRequest: () => {} };
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
  on() { return this; }
  removeListener() { return this; }
}
class FakeWindow {
  destroyed = false;
  children: unknown[] = [];
  contentView = { addChildView: (view: unknown) => { this.children.push(view); }, removeChildView: (view: unknown) => { this.children = this.children.filter(item => item !== view); } };
  webContents = { isDestroyed: () => this.destroyed, send: () => {} };
  isDestroyed() { return this.destroyed; }
  getContentSize() { return [1400, 900]; }
}

/* -------------------------------------------------------------------------- */
/* The two peers this subsystem reaches through the registry.                 */
/* -------------------------------------------------------------------------- */

/** Orchestration as the tool bridge reads it. A class, because production
 * registers class instances and a `get mode()` on a literal is not the same
 * object shape a getter on a prototype is. */
class FakeOrchestration {
  mode = { enabled: false };
  configuring = false;
  workers: { presentation?: unknown }[] = [];
  notified = 0;
  calls: { name: string; args: Record<string, unknown> }[] = [];
  presentation?: WorkerPresentation;
  notify() { this.notified++; }
  async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    return { content: [{ type: "text", text: "{}" }], isError: false };
  }
}
class FakePolicy {
  synced = 0;
  async syncBridge() { this.synced++; }
}
class OrchestrationSubsystemFake {
  readonly key = "orchestration";
  readonly orchestration = new FakeOrchestration();
  readonly policy = new FakePolicy();
}

/** The terminal as the tool bridge reads it: a snapshot, a create, a reveal. */
class FakeTerminal {
  shell = "zsh";
  sessions: { id: string; cwd: string; status: string }[] = [];
  snapshot() { return { sessions: this.sessions, activeSessionId: this.sessions.at(-1)?.id ?? null }; }
  async create({ cwd }: { cwd?: string } = {}) {
    const sessionId = `terminal-${this.sessions.length + 1}`;
    this.sessions.push({ id: sessionId, cwd: cwd || "", status: "running" });
    return { sessionId };
  }
  write() { return { written: true }; }
  readSince(id: string, afterSequence: number) { return { id, sequence: afterSequence, data: "" }; }
  activate() {}
  async close() { return { closed: true }; }
}
class TerminalSubsystemFake {
  readonly key = "terminal";
  readonly terminal = new FakeTerminal();
  revealed: string[] = [];
  reveal(terminalId: string) { this.revealed.push(terminalId); }
}

/* -------------------------------------------------------------------------- */

interface FixtureOptions {
  connectionAddress?: string;
  workspace?: string;
  peers?: Record<string, unknown>;
}

async function fixture({ connectionAddress = ADDRESS, workspace = "/tmp/fixture-workspace", peers = {} }: FixtureOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beings-tools-ipc-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  FakeView.created = [];
  FakeSession.partitions = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pushes: { channel: string; payload: unknown }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const window = new FakeWindow();
  const built = new Map<string, unknown>(Object.entries(peers));
  const registry: SubsystemRegistry = {
    get: <K extends keyof SubsystemMap>(key: K) => (built.get(key as string) as SubsystemMap[K] | undefined) ?? null,
    require: <K extends keyof SubsystemMap>(key: K) => {
      const value = built.get(key as string);
      if (!value) throw new Error(`子系统 ${String(key)} 未安装。`);
      return value as SubsystemMap[K];
    },
  };
  let clipboardText = "";
  const context = {
    handle: (channel: string, callback: (...args: any[]) => unknown) => { handlers.set(channel, callback); },
    exclusive: <T>(operation: () => Promise<T>) => operation(),
    window: () => window,
    store: {
      connection: null as Connection | null,
      connectionAddress,
      settings: { workspace, projectWorkspace: "" } as unknown as Settings,
      extras: {},
      saveExtra: async () => {},
    },
    electron: {
      WebContentsView: FakeView,
      session: { fromPartition: (partition: string) => { FakeSession.partitions.push(partition); return new FakeSession(); } },
      net: { fetch, request: null, isOnline: () => true },
      clipboard: { readText: async () => clipboardText, writeText: async (value: string) => { clipboardText = value; } },
      shell: { openPath: async () => "", openExternal: async () => {} },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    },
    userData: directory,
    desktopId: DESKTOP_ID,
    clientVersion: "0.9.0",
    fetchImpl: fetch,
    onError: (scope: string, error: unknown) => { errors.push({ scope, error }); },
    registry,
    push: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); },
  } as unknown as SubsystemContext;
  const subsystem = installToolsSubsystem(context);
  built.set(subsystem.key as string, subsystem as unknown as DesktopSubsystem);
  cleanups.push(() => subsystem.quitting?.());
  /** Wait for `DesktopTools.changed()`'s setImmediate to run, so a push that the
   * action caused has actually been sent. */
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    subsystem, handlers, pushes, errors, window, settle, context,
    setClipboard: (value: string) => { clipboardText = value; },
    // Async, as production is: `createTrustedHandle` wraps every callback in an
    // async function, so a handler that throws synchronously reaches the renderer
    // as a rejection either way (desktop/main/app/ipc.ts).
    call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
  };
}

describe("the tool bridge's channels", () => {
  it("registers the documented set and answers with a live snapshot", async () => {
    const f = await fixture();
    expect([...f.handlers.keys()]).toEqual([
      "beings:tools", "beings:tools-action", "beings:tools-browser-view", "beings:clipboard-read",
    ]);
    const state = (await f.call("beings:tools")) as DesktopToolsState;
    expect(state.link.status).toBe("disconnected");
    expect(state.workspace).toBe("/tmp/fixture-workspace");
    expect(state.requests).toEqual([]);
    // The Being-facing browser's own partition, not the shell browser's — the
    // whole point of keeping the two apart (integration plan §5.6).
    expect(FakeSession.partitions).toEqual(["persist:being-desktop-browser-v1"]);
  });

  it("answers the idle snapshot rather than refusing when no bridge could be built", async () => {
    // The shape a renderer sees before anything exists is the shape it sees
    // afterwards; it never branches on "not ready".
    expect(Object.keys(IDLE_TOOLS_STATE)).toEqual(["browser", "console", "link", "workspace", "requestResult", "requests"]);
    expect(IDLE_TOOLS_STATE.link.status).toBe("disconnected");
  });

  it("refuses a verb it does not know, and one that is not a string", async () => {
    const f = await fixture();
    for (const action of ["browser.evaluate", "console", "", null, 42, { action: "browser.new" }])
      await expect(f.call("beings:tools-action", action)).rejects.toThrow("未知桌面工具操作。");
  });

  it("refuses a payload with a field outside the whitelist, or a prototype of its own", async () => {
    const f = await fixture();
    await expect(f.call("beings:tools-action", "browser.new", { url: "https://example.test/", partition: "persist:elsewhere" }))
      .rejects.toThrow("标签页参数无效。");
    await expect(f.call("beings:tools-action", "browser.navigate", { id: "x", url: "https://example.test/", expectedRevision: 3 }))
      .rejects.toThrow("网页地址参数无效。");
    await expect(f.call("beings:tools-action", "console.run", { command: "ls", shell: "/bin/sh" }))
      .rejects.toThrow("命令参数无效。");
    // A payload carrying its own prototype is refused before any key is read.
    const polluted = JSON.parse('{"url":"https://example.test/","__proto__":{"polluted":true}}');
    await expect(f.call("beings:tools-action", "browser.new", Object.create({ url: "https://example.test/" }))).rejects.toThrow("标签页参数无效。");
    await f.call("beings:tools-action", "browser.new", polluted).catch(() => {});
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });

  it("refuses a value of the wrong type or beyond the ceiling", async () => {
    const f = await fixture();
    await expect(f.call("beings:tools-action", "browser.new", { active: "yes" })).rejects.toThrow("标签页参数无效。");
    await expect(f.call("beings:tools-action", "browser.new", { url: "h".repeat(8193) })).rejects.toThrow("标签页参数无效。");
    await expect(f.call("beings:tools-action", "browser.activate", 7)).rejects.toThrow("标签页参数无效。");
    await expect(f.call("beings:tools-action", "browser.activate", "")).rejects.toThrow("标签页参数无效。");
    await expect(f.call("beings:tools-action", "request.allow", { id: "x" })).rejects.toThrow("待确认调用参数无效。");
    await expect(f.call("beings:tools-action", "link.connect", "now")).rejects.toThrow("工具连接参数无效。");
  });

  it("opens, navigates and closes a tab, pushing the new state each time", async () => {
    const f = await fixture();
    const opened = (await f.call("beings:tools-action", "browser.new", { url: "https://example.test/one" })) as DesktopToolsState;
    expect(opened.browser.tabs).toHaveLength(1);
    const tabId = opened.browser.tabs[0].id;
    expect(opened.browser.activeTabId).toBe(tabId);
    await f.settle();
    expect(f.pushes.map(push => push.channel)).toContain("beings:tools-state");
    const closed = (await f.call("beings:tools-action", "browser.close", tabId)) as DesktopToolsState;
    expect(closed.browser.tabs).toEqual([]);
  });

  it("pins the native view to the rectangle it is given, and detaches without forgetting it", async () => {
    const f = await fixture();
    await f.call("beings:tools-action", "browser.new", { url: "https://example.test/one" });
    const shown = await f.call("beings:tools-browser-view", { visible: true, bounds: { x: 12.4, y: 48.6, width: 700.2, height: 500.9 } });
    // Floored, as DesktopBrowser's own normalizeBounds does.
    expect(FakeView.created[0].bounds).toEqual({ x: 12, y: 48, width: 700, height: 500 });
    expect(shown).toMatchObject({ visible: true });
    const hidden = await f.call("beings:tools-browser-view", { visible: false });
    expect(hidden).toMatchObject({ visible: false });
    expect(FakeView.created[0].visible).toBe(false);
  });

  it("refuses a viewport that is not a rectangle", async () => {
    const f = await fixture();
    await expect(f.call("beings:tools-browser-view", { bounds: { x: 0, y: 0, width: 10, height: 10 } })).rejects.toThrow("浏览器显示参数无效。");
    await expect(f.call("beings:tools-browser-view", { visible: true, bounds: { x: 0, y: 0, width: Number.NaN, height: 10 } })).rejects.toThrow("浏览器显示参数无效。");
    await expect(f.call("beings:tools-browser-view", { visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 }, opacity: 1 })).rejects.toThrow("浏览器显示参数无效。");
  });

  it("reads the clipboard, truncated where 0.8.26 truncates it", async () => {
    const f = await fixture();
    f.setClipboard("x".repeat(65536 + 40));
    expect(((await f.call("beings:clipboard-read")) as string).length).toBe(65536);
  });
});

describe("the approval queue over IPC", () => {
  /** A Being's call, as `DesktopToolLink` delivers it. Answered only once the
   * user decides, which is the whole mechanism. */
  const request = (f: Awaited<ReturnType<typeof fixture>>, name: string, args: Record<string, unknown>) =>
    f.subsystem.tools!.request(name, args, {});

  it("holds a call until `request.allow`, then runs exactly it", async () => {
    const f = await fixture();
    const call = request(f, "desktop_browser_open", { url: "https://example.test/from-being" });
    await f.settle();
    const queued = (await f.call("beings:tools")) as DesktopToolsState;
    expect(queued.requests.map(item => ({ name: item.name, status: item.status }))).toEqual([{ name: "desktop_browser_open", status: "pending" }]);
    // Nothing has happened yet: no tab, and the browser has built no view.
    expect(queued.browser.tabs).toEqual([]);
    const after = (await f.call("beings:tools-action", "request.allow", queued.requests[0].id)) as DesktopToolsState;
    await expect(call).resolves.toMatchObject({ isError: false });
    expect(after.requests).toEqual([]);
    expect(after.requestResult).toMatchObject({ id: queued.requests[0].id, status: "completed", message: "Being 调用已完成。" });
    expect(((await f.call("beings:tools")) as DesktopToolsState).browser.tabs).toHaveLength(1);
  });

  it("answers `request.deny` with the refusal the Being sees, and runs nothing", async () => {
    const f = await fixture();
    const call = request(f, "desktop_browser_open", { url: "https://example.test/from-being" });
    await f.settle();
    const id = ((await f.call("beings:tools")) as DesktopToolsState).requests[0].id;
    const after = (await f.call("beings:tools-action", "request.deny", id)) as DesktopToolsState;
    await expect(call).rejects.toThrow("用户拒绝了本次调用。");
    expect(after.requests).toEqual([]);
    expect(after.requestResult).toMatchObject({ status: "failed", message: "用户拒绝了本次调用。" });
    expect(((await f.call("beings:tools")) as DesktopToolsState).browser.tabs).toEqual([]);
  });

  it("refuses a decision on a request that is not in this queue", async () => {
    const f = await fixture();
    await expect(f.call("beings:tools-action", "request.allow", "not-a-request")).rejects.toThrow("该调用已处理或已取消。");
    // …including one that was already decided.
    const call = request(f, "desktop_browser_open", { url: "https://example.test/from-being" });
    await f.settle();
    const id = ((await f.call("beings:tools")) as DesktopToolsState).requests[0].id;
    await f.call("beings:tools-action", "request.deny", id);
    await expect(call).rejects.toThrow();
    await expect(f.call("beings:tools-action", "request.allow", id)).rejects.toThrow("该调用已处理或已取消。");
  });

  it("cancels everything queued when the Being binding changes", async () => {
    const f = await fixture();
    const call = request(f, "desktop_browser_open", { url: "https://example.test/from-being" });
    await f.settle();
    expect(((await f.call("beings:tools")) as DesktopToolsState).requests).toHaveLength(1);
    // First verification of a different identity than the (empty) one held.
    f.subsystem.connectionVerified?.(null);
    await expect(call).rejects.toThrow("工具连接已断开。");
    expect(((await f.call("beings:tools")) as DesktopToolsState).requests).toEqual([]);
  });

  // Re-verifying the SAME Being must not cut a live bridge. This shell calls
  // `connectionVerified` from `beings:portal-start`, `beings:save` and a takeover
  // preflight as well as from startup, so an unguarded disconnect would drop the
  // link every time someone started their Portal — 0.8.26 guards it on the
  // session partition (src/main.cjs line 710).
  it("leaves a live bridge alone when the same Being is verified again", async () => {
    const f = await fixture();
    f.subsystem.connectionVerified?.(null);
    const call = request(f, "desktop_browser_open", { url: "https://example.test/from-being" });
    await f.settle();
    f.subsystem.connectionVerified?.(null);
    f.subsystem.connectionVerified?.(null);
    expect(((await f.call("beings:tools")) as DesktopToolsState).requests).toHaveLength(1);
    // …and a different Being still cuts it.
    f.subsystem.connectionVerified?.(null);
    (f.context.store as { connectionAddress: string }).connectionAddress = "https://loom.example.test/other?token=another-token";
    f.subsystem.connectionVerified?.(null);
    await expect(call).rejects.toThrow("工具连接已断开。");
  });

  it("forgets the previous Being's terminal scopes when the identity changes", async () => {
    const peer = new TerminalSubsystemFake();
    const f = await fixture({ peers: { terminal: peer } });
    f.subsystem.connectionVerified?.(null);
    const tools = f.subsystem.tools!;
    const scope = tools.terminalTools.scope("session-1");
    await tools.terminalTools.invoke("desktop_terminal_create", { ...scope, requestId: "r-1" }, {});
    expect(tools.terminalTools.sessions("session-1")).toHaveLength(1);
    (f.context.store as { connectionAddress: string }).connectionAddress = "https://loom.example.test/other?token=another-token";
    f.subsystem.connectionVerified?.(null);
    // The scope is gone, so a retry with the old session token is refused as
    // belonging to another desktop session.
    await expect(tools.terminalTools.invoke("desktop_terminal_list", scope, {}))
      .rejects.toThrow("终端调用不属于当前桌面会话，请使用当前消息中的会话绑定。");
  });
});

describe("the tool subsystem's wiring", () => {
  it("leaves the bridge in direct mode when no orchestration subsystem is installed", async () => {
    const f = await fixture();
    const tools = f.subsystem.tools!;
    expect(tools.orchestration?.mode).toEqual({ enabled: false });
    // A worker tool in direct mode is refused by the bridge itself…
    await expect(tools.request("desktop_worker_start", {}, {})).rejects.toThrow("编排模式未开启。");
    // …and `tools/list` offers the direct-mode tools, never the worker ones.
    expect(tools.link.capabilities().tools).toEqual([]);
  });

  it("follows orchestration mode through the façade, including a peer installed after it", async () => {
    // Installed after, which is the case the lazy rule exists for: the tool
    // bridge captured `orchestration` in its constructor's closures, so a façade
    // that resolved once would still say「编排模式未开启」here.
    const peer = new OrchestrationSubsystemFake();
    const f = await fixture({ peers: { orchestration: peer } });
    const tools = f.subsystem.tools!;
    expect(tools.orchestration?.mode.enabled).toBe(false);
    peer.orchestration.mode.enabled = true;
    expect(tools.orchestration?.mode.enabled).toBe(true);
    // Now a worker tool goes to orchestration, and a desktop tool is refused.
    await expect(tools.request("desktop_worker_start", { task: "x" }, {})).resolves.toMatchObject({ isError: false });
    expect(peer.orchestration.calls.map(call => call.name)).toEqual(["desktop_worker_start"]);
    await expect(tools.request("desktop_browser_open", { url: "https://example.test/" }, {}))
      .rejects.toThrow("编排模式下 Being 只能调度 worker，不能直接执行桌面工具。");
  });

  it("syncs the orchestration policy and notifies presented workers on every change", async () => {
    const peer = new OrchestrationSubsystemFake();
    peer.orchestration.workers = [{ presentation: { tabId: "browser-1" } }];
    const f = await fixture({ peers: { orchestration: peer } });
    await f.call("beings:tools-action", "browser.new", { url: "https://example.test/one" });
    await f.settle();
    expect(peer.policy.synced).toBeGreaterThan(0);
    expect(peer.orchestration.notified).toBeGreaterThan(0);
    expect(f.pushes.filter(push => push.channel === "beings:tools-state").length).toBeGreaterThan(0);
  });

  it("gives orchestration its presentation in `linked()`, not while installing", async () => {
    const peer = new OrchestrationSubsystemFake();
    const f = await fixture({ peers: { orchestration: peer } });
    // The assignment is the one thing a lazy getter cannot express, so it must
    // not have happened yet when the installer returned.
    expect(peer.orchestration.presentation).toBe(undefined);
    f.subsystem.linked?.();
    expect(peer.orchestration.presentation).toBeInstanceOf(WorkerPresentation);
    // And it presents into THIS subsystem's browser, not a second one.
    await f.call("beings:tools-action", "browser.new", { url: "https://example.test/one" });
    const tabs = f.subsystem.tools!.browser.snapshot().tabs;
    const value = { url: tabs[0].url, artifactPath: null, requestedUrl: null, openedAt: "" };
    // A tab this browser holds is described from this browser's snapshot…
    expect(peer.orchestration.presentation!.describe({ ...value, tabId: tabs[0].id })).toMatchObject({ state: "loading", title: tabs[0].title });
    // …and one it does not hold reads as closed, which is what「结果标签页已关闭」
    // means to the user.
    expect(peer.orchestration.presentation!.describe({ ...value, tabId: "browser-from-another-window" }))
      .toMatchObject({ state: "closed", detail: "结果标签页已关闭，可重新打开。" });
  });

  it("links without complaint when there is no orchestration subsystem", async () => {
    const f = await fixture();
    expect(() => f.subsystem.linked?.()).not.toThrow();
    expect(f.errors).toEqual([]);
  });

  it("keeps the terminal tools out of the catalogue while no terminal subsystem is installed", async () => {
    const f = await fixture();
    const tools = f.subsystem.tools!;
    expect(tools.getTerminal()).toBe(null);
    await expect(tools.request("desktop_terminal_list", { sessionId: "s", sessionToken: "t" }, {}))
      .resolves.toMatchObject({ isError: true });
  });

  it("resolves the terminal through the registry when one is installed", async () => {
    const peer = new TerminalSubsystemFake();
    const f = await fixture({ peers: { terminal: peer } });
    const tools = f.subsystem.tools!;
    expect(tools.getTerminal()).toBe(peer.terminal);
    const scope = tools.terminalTools.scope("session-1");
    const created = (await tools.terminalTools.invoke("desktop_terminal_create", { ...scope, requestId: "r-1" }, {})) as { terminalId: string };
    expect(peer.terminal.sessions.map(item => item.id)).toEqual([created.terminalId]);
    // `showTerminal` opens the console pane first, then hands the id to I3's own
    // panel — BeingDesktop does both (src/main.cjs line 1701).
    expect(peer.revealed).toEqual([created.terminalId]);
    expect(f.pushes.filter(push => push.channel === "beings:tools-reveal").map(push => push.payload)).toEqual(["console"]);
  });

  it("stops the relay, the queue and the browser when the client quits", async () => {
    const f = await fixture();
    await f.call("beings:tools-action", "browser.new", { url: "https://example.test/one" });
    const call = f.subsystem.tools!.request("desktop_browser_open", { url: "https://example.test/from-being" }, {});
    await f.settle();
    await f.subsystem.quitting?.();
    await expect(call).rejects.toThrow("工具连接已断开。");
    await expect(f.call("beings:tools-action", "browser.new")).rejects.toThrow("桌面工具已关闭。");
    // …and the snapshot channel still answers, because the panel may still ask.
    expect(await f.call("beings:tools")).toBeTruthy();
  });
});
