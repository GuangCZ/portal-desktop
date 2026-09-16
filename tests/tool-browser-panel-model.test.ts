// The tool browser panel's renderer model; 2026-09-16 (I3, review pass).
//
// The main-process half is covered by tests/tool-browser-integration.test.ts.
// This is the other half, and the one this unit invented rather than ported: the
// viewport handshake, the address field and the show/hide lifecycle exist in
// neither portal-desktop (its shell browser has one page and no tab strip) nor in
// BeingDesktop in this shape (its panel is imperative DOM). What is ported is the
// three RULES, all from BeingDesktop 0.8.26 renderer/desktop-tools.js:
//
//   1. `layout()` dedupes the viewport on the whole payload, INCLUDING `visible`,
//      and both `show()` and `hide()` route through it — so there is no path that
//      tells the main process something without recording it. A model that hides
//      out of band keeps a cache saying "attached at this rectangle", and the next
//      identical rectangle dedupes itself away: the panel re-opens blank.
//   2. `renderBrowser()` re-seeds the address field from the active tab on EVERY
//      state push unless the field has focus.
//   3. `onsubmit` opens a tab when there is none, and refuses a no-op navigation.
//
// There is no DOM in this suite (vitest.config.ts sets no environment); the model
// takes focus as a flag the panel sets, which is what makes that possible.
import { describe, expect, it } from "vitest";
import { ToolBrowserModel } from "../desktop/renderer/tool-browser/models/tool-browser";
import type { ToolBrowserState, ToolBrowserTab, ToolBrowserViewport } from "../desktop/shared/desktop-types";
import type { DesktopAPI } from "../desktop/shared/types";

const RECT = { x: 40, y: 120, width: 600, height: 400 };

const tab = (id: string, url: string, over: Partial<ToolBrowserTab> = {}): ToolBrowserTab =>
  ({ id, title: "", url, isLoading: false, canGoBack: false, canGoForward: false, error: "", notice: "", revision: 1, ...over });

const stateOf = (tabs: ToolBrowserTab[], activeTabId: string | null = tabs[0]?.id ?? null, visible = true): ToolBrowserState =>
  ({ tabs, activeTabId, visible });

function fixture() {
  const calls: { name: string; value: unknown }[] = [];
  const listeners: ((value: ToolBrowserState) => void)[] = [];
  let snapshot: ToolBrowserState = { tabs: [], activeTabId: null, visible: false };
  let fail: Error | null = null;
  const answer = (name: string, value: unknown) => {
    calls.push({ name, value });
    return fail ? Promise.reject(fail) : Promise.resolve(snapshot);
  };
  const api = {
    toolBrowser: {
      state: () => answer("state", null),
      newTab: (value: unknown) => answer("newTab", value),
      activateTab: (id: string) => answer("activateTab", id),
      closeTab: (id: string) => answer("closeTab", id),
      navigate: (value: unknown) => answer("navigate", value),
      goBack: (id?: string) => answer("goBack", id),
      goForward: (id?: string) => answer("goForward", id),
      reload: (id?: string) => answer("reload", id),
      stop: (id?: string) => answer("stop", id),
      setViewport: (value: ToolBrowserViewport) => answer("setViewport", value),
      onState: (callback: (value: ToolBrowserState) => void) => {
        listeners.push(callback);
        return () => { const at = listeners.indexOf(callback); if (at >= 0) listeners.splice(at, 1); };
      },
    },
  } as unknown as DesktopAPI;
  const toasted: unknown[] = [];
  const model = new ToolBrowserModel(api, { toast: error => toasted.push(error) });
  return {
    model, calls, toasted, listeners,
    /** What the main process was actually told about the rectangle, in order. */
    viewports: () => calls.filter(call => call.name === "setViewport").map(call => call.value as ToolBrowserViewport),
    answerWith: (next: ToolBrowserState) => { snapshot = next; },
    failWith: (error: Error | null) => { fail = error; },
    push: (next: ToolBrowserState) => { snapshot = next; for (const listener of [...listeners]) listener(next); },
    settle: async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); },
  };
}

