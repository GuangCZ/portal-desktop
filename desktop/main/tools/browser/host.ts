// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Source: the Electron surface src/desktop-browser.cjs receives through its
// constructor ({WebContentsView, session, getWindow}). BeingDesktop's module
// never required 'electron' either; this file only names those shapes so
// browser.ts can stay unit-testable, and electron-host.ts binds the real APIs.
// Reading digest: docs/migration/u5-terminal-browser.md.

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** WebContents.capturePage() result (Electron NativeImage). */
export interface BrowserNativeImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number }): BrowserNativeImage;
  toPNG(): Buffer;
}

export interface BrowserNavigationHistory {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

export interface BrowserWindowOpenDetails {
  url: string;
  disposition?: string;
}

export interface BrowserWindowOpenResponse {
  action: 'allow' | 'deny';
}

/** The WebContents members the desktop browser drives. */
export interface BrowserWebContents {
  navigationHistory: BrowserNavigationHistory;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  setWindowOpenHandler(handler: (details: BrowserWindowOpenDetails) => BrowserWindowOpenResponse): void;
  loadURL(url: string): Promise<void> | void;
  getURL(): string;
  isLoading(): boolean;
  isDestroyed(): boolean;
  reload(): void;
  stop(): void;
  close(options: { waitForBeforeUnload: boolean }): void;
  capturePage(rect: BrowserBounds, options: { stayHidden: boolean; stayAwake: boolean }): Promise<BrowserNativeImage>;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[], userGesture: boolean): Promise<any>;
}

/** webPreferences of every browser tab; every flag is asserted by the tests. */
export interface BrowserWebPreferences {
  session: BrowserSession;
  nodeIntegration: boolean;
  nodeIntegrationInSubFrames: boolean;
  nodeIntegrationInWorker: boolean;
  contextIsolation: boolean;
  sandbox: boolean;
  webSecurity: boolean;
  allowRunningInsecureContent: boolean;
  webviewTag: boolean;
  navigateOnDragDrop: boolean;
  safeDialogs: boolean;
  disableDialogs: boolean;
  spellcheck: boolean;
}

/** The WebContentsView members the desktop browser drives. */
export interface BrowserView {
  webContents: BrowserWebContents;
  setBounds(bounds: BrowserBounds): void;
  getBounds(): BrowserBounds;
  setVisible(visible: boolean): void;
  setBackgroundColor(color: string): void;
}

export interface BrowserViewConstructor {
  new (options: { webPreferences: BrowserWebPreferences }): BrowserView;
}

export interface BrowserRequestDetails {
  url: string;
  resourceType: string;
}

export type BrowserRequestListener = (
  details: BrowserRequestDetails,
  callback: (response: { cancel: boolean }) => void,
) => void;

export interface BrowserWebRequest {
  onBeforeRequest(listener: BrowserRequestListener | null): void;
}

export interface BrowserDownloadEvent {
  preventDefault(): void;
}

export type BrowserDownloadListener = (
  event: BrowserDownloadEvent,
  item: unknown,
  contents: BrowserWebContents,
) => void;

/** The Session members the desktop browser locks down. */
export interface BrowserSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  on(event: 'will-download', listener: BrowserDownloadListener): unknown;
  removeListener(event: 'will-download', listener: BrowserDownloadListener): unknown;
  webRequest: BrowserWebRequest;
}

export interface BrowserSessionFactory {
  fromPartition(partition: string): BrowserSession;
}

/** The host window the active tab is attached to. */
export interface BrowserHostWindow {
  isDestroyed(): boolean;
  getContentSize(): number[];
  contentView: {
    addChildView(view: BrowserView): void;
    removeChildView(view: BrowserView): void;
  };
}

/**
 * Every Electron touch point of DesktopBrowser, gathered into one injected
 * host. electron-host.ts is the only module that binds it to real Electron.
 */
export interface ElectronBrowserHost {
  WebContentsView: BrowserViewConstructor;
  session: BrowserSessionFactory;
  getWindow: () => BrowserHostWindow | null | undefined;
}
