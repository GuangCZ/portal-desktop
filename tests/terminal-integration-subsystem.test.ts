// The terminal subsystem: the assembly BeingDesktop 0.8.26 does at src/main.cjs
// lines 1710-1712, the teardown at line 1615, and `showTerminal` at line 1697.
// 2026-09-16 (I3).
//
// Three things are worth a case of their own here rather than in the IPC file:
//
//  · the WORKSPACE wiring. 0.8.26 passes `state.workspace.path`; this shell has
//    two workspaces — the Desktop project directory and the Portal one — and
//    getting the precedence wrong sends every new shell to the wrong folder,
//    which nothing else would catch.
//  · the UN-INJECTED PTY path (integration plan §5.8). The panel, the channels
//    and the browser ship before node-pty does, so a client with no pty module
//    must fail with BeingDesktop's own sentence and stay usable afterwards.
//  · the REVEAL handshake end to end: the pushes, the answer, and the two ways it
//    refuses.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { installSubsystems } from "../desktop/main/extensions";
import { installTerminalSubsystem } from "../desktop/main/subsystems/terminal";
import type { TerminalSubsystem } from "../desktop/main/subsystems/terminal";
import { setDefaultPtyFactory } from "../desktop/main/tools/terminal/terminal";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { PtyDisposable, PtyExitEvent, PtyLike, PtySpawnOptions } from "../desktop/main/tools/terminal/types";
import type { Settings } from "../desktop/shared/types";
import type { TerminalCreateState } from "../desktop/shared/desktop-types";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL = "beings://desktop/";

class FakePty implements PtyLike {
  pid = 7000;
  data = new Set<(value: string) => void>();
  exit = new Set<(event: PtyExitEvent) => void>();
  kills = 0;
  constructor(readonly options: PtySpawnOptions) {}
  onData(listener: (value: string) => void): PtyDisposable { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable { this.exit.add(listener); return { dispose: () => this.exit.delete(listener) }; }
  emit(text: string) { for (const listener of this.data) listener(text); }
  write() {}
  resize() {}
  kill() { this.kills++; for (const listener of this.exit) listener({ exitCode: 0 }); }
}

/** How the native module behaves on this machine.
 *  · 'fake'         — loads, and spawns the fixture's pty.
 *  · 'missing'      — registered, but `require` throws: a module that is absent
 *                     or built for another Electron ABI, which is what
 *                     BeingDesktop's inline `require('node-pty')` did.
 *  · 'unregistered' — nothing registered at all, the state the skeleton commit
 *                     ships in (integration plan §5.8). */
type PtyMode = "fake" | "missing" | "unregistered";

function fixture({ pty = "fake", settings = {} as Partial<Settings> }: { pty?: PtyMode; settings?: Partial<Settings> } = {}) {
  const spawned: FakePty[] = [];
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  const errors: { scope: string; error: unknown }[] = [];
  let destroyed = false;
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => destroyed, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => destroyed, webContents };
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => false, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  // The real installer, through the real registry machinery; the wrapper only
  // captures the instance, which `installSubsystems` returns no handle to (its
  // return value is the lifecycle fan-out, and the registry is private to it).
  let subsystem!: TerminalSubsystem;
  const extensions = installSubsystems({
    handle, exclusive: operation => operation(),
    window: () => window,
    store: { connection: null, connectionAddress: "", settings: settings as Settings },
    secretStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
    userData: dirname, desktopId: "11111111-1111-4111-8111-111111111111",
    onError: (scope, error) => { errors.push({ scope, error }); },
  }, [context => (subsystem = installTerminalSubsystem(context))]);
  // AFTER installing, because the installer calls `registerNodePty()` — the
  // production mechanism, not a constructor parameter. `DesktopTerminal` resolves
  // the factory on its first `create()`, so the last registration wins.
  setDefaultPtyFactory(
    pty === "fake" ? () => ({ spawn: (_file: string, _args: string[] | string, options: PtySpawnOptions) => { const handle = new FakePty(options); spawned.push(handle); return handle; } })
      : pty === "missing" ? () => { throw new Error("Cannot find module 'node-pty'"); }
        : null);
  // The terminal is offered on win32 and darwin only (common/platform.ts
  // `terminalSupported`), and the subsystem takes the host's platform on purpose.
  // Pin it so every runner exercises the same case; the pty is a fake either way.
  if (subsystem.terminal) subsystem.terminal.platform = "darwin";
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args) as Promise<any>;
  return {
    extensions, handlers, pushes, errors, call, spawned, subsystem,
    act: (action: string, value?: unknown) => call("beings:terminal-action", action, value),
    destroy: () => { destroyed = true; },
    cleanup: async () => { setDefaultPtyFactory(null); await extensions.quitting().catch(() => {}); },
  };
}

