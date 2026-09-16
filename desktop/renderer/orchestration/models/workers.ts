// The worker list, the selected worker's detail, and the mode editor beside them;
// 2026-09-16. Ported from BeingDesktop 0.8.26 renderer/orchestration.js
// (`setState`, `appendSession`, `showWorker`, `hasActiveWorkers`), with the
// behaviour test/orchestration-ui.cjs measures.
//
// The rules that outlive the DOM they were written for:
//
//   * A worker that disappears from the snapshot takes its detail with it and
//     says which connection it was under — the record belongs to one Being, and
//     showing a stale one under another would be a lie (source line 55).
//   * While a worker is selected, each snapshot re-reads its detail after 120ms
//     (line 56). Coalescing matters: a running CLI pushes constantly.
//   * A reply for a worker that is no longer the selected one is dropped (line
//     91). Two overlapping reads must not paint each other's worker.
//   * Group collapse survives a restart, per session, in local storage (line 11).

import { Store } from "../../shared/models/store";
import { OrchestrationSettingsModel, publicMessage } from "./settings";
import type { DesktopAPI } from "../../../shared/types";
import type {
  OrchestrationSnapshotState, OrchestrationWorker, OrchestrationWorkerSummary,
} from "../../../shared/desktop-types";

/** renderer/orchestration.js lines 5-8, verbatim. */
export const WORKER_STATUS: Record<string, string> = {
  starting: "正在启动", queued: "排队中", running: "执行中", stopping: "正在停止",
  completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断",
};
export const REVIEW_STATUS: Record<string, string> = {
  pending: "待验收", processing: "Being 验收中", passed: "验收通过",
  failed: "验收未通过", needs_verification: "待补充验证", cancelled: "接续已停止",
};
export const DELIVERY_STATUS: Record<string, string> = {
  pending: "待通知", sending: "正在通知", retrying: "通知重试中",
  accepted: "Heart 已接收", failed: "通知失败", suppressed: "通知已停止",
};
/** The continuation sentences (source line 122). */
export const CONTINUATION: Record<string, string> = {
  sending: "正在唤醒 Being 接续验收。", accepted: "自动接续已提交。",
  retrying: "模型服务暂时出错，等待重试验收。", failed: "验收接续失败，可重新接续。",
  uncertain: "自动接续状态未确认，请检查原会话；不会重复执行 Worker。",
};
/** An event row's label (source line 112). */
export const EVENT_LABEL: Record<string, string> = {
  message: "Agent 输出", error: "执行错误", result: "执行结果", session: "Agent 会话", log: "运行日志",
};

export const ACTIVE = ["starting", "running", "queued", "stopping"];
export const isActive = (worker: { status: string }): boolean => ACTIVE.includes(worker.status);

/** renderer/orchestration.js line 11, verbatim. The renderer's origin differs
 * from 0.8.x's, so nothing migrates either way; the key is the source's because
 * there is no reason for it not to be. */
const COLLAPSED_KEY = "being.workerGroups.collapsed";

/** The two methods the collapse state needs of `localStorage`. */
export interface CollapseStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const defaultStorage = (): CollapseStorage => {
  // node's `localStorage` exists but throws on write without a backing file, so
  // the fallback has to behave like a storage that simply keeps nothing.
  const none: CollapseStorage = { getItem: () => null, setItem: () => {} };
  try { return typeof localStorage?.getItem === "function" ? localStorage : none; }
  catch { return none; }
};
const EMPTY: OrchestrationSnapshotState = {
  mode: { enabled: false, defaultAgent: "codex", paths: {} },
  enforcement: { status: "unchecked" }, agents: [], workers: [], error: "", linkRequired: true,
};

export class OrchestrationModel extends Store {
  snapshot: OrchestrationSnapshotState = EMPTY;
  /** The worker whose detail is open, and the detail itself. */
  selected = "";
  worker: OrchestrationWorker | null = null;
  detailError = "";
  /** Which panel the workspace shows: the list, or one worker's detail. */
  settingsOpen = false;
  open = false;
  busy = "";
  readonly settings: OrchestrationSettingsModel;
  private collapsed = new Set<string>();
  /** Distinguishes overlapping detail reads; `Store` already owns `revision`. */
  private ticket = 0;
  private refresh?: ReturnType<typeof setTimeout>;

