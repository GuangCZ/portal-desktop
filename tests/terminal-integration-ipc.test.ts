// The terminal's IPC surface and the reveal handshake; 2026-09-16 (I3).
//
// Not a port — BeingDesktop 0.8.26 registers these handlers inline in
// src/main.cjs lines 1102-1116 — but every channel's behaviour is the one
// measured there, and the request shapes come from docs/interfaces.md §1.2
//「桌面工具、控制台与终端」.
//
// The limits themselves (8 sessions, 64 KiB, 2..500 x 1..200, the 1 MiB replay
// buffer) belong to `DesktopTerminal` and are pinned by
// tests/tools-terminal-terminal.test.ts. What this file pins is that they REACH
// the renderer: the channel layer must not swallow, rewrite or pre-empt them.
//
// The reveal gate is new here. 0.8.26 asked the page directly
// (`executeJavaScript('window.beingTerminal.reveal(id)')`) and could not hang;
// a push plus an invoke can, so the deadline and what happens around it — a late
// answer, a second waiter, the window going away — are the cases below.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createTrustedHandle } from "../desktop/main/app/ipc";
import { createRevealGate, registerTerminalIpc, TERMINAL_UNAVAILABLE } from "../desktop/main/tools/terminal/ipc";
import { DesktopTerminal } from "../desktop/main/tools/terminal/terminal";
import { publicErrorMessage } from "../desktop/shared/errors";
import type { PtyDisposable, PtyExitEvent, PtyLike, PtySpawnOptions } from "../desktop/main/tools/terminal/types";
import type { TerminalCreateState, TerminalRevealResult, TerminalState } from "../desktop/shared/desktop-types";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL = "beings://desktop/";
const CHANNELS = ["beings:terminal", "beings:terminal-read", "beings:terminal-action", "beings:terminal-revealed"];

class FakePty implements PtyLike {
  pid = 4242;
  data = new Set<(value: string) => void>();
  exit = new Set<(event: PtyExitEvent) => void>();
  writes: string[] = [];
  sizes: { cols: number; rows: number }[] = [];
  kills = 0;
  onData(listener: (value: string) => void): PtyDisposable { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable { this.exit.add(listener); return { dispose: () => this.exit.delete(listener) }; }
  emit(text: string) { for (const listener of this.data) listener(text); }
  write(value: string) { this.writes.push(value); }
  resize(cols: number, rows: number) { this.sizes.push({ cols, rows }); }
  kill() { this.kills++; for (const listener of this.exit) listener({ exitCode: 0 }); }
}

function fixture({ terminal = true }: { terminal?: boolean } = {}) {
  const spawned: FakePty[] = [];
  const pty = { spawn: (_file: string, _args: string[] | string, _options: PtySpawnOptions) => { const handle = new FakePty(); spawned.push(handle); return handle; } };
  // win32 and a fake pty, so the case is the same on every runner: the terminal
  // is only offered on win32 and darwin (common/platform.ts `terminalSupported`).
  const service = terminal ? new DesktopTerminal({ pty, platform: "win32", getWorkspace: () => path.resolve(dirname, "..") }) : null;
  const handlers = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  const pushes: { channel: string; payload: any }[] = [];
  let quitting = false;
  const mainFrame = { url: SHELL };
  const webContents = { mainFrame, isDestroyed: () => false, send: (channel: string, payload: unknown) => { pushes.push({ channel, payload }); } };
  const window = { isDestroyed: () => false, webContents };
  // The wrapper production registers through, not a re-creation of it: its catch
  // replaces whatever a handler throws with `publicErrorMessage(error)`, so an
  // assertion here is on the sentence the renderer actually receives.
  const handle = createTrustedHandle({
    register: (channel, listener) => { handlers.set(channel, listener); },
    window: () => window, shellURL: () => SHELL,
    quitting: () => quitting, recoveryBlocked: () => false,
    report: (_channel, error) => publicErrorMessage(error),
  });
  const answered: TerminalRevealResult[] = [];
  registerTerminalIpc({ handle, terminal: () => service, revealed: result => answered.push(result) });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args) as Promise<any>;
  return {
    service, spawned, handlers, pushes, answered, call,
    state: () => call("beings:terminal") as Promise<TerminalState>,
    act: (action: string, value?: unknown) => call("beings:terminal-action", action, value),
    quit: () => { quitting = true; },
    untrusted: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {}, senderFrame: { url: "https://elsewhere.example/" } }, ...args),
  };
}