describe("tool browser panel model", () => {
  // Finding 1 of the I3 review, as the user meets it: the topbar button is the
  // only way in, so the second click is where the feature either works or is
  // permanently blank.
  it("re-attaches the view when the panel is re-opened at the rectangle it had before", async () => {
    const f = fixture();
    const stop = f.model.start();
    await f.settle();

    // Open, and the panel's layout effect reports its placeholder.
    f.model.show();
    f.model.setViewport(RECT, true);
    await f.settle();
    expect(f.viewports()).toEqual([{ visible: true, bounds: RECT }]);

    // 收起浏览器. The view must detach, or it sits over the conversation.
    f.model.hide();
    await f.settle();
    expect(f.viewports().at(-1)).toEqual({ visible: false });

    // The topbar button again. The panel re-mounts and reports the SAME rectangle,
    // because nothing about the window moved.
    f.model.show();
    f.model.setViewport(RECT, true);
    await f.settle();
    expect(f.viewports().at(-1)).toEqual({ visible: true, bounds: RECT });
    expect(f.model.open).toBe(true);
    stop();
  });

  it("sends nothing when neither the rectangle nor the visibility moved", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.model.setViewport(RECT, true);
    f.model.setViewport({ ...RECT }, true);
    f.model.setViewport({ ...RECT }, true);
    await f.settle();
    expect(f.viewports()).toEqual([{ visible: true, bounds: RECT }]);
    // A moved rectangle is a new payload, deduped against the one before it.
    f.model.setViewport({ ...RECT, y: 130 }, true);
    await f.settle();
    expect(f.viewports()).toHaveLength(2);
    stop();
  });

  it("retries the rectangle after a failed send instead of trusting it landed", async () => {
    const f = fixture();
    const stop = f.model.start();
    await f.settle();
    f.failWith(new Error("内置浏览器在当前运行环境不可用。"));
    f.model.setViewport(RECT, true);
    await f.settle();
    expect(f.toasted).toHaveLength(1);
    // BeingDesktop clears `lastViewport` on failure (renderer/desktop-tools.js),
    // so the next layout at the same rectangle sends again.
    f.failWith(null);
    f.model.setViewport(RECT, true);
    await f.settle();
    expect(f.viewports()).toHaveLength(2);
    stop();
  });

  it("detaches the view when the panel is torn down, and stops accepting pushes", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.model.show();
    f.model.setViewport(RECT, true);
    await f.settle();

    stop();
    await f.settle();
    expect(f.viewports().at(-1)).toEqual({ visible: false });
    expect(f.model.open).toBe(false);
    expect(f.listeners).toHaveLength(0);

    // A push that raced the teardown must not revive the panel's state.
    f.model.accept(stateOf([tab("t1", "https://example.com/")]));
    expect(f.model.open).toBe(false);
  });

  // Finding 3: the address bar has to follow an in-tab navigation, not only a tab
  // switch. BeingDesktop's rule is `renderBrowser()`'s
  // `if(document.activeElement!==$('browser-address'))`.
  it("follows the active tab's URL on every push, including a navigation inside one tab", () => {
    const f = fixture();
    f.model.accept(stateOf([tab("t1", "https://example.com/")]));
    expect(f.model.address).toBe("https://example.com/");
    // A link click, a redirect, or `example.com` normalised to `https://example.com/`.
    f.model.accept(stateOf([tab("t1", "https://example.com/deep/page")]));
    expect(f.model.address).toBe("https://example.com/deep/page");
    // A tab switch still works, and closing the last tab empties the field.
    f.model.accept(stateOf([tab("t1", "https://example.com/deep/page"), tab("t2", "https://two.example/")], "t2"));
    expect(f.model.address).toBe("https://two.example/");
    f.model.accept(stateOf([], null));
    expect(f.model.address).toBe("");
  });

  it("leaves the address alone while the field has focus, and resumes after it", () => {
    const f = fixture();
    f.model.accept(stateOf([tab("t1", "https://example.com/")]));
    f.model.setEditing(true);
    f.model.setAddress("https://typing.example/half");
    // The page navigating underneath must not rewrite what is being typed.
    f.model.accept(stateOf([tab("t1", "https://example.com/moved")]));
    expect(f.model.address).toBe("https://typing.example/half");
    // Leaving the field does not snap it back — BeingDesktop re-seeds on the next
    // render, not on blur — but the next push does.
    f.model.setEditing(false);
    expect(f.model.address).toBe("https://typing.example/half");
    f.model.accept(stateOf([tab("t1", "https://example.com/moved")]));
    expect(f.model.address).toBe("https://example.com/moved");
  });

  it("opens a tab when there is none, navigates the tab the address belongs to, and refuses a no-op", async () => {
    const f = fixture();
    const stop = f.model.start();
    await f.settle();

    // No tab: `DesktopBrowser.navigate` cannot create one, so this is `newTab`.
    f.model.setEditing(true);
    f.model.setAddress("  https://example.com/  ");
    f.answerWith(stateOf([tab("t1", "https://example.com/")]));
    f.model.submit();
    await f.settle();
    expect(f.calls.filter(call => call.name === "newTab")).toEqual([{ name: "newTab", value: { url: "https://example.com/" } }]);
    // The answer re-seeds the field, which is how the normalised URL gets there.
    f.model.setEditing(false);
    f.model.accept(stateOf([tab("t1", "https://example.com/")]));
    expect(f.model.address).toBe("https://example.com/");

    // Enter on the address already shown is not a navigation (BeingDesktop's
    // `if(active?.url===url)return;`); reloading is the reload button's job.
    f.model.submit();
    await f.settle();
    expect(f.calls.some(call => call.name === "navigate")).toBe(false);

    // A changed address navigates the active tab, named by id.
    f.model.setEditing(true);
    f.model.setAddress("https://two.example/");
    f.model.submit();
    await f.settle();
    expect(f.calls.filter(call => call.name === "navigate"))
      .toEqual([{ name: "navigate", value: { id: "t1", url: "https://two.example/" } }]);

    // An empty field does nothing at all.
    f.model.setAddress("   ");
    f.model.submit();
    await f.settle();
    expect(f.calls.filter(call => call.name === "navigate")).toHaveLength(1);
    stop();
  });

  it("reports a failed action to the host instead of throwing into the panel", async () => {
    const f = fixture();
    const stop = f.model.start();
    await f.settle();
    f.failWith(Object.assign(new Error("请输入完整网址。"), { code: "INVALID_REQUEST" }));
    f.model.setAddress("not a url");
    f.model.submit();
    await f.settle();
    expect(f.toasted).toHaveLength(1);
    expect((f.toasted[0] as Error).message).toBe("请输入完整网址。");
    stop();
  });

  it("says why the browser is missing when the first read refuses, and forgets it once one arrives", async () => {
    const f = fixture();
    f.failWith(new Error("内置浏览器在当前运行环境不可用。"));
    const stop = f.model.start();
    await f.settle();
    expect(f.model.unavailable).toBe("内置浏览器在当前运行环境不可用。");
    // A state pushed later means it was built after all.
    f.failWith(null);
    f.push(stateOf([tab("t1", "https://example.com/")]));
    expect(f.model.unavailable).toBe("");
    stop();
  });

  it("ignores a malformed push rather than emptying the tab strip", () => {
    const f = fixture();
    f.model.accept(stateOf([tab("t1", "https://example.com/")]));
    f.model.accept(undefined as unknown as ToolBrowserState);
    f.model.accept({ tabs: null } as unknown as ToolBrowserState);
    expect(f.model.tabs).toHaveLength(1);
    expect(f.model.address).toBe("https://example.com/");
  });
});
