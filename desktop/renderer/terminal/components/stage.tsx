// One xterm instance per session, ported from BeingDesktop 0.8.26
// renderer/terminal-panel.js on 2026-09-16 (`createEntry`, `terminalOptions`,
// `typography`, `terminalTheme`, `fit`).
//
// The colours, the sizes and the reduced-motion rule are 0.8.26's, value for
// value — a terminal that renders differently from the one the user had is a
// regression they will notice before any behaviour change. 0.8.26 loaded xterm
// from renderer/vendor and reached it through `window.Terminal`; this shell has
// `@xterm/xterm` as a dependency, so it is imported.
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import type { TerminalModel } from "../models/terminal";

/** terminal-panel.js line 18. `--text-code` is one of three sizes the appearance
 * settings offer; anything else means the stylesheet has not loaded yet, and
 * 0.8.26 falls back to 12 rather than to whatever was parsed. */
export function typography(zoom = 0): { fontFamily: string; fontSize: number; cursorBlink: boolean } {
  const style = getComputedStyle(document.documentElement);
  const size = parseFloat(style.getPropertyValue("--text-code"));
  return {
    fontFamily: style.getPropertyValue("--font-mono").trim()
      || 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: Math.max(8, Math.min(32, ([12, 13, 14].includes(size) ? size : 12) + zoom)),
    cursorBlink: !matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

/** terminal-panel.js lines 19-23. The sixteen ANSI colours are literals there
 * and literals here; only the first three follow the client's theme. */
export function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue("--background").trim() || "#181818";
  const foreground = style.getPropertyValue("--text").trim() || "#dfdfdf";
  const selection = /^#[\da-f]{6}$/i.test(foreground)
    ? `${foreground}33`
    : style.getPropertyValue("--line").trim() || "#ffffff1a";
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: selection, selectionInactiveBackground: selection,
    black: "#181818", red: "#e2777a", green: "#9bbd91", yellow: "#d6bb85",
    blue: "#8aa9d6", magenta: "#ba9bd2", cyan: "#84b8bc", white: "#dfdfdf",
    brightBlack: "#777777", brightRed: "#ee9294", brightGreen: "#b3d2a9", brightYellow: "#e4d0a6",
    brightBlue: "#abc3e6", brightMagenta: "#d0b5e3", brightCyan: "#a2d0d3", brightWhite: "#f1f1f1",
  };
}

/** terminal-panel.js line 32. */
const options = (zoom: number) => ({
  ...typography(zoom), fontWeight: 400 as const, lineHeight: 1.2, letterSpacing: 0,
  cursorStyle: "bar" as const, cursorWidth: 1, scrollback: 5000,
  allowProposedApi: false, allowTransparency: false, convertEol: false,
  disableStdin: false, drawBoldTextInBrightColors: false, minimumContrastRatio: 1,
  theme: terminalTheme(),
});

export function TerminalStage({ model, id, active, zoom, onZoom }: {
  model: TerminalModel;
  id: string;
  active: boolean;
  zoom: number;
  onZoom(next: number): void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fitAddon = useRef<FitAddon>(null);
  // Reading the model from a ref keeps the effect below from re-running — and so
  // from tearing down a live terminal — every time a keystroke changes the store.
  const store = useRef(model);
  store.current = model;
  const zoomTo = useRef(onZoom);
  zoomTo.current = onZoom;

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    const term = new Terminal(options(0));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terminal.current = term;
    fitAddon.current = fit;
    const detach = store.current.attach(id, {
      reset: () => term.reset(),
      write: data => term.write(data),
      setInteractive: interactive => { term.options.disableStdin = !interactive; },
    });
    const typed = term.onData(data => store.current.write(id, data));
    const resized = term.onResize(({ cols, rows }) => store.current.resize(id, cols, rows));
    // terminal-panel.js line 45: copy on Ctrl/Cmd+C when there is a selection,
    // paste on Ctrl/Cmd+V, and Ctrl/Cmd +/-/0 for the font size. Everything else
    // belongs to the shell running inside.
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "c" && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        void navigator.clipboard.writeText(term.getSelection()).catch(() => { /* Denied clipboard access is not the terminal's failure. */ });
        return false;
      }
      if ((modifier && key === "v") || (event.shiftKey && event.key === "Insert")) {
        event.preventDefault();
        void navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => { /* Same. */ });
        return false;
      }
      if (modifier && ["+", "=", "-", "0"].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        zoomTo.current(key === "0" ? 0 : key === "-" ? -1 : 1);
        return false;
      }
      return true;
    });
    return () => {
      detach();
      typed.dispose();
      resized.dispose();
      term.dispose();
      terminal.current = null;
      fitAddon.current = null;
    };
  }, [id]);

  // terminal-panel.js `fit` (line 143): only the visible tab is measured, and a
  // stage narrower than 30px or shorter than 20px is mid-layout, not real.
  useEffect(() => {
    const term = terminal.current;
    const host = mount.current;
    if (!term || !host || !active) return;
    let frame = 0;
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth < 30 || host.clientHeight < 20) return;
        const settings = typography(zoom);
        if (term.options.fontFamily !== settings.fontFamily) term.options.fontFamily = settings.fontFamily;
        if (term.options.fontSize !== settings.fontSize) term.options.fontSize = settings.fontSize;
        if (term.options.cursorBlink !== settings.cursorBlink) term.options.cursorBlink = settings.cursorBlink;
        try { fitAddon.current?.fit(); } catch { /* A detached addon cannot measure; the next frame will. */ }
      });
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(host);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", layout);
    window.addEventListener("resize", layout);
    // The shell's own theme switch (app/models/app.ts `toggleTheme`) rewrites the
    // custom properties on <html>; 0.8.26 listened for `being-theme-change`.
    const observedTheme = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    observedTheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      observedTheme.disconnect();
      motion.removeEventListener("change", layout);
      window.removeEventListener("resize", layout);
    };
  }, [active, zoom]);

  return (
    <div
      className="terminal-session"
      role="tabpanel"
      aria-label="交互终端"
      hidden={!active}
      data-terminal-id={id}
    >
      <div className="terminal-mount" ref={mount} />
    </div>
  );
}
