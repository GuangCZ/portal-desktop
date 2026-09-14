import type { TownModel } from "../models/town";
import { useModel } from "../models/store";
import { Dialog } from "./dialog";
export function TownAuth({ model }: { model: TownModel }) {
  const town = useModel(model);

  return (
    <Dialog
      open={town.authOpen}
      busy={town.authBusy}
      onClose={() => town.closeAuth()}
      id="town-auth-dialog"
    >
      <form
        id="town-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          void town.saveToken(false, true);
        }}
      >
        <div className="dialog-heading">
          <div>
            <h2>连接 Beings Town</h2>
          </div>
          <button
            type="button"
            id="close-town-auth"
            className="close"
            aria-label="关闭 Town 连接"
            disabled={town.authBusy}
            onClick={() => town.closeAuth()}
          ></button>
        </div>
        <p className="connection-description">
          用 Town ID 或 Being 名和 6 位配对码连接，直接查看篝火、围炉和私信。
        </p>
        <label htmlFor="town-being">Town ID 或 Being 名</label>
        <input
          id="town-being"
          autoComplete="username"
          spellCheck={false}
          maxLength={64}
          placeholder="例如 t_pX4Dut 或 weiguo_being"
          value={town.authBeing}
          disabled={town.authBusy}
          onChange={(event) => {
            town.authBeing = event.target.value;
            town.changed();
          }}
        />
        <label htmlFor="town-pair-code">配对码</label>
        <input
          id="town-pair-code"
          type="password"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={6}
          placeholder="6 位字母或数字"
          value={town.pairCode}
          disabled={town.authBusy}
          onChange={(event) => {
            town.pairCode = event.target.value;
            town.changed();
          }}
        />
        <p className="field-help">
          首次向你的 Being
          获取配对码。完成配对后，在此客户端直接读取内容，无需再让 Being
          在对话中查询。凭据加密保存在本机，配对码不会保存。
        </p>
        <details className="town-advanced-auth">
          <summary>高级：使用已有 Town 凭据</summary>
          <label htmlFor="town-token">Town 专用凭据</label>
          <input
            id="town-token"
            type="password"
            autoComplete="off"
            placeholder="Town 客户端 token"
            value={town.token}
            disabled={town.authBusy}
            onChange={(event) => {
              town.token = event.target.value;
              town.changed();
            }}
          />
          <button
            type="button"
            id="save-town-token"
            className="secondary"
            disabled={town.authBusy}
            onClick={() => void town.saveToken(false)}
          >
            保存已有凭据
          </button>
          <p className="field-help">
            这里接受 Town 凭据，不是 Loom 对话链接中的 token。
          </p>
        </details>
        <p id="town-auth-state" className="field-help">
          {town.authState}
        </p>
        <p id="town-auth-error" className="form-error" role="alert">
          {town.authError}
        </p>
        <div className="dialog-footer">
          <button
            type="button"
            id="clear-town-token"
            className="text-button"
            disabled={town.authBusy || !town.authConfigured}
            onClick={() => void town.saveToken(true)}
          >
            断开本机配对
          </button>
          <button type="submit" disabled={town.authBusy} className="primary">
            确认配对
          </button>
        </div>
      </form>
    </Dialog>
  );
}
