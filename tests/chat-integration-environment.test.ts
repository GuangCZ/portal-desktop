// The desktop runtime the request context carries; new on 2026-09-16 (I5).
//
// Two things are pinned here. The first is the shape BeingDesktop 0.8.26 sends
// (src/main.cjs lines 200-219): the Being is told what it is allowed to assume
// about this machine, and a field that silently changes name or meaning changes
// what a real Being does with it.
//
// The second is the `portal` half, which is the one place this shell could not
// copy 0.8.26 — its `PortalService` state and this shell's `PortalState` are
// different objects. `portalRuntime` maps one onto the other and every phase has
// a row below, so the mapping is a table someone can read rather than a guess
// buried in a template string.
import { expect, test } from "vitest";
import { desktopEnvironment, portalRuntime } from "../desktop/main/chat/environment";
import { DESKTOP_PORTAL_NAME } from "../desktop/main/common/message-context";
import type { PortalPhase, PortalState, Settings } from "../desktop/shared/types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const SETTINGS = {
  endpoint: "https://echo.beings.town/cz_being", being: "cz_being", hasToken: true,
  workspace: "/tmp/portal-workspace", projectWorkspace: "/tmp/project", portalBinary: "",
  portalName: "willow-portal", autoStart: false, allowExec: false, kitsEnabled: true,
} satisfies Settings;

const state = (phase: PortalPhase, extra: Partial<PortalState> = {}): PortalState =>
  ({ phase, message: "", logs: [], ...extra });

/** The whole mapping, as a table. `status` keeps this shell's own phase word
 * rather than inventing one of BeingDesktop's — the frame says in as many words
 * that the JSON is environment data, and a renamed phase would be a worse lie
 * than an unfamiliar one. */
const TABLE: [PortalPhase, { status: string; health: string; management: string }][] = [
  ["running", { status: "running", health: "healthy", management: "desktop" }],
  ["connected", { status: "connected", health: "healthy", management: "desktop" }],
  ["starting", { status: "starting", health: "unknown", management: "desktop" }],
  ["reconnecting", { status: "reconnecting", health: "unknown", management: "desktop" }],
  ["stopping", { status: "stopping", health: "unknown", management: "desktop" }],
  ["stopped", { status: "stopped", health: "unknown", management: "desktop" }],
  ["external", { status: "external", health: "unknown", management: "external" }],
  ["error", { status: "error", health: "unhealthy", management: "desktop" }],
];

test("every Portal phase has one mapping, and it is this one", () => {
  for (const [phase, expected] of TABLE) {
    expect({ ...portalRuntime(state(phase), SETTINGS), name: undefined, configuredName: undefined, workspace: undefined })
      .toEqual({ ...expected, name: undefined, configuredName: undefined, workspace: undefined });
  }
  // Nothing configured at all is not「stopped」: BeingDesktop's own initial state
  // is `not_configured`, and saying a Portal is stopped implies there is one.
  expect(portalRuntime(null, SETTINGS)).toMatchObject({ status: "not_configured", health: "unknown", management: "desktop" });
  // A port another process already holds is unhealthy however the phase reads —
  // that is exactly the case where a running-looking Portal is not ours.
  expect(portalRuntime(state("running", { conflict: true }), SETTINGS).health).toBe("unhealthy");
  expect(portalRuntime(state("connected", { conflict: true }), SETTINGS).health).toBe("unhealthy");
});

test("the routing name is claimed only for a Portal this client manages", () => {
  expect(portalRuntime(state("running", { managed: true }), SETTINGS).name).toBe(DESKTOP_PORTAL_NAME);
  // Running, but somebody else started it: the frame then tells the Being to
  // check `configuredName` against the tool bindings instead of assuming.
  expect(portalRuntime(state("running"), SETTINGS).name).toBe(null);
  expect(portalRuntime(state("external", { managed: false }), SETTINGS).name).toBe(null);
  expect(portalRuntime(state("running", { managed: true }), SETTINGS)).toMatchObject({
    configuredName: "willow-portal", workspace: "/tmp/portal-workspace",
  });
  // An empty profile says null rather than an empty string: the frame's prose
  // points at this field, and "" reads as a name that happens to be blank.
  expect(portalRuntime(null, { ...SETTINGS, portalName: "", workspace: "" })).toMatchObject({ configuredName: null, workspace: null });
});

function environment(overrides: Partial<Parameters<typeof desktopEnvironment>[0]> = {}) {
  return desktopEnvironment({
    desktopId: DESKTOP, clientVersion: "0.9.0", settings: () => SETTINGS,
    bridge: () => ({ status: "connected", place: "being-desktop-tools-" + DESKTOP, hostname: "fixture-host", platform: "darwin", tools: ["desktop_browser_open", "desktop_console_run", "desktop_terminal_create"] }),
    terminalTools: () => ({ scope: sessionId => ({ sessionId, sessionToken: "token-1" }), sessions: () => [{ id: "t-1" }] }),
    orchestration: () => ({ mode: { enabled: false }, configuring: false }),
    inspectPolicy: async () => ({ status: "disabled", scope: "desktop" }),
    getPortalState: () => null,
    clock: () => Date.parse("2026-09-16T08:00:00Z"),
    platform: "darwin",
    ...overrides,
  });
}

