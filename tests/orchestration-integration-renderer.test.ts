// The orchestration page's rules, without a DOM; 2026-09-16.
//
// BeingDesktop 0.8.26 pins these in test/orchestration-ui.cjs, which drives a
// real Electron window: it asserts the status dictionaries, the group summary,
// what happens to an open worker detail when the worker disappears, and — the
// part that is easiest to lose in a rewrite — that a REFUSED mode save puts the
// switch back and offers to retry that exact mode. That file cannot run here (no
// `renderer/index.html`, no BrowserWindow), so the same claims are made against
// the models that now own them. The two that genuinely need a window (the
// breathing activity light, and scrolling a worker into view) are listed in
// docs/migration/i4-orchestration-features.md as not covered.

import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTINUATION, DELIVERY_STATUS, EVENT_LABEL, OrchestrationModel, REVIEW_STATUS, WORKER_STATUS, isActive,
} from "../desktop/renderer/orchestration/models/workers";
import { AGENT_KITS, AGENT_STATUS, PATH_PLACEHOLDER, publicMessage } from "../desktop/renderer/orchestration/models/settings";
import type { DesktopAPI } from "../desktop/shared/types";
import type {
  OrchestrationModeInputState, OrchestrationSnapshotState, OrchestrationWorker, OrchestrationWorkerSummary,
} from "../desktop/shared/desktop-types";

const SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const worker = (id: string, patch: Partial<OrchestrationWorkerSummary> = {}): OrchestrationWorkerSummary => ({
  id, requestId: `req-${id}`, sessionId: SESSION, agentId: "codex", title: `任务 ${id}`,
  parentWorkerId: null, cwd: "/workspace", status: "running", detail: "command_execution · running",
  sequence: 1, startedAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:01.000Z",
  endedAt: null, eventCount: 1, ...patch,
});

const snapshot = (patch: Partial<OrchestrationSnapshotState> = {}): OrchestrationSnapshotState => ({
  mode: { enabled: false, defaultAgent: "codex", paths: {} },
  enforcement: { status: "unchecked" }, agents: [], workers: [], error: "", linkRequired: true, ...patch,
});

interface Harness {
  api: DesktopAPI;
  saves: OrchestrationModeInputState[];
  detections: Record<string, string>[];
  reply: { snapshot: OrchestrationSnapshotState; worker: OrchestrationWorker | null; save: OrchestrationSnapshotState | Error; link: { status?: string } };
  push: (state: OrchestrationSnapshotState) => void;
}

function harness(): Harness {
  const saves: OrchestrationModeInputState[] = [];
  const detections: Record<string, string>[] = [];
  let listener: ((state: OrchestrationSnapshotState) => void) | null = null;
  const reply: Harness["reply"] = { snapshot: snapshot(), worker: null, save: snapshot(), link: { status: "connected" } };
  const api = {
    orchestration: {
      snapshot: async () => reply.snapshot,
      inspectAgents: async (paths: Record<string, string>) => { detections.push(paths); return reply.snapshot.agents; },
      save: async (mode: OrchestrationModeInputState) => {
        saves.push(mode);
        if (reply.save instanceof Error) throw reply.save;
        return reply.save;
      },
      worker: async (id: string) => {
        if (!reply.worker || reply.worker.id !== id) throw new Error(`Error invoking remote method 'beings:worker': Error: 当前连接下没有此 worker。`);
        return reply.worker;
      },
      cancelWorker: async () => reply.worker!,
      retryWorker: async () => reply.worker!,
      reconnect: async () => reply.link,
      onWorkers: (callback: (state: OrchestrationSnapshotState) => void) => { listener = callback; return () => { listener = null; }; },
      featureTasks: async () => ({ tasks: [] }),
      featureTask: async () => null,
      endFeatureTask: async () => null,
      discussFeatureTask: async () => ({ prepared: true as const, taskId: "" }),
      onFeatureTasks: () => () => {},
    },
  } as unknown as DesktopAPI;
  return { api, saves, detections, reply, push: state => listener?.(state) };
}

beforeEach(() => { try { localStorage.clear(); } catch { /* optional */ } });

