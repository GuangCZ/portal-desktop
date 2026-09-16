// What the shell does with a push that arrives during a shutdown; 2026-09-17
// (integration unit IN).
//
// `before-quit` sets the main process's quitting flag and then stops the Portal
// (desktop/main/main.ts), so the last `beings:portal-state` transitions of a
// shutdown reach a page that is still alive. The shell answered each of them
// with `beings:snapshot` — a channel that is not `QUIT_ALLOWED` and therefore
// can only be refused — which left `Error occurred in handler for
// 'beings:snapshot'` in the terminal and「客户端正在退出，请稍候。」in a toast on
// the way out (docs/migration/im-integration.md openIssue 7).
//
// The refusal is the only notice the renderer gets that the client is leaving,
// so it is treated as one.
import { expect, test, vi } from "vitest";
import { AppModel } from "../desktop/renderer/app/models/app";
import { QUITTING_MESSAGE } from "../desktop/shared/errors";
import type { DesktopAPI, PortalState, Snapshot } from "../desktop/shared/types";

const SNAPSHOT: Snapshot = {
  settings: {
    endpoint: "https://echo.beings.town/cz_being", being: "cz_being", hasToken: true,
    workspace: "/tmp/portal-workspace", projectWorkspace: "/tmp/project", portalBinary: "",
    portalName: "willow-portal", autoStart: false, allowExec: false, kitsEnabled: true,
  },
  desktopId: "11111111-1111-4111-8111-111111111111",
  portal: { phase: "connected", message: "已连接", logs: [] },
  background: { supported: true, installed: false, existing: false, enabled: false, running: false, message: "" },
};

const portal = (phase: PortalState["phase"]): PortalState => ({ phase, message: phase, logs: [] });

/** Electron's own wrapping of a rejected invoke, so the match is made against
 * what the page actually catches rather than against the bare sentence. */
const refusal = () => new Error(`Error invoking remote method 'beings:snapshot': Error: ${QUITTING_MESSAGE}`);

function fixture(snapshot: () => Promise<Snapshot>) {
  let push: ((state: PortalState) => void) | null = null;
  const api = {
    snapshot: vi.fn(snapshot),
    appearance: vi.fn(async () => "light"),
    updateState: vi.fn(async () => ({ phase: "idle" })),
    onPortal: (callback: (state: PortalState) => void) => { push = callback; return () => { push = null; }; },
    onUpdate: () => () => {},
    townDesktop: {
      appState: vi.fn(async () => { throw new Error("not paired"); }),
      onState: () => () => {}, onMessages: () => () => {}, onMembersInvalidated: () => () => {},
    },
  } as unknown as DesktopAPI;
  const model = new AppModel(api);
  const stop = model.start();
  return {
    model, api: api as unknown as { snapshot: ReturnType<typeof vi.fn> }, stop,
    push: (phase: PortalState["phase"]) => push?.(portal(phase)),
    /** Let the chase run: the read, its rejection and the toast timer. */
    settle: async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); },
  };
}

test("a Portal push is answered with a snapshot read while the client is running", async () => {
  const f = fixture(async () => SNAPSHOT);
  await f.settle();
  const before = f.api.snapshot.mock.calls.length;
  f.push("reconnecting");
  await f.settle();
  expect(f.api.snapshot.mock.calls.length).toBe(before + 1);
  expect(f.model.snapshot?.portal.phase).toBe("connected");
  f.stop();
});

test("the first refusal ends the chase: a shutdown costs one refused read, not one per transition", async () => {
  let quitting = false;
  const f = fixture(async () => { if (quitting) throw refusal(); return SNAPSHOT; });
  await f.settle();
  const before = f.api.snapshot.mock.calls.length;
  // `before-quit` has run; the Portal now reports its way to a stop. The toast
  // is cleared first: this fixture's API carries only what the shell itself
  // reads, so the feature models fail to start and say so — which is their rule,
  // not this one's.
  f.model.toastMessage = "";
  quitting = true;
  f.push("stopping");
  await f.settle();
  expect(f.api.snapshot.mock.calls.length).toBe(before + 1);
  // Everything after it is answered from the push alone.
  f.push("stopped");
  f.push("stopped");
  await f.settle();
  expect(f.api.snapshot.mock.calls.length).toBe(before + 1);
  // And the refusal is not shown to a user who is already on their way out.
  expect(f.model.toastMessage).toBe("");
  // The push itself is still applied, so a panel that is still on screen is not
  // showing a phase the Portal has left.
  expect(f.model.snapshot?.portal.phase).toBe("stopped");
  f.stop();
});

test("a failure that is not the shutdown refusal is still surfaced and does not stop the chase", async () => {
  let failing = true;
  const f = fixture(async () => { if (failing) throw new Error("读取失败"); return SNAPSHOT; });
  await f.settle();
  const before = f.api.snapshot.mock.calls.length;
  f.push("error");
  await f.settle();
  expect(f.api.snapshot.mock.calls.length).toBe(before + 1);
  expect(f.model.toastMessage).toBe("读取失败");
  failing = false;
  f.push("starting");
  await f.settle();
  expect(f.api.snapshot.mock.calls.length).toBe(before + 2);
  f.stop();
});

test("a push racing teardown starts no read at all", async () => {
  const f = fixture(async () => SNAPSHOT);
  await f.settle();
  const before = f.api.snapshot.mock.calls.length;
  // The subscription is removed by `stop()`, but a listener captured before it
  // must not start a call nobody is left to apply either.
  const leak = (f as unknown as { push: (phase: PortalState["phase"]) => void }).push;
  f.stop();
  leak("stopped");
  await f.settle();
  expect(f.api.snapshot.mock.calls.length).toBe(before);
});