  /** `storage` is the browser's own in the client. It is a parameter because a
   * test process has no working `localStorage` (node's stub throws on write), and
   * "the collapse state survives a restart" is exactly the claim worth pinning. */
  constructor(private readonly api: DesktopAPI, private readonly storage: CollapseStorage = defaultStorage()) {
    super();
    this.settings = new OrchestrationSettingsModel(api, snapshot => this.receive(snapshot));
    try {
      const saved: unknown = JSON.parse(this.storage.getItem(COLLAPSED_KEY) || "[]");
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") this.collapsed.add(id);
    } catch { /* Keep the toggles usable when local storage is unavailable. */ }
  }

  /** Opened from `AppModel.start()`; the cleanup joins the shell's own. */
  start(): () => void {
    let active = true;
    const stop = this.api?.orchestration?.onWorkers?.(state => { if (active) this.receive(state); }) ?? (() => {});
    const settings = this.settings.subscribe(() => this.changed());
    void this.api?.orchestration?.snapshot().then(state => { if (active) this.receive(state); }).catch(() => {});
    return () => {
      active = false;
      this.ticket++;
      clearTimeout(this.refresh);
      settings();
      stop();
    };
  }

  receive(value: OrchestrationSnapshotState) {
    if (!value?.mode) return;
    this.snapshot = value;
    this.settings.receive(value);
    if (this.selected && !value.workers.some(worker => worker.id === this.selected)) {
      // BeingDesktop line 55: the record is gone with the Being it belonged to.
      this.selected = ""; this.worker = null; this.ticket++;
      this.detailError = "当前连接下没有此 worker。";
    } else if (this.selected && !this.refresh) {
      this.refresh = setTimeout(() => { this.refresh = undefined; void this.load(this.selected); }, 120);
    }
    this.changed();
  }

  workersFor(sessionId: string): OrchestrationWorkerSummary[] {
    return this.snapshot.workers.filter(worker => worker.sessionId === sessionId);
  }
  /** The sessions that have workers, in the order the snapshot lists them. */
  sessions(): string[] { return [...new Set(this.snapshot.workers.map(worker => worker.sessionId))]; }
  hasActiveWorkers(sessionId: string): boolean { return this.workersFor(sessionId).some(isActive); }

  isCollapsed(sessionId: string): boolean { return this.collapsed.has(sessionId); }
  toggleGroup(sessionId: string) {
    if (this.collapsed.has(sessionId)) this.collapsed.delete(sessionId); else this.collapsed.add(sessionId);
    try { this.storage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); }
    catch { /* In-memory state still works without storage. */ }
    this.changed();
  }

  show(open: boolean) { this.open = open; this.changed(); }
  showSettings(open: boolean) { this.settingsOpen = open; this.changed(); }

  /** Select a worker and open the panel on it (source `showWorker(id, true)`). */
  async select(id: string): Promise<void> {
    if (!id) return;
    this.selected = id; this.open = true; this.detailError = ""; this.changed();
    await this.load(id);
  }

  back() { this.selected = ""; this.worker = null; this.detailError = ""; this.ticket++; this.changed(); }

  private async load(id: string): Promise<void> {
    if (!id) return;
    const ticket = ++this.ticket;
    try {
      const worker = await this.api.orchestration.worker(id);
      // A reply for a worker that is no longer the selected one is dropped.
      if (ticket !== this.ticket || this.selected !== id) return;
      this.worker = worker; this.detailError = "";
    } catch (error) {
      if (ticket === this.ticket) { this.worker = null; this.detailError = publicMessage(error); }
    }
    this.changed();
  }

  async cancel(id: string): Promise<void> { await this.act(id, () => this.api.orchestration.cancelWorker(id)); }
  async retry(id: string): Promise<void> { await this.act(id, () => this.api.orchestration.retryWorker(id)); }

  private async act(id: string, operation: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = id; this.changed();
    try { await operation(); await this.load(id); }
    catch (error) { this.detailError = publicMessage(error); }
    finally { this.busy = ""; this.changed(); }
  }
}

/** The factory the shell's model registry calls (app/models/registry.ts). */
export const orchestrationModel = {
  key: "orchestration" as const,
  create: (api: DesktopAPI) => new OrchestrationModel(api),
};

declare module "../../app/models/registry" {
  interface AppFeatureModels { orchestration: OrchestrationModel }
}
