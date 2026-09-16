// The sidebar ledger's IPC surface. New in the portal-desktop shell on
// 2026-09-16; channel semantics ported from BeingDesktop 0.8.26 src/main.cjs's
// `sidebarAction` (line 1139) and its `selectWorkspace` project merge (line
// 1491), with the payload contract of docs/interfaces.md §1「工作区与侧栏」.
//
// Registration follows chat/ipc.ts: every channel goes through the `handle`
// wrapper main.ts supplies, so it inherits the sender check and the quitting
// guard, and the two mutations 0.8.26 serializes (`sidebarAction`,
// `selectSavedProject`, src/main.cjs lines 140-141) go through the same
// `exclusive` queue this client uses for everything that writes the profile.
//
// Arguments arrive from the renderer and are untrusted, so they are checked
// structurally before the reducer sees them: a plain object, no field outside the
// whitelist, every value of the declared type. The reducer then enforces what it
// alone can know — the scope is current, the conversation exists, the project is
// listed — and refuses with the message 0.8.26 refuses with.
//
// None of these channels is「Town 包络」: their callers branch on nothing but
// success, exactly as 0.8.26's do, so a failure is a thrown Error the renderer
// shows as a toast.
import type { ShellSidebarAction, ShellSidebarState } from '../../shared/shell-state-types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface ShellStateIpcOptions {
  handle: RegisterHandler;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  /** The ledger for the Being connected now. */
  state: () => ShellSidebarState;
  /** Apply one change, write the profile, and answer with the new ledger.
   * Resolved lazily for the same reason the chat channels resolve their sessions
   * lazily: the ledger is rebound on every Being binding. */
  apply: (action: ShellSidebarAction) => Promise<ShellSidebarState>;
  addProject: (project: string) => Promise<ShellSidebarState>;
  /** Make one already-listed project the working directory, and answer with the
   * ledger — unchanged, but the caller re-renders from one shape either way.
   * BeingDesktop's `selectSavedProject` (src/main.cjs:574). */
  selectProject: (project: string) => Promise<ShellSidebarState>;
}

const ACTIONS = ['pin', 'archive', 'move', 'touch', 'remove-project'] as const;
const FIELDS = ['type', 'id', 'scope', 'project'] as const;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** A path is a label here — the sidebar groups by it and never opens it — so the
 * only limit that matters is the one the reducer will save: 4096 characters.
 * Anything longer is refused before it reaches a string comparison. */
const PATH_LIMIT = 4096;

/** The action, validated field by field. An unknown field is refused rather than
 * dropped: it means the renderer and this contract disagree, and guessing which
 * of the two is right is how a stale renderer silently loses a parameter. */
function action(value: unknown): ShellSidebarAction {
  if (!plain(value)) throw new Error('侧栏操作无效。');
  for (const key of Object.keys(value)) if (!(FIELDS as readonly string[]).includes(key)) throw new Error('侧栏操作无效。');
  const type = ACTIONS.find(known => known === value.type);
  if (!type) throw new Error('侧栏操作无效。');
  if (typeof value.scope !== 'string' || value.scope.length > 128) throw new Error('连接已变化，请重试。');
  if (type === 'remove-project') {
    if (value.id !== undefined) throw new Error('侧栏操作无效。');
    if (typeof value.project !== 'string' || value.project.length > PATH_LIMIT) throw new Error('项目不存在。');
    return { type, project: value.project, scope: value.scope };
  }
  // 0.8.26's own id test (src/sidebar-state.cjs line 3) runs in the reducer; this
  // one only keeps a non-string from reaching it.
  if (typeof value.id !== 'string' || value.id.length > 64) throw new Error('会话不存在。');
  if (type === 'move') {
    if (typeof value.project !== 'string' || value.project.length > PATH_LIMIT) throw new Error('项目不存在。');
    return { type, id: value.id, scope: value.scope, project: value.project };
  }
  if (value.project !== undefined) throw new Error('侧栏操作无效。');
  return { type, id: value.id, scope: value.scope };
}

export function registerShellStateIpc({ handle, exclusive, state, apply, addProject, selectProject }: ShellStateIpcOptions) {
  handle('beings:sidebar-state', (): ShellSidebarState => state());

  handle('beings:sidebar-action', (input: unknown): Promise<ShellSidebarState> =>
    exclusive(() => apply(action(input))));

  handle('beings:sidebar-project-add', (project: unknown): Promise<ShellSidebarState> => {
    if (typeof project !== 'string' || project.length > PATH_LIMIT) throw new Error('请选择一个本机文件夹。');
    return exclusive(() => addProject(project));
  });

  // 0.8.26's `selectSavedProject`, serialized with the rest (src/main.cjs:141).
  // It writes the profile, so it belongs in the same queue as `sidebar-action`.
  // The refusal is the reducer's, not this layer's: a path that is not on the
  // list and a path that is not a path get the same sentence there, and repeating
  // it here would give one situation two.
  handle('beings:sidebar-project-select', (project: unknown): Promise<ShellSidebarState> => {
    if (typeof project !== 'string' || project.length > PATH_LIMIT) throw new Error('项目不存在，请重新选择文件夹。');
    return exclusive(() => selectProject(project));
  });
}

/** The one push. The window guard lives in `ctx.push`, so the subsystem may call
 * this at any time — including while the profile is being rewritten. */
export const shellStatePush = (send: (channel: string, payload: unknown) => void) =>
  (state: ShellSidebarState) => send('beings:sidebar', state);
