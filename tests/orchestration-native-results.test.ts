// Ported from BeingDesktop 0.8.26 test/native-orchestration.test.cjs on 2026-09-16.
// All 11 runtime cases are listed with their original names. Ten of them drive ChatSessions,
// BeingChat, desktop-message-context, orchestration-message (P1's request-context frame) and
// renderer/chat-references — every one of those belongs to another migration unit, so they are
// carried as it.skip and recorded in the unit's openIssues. The one case that exercises a module
// of this unit (`nativeWorkerResults`) is ported for real, with its fixture worker copied verbatim.
// Contract: docs/orchestration.md "Completion", docs/interfaces.md §3.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestration } from "../desktop/main/orchestration/orchestration";
import { nativeWorkerResults } from "../desktop/main/orchestration/native-worker-results";
import type { AgentExitResult, WorkerRecord } from "../desktop/main/orchestration/types";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** The orchestration half of test/native-orchestration.test.cjs's fixture (no chat stack). */
async function fixture(): Promise<{ manager: Orchestration; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-worker-"));
  const desktopId = randomUUID();
  const manager = new Orchestration({
    directory, getWorkspace: () => directory, getSessionIds: () => [], getExecutionContext: () => ({ desktopId }),
    detect: async () => [{ id: "codex", name: "Codex CLI", path: "fixture", status: "ready" }],
    launch: (options) => {
      let finish!: (result: AgentExitResult) => void;
      return { ...options, done: new Promise<AgentExitResult>((resolve) => { finish = resolve; }), stop: async () => finish({ code: null, stopped: true }) };
    },
  });
  await manager.selectOwner("identity-a");
  await manager.configure({ enabled: true }, async () => {});
  cleanups.push(async () => { await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, directory };
}

describe("native worker results", () => {
  // Needs ChatSessions + BeingChat + the request-context frame (chat-core / message-frame units).
  it.skip("native send supplies a usable current Worker scope; fake Being dispatch launches exactly one bound worker", () => {});
  it.skip("context is removed before cache and bubble confirmation; image and quote content survives exactly", () => {});
  it.skip("disconnected Worker bridge leaves native conversation available and Worker execution blocked", () => {});
  for (const change of ["identity", "mode", "mode-roundtrip", "cancel"]) {
    it.skip(`preflight ${change} prevents a stale native POST`, () => {});
  }
  it.skip("switching to direct mode supplies the current mode and no old Worker scope", () => {});
  it.skip("plain protocol callers stay verbatim, and framed metadata does not eat user content", () => {});

  it("native result projection is scoped, persistent in Worker history, and exposes only display fields", async () => {
    const f = await fixture(), id = randomUUID(), other = randomUUID();
    const worker = { id: randomUUID(), sessionId: id, title: "多米诺骨牌", endedAt: new Date().toISOString(), taskPrompt: "PRIVATE", events: [], sessionToken: "PRIVATE", presentation: { artifactPath: "index.html" }, review: { status: "passed", summary: "已完成", evidence: "隔离测试通过" } };
    f.manager.workers.push(worker as unknown as WorkerRecord);
    // ChatSessions' `getWorkerResults` is exactly this projection over the live Worker ledger.
    expect(nativeWorkerResults(f.manager.workers, other).length).toBe(0);
    const result = nativeWorkerResults(f.manager.workers, id)[0];
    expect(result.preview).toBe(true); expect(result.status).toBe("passed");
    expect(JSON.stringify(result).includes("PRIVATE")).toBe(false); expect(JSON.stringify(result).includes("artifactPath")).toBe(false);
    f.manager.workers = [];
  });

  // Needs orchestration-message's wrap/unwrap frame (P1's desktop/main/chat/frame.ts).
  it.skip("Heart newline normalization preserves the human message and old frame recovery", () => {});
});