describe("the worker list", () => {
  it("names every status the way BeingDesktop does", () => {
    // renderer/orchestration.js lines 5-8, copied from the source file.
    expect(WORKER_STATUS).toEqual({
      starting: "正在启动", queued: "排队中", running: "执行中", stopping: "正在停止",
      completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断",
    });
    expect(REVIEW_STATUS).toEqual({
      pending: "待验收", processing: "Being 验收中", passed: "验收通过",
      failed: "验收未通过", needs_verification: "待补充验证", cancelled: "接续已停止",
    });
    expect(DELIVERY_STATUS).toEqual({
      pending: "待通知", sending: "正在通知", retrying: "通知重试中",
      accepted: "Heart 已接收", failed: "通知失败", suppressed: "通知已停止",
    });
    expect(CONTINUATION.uncertain).toBe("自动接续状态未确认，请检查原会话；不会重复执行 Worker。");
    expect(EVENT_LABEL.message).toBe("Agent 输出");
    // The four statuses that mean "still working" — the set the conversation's
    // activity light and the group summary both read.
    expect(["starting", "queued", "running", "stopping", "completed", "failed", "cancelled", "interrupted"]
      .filter(status => isActive({ status }))).toEqual(["starting", "queued", "running", "stopping"]);
  });

  it("groups workers by conversation and counts the ones still running", () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    model.receive(snapshot({ workers: [
      worker("a"), worker("b", { status: "completed" }), worker("c", { sessionId: OTHER, status: "queued" }),
    ] }));
    expect(model.sessions()).toEqual([SESSION, OTHER]);
    expect(model.workersFor(SESSION).map(item => item.id)).toEqual(["a", "b"]);
    expect(model.workersFor(SESSION).filter(isActive)).toHaveLength(1);
    // The rule BeingDesktop's UI test spends most of its length on: a running
    // worker makes its conversation active, and a finished one does not.
    expect(model.hasActiveWorkers(SESSION)).toBe(true);
    model.receive(snapshot({ workers: [worker("a", { status: "completed" })] }));
    expect(model.hasActiveWorkers(SESSION)).toBe(false);
  });

  it("remembers which groups are collapsed across a restart", () => {
    const f = harness();
    // A stand-in for the browser's own storage: node's `localStorage` throws on
    // write in this process, which would make the claim below vacuous.
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } };
    const model = new OrchestrationModel(f.api, storage);
    expect(model.isCollapsed(SESSION)).toBe(false);
    model.toggleGroup(SESSION);
    expect(model.isCollapsed(SESSION)).toBe(true);
    // A second model reads the same storage, which is what "across a restart"
    // means for a renderer.
    expect(new OrchestrationModel(f.api, storage).isCollapsed(SESSION)).toBe(true);
    model.toggleGroup(SESSION);
    expect(new OrchestrationModel(f.api, storage).isCollapsed(SESSION)).toBe(false);
    // A storage that refuses still leaves the toggles working in memory.
    const broken = new OrchestrationModel(f.api, { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    broken.toggleGroup(SESSION);
    expect(broken.isCollapsed(SESSION)).toBe(true);
  });
});

describe("the worker detail", () => {
  it("drops a worker that is no longer in the snapshot and says which connection it was under", async () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    f.reply.worker = { ...worker("a"), taskPrompt: "做点事", result: "", events: [] };
    model.receive(snapshot({ workers: [worker("a")] }));
    await model.select("a");
    expect(model.worker?.id).toBe("a");
    model.receive(snapshot({ workers: [] }));
    expect(model.selected).toBe("");
    expect(model.worker).toBeNull();
    expect(model.detailError).toBe("当前连接下没有此 worker。");
  });

  it("ignores a reply for a worker the user already navigated away from", async () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    f.reply.worker = { ...worker("a"), taskPrompt: "", result: "", events: [] };
    model.receive(snapshot({ workers: [worker("a"), worker("b")] }));
    const pending = model.select("a");
    model.back();
    await pending;
    expect(model.worker).toBeNull();
    expect(model.selected).toBe("");
  });

  it("shows the main process's own sentence when a detail cannot be read", async () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    model.receive(snapshot({ workers: [worker("a")] }));
    await model.select("a");
    // The IPC wrapper's prefix is stripped, as BeingDesktop's `perform` does.
    expect(model.detailError).toBe("当前连接下没有此 worker。");
    expect(publicMessage(new Error("Error invoking remote method 'beings:worker': Error: 失败了"))).toBe("失败了");
    expect(publicMessage(null)).toBe("操作失败，请重试。");
  });
});

