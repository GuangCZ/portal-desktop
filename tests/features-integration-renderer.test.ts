// The feature-task page's rules, without a DOM; 2026-09-16.
//
// BeingDesktop 0.8.26 pins these in test/feature-tasks-ui.cjs against a real
// window. The claims that survive the rewrite are about what the page is allowed
// to do on the user's behalf, and they are made here against the model that owns
// them:
//
//   * the filters and the counts;
//   * `canEnd` — which must agree, exactly, with the main process's own `reading`
//     rule, or the page offers a button the client refuses;
//   * a draft is prepared only when the user asks for one, and a refused draft
//     shows the refusal on that task rather than silently doing nothing;
//   * `persistenceError` is surfaced;
//   * a push and a refresh that overlap do not paint each other's list.

import { describe, expect, it } from "vitest";
import {
  FEATURE_NAMES, FeatureTasksModel, TASK_FILTERS, TASK_STATUS, canEnd, executionLabel,
  navigateLabel, taskError,
} from "../desktop/renderer/features/models/feature-tasks";
import type { DesktopAPI } from "../desktop/shared/types";
import type { FeatureTask, FeatureTasksState } from "../desktop/shared/desktop-types";

const task = (id: string, patch: Partial<FeatureTask> = {}): FeatureTask => ({
  id, feature: "bonfire", operation: "read", title: `任务 ${id}`, execution: "being",
  mayDelayChat: true, status: "running", detail: "", summary: "", requestId: "",
  errorCode: "", createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:01.000Z",
  finishedAt: "", ...patch,
});

function harness() {
  const calls: string[] = [];
  let listener: ((state: FeatureTasksState) => void) | null = null;
  const reply: { tasks: FeatureTask[]; persistenceError?: boolean; discuss: { prepared: true; taskId: string } | Error; end: Error | null } = {
    tasks: [], persistenceError: false, discuss: { prepared: true, taskId: "" }, end: null,
  };
  const api = {
    orchestration: {
      featureTasks: async () => { calls.push("featureTasks"); return { tasks: reply.tasks, persistenceError: reply.persistenceError }; },
      discussFeatureTask: async (id: string) => {
        calls.push(`discuss:${id}`);
        if (reply.discuss instanceof Error) throw reply.discuss;
        return { ...reply.discuss, taskId: reply.discuss.taskId || id };
      },
      endFeatureTask: async (id: string) => { calls.push(`end:${id}`); if (reply.end) throw reply.end; return null; },
      featureTask: async () => null,
      onFeatureTasks: (callback: (state: FeatureTasksState) => void) => { listener = callback; return () => { listener = null; }; },
    },
  } as unknown as DesktopAPI;
  return { api, calls, reply, push: (state: FeatureTasksState) => listener?.(state) };
}

