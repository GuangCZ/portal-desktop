// The terminal panel: the dockable surface the shell mounts through
// PANEL_SLOTS. Ported from BeingDesktop 0.8.26 renderer/terminal-panel.js
// (`init`, `renderStage`, `show`, `reveal`) on 2026-09-16.
//
// Two things here are protocol rather than decoration:
//
//  · Every session keeps its xterm mounted, hidden, for as long as the session
//    exists. Unmounting would drop the replay cursor and the scrollback, and the
//    next `read` would repaint the whole 1 MiB buffer.
//  · A reveal request from the main process (`beings:terminal-reveal`) is
//    answered here, after layout, with what this element actually measures —
//    0.8.26 checked `host.getBoundingClientRect()` was non-empty before
//    answering true, and `DesktopTools.showTerminal` turns a false into
//    「终端已创建，但面板尚未展示…」. The main process gives up after two seconds,
//    so a panel that is not mounted refuses by saying nothing at all.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useModel } from "../../shared/hooks/use-model";
import { TerminalStage } from "./stage";
import { TerminalTabs } from "./tabs";
import type { TerminalModel } from "../models/terminal";

export function TerminalPanel({ model }: { model: TerminalModel }) {
  const terminal = useModel(model);
  const host = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(0);
  const { pendingReveal, selected } = terminal;

  // After layout, and only then: the element has to have been painted for its
  // rectangle to mean anything.
  useLayoutEffect(() => {
    if (!pendingReveal) return;
    const frame = requestAnimationFrame(() => {
      const rect = host.current?.getBoundingClientRect();
      terminal.confirmReveal(pendingReveal, Boolean(rect && rect.width > 0 && rect.height > 0 && selected === pendingReveal));
    });
    return () => cancelAnimationFrame(frame);
  }, [terminal, pendingReveal, selected]);

  // 0.8.26 `show()` (line 152): opening an empty panel starts a session, so the
  // user sees a prompt rather than an empty stage with a button.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || terminal.sessions.length || terminal.creating || terminal.unavailable) return;
    opened.current = true;
    void terminal.create();
  }, [terminal]);

  return (
    <aside id="terminal-panel" className="terminal-panel" ref={host} aria-label="终端">
      <div className="terminal-toolbar">
        <TerminalTabs model={terminal} />
        <div className="terminal-toolbar-actions">
          <button
            type="button"
            className="terminal-icon-button"
            title={terminal.creating ? "正在启动 终端…" : "新建 交互终端"}
            aria-label="新建 交互终端"
            disabled={terminal.creating}
            onClick={() => void terminal.create()}
          >
            +
          </button>
          <button
            type="button"
            className="terminal-icon-button"
            title="收起终端"
            aria-label="收起终端"
            onClick={() => terminal.hide()}
          >
            ×
          </button>
        </div>
      </div>
      <div className={`terminal-stage${terminal.active ? "" : " terminal-panel-empty"}`}>
        {terminal.sessions.map(session => (
          <TerminalStage
            key={session.id}
            model={terminal}
            id={session.id}
            active={session.id === terminal.selected}
            zoom={zoom}
            onZoom={next => setZoom(current => (next === 0 ? 0 : Math.max(-6, Math.min(20, current + next))))}
          />
        ))}
        <div className="terminal-empty" hidden={Boolean(terminal.active)}>
          <p role="status">{terminal.unavailable || "还没有打开的终端。"}</p>
          <button
            type="button"
            className="terminal-open-button secondary"
            disabled={terminal.creating}
            onClick={() => void terminal.create()}
          >
            打开终端
          </button>
        </div>
      </div>
    </aside>
  );
}
