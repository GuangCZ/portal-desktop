// The composer: the pill, the image tray above it, the quoted selections
// inside it, the `/` and `@` menu over it, and the status lines under it.
// Ported from BeingDesktop 0.8.26 renderer/chat-app.js (`build`'s `#input-area`,
// `renderTray`, `renderReferences`, the paste and drop handlers) and
// renderer/chat-composer.js (the input listeners and `keydown`); 2026-09-16.
import { useEffect, useRef } from "react";
import { useModel } from "../../shared/hooks/use-model";
import type { ConversationModel } from "../models/conversation";
import { IMAGE_TYPES } from "../models/composer";
import { ComposerMenu, ComposerNotice, MENU_ID, optionId } from "./composer-menu";
import { ReferenceChip } from "./messages";

export function Composer({ model }: { model: ConversationModel }) {
  const conversation = useModel(model);
  const composer = useModel(conversation.composer);
  const menu = useModel(conversation.menu);
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
  // Where the caret goes back to after a quotation is added or a card closed.
  useEffect(() => {
    model.focusComposer = () => input.current?.focus();
    return () => { model.focusComposer = () => {}; };
  }, [model]);

  /** Recompute the notice and the menu against the draft and the caret. A caret
   * of `null` — unfocused, disabled, or still inside an input method's commit —
   * closes the menu without touching the notice (chat-composer.js line 57). */
  const sync = (open = true) => {
    const node = input.current;
    const text = node ? node.value : composer.text;
    const caret = open && node && !node.disabled && document.activeElement === node && !composer.settling
      ? { start: node.selectionStart, end: node.selectionEnd }
      : null;
    conversation.menu.sync(text, caret);
  };
  // The draft can change from outside the textarea — a restored failure, a
  // switched conversation, a quotation placed by the companion panel.
  useEffect(() => { sync(); });

  const choose = (index: number) => {
    const node = input.current;
    if (!node) return;
    const result = conversation.menu.choose(index, node.value, { start: node.selectionStart, end: node.selectionEnd });
    if (!result) return;
    conversation.composer.setText(result.text);
    // The DOM goes first so the caret lands in the new text rather than in what
    // React has not re-rendered yet.
    node.value = result.text;
    node.setSelectionRange(result.caret, result.caret);
    node.focus();
    conversation.menu.sync(result.text, { start: result.caret, end: result.caret });
  };

  const send = (trusted: boolean) => void conversation.send(trusted);
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
        // A submit that did not come through the send button is never trusted:
        // `requestSubmit()` is something a script can call, and a public mention
        // is not something a script may cause (chat-app.js line 181).
        onSubmit={event => { event.preventDefault(); send(false); }}
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
        <ComposerMenu model={model} onChoose={choose} onRetry={() => void conversation.directory.load(true)} />
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
          placeholder="输入消息，/ 调用 Kit，@ 通知 Being"
          aria-label="给 Being 发消息，Enter 发送，Shift+Enter 换行"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={MENU_ID}
          aria-expanded={menu.open}
          aria-activedescendant={menu.open ? optionId(menu.selected) : undefined}
          disabled={disabled}
          value={composer.text}
          onChange={event => { composer.setText(event.target.value); sync(); }}
          onClick={() => sync()}
          onKeyUp={() => sync()}
          onFocus={() => sync()}
          onBlur={() => sync(false)}
          onCompositionStart={() => { composer.startComposition(); sync(false); }}
          onCompositionEnd={() => { composer.endComposition(); sync(); }}
          onKeyDown={event => {
            // An input method owns this key press. 0.8.26 swallows the Enter
            // that accepts a candidate through the 50ms window after
            // `compositionend`, because several methods report it as a plain key
            // press with `isComposing` already false (chat-composer.js lines 98
            // and 142). A swallowed Enter is not prevented — the textarea keeps
            // whatever was just committed.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composer.settling) return;
            if (menu.open) {
              if (event.key === "Escape") { event.preventDefault(); conversation.menu.dismiss(); return; }
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && menu.items.length) {
                event.preventDefault();
                conversation.menu.move(event.key === "ArrowDown" ? 1 : -1);
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                // An open menu owns Enter: it chooses, it does not send.
                event.preventDefault();
                if (menu.items.length) choose(menu.selected); else conversation.menu.dismiss();
                return;
              }
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            send(event.nativeEvent.isTrusted);
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
          // The click carries whether a person made it, and stops the form's own
          // submit so the message is not sent twice (chat-app.js line 180).
          onClick={event => { event.preventDefault(); send(event.nativeEvent.isTrusted); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
      <div className="chat-phase" role="status">{conversation.status}</div>
      <ComposerNotice model={model} />
    </div>
  );
}
