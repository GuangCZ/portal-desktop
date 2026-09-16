import type { TownModel } from "../models/town";
import { useModel } from "../../shared/hooks/use-model";
import { Dialog } from "../../shared/components/dialog";
import { townPairPrompt } from '../../../shared/town-pairing';

/** Connecting this client to Town.
 *
 * REWRITTEN 2026-09-16 for the direct client. What changed, and why each change
 * is not a simplification:
 *
 *   * There is no「Town ID 或 Being 名」field. The confirm call takes the code
 *     and the identity of the connection this client is already bound to; asking
 *     for the identity again only created a way to type the wrong one.
 *   * There is no「使用已有 Town 凭据」field. A long-lived token pasted into a
 *     page is a token that has been in a page. The client mints its own through
 *     `/api/client/pair/confirm` and it never leaves the main process.
 *   * There is a「重试保存配对」button, and it appears exactly when
 *     `pairingPending` is true: the code was already spent and the token is held
 *     in memory, so asking for another code would consume a second one for
 *     nothing (docs/town-sdk-integration.md「SDK 配对升级」).
 */
export function TownAuth({ model }: { model: TownModel }) {
  const town = useModel(model);
  const client = town.townApp?.client;
  const pending = client?.pairingPending === true;
  const manual = town.pairCode.length > 0 || !town.townApp;

  return (
    <Dialog
      open={town.authOpen}
      busy={town.authBusy}
      onClose={() => void town.closeAuth()}
      id="town-auth-dialog"
    >
      <form
        id="town-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) void town.retryPairStorage();
          else if (manual) void town.pair();
          else void town.autoPair();
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
            onClick={() => void town.closeAuth()}
          ></button>
        </div>
        <div className="dialog-body">
          <p className="connection-description">
            {town.authLoading
              ? '正在读取连接信息…'
              : pending
                ? '配对已经完成，只差写入本机密钥库。请重试保存；不要再要一个新的配对码。'
                : '点「自动连接 Town」，客户端会在一个单独的会话里请你的 Being 生成一次性配对码并自动兑换；也可以把下面的请求发给 Being，手动填写它回复的六位码。'}
          </p>
          <label htmlFor="town-pair-code">配对码</label>
          <input
            id="town-pair-code"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={6}
            placeholder="6 位大写字母或数字"
            value={town.pairCode}
            disabled={town.authBusy || pending}
            onChange={(event) => {
              town.pairCode = event.target.value.toUpperCase();
              town.changed();
            }}
          />
          <details className="town-manual-prompt">
            <summary>获取配对码的请求</summary>
            <p>{townPairPrompt}</p>
            <button type="button" className="text-button" onClick={() => void town.api.copyText(townPairPrompt).catch(error => town.toast(error))}>复制请求</button>
          </details>
          <p id="town-auth-state" className="field-help" role="status" aria-live="polite">
            {town.authState}
          </p>
          <p id="town-auth-error" className="form-error" role="alert">
            {town.authError}
          </p>
          {/* Fixed reason codes only: never a credential, a code, or an upstream body. */}
          {client?.errorCode && <p className="field-help">诊断：{client.errorCode}{client.authReason ? ` · ${client.authReason}` : ''}</p>}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            id="clear-town-token"
            className="text-button"
            disabled={town.authBusy || !client?.paired}
            onClick={() => void town.forget()}
          >
            断开本机配对
          </button>
          {!pending && (
            <button
              type="button"
              id="town-auto-pair"
              className="secondary"
              disabled={town.authBusy || town.authLoading}
              onClick={() => void town.autoPair()}
            >
              自动连接 Town
            </button>
          )}
          <button type="submit" disabled={town.authBusy || town.authLoading} className="primary">
            {pending ? '重试保存配对' : town.authBusy ? '正在连接…' : '确认配对'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
