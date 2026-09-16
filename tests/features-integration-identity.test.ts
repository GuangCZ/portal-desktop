// The feature-task ledger's identity rules, wired; 2026-09-16 (integration plan
// §3.4). The port (docs/migration/u7-features.md) proved the ledger, the runner
// and the encrypted history in isolation. This file proves what the composition
// root around them does — the part BeingDesktop 0.8.26 keeps inline in
// src/main.cjs and which therefore had no test of its own:
//
//   * one ledger per Being identity, opened lazily and kept open;
//   * the renderer is shown an EMPTY list before the next identity's file is
//     read, so the previous Being's tasks never appear under the new one's name
//     (src/main.cjs line 492);
//   * every「功能任务」channel is refused while the ledger does not match the
//     connected Being, with three different sentences for the three stages the
//     identity can move at (lines 505, 726, 732). They are not interchangeable:
//     each says what the user has to do next, and 0.8.26 words them differently
//     on purpose;
//   * `endFeatureTaskTracking`'s `reading` rule (lines 1243-1251), which decides
//     which running tasks may be dropped locally;
//   * enrolled Town sync records are validated by the real
//     `normalizeTownSyncRecords`, not by a copy of it.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { beingIdentityKey } from "../desktop/main/chat/connection";
import { installSubsystems, type DesktopExtensionsContext } from "../desktop/main/extensions";
import { installOrchestrationSubsystem, type OrchestrationSubsystem } from "../desktop/main/subsystems/orchestration";
import { EXITING, SESSION_CHANGED, createFeatureMethods } from "../desktop/main/features/methods";
import { FeatureTaskRunner } from "../desktop/main/features/feature-task-runner";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { Connection } from "../desktop/main/chat/connection";
import type { FeatureTaskContext } from "../desktop/main/features/types";
import type { Settings } from "../desktop/shared/types";
import type { SubsystemContext, SubsystemInstaller } from "../desktop/main/subsystems/types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const SHELL = "beings://desktop/";
const token = "c".repeat(64);
const connectionFor = (being: string): Connection => ({
  endpoint: `https://echo.beings.town/${being}`, being, token, relaySecret: token,
  link: `https://echo.beings.town/${being}/?token=${token}`,
});
const FIRST = connectionFor("cz_being");
const SECOND = connectionFor("other_being");

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "features-identity-test-"));
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const drafts: { prompt: string; context: FeatureTaskContext }[] = [];
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => false, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => false, webContents };
  const store = {
    connection: null as Connection | null,
    connectionAddress: "",
    settings: {} as Settings,
    extras: {} as Record<string, unknown>,
    saveExtra: async () => {},
  };
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => false, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  // Real encryption is unavailable in a test process, and a history that cannot
  // encrypt refuses to hold anything — so a working stand-in for electron's
  // safeStorage is what lets the ledger behave the way it does in the client.
  const secretStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
  const context: DesktopExtensionsContext = {
    handle, exclusive: operation => operation(),
    window: () => window, store, secretStorage,
    userData: directory, desktopId: DESKTOP, clientVersion: "0.9.0",
    fetchImpl: (async () => { throw new Error("no network in this fixture"); }) as unknown as typeof fetch,
    onError: (scope, error) => { errors.push({ scope, error }); },
  };
  let subsystem!: OrchestrationSubsystem;
  const installer: SubsystemInstaller = Object.defineProperty((ctx: SubsystemContext) => {
    subsystem = installOrchestrationSubsystem(ctx, { detect: async () => [], inspectOnStart: false });
    return subsystem;
  }, "name", { value: "installOrchestrationSubsystem" });
  const extensions = installSubsystems(context, [installer]);
  await extensions.ready; await settle();
  subsystem.setDraftPreparer(async (prompt, current) => { drafts.push({ prompt, context: current() }); });

  return {
    extensions, handlers, pushes, errors, drafts, store, directory,
    subsystem: () => subsystem,
    connect: async (connection: Connection | null) => {
      store.connection = connection;
      store.connectionAddress = connection?.link ?? "";
      if (connection) extensions.connectionVerified(connection);
      else await extensions.connectionCleared();
      await extensions.ready; await settle();
    },
    invoke: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args),
    cleanup: async () => { await extensions.quitting(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("the three refusals are BeingDesktop's three different sentences", () => {
  // Copied from BeingDesktop 0.8.26 src/main.cjs lines 505, 726 and 732. Folding
  // them into one message would lose what each one tells the user to do.
  expect(SESSION_CHANGED.restore).toBe("连接身份已变化，请重新读取功能任务。");
  expect(SESSION_CHANGED.entry).toBe("连接身份正在切换，请稍后重新选择功能。");
  expect(SESSION_CHANGED.queued).toBe("连接身份已变化，请重新选择功能。");
  expect(new Set(Object.values(SESSION_CHANGED)).size).toBe(3);
});

test("switching Beings empties the list first, then opens that Being's own ledger", async () => {
  const f = await fixture();
  try {
    // No Being configured is a real identity, not the absence of one: local work
    // is recorded before a connection exists (BeingDesktop's 'disconnected').
    expect(f.subsystem().histories.identity()).toBe("disconnected");
    expect(await f.invoke("beings:feature-tasks", {})).toEqual({ tasks: [], persistenceError: false });

    await f.connect(FIRST);
    expect(f.subsystem().histories.identity()).toBe(beingIdentityKey(FIRST.link));
    const ledger = f.subsystem().histories.ledger!;
    ledger.begin({ feature: "bonfire", operation: "read", title: "读取篝火消息", execution: "being" });
    await settle();
    expect((await f.invoke("beings:feature-tasks", {}) as any).tasks).toHaveLength(1);

    f.pushes.length = 0;
    await f.connect(SECOND);
    // The empty list goes out BEFORE the next file is read; the first push must
    // not be the previous Being's rows under the new Being's name.
    const tasks = f.pushes.filter(push => push.channel === "beings:feature-tasks").map(push => push.payload);
    expect(tasks[0]).toEqual({ tasks: [] });
    expect(tasks.at(-1)).toEqual({ tasks: [], persistenceError: false });
    expect((await f.invoke("beings:feature-tasks", {}) as any).tasks).toEqual([]);

    // Going back reopens the first Being's ledger with its row still in it.
    await f.connect(FIRST);
    expect((await f.invoke("beings:feature-tasks", {}) as any).tasks).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("a rolled-back save leaves the manager and the ledger on the same Being", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    // main.ts's `beings:save`, on the path its own comment calls an ordinary one
    // (lines 449-469): `verifyConnection()` announces the Being being switched
    // TO, the takeover then fails, the store is rolled back and the previous
    // Being is announced again. Neither announcement is awaited — and
    // `Orchestration.selectOwner` decides "already there?" synchronously but
    // commits the new owner only after `stopAll()` and `flush()` have awaited.
    // Unless the two are serialized, the FIRST call commits LAST: the manager
    // ends up holding the Being the user was just refused, while the store, the
    // ledger and the session partition all say the previous one.
    f.store.connection = SECOND; f.store.connectionAddress = SECOND.link;
    f.extensions.connectionVerified(SECOND);
    f.store.connection = FIRST; f.store.connectionAddress = FIRST.link;
    f.extensions.connectionVerified(FIRST);
    await f.extensions.ready; await settle();

    // What every worker completion is checked against (`sessionPartition(...)
    // !== owner` in orchestration/worker-callbacks.ts): an owner that disagrees
    // with the connection refuses all of them and retries forever.
    expect(f.subsystem().orchestration.owner).toBe(beingIdentityKey(FIRST.link));
    expect(f.subsystem().histories.identity()).toBe(beingIdentityKey(FIRST.link));
    expect(f.subsystem().histories.currentIdentity()).toBe(true);
    expect(f.errors).toEqual([]);

    // And the same holds for the plain switch, where the second announcement is
    // the one that should win.
    f.store.connection = SECOND; f.store.connectionAddress = SECOND.link;
    f.extensions.connectionVerified(SECOND);
    f.extensions.connectionVerified(SECOND);
    await f.extensions.ready; await settle();
    expect(f.subsystem().orchestration.owner).toBe(beingIdentityKey(SECOND.link));
    expect(f.subsystem().histories.currentIdentity()).toBe(true);
  } finally { await f.cleanup(); }
});

test("a serialized call that was waiting on the queue when shutdown began is refused", async () => {
  // BeingDesktop src/main.cjs line 730 re-reads `exitStarted` AFTER the mutation
  // queue hands the turn over, and before it compares the ledger. The shell's own
  // quitting guard (app/ipc.ts) only covers the moment the call arrives, which is
  // the wrong moment: a serialized body waits behind every other mutation, and
  // shutdown normally begins while one is queued.
  let exiting = false;
  let release!: () => void;
  const queue = new Promise<void>(resolve => { release = resolve; });
  const methods = createFeatureMethods({
    // `discussFeatureTask` has no ledger definition, so the runner passes it
    // straight through — which is what it does in the client too.
    runner: new FeatureTaskRunner({ getLedger: () => { throw new Error("no ledger in this fixture"); } }),
    current: () => true, ledger: () => null,
    exclusive: operation => queue.then(operation),
    exiting: () => exiting,
  });
  let ran = false;
  const pending = methods.run([], { operation: "discussFeatureTask", serialized: true }, () => { ran = true; });
  exiting = true;
  release();
  await expect(pending).rejects.toThrow(EXITING);
  expect(ran).toBe(false);
});

test("the subsystem wires that guard to its own shutdown", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    await f.extensions.quitting();
    // Reached through the real channel: `beings:feature-task-discuss` is the one
    // 0.8.26 lists as「串行」(src/main.cjs line 134).
    await expect(f.invoke("beings:feature-task-discuss", "x")).rejects.toThrow(EXITING);
  } finally { await f.cleanup(); }
});

test("a feature channel is refused while the ledger does not match the connected Being", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    // The store moves first and the subsystem is told afterwards, which is the
    // window BeingDesktop's guard exists for: between the two, the open ledger
    // belongs to a Being that is no longer the connected one.
    f.store.connection = SECOND;
    f.store.connectionAddress = SECOND.link;
    expect(f.subsystem().histories.currentIdentity()).toBe(false);
    for (const [channel, args] of [
      ["beings:feature-tasks", [{}]], ["beings:feature-task", ["x"]],
      ["beings:feature-task-end", ["x"]], ["beings:feature-task-discuss", ["x"]],
    ] as [string, unknown[]][]) {
      await expect(f.invoke(channel, ...args)).rejects.toThrow(SESSION_CHANGED.entry);
    }
  } finally { await f.cleanup(); }
});

