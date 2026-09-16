// The Portal's live state, from main.ts's closure to the wire; 2026-09-17
// (integration unit IN).
//
// Integration decision §5.2 says the request context tells the Being what this
// machine's Portal is doing. I5 ported the whole mapping (`portalRuntime`, nine
// rows, pinned by tests/chat-integration-environment.test.ts) and then had to
// leave it without an input: `PortalSupervisor` lives in main.ts's closure and
// `SubsystemContext` had no field for it, both files outside that unit. So the
// chat subsystem passed `() => null` and every frame told the Being「Portal 未配置,
// 健康状况未知」regardless of what the Portal was actually doing
// (docs/migration/i5-conversation.md §7.1 and F2).
//
// This file is the seam the mapping was missing, asserted where it is now
// wired rather than where it is computed: the real registry installs the real
// chat subsystem over a context carrying `portalState`, a message is sent
// through the real `beings:chat-send`, and the frame on the wire is read back.
// Only the network is a fixture.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { installSubsystems } from "../desktop/main/extensions";
import { installChatSubsystem } from "../desktop/main/subsystems/chat";
import { portalRuntime } from "../desktop/main/chat/environment";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { Connection } from "../desktop/main/chat/connection";
import type { PortalState, Settings } from "../desktop/shared/types";

const SHELL = "beings://desktop/";
const TOKEN = "c".repeat(64);
const ADDRESS = `https://echo.beings.town/cz_being/?token=${TOKEN}`;
const SETTINGS = {
  endpoint: "https://echo.beings.town/cz_being", being: "cz_being", hasToken: true,
  workspace: "/tmp/portal-workspace", projectWorkspace: "/tmp/project", portalBinary: "",
  portalName: "willow-portal", autoStart: false, allowExec: false, kitsEnabled: true,
} satisfies Settings;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });

/** The JSON blob the context embeds, parsed back out of the message on the wire.
 * Same reader tests/chat-integration-environment.test.ts uses. */
function runtimeOf(message: string): Record<string, any> {
  const start = message.indexOf("\n{");
  const end = message.indexOf("\n", start + 1);
  return JSON.parse(message.slice(start + 1, end));
}

/** Install the chat subsystem the way `extensions.ts` does, over a context whose
 * `portalState` is whatever the test last set — read at call time, because the
 * supervisor replaces the object on every transition. */
async function fixture(options: { portal?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-portal-state-"));
  let state: PortalState | null = null;
  const posted: { message: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname.replace(/^\/cz_being/, "");
    if (route === "/api/history") return json({ messages: [] });
    if (route === "/api/stream/active") return json(null, 204);
    if (route === "/api/chat/stream") {
      const body = JSON.parse(init.body as string) as { message: string; scene_id: string; client_ref: string };
      posted.push(body);
      return new Response(
        [["meta", { scene_id: body.scene_id, stream_id: "s-1", client_ref: body.client_ref }],
          ["content_block_delta", { scene_id: body.scene_id, delta: { text: "好" } }],
          ["message_stop", { scene_id: body.scene_id }]]
          .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => false, send: () => {} };
  const window = { isDestroyed: () => false, webContents };
  const store = { connection: null as Connection | null, connectionAddress: "", settings: SETTINGS };
  const secretStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => false, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  const extensions = installSubsystems({
    handle, exclusive: operation => operation(),
    window: () => window, store, secretStorage, userData: directory,
    desktopId: "11111111-1111-4111-8111-111111111111", clientVersion: "0.9.0", fetchImpl,
    onError: () => {},
    // The one line main.ts adds. Omitted entirely when a test asks for the shell
    // that models no Portal at all, which is what every other test's context is.
    ...(options.portal === false ? {} : { portalState: () => state }),
  }, [installChatSubsystem]);

  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args);
  store.connection = { endpoint: ADDRESS.split("/?")[0], being: "cz_being", token: TOKEN, relaySecret: TOKEN, link: ADDRESS };
  store.connectionAddress = ADDRESS;
  extensions.connectionVerified(store.connection);
  await extensions.ready;
  await settle();
  cleanups.push(async () => { await extensions.quitting(); await rm(directory, { recursive: true, force: true }); });
  return {
    set portal(value: PortalState | null) { state = value; },
    /** Send one message and hand back the `runtime.portal` the Being received. */
    send: async (text: string) => {
      const sessions = await invoke("beings:chat-sessions") as { sessions: { id: string }[]; active: string };
      await invoke("beings:chat-send", { sessionId: sessions.active || sessions.sessions[0].id, text });
      await settle();
      return runtimeOf(posted.at(-1)!.message).portal as Record<string, unknown>;
    },
  };
}

const state = (phase: PortalState["phase"], extra: Partial<PortalState> = {}): PortalState =>
  ({ phase, message: "fixture", logs: [], ...extra });

test("the frame carries the Portal the supervisor is actually running", async () => {
  const f = await fixture();
  f.portal = state("connected", { managed: true, pid: 4242 });
  // Row by row against the mapping table's source, not against a copy of it: the
  // point of this test is the wiring, and `portalRuntime` is already pinned line
  // by line by tests/chat-integration-environment.test.ts.
  expect(await f.send("在吗")).toEqual(portalRuntime(state("connected", { managed: true, pid: 4242 }), SETTINGS));
  expect(await f.send("在吗")).toMatchObject({
    status: "connected", health: "healthy", management: "desktop",
    name: "being-desktop", configuredName: "willow-portal", workspace: "/tmp/portal-workspace",
  });
});

test("the state is read when the message is sent, never captured when the subsystem is installed", async () => {
  const f = await fixture();
  // Installed while nothing was running at all.
  expect(await f.send("第一条")).toMatchObject({ status: "not_configured", health: "unknown" });
  f.portal = state("starting", { managed: true });
  expect(await f.send("第二条")).toMatchObject({ status: "starting", health: "unknown", management: "desktop" });
  f.portal = state("external", { managed: false });
  expect(await f.send("第三条")).toMatchObject({ status: "external", health: "unknown", management: "external", name: null });
  // A Portal whose port is already held by somebody else looks like it is running
  // and is not the one this client speaks to.
  f.portal = state("running", { managed: true, conflict: true });
  expect(await f.send("第四条")).toMatchObject({ status: "running", health: "unhealthy" });
  f.portal = state("error", { managed: true });
  expect(await f.send("第五条")).toMatchObject({ status: "error", health: "unhealthy" });
});

test("a context that models no Portal still says so rather than failing", async () => {
  // `portalState` is optional so that every existing test's context — none of
  // which has a supervisor — keeps working, and so the frame's prose keeps
  // pointing the Being at `runtime.portal.configuredName`, which is a real value
  // from the saved profile even when nothing is running.
  const f = await fixture({ portal: false });
  expect(await f.send("在吗")).toMatchObject({
    status: "not_configured", health: "unknown", management: "desktop",
    name: null, configuredName: "willow-portal", workspace: "/tmp/portal-workspace",
  });
});
