// Ported from BeingDesktop 0.8.26 test/feature-tasks.test.cjs on 2026-09-16 (node:test -> vitest).
// Fixtures are copied verbatim; only the assertion style changed. The final case is the ledger half
// of test/town-error-ipc.test.cjs (its preload half needs IPC and stays out of this migration unit).

import { describe, expect, it } from "vitest";
import { FeatureTasks, type FeatureTasksOptions } from "../desktop/main/features/feature-tasks";
import type { FeatureTaskBeginInput, FeatureTaskRecord } from "../desktop/main/features/types";

function setup(options: FeatureTasksOptions = {}) {
  let timestamp = 1000;
  let sequence = 0;
  const changes: { version: 1; identityKey: string; records: FeatureTaskRecord[] }[] = [];
  const tasks = new FeatureTasks({ now: () => timestamp, createId: () => `task-${++sequence}`, onChange: value => changes.push(value), ...options });
  return { tasks, changes, tick(value = 1) { timestamp += value; }, begin(input: Partial<FeatureTaskBeginInput> = {}) { return tasks.begin({ feature: "bonfire", operation: "read", title: "读取篝火消息", execution: "being", ...input }); } };
}

function capture(fn: () => unknown): { code?: string } {
  try { fn(); } catch (error) { return error as { code?: string }; }
  throw new Error("Expected the call to throw");
}

