// The tool panel's rules, as the renderer model holds them; 2026-09-16.
//
// BeingDesktop has no `*-ui.cjs` for renderer/desktop-tools.js — the panel's
// behaviour was only ever covered end to end. These are the rules that are worth
// pinning without a packaged client, because each of them is a decision rather
// than a layout, and each of them was ported rather than invented:
//
//  · a snapshot must not eat what is being typed in the address field;
//  · a failed request result is raised once, not on every push after it;
//  · the link hint's four branches and their order;
//  · the viewport is sent only when it changed, and `visible` is the conjunction
//    the native view is actually attached on.
//
// The components are not exercised here (there is no DOM in this suite); the
// browser-side path is tests/tools-e2e.mjs's subject.
import { describe, expect, it } from "vitest";
import { ToolsModel } from "../desktop/renderer/tools/models/tools";
import { IDLE_TOOLS_STATE } from "../desktop/shared/desktop-types";
import type {
  DesktopToolsAction, DesktopToolsState, DesktopToolsViewport,
} from "../desktop/shared/desktop-types";
import type { DesktopAPI } from "../desktop/shared/types";

const tab = (over: Partial<DesktopToolsState["browser"]["tabs"][number]> = {}) => ({
  id: "browser-1", title: "示例", url: "https://example.test/one", isLoading: false,
  canGoBack: false, canGoForward: false, error: "", notice: "", revision: 1, ...over,
});

const state = (over: Partial<DesktopToolsState> = {}): DesktopToolsState => ({
  ...IDLE_TOOLS_STATE,
  browser: { tabs: [tab()], activeTabId: "browser-1", visible: false },
  ...over,
});

/** The bridge as the panel sees it: every call recorded, every push replayable.
 * A class, so the model meets the same shape production gives it. */
class FakeBridge {
  acts: DesktopToolsAction[] = [];
  viewports: DesktopToolsViewport[] = [];
  next: DesktopToolsState = state();
  failure: Error | null = null;
  viewportFailure: Error | null = null;
  private stateListeners: ((value: DesktopToolsState) => void)[] = [];
  private revealListeners: ((value: "browser" | "console") => void)[] = [];
  stopped = 0;
  readonly tools = {
    state: async () => this.next,
    act: async (input: DesktopToolsAction) => {
      this.acts.push(input);
      if (this.failure) throw this.failure;
      return this.next;
    },
    browserView: async (viewport: DesktopToolsViewport) => {
      this.viewports.push(viewport);
      if (this.viewportFailure) throw this.viewportFailure;
      return this.next.browser;
    },
    readText: async () => "",
    onState: (callback: (value: DesktopToolsState) => void) => {
      this.stateListeners.push(callback);
      return () => { this.stopped++; this.stateListeners = this.stateListeners.filter(item => item !== callback); };
    },
    onReveal: (callback: (value: "browser" | "console") => void) => {
      this.revealListeners.push(callback);
      return () => { this.stopped++; this.revealListeners = this.revealListeners.filter(item => item !== callback); };
    },
  };
  push(value: DesktopToolsState) { this.next = value; for (const listener of this.stateListeners) listener(value); }
  reveal(pane: "browser" | "console") { for (const listener of this.revealListeners) listener(pane); }
  get api() { return this as unknown as DesktopAPI; }
}

const started = () => {
  const bridge = new FakeBridge();
  const model = new ToolsModel(bridge.api);
  const stop = model.start();
  return { bridge, model, stop };
};

const RECT = { x: 10, y: 20, width: 800, height: 600 };

