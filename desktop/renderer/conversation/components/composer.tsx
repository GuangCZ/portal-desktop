// The composer: the pill, the image tray above it, the quoted selections
// inside it, and the status line under it. Ported from BeingDesktop 0.8.26
// renderer/chat-app.js (`build`'s `#input-area`, `renderTray`,
// `renderReferences`, the paste and drop handlers); 2026-09-16.
import { useEffect, useRef } from "react";
import { useModel } from "../../shared/hooks/use-model";
import type { ConversationModel } from "../models/conversation";
import { IMAGE_TYPES } from "../models/composer";
import { ReferenceChip } from "./messages";

export function Composer({ model }: { model: ConversationModel }) {
  const conversation = useModel(model);
  const composer = useModel(conversation.composer);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const disabled = conversation.disabled;
  // The textarea grows with its content in CSS; older engines get the same by hand.
  useEffect(() => {
    const node = input.current;
    if (!node || CSS.supports?.("field-sizing", "content")) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 210)}px`;
  }, [composer.text]);
  const send = () => void conversation.send();
  return (
    <div className="chat-composer-area">
      <div className="chat-tray" aria-label="待发送的图片" hidden={!composer.images.length && !composer.reading}>
        {composer.images.map(image => (
          <div className="chat-tray-item" key={image.id}>
            {image.thumb
              ? <img className="chat-image" src={image.thumb} alt={image.name} title={image.name} />
              : <span className="chat-image chat-image-name">{image.name}</span>}
            <button
              type="button"
              className="chat-tray-remove"
              title="移除"
              aria-label={`移除 ${image.name}`}
              onClick={() => { composer.removeImage(image.id); input.current?.focus(); }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="chat-tray-note">
          {composer.reading
            ? `正在读取 ${composer.reading} 张图片…`
            : composer.images.length
              ? `${composer.images.length} 张图片将随下一条消息发送 · Being 只在这一轮看到它们，记录里保留缩略图`
              : ""}
        </div>
      </div>
      <form
        className={`chat-composer${composer.references.length ? " has-references" : ""}`}
        onSubmit={event => { event.preventDefault(); send(); }}
      >
        {!!composer.references.length && (
          <div className="chat-composer-references">
            <ReferenceChip
              references={composer.references}
              onRemove={index => { composer.removeReference(index); input.current?.focus(); }}
              onRemoveAll={() => { composer.clearReferences(); input.current?.focus(); }}
            />
          </div>
        )}
        <button
          type="button"
          className="chat-attach"
          title="添加图片 · 也可粘贴或拖入 · 每条消息最多 10 MB"
          aria-label="添加图片"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
          </svg>
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="选择图片"
          onChange={event => {
            void composer.addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <textarea
          ref={input}
          className="chat-input"
          rows={1}
          placeholder="随意输入…"
          aria-label="给 Being 发消息，Enter 发送，Shift+Enter 换行"
          disabled={disabled}
          value={composer.text}
          onChange={event => composer.setText(event.target.value)}
          onCompositionStart={() => composer.startComposition()}
          onCompositionEnd={() => composer.endComposition()}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // The Enter that accepts an input method's candidate is reported as
            // a plain key press by several of them: `isComposing` is already
            // false by the time it arrives. 0.8.26 swallowed it through the
            // 50ms window after `compositionend` (chat-composer.js lines 98 and
            // 142) and, like there, a swallowed Enter is not prevented — the
            // textarea keeps whatever the input method just committed.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composer.settling) return;
            event.preventDefault();
            send();
          }}
          onPaste={event => {
            const files = [...(event.clipboardData?.files || [])].filter(file => IMAGE_TYPES.test(file.type));
            if (!files.length) return;
            event.preventDefault();
            void composer.addFiles(files);
          }}
        />
        {/* Hidden rather than disabled when idle: there is nothing to stop, and
            a lit button would say otherwise (chat-app.js line 315). */}
        <button
          type="button"
          className="chat-stop"
          title="停止生成"
          aria-label="停止生成"
          hidden={!conversation.stopVisible}
          disabled={conversation.stopping}
          onClick={() => void conversation.stop()}
        >
          ■
        </button>
        <button
          type="submit"
          className="chat-send"
          title="发送"
          aria-label="发送"
          disabled={disabled || conversation.sending}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
      <div className="chat-phase" role="status">{conversation.status}</div>
    </div>
  );
}