describe("the mode editor", () => {
  it("lists BeingDesktop's four adapters, their names and their state words", () => {
    expect(AGENT_KITS.map(([id]) => id)).toEqual(["codex", "claude", "cursor", "grok"]);
    expect(AGENT_KITS.map(([, name]) => name)).toEqual(["Codex CLI", "Claude Code CLI", "Cursor CLI", "Grok Build CLI"]);
    expect(AGENT_STATUS).toEqual({ ready: "可执行", missing: "未安装", needs_auth: "需要登录", incompatible: "接口不兼容", error: "检测失败" });
    expect(PATH_PLACEHOLDER).toBe("自动从 PATH 检测，或填写程序绝对路径");
  });

  it("saves on every change, with no save button in between", async () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    f.reply.save = snapshot({ mode: { enabled: true, defaultAgent: "claude", paths: { claude: "/fixture/claude" } }, enforcement: { status: "enforced", detail: "已核验当前 Desktop：本机执行通过 Worker 调度。" } });
    model.settings.toggle(true);
    await model.settings.save();
    expect(f.saves.at(-1)).toMatchObject({ enabled: true });
    model.settings.setDefaultAgent("claude");
    await model.settings.save();
    model.settings.setPath("claude", " /fixture/claude ");
    model.settings.commitPath();
    await model.settings.save();
    // Trimmed before it leaves the page, as the source's `draft()` does.
    expect(f.saves.at(-1)!.paths).toEqual({ codex: "", claude: "/fixture/claude", cursor: "", grok: "" });
    expect(model.settings.status).toBe("编排已开启，配置已自动保存，调度工具已就绪。");
    expect(model.settings.policyDetail).toBe("已核验当前 Desktop：本机执行通过 Worker 调度。");
  });

  it("puts the switch back and offers the same mode again when a save is refused", async () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    model.receive(snapshot());
    f.reply.save = new Error("Error invoking remote method 'beings:orchestration-save': Error: 本机 Worker 工具不可用");
    model.settings.toggle(true);
    await model.settings.save(true);
    // The mode did not change, so the switch must not claim it did.
    expect(model.settings.enabled).toBe(false);
    expect(model.settings.status).toBe("本机 Worker 工具不可用");
    expect(model.settings.statusKind).toBe("error");
    expect(model.settings.failed).toMatchObject({ enabled: true });
    // Retry re-sends exactly the refused mode, not the current form.
    f.reply.save = snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: {} }, enforcement: { status: "pending" } });
    model.settings.retry();
    await model.settings.save(true, model.settings.failed!);
    expect(f.saves.at(-1)).toMatchObject({ enabled: true });
    expect(model.settings.enabled).toBe(true);
    expect(model.settings.failed).toBeNull();
    expect(model.settings.status).toBe("编排已开启，配置已自动保存，正在连接 Worker 调度工具…");
  });

  it("keeps what is being typed when a push lands mid-edit", () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    model.receive(snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: { codex: "/one" } } }));
    model.settings.setPath("codex", "/being-typed");
    f.push(snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: { codex: "/two" } } }));
    model.receive(snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: { codex: "/two" } } }));
    expect(model.settings.paths.codex).toBe("/being-typed");
  });

  it("says each of the three mode states in BeingDesktop's words", () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    model.settings.showModeStatus(snapshot());
    expect(model.settings.status).toBe("编排模式已关闭。开启时会自动检测并保存配置。");
    model.settings.showModeStatus(snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: {} }, enforcement: { status: "blocked" } }));
    expect(model.settings.status).toBe("配置已自动保存，但调度工具暂不可用；本机执行暂停，对话可继续。");
    expect(model.settings.statusKind).toBe("error");
    model.settings.showModeStatus(snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: {} }, enforcement: { status: "enforced" } }));
    expect(model.settings.status).toBe("编排已开启，配置已自动保存，调度工具已就绪。");
  });

  it("detects without saving, and reports the bridge honestly", async () => {
    const f = harness();
    const model = new OrchestrationModel(f.api);
    model.receive(snapshot({ mode: { enabled: true, defaultAgent: "codex", paths: { codex: "/fixture/codex" } } }));
    await model.settings.detect();
    expect(f.detections).toEqual([{ codex: "/fixture/codex", claude: "", cursor: "", grok: "" }]);
    expect(f.saves).toEqual([]);
    expect(model.settings.status).toBe("检测完成。可执行不代表任务必定成功；登录和权限错误会显示在 worker 事件中。");
    f.reply.link = { status: "disconnected" };
    await model.settings.reconnect();
    expect(model.settings.status).toBe("调度工具未连接，请确认 Being 连接和编排模式。");
    f.reply.link = { status: "connected" };
    await model.settings.reconnect();
    expect(model.settings.status).toBe("调度工具已连接。");
  });
});
