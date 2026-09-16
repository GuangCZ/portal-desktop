// Ported from BeingDesktop 0.8.26 src/desktop-browser.cjs on 2026-09-16.
// Data shapes of the browser snapshot, the live tab record and the structured
// page operations. Kept out of browser.ts so the integration phase can reuse
// them from IPC and renderer contracts (docs/interfaces.md 1.2 / 3.6).
// Reading digest: docs/migration/u5-terminal-browser.md.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BrowserView } from './host';

/** One row of DesktopBrowser.snapshot().tabs. Key order is asserted by tests. */
export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string;
  notice: string;
  revision: number;
}

export interface BrowserSnapshot {
  tabs: BrowserTabState[];
  activeTabId: string | null;
  visible: boolean;
}

/** Live tab record kept in DesktopBrowser.tabs. */
export interface BrowserTab {
  id: string;
  view: BrowserView;
  url: string;
  title: string;
  error: string;
  notice: string;
  committedUrl: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  listeners: [string, (...args: any[]) => void][];
  revision: number;
  requestRevision: number;
  documentToken: string;
  contextPromise: Promise<void> | null;
  blockedRequestRevision?: number;
  blockedRevision?: number;
}

/** One interactive element returned by a page read. */
export interface PageElement {
  selector: string;
  tag: string;
  role: string;
  label: string;
  type: string;
}

/** Whatever the injected page function returns, across all operations. */
export interface PageOperationResult {
  error?: string;
  title?: string;
  text?: string;
  elements?: PageElement[];
  truncated?: boolean;
  targetToken?: string;
  summary?: string;
  clicked?: boolean;
  filled?: boolean;
}

export interface BrowserNewTabOptions {
  url?: unknown;
  active?: unknown;
}

export interface BrowserNavigateOptions {
  id?: unknown;
  url?: unknown;
}

export interface BrowserViewportOptions {
  visible?: unknown;
  bounds?: unknown;
}

export interface BrowserActionOptions {
  id?: unknown;
  selector?: unknown;
  targetToken?: unknown;
  expectedRevision?: number;
}

export interface BrowserPrepareOptions extends BrowserActionOptions {
  kind?: unknown;
}

export interface BrowserFillOptions extends BrowserActionOptions {
  text?: unknown;
}

export interface BrowserReadResult {
  tabId: string;
  revision: number;
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
  truncated: boolean;
}

export interface BrowserPrepareResult {
  targetToken: string;
  summary: string;
}

export interface BrowserScreenshotResult {
  tabId: string;
  revision: number;
  mimeType: 'image/png';
  data: string;
  width: number;
  height: number;
}

export interface DesktopBrowserOptions {
  WebContentsView: import('./host').BrowserViewConstructor;
  session: import('./host').BrowserSessionFactory;
  getWindow: () => import('./host').BrowserHostWindow | null | undefined;
  onChange?: (snapshot: BrowserSnapshot) => void;
}
