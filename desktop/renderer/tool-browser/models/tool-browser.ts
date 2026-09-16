// The tool browser panel's state; 2026-09-16.
//
// The Being-operable browser (main/tools/browser/browser.ts, ported from
// BeingDesktop 0.8.26 src/desktop-browser.cjs) — sixteen tabs, its own partition,
// pages a Being may read and act on. NOT the shell browser, whose state lives in
// renderer/browser/page.tsx and whose partition is different on purpose
// (integration plan §5.6).
//
// The pages themselves are native `WebContentsView`s the main process attaches to
// the window. All this model holds is the tab strip, the address the user is
// typing, and the rectangle the panel occupies — the last of which the main
// process needs, because a view that is not told where the panel is would cover
// the conversation.
import { Store } from "../../shared/models/store";
import type { ToolBrowserBounds, ToolBrowserState, ToolBrowserTab } from "../../../shared/desktop-types";
import type { DesktopAPI } from "../../../shared/types";
import type { FeatureModelFactory } from "../../app/models/registry";

export interface ToolBrowserHost {
  toast(error: unknown): void;
}

const EMPTY: ToolBrowserState = { tabs: [], activeTabId: null, visible: false };

export class ToolBrowserModel extends Store {
  state: ToolBrowserState = EMPTY;
  /** Whether the panel is on screen. The panel owns this (app/slots.tsx). */
  open = false;
  /** What is in the address field, which is not the active tab's URL while the
   * user is typing. */
  address = "";
  /** The browser could not be built at all — no Electron in this process. */
  unavailable = "";
  private lifecycle = 0;
  private bounds: ToolBrowserBounds & { visible: boolean } = { x: 0, y: 0, width: 0, height: 0, visible: false };

  constructor(private readonly api: DesktopAPI, private readonly host: ToolBrowserHost) {
    super();
  }

  start(): () => void {
    const revision = ++this.lifecycle;
    const stop = this.api.toolBrowser.onState(state => { if (revision === this.lifecycle) this.accept(state); });
    void this.api.toolBrowser
      .state()
      .then(state => { if (revision === this.lifecycle) this.accept(state); })
      .catch(() => { /* The first read fails only when the browser is unavailable; the panel says so on its first action. */ });
    return () => {
      this.lifecycle++;
      stop();
      this.open = false;
      // Detach the native view: the panel is gone, and a view left attached would
      // sit on top of the conversation.
      void this.api.toolBrowser.setViewport({ visible: false }).catch(() => { /* Shutting down. */ });
    };
  }

  get tabs(): ToolBrowserTab[] { return this.state.tabs; }

  get active(): ToolBrowserTab | undefined {
    return this.state.tabs.find(tab => tab.id === this.state.activeTabId);
  }

  accept(state: ToolBrowserState): void {
    if (!state || !Array.isArray(state.tabs)) return;
    const previous = this.state.activeTabId;
    this.state = state;
    // Follow the active tab's address unless the user is editing the field. The
    // field is uncontrolled while focused; the panel passes `editing`.
    if (previous !== state.activeTabId) this.address = this.active?.url || "";
    this.changed();
  }

  setAddress(value: string): void {
    this.address = value;
    this.changed();
  }

  show(): void { this.open = true; this.changed(); }

  hide(): void {
    this.open = false;
    this.changed();
    void this.api.toolBrowser.setViewport({ visible: false }).catch(() => { /* Already detached. */ });
  }

  toggle(open = !this.open): void { if (open) this.show(); else this.hide(); }

  /** Where the panel's placeholder is. Called from layout, so it is deliberately
   * cheap when nothing moved: a `WebContentsView` re-attaches on every call. */
  setViewport(bounds: ToolBrowserBounds, visible: boolean): void {
    const next = { ...bounds, visible };
    if (next.visible === this.bounds.visible && next.x === this.bounds.x && next.y === this.bounds.y
      && next.width === this.bounds.width && next.height === this.bounds.height) return;
    this.bounds = next;
    void this.api.toolBrowser.setViewport({ visible, bounds }).then(
      state => this.accept(state),
      error => { if (visible) this.host.toast(error); },
    );
  }

  newTab(url?: string): void { void this.run(() => this.api.toolBrowser.newTab(url ? { url } : {})); }
  activateTab(id: string): void { void this.run(() => this.api.toolBrowser.activateTab(id)); }
  closeTab(id: string): void { void this.run(() => this.api.toolBrowser.closeTab(id)); }
  goBack(): void { void this.run(() => this.api.toolBrowser.goBack()); }
  goForward(): void { void this.run(() => this.api.toolBrowser.goForward()); }
  reload(): void { void this.run(() => this.api.toolBrowser.reload()); }
  stop(): void { void this.run(() => this.api.toolBrowser.stop()); }

  /** Enter in the address field. With no tab open this opens one, which is what
   * `DesktopBrowser.navigate` cannot do on its own. */
  submit(): void {
    const url = this.address.trim();
    if (!url) return;
    void this.run(() => this.active ? this.api.toolBrowser.navigate({ url }) : this.api.toolBrowser.newTab({ url }));
  }

  private async run(operation: () => Promise<ToolBrowserState>): Promise<void> {
    try { this.accept(await operation()); }
    catch (error) { this.host.toast(error); }
  }
}

declare module "../../app/models/registry" {
  interface AppFeatureModels { toolBrowser: ToolBrowserModel }
}

/** The registry entry (app/models/registry.ts), beside the model so that file
 * never pulls a React component into the model graph. */
export const toolBrowserModelFactory: FeatureModelFactory = {
  key: "toolBrowser",
  create: (api: DesktopAPI, app: unknown) => new ToolBrowserModel(api, app as ToolBrowserHost),
};
