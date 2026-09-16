// The renderer half of the I0 seam; 2026-09-16.
//
// `page.tsx`, `sidebar.tsx` and `topbar.tsx` read these four arrays and never
// change again, so what has to hold is the contract five branches append into:
// position in the array carries no meaning, `order` then `key` decides, a panel's
// own predicate decides whether it is mounted, and a sheet answers for exactly one
// view. There is no DOM environment in this suite, and the slot module imports
// nothing at runtime (its React imports are type-only), so this exercises the real
// module rather than a copy of its rules.
//
// The second half is the model half of the same seam: a feature's model is built
// by the real `AppModel`, and what has to hold there is that it gets the lifecycle
// the built-in models get — subscribed, started, and stopped again with the shell
// — because `models/app.ts` is not a file any integration unit may edit.
import { afterEach, describe, expect, it } from "vitest";
import {
  PANEL_SLOTS, SHEET_SLOTS, SIDEBAR_SLOTS, TOPBAR_SLOTS,
  sidebarSections, topbarActions, viewSheets, visiblePanels,
  type PanelSlot, type SheetSlot, type SidebarSlot, type TopbarSlot,
} from "../desktop/renderer/app/slots";
import { FEATURE_MODELS, type AppFeatureModels } from "../desktop/renderer/app/models/registry";
import { AppModel } from "../desktop/renderer/app/models/app";
import { Store } from "../desktop/renderer/shared/models/store";
import type { DesktopAPI } from "../desktop/shared/types";

const Nothing = () => null;
const app = {} as AppModel;

/** The five registries as the landed units left them, taken at import time —
 * before any `afterEach` has run. The two roll-call cases put them back before
 * asserting, so what they assert is the production registry rather than whatever
 * the case that happened to run first left behind. */
const SHIPPED = {
  panels: [...PANEL_SLOTS],
  sidebar: [...SIDEBAR_SLOTS],
  topbar: [...TOPBAR_SLOTS],
  sheets: [...SHEET_SLOTS],
  models: [...FEATURE_MODELS],
};
const shipped = () => {
  PANEL_SLOTS.splice(0, PANEL_SLOTS.length, ...SHIPPED.panels);
  SIDEBAR_SLOTS.splice(0, SIDEBAR_SLOTS.length, ...SHIPPED.sidebar);
  TOPBAR_SLOTS.splice(0, TOPBAR_SLOTS.length, ...SHIPPED.topbar);
  SHEET_SLOTS.splice(0, SHEET_SLOTS.length, ...SHIPPED.sheets);
  FEATURE_MODELS.splice(0, FEATURE_MODELS.length, ...SHIPPED.models);
};

afterEach(() => {
  PANEL_SLOTS.length = 0;
  SIDEBAR_SLOTS.length = 0;
  TOPBAR_SLOTS.length = 0;
  SHEET_SLOTS.length = 0;
  FEATURE_MODELS.length = 0;
});

const panel = (key: string, order: number, visible: (app: AppModel) => boolean = () => true): PanelSlot =>
  ({ key, title: key, order, Panel: Nothing, visible });
const section = (key: string, order: number, placement: SidebarSlot["placement"]): SidebarSlot =>
  ({ key, order, placement, Section: Nothing });
const action = (key: string, order: number): TopbarSlot => ({ key, order, Action: Nothing });
const sheet = (key: string, view: string): SheetSlot => ({ key, view, Sheet: Nothing });

