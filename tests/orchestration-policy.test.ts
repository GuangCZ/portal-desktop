// Ported from BeingDesktop 0.8.26 test/orchestration-policy.test.cjs on 2026-09-16.
// Seven cases, names preserved. `desktopPortalName` belongs to the Desktop identity unit; the
// fixture reproduces it verbatim (src/desktop-identity.cjs) rather than importing it.
// Contract: docs/orchestration.md "Desktop identity and execution isolation".

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrchestrationPolicy } from "../desktop/main/orchestration/orchestration-policy";
import type {
  BridgeCapabilities,
  OrchestrationMode,
  OrchestrationPolicyOptions,
} from "../desktop/main/orchestration/types";

const desktopPortalName = (id: string): string => "being-desktop-tools-" + id.toLowerCase();

const NOT_ENFORCED = { code: "ORCHESTRATION_NOT_ENFORCED" };

interface Fixture {
  gate: OrchestrationPolicy;
  mode: { enabled: boolean };
  bridge: BridgeCapabilities;
  setId: (value: string) => void;
  setIdentity: (value: string) => void;
}

function fixture(): Fixture {
  let id = randomUUID(), identity = "shared-being";
  const mode = { enabled: false };
  const bridge: BridgeCapabilities = { place: desktopPortalName(id), status: "connected", tools: ["desktop_worker_start", "desktop_worker_status"] };
  // readConfig/saveConfig/fetchImpl are the point of the fixture: the policy must never read or
  // write Being's shared model settings, nor contact a gateway. The implementation ignores them.
  const gate = new OrchestrationPolicy({
    getDesktopId: () => id, getIdentity: () => identity, getMode: () => mode as OrchestrationMode, getBridge: () => bridge,
    readConfig: () => { throw new Error("must not read shared model"); },
    saveConfig: () => { throw new Error("must not write shared model"); },
    fetchImpl: () => { throw new Error("must not contact a shared gateway"); },
  } as OrchestrationPolicyOptions);
  return { gate, mode, bridge, setId: (value) => { id = value; }, setIdentity: (value) => { identity = value; } };
}

describe("orchestration policy", () => {
  it("Desktop mode switches and preflight never read or mutate Being model settings", async () => {
    const f = fixture(); await f.gate.configure(true); f.mode.enabled = true; await f.gate.assertEnforced();
    expect(f.gate.state.status).toBe("enforced"); expect(f.gate.state.scope).toBe("desktop");
    await f.gate.configure(false); f.mode.enabled = false; expect(f.gate.state.status).toBe("disabled");
    await expect(f.gate.assertEnforced()).rejects.toThrow(/未启用/);
  });

  it("one Being can have a direct Desktop and an orchestrator Desktop independently", async () => {
    const mac = fixture(), win = fixture();
    await mac.gate.configure(false); await win.gate.configure(true); win.mode.enabled = true;
    await win.gate.assertEnforced(); expect(mac.mode.enabled).toBe(false);
    await mac.gate.configure(false); await win.gate.assertEnforced();
    expect(mac.bridge.place).not.toBe(win.bridge.place);
  });

  it("another Desktop bridge cannot satisfy local preflight even on the same Being", async () => {
    const a = fixture(), b = fixture(); a.mode.enabled = true; a.bridge.place = b.bridge.place;
    await expect(a.gate.assertEnforced()).rejects.toThrow(/本机 Worker/);
    expect(a.gate.state.status).toBe("blocked");
  });

  it("missing dispatch and direct tools in an orchestrator bridge fail closed", async () => {
    const f = fixture(); f.mode.enabled = true;
    f.bridge.tools = []; await expect(f.gate.assertEnforced()).rejects.toThrow(/未连接/);
    f.bridge.tools = ["desktop_worker_start", "desktop_console_run"]; await expect(f.gate.assertEnforced()).rejects.toThrow(/范围未生效/);
    f.bridge.tools = ["desktop_worker_start"]; f.bridge.status = "disconnected"; await expect(f.gate.assertEnforced()).rejects.toThrow(/未连接/);
  });

  it("chat readiness reports an unavailable or invalid bridge without authorizing local execution", async () => {
    for (const change of [
      (f: Fixture) => { f.bridge.status = "disconnected"; },
      (f: Fixture) => { f.bridge.tools = []; },
      (f: Fixture) => { f.bridge.tools!.push("desktop_console_run"); },
      (f: Fixture) => { f.bridge.place = "other-desktop"; },
    ]) {
      const f = fixture(); f.mode.enabled = true; change(f);
      const state = await f.gate.inspectForMessage();
      expect(state.status).toBe("blocked"); expect(state.scope).toBe("desktop");
      await expect(f.gate.assertEnforced()).rejects.toMatchObject(NOT_ENFORCED);
      expect(f.mode.enabled).toBe(true);
    }
    const f = fixture(); expect((await f.gate.inspectForMessage()).status).toBe("disabled");
    f.mode.enabled = true; expect((await f.gate.inspectForMessage()).status).toBe("enforced");
  });

  it("invalid identity cannot configure mode; a disconnected Being cannot dispatch", async () => {
    const f = fixture(); f.setId("malformed"); await expect(f.gate.configure(true)).rejects.toThrow(/身份/);
    const g = fixture(); g.setIdentity(""); await expect(g.gate.configure(true)).rejects.toThrow(/连接 Being/);
    g.mode.enabled = true; await expect(g.gate.assertEnforced()).rejects.toThrow(/身份/);
  });

  it("automatic configuration follows bridge initialization and loss without a chat or manual save", async () => {
    const f = fixture(); f.mode.enabled = true; f.bridge.status = "connecting"; f.bridge.tools = [];
    await f.gate.syncBridge(); expect(f.gate.state.status).toBe("pending");
    f.bridge.status = "connected"; await f.gate.syncBridge(); expect(f.gate.state.status).toBe("pending"); expect(f.gate.state.detail).toMatch(/初始化/);
    f.bridge.tools = ["desktop_worker_start"]; await f.gate.syncBridge(); expect(f.gate.state.status).toBe("enforced");
    f.bridge.status = "disconnected"; await f.gate.syncBridge(); expect(f.gate.state.status).toBe("blocked");
    await expect(f.gate.assertEnforced()).rejects.toMatchObject(NOT_ENFORCED);
    f.mode.enabled = false; await f.gate.syncBridge(); expect(f.gate.state.status).toBe("disabled");
  });
});
