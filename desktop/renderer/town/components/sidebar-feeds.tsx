import type { AppModel } from "../../app/models/app";
import { useModel } from "../../shared/hooks/use-model";

/** The three feeds of the paired Town client, as sidebar rows.
 *
 * Ported from BeingDesktop renderer/sidebar.js `sidebar-bonfire` /
 * `sidebar-fireside` / `sidebar-mail`: a way into each feed from the
 * conversation, and a marker when something arrived while you were elsewhere.
 * The marker is exactly `TownModel.unread(kind)` — the same set the page's
 * 「有新内容 · 更新」button reads — so a row can never claim news the page will
 * not show, and reading the feed clears both at once.
 *
 * It is one `SIDEBAR_SLOTS` entry (../../app/slots.tsx), which is why this file
 * exists instead of a change to the shell's sidebar: the shell renders the
 * region and this owns what is in it, including its own empty state — nothing is
 * shown at all until a Being is connected. */
const FEEDS = [
  ["bonfire", "篝火", "bonfire"],
  ["firesides", "围炉", "fireside"],
  ["mail", "私信", "dm"],
] as const;

export function TownFeedLinks({ app }: { app: AppModel }) {
  const town = useModel(app.town);
  // Not paired and not connected: the rows would open a page that can only ask
  // for a pairing code. The Town page itself is still reachable from the place
  // switcher, which is where that conversation belongs.
  if (!town.paired) return null;
  return (
    // Styled inline: the sidebar's own stylesheet belongs to the conversation
    // unit, and `main.tsx` — which imports the stylesheets — is not one of this
    // unit's shared files. `sidebar-action` is reused as-is.
    <div role="group" aria-label="Town 消息" style={{ display: 'contents' }}>
      {FEEDS.map(([view, label, kind]) => {
        const unread = town.unread(kind);
        return (
          <button
            type="button"
            key={view}
            id={`sidebar-${view}`}
            className="sidebar-action"
            aria-current={app.view === view ? "page" : undefined}
            onClick={() => app.navigate(view)}
          >
            <span>{label}</span>
            {unread && (
              <span
                aria-label="有新消息"
                style={{ marginInlineStart: 'auto', width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
