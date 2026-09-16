// The desktop tool bridge's IPC surface. New in the portal-desktop shell on
// 2026-09-16; channel semantics ported from BeingDesktop 0.8.26 src/main.cjs's
// `getDesktopTools` (line 1117), `desktopAction` (1136), `setBrowserView` (1137)
// and `readNativeText` (1104) — docs/interfaces.md §1.2「桌面工具、控制台与终端」,
// §1.3「主进程 → 渲染层推送」.
//
// Registration follows chat/ipc.ts: every channel goes through the `handle`
// wrapper main.ts supplies, so it inherits the sender check (main frame of the
// trusted shell URL only) and the quitting guard for free. None of these four is
// marked「串行」in docs/interfaces.md, and 0.8.26 runs none of them through its
// mutation queue, so none uses `exclusive`; none is marked「Town 包络」either, so
// all four throw rather than answering with an envelope.
//
// Arguments arrive from the renderer and are therefore untrusted. Validation
// here is structural — a plain object, no key outside the whitelist, values of
// the declared type, lengths capped — and stops there. The semantic rules and
// their measured Chinese messages belong to the modules that own them
// (`DesktopBrowser` refuses an address, `DesktopConsole` a command,
// `DesktopTools.decide` a request that is already gone), so restating them here
// would give the user two different sentences for one situation.
//
// BeingDesktop guards `desktopAction` with its own `exitStarted` check
// (「桌面端正在退出。」). The wrapper does it instead: every channel except
// `QUIT_ALLOWED` (desktop/main/app/ipc.ts) refuses once the client is quitting.
// DEVIATION: `beings:tools-browser-view` is NOT on that list, while the shell
// browser's `beings:browser-bounds` is, so a viewport update sent while the
// window is closing is refused rather than applied. The panel's layout call
// already swallows its own failures, and 0.8.26 had no guard on `setBrowserView`
// at all — see docs/migration/i2-tools.md「决定与偏差」.
import { IDLE_TOOLS_STATE } from '../../shared/tools-types';
import type {
  DesktopToolsBrowserState, DesktopToolsPane, DesktopToolsState,
} from '../../shared/tools-types';
import type { DesktopTools } from './desktop-tools';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface ToolsIpcOptions {
  handle: RegisterHandler;
  /** Resolved lazily: the tool bridge is disposed and rebuilt with the Being
   * binding, and it may be absent entirely when its own installation failed. */
  tools: () => DesktopTools | null;
  /** The system clipboard, from `SubsystemContext.electron`. `readText` is
   * awaited because Electron 44 declares it promise-shaped; a plain string
   * passes through `await` unchanged, so this is right either way. */
  clipboard: { readText(): Promise<string> | string };
  /** Why the tool bridge cannot run at all, when that is not simply "no Being
   * connected yet". Empty means nothing is wrong. */
  blocked?: () => string;
}

/** 0.8.26's `readNativeText`: `clipboard.readText().slice(0, 65536)`. */
const MAX_CLIPBOARD_READ = 65536;
/** `DesktopBrowser`'s own address ceiling (MAX_URL_LENGTH), applied one layer
 * earlier so an oversized string is refused before it is parsed. */
const MAX_URL_LENGTH = 8192;
/** `DesktopConsole` caps the command itself; this is the outer bound on what may
 * cross IPC at all, matching 0.8.26's `copyDesktopText` ceiling. */
const MAX_COMMAND_LENGTH = 1024 * 1024;

const ACTIONS = [
  'browser.new', 'browser.activate', 'browser.close', 'browser.navigate',
  'browser.back', 'browser.forward', 'browser.reload', 'browser.stop',
  'console.run', 'console.stop', 'console.clear',
  'link.connect', 'link.disconnect',
  'request.allow', 'request.deny',
] as const;
type ToolsActionName = (typeof ACTIONS)[number];

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

/** A plain object whose keys are all known. `Object.getPrototypeOf` is the check
 * rather than `typeof`: an object arriving with a `__proto__` or a class
 * prototype is refused outright instead of being walked. An unknown field is
 * refused too — it means the caller and this contract disagree, and guessing
 * which of the two is right is how a stale renderer silently loses a parameter. */
