// The desktop tool bridge's renderer-facing contract; 2026-09-16.
//
// Shapes ported from BeingDesktop 0.8.26: `DesktopTools.snapshot()`
// (src/desktop-tools.cjs) as docs/interfaces.md §1.2「桌面工具、控制台与终端」
// describes it, and the action vocabulary `desktopAction(action, value)` accepts.
// The main process asserts its IPC return types against these declarations
// (desktop/main/tools/ipc.ts), which is what keeps the two halves in step.
//
// These are DECLARATIONS of what the main process already produces, not a second
// model of it. Where a field's meaning is not obvious from its name, the comment
// says which measured behaviour it reports — a renderer that guesses at
// `reconnect.delayMs` or at `origin` shows the user something untrue.

/** One tab of the Being-facing tool browser (`DesktopBrowser.snapshot().tabs`).
 * `url` and `title` arrive redacted: the browser replaces credential-shaped query
 * parameters with `[redacted]` before they leave the main process. */
export interface DesktopToolsBrowserTab {
  id: string;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string;
  notice: string;
  /** Bumped on every committed navigation. A Being's call carries the revision it
   * read, and the bridge refuses the call when the page has moved on since. */
  revision: number;
}

export interface DesktopToolsBrowserState {
  tabs: DesktopToolsBrowserTab[];
  activeTabId: string | null;
  /** Whether the native view is currently attached to the window. The renderer
   * sets this through `browserView`, and reads it back to know what happened. */
  visible: boolean;
}

export type DesktopConsoleJobStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
export interface DesktopConsoleOutputChunk { stream: 'stdout' | 'stderr'; text: string }

export interface DesktopConsoleJob {
  id: string;
  command: string;
  cwd: string;
  status: DesktopConsoleJobStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  output: DesktopConsoleOutputChunk[];
  truncated: boolean;
  /** Who started it. `being` means it arrived over the tool bridge and was
   * approved here; `you` means the console's own run box. Only `being` jobs can
   * be read or stopped through the bridge. */
  origin?: 'you' | 'being';
}

export interface DesktopConsoleState {
  shell: string;
  limits: { maxConcurrent: number; maxOutputBytes: number; maxJobs: number };
  jobs: DesktopConsoleJob[];
}

export type DesktopToolLinkStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface DesktopToolLinkState {
  status: DesktopToolLinkStatus;
  error: string;
  lastCall: { name: string; status: 'pending' | 'completed' | 'failed' | 'cancelled'; at: number } | null;
  calls: number;
  /** Present only while a reconnection is scheduled. `delayMs` is the wait the
   * link actually set (2s doubling to a 60s ceiling), which the panel turns into
   *「…秒后自动重连。」— it is not a countdown and does not tick. */
  reconnect?: { attempt: number; delayMs: number };
  pending: { id: string; name: string; startedAt: number }[];
}

/** One console job a `desktop_console_status` / `desktop_console_stop` request
 * would read or stop, resolved at the moment the request was queued. The panel
 * shows them so「允许本次」is a decision about named commands, not about a verb. */
export interface DesktopToolsReviewJob { id: string; command: string; cwd: string }

export interface DesktopToolsRequest {
  id: string;
  /** The tool name, e.g. `desktop_browser_open`. */
  name: string;
  args: Record<string, unknown>;
  /** What the call would act on: a page address, a working directory, or 本机. */
  target: string;
  status: 'pending' | 'running';
  /** For a click or a fill, what the browser found under the selector before the
   * user was asked — the page's own words, redacted. */
  targetSummary?: string;
  reviewJobs: DesktopToolsReviewJob[];
}

/** The outcome of the last request that left the queue. The panel raises the
 * failure text once per id, so a refusal is visible even after the card is gone. */
export interface DesktopToolsRequestResult {
  id: string;
  status: 'completed' | 'failed';
  message: string;
}

export interface DesktopToolsState {
  browser: DesktopToolsBrowserState;
  console: DesktopConsoleState;
  link: DesktopToolLinkState;
  /** The workspace every console command starts in; empty when none is chosen. */
  workspace: string;
  requestResult: DesktopToolsRequestResult | null;
  requests: DesktopToolsRequest[];
}

/** The action vocabulary of `beings:tools-action`, ported verbatim from
 * `DesktopTools.perform` (src/desktop-tools.cjs). Split by the shape of `value`
 * so the preload bridge and the panel cannot pair a verb with the wrong payload. */
export type DesktopToolsAction =
  | { action: 'browser.new'; value?: { url?: string; active?: boolean } }
  | { action: 'browser.navigate'; value: { id?: string; url?: string } }
  | { action: 'browser.activate' | 'browser.close' | 'browser.back' | 'browser.forward' | 'browser.reload' | 'browser.stop'; value?: string }
  | { action: 'console.run'; value: { command: string; cwd?: string } }
  | { action: 'console.stop'; value: string }
  | { action: 'console.clear'; value?: string }
  | { action: 'link.connect' | 'link.disconnect' }
  | { action: 'request.allow' | 'request.deny'; value: string };

/** The visible area the native browser view is pinned to, in CSS pixels of the
 * renderer's own coordinate space. `visible` false detaches the view without
 * forgetting the rectangle, which is how the panel hides it behind a dialog. */
export interface DesktopToolsViewport {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DesktopToolsAPI {
  /** The current snapshot. Safe before anything is connected: it answers with the
   * idle shape rather than refusing. */
  state(): Promise<DesktopToolsState>;
  /** Perform one action and answer with the snapshot that resulted. */
  act(input: DesktopToolsAction): Promise<DesktopToolsState>;
  /** Pin the native browser view to a rectangle, or detach it. */
  browserView(viewport: DesktopToolsViewport): Promise<DesktopToolsBrowserState>;
  /** The system clipboard's text, truncated to 65536 characters as 0.8.26 does. */
  readText(): Promise<string>;
  onState(callback: (state: DesktopToolsState) => void): () => void;
}
