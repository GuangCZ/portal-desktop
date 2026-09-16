// The sidebar's ledger: which conversations are pinned, archived or filed under
// a project folder, bucketed by Being. Ported line for line from BeingDesktop
// 0.8.26 src/sidebar-state.cjs (`validPath`, `sidebarState`, `updateSidebar`) and
// docs/interfaces.md §2 line 332; 2026-09-16.
//
// It is a pure reducer over the record that lives in settings.json under
// `sidebar` — the same key, the same shape 0.8.26 writes, so a profile that has
// been used by either client keeps its pins. Nothing here reads the disk: the
// shell-state subsystem hands it the saved record and writes back what it
// returns, which is what makes every rule below testable without a profile.
//
// Two properties are load-bearing and easy to lose in a rewrite:
//
//  · A task's `project` is only ever a path that is in `projects`. Removing a
//    folder therefore empties the field on its tasks rather than orphaning them,
//    and a task read back against a project list that no longer has its folder
//    reads as standalone.
//  · `projects` falls back to the workspace ONLY when the key is absent. An empty
//    array is a decision — the user removed the last folder — and re-adding the
//    workspace there would make「从侧栏移除项目」undoable
//    (test/sidebar-state.test.cjs's fifth case).
//
// The additions this shell needs are `addSidebarProject` at the bottom (0.8.26
// does it inline in its `selectWorkspace` handler, src/main.cjs line 1491) and
// the types, which live in desktop/shared so the renderer can name them.
import path from 'node:path';
import type { ShellSidebarAction, ShellSidebarState, ShellSidebarTask } from '../../shared/shell-state-types';

/** 0.8.26's own id test, deliberately looser than the conversation layer's
 * (chat/ipc.ts): this file must accept every id that client wrote. It is also
 * what keeps `__proto__` and `constructor` out of the task record below — no
 * prototype key is 36 characters of hex and dashes. */
const UUID = /^[0-9a-f-]{36}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An absolute path, short enough to save and free of control characters. Both
 * conventions are accepted on every platform: a profile copied from Windows to
 * macOS must not lose its project list. */
export const validPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value)
  && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));

/** The saved record, as it sits in settings.json. Read defensively — it may have
 * been written by another client, by hand, or by a newer version. */
const savedProjects = (saved: unknown): unknown[] | null => {
  if (!isRecord(saved) || !Array.isArray(saved.projects)) return null;
  return saved.projects as unknown[];
};
const savedTasks = (saved: unknown, scope: string): Record<string, unknown> => {
  if (!scope || !isRecord(saved) || !isRecord(saved.owners)) return {};
  const owner = saved.owners[scope];
  return isRecord(owner) && isRecord(owner.tasks) ? owner.tasks : {};
};

/** The ledger for one Being, normalized. Never mutates `saved`, and never
 * returns a field that was not validated: an unknown key (a credential someone
 * pasted into the file, a future client's addition) is dropped rather than
 * carried into the renderer. */
export function sidebarState(saved: unknown, scope: string, workspace = ''): ShellSidebarState {
  const projects = [...new Set((savedProjects(saved) ?? [workspace]).filter(validPath))].slice(0, 100);
  const tasks: Record<string, ShellSidebarTask> = {};
  for (const [id, value] of Object.entries(savedTasks(saved, scope)).slice(0, 10000)) {
    if (!UUID.test(id) || !isRecord(value)) continue;
    tasks[id] = {
      pinned: value.pinned === true, archived: value.archived === true,
      project: typeof value.project === 'string' && projects.includes(value.project) ? value.project : '',
      touchedAt: typeof value.touchedAt === 'number' && Number.isFinite(value.touchedAt) ? value.touchedAt : 0,
    };
  }
  return { scope: scope || '', projects, tasks };
}

/** Apply one change and answer with the record to save.
 *
 * The first line is the stale-request guard: an action carries the scope it was
 * composed against, and a mismatch means the user switched Beings while the menu
 * was open. With no Being connected only `remove-project` is allowed — the
 * project list is shared across Beings, the task buckets are not. */
