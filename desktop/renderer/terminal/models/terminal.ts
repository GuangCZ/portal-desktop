// The terminal panel's state, ported from BeingDesktop 0.8.26
// renderer/terminal-panel.js on 2026-09-16.
//
// Everything that is not xterm lives here: the session list, which tab is
// selected, and — the part worth porting carefully — the replay/live protocol
// between `readTerminal` and `being:terminal-data`.
//
// THE SEQUENCE PROTOCOL (terminal-panel.js `replay` / `receive`, lines 79-100).
// `read` and the data events share one counter. A view therefore subscribes
// first, then replays, then drops every event at or below the replay's sequence.
// Three cases, all measured in 0.8.26 and reproduced here:
//   · `sequence <= seen`      already written, drop it;
//   · `sequence === seen + 1` the next chunk, write it;
//   · `sequence >  seen + 1`  a gap — the retained buffer rolled over or an event
//                             was lost, so queue it and replay from scratch.
// A replay that is overtaken by a newer one is abandoned by generation, so a slow
// answer can never overwrite a fresh screen.
//
// xterm itself is not imported: the model hands each session's output to a sink
// the component registers (`attach`). That keeps the protocol testable — vitest
// runs without a DOM — and keeps the model free of React and of the terminal
// library, which tests/architecture.test.ts requires of everything under models/.
import { Store, errorText } from "../../shared/models/store";
import type {
  TerminalData, TerminalReplay, TerminalSession, TerminalState,
} from "../../../shared/desktop-types";
import type { DesktopAPI } from "../../../shared/types";
import type { FeatureModelFactory } from "../../app/models/registry";

/** What a mounted xterm instance offers the model. */
export interface TerminalSink {
  /** Clear the screen before a replay. */
  reset(): void;
  write(data: string): void;
  /** Whether stdin is accepted; follows the session's status. */
  setInteractive(interactive: boolean): void;
}

const LIVE = ["running", "starting"];
/** 0.8.26 writes this dim line before a truncated replay (terminal-panel.js:85). */
const TRUNCATED = "\x1b[90m[较早的终端输出已截断]\x1b[0m\r\n";

interface TerminalView {
  sink: TerminalSink;
  sequence: number;
  replaying: boolean;
  pending: TerminalData[];
  generation: number;
}

export interface TerminalHost {
  toast(error: unknown): void;
}

export class TerminalModel extends Store {
  sessions: TerminalSession[] = [];
  activeSessionId: string | null = null;
  /** The tab on screen. Kept apart from `activeSessionId`, which is the main
   * process's idea of the active session: selecting a tab tells it, and a reveal
   * from the tool bridge tells us. */
  selected = "";
  /** Whether the panel is on screen. The shell mounts the panel through
   * `visible()` in slots.tsx, so this is the single source of that answer. */
  open = false;
  creating = false;
  /** The terminal refused to start at all — no pty module, or an unsupported
   * platform. Its message is 0.8.26's, arriving from the main process. */
  unavailable = "";
  /** A reveal the main process is waiting on. The component answers it after
   * layout, because only it can see whether the panel really has an area. */
  pendingReveal = "";
  private lifecycle = 0;
  private readonly views = new Map<string, TerminalView>();
  /** One chain per session, so keystrokes reach the shell in the order typed. */
  private readonly writes = new Map<string, Promise<unknown>>();
  /** The last size reported per session, so an unchanged fit sends nothing. */
  private readonly sizes = new Map<string, string>();

  constructor(private readonly api: DesktopAPI, private readonly host: TerminalHost) {
    super();
  }

