// The desktop runtime read at send time, as the request context carries it;
// 2026-09-16.
//
// Ported line for line from BeingDesktop 0.8.26 src/main.cjs lines 200-219
// (`desktopEnvironment`). The shape of the object is the contract — it is
// `JSON.stringify`d into the frame `common/message-context.ts` builds — so field
// names and order follow the original rather than this shell's conventions.
//
// Two of its readings are refusals rather than values, and both are BeingDesktop's:
// while the orchestration mode is being reconfigured no message may go at all,
// and a mode that changes across the policy read invalidates what was just
// gathered. Both throw `ORCHESTRATION_NOT_ENFORCED`, which `prepare-message.ts`
// lets through untouched.
//
// DEVIATION, measured rather than assumed: BeingDesktop's `portal` half reads a
// `PortalService` state shaped `{status, health, owned, management, deployment}`.
// This shell has `PortalState` — `{phase, pid, managed, runtimePath, conflict,
// message, logs}` (desktop/shared/types.ts) — which is not the same object, so
// `portalRuntime` below is an explicit mapping with a row per phase, pinned by
// tests/chat-integration-environment.test.ts.
import { DESKTOP_PORTAL_NAME, desktopMessageContext, type DesktopRuntime } from '../common/message-context';
import { desktopPlatform } from '../common/platform';
import type { PortalState, Settings } from '../../shared/types';

const notEnforced = (message: string): Error => Object.assign(new Error(message), { code: 'ORCHESTRATION_NOT_ENFORCED' });

/** The bridge capabilities the frame reports, as `tool-link.ts` produces them.
 * Declared structurally so this module does not depend on the tool bridge unit:
 * the subsystem passes `link.capabilities()` straight through. */
export interface EnvironmentBridge { status: string; place: string; hostname: string; platform: string; tools: string[] }

const IDLE_BRIDGE: EnvironmentBridge = { status: 'disconnected', place: '', hostname: '', platform: process.platform, tools: [] };

/** The orchestration half, as this module needs it. */
export interface EnvironmentOrchestration {
  readonly mode: { enabled?: boolean };
  readonly configuring: boolean;
}

export interface EnvironmentTerminalTools {
  scope(sessionId: string): unknown;
  sessions(sessionId: string | undefined): unknown[];
}

export interface DesktopEnvironmentOptions {
  desktopId: string;
  clientVersion: string;
  settings: () => Settings;
  /** `link.capabilities()`, or null when the tool bridge is not installed. */
  bridge: () => EnvironmentBridge | null | undefined;
  /** Absent when the tool bridge is not installed; the terminal half then reports
   * no scope and no sessions, which is what「工具未连接」means. */
  terminalTools: () => EnvironmentTerminalTools | null | undefined;
  orchestration: () => EnvironmentOrchestration | null | undefined;
  /** `OrchestrationPolicy.inspectForMessage()`. Never throws for a disabled mode. */
  inspectPolicy: () => Promise<unknown>;
  /** The Portal supervisor's live state, read at send time.
   *
   * The gap I5 recorded here is closed (2026-09-17, integration unit IN):
   * `main.ts` passes a reader for its `PortalSupervisor` as
   * `SubsystemContext.portalState` and the chat subsystem forwards it. Still
   * optional, and still `not_configured` when absent — everything that does NOT
   * depend on the live process (`configuredName`, `workspace`) comes from the
   * saved profile either way, because the frame's prose points the Being at
   * `runtime.portal.configuredName` when the Portal is unconfirmed. The seam is
   * asserted by tests/chat-integration-portal-state.test.ts; the mapping itself
   * by tests/chat-integration-environment.test.ts. */
  getPortalState?: () => PortalState | null | undefined;
  clock?: () => number;
  platform?: NodeJS.Platform | string;
}

