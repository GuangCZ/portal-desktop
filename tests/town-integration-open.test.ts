// Where `beings:town-open` puts a Town page; 2026-09-16 (IM).
//
// BeingDesktop 0.8.26: `handle('openTownPage', id => browserLinks().open(
// townPageUrl(id)))` — src/main.cjs:1252. THE PAGE OPENS IN THE TOOL BROWSER, in a
// tab beside the conversation, and the panel comes forward. That matters beyond
// taste: the Being can read and act on a page in that browser, which is the whole
// reason a Town link is followed there rather than handed to the system browser
// and lost.
//
// I1 shipped `shell.openExternal` because the tool bridge was not in its worktree,
// and recorded it as a deviation (docs/migration/i1-town.md 遗留 2). This file
// pins the deviation closed, and pins the fallback that replaces it: a build with
// no tool bridge at all still opens the link somewhere.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSubsystems } from "../desktop/main/extensions";
import { installTownSubsystem } from "../desktop/main/subsystems/town";
import { installToolsSubsystem } from "../desktop/main/subsystems/tools";
import { installToolBrowserSubsystem } from "../desktop/main/subsystems/tool-browser";
import type { DesktopExtensionsContext } from "../desktop/main/extensions";
import type { SubsystemInstaller } from "../desktop/main/subsystems/types";
import type { DesktopToolsState } from "../desktop/shared/tools-types";
import type { Settings } from "../desktop/shared/types";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/* The Electron surface `DesktopBrowser` validates, and nothing more. */
class FakeView {
  webContents = {
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    on: () => {}, removeListener: () => {}, setWindowOpenHandler: () => {},
    loadURL: (url: string) => { this.url = url; }, getURL: () => this.url,
    isLoading: () => false, isDestroyed: () => false, reload: () => {}, stop: () => {}, close: () => {},
    capturePage: async () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize() { return this; }, toPNG: () => Buffer.alloc(0) }),
    executeJavaScriptInIsolatedWorld: async () => ({}),
  };
  url = "";
  setBounds() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
  setVisible() {} setBackgroundColor() {}
}
class FakeSession {
  webRequest = { onBeforeRequest: () => {} };
  setPermissionRequestHandler() {} setPermissionCheckHandler() {} setDevicePermissionHandler() {}
  on() { return this; } removeListener() { return this; }
}

interface Options { withTools?: boolean }

async function fixture({ withTools = true }: Options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beings-town-open-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const opened: string[] = [];
  const pushes: { channel: string; payload: unknown }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } },
    getContentSize: () => [1400, 900],
  };
  const secretStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const context: DesktopExtensionsContext = {
    handle: (channel, callback) => { handlers.set(channel, callback); },
    exclusive: operation => operation(),
    window: () => window as never,
    store: {
      connection: null, connectionAddress: "",
      settings: { workspace: directory, projectWorkspace: "" } as unknown as Settings,
      extras: {}, saveExtra: async () => {},
    },
    secretStorage,
    electron: {
      WebContentsView: FakeView,
      session: { fromPartition: () => new FakeSession() as never },
      net: { fetch, request: null, isOnline: () => true },
      clipboard: { readText: async () => "", writeText: async () => {} },
      shell: { openPath: async () => "", openExternal: async (target: string) => { opened.push(target); } },
      safeStorage: secretStorage,
    },
    userData: directory,
    desktopId: "11111111-1111-4111-8111-111111111111",
    clientVersion: "0.9.0",
    // Nothing in these cases reaches Town's HTTP surface; a fetch that did would
    // be a bug in the case, not a missing route.
    fetchImpl: (async () => { throw new Error("unexpected network call"); }) as unknown as typeof fetch,
    onError: (scope, error) => { errors.push({ scope, error }); },
  };
  const installers: SubsystemInstaller[] = withTools
    ? [installToolBrowserSubsystem, installToolsSubsystem, installTownSubsystem]
    : [installTownSubsystem];
  const extensions = installSubsystems(context, installers);
  cleanups.push(() => extensions.quitting());
  return {
    extensions, handlers, opened, pushes, errors,
    call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
  };
}

describe("beings:town-open", () => {
  it("opens the page in the tool browser and brings the panel forward", async () => {
    const f = await fixture();
    await f.call("beings:town-open", "/embers/story-7");

    // Not the system browser.
    expect(f.opened).toEqual([]);
    // A tab in the Being-operable browser, at the Town origin.
    const state = (await f.call("beings:tools")) as DesktopToolsState;
    expect(state.browser.tabs.map(tab => tab.url)).toEqual(["https://beings.town/embers/story-7"]);
    expect(state.browser.activeTabId).toBe(state.browser.tabs[0].id);
    // `browserLinks().open` ends in `showBrowser()`: state first, then the reveal
    // (src/main.cjs lines 601-604).
    const channels = f.pushes.map(push => push.channel);
    expect(channels).toContain("beings:tools-state");
    expect(channels.indexOf("beings:tools-reveal")).toBeGreaterThan(channels.indexOf("beings:tools-state"));
    expect(f.pushes.find(push => push.channel === "beings:tools-reveal")?.payload).toBe("browser");
    expect(f.errors).toEqual([]);
  });

  it("keeps the route allow-list exactly as it was, on either path", async () => {
    for (const withTools of [true, false]) {
      const f = await fixture({ withTools });
      for (const route of ["/api/messages", "https://elsewhere.example/", "/embers/../api/messages", 7, "", null])
        await expect(f.call("beings:town-open", route)).rejects.toThrow("不支持的 Town 链接。");
      expect(f.opened).toEqual([]);
      if (withTools) expect(((await f.call("beings:tools")) as DesktopToolsState).browser.tabs).toEqual([]);
    }
  });

  it("falls back to the system browser only when there is no tool bridge", async () => {
    const f = await fixture({ withTools: false });
    await f.call("beings:town-open", "/scrolls/s_42");
    expect(f.opened).toEqual(["https://beings.town/scrolls/s_42"]);
    expect(f.errors).toEqual([]);
  });
});
