// The interactive terminal's IPC surface. New in the portal-desktop shell on
// 2026-09-16; channel semantics ported from BeingDesktop 0.8.26 src/main.cjs's
// `getTerminalState` / `readTerminal` / `terminalAction` (lines 1102-1116) and
// the two pushes `being:terminal-state` / `being:terminal-data`
// (docs/interfaces.md §1.2「桌面工具、控制台与终端」, §1.3).
//
// Registration follows chat/ipc.ts: every channel goes through the `handle`
// wrapper main.ts supplies, so it inherits the sender check and the quitting
// guard — BeingDesktop's own `if (exitStarted) throw '桌面端正在退出。'` at line
// 1106 is that guard, and is therefore not repeated here.
//
// Arguments arrive from the renderer and are untrusted. Validation is structural
// and refuses rather than coerces: a plain object, no field outside the
// whitelist, declared types only. The MEASURED limits — 8 sessions, 64 KiB per
// write, 2..500 columns, 1..200 rows, the 1 MiB replay buffer — stay inside
// `DesktopTerminal`, which is the one place that owns them and the one place
// tests/tools-terminal-terminal.test.ts pins them.
//
// BeingDesktop answers every action with `snapshot()`. So does this, with one
// addition: `create` also carries the new `sessionId` (see
// desktop/shared/terminal-types.ts `TerminalCreateState`).
import type { DesktopTerminal } from './terminal';
import type {
  TerminalCreateState, TerminalData, TerminalReplay, TerminalRevealResult, TerminalState,
} from '../../../shared/terminal-types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface TerminalIpcOptions {
  handle: RegisterHandler;
  /** Resolved lazily: the terminal may have failed to build, and the subsystem
   * replaces nothing at runtime but must still answer every channel. */
  terminal: () => DesktopTerminal | null;
  /** Why the terminal cannot run at all, when that is not simply "not built yet".
   * Empty means nothing is wrong. */
  blocked?: () => string;
  /** Called when the renderer answers a reveal request. */
  revealed?: (result: TerminalRevealResult) => void;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

/** A plain object whose keys are all known. An unknown field is refused rather
 * than dropped: it means the caller and this contract disagree. */
function fields(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!plain(value)) throw invalid(`${what}参数无效。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${what}参数无效。`);
  return value;
}

function sessionId(value: unknown): string {
  // `DesktopTerminal.requireSession` refuses an unknown id with the same text;
  // this only stops a non-string reaching the Map lookup.
  if (typeof value !== 'string' || !value) throw invalid('终端会话不存在。');
  return value;
}

function optionalNumber(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(what);
  return value;
}

export const TERMINAL_UNAVAILABLE = '交互终端在当前运行环境不可用。';

export function registerTerminalIpc({ handle, terminal, blocked, revealed }: TerminalIpcOptions) {
  const required = (): DesktopTerminal => {
    const current = terminal();
    if (!current) throw new Error(blocked?.() || TERMINAL_UNAVAILABLE);
    return current;
  };
  const idle: TerminalState = { sessions: [], activeSessionId: null };

  handle('beings:terminal', (): TerminalState => terminal()?.snapshot() ?? idle);

  handle('beings:terminal-read', (id: unknown): TerminalReplay => required().read(sessionId(id)));

  // One channel, five actions, exactly as BeingDesktop's `terminalAction`. The
  // unknown-action text is its own (src/main.cjs line 1113) and is asserted.
  handle('beings:terminal-action', async (action: unknown, value: unknown): Promise<TerminalState | TerminalCreateState> => {
    const current = required();
    switch (action) {
      case 'create': {
        const options = fields(value, ['cwd', 'cols', 'rows'], '终端创建');
        if (options.cwd !== undefined && typeof options.cwd !== 'string') throw invalid('终端创建参数无效。');
        const { sessionId: id } = await current.create({
          cwd: options.cwd as string | undefined,
          cols: optionalNumber(options.cols, '终端尺寸无效。'),
          rows: optionalNumber(options.rows, '终端尺寸无效。'),
        });
        return { ...current.snapshot(), sessionId: id };
      }
      case 'write': {
        const options = fields(value, ['id', 'data'], '终端输入');
        // Size is DesktopTerminal's contract (64 KiB, measured in UTF-8 bytes).
        if (typeof options.data !== 'string') throw invalid('终端输入不能超过 64 KiB。');
        current.write({ id: sessionId(options.id), data: options.data });
        break;
      }
      case 'resize': {
        const options = fields(value, ['id', 'cols', 'rows'], '终端尺寸');
        current.resize({
          id: sessionId(options.id),
          cols: optionalNumber(options.cols, '终端尺寸无效。'),
          rows: optionalNumber(options.rows, '终端尺寸无效。'),
        });
        break;
      }
      case 'activate':
        current.activate(sessionId(value));
        break;
      case 'close':
        await current.close(sessionId(value));
        break;
      default:
        throw new Error('未知终端操作。');
    }
    return current.snapshot();
  });

  // The renderer's answer to `beings:terminal-reveal`. It is a plain channel
  // rather than a return value because the request travels the other way: the
  // tool bridge's `desktop_terminal_*` calls wait on this (integration plan §3.3).
  handle('beings:terminal-revealed', (result: unknown): void => {
    const answer = fields(result, ['id', 'shown'], '终端展示');
    if (typeof answer.shown !== 'boolean') throw invalid('终端展示参数无效。');
    revealed?.({ id: sessionId(answer.id), shown: answer.shown });
  });
}

