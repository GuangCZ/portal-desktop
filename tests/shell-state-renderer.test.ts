// The renderer half of the sidebar ledger: the projection and the model that
// feeds it. New in the portal-desktop shell on 2026-09-16 (integration unit I6).
//
// The claim under test is the one the whole unit rests on — the main process is
// the truth and the renderer only projects it — so every case here is about what
// the sidebar shows AFTER a change, not about what it sent: a refused change must
// leave the previous ledger on screen, and a Being switch must replace it whole.
//
// The shell is the real `AppModel`, built by the real registry, so the model under
// test is reached exactly the way production reaches it (`app.features.shellState`)
// and the projection it binds to is the real `OrganizerModel` the sidebar renders
// from. Only the bridge is a fake, because it is the process boundary.
import { describe, expect, it, vi } from "vitest";
import { AppModel } from "../desktop/renderer/app/models/app";
import type { DesktopAPI } from "../desktop/shared/types";
import type { ChatSessionSummary, ShellSidebarAction, ShellSidebarState } from "../desktop/shared/desktop-types";

const SCOPE_A = "persist:loom-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SCOPE_B = "persist:loom-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROJECT = "/Users/me/Work";
const ledger = (over: Partial<ShellSidebarState> = {}): ShellSidebarState =>
  ({ scope: SCOPE_A, projects: [], tasks: {}, ...over });
