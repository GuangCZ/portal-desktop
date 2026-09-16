// The tool panel, ported from BeingDesktop 0.8.26 renderer/index.html's
// `#desktop-tools` aside and renderer/desktop-tools.js on 2026-09-16.
//
// It docks beside the conversation in the workspace body, the same region the
// shell's own browser uses, and carries four things: the two mode tabs, the link
// status block, the approval queue, and whichever pane is selected. The width is
// draggable and the whole panel expands over the conversation with「展开」.
//
// The divider follows the shell's `#browser-divider` conventions — pointer
// capture, Arrow keys, double-click to reset — rather than 0.8.26's, because the
// user meets both in the same window and one of them should not behave
// differently. The measured rule it keeps from 0.8.26 is the one that matters for
// the native view: while a pointer is dragging, the view is hidden
// (`model.setResizing`), or it lags a frame behind the panel's own edge.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppModel } from "../../app/models/app";
import { ToolsBrowserBar } from "./browser-bar";
import { ToolsConsole } from "./console";
import { ToolsLinkStatus } from "./link-status";
import { ToolsRequests } from "./requests";

const STORAGE_KEY = "beings:tools-width";
const DEFAULT_RATIO = 0.45;
/** 0.8.26 clamps the panel to at least 380px and leaves the conversation at
 * least 285px (renderer/desktop-tools.js `setWidth`). */
const MIN_PANEL = 380;
const MIN_REST = 285;

export function ToolsPanel({ app }: { app: AppModel }) {
  // Mounted only while `toolsPanel.visible` said there is one (../slot.tsx), so
  // this does not repeat that guard.
  const model = app.features.tools;
  const panel = useRef<HTMLElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | undefined>(undefined);
  const ratio = useRef(DEFAULT_RATIO);
  const [width, setWidth] = useState("");

  const limits = useCallback(() => {
    const total = panel.current?.parentElement?.getBoundingClientRect().width || 0;
    const min = Math.min(MIN_PANEL, total / 2);
    return { total, min, max: Math.max(min, total - MIN_REST) };
  }, []);

  const apply = useCallback(
    (next?: number) => {
      const { total, min, max } = limits();
      if (!total) return;
      const value = Math.max(min, Math.min(max, next ?? total * ratio.current));
      if (next !== undefined) ratio.current = value / total;
      setWidth(`${Math.round(value)}px`);
    },
    [limits],
  );

  const finish = useCallback(() => {
    if (pointer.current === undefined) return;
    const id = pointer.current;
    pointer.current = undefined;
    if (divider.current?.hasPointerCapture(id)) divider.current.releasePointerCapture(id);
    model.setResizing(false);
    try {
      localStorage.setItem(STORAGE_KEY, String(ratio.current));
    } catch {
      /* Optional preference. */
    }
  }, [model]);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      if (saved > 0 && saved < 1) ratio.current = saved;
    } catch {
      /* Default ratio. */
    }
    apply();
    const observer = new ResizeObserver(() => apply());
    if (panel.current?.parentElement) observer.observe(panel.current.parentElement);
    window.addEventListener("blur", finish);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", finish);
      finish();
    };
  }, [apply, finish]);

  const mode = (next: "browser" | "console") => ({
    role: "tab" as const,
    "aria-selected": model.mode === next,
    "aria-controls": `tools-${next}-pane`,
    onClick: () => void model.show(next),
  });

  return (
    <>
      <div
        id="tools-resizer"
        className="tools-resizer"
        ref={divider}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="调整工具面板宽度"
        aria-controls="desktop-tools"
        hidden={model.full}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointer.current !== undefined || model.full) return;
          event.preventDefault();
          event.currentTarget.focus();
          pointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          model.setResizing(true);
        }}
        onPointerMove={(event) => {
          if (event.pointerId === pointer.current && panel.current) apply(panel.current.getBoundingClientRect().right - event.clientX);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={() => {
          ratio.current = DEFAULT_RATIO;
          apply();
        }}
        onKeyDown={(event) => {
          const current = panel.current?.getBoundingClientRect().width || 0;
          const { min, max } = limits();
          const step = event.shiftKey ? 60 : 20;
          const next =
            event.key === "ArrowLeft"
              ? current + step
              : event.key === "ArrowRight"
                ? current - step
                : event.key === "Home"
                  ? min
                  : event.key === "End"
                    ? max
                    : undefined;
          if (next !== undefined) {
            event.preventDefault();
            apply(next);
          }
        }}
      />
      <aside
        id="desktop-tools"
        className={`desktop-tools${model.full ? " tools-full" : ""}${model.mode === "console" ? " console-mode" : ""}`}
        ref={panel}
        aria-label="浏览器和控制台"
        style={{ flexBasis: model.full ? "100%" : width || undefined }}
      >
        <header className="tools-heading">
          <div className="tools-modes" role="tablist" aria-label="桌面工具">
            <button type="button" id="tools-browser-mode" {...mode("browser")}>
              浏览器
            </button>
            <button type="button" id="tools-console-mode" {...mode("console")}>
              控制台
              {model.pendingCount > 0 && (
                <span className="tools-pending-count" id="tools-pending-count">
                  {model.pendingCount}
                </span>
              )}
            </button>
          </div>
          <button
            type="button"
            className="icon-button compact"
            id="tools-connection"
            aria-label="Being 工具连接"
            title={model.linkLabel}
            data-state={model.state.link.status}
            aria-expanded={model.detailsOpen}
            onClick={() => model.toggleDetails()}
          >
            ⚯
          </button>
          <button
            type="button"
            className="icon-button compact"
            id="tools-expand"
            aria-label={model.full ? "与对话并排" : "展开工具面板"}
            onClick={() => model.toggleFull()}
          >
            {model.full ? "▣" : "▢"}
          </button>
          <button type="button" className="icon-button compact" id="tools-close" aria-label="收起工具面板" onClick={() => model.hide()}>
            ×
          </button>
        </header>
        <ToolsLinkStatus model={model} />
        <ToolsRequests model={model} />
        <p className="tools-error" id="tools-error" role="alert" hidden={!model.error}>
          {model.error}
        </p>
        <ToolsBrowserBar model={model} />
        <ToolsConsole model={model} />
      </aside>
    </>
  );
}
