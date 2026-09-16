// The channels the interactive terminal adds to the bridge; 2026-09-16.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are
// `being:` — see MIGRATION.md). The three subscriptions mirror
// docs/interfaces.md §1.3: `terminal-state` carries a new snapshot,
// `terminal-data` one chunk of a PTY's output, and `terminal-reveal` is the main
// process asking the panel to bring a session on screen — the only channel of
// this subsystem that travels that way, which is why `revealed` exists to answer
// it.
//
// None of these is a Town envelope: BeingDesktop's terminal methods are not in
// `townMethods` (src/main.cjs line 125), so a failure arrives as a plain Error
// and the panel shows its message.
import { ipcRenderer } from 'electron';
import { subscribe } from './bridge';
import type {
  TerminalAPI, TerminalCreateState, TerminalData, TerminalReveal, TerminalState,
} from '../../shared/desktop-types';

const act = (action: string, value?: unknown): Promise<TerminalState> =>
  ipcRenderer.invoke('beings:terminal-action', action, value);

export const terminal: TerminalAPI = {
  state: () => ipcRenderer.invoke('beings:terminal'),
  read: id => ipcRenderer.invoke('beings:terminal-read', id),
  create: value => act('create', value ?? {}) as Promise<TerminalCreateState>,
  write: value => act('write', value),
  resize: value => act('resize', value),
  activate: id => act('activate', id),
  close: id => act('close', id),
  revealed: result => ipcRenderer.invoke('beings:terminal-revealed', result),
  onState: callback => subscribe<TerminalState>('beings:terminal-state', callback),
  onData: callback => subscribe<TerminalData>('beings:terminal-data', callback),
  onReveal: callback => subscribe<TerminalReveal>('beings:terminal-reveal', callback),
};
