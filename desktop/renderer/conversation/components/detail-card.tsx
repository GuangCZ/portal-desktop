// The explanation card. Ported from BeingDesktop 0.8.26 renderer/chat-selection.js
// (`openDetail`'s DOM, `sendDetail`, `refreshDetail`, `sync`); 2026-09-16.
//
// A card is a temporary conversation about one quotation, living beside the real
// one. The two promises it makes to the reader, both asserted in
// test/chat-selection-ui.cjs:
//
//   * What is said here is said here. A follow-up never lands in the main
//     conversation, and the main conversation's stream never shows the card's.
//   * Closing it disposes a reader and nothing else. The Being is not
//     interrupted, and a question asked once stays asked once.
//
// Every card is drawn, and the ones belonging to another conversation are
// hidden rather than unmounted — a card belongs to the conversation it was
// opened from, so coming back finds it and its half-typed follow-up.
import { useLayoutEffect, useRef } from "react";
import { Markdown } from "../../shared/components/markdown";
import { useModel } from "../../shared/hooks/use-model";
import { decode } from "../../../shared/chat-references";
import type { ConversationModel } from "../models/conversation";
import type { DetailCardState } from "../models/details";
import { interleave } from "../models/transcript";
import { ReferenceChip } from "./messages";

/** What one card shows, in conversational order: the durable rows, the
 * unconfirmed pair around them, and the reply arriving now last. */
interface CardMessage { role: "user" | "being"; text: string; at: string; seq?: number; after?: number }

function messages(card: DetailCardState): CardMessage[] {
  const view = card.view;
  if (!view) return [];
  const items = interleave<CardMessage, CardMessage>(
    (view.rows || []).map(row => ({ role: row.role === "user" ? "user" : "being", text: row.content, at: row.at, seq: row.seq })),
    [
      ...(view.sent || []).map((row): CardMessage => ({ role: "user", text: row.text, at: row.at, after: row.after })),
      ...(view.replied || []).map((row): CardMessage => ({ role: "being", text: row.text, at: row.at, after: row.after })),
    ],
  ).map(({ key: _key, ...item }) => item as CardMessage);
  // 0.8.26 shows the card thinking before its first token, and an empty live
  // reply is exactly what says so (chat-selection.js line 185).
  if (view.live) items.push({ role: "being", text: view.live.text || "正在思考…", at: view.live.at });
  return items;
}

export function DetailCards({ model }: { model: ConversationModel }) {
  const conversation = useModel(model);
  const details = useModel(model.details);
  return (
    <>
      {details.list.map(card => (
        <DetailCard key={card.parentSessionId} model={model} card={card} hidden={card.parentSessionId !== conversation.activeId} />
      ))}
    </>
  );
}

function DetailCard({ model, card, hidden }: { model: ConversationModel; card: DetailCardState; hidden: boolean }) {
  const conversation = useModel(model);
  const details = model.details;
  const log = useRef<HTMLDivElement>(null);
  const items = messages(card);
  // Follow the card only while the reader is still at the bottom of it.
  useLayoutEffect(() => {
    const node = log.current;
    if (node && card.pinned && !hidden) node.scrollTop = node.scrollHeight;
  });
  const disabled = conversation.disabled || !card.sessionId;
  const send = () => void details.send(card.parentSessionId);
  return (
    <section
      className="chat-detail-card"
      role="dialog"
      aria-label="更多详情 · 临时会话"
      tabIndex={-1}
      hidden={hidden}
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        details.close(card.parentSessionId);
        model.focusComposer();
      }}
    >
      <header className="chat-detail-header">
        <strong>更多详情</strong>
        <span className="chat-detail-badge">临时会话</span>
        <button
          type="button"
          className="chat-detail-close"
          aria-label="关闭解释卡片"
          onClick={() => { details.close(card.parentSessionId); model.focusComposer(); }}
        >
          ×
        </button>
      </header>
      <p className="chat-detail-notice">关闭后不保留本地卡片；Being 仍可能保留对话并共享记忆。</p>
      <div className="chat-detail-source">
        <ReferenceChip references={[card.reference]} />
      </div>
      <div
        className="chat-detail-messages"
        role="log"
        aria-live="polite"
        ref={log}
        onScroll={event => {
          const node = event.currentTarget;
          details.setPinned(card.parentSessionId, node.scrollHeight - node.scrollTop - node.clientHeight < 48);
        }}
      >
        {items.map((item, index) => (
          <div className={`chat-detail-message is-${item.role}`} key={index}>
            <div className="chat-meta">{item.role === "user" ? "you" : "Being"}</div>
            <Markdown
              className="chat-body reading-text"
              content={item.role === "user" ? decode(item.text).text : item.text}
              chat
            />
          </div>
        ))}
      </div>
      <div className="chat-detail-status" role="status">{card.status}</div>
      <form className="chat-detail-composer" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea
          className="chat-detail-input"
          rows={1}
          placeholder="继续追问…"
          aria-label="在解释卡片中继续追问"
          disabled={disabled}
          value={card.draft}
          onChange={event => details.setDraft(card.parentSessionId, event.target.value)}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
        />
        {/* Stopping a card stops that card. The channel carries no `force` at
            all, so a refusal is reported in the status line and nothing is
            retried (chat-selection.js line 146). */}
        <button
          type="button"
          className="chat-detail-stop"
          hidden={!card.busy}
          onClick={() => void details.stop(card.parentSessionId)}
        >
          停止
        </button>
        <button type="submit" className="chat-detail-send" aria-label="发送追问" disabled={disabled || card.sending}>
          ↑
        </button>
      </form>
    </section>
  );
}
