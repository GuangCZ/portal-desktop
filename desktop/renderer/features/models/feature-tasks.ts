// The feature-task page's state; 2026-09-16. Ported from BeingDesktop 0.8.26
// renderer/feature-tasks.js (`mount`'s state machine: `visibleTasks`, `refresh`,
// `discussTask`, `endTracking`), with the rules test/feature-tasks-ui.cjs pins.
//
// What this page is for: a Being-side read, a kit installation or a Portal
// operation does not finish when the call returns — the ledger is where the user
// can see what is still waiting and what came back. So the rules that matter are
// about honesty rather than convenience:
//
//   * `canEnd` is the renderer's copy of the main process's `reading` rule, and
//     both say the same thing: only a waiting task, a task asking for a decision,
//     or a Being-side READ may be dropped. Ending tracking cancels nothing on the
//     Being, and the button's own hint says so.
//   * A draft is prepared only when the user asks for one (`discussTask`), never
//     as a side effect of opening a task.
//   * `persistenceError` is surfaced rather than swallowed: the operation still
//     ran, but the record may not survive a restart.
//   * Every response is guarded by a sequence number, because a push and a
//     refresh race constantly while a task is running.

import { Store } from "../../shared/models/store";
import type { DesktopAPI } from "../../../shared/types";
import type { FeatureTask, FeatureTasksState } from "../../../shared/desktop-types";

/** renderer/feature-tasks.js line 4. */
export const FEATURE_NAMES: Record<string, string> = {
  bonfire: "篝火", fireside: "围炉", scroll: "卷轴", grove: "工具市场", portal: "电脑连接",
  channel: "消息渠道", model: "模型", workspace: "工作区", beings: "居民名录",
};
/** renderer/feature-tasks.js line 5. */
export const TASK_STATUS: Record<string, string> = {
  running: "进行中", waiting: "等待中", succeeded: "已完成", failed: "未完成",
  cancelled: "已结束跟踪", needs_input: "需要你决定",
};
/** The status filter (source line 53), in order. */
export const TASK_FILTERS: readonly (readonly [string, string])[] = [
  ["all", "全部状态"], ["active", "进行与等待"], ["needs_input", "需要你决定"],
  ["succeeded", "已完成"], ["failed", "未完成"], ["cancelled", "已结束跟踪"],
] as const;

const ACTIVE_STATUSES = new Set(["running", "waiting", "needs_input"]);
const READABLE = ["bonfire", "fireside", "scroll"];

/** renderer/feature-tasks.js line 7, and the main process's own `reading` rule
 * (BeingDesktop src/main.cjs line 1247). They must agree: a button the main
 * process would refuse is worse than no button. */
export const canEnd = (task: FeatureTask | undefined | null): boolean =>
  Boolean(task && (["waiting", "needs_input"].includes(task.status)
    || (task.status === "running" && task.requestId && task.execution === "being" && READABLE.includes(task.feature))));

/** renderer/feature-tasks.js line 9. */
export const taskError = (error: unknown): string =>
  String((error as Error | null)?.message || "")
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    .slice(0, 400) || "暂时无法读取任务，请重试。";

export const taskTime = (value: string | undefined): string => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

/** Source line 27: an entry with no id is not a task, whatever else it carries. */
const validTasks = (value: unknown): FeatureTask[] =>
  (Array.isArray(value) ? value : []).filter((task: unknown): task is FeatureTask =>
    Boolean(task) && typeof task === "object" && typeof (task as FeatureTask).id === "string" && Boolean((task as FeatureTask).id));

export class FeatureTasksModel extends Store {
  open = false;
  tasks: FeatureTask[] = [];
  feature = "";
  filter = "all";
  selected = "";
  loading = true;
  error = "";
  persistenceError = false;
  draftError = "";
  drafting = "";
  draftReady = "";
  ending = "";
  trackingError: { id: string; message: string } | null = null;
  private sequence = 0;
  private stopped = false;

  constructor(private readonly api: DesktopAPI) { super(); }

  start(): () => void {
    this.stopped = false;
    const stop = this.api?.orchestration?.onFeatureTasks?.(state => this.receive(state)) ?? (() => {});
    void this.load();
    return () => { this.stopped = true; this.sequence++; stop(); };
  }

