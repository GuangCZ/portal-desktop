// The tool link's status row, ported from BeingDesktop 0.8.26
// renderer/desktop-tools.js `render()` on 2026-09-16.
//
// It is the only place the user is told what「连接 Being 工具」costs and what
// disconnecting does to commands already running, so both sentences come from the
// model verbatim rather than being shortened here.
import type { ToolsModel } from "../models/tools";
export function ToolsLinkStatus({ model }: { model: ToolsModel }) {
  const status = model.state.link.status;
  return (
    <div id="tools-link-details" className="tools-link-details" hidden={!model.detailsOpen}>
      <div className="tools-link-row">
        <span>
          <i className="status-dot" id="tools-link-dot" data-state={status} />
          <span id="tools-link-status">{model.linkLabel}</span>
        </span>
        <button
          type="button"
          className="text-button"
          id="tools-link-toggle"
          disabled={model.linkBusy}
          onClick={() => void model.toggleLink()}
        >
          {status === "connected" || status === "connecting" ? "断开" : "连接 Being 工具"}
        </button>
      </div>
      <p className="tools-link-hint" id="tools-link-hint">
        {model.linkHint}
      </p>
    </div>
  );
}
