// The tool browser subsystem and its IPC surface; 2026-09-16 (I3).
//
// `DesktopBrowser` itself is pinned by tests/tools-browser-browser.test.ts (the
// port of BeingDesktop 0.8.26 test/desktop-browser.test.cjs). What this file
// pins is the part that only exists in this shell:
//
//  · THE PARTITION BOUNDARY (integration plan §5.6). Two browsers now live in one
//    window — portal-desktop's single-tab `ClientBrowser` on
//    'persist:beings-browser', which the user drives by hand, and this one on
//    'persist:being-desktop-browser-v1', whose pages a Being may read and act on.
//    Sharing a partition would hand a Being every session the user signed into.
//    That is a security boundary, so it is asserted here rather than assumed.
//  · the subsystem installing at all without Electron, because
//    `ElectronBindings.WebContentsView` and `.session` are `unknown` and absent
//    outside a running application (subsystems/types.ts).
//  · the channel layer: the actions, the viewport, and what it refuses.
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { installSubsystems } from "../desktop/main/extensions";
import { installToolBrowserSubsystem } from "../desktop/main/subsystems/tool-browser";
import type { ToolBrowserSubsystem } from "../desktop/main/subsystems/tool-browser";
import { BROWSER_PARTITION } from "../desktop/main/tools/browser/browser";
import { TOOL_BROWSER_UNAVAILABLE } from "../desktop/main/tools/browser/ipc";
import { publicErrorMessage } from "../desktop/shared/errors";
import type {
  BrowserBounds, BrowserNativeImage, BrowserRequestListener, BrowserSession,
  BrowserView, BrowserWebContents, BrowserWebPreferences, BrowserWindowOpenDetails, BrowserWindowOpenResponse,
} from "../desktop/main/tools/browser/host";
import type { Settings } from "../desktop/shared/types";
import type { ToolBrowserState } from "../desktop/shared/desktop-types";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL = "beings://desktop/";
const CHANNELS = ["beings:tool-browser", "beings:tool-browser-action", "beings:tool-browser-viewport"];

// The same fake Electron surface tests/tools-browser-browser.test.ts drives,
// trimmed to what the channel layer reaches.
class Contents extends EventEmitter implements BrowserWebContents {
  url = "";
  loading = false;
  destroyed = false;
  closed?: { waitForBeforeUnload: boolean };
  popup!: (details: BrowserWindowOpenDetails) => BrowserWindowOpenResponse;
  capturePage!: (rect: BrowserBounds, options: { stayHidden: boolean; stayAwake: boolean }) => Promise<BrowserNativeImage>;
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} };
  loadURL(url: string) { this.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false }); this.url = url; this.loading = true; this.emit("did-start-loading"); return Promise.resolve(); }
  finish(title = "Fixture page") { this.loading = false; this.emit("did-navigate"); this.emit("page-title-updated", {}, title); this.emit("did-stop-loading"); }
  getURL() { return this.url; }
  executeJavaScriptInIsolatedWorld: BrowserWebContents["executeJavaScriptInIsolatedWorld"] = () => Promise.resolve(true);
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler(handler: (details: BrowserWindowOpenDetails) => BrowserWindowOpenResponse) { this.popup = handler; }
  stop() { this.loading = false; this.emit("did-stop-loading"); }
  reload() { this.loading = true; }
  close(options: { waitForBeforeUnload: boolean }) { this.closed = options; this.destroyed = true; }
}

class Session extends EventEmitter implements BrowserSession {
  webRequest = { before: null as BrowserRequestListener | null, onBeforeRequest(handler: BrowserRequestListener | null) { this.before = handler; } };
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
}

