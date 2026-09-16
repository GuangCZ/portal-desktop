// The settings page's rules, without a DOM. New in the portal-desktop shell on
// 2026-09-16 (integration unit I6b).
//
// ── WHERE THESE CASES COME FROM ──────────────────────────────────────────────
// BeingDesktop 0.8.26 pins this page with test/model-settings-ui.cjs: 363 lines
// that drive the real renderer in a hidden Electron window and assert 26 named
// checks against the DOM. That harness cannot be reused here — this client has no
// `renderer/index.html` and vitest has no DOM — so the rules moved into
// settings/models/model-settings.ts and the checks moved here, name for name. The
// mapping is in docs/migration/i6b-model-settings.md §5; every check is either
// below or listed there as covered by tests/sbs-refresh.mjs (the ones that are
// about geometry, pointer input or screenshots, which a model cannot answer for).
//
// The fixture data is 0.8.26's own, value for value — three providers, five
// presets including a duplicate model id under two providers and a preset whose
// provider is absent from the table — because several checks are about exactly
// those collisions.
//
// The shell is the real `AppModel`, built by the real registry, so the model is
// reached the way production reaches it (`app.features.modelSettings`). Only the
// bridge is a fake, because it is the process boundary.
import { describe, expect, it } from "vitest";
import { AppModel } from "../desktop/renderer/app/models/app";
import { CUSTOM_MODEL } from "../desktop/renderer/settings/models/model-settings";
import type { DesktopAPI } from "../desktop/shared/types";
import type {
  ModelConfigDto, ModelPatchInput, ModelSettingsState,
} from "../desktop/shared/desktop-types";

const settle = () => new Promise(resolve => setImmediate(resolve));

const initialConfig = {
  model: "fixture-model-a", provider: "openai", baseUrl: "https://model.fixture.invalid/v1",
  hasApiKey: true, thinking: "", temperature: null, sbsEnabled: false,
};
const providers = [
  { id: "openai", name: "OpenAI compatible", baseUrl: "https://default-openai.fixture.invalid/v1", keyless: false },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://anthropic.fixture.invalid/v1", keyless: false },
  { id: "self-hosted", name: "自部署", baseUrl: "http://self-hosted.fixture.invalid:7860/v1", keyless: true },
];
const models = [
  { id: "fixture-model-a", presetId: "fixture-a", name: "Fixture A", provider: "openai", baseUrl: "", hasApiKey: true },
  { id: "fixture-model-b", presetId: "fixture-b", name: "Fixture B", provider: "openai", baseUrl: "", hasApiKey: true },
  { id: "fixture-model-b", presetId: "fixture-b", name: "Anthropic B", provider: "anthropic", baseUrl: "", hasApiKey: true },
  { id: "fixture-endpoint-model", presetId: "", name: "Endpoint Needed", provider: "unknown-provider", baseUrl: "", hasApiKey: false },
  { id: "fixture-self-hosted", presetId: "self-hosted-fixture", name: "Self Hosted", provider: "self-hosted", baseUrl: "", hasApiKey: null },
];
const dto = (over: Partial<ModelConfigDto> = {}): ModelConfigDto => ({
  connectionId: 1, checkedAt: "now", config: { ...initialConfig }, models, providers, modelsError: "", ...over,
});
const runtime = (over: Partial<ModelSettingsState["runtime"]> = {}): ModelSettingsState["runtime"] => ({
  configStatus: "connected", configError: "", configCheckedAt: "now",
  model: initialConfig.model, provider: initialConfig.provider, baseUrl: initialConfig.baseUrl,
  sideBySide: { configured: false, active: null }, ...over,
});

