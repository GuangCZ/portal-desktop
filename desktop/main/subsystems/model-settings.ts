// 模型配置 and Side by Side, as a subsystem; 2026-09-16 (integration unit I6b).
//
// It owns one route — `GET/PATCH /api/llm/config` — and it is the only thing in
// this client that reads or writes it. BeingDesktop 0.8.26 assembles the same
// three objects at src/main.cjs line 358 (`new ModelConfig({getContext,
// fetchImpl})`), line 363 (`publishModelConfig`) and line 972 (`doRefresh`'s
// config leg); this is those three, with the epoch rules made explicit.
//
// ── THE EPOCH, AND WHY IT IS NOT 0.8.26'S ─────────────────────────────────────
// 0.8.26 passes `connectionId: generation`, and `generation` increments on every
// `verifyConnection` — so re-verifying the SAME Being invalidates a form the user
// is holding and cancels a save in flight. This client follows subsystems/chat.ts
// instead: the epoch advances only when the Being's IDENTITY changes
// (`beingIdentityKey` of the saved address). Re-verifying the same Being is not a
// change, and the parsed `LoomConnection` object is kept rather than re-parsed,
// because `ModelConfig` compares it by reference — a re-parsed equal address
// would otherwise read as a new Being and fail every request in flight with
// SESSION_CHANGED. Recorded in docs/migration/i6b-model-settings.md §4.
//
// ── WHAT IT PUBLISHES, AND WHAT IT DOES NOT TOUCH ────────────────────────────
// `beings:model-settings-state`, its own channel, carrying the configuration half
// of `state.runtime`. Nothing is added to `beings:snapshot`: that is assembled in
// main.ts, which integration units must not edit (integration plan §4), and I6
// made the same choice for the sidebar ledger. `sideBySide.active` stays `null`
// here — see model-settings/runtime.ts.
//
// ── THE API KEY ───────────────────────────────────────────────────────────────
// This subsystem is the only place in the client where a credential the user
// typed crosses IPC in the clear. It is handed to `ModelConfig.save`, forwarded
// once to the Being, and dropped. It is never written to settings.json, never
// given to `ctx.store.saveExtra`, never logged (`ctx.onError` receives the scope
// and the error, and no error raised on this path carries a key — the validator's
// own message for a bad key is「API Key格式无效。」, the value redacted by
// omission), and never included in what is pushed: `ModelConfigDto` carries
// `hasApiKey` and nothing else. Pinned by tests/model-settings-secret.test.ts.
import { parseConnection, sessionPartition, type LoomConnection } from '../common/loom-connection';
import { ModelConfig } from '../model-settings/config';
import { modelSettingsPush, registerModelSettingsIpc } from '../model-settings/ipc';
import { emptyRuntime, failRuntimeConfig, modelRuntimeState, updateRuntimeConfig, type RuntimeState } from '../model-settings/runtime';
import type { ModelConfigDto, ModelPatchInput, ModelSettingsState } from '../../shared/model-settings-types';
import type { DesktopSubsystem, SubsystemContext } from './types';

export interface ModelSettingsSubsystem extends DesktopSubsystem {
  /** The configuration half of the runtime, as last confirmed. Exposed for the
   * tests and for any later subsystem that needs to know which model is bound. */
  state(): ModelSettingsState;
}

declare module './types' { interface SubsystemMap { 'model-settings': ModelSettingsSubsystem } }

