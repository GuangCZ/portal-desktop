// The terminal panel's tab strip, ported from BeingDesktop 0.8.26
// renderer/terminal-panel.js `renderTabs` (lines 102-130) on 2026-09-16.
//
// Kept as its own component because the rules it carries are not obvious: the
// tab list is a real ARIA tablist with roving tabindex and arrow/Home/End
// navigation, an exited session stays in the list with its exit code in the
// title, and the close button's label says whether closing will end a running
// shell.
//
// Not ported: the read-only「Being · 命令」tabs. Those mirror `DesktopConsole`
// jobs, which belong to the tool bridge (integration plan §3.2, I2).
import type { TerminalSession } from "../../../shared/desktop-types";
import type { TerminalModel } from "../models/terminal";

const LIVE = ["running", "starting"];

function title(session: TerminalSession): string {
  const running = LIVE.includes(session.status);
  const code = session.exitCode === null || session.exitCode === undefined ? "" : ` (${session.exitCode})`;
  return `${session.title || "终端"}\n${session.cwd}${running ? "" : `\n已退出${code}`}`;
}

export function TerminalTabs({ model }: { model: TerminalModel }) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, at: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const ids = model.sessions.map(session => session.id);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? ids.length - 1
        : (at + (event.key === "ArrowLeft" ? -1 : 1) + ids.length) % ids.length;
    model.select(ids[next]);
    const strip = event.currentTarget.closest(".terminal-tabs");
    (strip?.querySelectorAll<HTMLButtonElement>(".terminal-tab-select")[next])?.focus();
  };
  return (
    <div className="terminal-tabs" role="tablist" aria-label="终端">
      {model.sessions.map((session, at) => {
        const active = model.selected === session.id;
        const running = session.status === "running";
        return (
          <div key={session.id} className={`terminal-tab${active ? " active" : ""}`}>
            <button
              type="button"
              className="terminal-tab-select"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={title(session)}
              onClick={() => model.select(session.id)}
              onKeyDown={event => move(event, at)}
            >
              <span className="terminal-tab-title">{session.title || "终端"}</span>
              {!running && <span className="terminal-tab-ended">已退出</span>}
            </button>
            <button
              type="button"
              className="terminal-icon-button terminal-tab-close"
              title={running ? "关闭并结束 终端会话" : "关闭 交互终端"}
              aria-label={running ? "关闭并结束 终端会话" : "关闭 交互终端"}
              onClick={() => model.close(session.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
