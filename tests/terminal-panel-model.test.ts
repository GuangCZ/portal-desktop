// The terminal panel's model, ported from BeingDesktop 0.8.26
// renderer/terminal-panel.js on 2026-09-16 (I3).
//
// The subject is the replay/live protocol between `readTerminal` and
// `being:terminal-data` (terminal-panel.js `replay` / `receive`, lines 79-100).
// It is the one piece of the panel that is neither cosmetic nor a thin call:
// getting it wrong shows the user a screen that is silently missing output, or
// the same output twice, and no test of the main process can see that.
//
// There is no DOM in this suite (vitest.config.ts sets no environment), which is
// exactly why the model hands output to an injected sink rather than to xterm.
import { describe, expect, it } from "vitest";
import { TerminalModel } from "../desktop/renderer/terminal/models/terminal";
import type { TerminalSink } from "../desktop/renderer/terminal/models/terminal";
import type { TerminalData, TerminalReplay, TerminalSession, TerminalState } from "../desktop/shared/desktop-types";
import type { DesktopAPI } from "../desktop/shared/types";

const TRUNCATED = "[90m[较早的终端输出已截断][0m\r\n";
const RESET = "<reset>";

const session = (id: string, over: Partial<TerminalSession> = {}): TerminalSession =>
  ({ id, title: "zsh", cwd: "/w", status: "running", pid: 1, cols: 100, rows: 30, exitCode: null, ...over });

function fixture() {
  const listeners = {
    state: [] as ((value: TerminalState) => void)[],
    data: [] as ((value: TerminalData) => void)[],
    reveal: [] as ((value: { id: string }) => void)[],
  };
  const calls: { name: string; value: unknown }[] = [];
  let snapshot: TerminalState = { sessions: [], activeSessionId: null };
  let replay: TerminalReplay = { id: "a", sequence: 0, data: "", truncated: false };
  let readFails: Error | null = null;
  const answer = <T>(name: string, value: unknown, result: T) => { calls.push({ name, value }); return Promise.resolve(result); };
  const unsubscribe = <T>(list: T[], item: T) => () => { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1); };
  const api = {
    terminal: {
      state: () => answer("state", null, snapshot),
      read: (id: string) => { calls.push({ name: "read", value: id }); return readFails ? Promise.reject(readFails) : Promise.resolve(replay); },
      create: (value: unknown) => answer("create", value, { ...snapshot, sessionId: snapshot.sessions[0]?.id || "" }),
      write: (value: unknown) => answer("write", value, snapshot),
      resize: (value: unknown) => answer("resize", value, snapshot),
      activate: (id: string) => answer("activate", id, snapshot),
      close: (id: string) => answer("close", id, snapshot),
      revealed: (value: unknown) => answer("revealed", value, undefined),
      onState: (callback: (value: TerminalState) => void) => { listeners.state.push(callback); return unsubscribe(listeners.state, callback); },
      onData: (callback: (value: TerminalData) => void) => { listeners.data.push(callback); return unsubscribe(listeners.data, callback); },
      onReveal: (callback: (value: { id: string }) => void) => { listeners.reveal.push(callback); return unsubscribe(listeners.reveal, callback); },
    },
  } as unknown as DesktopAPI;
  const toasted: unknown[] = [];
  const model = new TerminalModel(api, { toast: error => toasted.push(error) });
  const written: string[] = [];
  const interactive: boolean[] = [];
  const sink: TerminalSink = {
    reset: () => { written.push(RESET); },
    write: data => { written.push(data); },
    setInteractive: value => { interactive.push(value); },
  };
  return {
    model, calls, toasted, written, interactive, sink, listeners,
    setReplay: (next: TerminalReplay) => { replay = next; },
    failRead: (error: Error | null) => { readFails = error; },
    pushState: (next: TerminalState) => { snapshot = next; for (const listener of [...listeners.state]) listener(next); },
    pushData: (event: TerminalData) => { for (const listener of [...listeners.data]) listener(event); },
    pushReveal: (id: string) => { for (const listener of [...listeners.reveal]) listener({ id }); },
    settle: async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); },
  };
}

