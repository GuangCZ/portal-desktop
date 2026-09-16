// Who owns the DesktopBrowser once the tool bridge and the tool browser are both
// installed; 2026-09-16 (IM).
//
// docs/migration/i3-terminal-browser.md D1 called this out as a real defect, not
// merge noise: the tool-browser subsystem builds one `DesktopBrowser` and the tool
// bridge used to build a second one inside `DesktopTools`. Two instances attach
// their own `WebContentsView` to the SAME window's `contentView`, and both hold
// `persist:being-desktop-browser-v1`, so `_syncView()` on one detaches the other's
// page and a Being reads whichever happened to attach last.
//
// The fix is an injection point that is resolved lazily, so this file installs the
// two subsystems in BOTH orders: `INSTALLERS` order carries no meaning (see
// docs/migration/i0-seams.md §A), and resolving at construction time is exactly
// the bug — the registry is still empty then, and the fallback builds instance #2.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSubsystems } from "../desktop/main/extensions";
import { installToolsSubsystem } from "../desktop/main/subsystems/tools";
import { installToolBrowserSubsystem } from "../desktop/main/subsystems/tool-browser";
import type { DesktopExtensionsContext } from "../desktop/main/extensions";
import type { SubsystemInstaller } from "../desktop/main/subsystems/types";
import type { DesktopToolsState } from "../desktop/shared/tools-types";
import type { Settings } from "../desktop/shared/types";

const DESKTOP_ID = "11111111-1111-4111-8111-111111111111";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/* -------------------------------------------------------------------------- */
/* The electron touchpoints DesktopBrowser validates, and nothing more.        */
/* -------------------------------------------------------------------------- */

