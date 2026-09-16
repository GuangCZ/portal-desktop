// The renderer's half of 模型配置 and Side by Side; 2026-09-16 (integration unit
// I6b).
//
// Ported rule by rule from BeingDesktop 0.8.26 renderer/model-settings.js (205
// lines), whose behaviour is pinned by test/model-settings-ui.cjs (26 checks).
// Every one of those rules is here rather than in the component, so the component
// stays a rendering of this state and the rules can be tested without a DOM —
// tests/model-settings-renderer.test.ts walks the same sequence the DOM fixture
// walked.
//
// ── THE THREE RULES THAT ARE THE WHOLE POINT ──────────────────────────────────
//
// 1. A STALE ANSWER IS DROPPED, NEVER APPLIED. Every request captures
//    `generation`; a reply that comes back after the Being changed returns
//    without touching state, without clearing `busy` and without showing a
//    message. 0.8.26's own two checks for this are named
//    `previous-identity-load-cannot-replace-new-config` and
//    `previous-identity-save-cannot-replace-new-config`. The main process refuses
//    the same thing independently (`connectionId` must equal the current epoch);
//    both halves check, because either alone leaves a window.
//
// 2. THE KEY IS WRITE-ONLY. `apiKey` is never filled from anything the main
//    process sent — there is nothing to fill it from — it is cleared whenever the
//    Being changes, and it is dropped from the payload in `finally` so it does
//    not sit in memory for a tick longer than the call. The field renders as
//    `type="password"` and is never populated on the way back.
//
// 3. SIDE BY SIDE IS NOT FLIPPED OPTIMISTICALLY. `configured` changes only when
//    the main process pushes a confirmed read, exactly as Loom 1.8.0's own
//    `toggleSbs` does ("以服务端回声为准"). `null` is unknown, which is not off:
//    the switch is disabled and reports no pressed state at all until a read
//    confirms one.
import { Store, errorText } from "../../shared/models/store";
import type { DesktopAPI } from "../../../shared/types";
import type {
  ModelConfigDto, ModelPatchInput, ModelPresetOption, ModelProviderOption,
  ModelRuntimeState, ModelSettingsState,
} from "../../../shared/desktop-types";

/** The option value that means「自定义模型…」. 0.8.26's own sentinel, kept so the
 * two clients' fixtures read the same. */
export const CUSTOM_MODEL = "__custom__";

const DEFAULT_KEY_NOTE = "留空保留已有密钥；填写后随模型配置保存。";
const DEFAULT_LIST_STATUS = "模型列表由当前 Being 提供。";

const EMPTY_RUNTIME: ModelRuntimeState = {
  configStatus: "unknown", configError: "", configCheckedAt: null,
  model: "", provider: "", baseUrl: "", sideBySide: { configured: null, active: null },
};

/** One `<optgroup>`: a provider and the presets it offers. */
export interface ModelOptionGroup {
  provider: string;
  label: string;
  options: { value: string; label: string }[];
}

/** What this model needs of `AppModel`. Narrow on purpose: the registry hands
 * factories the shell as `unknown` (app/models/registry.ts) precisely so a
 * feature cannot start depending on all of it. */
export interface ModelSettingsHost {
  toast(error: unknown): void;
}

const host = (value: unknown): ModelSettingsHost | null => {
  const app = value as Partial<ModelSettingsHost> | null;
  return app && typeof app.toast === "function" ? (app as ModelSettingsHost) : null;
};

/** The shape `fillForm` carries across a refresh when the user has unsaved
 * edits. Structurally a `ModelConfigValues` for the fields it reads. */
interface DraftSnapshot { model: string; provider: string; baseUrl: string; custom: boolean; apiKey: string }

export class ModelSettingsModel extends Store {
  /** Whether a Being is bound. Pushed by the subsystem, not inferred. */
  connected = false;
  /** The main process's epoch. A change of it is a change of Being. */
  connectionId = 0;
  runtime: ModelRuntimeState = EMPTY_RUNTIME;

  snapshot: ModelConfigDto | null = null;
  models: ModelPresetOption[] = [];
  providers: ModelProviderOption[] = [];

  /** The `<select>` value: `model-<index>`, `CUSTOM_MODEL`, or `""` before the
   * first read. */
  selected = "";
  /** The custom model ID field. Populated from the configuration even when a
   * preset is selected, so switching to 自定义 keeps the name. */
  customName = "";
  provider = "";
  baseUrl = "";
  /** Write-only. See rule 2 in the header. */
  apiKey = "";