test("only a waiting, pending or Being-side read may have its local tracking ended", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    const ledger = f.subsystem().histories.ledger!;
    const reading = ledger.begin({ feature: "bonfire", operation: "read", title: "读取篝火消息", execution: "being" });
    ledger.update(reading.id, { requestId: randomUUID() });
    const local = ledger.begin({ feature: "portal", operation: "start", title: "启动 Portal", execution: "local" });
    const waiting = ledger.begin({ feature: "channel", operation: "connect", title: "连接消息渠道", execution: "being" });
    ledger.update(waiting.id, { status: "waiting" });

    // Running + Being + requestId + a readable feature: the Being's read has no
    // local process, so dropping the record cancels nothing.
    expect(await f.invoke("beings:feature-task-end", reading.id)).toMatchObject({
      status: "cancelled", detail: "本地跟踪已结束；这不会取消 Being 端的执行。",
    });
    expect(await f.invoke("beings:feature-task-end", waiting.id)).toMatchObject({ status: "cancelled" });
    // A running LOCAL operation is a live process; refusing is the whole point.
    await expect(f.invoke("beings:feature-task-end", local.id)).rejects.toThrow("只能结束读取、等待中或待处理任务的本地跟踪。");
    await expect(f.invoke("beings:feature-task-end", randomUUID())).rejects.toThrow("任务不存在或身份已变化。");
    await expect(f.invoke("beings:feature-task-end", "x".repeat(129))).rejects.toThrow("请选择有效的功能任务。");
    // A read whose feature is not one of the three stays untouchable.
    const grove = ledger.begin({ feature: "grove", operation: "install", title: "安装工具包", execution: "being" });
    ledger.update(grove.id, { requestId: randomUUID() });
    await expect(f.invoke("beings:feature-task-end", grove.id)).rejects.toThrow("只能结束读取、等待中或待处理任务的本地跟踪。");
  } finally { await f.cleanup(); }
});

