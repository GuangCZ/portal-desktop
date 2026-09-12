import { useEffect, useState } from "react";
import type { AppModel } from "../models/app";
import { useModel } from "../models/store";
import { Dialog } from "./dialog";
export function ClientSettings({ model }: { model: AppModel }) {
  const app = useModel(model);
  const [tab, setTab] = useState("connections");
  useEffect(() => {
    if (app.clientSettingsOpen) setTab("connections");
  }, [app.clientSettingsOpen]);
  return (
    <Dialog
      open={app.clientSettingsOpen}
      onClose={() => {
        app.clientSettingsOpen = false;
        app.changed();
      }}
      id="client-settings-dialog"
      aria-labelledby="client-settings-title"
    >
      <div className="client-settings-content">
        <div className="dialog-heading">
          <h2 id="client-settings-title">设置</h2>
          <button
            type="button"
            id="close-client-settings"
            className="close"
            aria-label="关闭客户端设置"
            onClick={() => {
              app.clientSettingsOpen = false;
              app.changed();
            }}
          ></button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          <button
            id="settings-tab-connections"
            role="tab"
            aria-controls="settings-panel-connections"
            aria-selected={tab === "connections"}
            tabIndex={tab === "connections" ? 0 : -1}
            onClick={() => setTab("connections")}
            onKeyDown={(event) => {
              const keys = ["connections", "appearance", "general"];
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : event.key === "ArrowRight"
                      ? (0 + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (0 + 2) % 3
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(keys[next]);
              (
                event.currentTarget.parentElement?.children[next] as HTMLElement
              )?.focus();
            }}
          >
            连接与 Being
          </button>
          <button
            id="settings-tab-appearance"
            role="tab"
            aria-controls="settings-panel-appearance"
            aria-selected={tab === "appearance"}
            tabIndex={tab === "appearance" ? 0 : -1}
            onClick={() => setTab("appearance")}
            onKeyDown={(event) => {
              const keys = ["connections", "appearance", "general"];
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : event.key === "ArrowRight"
                      ? (1 + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (1 + 2) % 3
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(keys[next]);
              (
                event.currentTarget.parentElement?.children[next] as HTMLElement
              )?.focus();
            }}
          >
            外观与阅读
          </button>
          <button
            id="settings-tab-general"
            role="tab"
            aria-controls="settings-panel-general"
            aria-selected={tab === "general"}
            tabIndex={tab === "general" ? 0 : -1}
            onClick={() => setTab("general")}
            onKeyDown={(event) => {
              const keys = ["connections", "appearance", "general"];
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : event.key === "ArrowRight"
                      ? (2 + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (2 + 2) % 3
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(keys[next]);
              (
                event.currentTarget.parentElement?.children[next] as HTMLElement
              )?.focus();
            }}
          >
            通用
          </button>
        </div>
        <div
          id="settings-panel-connections"
          role="tabpanel"
          aria-labelledby="settings-tab-connections"
          hidden={tab !== "connections"}
        >
          <section
            className="settings-group"
            aria-labelledby="settings-connections"
          >
            <h3 id="settings-connections">连接与 Being</h3>
            <button
              id="settings-button"
              data-settings-route=""
              onClick={() => app.showSettings()}
            >
              Being 连接与本机配置 <span>›</span>
            </button>
            <button
              id="town-settings-button"
              data-settings-route=""
              onClick={() => {
                app.clientSettingsOpen = false;
                app.changed();
                void app.town.auth();
              }}
            >
              Town 配对与身份 <span>›</span>
            </button>
            <button
              data-chat-action="model"
              disabled={!app.snapshot?.settings.hasToken}
              onClick={() => app.chatAction("model")}
              data-settings-route=""
            >
              模型设置 <span>›</span>
            </button>
            <button
              data-view="portal"
              onClick={() => {
                app.clientSettingsOpen = false;
                app.navigate("portal");
              }}
              data-settings-route=""
            >
              Portal 运行状态 <span>›</span>
            </button>
            <button
              id="open-workspace"
              onClick={() => void app.run(() => app.api.openWorkspace())}
            >
              打开工作目录 <span>↗</span>
            </button>
          </section>
        </div>
        <div
          id="settings-panel-appearance"
          role="tabpanel"
          aria-labelledby="settings-tab-appearance"
          hidden={tab !== "appearance"}
        >
          <section
            className="settings-group"
            aria-labelledby="settings-appearance"
          >
            <h3 id="settings-appearance">外观与阅读</h3>
            <button id="theme-toggle" onClick={() => void app.toggleTheme()}>
              {app.theme === "light"
                ? "配色 · 浅色，点击切换"
                : "配色 · 深色，点击切换"}
            </button>
            <div className="reading-setting">
              <label htmlFor="reading-size">
                阅读字号{" "}
                <output id="reading-size-value" htmlFor="reading-size">
                  {app.readingSize} px
                </output>
              </label>
              <input
                id="reading-size"
                type="range"
                min="13"
                max="21"
                step="1"
                value={app.readingSize}
                onChange={(event) =>
                  app.setReadingSize(Number(event.target.value))
                }
              />
              <button
                id="reading-reset"
                type="button"
                onClick={() => app.setReadingSize(15)}
              >
                恢复默认
              </button>
              <p className="field-help">
                调整对话与 Town 正文字号，立即预览并记住设置。
              </p>
            </div>
          </section>
        </div>
        <div
          id="settings-panel-general"
          role="tabpanel"
          aria-labelledby="settings-tab-general"
          hidden={tab !== "general"}
        >
          <section
            className="settings-group"
            aria-labelledby="settings-startup"
          >
            <h3 id="settings-startup">启动与后台</h3>
            <p className="field-help">
              关闭窗口后，客户端继续运行。点击托盘图标或重新打开应用可恢复窗口；选择「退出客户端」才会结束运行。
            </p>
            <div className="switch-list">
              <label>
                <span>
                  <strong>开机自启客户端</strong>
                  <small id="client-startup-help">
                    {app.clientStartup?.message || "正在读取系统设置…"}
                  </small>
                </span>
                <input
                  id="client-startup-input"
                  type="checkbox"
                  role="switch"
                  checked={Boolean(app.clientStartup?.enabled)}
                  disabled={app.startupBusy || !app.clientStartup?.supported}
                  onChange={(event) =>
                    void app.changeClientStartup(event.target.checked)
                  }
                />
              </label>
            </div>
            <p className="form-error" id="client-settings-error" role="alert">
              {app.clientError}
            </p>
          </section>

          <section
            className="settings-group"
            aria-labelledby="settings-maintenance"
          >
            <h3 id="settings-maintenance">维护</h3>
            <button
              id="open-diagnostics"
              data-settings-route=""
              onClick={() => {
                app.clientSettingsOpen = false;
                app.diagnosticsOpen = true;
                app.changed();
              }}
            >
              连接诊断 <span>›</span>
            </button>
            <button
              id="check-updates"
              onClick={() => void app.run(() => app.api.checkUpdates())}
            >
              {app.update?.phase === "available"
                ? `更新至 ${app.update.latestVersion}`
                : app.update?.phase === "checking"
                  ? "正在检查更新…"
                  : "检查更新"}
            </button>
          </section>
        </div>
      </div>
    </Dialog>
  );
}