/** The three pushes, given the window to send on. Kept beside the handlers so
 * every channel name of this subsystem lives in one file. */
export interface TerminalPushTarget { send(channel: string, payload: unknown): void }

export function terminalPush(target: () => TerminalPushTarget | null) {
  return {
    state: (payload: TerminalState) => { target()?.send('beings:terminal-state', payload); },
    data: (payload: TerminalData) => { target()?.send('beings:terminal-data', payload); },
    reveal: (id: string) => { target()?.send('beings:terminal-reveal', { id }); },
  };
}

/** How long `reveal` waits for the renderer's answer before giving up.
 *
 * BeingDesktop had no timeout: `executeJavaScript` returned the panel's own
 * boolean and could not hang, because the call ran inside the page. Here the two
 * halves are a push and an invoke, so a renderer that is still starting, is on a
 * different view, or has crashed would leave the tool bridge waiting forever.
 * Two seconds, as specified by integration plan §3.3. */
export const REVEAL_TIMEOUT_MS = 2000;

export interface RevealGate {
  /** Ask the renderer to bring `id` on screen and resolve with what it answers.
   * Resolves `false` on timeout — the caller turns that into BeingDesktop's own
   * message rather than a second error vocabulary. */
  request(id: string): Promise<boolean>;
  /** The renderer answered. Ids nobody is waiting on are ignored: a late answer
   * to a request that already timed out is not an error. */
  settle(result: TerminalRevealResult): void;
  /** The window went away or the client is quitting: nothing will answer. */
  abort(): void;
}

export function createRevealGate(push: (id: string) => void, timeoutMs: number = REVEAL_TIMEOUT_MS): RevealGate {
  const waiting = new Map<string, Set<(shown: boolean) => void>>();
  const finish = (id: string, settle: (shown: boolean) => void, shown: boolean) => {
    const pending = waiting.get(id);
    if (!pending?.delete(settle)) return;
    if (!pending.size) waiting.delete(id);
    settle(shown);
  };
  return {
    request: (id: string) => new Promise<boolean>(resolve => {
      const pending = waiting.get(id) ?? new Set<(shown: boolean) => void>();
      waiting.set(id, pending);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (shown: boolean) => { clearTimeout(timer); resolve(shown); };
      pending.add(settle);
      timer = setTimeout(() => finish(id, settle, false), timeoutMs);
      // A pending timer must not be what keeps the process alive.
      timer.unref?.();
      // The request goes out only once the waiter is in place: the renderer may
      // answer synchronously from inside `send` in a test double.
      push(id);
    }),
    settle: ({ id, shown }: TerminalRevealResult) => {
      for (const settle of [...(waiting.get(id) ?? [])]) finish(id, settle, shown);
    },
    abort: () => {
      for (const [id, pending] of [...waiting]) for (const settle of [...pending]) finish(id, settle, false);
    },
  };
}