export function updateSidebar(
  saved: unknown, scope: string, workspace: string, action: ShellSidebarAction,
  sessionIds: readonly string[] = [], now = Date.now(),
): Record<string, unknown> {
  if (action?.scope !== scope || (!scope && action.type !== 'remove-project')) throw new Error('连接已变化，请重试。');
  const next = sidebarState(saved, scope, workspace);
  if (action.type === 'remove-project') {
    if (!next.projects.includes(action.project)) throw new Error('项目不存在。');
    next.projects = next.projects.filter(item => item !== action.project);
    for (const task of Object.values(next.tasks)) if (task.project === action.project) task.project = '';
  } else {
    if (!UUID.test(action.id) || !sessionIds.includes(action.id)) throw new Error('会话不存在。');
    const task: ShellSidebarTask = next.tasks[action.id] || { pinned: false, archived: false, project: '', touchedAt: 0 };
    // Pinned and archived are mutually exclusive: a pinned conversation sits in
    // its own section, an archived one is out of every section.
    if (action.type === 'pin') { task.pinned = !task.pinned; if (task.pinned) task.archived = false; }
    else if (action.type === 'archive') { task.archived = !task.archived; if (task.archived) task.pinned = false; }
    else if (action.type === 'move') {
      if (action.project !== '' && !next.projects.includes(action.project)) throw new Error('项目不存在。');
      task.project = action.project;
    } else if (action.type === 'touch') task.touchedAt = now;
    else throw new Error('侧栏操作无效。');
    next.tasks[action.id] = task;
  }
  return record(saved, scope, next);
}

/** Add a folder to the project list.
 *
 * 0.8.26 does this inline in `selectWorkspace` (src/main.cjs line 1491) because
 * there the chosen folder is also the Desktop workspace. In this shell the two
 * are separate — `Settings.workspace` is the Portal working directory and saving
 * it re-verifies the connection and may hand the Portal over — so adding a
 * project folder is its own operation over the same list, with the same
 * deduplication, the same 100-folder cap and the same `validPath`.
 *
 * Adding a folder that is already listed is not an error: the user picked it
 * again from the directory dialog, and refusing would be noise. */
export function addSidebarProject(saved: unknown, scope: string, workspace: string, project: unknown): Record<string, unknown> {
  if (!validPath(project)) throw new Error('请选择一个本机文件夹。');
  const next = sidebarState(saved, scope, workspace);
  if (!next.projects.includes(project)) {
    if (next.projects.length >= 100) throw new Error('项目文件夹最多 100 个，请先移除一些。');
    next.projects = [...next.projects, project];
  }
  return record(saved, scope, next);
}

/** BeingDesktop's `selectSavedProject` guard, and only the guard.
 *
 * `src/main.cjs:574`: `if(!sidebarState(disk.sidebar,'',state.workspace.path)
 * .projects.includes(selected)) throw new Error('项目不存在，请重新选择文件夹。')`.
 * The scope is `''` there because THE PROJECT LIST IS SHARED ACROSS BEINGS — only
 * the task buckets are per-Being — so a folder added while connected to one Being
 * can be selected while connected to another. The caller passes its real scope
 * anyway; `sidebarState` derives the same `projects` either way, and passing the
 * truth keeps this function usable from one place instead of two.
 *
 * Nothing is written: switching the working directory is not a change to the
 * ledger, which is why this answers void rather than a record. IM, 2026-09-16. */
export function assertSavedProject(saved: unknown, scope: string, workspace: string, project: unknown): string {
  if (!validPath(project)) throw new Error('项目不存在，请重新选择文件夹。');
  if (!sidebarState(saved, scope, workspace).projects.includes(project)) throw new Error('项目不存在，请重新选择文件夹。');
  return project;
}

/** The record to write back: every key of the saved object preserved, the
 * project list replaced, and this Being's bucket replaced by the normalized
 * tasks. With no Being connected the buckets are carried through untouched. */
function record(saved: unknown, scope: string, next: ShellSidebarState): Record<string, unknown> {
  const owners = isRecord(saved) && isRecord(saved.owners) ? saved.owners : {};
  return {
    ...(isRecord(saved) ? saved : {}),
    projects: next.projects,
    owners: scope ? { ...owners, [scope]: { tasks: next.tasks } } : { ...owners },
  };
}