  /** Opened from `AppModel.start()`; the returned function closes it again
   * (renderer/app/models/registry.ts). */
  start(): () => void {
    const revision = ++this.lifecycle;
    // Subscribe before reading, and let a push that arrives first win. The main
    // process only sends on a change, so a snapshot that was true when the read
    // was issued can be stale by the time it answers — and accepting it would
    // drop the sessions the push just announced. Same shape as the shell
    // browser's panel (renderer/browser/page.tsx).
    let received = false;
    const stops = [
      this.api.terminal.onState(state => { if (revision !== this.lifecycle) return; received = true; this.accept(state); }),
      this.api.terminal.onData(event => { if (revision === this.lifecycle) this.receive(event); }),
      this.api.terminal.onReveal(({ id }) => { if (revision === this.lifecycle) this.reveal(id); }),
    ];
    void this.api.terminal
      .state()
      .then(state => { if (revision === this.lifecycle && !received) this.accept(state); })
      .catch(error => { if (revision === this.lifecycle) this.unavailable = errorText(error); this.changed(); });
    return () => {
      this.lifecycle++;
      for (const stop of stops) stop();
      this.views.clear();
      this.open = false;
      this.pendingReveal = "";
    };
  }

  session(id: string): TerminalSession | undefined {
    return this.sessions.find(item => item.id === id);
  }

  get active(): TerminalSession | undefined {
    return this.session(this.selected);
  }

  private interactive(id: string): boolean {
    return LIVE.includes(this.session(id)?.status || "");
  }

  /** A mounted xterm instance claims a session. Returns the detach function. */
  attach(id: string, sink: TerminalSink): () => void {
    const view: TerminalView = { sink, sequence: 0, replaying: false, pending: [], generation: 0 };
    this.views.set(id, view);
    sink.setInteractive(this.interactive(id));
    void this.replay(id);
    return () => { if (this.views.get(id) === view) this.views.delete(id); };
  }

  /** A new snapshot from the main process. */
  accept(state: TerminalState): void {
    if (!state || !Array.isArray(state.sessions)) return;
    this.sessions = state.sessions;
    this.activeSessionId = state.activeSessionId;
    const ids = new Set(this.sessions.map(item => item.id));
    for (const id of [...this.views.keys()]) if (!ids.has(id)) this.views.delete(id);
    for (const [id, view] of this.views) view.sink.setInteractive(this.interactive(id));
    // 0.8.26: fall back to the main process's active session, then to whatever
    // is left, so closing the last tab never leaves an empty stage with sessions.
    if (!ids.has(this.selected)) this.selected = state.activeSessionId && ids.has(state.activeSessionId) ? state.activeSessionId : this.sessions[0]?.id || "";
    this.changed();
  }

  /** One PTY chunk. */
  receive(event: TerminalData): void {
    if (!event || typeof event.data !== "string") return;
    const view = this.views.get(event.id);
    if (!view) return;
    if (view.replaying) { view.pending.push(event); return; }
    if (event.sequence <= view.sequence) return;
    if (event.sequence > view.sequence + 1) {
      // A gap. Queue it and re-read: the retained buffer is the authority.
      view.pending.push(event);
      void this.replay(event.id, true);
      return;
    }
    view.sequence = event.sequence;
    view.sink.write(event.data);
  }

  /** `recovering` marks the read a gap asked for. See the bottom of this method:
   * it is the difference between one re-read and an unbounded loop. */
  private async replay(id: string, recovering = false): Promise<void> {
    const view = this.views.get(id);
    if (!view) return;
    const generation = ++view.generation;
    const revision = this.lifecycle;
    view.replaying = true;
    let snapshot: TerminalReplay;
    try {
      snapshot = await this.api.terminal.read(id);
    } catch (error) {
      if (this.views.get(id) === view && generation === view.generation) {
        view.replaying = false;
        this.host.toast(error);
      }
      return;
    }
    if (this.views.get(id) !== view || generation !== view.generation || revision !== this.lifecycle) return;
    view.sink.reset();
    view.sequence = Number(snapshot.sequence) || 0;
    if (snapshot.truncated) view.sink.write(TRUNCATED);
    if (snapshot.data) view.sink.write(snapshot.data);
    const queued = view.pending;
    view.pending = [];
    view.replaying = false;
    for (const event of queued.sort((a, b) => a.sequence - b.sequence)) {
      // DEVIATION from BeingDesktop, and the only one in this protocol. 0.8.26
      // re-delivers the queue unconditionally (terminal-panel.js line 90), so an
      // event still ahead of the freshly read cursor calls `replay` again, which
      // re-delivers it, which calls `replay` again — forever. It never fired in
      // 0.8.26 because the main process appends to the retained buffer BEFORE it
      // emits (tools/terminal/terminal.ts `append`), so a read always answers at
      // or past every event already sent. If that invariant ever breaks, a
      // request storm is a worse failure than a gap: the buffer has just told us
      // it does not hold the missing chunks, and reading it again cannot produce
      // them. Take the loss, keep the newest output, and stop asking.
      if (recovering && event.sequence > view.sequence + 1) view.sequence = event.sequence - 1;
      this.receive(event);
    }
  }