  busy: "" | "load" | "save" | "sbs" = "";
  feedback = "";
  failed = false;
  /** A read has been attempted for this Being, so opening the page again does not
   * re-request. 0.8.26's own flag (renderer/model-settings.js line 12). */
  attempted = false;
  /** The「服务与凭据」disclosure. Opened automatically when a choice changes the
   * provider or the endpoint, because those are the fields that then need review. */
  serviceOpen = false;
  listStatus = DEFAULT_LIST_STATUS;
  listFailed = false;
  keyNote = DEFAULT_KEY_NOTE;
  /** The Side by Side switch's own message, kept apart from the form's so a
   * failed toggle does not erase what the form was saying. */
  sbsFeedback = "";

  private generation = 0;
  /** The page is on screen. 0.8.26 keeps the same flag (renderer/model-settings
   * .js line 9) for the same reason: a Being that binds while the page is open
   * should populate it, and one that binds while it is closed should not cost a
   * request nobody asked for. */
  private active = false;

  constructor(private readonly api: DesktopAPI, private readonly app: unknown) { super(); }

  /** Opened here and closed by the returned function: the contract every
   * registered model follows (app/models/registry.ts). */
  start() {
    if (!this.api?.modelSettings) return () => {};
    return this.api.modelSettings.onModelSettings(state => this.accept(state));
  }

  /** The push. A change of epoch is a change of Being: everything the user was
   * looking at belonged to the previous one and is dropped, including the key. */
  private accept(state: ModelSettingsState) {
    const changedBeing = state.connectionId !== this.connectionId;
    this.connected = state.connected;
    this.connectionId = state.connectionId;
    this.runtime = state.runtime;
    if (changedBeing) this.reset();
    this.changed();
    // 0.8.26's last line of `setState` (renderer/model-settings.js line 201): a
    // Being that arrived while the page was open populates it, without the user
    // having to close and reopen.
    if (this.active && this.connected && !this.attempted) void this.refresh();
  }

  private reset() {
    this.generation += 1;
    this.busy = "";
    this.snapshot = null;
    this.models = [];
    this.providers = [];
    this.selected = "";
    this.customName = "";
    this.provider = "";
    this.baseUrl = "";
    this.apiKey = "";
    this.attempted = false;
    this.feedback = "";
    this.sbsFeedback = "";
    this.failed = false;
    this.serviceOpen = false;
    this.listStatus = DEFAULT_LIST_STATUS;
    this.listFailed = false;
    this.keyNote = DEFAULT_KEY_NOTE;
  }

  /** The page was opened. 0.8.26's `activate()`: read once per Being, on first
   * sight, and never again on its own. */
  activate() {
    this.active = true;
    if (this.connected && !this.attempted) void this.refresh();
  }

  /** The page was closed. Nothing in flight is cancelled — a reply for the
   * current Being is still the current Being's — it only stops the page asking
   * again on its own while nobody is looking at it. */
  deactivate() { this.active = false; }

  // ── Derived state the component renders from ────────────────────────────────

  providerOf(id: string): ModelProviderOption | undefined {
    return this.providers.find(provider => provider.id === id);
  }
  providerName(id: string): string {
    return this.providerOf(id)?.name || id || "其他";
  }
  optionValue(index: number): string { return `model-${index}`; }
  selectedModel(): ModelPresetOption | undefined {
    return this.models.find((_model, index) => this.optionValue(index) === this.selected);
  }
  /** What would be saved as the model name. */
  modelName(): string {
    return this.selected === CUSTOM_MODEL ? this.customName.trim() : this.selectedModel()?.id || "";
  }
  get custom(): boolean { return this.selected === CUSTOM_MODEL; }

  /** Presets grouped by provider, keyless (self-hosted) groups first — Loom's own
   * order. Within a group the Being's order is kept. */
  groups(): ModelOptionGroup[] {
    const groups = new Map<string, ModelOptionGroup>();
    this.models.forEach((model, index) => {
      const key = model.provider || "";
      if (!groups.has(key)) groups.set(key, { provider: key, label: this.providerName(key), options: [] });
      const name = model.name || model.id;
      const middle = model.name && model.name !== model.id ? ` · ${model.id}` : "";
      groups.get(key)!.options.push({ value: this.optionValue(index), label: `${name}${middle} · ${this.providerName(key)}` });
    });
    const keyless = (key: string) => Number(this.providerOf(key)?.keyless === true);
    return [...groups.values()].sort((a, b) => keyless(b.provider) - keyless(a.provider));
  }