describe("the renderer slot registry", () => {
  // Every landed unit appends one line to these arrays, so this is the roll call:
  // it names what is registered, in which region, rather than asserting nothing is
  // (which it did until the first unit landed). A unit that appends without saying
  // so here fails, which is the point.
  // `afterEach` empties the real arrays so the cases below can push fakes into
  // them, so this one restores what was imported first and does not care whether
  // it runs first.
  it("registers exactly the surfaces the landed units declare", () => {
    shipped();
    expect(PANEL_SLOTS.map(slot => slot.key)).toEqual([]);
    expect(SIDEBAR_SLOTS.map(slot => `${slot.placement}:${slot.key}`)).toEqual(["foot:shell-pages"]);
    expect(TOPBAR_SLOTS.map(slot => slot.key)).toEqual([]);
    expect(SHEET_SLOTS.map(slot => `${slot.view}:${slot.key}`)).toEqual([]);
    expect(FEATURE_MODELS.map(feature => feature.key)).toEqual(["shellState"]);
    expect(Object.keys(new AppModel(desktop()).features)).toEqual(["shellState"]);
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

/** A feature model as an integration unit will write one: a `Store` that owns
 * something which has to be opened and closed again. */
class Feature extends Store {
  started = 0;
  stopped = 0;
  start() {
    this.started++;
    return () => { this.stopped++; };
  }
}
class BrokenStart extends Store {
  start(): () => void { throw new Error("feature failed to start"); }
}
class BrokenStop extends Store {
  start() { return () => { throw new Error("feature failed to stop"); }; }
}
declare module "../desktop/renderer/app/models/registry" {
  interface AppFeatureModels {
    "test-feature": Feature;
    "test-broken-start": BrokenStart;
    "test-broken-stop": BrokenStop;
  }
}

/** Only what `AppModel.start()` reaches for. The shell's own data flow is
 * tests/renderer-state.test.ts's subject; this file's is the seam. */
const desktop = () => ({
  appearance: async () => "light",
  snapshot: async () => ({ settings: { hasToken: false }, portal: { phase: "stopped", message: "", logs: [] } }),
  updateState: async () => ({ phase: "idle" }),
  onPortal: () => () => {},
  onUpdate: () => () => {},
  onTownLive: () => () => {},
  townLive: async () => { throw new Error("no Town in this fixture"); },
}) as unknown as DesktopAPI;

/** Registers a prebuilt model, the way a unit's own factory would. The keys come
 * from the `declare module` block above — the augmentation IS the mechanism, so
 * the fakes use it rather than casting past it. */
const register = <K extends keyof AppFeatureModels>(key: K, model: AppFeatureModels[K]) => {
  FEATURE_MODELS.push({ key, create: () => model });
};

describe("the renderer feature-model registry", () => {
  // Exactly the registered models, and nothing the shell invented: the production
  // registry builds the keys it names, and an empty one builds nothing at all.
  // Both halves are asserted here rather than relying on this case running before
  // `afterEach` has emptied the registry — an emptied array being empty is not the
  // claim.
  it("builds exactly the models that are registered, and no others", () => {
    shipped();
    expect(Object.keys(new AppModel(desktop()).features)).toEqual(SHIPPED.models.map(feature => feature.key));
    FEATURE_MODELS.length = 0;
    expect(new AppModel(desktop()).features).toEqual({});
  });

  // The point of the whole case: a model registered here gets the same lifecycle
  // the built-in `town` model gets. Without it an IPC subscription opened in a
  // feature's constructor would have nothing to close it, and I1, I4 and I6 all
  // need one.
  it("starts each registered model with the shell and stops it with the shell", () => {
    const model = new Feature();
    register("test-feature", model);
    const shell = new AppModel(desktop());
    expect(shell.features["test-feature"]).toBe(model);
    expect(model.started).toBe(0);
    const stop = shell.start();
    expect([model.started, model.stopped]).toEqual([1, 0]);
    // Its changes still reach the shell, which is the half that already worked.
    const before = shell.getVersion();
    model.changed();
    expect(shell.getVersion()).toBeGreaterThan(before);
    stop();
    expect([model.started, model.stopped]).toEqual([1, 1]);
    // And nothing runs it twice: a second mount starts it again exactly once.
    shell.start()();
    expect([model.started, model.stopped]).toEqual([2, 2]);
  });

  it("carries on when one model fails to start, and reports it", () => {
    const healthy = new Feature();
    register("test-broken-start", new BrokenStart());
    register("test-feature", healthy);
    const shell = new AppModel(desktop());
    const stop = shell.start();
    expect(shell.toastMessage).toContain("feature failed to start");
    // The healthy one still started, and the shell itself is live.
    expect(healthy.started).toBe(1);
    stop();
    expect(healthy.stopped).toBe(1);
  });

  it("finishes teardown when one model fails to stop", () => {
    const healthy = new Feature();
    register("test-broken-stop", new BrokenStop());
    register("test-feature", healthy);
    const shell = new AppModel(desktop());
    const stop = shell.start();
    expect(() => stop()).not.toThrow();
    expect(healthy.stopped).toBe(1);
  });
});
