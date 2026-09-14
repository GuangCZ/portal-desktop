import type { TownModel } from "../models/town";

/** Shared link controls for scrolls, books and seeds. */
export function ReadingActions({ town, route }: { town: TownModel; route: string }) {
  return (
    <div className="reading-actions" aria-label="文档操作">
      <button className="secondary" onClick={() => void town.run(async () => {
        await town.api.copyText(`https://beings.town${route}`);
        town.toast("链接已复制");
      })}>复制链接</button>
      <button className="secondary" onClick={() => void town.run(() => town.api.openTownLink(route))}>
        浏览器打开 ↗
      </button>
    </div>
  );
}