function fields(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`${what}参数无效。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${what}参数无效。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number, what: string): string {
  if (typeof value !== 'string' || value.length > limit) throw invalid(`${what}参数无效。`);
  return value;
}

/** An identifier the renderer read out of a snapshot and is handing back: a tab,
 * a console job or a pending request. Whether it still exists is the owning
 * module's answer, not this layer's. */
function identifier(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw invalid(`${what}参数无效。`);
  return value;
}

/** Checks one action's `value` and answers with what `DesktopTools.perform`
 * should receive. Returning rather than mutating keeps the shape the module sees
 * exactly the shape this function approved. */
function actionValue(action: ToolsActionName, value: unknown): unknown {
  switch (action) {
    case 'browser.new': {
      const options = fields(value, ['url', 'active'], '标签页');
      if (options.url !== undefined) text(options.url, MAX_URL_LENGTH, '标签页');
      if (options.active !== undefined && typeof options.active !== 'boolean') throw invalid('标签页参数无效。');
      // `undefined` and `{}` are not the same to DesktopBrowser.newTab: only an
      // absent argument takes its default. Preserve whichever the caller sent.
      return value === undefined || value === null ? undefined : options;
    }
    case 'browser.navigate': {
      const options = fields(value, ['id', 'url'], '网页地址');
      if (options.id !== undefined) identifier(options.id, '网页地址');
      if (options.url !== undefined) text(options.url, MAX_URL_LENGTH, '网页地址');
      return options;
    }
    // 0.8.26's toolbar sends no id for back/forward/reload/stop, and the browser
    // then acts on the active tab. `activate` and `close` always name one.
    case 'browser.activate':
    case 'browser.close':
      return identifier(value, '标签页');
    case 'browser.back':
    case 'browser.forward':
    case 'browser.reload':
    case 'browser.stop':
      return value === undefined || value === null ? undefined : identifier(value, '标签页');
    case 'console.run': {
      const options = fields(value, ['command', 'cwd'], '命令');
      if (options.command !== undefined) text(options.command, MAX_COMMAND_LENGTH, '命令');
      if (options.cwd !== undefined) text(options.cwd, MAX_COMMAND_LENGTH, '命令');
      return options;
    }
    case 'console.stop':
      return identifier(value, '命令');
    case 'console.clear':
      return value === undefined || value === null ? undefined : identifier(value, '命令');
    case 'link.connect':
    case 'link.disconnect':
      if (value !== undefined && value !== null) throw invalid('工具连接参数无效。');
      return undefined;
    case 'request.allow':
    case 'request.deny':
      return identifier(value, '待确认调用');
  }
}

export function registerToolsIpc({ handle, tools, clipboard, blocked }: ToolsIpcOptions) {
  const require = (): DesktopTools => {
    const current = tools();
    if (!current) throw new Error(blocked?.() || '桌面工具暂时不可用，请重启客户端后重试。');
    return current;
  };

  handle('beings:tools', (): DesktopToolsState => {
    const current = tools();
    // `snapshot()` reaches into the browser and the console, either of which can
    // be mid-teardown. An unreadable snapshot is not worth a refusal the panel
    // would have to render: answer with the idle shape, as if nothing is open.
    if (!current) return IDLE_TOOLS_STATE;
    try { return current.snapshot(); }
    catch { return IDLE_TOOLS_STATE; }
  });

  handle('beings:tools-action', async (action: unknown, value: unknown): Promise<DesktopToolsState> => {
    if (typeof action !== 'string' || !ACTIONS.includes(action as ToolsActionName)) throw invalid('未知桌面工具操作。');
    const name = action as ToolsActionName;
    return await require().perform(name, actionValue(name, value));
  });

  handle('beings:tools-browser-view', (input: unknown): DesktopToolsBrowserState => {
    const viewport = fields(input, ['visible', 'bounds'], '浏览器显示');
    if (typeof viewport.visible !== 'boolean') throw invalid('浏览器显示参数无效。');
    if (viewport.bounds !== undefined) {
      const bounds = fields(viewport.bounds, ['x', 'y', 'width', 'height'], '浏览器显示');
      for (const key of ['x', 'y', 'width', 'height']) {
        const item = bounds[key];
        if (typeof item !== 'number' || !Number.isFinite(item)) throw invalid('浏览器显示参数无效。');
      }
    }
    // Ranges, flooring and the "keep the last rectangle while hiding" rule are
    // DesktopBrowser.setViewport's, ported with its own messages.
    return require().browser.setViewport(viewport);
  });

  handle('beings:clipboard-read', async (): Promise<string> => {
    const value = await clipboard.readText();
    return typeof value === 'string' ? value.slice(0, MAX_CLIPBOARD_READ) : '';
  });
}

/** The one push, given the window to send on. Kept beside the handlers so the
 * channel name lives in one file (`beings:tools-state`). */
export interface ToolsPushTarget { send(channel: string, payload: unknown): void }

export function toolsPush(target: () => ToolsPushTarget | null) {
  return {
    state: (payload: DesktopToolsState) => { target()?.send('beings:tools-state', payload); },
    /** BeingDesktop opens the panel by evaluating `window.beingTools.show(mode)`
     * in the renderer (src/main.cjs lines 1701, 1708). There is no such back
     * channel here, so the same intent is a push and the panel opens itself. */
    reveal: (pane: DesktopToolsPane) => { target()?.send('beings:tools-reveal', pane); },
  };
}
