// The Being's runtime line, as BeingDesktop 0.8.26 assembles it. Ported line by
// line from src/runtime.cjs (55 lines); 2026-09-16.
//
// Three reads make one runtime: `/api/status` (is the Being reachable),
// `/api/llm/config` (which model, and whether Side by Side is configured) and
// `/api/stream/active` (is it answering someone right now). 0.8.26 issues all
// three together from `doRefresh` (src/main.cjs line 972) and keeps the result in
// `state.runtime`.
//
// WHAT THIS SHELL USES, AND WHAT IT DOES NOT. The model-settings subsystem reads
// only `/api/llm/config`: the other two belong to the conversation layer, which
// polls `/api/status` for readiness and `/api/stream/active` for the stream it is
// attached to, and duplicating those here would mean two clients asking the same
// Being the same question on two different timers. So the subsystem builds its
// state with `updateRuntimeConfig(emptyRuntime(), dto)` — the config half filled
// in, `status` left `unknown` and `activeStream.active` left `null`, which is
// exactly what BeingDesktop's own test asserts of that function ("updates
// configuration without claiming runtime or stream health", test/model-config
// .test.cjs).
//
// 0.8.26's `readRuntime`, which parses all three answers into one line, is NOT
// ported: nothing here would call it, and a copy of the stream-phase table that
// no code reads is a second definition waiting to disagree with the conversation
// layer's. The two fields it would fill are kept on `RuntimeState` — `status` and
// `activeStream.active`, both left at their unknown value — because every
// function below must be able to say it did not touch that half. When a unit
// takes ownership of all three reads it should write the parser against the
// routes as they are then, not inherit a copy frozen on this date.
//
// `sideBySide.active` has no source in this shell at all. In 0.8.26 it arrived as
// a `beings:sbs-state` message from the Loom page, which the native conversation
// replaced; it stays `null` (unknown) and the settings page says so rather than
// claiming the Being is asleep.
import type { ModelRuntimeState, ModelSideBySideState } from '../../shared/model-settings-types';

/** The conversation layer's half, as far as this file is concerned: whether the
 * Being is answering someone right now. Nothing here ever sets it — see the
 * header — and the settings page reports it as unknown rather than guessing. */
export interface ActiveStreamState {
  active: boolean | null;
}

export interface RuntimeState {
  status: string;
  error: string;
  checkedAt: string | null;
  configStatus: ModelRuntimeState['configStatus'];
  configError: string;
  configCheckedAt: string | null;
  model: string;
  provider: string;
  baseUrl: string;
  sideBySide: ModelSideBySideState;
  activeStream: ActiveStreamState;
}

/** The config half of a confirmed `/api/llm/config` read. `ModelConfigDto`
 * structurally, declared here so runtime.ts and config.ts stay independent. */
export interface RuntimeConfigSnapshot {
  checkedAt: string;
  config: { model: string; provider: string; baseUrl: string; sbsEnabled: boolean | null };
}

export function emptyRuntime(): RuntimeState {
  return {
    status: 'unknown', error: '', checkedAt: null, configStatus: 'unknown', configError: '', configCheckedAt: null,
    model: '', provider: '', baseUrl: '', sideBySide: { configured: null, active: null }, activeStream: { active: null },
  };
}

/** The other half of `updateRuntimeConfig`: a read that did NOT come back.
 *
 * It is `readRuntime`'s own else branch (above), lifted so a failure can be
 * recorded without pretending to have read `/api/status` too — and it resets the
 * configuration values rather than leaving the last ones on screen, because the
 * sentence it sets says「当前值未知」and a stale Side by Side state contradicting
 * that is exactly the bug tests/sbs-refresh.mjs was written to catch. */
export function failRuntimeConfig(runtime: RuntimeState, checkedAt: string): RuntimeState {
  const empty = emptyRuntime();
  return {
    ...runtime, configStatus: 'error', configError: '模型与并肩配置读取失败，当前值未知；重新读取成功后更新。',
    configCheckedAt: checkedAt, model: empty.model, provider: empty.provider, baseUrl: empty.baseUrl,
    sideBySide: { ...empty.sideBySide },
  };
}

/** A confirmed read replaces the configuration half and nothing else: it says
 * nothing about whether the Being is reachable or streaming. */
export function updateRuntimeConfig(runtime: RuntimeState, snapshot: RuntimeConfigSnapshot): RuntimeState {
  const { config, checkedAt } = snapshot;
  return {
    ...runtime, configStatus: 'connected', configError: '', configCheckedAt: checkedAt,
    model: config.model, provider: config.provider, baseUrl: config.baseUrl,
    sideBySide: { ...runtime.sideBySide, configured: config.sbsEnabled },
  };
}

/** The half of the runtime this subsystem publishes (`beings:model-settings-state`).
 * `/api/status` and `/api/stream/active` are the conversation layer's to report,
 * so they are dropped here rather than pushed twice from two timers. */
export function modelRuntimeState(runtime: RuntimeState): ModelRuntimeState {
  const { configStatus, configError, configCheckedAt, model, provider, baseUrl, sideBySide } = runtime;
  return { configStatus, configError, configCheckedAt, model, provider, baseUrl, sideBySide: { ...sideBySide } };
}
