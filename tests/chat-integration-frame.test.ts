// The request-context frame, end to end; new on 2026-09-16 (integration unit I5).
//
// These are the acceptance conditions the P1 review left behind, taken at their
// word: what leaves this machine carries the frame, what is kept on this machine
// does not, orchestrator mode puts its instructions and its scope inside the
// frame, and a binding that moved while the frame was being built refuses the
// send instead of dispatching a stale scope.
//
// Nothing is faked that has behaviour. `Orchestration` is the real manager (its
// agent detection and its child process are injected, exactly as
// tests/orchestration-native-results.test.ts injects them), `ChatSessions` is the
// real conversation layer, `BeingChat` does the real POST through a fetch that
// answers like a Being, and the frame is built by the real
// `nativeMessageContext` over the real `desktopEnvironment`. Only the network and
// the CLI are stand-ins.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { desktopEnvironment } from "../desktop/main/chat/environment";
import { setOrchestrationInstructions, unwrapMessage, wrapMessage } from "../desktop/main/chat/frame";
import { nativeMessageContext } from "../desktop/main/chat/prepare-message";
import { ChatSessions } from "../desktop/main/chat/sessions";
import { Orchestration } from "../desktop/main/orchestration/orchestration";
import { orchestrationInstructions } from "../desktop/main/orchestration/instructions";
import type { AgentExitResult } from "../desktop/main/orchestration/types";
import type { Settings } from "../desktop/shared/types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const token = "c".repeat(64);
const ADDRESS = `https://echo.beings.town/cz_being/?token=${token}`;
const IDENTITY = "identity-a";
const SETTINGS = {
  endpoint: "https://echo.beings.town/cz_being", being: "cz_being", hasToken: true,
  workspace: "/tmp/portal-workspace", projectWorkspace: "/tmp/project", portalBinary: "", portalName: "willow-portal",
  autoStart: false, allowExec: false, kitsEnabled: true,
} satisfies Settings;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  // `frame.ts` holds the instructions implementation in module state. Put it back
  // the way P1 ships it so a file that runs after this one is not told a mode is
  // enabled that it never enabled.
  setOrchestrationInstructions(() => "");
});

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const sse = (frames: [string, unknown][]) =>
  new Response(frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chat-frame-"));
  const manager = new Orchestration({
    directory, getWorkspace: () => directory,
    getSessionIds: () => sessions.snapshot().sessions.map(item => item.id),
    getExecutionContext: () => ({ desktopId: DESKTOP, place: "being-desktop-tools-" + DESKTOP }),
    detect: async () => [{ id: "codex", name: "Codex CLI", path: "/fixture/codex", status: "ready" }],
    launch: options => {
      let finish!: (result: AgentExitResult) => void;
      return { ...options, done: new Promise<AgentExitResult>(resolve => { finish = resolve; }), stop: async () => finish({ code: null, stopped: true }) };
    },
  });
  await manager.selectOwner(IDENTITY);

  const calls: { path: string; body: any }[] = [];
  let history: unknown[] = [];
  /** Runs while `desktopEnvironment` is awaiting the policy — the only place a
   * test can act between the two `assertCurrent` calls. */
  let duringEnvironment: (() => Promise<void>) | null = null;
  const fetchImpl = (async (url: string, options: RequestInit) => {
    const parsed = new URL(url), route = parsed.pathname.replace(/^\/cz_being/, "");
    calls.push({ path: route, body: options.body ? JSON.parse(options.body as string) : null });
    if (route === "/api/history") return json({ messages: history });
    if (route === "/api/stream/active") return json(null, 204);
    if (route === "/api/chat/stream") {
      const scene = JSON.parse(options.body as string).scene_id;
      return sse([["meta", { scene_id: scene, stream_id: "s-1", client_ref: JSON.parse(options.body as string).client_ref }],
        ["content_block_delta", { scene_id: scene, delta: { text: "好" } }], ["message_stop", { scene_id: scene }]]);
    }
    throw new Error(`no route: ${route}`);
  }) as unknown as typeof fetch;

  const prepare = nativeMessageContext({
    orchestration: () => manager,
    environment: desktopEnvironment({
      desktopId: DESKTOP, clientVersion: "0.9.0", settings: () => SETTINGS,
      bridge: () => ({ status: "connected", place: "being-desktop-tools-" + DESKTOP, hostname: "fixture-host", platform: "darwin", tools: ["desktop_worker_start"] }),
      terminalTools: () => null,
      orchestration: () => manager,
      inspectPolicy: async () => { await duringEnvironment?.(); return { status: manager.mode.enabled ? "enforced" : "disabled", scope: "desktop" }; },
      getPortalState: () => null,
      clock: () => Date.parse("2026-09-16T08:00:00Z"),
      platform: "darwin",
    }),
  });

  const sessions: ChatSessions = new ChatSessions({
    desktopId: DESKTOP, clientVersion: "0.9.0", fetchImpl,
    getContext: () => ({ connected: true, connection: ADDRESS, revision: 1 }),
    prepareMessage: prepare,
  });
  await sessions.start(IDENTITY);
  cleanups.push(async () => { sessions.end(); await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return {
    manager, sessions, calls, prepare,
    set history(value: unknown[]) { history = value; },
    set during(value: (() => Promise<void>) | null) { duringEnvironment = value; },
    active: () => sessions.snapshot().active,
    posted: () => calls.filter(call => call.path === "/api/chat/stream").at(-1)!.body as { message: string },
    enable: () => manager.configure({ enabled: true }, async () => {}),
  };
}

test("the message on the wire carries the v1 frame and the row kept on this machine does not", async () => {
  const f = await fixture();
  const id = f.active();
  await f.sessions.send({ sessionId: id, text: "在吗" });
  await settle();

  const wire = f.posted().message;
  expect(wire.startsWith("[Being Desktop request context v1; length=")).toBe(true);
  // The declared length is the authority, and `unwrapMessage` takes it at its
  // word: strip the frame and exactly the human's words are left.
  expect(unwrapMessage(wire)).toBe("在吗");
  // The context inside it is the one `desktopMessageContext` writes, with the
  // runtime this machine actually has.
  expect(wire).toContain("[Being Desktop 当前消息环境]");
  expect(wire).toContain('"Being Desktop"');
  expect(wire).toContain(`"${id}"`);
  // Direct mode: no orchestrator paragraph anywhere in the frame.
  expect(wire).not.toContain("[Being Desktop Orchestrator mode]");

  // What the Being persisted comes back framed, because it is what we sent. The
  // store unframes on the way in, so the transcript and the encrypted cache keep
  // the human's words alone (chat/store.ts line 61).
  f.history = [{ seq: 4, role: "user", content: wire, at: "2026-09-16T08:00:01Z", scene_id: `desktop-${DESKTOP}-${id}` }];
  await f.sessions.reload();
  const view = f.sessions.view(id);
  expect(view.rows.map(row => row.content)).toEqual(["在吗"]);
  expect(JSON.stringify(view.rows)).not.toContain("request context v1");
});

test("orchestrator mode puts its instructions and its scope inside the same frame", async () => {
  const f = await fixture();
  setOrchestrationInstructions(orchestrationInstructions);
  await f.enable();
  const id = f.active();
  await f.sessions.send({ sessionId: id, text: "跑一下测试" });
  await settle();

  const wire = f.posted().message;
  expect(unwrapMessage(wire)).toBe("跑一下测试");
  expect(wire).toContain("[Being Desktop Orchestrator mode]");
  expect(wire).toContain("[/Being Desktop Orchestrator mode]");
  // `JSON.stringify(mode)` is the last line of the instructions: the scope the
  // worker tools have to be called with. It is the manager's own, minted for this
  // conversation, and it must be in the frame verbatim.
  const scope = f.manager.context(id);
  expect(scope.enabled).toBe(true);
  expect(wire).toContain(JSON.stringify(scope));
  expect(scope.sessionToken).toBeTruthy();
  expect(wire).toContain(scope.sessionToken!);
  // The runtime half says the same thing in its own field.
  expect(wire).toContain('"mode":"orchestrator"');
});

test("a binding that moves while the frame is being built refuses the send", async () => {
  const f = await fixture();
  const id = f.active();
  // The owner changes during the environment read — the Being was switched while
  // the message was being prepared. `desktopEnvironment` does not look at the
  // owner; `assertCurrent` does, and it is the second of its two calls that sees it.
  f.during = async () => { await f.manager.selectOwner("identity-b"); };
  await expect(f.sessions.send({ sessionId: id, text: "在吗" })).rejects.toMatchObject({
    code: "SESSION_CHANGED", message: "编排模式或会话绑定已变化，请重新发送。",
  });
  // Nothing was dispatched: the refusal is pre-dispatch, so the message is not
  // in the Being's timeline and the composer gets it back.
  expect(f.calls.some(call => call.path === "/api/chat/stream")).toBe(false);
  expect(f.sessions.view(id).sent).toEqual([]);
});

test("assertCurrent refuses a prepared message whose orchestration mode changed before dispatch", async () => {
  const f = await fixture();
  setOrchestrationInstructions(orchestrationInstructions);
  await f.enable();
  const id = f.active();
  // The window `BeingChat.send` guards: `prepareMessage` has resolved and the
  // POST has not gone out. It calls this exact function there (being-chat.ts
  // line 515), so calling it here is the same check at the same moment.
  const prepared = await f.prepare({ sessionId: id });
  expect(prepared.context).toContain("[Being Desktop Orchestrator mode]");
  await f.manager.configure({ enabled: false }, async () => {});
  expect(() => prepared.assertCurrent!()).toThrowError(
    expect.objectContaining({ code: "SESSION_CHANGED", message: "编排模式或会话绑定已变化，请重新发送。" }) as unknown as Error,
  );
  // And the frame it had already produced is still a well-formed one — the
  // refusal is about when it may be used, not about what it says.
  expect(unwrapMessage(wrapMessage("在吗", prepared.context))).toBe("在吗");
});

test("a Being with no orchestration subsystem still gets a frame, in direct mode", async () => {
  // The registry lookup is optional by contract: the worker unit may be absent.
  const environment = desktopEnvironment({
    desktopId: DESKTOP, clientVersion: "0.9.0", settings: () => SETTINGS,
    bridge: () => null, terminalTools: () => null, orchestration: () => null,
    inspectPolicy: async () => ({ status: "disabled", scope: "desktop" }),
    clock: () => Date.parse("2026-09-16T08:00:00Z"), platform: "darwin",
  });
  const prepare = nativeMessageContext({ orchestration: () => null, environment });
  const id = randomUUID();
  const prepared = await prepare({ sessionId: id });
  expect(prepared.context).toContain("[Being Desktop 当前消息环境]");
  expect(prepared.context).toContain('"mode":"direct"');
  expect(prepared.context).not.toContain("[Being Desktop Orchestrator mode]");
  expect(() => prepared.assertCurrent!()).not.toThrow();
  expect(unwrapMessage(wrapMessage("在吗", prepared.context))).toBe("在吗");
});
