// How the conversation list is arranged in the sidebar: order, relative age,
// and the three groups. Ported from BeingDesktop 0.8.26 renderer/sidebar.js
// (`timestamp`, `age`, `ordered`, `metadata`, `render`'s grouping and
// `renderSearch`); 2026-09-16. Behaviour rules: docs/sidebar-interaction.md.
//
// The metadata itself belongs to the main process — 0.8.26 keeps it bucketed by
// Being connection in settings.json (`sidebarAction`, src/main.cjs line 1139),
// and this client does too since integration unit I6
// (docs/migration/i6-shell-state.md). This model is the PROJECTION of it: while
// a ledger is bound, `pin` / `archive` / `move` send the change and render what
// comes back, and the entries below are replaced wholesale by
// `applyLedger`. Nothing is applied optimistically: a refused change (the Being
// switched, the profile could not be written) must leave the sidebar showing what
// was actually saved, which is 0.8.26's rule too — its `mutate` only accepts the
// state the main process answers with (renderer/sidebar.js line 36).
//
// With no ledger bound it keeps its own entries in memory, which is what a test
// and a window with no bridge get.
import { Store } from '../../shared/models/store';
import type { ChatSessionSummary, ShellSidebarAction, ShellSidebarState } from '../../../shared/desktop-types';

export interface SessionMetadata {
  pinned: boolean;
  archived: boolean;
  project: string;
  /** Epoch milliseconds of the last explicit `touch`, or 0. It raises a
   * conversation in the order without a message having arrived — filing a new one
   * into a project is what does it (0.8.26 src/main.cjs line 1171). */
  touchedAt: number;
}

/** Where a change goes while the main process owns the ledger. */
export interface SidebarLedger { act(action: ShellSidebarAction): Promise<void> }

/** The action minus the scope this model fills in. Distributed over the union,
 * because a plain `Omit` of a union keeps only the keys every member shares —
 * which would drop `id` and `project`, the two that carry the change. */
type SidebarChange = ShellSidebarAction extends infer Action
  ? Action extends ShellSidebarAction ? Omit<Action, 'scope'> : never
  : never;

const EMPTY: SessionMetadata = { pinned: false, archived: false, project: '', touchedAt: 0 };

export const basename = (value: string) => value?.split(/[\\/]/).filter(Boolean).at(-1) || value || '项目';

