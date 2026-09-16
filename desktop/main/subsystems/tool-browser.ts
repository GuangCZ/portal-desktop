// The Being-operable tool browser, as a subsystem; 2026-09-16.
//
// Assembly mirrors BeingDesktop 0.8.26 src/desktop-tools.cjs's constructor, which
// is where `DesktopBrowser` was built: `new Browser({WebContentsView, session,
// getWindow, onChange})`. The three Electron touch points arrive through
// `ctx.electron` instead of from `boot()`, and this subsystem — not the tool
// bridge — owns the instance.
//
// WHY IT OWNS IT (integration plan §5.6, and a deviation from §3.2 recorded in
// docs/migration/i3-terminal-browser.md D1): the browser is a visible surface
// with a panel, a partition and a rectangle on screen, and all three exist
// whether or not a Being is connected. The tool bridge consumes it —
// `registry.get('tool-browser')?.browser` — rather than constructing a second
// one; two instances would fight over the same window's `contentView` and share
// one partition.
//
// The partition is the security boundary: `BROWSER_PARTITION`
// ('persist:being-desktop-browser-v1') is not the shell browser's
// 'persist:beings-browser'. A Being can read and act on every page in this
// browser, so it must never see a session the user signed into by hand.
import { DesktopBrowser } from '../tools/browser/browser';
import { registerToolBrowserIpc, toolBrowserPush } from '../tools/browser/ipc';
import type { BrowserHostWindow, BrowserSessionFactory, BrowserViewConstructor } from '../tools/browser/host';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ToolBrowserSubsystem extends DesktopSubsystem {
  /** The live browser, or null when this process has no Electron to build it
   * with. The tool bridge reaches it through the registry, and so do tests. */
  readonly browser: DesktopBrowser | null;
}

declare module './types' { interface SubsystemMap { 'tool-browser': ToolBrowserSubsystem } }

export function installToolBrowserSubsystem(ctx: SubsystemContext): ToolBrowserSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  const push = toolBrowserPush(() => ({ send: ctx.push }));

  let closed = false;
  let blocked = '';
  let browser: DesktopBrowser | null = null;
  // `ElectronBindings` declares these two as `unknown` on purpose: giving them
  // real types would force every test that builds a context to produce a real
  // Electron class (subsystems/types.ts). This is the cast that costs — one
  // place, one comment — and `tests/architecture.test.ts` forbids this directory
  // from importing electron directly, so `tools/browser/electron-host.ts` (which
  // does) stays out of the graph.
  const View = ctx.electron.WebContentsView as BrowserViewConstructor | null;
  const session = ctx.electron.session as BrowserSessionFactory | null;
  if (typeof View !== 'function' || typeof session?.fromPartition !== 'function') {
    blocked = '内置浏览器在当前运行环境不可用。';
  } else {
    try {
      browser = new DesktopBrowser({
        WebContentsView: View,
        session,
        getWindow: () => ctx.window() as unknown as BrowserHostWindow | null,
        onChange: snapshot => push.state(snapshot),
      });
    } catch (error) {
      // The constructor validates its four dependencies and locks the partition
      // down (permissions, downloads, the protocol gate). A failure means the
      // sandbox could not be established, so refusing is the only safe answer.
      blocked = '内置浏览器暂时无法使用，请重启客户端后重试。';
      report('tool-browser-construct', error);
    }
  }

  registerToolBrowserIpc({ handle: ctx.handle, browser: () => browser, blocked: () => blocked });

  return {
    key: 'tool-browser',
    get browser() { return browser; },
    async quitting() {
      if (closed) return;
      closed = true;
      // Synchronous, and never throws: it detaches the view, closes every tab's
      // webContents and releases the partition's handlers.
      try { browser?.destroy(); }
      catch (error) { report('tool-browser-destroy', error); }
    },
  };
}
