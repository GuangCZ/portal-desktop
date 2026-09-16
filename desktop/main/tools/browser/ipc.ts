// The tool browser's IPC surface. New in the portal-desktop shell on 2026-09-16;
// channel semantics ported from BeingDesktop 0.8.26 src/main.cjs's
// `getDesktopTools().browser`, `desktopAction('browser.*')` (line 1136) and
// `setBrowserView` (line 1137) — docs/interfaces.md §1.2「桌面工具、控制台与终端」.
//
// BeingDesktop carried the browser inside the tool bridge's one snapshot and one
// action channel. Here it has its own, for one reason: the browser is usable
// before the bridge exists, and the panel that hosts it must be able to report
// its rectangle from the first frame. The tool bridge's own `beings:tools-*`
// channels (integration plan §3.2) keep carrying the browser inside
// `DesktopTools.snapshot()`; both views read the same instance.
//
// This is NOT the shell browser. `beings:browser-*` belongs to portal-desktop's
// single-tab `ClientBrowser` (main/browser/), on partition
// `persist:beings-browser`. This one is `DesktopBrowser` on
// `persist:being-desktop-browser-v1` — a Being can read and act on its pages, so
// it must never see a session the user signed into by hand (integration plan §5.6).
//
// Every channel goes through main.ts's `handle` wrapper, inheriting the sender
// check and the quitting guard. Arguments are untrusted: structural whitelist
// checks here, and the measured limits — 16 tabs, the address grammar, the
// bounds — stay inside `DesktopBrowser`, which owns them.
import { normalizeBounds, VIEWPORT_SOURCES } from './browser';
import type { DesktopBrowser } from './browser';
import type { ToolBrowserState } from '../../../shared/tool-browser-types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface ToolBrowserIpcOptions {
  handle: RegisterHandler;
  /** Resolved lazily: the browser needs Electron's `WebContentsView` and
   * `session`, which a test context does not supply. */
  browser: () => DesktopBrowser | null;
  /** Why the browser cannot run at all. Empty means nothing is wrong. */
  blocked?: () => string;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

function fields(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!plain(value)) throw invalid(`${what}参数无效。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${what}参数无效。`);
  return value;
}

function tabId(value: unknown, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalid('标签页不存在。');
    return undefined;
  }
  if (typeof value !== 'string' || !value) throw invalid('标签页不存在。');
  return value;
}

export const TOOL_BROWSER_UNAVAILABLE = '内置浏览器在当前运行环境不可用。';

export function registerToolBrowserIpc({ handle, browser, blocked }: ToolBrowserIpcOptions) {
  const required = (): DesktopBrowser => {
    const current = browser();
    if (!current) throw new Error(blocked?.() || TOOL_BROWSER_UNAVAILABLE);
    return current;
  };
  const idle: ToolBrowserState = { tabs: [], activeTabId: null, visible: false };
  const state = (snapshot: unknown): ToolBrowserState => snapshot as ToolBrowserState;

  handle('beings:tool-browser', (): ToolBrowserState => state(browser()?.snapshot()) ?? idle);

  // One channel, eight actions, matching BeingDesktop's `browser.*` prefix under
  // `desktopAction`. Splitting them into one channel per verb would multiply the
  // preload surface without making any of them safer.
  handle('beings:tool-browser-action', (action: unknown, value: unknown): ToolBrowserState => {
    const current = required();
    switch (action) {
      // Types and grammar belong to `DesktopBrowser`: `newTab` refuses a
      // non-boolean `active` and hands `url` to `normalizeBrowserUrl`, whose
      // refusals name what a valid address looks like. Re-checking them here would
      // give the same input two different sentences depending on which layer spoke
      // first. Only the whitelist — which `DesktopBrowser` has no notion of — is
      // this layer's.
      case 'new': return state(current.newTab(fields(value, ['url', 'active'], '标签页')));
      case 'activate': return state(current.activateTab(tabId(value)));
      case 'close': return state(current.closeTab(tabId(value)));
      case 'navigate': {
        const options = fields(value, ['id', 'url'], '网址');
        return state(current.navigate({ id: tabId(options.id, false), url: options.url }));
      }
      case 'back': return state(current.goBack(tabId(value, false)));
      case 'forward': return state(current.goForward(tabId(value, false)));
      case 'reload': return state(current.reload(tabId(value, false)));
      case 'stop': return state(current.stop(tabId(value, false)));
      default: throw new Error('未知浏览器操作。');
    }
  });

  // Where the panel's placeholder is, in window coordinates. `visible:false`
  // without bounds keeps the last rectangle, which is what `DesktopBrowser`
  // expects when a panel is merely hidden rather than resized.
  handle('beings:tool-browser-viewport', (value: unknown): ToolBrowserState => {
    const options = fields(value, ['visible', 'bounds'], '浏览器显示');
    // TYPES, HERE, NOT ONLY INSIDE `setViewport`. The destroyed branch below
    // never reaches the browser, so a check that lives only there is skipped for
    // the whole of a quit — `{visible:'no'}` would then be accepted in silence.
    // These two lines are `setViewport`'s own first two, character for character
    // and branch for branch (including「visible:true with no bounds is invalid」),
    // so neither the refusals nor their measured messages can drift apart.
    if (typeof options.visible !== 'boolean') throw new TypeError('浏览器显示选项无效。');
    if (options.bounds !== undefined || options.visible) normalizeBounds(options.bounds);
    // This channel is on QUIT_ALLOWED, so the panel's last `visible:false` can
    // land after `tool-browser`'s `quitting()` destroyed the browser. There is
    // no rectangle left to move and nothing to report: answer idle rather than
    // throw「浏览器已经关闭。」into the error log on every quit. Only *destroyed*
    // is quiet — `required()` still refuses when there is no browser at all
    // (the Electron facade was rejected), and the argument is fully validated
    // above, so a malformed payload is still refused.
    const current = required();
    if (current.destroyed) return idle;
    // Named for the same reason the tool pane's channel is: one browser, two
    // panels, and each may only speak for its own rectangle (browser.ts
    //`viewports`).
    return state(current.setViewport(options, VIEWPORT_SOURCES.toolBrowserPanel));
  });
}

/** The one push, given the window to send on. */
export interface ToolBrowserPushTarget { send(channel: string, payload: unknown): void }

export function toolBrowserPush(target: () => ToolBrowserPushTarget | null) {
  return {
    state: (payload: ToolBrowserState) => { target()?.send('beings:tool-browser-state', payload); },
  };
}
