// What used to be the postMessage bridge into the sandboxed Loom document is
// now a wiring between two models in the same window. New on 2026-09-16, and it
// keeps `AppModel.post` as the shell's outbound channel on purpose: the
// companion panel, the Town layer and the search panel all speak through it,
// and their contracts (and their tests) do not change just because the other
// end is no longer an iframe. See desktop/renderer/app/hooks/use-chat-bridge.ts
// for the version that talked to `beings://chat`.
import { useEffect, useLayoutEffect } from "react";
import type { AppModel } from "../models/app";
import type { ConversationModel } from "../../conversation/models/conversation";

export function useConversationBridge(app: AppModel, conversation: ConversationModel) {
  useEffect(() => conversation.start(), [conversation]);
  useLayoutEffect(() => {
    app.post = (data: unknown) => {
      const message = data as Record<string, unknown> | null;
      if (!message || typeof message !== "object") return;
      if (message.type === "beings:scene-draft" && typeof message.text === "string") {
        // The workspace model is mid-call while this runs; answer after it has
        // finished setting up its own timeout, as the iframe's reply did.
        const ok = conversation.placeDraft(message.text);
        queueMicrotask(() => app.workspace.receive({ type: "beings:scene-draft-result", id: message.id, ok }));
        return;
      }
      if (message.type === "beings:search-jump" && typeof message.id === "string") conversation.jump(message.id);
    };
    return () => { app.post = () => {}; };
  }, [app, conversation]);
  // A new connection means a new conversation layer: read the newest window as a
  // fresh baseline, and let the shell stop reporting the surface as loading.
  useEffect(() => {
    if (!app.chatSource) return;
    app.frameLoaded();
    void conversation.reload();
  }, [app, app.chatSource, conversation]);
  // ⌘F searches what this conversation has actually said.
  useEffect(() => {
    app.searchEntries = conversation.questions();
    app.changed();
  }, [app, conversation, conversation.view]);
  useEffect(() => {
    const next = app.snapshot?.settings.hasToken ? conversation.connectionState : "";
    if (app.connection === next) return;
    app.connection = next;
    app.workspace.connection(next === "online");
    app.changed();
  }, [app, app.snapshot, conversation, conversation.state]);
}
