// What used to be the postMessage bridge into the sandboxed Loom document is
// now a wiring between two models in the same window. New on 2026-09-16, and it
// keeps `AppModel.post` as the shell's outbound channel on purpose: the
// companion panel, the Town layer and the search panel all speak through it,
// and their contracts (and their tests) do not change just because the other
// end is no longer an iframe. See desktop/renderer/app/hooks/use-chat-bridge.ts
// for the version that talked to `beings://chat`.
import { useEffect, useLayoutEffect } from "react";
import type { AppModel } from "../models/app";
import { useModel } from "../../shared/hooks/use-model";
import type { ConversationModel } from "../../conversation/models/conversation";

/**
 * Call this from a component that renders nothing. It subscribes to the
 * conversation model, so its effects re-run when a projection or a connection
 * state lands — and because the component has no output, a reply arriving one
 * token at a time does not re-render the rest of the shell.
 */
export function useConversationBridge(app: AppModel, conversation: ConversationModel) {
  useModel(conversation);
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
  // ⌘F searches what this conversation has actually said. `chatSource` is a
  // dependency because the effect above resets the index through `frameLoaded`
  // when the surface reloads, and that can land after a projection: without it,
  // a conversation read before the connection settled would leave ⌘F empty
  // until the next projection. (Measured: it does, on a cold start.)
  useEffect(() => {
    app.searchEntries = conversation.questions();
    app.changed();
  }, [app, app.chatSource, conversation, conversation.view]);
  // Likewise reconciled rather than assigned once: `applySnapshot` puts the
  // label back to "connecting" whenever a connection is (re)established, and
  // the equality guard makes re-running on our own write a no-op.
  useEffect(() => {
    const next = app.snapshot?.settings.hasToken ? conversation.connectionState : "";
    if (app.connection === next) return;
    app.connection = next;
    app.workspace.connection(next === "online");
    app.changed();
  }, [app, app.connection, app.snapshot, conversation, conversation.state]);
}
