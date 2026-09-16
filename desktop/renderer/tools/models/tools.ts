// The tool panel's state, ported from BeingDesktop 0.8.26
// renderer/desktop-tools.js (126 lines) on 2026-09-16.
//
// Everything the panel decides lives here; the components only read. The rules
// worth naming, because each of them is a behaviour and not a style:
//
//  · `show('browser')` with no tabs opens one. 0.8.26 does it so the panel is
//    never an empty rectangle the user has to prime.
//  · The address field is only overwritten from a push while it is NOT focused,
//    so a snapshot arriving mid-typing does not eat what is being typed.
//  · A failed `requestResult` is raised once per id, as an error line. It is how
//    a refusal stays visible after its card is gone.
//  · `link.reconnect` outranks `link.error` in the hint, because a link that is
//    about to retry is not the same news as one that gave up.
//  · The viewport is recomputed on a rAF and sent only when it actually changed
//    — the native view lives in the main process, and a redundant round trip per
//    animation frame is what that costs.
//  · Closing the panel RELEASES the view. 0.8.26 hides its panel and its
//    `hide()` reaches `layout()`, which sends `visible: false`; this panel
//    unmounts instead, so the release is explicit — see `detachView`.
//  · A viewport the main process refuses is re-sent a bounded number of times,
//    which is the one place this model deliberately does NOT match 0.8.26. See
//    `VIEWPORT_RETRIES`.
import { IDLE_TOOLS_STATE } from "../../../shared/desktop-types";
import type {
  DesktopToolsAction, DesktopToolsBrowserTab, DesktopToolsPane,
  DesktopToolsRequest, DesktopToolsState, DesktopToolsViewport,
} from "../../../shared/desktop-types";
import type { DesktopAPI } from "../../../shared/types";
import { Store, errorText } from "../../shared/models/store";

declare module "../../app/models/registry" {
  interface AppFeatureModels {
    /** The desktop tool bridge's panel (I2). */
    tools: ToolsModel;
  }
}

/** The human name of each tool, for the approval card's heading. Ported from
 * `labels` in renderer/desktop-tools.js. A name with no entry shows as itself:
 * an unknown tool is exactly when the user most needs to read the raw name. */
const TOOL_LABELS: Record<string, string> = {
  desktop_browser_tabs: "查看浏览器标签",
  desktop_browser_open: "打开网页",
  desktop_browser_read: "读取网页内容",
  desktop_browser_click: "点击网页元素",
  desktop_browser_fill: "填写网页内容",
  desktop_browser_screenshot: "截取网页",
  desktop_console_run: "运行本机命令",
  desktop_console_status: "读取命令输出",
  desktop_console_stop: "停止命令",
};

const LINK_LABELS: Record<string, string> = {
  connected: "Being 工具已连接",
  connecting: "正在连接 Being…",
  error: "Being 工具连接失败",
  disconnected: "Being 工具未连接",
};

const ACTIVE_JOB = ["starting", "running", "stopping"];

/** How many times one rectangle may be re-sent after `beings:tools-browser-view`
 * refused it.
 *
 * 0.8.26 re-sends without a bound: its renderer clears the last-sent key on every
 * failure and the next rAF tries again, forever. That is survivable there because
 * the only failure it has is a transient one. Here the channel is refused for the
 * WHOLE of a quit — it is not on `QUIT_ALLOWED` (desktop/main/app/ipc.ts) — and
 * `fail()` notifies the shell, which re-renders, which measures and sends again:
 * an unbounded retry is a live loop that ends only when the window does. Three
 * tries per rectangle keeps the recovery (a rectangle the main process may have
 * missed is still re-sent) without the loop; a rectangle that actually changes
 * starts a fresh budget, and one success clears it. */
export const VIEWPORT_RETRIES = 3;