  receive(state: FeatureTasksState) {
    if (this.stopped || !Array.isArray(state?.tasks)) return;
    this.sequence++;
    this.tasks = validTasks(state.tasks);
    this.persistenceError = state.persistenceError === true;
    this.loading = false;
    this.changed();
  }

  /** The tasks the filters let through (source line 76). */
  visible(): FeatureTask[] {
    return this.tasks.filter(task =>
      (!this.feature || task.feature === this.feature)
      && (this.filter === "all" || (this.filter === "active" ? ACTIVE_STATUSES.has(task.status) : task.status === this.filter)));
  }

  /** The feature filter's options: the known names first, then whatever else the
   * ledger holds, so a feature this build has no name for is still reachable. */
  features(): [string, string][] {
    const names = new Map(Object.entries(FEATURE_NAMES));
    for (const task of this.tasks) if (task.feature && !names.has(task.feature)) names.set(task.feature, task.feature);
    return [["", "全部功能"], ...names];
  }

  current(): FeatureTask | undefined {
    const tasks = this.visible();
    return tasks.find(task => task.id === this.selected) ?? tasks[0];
  }

  show(open: boolean) { this.open = open; this.changed(); if (open) void this.load(); }
  select(id: string) { this.selected = id; this.draftError = ""; this.changed(); }
  setFeature(feature: string) { this.feature = feature; this.draftError = ""; this.changed(); }
  setFilter(filter: string) { this.filter = filter; this.draftError = ""; this.changed(); }

  /** Source line 186. A refresh reads the local ledger; it sends nothing to the
   * Being, which is why the button says so in its title. */
  async load(): Promise<void> {
    if (this.stopped || (this.loading && this.sequence > 0)) return;
    if (!this.api?.orchestration?.featureTasks) { this.loading = false; this.error = "当前版本尚未提供功能任务记录。"; this.changed(); return; }
    const sequence = ++this.sequence;
    this.loading = true; this.error = ""; this.changed();
    try {
      const response = await this.api.orchestration.featureTasks({});
      if (this.stopped || sequence !== this.sequence) return;
      this.tasks = validTasks(response?.tasks);
      this.persistenceError = response?.persistenceError === true;
    } catch (error) {
      if (!this.stopped && sequence === this.sequence) this.error = taskError(error);
    } finally {
      if (!this.stopped && sequence === this.sequence) { this.loading = false; this.changed(); }
    }
  }

  /** Source line 205. Only a task with something to say can be discussed, and the
   * draft is handed to the composer — never sent. */
  async discuss(id: string): Promise<void> {
    if (this.stopped || this.drafting) return;
    const task = this.tasks.find(item => item.id === id);
    if (!task || (!task.summary && !task.detail)) return;
    this.drafting = id; this.draftError = ""; this.changed();
    try {
      const draft = await this.api.orchestration.discussFeatureTask(id);
      if (this.stopped || !this.tasks.some(item => item.id === id)) return;
      if (draft?.prepared !== true || draft.taskId !== id) throw new Error("草稿尚未准备完成，请重试。");
      this.draftReady = id;
    } catch (error) {
      if (!this.stopped && this.selected === id) this.draftError = taskError(error);
    } finally {
      if (!this.stopped) { this.drafting = ""; this.changed(); }
    }
  }

  /** Source line 225. */
  async endTracking(id: string): Promise<void> {
    if (this.stopped || this.ending) return;
    if (!canEnd(this.tasks.find(item => item.id === id))) return;
    this.ending = id; this.trackingError = null; this.changed();
    try { await this.api.orchestration.endFeatureTask(id); }
    catch (error) { if (!this.stopped) this.trackingError = { id, message: taskError(error) }; }
    finally { if (!this.stopped) { this.ending = ""; this.changed(); } }
  }
}

/** The factory the shell's model registry calls (app/models/registry.ts). */
export const featureTasksModel = {
  key: "featureTasks" as const,
  create: (api: DesktopAPI) => new FeatureTasksModel(api),
};

declare module "../../app/models/registry" {
  interface AppFeatureModels { featureTasks: FeatureTasksModel }
}
