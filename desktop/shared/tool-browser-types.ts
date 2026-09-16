// The Being-operable tool browser's renderer-facing contract; 2026-09-16.
//
// Shapes ported from BeingDesktop 0.8.26 docs/interfaces.md §1.2「桌面工具、控制台
// 与终端」(`getDesktopTools().browser`, `desktopAction('browser.*')`,
// `setBrowserView`) and §3.6「DesktopBrowser」.
//
// NOT the shell browser. `BrowserState` / `BrowserAction` / `BrowserBounds` in
// ./types.ts belong to portal-desktop's own single-tab `ClientBrowser`
// (main/browser/), which keeps its own partition `persist:beings-browser` and is
// not touched by this unit. This one is `DesktopBrowser`: sixteen tabs, partition
// `persist:being-desktop-browser-v1`, and a Being may read and act on its pages.
// Two browsers, two partitions, two regions on screen — integration plan §5.6.
// Every name here is prefixed `ToolBrowser` so the two contracts cannot collide
// behind `desktop-types.ts`'s `export *`.

export interface ToolBrowserTab {
  id: string;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** A page-level failure (navigation refused, load error). */
  error: string;
  /** A transient message about something the browser refused to do — a download,
   * a popup — shown beside the address rather than replacing the page. */
  notice: string;
  /** Bumped on every committed document. A Being's page operations carry the
   * revision they were prepared against, so an action cannot land on a page that
   * navigated underneath it. */
  revision: number;
}

export interface ToolBrowserState {
  tabs: ToolBrowserTab[];
  activeTabId: string | null;
  /** Whether the native view is attached to the window. The renderer owns this:
   * it reports the rectangle its placeholder occupies, and zero area or a hidden
   * panel detaches the view. */
  visible: boolean;
}

export interface ToolBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ToolBrowserViewport {
  visible: boolean;
  bounds?: ToolBrowserBounds;
}

export type ToolBrowserAction = 'new' | 'activate' | 'close' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop';

export interface ToolBrowserAPI {
  state(): Promise<ToolBrowserState>;
  newTab(value?: { url?: string; active?: boolean }): Promise<ToolBrowserState>;
  activateTab(id: string): Promise<ToolBrowserState>;
  closeTab(id: string): Promise<ToolBrowserState>;
  navigate(value: { id?: string; url: string }): Promise<ToolBrowserState>;
  goBack(id?: string): Promise<ToolBrowserState>;
  goForward(id?: string): Promise<ToolBrowserState>;
  reload(id?: string): Promise<ToolBrowserState>;
  stop(id?: string): Promise<ToolBrowserState>;
  /** Where the panel's placeholder is, in window coordinates. */
  setViewport(value: ToolBrowserViewport): Promise<ToolBrowserState>;
  onState(callback: (state: ToolBrowserState) => void): () => void;
}