export class ToolsModel extends Store {
  state: DesktopToolsState = IDLE_TOOLS_STATE;
  open = false;
  mode: DesktopToolsPane = "browser";
  /** The panel takes the whole workspace body instead of sharing it. */
  full = false;
  /** The link toggle is in flight; both it and a second click are refused. */
  linkBusy = false;
  /** The address field's own value, which diverges from the active tab while the
   * user is typing. */
  address = "";
  /** Whether the address field currently has focus. Kept here rather than read
   * off `document` so the model stays free of the DOM. */
  addressFocused = false;
  /** The console pane's command box. */
  command = "";
  error = "";
  /** Whether the connection details block under the heading is expanded. */
  detailsOpen = false;
  private lastRequestResult = "";
  private lastViewport = "";
  /** Consecutive `browserView` refusals; see VIEWPORT_RETRIES. */
  private viewportFailures = 0;
  private viewport: DesktopToolsViewport = { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  /** Suppresses the viewport while a pointer is dragging the divider: a native
   * view that repaints during a drag lags visibly behind the panel's frame. */
  private resizing = false;
  private closed = false;

  constructor(private readonly api: DesktopAPI) {
    super();
  }

  /** Opened by `AppModel.start()` and closed with the shell
   * (desktop/renderer/app/models/registry.ts). */
  start = () => {
    let received = false;
    const stopState = this.api.tools.onState((next) => {
      received = true;
      this.accept(next);
    });
    const stopReveal = this.api.tools.onReveal((mode) => {
      void this.show(mode);
    });
    void this.api.tools
      .state()
      .then((next) => {
        if (!received && !this.closed) this.accept(next);
      })
      .catch((error) => this.fail(error));
    return () => {
      this.closed = true;
      stopState();
      stopReveal();
    };
  };

  get activeTab(): DesktopToolsBrowserTab | undefined {
    return this.state.browser.tabs.find((tab) => tab.id === this.state.browser.activeTabId);
  }

  get pendingCount() {
    return this.state.requests.length;
  }

  get activeJobCount() {
    return this.state.console.jobs.filter((job) => ACTIVE_JOB.includes(job.status)).length;
  }

  get linkLabel() {
    return LINK_LABELS[this.state.link.status] || LINK_LABELS.disconnected;
  }

  get linkConnected() {
    return this.state.link.status === "connected";
  }

  /** The sentence under the link row. Ported verbatim, including which of the
   * four branches wins. */
  get linkHint() {
    const { link } = this.state;
    const active = this.activeJobCount;
    if (link.reconnect) return `调度工具已断线，${Math.ceil(link.reconnect.delayMs / 1000)} 秒后自动重连。`;
    if (link.error) return link.error;
    if (this.linkConnected)
      return `每次调用单独确认；断开连接${active ? `后 ${active} 条本机命令仍会运行` : "不会停止已启动的命令"}。`;
    if (active) return `Being 工具未连接；仍有 ${active} 条本机命令运行，可在控制台手动停止。`;
    return "连接后，Being 的页面和命令调用会在这里等待你确认。";
  }

  label(name: string) {
    return TOOL_LABELS[name] || name;
  }

  /** The body of one approval card. The three shapes are 0.8.26's, including the
   * long `desktop_console_status` sentence, which is the only place the user is
   * told what「读取命令输出」actually reads. */
  summary(request: DesktopToolsRequest) {
    if (request.name === "desktop_console_run")
      return `新建独立命令会话 · 非交互命令\n${request.args.cwd || "未选择目录"}\n\n${request.args.command}`;
    if (request.name === "desktop_console_status" || request.name === "desktop_console_stop") {
      const what =
        request.name === "desktop_console_status"
          ? "读取以下命令截至执行时保留的状态与输出（每条最多 256 KiB，保留尾部，含审批后同一任务新增的输出）"
          : "停止以下命令及桌面管理的子进程";
      const jobs = request.reviewJobs.map((job) => `${job.id}\nPS ${job.cwd}> ${job.command}`).join("\n\n");
      return `${what}\n${jobs || "没有可读取的命令"}`;
    }
    return `${request.target || ""}\n${request.targetSummary ? `${request.targetSummary}\n` : ""}${JSON.stringify(request.args, null, 2)}`;
  }

  async act(input: DesktopToolsAction) {
    this.error = "";
    this.changed();
    try {
      this.accept(await this.api.tools.act(input));
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async show(mode: DesktopToolsPane = "browser") {
    this.mode = mode;
    this.open = true;
    this.changed();
    // 0.8.26 opens a first tab rather than showing an empty browser.
    if (mode === "browser" && !this.state.browser.tabs.length) await this.act({ action: "browser.new" });
  }

  hide() {
    this.open = false;
    this.full = false;
    // Before the notification, so the view is already released by the time the
    // panel's own unmount runs and the second call is a no-op.
    this.detachView();
    this.changed();
  }

  /** The topbar toggle: the same control both opens the pane and closes it. */
  toggle(mode: DesktopToolsPane = "browser") {
    if (this.open && this.mode === mode) this.hide();
    else void this.show(mode);
  }

  toggleFull() {
    this.full = !this.full;
    this.changed();
  }

  toggleDetails() {
    this.detailsOpen = !this.detailsOpen;
    if (!this.detailsOpen) this.error = "";
    this.changed();
  }

  async toggleLink() {
    if (this.linkBusy) return;
    this.linkBusy = true;
    this.changed();
    const connecting = this.state.link.status === "connecting";
    await this.act({ action: this.linkConnected || connecting ? "link.disconnect" : "link.connect" });
    this.linkBusy = false;
    this.changed();
  }

  editAddress(value: string) {
    this.address = value;
    this.changed();
  }

  focusAddress(focused: boolean) {
    this.addressFocused = focused;
    if (!focused) this.address = this.activeTab?.url || "";
    this.changed();
  }

  /** Enter in the address field. Navigating the active tab to the address it is
   * already showing is a no-op, as in 0.8.26 — reload is a separate control. */
  async submitAddress() {
    const url = this.address.trim();
    const active = this.activeTab;
    this.addressFocused = false;
    if (active?.url === url) return;
    await this.act(active ? { action: "browser.navigate", value: { id: active.id, url } } : { action: "browser.new", value: { url } });
  }

  editCommand(value: string) {
    this.command = value;
    this.changed();
  }

  async submitCommand() {
    const command = this.command.trim();
    if (!command) return;
    // Cleared optimistically: a command the console refuses stays in the error
    // line, and a resubmit of the same text would be a second job.
    this.command = "";
    this.changed();
    await this.act({ action: "console.run", value: { command } });
  }

  setResizing(resizing: boolean) {
    this.resizing = resizing;
    this.changed();
  }

  /** Hand the main process the rectangle the native browser view should occupy.
   * `blocked` is the shell's own reasons for hiding it — a dialog on top, the
   * document hidden — which the component measures and passes in. */
  browserView(bounds: DesktopToolsViewport["bounds"], blocked: boolean) {
    const active = this.activeTab;
    this.send({
      visible:
        this.open &&
        this.mode === "browser" &&
        !this.resizing &&
        !blocked &&
        Boolean(active?.url && !active.error),
      bounds: {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(0, Math.round(bounds.width)),
        height: Math.max(0, Math.round(bounds.height)),
      },
    });
  }

  /** Release the native view, keeping the last rectangle.
   *
   * THE PANEL UNMOUNTS WHEN IT CLOSES (renderer/tools/slot.tsx: `visible` is
   * `open`), taking `#tools-browser-host` — the element `browserView` measures —
   * with it. Nothing therefore measures a closed panel, and without this call the
   * last thing the main process heard is `visible: true`: `DesktopBrowser
   * ._syncView` only detaches when it is told to hide, so the page stays pinned
   * over the conversation for the rest of the run. 0.8.26 does not have the hole
   * because its panel is hidden rather than removed and `hide()` runs `layout()`.
   *
   * The bounds are the last ones sent rather than zeroes: `setViewport` keeps the
   * rectangle while hidden, so re-opening puts the view back where it was. */
  detachView() {
    this.send({ visible: false, bounds: this.viewport.bounds });
  }

  /** The one place a viewport crosses IPC. Identical messages are dropped — the
   * native view is in the main process, and a redundant round trip per animation
   * frame is what a redundant message costs. */
  private send(viewport: DesktopToolsViewport) {
    const key = JSON.stringify(viewport);
    if (key === this.lastViewport) return;
    this.lastViewport = key;
    this.viewport = viewport;
    void this.api.tools.browserView(viewport).then(
      () => { this.viewportFailures = 0; },
      (error) => {
        this.viewportFailures += 1;
        // Re-send next frame: the rectangle the main process has is now unknown.
        // Bounded, unlike 0.8.26's — see VIEWPORT_RETRIES.
        if (this.viewportFailures <= VIEWPORT_RETRIES) this.lastViewport = "";
        // Raised once per streak. `fail()` notifies, a notification re-renders,
        // and a re-render measures and sends again, so raising every failure is
        // half of the loop the bound above exists to stop.
        if (this.viewportFailures === 1) this.fail(error);
      },
    );
  }

  /** What was last sent, for the tests and for a re-send after a failure. */
  get lastSentViewport() {
    return this.viewport;
  }

  private accept(next: DesktopToolsState) {
    if (this.closed) return;
    this.state = next;
    if (!this.addressFocused) this.address = this.activeTab?.url || "";
    const result = next.requestResult;
    if (result && result.id !== this.lastRequestResult) {
      this.lastRequestResult = result.id;
      if (result.status === "failed") {
        this.detailsOpen = true;
        this.error = `上一次 Being 调用：${result.message}`;
      }
    }
    this.changed();
  }

  private fail(error: unknown) {
    this.detailsOpen = true;
    this.error = errorText(error);
    this.changed();
  }
}
