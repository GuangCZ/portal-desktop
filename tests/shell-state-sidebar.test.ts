// The sidebar ledger's rules. Ported from BeingDesktop 0.8.26
// test/sidebar-state.test.cjs, case for case, with the same fixture ids and the
// same assertions; 2026-09-16.
//
// The five ported cases are the contract 0.8.26 ships with. The three after them
// cover what this shell added: `addSidebarProject` (0.8.26 does it inline in its
// `selectWorkspace` handler, so it had no test of its own) and the two boundaries
// the reducer is expected to hold against a hand-edited profile.
import { describe, expect, it } from "vitest";
import { addSidebarProject, sidebarState, updateSidebar, validPath } from "../desktop/main/shell/sidebar-state";

const one = "11111111-1111-4111-8111-111111111111";
const two = "22222222-2222-4222-8222-222222222222";

describe("the sidebar ledger", () => {
  it("isolates changes by Being connection and rejects stale requests", () => {
    const saved = updateSidebar({}, "owner-a", "/work", { scope: "owner-a", type: "pin", id: one }, [one]);
    expect(sidebarState(saved, "owner-a").tasks[one].pinned).toBe(true);
    expect(sidebarState(saved, "owner-b").tasks).toEqual({});
    expect(() => updateSidebar(saved, "owner-b", "", { scope: "owner-a", type: "archive", id: one }, [one])).toThrow(/连接已变化/);
    expect(() => updateSidebar(saved, "owner-a", "", { scope: "owner-a", type: "pin", id: two }, [one])).toThrow(/会话不存在/);
  });

  it("preserves the session and its project when archiving, and reverses", () => {
    let saved = updateSidebar({}, "a", "/work", { scope: "a", type: "move", id: one, project: "/work" }, [one]);
    saved = updateSidebar(saved, "a", "/work", { scope: "a", type: "pin", id: one }, [one]);
    saved = updateSidebar(saved, "a", "/work", { scope: "a", type: "archive", id: one }, [one]);
    expect(sidebarState(saved, "a").tasks[one]).toEqual({ pinned: false, archived: true, project: "/work", touchedAt: 0 });
    saved = updateSidebar(saved, "a", "/work", { scope: "a", type: "archive", id: one }, [one]);
    expect(sidebarState(saved, "a").tasks[one].archived).toBe(false);
  });

  it("rejects an invalid project and keeps the tasks of one that is removed", () => {
    let saved = updateSidebar({ projects: ["/a", "/b"] }, "a", "/b", { scope: "a", type: "move", id: one, project: "/a" }, [one]);
    expect(() => updateSidebar(saved, "a", "/b", { scope: "a", type: "move", id: one, project: "/unknown" }, [one])).toThrow(/项目不存在/);
    saved = updateSidebar(saved, "a", "/b", { scope: "a", type: "remove-project", project: "/a" }, [one]);
    expect(sidebarState(saved, "a").projects).toEqual(["/b"]);
    expect(sidebarState(saved, "a").tasks[one].project).toBe("");
  });

  it("normalizes malformed values on read without changing the saved object", () => {
    const saved = {
      projects: ["/a", "/a", "relative", "/bad\0path", "C:\\work"],
      owners: { a: { tasks: { [one]: { pinned: "true", archived: false, project: "/missing", touchedAt: "secret", credential: "never exposed" }, bad: { pinned: true } } } },
    };
    const original = structuredClone(saved);
    const result = sidebarState(saved, "a");
    expect(result.projects).toEqual(["/a", "C:\\work"]);
    expect(result.tasks).toEqual({ [one]: { pinned: false, archived: false, project: "", touchedAt: 0 } });
    expect(saved).toEqual(original);
  });

  it("does not re-add the current project after removing it, and works while disconnected", () => {
    const saved = updateSidebar({}, "", "/work", { scope: "", type: "remove-project", project: "/work" });
    expect(sidebarState(saved, "", "/work").projects).toEqual([]);
    expect(saved.owners).toEqual({});
  });

  // ── This shell's own additions ──────────────────────────────────────────────

  it("adds a chosen folder once, keeps the rest of the profile, and refuses a relative one", () => {
    const saved = addSidebarProject({ credential: "kept", owners: { a: { tasks: {} } } }, "a", "", "/Users/me/Projects");
    expect(saved.credential).toBe("kept");
    expect(sidebarState(saved, "a").projects).toEqual(["/Users/me/Projects"]);
    const again = addSidebarProject(saved, "a", "", "/Users/me/Projects");
    expect(sidebarState(again, "a").projects).toEqual(["/Users/me/Projects"]);
    expect(() => addSidebarProject(saved, "a", "", "Projects")).toThrow(/本机文件夹/);
    expect(() => addSidebarProject(saved, "a", "", "/tmp/a\u0001b")).toThrow(/本机文件夹/);
    expect(() => addSidebarProject({ projects: Array.from({ length: 100 }, (_, index) => `/p${index}`) }, "a", "", "/one-too-many")).toThrow(/最多 100 个/);
  });

  it("keeps a touch out of the other Being's bucket and raises only the task it names", () => {
    const first = updateSidebar({}, "a", "", { scope: "a", type: "touch", id: one }, [one, two], 1_700_000_000_000);
    const both = updateSidebar(first, "a", "", { scope: "a", type: "pin", id: two }, [one, two]);
    expect(sidebarState(both, "a").tasks[one]).toEqual({ pinned: false, archived: false, project: "", touchedAt: 1_700_000_000_000 });
    expect(sidebarState(both, "a").tasks[two].touchedAt).toBe(0);
    expect(sidebarState(both, "b").tasks).toEqual({});
  });

  it("refuses an unknown action and never lets a prototype key become a task", () => {
    expect(() => updateSidebar({}, "a", "", { type: "sudo", id: one, scope: "a" } as never, [one])).toThrow(/侧栏操作无效/);
    const poisoned = sidebarState({ owners: { a: { tasks: { __proto__: { pinned: true }, constructor: { pinned: true } } } } }, "a");
    expect(poisoned.tasks).toEqual({});
    expect(({} as Record<string, unknown>).pinned).toBeUndefined();
    expect(validPath("/a")).toBe(true);
    expect(validPath(123)).toBe(false);
  });
});
