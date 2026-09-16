// How the conversation list is arranged in the sidebar: order, relative age,
// and the three groups. Ported from BeingDesktop 0.8.26 renderer/sidebar.js
// (`timestamp`, `age`, `ordered`, `metadata`, `render`'s grouping and
// `renderSearch`); 2026-09-16. Behaviour rules: docs/sidebar-interaction.md.
//
// DEVIATION: 0.8.26 keeps this metadata in the main process, scoped by Being
// connection and persisted in Desktop settings (`sidebarAction`, src/main.cjs
// line 1139). There is no such channel in this shell yet, so the metadata lives
// here, in memory, for the lifetime of the window — pins, projects and archives
// are gone after a restart. The shapes are 0.8.26's so the persistence stage has
// nothing to redesign.
import { Store } from '../../shared/models/store';
import type { ChatSessionSummary } from '../../../shared/desktop-types';

export interface SessionMetadata { pinned: boolean; archived: boolean; project: string }

const EMPTY: SessionMetadata = { pinned: false, archived: false, project: '' };

export const basename = (value: string) => value?.split(/[\\/]/).filter(Boolean).at(-1) || value || '项目';

const timestamp = (value: string | number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(String(value || '')) || 0;

/** The newest thing that happened in a conversation. Opening one is not one of
 * them: "打开会话不会将它重新置顶" (docs/sidebar-interaction.md). */
export const touched = (session: ChatSessionSummary) => timestamp(session.updatedAt || session.createdAt);

/** `刚刚` / `12分` / `3时` / `2天`, as the sidebar has always shown it. */
export function age(session: ChatSessionSummary, now = Date.now()): string {
  const at = touched(session);
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
  /** The project folders the sidebar offers. One in this shell: the workspace
   * the connection settings name (0.8.26's own fallback, sidebar.js line 117). */
  projects: string[] = [];

  metadata(id: string): SessionMetadata { return this.entries.get(id) || EMPTY; }

  setProjects(paths: string[]) {
    const next = paths.filter(Boolean);
    if (next.length === this.projects.length && next.every((path, index) => path === this.projects[index])) return;
    this.projects = next;
    this.changed();
  }

  private patch(id: string, change: Partial<SessionMetadata>) {
    this.entries.set(id, { ...this.metadata(id), ...change });
    this.changed();
  }

  pin(id: string) { this.patch(id, { pinned: !this.metadata(id).pinned }); }
  archive(id: string) { this.patch(id, { archived: !this.metadata(id).archived }); }
  move(id: string, project: string) { this.patch(id, { project }); }
  forget(id: string) {
    if (!this.entries.delete(id)) return;
    this.changed();
  }

  /** Newest first, stable among equals — the list does not reshuffle itself
   * while the user is reading it (sidebar.js line 23). */
  ordered(sessions: readonly ChatSessionSummary[]): ChatSessionSummary[] {
    return sessions
      .map((session, index) => ({ session, index }))
      .sort((left, right) => touched(right.session) - touched(left.session) || left.index - right.index)
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
