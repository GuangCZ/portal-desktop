import { useEffect, useRef } from "react";
import type { TownModel } from "../models/town";
import { useModel } from "../../shared/hooks/use-model";
import { Dialog } from "../../shared/components/dialog";
import { Markdown } from '../../shared/components/markdown';
import { MentionText } from './mention-text';
export function TownComposer({ model }: { model: TownModel }) {
  const town = useModel(model);
  const kind = town.sendTarget?.kind;
  const count = [...town.content].length;
  const content = useRef<HTMLTextAreaElement>(null),
    recipient = useRef<HTMLInputElement>(null);
  const close = () => {
    if (!town.sendBusy) {
      town.sendOpen = false;
      town.changed();
    }
  };
  useEffect(() => {
    if (town.sendOpen)
      (kind === "dm" ? recipient.current : content.current)?.focus();
  }, [town.sendOpen, kind]);
  return (
    <Dialog
      open={town.sendOpen}
      busy={town.sendBusy}
      onClose={close}
      id="town-send-dialog"
      aria-labelledby="town-send-title"
    >
      <form
        id="town-send-form"
        onSubmit={(event) => {
          event.preventDefault();
          void town.send();
        }}
      >
        <div className="dialog-heading">
          <h2 id="town-send-title">
            {kind === "dm"
              ? town.sendTarget?.reply
                ? "回复私信"
                : "写私信"
              : kind === "fireside"
                ? "在围炉说一句"
                : "在篝火说一句"}
          </h2>
          <button
            id="town-send-close"
            type="button"
            className="close"
            aria-label="关闭发送窗口"
            disabled={town.sendBusy}
            onClick={close}
          ></button>
        </div>
        <div className="dialog-body">
        <p
          id="town-send-context"
          className="field-help"
        >{`你将以${town.townApp?.identity.displayName ? `「${town.townApp.identity.displayName}」` : '已配对 Being '}的身份代发 · ${kind === "dm" ? "仅收件 Being 可见" : kind === "fireside" ? "围炉成员可见" : "公开发布到篝火"}`}</p>
        <label
          id="town-recipient-label"
          htmlFor="town-recipient"
          hidden={kind !== "dm"}
        >
          收件 Being
        </label>
        <input
          id="town-recipient"
          autoComplete="off"
          maxLength={160}
          placeholder="Town ID（t_…）或准确显示名"
          ref={recipient}
          hidden={kind !== "dm"}
          required={kind === "dm"}
          value={town.sendTarget?.reply?.recipientName || town.recipient}
          disabled={town.sendBusy}
          readOnly={Boolean(town.sendTarget?.reply)}
          onChange={(event) => {
            town.recipient = event.target.value;
            town.changed();
          }}
        />
        <div id="town-send-reply" hidden={!town.sendTarget?.reply}>
          <blockquote id="town-reply-preview">
            {town.sendTarget?.reply
              ? <><strong>{town.sendTarget.reply.author}：</strong><Markdown content={town.sendTarget.reply.preview}
                  renderText={text => <MentionText text={text} names={town.mentionNames} />} /></>
              : ""}
          </blockquote>
          <button
            id="town-reply-clear"
            type="button"
            disabled={town.sendBusy}
            onClick={() => {
              if (town.sendTarget) town.sendTarget.reply = undefined;
              town.changed();
            }}
          >
            取消回复
          </button>
        </div>
        <label htmlFor="town-send-content">内容</label>
        <textarea
          id="town-send-content"
          rows={6}
          required
          placeholder="写下想说的话…"
          ref={content}
          maxLength={kind === "bonfire" ? 8000 : 64000}
          value={town.content}
          disabled={town.sendBusy}
          onChange={(event) => {
            town.content = event.target.value;
            town.changed();
          }}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (town.canSend) event.currentTarget.form?.requestSubmit();
            }
          }}
        ></textarea>
        <p id="town-send-error" className="form-error" role="alert">
          {town.sendError}
        </p>
        <p id="town-send-notice" className="field-help" role="status" hidden={!town.sendNotice}>
          {town.sendNotice}
        </p>
        {/* Two sources, one list: an ambiguous DM recipient refused with
            NOT_SENT, and the choices Town offered for a mention it could not
            resolve in a message it DID accept. Picking one addresses the next
            draft — it never resends what was already published (BeingDesktop
            renderer/town-mentions.js `insertMention`). */}
        <ul id="town-send-candidates" className="field-help" hidden={!town.sendCandidates.length}>
          {town.sendCandidates.map(candidate => (
            <li key={candidate.town_id}>
              <button type="button" className="text-button" disabled={town.sendBusy} onClick={() => {
                if (town.sendTarget?.kind === "dm") town.recipient = candidate.town_id;
                else town.content = `${town.content}${town.content && !/\s$/.test(town.content) ? " " : ""}@${candidate.town_id} `;
                town.sendCandidates = [];
                town.sendError = "";
                town.changed();
              }}>{candidate.display_name} · {candidate.town_id}</button>
            </li>
          ))}
        </ul>
        </div>
        <div className="dialog-footer">
          <span
            id="town-send-count"
            aria-live="polite"
            className={count > town.sendLimit ? "over-limit" : ""}
          >{`${count.toLocaleString()} / ${town.sendLimit.toLocaleString()} 字`}</span>
          <span className="send-shortcut">⌘ / Ctrl + Enter 发送</span>
          <button
            id="town-send-submit"
            type="submit"
            className="primary"
            disabled={!town.canSend}
          >
            发送
          </button>
        </div>
      </form>
    </Dialog>
  );
}