describe("terminal IPC", () => {
  it("registers the documented channel set and answers an empty snapshot before anything is built", async () => {
    const f = fixture({ terminal: false });
    expect([...f.handlers.keys()]).toEqual(CHANNELS);
    // Listing answers while unavailable: an empty tab strip is the truth, and a
    // refusal there would look like a failure of the panel rather than absence.
    expect(await f.state()).toEqual({ sessions: [], activeSessionId: null });
    await expect(f.act("create", {})).rejects.toThrow(TERMINAL_UNAVAILABLE);
    await expect(f.call("beings:terminal-read", "any")).rejects.toThrow(TERMINAL_UNAVAILABLE);
  });

  it("every action answers the snapshot, and create also carries the new session id", async () => {
    const f = fixture();
    const created = await f.act("create", {}) as TerminalCreateState;
    expect(created.sessions).toHaveLength(1);
    expect(created.sessionId).toBe(created.sessions[0].id);
    expect(created.activeSessionId).toBe(created.sessionId);
    const id = created.sessionId;

    expect(await f.act("write", { id, data: "echo being\r" })).toMatchObject({ activeSessionId: id });
    expect(f.spawned[0].writes).toEqual(["echo being\r"]);

    await f.act("resize", { id, cols: 120, rows: 40 });
    expect(f.spawned[0].sizes).toEqual([{ cols: 120, rows: 40 }]);
    expect((await f.state()).sessions[0]).toMatchObject({ cols: 120, rows: 40 });

    const second = await f.act("create", {}) as TerminalCreateState;
    expect((await f.act("activate", id) as TerminalState).activeSessionId).toBe(id);
    const closed = await f.act("close", second.sessionId) as TerminalState;
    expect(closed.sessions.map(session => session.id)).toEqual([id]);
    // The snapshot the renderer receives never carries output, the environment or
    // the pty handle — the tab strip is all it is for.
    expect(Object.keys(closed.sessions[0]).sort()).toEqual(["cols", "cwd", "exitCode", "id", "pid", "rows", "status", "title"]);
  });

  it("the measured limits reach the renderer rather than being re-stated here", async () => {
    const f = fixture();
    const ids: string[] = [];
    for (let index = 0; index < 8; index++) ids.push((await f.act("create", {}) as TerminalCreateState).sessionId);
    await expect(f.act("create", {})).rejects.toThrow("最多同时保留 8 个终端，请先关闭一个终端。");
    await expect(f.act("write", { id: ids[0], data: "x".repeat(64 * 1024 + 1) })).rejects.toThrow("终端输入不能超过 64 KiB。");
    // 64 KiB exactly is allowed: the limit is a maximum, not a threshold.
    await f.act("write", { id: ids[0], data: "y".repeat(64 * 1024) });
    await expect(f.act("resize", { id: ids[0], cols: 1, rows: 30 })).rejects.toThrow("终端尺寸无效。");
    await expect(f.act("create", { cols: 501, rows: 30 })).rejects.toThrow("终端尺寸无效。");
    await expect(f.act("close", "no-such-session")).rejects.toThrow("终端会话不存在。");
  });

  it("refuses an unknown action and input the renderer should never send", async () => {
    const f = fixture();
    const { sessionId } = await f.act("create", {}) as TerminalCreateState;
    await expect(f.act("detach", sessionId)).rejects.toThrow("未知终端操作。");
    // An unknown field means the caller and this contract disagree; guessing which
    // is right is how a stale renderer silently loses a parameter.
    await expect(f.act("create", { cwd: ".", shell: "bash" })).rejects.toThrow("终端创建参数无效。");
    await expect(f.act("write", { id: sessionId, data: 42 })).rejects.toThrow("终端输入不能超过 64 KiB。");
    await expect(f.act("write", { id: 7, data: "x" })).rejects.toThrow("终端会话不存在。");
    await expect(f.act("resize", { id: sessionId, cols: "120", rows: 40 })).rejects.toThrow("终端尺寸无效。");
    // Not a plain object: a class instance or an array would carry a prototype the
    // whitelist walk never sees.
    await expect(f.act("create", [])).rejects.toThrow("终端创建参数无效。");
    await expect(f.act("create", JSON.parse('{"__proto__": {"polluted": true}}'))).rejects.toThrow("终端创建参数无效。");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expect(f.call("beings:terminal-revealed", { id: sessionId, shown: "yes" })).rejects.toThrow("终端展示参数无效。");
    expect(f.answered).toEqual([]);
  });

  it("replay and the live events share one sequence, so a subscriber can join without a gap", async () => {
    const f = fixture();
    const { sessionId } = await f.act("create", {}) as TerminalCreateState;
    f.spawned[0].emit("first\r\n");
    f.spawned[0].emit("second\r\n");
    const replay = await f.call("beings:terminal-read", sessionId);
    expect(replay).toEqual({ id: sessionId, sequence: 2, data: "first\r\nsecond\r\n", truncated: false });
    // Which is exactly the sequence the last data event carried: the renderer
    // drops everything at or below it and resumes from the next one.
    expect(f.service!.readSince(sessionId, replay.sequence).data).toBe("");
  });

  it("the trusted wrapper's two guards cover every terminal channel", async () => {
    const f = fixture();
    await expect(f.untrusted("beings:terminal")).rejects.toThrow("Untrusted IPC sender");
    f.quit();
    for (const channel of CHANNELS) await expect(f.call(channel)).rejects.toThrow("客户端正在退出，请稍候。");
  });
});

describe("terminal reveal gate", () => {
  it("resolves with the renderer's answer, and once", async () => {
    const asked: string[] = [];
    const gate = createRevealGate(id => asked.push(id), 50);
    const pending = gate.request("session-1");
    expect(asked).toEqual(["session-1"]);
    gate.settle({ id: "session-1", shown: true });
    expect(await pending).toBe(true);
    // A late answer to a request nobody is waiting on is not an error.
    expect(() => gate.settle({ id: "session-1", shown: false })).not.toThrow();
  });

  it("gives up on its own deadline, so a panel that never mounts refuses by silence", async () => {
    vi.useFakeTimers();
    try {
      const gate = createRevealGate(() => {}, 2000);
      const pending = gate.request("session-1");
      vi.advanceTimersByTime(1999);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await pending).toBe(false);
      // The answer that arrives after the deadline changes nothing.
      gate.settle({ id: "session-1", shown: true });
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("answers every waiter for a session, and abort releases them all", async () => {
    const gate = createRevealGate(() => {}, 50);
    const first = gate.request("a"), second = gate.request("a"), other = gate.request("b");
    gate.settle({ id: "a", shown: true });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    gate.abort();
    expect(await other).toBe(false);
  });
});
