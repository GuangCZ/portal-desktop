// The conversation page: the one-time explanation, the transcript, the composer,
// and the confirmation a refused stop has to go through. Ported from
// BeingDesktop 0.8.26 renderer/chat-app.js (`build`'s `#chat-native` host, the
// notice bar, the drop target) and the `window.confirm` calls in `stop`;
// 2026-09-16 — the browser dialog becomes the shell's own modal, which is the
// only change of substance.
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../shared/components/dialog";
import { useModel } from "../../shared/hooks/use-model";
import type { PlaceTarget } from "../../shared/lib/navigation";
import { NOTICE_TEXT, type ConversationModel } from "../models/conversation";
import { Transcript } from "./messages";
import { Composer } from "./composer";
import { DetailCards } from "./detail-card";
import { SelectionToolbar } from "./selection";

export function ConversationPage({ model, onPlace }: {
  model: ConversationModel;
  onPlace?: (target: PlaceTarget) => void;
}) {
  const conversation = useModel(model);
  const stream = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <section
      className={`chat-native${dragging ? " is-dragover" : ""}`}
      onDragOver={event => {
        if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        void conversation.composer.addFiles(event.dataTransfer?.files);
      }}
    >
      {conversation.noticeVisible && (
        <div className="chat-notice">
          <span>{NOTICE_TEXT}</span>
          <button type="button" className="chat-notice-close" onClick={() => conversation.dismissNotice()}>
            知道了
          </button>
        </div>
      )}
      <Transcript model={model} onPlace={onPlace} streamRef={stream} />
      <SelectionToolbar model={model} stream={stream} />
      <Composer model={model} />
      {/* Inside the page, not the transcript: a card is beside the conversation
          it explains, and a scroll of the transcript must not carry it away. */}
      <DetailCards model={model} />
      <StopConfirmDialog model={model} />
    </section>
  );
}

/** A stop the main process refused to guess about. `other-scene` names the
 * conversation that owns the breath, `unknown` means a bubble just closed and
 * the next speaker is not known yet (docs/desktop-message-layer.md §四). Only
 * the user's answer here turns into `force: true`. */
function StopConfirmDialog({ model }: { model: ConversationModel }) {
  const conversation = useModel(model);
  const confirm = conversation.confirm;
  // The page goes away when the settings lose their token, taking the <dialog>
  // element with it — no close event, no answer. Answer for it, or the model
  // waits forever and the stop button never comes back.
  useEffect(() => () => model.cancelConfirm(), [model]);
  return (
    <Dialog
      className="utility-dialog"
      aria-label="停止回复"
      open={Boolean(confirm)}
      onClose={() => confirm?.resolve(false)}
    >
      <div className="chat-confirm">
        <p>{confirm?.message || ""}</p>
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={() => confirm?.resolve(false)}>取消</button>
          <button type="button" className="primary" onClick={() => confirm?.resolve(true)}>停止回复</button>
        </div>
      </div>
    </Dialog>
  );
}
