// Where the tool bridge attaches to the shell; 2026-09-16.
//
// Three exports, each one line in a shared file (desktop/renderer/app/slots.tsx
// and app/models/registry.ts):
//
//  · `toolsModel`   — the model factory, built with `AppModel` and started with it.
//  · `toolsPanel`   — the dockable panel, mounted while it is open.
//  · `toolsAction`  — the topbar control that opens it.
//
// DEVIATION from integration plan §3.2, which lists「PANEL_SLOTS 一项」only. A
// panel whose own predicate is「while it is open」and which nothing can open is
// unreachable: BeingDesktop's two entry points (`#open-browser` and
// `#open-console`, renderer/index.html) live in the toolbar, not in the panel.
// This unit therefore appends one topbar entry as well — still one line, still
// append-only. See docs/migration/i2-tools.md「决定与偏差」.
import type { DesktopAPI } from "../../shared/types";
import type { AppModel } from "../app/models/app";
// Type-only, and therefore not a cycle at runtime even though `slots.tsx` imports
// the values below: the import is erased, and the value edge runs one way.
import type { PanelSlot, TopbarSlot } from "../app/slots";
import type { FeatureModelFactory } from "../app/models/registry";
import { ToolsModel } from "./models/tools";
import { ToolsPanel } from "./components/panel";
import "./styles.css";

export const toolsModel: FeatureModelFactory = {
  key: "tools",
  create: (api: DesktopAPI) => new ToolsModel(api),
};

export const toolsPanel: PanelSlot = {
  key: "tools",
  title: "浏览器和控制台",
  order: 100,
  Panel: ToolsPanel,
  // The panel unmounts when it is closed rather than hiding: its native browser
  // view is detached by the same act, and a hidden panel would keep reporting a
  // rectangle for a view nobody can see.
  visible: (app: AppModel) => Boolean((app.features.tools as ToolsModel | undefined)?.open),
};

export const toolsAction: TopbarSlot = {
  key: "tools",
  order: 100,
  Action: ToolsToggle,
};

/** 0.8.26 has two toolbar buttons, one per pane, each of which also closes the
 * panel when its own pane is already showing. One control does the same job here
 * — the two modes are one click apart inside the panel — and carries the pending
 * count, which is the whole reason the toolbar needs to say anything at all. */
function ToolsToggle({ app }: { app: AppModel }) {
  // `AppFeatureModels` says this is always there, and at runtime it is not:
  // `AppModel`'s constructor catches a factory that throws and leaves the key
  // unset (desktop/renderer/app/models/app.ts). The shell must still draw.
  const model = app.features.tools as ToolsModel | undefined;
  if (!model) return null;
  const pending = model.pendingCount;
  const running = model.activeJobCount;
  return (
    <button
      type="button"
      className={`icon-button${model.open ? " active" : ""}`}
      id="open-tools"
      aria-pressed={model.open}
      aria-label="浏览器和控制台"
      title={pending ? `${pending} 个 Being 调用待确认` : `浏览器和控制台${running ? ` · ${running} 个命令运行中` : ""}`}
      onClick={() => model.toggle(model.mode)}
    >
      ⌘
      {(pending || running) > 0 && (
        <span className="tools-pending-count" id="open-tools-count">
          {pending ? String(pending) : `${running} 运行`}
        </span>
      )}
    </button>
  );
}
