// The channels 模型配置 and Side by Side add to the bridge; 2026-09-16
// (integration unit I6b).
//
// Names follow portal-desktop's `beings:` prefix (BeingDesktop's own are
// `being:` — see MIGRATION.md): `getModelConfig` → `beings:model-config-get`,
// `saveModelConfig` → `beings:model-config-save`. `beings:sbs-set` is new; 0.8.26
// only ever displayed `sbs_enabled` (integration plan §5.3).
//
// The read is a plain invoke, as 0.8.26's is: its caller branches on nothing but
// success and prints the message. The two writes go through `enveloped`, because
// their callers must tell NEEDS_KEY (fill in a key) from ROLLED_BACK (the Being
// undid it) from RESULT_UNKNOWN (nobody knows; re-read) — and a `code` cannot
// survive on an Error crossing IPC. See main/model-settings/ipc.ts's header.
import { ipcRenderer } from 'electron';
import { enveloped, subscribe } from './bridge';
import type {
  ModelConfigDto, ModelPatchInput, ModelSettingsAPI, ModelSettingsState,
} from '../../shared/desktop-types';

export const modelSettings: ModelSettingsAPI = {
  modelConfig: () => ipcRenderer.invoke('beings:model-config-get'),
  saveModelConfig: (patch: ModelPatchInput) => enveloped<ModelConfigDto>('beings:model-config-save', patch),
  setSideBySide: (enabled: boolean, connectionId: number) =>
    enveloped<ModelConfigDto>('beings:sbs-set', enabled, connectionId),
  onModelSettings: callback => subscribe<ModelSettingsState>('beings:model-settings-state', callback),
};
