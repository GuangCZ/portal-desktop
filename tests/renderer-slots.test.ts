// The renderer half of the I0 seam; 2026-09-16.
//
// `page.tsx`, `sidebar.tsx` and `topbar.tsx` read these four arrays and never
// change again, so what has to hold is the contract five branches append into:
// position in the array carries no meaning, `order` then `key` decides, a panel's
// own predicate decides whether it is mounted, and a sheet answers for exactly one
// view. There is no DOM environment in this suite, and the slot module imports
// nothing at runtime (its React imports are type-only), so this exercises the real
// module rather than a copy of its rules.
import { afterEach, describe, expect, it } from "vitest";
import {
  PANEL_SLOTS, SHEET_SLOTS, SIDEBAR_SLOTS, TOPBAR_SLOTS,
  sidebarSections, topbarActions, viewSheets, visiblePanels,
  type PanelSlot, type SheetSlot, type SidebarSlot, type TopbarSlot,
} from "../desktop/renderer/app/slots";
import type { AppModel } from "../desktop/renderer/app/models/app";

const Nothing = () => null;
const app = {} as AppModel;

afterEach(() => {
  PANEL_SLOTS.length = 0;
  SIDEBAR_SLOTS.length = 0;
  TOPBAR_SLOTS.length = 0;
  SHEET_SLOTS.length = 0;
});

const panel = (key: string, order: number, visible: (app: AppModel) => boolean = () => true): PanelSlot =>
  ({ key, title: key, order, Panel: Nothing, visible });
const section = (key: string, order: number, placement: SidebarSlot["placement"]): SidebarSlot =>
  ({ key, order, placement, Section: Nothing });
const action = (key: string, order: number): TopbarSlot => ({ key, order, Action: Nothing });
const sheet = (key: string, view: string): SheetSlot => ({ key, view, Sheet: Nothing });

describe("the renderer slot registry", () => {
  it("ships empty, so the shell renders exactly what it did before any unit landed", () => {
    expect([PANEL_SLOTS, SIDEBAR_SLOTS, TOPBAR_SLOTS, SHEET_SLOTS].map(list => list.length)).toEqual([0, 0, 0, 0]);
  });

  it("orders by `order` then `key`, whichever order the branches appended in", () => {
    PANEL_SLOTS.push(panel("terminal", 200), panel("console", 100), panel("browser", 100));
    expect(visiblePanels(app).map(slot => slot.key)).toEqual(["browser", "console", "terminal"]);
    TOPBAR_SLOTS.push(action("z", 100), action("a", 100));
    expect(topbarActions().map(slot => slot.key)).toEqual(["a", "z"]);
    // Sorting must not reorder the shared array itself: two units appending is a
    // textual merge, and a sort in place would make the file churn.
    expect(TOPBAR_SLOTS.map(slot => slot.key)).toEqual(["z", "a"]);
  });

  it("mounts a panel only while its own predicate says so", () => {
    PANEL_SLOTS.push(panel("always", 100), panel("never", 200, () => false));
    expect(visiblePanels(app).map(slot => slot.key)).toEqual(["always"]);
  });

  it("keeps the three sidebar regions apart", () => {
    SIDEBAR_SLOTS.push(section("bonfire", 200, "head"), section("workers", 100, "scroll"), section("fireside", 100, "head"));
    expect(sidebarSections("head").map(slot => slot.key)).toEqual(["fireside", "bonfire"]);
    expect(sidebarSections("scroll").map(slot => slot.key)).toEqual(["workers"]);
    expect(sidebarSections("foot")).toEqual([]);
  });

  it("answers a sheet for its own view and for no other", () => {
    SHEET_SLOTS.push(sheet("town-desktop", "town-desktop"), sheet("orchestration", "orchestration"));
    expect(viewSheets("town-desktop").map(slot => slot.key)).toEqual(["town-desktop"]);
    expect(viewSheets("chat")).toEqual([]);
  });
});
