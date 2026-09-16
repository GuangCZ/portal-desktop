// Ported from BeingDesktop 0.8.26 test/desktop-browser.test.cjs on 2026-09-16.
// The original drives fake Electron objects, so every case survives the move to
// vitest unchanged; only the assertion style differs. Fixtures are copied
// verbatim. Reading digest: docs/migration/u5-terminal-browser.md.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DesktopBrowser, BROWSER_PARTITION, MAX_BROWSER_TABS, normalizeBrowserUrl } from "../desktop/main/tools/browser/browser";
import type {
  BrowserBounds,
  BrowserHostWindow,
  BrowserNativeImage,
  BrowserRequestListener,
  BrowserSession,
  BrowserView,
  BrowserWebContents,
  BrowserWebPreferences,
  BrowserWindowOpenDetails,
  BrowserWindowOpenResponse,
} from "../desktop/main/tools/browser/host";
import type { BrowserSnapshot } from "../desktop/main/tools/browser/types";

class Contents extends EventEmitter implements BrowserWebContents {
  url = "";
  history: string[] = [];
  index = -1;
  loading = false;
  destroyed = false;
  pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  popup!: (details: BrowserWindowOpenDetails) => BrowserWindowOpenResponse;
  stopped?: boolean;
  reloaded?: boolean;
  closeOptions?: { waitForBeforeUnload: boolean };
  // Declared, never assigned by default: the BeingDesktop fixture only attaches
  // capturePage inside the screenshot case, and no other case reaches it.
  capturePage!: (rect: BrowserBounds, options: { stayHidden: boolean; stayAwake: boolean }) => Promise<BrowserNativeImage>;
  navigationHistory = {
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index < this.history.length - 1,
    goBack: () => { this.url = this.history[--this.index]; this.emit("did-navigate"); },
    goForward: () => { this.url = this.history[++this.index]; this.emit("did-navigate"); },
  };
  loadURL(url: string) {
    this.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
    this.url = url;
    this.history.splice(this.index + 1);
    this.history.push(url);
    this.index++;
    this.loading = true;
    this.emit("did-start-loading");
    return new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  finish(title = "Fixture page") {
    this.loading = false;
    this.emit("did-navigate");
    this.emit("page-title-updated", {}, title);
    this.emit("did-stop-loading");
    this.pending.at(-1)?.resolve();
  }
  getURL() { return this.url; }
  executeJavaScriptInIsolatedWorld: BrowserWebContents["executeJavaScriptInIsolatedWorld"] = () => Promise.resolve(true);
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler(handler: (details: BrowserWindowOpenDetails) => BrowserWindowOpenResponse) { this.popup = handler; }
  stop() { this.stopped = true; this.loading = false; this.emit("did-stop-loading"); }
  reload() { this.reloaded = true; this.loading = true; }
  close(options: { waitForBeforeUnload: boolean }) { this.closeOptions = options; this.destroyed = true; }
}

class Session extends EventEmitter implements BrowserSession {
  requestPermission!: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void;
  checkPermission!: () => boolean;
  devicePermission!: () => boolean;
  webRequest = {
    before: null as BrowserRequestListener | null,
    onBeforeRequest(handler: BrowserRequestListener | null) { this.before = handler; },
  };
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void) { this.requestPermission = handler; }
  setPermissionCheckHandler(handler: () => boolean) { this.checkPermission = handler; }
  setDevicePermissionHandler(handler: () => boolean) { this.devicePermission = handler; }
}

interface FakeView extends BrowserView {
  options: { webPreferences: BrowserWebPreferences };
  webContents: Contents;
  bounds?: BrowserBounds;
  visible?: boolean;
  color?: string;
}

function fixture() {
  const views: FakeView[] = [], changes: BrowserSnapshot[] = [], attached: BrowserView[] = [];
  const ses = new Session();
  const window: BrowserHostWindow = {
    isDestroyed: () => false,
    getContentSize: () => [1000, 700],
    contentView: {
      addChildView(view: BrowserView) { attached.push(view); },
      removeChildView(view: BrowserView) { attached.splice(attached.indexOf(view), 1); },
    },
  };
  class View implements FakeView {
    options: { webPreferences: BrowserWebPreferences };
    webContents: Contents;
    bounds?: BrowserBounds;
    visible?: boolean;
    color?: string;
    constructor(options: { webPreferences: BrowserWebPreferences }) { this.options = options; this.webContents = new Contents(); views.push(this); }
    setBounds(bounds: BrowserBounds) { this.bounds = bounds; }
    getBounds() { return this.bounds || { x: 0, y: 0, width: 0, height: 0 }; }
    setVisible(visible: boolean) { this.visible = visible; }
    setBackgroundColor(color: string) { this.color = color; }
  }
  const browser = new DesktopBrowser({ WebContentsView: View, session: { fromPartition(name: string) { expect(name).toBe(BROWSER_PARTITION); return ses; } }, getWindow: () => window, onChange: value => changes.push(value) });
  return { browser, views, changes, attached, ses, window };
}

