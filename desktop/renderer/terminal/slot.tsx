// Where the terminal attaches to the shell; 2026-09-16.
//
// Two appended lines in app/slots.tsx and app/models/registry.ts point here, and
// nothing else in the shell knows this feature exists. `visible` is the model's
// own `open` flag: the panel decides when it is on screen, the shell only mounts
// it (app/slots.tsx).
import { TerminalPanel } from "./components/panel";
import type { PanelSlot, TopbarSlot } from "../app/slots";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

export const terminalPanelSlot: PanelSlot = {
  key: "terminal",
  title: "终端",
  order: 300,
  visible: app => Boolean(app.features.terminal?.open),
  Panel: ({ app }) => <TerminalPanel model={app.features.terminal} />,
};

/** The only way a person opens the terminal. Without it the panel could be
 * brought up only by a Being calling `desktop_terminal_open` through the tool
 * bridge, which is not an entry point a user has. */
export const terminalTopbarSlot: TopbarSlot = {
  key: "terminal",
  order: 300,
  Action: ({ app }) => {
    const model = app.features.terminal;
    if (!model) return null;
    return (
      <button
        type="button"
        className="topbar-icon-button"
        aria-label="终端"
        title="终端"
        aria-pressed={model.open}
        onClick={() => model.toggle()}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 5 5 5-5 5m7 0h5" /></svg>
      </button>
    );
  },
};