const timestamp = (value: string | number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(String(value || '')) || 0;

/** The newest thing that happened in a conversation. Opening one is not one of
 * them: "打开会话不会将它重新置顶" (docs/sidebar-interaction.md). */
export const touched = (session: ChatSessionSummary, touchedAt = 0) =>
  Math.max(touchedAt, timestamp(session.updatedAt || session.createdAt));

/** `刚刚` / `12分` / `3时` / `2天`, as the sidebar has always shown it. */
export function age(session: ChatSessionSummary, now = Date.now(), touchedAt = 0): string {
  const at = touched(session, touchedAt);
  if (!at) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes}分` : minutes < 1440 ? `${Math.floor(minutes / 60)}时` : `${Math.floor(minutes / 1440)}天`;
}

export interface SessionGroups {
  pinned: ChatSessionSummary[];
  projects: { path: string; name: string; sessions: ChatSessionSummary[] }[];
  standalone: ChatSessionSummary[];
}

export class OrganizerModel extends Store {
  /** Only conversations the user has done something to appear here. */
  private entries = new Map<string, SessionMetadata>();
  /** The project folders the sidebar offers, in the order they were added. */
  projects: string[] = [];
  /** The Being the current entries belong to, as the main process named it. It
   * travels with every change so a stale one is refused rather than applied. */
  scope = '';
  private ledger: SidebarLedger | null = null;

  /** Whether changes are being saved. False means this is a window with no
   * bridge, and the sidebar says so rather than pretending. */
  get persistent() { return this.ledger !== null; }

  metadata(id: string): SessionMetadata { return this.entries.get(id) || EMPTY; }

  setProjects(paths: string[]) {
    const next = paths.filter(Boolean);
    if (next.length === this.projects.length && next.every((path, index) => path === this.projects[index])) return;
    this.projects = next;
    this.changed();
  }

  /** The ledger the main process just saved. Replaces everything: a task that is
   * no longer in it has no metadata, which is how removing a project folder
   * unfiles its conversations in one push. */
  applyLedger(state: ShellSidebarState) {
    this.scope = state.scope;
    this.projects = [...state.projects];
    this.entries = new Map(Object.entries(state.tasks).map(([id, task]) => [id, { ...EMPTY, ...task }]));
    this.changed();
  }

  bindLedger(ledger: SidebarLedger | null) {
    this.ledger = ledger;
    this.changed();
  }

  private patch(id: string, change: Partial<SessionMetadata>) {
    this.entries.set(id, { ...this.metadata(id), ...change });
    this.changed();
  }

  /** Send the change, or — with no ledger — apply the same rule locally. The two
   * branches must agree, so the local one reproduces the reducer's exclusions:
   * pinning un-archives and archiving un-pins (main/shell/sidebar-state.ts). */
  private change(action: SidebarChange, local: () => void): Promise<void> {
    if (!this.ledger) { local(); return Promise.resolve(); }
    return this.ledger.act({ ...action, scope: this.scope } as ShellSidebarAction);
  }

  pin(id: string): Promise<void> {
    const value = this.metadata(id);
    return this.change({ type: 'pin', id }, () => this.patch(id, { pinned: !value.pinned, archived: value.pinned ? value.archived : false }));
  }

  archive(id: string): Promise<void> {
    const value = this.metadata(id);
    return this.change({ type: 'archive', id }, () => this.patch(id, { archived: !value.archived, pinned: value.archived ? value.pinned : false }));
  }

  move(id: string, project: string): Promise<void> {
    return this.change({ type: 'move', id, project }, () => this.patch(id, { project }));
  }

  /** Raise a conversation in the order without anything having been said in it.
   * 0.8.26 files a newly created conversation this way. */
  touch(id: string): Promise<void> {
    return this.change({ type: 'touch', id }, () => this.patch(id, { touchedAt: Date.now() }));
  }

  /** Take a folder out of the sidebar. The folder and its files are untouched;
   * conversations filed under it become standalone. */
  removeProject(project: string): Promise<void> {
    return this.change({ type: 'remove-project', project }, () => {
      this.projects = this.projects.filter(item => item !== project);
      for (const [id, value] of this.entries) if (value.project === project) this.entries.set(id, { ...value, project: '' });
      this.changed();
    });
  }

  /** The conversation is gone from this machine. With a ledger bound there is
   * nothing to do: the entry is keyed by an id that will never be reused, and the
   * main process keeps it exactly as 0.8.26 does. */
  forget(id: string) {
    if (this.ledger) return;
    if (!this.entries.delete(id)) return;
    this.changed();
  }

  /** Newest first, stable among equals — the list does not reshuffle itself
   * while the user is reading it (sidebar.js line 23). */
  ordered(sessions: readonly ChatSessionSummary[]): ChatSessionSummary[] {
    const at = (session: ChatSessionSummary) => touched(session, this.metadata(session.id).touchedAt);
    return sessions
      .map((session, index) => ({ session, index }))
      .sort((left, right) => at(right.session) - at(left.session) || left.index - right.index)
      .map(entry => entry.session);
  }

  /** Pinned first, then each project folder, then everything else. Archived
   * conversations are in none of them and are found through search. */
  groups(sessions: readonly ChatSessionSummary[]): SessionGroups {
    const visible = this.ordered(sessions).filter(session => !this.metadata(session.id).archived);
    return {
      pinned: visible.filter(session => this.metadata(session.id).pinned),
      projects: this.projects.map(path => ({
        path,
        name: basename(path),
        sessions: visible.filter(session => !this.metadata(session.id).pinned && this.metadata(session.id).project === path),
      })),
      standalone: visible.filter(session =>
        !this.metadata(session.id).pinned && !this.projects.includes(this.metadata(session.id).project)),
    };
  }

  /** What ⌘1–9 counts: the unarchived conversations in recency order.
   *
   * Deliberately NOT the sidebar's visual order. 0.8.26 renders pinned rows, then
   * project folders, then the rest (sidebar.js line 98), but its own shortcut
   * reads `ordered().filter(!archived)[n-1]` (line 280) — most recently touched
   * first, grouping ignored. So ⌘3 is the third conversation you touched, not the
   * third row on screen, and it keeps meaning that when something is pinned.
   * Ported as measured; the grouped reading was tried and rejected as an
   * optimisation of behaviour rather than a port of it. */
  listed(sessions: readonly ChatSessionSummary[]): ChatSessionSummary[] {
    return this.ordered(sessions).filter(session => !this.metadata(session.id).archived);
  }

  /** The search panel's two categories. Matches title and project name, as
   * 0.8.26 does (sidebar.js line 206). */
  search(sessions: readonly ChatSessionSummary[], query: string, filter: 'active' | 'archived'): ChatSessionSummary[] {
    const needle = query.trim().toLocaleLowerCase();
    return this.ordered(sessions).filter(session => {
      const value = this.metadata(session.id);
      if (Boolean(value.archived) !== (filter === 'archived')) return false;
      return `${session.title} ${value.project ? basename(value.project) : ''}`.toLocaleLowerCase().includes(needle);
    });
  }
}