describe("the feature-task page", () => {
  it("names the features, the states and the filters the way BeingDesktop does", () => {
    // renderer/feature-tasks.js lines 4, 5 and 53.
    expect(FEATURE_NAMES).toEqual({
      bonfire: "篝火", fireside: "围炉", scroll: "卷轴", grove: "工具市场", portal: "电脑连接",
      channel: "消息渠道", model: "模型", workspace: "工作区", beings: "居民名录",
    });
    expect(TASK_STATUS).toEqual({
      running: "进行中", waiting: "等待中", succeeded: "已完成", failed: "未完成",
      cancelled: "已结束跟踪", needs_input: "需要你决定",
    });
    expect(TASK_FILTERS.map(([value]) => value)).toEqual(["all", "active", "needs_input", "succeeded", "failed", "cancelled"]);
    expect(taskError(new Error("Error invoking remote method 'beings:feature-tasks': Error: 读不到"))).toBe("读不到");
    expect(taskError(null)).toBe("暂时无法读取任务，请重试。");
  });

  it("offers to end tracking on exactly the tasks the main process would accept", () => {
    // The main process's rule (desktop/main/features/ipc.ts, from BeingDesktop
    // src/main.cjs line 1247): waiting, needs_input, or a Being-side READ of one
    // of three features that is still running and has a request id.
    expect(canEnd(task("a", { status: "waiting" }))).toBe(true);
    expect(canEnd(task("b", { status: "needs_input" }))).toBe(true);
    expect(canEnd(task("c", { status: "running", requestId: "r", execution: "being", feature: "bonfire" }))).toBe(true);
    expect(canEnd(task("d", { status: "running", requestId: "r", execution: "being", feature: "fireside" }))).toBe(true);
    expect(canEnd(task("e", { status: "running", requestId: "r", execution: "being", feature: "scroll" }))).toBe(true);
    // A running LOCAL operation is a live process; a Being-side read of anything
    // else, or one with no request id, is not the shape the rule covers.
    expect(canEnd(task("f", { status: "running", requestId: "r", execution: "local", feature: "portal" }))).toBe(false);
    expect(canEnd(task("g", { status: "running", requestId: "", execution: "being", feature: "bonfire" }))).toBe(false);
    expect(canEnd(task("h", { status: "running", requestId: "r", execution: "being", feature: "grove" }))).toBe(false);
    expect(canEnd(task("i", { status: "succeeded" }))).toBe(false);
    expect(canEnd(null)).toBe(false);
  });

  it("filters by feature and by state, and counts what is left", async () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    f.reply.tasks = [
      task("a", { status: "running" }), task("b", { status: "waiting" }),
      task("c", { status: "succeeded", feature: "portal" }), task("d", { status: "failed", feature: "grove" }),
    ];
    await model.load();
    expect(model.visible()).toHaveLength(4);
    model.setFilter("active");
    expect(model.visible().map(item => item.id)).toEqual(["a", "b"]);
    model.setFilter("all");
    model.setFeature("portal");
    expect(model.visible().map(item => item.id)).toEqual(["c"]);
    model.setFeature("");
    // The picker lists the known names plus anything else the ledger holds, so a
    // feature this build has no name for is still reachable.
    f.reply.tasks = [...f.reply.tasks, task("e", { feature: "unknown-feature" })];
    await model.load();
    expect(model.features().map(([value]) => value)).toContain("unknown-feature");
    expect(model.features()[0]).toEqual(["", "全部功能"]);
  });

  it("drops entries that are not tasks and surfaces a ledger that could not be saved", async () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    f.reply.tasks = [task("a"), null as unknown as FeatureTask, { title: "no id" } as FeatureTask];
    f.reply.persistenceError = true;
    // `start()` is what subscribes to the push, exactly as `AppModel.start()`
    // calls it; the pushes below would reach nothing without it.
    const stop = model.start();
    await Promise.resolve(); await Promise.resolve();
    expect(model.tasks.map(item => item.id)).toEqual(["a"]);
    expect(model.persistenceError).toBe(true);
    // A push carries the same two facts, and replaces the list wholesale.
    f.push({ tasks: [task("b")], persistenceError: false });
    expect(model.tasks.map(item => item.id)).toEqual(["b"]);
    expect(model.persistenceError).toBe(false);
    // The deliberate empty list an identity swap sends is honoured, not ignored.
    f.push({ tasks: [] });
    expect(model.tasks).toEqual([]);
    stop();
  });

  it("prepares a draft only when asked, and reports a refusal against that task", async () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    f.reply.tasks = [task("a", { status: "succeeded", summary: "读到 3 条消息。" }), task("b", { status: "running" })];
    await model.load();
    model.select("a");
    // Opening a task sends nothing; only `discuss` does.
    expect(f.calls.filter(call => call.startsWith("discuss"))).toEqual([]);
    await model.discuss("a");
    expect(f.calls).toContain("discuss:a");
    expect(model.draftReady).toBe("a");
    expect(model.draftError).toBe("");
    // A task with nothing to say is not discussable at all.
    await model.discuss("b");
    expect(f.calls.filter(call => call === "discuss:b")).toEqual([]);
    f.reply.discuss = new Error("连接身份已变化，请重新选择功能。");
    await model.discuss("a");
    expect(model.draftError).toBe("连接身份已变化，请重新选择功能。");
    // A reply that does not answer for the task asked about is refused rather
    // than shown as ready (renderer/feature-tasks.js line 215).
    f.reply.discuss = { prepared: true, taskId: "somewhere-else" };
    model.draftReady = "";
    await model.discuss("a");
    expect(model.draftReady).toBe("");
    expect(model.draftError).toBe("草稿尚未准备完成，请重试。");
  });

  it("ends local tracking only for a task the rule allows, and keeps the refusal on that row", async () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    f.reply.tasks = [task("a", { status: "waiting" }), task("b", { status: "succeeded" })];
    await model.load();
    await model.endTracking("b");
    expect(f.calls.filter(call => call.startsWith("end:"))).toEqual([]);
    f.reply.end = new Error("只能结束读取、等待中或待处理任务的本地跟踪。");
    await model.endTracking("a");
    expect(f.calls).toContain("end:a");
    expect(model.trackingError).toEqual({ id: "a", message: "只能结束读取、等待中或待处理任务的本地跟踪。" });
    f.reply.end = null;
    await model.endTracking("a");
    expect(model.trackingError).toBeNull();
  });

  it("says how a task is executed, in the source's three branches", () => {
    // Three different promises to the user, so which one is shown matters:
    //「使用 Being」is the warning that the operation shares the chat queue.
    expect(executionLabel(task("a"))).toBe("使用 Being，聊天可能等待");
    expect(executionLabel(task("a", { execution: "local", mayDelayChat: true }))).toBe("使用 Being，聊天可能等待");
    expect(executionLabel(task("a", { execution: "local", mayDelayChat: false }))).toBe("本机执行");
    // `native` is the source's other spelling for a local run
    // (renderer/feature-tasks.js line 100). It cannot arrive through this
    // client's ledger — `begin` rejects it and `restore()` drops a stored row
    // carrying it — but a task that has already run here must never be described
    // as「执行方式待确认」, so the branch is kept rather than dropped.
    expect(executionLabel({ execution: "native" as never, mayDelayChat: false })).toBe("本机执行");
    expect(executionLabel({ execution: "" as never, mayDelayChat: false })).toBe("执行方式待确认");
  });

  it("offers the feature page only when the shell has somewhere to send the user", () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    // No destination, no button: the feature pages belong to other integration
    // units, and an action that goes nowhere is worse than no action.
    expect(model.navigate).toBeNull();
    const went: [string, string][] = [];
    model.setNavigate((feature, item) => { went.push([feature, item.id]); });
    model.navigate!("bonfire", task("a"));
    expect(went).toEqual([["bonfire", "a"]]);
    // `needs_input` is the one the user has to act on, and the source says so in
    // the label (renderer/feature-tasks.js line 116).
    expect(navigateLabel(task("a"))).toBe("打开功能页");
    expect(navigateLabel(task("a", { status: "needs_input" }))).toBe("到功能页处理");
  });

  it("ignores a reply from a read that a later one replaced", async () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    const stop = model.start();
    await Promise.resolve(); await Promise.resolve();
    f.reply.tasks = [task("stale")];
    const second = model.load();
    // A push while the read is in flight bumps the sequence, so the read's own
    // reply is dropped rather than overwriting what just arrived.
    f.push({ tasks: [task("fresh")] });
    await second;
    expect(model.tasks.map(item => item.id)).toEqual(["fresh"]);
    expect(model.loading).toBe(false);
    stop();
  });

  it("stops answering once the shell tears it down", async () => {
    const f = harness();
    const model = new FeatureTasksModel(f.api);
    const stop = model.start();
    f.reply.tasks = [task("a")];
    stop();
    f.push({ tasks: [task("b")] });
    expect(model.tasks.map(item => item.id)).not.toContain("b");
    await model.load();
    expect(f.calls.filter(call => call === "featureTasks")).toHaveLength(1);
  });
});