/** What BeingDesktop's `runtime.portal` says, computed from this shell's state.
 *
 * | phase          | status         | health    | management |
 * | -------------- | -------------- | --------- | ---------- |
 * | running        | running        | healthy   | desktop    |
 * | connected      | connected      | healthy   | desktop    |
 * | starting       | starting       | unknown   | desktop    |
 * | reconnecting   | reconnecting   | unknown   | desktop    |
 * | stopping       | stopping       | unknown   | desktop    |
 * | stopped        | stopped        | unknown   | desktop    |
 * | external       | external       | unknown   | external   |
 * | error          | error          | unhealthy | desktop    |
 * | (no state)     | not_configured | unknown   | desktop    |
 *
 * `conflict` — another process already holds the Portal's port — forces
 * `unhealthy` whatever the phase says, because that is precisely the case where
 * a running-looking Portal is not the one this client speaks to.
 *
 * `name` is BeingDesktop's `owned ? DESKTOP_PORTAL_NAME : null`: the routing name
 * is claimed only for a Portal this client actually manages. `management` is
 * `'external'` only for the phase that means it; `managed` says who started the
 * process, `phase === 'external'` says who owns it. */
export function portalRuntime(state: PortalState | null | undefined, settings: Settings) {
  const phase = state?.phase;
  const healthy = phase === 'running' || phase === 'connected';
  const health = state?.conflict === true || phase === 'error' ? 'unhealthy' : healthy ? 'healthy' : 'unknown';
  return {
    name: state?.managed === true ? DESKTOP_PORTAL_NAME : null,
    configuredName: settings.portalName || null,
    // BeingDesktop reads `town.state().portalWorkspace.path` here; in this shell
    // `settings.workspace` IS the Portal working directory and
    // `settings.projectWorkspace` is BeingDesktop's own top-level project
    // directory (desktop/shared/types.ts documents both).
    workspace: settings.workspace || null,
    management: phase === 'external' ? 'external' : 'desktop',
    status: phase || 'not_configured',
    health,
  };
}

/**
 * `desktopEnvironment(sessionId)` as `ChatSessions` gets it: the request context
 * text for one outgoing message.
 *
 * The two guards around `inspectPolicy()` are BeingDesktop's own, in its order:
 * a mode mid-configuration refuses before the read, and a mode that moved during
 * it refuses after. `enabled` is captured once at the top so both comparisons are
 * against the same starting point.
 */
export function desktopEnvironment(options: DesktopEnvironmentOptions): (sessionId: string) => Promise<string> {
  const clock = options.clock || Date.now;
  return async (sessionId: string): Promise<string> => {
    const orchestration = options.orchestration();
    const enabled = orchestration?.mode.enabled === true;
    if (orchestration?.configuring) throw notEnforced('编排模式正在切换，请完成后再发送消息。');
    const executionPolicy = await options.inspectPolicy();
    const current = options.orchestration();
    if (enabled !== (current?.mode.enabled === true) || current?.configuring) throw notEnforced('编排模式已变化，请重新发送。');
    const bridge = options.bridge() || IDLE_BRIDGE;
    const terminalCallable = bridge.tools.includes('desktop_terminal_create');
    const terminalTools = options.terminalTools();
    const platform = desktopPlatform(options.platform ?? process.platform);
    const settings = options.settings();
    const runtime: DesktopRuntime = {
      desktopId: options.desktopId,
      capturedAt: new Date(clock()).toISOString(),
      application: { name: 'Being Desktop', version: options.clientVersion },
      chatSessionId: sessionId,
      workspace: settings.projectWorkspace || null,
      portal: portalRuntime(options.getPortalState?.(), settings),
      bridge,
      executionPolicy,
      mode: current?.mode.enabled === true ? 'orchestrator' : 'direct',
      terminal: {
        present: platform.terminalSupported, interactive: platform.terminalSupported, shell: platform.shell,
        callable: terminalCallable,
        approval: '本会话自建终端内的已授权任务可直接执行；账户凭据和必须本人确认的授权交给用户',
        scope: terminalCallable && terminalTools ? terminalTools.scope(sessionId) : null,
        sessions: terminalTools ? terminalTools.sessions(sessionId) : [],
        lifetime: '跨回复和聊天切换保留；退出应用或明确关闭终端时结束',
      },
      browser: { present: true, callable: bridge.tools.includes('desktop_browser_open'), approval: '现有浏览器工具逐次本地确认' },
      console: { interactive: false, callable: bridge.tools.includes('desktop_console_run'), approval: '现有非交互命令逐次本地确认' },
    };
    return desktopMessageContext({ runtime, ...(options.platform === undefined ? {} : { platform: options.platform }) });
  };
}