describe("terminal panel model", () => {
  it("replays the retained buffer, then resumes from the sequence the replay ended on", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.setReplay({ id: "a", sequence: 2, data: "one\r\ntwo\r\n", truncated: false });
    f.model.attach("a", f.sink);
    await f.settle();
    expect(f.written).toEqual([RESET, "one\r\ntwo\r\n"]);
    // Everything at or below the replay's sequence is already on screen. Read and
    // the data events share one counter precisely so this can be decided here.
    f.pushData({ id: "a", sequence: 1, data: "one\r\n" });
    f.pushData({ id: "a", sequence: 2, data: "two\r\n" });
    expect(f.written).toHaveLength(2);
    f.pushData({ id: "a", sequence: 3, data: "three\r\n" });
    expect(f.written.at(-1)).toBe("three\r\n");
    stop();
  });

  it("says so when the retained buffer had already rolled over", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.setReplay({ id: "a", sequence: 900, data: "tail\r\n", truncated: true });
    f.model.attach("a", f.sink);
    await f.settle();
    // BeingDesktop's own dim line, byte for byte (terminal-panel.js line 85).
    expect(f.written).toEqual([RESET, TRUNCATED, "tail\r\n"]);
    stop();
  });

  it("a gap in the sequence re-reads rather than writing the hole", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.setReplay({ id: "a", sequence: 1, data: "one\r\n", truncated: false });
    f.model.attach("a", f.sink);
    await f.settle();
    f.written.length = 0;

    // Event 4 with only 1 seen: two chunks were lost, so the retained buffer is
    // the authority and the screen is rebuilt from it.
    f.setReplay({ id: "a", sequence: 4, data: "one\r\ntwo\r\nthree\r\nfour\r\n", truncated: false });
    f.pushData({ id: "a", sequence: 4, data: "four\r\n" });
    await f.settle();
    expect(f.written).toEqual([RESET, "one\r\ntwo\r\nthree\r\nfour\r\n"]);
    // The queued event is re-delivered after the read; it is at the cursor, so it
    // must not be written a second time.
    f.pushData({ id: "a", sequence: 5, data: "five\r\n" });
    expect(f.written.at(-1)).toBe("five\r\n");
    stop();
  });

  it("events that arrive during a replay are held and delivered in order", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.setReplay({ id: "a", sequence: 1, data: "one\r\n", truncated: false });
    f.model.attach("a", f.sink);
    // Before the read resolves, and out of order on purpose.
    f.pushData({ id: "a", sequence: 3, data: "three\r\n" });
    f.pushData({ id: "a", sequence: 2, data: "two\r\n" });
    await f.settle();
    expect(f.written).toEqual([RESET, "one\r\n", "two\r\n", "three\r\n"]);
    stop();
  });

  it("a detached view receives nothing, and a closed session's view is dropped", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a"), session("b")], activeSessionId: "a" });
    const detach = f.model.attach("a", f.sink);
    await f.settle();
    f.written.length = 0;
    detach();
    f.pushData({ id: "a", sequence: 1, data: "ignored" });
    expect(f.written).toEqual([]);

    // Re-attached, then the session goes away: the model forgets the view, so a
    // stray event for a dead id cannot reach a live xterm.
    f.model.attach("a", f.sink);
    await f.settle();
    f.written.length = 0;
    f.pushState({ sessions: [session("b")], activeSessionId: "b" });
    f.pushData({ id: "a", sequence: 1, data: "ignored" });
    expect(f.written).toEqual([]);
    // And the tab that is gone is not the one still on screen.
    expect(f.model.selected).toBe("b");
    stop();
  });

  it("follows the session list: stdin, selection and what the shell is told", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.model.attach("a", f.sink);
    await f.settle();
    expect(f.interactive).toEqual([true]);
    // An exited shell keeps its screen but stops accepting keystrokes.
    f.pushState({ sessions: [session("a", { status: "exited", exitCode: 0 })], activeSessionId: "a" });
    expect(f.interactive.at(-1)).toBe(false);
    f.model.write("a", "echo being\r");
    await f.settle();
    expect(f.calls.filter(call => call.name === "write")).toEqual([]);
    // And a live one does.
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.model.write("a", "echo being\r");
    await f.settle();
    expect(f.calls.at(-1)).toEqual({ name: "write", value: { id: "a", data: "echo being\r" } });
    stop();
  });

  it("selecting a tab tells the main process, and only when it is not already active", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a"), session("b")], activeSessionId: "a" });
    f.model.select("a");
    await f.settle();
    expect(f.calls.filter(call => call.name === "activate")).toEqual([]);
    f.model.select("b");
    await f.settle();
    expect(f.calls.at(-1)).toEqual({ name: "activate", value: "b" });
    // A tab that does not exist is not a selection at all.
    f.model.select("gone");
    expect(f.model.selected).toBe("b");
    stop();
  });

  it("sends a size only when it changed, and never one xterm cannot mean", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.model.resize("a", 120, 40);
    f.model.resize("a", 120, 40);
    await f.settle();
    expect(f.calls.filter(call => call.name === "resize")).toEqual([{ name: "resize", value: { id: "a", cols: 120, rows: 40 } }]);
    // terminal-panel.js line 74: a fit taken mid-layout can report 1x0, which the
    // shell would refuse anyway; not sending it keeps the refusal off the screen.
    f.model.resize("a", 1, 40);
    f.model.resize("a", 120, 0);
    await f.settle();
    expect(f.calls.filter(call => call.name === "resize")).toHaveLength(1);
    stop();
  });

  it("answers a reveal with what the panel measured, once", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a"), session("b")], activeSessionId: "a" });
    f.model.select("b");
    f.pushReveal("a");
    // Opened and selected for the panel; the answer is the panel's to give,
    // because only it can see whether this element has an area.
    expect([f.model.open, f.model.selected, f.model.pendingReveal]).toEqual([true, "a", "a"]);
    f.model.confirmReveal("a", true);
    await f.settle();
    expect(f.calls.at(-1)).toEqual({ name: "revealed", value: { id: "a", shown: true } });
    expect(f.model.pendingReveal).toBe("");
    // A second answer for the same request is not sent: the main process has one
    // waiter, and a duplicate would resolve whatever it asks next.
    f.model.confirmReveal("a", false);
    await f.settle();
    expect(f.calls.filter(call => call.name === "revealed")).toHaveLength(1);
    stop();
  });

  it("closing the panel abandons a reveal, and stopping unsubscribes everything", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.pushReveal("a");
    f.model.hide();
    // Nothing is answered: the main process's two-second deadline is what turns
    // a closed panel into「面板尚未展示」, and answering false here would only
    // race it.
    expect([f.model.open, f.model.pendingReveal]).toEqual([false, ""]);
    expect(f.calls.filter(call => call.name === "revealed")).toEqual([]);
    stop();
    expect([f.listeners.state, f.listeners.data, f.listeners.reveal].map(list => list.length)).toEqual([0, 0, 0]);
  });

  it("a failed read is reported and does not leave the view stuck replaying", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    // What a session that ended between the push and the read produces.
    f.failRead(new Error("终端会话不存在。"));
    f.model.attach("a", f.sink);
    await f.settle();
    expect((f.toasted[0] as Error).message).toBe("终端会话不存在。");

    // Not stuck: the next gap re-reads, and a successful read puts the view back
    // on the live stream.
    f.failRead(null);
    f.setReplay({ id: "a", sequence: 4, data: "one\r\ntwo\r\nthree\r\nfour\r\n", truncated: false });
    f.pushData({ id: "a", sequence: 4, data: "four\r\n" });
    await f.settle();
    expect(f.written).toEqual([RESET, "one\r\ntwo\r\nthree\r\nfour\r\n"]);
    stop();
  });

  it("a gap the retained buffer cannot close costs output, not an endless re-read", async () => {
    const f = fixture();
    const stop = f.model.start();
    f.pushState({ sessions: [session("a")], activeSessionId: "a" });
    f.setReplay({ id: "a", sequence: 0, data: "", truncated: false });
    f.model.attach("a", f.sink);
    await f.settle();
    f.written.length = 0;
    f.calls.length = 0;

    // A state the main process cannot produce — it appends before it emits — but
    // one a re-read can never resolve either. BeingDesktop would re-read forever;
    // this takes the loss and shows the newest chunk (see `replay`).
    f.pushData({ id: "a", sequence: 9, data: "newest\r\n" });
    await f.settle();
    expect(f.calls.filter(call => call.name === "read")).toHaveLength(1);
    expect(f.written).toEqual([RESET, "newest\r\n"]);
    // And the cursor is where that chunk left it, so the stream continues.
    f.pushData({ id: "a", sequence: 10, data: "after\r\n" });
    expect(f.written.at(-1)).toBe("after\r\n");
    stop();
  });
});
