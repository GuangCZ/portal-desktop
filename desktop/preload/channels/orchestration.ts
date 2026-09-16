// The channels orchestration and the feature-task ledger add to the bridge;
// 2026-09-16.
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are
// `being:`). The two subscriptions mirror BeingDesktop docs/interfaces.md §1.3:
// `workers` carries `Orchestration.snapshot()`, already coalesced to one per 50ms
// by the manager, and `feature-tasks` carries `{tasks, persistenceError}` —
// including the deliberate empty list pushed while an identity is being swapped.
//
// None of these channels is「Town 包络」in 0.8.26, so every one goes through
// `ipcRenderer.invoke` directly: a failure arrives as a plain Error whose message
// the pages display, and nothing here branches on a code.
import { ipcRenderer } from 'electron';
import { subscribe } from './bridge';
import type { FeatureTasksState, OrchestrationAPI, OrchestrationSnapshotState } from '../../shared/desktop-types';

export const orchestration: OrchestrationAPI = {
  snapshot: () => ipcRenderer.invoke('beings:orchestration'),
  inspectAgents: paths => ipcRenderer.invoke('beings:orchestration-inspect', paths),
  save: mode => ipcRenderer.invoke('beings:orchestration-save', mode),
  worker: id => ipcRenderer.invoke('beings:worker', id),
  cancelWorker: id => ipcRenderer.invoke('beings:worker-cancel', id),
  retryWorker: id => ipcRenderer.invoke('beings:worker-retry', id),
  reconnect: () => ipcRenderer.invoke('beings:workers-reconnect'),
  onWorkers: callback => subscribe<OrchestrationSnapshotState>('beings:workers', callback),
  featureTasks: options => ipcRenderer.invoke('beings:feature-tasks', options),
  featureTask: id => ipcRenderer.invoke('beings:feature-task', id),
  endFeatureTask: id => ipcRenderer.invoke('beings:feature-task-end', id),
  discussFeatureTask: id => ipcRenderer.invoke('beings:feature-task-discuss', id),
  onFeatureTasks: callback => subscribe<FeatureTasksState>('beings:feature-tasks', callback),
};
