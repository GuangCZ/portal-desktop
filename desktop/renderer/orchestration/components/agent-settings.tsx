// The orchestration mode editor; 2026-09-16. Layout follows BeingDesktop 0.8.26
// renderer/index.html's `settings-panel-orchestration` and the behaviour its
// renderer/orchestration.js gives it.
//
// There is no save button, and `test/orchestration-ui.cjs` asserts there is not:
// the switch, the default adapter and each path save themselves. The retry button
// appears only after a save was refused, and it re-sends that exact mode.
import { useEffect, useState } from "react";
import { AGENT_KITS, AGENT_STATUS, PATH_PLACEHOLDER } from "../models/settings";
import type { OrchestrationModel } from "../models/workers";

export function AgentSettings({ model }: { model: OrchestrationModel }) {
  const settings = model.settings;
  const agents = new Map(settings.agents.map(agent => [agent.id, agent]));
  return (
    <section className="orchestration-settings" data-mode-disabled={String(!settings.enabled)} aria-label="编排设置">
      <label className="orchestration-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={settings.busy}
          onChange={event => settings.toggle(event.target.checked)}
        />
        <span>
          编排模式
          <small>本机代码、命令与浏览器操作交给 Worker 执行；对话与 Being 的原生能力不受影响。</small>
        </span>
      </label>
      <p className="orchestration-status" data-status={settings.statusKind} role="status">{settings.status}</p>
      {settings.failed && (
        <button type="button" className="secondary" disabled={settings.busy} onClick={() => settings.retry()}>
          重试保存
        </button>
      )}
      <label className="orchestration-default">
        <span>默认 Agent</span>
        <select
          value={settings.defaultAgent}
          disabled={settings.locked}
          onChange={event => settings.setDefaultAgent(event.target.value)}
        >
          {AGENT_KITS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <div className="agent-kit-list">
        {AGENT_KITS.map(([id, name]) => {
          const agent = agents.get(id);
          return (
            <div className="agent-kit-row" key={id}>
              <label htmlFor={`agent-path-${id}`}>{name}</label>
              <PathInput
                id={id}
                value={settings.paths[id] ?? ""}
                disabled={settings.locked}
                onChange={value => settings.setPath(id, value)}
                onCommit={() => settings.commitPath()}
              />
              <p className="field-help" data-status={agent?.status || "unknown"} title={agent?.path || ""}>
                {agent ? `${AGENT_STATUS[agent.status] || agent.status} · ${agent.detail ?? ""}` : "尚未检测"}
              </p>
            </div>
          );
        })}
      </div>
      <div className="orchestration-actions">
        <button type="button" className="secondary" disabled={settings.locked} onClick={() => void settings.detect()}>
          检测本机 Agent
        </button>
        <button type="button" className="secondary" disabled={settings.locked} onClick={() => void settings.reconnect()}>
          重新连接调度工具
        </button>
      </div>
      {settings.policyDetail && <p className="field-help orchestration-policy-status">{settings.policyDetail}</p>}
      {model.snapshot.error && <p className="field-help orchestration-error">{model.snapshot.error}</p>}
    </section>
  );
}

/** A path field edits locally and saves on blur or Enter, which is what the
 * source's `change` + `keydown` pair does — saving on every keystroke would run a
 * detection pass per character. */
function PathInput({ id, value, disabled, onChange, onCommit }: {
  id: string; value: string; disabled: boolean;
  onChange: (value: string) => void; onCommit: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      id={`agent-path-${id}`}
      type="text"
      placeholder={PATH_PLACEHOLDER}
      value={draft}
      disabled={disabled}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (draft !== value) onChange(draft); onCommit(); }}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
    />
  );
}
