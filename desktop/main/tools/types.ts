// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Call surfaces for the collaborators this unit does not own: DesktopBrowser
// (src/desktop-browser.cjs), DesktopTerminal (src/desktop-terminal.cjs) and
// Orchestration (src/orchestration.cjs, the desktop_worker_* implementation).
// They are injected through constructors so the tool bridge stays testable
// without Electron. See docs/architecture.md §5.4「桌面工具桥（直接模式）」.

/** One MCP content block. Desktop only ever emits text and image blocks. */
export interface ToolTextContent { type: 'text'; text: string }
export interface ToolImageContent { type: 'image'; mimeType: string; data: string }
export type ToolContent = ToolTextContent | ToolImageContent;
export interface ToolResult { content: ToolContent[]; isError?: boolean }

/** Context handed to the tool host for one `tools/call`. */
export interface ToolCallContext { signal?: AbortSignal; requestKey?: string }
export type InvokeTool = (name: string, args: Record<string, unknown>, context: ToolCallContext) => ToolResult | Promise<ToolResult>;

export interface BrowserTab {
  id: string;
  url?: string;
  title?: string;
  revision?: number;
  isLoading?: boolean;
  error?: string;
  [key: string]: unknown;
}
export interface BrowserSnapshot {
  tabs: BrowserTab[];
  activeTabId: string | null;
  visible?: boolean;
  [key: string]: unknown;
}
/** `newTab` on a live browser returns a snapshot; lighter hosts return the id only. */
export interface NewTabResult { activeTabId: string | null; tabs?: BrowserTab[]; [key: string]: unknown }
export interface PrepareActionRequest { id: string; selector: string; expectedRevision?: number; kind: 'click' | 'fill' }
export interface PreparedAction { targetToken?: string; summary?: string }
export interface BrowserScreenshot { mimeType: string; data: string }

/** The DesktopBrowser surface DesktopTools drives. */
export interface DesktopBrowserLike {
  snapshot(): BrowserSnapshot;
  newTab(options: { url?: string; active?: boolean }): NewTabResult;
  activateTab(id: string): unknown;
  closeTab(id: string): unknown;
  navigate(options: { id?: string; url?: string }): unknown;
  goBack(id: string): unknown;
  goForward(id: string): unknown;
  reload(id: string): unknown;
  stop(id: string): unknown;
  readPage(id: string, expectedRevision?: number): Promise<unknown>;
  prepareAction(request: PrepareActionRequest): Promise<PreparedAction>;
  click(options: { id: string; selector: string; expectedRevision?: number; targetToken?: string }): Promise<unknown>;
  fill(options: { id: string; selector: string; text: string; expectedRevision?: number; targetToken?: string }): Promise<unknown>;
  screenshot(id: string, expectedRevision?: number): Promise<BrowserScreenshot>;
  destroy(): void;
}
/** The narrow browser surface browser-links and worker presentation need. */
export interface BrowserTabOpener { newTab(options: { url?: string; active?: boolean }): NewTabResult }
export interface PresentationBrowser extends BrowserTabOpener {
  snapshot(): BrowserSnapshot;
  activateTab(id: string): unknown;
  reload(id: string): unknown;
}

/** `normalizeBrowserUrl` from src/desktop-browser.cjs, injected by the browser unit. */
export type NormalizeBrowserUrl = (value: string) => string;

export interface TerminalSession { id: string; status?: string; [key: string]: unknown }
export interface TerminalSnapshot { sessions: TerminalSession[]; [key: string]: unknown }
/** The DesktopTerminal surface DesktopTerminalTools drives. */
export interface DesktopTerminalLike {
  shell?: string;
  snapshot(): TerminalSnapshot;
  create(options: { cwd?: string }): Promise<{ sessionId: string }>;
  write(options: { id: string; data: string }): Record<string, unknown>;
  readSince(id: string, afterSequence: number): Record<string, unknown>;
  activate(id: string): unknown;
  close(id: string): unknown | Promise<unknown>;
}

/** The Orchestration surface DesktopTools consults for mode and worker tools. */
export interface OrchestrationLike {
  mode: { enabled: boolean };
  configuring?: boolean;
  tool(name: string, args: Record<string, unknown>, context: { signal?: AbortSignal }): Promise<ToolResult>;
}

/** `desktopPortalName` from src/desktop-identity.cjs, injected by the identity unit. */
export type DesktopPortalName = (desktopId: string) => string;