test("discussing a task refuses until a composer is installed, then prepares one draft", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    const ledger = f.subsystem().histories.ledger!;
    const task = ledger.begin({ feature: "bonfire", operation: "read", title: "读取篝火消息", execution: "being" });
    ledger.complete(task.id, { summary: "读到 3 条消息。" });

    f.subsystem().setDraftPreparer(null);
    await expect(f.invoke("beings:feature-task-discuss", task.id)).rejects.toThrow("把任务内容放入聊天草稿的功能尚未就绪。");

    const prepared: { prompt: string }[] = [];
    f.subsystem().setDraftPreparer(async (prompt, current) => { current(); prepared.push({ prompt }); });
    expect(await f.invoke("beings:feature-task-discuss", task.id)).toEqual({ prepared: true, taskId: task.id });
    expect(prepared).toHaveLength(1);
    expect(prepared[0].prompt).toContain("任务：读取篝火消息");
    expect(prepared[0].prompt).toContain("结果摘要：读到 3 条消息。");
    // A draft that finishes after the Being changed is refused rather than
    // delivered: `discussFeatureTask` re-reads the epoch after preparing.
    f.subsystem().setDraftPreparer(async () => {
      f.store.connection = SECOND;
      f.store.connectionAddress = SECOND.link;
      f.extensions.connectionVerified(SECOND);
      await settle();
    });
    // Whichever of `discussFeatureTask`'s two guards notices first — the ledger
    // identity or the connection epoch — depends on how far the swap got while
    // the draft was being prepared. Both mean the same thing to the user, and
    // neither delivers a draft built under the previous Being.
    await expect(f.invoke("beings:feature-task-discuss", task.id))
      .rejects.toThrow(/连接身份已变化，任务内容未转交。|连接已变化，请重新选择任务。/);
    // The swap is a file read, not just a microtask drain: wait on the same
    // promise `connectionVerified` hands production (`extensions.ready`), or a
    // slow disk leaves the ledger half-swapped and the next line flakes.
    await f.extensions.ready; await settle();
    // The swap has completed by now, so the channel works again — for the NEW
    // Being's ledger, which has never heard of this task.
    expect(f.subsystem().histories.currentIdentity()).toBe(true);
    await expect(f.invoke("beings:feature-task-discuss", task.id)).rejects.toThrow("任务不存在或连接身份已变化，请重新选择。");
  } finally { await f.cleanup(); }
});

