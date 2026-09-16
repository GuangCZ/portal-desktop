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

// I2 (2026-09-16) removed the `[key: string]: unknown` members these three used
// to carry. They were what let a hand-written fixture answer with whatever it
// liked, but they also made the REAL browser unassignable: `BrowserTabState`
// (./browser/types) is an interface, and TypeScript grants an implicit index
// signature only to type-alias object types, so `DesktopBrowser.snapshot()` was
// rejected by `DesktopBrowserLike` — measured with tsc, see
// docs/migration/i2-tools.md「类型对齐实测」. Every field the loose shapes
// declare still exists on the real ones, so widening stayed a deletion.
export interface BrowserTab {
  id: string;
  url?: string;
  title?: string;
  revision?: number;
  isLoading?: boolean;
  error?: string;
}
export interface BrowserSnapshot {
  tabs: BrowserTab[];
  activeTabId: string | null;
  visible?: boolean;
}
/** `newTab` on a live browser returns a snapshot; lighter hosts return the id only. */
export interface NewTabResult { activeTabId: string | null; tabs?: BrowserTab[] }
export interface PrepareActionRequest { id: string; selector: string; expectedRevision?: number; kind: 'click' | 'fill' }
export interface PreparedAction { targetToken?: string; summary?: string }
export interface BrowserScreenshot { mimeType: string; data: string }

/** The DesktopBrowser surface DesktopTools drives. */
export interface DesktopBrowserLike {
  snapshot(): BrowserSnapshot;
  /** A live browser answers every navigation with its whole snapshot, `newTab`
   * included (src/desktop-browser.cjs, and ./browser/browser.ts after it). The
   * declaration used to say `NewTabResult`, which only the lighter
   * `BrowserTabOpener` below actually returns. I2, 2026-09-16. */
  newTab(options: { url?: string; active?: boolean }): BrowserSnapshot;
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

// Same widening as the browser shapes above, for the same measured reason:
// `TerminalSessionState` (./terminal/types) is an interface and carries no
// implicit index signature, so the real `DesktopTerminal` could not be handed to
// `getTerminal`.
export interface TerminalSession { id: string; title?: string; cwd?: string; status?: string; pid?: number | null; cols?: number; rows?: number; exitCode?: number | null }
export interface TerminalSnapshot { sessions: TerminalSession[]; activeSessionId?: string | null }
/** The DesktopTerminal surface DesktopTerminalTools drives. */
export interface DesktopTerminalLike {
  shell?: string;
  snapshot(): TerminalSnapshot;
  create(options: { cwd?: string }): Promise<{ sessionId: string }>;
  // Both used to answer `Record<string, unknown>`, which the real terminal's own
  // result interfaces cannot satisfy for the index-signature reason above; the
  // spread sites in terminal-tools.ts only need the members to be enumerable.
  // I2, 2026-09-16.
  write(options: { id: string; data: string }): object;
  readSince(id: string, afterSequence: number): object;
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
