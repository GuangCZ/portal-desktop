// The interactive terminal, as a subsystem; 2026-09-16.
//
// Assembly is BeingDesktop 0.8.26 src/main.cjs lines 1710-1712, line for line:
// one `DesktopTerminal` built with the project workspace, pushing its snapshot on
// every change and every PTY chunk as it arrives. `environment`, `platform` and
// `shellPath` are left at their defaults there and are left at their defaults
// here. Teardown is line 1615: the terminal is disposed before the tool bridge.
//
// The pty factory is NOT registered here yet. `tools/terminal/node-pty.ts` — the
// one file that reaches for the native module — lands in the next commit
// (integration plan §5.8: the channels, the panel and the browser ship first, so
// a platform that cannot build node-pty still gets everything else). Until then
// every `create` fails with BeingDesktop's own message —「无法启动 … 交互终端，
// 请检查终端组件与系统安装。」— which is exactly what a failed
// `require('node-pty')` produced in 0.8.26, and the tool bridge drops
// `desktop_terminal_*` from its catalogue on its own (`DesktopTools`'s
// `toolAllowed` gates on `Boolean(getTerminal())`).
//
// `reveal` replaces BeingDesktop's `showTerminal` (line 1697), which reached into
// the page with `executeJavaScript('window.beingTerminal.reveal(id)')` and threw
// when the panel answered false. There is no such global here, so the two halves
// are a push and an invoke with a two-second deadline; the message on failure is
// 0.8.26's, unchanged.
import { DesktopTerminal } from '../tools/terminal/terminal';
import { createRevealGate, registerTerminalIpc, terminalPush } from '../tools/terminal/ipc';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface TerminalSubsystem extends DesktopSubsystem {
  /** The live terminal, or null when it could not be built. The tool bridge
   * reaches it through the registry — `getTerminal: () => ctx.registry
   * .get('terminal')?.terminal ?? null` — and so do tests. */
  readonly terminal: DesktopTerminal | null;
  /** Bring a session on screen, or refuse. `DesktopTools.showTerminal`. */
  reveal(id: string): Promise<void>;
}

declare module './types' { interface SubsystemMap { 'terminal': TerminalSubsystem } }

export function installTerminalSubsystem(ctx: SubsystemContext): TerminalSubsystem {
  const report = (scope: string, error: unknown) => { try { ctx.onError(scope, error); } catch { /* Reporting a failure must not raise one. */ } };
  // `ctx.push` already applies the destroyed-window guard, so the target is
  // unconditional here; the three channel names stay in tools/terminal/ipc.ts.
  const push = terminalPush(() => ({ send: ctx.push }));
  const gate = createRevealGate(id => push.reveal(id));

  let closed = false;
  let blocked = '';
  let terminal: DesktopTerminal | null = null;
  try {
    terminal = new DesktopTerminal({
      // BeingDesktop's `state.workspace.path`, which this shell keeps as
      // `projectWorkspace` (shared/types.ts `Settings`). Empty means the home
      // directory — `DesktopTerminal.create` does that, as 0.8.26 did.
      //
      // DEVIATION from integration plan §3.3, which suggested
      // `projectWorkspace || workspace`. MEASURED: `settings.workspace` is the
      // PORTAL working directory and defaults to `~/Being Desktop Workspace`
      // (app/settings.ts line 44), a path that is not created until the user
      // saves connection settings. Falling back to it made every terminal on a
      // fresh profile fail with「终端工作目录不存在或无法访问。」, which is what a
      // packaged smoke run showed on 2026-09-16. It is also not the same folder:
      // one is where the engine runs, the other is what the user is working on.
      getWorkspace: () => ctx.store.settings.projectWorkspace || '',
      onChange: snapshot => push.state(snapshot),
      onData: chunk => push.data(chunk),
    });
  } catch (error) {
    // The constructor only reads the platform and the environment, so this is a
    // broken host rather than a broken profile. Say which thing is unavailable.
    blocked = '交互终端暂时无法使用，请重启客户端后重试。';
    report('terminal-construct', error);
  }

  registerTerminalIpc({
    handle: ctx.handle,
    terminal: () => terminal,
    blocked: () => blocked,
    revealed: result => gate.settle(result),
  });

  return {
    key: 'terminal',
    get terminal() { return terminal; },
    async reveal(id: string) {
      const current = terminal;
      if (closed || !current) throw new Error(blocked || '交互终端在当前运行环境不可用。');
      const target = ctx.window();
      if (!target || target.isDestroyed() || target.webContents.isDestroyed()) throw new Error('桌面窗口已关闭。');
      // Refuses an unknown id with「终端会话不存在。」before anything is pushed.
      current.activate(id);
      push.state(current.snapshot());
      const shown = await gate.request(id);
      if (!shown) throw new Error('终端已创建，但面板尚未展示，请用终端列表和显示工具恢复。');
    },
    async quitting() {
      if (closed) return;
      closed = true;
      gate.abort();
      // `dispose()` kills every PTY and waits for each to exit; a session that
      // refuses to end rethrows, which is how BeingDesktop cancels the quit
      // (src/main.cjs line 1616). The subsystem fan-out reports it and carries on,
      // so re-arm: a terminal that could not be closed is still usable.
      try { await terminal?.dispose(); }
      catch (error) { closed = false; throw error; }
    },
  };
}
