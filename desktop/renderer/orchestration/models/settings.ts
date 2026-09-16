// The orchestration mode editor; 2026-09-16. Rules ported from BeingDesktop
// 0.8.26 renderer/orchestration.js (`draft`, `controls`, `saveMode`,
// `showModeStatus`, `perform`) and the behaviour test/orchestration-ui.cjs pins.
//
// The three rules that are easy to lose and were measured in that test:
//
//   * There is NO save button. Every edit — the switch, the default adapter, a
//     path — saves immediately, and `test/orchestration-ui.cjs` line 166 asserts
//     the button does not exist. The user is never left with unsaved settings
//     they think are live.
//   * A rejected save puts the switch BACK where it was (line 142 of the source,
//     asserted at line 157 of the test) and offers a retry of that exact mode.
//     Leaving the switch on after a refusal would claim orchestration is on when
//     the main process refused to enable it.
//   * While a save is in flight, and while the mode is off, every control except
//     the switch itself is disabled.
//
// The status line is the only place the mode's three states are spelled out, so
// the sentences are BeingDesktop's, unchanged.

import { Store } from "../../shared/models/store";
import type { DesktopAPI } from "../../../shared/types";
import type {
  OrchestrationAgent, OrchestrationModeInputState, OrchestrationSnapshotState,
} from "../../../shared/desktop-types";

/** The four adapters, with the names BeingDesktop shows (renderer/orchestration.js
 * line 132). The order is the order of the rows and of the default picker. */
export const AGENT_KITS: readonly (readonly [string, string])[] = [
  ["codex", "Codex CLI"], ["claude", "Claude Code CLI"], ["cursor", "Cursor CLI"], ["grok", "Grok Build CLI"],
] as const;

/** renderer/orchestration.js line 35. */
export const AGENT_STATUS: Record<string, string> = {
  ready: "可执行", missing: "未安装", needs_auth: "需要登录", incompatible: "接口不兼容", error: "检测失败",
};

export const PATH_PLACEHOLDER = "自动从 PATH 检测，或填写程序绝对路径";

export type StatusKind = "info" | "error";

/** BeingDesktop's `perform` strips electron's IPC wrapper from the message
 * (renderer/orchestration.js line 28) so the user reads the sentence the main
 * process wrote, not the channel it came through. */
export const publicMessage = (error: unknown): string =>
  String((error as Error | null)?.message || "操作失败，请重试。")
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export class OrchestrationSettingsModel extends Store {
  /** The editor's own copy. Overwritten from a push only while the user has not
   * touched anything — otherwise a snapshot arriving mid-edit would discard what
   * is being typed (source line 47). */
  enabled = false;
  defaultAgent = "codex";
  paths: Record<string, string> = Object.fromEntries(AGENT_KITS.map(([id]) => [id, ""]));
  agents: OrchestrationAgent[] = [];
  policyDetail = "";
  dirty = false;
  busy = false;
  status = "";
  statusKind: StatusKind = "info";
  /** The mode a failed save was trying to apply, offered again as「重试」. */
  failed: OrchestrationModeInputState | null = null;
  /** The last mode the main process confirmed. A rejected toggle is put back to
   * this, not to the opposite of what was attempted — the two differ whenever a
   * push landed between the click and the refusal. */
  private applied = { enabled: false, defaultAgent: "codex", paths: {} as Record<string, string> };

  constructor(private readonly api: DesktopAPI, private readonly onSnapshot: (snapshot: OrchestrationSnapshotState) => void) { super(); }

  /** A snapshot arrived (push or reply). */
  receive(value: OrchestrationSnapshotState) {
    this.agents = value.agents;
    this.applied = { enabled: value.mode.enabled, defaultAgent: value.mode.defaultAgent, paths: { ...value.mode.paths } };
    if (!this.dirty) {
      this.enabled = value.mode.enabled;
      this.defaultAgent = value.mode.defaultAgent;
      this.paths = Object.fromEntries(AGENT_KITS.map(([id]) => [id, value.mode.paths?.[id] || ""]));
      if (!this.busy) this.showModeStatus(value);
    }
    if (value.enforcement?.detail) this.policyDetail = value.enforcement.detail;
    this.changed();
  }

  /** renderer/orchestration.js lines 40-44, verbatim. */
  showModeStatus(value: OrchestrationSnapshotState) {
    if (!value.mode.enabled) { this.say("编排模式已关闭。开启时会自动检测并保存配置。"); return; }
    const status = value.enforcement?.status;
    this.say(
      status === "enforced" ? "编排已开启，配置已自动保存，调度工具已就绪。"
        : status === "blocked" ? "配置已自动保存，但调度工具暂不可用；本机执行暂停，对话可继续。"
          : "编排已开启，配置已自动保存，正在连接 Worker 调度工具…",
      status === "blocked" ? "error" : "info",
    );
  }

  say(text: string, kind: StatusKind = "info") { this.status = text; this.statusKind = kind; this.changed(); }

  draft(): OrchestrationModeInputState {
    return { enabled: this.enabled, defaultAgent: this.defaultAgent, paths: Object.fromEntries(Object.entries(this.paths).map(([id, value]) => [id, value.trim()])) };
  }

  setPath(id: string, value: string) { this.paths = { ...this.paths, [id]: value }; this.dirty = true; this.changed(); }
  setDefaultAgent(id: string) { this.defaultAgent = id; this.dirty = true; this.changed(); void this.save(); }
  toggle(enabled: boolean) { this.enabled = enabled; this.dirty = true; this.changed(); void this.save(true); }
  /** A path field committed (blur or Enter). Nothing to save if it never changed. */
  commitPath() { if (this.dirty && !this.busy) void this.save(); }
  retry() { if (this.failed) void this.save(true, this.failed); }

  /** renderer/orchestration.js lines 137-144 with its `perform` wrapper inlined. */
  async save(toggled = false, request: OrchestrationModeInputState | null = null): Promise<void> {
    if (this.busy) return;
    const next = request || this.draft();
    this.busy = true;
    this.say("正在检测本机 Agent 并确认 Desktop 工具绑定…");
    try {
      const result = await this.api.orchestration.save(next);
      this.failed = null;
      this.dirty = false;
      this.receive(result);
      this.onSnapshot(result);
      this.showModeStatus(result);
    } catch (error) {
      this.failed = next;
      // Put the switch back where the main process last confirmed it: the mode
      // did not change, and a switch left on would say it did.
      if (toggled) this.enabled = this.applied.enabled;
      this.say(publicMessage(error), "error");
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /** renderer/orchestration.js line 146. Detection never saves. */
  async detect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say("正在检测程序与执行接口…");
    try {
      this.agents = await this.api.orchestration.inspectAgents(this.draft().paths ?? {});
      this.say("检测完成。可执行不代表任务必定成功；登录和权限错误会显示在 worker 事件中。");
    } catch (error) {
      this.say(publicMessage(error), "error");
    } finally { this.busy = false; this.changed(); }
  }

  /** renderer/orchestration.js line 148. */
  async reconnect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.changed();
    try {
      const result = await this.api.orchestration.reconnect();
      this.say(result?.status === "connected" ? "调度工具已连接。" : "调度工具未连接，请确认 Being 连接和编排模式。");
    } catch (error) {
      this.say(publicMessage(error), "error");
    } finally { this.busy = false; this.changed(); }
  }

  /** Which controls answer right now (source line 17). */
  get locked() { return this.busy || !this.enabled; }
}