  dirty(): boolean {
    if (!this.snapshot) return false;
    const config = this.snapshot.config;
    return this.modelName() !== (config.model || "") || this.provider !== (config.provider || "")
      || this.baseUrl.trim() !== (config.baseUrl || "") || Boolean(this.apiKey);
  }
  get editable(): boolean { return this.connected && Boolean(this.snapshot) && !this.busy; }
  get canRefresh(): boolean { return this.connected && !this.busy; }
  get canSave(): boolean {
    return this.editable && this.dirty() && Boolean(this.modelName()) && Boolean(this.provider);
  }
  /** The note under the key field. A keyless service overrides it: Loom switches
   * those without sending a key, but the Being may still demand one for a
   * provider it holds no key for (measured 2026-09-11, 0.8.26 line 59). */
  get keyNoteText(): string {
    const provider = this.providerOf(this.provider);
    return provider?.keyless ? `${provider.name}服务通常不填 API Key；Being 提示需要时填写后重新保存。` : this.keyNote;
  }
  get statusText(): string {
    if (!this.connected) return "连接 Being 后即可配置模型。";
    if (this.busy === "load") return "正在读取配置与支持的模型…";
    if (this.busy === "save") return "正在保存并确认模型配置…";
    return this.feedback
      || (this.dirty() ? "有未保存的更改，保存后应用到当前 Being。" : "配置保存在当前 Being，选择后点击保存。");
  }
  get statusFailed(): boolean { return this.failed && !this.busy && this.connected; }
  get saveLabel(): string { return this.busy === "save" ? "正在保存…" : "保存模型配置"; }

  // ── Side by Side ────────────────────────────────────────────────────────────

  /** `true`/`false` once a read has confirmed one, `null` while unknown. */
  get sideBySide(): boolean | null { return this.runtime.sideBySide.configured; }
  /** Whether the waking loop is running. Always `null` in this shell — the
   * subsystem has no source for it (main/model-settings/runtime.ts). */
  get sideBySideActive(): boolean | null { return this.runtime.sideBySide.active; }
  get canToggleSideBySide(): boolean {
    return this.connected && !this.busy && this.sideBySide !== null;
  }
  get sideBySideText(): string {
    if (this.sbsFeedback) return this.sbsFeedback;
    if (!this.connected) return "连接 Being 后即可读取 Side by Side 状态。";
    if (this.busy === "sbs") return "正在切换并确认 Side by Side…";
    if (this.sideBySide === null) return "Side by Side 状态未知；刷新配置后显示。";
    return this.sideBySide ? "Being 会按自己的节奏醒来。" : "Being 只在你说话时回应。";
  }

  // ── Editing ─────────────────────────────────────────────────────────────────

  /** A new message replaces whatever the last request said. */
  private touched() {
    this.feedback = "";
    this.failed = false;
    this.changed();
  }

  selectModel(value: string) {
    this.selected = value;
    const model = this.selectedModel();
    if (model) {
      const providerChanged = model.provider !== this.provider;
      // A preset's own address wins; otherwise the new provider's default, and
      // only when the provider actually changed — so picking a second model from
      // the provider already selected keeps the endpoint the user configured.
      const endpoint = model.baseUrl || (providerChanged ? this.providerOf(model.provider)?.baseUrl || "" : "");
      if (providerChanged || (endpoint && endpoint !== this.baseUrl)) this.serviceOpen = true;
      this.provider = model.provider;
      if (endpoint || providerChanged) this.baseUrl = endpoint || "";
    }
    this.touched();
  }

  selectProvider(id: string) {
    const name = this.modelName();
    this.provider = id;
    this.baseUrl = this.providerOf(id)?.baseUrl || "";
    // The selected preset no longer belongs to this provider: fall back to a
    // custom model and carry the name over rather than silently selecting
    // someone else's model.
    if (this.selectedModel()?.provider !== id) {
      this.selected = CUSTOM_MODEL;
      this.customName = name;
    }
    this.touched();
  }

  setCustomName(value: string) { this.customName = value; this.touched(); }
  setBaseUrl(value: string) { this.baseUrl = value; this.touched(); }
  setApiKey(value: string) { this.apiKey = value; this.touched(); }
  setServiceOpen(open: boolean) { this.serviceOpen = open; this.changed(); }

  // ── The two requests ────────────────────────────────────────────────────────

