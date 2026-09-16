// The workers of one conversation, as a collapsible group; 2026-09-16. Ported
// from BeingDesktop 0.8.26 renderer/orchestration.js `appendSession` (lines
// 59-86).
//
// DEVIATION, and it is visible: BeingDesktop hangs this group directly under its
// own conversation row in the sidebar. This shell's sidebar renders its rows
// itself (desktop/renderer/app/components/sidebar.tsx) and an integration unit
// may not edit it (integration plan §3「统一约定」), so the groups are one section
// at the foot of the session list instead, each labelled with its conversation.
// The group's own contract — the count summary, the collapse state that survives
// a restart, the caption carrying agent + status + review — is unchanged.
// docs/migration/i4-orchestration-features.md records what this costs.
import { REVIEW_STATUS, WORKER_STATUS, isActive } from "../models/workers";
import type { OrchestrationModel } from "../models/workers";
import type { ChatSessionSummary } from "../../../shared/desktop-types";

export function SessionWorkers({ model, sessions }: { model: OrchestrationModel; sessions: ChatSessionSummary[] }) {
  const groups = model.sessions();
  if (!groups.length) return null;
  const titles = new Map(sessions.map(session => [session.id, session.title]));
  return (
    <section className="sidebar-section session-workers" aria-label="Worker">
      <h2 className="sidebar-section-title">Worker</h2>
      {groups.map(sessionId => (
        <Group key={sessionId} model={model} sessionId={sessionId} title={titles.get(sessionId) || "其他会话"} />
      ))}
    </section>
  );
}

function Group({ model, sessionId, title }: { model: OrchestrationModel; sessionId: string; title: string }) {
  const workers = model.workersFor(sessionId);
  if (!workers.length) return null;
  const expanded = !model.isCollapsed(sessionId);
  const listId = `session-workers-${sessionId}`;
  return (
    <div className="session-workers-group">
      <button
        type="button"
        className="worker-group-toggle"
        aria-controls={listId}
        aria-expanded={expanded}
        title={expanded ? "收起 Worker 列表" : "展开 Worker 列表"}
        onClick={() => model.toggleGroup(sessionId)}
      >
        <span className="worker-group-arrow" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="worker-group-summary">
          {`${workers.length} 个 Worker · ${workers.filter(isActive).length} 执行中`}
          <small>{title}</small>
        </span>
        <span className="worker-group-action">{expanded ? "收起" : "展开"}</span>
      </button>
      <div className="worker-group-list" id={listId} hidden={!expanded}>
        {workers.map(worker => (
          <button
            type="button"
            key={worker.id}
            className="worker-shortcut"
            data-status={worker.status}
            title={`${worker.title}\n${worker.detail}`}
            onClick={() => void model.select(worker.id)}
          >
            <span className="worker-dot" aria-hidden="true" />
            <span className="worker-shortcut-label">
              <span className="worker-title">{worker.title}</span>
              <small className="worker-caption">
                {`${worker.agentId} · ${WORKER_STATUS[worker.status] || worker.status}`}
                {worker.review ? ` · ${REVIEW_STATUS[worker.review.status] || worker.review.status}` : ""}
              </small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
