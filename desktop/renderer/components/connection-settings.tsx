import type { AppModel } from "../models/app";
import { useModel } from "../models/store";
import { Dialog } from "./dialog";
export function ConnectionSettings({ model }: { model: AppModel }) {
  const app = useModel(model);
  const form = app.form;
  const imported = Boolean(form?.portalConfigPath);
  return (
    <Dialog
      open={app.settingsOpen}
      busy={app.saving}
      onClose={() => app.closeSettings()}
      id="settings-dialog"
    >
      <form
        id="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void app.saveSettings();
        }}
      >
        <div className="dialog-heading">
          <div>
            <h2>连接与设置</h2>
          </div>
          <button
            type="button"
            id="close-settings"
            disabled={app.saving}
            className="close"
            aria-label="关闭设置"
            onClick={() => app.closeSettings()}
          ></button>
        </div>
        <label htmlFor="connection-link">Being 完整连接地址</label>
        <input
          id="connection-link"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={form?.connectionLink || ""}
          onChange={(event) =>
            app.editForm("connectionLink", event.target.value)
          }
          required={!app.snapshot?.settings.hasToken}
          placeholder={
            app.snapshot?.settings.hasToken
              ? `${app.snapshot.settings.endpoint}/ · 已安全保存，留空保留`
              : "https://echo.beings.town/your_being/?token=…"
          }
        />
        <p className="field-help" id="connection-help">
          粘贴包含 token 的完整 Loom 地址，Being
          由地址确定。凭据加密保存在系统密钥库支持的本地配置中。
        </p>
        <div className="field-row">
          <div>
            <label htmlFor="portal-name-input">本机 Portal 名称</label>
            <input
              id="portal-name-input"
              required
              maxLength={80}
              pattern="[a-zA-Z0-9_-]+"
              value={form?.portalName || ""}
              onChange={(event) =>
                app.editForm("portalName", event.target.value)
              }
            />
          </div>
        </div>
        <p id="portal-name-help" className="field-help">
          {app.portalNameHelp}
        </p>
        <label htmlFor="workspace-input">工作目录</label>
        <div className="picker">
          <input
            id="workspace-input"
            required
            value={form?.workspace || ""}
            onChange={(event) => app.editForm("workspace", event.target.value)}
            readOnly={imported}
          />
          <button
            type="button"
            data-pick="workspace"
            disabled={imported}
            onClick={() =>
              void app.run(async () => {
                const value = await app.api.choose("workspace");
                if (value) app.editForm("workspace", value);
              })
            }
          >
            选择…
          </button>
        </div>
        <label htmlFor="binary-input">Portal 可执行文件</label>
        <div className="picker">
          <input
            id="binary-input"
            required
            value={form?.portalBinary || ""}
            onChange={(event) =>
              app.editForm("portalBinary", event.target.value)
            }
          />
          <button
            type="button"
            data-pick="binary"
            onClick={() =>
              void app.run(async () => {
                const value = await app.api.choose("binary");
                if (value) app.editForm("portalBinary", value);
              })
            }
          >
            选择…
          </button>
        </div>
        <p className="field-help">
          默认使用随客户端附带的 Rust 引擎，也可以选择已有的 heart-portal。
        </p>
        <p className="field-help" id="existing-config-note" hidden={!imported}>
          {imported
            ? `沿用现有配置：${form?.portalConfigPath}。工作目录、命令、截图及扩展工具以该文件为准；在原配置中修改后重启 Portal 生效。`
            : ""}
        </p>
        <div className="switch-list">
          <label>
            <span>
              <strong>Portal 后台常驻与登录自启</strong>
              <small>退出客户端后继续运行；连续故障最多重试 5 次</small>
            </span>
            <input
              id="background-input"
              type="checkbox"
              role="switch"
              checked={Boolean(form?.backgroundEnabled)}
              disabled={app.snapshot?.background?.supported === false}
              onChange={(event) =>
                app.editForm("backgroundEnabled", event.target.checked)
              }
            />
          </label>
          <label>
            <span>
              <strong>仅随客户端启动 Portal</strong>
              <small>未启用后台常驻时生效，退出客户端后停止</small>
            </span>
            <input
              id="autostart-input"
              type="checkbox"
              role="switch"
              checked={Boolean(form?.autoStart)}
              disabled={Boolean(form?.backgroundEnabled)}
              onChange={(event) =>
                app.editForm("autoStart", event.target.checked)
              }
            />
          </label>
          <label>
            <span>
              <strong>允许命令执行</strong>
              <small>默认开启，与 Portal 一同提供本机命令能力</small>
            </span>
            <input
              id="exec-input"
              type="checkbox"
              role="switch"
              checked={Boolean(form?.allowExec)}
              disabled={imported}
              onChange={(event) =>
                app.editForm("allowExec", event.target.checked)
              }
            />
          </label>
          <label>
            <span>
              <strong>启用 Kits 与自定义工具</strong>
              <small>默认开启，与 Portal 一同加载已安装的扩展和工具配置</small>
            </span>
            <input
              id="kits-input"
              type="checkbox"
              role="switch"
              checked={Boolean(form?.kitsEnabled)}
              disabled={imported}
              onChange={(event) =>
                app.editForm("kitsEnabled", event.target.checked)
              }
            />
          </label>
        </div>
        <p className="form-error" id="settings-error" role="alert">
          {app.formError}
        </p>
        <div className="dialog-footer">
          <span>验证连接成功后启动 Portal</span>
          <button
            className="primary"
            id="save-settings"
            type="submit"
            disabled={app.saving}
          >
            保存、连接并启动
          </button>
        </div>
      </form>
    </Dialog>
  );
}
