// The `/` and `@` suggestion list, and the lines under the composer that say
// what the next message will do. Ported from BeingDesktop 0.8.26
// renderer/chat-composer.js (`refresh`'s menu markup, `selection`, the notice
// and result-notice elements); 2026-09-16.
//
// The heading is the part that matters most:「通知 Being · 消息将公开到篝火」is
// shown before a member is chosen, not after — choosing one makes the message
// public, and that is not something to discover from a receipt.
import { useEffect, useRef } from "react";
import { useModel } from "../../shared/hooks/use-model";
import type { ConversationModel } from "../models/conversation";

export const MENU_ID = "chat-composer-menu";
export const optionId = (index: number) => `chat-composer-option-${index}`;

export function ComposerMenu({ model, onChoose, onRetry }: {
  model: ConversationModel;
  onChoose: (index: number) => void;
  onRetry: () => void;
}) {
  const menu = useModel(model.menu);
  const directory = useModel(model.directory);
  const list = useRef<HTMLDivElement>(null);
  // Keep the highlighted row on screen while the arrows walk past the edge.
  useEffect(() => {
    if (!menu.open) return;
    list.current?.querySelector(`#${CSS.escape(optionId(menu.selected))}`)?.scrollIntoView({ block: "nearest" });
  }, [menu.open, menu.selected, menu.items]);
  return (
    <div className="chat-composer-menu" id={MENU_ID} role="listbox" hidden={!menu.open} ref={list}>
      <div className="chat-composer-heading">{menu.heading}</div>
      {menu.items.map((item, index) => (
        <button
          type="button"
          key={item.id}
          id={optionId(index)}
          className="chat-composer-option"
          role="option"
          aria-selected={index === menu.selected}
          tabIndex={-1}
          data-index={index}
          // The composer keeps the caret: a suggestion is chosen with the
          // pointer without the textarea ever losing focus.
          onMouseDown={event => event.preventDefault()}
          onClick={() => onChoose(index)}
        >
          <span className="chat-composer-icon" aria-hidden="true">
            {[...item.name][0]?.toUpperCase() || "?"}
            {item.icon.startsWith("data:image/") && <img alt="" src={item.icon} />}
          </span>
          <span className="chat-composer-copy">
            <strong>{(menu.token?.prefix || "") + (item.kind === "member" ? item.name : item.handle)}</strong>
            <span className="chat-composer-detail">
              {item.kind === "member" ? `@${item.id}${item.description ? " · " + item.description : ""}` : item.description}
            </span>
          </span>
        </button>
      ))}
      {!!menu.status && (
        <div className="chat-composer-empty">
          {menu.status}
          {/* Only a failed read gets a retry. Empty is not a failure, and a
              reload button over an empty list would promise a fix for nothing. */}
          {menu.retryable && (
            <button
              type="button"
              className="chat-composer-retry"
              title="重新加载"
              aria-label="重新加载"
              onMouseDown={event => event.preventDefault()}
              onClick={onRetry}
              disabled={directory.loading}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.4 6.7M20 4v7h-7" /></svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** What this message will do, and what the last one did. Two lines, because they
 * answer different questions: the first is about the draft and changes as it is
 * typed; the second is a receipt and stays until the conversation moves on. */
export function ComposerNotice({ model }: { model: ConversationModel }) {
  const menu = useModel(model.menu);
  const directory = useModel(model.directory);
  const receipt = directory.receipt;
  return (
    <>
      <div className="chat-composer-notice" aria-live="polite" hidden={!menu.notice}>{menu.notice}</div>
      <div className="chat-composer-notice" role="status" hidden={!receipt}>
        {receipt?.lines.map((line, index) => <p key={index}>{line}</p>)}
        {!!receipt?.warnings.length && (
          <ul aria-label="提及警告">
            {receipt.warnings.map((warning, index) => (
              <li key={index}>
                {warning.candidates.length
                  ? `提及有歧义${warning.mention ? "：" + warning.mention : ""}`
                  : `提及未确认${warning.mention ? "：" + warning.mention : ""}${warning.detail ? " · " + warning.detail : ""}`}
                {!!warning.candidates.length && (
                  <ul>
                    {warning.candidates.map(choice => (
                      <li key={choice.town_id}>{`${choice.display_name} · ${choice.town_id}`}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
