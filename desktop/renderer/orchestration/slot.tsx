// Where orchestration and the feature-task ledger attach to the shell;
// 2026-09-16 (integration plan §2.4).
//
// Three surfaces and one topbar control:
//
//   panel  `orchestration`   the mode editor, the worker list, one worker's detail
//   panel  `feature-tasks`   the ledger page
//   side   `session-workers` the workers of each conversation, in the sidebar
//   top    `orchestration`   the two toggles that open them
//
// DEVIATION from integration plan §3.4, which asked for a SHEET slot (a full page
// behind `#place-sheet`) for the settings and the worker detail. A sheet's own
// heading is rendered by the shell from `definitions` in
// desktop/renderer/town/models/town.ts — a file this unit may not edit — so a
// sheet registered here would open under the title「对话」. Two dockable panels
// carry the same content, honestly labelled. Adding one row to `definitions` (a
// Town-unit file) is all a later unit needs to move them back;
// docs/migration/i4-orchestration-features.md records it.
import "./styles.css";
import { OrchestrationPanel } from "./components/worker-list";
import { SessionWorkers } from "./components/session-workers";
import { FeatureTasksPanel } from "../features/components/feature-tasks";
import type { PanelSlot, SidebarSlot, TopbarSlot } from "../app/slots";
import type { AppModel } from "../app/models/app";

export const orchestrationPanel: PanelSlot = {
  key: "orchestration",
  title: "编排",
  order: 300,
  visible: app => app.features.orchestration?.open === true,
  Panel: ({ app }) => <OrchestrationPanel model={app.features.orchestration} />,
};

export const featureTasksPanel: PanelSlot = {
  key: "feature-tasks",
  title: "功能任务",
  order: 400,
  visible: app => app.features.featureTasks?.open === true,
  Panel: ({ app }) => <FeatureTasksPanel model={app.features.featureTasks} />,
};

export const sessionWorkersSection: SidebarSlot = {
  key: "session-workers",
  order: 300,
  placement: "scroll",
  Section: ({ app }) => <SessionWorkers model={app.features.orchestration} sessions={app.conversation.sessions} />,
};

export const orchestrationActions: TopbarSlot = {
  key: "orchestration",
  order: 300,
  Action: ({ app }) => <Actions app={app} />,
};

function Actions({ app }: { app: AppModel }) {
  const orchestration = app.features.orchestration, tasks = app.features.featureTasks;
  if (!orchestration || !tasks) return null;
  const running = orchestration.snapshot.workers.filter(worker => ["starting", "running", "queued", "stopping"].includes(worker.status)).length;
  return (
    <>
      <button
        type="button"
        className="topbar-icon-button"
        aria-label="编排与 Worker"
        aria-pressed={orchestration.open}
        title={running ? `编排与 Worker · ${running} 执行中` : "编排与 Worker"}
        onClick={() => orchestration.show(!orchestration.open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" />
          <path d="M6 8.5v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" />
        </svg>
        {running > 0 && <span className="topbar-badge" aria-hidden="true">{running}</span>}
      </button>
      <button
        type="button"
        className="topbar-icon-button"
        aria-label="功能任务"
        aria-pressed={tasks.open}
        title="功能任务"
        onClick={() => tasks.show(!tasks.open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h10" /><path d="m17 17 2 2 3-4" />
        </svg>
      </button>
    </>
  );
}
