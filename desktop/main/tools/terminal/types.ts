// Ported from BeingDesktop 0.8.26 on 2026-09-16.
// Source: src/desktop-terminal.cjs (session shapes) plus the node-pty 1.1.0 IPty
// surface that module drives. node-pty is NOT a dependency of portal-desktop:
// the factory is injected through the DesktopTerminal constructor so the class
// stays testable, and the integration phase binds the real module.
// Reading digest: docs/migration/u5-terminal-browser.md.

/** Subscription handle returned by node-pty's onData / onExit. */
export interface PtyDisposable {
  dispose(): void;
}

/** Exit payload of node-pty's onExit event. */
export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

/**
 * node-pty internals the desktop terminal reaches into when a shell exits on
 * its own. node-pty 1.1.0 waits for another data event before disposing its
 * ConPTY worker, which a closed output pipe can never produce.
 */
export interface PtyAgent {
  inSocket?: { destroy(): void };
  _conoutSocketWorker?: { dispose(): void };
}

/** The subset of node-pty's IPty the desktop terminal uses. */
export interface PtyLike {
  readonly pid?: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
  _agent?: PtyAgent;
}

/** Spawn options passed straight through to node-pty. */
export interface PtySpawnOptions {
  name?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  handleFlowControl?: boolean;
  useConpty?: boolean;
  useConptyDll?: boolean;
  conptyInheritCursor?: boolean;
}

/** node-pty's module surface, injected instead of imported. */
export interface PtyFactory {
  spawn(file: string, args: string[] | string, options: PtySpawnOptions): PtyLike;
}

export type TerminalStatus = 'running' | 'closing' | 'exited' | 'failed';

/** One row of DesktopTerminal.snapshot().sessions. */
export interface TerminalSessionState {
  id: string;
  title: string;
  cwd: string;
  status: TerminalStatus;
  pid: number | null;
  cols: number;
  rows: number;
  exitCode: number | null;
}

export interface TerminalSnapshot {
  sessions: TerminalSessionState[];
  activeSessionId: string | null;
}

/** Payload pushed on being:terminal-data. */
export interface TerminalDataEvent {
  id: string;
  sequence: number;
  data: string;
}

/** DesktopTerminal.read() result. */
export interface TerminalReplay {
  id: string;
  sequence: number;
  data: string;
  truncated: boolean;
}

/** DesktopTerminal.readSince() result. */
export interface TerminalIncrementalRead {
  id: string;
  data: string;
  sequence: number;
  latestSequence: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalWriteOptions {
  id?: string;
  data?: unknown;
}

export interface TerminalResizeOptions {
  id?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

/** Live session record kept in DesktopTerminal.sessions. */
export interface TerminalSession extends TerminalSessionState {
  process: PtyLike | null;
  sequence: number;
  chunks: string[];
  replayBytes: number;
  truncated: boolean;
  subscriptions: (PtyDisposable | undefined)[];
  closing: Promise<{ closed: true }> | null;
  nativeReleased: boolean;
  didExit: boolean;
  exited: Promise<void>;
  resolveExit: () => void;
}

export interface DesktopTerminalOptions {
  getWorkspace?: () => string | Promise<string>;
  onChange?: (snapshot: TerminalSnapshot) => void;
  onData?: (event: TerminalDataEvent) => void;
  pty?: PtyFactory;
  environment?: Record<string, string | undefined>;
  platform?: string;
  shellPath?: string;
}
