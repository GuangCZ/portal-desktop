// 模型配置 and Side by Side, as a page; 2026-09-16 (integration unit I6b).
//
// The DOM is BeingDesktop 0.8.26's, element for element and id for id
// (renderer/index.html lines 300-316): `model-select`, `model-custom-field`,
// `model-service-settings`, `model-provider`, `model-base-url`, `model-api-key`,
// `model-list-status`, `model-key-note`, `model-config-status`,
// `model-config-refresh`, `model-config-save`. Keeping the ids is not nostalgia —
// test/model-settings-ui.cjs addresses every one of them, and tests/sbs-refresh
// .mjs drives this page through them.
//
// There is no logic here. Every rule lives in ../models/model-settings.ts so it
// can be tested without a DOM; this file renders that state and forwards events.
// The one thing it decides is when to ask: the page is mounted only while the
// dialog shows it, so mounting IS 0.8.26's `activate()`.
import { useEffect } from "react";
import { useModel } from "../../shared/hooks/use-model";
import type { AppModel } from "../../app/models/app";
import { CUSTOM_MODEL, NO_MODEL_SETTINGS } from "../models/model-settings";

/** 已保存 / 运行中, in the three states the value actually has. `null` is unknown,
 * which 0.8.26 also renders as「未知」rather than as off. */
const sideBySideLabel = (value: boolean | null) => (value === null ? "未知" : value ? "已开启" : "已关闭");