class FakeView {
  static created: FakeView[] = [];
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  url = "";
  webContents = {
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    on: () => {},
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
  contentView = {
    addChildView: (view: unknown) => { this.children.push(view); },
    removeChildView: (view: unknown) => { this.children = this.children.filter(item => item !== view); },
  };
  webContents = { isDestroyed: () => this.destroyed, send: (channel: string, payload: unknown) => { this.sent.push({ channel, payload }); } };
  sent: { channel: string; payload: unknown }[] = [];
  isDestroyed() { return this.destroyed; }
  getContentSize() { return [1400, 900]; }
}

/** Keeps the installed instances, which `DesktopExtensions` deliberately does not
 * expose. The wrapper keeps the installer's own `name`, because a failure is
 * reported as `subsystem-install:<name>`. */
function capturing(installers: readonly SubsystemInstaller[], into: Map<string, any>): SubsystemInstaller[] {
  return installers.map(install => {
    const wrapper: SubsystemInstaller = ctx => {
      const subsystem = install(ctx);
      into.set(String(subsystem.key), subsystem);
      return subsystem;
    };
    Object.defineProperty(wrapper, "name", { value: install.name });
    return wrapper;
  });
}

async function fixture(installers: readonly SubsystemInstaller[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beings-browser-ownership-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const built = new Map<string, any>();
  FakeView.created = [];
  FakeSession.partitions = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const errors: { scope: string; error: unknown }[] = [];
  const window = new FakeWindow();
  const context: DesktopExtensionsContext = {
    handle: (channel, callback) => { handlers.set(channel, callback); },
    exclusive: operation => operation(),
    window: () => window as never,
    store: {
      connection: null,
      connectionAddress: "",
      settings: { workspace: "/tmp/ownership-workspace", projectWorkspace: "" } as unknown as Settings,
      extras: {},
      saveExtra: async () => {},
    },
    secretStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
    electron: {
      WebContentsView: FakeView,
      session: { fromPartition: (partition: string) => { FakeSession.partitions.push(partition); return new FakeSession() as never; } },
      net: { fetch, request: null, isOnline: () => true },
      clipboard: { readText: async () => "", writeText: async () => {} },
      shell: { openPath: async () => "", openExternal: async () => {} },
    },
    userData: directory,
    desktopId: DESKTOP_ID,
    clientVersion: "0.9.0",
    fetchImpl: fetch,
    onError: (scope, error) => { errors.push({ scope, error }); },
  };
  const extensions = installSubsystems(context, capturing(installers, built));
  cleanups.push(() => extensions.quitting());
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    extensions, handlers, errors, window, settle, built,
    call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
  };
}

/** Both orders, because the order `INSTALLERS` happens to be in is not a contract
 * and the merge that produced it reordered nothing deliberately. */
const ORDERS: { name: string; installers: readonly SubsystemInstaller[] }[] = [
  { name: "the tool browser first", installers: [installToolBrowserSubsystem, installToolsSubsystem] },
  { name: "the tool bridge first", installers: [installToolsSubsystem, installToolBrowserSubsystem] },
];

describe("the tool browser has exactly one owner", () => {
  for (const { name, installers } of ORDERS) {
    it(`builds one browser and shares it with the bridge, installing ${name}`, async () => {
      const f = await fixture(installers);
      // One partition acquisition is one `new DesktopBrowser(...)`: the
      // constructor's last act is `session.fromPartition(BROWSER_PARTITION)`, and
      // nothing else in either subsystem touches `fromPartition`.
      expect(FakeSession.partitions).toEqual(["persist:being-desktop-browser-v1"]);

      // Reading the bridge's snapshot is what used to force the second build.
      const state = (await f.call("beings:tools")) as DesktopToolsState;
      expect(state.browser.tabs).toEqual([]);
      expect(FakeSession.partitions).toEqual(["persist:being-desktop-browser-v1"]);

      // THE IDENTITY, which is the actual contract: the bridge's `browser` is the
      // tool-browser subsystem's instance, not a copy and not a peer of it.
      expect(f.built.get("tools").tools.browser).toBe(f.built.get("tool-browser").browser);
      expect(FakeView.created).toHaveLength(0); // No tab yet, so no view yet.

      // And a tab opened through the panel's channel is in the bridge's snapshot.
      const viaPanel = (await f.call("beings:tool-browser-action", "new", { url: "https://example.test/one" })) as { tabs: { id: string }[] };
      expect(viaPanel.tabs).toHaveLength(1);
      const after = (await f.call("beings:tools")) as DesktopToolsState;
      expect(after.browser.tabs.map(tab => tab.id)).toEqual(viaPanel.tabs.map(tab => tab.id));
      // One tab, one view: two browsers would have produced two.
      expect(FakeView.created).toHaveLength(1);
      expect(FakeSession.partitions).toEqual(["persist:being-desktop-browser-v1"]);
      expect(f.errors).toEqual([]);
    });

    it(`fans a browser change out to both state channels, installing ${name}`, async () => {
      const f = await fixture(installers);
      await f.call("beings:tools"); // Resolve the bridge's view of the browser.
      f.window.sent.length = 0;
      await f.call("beings:tool-browser-action", "new", { url: "https://example.test/two" });
      await f.settle();
      const channels = f.window.sent.map(entry => entry.channel);
      // The panel's own push, which the tool-browser subsystem sends directly…
      expect(channels).toContain("beings:tool-browser-state");
      // …and 0.8.26's `onChange: () => this.changed()`, which is what puts the new
      // tab into the bridge's snapshot (docs/migration/i2-tools.md IPC table).
      expect(channels).toContain("beings:tools-state");
      const toolsPush = f.window.sent.find(entry => entry.channel === "beings:tools-state")!.payload as DesktopToolsState;
      expect(toolsPush.browser.tabs).toHaveLength(1);
      expect(f.errors).toEqual([]);
    });
  }

  // THE SECOND HALF OF「ONE OWNER」, and a defect the first half introduced.
  // Converging the two panels onto one `DesktopBrowser` converged their two
  // rectangles as well: `beings:tools-browser-view` and
  // `beings:tool-browser-viewport` wrote `visible`/`bounds` on the same object, so
  // merely opening the tool panel on its CONSOLE tab took the page off the
  // standalone tool-browser panel — `ToolsModel.browserView` computes `visible` as
  // `open && mode === 'browser' && …` (desktop/renderer/tools/models/tools.ts) and
  // `ToolsBrowserBar` measures on every layout whether or not its pane is the one
  // on screen (its `<section>` is `hidden`, not unmounted). The other panel never
  // asked for the page back either: its own dedupe cache still believed it was
  // visible. Measured on the packaged build before the fix
  // (docs/migration/im-integration.md §4.9).
  it("lets each panel speak only for its own rectangle", async () => {
    const f = await fixture([installToolBrowserSubsystem, installToolsSubsystem]);
    const opened = (await f.call("beings:tool-browser-action", "new", { url: "https://example.test/page" })) as { tabs: { id: string }[] };
    expect(opened.tabs).toHaveLength(1);
    const view = () => FakeView.created[0];
    const attached = () => f.window.children.length;

    // 1. The standalone panel puts the page on screen.
    const shown = (await f.call("beings:tool-browser-viewport", { visible: true, bounds: { x: 100, y: 100, width: 400, height: 300 } })) as { visible: boolean };
    expect(shown.visible).toBe(true);
    expect(attached()).toBe(1);
    expect(view().bounds).toEqual({ x: 100, y: 100, width: 400, height: 300 });

    // 2. The tool panel opens on its console tab and reports「不在我这儿」. This
    //    is the exact message the regression was made of.
    const afterConsole = (await f.call("beings:tools-browser-view", { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } })) as { visible: boolean };
    expect(attached()).toBe(1);
    expect(view().visible).toBe(true);
    expect(view().bounds).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(afterConsole.visible).toBe(true);
    expect(((await f.call("beings:tool-browser")) as { visible: boolean }).visible).toBe(true);

    // 3. The tool panel switches to its browser pane: it asked for the view, so
    //    it gets it, at its own rectangle.
    await f.call("beings:tools-browser-view", { visible: true, bounds: { x: 10, y: 10, width: 800, height: 600 } });
    expect(attached()).toBe(1);
    expect(view().bounds).toEqual({ x: 10, y: 10, width: 800, height: 600 });

    // 4. And symmetrically: the standalone panel closing does not take the page
    //    off the tool panel.
    await f.call("beings:tool-browser-viewport", { visible: false });
    expect(attached()).toBe(1);
    expect(view().bounds).toEqual({ x: 10, y: 10, width: 800, height: 600 });

    // 5. Only when NOBODY is showing it does the view come off the window.
    const gone = (await f.call("beings:tools-browser-view", { visible: false, bounds: { x: 10, y: 10, width: 800, height: 600 } })) as { visible: boolean };
    expect(attached()).toBe(0);
    expect(gone.visible).toBe(false);
    expect(((await f.call("beings:tool-browser")) as { visible: boolean }).visible).toBe(false);
    expect(f.errors).toEqual([]);
  });

  it("falls back to building its own when the tool browser is not installed", async () => {
    const f = await fixture([installToolsSubsystem]);
    // Nothing is built until something needs it — the resolver may still answer.
    expect(FakeSession.partitions).toEqual([]);
    const state = (await f.call("beings:tools")) as DesktopToolsState;
    expect(state.browser.tabs).toEqual([]);
    expect(FakeSession.partitions).toEqual(["persist:being-desktop-browser-v1"]);
    // The fallback is the bridge's own, so the bridge still tears it down.
    expect(f.errors).toEqual([]);
  });

  it("refuses rather than half-working when there is no Electron to build a browser with", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "beings-browser-ownership-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const errors: { scope: string; error: unknown }[] = [];
    const extensions = installSubsystems({
      handle: (channel, callback) => { handlers.set(channel, callback); },
      exclusive: operation => operation(),
      window: () => null,
      store: { connection: null, connectionAddress: "", settings: {} as Settings, extras: {}, saveExtra: async () => {} },
      secretStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
      userData: directory,
      desktopId: DESKTOP_ID,
      onError: (scope, error) => { errors.push({ scope, error }); },
    }, [installToolBrowserSubsystem, installToolsSubsystem]);
    cleanups.push(() => extensions.quitting());
    // 0.8.26 built the browser in the constructor, so a refused Electron façade
    // meant no bridge at all. The injection point made the build lazy; the check
    // moved to the subsystem so the refusal still arrives as a refusal and never
    // as a throw out of `changed()`'s setImmediate.
    await expect(handlers.get("beings:tools-action")!("browser.new", {})).rejects.toThrow("桌面工具暂时不可用");
    expect(errors).toEqual([]);
  });
});