export function installModelSettingsSubsystem(ctx: SubsystemContext): ModelSettingsSubsystem {
  const push = modelSettingsPush(ctx.push);
  let connection: LoomConnection | null = null;
  let identityKey = '';
  let connectionId = 0;
  let exiting = false;
  let runtime: RuntimeState = emptyRuntime();
  let ready: Promise<unknown> = Promise.resolve();

  const model = new ModelConfig({
    getContext: () => ({ connection, connectionId, exiting }),
    fetchImpl: ctx.fetchImpl,
  });

  const state = (): ModelSettingsState => ({ connected: Boolean(connection), connectionId, runtime: modelRuntimeState(runtime) });
  const publish = () => {
    try { push(state()); }
    catch (error) { ctx.onError('model-settings-publish', error); }
  };

  /** 0.8.26's `publishModelConfig` (src/main.cjs line 363), including its first
   * line: a result that belongs to a Being this client is no longer bound to is
   * refused rather than applied. It is the last gate before the runtime changes,
   * and it is what makes a save that stalled across a Being switch unable to
   * claim the new Being's state. */
  const accept = (dto: ModelConfigDto): ModelConfigDto => {
    if (!connection || dto.connectionId !== connectionId) throw Object.assign(
      new Error('Being 连接已变化，请重新读取模型配置。'), { code: 'SESSION_CHANGED' });
    runtime = updateRuntimeConfig(runtime, dto);
    publish();
    return dto;
  };

  /** Codes that say nothing about the Being's configuration: the epoch moved on
   * (the state was reset with it), a write is in flight (its own result will
   * publish, and 0.8.26 protects a write's snapshot from a concurrent read —
   * src/main.cjs line 977), or nothing is bound at all. Anything else means the
   * read did not come back and the values on screen are no longer claimed. */
  const STALE = new Set(['SESSION_CHANGED', 'BUSY', 'NOT_CONNECTED']);

  /** DEVIATION, and the reason it exists. 0.8.26 leaves a failed `getModelConfig`
   * silent and lets the next `doRefresh` poll (src/main.cjs line 972) record the
   * failure — it re-reads all three routes on a timer. This client has no such
   * timer for `/api/llm/config`: this subsystem is its only reader. So the failure
   * is recorded here instead, which keeps the observable rule the E2E pins:
   * a 503 or a malformed answer puts Side by Side back to「未知」and a later
   * successful refresh restores it (tests/sbs-refresh.mjs). */
  const readConfig = async (): Promise<ModelConfigDto> => {
    try { return accept(await model.get()); }
    catch (error) {
      if (!STALE.has(String((error as { code?: unknown } | null)?.code))) {
        runtime = failRuntimeConfig(runtime, new Date().toISOString());
        publish();
      }
      throw error;
    }
  };

  registerModelSettingsIpc({
    handle: ctx.handle,
    exclusive: ctx.exclusive,
    read: readConfig,
    save: async (patch: ModelPatchInput) => accept(await model.save(patch)),
    setSideBySide: async (enabled: boolean, id: number) => accept(await model.setSideBySide(enabled, id)),
  });

  /** The first read after a Being is bound, so the settings page and the runtime
   * line are populated before the user opens either. Fire-and-forget by contract
   * (./types.ts): `connectionVerified` runs inside main.ts's `exclusive` and must
   * not wait. A failure leaves `configStatus` at `error` with the sentence
   * 0.8.26 shows, and the page's 刷新 button is the retry. */
  const refresh = (epoch: number) => {
    ready = model.get().then(
      dto => { if (epoch === connectionId) accept(dto); },
      error => {
        if (epoch !== connectionId) return;
        runtime = failRuntimeConfig(runtime, new Date().toISOString());
        publish();
        ctx.onError('model-settings-refresh', error);
      },
    );
  };

  return {
    key: 'model-settings',
    state,
    get ready() { return ready; },
    connectionVerified(bound) {
      if (exiting) return;
      const address = ctx.store.connectionAddress || bound?.link || '';
      if (!address) return;
      let key: string;
      let parsed: LoomConnection;
      // The same identity string chat/connection.ts's `beingIdentityKey` derives
      // from the saved address — pinned equal by tests/identity-partition.test.ts
      // — computed from `main/common/` so this unit does not import I5's
      // directory for one function.
      try { parsed = parseConnection(address); key = sessionPartition(parsed); }
      catch (error) { ctx.onError('model-settings-identity', error); return; }
      // The same Being, verified again: keep the object `ModelConfig` compares by
      // reference, keep the epoch, and do not disturb a request in flight.
      if (connection && key === identityKey) return;
      connection = parsed;
      identityKey = key;
      connectionId++;
      runtime = emptyRuntime();
      publish();
      refresh(connectionId);
    },
    async connectionCleared() {
      connection = null;
      identityKey = '';
      // A new epoch even though nothing is bound: a reply still in flight for the
      // Being that just went away can no longer be accepted.
      connectionId++;
      runtime = emptyRuntime();
      publish();
      await ready.catch(() => { /* Reported where it happened. */ });
    },
    async quitting() {
      exiting = true;
      await ready.catch(() => { /* Reported where it happened. */ });
    },
  };
}
