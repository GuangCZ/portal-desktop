// One worker in full; 2026-09-16. Ported from BeingDesktop 0.8.26
// renderer/orchestration.js `showWorker` (lines 87-129).
//
// The four buttons are the part worth reading twice, because each appears under a
// different condition and two of them look alike but do opposite things:
//
//   停止 Worker      — while the CLI is running. Ends the process.
//   停止接续         — after it ended, while a review is still pending. Stops the
//                     follow-up, not the worker (there is nothing left to stop).
//   重试通知         — the completion notification failed to reach Heart.
//   重新接续         — Heart accepted it, but the continuation did not land.
//
// `重试通知` and `重新接续` never re-run the CLI, and the source is careful to say
// so in the surrounding copy; that copy is reproduced verbatim.
import { CONTINUATION, DELIVERY_STATUS, EVENT_LABEL, REVIEW_STATUS, WORKER_STATUS, isActive } from "../models/workers";
import type { OrchestrationModel } from "../models/workers";
import type { OrchestrationWorker, OrchestrationWorkerEvent } from "../../../shared/desktop-types";

const eventLabel = (event: OrchestrationWorkerEvent): string =>
  event.kind === "tool" ? `${event.name || "工具"} · ${event.status}` : EVENT_LABEL[event.kind] || "执行状态";

const eventTime = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString("zh-CN");
};

export function WorkerDetail({ model }: { model: OrchestrationModel }) {
  const worker = model.worker;
  if (!worker) return <p className="worker-error">{model.detailError || "正在读取 Worker…"}</p>;
  const review = worker.review, completion = worker.completion;
  const pendingReview = ["pending", "processing"].includes(review?.status ?? "");
  const canRetry = Boolean(completion && (["failed", "retrying"].includes(completion.state)
    || (completion.state === "accepted" && review?.status === "pending"
      && ["accepted", "uncertain", "failed"].includes(completion.continuation?.state ?? ""))));
  return (
    <article className="worker-detail">
      <header className="worker-detail-header">
        <button type="button" className="secondary" onClick={() => model.back()}>返回列表</button>
        <span className="worker-state">{WORKER_STATUS[worker.status] || worker.status}</span>
        {isActive(worker) && (
          <button type="button" className="secondary" disabled={worker.status === "stopping" || Boolean(model.busy)}
            onClick={() => void model.cancel(worker.id)}>停止 Worker</button>
        )}
        {completion && pendingReview && !isActive(worker) && (
          <button type="button" className="secondary" disabled={Boolean(model.busy)}
            onClick={() => void model.cancel(worker.id)}>停止接续</button>
        )}
        {canRetry && (
          <button type="button" className="secondary" disabled={!model.snapshot.mode.enabled || Boolean(model.busy)}
            onClick={() => void model.retry(worker.id)}>
            {completion!.state === "accepted" ? "重新接续" : "重试通知"}
          </button>
        )}
      </header>
      <h2 className="worker-detail-title">{worker.title}</h2>
      <p className="worker-detail-meta">{`${worker.agentId} · 会话 ${worker.sessionId}\n${worker.cwd}`}</p>
      <p className="worker-detail-note">{worker.detail}</p>
      {model.detailError && <p className="worker-error">{model.detailError}</p>}
      {completion && <Review worker={worker} enforcementBlocked={model.snapshot.mode.enabled && model.snapshot.enforcement?.status === "blocked"} />}
      <h3>执行结果</h3>
      <pre className="worker-result">{worker.result || "尚无执行结果"}</pre>
      <h3>工具调用与事件</h3>
      <div className="worker-events">
        {worker.events.map(event => (
          <details className="worker-event" key={event.seq} data-kind={event.kind}>
            <summary>{`${eventTime(event.at)}  ${eventLabel(event)}`}</summary>
            <pre>{[event.text, event.output, event.sessionId].filter(Boolean).join("\n") || eventLabel(event)}</pre>
          </details>
        ))}
        {!worker.events.length && <p className="field-help">尚无事件。</p>}
      </div>
      {worker.truncated && <p className="field-help">仅保留最近 300 条事件；早期事件已截断。</p>}
    </article>
  );
}

function Review({ worker, enforcementBlocked }: { worker: OrchestrationWorker; enforcementBlocked: boolean }) {
  const completion = worker.completion!, review = worker.review;
  return (
    <section className="worker-review">
      <h3>结果通知与验收</h3>
      <p>{`${DELIVERY_STATUS[completion.state] || completion.state} · ${REVIEW_STATUS[review?.status ?? ""] || "待验收"}`}</p>
      <p className="field-help">{completion.detail}</p>
      {enforcementBlocked && ["pending", "processing"].includes(review?.status ?? "") && (
        <p className="field-help">调度工具当前不可用，等待连接恢复后由 Being 验收；Worker 不会重新执行。</p>
      )}
      {completion.continuation && <p className="field-help">{CONTINUATION[completion.continuation.state] || ""}</p>}
      {review?.summary && (
        <>
          <pre className="worker-result">{review.summary}</pre>
          <p className="field-help">验收依据</p>
          <pre className="worker-result">{review.evidence}</pre>
        </>
      )}
    </section>
  );
}
