// 模型配置 and Side by Side, as channels. Ported from BeingDesktop 0.8.26
// src/main.cjs `getModelConfig`/`saveModelConfig` (lines 1231-1236) with the
// payload contract of docs/interfaces.md §1.2; 2026-09-16 (integration unit I6b).
//
// Registration follows chat/ipc.ts and shell/ipc.ts: every channel goes through
// the `handle` wrapper main.ts supplies, so it inherits the sender check and the
// quitting guard, and the mutation 0.8.26 serializes (`saveModelConfig`, in its
// `serialized` set at src/main.cjs line 136) goes through the same `exclusive`
// queue this client uses for everything that writes.
//
// ── THREE DELIBERATE DEVIATIONS FROM 0.8.26, ALL RECORDED ────────────────────
//
// 1. THE WRITES ARE ENVELOPED, and 0.8.26's are not. `getModelConfig` and
//    `saveModelConfig` are absent from its `townMethods` set (src/main.cjs line
//    125), so there a failure is a thrown Error whose message the renderer prints
//    after stripping the Electron prefix (renderer/model-settings.js `cleanError`).
//    That works there because 0.8.26's own handle wrapper rethrows
//    `sanitizeText(error.message)`. This shell's does not: app/ipc.ts line 59
//    replaces whatever a handler throws with `new Error(errorLog.report(...))`,
//    and a custom `code` cannot cross IPC on an Error in any case. The message
//    would survive (shared/errors.ts keeps short authored Chinese), but the code
//    would not — and `NEEDS_KEY`, `ROLLED_BACK` and `RESULT_UNKNOWN` are three
//    different instructions to the user: fill in a key, the Being undid it, or
//    nobody knows and you must re-read. So both writes answer with data. The read
//    still throws, exactly as 0.8.26 does: its caller branches on nothing.
//
// 2. `beings:sbs-set` HAS NO 0.8.26 COUNTERPART. That client only displayed
//    `sbs_enabled` and pointed the user at Loom to change it (renderer/index.html
//    line 316,「在 Loom 中调整 Side by Side」). The write is the integration
//    plan's §5.3 decision, and its wire shape was measured rather than inferred —
//    see the `SideBySidePatch` comment in ./config.ts.
//
// 3. `beings:model-settings` READS WHAT 0.8.26 ONLY BROADCAST. There the runtime
//    line rides on `publicState()`, which the renderer also fetches on load
//    (`being:state`); here the equivalent state has a channel of its own because
//    `beings:snapshot` is assembled in main.ts, which integration units must not
//    edit. A push without a pull loses the cold start — see the comment on the
//    registration below.
//
// Arguments arrive from the renderer and are untrusted. They are NOT re-checked
// here: `validateModelPatch` (./config.ts) is the single gate, and it is stricter
// than a field walk — it refuses a non-plain prototype, an unknown key, and any
// property defined as an accessor, the last WITHOUT reading it. Duplicating a
// weaker version of that check here is how the two drift apart.
import { chatErrorEnvelope } from '../../shared/chat-errors';
import type { ModelConfigDto, ModelPatchInput, ModelSettingsState } from '../../shared/model-settings-types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface ModelSettingsIpcOptions {
  handle: RegisterHandler;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  /** What the push last carried, for a renderer that was not listening when it
   * went out. See the third deviation in the header. */
  state: () => ModelSettingsState;
  /** GET `/api/llm/config`, confirmed and redacted. */
  read: () => Promise<ModelConfigDto>;
  /** PATCH, then re-read to confirm. Answers with what the Being reports after
   * the change, never with what was requested. */
  save: (patch: ModelPatchInput) => Promise<ModelConfigDto>;
  setSideBySide: (enabled: boolean, connectionId: number) => Promise<ModelConfigDto>;
}

export function registerModelSettingsIpc({ handle, exclusive, state, read, save, setSideBySide }: ModelSettingsIpcOptions) {
  /** A channel that resolves with `{__townError:true, code, message}` rather than
   * throwing — see deviation 1 in the header. Catching inside `exclusive` also
   * keeps a refused write from arriving at the queue as a rejection. */
  const enveloped = (channel: string, callback: (...args: any[]) => Promise<ModelConfigDto>) =>
    handle(channel, (...args: any[]) => exclusive(async () => {
      try { return await callback(...args); }
      catch (error) { return chatErrorEnvelope(error); }
    }));

  // The pull that goes with the push. A subscription alone is not enough: the
  // window is created before the renderer runs, and this client binds its Being
  // one status round trip later (main.ts `createWindow()` then `restoreStartup()`
  // → `verifyConnection()` → `connectionVerified`), so on a cold start with a
  // Being already saved the only push of `connected: true` is normally sent
  // BEFORE the page subscribes and is dropped on the floor. A page that then
  // believed nothing was connected would disable its own read and never recover
  // — `connectionVerified` publishes nothing when the identity has not changed.
  // Every other model in this shell pairs the same way (ShellStateModel.start →
  // `beings:sidebar-state`, workers → `orchestration.snapshot()`, Town →
  // `town.appState()`); this is that pull.
  handle('beings:model-settings', (): ModelSettingsState => state());

  handle('beings:model-config-get', (): Promise<ModelConfigDto> => read());

  // The cast is the boundary's only claim about this value, and it is not
  // trusted: `validateModelPatch` runs first inside `save` and throws
  // INVALID_REQUEST for anything that is not exactly the five allowed fields.
  enveloped('beings:model-config-save', (input: unknown) => save(input as ModelPatchInput));

  // `setSideBySide` does its own checking for the same reason: one gate per value.
  enveloped('beings:sbs-set', (enabled: unknown, connectionId: unknown) =>
    setSideBySide(enabled as boolean, connectionId as number));
}

/** The one push. The window guard lives in `ctx.push`, so the subsystem may call
 * this at any time. */
export const modelSettingsPush = (send: (channel: string, payload: unknown) => void) =>
  (state: ModelSettingsState) => send('beings:model-settings-state', state);
