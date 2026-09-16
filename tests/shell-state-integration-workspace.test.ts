// Choosing a project moves the working directory the desktop tools start from;
// 2026-09-16 (IM).
//
// The channel and the profile write are covered by tests/shell-state-ipc.test.ts
// against a real `SettingsStore`. What THIS file is about is the other half —
// that the choice reaches the consumers — because that is the half
// docs/migration/i6-shell-state.md §9.5 left open: I6 shipped without
// `beings:sidebar-project-select` on the grounds that nothing could be switched,
// and I2/I3 then landed `DesktopTools({getWorkspace})`,
// `DesktopConsole({getWorkspace})` and the terminal, all three of which read
// `Settings.projectWorkspace`.
//
// So: install the ledger and the tool bridge together, choose a folder, and look
// at what the bridge says its workspace is.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSubsystems } from "../desktop/main/extensions";
import { installShellStateSubsystem } from "../desktop/main/subsystems/shell-state";
import { installToolsSubsystem } from "../desktop/main/subsystems/tools";
import { installToolBrowserSubsystem } from "../desktop/main/subsystems/tool-browser";
import type { DesktopExtensionsContext } from "../desktop/main/extensions";
import type { DesktopToolsState } from "../desktop/shared/tools-types";
import type { Settings } from "../desktop/shared/types";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const PROJECT = process.platform === "win32" ? "C:\\Users\\me\\Work" : "/Users/me/Work";
const OTHER = process.platform === "win32" ? "C:\\Users\\me\\Other" : "/Users/me/Other";

/* The Electron surface `DesktopBrowser` validates, and nothing more. */
class FakeView {
  webContents = {
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} },
    on: () => {}, removeListener: () => {}, setWindowOpenHandler: () => {},
    loadURL: () => {}, getURL: () => "", isLoading: () => false, isDestroyed: () => false,
    reload: () => {}, stop: () => {}, close: () => {},
    capturePage: async () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize() { return this; }, toPNG: () => Buffer.alloc(0) }),
    executeJavaScriptInIsolatedWorld: async () => ({}),
  };
  setBounds() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
  setVisible() {} setBackgroundColor() {}
}
class FakeSession {
  webRequest = { onBeforeRequest: () => {} };
  setPermissionRequestHandler() {} setPermissionCheckHandler() {} setDevicePermissionHandler() {}
  on() { return this; } removeListener() { return this; }
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "beings-workspace-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pushes: { channel: string; payload: unknown }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } },
    getContentSize: () => [1400, 900],
  };
  // The live `SettingsStore` shape the extensions context is handed in production:
  // `settings` is one mutable object every subsystem reads through, and
  // `saveExtra` merges into the same record `extras` answers with.
  let extras: Record<string, unknown> = {};
  const settings = { workspace: "/portal/workspace", projectWorkspace: "" } as unknown as Settings;
  const context: DesktopExtensionsContext = {
    handle: (channel, callback) => { handlers.set(channel, callback); },
    exclusive: operation => operation(),
    window: () => window as never,
    store: {
      connection: null,
      // A saved address so the ledger has a bucket; the tool bridge parses the
      // same string for its link identity.
      connectionAddress: "https://echo.beings.town/cz_being/?token=" + "a".repeat(64),
      settings,
      get extras() { return extras; },
      saveExtra: async patch => { extras = { ...extras, ...patch }; },
    },
    secretStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    electron: {
      WebContentsView: FakeView,
      session: { fromPartition: () => new FakeSession() as never },
      net: { fetch, request: null, isOnline: () => true },
      clipboard: { readText: async () => "", writeText: async () => {} },
      shell: { openPath: async () => "", openExternal: async () => {} },
    },
    userData: directory,
    desktopId: "11111111-1111-4111-8111-111111111111",
    clientVersion: "0.9.0",
    fetchImpl: fetch,
    onError: (scope, error) => { errors.push({ scope, error }); },
  };
  const extensions = installSubsystems(context, [installToolBrowserSubsystem, installToolsSubsystem, installShellStateSubsystem]);
  cleanups.push(() => extensions.quitting());
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    handlers, pushes, errors, settle, settings,
    saved: () => extras,
    call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
  };
}

describe("choosing a project folder", () => {
  it("moves the workspace the tool bridge and its console report", async () => {
    const f = await fixture();
    // Before anything is chosen the bridge falls back to the Portal's directory,
    // which is 0.8.26's `state.workspace.path` when no project has been picked.
    expect(((await f.call("beings:tools")) as DesktopToolsState).workspace).toBe("/portal/workspace");

    await f.call("beings:sidebar-project-add", PROJECT);
    await f.call("beings:sidebar-project-select", PROJECT);

    // THE POINT OF THE WHOLE CHANNEL.
    expect(f.settings.projectWorkspace).toBe(PROJECT);
    expect(((await f.call("beings:tools")) as DesktopToolsState).workspace).toBe(PROJECT);
    // 0.8.26's `desktopTools?.changed()`: nothing else would push the new
    // directory to the console pane's「在 X 运行」line.
    await f.settle();
    const pushed = f.pushes.filter(push => push.channel === "beings:tools-state").at(-1)!.payload as DesktopToolsState;
    expect(pushed.workspace).toBe(PROJECT);
    // And it is on the profile, under BeingDesktop's own top-level key.
    expect(f.saved().workspace).toBe(PROJECT);
    expect(f.errors).toEqual([]);
  });

  it("switches again, and refuses a folder that is not on the list", async () => {
    const f = await fixture();
    await f.call("beings:sidebar-project-add", PROJECT);
    await f.call("beings:sidebar-project-add", OTHER);
    await f.call("beings:sidebar-project-select", PROJECT);
    await f.call("beings:sidebar-project-select", OTHER);
    expect(((await f.call("beings:tools")) as DesktopToolsState).workspace).toBe(OTHER);

    await expect(f.call("beings:sidebar-project-select", "/never-added")).rejects.toThrow("项目不存在，请重新选择文件夹。");
    // The refusal changes nothing: the previous choice still stands.
    expect(f.settings.projectWorkspace).toBe(OTHER);
    expect(((await f.call("beings:tools")) as DesktopToolsState).workspace).toBe(OTHER);
    expect(f.errors).toEqual([]);
  });
});
