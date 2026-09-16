// What still answers while the client is quitting; 2026-09-16 (IM).
//
// `QUIT_ALLOWED` is a four-name list in desktop/main/app/ipc.ts and nothing else
// in the tree says which channels belong on it, so this file is where the rule
// is written down: A CHANNEL THAT ONLY MOVES OR RELEASES A NATIVE RECTANGLE HAS
// TO KEEP ANSWERING DURING A QUIT. The rectangle belongs to a `WebContentsView`
// that lives in the main process; the only way the renderer can let go of one is
// to send `visible:false`, and a panel unmounting during shutdown sends exactly
// that. Refusing it pins a page over the closing window and makes the renderer
// re-measure and re-send against a channel that will never answer — which is why
// I2 had to bound its retries (docs/migration/i2-tools.md「决定与偏差」8).
//
// BeingDesktop 0.8.26 guards none of these: `setBrowserView` (src/main.cjs:1137)
// has no `exitStarted` check at all.
import { describe, expect, it } from "vitest";
import { QUIT_ALLOWED, createTrustedHandle } from "../desktop/main/app/ipc";
import { registerToolsIpc } from "../desktop/main/tools/ipc";
import { registerToolBrowserIpc } from "../desktop/main/tools/browser/ipc";
import type { DesktopTools } from "../desktop/main/tools/desktop-tools";
import type { DesktopBrowser } from "../desktop/main/tools/browser/browser";

const SHELL_URL = "beings://desktop/";

/** The channels this shell registers that do nothing but place a rectangle. The
 * shell browser's own `beings:browser-bounds` is registered in main.ts, which is
 * not importable from a test, so it is named rather than driven. */
const GEOMETRY = ["beings:browser-bounds", "beings:tools-browser-view", "beings:tool-browser-viewport"];

function fixture() {
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const frame = { url: SHELL_URL };
  const window = { webContents: { mainFrame: frame } };
  let quitting = false;
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window,
    shellURL: () => SHELL_URL,
    quitting: () => quitting,
    recoveryBlocked: () => false,
    // `errorLog.report` returns the short redacted message; the real one logs.
    report: (_channel, error) => String((error as Error)?.message ?? error),
  });

  /** What each registrar was told, so a call that got through is visible. */
  const viewports: { where: string; value: unknown }[] = [];
  const browser = {
    snapshot: () => ({ tabs: [], activeTabId: null, visible: false }),
    setViewport: (value: unknown) => { viewports.push({ where: "tool-browser", value }); return { tabs: [], activeTabId: null, visible: false }; },
    newTab: () => ({ tabs: [], activeTabId: null, visible: false }),
  } as unknown as DesktopBrowser;
  const tools = {
    snapshot: () => ({ browser: { tabs: [], activeTabId: null, visible: false }, console: { jobs: [] }, link: { status: "disconnected" }, workspace: "", requestResult: null, requests: [] }),
    perform: async () => ({ browser: { tabs: [], activeTabId: null, visible: false }, console: { jobs: [] }, link: { status: "disconnected" }, workspace: "", requestResult: null, requests: [] }),
    browser: { setViewport: (value: unknown) => { viewports.push({ where: "tools", value }); return { tabs: [], activeTabId: null, visible: false }; } },
  } as unknown as DesktopTools;

  registerToolsIpc({ handle, tools: () => tools, clipboard: { readText: async () => "" } });
  registerToolBrowserIpc({ handle, browser: () => browser });

  return {
    handlers, viewports,
    quit: () => { quitting = true; },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: window.webContents, senderFrame: frame }, ...args),
  };
}

describe("the quitting guard", () => {
  it("lists exactly the geometry channels and diagnostics", () => {
    // Order is the reading order — the shell browser, the two tool surfaces, then
    // the one non-geometry exception.
    expect(QUIT_ALLOWED).toEqual([
      "beings:browser-bounds", "beings:tools-browser-view", "beings:tool-browser-viewport", "beings:diagnostics",
    ]);
    for (const channel of GEOMETRY) expect(QUIT_ALLOWED).toContain(channel);
  });

  it("lets a closing panel release its native view on both browser surfaces", async () => {
    const f = fixture();
    f.quit();
    // This is the unmount of a panel during shutdown, on each surface.
    await f.call("beings:tools-browser-view", { visible: false, bounds: { x: 0, y: 0, width: 640, height: 480 } });
    await f.call("beings:tool-browser-viewport", { visible: false });
    expect(f.viewports).toEqual([
      { where: "tools", value: { visible: false, bounds: { x: 0, y: 0, width: 640, height: 480 } } },
      { where: "tool-browser", value: { visible: false } },
    ]);
  });

  it("still refuses everything that could start work", async () => {
    const f = fixture();
    f.quit();
    for (const channel of ["beings:tools", "beings:tools-action", "beings:clipboard-read", "beings:tool-browser", "beings:tool-browser-action"]) {
      await expect(f.call(channel, "new", {})).rejects.toThrow("客户端正在退出，请稍候。");
    }
    expect(f.viewports).toEqual([]);
  });

  it("changes nothing before the quit starts", async () => {
    const f = fixture();
    await expect(f.call("beings:tools")).resolves.toMatchObject({ link: { status: "disconnected" } });
    await f.call("beings:tool-browser-viewport", { visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } });
    expect(f.viewports).toEqual([{ where: "tool-browser", value: { visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } } }]);
  });

  it("refuses an untrusted sender before it consults the list at all", async () => {
    const f = fixture();
    f.quit();
    const handler = f.handlers.get("beings:tool-browser-viewport")!;
    // A different frame, on an allowed channel, during a quit: the sender check
    // is first, and being on QUIT_ALLOWED never weakens it.
    await expect(handler({ sender: {}, senderFrame: { url: SHELL_URL } }, { visible: false })).rejects.toThrow("Untrusted IPC sender");
    expect(f.viewports).toEqual([]);
  });
});
