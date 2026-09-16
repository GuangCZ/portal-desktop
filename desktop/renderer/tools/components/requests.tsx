// The approval queue, ported from BeingDesktop 0.8.26 renderer/desktop-tools.js
// `renderRequests()` on 2026-09-16.
//
// THE POINT OF THE WHOLE PANEL. A Being's browser and console calls do not run
// when they arrive; they wait here until someone presses「允许本次」, once, for
// that one call. So the card shows what the call would actually touch — the page,
// the working directory, the named console jobs — and the arguments in full,
// rather than a verb and a tool name.
//
// The buttons are disabled while a card is `running`: the decision has been made
// and the call is in flight, and a second press would be a second decision on a
// request the queue no longer holds.
import type { ToolsModel } from "../models/tools";
export function ToolsRequests({ model }: { model: ToolsModel }) {
  return (
    <div className="tools-requests" id="tools-requests" aria-label="Being 待确认调用">
      {model.state.requests.map((request) => (
        <article className="tools-request" key={request.id} data-request={request.id}>
          <strong>Being 请求：{model.label(request.name)}</strong>
          <pre>{model.summary(request)}</pre>
          <div className="tools-request-actions">
            <button
              type="button"
              className="button secondary small-button"
              data-request-action={`${request.id}:deny`}
              disabled={request.status !== "pending"}
              onClick={() => void model.act({ action: "request.deny", value: request.id })}
            >
              拒绝
            </button>
            <button
              type="button"
              className="button primary small-button"
              data-request-action={`${request.id}:allow`}
              disabled={request.status !== "pending"}
              onClick={() => void model.act({ action: "request.allow", value: request.id })}
            >
              {request.status === "running" ? "正在执行…" : "允许本次"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
