// The local-command console pane; 2026-09-16.
//
// DEVIATION from BeingDesktop 0.8.26, and a deliberate one. There, this pane is
// `#terminal-host` and the job list is drawn by `window.beingTerminal
// .updateJobs()` (renderer/terminal-panel.js) — the interactive terminal and the
// non-interactive console share one surface. The terminal belongs to another
// integration unit and is not in this worktree, so this pane renders the console's
// own jobs. When the terminal lands it joins this pane; the job list stays.
// See docs/migration/i2-tools.md「决定与偏差」.
//
// What is NOT a deviation: which jobs a Being may touch. `origin` comes from the
// main process — a job it started over the bridge reads `being`, one started in
// the box below reads `you` — and the bridge refuses to read or stop anything
// that is not its own. The badge exists so the difference is visible here too.
import type { DesktopConsoleJob } from "../../../shared/desktop-types";
import type { ToolsModel } from "../models/tools";

const STATUS_LABELS: Record<DesktopConsoleJob["status"], string> = {
  starting: "正在启动",
  running: "运行中",
  stopping: "正在停止",
  stopped: "已停止",
  completed: "已完成",
  failed: "失败",
};

const RUNNING = ["starting", "running", "stopping"];

/** The tail of a job's output, as the console kept it. The chunks are already
 * capped and truncated in the main process; joining is all that is left. */
const outputText = (job: DesktopConsoleJob) => job.output.map((chunk) => chunk.text).join("");

export function ToolsConsole({ model }: { model: ToolsModel }) {
  const { jobs, shell } = model.state.console;
  return (
    <section className="tools-pane console-pane" id="tools-console-pane" role="tabpanel" aria-labelledby="tools-console-mode" hidden={model.mode !== "console"}>
      <form
        className="console-run"
        id="tools-console-form"
        onSubmit={(event) => {
          event.preventDefault();
          void model.submitCommand();
        }}
      >
        <label className="visually-hidden" htmlFor="tools-console-command">
          本机命令
        </label>
        <input
          id="tools-console-command"
          autoComplete="off"
          spellCheck={false}
          placeholder={model.state.workspace ? `在 ${model.state.workspace} 运行` : "先选择工作区，再运行命令"}
          value={model.command}
          onChange={(event) => model.editCommand(event.target.value)}
        />
        <button type="submit" className="button primary small-button" disabled={!model.command.trim()}>
          运行
        </button>
      </form>
      <div className="console-jobs" id="tools-console-jobs" aria-label="本机命令">
        {jobs.length === 0 && (
          <p className="console-empty" id="tools-console-empty">
            {shell ? `命令在 ${shell} 中运行，每条一个独立会话，不共享状态。` : "还没有运行过命令。"}
          </p>
        )}
        {jobs.map((job) => (
          <article className="console-job" key={job.id} data-job={job.id} data-status={job.status}>
            <header>
              <span className="console-job-origin" data-origin={job.origin || "you"}>
                {job.origin === "being" ? "Being" : "你"}
              </span>
              <code className="console-job-command">{job.command}</code>
              <span className="console-job-status">
                {STATUS_LABELS[job.status]}
                {job.exitCode !== null && !RUNNING.includes(job.status) ? ` · 退出码 ${job.exitCode}` : ""}
                {job.signal ? ` · ${job.signal}` : ""}
              </span>
              <button
                type="button"
                className="text-button"
                data-job-action={`${RUNNING.includes(job.status) ? "stop" : "clear"}:${job.id}`}
                onClick={() =>
                  void model.act(
                    RUNNING.includes(job.status)
                      ? { action: "console.stop", value: job.id }
                      : { action: "console.clear", value: job.id },
                  )
                }
              >
                {RUNNING.includes(job.status) ? "停止" : "清除"}
              </button>
            </header>
            <p className="console-job-cwd">{job.cwd}</p>
            <pre className="console-job-output">{outputText(job)}</pre>
            {job.truncated && <p className="console-job-note">输出过长，只保留了尾部。</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
