// The sidebar footer's two static pages, and the dialog they open in;
// 2026-09-16 (integration unit I6).
//
// This is the whole of this unit's surface in the shell: one entry in
// `SIDEBAR_SLOTS` (app/slots.tsx). BeingDesktop 0.8.26 reaches its「关于」the same
// way — from the profile row at the bottom of the sidebar (renderer/sidebar.js's
// `profileMenu`) — and a dialog rather than a page keeps whatever the user was
// reading behind it.
//
// The stylesheet is imported here rather than from renderer/main.tsx: main.tsx is
// the shell's and this unit owns nothing in it.
import { useModel } from "../../shared/hooks/use-model";
import { Dialog } from "../../shared/components/dialog";
import type { AppModel } from "../../app/models/app";
import { NO_SHELL_STATE } from "../models/shell-state";
import { AboutPage } from "./about";
import { PrivacyPage } from "./privacy";
import "../styles.css";

export function ShellPagesSection({ app }: { app: AppModel }) {
  // A model that failed to build is not on `AppModel` at all — the shell catches
  // that and carries on (app/models/app.ts) — so these two pages fall back to an
  // inert one rather than being the thing that empties the window.
  const shell = useModel(app.features.shellState ?? NO_SHELL_STATE);
  const page = shell.page;
  return (
    <div className="shell-links">
      <button type="button" id="open-about" className="shell-link" onClick={() => shell.open("about")}>
        关于
      </button>
      <span aria-hidden="true">·</span>
      <button type="button" id="open-privacy" className="shell-link" onClick={() => shell.open("privacy")}>
        隐私
      </button>
      <Dialog
        id="shell-page-dialog"
        className="utility-dialog"
        aria-label={page === "privacy" ? "隐私说明" : "关于 Being Desktop"}
        open={page !== ""}
        onClose={() => shell.open("")}
        dismissOnBackdrop
      >
        <div className="dialog-heading">
          <h2>{page === "privacy" ? "隐私说明" : "关于"}</h2>
          <button
            type="button"
            id="close-shell-page"
            className="close"
            aria-label="关闭"
            onClick={() => shell.open("")}
          />
        </div>
        <div className="dialog-body">
          {page === "privacy" ? <PrivacyPage app={app} /> : page === "about" ? <AboutPage app={app} /> : null}
        </div>
      </Dialog>
    </div>
  );
}
