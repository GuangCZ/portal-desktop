import { useEffect, useRef, useState } from "react";
import type { ChatRuntime, ChatState, Preset } from "../models/chat";
import { useModel } from "../../shared/hooks/use-model";
import { safeLink } from "../../shared/components/markdown";

const baseUrls: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  "openai-responses": "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  kimi: "https://api.moonshot.cn/v1",
  google: "https://generativelanguage.googleapis.com",
};
const providerNames: Record<string, string> = {
  anthropic: "Claude",
  "openai-responses": "OpenAI",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  google: "Google",
  glm: "GLM",
};
interface ModelDraft {
  preset: Preset;
  route: "official" | "openrouter";
  model: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
}
function OAuthSettings({ runtime }: { runtime: ChatRuntime }) {
  const [status, setStatus] = useState<
    "idle" | "starting" | "pending" | "connected"
  >("idle");
  const [remaining, setRemaining] = useState(0),
    [error, setError] = useState(""),
    [disconnecting, setDisconnecting] = useState(false);
  const [url, setUrl] = useState<string>(),
    [code, setCode] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (status !== "pending") return;
    const request = ++generation.current;
    const deadline = Date.now() + remaining * 1000;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (!left) {
        setStatus("idle");
        setError("Authorization timed out");
        return;
      }
      inFlight = true;
      try {
        const res = await runtime.request("/api/llm/oauth/poll");
        const data = await res.json();
        if (request !== generation.current) return;
        if (data.status === "connected" || data.status === "authorized")
          setStatus("connected");
        else if (data.status === "error") {
          setStatus("idle");
          setError(data.message || "Authorization failed");
        }
      } catch {
        /* Continue within the device authorization deadline. */
      } finally {
        inFlight = false;
      }
    };
    const complete = (event: MessageEvent) => {
      if (
        event.source === parent &&
        event.data?.type === "heart:oauth-complete"
      )
        void poll();
    };
    const timer = setInterval(() => void poll(), 5000);
    window.addEventListener("message", complete);
    void poll();
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("message", complete);
    };
    // The deadline is captured once when a new authorization starts.
  }, [status, runtime]);
  async function start() {
    const request = ++generation.current;
    setStatus("starting");
    setError("");
    try {
      const res = await runtime.request("/api/llm/oauth/start", {
        method: "POST",
      });
      const data = await res.json();
      if (request !== generation.current) return;
      if (!res.ok || data.status !== "pending")
        throw new Error(
          data.status === "portal_required"
            ? "Please start Portal first"
            : data.error || data.message || "Failed to start OAuth",
        );
      setUrl(
        safeLink(data.verification_uri_complete || data.verification_uri || ""),
      );
      setCode(data.user_code || "");
      setRemaining(data.expires_in || 120);
      setStatus("pending");
    } catch (error) {
      if (request === generation.current) {
        setError(String(error));
        setStatus("idle");
      }
    }
  }
  async function disconnect() {
    const request = ++generation.current;
    try {
      const res = await runtime.request("/api/llm/oauth", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to disconnect");
      if (request === generation.current) {
        setStatus("idle");
        setDisconnecting(false);
      }
    } catch (error) {
      if (request === generation.current) setError(String(error));
    }
  }
  return (
    <div id="oauth-section" className="settings-section">
      <div className="section-label">CHATGPT ACCOUNT</div>
      <div id="oauth-status" role="status">
        {status === "connected" ? "✓ ChatGPT account connected" : error}
      </div>
      <button
        id="oauth-connect-btn"
        className="btn-sm"
        type="button"
        hidden={status === "pending" || status === "connected"}
        disabled={status === "starting"}
        onClick={() => void start()}
      >
        {status === "starting" ? "Starting..." : "🔗 Connect ChatGPT"}
      </button>
      <div id="oauth-device" hidden={status !== "pending"}>
        <div className="hint">
          Complete authorization in the browser window.
        </div>
        <div id="oauth-code">
          {code || "Waiting for authorization on your device..."}
        </div>
        {url && (
          <a
            id="oauth-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open authorization page →
          </a>
        )}
        <div id="oauth-timer" className="hint">
          {remaining}s remaining
        </div>
      </div>
      <button
        id="oauth-disconnect-btn"
        className="btn-sm"
        type="button"
        hidden={status !== "connected" || disconnecting}
        onClick={() => setDisconnecting(true)}
      >
        Disconnect
      </button>
      {disconnecting && (
        <div role="group" aria-label="Disconnect ChatGPT account?">
          <p>Disconnect ChatGPT account?</p>
          <button type="button" onClick={() => void disconnect()}>
            Disconnect
          </button>
          <button type="button" onClick={() => setDisconnecting(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
export function ChatSettings({
  state,
  runtime,
  open,
  close,
}: {
  state: ChatState;
  runtime: ChatRuntime;
  open: boolean;
  close: () => void;
}) {
  useModel(state);
  const [draft, setDraft] = useState<ModelDraft | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [temperature, setTemperature] = useState(1);
  const keyInput = useRef<HTMLInputElement>(null),
    closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) {
      void runtime.loadLlmConfig();
      closeButton.current?.focus();
    } else {
      setDraft(null);
      setError("");
    }
  }, [open, runtime]);
  useEffect(
    () => setTemperature(state.config.temperature ?? 1),
    [state.config.temperature],
  );
  const presets = Array.isArray(state.config.presets)
    ? state.config.presets
    : [];
  const current = presets.find((p) => p.model === state.config.model);
  const groups = new Map<string, Preset[]>();
  for (const preset of presets.filter((p) => p.model !== state.config.model))
    groups.set(preset.provider, [
      ...(groups.get(preset.provider) || []),
      preset,
    ]);
  function select(preset: Preset) {
    setError("");
    setDraft({
      preset,
      model: preset.model,
      provider: preset.provider,
      baseUrl: baseUrls[preset.provider] || "",
      apiKey: "",
      route: "official",
    });
  }
  const custom = draft?.preset.id === "__custom";
  const update = (patch: Partial<ModelDraft>) =>
    setDraft((value) => (value ? { ...value, ...patch } : value));
  async function apply() {
    if (!draft || busy) return;
    const model = (
      draft.route === "openrouter"
        ? `${draft.preset.provider}/${draft.preset.model}`
        : draft.model
    ).trim();
    if (!model) {
      setError("Enter a model name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await runtime.applyConfigChange({
        model,
        ...(draft.provider.trim() ? { provider: draft.provider.trim() } : {}),
        ...(draft.baseUrl.trim() ? { base_url: draft.baseUrl.trim() } : {}),
        ...(draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
      });
      if (result?.needs_key) {
        setError(result.error || "API key required for this provider.");
        keyInput.current?.focus();
      } else if (result?.ok) setDraft(null);
      else setError(state.configStatus || "Failed to switch model");
    } finally {
      setBusy(false);
    }
  }
  async function patch(value: Record<string, string | number>) {
    if (busy) return;
    setBusy(true);
    try {
      await runtime.applyConfigChange(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      id="settings-panel"
      className={`side-panel${open ? " active" : ""}`}
      inert={!open}
      aria-hidden={!open}
      aria-label="模型设置"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="settings-header panel-header">
        <span id="settings-title">Settings</span>
        <button
          ref={closeButton}
          className="btn-close"
          type="button"
          aria-label="关闭模型设置"
          onClick={close}
        >
          ✕
        </button>
      </div>
      <div className="settings-body" aria-busy={state.configLoading || busy}>
        <div id="llm-step1" hidden={!!draft}>
          <div className="settings-section">
            <div className="section-label">MODEL</div>
            <div id="llm-current" className="llm-current">
              <div className="model-name">
                {current?.label || state.config.model || "No model set"}
              </div>
              {state.config.model && (
                <div className="model-detail">
                  {state.config.model} · {current?.provider || "custom"}
                </div>
              )}
            </div>
            <div id="llm-preset-list" className="llm-list">
              {[...groups].map(([provider, items]) => (
                <div key={provider}>
                  <div className="provider-group-label">
                    {providerNames[provider] || provider}
                  </div>
                  <div className="provider-items">
                    {items.map((preset) => (
                      <button
                        key={preset.id}
                        className="llm-item"
                        type="button"
                        disabled={busy}
                        onClick={() => select(preset)}
                      >
                        {preset.label.replace(
                          /^(Claude|GPT|DeepSeek|Kimi|Gemini|GLM)\s*/i,
                          "",
                        )}
                        {preset.has_key === false && (
                          <span className="badge">🔑</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <button
              className="llm-custom-link"
              type="button"
              disabled={busy}
              onClick={() =>
                select({
                  id: "__custom",
                  label: "Custom Model",
                  model: "",
                  provider: "",
                })
              }
            >
              Custom model ›
            </button>
          </div>
          <div className="settings-section">
            <div className="section-label">THINKING</div>
            <div className="toggle-group" id="cfg-thinking">
              {[
                ["off", "Off"],
                ["low", "Low"],
                ["medium", "Med"],
                ["high", "High"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-val={value}
                  className={
                    (state.config.thinking || "medium") === value
                      ? "active"
                      : ""
                  }
                  aria-pressed={(state.config.thinking || "medium") === value}
                  disabled={busy}
                  onClick={() => void patch({ thinking: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <div className="section-label">TEMPERATURE</div>
            <div className="slider-row">
              <input
                aria-label="Temperature"
                type="range"
                id="cfg-temperature"
                min="0"
                max="1"
                step="0.1"
                value={temperature}
                disabled={busy}
                onChange={(event) => setTemperature(Number(event.target.value))}
                onPointerUp={() => void patch({ temperature })}
                onKeyUp={(event) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "Home",
                      "End",
                    ].includes(event.key)
                  )
                    void patch({ temperature });
                }}
              />
              <span id="cfg-temperature-val">{temperature.toFixed(1)}</span>
            </div>
          </div>
          <div className="settings-section">
            <button
              className="btn-rollback"
              type="button"
              disabled={busy}
              onClick={() => void patch({ rollback: "true" })}
            >
              ↩ Rollback to last working
            </button>
          </div>
        </div>
        {draft && (
          <form
            id="llm-step2"
            onSubmit={(event) => {
              event.preventDefault();
              void apply();
            }}
          >
            <div className="step2-header">
              <button
                className="step2-back"
                type="button"
                aria-label="返回模型列表"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                ←
              </button>
              <span id="step2-title">
                {draft.preset.label}
                {draft.route === "openrouter" ? " (OpenRouter)" : ""}
              </span>
            </div>
            <div
              className="settings-section"
              id="s2-model-section"
              hidden={!custom}
            >
              <label className="field-label" htmlFor="s2-model">
                Model
              </label>
              <input
                id="s2-model"
                className="field-input"
                value={draft.model}
                onChange={(event) => update({ model: event.target.value })}
                disabled={busy}
              />
            </div>
            <div
              className="settings-section"
              id="s2-route-section"
              hidden={custom}
            >
              <div className="toggle-group" id="s2-route">
                {(["official", "openrouter"] as const).map((route) => (
                  <button
                    type="button"
                    key={route}
                    data-val={route}
                    className={draft.route === route ? "active" : ""}
                    aria-pressed={draft.route === route}
                    disabled={busy}
                    onClick={() =>
                      update({
                        route,
                        provider:
                          route === "openrouter"
                            ? "openrouter"
                            : draft.preset.provider,
                        baseUrl:
                          route === "openrouter"
                            ? "https://openrouter.ai/api/v1"
                            : baseUrls[draft.preset.provider] || "",
                      })
                    }
                  >
                    {route === "official" ? "Official" : "OpenRouter"}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <label className="field-label" htmlFor="s2-provider">
                Provider
              </label>
              <input
                id="s2-provider"
                className="field-input"
                readOnly={!custom}
                value={draft.provider}
                disabled={busy}
                onChange={(event) => update({ provider: event.target.value })}
              />
            </div>
            <div className="settings-section">
              <label className="field-label" htmlFor="s2-base-url">
                Base URL
              </label>
              <input
                id="s2-base-url"
                className="field-input"
                readOnly={!custom}
                value={draft.baseUrl}
                disabled={busy}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </div>
            <div className="settings-section">
              <label className="field-label" htmlFor="s2-api-key">
                API Key
              </label>
              <input
                ref={keyInput}
                id="s2-api-key"
                className="field-input"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                disabled={busy}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
              <div id="s2-key-hint" className="hint">
                {custom
                  ? "Enter provider details for custom model."
                  : draft.preset.has_key === false
                    ? `No key found for ${draft.provider}. Enter one below.`
                    : `Key for ${draft.provider}`}
              </div>
            </div>
            <div id="s2-error" className="step2-error" role="alert">
              {error}
            </div>
            <button
              id="s2-apply"
              type="submit"
              className="btn-apply"
              disabled={busy}
            >
              {busy ? "Switching…" : "Apply"}
            </button>
          </form>
        )}
        <OAuthSettings runtime={runtime} />
        <div id="cfg-status" className={state.configStatusClass} role="status">
          {state.configStatus}
        </div>
        <div className="loom-version">
          Loom v<span id="loom-ver">1.8.0</span>
        </div>
      </div>
    </aside>
  );
}