function fixture({ electron = true }: { electron?: boolean } = {}) {
  const views: { bounds?: BrowserBounds; visible?: boolean; webContents: Contents }[] = [];
  const partitions: string[] = [];
  const attached: BrowserView[] = [];
  const shellSession = new Session();
  class View implements BrowserView {
    webContents = new Contents();
    bounds?: BrowserBounds;
    visible?: boolean;
    constructor(readonly options: { webPreferences: BrowserWebPreferences }) { views.push(this); }
    setBounds(bounds: BrowserBounds) { this.bounds = bounds; }
    getBounds() { return this.bounds || { x: 0, y: 0, width: 0, height: 0 }; }
    setVisible(visible: boolean) { this.visible = visible; }
    setBackgroundColor() {}
  }
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  let destroyed = false;
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = {
    isDestroyed: () => destroyed, webContents,
    getContentSize: () => [1000, 700],
    contentView: { addChildView: (view: BrowserView) => { attached.push(view); }, removeChildView: (view: BrowserView) => { attached.splice(attached.indexOf(view), 1); } },
  };
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => false, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  let subsystem!: ToolBrowserSubsystem;
  const extensions = installSubsystems({
    handle, exclusive: operation => operation(),
    window: () => window,
    store: { connection: null, connectionAddress: "", settings: {} as Settings },
    secretStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    userData: dirname, desktopId: "11111111-1111-4111-8111-111111111111",
    ...(electron ? { electron: { WebContentsView: View, session: { fromPartition: (name: string) => { partitions.push(name); return shellSession; } } } } : {}),
    onError: (scope, error) => { errors.push({ scope, error }); },
  }, [context => (subsystem = installToolBrowserSubsystem(context))]);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args) as Promise<any>;
  return {
    extensions, subsystem, handlers, pushes, errors, views, partitions, attached, call,
    act: (action: string, value?: unknown) => call("beings:tool-browser-action", action, value) as Promise<ToolBrowserState>,
    open: async (url: string) => {
      const state = await call("beings:tool-browser-action", "new", { url }) as ToolBrowserState;
      views.at(-1)!.webContents.finish();
      return state;
    },
    cleanup: async () => { await extensions.quitting(); },
  };
}