interface FakeEvent {
  url: string;
  isMainFrame: boolean;
  prevented: boolean;
  preventDefault(): void;
}

function event(url: string, isMainFrame = true): FakeEvent {
  return { url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } };
}

describe("desktop browser", () => {
  it("browser address input supports real web URLs and local developer previews", () => {
    expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserUrl(" https://example.com:443/a?q=1 ")).toBe("https://example.com/a?q=1");
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("127.0.0.1:8317/management.html")).toBe("http://127.0.0.1:8317/management.html");
    expect(normalizeBrowserUrl("[::1]:8080")).toBe("http://[::1]:8080/");
    expect(normalizeBrowserUrl("http://192.168.1.20:8080")).toBe("http://192.168.1.20:8080/");
  });

  it("address parser rejects executable and privileged schemes, credentials and malformed values", () => {
    for (const value of ["javascript:alert(1)", "file:///C:/secret", "data:text/html,hello", "being://app/", "about:blank", "chrome://settings", "devtools://a", "//evil.test/", "https://user:password@example.com", "https://user@example.com", "https:example.com", "example.com\n.evil.test", "search some text", "localhost:999999", "", null, {}, 4, "x".repeat(9000)]) {
      expect(() => normalizeBrowserUrl(value), String(value)).toThrow();
    }
  });

  it("browser creates an isolated sandboxed page without privileged preload or homepage requests", () => {
    const { browser, views } = fixture();
    const state = browser.newTab();
    expect(state.tabs.length).toBe(1);
    expect(state.tabs[0].url).toBe("");
    expect(views[0].webContents.pending.length).toBe(0);
    const preferences = views[0].options.webPreferences as unknown as Record<string, unknown>;
    for (const key of ["sandbox", "contextIsolation", "webSecurity"]) expect(preferences[key]).toBe(true);
    for (const key of ["nodeIntegration", "nodeIntegrationInSubFrames", "nodeIntegrationInWorker", "webviewTag", "navigateOnDragDrop", "allowRunningInsecureContent"]) expect(preferences[key]).toBe(false);
    expect(Object.hasOwn(preferences, "preload")).toBe(false);
    browser.destroy();
  });

  it("viewport attaches only the active page and clips dimensions to the host window", () => {
    const { browser, views, attached } = fixture();
    browser.setViewport({ visible: true, bounds: { x: 200.9, y: 100.9, width: 9999, height: 9999 } });
    const first = browser.newTab({ url: "https://example.com" }).activeTabId;
    const second = browser.newTab({ url: "https://example.org" }).activeTabId;
    expect(attached).toEqual([views[1]]);
    expect(views[0].visible).toBe(false);
    expect(views[1].bounds).toEqual({ x: 200, y: 100, width: 800, height: 600 });
    browser.activateTab(first);
    expect(attached).toEqual([views[0]]);
    browser.setViewport({ visible: false });
    expect(attached).toEqual([]);
    browser.closeTab(second);
    expect(views[1].webContents.destroyed).toBe(true);
    browser.closeTab(first);
    expect(browser.snapshot().tabs).toEqual([]);
    expect(browser.snapshot().activeTabId).toBe(null);
    browser.destroy();
  });

  it("history, loading, title, reload and stop reflect the active browser tab", () => {
    const { browser, views } = fixture();
    browser.newTab({ url: "example.com" });
    const wc = views[0].webContents;
    expect(browser.snapshot().tabs[0].isLoading).toBe(true);
    wc.finish("First page");
    expect(browser.snapshot().tabs[0].title).toBe("First page");
    expect(browser.snapshot().tabs[0].isLoading).toBe(false);
    browser.navigate({ url: "example.org" });
    wc.finish("Second page");
    expect(browser.snapshot().tabs[0].canGoBack).toBe(true);
    browser.goBack();
    expect(browser.snapshot().tabs[0].url).toBe("https://example.com/");
    expect(browser.snapshot().tabs[0].canGoForward).toBe(true);
    browser.goForward();
    expect(browser.snapshot().tabs[0].url).toBe("https://example.org/");
    browser.reload();
    expect(wc.reloaded).toBe(true);
    browser.stop();
    expect(wc.stopped).toBe(true);
    expect(browser.snapshot().tabs[0].isLoading).toBe(false);
    browser.destroy();
  });

  it("all frame navigations and redirects enforce the protocol boundary", () => {
    const { browser, views, ses } = fixture();
    browser.newTab({ url: "https://example.com" });
    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
      const blocked = event("being://app/index.html");
      views[0].webContents.emit(name, blocked);
      expect(blocked.prevented, name).toBe(true);
      const allowed = event("http://localhost:3000");
      views[0].webContents.emit(name, allowed);
      expect(allowed.prevented, name).toBe(false);
    }
    const frame = event("file:///C:/secret", false);
    views[0].webContents.emit("will-frame-navigate", frame);
    expect(frame.prevented).toBe(true);
    let intercepted: { cancel: boolean } | undefined;
    ses.webRequest.before!({ url: "being://app/", resourceType: "mainFrame" }, value => { intercepted = value; });
    expect(intercepted).toEqual({ cancel: true });
    ses.webRequest.before!({ url: "https://example.com/script.js", resourceType: "script" }, value => { intercepted = value; });
    expect(intercepted).toEqual({ cancel: false });
    const attach = event("https://example.org");
    views[0].webContents.emit("will-attach-webview", attach);
    expect(attach.prevented).toBe(true);
    browser.destroy();
  });

  it("website popups become safe internal tabs and never native windows", async () => {
    const { browser, views } = fixture();
    const first = browser.newTab({ url: "https://example.com" }).activeTabId;
    expect(views[0].webContents.popup({ url: "https://example.org", disposition: "background-tab" })).toEqual({ action: "deny" });
    await Promise.resolve();
    expect(browser.snapshot().tabs.length).toBe(2);
    expect(browser.snapshot().activeTabId).toBe(first);
    expect(views[0].webContents.popup({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(views[0].webContents.popup({ url: "file:///C:/secret" })).toEqual({ action: "deny" });
    await Promise.resolve();
    expect(browser.snapshot().tabs.length).toBe(2);
    browser.destroy();
  });

  it("browser pages cannot request native permissions, devices or downloads", () => {
    const { browser, views, ses } = fixture();
    browser.newTab({ url: "https://example.com" });
    let granted: boolean | undefined;
    ses.requestPermission(views[0].webContents, "media", value => { granted = value; });
    expect(granted).toBe(false);
    expect(ses.checkPermission()).toBe(false);
    expect(ses.devicePermission()).toBe(false);
    const download = event("https://example.com/file");
    ses.emit("will-download", download, {}, views[0].webContents);
    expect(download.prevented).toBe(true);
    expect(browser.snapshot().tabs[0].notice).toMatch(/下载/);
    expect(browser.snapshot().tabs[0].error).toBe("");
    browser.destroy();
  });

  it("UI snapshots redact credentials and contain no contents objects or page body", () => {
    const { browser, views } = fixture();
    browser.newTab({ url: "https://example.com/?token=private-fixture&query=visible&api_key=secret-fixture#access_token=hidden-fixture" });
    views[0].webContents.finish("Public title");
    const value = JSON.stringify(browser.snapshot());
    expect(value.includes("private-fixture")).toBe(false);
    expect(value.includes("secret-fixture")).toBe(false);
    expect(value.includes("hidden-fixture")).toBe(false);
    expect(value).toMatch(/query=visible/);
    expect(Object.keys(browser.snapshot().tabs[0])).toEqual(["id", "title", "url", "isLoading", "canGoBack", "canGoForward", "error", "notice", "revision"]);
    expect(views[0].webContents.getURL()).toMatch(/token=private-fixture/);
    views[0].webContents.finish("https://example.com/?token=private-fixture");
    expect(JSON.stringify(browser.snapshot()).includes("private-fixture")).toBe(false);
    browser.destroy();
  });

  it("stale page failures and closed-tab failures cannot overwrite a newer navigation", async () => {
    const { browser, views } = fixture();
    browser.newTab({ url: "https://example.com/old" });
    const wc = views[0].webContents, old = wc.pending[0];
    browser.navigate({ url: "https://example.com/new" });
    wc.finish();
    old.reject(new Error("secret-fixture in an obsolete network error"));
    await Promise.resolve();
    expect(browser.snapshot().tabs[0].error).toBe("");
    browser.navigate({ url: "https://example.com/closed" });
    const pending = wc.pending.at(-1)!;
    browser.closeTab(browser.snapshot().activeTabId);
    pending.reject(new Error("secret-fixture after closing"));
    await Promise.resolve();
    expect(browser.snapshot().tabs).toEqual([]);
    browser.destroy();
  });

  it("failed main frames show a sanitized error while aborted loads and subframes stay quiet", () => {
    const { browser, views } = fixture();
    browser.newTab({ url: "https://example.com" });
    const wc = views[0].webContents;
    wc.emit("did-fail-load", {}, -3, "secret-fixture", "https://example.com", true);
    expect(browser.snapshot().tabs[0].error).toBe("");
    wc.emit("did-fail-load", {}, -105, "secret-fixture", "https://example.com", false);
    expect(browser.snapshot().tabs[0].error).toBe("");
    wc.emit("did-fail-load", {}, -105, "secret-fixture", "https://example.com", true);
    expect(browser.snapshot().tabs[0].error).toMatch(/找不到/);
    expect(JSON.stringify(browser.snapshot()).includes("secret-fixture")).toBe(false);
    browser.destroy();
  });

  it("invalid commands and viewport values leave the browser unchanged", () => {
    const { browser } = fixture();
    browser.newTab();
    const before = browser.snapshot();
    for (const operation of [
      () => browser.newTab({ active: "yes" }),
      () => browser.newTab(null),
      () => browser.activateTab({}),
      () => browser.closeTab("missing"),
      () => browser.navigate({ url: "file:///secret" }),
      () => browser.setViewport({ visible: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } }),
      () => browser.setViewport({ visible: true, bounds: { x: 0, y: -1, width: 10, height: 10 } }),
      () => browser.setViewport({ visible: true, bounds: { x: 0, y: 0, width: NaN, height: 10 } }),
      () => browser.setViewport({ visible: true, bounds: { x: 0, y: 0, width: 100001, height: 10 } }),
    ]) expect(operation).toThrow();
    expect(browser.snapshot()).toEqual(before);
    browser.destroy();
  });

  it("tab limits and disposal release all page resources without beforeunload prompts", () => {
    const { browser, views, ses } = fixture();
    for (let i = 0; i < MAX_BROWSER_TABS; i++) browser.newTab();
    expect(() => browser.newTab()).toThrow(/最多/);
    browser.destroy();
    browser.destroy();
    expect(ses.listenerCount("will-download")).toBe(0);
    expect(ses.webRequest.before).toBe(null);
    for (const view of views) {
      expect(view.webContents.destroyed).toBe(true);
      expect(view.webContents.closeOptions).toEqual({ waitForBeforeUnload: false });
      expect(view.webContents.eventNames().length).toBe(0);
    }
    expect(() => browser.newTab()).toThrow(/已经关闭/);
  });

  it("structured operations reject stale revisions, loading pages and invalid parameters before execution", async () => {
    const { browser, views } = fixture();
    browser.newTab({ url: "https://example.com" });
    const first = browser.snapshot().tabs[0];
    expect(first.revision).toBe(1);
    await expect(browser.readPage(first.id, first.revision)).rejects.toThrow(/加载/);
    views[0].webContents.finish();
    browser.tabs.get(first.id)!.documentToken = "synthetic-fixture-context";
    browser.navigate({ url: "https://example.org" });
    expect(browser.snapshot().tabs[0].revision).toBe(2);
    await expect(browser.readPage(first.id, first.revision)).rejects.toThrow(/页面已变化/);
    await expect(browser.click({ id: first.id, selector: "#note", expectedRevision: 1 })).rejects.toThrow(/页面已变化/);
    await expect(browser.fill({ id: first.id, selector: "#note", text: "private-fixture", expectedRevision: 1 })).rejects.toThrow(/页面已变化/);
    await expect(browser.screenshot(first.id, 1)).rejects.toThrow(/页面已变化/);
    await expect(browser.click({ selector: "x".repeat(513) })).rejects.toThrow(/选择器/);
    await expect(browser.fill({ selector: "#note", text: "x".repeat(8001) })).rejects.toThrow(/8000/);
    await expect(browser.fill({ selector: "#note", text: 42 })).rejects.toThrow(/填写内容/);
    browser.destroy();
  });

  it("screenshots bound the native bitmap and discard an image captured across navigation", async () => {
    const { browser, views } = fixture();
    browser.setViewport({ visible: true, bounds: { x: 0, y: 0, width: 1000, height: 700 } });
    const first = browser.newTab({ url: "https://example.com" }).activeTabId as string;
    views[0].webContents.finish();
    browser.tabs.get(first)!.documentToken = "synthetic-fixture-context";
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const bitmap: (width: number, height: number) => BrowserNativeImage = (width, height) => ({ isEmpty: () => false, getSize: () => ({ width, height }), resize: ({ width: w, height: h }) => bitmap(w, h), toPNG: () => png });
    views[0].webContents.capturePage = async (_rect, options) => {
      expect(options.stayHidden).toBe(true);
      return bitmap(3200, 2000);
    };
    const capture = await browser.screenshot(first, 1);
    expect(capture.width).toBe(1600);
    expect(capture.height).toBe(1000);
    expect(capture.mimeType).toBe("image/png");
    expect(capture.data).toBe(png.toString("base64"));
    views[0].webContents.capturePage = async () => { browser.navigate({ id: first, url: "https://example.org" }); return bitmap(800, 600); };
    await expect(browser.screenshot(first, 1)).rejects.toThrow(/页面已变化/);
    browser.destroy();
  });

  it("blocked navigation, downloads and popups keep a committed page visible and usable", async () => {
    const { browser, views, ses, attached } = fixture();
    browser.setViewport({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    const id = browser.newTab({ url: "https://example.com" }).activeTabId as string;
    const wc = views[0].webContents;
    wc.finish();
    wc.emit("did-start-navigation", { url: "mailto:fixture@example.test", isMainFrame: true, isSameDocument: false });
    const blocked = event("mailto:fixture@example.test");
    wc.emit("will-navigate", blocked);
    await Promise.resolve();
    expect(blocked.prevented).toBe(true);
    expect(browser.snapshot().tabs[0].error).toBe("");
    expect(browser.snapshot().tabs[0].notice).toMatch(/已阻止/);
    expect(browser.tabs.get(id)!.documentToken).toBeTruthy();
    expect(attached).toEqual([views[0]]);
    expect(views[0].visible).toBe(true);
    const download = event("https://example.com/file");
    ses.emit("will-download", download, {}, wc);
    expect(browser.snapshot().tabs[0].error).toBe("");
    expect(browser.snapshot().tabs[0].notice).toMatch(/下载/);
    wc.popup({ url: "javascript:alert(1)" });
    expect(browser.snapshot().tabs[0].error).toBe("");
    expect(browser.snapshot().tabs[0].notice).toMatch(/弹出窗口/);
    expect(views[0].visible).toBe(true);
    browser.navigate({ id, url: "https://example.org" });
    expect(browser.snapshot().tabs[0].notice).toBe("");
    browser.destroy();
  });

  it("a blocked redirect with no committed page remains a fatal load error", () => {
    const { browser, views } = fixture();
    browser.newTab({ url: "https://example.com/redirect" });
    views[0].webContents.emit("will-redirect", event("being://app/index.html"));
    expect(browser.snapshot().tabs[0].error).toMatch(/已阻止/);
    expect(browser.snapshot().tabs[0].notice).toBe("");
    browser.destroy();
  });
});

// Added by the 2026-09-16 port, with no counterpart in BeingDesktop: the page
// function is shipped to the renderer through Function.prototype.toString(), so
// the TypeScript build must keep it serializable as valid standalone JavaScript.
describe("injected page function survives the TypeScript build", () => {
  it("serializes into parsable standalone JavaScript", async () => {
    const { browser, views } = fixture();
    const id = browser.newTab({ url: "https://example.com" }).activeTabId as string;
    views[0].webContents.finish();
    browser.tabs.get(id)!.documentToken = "synthetic-fixture-context";
    let injected = "";
    views[0].webContents.executeJavaScriptInIsolatedWorld = (world: number, scripts: { code: string }[]) => {
      expect(world).toBe(1004);
      injected = scripts[0].code;
      return Promise.resolve({ title: "t", text: "", elements: [], truncated: false });
    };
    await browser.readPage(id, 1);
    expect(injected.startsWith("(function pageOperation(")).toBe(true);
    expect(injected.includes("__beingBrowserDocument")).toBe(true);
    expect(injected.endsWith('("synthetic-fixture-context","read",{})')).toBe(true);
    expect(() => new Function(injected)).not.toThrow();
    browser.destroy();
  });
});
