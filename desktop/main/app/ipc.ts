// The wrapper every `beings:` channel is registered through. Lifted out of
// main.ts on 2026-09-16 without a behaviour change, so the conversation channels
// can be tested against the wrapper production actually runs rather than a
// re-creation of it in a test file — the reason that matters is below.
//
// It does not import electron: `register` is `ipcMain.handle` bound by the
// caller, which is what lets a test drive it with a plain function.
//
// The last line is load-bearing for anything that needs to say *why* a call
// failed. Whatever a handler throws is replaced here by a new Error carrying
// only `errorLog.report(channel, error)` — a short, redacted string — so custom
// fields (`code`) do not survive, and Electron would strip them from an Error
// crossing IPC even if they did. A channel whose caller must branch on the kind
// of failure has to answer with data instead; see desktop/shared/chat-errors.ts.

/** The part of a `WebFrameMain` the sender check reads. Declared once so that
 * `senderFrame !== mainFrame` narrows the nullable side, exactly as it does in
 * electron's own types. */
export interface TrustedFrame { url: string }
/** The part of an `IpcMainInvokeEvent` the sender check reads. */
export interface TrustedInvokeEvent {
  sender: unknown;
  senderFrame: TrustedFrame | null;
}
/** The part of a `BrowserWindow` it compares against. */
export interface TrustedWindow {
  webContents: { mainFrame: TrustedFrame };
}

/** Channels that still answer while the client is quitting: the browser view's
 * bounds follow a window that is closing, and diagnostics are what a user
 * exports when a shutdown hangs. */
export const QUIT_ALLOWED = ['beings:browser-bounds', 'beings:diagnostics'];
/** Channels refused until an interrupted Portal upgrade has been recovered. */
export const RECOVERY_BLOCKED = ['beings:save', 'beings:portal-start', 'beings:portal-stop'];

export interface TrustedHandleOptions {
  /** `ipcMain.handle`, bound by main.ts. */
  register: (channel: string, listener: (event: TrustedInvokeEvent, ...args: any[]) => Promise<unknown>) => void;
  window: () => TrustedWindow | null;
  /** The one URL the shell is allowed to be at. */
  shellURL: () => string;
  quitting: () => boolean;
  recoveryBlocked: () => boolean;
  /** `errorLog.report`: logs the real failure, returns the short public message. */
  report: (channel: string, error: unknown) => string;
}

/** Only the trusted top-level local shell can control local capabilities. */
export function createTrustedHandle(options: TrustedHandleOptions) {
  return (channel: string, callback: (...args: any[]) => unknown) => {
    options.register(channel, async (event, ...args) => {
      const window = options.window();
      const frame = event.senderFrame;
      if (!window || event.sender !== window.webContents || frame !== window.webContents.mainFrame || frame.url !== options.shellURL()) throw new Error('Untrusted IPC sender');
      if (options.quitting() && !QUIT_ALLOWED.includes(channel)) throw new Error('客户端正在退出，请稍候。');
      if (options.recoveryBlocked() && RECOVERY_BLOCKED.includes(channel)) throw new Error('Portal 升级恢复尚未完成，请重新启动客户端完成恢复。');
      try { return await callback(...args); }
      catch (error) { throw new Error(options.report(channel, error)); }
    });
  };
}
