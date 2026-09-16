// The sidebar ledger's channels, against the profile they actually write.
// New in the portal-desktop shell on 2026-09-16 (integration unit I6); the
// behaviour under test is BeingDesktop 0.8.26's — `sidebarAction` (src/main.cjs
// line 1139), `publicState().sidebar` (line 567) and the settings.json format of
// docs/interfaces.md §7.
//
// It installs the real subsystem registry through the real trusted-sender wrapper
// with a real `SettingsStore` over a temporary profile, because the two claims
// worth testing are about persistence and identity, and a stubbed store would
// assert neither: a pin survives a restart, and switching Beings swaps the whole
// set of pins without either Being seeing the other's.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { SettingsStore } from "../desktop/main/app/settings";
import { beingIdentityKey } from "../desktop/main/chat/connection";
import { installSubsystems } from "../desktop/main/extensions";
import { installChatSubsystem } from "../desktop/main/subsystems/chat";
import { installShellStateSubsystem } from "../desktop/main/subsystems/shell-state";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { ShellSidebarState } from "../desktop/shared/shell-state-types";

const DESKTOP = "11111111-1111-4111-8111-111111111111";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const ADDRESS_A = `https://echo.beings.town/cz_being/?token=${TOKEN_A}`;
const ADDRESS_B = `https://echo.beings.town/other_being/?token=${TOKEN_B}`;
const SHELL = "beings://desktop/";
const CHANNELS = ["beings:sidebar-state", "beings:sidebar-action", "beings:sidebar-project-add"];
const json = (value: unknown, status = 200) =>
  new Response(value === null ? null : JSON.stringify(value), { status, headers: value === null ? {} : { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 25; index++) await new Promise(resolve => setImmediate(resolve)); };
/** The secret storage the client is handed in tests: reversible, not encrypting,
 * so a fixture can write the credential a profile is expected to already hold. */
const secretStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() };
const credential = (address: string) => Buffer.from(address).toString("base64");

