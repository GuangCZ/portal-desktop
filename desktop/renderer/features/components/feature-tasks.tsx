// The feature-task page; 2026-09-16. Ported from BeingDesktop 0.8.26
// renderer/feature-tasks.js (`render`, `renderDetail`), with the copy its
// test/feature-tasks-ui.cjs pins.
//
// Every sentence here is load-bearing, which is why they are the source's:
//「使用 Being，聊天可能等待」is a warning that the operation shares the chat
// queue;「结束本地跟踪」says in its own hint that the Being keeps going; the
// persistence notice says the work ran even though the record may not survive.
import {
  FEATURE_NAMES, TASK_FILTERS, TASK_STATUS, canEnd, taskTime,
} from "../models/feature-tasks";
import type { FeatureTasksModel } from "../models/feature-tasks";
import type { FeatureTask } from "../../../shared/desktop-types";

export function FeatureTasksPanel({ model }: { model: FeatureTasksModel }) {
  const tasks = model.visible();
  const selected = model.current();
  const notice = [model.error, model.persistenceError ? "任务记录暂未保存，重启后可能无法恢复。当前操作不受影响。" : ""].filter(Boolean).join("\n");
  return (
    <section className="feature-tasks" aria-label="功能任务" aria-busy={model.loading}>
      <header className="ft-header">
        <div>
          <h2>功能任务</h2>
          <p className="ft-subtitle">读取、检查和安装的进展与结果，都留在这里。</p>
        </div>
        <button type="button" className="ft-button ft-quiet" disabled={model.loading}
          title="读取本机已有任务，不向 Being 发送消息" onClick={() => void model.load()}>
          {model.loading ? "读取中…" : "刷新列表"}
        </button>
        <button type="button" className="icon-button close" aria-label="收起功能任务" title="收起功能任务"
          onClick={() => model.show(false)} />
      </header>
      <div className="ft-filters">
        <label className="ft-filter-label">
          <span>功能</span>
          <select className="ft-select" aria-label="按功能筛选" value={model.feature}
            onChange={event => model.setFeature(event.target.value)}>
            {model.features().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="ft-filter-label">
          <span>状态</span>
          <select className="ft-select" aria-label="按状态筛选" value={model.filter}
            onChange={event => model.setFilter(event.target.value)}>
            {TASK_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <span className="ft-count">{`${tasks.length} 个任务`}</span>
      </div>
      {notice && <div className={`ft-notice${model.persistenceError && !model.error ? " ft-persistence-warning" : ""}`} role="status">{notice}</div>}
      <div className="ft-content">
        {tasks.length > 0 && (
          <div className="ft-list" aria-label="任务列表">
            {tasks.map(task => (
              <button type="button" key={task.id} className={`ft-button ft-task${task.id === selected?.id ? " is-selected" : ""}`}
                aria-pressed={task.id === selected?.id} onClick={() => model.select(task.id)}>
                <span className="ft-task-top">
                  <strong className="ft-task-title">{task.title || "功能任务"}</strong>
                  <span className={`ft-task-dot ft-dot-${TASK_STATUS[task.status] ? task.status : "waiting"}`} />
                </span>
                <span className="ft-task-bottom">
                  <span>{`${FEATURE_NAMES[task.feature] || task.feature || "功能"} · ${TASK_STATUS[task.status] || "状态待确认"}`}</span>
                  <time>{taskTime(task.updatedAt || task.createdAt)}</time>
                </span>
              </button>
            ))}
          </div>
        )}
        {selected && <Detail model={model} task={selected} />}
        {!tasks.length && (
          <div className="ft-empty">
            <h3>{model.loading ? "正在读取任务…" : model.error ? "任务暂时无法读取" : model.tasks.length ? "没有符合筛选的任务" : "还没有功能任务"}</h3>
            <p>
              {model.error ? "可以重试刷新列表。已经提交的操作不会因此重发。"
                : model.tasks.length ? "换一个功能或状态查看。"
                  : "在功能页开始读取、检查或安装后，可在这里查看进展与结果。"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function Detail({ model, task }: { model: FeatureTasksModel; task: FeatureTask }) {
  const usesBeing = task.execution === "being" || task.mayDelayChat === true;
  const execution = usesBeing ? "使用 Being，聊天可能等待"
    : task.execution === "local" ? "本机执行" : "执行方式待确认";
  const heading = task.status === "needs_input" ? "需要你决定"
    : task.status === "failed" ? "未完成的原因"
      : task.status === "succeeded" ? "结果" : "当前进展";
  const fallback = task.status === "waiting" ? "结果尚未确认；不会自动重新提交。"
    : task.status === "running" ? "正在处理，结果会更新在这里。"
      : task.status === "cancelled" ? "已结束本地跟踪，Being 端执行状态需另行确认。"
        : "暂时没有更多详情。";
  const draftHint = model.draftError && model.selected === task.id ? model.draftError
    : model.draftReady === task.id ? "已放入聊天草稿，编辑后由你发送。"
      : "只有你选择讨论，才会把相关结果放入聊天草稿。";
  return (
    <section className="ft-detail" aria-label="任务详情">
      <div className="ft-detail-heading">
        <div>
          <p className="ft-eyebrow">{FEATURE_NAMES[task.feature] || task.feature || "功能任务"}</p>
          <h3>{task.title || "功能任务"}</h3>
        </div>
        <span className={`ft-status ft-status-${TASK_STATUS[task.status] ? task.status : "waiting"}`}>
          {TASK_STATUS[task.status] || "状态待确认"}
        </span>
      </div>
      <p className={`ft-execution${usesBeing ? " ft-execution-being" : ""}`}>{execution}</p>
      <div className="ft-result">
        <h4>{heading}</h4>
        <p className={task.status === "failed" ? "ft-error" : undefined}>{task.summary || task.detail || fallback}</p>
        {task.summary && task.detail && task.summary !== task.detail && <p className="ft-result-detail">{task.detail}</p>}
      </div>
      <dl className="ft-metadata">
        {([["创建", taskTime(task.createdAt)], ["更新", taskTime(task.updatedAt)], ["结束", taskTime(task.finishedAt)]] as [string, string][])
          .filter(([, value]) => value)
          .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <div className="ft-detail-actions">
        <button type="button" className="ft-button ft-secondary" data-action="discuss"
          title="把相关结果放入聊天输入框，编辑后由你发送"
          disabled={Boolean(model.drafting) || (!task.summary && !task.detail)}
          onClick={() => void model.discuss(task.id)}>
          {model.drafting === task.id ? "正在准备…" : "拿到聊天里讨论"}
        </button>
      </div>
      <p className={`ft-draft-hint${model.draftError && model.selected === task.id ? " ft-error" : ""}`}>{draftHint}</p>
      {canEnd(task) && (
        <div className="ft-tracking">
          <button type="button" className="ft-button ft-quiet" data-action="end-tracking"
            disabled={Boolean(model.ending)} onClick={() => void model.endTracking(task.id)}>
            {model.ending === task.id ? "正在结束…" : "结束本地跟踪"}
          </button>
          <p className="ft-tracking-hint">停止本地结果检查并关闭记录，Being 端执行不会取消。</p>
          {model.trackingError?.id === task.id && (
            <p className="ft-tracking-hint ft-error" role="status">{model.trackingError.message}</p>
          )}
        </div>
      )}
    </section>
  );
}
