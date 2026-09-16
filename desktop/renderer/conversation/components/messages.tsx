// The transcript. Ported from BeingDesktop 0.8.26 renderer/chat-app.js
// (`bubble`, `activityLine`, `preview`, `render`) and renderer/chat-selection.js
// (`referenceChip`); 2026-09-16. The markup mirrors what Loom's page looked like
// under Desktop's theme (src/loom-theme.css): a meta line
// ("you · 13:44:23" / "<being> · 13:44:23"), the content below it, consecutive
// messages grouped, a "— 13:40:01 —" divider after a long silence, thinking
// dots before the first token.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { Markdown } from "../../shared/components/markdown";
import type { PlaceTarget } from "../../shared/lib/navigation";
import { decode, type ChatReference } from "../../../shared/chat-references";
import type { ChatRowImage } from "../../../shared/desktop-types";
import { useModel } from "../../shared/hooks/use-model";
import type { Activity, ConversationModel } from "../models/conversation";
import { clock, type TranscriptItem } from "../models/transcript";
import { WorkerResultCard } from "./worker-result";

/** One image as the transcript keeps it: the preview the renderer made, or the
 * name when the preview did not fit. History never returns images (measured
 * 2026-09-11, docs/desktop-message-layer.md §十), so this is all there is. */
function Preview({ image }: { image: ChatRowImage }) {
  return image.thumb
    ? <img className="chat-image" src={image.thumb} alt={image.name || "图片"} title={image.name || ""} />
    : <span className="chat-image chat-image-name">{image.name || "图片"}</span>;
}

/** The quoted selections travelling with a message, folded to a count until
 * opened. The full text stays available: a quotation the Being was asked about
 * should be readable next to its answer. */
