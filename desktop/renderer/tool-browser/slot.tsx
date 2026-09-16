// Where the tool browser attaches to the shell; 2026-09-16.
// Two appended lines in app/slots.tsx and app/models/registry.ts point here.
import { ToolBrowserPanel } from "./components/panel";
import type { PanelSlot, TopbarSlot } from "../app/slots";
import "./styles.css";

export const toolBrowserPanelSlot: PanelSlot = {
  key: "tool-browser",
  title: "工具浏览器",
  order: 200,
  visible: app => Boolean(app.features.toolBrowser?.open),
  Panel: ({ app }) => <ToolBrowserPanel model={app.features.toolBrowser} />,
};

/** The only way a person opens the tool browser. */
export const toolBrowserTopbarSlot: TopbarSlot = {
  key: "tool-browser",
  order: 200,
  Action: ({ app }) => {
    const model = app.features.toolBrowser;
    if (!model) return null;
    return (
      <button
        type="button"
        className="topbar-icon-button"
        aria-label="Being 工具浏览器"
        title="Being 工具浏览器"
        aria-pressed={model.open}
        onClick={() => model.toggle()}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 0c2 2 3 4.5 3 7.5s-1 5.5-3 7.5m0-15c-2 2-3 4.5-3 7.5s1 5.5 3 7.5M2.9 7.5h14.2M2.9 12.5h14.2" /></svg>
      </button>
    );
  },
};
