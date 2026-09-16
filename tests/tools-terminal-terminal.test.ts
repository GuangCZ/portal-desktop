// Ported from BeingDesktop 0.8.26 test/desktop-terminal.test.cjs on 2026-09-16.
// The original already injects a fake pty (it never starts node-pty), so every
// case survives the move to vitest unchanged; only the assertion style differs.
// Fixtures are copied verbatim. Reading digest: docs/migration/u5-terminal-browser.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DesktopTerminal } from "../desktop/main/tools/terminal/terminal";
import type { DesktopTerminalOptions, PtyAgent, PtyDisposable, PtyExitEvent, PtyLike, PtySpawnOptions } from "../desktop/main/tools/terminal/types";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

class FakePty implements PtyLike {
  pid: number;
  data = new Set<(value: string) => void>();
  exit = new Set<(event: PtyExitEvent) => void>();
  errors = new Set<(error: Error) => void>();
  writes: string[] = [];
  sizes: { cols: number; rows: number }[] = [];
  kills = 0;
  _agent?: PtyAgent;
  constructor(pid: number) { this.pid = pid; }
  onData(listener: (value: string) => void): PtyDisposable { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable { this.exit.add(listener); return { dispose: () => this.exit.delete(listener) }; }
  emit(text: string) { for (const listener of this.data) listener(text); }
  end(exitCode = 0) { for (const listener of this.exit) listener({ exitCode }); }
  write(value: string) { this.writes.push(value); }
  resize(cols: number, rows: number) { this.sizes.push({ cols, rows }); }
  kill() { this.kills++; this.end(1); }
  on(name: string, listener: (...args: never[]) => void) { if (name === "error") this.errors.add(listener as unknown as (error: Error) => void); }
  removeListener(name: string, listener: (...args: never[]) => void) { if (name === "error") this.errors.delete(listener as unknown as (error: Error) => void); }
}

interface SpawnCall {
  args: [string, string[] | string, PtySpawnOptions];
  handle: FakePty;
}

function fixture(options: DesktopTerminalOptions = {}) {
  const calls: SpawnCall[] = [];
  const pty = { spawn: (...args: [string, string[] | string, PtySpawnOptions]) => { const handle = new FakePty(1000 + calls.length); calls.push({ args, handle }); return handle; } };
  const service = new DesktopTerminal({ pty, getWorkspace: () => path.resolve(dirname, ".."), platform: "win32", ...options });
  return { service, calls };
}

describe("desktop terminal", () => {
  it("terminal construction is lazy and snapshots contain no output or environment", async () => {
    const { service, calls } = fixture();
    expect(service.snapshot()).toEqual({ sessions: [], activeSessionId: null });
    expect(calls.length).toBe(0);
    await service.dispose();
    await expect(service.create()).rejects.toThrow(/关闭/);
  });

  it("creation selects a real directory, ConPTY and an interactive shell with a clean environment", async () => {
    const { service, calls } = fixture({ environment: {
      SystemRoot: "C:\\Windows", Path: "safe-path", OPENAI_API_KEY: "private", BEING_TOKEN: "private",
      HTTP_PROXY: "http://user:secret@proxy", ELECTRON_RUN_AS_NODE: "1", OTHER: "private",
    } });
    try {
      const { sessionId } = await service.create({ cols: 91, rows: 22 });
      const [file, args, options] = calls[0].args;
      expect(file).toMatch(/powershell\.exe$/i);
      expect(args).toEqual(["-NoLogo", "-NoProfile"]);
      expect(options.useConpty).toBe(true);
      expect(options.conptyInheritCursor).toBe(false);
      expect(options.env?.Path).toBe("safe-path");
      expect(options.env?.TERM).toBe("xterm-256color");
      for (const key of ["OPENAI_API_KEY", "BEING_TOKEN", "HTTP_PROXY", "ELECTRON_RUN_AS_NODE", "OTHER"]) expect(options.env?.[key]).toBe(undefined);
      expect(service.snapshot().activeSessionId).toBe(sessionId);
      expect(service.snapshot().sessions[0].cols).toBe(91);
      expect(service.snapshot().sessions[0].status).toBe("running");
    } finally { await service.dispose(); }
  });

  it("input, Ctrl+C and terminal responses go to the same persistent session", async () => {
    const { service, calls } = fixture();
    try {
      const { sessionId: id } = await service.create();
      for (const data of ["cd child\r", "echo 中文🙂\r", "\x03", "\x1b[A", "\x1b[1;1R"]) service.write({ id, data });
      expect(calls[0].handle.writes).toEqual(["cd child\r", "echo 中文🙂\r", "\x03", "\x1b[A", "\x1b[1;1R"]);
      expect(calls.length).toBe(1);
      expect(() => service.write({ id, data: "界".repeat(23000) })).toThrow(/64 KiB/);
      expect(() => service.write({ id, data: null })).toThrow(/64 KiB/);
      expect(() => service.write({ id: "unknown", data: "x" })).toThrow(/不存在/);
    } finally { await service.dispose(); }
  });

  it("resize validates before native calls and ignores identical dimensions", async () => {
    const { service, calls } = fixture();
    try {
      const { sessionId: id } = await service.create();
      service.resize({ id, cols: 100, rows: 30 });
      service.resize({ id, cols: 120, rows: 42 });
      expect(calls[0].handle.sizes).toEqual([{ cols: 120, rows: 42 }]);
      for (const [cols, rows] of [[0, 20], [501, 20], [80, 201], [80.5, 20], [80, NaN]]) expect(() => service.resize({ id, cols, rows })).toThrow(/尺寸/);
      expect(calls[0].handle.sizes.length).toBe(1);
    } finally { await service.dispose(); }
  });

  it("incremental terminal reads paginate complete Unicode chunks and report expired cursors", async () => {
    const { service, calls } = fixture();
    try {
      const { sessionId: id } = await service.create();
      const expected = "中文🙂".repeat(100000); calls[0].handle.emit(expected);
      let data = "", sequence = 0, more = true;
      while (more) {
        const chunk = service.readSince(id, sequence);
        expect(chunk.truncated).toBe(false); expect(Buffer.byteLength(chunk.data, "utf8") <= 128 * 1024).toBe(true);
        expect(chunk.sequence > sequence).toBe(true); data += chunk.data; sequence = chunk.sequence; more = chunk.hasMore;
      }
      expect(data).toBe(expected); expect(service.readSince(id, sequence).data).toBe("");
      calls[0].handle.emit("x".repeat(2 * 1024 * 1024));
      expect(service.readSince(id, 0).truncated).toBe(true);
      expect(() => service.readSince(id, Number.MAX_SAFE_INTEGER)).toThrow(/游标/);
    } finally { await service.dispose(); }
  });

  it("invalid creation dimensions and invalid directories never spawn", async () => {
    const { service, calls } = fixture();
    for (const options of [{ cols: 0 }, { rows: 201 }, { cwd: "relative" }, { cwd: filename }, { cwd: path.join(dirname, "missing-terminal-fixture") }]) {
      await expect(service.create(options)).rejects.toThrow();
    }
    expect(calls.length).toBe(0);
    await service.dispose();
  });

  it("the eight-session limit includes concurrent pending creates", async () => {
    let release: (value: string) => void = () => {};
    const workspace = new Promise<string>(resolve => { release = resolve; });
    const { service, calls } = fixture({ getWorkspace: () => workspace });
    try {
      const creates = Array.from({ length: 8 }, () => service.create());
      await expect(service.create()).rejects.toThrow(/8 个终端/);
      release(path.resolve(dirname, ".."));
      await Promise.all(creates);
      expect(calls.length).toBe(8);
      await expect(service.create()).rejects.toThrow(/8 个终端/);
    } finally { await service.dispose(); }
  });

  it("dispose during asynchronous workspace resolution prevents the spawn", async () => {
    let release: (value: string) => void = () => {};
    const workspace = new Promise<string>(resolve => { release = resolve; });
    const { service, calls } = fixture({ getWorkspace: () => workspace });
    const pending = service.create();
    await service.dispose();
    release(path.resolve(dirname, ".."));
    await expect(pending).rejects.toThrow(/关闭/);
    expect(calls.length).toBe(0);
  });

  it("replay sequence and streaming sequence avoid loss or duplicate delivery", async () => {
    const events: { id: string; sequence: number; data: string }[] = [];
    const { service, calls } = fixture({ onData: event => events.push(event) });
    try {
      const { sessionId: id } = await service.create();
      calls[0].handle.emit("one");
      const replay = service.read(id);
      calls[0].handle.emit("two");
      expect(replay.data).toBe("one");
      expect(replay.sequence).toBe(1);
      expect(replay.data + events.filter(event => event.sequence > replay.sequence).map(event => event.data).join("")).toBe("onetwo");
      expect(events.map(event => event.id)).toEqual([id, id]);
      expect("data" in service.snapshot().sessions[0]).toBe(false);
    } finally { await service.dispose(); }
  });

  it("replay memory and individual stream chunks are bounded without splitting Unicode", async () => {
    const events: { id: string; sequence: number; data: string }[] = [];
    const { service, calls } = fixture({ onData: event => events.push(event) });
    try {
      const { sessionId: id } = await service.create();
      calls[0].handle.emit("界🙂".repeat(400000) + "tail-marker");
      const replay = service.read(id);
      expect(replay.truncated).toBe(true);
      expect(Buffer.byteLength(replay.data) <= 1024 * 1024).toBe(true);
      expect(replay.data.endsWith("tail-marker")).toBe(true);
      for (const event of events) {
        expect(Buffer.byteLength(event.data) <= 64 * 1024).toBe(true);
        expect(event.data).toBe(Buffer.from(event.data, "utf8").toString("utf8"));
      }
      expect(replay.data).toBe(Buffer.from(replay.data, "utf8").toString("utf8"));
    } finally { await service.dispose(); }
  });

  it("observer failures cannot lose replay or interrupt terminal teardown", async () => {
    const { service, calls } = fixture({ onChange: () => { throw new Error("observer"); }, onData: () => { throw new Error("observer"); } });
    const { sessionId: id } = await service.create();
    calls[0].handle.emit("still-available");
    expect(service.read(id).data).toBe("still-available");
    await service.dispose();
    expect(calls[0].handle.kills).toBe(1);
  });

  it("closing a session stops only its owned PTY, preserves others and deduplicates", async () => {
    const { service, calls } = fixture();
    try {
      const { sessionId: first } = await service.create();
      const { sessionId: second } = await service.create();
      service.activate(first);
      await Promise.all([service.close(first), service.close(first)]);
      expect(calls[0].handle.kills).toBe(1);
      expect(calls[1].handle.kills).toBe(0);
      expect(service.snapshot().activeSessionId).toBe(second);
      expect(calls[0].handle.data.size).toBe(0);
      expect(calls[0].handle.exit.size).toBe(0);
    } finally { await service.dispose(); }
  });

  it("natural exit preserves scrollback and exit code but blocks new input", async () => {
    const { service, calls } = fixture();
    try {
      const { sessionId: id } = await service.create();
      calls[0].handle.emit("last output");
      calls[0].handle.end(7);
      expect(service.snapshot().sessions[0].exitCode).toBe(7);
      expect(service.snapshot().sessions[0].status).toBe("exited");
      expect(service.read(id).data).toBe("last output");
      expect(() => service.write({ id, data: "x" })).toThrow(/结束/);
      expect(() => service.resize({ id, cols: 90, rows: 30 })).toThrow(/结束/);
      await service.close(id);
      expect(calls[0].handle.kills).toBe(1);
    } finally { await service.dispose(); }
  });

  it("failed native close is retryable and never drops ownership", async () => {
    const { service, calls } = fixture();
    const { sessionId: id } = await service.create();
    const original = calls[0].handle.kill.bind(calls[0].handle);
    calls[0].handle.kill = () => { throw new Error("owned PTY is busy"); };
    await expect(service.close(id)).rejects.toThrow(/busy/);
    expect(service.snapshot().sessions.length).toBe(1);
    calls[0].handle.kill = original;
    await service.close(id);
    expect(service.snapshot().sessions.length).toBe(0);
    await service.dispose();
  });

  it("failed dispose restores a usable service and a later successful dispose closes it", async () => {
    const { service, calls } = fixture();
    const { sessionId: first } = await service.create();
    const originalKill = calls[0].handle.kill.bind(calls[0].handle);
    calls[0].handle.kill = () => { throw new Error("fixture close failure"); };
    await expect(service.dispose()).rejects.toThrow(/fixture close failure/);
    expect(service.disposed).toBe(false);
    expect(service.snapshot().sessions[0].id).toBe(first);
    expect(service.snapshot().sessions[0].status).toBe("running");
    const { sessionId: second } = await service.create();
    service.write({ id: second, data: "still usable\r" });
    expect(calls[1].handle.writes).toEqual(["still usable\r"]);
    calls[0].handle.kill = originalKill;
    await service.close(first);
    await service.dispose();
    expect(service.disposed).toBe(true);
    expect(service.snapshot().sessions.length).toBe(0);
    expect(calls[0].handle.kills).toBe(1);
    expect(calls[1].handle.kills).toBe(1);
    await expect(service.create()).rejects.toThrow(/关闭/);
  });

  it("failed spawn releases the create slot and unsupported platforms do not launch", async () => {
    const { service } = fixture({ pty: { spawn: () => { throw new Error("native load failed"); } } });
    for (let index = 0; index < 10; index++) await expect(service.create()).rejects.toThrow(/无法启动/);
    expect(service.pendingCreates).toBe(0);
    expect(service.snapshot().sessions.length).toBe(0);
    await service.dispose();
    const unsupported = fixture({ platform: "linux" });
    await expect(unsupported.service.create()).rejects.toThrow(/不支持/);
    expect(unsupported.calls.length).toBe(0);
    await unsupported.service.dispose();
  });

  it("native stream errors are handled inside the owning session", async () => {
    const { service, calls } = fixture();
    try {
      const { sessionId: id } = await service.create();
      for (const handler of calls[0].handle.errors) handler(new Error("native failure"));
      expect(service.read(id).data).toMatch(/连接已中断/);
      expect(service.snapshot().sessions[0].status).toBe("exited");
      expect(calls[0].handle.kills).toBe(1);
    } finally { await service.dispose(); }
    expect(calls[0].handle.errors.size).toBe(0);
  });

  it("natural shell exit releases its pinned node-pty worker and pipe without touching another session", async () => {
    const { service, calls } = fixture();
    try {
      await service.create();
      await service.create();
      let pipes = 0;
      let workers = 0;
      calls[0].handle._agent = { inSocket: { destroy: () => { pipes++; } }, _conoutSocketWorker: { dispose: () => { workers++; } } };
      calls[0].handle.end(0);
      expect(pipes).toBe(1);
      expect(workers).toBe(1);
      expect(calls[1].handle.kills).toBe(0);
      calls[0].handle.end(0);
      expect(pipes).toBe(1);
    } finally { await service.dispose(); }
  });
});
