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

function bounds(value: unknown): { x: number; y: number; width: number; height: number } {
  const rect = fields(value, ['x', 'y', 'width', 'height'], '浏览器显示');
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = rect[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) throw invalid('浏览器显示参数无效。');
  }
  return rect as { x: number; y: number; width: number; height: number };
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
      case 'new': {
        const options = fields(value, ['url', 'active'], '标签页');
        if (options.url !== undefined && typeof options.url !== 'string') throw invalid('标签页参数无效。');
        if (options.active !== undefined && typeof options.active !== 'boolean') throw invalid('标签页参数无效。');
        return state(current.newTab(options));
      }
      case 'activate': return state(current.activateTab(tabId(value)));
      case 'close': return state(current.closeTab(tabId(value)));
      case 'navigate': {
        const options = fields(value, ['id', 'url'], '网址');
        if (typeof options.url !== 'string') throw invalid('请输入完整网址，例如 https://example.com。');
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
    if (typeof options.visible !== 'boolean') throw invalid('浏览器显示参数无效。');
    return state(required().setViewport({
      visible: options.visible,
      ...(options.bounds === undefined ? {} : { bounds: bounds(options.bounds) }),
    }));
  });
}

/** The one push, given the window to send on. */
export interface ToolBrowserPushTarget { send(channel: string, payload: unknown): void }

export function toolBrowserPush(target: () => ToolBrowserPushTarget | null) {
  return {
    state: (payload: ToolBrowserState) => { target()?.send('beings:tool-browser-state', payload); },
  };
}