  private fillForm(value: ModelConfigDto, preserveDraft = false) {
    const previous: DraftSnapshot | null = preserveDraft
      ? { model: this.modelName(), provider: this.provider, baseUrl: this.baseUrl.trim(), custom: this.custom, apiKey: this.apiKey }
      : null;
    this.snapshot = value;
    this.models = Array.isArray(value.models) ? value.models : [];
    this.providers = Array.isArray(value.providers) ? value.providers.slice() : [];
    // A provider named by the configuration, by a preset, or by the draft but
    // absent from the table is still a provider: list it under its own id rather
    // than dropping the user's current setting off the menu.
    for (const entry of [value.config, ...this.models, ...(previous ? [previous] : [])]) {
      if (entry.provider && !this.providers.some(provider => provider.id === entry.provider)) {
        this.providers.push({ id: entry.provider, name: entry.provider, baseUrl: entry.baseUrl || "", keyless: false });
      }
    }
    const values = previous || value.config;
    this.provider = values.provider || "";
    this.baseUrl = values.baseUrl || "";
    this.apiKey = previous?.apiKey || "";
    this.customName = values.model || "";
    const match = this.models.findIndex(model => model.id === values.model && model.provider === values.provider);
    this.selected = !previous?.custom && match >= 0 ? this.optionValue(match) : CUSTOM_MODEL;
    this.listStatus = value.modelsError
      || (this.models.length ? `${this.models.length} 个支持的模型，也可填写自定义模型 ID。` : "当前 Being 未提供模型列表，可填写自定义模型 ID。");
    this.listFailed = Boolean(value.modelsError);
    this.keyNote = value.config.hasApiKey
      ? "已有密钥；留空保留，填写新密钥可替换。"
      : "当前配置未提供密钥；按服务要求填写。";
  }

  async refresh() {
    if (!this.connected || this.busy || !this.api?.modelSettings) return;
    const request = this.generation;
    const preserveDraft = this.dirty();
    this.attempted = true;
    this.busy = "load";
    this.feedback = "";
    this.failed = false;
    this.changed();
    try {
      const value = await this.api.modelSettings.modelConfig();
      if (request !== this.generation) return;
      if (!value?.config || typeof value.config.model !== "string" || typeof value.config.provider !== "string") {
        throw new Error("模型配置读取失败，请重试。");
      }
      this.fillForm(value, preserveDraft);
      if (preserveDraft) this.feedback = "已刷新支持的模型，保留了未保存的更改。";
    } catch (error) {
      if (request !== this.generation) return;
      this.feedback = errorText(error);
      this.failed = true;
      host(this.app)?.toast(error);
    } finally {
      // A generation that has moved on already cleared `busy` in `reset()`;
      // clearing it here would undo the new Being's own in-flight read.
      if (request === this.generation) this.busy = "";
      this.changed();
    }
  }

  async save() {
    if (!this.canSave || !this.snapshot || !this.api?.modelSettings) return;
    const request = this.generation;
    const key = this.apiKey.trim();
    const payload: ModelPatchInput = {
      connectionId: this.snapshot.connectionId,
      model: this.modelName(),
      provider: this.provider,
      baseUrl: this.baseUrl.trim(),
      ...(key ? { apiKey: key } : {}),
    };
    this.busy = "save";
    this.feedback = "";
    this.failed = false;
    this.changed();
    try {
      const value = await this.api.modelSettings.saveModelConfig(payload);
      if (request !== this.generation) return;
      if (!value?.config) throw new Error("保存结果尚未确认，请刷新配置后检查。");
      this.fillForm(value);
      this.feedback = "模型配置已保存，并已从 Being 读回确认。";
    } catch (error) {
      if (request !== this.generation) return;
      this.feedback = errorText(error);
      this.failed = true;
      host(this.app)?.toast(error);
    } finally {
      // Not a formality: the payload is the last object holding the key, and it
      // is reachable from this closure until the call settles.
      delete payload.apiKey;
      if (request === this.generation) this.busy = "";
      this.changed();
    }
  }

  /** Turn the waking loop on or off. No optimistic flip: the display changes only
   * when the main process pushes the read that confirmed it. */
  async toggleSideBySide() {
    if (!this.canToggleSideBySide || !this.api?.modelSettings) return;
    const request = this.generation;
    const next = !this.sideBySide;
    const epoch = this.connectionId;
    this.busy = "sbs";
    this.sbsFeedback = "";
    this.changed();
    try {
      await this.api.modelSettings.setSideBySide(next, epoch);
      if (request !== this.generation) return;
      this.sbsFeedback = "";
    } catch (error) {
      if (request !== this.generation) return;
      this.sbsFeedback = errorText(error);
      host(this.app)?.toast(error);
    } finally {
      if (request === this.generation) this.busy = "";
      this.changed();
    }
  }
}

/** What a component falls back to when this model is not on `AppModel` at all —
 * the same reason `NO_SHELL_STATE` exists (settings/models/shell-state.ts): a
 * factory that throws is caught by `AppModel` and the key is simply absent, and a
 * component reading it blind would turn one broken model into an empty window. */
export const NO_MODEL_SETTINGS = new ModelSettingsModel(undefined as unknown as DesktopAPI, null);

declare module "../../app/models/registry" {
  interface AppFeatureModels {
    modelSettings: ModelSettingsModel;
  }
}
