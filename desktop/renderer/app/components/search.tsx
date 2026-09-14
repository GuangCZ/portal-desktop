import { useEffect, useRef } from "react";
import type { AppModel } from "../models/app";
import { useModel } from "../../shared/hooks/use-model";
import { Dialog } from "../../shared/components/dialog";
export function ChatSearch({ model }: { model: AppModel }) {
  const app = useModel(model),
    input = useRef<HTMLInputElement>(null),
    results = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const query = app.search.trim().toLocaleLowerCase(),
    matches = query
      ? app.searchEntries.filter((entry) =>
          entry.text.toLocaleLowerCase().includes(query),
        )
      : [];
  const close = () => {
    app.searchOpen = false;
    app.changed();
    document.getElementById("options-trigger")?.focus();
  };
  useEffect(() => {
    if (app.searchOpen) input.current?.focus();
    else if (wasOpen.current)
      document.getElementById("options-trigger")?.focus();
    wasOpen.current = app.searchOpen;
  }, [app.searchOpen]);
  return (
    <Dialog
      id="chat-search-panel"
      aria-label="查找对话"
      open={app.searchOpen}
      onClose={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        const buttons = [
            ...results.current!.querySelectorAll<HTMLButtonElement>("button"),
          ],
          index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.target === input.current && event.key === "Enter") {
          event.preventDefault();
          buttons[0]?.click();
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (index <= 0) input.current?.focus();
          else buttons[index - 1]?.focus();
        }
      }}
    >
      <div className="chat-search-field">
        <input
          id="chat-search-input"
          ref={input}
          type="search"
          placeholder="查找对话中的提问…"
          aria-label="查找提问"
          autoComplete="off"
          value={app.search}
          onChange={(event) => {
            app.search = event.target.value;
            app.changed();
          }}
        />
        <button
          id="close-chat-search"
          className="icon-button close"
          aria-label="关闭查找"
          onClick={close}
        />
      </div>
      <div
        id="chat-search-results"
        ref={results}
        role="list"
        aria-label="提问搜索结果"
      >
        {matches.map((entry) => (
          <div role="listitem" key={entry.id}>
            <button
              className="chat-search-result"
              title={entry.text}
              onClick={() => {
                close();
                app.navigate("chat");
                app.post({ type: "beings:search-jump", id: entry.id });
              }}
            >
              {entry.text}
            </button>
          </div>
        ))}
      </div>
      <p id="chat-search-status" role="status">
        {!query
          ? "输入关键词查找已加载的提问"
          : matches.length
            ? `${matches.length} 条匹配的提问`
            : "没有匹配的提问"}
      </p>
    </Dialog>
  );
}