export function ModelSettingsPage({ app }: { app: AppModel }) {
  // A model that failed to build is not on `AppModel` at all — the shell catches
  // that and carries on (app/models/app.ts) — so fall back to an inert one rather
  // than being the thing that empties the window.
  const model = useModel(app.features.modelSettings ?? NO_MODEL_SETTINGS);
  // 0.8.26's `activate()`: read once per Being, the first time the page is seen.
  // `model` is stable for the life of the shell, so this runs on mount and the
  // model itself refuses a second read (`attempted`).
  useEffect(() => { model.activate(); }, [model]);

  const editable = model.editable;
  return (
    <div className="shell-page model-page" id="model-settings-page" aria-busy={Boolean(model.busy)}>
      <h3>模型配置</h3>
      <p className="field-help">选择当前 Being 支持的模型，或填写自定义模型 ID。配置保存在 Being 那边。</p>
      <dl className="shell-facts">
        <div>
          <dt>当前模型</dt>
          <dd id="model-current">{model.runtime.model || "当前配置未知"}</dd>
        </div>
        <div>
          <dt>提供方</dt>
          <dd id="model-current-provider">{model.runtime.provider || "未知"}</dd>
        </div>
      </dl>

      <form
        id="model-config-form"
        className="model-config-form"
        onSubmit={event => { event.preventDefault(); void model.save(); }}
      >
        <div className="model-choice-heading">
          <label htmlFor="model-select">模型</label>
          <button
            type="button"
            id="model-config-refresh"
            className="text-button"
            disabled={!model.canRefresh}
            onClick={() => { void model.refresh(); }}
          >
            刷新列表
          </button>
        </div>
        <select
          id="model-select"
          aria-describedby="model-list-status"
          disabled={!editable}
          value={model.selected}
          onChange={event => model.selectModel(event.target.value)}
        >
          {/* Before the first read there is one placeholder and nothing to pick. */}
          {model.selected === "" ? (
            <option value="">{model.connected ? "待读取模型列表" : "连接 Being 后读取模型"}</option>
          ) : null}
          {model.groups().map(group => (
            <optgroup key={group.provider} label={group.label}>
              {group.options.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </optgroup>
          ))}
          {model.snapshot ? <option value={CUSTOM_MODEL}>自定义模型…</option> : null}
        </select>
        <p
          className={`field-help${model.listFailed ? " tone-error" : ""}`}
          id="model-list-status"
          role="status"
          aria-live="polite"
        >
          {model.listStatus}
        </p>

        {model.custom ? (
          <div className="model-config-field" id="model-custom-field">
            <label htmlFor="model-custom-name">自定义模型 ID</label>
            <input
              id="model-custom-name"
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              placeholder="输入服务端支持的完整模型 ID"
              required
              disabled={!editable}
              value={model.customName}
              onChange={event => model.setCustomName(event.target.value)}
            />
          </div>
        ) : null}

        <details
          className="model-service-settings"
          id="model-service-settings"
          open={model.serviceOpen}
          onToggle={event => model.setServiceOpen(event.currentTarget.open)}
        >
          <summary>服务与凭据</summary>
          <div className="model-config-field">
            <label htmlFor="model-provider">提供方 / API 协议</label>
            <select
              id="model-provider"
              disabled={!editable}
              value={model.provider}
              onChange={event => model.selectProvider(event.target.value)}
            >
              {/* An empty configuration has no provider to show as selected;
                  without this the browser would silently select the first entry
                  and the form would claim a provider nobody chose. */}
              {model.provider === "" ? <option value="">未选择</option> : null}
              {model.providers.map(provider => (
                <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
              ))}
            </select>
          </div>
          <div className="model-config-field">
            <label htmlFor="model-base-url">服务地址</label>
            <input
              id="model-base-url"
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              aria-describedby="model-service-note"
              disabled={!editable}
              value={model.baseUrl}
              onChange={event => model.setBaseUrl(event.target.value)}
            />
            <p className="field-help" id="model-service-note">使用 Being 服务端可访问的地址。</p>
          </div>
          <div className="model-config-field">
            <label htmlFor="model-api-key">API Key</label>
            {/* Write-only: never populated from anything the main process sent,
                cleared when the Being changes. See the model's header, rule 2. */}
            <input
              id="model-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="留空保留已有密钥"
              aria-describedby="model-key-note"
              disabled={!editable}
              value={model.apiKey}
              onChange={event => model.setApiKey(event.target.value)}
            />
            <p className="field-help" id="model-key-note">{model.keyNoteText}</p>
          </div>
        </details>

        <div className="form-footer model-config-footer">
          <p
            className={`field-help${model.statusFailed ? " tone-error" : ""}`}
            id="model-config-status"
            role="status"
            aria-live="polite"
          >
            {model.statusText}
          </p>
          <button type="submit" id="model-config-save" className="primary" disabled={!model.canSave}>
            {model.saveLabel}
          </button>
        </div>
      </form>

      <section className="model-sbs" aria-labelledby="model-sbs-heading">
        <h4 id="model-sbs-heading">Side by Side</h4>
        <p className="field-help">开启后 Being 会按自己的节奏醒来，而不是只在你说话时回应。</p>
        <div className="detail-row">
          <span>已保存</span>
          <strong id="model-sbs-configured">{sideBySideLabel(model.sideBySide)}</strong>
        </div>
        <div className="detail-row">
          <span>运行中</span>
          {/* Always「未知」in this client: 0.8.26 learned it from a message the
              Loom page posted, and the native conversation replaced that page.
              Saying so is better than claiming the Being is asleep. */}
          <strong id="model-sbs-active">{sideBySideLabel(model.sideBySideActive)}</strong>
        </div>
        <div className="model-sbs-footer">
          <p className="field-help" id="model-sbs-status" role="status" aria-live="polite">
            {model.sideBySideText}
          </p>
          {/* No pressed state at all while the value is unknown: `undefined`
              leaves the attribute off, which is what tests/sbs-refresh.mjs
              asserts before the first confirmed read. */}
          <button
            type="button"
            id="model-sbs-toggle"
            className="sbs-header-switch"
            aria-label="切换 SBS 自主醒来"
            aria-pressed={model.sideBySide === null ? undefined : model.sideBySide}
            disabled={!model.canToggleSideBySide}
            onClick={() => { void model.toggleSideBySide(); }}
          >
            {model.sideBySide ? "关闭 Side by Side" : "开启 Side by Side"}
          </button>
        </div>
      </section>
    </div>
  );
}
