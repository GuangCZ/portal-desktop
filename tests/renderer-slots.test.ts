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

/** What the modules under test registered at import time, captured before the
 * `afterEach` below empties the shared arrays for the fixture cases. */
const LANDED = {
  panels: PANEL_SLOTS.map(slot => slot.key).sort(),
  sidebar: SIDEBAR_SLOTS.map(slot => slot.key).sort(),
  topbar: TOPBAR_SLOTS.map(slot => slot.key).sort(),
  sheets: SHEET_SLOTS.map(slot => slot.key).sort(),
  models: [...FEATURE_MODELS],
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
  // Was「ships empty」until the first integration unit landed (I3, 2026-09-16).
  // The claim is the same one, stated against what is actually registered: the
  // shell renders the surfaces the landed units appended and nothing else, and a
  // slot that appears here without a line in slots.tsx — or disappears from it —
  // fails this first.
  it("carries exactly the surfaces the landed units registered", () => {
    expect(LANDED.panels).toEqual(["terminal", "tool-browser"]);
    expect(LANDED.sidebar).toEqual([]);
    expect(LANDED.topbar).toEqual(["terminal", "tool-browser"]);
    expect(LANDED.sheets).toEqual([]);
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
  // Same rewrite as the slot case above: the landed units' models, and only
  // those. `AppModel` builds every registered factory in its constructor, so this
  // also proves none of them needs a live shell to be constructed.
  it("builds exactly the models the landed units registered", () => {
    expect(LANDED.models.map(factory => factory.key).sort()).toEqual(["terminal", "toolBrowser"]);
    FEATURE_MODELS.push(...LANDED.models);
    expect(Object.keys(new AppModel(desktop()).features).sort()).toEqual(["terminal", "toolBrowser"]);
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