describe("feature task ledger", () => {
  it("functional work owns its progress and result without invoking a transport", () => {
    const context = setup();
    const started = context.begin();
    expect(started.mayDelayChat).toBe(true);
    expect(started.status).toBe("running");
    context.tick(50);
    context.tasks.update(started.id, { status: "waiting", detail: "请求已送达，等待实际结果", requestId: "request-1" });
    context.tick(50);
    const done = context.tasks.complete(started.id, { summary: "已读取 10 条篝火消息" });
    expect(done?.status).toBe("succeeded");
    expect(done?.finishedAt).toBe(1100);
    expect(done?.createdAt).toBe(1000);
    expect(done?.requestId).toBe("request-1");
    expect(done?.summary).toBe("已读取 10 条篝火消息");
    expect(done?.detail).toBe("");
    expect(context.changes.length).toBe(3);
    expect(context.changes[2].records).toStrictEqual([done]);
  });

  it("local work never claims it can delay Being chat", () => {
    const context = setup();
    const task = context.begin({ feature: "portal", operation: "install", execution: "local" });
    expect(task.mayDelayChat).toBe(false);
    expect(task.execution).toBe("local");
  });

  it("terminal records cannot be resurrected by late success, errors or progress", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"]) {
      const context = setup();
      const task = context.begin();
      const before = context.tasks.update(task.id, { status: terminal, detail: "终态" });
      context.tick(100);
      expect(context.tasks.update(task.id, { status: "running", detail: "延迟回调" })).toStrictEqual(before);
      expect(context.tasks.complete(task.id, { summary: "迟到结果" })).toStrictEqual(before);
      expect(context.tasks.fail(task.id, { code: "NETWORK_ERROR" })).toStrictEqual(before);
      expect(context.changes.length).toBe(2);
    }
  });

  it("active task identifiers and execution fields cannot be changed through patches", () => {
    const context = setup(); const task = context.begin();
    for (const patch of [{ id: "other" }, { execution: "local" }, { mayDelayChat: false }, { prompt: "hidden" }, { status: "done" }, { requestId: "https://example.test/?token=secret" }]) expect(() => context.tasks.update(task.id, patch)).toThrow(TypeError);
    expect(context.tasks.get(task.id)?.status).toBe("running");
    expect(context.changes.length).toBe(1);
  });

  it("task errors never expose upstream messages, headers, or response bodies", () => {
    const context = setup(); const task = context.begin();
    const error = Object.assign(new Error("Authorization: Bearer secret; https://host/path?token=secret"), { code: "NETWORK_ERROR", response: { password: "secret" } });
    const failed = context.tasks.fail(task.id, error);
    expect(failed?.errorCode).toBe("NETWORK_ERROR");
    expect(failed?.detail).toBe("连接暂时中断，请稍后重试。");
    expect(JSON.stringify(failed)).not.toMatch(/secret|Authorization|password|response/);
    const other = context.begin();
    expect(context.tasks.fail(other.id, { code: "SECRET_TOKEN_VALUE", message: "private prompt" })?.errorCode).toBe("REQUEST_FAILED");
  });

  it("public text strips credential URLs, bearer values and token assignments", () => {
    const context = setup();
    const task = context.begin({ title: "读取 https://user:pw@example.test/being/?token=url-secret" });
    context.tasks.update(task.id, { detail: "Bearer bearer-secret; token=query-secret api_key=key-secret sk-abcdefghijklm" });
    context.tasks.complete(task.id, { summary: "password=pass-secret refresh_token=refresh-secret cookie=session-secret key=bare-secret" });
    const text = JSON.stringify(context.tasks.snapshot());
    expect(text).not.toMatch(/url-secret|bearer-secret|query-secret|key-secret|abcdefghijklm|pass-secret|refresh-secret|session-secret|bare-secret|user:pw/);
    expect(text).toMatch(/已隐藏/);
  });

  it("text and record counts are bounded without dropping active work", () => {
    const context = setup({ maxRecords: 2 });
    const first = context.begin({ title: "标题".repeat(1000) });
    context.tick();
    const second = context.begin();
    expect(first.title.length).toBe(160);
    expect(capture(() => context.begin()).code).toBe("TASK_LIMIT_REACHED");
    context.tasks.complete(first.id, { summary: "结果".repeat(1000) });
    expect(context.tasks.get(first.id)?.summary.length).toBe(1200);
    context.tick();
    const third = context.begin();
    expect(context.tasks.get(first.id)).toBe(null);
    expect(context.tasks.list().map(task => task.id)).toStrictEqual([third.id, second.id]);
  });

  it("callers and observers cannot mutate retained records", () => {
    const context = setup(); const task = context.begin();
    task.title = "changed";
    (context.tasks.get(task.id) as FeatureTaskRecord).title = "changed";
    context.tasks.list()[0].title = "changed";
    context.tasks.snapshot().records[0].title = "changed";
    context.changes[0].records[0].title = "changed";
    expect(context.tasks.get(task.id)?.title).toBe("读取篝火消息");
    const throwing = setup({ onChange: () => { throw new Error("observer failed"); } });
    expect(throwing.begin().status).toBe("running");
  });

  it("restarting preserves terminal results and marks unfinished work for reconciliation without replay", () => {
    const context = setup({ identityKey: "alice" });
    const done = context.begin(); context.tasks.complete(done.id, { summary: "原始摘要" });
    context.tick();
    const pending = context.begin(); context.tasks.update(pending.id, { status: "needs_input", requestId: "request-2" });
    let changed = 0;
    const restored = new FeatureTasks({ identityKey: "alice", initialSnapshot: context.tasks.snapshot(), onChange: () => changed++ });
    expect(restored.get(done.id)?.summary).toBe("原始摘要");
    expect(restored.get(pending.id)?.status).toBe("needs_input");
    expect(restored.get(pending.id)?.detail).toMatch(/旧读取结果尚未确认，本地已无等待队列/);
    expect(restored.get(pending.id)?.mayDelayChat).toBe(true);
    expect(restored.get(pending.id)?.finishedAt).toBe(null);
    expect(restored.get(pending.id)?.requestId).toBe("request-2");
    expect(changed).toBe(0);
  });

  it("restoration and reset never cross a connection identity boundary", () => {
    const context = setup({ identityKey: "alice" }); const task = context.begin();
    const snapshot = context.tasks.snapshot();
    expect(new FeatureTasks({ identityKey: "bob", initialSnapshot: snapshot }).list()).toStrictEqual([]);
    expect(new FeatureTasks({ identityKey: "alice", initialRecords: snapshot.records }).list()).toStrictEqual([]);
    expect(new FeatureTasks({ identityKey: "alice", initialRecords: snapshot.records, initialIdentityKey: "alice" }).list().length).toBe(1);
    context.tasks.reset({ identityKey: "bob" });
    expect(context.tasks.get(task.id)).toBe(null);
    expect(context.tasks.complete(task.id, { summary: "old request completed" })).toBe(null);
    expect(context.tasks.snapshot().identityKey).toBe("bob");
    expect(context.tasks.list()).toStrictEqual([]);
  });

  it("legacy rejected reads stop pretending to queue while accepted reads require reconciliation", () => {
    const context = setup({ identityKey: "alice" });
    const blocked = context.begin();
    context.tasks.update(blocked.id, { status: "waiting", detail: "Being 正在处理其他请求，本次操作尚未完成；不会自动重发。" });
    context.tick(); const accepted = context.begin();
    context.tasks.update(accepted.id, { status: "waiting", requestId: "accepted-request", detail: "请求结果尚待确认；不会自动重发。" });
    const restored = new FeatureTasks({ identityKey: "alice", initialSnapshot: context.tasks.snapshot() });
    expect(restored.get(blocked.id)?.status).toBe("failed");
    expect(restored.get(blocked.id)?.detail).toMatch(/未发送/);
    expect(restored.get(accepted.id)?.status).toBe("needs_input");
    expect(restored.get(accepted.id)?.requestId).toBe("accepted-request");
  });

  it("invalid or hostile persisted fields cannot restore a task", () => {
    const context = setup({ identityKey: "alice" }); const task = context.begin();
    const candidates = [{ ...task, prompt: "private" }, { ...task, execution: "remote" }, { ...task, createdAt: -1 }, { ...task, requestId: "Bearer token" }, { ...task, status: "succeeded", finishedAt: null }];
    const restored = new FeatureTasks({ identityKey: "alice", initialSnapshot: { version: 1, identityKey: "alice", records: candidates } });
    expect(restored.list()).toStrictEqual([]);
  });

  it("feature filtering is exact, callback timestamps are monotonic, and duplicate updates are quiet", () => {
    const context = setup(); const first = context.begin(); context.tick();
    const second = context.begin({ feature: "fireside" });
    expect(context.tasks.list({ feature: "bonfire" }).map(task => task.id)).toStrictEqual([first.id]);
    expect(context.tasks.list({ feature: "fireside" }).map(task => task.id)).toStrictEqual([second.id]);
    context.tick(-500);
    expect(context.tasks.update(first.id, { detail: "等待结果" })?.updatedAt).toBe(1000);
    context.tasks.update(first.id, { detail: "等待结果" });
    expect(context.changes.length).toBe(3);
  });

  it("accessors and prototype-bearing patches are rejected without evaluating them", () => {
    const context = setup(); const task = context.begin();
    const getter = { get detail() { throw new Error("must not run"); } };
    expect(() => context.tasks.update(task.id, getter)).toThrow(/Invalid task update fields/);
    expect(() => context.tasks.update(task.id, Object.create({ status: "succeeded" }))).toThrow(TypeError);
    const hostileError = { get code() { throw new Error("must not run"); } };
    expect(context.tasks.fail(task.id, hostileError)?.errorCode).toBe("REQUEST_FAILED");
  });

  it("invalid allocation and clock callbacks leave existing records intact", () => {
    let timestamp = 1000;
    let nextId = "first";
    const tasks = new FeatureTasks({ maxRecords: 1, now: () => timestamp, createId: () => nextId });
    const input: FeatureTaskBeginInput = { feature: "bonfire", operation: "read", title: "读取消息" };
    const first = tasks.begin(input);
    timestamp = NaN;
    expect(() => tasks.complete(first.id)).toThrow(TypeError);
    expect(tasks.get(first.id)?.status).toBe("running");
    timestamp = 1001;
    tasks.complete(first.id);
    nextId = "invalid task ID";
    expect(() => tasks.begin(input)).toThrow(TypeError);
    expect(tasks.get(first.id)?.status).toBe("succeeded");
  });

  // Ledger half of test/town-error-ipc.test.cjs case 1; the preload half needs IPC.
  it("Town transport failures survive the task ledger without becoming format errors", () => {
    const tasks = new FeatureTasks();
    for (const code of ["TOWN_TOOL_NOT_CALLED", "RESULT_SOURCE_NOT_CONFIGURED", "READINESS_UNKNOWN", "RESULT_UNCONFIRMED"]) {
      const task = tasks.begin({ feature: "bonfire", operation: "read", title: "读取篝火消息", execution: "being" });
      const failed = tasks.fail(task.id, Object.assign(new Error("固定诊断信息"), { code }));
      expect(failed?.status).toBe("failed");
      expect(failed?.errorCode).toBe(code);
    }
  });
});