describe("the tool panel's model", () => {
  it("shows the idle snapshot before the first answer, and closes both subscriptions", async () => {
    const { bridge, model, stop } = started();
    expect(model.state).toBe(IDLE_TOOLS_STATE);
    await Promise.resolve();
    stop();
    expect(bridge.stopped).toBe(2);
    // A push after teardown must not reopen the panel's state.
    const before = model.state;
    bridge.push(state({ workspace: "/late" }));
    expect(model.state).toBe(before);
  });

  it("opens a first tab when the browser pane is shown empty, and not when it has one", async () => {
    const { bridge, model, stop } = started();
    bridge.next = IDLE_TOOLS_STATE;
    await model.show("browser");
    expect(bridge.acts).toEqual([{ action: "browser.new" }]);
    bridge.next = state();
    bridge.push(state());
    await model.show("browser");
    expect(bridge.acts).toHaveLength(1);
    stop();
  });

  it("keeps what is being typed in the address field, and restores it on blur", () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    expect(model.address).toBe("https://example.test/one");
    model.focusAddress(true);
    model.editAddress("https://example.test/two");
    // A snapshot arriving mid-edit must not overwrite the field.
    bridge.push(state({ browser: { tabs: [tab({ url: "https://example.test/three" })], activeTabId: "browser-1", visible: false } }));
    expect(model.address).toBe("https://example.test/two");
    model.focusAddress(false);
    expect(model.address).toBe("https://example.test/three");
    stop();
  });

  it("navigates the active tab, and does nothing when the address is already showing", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    model.editAddress("https://example.test/two");
    await model.submitAddress();
    expect(bridge.acts).toEqual([{ action: "browser.navigate", value: { id: "browser-1", url: "https://example.test/two" } }]);
    model.editAddress("https://example.test/one");
    await model.submitAddress();
    expect(bridge.acts).toHaveLength(1);
    stop();
  });

  it("opens a new tab when nothing is active", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state({ browser: { tabs: [], activeTabId: null, visible: false } }));
    model.editAddress("https://example.test/two");
    await model.submitAddress();
    expect(bridge.acts).toEqual([{ action: "browser.new", value: { url: "https://example.test/two" } }]);
    stop();
  });

  it("raises a failed request result once, and never for a success", () => {
    const { bridge, model, stop } = started();
    bridge.push(state({ requestResult: { id: "r-1", status: "failed", message: "用户拒绝了本次调用。" } }));
    expect(model.error).toBe("上一次 Being 调用：用户拒绝了本次调用。");
    expect(model.detailsOpen).toBe(true);
    model.toggleDetails();
    expect(model.error).toBe("");
    // The same result arriving again with every later push must not re-raise it.
    bridge.push(state({ requestResult: { id: "r-1", status: "failed", message: "用户拒绝了本次调用。" } }));
    expect(model.error).toBe("");
    bridge.push(state({ requestResult: { id: "r-2", status: "completed", message: "Being 调用已完成。" } }));
    expect(model.error).toBe("");
    stop();
  });

  it("puts the reconnect countdown ahead of the error, and both ahead of the ordinary sentence", () => {
    const { bridge, model, stop } = started();
    expect(model.linkHint).toBe("连接后，Being 的页面和命令调用会在这里等待你确认。");
    const link = IDLE_TOOLS_STATE.link;
    bridge.push(state({ link: { ...link, status: "error", error: "工具连接握手未完成，请重新连接。" } }));
    expect(model.linkHint).toBe("工具连接握手未完成，请重新连接。");
    bridge.push(state({ link: { ...link, status: "error", error: "工具连接握手未完成，请重新连接。", reconnect: { attempt: 3, delayMs: 8000 } } }));
    expect(model.linkHint).toBe("调度工具已断线，8 秒后自动重连。");
    // Rounded up, as 0.8.26 does: 2500ms is「3 秒后」, never「2 秒后」.
    bridge.push(state({ link: { ...link, status: "error", error: "", reconnect: { attempt: 1, delayMs: 2500 } } }));
    expect(model.linkHint).toBe("调度工具已断线，3 秒后自动重连。");
    stop();
  });

  it("says what disconnecting does to commands that are still running", () => {
    const { bridge, model, stop } = started();
    const link = { ...IDLE_TOOLS_STATE.link, status: "connected" as const };
    const jobs = (count: number) => ({
      ...IDLE_TOOLS_STATE.console,
      jobs: Array.from({ length: count }, (_, index) => ({
        id: `job-${index}`, command: "sleep 9", cwd: "/tmp", status: "running" as const,
        startedAt: "", endedAt: null, exitCode: null, signal: null, output: [], truncated: false,
      })),
    });
    bridge.push(state({ link, console: jobs(0) }));
    expect(model.linkHint).toBe("每次调用单独确认；断开连接不会停止已启动的命令。");
    bridge.push(state({ link, console: jobs(2) }));
    expect(model.linkHint).toBe("每次调用单独确认；断开连接后 2 条本机命令仍会运行。");
    bridge.push(state({ link: IDLE_TOOLS_STATE.link, console: jobs(2) }));
    expect(model.linkHint).toBe("Being 工具未连接；仍有 2 条本机命令运行，可在控制台手动停止。");
    stop();
  });

  it("toggles the link once at a time, and picks disconnect while still connecting", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    await model.toggleLink();
    expect(bridge.acts).toEqual([{ action: "link.connect" }]);
    bridge.push(state({ link: { ...IDLE_TOOLS_STATE.link, status: "connecting" } }));
    await model.toggleLink();
    expect(bridge.acts.at(-1)).toEqual({ action: "link.disconnect" });
    bridge.push(state({ link: { ...IDLE_TOOLS_STATE.link, status: "connected" } }));
    await model.toggleLink();
    expect(bridge.acts.at(-1)).toEqual({ action: "link.disconnect" });
    stop();
  });

  it("shows the native view only when the panel, the mode, the tab and the shell all allow it", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    // Closed: nothing to attach to.
    model.browserView(RECT, false);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: false });
    await model.show("browser");
    model.browserView(RECT, false);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: true, bounds: RECT });
    // A dialog on top, a drag in progress, and the console pane each hide it.
    model.browserView({ ...RECT, x: 11 }, true);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: false });
    model.setResizing(true);
    model.browserView({ ...RECT, x: 12 }, false);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: false });
    model.setResizing(false);
    await model.show("console");
    model.browserView({ ...RECT, x: 13 }, false);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: false });
    stop();
  });

  it("hides the view for a tab that failed or has no page yet", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state({ browser: { tabs: [tab({ url: "", error: "" })], activeTabId: "browser-1", visible: false } }));
    await model.show("browser");
    model.browserView(RECT, false);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: false });
    bridge.push(state({ browser: { tabs: [tab({ error: "网页未能打开" })], activeTabId: "browser-1", visible: false } }));
    model.browserView({ ...RECT, x: 11 }, false);
    expect(bridge.viewports.at(-1)).toMatchObject({ visible: false });
    stop();
  });

  it("sends a viewport only when it changed, and resends after one fails", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    await model.show("browser");
    bridge.viewports.length = 0;
    model.browserView(RECT, false);
    model.browserView(RECT, false);
    // Sub-pixel jitter rounds to the same rectangle, so it is the same message.
    model.browserView({ ...RECT, x: RECT.x + 0.2 }, false);
    expect(bridge.viewports).toHaveLength(1);
    bridge.viewportFailure = new Error("桌面窗口已关闭。");
    model.browserView({ ...RECT, x: 40 }, false);
    await Promise.resolve();
    bridge.viewportFailure = null;
    // The main process's rectangle is now unknown, so the same one is sent again.
    model.browserView({ ...RECT, x: 40 }, false);
    expect(bridge.viewports).toHaveLength(3);
    stop();
  });

  it("opens the pane the main process asked for", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    expect(model.open).toBe(false);
    bridge.reveal("console");
    await Promise.resolve();
    expect([model.open, model.mode]).toEqual([true, "console"]);
    bridge.reveal("browser");
    await Promise.resolve();
    expect(model.mode).toBe("browser");
    stop();
  });

  it("closes the panel with the toggle, and leaves the expanded state behind", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    await model.show("browser");
    model.toggleFull();
    expect(model.full).toBe(true);
    model.toggle("browser");
    expect([model.open, model.full]).toEqual([false, false]);
    stop();
  });

  it("writes the three approval summaries 0.8.26 writes", () => {
    const { model, stop } = started();
    expect(model.summary({ id: "r", name: "desktop_console_run", args: { command: "npm test", cwd: "/work" }, target: "/work", status: "pending", reviewJobs: [] }))
      .toBe("新建独立命令会话 · 非交互命令\n/work\n\nnpm test");
    expect(model.summary({ id: "r", name: "desktop_console_run", args: { command: "npm test" }, target: "", status: "pending", reviewJobs: [] }))
      .toContain("未选择目录");
    expect(model.summary({ id: "r", name: "desktop_console_stop", args: {}, target: "本机", status: "pending", reviewJobs: [{ id: "job-1", command: "sleep 9", cwd: "/work" }] }))
      .toBe("停止以下命令及桌面管理的子进程\njob-1\nPS /work> sleep 9");
    expect(model.summary({ id: "r", name: "desktop_console_status", args: {}, target: "本机", status: "pending", reviewJobs: [] }))
      .toContain("没有可读取的命令");
    expect(model.summary({ id: "r", name: "desktop_browser_click", args: { tabId: "browser-1", selector: "#go" }, target: "https://example.test/one", status: "pending", targetSummary: "前往", reviewJobs: [] }))
      .toBe('https://example.test/one\n前往\n{\n  "tabId": "browser-1",\n  "selector": "#go"\n}');
    // An unknown tool keeps its own name: that is when the raw name matters most.
    expect(model.label("desktop_browser_open")).toBe("打开网页");
    expect(model.label("desktop_future_tool")).toBe("desktop_future_tool");
    stop();
  });

  it("reports a refused action without losing the state it already had", async () => {
    const { bridge, model, stop } = started();
    bridge.push(state());
    bridge.failure = new Error("Error invoking remote method 'beings:tools-action': Error: 浏览器标签已关闭。");
    expect(await model.act({ action: "browser.close", value: "browser-1" })).toBe(false);
    // Redacted by the shell's own publicErrorMessage, prefix and all.
    expect(model.error).toBe("浏览器标签已关闭。");
    expect(model.state.browser.tabs).toHaveLength(1);
    stop();
  });
});
