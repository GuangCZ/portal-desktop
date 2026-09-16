// Ported line by line from BeingDesktop 0.8.26 test/desktop-terminal-tools.test.cjs on 2026-09-16.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DesktopTerminalTools } from "../desktop/main/tools/terminal-tools";
import type { DesktopTerminalLike, TerminalSession } from "../desktop/main/tools/types";

function fixture() {
  const sessions: TerminalSession[] = [], writes: { id: string; data: string }[] = [], shown: string[] = [], closed: string[] = [];
  const terminal: DesktopTerminalLike = {
    snapshot: () => ({ sessions }),
    async create({ cwd }) { const id = randomUUID(); sessions.push({ id, cwd, status: "running" }); return { sessionId: id }; },
    write(value) { writes.push(value); return { written: true }; },
    readSince(id, afterSequence) { return { id, sequence: afterSequence + 1, data: "fixture" }; },
    activate() {},
    async close(id) { closed.push(id); sessions.splice(sessions.findIndex((item) => item.id === id), 1); return { closed: true }; },
  };
  const tools = new DesktopTerminalTools({ getTerminal: () => terminal, showTerminal: (id) => shown.push(id) });
  const scope = tools.scope(randomUUID());
  return { tools, scope, sessions, writes, shown, closed, terminal };
}

describe("desktop terminal tools", () => {
  it("the conversation shares one visible terminal and retried creates/writes execute once", async () => {
    const f = fixture(), create = { ...f.scope, requestId: randomUUID(), cwd: "E:\\workspace" };
    const [first, duplicate] = (await Promise.all([f.tools.invoke("desktop_terminal_create", create), f.tools.invoke("desktop_terminal_create", create)])) as any[];
    expect(first.terminalId).toBe(duplicate.terminalId); expect(f.sessions.length).toBe(1); expect(f.shown).toEqual([first.terminalId]);
    const write = { ...f.scope, terminalId: first.terminalId, requestId: randomUUID(), data: 'Write-Output "hello"\r' };
    await f.tools.invoke("desktop_terminal_write", write); await f.tools.invoke("desktop_terminal_write", write);
    expect(f.writes.length).toBe(1); expect(f.writes[0].data).toBe(write.data);
    await expect(f.tools.invoke("desktop_terminal_write", { ...write, data: "different\r" })).rejects.toThrow(/requestId/);
    expect(((await f.tools.invoke("desktop_terminal_read", { ...f.scope, terminalId: first.terminalId, afterSequence: 9 })) as any).sequence).toBe(10);
    expect(f.closed.length, "Reply boundaries and read operations cannot close a terminal").toBe(0);
  });

  it("tokens, terminal ownership and identity reset prevent cross-conversation access", async () => {
    const f = fixture(), first = (await f.tools.invoke("desktop_terminal_create", { ...f.scope, requestId: randomUUID() })) as any;
    const other = f.tools.scope(randomUUID());
    expect(await f.tools.invoke("desktop_terminal_list", other)).toEqual({ sessions: [] });
    for (const name of ["desktop_terminal_read", "desktop_terminal_write", "desktop_terminal_show", "desktop_terminal_close"]) {
      await expect(f.tools.invoke(name, { ...other, terminalId: first.terminalId, requestId: randomUUID(), data: "x" })).rejects.toThrow(/本会话/);
      await expect(f.tools.invoke(name, { ...f.scope, sessionToken: randomUUID(), terminalId: first.terminalId })).rejects.toThrow(/会话绑定/);
    }
    f.sessions.push({ id: "human-terminal", status: "running" });
    await expect(f.tools.invoke("desktop_terminal_read", { ...f.scope, terminalId: "human-terminal" })).rejects.toThrow(/本会话/);
    f.tools.reset();
    await expect(f.tools.invoke("desktop_terminal_read", { ...f.scope, terminalId: first.terminalId })).rejects.toThrow(/会话绑定/);
    expect(f.sessions.length, "Revoking tool ownership leaves user-visible processes available").toBe(2);
  });

  it("cancellation before creation never spawns, and reset during creation cleans only its new terminal", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.tools.invoke("desktop_terminal_create", { ...f.scope, requestId: randomUUID() }, { signal: controller.signal })).rejects.toThrow();
    expect(f.sessions.length).toBe(0);
    const original = f.terminal.create; let release!: () => void;
    f.terminal.create = async (args) => { await new Promise<void>((resolve) => { release = resolve; }); return original(args); };
    const creating = f.tools.invoke("desktop_terminal_create", { ...f.scope, requestId: randomUUID() });
    await new Promise((resolve) => setImmediate(resolve)); f.tools.reset(); release();
    await expect(creating).rejects.toThrow(/会话绑定/); expect(f.sessions.length).toBe(0); expect(f.closed.length).toBe(1);
  });

  it("explicit close is idempotent and cannot reuse a write request ID", async () => {
    const f = fixture(), created = (await f.tools.invoke("desktop_terminal_create", { ...f.scope, requestId: randomUUID() })) as any;
    const args = { ...f.scope, terminalId: created.terminalId, requestId: randomUUID() };
    await f.tools.invoke("desktop_terminal_close", args); await f.tools.invoke("desktop_terminal_close", args);
    expect(f.closed.length).toBe(1);
  });
});
