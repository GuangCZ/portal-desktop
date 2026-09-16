// The renderer's half of the sidebar ledger; 2026-09-16 (integration unit I6).
//
// The main process owns the ledger — pins, archives, project folders, bucketed by
// Being and written to settings.json — and this model is the projection of it.
// It holds no decisions of its own: every change goes out as an IPC call and
// comes back as the ledger the main process saved, either as that call's answer
// or as the `beings:sidebar` push that follows it. Two windows, or a menu left
// open across a Being switch, therefore cannot disagree about what is pinned.
//
// It also owns the two static pages (关于 / 隐私说明), which are state rather than
// routing: they open over whatever the user was doing and close back to it.
import { Store } from "../../shared/models/store";
import type { DesktopAPI } from "../../../shared/types";
import type { ShellSidebarAction, ShellSidebarState } from "../../../shared/desktop-types";

/** The sidebar's projection, structurally — `OrganizerModel`. Declared here
 * rather than imported so the conversation layer and this one stay independent:
 * the only thing they share is the ledger's shape. */
export interface SidebarProjection {
  /** A ledger from the main process, to render from now on. */
  applyLedger(state: ShellSidebarState): void;
  /** Where the projection sends changes, or `null` to go back to its own memory
   * (which is what a test, or a window with no bridge, gets). */
  bindLedger(ledger: { act(action: ShellSidebarAction): Promise<void> } | null): void;
}

/** What this model needs of `AppModel`. Narrow on purpose: the registry hands
 * factories the shell as `unknown` (app/models/registry.ts) precisely so a
 * feature cannot start depending on all of it. */
export interface ShellStateHost {
  toast(error: unknown): void;
  conversation: { organizer: SidebarProjection };
}

export type ShellPage = "" | "about" | "privacy";

const EMPTY: ShellSidebarState = { scope: "", projects: [], tasks: {} };

const host = (value: unknown): ShellStateHost | null => {
  const app = value as Partial<ShellStateHost> | null;
  return app && typeof app.toast === "function" && app.conversation?.organizer ? (app as ShellStateHost) : null;
};

export class ShellStateModel extends Store {
  sidebar: ShellSidebarState = EMPTY;
  /** Which static page is open, if any. */
  page: ShellPage = "";
  /** A change is in flight. The sidebar disables its own entries rather than
   * letting a second click queue behind the first, as 0.8.26 does with its
   * `busy` flag (renderer/sidebar.js line 36). */
  busy = false;
  /** Set when the first read failed, so the sidebar can say the ledger is not
   * being saved instead of quietly behaving like the old in-memory one. */
  error = "";

  constructor(private readonly api: DesktopAPI, private readonly app: unknown) { super(); }

  /** Opened here rather than in the constructor, and closed by the returned
   * function: the contract every registered model follows (app/models/registry.ts).
   * Subscribing before the first read, so a change made while it is in flight is
   * not the one that gets overwritten. */
  start() {
    const shell = host(this.app);
    // No bridge, no binding: the projection keeps its own entries, the sidebar
    // still works, and nothing pretends to have been saved. The only way to be
    // here is a preload without this unit's channels.
    if (!this.api?.shellState) return () => {};
    const stop = this.api.shellState.onSidebar(state => this.accept(state));
    shell?.conversation.organizer.bindLedger({ act: action => this.act(action) });
    void this.refresh();
    return () => {
      stop();
      shell?.conversation.organizer.bindLedger(null);
    };
  }

  async refresh() {
    if (!this.api?.shellState) return;
    try { this.accept(await this.api.shellState.sidebar()); }
    catch (error) {
      // The sidebar still works — it just will not remember. Say so once.
      this.error = "侧栏的置顶与项目暂时无法读取，这次的改动不会被保存。";
      this.changed();
      host(this.app)?.toast(error);
    }
  }

  private accept(state: ShellSidebarState) {
    this.sidebar = state;
    this.error = "";
    host(this.app)?.conversation.organizer.applyLedger(state);
    this.changed();
  }

  /** One change, to the Being that is connected now. The scope travels with the
   * action so a request composed against the previous Being is refused by the
   * main process rather than applied to this one. */
  private async act(action: ShellSidebarAction) {
    if (!this.api?.shellState) throw new Error("侧栏的置顶与项目暂时无法保存。");
    this.busy = true;
    this.changed();
    try { this.accept(await this.api.shellState.sidebarAction(action)); }
    finally {
      this.busy = false;
      this.changed();
    }
  }

  /** The directory dialog, then the ledger. Cancelling answers `null` and is not
   * a failure. Answers whether a folder was added, for the caller's own feedback. */
  async addProject(): Promise<boolean> {
    if (this.busy || !this.api?.shellState) return false;
    this.busy = true;
    this.changed();
    try {
      const chosen = await this.api.choose("workspace");
      if (!chosen) return false;
      this.accept(await this.api.shellState.addProject(chosen));
      return true;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  open(page: ShellPage) {
    this.page = page;
    this.changed();
  }
}

/** What a component falls back to when this model is not on `AppModel` at all.
 * `AppModel` catches a factory that throws and carries on without the key
 * (app/models/app.ts: "A broken feature model must not stop the conversation
 * opening"), so a component that read `app.features.shellState` blind would turn
 * one broken model into a window that renders nothing — undoing the isolation that
 * catch exists for. This one holds no bridge and no shell: it reads as an empty
 * ledger, `addProject` answers false, and the two static pages still open. */
export const NO_SHELL_STATE = new ShellStateModel(undefined as unknown as DesktopAPI, null);

declare module "../../app/models/registry" {
  interface AppFeatureModels {
    shellState: ShellStateModel;
  }
}
