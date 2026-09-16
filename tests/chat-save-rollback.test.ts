// `beings:save` rolls the saved connection back when a Portal takeover fails.
// Regression added 2026-09-16: the rollback used to change the store alone, and
// the conversation layer had already been pointed at the new Being by
// `verifyConnection` — so the settings said Being A while every message the user
// typed afterwards went to Being B with B's token. A failing takeover is an
// ordinary path (a runtime bundle that will not load, `background.enable`
// refused, `portal.start` timing out), which is what makes the desync ordinary
// too.
//
// Driven through the real `beings:save` handler on the real trusted-sender
// wrapper, the way tests/main-startup.test.ts drives it: everything below the
// handler — the settings file, the Portal takeover, the Being's `/api/status` —
// is replaced, because none of it is what is under test.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "../desktop/main/app/settings";
import { BackgroundPortal } from "../desktop/main/portal/background";
import { PortalTakeover } from "../desktop/main/portal/takeover";
import type { Connection } from "../desktop/main/chat/connection";
import type { SaveSettings } from "../desktop/shared/types";

const secret = (letter: string) => letter.repeat(64);
const being = (name: string, letter: string): Connection => ({
  endpoint: `https://echo.beings.town/${name}`, being: name, token: secret(letter),
  relaySecret: secret(letter), link: `https://echo.beings.town/${name}/?token=${secret(letter)}`,
});
const PREVIOUS = being("cz_being", "a");
// The address as saved, carrying the `api=` parameter `Connection` does not
// model. Rolling back has to restore this string, not a link rebuilt from parts.
const PREVIOUS_ADDRESS = `${PREVIOUS.link}&api=https://echo.beings.town/api-root/`;
const NEXT = being("other_being", "b");

const fixture = vi.hoisted(() => ({
  directory: "",
  startup: undefined as Promise<void> | undefined,
  /** Each Being the conversation layer was told to bind to, in order. */
  verified: [] as (string | null)[],
  cleared: 0,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, setName: vi.fn(), setAboutPanelOptions: vi.fn(), setPath: vi.fn(),
    getPath: () => fixture.directory, getAppPath: () => fixture.directory, getVersion: () => "0.9.0",
    requestSingleInstanceLock: () => true, quit: vi.fn(),
    whenReady: () => ({ then: (ready: () => Promise<void>) => (fixture.startup = Promise.resolve().then(ready)) }),
  });
  return { app, clipboard: {}, ipcMain: { handle: vi.fn() }, net: { fetch: vi.fn(), request: vi.fn(), isOnline: () => true },
    // The subsystem seam hands these to installDesktopExtensions (I0, 2026-09-16);
    // this test mocks that module out, so presence is all that is needed.
    WebContentsView: class {}, powerMonitor: { on: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() }, nativeTheme: {}, shell: {},
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  };
});
vi.mock("../desktop/main/app/tray", () => ({ installApplicationMenu: vi.fn(), createApplicationTray: () => ({ destroy: vi.fn() }) }));
vi.mock("../desktop/main/app/window", () => ({ createMainWindow: vi.fn() }));
// The Being answers `/api/status`; this test is about what happens afterwards.
vi.mock("../desktop/main/chat/ready", () => ({ verifyBeingConnection: vi.fn(async () => {}) }));
vi.mock("../desktop/main/extensions", () => ({
  installDesktopExtensions: () => ({
    chat: null, ready: Promise.resolve(),
    connectionVerified: (connection: Connection | null) => { fixture.verified.push(connection?.being ?? null); },
    connectionCleared: async () => { fixture.cleared++; },
    quitting: async () => {},
  }),
}));

const settings = (connectionLink: string): SaveSettings => ({
  connectionLink, workspace: fixture.directory, portalName: "being-desktop-test",
  portalBinary: path.join(fixture.directory, "heart-portal"),
  autoStart: false, allowExec: true, kitsEnabled: true, backgroundEnabled: false,
});

it("puts the conversation layer back on the previous Being when a failed takeover rolls the settings back", async () => {
  fixture.directory = await mkdtemp(path.join(os.tmpdir(), "chat-save-rollback-"));
  vi.stubEnv("BEING_DATA_DIR", undefined); vi.stubEnv("PORTAL_DESKTOP_USER_DATA", fixture.directory);
  vi.stubGlobal("MAIN_WINDOW_VITE_DEV_SERVER_URL", undefined);
  vi.stubGlobal("PORTAL_DESKTOP_UPDATE_REPOSITORY", "fixture/releases");
  const { ipcMain } = await import("electron");
  const { createMainWindow } = await import("../desktop/main/app/window");
  // A profile already connected to Being A, with no file behind it: `load` is
  // what a real profile's settings.json would have produced.
  vi.spyOn(SettingsStore.prototype, "load").mockImplementation(async function (this: SettingsStore) {
    this.connection = { ...PREVIOUS };
    (this as unknown as { address: string }).address = PREVIOUS_ADDRESS;
    this.settings = { ...this.settings, endpoint: PREVIOUS.endpoint, being: PREVIOUS.being, hasToken: true, workspace: fixture.directory };
  });
  const saved: string[] = [];
  vi.spyOn(SettingsStore.prototype, "save").mockImplementation(async function (this: SettingsStore, input: SaveSettings) {
    saved.push(input.connectionLink || "");
    if (!input.connectionLink) return;
    this.connection = input.connectionLink.includes(NEXT.being) ? { ...NEXT } : { ...PREVIOUS };
    (this as unknown as { address: string }).address = input.connectionLink;
  });
  vi.spyOn(SettingsStore.prototype, "reusePortalConfig").mockResolvedValue(undefined);
  vi.spyOn(BackgroundPortal.prototype, "discover").mockResolvedValue(undefined as never);
  // Everything up to here succeeded: the address was written, `/api/status`
  // answered, and the conversation layer is already bound to Being B.
  const takeover = vi.spyOn(PortalTakeover.prototype, "run").mockRejectedValue(new Error("Portal 启动失败"));
  vi.mocked(createMainWindow).mockImplementation(() => {
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn(), restore: vi.fn(),
      webContents: { isDestroyed: () => false, send: vi.fn(), mainFrame: { url: "beings://desktop/" } },
    });
    return { window, browser: { close: vi.fn() } } as never;
  });
  try {
    await import("../desktop/main/main");
    await fixture.startup;
    const window = vi.mocked(createMainWindow).mock.results[0].value.window;
    const request = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls);
    // Startup runs its own automatic takeover, which this mock also fails; the
    // client opens anyway with a notice. Only the manual save is under test.
    expect((await handlers.get("beings:snapshot")!(request as never)).settings.being).toBe(PREVIOUS.being);
    saved.length = 0; fixture.verified.length = 0; takeover.mockClear();
    await expect(handlers.get("beings:save")!(request as never, settings(NEXT.link))).rejects.toThrow("Portal 启动失败");
    expect(takeover).toHaveBeenCalledOnce();
    // The address is rolled back as the string that was stored, `api=` and all.
    expect(saved).toEqual([NEXT.link, PREVIOUS_ADDRESS]);
    // …and the conversation layer is told, or it keeps talking to Being B with
    // B's token while the settings say Being A.
    expect(fixture.verified).toEqual([NEXT.being, PREVIOUS.being]);
    expect(fixture.cleared).toBe(0);
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    // The startup notice is still being appended to logs/client-errors.log by
    // main.ts's own error log, which nothing here can await; retry the removal
    // rather than race it.
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});
