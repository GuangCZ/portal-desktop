// Where the message channel and the Town feature catalogue attach to the shell;
// 2026-09-16 (integration plan §2.4).
//
//   panel  `channel`   the channel page and the feature catalogue, two tabs
//   top    `channel`   the control that opens it
//
// DEVIATION from integration plan §3.7, which left the choice open («看 BD 是页面
// 还是面板，照 BD») — BeingDesktop's Channel IS a full page (a `ta-module` inside
// its Town app), so a SHEET slot is the faithful answer, and it is not the one
// taken here. A sheet's heading is rendered by the shell from `definitions` in
// desktop/renderer/town/models/town.ts: an unlisted view opens under the title
//「对话」, and ADDING a row there does more than name it — `TownModel.show()` and
// `navigate()` both branch on that table and would start a Town read for a page
// that has nothing to read (models/town.ts lines 468-474 and 653). That file is
// I1's. So: a dockable panel, honestly titled, exactly as I4 did with the same
// constraint (docs/migration/i4-orchestration-features.md「与方案的偏差」). One row
// in `definitions` plus a `feedKind` exemption is all a later unit needs to move
// it to a full page.
import "./styles.css";
import { ChannelPage } from "./components/channel-page";
import type { PanelSlot, TopbarSlot } from "../app/slots";
import type { AppModel } from "../app/models/app";

export const channelPanel: PanelSlot = {
  key: "channel",
  title: "消息渠道",
  order: 500,
  visible: app => app.features.channel?.open === true,
  Panel: ({ app }) => <ChannelPage model={app.features.channel} />,
};

export const channelAction: TopbarSlot = {
  key: "channel",
  order: 500,
  Action: ({ app }) => <Action app={app} />,
};

function Action({ app }: { app: AppModel }) {
  const channel = app.features.channel;
  if (!channel) return null;
  return (
    <button
      type="button"
      className="topbar-icon-button"
      aria-label="消息渠道"
      aria-pressed={channel.open}
      title="消息渠道"
      onClick={() => channel.show(!channel.open)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v6A2.5 2.5 0 0 1 17.5 16H12l-4.5 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5z" />
      </svg>
    </button>
  );
}
