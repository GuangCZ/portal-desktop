// Ported from BeingDesktop 0.8.26 test/feature-task-runner.test.cjs on 2026-09-16 (node:test -> vitest).
// Fixtures are copied verbatim; only the assertion style changed.

import { describe, expect, it } from "vitest";
import { FeatureTasks } from "../desktop/main/features/feature-tasks";
import { FeatureTaskRunner, currentTask } from "../desktop/main/features/feature-task-runner";

function setup() {
  let sequence = 0;
  let ledger = new FeatureTasks({ createId: () => `task-${++sequence}`, identityKey: "alice" });
  const runner = new FeatureTaskRunner({ getLedger: () => ledger });
  return { runner, get ledger() { return ledger; }, replace() { ledger = new FeatureTasks({ createId: () => `task-${++sequence}`, identityKey: "bob" }); } };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const bonfire = { kind: "bonfire", snapshot: { messages: [{ content: "private message" }] }, status: { status: "ready", errorCode: "" } };

describe("feature task runner", () => {
  it("only allowlisted user operations create task records", async () => {
    const context = setup();
    for (const name of ["getTownMessageSnapshot", "refreshTownMessages", "getFiresides", "sendBonfireMessage", "unknown"]) expect(context.runner.run(name, [], () => 42)).toBe(42);
    expect(context.ledger.list().length).toBe(0);
    expect(context.runner.run("requestTownRead", [{ kind: "invalid" }], () => "validation handled by caller")).toBe("validation handled by caller");
    const result = await context.runner.run("requestTownRead", [{ kind: "bonfire" }], () => bonfire);
    expect(result).toBe(bonfire);
    expect(context.ledger.list()[0].summary).toBe("已读取 1 条篝火消息。");
    expect(context.ledger.list()[0].mayDelayChat).toBe(true);
    expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/private message/);
  });

  it("identical concurrent requests share the same promise even with reordered object keys", async () => {
    const context = setup(), pending = deferred<{ scrolls: unknown[] }>(); let sends = 0;
    const first = context.runner.run("listScrolls", [{ offset: 0, limit: 10 }], () => { sends++; return pending.promise; });
    const second = context.runner.run("listScrolls", [{ limit: 10, offset: 0 }], () => { sends++; return pending.promise; });
    expect(first).toBe(second);
    await Promise.resolve(); expect(sends).toBe(1);
    expect(context.ledger.list().length).toBe(1);
    pending.resolve({ scrolls: [] }); await first;
    expect(context.ledger.list()[0].status).toBe("succeeded");
  });

  it("a settled request never replays itself; a new explicit invocation can run again", async () => {
    const context = setup(); let sends = 0;
    const fn = () => { sends++; return { status: "pending" }; };
    await context.runner.run("beginChannelConnection", [{ channel: "wechat" }], fn);
    expect(context.ledger.list()[0].status).toBe("waiting");
    await Promise.resolve(); expect(sends).toBe(1);
    await context.runner.run("beginChannelConnection", [{ channel: "wechat" }], fn);
    expect(sends).toBe(2);
  });

  it("returning to a Fireside starts a new selection while the previous selection is still settling", async () => {
    const context = setup(), previous = deferred(), current = deferred();
    const calls: { firesideId: string; selectionRevision: number }[] = [];
    const read = (firesideId: string, selectionRevision: number, pending: { promise: Promise<unknown> }) => context.runner.run("requestTownRead", [{ kind: "fireside", firesideId, selectionRevision }], () => {
      calls.push({ firesideId, selectionRevision });
      return pending.promise;
    });
    const first = read("1", 1, previous);
    const firstResult = expect(first).rejects.toHaveProperty("code", "SESSION_CHANGED");
    const selected = read("1", 3, current);
    const duplicate = read("1", 3, current);
    expect(first).not.toBe(selected);
    expect(selected).toBe(duplicate);
    await Promise.resolve();
    expect(calls).toStrictEqual([{ firesideId: "1", selectionRevision: 1 }, { firesideId: "1", selectionRevision: 3 }]);
    const result = { kind: "fireside", firesideId: "1", snapshot: { messages: [] }, status: { status: "ready", errorCode: "" } };
    current.resolve(result);
    expect(await selected).toBe(result);
    previous.reject(Object.assign(new Error("Previous room selection was cancelled"), { code: "SESSION_CHANGED" }));
    await firstResult;
    expect(context.ledger.list().filter(task => task.status === "succeeded").length).toBe(1);
    expect(context.ledger.list().filter(task => task.status === "failed").length).toBe(1);
  });

  it("identity changes isolate old request callbacks and duplicate maps", async () => {
    const context = setup(), firstPending = deferred<{ scrolls: unknown[] }>(), secondPending = deferred<{ scrolls: unknown[] }>();
    const oldLedger = context.ledger;
    const first = context.runner.run("listScrolls", [{}], () => firstPending.promise);
    context.replace();
    const second = context.runner.run("listScrolls", [{}], () => secondPending.promise);
    expect(first).not.toBe(second);
    firstPending.resolve({ scrolls: [] }); await first;
    expect(oldLedger.list()[0].status).toBe("succeeded");
    expect(context.ledger.list()[0].status).toBe("running");
    secondPending.resolve({ scrolls: [{ title: "new" }] }); await second;
    expect(context.ledger.list()[0].summary).toBe("已读取 1 份卷轴的目录。");
  });

  it("request correlation stays inside asynchronous task context and never stores the prompt", async () => {
    const context = setup();
    expect(currentTask()).toBe(null);
    await context.runner.run("requestTownRead", [{ kind: "bonfire" }], async () => {
      await Promise.resolve();
      const active = currentTask();
      expect(active?.ledger).toBe(context.ledger);
      expect(active?.task.feature).toBe("bonfire");
      context.runner.recordRequest({ requestId: "request-1", prompt: "private prompt", token: "private token" });
      return bonfire;
    });
    expect(context.runner.currentTask()).toBe(null);
    expect(context.ledger.list()[0].requestId).toBe("request-1");
    expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/private prompt|private token/);
    expect(context.runner.recordRequest({ requestId: "outside" })).toBe(null);
  });

  it("independent concurrent tasks retain their own AsyncLocalStorage request identifiers", async () => {
    const context = setup(), release = deferred();
    const first = context.runner.run("getScroll", [{ id: "one" }], async () => { await release.promise; context.runner.recordRequest({ requestId: "one" }); return { scroll: { title: "one" } }; });
    const second = context.runner.run("getScroll", [{ id: "two" }], async () => { context.runner.recordRequest({ requestId: "two" }); release.resolve(undefined); return { scroll: { title: "two" } }; });
    await Promise.all([first, second]);
    expect(context.ledger.list().map(task => task.requestId).sort()).toStrictEqual(["one", "two"]);
  });

  it("accepted and unknown execution results stay waiting and preserve original errors", async () => {
    for (const code of ["REQUEST_ACCEPTED", "RESULT_UNKNOWN"]) {
      const context = setup();
      const error = Object.assign(new Error("raw secret payload"), { code });
      await expect(context.runner.run("listScrolls", [{}], () => { throw error; })).rejects.toBe(error);
      expect(context.ledger.list()[0].status).toBe("waiting");
      expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/raw secret/);
    }
    const context = setup();
    const result = { accepted: true };
    expect(await context.runner.run("listScrolls", [{}], () => result)).toBe(result);
    expect(context.ledger.list()[0].status).toBe("waiting");
  });

  it("response errors cannot appear as successful tasks while existing UI receives the same result", async () => {
    for (const response of [{ error: { code: "NETWORK_ERROR", message: "secret" } }, { __townError: true, code: "SERVICE_ERROR" }, { ok: false, code: "SERVICE_ERROR" }]) {
      const context = setup();
      expect(await context.runner.run("getGroveCatalog", [{}], () => response)).toBe(response);
      expect(context.ledger.list()[0].status).toBe("failed");
      expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/secret/);
    }
  });

  it("a rejected preflight ends locally and a later explicit read can complete independently", async () => {
    const context = setup();
    await expect(context.runner.run("requestTownRead", [{ kind: "bonfire" }], () => { throw Object.assign(new Error("busy"), { code: "BUSY" }); })).rejects.toHaveProperty("code", "BUSY");
    const rejected = context.ledger.list()[0];
    expect(rejected.status).toBe("failed"); expect(rejected.requestId).toBe(""); expect(rejected.detail).toMatch(/未发送/);
    await context.runner.run("requestTownRead", [{ kind: "bonfire" }], () => bonfire);
    expect(context.ledger.list()[0].status).toBe("succeeded"); expect(context.ledger.get(rejected.id)?.status).toBe("failed");
  });

  it("explicit busy and accepted transport states take precedence over stale result arrays", async () => {
    for (const status of ["accepted", "busy", "BUSY", 202]) {
      const context = setup();
      await context.runner.run("listScrolls", [{}], () => ({ status, scrolls: [] }));
      expect(context.ledger.list()[0].status).toBe(["busy", "BUSY"].includes(status as string) ? "failed" : "waiting");
    }
  });

  it("Town old snapshots never count as a successful new request when status reports failure or waiting", async () => {
    for (const [code, expected] of [["REQUEST_ACCEPTED", "waiting"], ["BUSY", "failed"], ["READINESS_UNKNOWN", "failed"], ["RESULT_UNCONFIRMED", "needs_input"], ["NETWORK_ERROR", "failed"]]) {
      const context = setup();
      const response = { ...bonfire, status: { status: "waiting", errorCode: code } };
      await context.runner.run("requestTownRead", [{ kind: "bonfire" }], () => response);
      expect(context.ledger.list()[0].status).toBe(expected);
      expect(context.ledger.list()[0].summary).toBe("");
    }
  });

  it("Grove installation checks require user setup and never claim installation", async () => {
    const context = setup();
    await context.runner.run("prepareGroveInstallation", [{ id: "kit" }], () => ({ status: "needs_setup", kit: { name: "name", env: { API_KEY: "private" } }, assessment: { blocked: true } }));
    const task = context.ledger.list()[0];
    expect(task.status).toBe("needs_input");
    expect(task.mayDelayChat).toBe(false);
    expect(task.detail).toMatch(/尚未安装或运行脚本/);
    expect(JSON.stringify(task)).not.toMatch(/private|API_KEY/);
  });

  // Added during review follow-up (not in the source file): pins the CJS `item.status` reading of batch
  // results so a later rewrite cannot turn a malformed batch into a falsely successful task.
  it("batch installation counts read plain property values and refuse to summarize a malformed batch", async () => {
    const counted = setup();
    const inherited = Object.create({ status: "installed" }) as object;
    const accessor = Object.defineProperty({}, "status", { get() { return "installed"; } });
    await counted.runner.run("installEligibleGroveKits", [{}], () => ({ results: [inherited, accessor, { status: "needs_being" }, { status: "failed" }] }));
    expect(counted.ledger.list()[0].status).toBe("succeeded");
    expect(counted.ledger.list()[0].summary).toBe("批量检查 4 个 Kit：本机已安装 2 个，需 Being 协助 1 个，失败 1 个。加载状态见工具市场。");
    const malformed = setup();
    await expect(malformed.runner.run("installEligibleGroveKits", [{}], () => ({ results: [null] }))).rejects.toThrow(TypeError);
    expect(malformed.ledger.list()[0].status).toBe("failed");
    expect(malformed.ledger.list()[0].errorCode).toBe("REQUEST_FAILED");
    expect(malformed.ledger.list()[0].summary).toBe("");
  });

  it("Channel outcomes distinguish QR authorization, pending, unsupported and confirmed statuses", async () => {
    for (const [result, expected] of [[{ status: "pending" }, "waiting"], [{ status: "unknown" }, "waiting"], [{ status: "pending", qrCodeDataUrl: "data:image/png;base64,private" }, "needs_input"], [{ status: "registered" }, "needs_input"], [{ status: "unsupported" }, "failed"], [{ status: "connected" }, "succeeded"]] as const) {
      const context = setup();
      await context.runner.run("beginChannelConnection", [{ channel: "wechat" }], () => ({ ...result, detail: "secret raw channel response" }));
      expect(context.ledger.list()[0].status).toBe(expected);
      expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/base64|secret raw|qrCode/);
    }
  });

  it("Channel checks can report disconnection while a connection operation still needs action", async () => {
    const context = setup();
    await context.runner.run("checkChannelStatus", [{ channel: "feishu" }], () => ({ status: "disconnected" }));
    expect(context.ledger.list()[0].status).toBe("succeeded");
    await context.runner.run("beginChannelConnection", [{ channel: "feishu" }], () => ({ status: "disconnected" }));
    expect(context.ledger.list()[0].status).toBe("needs_input");
  });

  it("Portal status confirms local process operations without implying a verified relay", async () => {
    const context = setup();
    await context.runner.run("startPortal", [], () => ({ portal: { status: "running", health: "unknown" } }));
    expect(context.ledger.list()[0].status).toBe("succeeded");
    expect(context.ledger.list()[0].summary).toMatch(/中继连接状态.*确认/);
    await context.runner.run("stopPortal", [], () => ({ portal: { status: "external" } }));
    expect(context.ledger.list()[0].status).toBe("needs_input");
    await context.runner.run("deployPortal", [], () => ({ status: "existing_connection" }));
    expect(context.ledger.list()[0].status).toBe("needs_input");
    await context.runner.run("stopPortal", [], () => ({ portal: { status: "stopped" } }));
    expect(context.ledger.list()[0].status).toBe("succeeded");
  });

  it("Portal update response errors are failures even when the outer call resolved", async () => {
    const context = setup();
    await context.runner.run("checkPortalUpdates", [], () => ({ portalUpdate: { status: "error" } }));
    expect(context.ledger.list()[0].status).toBe("failed");
    await context.runner.run("checkPortalUpdates", [], () => ({ portalUpdate: { status: "available", releaseUrl: "https://example.test/?token=secret" } }));
    expect(context.ledger.list()[0].status).toBe("succeeded");
    expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/example.test|secret/);
  });

  it("curated library and Grove summaries contain titles and counts, not raw bodies or setup data", async () => {
    const context = setup();
    await context.runner.run("getScroll", [{ id: "one" }], () => ({ scroll: { title: "日志", content: "private body" } }));
    await context.runner.run("getGroveCatalog", [{}], () => ({ kits: [{ name: "one", description: "private manifest" }] }));
    await context.runner.run("getGroveDetail", ["one"], () => ({ name: "One", setup_guide: { env_template: { TOKEN: "private setup" } } }));
    await context.runner.run("requestTownRead", [{ kind: "fireside" }], () => ({ rooms: { owned: [{ id: 1, description: "private room" }], joined: [] } }));
    expect(context.ledger.list().every(task => task.status === "succeeded")).toBe(true);
    expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/private body|private manifest|private setup|private room|env_template/);
  });

  it("unknown response shapes remain unconfirmed and raw backend exceptions retain identity", async () => {
    const context = setup();
    await context.runner.run("getScroll", [{ id: "one" }], () => ({ message: "done" }));
    expect(context.ledger.list()[0].status).toBe("waiting");
    const error = new Error("private upstream exception");
    await expect(context.runner.run("getGroveDetail", ["one"], () => Promise.reject(error))).rejects.toBe(error);
    expect(context.ledger.list()[0].status).toBe("failed");
    expect(JSON.stringify(context.ledger.snapshot())).not.toMatch(/private upstream/);
  });

  it("a full active ledger never prevents stopping Portal but still blocks new tracked work", async () => {
    const ledger = new FeatureTasks({ maxRecords: 1 });
    const existing = ledger.begin({ feature: "channel", operation: "connect", title: "渠道授权", execution: "being" });
    ledger.update(existing.id, { status: "waiting" });
    const runner = new FeatureTaskRunner({ getLedger: () => ledger });
    let stopped = 0;
    const result = { portal: { status: "stopped" } };
    expect(await runner.run("stopPortal", [], async () => { stopped++; return result; })).toBe(result);
    expect(stopped).toBe(1);
    expect(ledger.list().length).toBe(1);
    expect(ledger.get(existing.id)?.status).toBe("waiting");
    let started = 0;
    let caught: { code?: string } | undefined;
    try { runner.run("startPortal", [], () => { started++; }); } catch (error) { caught = error as { code?: string }; }
    expect(caught?.code).toBe("TASK_LIMIT_REACHED");
    expect(started).toBe(0);
  });

  it("the full-ledger stop escape preserves stop failures and never swallows unrelated bookkeeping errors", async () => {
    const ledger = new FeatureTasks({ maxRecords: 1 });
    ledger.begin({ feature: "portal", operation: "inspect", title: "待核对" });
    const runner = new FeatureTaskRunner({ getLedger: () => ledger });
    const stopError = new Error("Portal could not stop");
    await expect(runner.run("stopPortal", [], async () => { throw stopError; })).rejects.toBe(stopError);
    let stopped = false;
    const ledgerError = new Error("Unexpected ledger failure");
    ledger.begin = () => { throw ledgerError; };
    let caught: unknown;
    // The escape hatch must rethrow the ledger error itself, not a look-alike: assert identity, not message.
    try { runner.run("stopPortal", [], () => { stopped = true; }); } catch (error) { caught = error; }
    expect(caught).toBe(ledgerError);
    expect(stopped).toBe(false);
  });
});
