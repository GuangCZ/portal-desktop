// Ported from BeingDesktop 0.8.26 test/feature-task-discussion.test.cjs on 2026-09-16 (node:test -> vitest).
// Fixtures are copied verbatim; only the assertion style changed. `prepareDraft` is required here
// because its BeingDesktop default (`prepareLoomDraft` in src/town.cjs) belongs to another unit.

import { describe, expect, it } from "vitest";
import { FeatureTasks } from "../desktop/main/features/feature-tasks";
import { discussFeatureTask } from "../desktop/main/features/feature-task-discussion";
import type { FeatureTaskContext, FeatureTaskLedger } from "../desktop/main/features/types";

function fixture() {
  let ledger = new FeatureTasks();
  const task = ledger.begin({ feature: "bonfire", operation: "read", title: "读取篝火", execution: "being" });
  ledger.complete(task.id, { summary: "已读取 10 条消息。token=private-value" });
  let context: FeatureTaskContext = { connection: {}, generation: 1 };
  const drafts: string[] = [];
  return { task, drafts, options: { getLedger: (): FeatureTaskLedger => ledger, getContext: () => context, prepareDraft: async (text: string, getContext: () => FeatureTaskContext) => { getContext(); drafts.push(text); } }, changeLedger: () => { ledger = new FeatureTasks(); }, changeContext: () => { context = { ...context, generation: 2 }; } };
}

describe("feature task discussion", () => {
  it("discussion explicitly prepares only a safe summary, without sending or changing task status", async () => {
    const f = fixture();
    expect(await discussFeatureTask(f.task.id, f.options)).toStrictEqual({ prepared: true, taskId: f.task.id });
    expect(f.drafts.length).toBe(1);
    expect(f.drafts[0]).toMatch(/读取篝火/);
    expect(f.drafts[0]).toMatch(/已读取 10 条/);
    expect(f.drafts[0]).toMatch(/尚未确认与聊天执行队列隔离/);
    expect(f.drafts[0]).not.toMatch(/private-value/);
    expect(f.options.getLedger().get(f.task.id)?.status).toBe("succeeded");
  });

  it("unknown and previous identity tasks cannot prepare a draft", async () => {
    const f = fixture();
    await expect(discussFeatureTask({}, f.options)).rejects.toThrow(/有效/);
    await expect(discussFeatureTask("missing", f.options)).rejects.toThrow(/不存在/);
    f.changeLedger();
    await expect(discussFeatureTask(f.task.id, f.options)).rejects.toThrow(/不存在/);
    expect(f.drafts.length).toBe(0);
  });

  it("draft preparation propagates existing-draft errors and preserves the task", async () => {
    const f = fixture();
    f.options.prepareDraft = async () => { throw new Error("Loom 中已有草稿"); };
    await expect(discussFeatureTask(f.task.id, f.options)).rejects.toThrow(/已有草稿/);
    expect(f.options.getLedger().get(f.task.id)?.status).toBe("succeeded");
  });

  it("identity and connection are checked again during asynchronous preparation", async () => {
    for (const kind of ["changeLedger", "changeContext"] as const) {
      const f = fixture();
      f.options.prepareDraft = async (_prompt: string, current: () => FeatureTaskContext) => { f[kind](); current(); };
      await expect(discussFeatureTask(f.task.id, f.options)).rejects.toThrow(/变化/);
    }
  });
});