describe("terminal subsystem", () => {
  it("builds the terminal BeingDesktop's boot() builds, and pushes what it pushes", async () => {
    const f = fixture({ settings: { projectWorkspace: path.resolve(dirname, ".."), workspace: "/nowhere" } });
    try {
      const created = await f.act("create", {}) as TerminalCreateState;
      // The Desktop PROJECT directory — 0.8.26's `state.workspace.path` — and
      // never the Portal working directory beside it, which is where the engine
      // runs and which need not exist.
      expect(created.sessions[0].cwd).toBe(path.resolve(dirname, ".."));
      // `being:terminal-state` on every change (src/main.cjs line 1711).
      expect(f.pushes.filter(push => push.channel === "beings:terminal-state").length).toBeGreaterThan(0);
      f.spawned[0].emit("hello\r\n");
      // `being:terminal-data` per chunk, with the sequence the replay shares.
      expect(f.pushes.filter(push => push.channel === "beings:terminal-data").map(push => push.payload))
        .toEqual([{ id: created.sessionId, sequence: 1, data: "hello\r\n" }]);
      const replay = await f.call("beings:terminal-read", created.sessionId);
      expect(replay).toMatchObject({ sequence: 1, data: "hello\r\n" });
    } finally { await f.cleanup(); }
  });

  it("opens in the home directory when no project is chosen, never in the Portal workspace", async () => {
    // The regression a packaged smoke run found on 2026-09-16: `settings
    // .workspace` defaults to `~/Being Desktop Workspace` and is not created
    // until the user saves connection settings, so using it as a fallback made
    // every terminal on a fresh profile refuse with
    //「终端工作目录不存在或无法访问。」.
    const f = fixture({ settings: { workspace: path.join(os.homedir(), "Being Desktop Workspace") } });
    try {
      const created = await f.act("create", {}) as TerminalCreateState;
      expect(created.sessions[0].cwd).toBe(await fs.realpath(os.homedir()));
    } finally { await f.cleanup(); }
  });

  it("without a usable pty module it refuses with BeingDesktop's own sentence and stays usable", async () => {
    // Both halves of integration plan §5.8's degradation: the skeleton commit,
    // where nothing is registered, and a machine whose native module will not
    // load. They must be indistinguishable to the user.
    for (const pty of ["unregistered", "missing"] as const) {
      const f = fixture({ pty });
      try {
        // The message a failed `require('node-pty')` produced in 0.8.26,
        // unchanged; the shell name comes from the platform, so the invariant
        // half is what is matched.
        await expect(f.act("create", {})).rejects.toThrow(/交互终端，请检查终端组件与系统安装。$/);
        // Nothing was half-created, the create slot was released, and the channels
        // still answer — the panel shows an empty stage, not a broken client.
        expect(await f.call("beings:terminal")).toEqual({ sessions: [], activeSessionId: null });
        expect(f.errors).toEqual([]);
        await expect(f.act("create", {})).rejects.toThrow(/交互终端，请检查终端组件与系统安装。$/);
      } finally { await f.cleanup(); }
    }
  });

  it("reveal pushes the request, waits for the panel, and refuses two ways", async () => {
    const f = fixture();
    try {
      const created = await f.act("create", {}) as TerminalCreateState;
      const id = created.sessionId;
      f.pushes.length = 0;

      // Answered yes: the request is pushed, and the session is made active first
      // so the panel has something to select (src/main.cjs line 1699). Two state
      // pushes, as in 0.8.26: `activate` notifies through `onChange`, and the
      // explicit send after it is what that line does.
      const shown = f.subsystem.reveal(id);
      await Promise.resolve();
      expect(f.pushes.map(push => push.channel)).toEqual(["beings:terminal-state", "beings:terminal-state", "beings:terminal-reveal"]);
      expect(f.pushes.at(-1)!.payload).toEqual({ id });
      await f.call("beings:terminal-revealed", { id, shown: true });
      await expect(shown).resolves.toBeUndefined();

      // Answered no: BeingDesktop's own message, so the Being is told how to
      // recover rather than that something is broken.
      const refused = f.subsystem.reveal(id);
      await Promise.resolve();
      await f.call("beings:terminal-revealed", { id, shown: false });
      await expect(refused).rejects.toThrow("终端已创建，但面板尚未展示，请用终端列表和显示工具恢复。");

      // An unknown session never reaches the panel at all.
      await expect(f.subsystem.reveal("no-such-session")).rejects.toThrow("终端会话不存在。");

      f.destroy();
      await expect(f.subsystem.reveal(id)).rejects.toThrow("桌面窗口已关闭。");
    } finally { await f.cleanup(); }
  });

  it("quitting ends every session before the client exits", async () => {
    const f = fixture();
    try {
      await f.act("create", {});
      await f.act("create", {});
      expect(f.spawned).toHaveLength(2);
      await f.extensions.quitting();
      expect(f.spawned.map(handle => handle.kills)).toEqual([1, 1]);
      expect(f.subsystem.terminal!.snapshot()).toEqual({ sessions: [], activeSessionId: null });
      // Idempotent: main.ts can call it again on a second close attempt.
      await expect(f.extensions.quitting()).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
  });
});