function fixture() {
  const listeners = new Set<(state: ModelSettingsState) => void>();
  const saved: ModelPatchInput[] = [];
  const toggles: { enabled: boolean; connectionId: number }[] = [];
  let reads = 0;
  let readAnswer: ModelConfigDto | Error = dto();
  let saveAnswer: ModelConfigDto | Error | null = null;
  /** Requests the test can hold open, which is the only way to see what the page
   * looks like while one is in flight. */
  let holdRead: ((value: ModelConfigDto) => void) | null = null;
  let holdSave: ((value: ModelConfigDto) => void) | null = null;

  const answer = <T,>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);

  const api = {
    platform: "darwin",
    appearance: async () => "light",
    snapshot: async () => ({ settings: { hasToken: false }, portal: { phase: "stopped", message: "", logs: [] } }),
    updateState: async () => ({ phase: "idle" }),
    onPortal: () => () => {},
    onUpdate: () => () => {},
    onTownLive: () => () => {},
    townLive: async () => { throw new Error("no Town in this fixture"); },
    modelSettings: {
      modelConfig: () => {
        reads += 1;
        if (holdRead) return new Promise<ModelConfigDto>(resolve => { holdRead = resolve; });
        return answer(readAnswer);
      },
      saveModelConfig: (patch: ModelPatchInput) => {
        // Copy: the model deletes `apiKey` from the payload in `finally`, and the
        // test has to be able to see what was actually sent.
        saved.push({ ...patch });
        if (holdSave) return new Promise<ModelConfigDto>(resolve => { holdSave = resolve; });
        return answer(saveAnswer ?? readAnswer);
      },
      setSideBySide: (enabled: boolean, connectionId: number) => {
        toggles.push({ enabled, connectionId });
        return answer(saveAnswer ?? readAnswer);
      },
      onModelSettings: (callback: (state: ModelSettingsState) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  } as unknown as DesktopAPI;

  const app = new AppModel(api);
  const model = app.features.modelSettings;
  const stop = model.start();
  const push = (state: Partial<ModelSettingsState> = {}) => {
    const full: ModelSettingsState = { connected: true, connectionId: 1, runtime: runtime(), ...state };
    listeners.forEach(listener => listener(full));
  };
  return {
    app, model, stop, saved, toggles, push,
    reads: () => reads,
    answers: (next: ModelConfigDto | Error) => { readAnswer = next; },
    answersSave: (next: ModelConfigDto | Error | null) => { saveAnswer = next; },
    holdRead: () => { holdRead = () => {}; },
    releaseRead: (value: ModelConfigDto) => { const resolve = holdRead; holdRead = null; resolve?.(value); },
    holdSave: () => { holdSave = () => {}; },
    releaseSave: (value: ModelConfigDto) => { const resolve = holdSave; holdSave = null; resolve?.(value); },
    /** Bind a Being and let the first read settle — the page's normal opening. */
    open: async () => {
      push();
      model.activate();
      await settle();
    },
  };
}

describe("the model settings page", () => {
  it("reads nothing while no Being is bound, and cannot save (disconnected-cannot-load-or-save)", async () => {
    const f = fixture();
    f.push({ connected: false, connectionId: 0, runtime: runtime({ configStatus: "unknown", model: "", provider: "", baseUrl: "" }) });
    f.model.activate();
    await settle();
    expect(f.reads()).toBe(0);
    expect(f.model.canRefresh).toBe(false);
    expect(f.model.canSave).toBe(false);
    expect(f.model.editable).toBe(false);
    expect(f.model.statusText).toBe("连接 Being 后即可配置模型。");
    f.stop();
  });

  it("reads once when the page opens and never again on its own", async () => {
    const f = fixture();
    await f.open();
    expect(f.reads()).toBe(1);
    // Opening the page again, and a periodic push, are not reasons to re-read.
    f.model.activate();
    f.push();
    await settle();
    expect(f.reads()).toBe(1);
    // The refresh button is (list-retry-loads-through-preload).
    await f.model.refresh();
    expect(f.reads()).toBe(2);
    f.stop();
  });

  it("groups presets with self-hosted first and offers a custom option (self-hosted-group-is-listed-first-with-provider-names, supported-list-and-custom-option)", async () => {
    const f = fixture();
    await f.open();
    const groups = f.model.groups();
    expect(groups.map(group => group.label)).toEqual(["自部署", "OpenAI compatible", "Anthropic", "unknown-provider"]);
    expect(groups[0].options[0].label).toBe("Self Hosted · fixture-self-hosted · 自部署");
    expect(groups[1].options.length).toBe(2);
    // Five presets and 自定义模型…, every value distinct.
    const values = [...groups.flatMap(group => group.options.map(option => option.value)), CUSTOM_MODEL];
    expect(values.length).toBe(6);
    expect(new Set(values).size).toBe(6);
    // The configured model is the one selected, and the key field is empty.
    expect(f.model.modelName()).toBe("fixture-model-a");
    expect(f.model.apiKey).toBe("");
    expect(f.model.keyNoteText).toBe("已有密钥；留空保留，填写新密钥可替换。");
    expect(f.model.canSave).toBe(false);
    f.stop();
  });

  it("keeps the configured endpoint when the provider does not change (same-provider-model-keeps-configured-proxy)", async () => {
    const f = fixture();
    await f.open();
    f.model.selectModel(f.model.groups()[1].options[1].value);
    expect(f.model.modelName()).toBe("fixture-model-b");
    expect(f.model.provider).toBe("openai");
    expect(f.model.baseUrl).toBe(initialConfig.baseUrl);
    expect(f.model.canSave).toBe(true);
    // A push that does not change the epoch leaves the selection alone
    // (periodic-state-preserves-model-selection).
    f.push();
    expect(f.model.modelName()).toBe("fixture-model-b");
    f.stop();
  });

  it("omits a blank key from the payload (supported-model-save-omits-blank-key)", async () => {
    const f = fixture();
    await f.open();
    f.model.selectModel(f.model.groups()[1].options[1].value);
    await f.model.save();
    expect(f.saved).toEqual([{ connectionId: 1, model: "fixture-model-b", provider: "openai", baseUrl: initialConfig.baseUrl }]);
    expect(Object.hasOwn(f.saved[0], "apiKey")).toBe(false);
    f.stop();
  });

  it("fills a keyless provider's default endpoint and opens the service section (self-hosted-model-fills-default-endpoint-with-key-optional)", async () => {
    const f = fixture();
    await f.open();
    f.model.selectModel(f.model.groups()[0].options[0].value);
    expect(f.model.provider).toBe("self-hosted");
    expect(f.model.baseUrl).toBe("http://self-hosted.fixture.invalid:7860/v1");
    expect(f.model.serviceOpen).toBe(true);
    expect(f.model.keyNoteText).toMatch(/^自部署服务通常不填 API Key/);
    expect(f.model.canSave).toBe(true);
    // The endpoint travels, the key does not
    // (self-hosted-save-sends-default-endpoint-without-key).
    await f.model.save();
    expect(f.saved[0]).toEqual({ connectionId: 1, model: "fixture-self-hosted", provider: "self-hosted", baseUrl: "http://self-hosted.fixture.invalid:7860/v1" });
    expect(Object.hasOwn(f.saved[0], "apiKey")).toBe(false);
    f.stop();
  });

  it("clears the endpoint for a provider with no default, and picks the right one of two same-named models (provider-without-default-clears-previous-endpoint, duplicate-model-and-preset-ids-select-correct-provider)", async () => {
    const f = fixture();
    await f.open();
    // `unknown-provider` is named by a preset but absent from the table, so it is
    // listed under its own id with no default address.
    f.model.selectModel(f.model.groups()[3].options[0].value);
    expect(f.model.provider).toBe("unknown-provider");
    expect(f.model.baseUrl).toBe("");
    expect(f.model.serviceOpen).toBe(true);
    expect(f.model.keyNoteText).not.toMatch(/通常不填/);
    // `fixture-model-b` exists under two providers: choosing the Anthropic one
    // must select Anthropic, not the OpenAI preset with the same model id.
    f.model.selectModel(f.model.groups()[2].options[0].value);
    expect(f.model.modelName()).toBe("fixture-model-b");
    expect(f.model.provider).toBe("anthropic");
    expect(f.model.baseUrl).toBe("https://anthropic.fixture.invalid/v1");
    expect(f.model.serviceOpen).toBe(true);
    f.stop();
  });

  it("carries the model name over when the provider changes under it", async () => {
    const f = fixture();
    await f.open();
    f.model.selectProvider("anthropic");
    // The selected preset belongs to openai, so the page falls back to a custom
    // model rather than silently selecting someone else's.
    expect(f.model.custom).toBe(true);
    expect(f.model.customName).toBe("fixture-model-a");
    expect(f.model.baseUrl).toBe("https://anthropic.fixture.invalid/v1");
    f.stop();
  });

  it("keeps a whole custom draft across a push and across an explicit refresh (periodic-state-preserves-entire-custom-draft, explicit-list-refresh-preserves-custom-draft)", async () => {
    const f = fixture();
    await f.open();
    f.model.selectProvider("anthropic");
    f.model.setCustomName("custom/fixture-model:latest");
    f.model.setBaseUrl("https://custom.fixture.invalid/v1");
    f.model.setApiKey("fixture-only-key");
    f.push();
    expect(f.model.customName).toBe("custom/fixture-model:latest");
    expect(f.model.baseUrl).toBe("https://custom.fixture.invalid/v1");
    expect(f.model.apiKey).toBe("fixture-only-key");

    await f.model.refresh();
    expect(f.model.selected).toBe(CUSTOM_MODEL);
    expect(f.model.customName).toBe("custom/fixture-model:latest");
    expect(f.model.baseUrl).toBe("https://custom.fixture.invalid/v1");
    expect(f.model.apiKey).toBe("fixture-only-key");
    expect(f.model.feedback).toBe("已刷新支持的模型，保留了未保存的更改。");
    f.stop();
  });

  it("refuses a second submit while one is in flight, and sends the typed key once (pending-save-disables-submit, duplicate-submit-does-not-duplicate-save, custom-save-sends-config-and-new-key)", async () => {
    const f = fixture();
    await f.open();
    f.model.selectProvider("anthropic");
    f.model.setCustomName("custom/fixture-model:latest");
    f.model.setBaseUrl("https://custom.fixture.invalid/v1");
    f.model.setApiKey("fixture-only-key");
    f.holdSave();
    const saving = f.model.save();
    expect(f.model.busy).toBe("save");
    expect(f.model.canSave).toBe(false);
    expect(f.model.saveLabel).toBe("正在保存…");
    expect(f.model.statusText).toBe("正在保存并确认模型配置…");
    // A second submit while the first is open must not become a second write.
    await f.model.save();
    expect(f.saved.length).toBe(1);
    expect(f.saved[0]).toEqual({
      connectionId: 1, model: "custom/fixture-model:latest", provider: "anthropic",
      baseUrl: "https://custom.fixture.invalid/v1", apiKey: "fixture-only-key",
    });
    f.releaseSave(dto({ config: { ...initialConfig, model: "custom/fixture-model:latest", provider: "anthropic", baseUrl: "https://custom.fixture.invalid/v1" } }));
    await saving;
    // What came back is what is shown, the key field is empty again, and the form
    // is clean (saved-custom-stays-editable-with-key-cleared).
    expect(f.model.selected).toBe(CUSTOM_MODEL);
    expect(f.model.customName).toBe("custom/fixture-model:latest");
    expect(f.model.apiKey).toBe("");
    expect(f.model.canSave).toBe(false);
    expect(f.model.feedback).toBe("模型配置已保存，并已从 Being 读回确认。");
    f.stop();
  });

  it("keeps the draft and offers a retry when a save fails, without the Electron wrapper (save-error-keeps-draft-and-allows-retry, error-feedback-hides-electron-wrapper)", async () => {
    const f = fixture();
    await f.open();
    f.model.selectProvider("anthropic");
    f.model.setCustomName("custom/retry-model");
    f.answersSave(new Error("Error invoking remote method 'being:saveModelConfig': Error: 此服务需要 API Key，请填写后重新保存。"));
    await f.model.save();
    expect(f.model.customName).toBe("custom/retry-model");
    expect(f.model.canSave).toBe(true);
    expect(f.model.failed).toBe(true);
    expect(f.model.statusFailed).toBe(true);
    expect(f.model.feedback).toBe("此服务需要 API Key，请填写后重新保存。");
    expect(f.model.feedback).not.toContain("Error invoking remote method");
    f.stop();
  });

  it("leaves the form uneditable but retryable after a failed first read (initial-read-error-disables-editing-and-allows-retry, read-error-offers-retry)", async () => {
    const f = fixture();
    f.answers(new Error("模型配置读取失败，请检查网络与连接凭据。"));
    await f.open();
    expect(f.model.snapshot).toBe(null);
    expect(f.model.editable).toBe(false);
    expect(f.model.canSave).toBe(false);
    // The retry is still offered — that is the whole difference between a failed
    // read and a missing Being.
    expect(f.model.canRefresh).toBe(true);
    expect(f.model.failed).toBe(true);
    f.answers(dto());
    await f.model.refresh();
    expect(f.model.snapshot).not.toBe(null);
    expect(f.model.editable).toBe(true);
    f.stop();
  });

  it("still allows a custom model when the Being lists none or cannot list them (empty-list-allows-custom-model, list-error-keeps-custom-configuration-available)", async () => {
    const f = fixture();
    f.answers(dto({ models: [] }));
    await f.open();
    expect(f.model.custom).toBe(true);
    expect(f.model.customName).toBe("fixture-model-a");
    expect(f.model.listStatus).toBe("当前 Being 未提供模型列表，可填写自定义模型 ID。");
    expect(f.model.listFailed).toBe(false);
    expect(f.model.editable).toBe(true);

    f.answers(dto({ models: [], modelsError: "此 Being 未提供支持模型列表，可填写自定义模型。" }));
    await f.model.refresh();
    expect(f.model.listFailed).toBe(true);
    expect(f.model.listStatus).toMatch(/自定义模型/);
    expect(f.model.editable).toBe(true);
    f.stop();
  });

  it("drops an answer that belongs to the previous Being (previous-identity-load-cannot-replace-new-config)", async () => {
    const f = fixture();
    await f.open();
    f.holdRead();
    const stale = f.model.refresh();
    // The Being changes while the read is open.
    f.push({ connectionId: 2, runtime: runtime({ model: "new-being-model", baseUrl: "https://new-being.fixture.invalid/v1" }) });
    expect(f.model.snapshot).toBe(null);
    expect(f.model.busy).toBe("");
    f.releaseRead(dto());
    await stale;
    // Nothing from the previous Being reached the page: no configuration, no
    // message, and `busy` was not cleared by a request that no longer owns it.
    expect(f.model.snapshot).toBe(null);
    expect(f.model.feedback).toBe("");
    expect(f.model.failed).toBe(false);
    expect(f.model.runtime.model).toBe("new-being-model");
    f.stop();
  });

  it("drops a save that belongs to the previous Being (previous-identity-save-cannot-replace-new-config)", async () => {
    const f = fixture();
    await f.open();
    f.model.setApiKey("fixture-only-key");
    f.holdSave();
    const stale = f.model.save();
    f.push({ connectionId: 2, runtime: runtime({ model: "latest-being-model" }) });
    f.releaseSave(dto({ config: { ...initialConfig, model: "replaced-by-a-stale-save" } }));
    await stale;
    expect(f.model.snapshot).toBe(null);
    expect(f.model.feedback).not.toMatch(/已保存/);
    expect(f.model.runtime.model).toBe("latest-being-model");
    f.stop();
  });

  it("clears the draft and the key when the Being goes away (disconnect-clears-draft-and-secret)", async () => {
    const f = fixture();
    await f.open();
    f.model.setCustomName("old-being-draft");
    f.model.setApiKey("fixture-only-key");
    expect(f.model.dirty()).toBe(true);
    f.push({ connected: false, connectionId: 2, runtime: runtime({ configStatus: "unknown", model: "", provider: "", baseUrl: "", sideBySide: { configured: null, active: null } }) });
    expect(f.model.apiKey).toBe("");
    expect(f.model.customName).not.toBe("old-being-draft");
    expect(f.model.canSave).toBe(false);
    expect(f.model.snapshot).toBe(null);
    expect(f.model.attempted).toBe(false);
    f.stop();
  });

  it("lets go of its subscription when the shell stops", async () => {
    const f = fixture();
    await f.open();
    f.stop();
    f.push({ connectionId: 9 });
    expect(f.model.connectionId).toBe(1);
  });
});

describe("the Side by Side switch", () => {
  it("reports no pressed state at all until a read confirms one", async () => {
    const f = fixture();
    f.push({ runtime: runtime({ sideBySide: { configured: null, active: null } }) });
    expect(f.model.sideBySide).toBe(null);
    expect(f.model.canToggleSideBySide).toBe(false);
    expect(f.model.sideBySideText).toBe("Side by Side 状态未知；刷新配置后显示。");
    // Confirmed: now it can be pressed, and it says which way.
    f.push();
    expect(f.model.sideBySide).toBe(false);
    expect(f.model.canToggleSideBySide).toBe(true);
    expect(f.model.sideBySideText).toBe("Being 只在你说话时回应。");
    // 运行中 has no source in this shell and says so rather than claiming asleep.
    expect(f.model.sideBySideActive).toBe(null);
    f.stop();
  });

  it("never flips optimistically: the display follows the push, not the click", async () => {
    const f = fixture();
    await f.open();
    expect(f.model.sideBySide).toBe(false);
    const toggling = f.model.toggleSideBySide();
    // While the write is open the switch still reads `false` — and is disabled,
    // so the second click the E2E makes cannot queue behind the first.
    expect(f.model.sideBySide).toBe(false);
    expect(f.model.canToggleSideBySide).toBe(false);
    await toggling;
    expect(f.toggles).toEqual([{ enabled: true, connectionId: 1 }]);
    // Still false: the main process has not pushed the confirmed read yet.
    expect(f.model.sideBySide).toBe(false);
    f.push({ runtime: runtime({ sideBySide: { configured: true, active: null } }) });
    expect(f.model.sideBySide).toBe(true);
    expect(f.model.sideBySideText).toBe("Being 会按自己的节奏醒来。");
    f.stop();
  });

  it("says what went wrong without disturbing the form's own message", async () => {
    const f = fixture();
    await f.open();
    f.model.setCustomName("a-draft-in-progress");
    f.answersSave(new Error("Being 已回退本次模型变更，请重新读取当前配置。"));
    await f.model.toggleSideBySide();
    expect(f.model.sbsFeedback).toBe("Being 已回退本次模型变更，请重新读取当前配置。");
    expect(f.model.sideBySide).toBe(false);
    // The form is untouched: its draft and its own status line survive.
    expect(f.model.customName).toBe("a-draft-in-progress");
    expect(f.model.failed).toBe(false);
    f.stop();
  });

  it("goes back to unknown when a read stops confirming it, and recovers on the next one", async () => {
    const f = fixture();
    await f.open();
    f.push({ runtime: runtime({ sideBySide: { configured: true, active: null } }) });
    expect(f.model.sideBySide).toBe(true);
    // What the subsystem pushes after a 503 or a malformed answer.
    f.push({ runtime: runtime({ configStatus: "error", configError: "模型与并肩配置读取失败，当前值未知；重新读取成功后更新。", model: "", provider: "", baseUrl: "", sideBySide: { configured: null, active: null } }) });
    expect(f.model.sideBySide).toBe(null);
    expect(f.model.canToggleSideBySide).toBe(false);
    f.push({ runtime: runtime({ sideBySide: { configured: true, active: null } }) });
    expect(f.model.sideBySide).toBe(true);
    expect(f.model.canToggleSideBySide).toBe(true);
    f.stop();
  });
});
