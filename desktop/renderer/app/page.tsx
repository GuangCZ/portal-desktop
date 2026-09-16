import { useEffect, useLayoutEffect, useRef } from "react";
import type { AppModel } from "./models/app";
import { useModel } from "../shared/hooks/use-model";
import { useConversationBridge } from "./hooks/use-conversation-bridge";
import { Topbar } from "./components/topbar";
import { Sidebar } from "./components/sidebar";
import { ConversationPage } from "../conversation/components/conversation";
import { UpdateProgress } from "./components/update-progress";
import { SceneRibbon, Companion } from "./components/workspace";
import { Browser } from "../browser/page";
import { Portal } from "../portal/page";
import { Town } from "../town/page";
import { TownAuth } from "../town/components/auth";
import { TownComposer } from "../town/components/composer";
import { KitInstall } from "../town/components/kit-install";
import { ChatSearch } from "./components/search";
import { ConnectionSettings, ClientSettings } from "./components/settings";
import { Diagnostics } from "./components/diagnostics";
import { Dialog } from "../shared/components/dialog";
import { PlaceHeading } from "./components/navigation";
import { viewSheets, visiblePanels } from "./slots";
import logo from "../../../resources/branding/logo.png";
export function App({ model }: { model: AppModel }) {
  const app = useModel(model);
  useEffect(() => app.start(), [app]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = app.theme;
    document.documentElement.dataset.platform = app.api?.platform || "";
    document.documentElement.style.setProperty(
      "--reading-size",
      app.readingSize + "px",
    );
    document.body.dataset.view = app.view;
  }, [app.theme, app.view, app.readingSize, app.api]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const dialog = document.querySelector("dialog[open]");
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        !dialog
      ) {
        event.preventDefault();
        app.openSearch();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "1") {
        event.preventDefault();
        app.navigate("chat");
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "," && !dialog) {
        event.preventDefault();
        void app.openClientSettings();
      }
      if (event.key === "Escape" && !dialog && app.workspace.open)
        app.workspace.toggle(false);
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [app]);
  return (
    <>
      <ConversationBridge app={app} />
      <section
        id="startup-screen"
        className="startup-screen"
        aria-busy={app.startup === "loading"}
        aria-label="客户端启动"
        hidden={app.startup === "ready"}
      >
        <div className="startup-content">
          <img src={logo} alt="Being Desktop" width={56} height={56} />
          <span
            id="startup-spinner"
            className="startup-spinner"
            aria-hidden="true"
            hidden={app.startup !== "loading"}
          />
          <p id="startup-message" role="status">
            {app.startup === "error"
              ? "配置加载未完成，请重试。原配置不会被覆盖。"
              : "正在加载配置并恢复连接…"}
          </p>
          <button
            id="startup-retry"
            className="secondary"
            hidden={app.startup !== "error"}
            onClick={() => void app.initialize()}
          >
            重试
          </button>
        </div>
      </section>
      <main id="client-main" hidden={app.startup !== "ready"}>
        <div className="workspace-body">
          <Sidebar model={app} />
          <div className="workspace-stage">
            <Topbar model={app} />
            <p
              id="startup-notice"
              className="startup-notice"
              role="status"
              hidden={!app.snapshot?.notice}
            >
              {app.snapshot?.notice || ""}
            </p>
            <SceneRibbon model={app.workspace} />
            <section id="chat-view" className="view">
              <div
                id="welcome"
                hidden={!app.snapshot || app.snapshot.settings.hasToken}
              >
                <div className="welcome-intro">
                  <img
                    className="welcome-logo"
                    src={logo}
                    alt="Being Desktop"
                    width={88}
                    height={88}
                  />
                  <h1>从一个想法开始</h1>
                  <p>连接你的 Being，继续对话。</p>
                </div>
                <button
                  className="welcome-connect"
                  id="connect-button"
                  onClick={() => app.showSettings()}
                >
                  <span>连接我的 Being</span>
                  <span className="welcome-connect-arrow" aria-hidden="true">
                    ↗
                  </span>
                </button>
              </div>
              {app.snapshot?.settings.hasToken && (
                <ConversationPage
                  model={app.conversation}
                  onPlace={(target) => app.navigate(target.view, target.id)}
                />
              )}
            </section>
          </div>
          <Companion model={app.workspace} />
          <Browser model={app} />
          {/* Feature panels (slots.tsx). Each owns its own chrome and decides when
              it is on screen; the shell only mounts it. */}
          {visiblePanels(app).map(({ key, Panel }) => (
            <Panel key={key} app={app} />
          ))}
        </div>
      </main>
      <Diagnostics model={app} />
      <Dialog
        id="place-sheet"
        aria-labelledby="view-title"
        open={app.view !== "chat"}
        onClose={() => app.navigate("chat")}
        dismissOnBackdrop
      >
        <PlaceHeading view={app.view} navigate={app.navigate} />
        <Portal model={app} />
        <Town model={app.town} />
        {/* Feature sheets (slots.tsx): one full page per registered view. */}
        {viewSheets(app.view).map(({ key, Sheet }) => (
          <Sheet key={key} app={app} />
        ))}
      </Dialog>
      <ChatSearch model={app} />
      <TownComposer model={app.town} />
      <TownAuth model={app.town} />
      <ClientSettings model={app} />
      <ConnectionSettings model={app} />
      <KitInstall model={app.town} />
      <UpdateProgress activity={app.update?.activity} onCancel={() => void app.run(() => app.api.cancelUpdate())} />
      <Toast message={app.toastMessage} />
    </>
  );
}

/** The conversation layer's wiring into the shell. It renders nothing on
 * purpose: it subscribes to a model that changes on every streamed token, and
 * the topbar, the sidebar and the Town sheet have no business re-rendering for
 * that. */
function ConversationBridge({ app }: { app: AppModel }) {
  useConversationBridge(app, app.conversation);
  return null;
}

function Toast({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const toast = ref.current;
    if (!toast) return;
    if (message) {
      if (typeof toast.showPopover === "function" && !toast.matches(":popover-open"))
        toast.showPopover();
    } else if (typeof toast.hidePopover === "function" && toast.matches(":popover-open")) {
      toast.hidePopover();
    }
  }, [message]);
  return (
    <div ref={ref} id="toast" popover="manual" role="status" aria-live="polite">
      {message}
    </div>
  );
}
