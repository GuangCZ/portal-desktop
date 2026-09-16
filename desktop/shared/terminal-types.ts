// The interactive terminal's renderer-facing contract; 2026-09-16.
//
// Shapes ported from BeingDesktop 0.8.26 docs/interfaces.md §1.2「桌面工具、控制台
// 与终端」and §1.3「主进程 → 渲染层推送」: `getTerminalState`, `readTerminal`,
// `terminalAction`, `being:terminal-state` and `being:terminal-data`. The main
// process asserts its handlers against these declarations (main/tools/terminal/
// ipc.ts), which is what keeps the two halves in step.
//
// They are deliberately NOT re-exported from main/tools/terminal/types.ts: that
// file also carries the node-pty surface and the live session record, neither of
// which may cross into the renderer. The overlapping members are the same by
// construction — the IPC layer returns `DesktopTerminal.snapshot()` verbatim —
// and tests/terminal-integration-ipc.ts pins the two together.

export type TerminalStatus = 'running' | 'closing' | 'exited' | 'failed';

/** One row of the terminal snapshot. */
export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  status: TerminalStatus;
  pid: number | null;
  cols: number;
  rows: number;
  exitCode: number | null;
}

export interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
}

/** `terminalAction('create', …)` answers the snapshot plus the new id.
 *
 * DEVIATION from BeingDesktop, which returns the bare snapshot for every action
 * (src/main.cjs line 1115) and leaves `renderer/terminal-panel.js`'s
 * `result?.sessionId` permanently undefined. The panel already reads that field;
 * filling it in costs nothing and removes a round trip. */
export interface TerminalCreateState extends TerminalState {
  sessionId: string;
}

/** One PTY output event. `sequence` is shared with the replay below: subscribe
 * first, then replay, then discard every event at or below the replay's
 * sequence. */
export interface TerminalData {
  id: string;
  sequence: number;
  data: string;
}

/** `readTerminal(id)`: the whole retained buffer, at most 1 MiB. */
export interface TerminalReplay {
  id: string;
  sequence: number;
  data: string;
  truncated: boolean;
}

/** The main process asking the renderer to bring a session on screen. The tool
 * bridge's `desktop_terminal_*` calls block on the answer, so the renderer must
 * reply on `terminalRevealed` whether it succeeded or not. */
export interface TerminalReveal {
  id: string;
}

export interface TerminalRevealResult {
  id: string;
  shown: boolean;
}

export type TerminalAction =
  | { action: 'create'; value?: { cwd?: string; cols?: number; rows?: number } }
  | { action: 'write'; value: { id: string; data: string } }
  | { action: 'resize'; value: { id: string; cols: number; rows: number } }
  | { action: 'activate'; value: string }
  | { action: 'close'; value: string };

export interface TerminalAPI {
  state(): Promise<TerminalState>;
  read(id: string): Promise<TerminalReplay>;
  create(value?: { cwd?: string; cols?: number; rows?: number }): Promise<TerminalCreateState>;
  write(value: { id: string; data: string }): Promise<TerminalState>;
  resize(value: { id: string; cols: number; rows: number }): Promise<TerminalState>;
  activate(id: string): Promise<TerminalState>;
  close(id: string): Promise<TerminalState>;
  /** Answer a `onReveal` request. Late answers are ignored by the main process. */
  revealed(result: TerminalRevealResult): Promise<void>;
  onState(callback: (state: TerminalState) => void): () => void;
  onData(callback: (event: TerminalData) => void): () => void;
  onReveal(callback: (request: TerminalReveal) => void): () => void;
}