  show(): void {
    this.open = true;
    this.changed();
  }

  hide(): void {
    this.open = false;
    this.pendingReveal = "";
    this.changed();
  }

  toggle(open = !this.open): void {
    if (open) this.show(); else this.hide();
  }

  /** The main process wants this session on screen and is waiting two seconds
   * for an answer (main/tools/terminal/ipc.ts `createRevealGate`). Open, select,
   * and leave the answer to the component: only it can see the panel's area. */
  private reveal(id: string): void {
    if (!id) return;
    this.open = true;
    this.selected = id;
    this.pendingReveal = id;
    this.changed();
  }

  /** The panel answering a reveal, after layout. `shown` is the panel's own
   * measurement — 0.8.26 checked `host.getBoundingClientRect()` was non-empty
   * (terminal-panel.js line 158). */
  confirmReveal(id: string, shown: boolean): void {
    if (this.pendingReveal !== id) return;
    this.pendingReveal = "";
    this.changed();
    void this.api.terminal.revealed({ id, shown }).catch(() => { /* A late answer is ignored by design. */ });
  }

  select(id: string): void {
    if (!this.session(id)) return;
    this.selected = id;
    this.changed();
    if (this.activeSessionId !== id) void this.run(() => this.api.terminal.activate(id));
  }

  async create(): Promise<void> {
    if (this.creating) return;
    this.creating = true;
    this.changed();
    try {
      const state = await this.api.terminal.create({});
      this.accept(state);
      if (state.sessionId) this.selected = state.sessionId;
      this.unavailable = "";
    } catch (error) {
      this.host.toast(error);
    } finally {
      this.creating = false;
      this.changed();
    }
  }

  close(id: string): void {
    void this.run(() => this.api.terminal.close(id));
  }

  /** Keystrokes from xterm. Serialized per session so the shell sees them in the
   * order they were typed (terminal-panel.js `write`, line 64). */
  write(id: string, data: string): void {
    if (!this.interactive(id)) return;
    const queue = this.writes.get(id) ?? Promise.resolve();
    this.writes.set(id, queue
      .then(() => this.api.terminal.write({ id, data }))
      .then(state => { this.accept(state); }, error => { this.host.toast(error); }));
  }

  /** xterm measured a new size. 0.8.26 refuses anything smaller than 2x1 and
   * sends only when it actually changed (terminal-panel.js `resize`, line 73). */
  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1 || !this.interactive(id)) return;
    const size = `${cols}:${rows}`;
    if (this.sizes.get(id) === size) return;
    this.sizes.set(id, size);
    void this.api.terminal.resize({ id, cols, rows }).then(
      state => { this.accept(state); },
      error => { this.sizes.delete(id); this.host.toast(error); },
    );
  }

  private async run(operation: () => Promise<TerminalState>): Promise<void> {
    try { this.accept(await operation()); }
    catch (error) { this.host.toast(error); }
  }
}

declare module "../../app/models/registry" {
  interface AppFeatureModels { terminal: TerminalModel }
}

/** The registry entry (app/models/registry.ts). It lives beside the model rather
 * than beside the panel so `registry.ts` — which `AppModel` imports — never pulls
 * a React component into the model graph. */
export const terminalModelFactory: FeatureModelFactory = {
  key: "terminal",
  // `app` arrives as `unknown` (registry.ts): take only what is needed, through a
  // structural type, and read nothing from it during construction.
  create: (api: DesktopAPI, app: unknown) => new TerminalModel(api, app as TerminalHost),
};