describe("tool browser subsystem", () => {
  it("runs on its own partition, never the shell browser's", async () => {
    const f = fixture();
    try {
      expect(f.partitions).toEqual([BROWSER_PARTITION]);
      expect(BROWSER_PARTITION).toBe("persist:being-desktop-browser-v1");
      // The shell browser's, which a Being must never reach: main/browser/browser.ts
      // calls `session.fromPartition('persist:beings-browser')` and this unit
      // changes no line of it.
      expect(BROWSER_PARTITION).not.toBe("persist:beings-browser");
    } finally { await f.cleanup(); }
  });

  it("registers the documented channel set and answers an empty snapshot before a tab exists", async () => {
    const f = fixture();
    try {
      expect([...f.handlers.keys()]).toEqual(CHANNELS);
      expect(await f.call("beings:tool-browser")).toEqual({ tabs: [], activeTabId: null, visible: false });
    } finally { await f.cleanup(); }
  });

  it("installs without Electron and refuses instead of pretending", async () => {
    const f = fixture({ electron: false });
    try {
      expect(f.subsystem.browser).toBeNull();
      // Installing must still succeed: one unavailable subsystem cannot stop the
      // client opening (subsystems/types.ts). It is still FILED — a panel that
      // says「不可用」and a log that says nothing leaves this fault undiagnosable
      // (IM, 2026-09-16).
      expect(f.errors.map(entry => entry.scope)).toEqual(["tool-browser-construct"]);
      expect(String((f.errors[0].error as Error).message)).toContain("Electron 浏览器门面不可用");
      expect(await f.call("beings:tool-browser")).toEqual({ tabs: [], activeTabId: null, visible: false });
      await expect(f.act("new", {})).rejects.toThrow(TOOL_BROWSER_UNAVAILABLE);
      await expect(f.call("beings:tool-browser-viewport", { visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } })).rejects.toThrow(TOOL_BROWSER_UNAVAILABLE);
    } finally { await f.cleanup(); }
  });

  it("drives tabs and the viewport, and pushes every change to the window", async () => {
    const f = fixture();
    try {
      const opened = await f.open("example.com/docs");
      expect(opened.tabs).toHaveLength(1);
      // `normalizeBrowserUrl`, not the shell browser's `browserURL`: a bare host
      // becomes https, and text that is not an address is refused outright.
      expect(opened.tabs[0].url).toBe("https://example.com/docs");
      const id = opened.tabs[0].id;
      expect((await f.act("activate", id)).activeTabId).toBe(id);

      // The panel's placeholder, in window coordinates. Only a visible, non-empty
      // rectangle attaches the native view to the window.
      const shown = await f.call("beings:tool-browser-viewport", { visible: true, bounds: { x: 420, y: 96, width: 500, height: 600 } }) as ToolBrowserState;
      expect(shown.visible).toBe(true);
      expect(f.attached).toHaveLength(1);
      expect(f.views[0].bounds).toEqual({ x: 420, y: 96, width: 500, height: 600 });
      await f.call("beings:tool-browser-viewport", { visible: false });
      expect(f.attached).toEqual([]);

      // `onChange` reaches the renderer: the tab strip is driven by the push, not
      // by polling.
      expect(f.pushes.map(push => push.channel)).toContain("beings:tool-browser-state");
      expect((await f.act("close", id)).tabs).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("refuses an unknown action and input the renderer should never send", async () => {
    const f = fixture();
    try {
      const { tabs } = await f.open("https://example.com/");
      await expect(f.act("print", tabs[0].id)).rejects.toThrow("未知浏览器操作。");
      // The whitelist is this layer's: an unknown field means the renderer and the
      // contract disagree.
      await expect(f.act("new", { url: "https://example.com/", target: "_blank" })).rejects.toThrow("标签页参数无效。");
      await expect(f.act("new", JSON.parse('{"__proto__": {"polluted": true}}'))).rejects.toThrow("标签页参数无效。");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // Everything else is `DesktopBrowser`'s, and its sentences reach the
      // renderer intact rather than being restated one layer up.
      await expect(f.act("new", { url: 7 })).rejects.toThrow("请输入有效的网页地址。");
      await expect(f.act("navigate", { url: "search some text" })).rejects.toThrow("请输入 HTTP 或 HTTPS 地址，例如 localhost:3000。");
      await expect(f.act("navigate", { url: "javascript:alert(1)" })).rejects.toThrow("请输入 HTTP 或 HTTPS 地址，例如 localhost:3000。");
      await expect(f.act("activate", 7)).rejects.toThrow("标签页不存在。");
      await expect(f.call("beings:tool-browser-viewport", { visible: true, bounds: { x: 0, y: 0, width: "500", height: 600 } })).rejects.toThrow("浏览器显示区域无效。");
      await expect(f.call("beings:tool-browser-viewport", { bounds: { x: 0, y: 0, width: 5, height: 5 } })).rejects.toThrow("浏览器显示选项无效。");
      await expect(f.call("beings:tool-browser-viewport", { visible: true, bounds: { x: -1, y: 0, width: 5, height: 5 } })).rejects.toThrow("浏览器显示区域无效。");
    } finally { await f.cleanup(); }
  });

  it("quitting closes every tab and releases the partition", async () => {
    const f = fixture();
    try {
      await f.open("https://example.com/");
      await f.open("https://example.org/");
      await f.extensions.quitting();
      expect(f.views.map(view => view.webContents.closed)).toEqual([{ waitForBeforeUnload: false }, { waitForBeforeUnload: false }]);
      expect(f.subsystem.browser!.destroyed).toBe(true);
      // Idempotent, and a destroyed browser refuses rather than throwing something
      // the renderer cannot read.
      await expect(f.extensions.quitting()).resolves.toBeUndefined();
      await expect(f.act("new", {})).rejects.toThrow("浏览器已经关闭。");
    } finally { await f.cleanup(); }
  });
});