const summary = (id: string, updatedAt: string): ChatSessionSummary =>
  ({ id, title: id, createdAt: Date.parse(updatedAt), updatedAt, truncated: false, count: 1, lastSeq: 1, busy: false, inFlight: false });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(initial: ShellSidebarState = ledger()) {
  const sent: ShellSidebarAction[] = [];
  const listeners = new Set<(state: ShellSidebarState) => void>();
  let answer: ShellSidebarState | Error = initial;
  let chosen: string | null = PROJECT;
  const added: string[] = [];
  const reply = async (): Promise<ShellSidebarState> => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const api = {
    platform: "darwin",
    appearance: async () => "light",
    snapshot: async () => ({ settings: { hasToken: false }, portal: { phase: "stopped", message: "", logs: [] } }),
    updateState: async () => ({ phase: "idle" }),
    onPortal: () => () => {},
    onUpdate: () => () => {},
    onTownLive: () => () => {},
    townLive: async () => { throw new Error("no Town in this fixture"); },
    choose: async () => chosen,
    shellState: {
      sidebar: reply,
      sidebarAction: async (action: ShellSidebarAction) => { sent.push(action); return reply(); },
      addProject: async (project: string) => { added.push(project); return reply(); },
      onSidebar: (callback: (state: ShellSidebarState) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  } as unknown as DesktopAPI;
  const app = new AppModel(api);
  return {
    app, sent, added,
    model: app.features.shellState,
    organizer: app.conversation.organizer,
    listeners,
    /** What the next call answers with — the ledger the main process saved, or
     * the refusal it answered with. */
    answers: (next: ShellSidebarState | Error) => { answer = next; },
    chooses: (next: string | null) => { chosen = next; },
    push: (state: ShellSidebarState) => listeners.forEach(listener => listener(state)),
  };
}

describe("the sidebar's projection of the ledger", () => {
  it("starts bound and subscribed, and lets go of both when the shell stops", async () => {
    const f = fixture(ledger({ projects: [PROJECT], tasks: { one: { pinned: true, archived: false, project: PROJECT, touchedAt: 0 } } }));
    expect(f.organizer.persistent).toBe(false);
    const stop = f.model.start();
    await settle();
    expect(f.organizer.persistent).toBe(true);
    expect(f.organizer.projects).toEqual([PROJECT]);
    expect(f.organizer.metadata("one").pinned).toBe(true);
    expect(f.organizer.scope).toBe(SCOPE_A);
    stop();
    expect(f.organizer.persistent).toBe(false);
    expect(f.listeners.size).toBe(0);
  });

  it("sends the change with the current scope and renders only what came back", async () => {
    const f = fixture();
    const stop = f.model.start();
    await settle();
    f.answers(ledger({ tasks: { one: { pinned: true, archived: false, project: "", touchedAt: 0 } } }));
    await f.organizer.pin("one");
    expect(f.sent).toEqual([{ type: "pin", id: "one", scope: SCOPE_A }]);
    expect(f.organizer.metadata("one").pinned).toBe(true);
    stop();
  });

  it("leaves the sidebar showing what was saved when a change is refused", async () => {
    const f = fixture(ledger({ tasks: { one: { pinned: true, archived: false, project: "", touchedAt: 0 } } }));
    const stop = f.model.start();
    await settle();
    f.answers(new Error("连接已变化，请重试。"));
    await expect(f.organizer.archive("one")).rejects.toThrow(/连接已变化/);
    // Nothing optimistic: the pin is still a pin, and it is not archived.
    expect(f.organizer.metadata("one")).toEqual({ pinned: true, archived: false, project: "", touchedAt: 0 });
    expect(f.model.busy).toBe(false);
    stop();
  });

  it("replaces the whole set when the Being changes underneath it", async () => {
    const f = fixture(ledger({ projects: [PROJECT], tasks: { one: { pinned: true, archived: false, project: PROJECT, touchedAt: 0 } } }));
    const stop = f.model.start();
    await settle();
    f.push(ledger({ scope: SCOPE_B, projects: [PROJECT], tasks: { two: { pinned: false, archived: true, project: "", touchedAt: 0 } } }));
    expect(f.organizer.scope).toBe(SCOPE_B);
    expect(f.organizer.metadata("one")).toEqual({ pinned: false, archived: false, project: "", touchedAt: 0 });
    expect(f.organizer.metadata("two").archived).toBe(true);
    // And the next change carries the new scope, not the one the menu was opened
    // against.
    f.answers(ledger({ scope: SCOPE_B }));
    await f.organizer.pin("two");
    expect(f.sent.at(-1)).toEqual({ type: "pin", id: "two", scope: SCOPE_B });
    stop();
  });

  it("raises a touched conversation above a newer one and groups by the ledger's projects", async () => {
    const list = [summary("old", "2026-09-16T03:00:00Z"), summary("new", "2026-09-16T05:00:00Z")];
    const f = fixture(ledger({
      projects: [PROJECT],
      tasks: { old: { pinned: false, archived: false, project: PROJECT, touchedAt: Date.parse("2026-09-16T06:00:00Z") } },
    }));
    const stop = f.model.start();
    await settle();
    expect(f.organizer.ordered(list).map(session => session.id)).toEqual(["old", "new"]);
    const groups = f.organizer.groups(list);
    expect(groups.projects[0].sessions.map(session => session.id)).toEqual(["old"]);
    expect(groups.standalone.map(session => session.id)).toEqual(["new"]);
    stop();
  });

  it("adds a project folder only after the dialog answers, and files a conversation into it", async () => {
    const f = fixture();
    const stop = f.model.start();
    await settle();
    f.chooses(null);
    expect(await f.model.addProject()).toBe(false);
    expect(f.added).toEqual([]);
    f.chooses(PROJECT);
    f.answers(ledger({ projects: [PROJECT] }));
    expect(await f.model.addProject()).toBe(true);
    expect(f.added).toEqual([PROJECT]);
    expect(f.organizer.projects).toEqual([PROJECT]);
    await f.organizer.move("one", PROJECT);
    await f.organizer.touch("one");
    await f.organizer.removeProject(PROJECT);
    expect(f.sent).toEqual([
      { type: "move", id: "one", project: PROJECT, scope: SCOPE_A },
      { type: "touch", id: "one", scope: SCOPE_A },
      { type: "remove-project", project: PROJECT, scope: SCOPE_A },
    ]);
    stop();
  });

  it("says so when the ledger cannot be read, and keeps the sidebar usable", async () => {
    const f = fixture();
    const toast = vi.spyOn(f.app, "toast");
    f.answers(new Error("设置暂时无法读取。"));
    const stop = f.model.start();
    await settle();
    expect(f.model.error).toMatch(/不会被保存/);
    expect(toast).toHaveBeenCalled();
    // Bound all the same, so the next attempt goes to the main process rather
    // than silently diverging into the renderer's own memory.
    expect(f.organizer.persistent).toBe(true);
    await expect(f.organizer.pin("one")).rejects.toThrow(/设置暂时无法读取/);
    expect(f.organizer.metadata("one").pinned).toBe(false);
    stop();
  });

  it("keeps working in a window with no ledger, with the reducer's own exclusions", async () => {
    const f = fixture();
    // Never started: no bridge, no binding — a test's organizer, and the state a
    // window gets if the subsystem failed to install.
    await f.organizer.pin("one");
    expect(f.organizer.metadata("one").pinned).toBe(true);
    await f.organizer.archive("one");
    expect(f.organizer.metadata("one")).toMatchObject({ pinned: false, archived: true });
    await f.organizer.pin("one");
    expect(f.organizer.metadata("one")).toMatchObject({ pinned: true, archived: false });
    expect(f.sent).toEqual([]);
  });
});