export function ReferenceChip({ references, onRemove, onRemoveAll }: {
  references: ChatReference[];
  onRemove?: (index: number) => void;
  onRemoveAll?: () => void;
}) {
  return (
    <div className="chat-reference">
      <details className="chat-reference-chip">
        <summary aria-label={`${references.length} 条引用`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 10h8M8 14h5M7 20l-3 1V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H7Z" />
          </svg>
          {references.length} 条引用
        </summary>
        <ol className="chat-reference-list" aria-label="所选文本全文">
          {references.map((reference, index) => (
            <li key={index}>
              <div className="chat-reference-source">所选文本 · {reference.source}</div>
              <div className="chat-reference-text">{reference.text}</div>
              {onRemove && (
                <button type="button" className="chat-reference-delete" onClick={() => onRemove(index)}>
                  移除此引用
                </button>
              )}
            </li>
          ))}
        </ol>
      </details>
      {onRemoveAll && (
        <button type="button" className="chat-reference-remove" aria-label="移除全部引用" onClick={onRemoveAll}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      )}
    </div>
  );
}

/**
 * The activity line Desktop drew inside the Being's row (Loom's `#tui-bar`):
 * what the Being is doing right now, and the log of this breath behind a
 * disclosure. Reasoning is shown here and never folded into the body text
 * (docs/desktop-message-layer.md §五).
 */
export function ActivityLine({ text, think, live, activity }: {
  text?: string; think?: string; live?: boolean; activity?: Activity | null;
}) {
  const current = live ? activity?.current : null;
  const label = current
    ? (current.error ? `${current.label} ✗` : current.label)
    : live ? (text ? "正在回复" : think ? "思考中" : "等待回复") : "思考过程";
  const preview = current ? current.arg : think ? think.trim().slice(-60) : "";
  const log = (live && activity?.log) || [];
  return (
    <details className="chat-think">
      <summary className="chat-think-line">
        <span className="chat-think-prompt" aria-hidden="true">⟩</span>
        <span className="chat-think-label">{label}</span>
        <span className="chat-think-preview">{preview}</span>
        {live && <span className="chat-think-cursor" aria-hidden="true">▊</span>}
      </summary>
      <div className="chat-think-body">
        {log.map((entry, index) => (
          <div className="chat-think-entry" key={index}>
            {`${entry.label} ${entry.arg} ${entry.done ? (entry.error ? "✗" : "✓") : "…"}`.trim()}
          </div>
        ))}
        {think && <div className="chat-think-text">{think}</div>}
        {!log.length && !think && <div className="chat-think-text">（没有思考过程）</div>}
      </div>
    </details>
  );
}

/** One message: meta line, the activity line while the Being works on it, content.
 * A Worker result takes the place of the content — it is the Being reporting a
 * finished task, not something it said (chat-app.js line 372). */
function Bubble({ item, beingName, activity, found, onPlace, onOpenWorker }: {
  item: TranscriptItem; beingName: string; activity: Activity | null; found: boolean;
  onPlace?: (target: PlaceTarget) => void;
  onOpenWorker: (result: { sessionId: string; workerId: string }) => void;
}) {
  const note = item.partial ? "回复中断，等待记录核对" : item.pending ? "等待记录确认" : "";
  const meta = [item.role === "user" ? "you" : beingName, clock(item.at), note].filter(Boolean).join(" · ");
  const decoded = item.role === "user" ? decode(item.text) : null;
  const text = decoded ? decoded.text : item.text;
  if (item.workerResult)
    return (
      <article data-row-id={item.id} className="chat-message is-being">
        <div className="chat-meta">{[beingName, clock(item.at)].filter(Boolean).join(" · ")}</div>
        <WorkerResultCard result={item.workerResult} onOpen={onOpenWorker} />
      </article>
    );
  return (
    <article
      data-row-id={item.id}
      className={`chat-message is-${item.role}${item.pending ? " is-pending" : ""}${item.live ? " is-live" : ""}${item.consecutive ? " is-consecutive" : ""}${found ? " is-found" : ""}`}
    >
      <div className="chat-meta">{meta}</div>
      {(item.think || item.live) && (
        <ActivityLine text={item.text} think={item.think} live={item.live} activity={activity} />
      )}
      {!!item.images?.length && (
        <div className="chat-images" aria-label={`${item.images.length} 张图片`}>
          {item.images.map((image, index) => <Preview key={index} image={image} />)}
        </div>
      )}
      {!!decoded?.references.length && <ReferenceChip references={decoded.references} />}
      {/* Loom streams escaped text and renders markdown once the moment is
          whole; so do we — a half-written fence is not a code block yet. */}
      {item.live
        ? <div className="chat-body chat-body-live">{text}</div>
        : <Markdown className="chat-body reading-text" content={text} chat onPlace={onPlace} />}
    </article>
  );
}

export function Transcript({ model, onPlace, streamRef }: {
  model: ConversationModel;
  onPlace?: (target: PlaceTarget) => void;
  /** The page hands the same node to the selection toolbar, which positions
   * itself inside these bounds and never over the passage it is about. */
  streamRef?: RefObject<HTMLDivElement | null>;
}) {
  const conversation = useModel(model);
  const own = useRef<HTMLDivElement>(null);
  const stream = streamRef || own;
  const items = conversation.items;
  const live = items.at(-1)?.live === true;
  // Follow the conversation only while the user is still at the bottom of it.
  useLayoutEffect(() => {
    const node = stream.current;
    if (node && conversation.pinned) node.scrollTop = node.scrollHeight;
  });
  // The row the search panel asked for stays marked until the model lets go of
  // it, so the highlight outlives the re-render that follows the jump.
  useEffect(() => {
    const id = conversation.jumpTo;
    if (!id) return;
    stream.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => conversation.jumped(), 1600);
    return () => clearTimeout(timer);
  }, [conversation, conversation.jumpTo]);
  return (
    <div
      className="chat-stream"
      ref={stream}
      role="log"
      aria-live="polite"
      aria-label="对话记录"
      onScroll={event => {
        const node = event.currentTarget;
        conversation.setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
      }}
    >
      {items.length > 0 && conversation.session?.truncated && (
        <button
          type="button"
          className="chat-more"
          disabled={conversation.reloading}
          onClick={() => void conversation.reload()}
        >
          记录已裁剪，重新读取最新窗口
        </button>
      )}
      {items.map(item => (
        <div key={item.id} className="chat-row">
          {item.gap && <div className="time-gap">{item.gap}</div>}
          <Bubble
            item={item}
            beingName={conversation.beingName}
            activity={conversation.activity}
            found={conversation.jumpTo === item.id}
            onPlace={onPlace}
            onOpenWorker={result => void model.openWorkerResult(result)}
          />
        </div>
      ))}
      {/* Loom's thinking indicator: the Being has the message and has not said
          anything yet — three dots, or the tool it is using, until the first
          token arrives. */}
      {conversation.waiting && !live && (
        <article className="chat-message is-being chat-thinking">
          <div className="chat-meta">{conversation.beingName}</div>
          {conversation.activity?.log.length
            ? <ActivityLine live activity={conversation.activity} />
            : <div className="chat-body"><span className="chat-dot" /><span className="chat-dot" /><span className="chat-dot" /></div>}
        </article>
      )}
    </div>
  );
}