async function fixture({ profile = {} as Record<string, unknown>, address = ADDRESS_A }: { profile?: Record<string, unknown>; address?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shell-state-test-"));
  // `address: ""` is a profile that has never been connected: no credential, so
  // `SettingsStore.load` leaves `connectionAddress` empty and the ledger has no
  // bucket to read.
  await writeFile(path.join(directory, "settings.json"), JSON.stringify({ ...(address ? { credential: credential(address) } : {}), ...profile }));
  const fetchImpl = (async (url: string) => {
    const route = new URL(url).pathname.replace(/^\/[a-z_]+/, "");
    if (route === "/api/history") return json({ messages: [] });
    if (route === "/api/stream/active") return json(null, 204);
    throw new Error(`no route: ${route}`);
  }) as unknown as typeof fetch;

  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => false, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => false, webContents };
  // Production's own queue shape: one operation at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const store = new SettingsStore(directory, secretStorage, "/nonexistent/portal");
  await store.load();
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => false, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  // Only the two subsystems this file is about: the ledger under test and the
  // conversation layer it hangs sessions on. `installDesktopExtensions` would
  // also install the tool browser and terminal, whose electron bindings this
  // fixture does not fake (merge of I3/I2/I4/I6, 2026-09-16).
  const extensions = installSubsystems({
    handle, exclusive, window: () => window, store, secretStorage, userData: directory,
    desktopId: DESKTOP, clientVersion: "0.9.0", fetchImpl,
    onError: (scope, error) => { errors.push({ scope, error }); },
  }, [installChatSubsystem, installShellStateSubsystem]);
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args) as Promise<any>;
  const connect = async () => {
    extensions.connectionVerified(store.connection);
    await extensions.ready; await settle();
  };
  return {
    directory, store, extensions, handlers, pushes, errors, call, connect, exclusive,
    sidebar: () => call("beings:sidebar-state") as Promise<ShellSidebarState>,
    /** A conversation the sidebar can act on, created the way the renderer does. */
    conversation: () => call("beings:chat-change-session", null) as Promise<string>,
    saved: async () => JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")),
    untrusted: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {}, senderFrame: { url: "https://elsewhere.example/" } }, ...args),
    cleanup: async () => { await extensions.quitting(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("the ledger registers its channels, refuses an untrusted sender, and reads a 0.8.x profile", async () => {
  // A profile written by BeingDesktop 0.8.26: its own `sidebar` key, its own
  // top-level `workspace` (this client's `projectWorkspace`), and keys this
  // client does not own.
  const scope = beingIdentityKey(ADDRESS_A);
  const task = "33333333-3333-4333-8333-333333333333";
  const f = await fixture({ profile: {
    workspace: "/Users/me/Projects/BeingDesktop", chatMode: "native",
    sidebar: { projects: ["/Users/me/Projects/BeingDesktop"], owners: { [scope]: { tasks: { [task]: { pinned: true, archived: false, project: "/Users/me/Projects/BeingDesktop", touchedAt: 7 } } } } },
  } });
  try {
    expect(CHANNELS.every(channel => f.handlers.has(channel))).toBe(true);
    await expect(f.untrusted("beings:sidebar-state")).rejects.toThrow(/Untrusted/);
    // The bucket follows the SAVED address, so the pins are on screen before the
    // connection has been verified — 0.8.26 resolves its scope the same way, from
    // the connection its `restore()` parsed (src/main.cjs line 567).
    await f.connect();
    expect(await f.sidebar()).toEqual({
      scope, projects: ["/Users/me/Projects/BeingDesktop"],
      tasks: { [task]: { pinned: true, archived: false, project: "/Users/me/Projects/BeingDesktop", touchedAt: 7 } },
    });
    // Binding a Being republishes the ledger, so a renderer holding the previous
    // Being's pins is corrected without asking.
    expect(f.pushes.filter(push => push.channel === "beings:sidebar").at(-1)!.payload.scope).toBe(scope);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }

  // A profile that has never been connected reads its project list and nothing
  // else: with no Being there is no bucket, and a change would have nowhere to go
  // — except removing a folder, which belongs to the profile rather than to a
  // Being (test/sidebar-state.test.cjs's fifth case).
  const fresh = await fixture({ address: "", profile: { sidebar: { projects: ["/Users/me/Work"] } } });
  try {
    expect(await fresh.sidebar()).toEqual({ scope: "", projects: ["/Users/me/Work"], tasks: {} });
    await expect(fresh.call("beings:sidebar-action", { type: "pin", id: task, scope: "" })).rejects.toThrow(/连接已变化/);
    expect((await fresh.call("beings:sidebar-action", { type: "remove-project", project: "/Users/me/Work", scope: "" })).projects).toEqual([]);
  } finally { await fresh.cleanup(); }
});

test("a pin is written to the profile and is still there after a restart", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const id = await f.conversation();
    const state: ShellSidebarState = await f.call("beings:sidebar-action", { type: "pin", id, scope: beingIdentityKey(ADDRESS_A) });
    expect(state.tasks[id]).toEqual({ pinned: true, archived: false, project: "", touchedAt: 0 });
    expect(f.pushes.filter(push => push.channel === "beings:sidebar").at(-1)!.payload).toEqual(state);
    // On disk, under 0.8.26's key, beside the credential it did not touch.
    const saved = await f.saved();
    expect(saved.sidebar.owners[beingIdentityKey(ADDRESS_A)].tasks[id].pinned).toBe(true);
    expect(saved.credential).toBe(credential(ADDRESS_A));
    await f.extensions.quitting();

    // The restart: a second client over the same profile directory.
    const restarted = await fixture();
    try {
      await rm(path.join(restarted.directory, "settings.json"));
      await writeFile(path.join(restarted.directory, "settings.json"), JSON.stringify(saved));
      await restarted.store.load();
      await restarted.connect();
      expect((await restarted.sidebar()).tasks[id]).toEqual({ pinned: true, archived: false, project: "", touchedAt: 0 });
    } finally { await restarted.cleanup(); }
  } finally { await f.cleanup(); }
});

