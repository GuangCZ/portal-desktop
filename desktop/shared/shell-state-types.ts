// The sidebar ledger's renderer-facing contract; 2026-09-16.
//
// Shapes ported from BeingDesktop 0.8.26 src/sidebar-state.cjs and
// docs/interfaces.md §3「`sidebar` | `sidebarState()` |
// `{scope, projects, tasks:{[id]:{pinned, archived, project, touchedAt}}}`」.
//
// Everything here is prefixed `Shell*`: desktop-types.ts re-exports every
// subsystem's file with `export *`, and a duplicate name would be dropped
// silently rather than fail (see that file's header).

/** What the sidebar remembers about one conversation, for one Being. */
export interface ShellSidebarTask {
  pinned: boolean;
  archived: boolean;
  /** A project folder from `ShellSidebarState.projects`, or `''` for a
   * standalone conversation. Never a path that is not in that list. */
  project: string;
  /** Epoch milliseconds of the last `touch`, or 0. It raises a conversation in
   * the sidebar's order without the Being having said anything — 0.8.26 files a
   * newly created conversation this way (src/main.cjs line 1171). */
  touchedAt: number;
}

/** The ledger as the renderer sees it: the current Being's bucket, resolved.
 *
 * `scope` is that Being's identity partition (`sessionPartition`), or `''` when
 * no Being is connected — in which case `tasks` is empty and only the project
 * list is readable, exactly as 0.8.26 behaves. */
export interface ShellSidebarState {
  scope: string;
  projects: string[];
  tasks: Record<string, ShellSidebarTask>;
}

/** One change to the ledger. `scope` must equal the current identity partition:
 * a request written for the Being that was connected a moment ago is refused
 * rather than applied to whoever is connected now (docs/interfaces.md §1
 * 「`scope` 必须等于当前身份分区」). */
export type ShellSidebarAction =
  | { type: 'pin' | 'archive' | 'touch'; id: string; scope: string }
  | { type: 'move'; id: string; scope: string; project: string }
  | { type: 'remove-project'; project: string; scope: string };

/** The bridge slice the shell-state subsystem adds to `window.beings`. */
export interface ShellStateAPI {
  /** The ledger for the Being that is connected now. */
  sidebar(): Promise<ShellSidebarState>;
  /** Apply one change and answer with the ledger it produced. Rejects — with a
   * message the renderer shows as a toast — when the scope is stale, the
   * conversation is unknown, the project does not exist, or the profile could
   * not be written. Nothing is kept in memory that did not reach the disk. */
  sidebarAction(action: ShellSidebarAction): Promise<ShellSidebarState>;
  /** Add a folder to the project list, after the user picked it with
   * `choose('workspace')`. Already-listed folders are accepted and change
   * nothing. */
  addProject(project: string): Promise<ShellSidebarState>;
  /** Every change to the ledger, including the one that follows switching
   * Beings — a different Being is a different set of pins. */
  onSidebar(callback: (state: ShellSidebarState) => void): () => void;
}
