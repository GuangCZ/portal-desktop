import { useLayoutEffect, useRef } from "react";
import { definitions } from "../models/town";

const places = [
  ["bonfire", "篝火"], ["firesides", "围炉"], ["mail", "私信"],
  ["seeds", "花园"], ["embers", "书架"], ["scrolls", "卷轴"],
  ["kits", "工具库"], ["town", "广场"],
] as const;

export function PlaceHeading({ view, navigate }: { view: string; navigate: (view: string) => void }) {
  const nav = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const menu = nav.current;
    const selected = menu?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    if (!menu || !selected) return;
    const left = selected.offsetLeft, right = left + selected.offsetWidth;
    if (left < menu.scrollLeft) menu.scrollLeft = left;
    else if (right > menu.scrollLeft + menu.clientWidth) menu.scrollLeft = right - menu.clientWidth;
  }, [view]);
  return (
    <header className="place-sheet-heading">
      <div className="place-sheet-title-row">
        <h1 id="view-title">{definitions[view]?.title || (view === "portal" ? "Portal 设置" : "对话")}</h1>
        <button id="back-to-chat" className="icon-button close" aria-label="回到对话" title="回到对话"
          onClick={() => navigate("chat")} />
      </div>
      <nav className="place-switcher" aria-label="小镇功能切换" ref={nav}>
        {places.map(([target, label]) => (
          <button type="button" key={target} aria-current={view === target ? "page" : undefined}
            onClick={() => navigate(target)}>{label}</button>
        ))}
      </nav>
    </header>
  );
}