test("switching Beings swaps the whole set of pins and refuses a change written for the previous one", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const first = await f.conversation();
    const scopeA = beingIdentityKey(ADDRESS_A);
    await f.call("beings:sidebar-action", { type: "archive", id: first, scope: scopeA });
    expect((await f.sidebar()).tasks[first].archived).toBe(true);

    // The user connects a different Being. `save` rewrites the credential and the
    // client re-verifies, which is when every subsystem is rebound.
    await f.store.save({ connectionLink: ADDRESS_B, workspace: path.join(f.directory, "workspace"),
      portalBinary: "", portalName: "test-client", autoStart: false, allowExec: true, kitsEnabled: true });
    await f.connect();
    const scopeB = beingIdentityKey(ADDRESS_B);
    expect(scopeB).not.toBe(scopeA);
    const swapped = await f.sidebar();
    expect(swapped.scope).toBe(scopeB);
    expect(swapped.tasks).toEqual({});
    // A menu opened before the switch carries the old scope; applying it would
    // file the second Being's conversation under the first Being's pins.
    await expect(f.call("beings:sidebar-action", { type: "pin", id: first, scope: scopeA })).rejects.toThrow(/连接已变化/);
    // And the first Being's bucket is untouched underneath.
    expect((await f.saved()).sidebar.owners[scopeA].tasks[first].archived).toBe(true);
  } finally { await f.cleanup(); }
});

test("project folders are added once, hold their conversations, and release them when removed", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const scope = beingIdentityKey(ADDRESS_A);
    const id = await f.conversation();
    const project = process.platform === "win32" ? "C:\\Users\\me\\Work" : "/Users/me/Work";
    expect((await f.call("beings:sidebar-project-add", project)).projects).toEqual([project]);
    expect((await f.call("beings:sidebar-project-add", project)).projects).toEqual([project]);
    await f.call("beings:sidebar-action", { type: "move", id, scope, project });
    await f.call("beings:sidebar-action", { type: "touch", id, scope });
    const filed = await f.sidebar();
    expect(filed.tasks[id].project).toBe(project);
    expect(filed.tasks[id].touchedAt).toBeGreaterThan(0);
    // Removing the folder keeps the conversation and empties its filing, which is
    // what makes it appear under 会话 again rather than disappear.
    const removed: ShellSidebarState = await f.call("beings:sidebar-action", { type: "remove-project", project, scope });
    expect(removed.projects).toEqual([]);
    expect(removed.tasks[id].project).toBe("");
    expect(removed.tasks[id].touchedAt).toBeGreaterThan(0);
  } finally { await f.cleanup(); }
});

test("malformed requests are refused before they reach the profile", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const scope = beingIdentityKey(ADDRESS_A);
    const id = await f.conversation();
    const before = await f.saved();
    for (const [input, message] of [
      [{ type: "sudo", id, scope }, /侧栏操作无效/],
      [{ type: "pin", id, scope, extra: 1 }, /侧栏操作无效/],
      [{ type: "pin", id, scope, project: "/x" }, /侧栏操作无效/],
      [{ type: "pin", id: "not-a-uuid", scope }, /会话不存在/],
      [{ type: "pin", id: "44444444-4444-4444-8444-444444444444", scope }, /会话不存在/],
      [{ type: "move", id, scope, project: "/never-added" }, /项目不存在/],
      [{ type: "remove-project", project: "/never-added", scope }, /项目不存在/],
      [{ type: "remove-project", id, project: "/x", scope }, /侧栏操作无效/],
      ["pin", /侧栏操作无效/], [null, /侧栏操作无效/],
    ] as [unknown, RegExp][]) {
      await expect(f.call("beings:sidebar-action", input)).rejects.toThrow(message);
    }
    await expect(f.call("beings:sidebar-project-add", "relative/path")).rejects.toThrow(/本机文件夹/);
    await expect(f.call("beings:sidebar-project-add", 12)).rejects.toThrow(/本机文件夹/);
    expect(await f.saved()).toEqual(before);
    expect(f.errors).toEqual([]);
  } finally { await f.cleanup(); }
});