test("enrolled Town requests are validated by the real normalizer, not a copy of it", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    const requestId = randomUUID();
    const record = { requestId, route: "/api/bonfire/hear", beingId: "cz_being", prompt: `[Being Desktop Town sync:${requestId}]  读取  篝火 ` };
    f.subsystem().register(record);
    // Whitespace runs are collapsed and the text trimmed — the projection has to
    // match a rendered message, not the JSON that produced it.
    expect(f.subsystem().histories.records).toEqual([{ ...record, prompt: `[Being Desktop Town sync:${requestId}] 读取 篝火` }]);
    // Every rejection below is the normalizer's, reached through the subsystem.
    f.subsystem().register({ requestId: "not-a-uuid", route: "/api/bonfire/hear", beingId: "cz_being", prompt: "[Being Desktop Town sync:not-a-uuid]" });
    f.subsystem().register({ requestId: randomUUID(), route: "/api/secret", beingId: "cz_being", prompt: "x" });
    f.subsystem().register({ requestId: randomUUID(), route: "/api/bonfire/hear", beingId: "cz_being", prompt: "no announcement" });
    expect(f.subsystem().histories.records).toHaveLength(1);
    // A scroll detail route is accepted through the Town library contract, which
    // is the shared implementation rather than a second list of routes here.
    const scroll = randomUUID();
    f.subsystem().register({ requestId: scroll, route: "/api/scrolls/design-notes", beingId: "cz_being", prompt: `[Being Desktop Town sync:${scroll}] 读取卷轴` });
    expect(f.subsystem().histories.records).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("every ledger that was opened is flushed when the client quits", async () => {
  const f = await fixture();
  try {
    await f.connect(FIRST);
    f.subsystem().histories.ledger!.begin({ feature: "bonfire", operation: "read", title: "读取篝火消息", execution: "being" });
    await f.connect(SECOND);
    f.subsystem().histories.ledger!.begin({ feature: "portal", operation: "start", title: "启动 Portal", execution: "local" });
    await settle();
    await f.extensions.quitting();
    // Both files exist: the set-aside ledger was still being written when the
    // identity moved, and shutdown has to find it (BeingDesktop main.cjs line 1623).
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(path.join(f.directory, "feature-tasks"));
    expect(files.filter(name => name.endsWith(".bin"))).toHaveLength(2);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
