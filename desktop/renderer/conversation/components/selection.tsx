// The toolbar that appears over a selected passage. Ported from BeingDesktop
// 0.8.26 renderer/chat-selection.js (`install`'s `toolbar`, `capture`, `hide`
// and the document listeners); 2026-09-16.
//
// Two actions, both about the passage and nothing else:「添加到对话」quotes it
// into the next message, and「更多详情」opens a temporary conversation about it.
// Neither ever moves the reader somewhere else.
//
// The positioning rule is the one test/chat-selection-ui.cjs asserts and the one
// worth keeping: the toolbar never covers the text it is about. It goes above
// the first line of the selection when there is room inside the transcript, and
// under the last line when there is not.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useModel } from "../../shared/hooks/use-model";
import type { ChatReference } from "../../../shared/chat-references";
import type { ConversationModel } from "../models/conversation";

interface Selected {
  sessionId: string;
  reference: ChatReference;
  /** Viewport coordinates, captured with the selection: the first visible line
   * of it, the bottom of the last, and the transcript it lives in. */
  top: number;
  left: number;
  bottom: number;
  bounds: { top: number; left: number; right: number; bottom: number };
}

export function SelectionToolbar({ model, stream }: {
  model: ConversationModel;
  stream: RefObject<HTMLDivElement | null>;
}) {
  const conversation = useModel(model);
  const toolbar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  // A drag in progress is not a selection yet: 0.8.26 waits for the pointer to
  // come up before offering anything (chat-selection.js line 89).
  const pressing = useRef(false);
  const frame = useRef<number | null>(null);
  const session = conversation.activeId;

  const capture = useCallback(() => {
    frame.current = null;
    const node = stream.current;
    if (pressing.current || !node) return;
    const current = window.getSelection();
    if (!current?.rangeCount || current.isCollapsed || !current.toString().trim()) return setSelected(null);
    const range = current.getRangeAt(0);
    const start = range.startContainer;
    const element = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
    const body = element?.closest(".chat-body");
    // Inside one message's body, and inside this transcript: a selection that
    // starts in the transcript and ends in the composer is not a quotation.
    if (!body || !node.contains(body) || !body.contains(range.endContainer)) return setSelected(null);
    const bounds = node.getBoundingClientRect();
    const rects = [...range.getClientRects()]
      .filter(rect => rect.width && rect.height && rect.bottom > bounds.top && rect.top < bounds.bottom);
    const first = rects[0], last = rects.at(-1);
    if (!first || !last) return setSelected(null);
    setSelected({
      sessionId: session,
      reference: { text: current.toString(), source: body.closest(".is-user") ? "you" : "Being" },
      top: first.top, left: first.left, bottom: last.bottom,
      bounds: { top: bounds.top, left: bounds.left, right: bounds.right, bottom: bounds.bottom },
    });
  }, [session, stream]);

  const dismiss = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelected(null);
  }, []);

  useEffect(() => {
    const schedule = () => { if (frame.current === null) frame.current = requestAnimationFrame(capture); };
    const node = stream.current;
    const down = (event: PointerEvent) => {
      if (node?.contains(event.target as Node)) pressing.current = true;
      else if (!toolbar.current?.contains(event.target as Node)) setSelected(null);
    };
    const up = () => { pressing.current = false; schedule(); };
    const cancel = () => { pressing.current = false; setSelected(null); };
    const hide = () => setSelected(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !toolbar.current || toolbar.current.hidden) return;
      event.preventDefault();
      dismiss();
      model.focusComposer();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", keydown);
    node?.addEventListener("scroll", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", keydown);
      node?.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [capture, dismiss, model, stream]);

  // A conversation that is no longer on screen has no selection to act on.
  useEffect(() => { setSelected(null); }, [session]);

  // Position after the toolbar has a size, and never over the passage itself.
  useLayoutEffect(() => {
    const node = toolbar.current;
    if (!node || !selected) return;
    const { bounds } = selected;
    const width = node.offsetWidth, height = node.offsetHeight;
    node.style.left = `${Math.max(bounds.left + 8, Math.min(selected.left, bounds.right - width - 8))}px`;
    const above = selected.top - height >= bounds.top + 4;
    const top = above ? Math.max(bounds.top + 4, selected.top - height - 8) : selected.bottom + 8;
    node.style.top = `${Math.max(bounds.top + 4, Math.min(top, bounds.bottom - height - 4))}px`;
  }, [selected]);

  const act = (run: (value: Selected) => void) => () => {
    // The conversation moved under the selection: the passage belongs to a
    // transcript nobody is reading.
    if (!selected || selected.sessionId !== model.activeId) return setSelected(null);
    run(selected);
  };

  return (
    <div
      ref={toolbar}
      className="chat-selection-toolbar"
      role="toolbar"
      aria-label="所选文本操作"
      hidden={!selected}
      onPointerDown={event => event.preventDefault()}
    >
      <button
        type="button"
        disabled={conversation.disabled}
        onClick={act(value => {
          if (!model.addSelection(value.reference)) return;
          dismiss();
          model.focusComposer();
        })}
      >
        添加到对话
      </button>
      <button
        type="button"
        disabled={conversation.disabled}
        onClick={act(value => {
          dismiss();
          void model.details.open(value.sessionId, value.reference);
        })}
      >
        更多详情
      </button>
    </div>
  );
}
