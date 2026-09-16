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
import { Store, errorText } from "../../shared/models/store";
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
  /** The browser could not be built at all — no Electron in this process, or
   * `DesktopBrowser`'s constructor refused. Set from the first read, which is the
   * only place the reason is learned without the user having to click something;
   * the panel shows it in place of its empty message. Mirrors `TerminalModel`. */
  unavailable = "";
  private lifecycle = 0;
  /** True while the address field has focus. BeingDesktop stops following the
   * active tab's URL exactly then — renderer/desktop-tools.js `renderBrowser()`'s
   * `if(document.activeElement!==$('browser-address'))` — and resumes on the next
   * state push once the field is left. The panel sets it on focus and blur. */
  private editing = false;
  /** The last viewport the main process was told about, or null when nothing is
   * known — which is also what a failed send leaves behind, so the next layout
   * retries (BeingDesktop's `lastViewport=''`). Everything that changes the
   * rectangle or the attachment goes through `setViewport`/`detach`, which are the
   * only two writers: a send that skipped this cache would make the next identical
   * rectangle dedupe itself away and the panel would come back blank. */
  private sent: (ToolBrowserBounds & { visible: boolean }) | null = null;

  constructor(private readonly api: DesktopAPI, private readonly host: ToolBrowserHost) {
    super();
  }

  start(): () => void {
    const revision = ++this.lifecycle;
    const stop = this.api.toolBrowser.onState(state => { if (revision === this.lifecycle) this.accept(state); });
    void this.api.toolBrowser
      .state()
      .then(state => { if (revision === this.lifecycle) this.accept(state); })
      .catch(error => {
        // The first read fails only when the browser could not be built at all.
        // Saying so beats an empty placeholder that invites the user to act on a
        // browser that is not there — the same shape `TerminalModel` uses.
        if (revision !== this.lifecycle) return;
        this.unavailable = errorText(error);
        this.changed();
      });
    return () => {
      this.lifecycle++;
      stop();
      this.open = false;
      // Detach the native view: the panel is gone, and a view left attached would
      // sit on top of the conversation.
      this.detach();
    };
  }

  get tabs(): ToolBrowserTab[] { return this.state.tabs; }

  get active(): ToolBrowserTab | undefined {
    return this.state.tabs.find(tab => tab.id === this.state.activeTabId);
  }

  accept(state: ToolBrowserState): void {
    if (!state || !Array.isArray(state.tabs)) return;
    this.state = state;
    // Follow the active tab on EVERY push, not only when the active tab changes:
    // a link click, a redirect, or `example.com` being normalised to
    // `https://example.com/` moves the URL inside one tab, and an address bar that
    // did not move shows something that is not the page. BeingDesktop does the
    // same, with focus as the one exception (renderer/desktop-tools.js).
    if (!this.editing) this.address = this.active?.url || "";
    // A state to accept means the browser exists after all.
    this.unavailable = "";
    this.changed();
  }

  setAddress(value: string): void {
    this.address = value;
    this.changed();
  }

  /** The address field gained or lost focus. Deliberately without `changed()`:
   * nothing rendered depends on it, and a re-render on focus would fight the
   * caret. */
  setEditing(editing: boolean): void { this.editing = editing; }

  show(): void { this.open = true; this.changed(); }

  hide(): void {
    this.open = false;
    this.changed();
    this.detach();
  }

  toggle(open = !this.open): void { if (open) this.show(); else this.hide(); }

  /** Where the panel's placeholder is. Called from layout, so it is deliberately
   * cheap when nothing moved: a `WebContentsView` re-attaches on every call. */
  setViewport(bounds: ToolBrowserBounds, visible: boolean): void {
    const next = { ...bounds, visible };
    const last = this.sent;
    if (last && last.visible === next.visible && last.x === next.x && last.y === next.y
      && last.width === next.width && last.height === next.height) return;
    this.sent = next;
    void this.api.toolBrowser.setViewport({ visible, bounds }).then(
      state => this.accept(state),
      error => {
        // Nothing landed. Forget what the main process was believed to know so the
        // next layout sends again rather than trusting a rectangle that never
        // arrived — BeingDesktop's `lastViewport=''` on the same failure.
        if (this.sent === next) this.sent = null;
        if (visible) this.host.toast(error);
      },
    );
  }

  /** Detach the native view. Hiding the panel and tearing it down both come here
   * rather than calling the bridge directly, so the dedupe cache can never claim
   * the view is attached while it is not: that is what made a re-opened panel at
   * the same rectangle stay blank. */
  private detach(): void {
    if (this.sent) this.sent = { ...this.sent, visible: false };
    void this.api.toolBrowser.setViewport({ visible: false }).catch(() => { /* Already detached, or shutting down. */ });
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
    const active = this.active;
    // The address the field already shows is not a navigation: BeingDesktop's
    // `if(active?.url===url)return;`. Re-loading a page is the reload button's job,
    // and now that the field follows the active tab, Enter on an untouched field
    // would otherwise re-navigate on every keystroke-free submit.
    if (active && active.url === url) return;
    // Name the tab the address belongs to. The active tab can change under a slow
    // navigation — a Being may open one — and BeingDesktop passes the id for the
    // same reason.
    void this.run(() => active ? this.api.toolBrowser.navigate({ id: active.id, url }) : this.api.toolBrowser.newTab({ url }));
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
