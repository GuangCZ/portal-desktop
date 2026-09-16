// 模型配置 and Side by Side, as the renderer sees them; 2026-09-16
// (integration unit I6b).
//
// Shapes ported from BeingDesktop 0.8.26 src/model-config.cjs and
// docs/interfaces.md §1.2「`getModelConfig()` → `ModelConfigDto`」/
// 「`saveModelConfig(patch)` 串行」, plus §3「`ModelConfig({getContext, fetchImpl})`」.
//
// Declared here rather than in main/model-settings/config.ts so one set of
// declarations serves both sides of the bridge: the main process asserts its IPC
// return types against these, and the settings page reads the same names. That is
// also what keeps `config.ts` importable from `shared` without the renderer ever
// reaching into `main/`.
//
// Everything is prefixed `Model*`: desktop-types.ts re-exports every subsystem's
// file with `export *`, and a duplicate name would be dropped silently rather
// than fail (see that file's header).
//
// ── ONE FIELD IS NOT HERE ─────────────────────────────────────────────────────
// There is no `apiKey` on anything the main process sends back. A key travels in
// one direction only — renderer → `beings:model-config-save` → the Being — and is
// never read back, cached, logged or pushed. `hasApiKey` is the entire
// renderer-visible truth about it. See main/model-settings/config.ts's header.

/** One entry of the provider table. `keyless` marks a service Loom applies in one
 * step without an API key (self-hosted); the settings page groups those first and
 * says so next to the key field. */
export interface ModelProviderOption {
  id: string;
  name: string;
  baseUrl: string;
  keyless: boolean;
}

/** One model the Being listed in `presets`. `baseUrl` is the preset's own
 * address, redacted — it takes precedence over the provider default. */
export interface ModelPresetOption {
  id: string;
  presetId: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** Whether the Being holds a key for this preset; `null` when it did not say. */
  hasApiKey: boolean | null;
}

/** The configuration the Being is running now. */
export interface ModelConfigValues {
  model: string;
  provider: string;
  /** Origin and path only. The Being's own address may carry credentials or query
   * parameters; `publicModelUrl` removes them before the value leaves the main
   * process, which is why saving an unchanged address omits it entirely. */
  baseUrl: string;
  /** Whether the Being holds a key for this configuration. The key itself never
   * leaves the Being, and this client never sends one back that it did not just
   * receive from the user. `null` when the Being did not answer with the field. */
  hasApiKey: boolean | null;
  thinking: string;
  temperature: number | null;
  /** Side by Side, the Being's own waking loop. `null` when the Being did not
   * answer with the field at all — unknown is not the same as off. */
  sbsEnabled: boolean | null;
}

/** One confirmed read of `/api/llm/config`.
 *
 * `connectionId` is the epoch it was read in and must be echoed back by
 * `saveModelConfig` (docs/interfaces.md §1「纪元字段」): a form composed against
 * the Being that was connected a moment ago is refused rather than applied to
 * whoever is connected now. */
export interface ModelConfigDto {
  connectionId: number;
  checkedAt: string;
  config: ModelConfigValues;
  models: ModelPresetOption[];
  providers: ModelProviderOption[];
  /** Non-empty only when the Being answered without a `presets` array at all —
   * the list is unavailable, but a custom model ID still works. */
  modelsError: string;
}

/** What `saveModelConfig` accepts. camelCase here and snake_case on the wire:
 * the main process validates and renames, so a renderer never composes the
 * Being's own request shape. */
export interface ModelPatchInput {
  connectionId: number;
  model: string;
  provider: string;
  baseUrl?: string;
  /** Sent only when the user typed one. Omitted — not empty — otherwise, which is
   * what keeps an existing key on the Being rather than clearing it. */
  apiKey?: string;
}

export interface ModelSideBySideState {
  /** What the Being has saved: `sbs_enabled` from `/api/llm/config`. `null` is
   * "not yet read / not answered", which is not the same as off. */
  configured: boolean | null;
  /** Whether the waking loop is running right now. Always `null` in this shell:
   * 0.8.26 learned it from a `beings:sbs-state` message posted by the Loom page,
   * which the native conversation replaced. See main/model-settings/runtime.ts. */
  active: boolean | null;
}

/** The configuration half of `state.runtime` (src/runtime.cjs). The other half —
 * `/api/status` and `/api/stream/active` — belongs to the conversation layer and
 * is deliberately not duplicated here. */
export interface ModelRuntimeState {
  configStatus: 'unknown' | 'connected' | 'error';
  configError: string;
  configCheckedAt: string | null;
  model: string;
  provider: string;
  baseUrl: string;
  sideBySide: ModelSideBySideState;
}

/** What `beings:model-settings-state` carries.
 *
 * DEVIATION, and the reason this push exists: 0.8.26 puts the runtime on
 * `publicState()` and broadcasts the whole thing (src/main.cjs `broadcast`). This
 * shell's `beings:snapshot` is assembled in main.ts, which integration units must
 * not edit (integration plan §4), so this subsystem publishes its own slice on its
 * own channel instead — the same choice I6 made for the sidebar ledger
 * (docs/migration/i6-shell-state.md §4.1). Nothing was added to `Snapshot`. */
export interface ModelSettingsState {
  /** The epoch this state belongs to, so a page holding an older one can tell. */
  connectionId: number;
  runtime: ModelRuntimeState;
}

/** The bridge slice the model-settings subsystem adds to `window.beings`. */
export interface ModelSettingsAPI {
  /** Read `/api/llm/config` and answer with the confirmed configuration.
   * Rejects with a short authored message when the Being is unreachable, the
   * connection changed, or a save is in flight. */
  modelConfig(): Promise<ModelConfigDto>;
  /** PATCH, then re-read to confirm. Answers with the configuration the Being
   * reports AFTER the change, never with the one that was requested.
   *
   * Enveloped: rejects with an `Error` carrying `code` — `NEEDS_KEY` when the
   * service wants a key, `ROLLED_BACK` when the Being undid the change,
   * `RESULT_UNKNOWN` when the outcome could not be confirmed and the user must
   * re-read. See desktop/shared/chat-errors.ts. */
  saveModelConfig(patch: ModelPatchInput): Promise<ModelConfigDto>;
  /** Turn the Being's waking loop on or off, confirmed the same way. Enveloped. */
  setSideBySide(enabled: boolean, connectionId: number): Promise<ModelConfigDto>;
  /** The configuration half of the runtime, after every confirmed read or write
   * and after every change of Being. */
  onModelSettings(callback: (state: ModelSettingsState) => void): () => void;
}
