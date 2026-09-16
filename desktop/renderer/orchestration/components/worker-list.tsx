// The orchestration panel: the mode editor, the worker list, and one worker's
// detail; 2026-09-16. BeingDesktop 0.8.26 splits these across a settings section
// (`settings-panel-orchestration`) and a page (`page-workers`); here they share
// one dockable panel, because the panel is what an integration unit may mount
// (integration plan §2.4) — see the slot file for why not a place sheet.
import { AgentSettings } from "./agent-settings";
import { WorkerDetail } from "./worker-detail";
import { REVIEW_STATUS, WORKER_STATUS, isActive } from "../models/workers";
import type { OrchestrationModel } from "../models/workers";

export function OrchestrationPanel({ model }: { model: OrchestrationModel }) {
  const workers = model.snapshot.workers;
  return (
    <aside className="orchestration-panel" aria-label="编排与 Worker">
      <header className="orchestration-panel-head">
        <h2>编排</h2>
        <button type="button" className="secondary" aria-expanded={model.settingsOpen}
          onClick={() => model.showSettings(!model.settingsOpen)}>
          {model.settingsOpen ? "收起设置" : "编排设置"}
        </button>
        <button type="button" className="icon-button close" aria-label="关闭编排面板" title="关闭编排面板"
          onClick={() => model.show(false)} />
      </header>
      {model.settingsOpen && <AgentSettings model={model} />}
      {model.selected ? <WorkerDetail model={model} /> : (
        <div className="worker-list">
          {model.detailError && <p className="worker-error">{model.detailError}</p>}
          {workers.map(worker => (
            <button type="button" key={worker.id} className="worker-shortcut" data-status={worker.status}
              title={`${worker.title}\n${worker.detail}`} onClick={() => void model.select(worker.id)}>
              <span className="worker-dot" aria-hidden="true" />
              <span className="worker-shortcut-label">
                <span className="worker-title">{worker.title}</span>
                <small className="worker-caption">
                  {`${worker.agentId} · ${WORKER_STATUS[worker.status] || worker.status}`}
                  {worker.review ? ` · ${REVIEW_STATUS[worker.review.status] || worker.review.status}` : ""}
                  {isActive(worker) ? "" : ""}
                </small>
              </span>
            </button>
          ))}
          {!workers.length && (
            <p className="field-help">
              {model.snapshot.mode.enabled
                ? "还没有 Worker。让 Being 委派一次本机任务后，进度会显示在这里。"
                : "编排模式已关闭。开启后，本机任务会交给 Worker 执行并在这里显示进度。"}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