/** The JSON blob the context embeds, parsed back out of the text. */
function runtimeOf(context: string): Record<string, any> {
  const start = context.indexOf("\n{");
  const end = context.indexOf("\n", start + 1);
  return JSON.parse(context.slice(start + 1, end));
}

test("the runtime the frame carries is BeingDesktop's, field for field", async () => {
  const context = await environment()("22222222-2222-4222-8222-222222222222");
  const runtime = runtimeOf(context);
  expect(runtime).toMatchObject({
    desktopId: DESKTOP,
    capturedAt: "2026-09-16T08:00:00.000Z",
    application: { name: "Being Desktop", version: "0.9.0" },
    chatSessionId: "22222222-2222-4222-8222-222222222222",
    // BeingDesktop's `state.workspace.path` is the Desktop project directory, and
    // `portal.workspace` the Portal's own. This shell keeps them under
    // `projectWorkspace` and `workspace` respectively (desktop/shared/types.ts).
    workspace: "/tmp/project",
    portal: { workspace: "/tmp/portal-workspace" },
    mode: "direct",
    bridge: { status: "connected", hostname: "fixture-host" },
    executionPolicy: { status: "disabled", scope: "desktop" },
    terminal: {
      present: true, interactive: true, shell: "zsh", callable: true,
      approval: "本会话自建终端内的已授权任务可直接执行；账户凭据和必须本人确认的授权交给用户",
      scope: { sessionId: "22222222-2222-4222-8222-222222222222", sessionToken: "token-1" },
      sessions: [{ id: "t-1" }],
      lifetime: "跨回复和聊天切换保留；退出应用或明确关闭终端时结束",
    },
    browser: { present: true, callable: true, approval: "现有浏览器工具逐次本地确认" },
    console: { interactive: false, callable: true, approval: "现有非交互命令逐次本地确认" },
  });
  // The direct-mode paragraph, not the orchestrator one.
  expect(context).toContain("当前为直接执行模式");
  expect(context).toContain("[/Being Desktop 当前消息环境]");
});

test("an absent tool bridge is reported as no capability rather than as an error", async () => {
  const context = await environment({ bridge: () => null, terminalTools: () => null })("22222222-2222-4222-8222-222222222222");
  const runtime = runtimeOf(context);
  // 「工具未连接」and「能力未实现」are different things and the frame's prose
  // insists on the difference: the browser is present and simply not callable.
  expect(runtime.bridge).toMatchObject({ status: "disconnected", tools: [] });
  expect(runtime.browser).toMatchObject({ present: true, callable: false });
  expect(runtime.console).toMatchObject({ interactive: false, callable: false });
  expect(runtime.terminal).toMatchObject({ callable: false, scope: null, sessions: [] });
});

test("the terminal scope is minted only when the bridge can actually call the terminal", async () => {
  const scopes: string[] = [];
  const terminalTools = { scope: (id: string) => { scopes.push(id); return { sessionId: id, sessionToken: "token-1" }; }, sessions: () => [] };
  await environment({ bridge: () => ({ status: "connected", place: "p", hostname: "h", platform: "darwin", tools: [] }), terminalTools: () => terminalTools })("22222222-2222-4222-8222-222222222222");
  // No `desktop_terminal_create` in the catalogue: nothing to bind, so no token
  // is minted for a conversation that could not use it (src/main.cjs line 205).
  expect(scopes).toEqual([]);
});

test("orchestrator mode is reported as such, with the policy read for this message", async () => {
  const context = await environment({
    orchestration: () => ({ mode: { enabled: true }, configuring: false }),
    inspectPolicy: async () => ({ status: "enforced", scope: "desktop", detail: "已核验当前 Desktop" }),
  })("22222222-2222-4222-8222-222222222222");
  expect(runtimeOf(context)).toMatchObject({ mode: "orchestrator", executionPolicy: { status: "enforced" } });
  expect(context).toContain("当前为本机任务编排模式");
});

test("a mode in the middle of being reconfigured refuses the message", async () => {
  await expect(environment({ orchestration: () => ({ mode: { enabled: false }, configuring: true }) })("22222222-2222-4222-8222-222222222222"))
    .rejects.toMatchObject({ code: "ORCHESTRATION_NOT_ENFORCED", message: "编排模式正在切换，请完成后再发送消息。" });
});

test("a mode that moves across the policy read refuses the message", async () => {
  let enabled = true;
  await expect(environment({
    orchestration: () => ({ mode: { enabled }, configuring: false }),
    inspectPolicy: async () => { enabled = false; return { status: "disabled", scope: "desktop" }; },
  })("22222222-2222-4222-8222-222222222222"))
    .rejects.toMatchObject({ code: "ORCHESTRATION_NOT_ENFORCED", message: "编排模式已变化，请重新发送。" });
  // And the same guard catches a reconfiguration that started during the read.
  let configuring = false;
  await expect(environment({
    orchestration: () => ({ mode: { enabled: false }, configuring }),
    inspectPolicy: async () => { configuring = true; return { status: "disabled", scope: "desktop" }; },
  })("22222222-2222-4222-8222-222222222222"))
    .rejects.toMatchObject({ code: "ORCHESTRATION_NOT_ENFORCED", message: "编排模式已变化，请重新发送。" });
});
