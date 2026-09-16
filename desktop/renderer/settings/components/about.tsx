// 关于 Being Desktop. New in the portal-desktop shell on 2026-09-16 (integration
// unit I6); BeingDesktop 0.8.26 shows the same four facts in its「关于」settings
// section (renderer/index.html line 363, renderer/app.js line 1319) alongside the
// update panel, which this client keeps in 设置 › 通用 instead.
//
// Everything on this page is read from state the shell already holds — the
// version from `updateState()`, the identity from the snapshot — so it adds no
// channel of its own and is correct the moment it opens.
import type { AppModel } from "../../app/models/app";

export function AboutPage({ app }: { app: AppModel }) {
  const version = app.update?.currentVersion || "";
  const settings = app.snapshot?.settings;
  return (
    <div className="shell-page" id="about-page">
      <h3>Being Desktop</h3>
      <p className="field-help">
        你自己的 Being 的桌面客户端：原生对话、小镇、以及这台机器上的 Portal。
        对话与本机记录都留在这台机器上，Being 的记忆在 Being 那边。
      </p>
      <dl className="shell-facts">
        <div>
          <dt>版本</dt>
          <dd id="about-version">{version || "读取中…"}</dd>
        </div>
        <div>
          <dt>运行平台</dt>
          <dd id="about-platform">{app.api?.platform || "未知"}</dd>
        </div>
        <div>
          <dt>当前 Being</dt>
          <dd id="about-being">{settings?.hasToken ? settings.being || "已连接" : "尚未连接"}</dd>
        </div>
        <div>
          <dt>Desktop 身份</dt>
          {/* desktop-id.json: one persistent UUID per profile. Conversations are
              named with it (main/chat/being-chat.ts `sceneId`), so it is how a
              Being tells this client's scenes from another machine's. */}
          <dd id="about-desktop-id" className="shell-mono">{app.snapshot?.desktopId || "不可用"}</dd>
        </div>
      </dl>
      <p className="field-help">
        这台机器的每个会话都以 Desktop 身份命名场景；换一台机器就是另一套场景，Being 能分得清。
        检查更新在「设置 › 通用」里。
      </p>
    </div>
  );
}
