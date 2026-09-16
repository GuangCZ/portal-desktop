// The sidebar ledger, as a subsystem; 2026-09-16.
//
// It is the smallest subsystem in the client and exists for one reason: the
// sidebar's pins, archives and project folders were living in the renderer's
// memory and vanished at every restart (the DEVIATION note at the top of
// renderer/conversation/models/organizer.ts). BeingDesktop 0.8.26 keeps them in
// the main process, bucketed by Being identity and persisted in settings.json —
// `publicState().sidebar` (src/main.cjs line 567), `saveSidebarAction` (line 569)
// — and this puts them back there, in the same file, under the same `sidebar`
// key, in the same shape, so a profile that has been used by either client keeps
// what the user pinned.
//
// Three things it deliberately does NOT do:
//
//  · It keeps no copy of the ledger. Every read goes to `ctx.store.extras`, which
//    is the record `SettingsStore` holds and rewrites, so a write that fails
//    leaves nothing stale behind to roll back — 0.8.26 needs its
//    `disk.sidebar = previous` rollback (src/main.cjs line 572) precisely because
//    it does keep one.
//  · It never touches `Settings`. The ledger is a key this client does not own,
//    written through `saveExtra` — see the note on `SubsystemSettings` in
//    ./types.ts, and `SettingsStore.merge`'s list of preserved keys.
//  · It reaches the conversation layer only through a lazy getter, per the rule
//    at the top of ./types.ts. It needs the current conversation ids to refuse a
//    change to a conversation that does not exist, and chat may install after it.
import { parseConnection, sessionPartition } from '../common/loom-connection';
import { registerShellStateIpc, shellStatePush } from '../shell/ipc';
import { addSidebarProject, assertSavedProject, sidebarState, updateSidebar } from '../shell/sidebar-state';
import type { ShellSidebarAction, ShellSidebarState } from '../../shared/shell-state-types';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ShellStateSubsystem extends DesktopSubsystem {
  /** The ledger for the Being connected now. Exposed for the tests and for any
   * later subsystem that needs to know what the user filed where. */
  sidebar(): ShellSidebarState;
}

declare module './types' { interface SubsystemMap { 'shell-state': ShellStateSubsystem } }

export function installShellStateSubsystem(ctx: SubsystemContext): ShellStateSubsystem {
  const push = shellStatePush(ctx.push);
  // The bucket key: the same identity string the conversation cache, the feature
  // task ledger and the TownClientStore file under (i0-seams §G). Computed from
  // the saved address, because that is what carries `api=` and `relay_secret=`.
  const scope = () => {
    const address = ctx.store.connectionAddress;
    if (!address) return '';
    try { return sessionPartition(parseConnection(address)); }
    catch (error) { ctx.onError('shell-state-identity', error); return ''; }
  };
  // The fallback project folder, for a profile that has never had a project list.
  // 0.8.26 passes its own top-level `workspace` here — the Desktop project
  // directory, which this client reads as `projectWorkspace` and does not
  // otherwise use. `Settings.workspace` is the PORTAL working directory in this
  // shell and is deliberately not offered as a project folder: it is a Portal
  // deployment detail, and saving it re-verifies the connection.
  const workspace = () => ctx.store.settings.projectWorkspace || '';
  const saved = () => ctx.store.extras.sidebar;
  const state = (): ShellSidebarState => sidebarState(saved(), scope(), workspace());
  const conversations = (): string[] => {
    const sessions = ctx.registry.get('chat')?.sessions;
    return sessions ? sessions.snapshot().sessions.map(session => session.id) : [];
  };
  /** Write, then publish. The renderer gets the answer as the resolved value of
   * its own call and every other view of the sidebar gets it as a push, so the
   * two can never disagree about what was saved. */
  const commit = async (next: Record<string, unknown>): Promise<ShellSidebarState> => {
    await ctx.store.saveExtra({ sidebar: next });
    const current = state();
    push(current);
    return current;
  };

  /** BeingDesktop's `selectSavedProject` (src/main.cjs:574), which is the only
   * thing that moves the Desktop working directory after startup:
   *
   *   `disk.workspace = selected; await persist(); state.workspace = {...};
   *    desktopTools?.changed();`
   *
   * `disk.workspace` is the SAME DISK KEY this client reads into
   * `Settings.projectWorkspace` (app/settings.ts line 68), so writing it through
   * `saveExtra` keeps a 0.8.x profile and this one on the same file — which is why
   * this does not go through `save()`: that is the Portal path, and it re-verifies
   * the connection and can restart the engine (main.ts line 441). Choosing a
   * folder in the sidebar must not do either.
   *
   * THE SECOND LINE IS THE ONE THAT MATTERS. `SettingsStore.settings` is the live
   * object every subsystem reads its workspace off — `DesktopTools` and
   * `DesktopConsole` through `projectWorkspace || workspace`, the terminal through
   * `projectWorkspace` alone (docs/migration/i3-terminal-browser.md D6) — and
   * `saveExtra` writes the file without touching it. Updating it here is 0.8.26's
   * `state.workspace = {path: selected, files}`: one assignment, in the one place
   * that changes the directory. `save()` carries `projectWorkspace` through
   * unchanged (app/settings.ts line 147), so a later Portal save preserves it, and
   * `load()` reads it back from the key written above. IM, 2026-09-16. */
  const selectProject = async (project: string): Promise<ShellSidebarState> => {
    const chosen = assertSavedProject(saved(), scope(), workspace(), project);
    await ctx.store.saveExtra({ workspace: chosen });
    ctx.store.settings.projectWorkspace = chosen;
    const current = state();
    push(current);
    // `desktopTools?.changed()`: the console pane's「在 X 运行」and the bridge's
    // own snapshot both carry the workspace, and nothing else will push them.
    try { ctx.registry.get('tools')?.tools?.changed(); }
    catch (error) { ctx.onError('shell-state-tools-change', error); }
    return current;
  };

  registerShellStateIpc({
    handle: ctx.handle, exclusive: ctx.exclusive, state,
    apply: (action: ShellSidebarAction) => commit(updateSidebar(saved(), scope(), workspace(), action, conversations())),
    addProject: (project: string) => commit(addSidebarProject(saved(), scope(), workspace(), project)),
    selectProject,
  });

  return {
    key: 'shell-state',
    sidebar: state,
    // A different Being is a different set of pins, and the renderer is holding
    // the previous one. Synchronous and cheap by contract (./types.ts): this runs
    // inside main.ts's `verifyConnection`, which is already inside `exclusive`.
    connectionVerified() {
      try { push(state()); }
      catch (error) { ctx.onError('shell-state-publish', error); }
    },
    async connectionCleared() {
      try { push(state()); }
      catch (error) { ctx.onError('shell-state-publish', error); }
    },
  };
}
