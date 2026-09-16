import { Store } from "../../shared/models/store";
import { SceneStore, type SceneView } from "../../shared/models/scene";
import type { Snapshot } from "../../../shared/types";
/**
 * The companion panel: what the user is looking at elsewhere in the client, and
 * the quotation they chose to bring into the conversation.
 *
 * Until 2026-09-16 it also spoke a capture protocol with the sandboxed Loom
 * document — the page told the shell which message the user had selected, and
 * announced every send so the shell could file an environment envelope beside
 * it. The conversation is native now and carries its own references
 * (`shared/chat-references.ts`), so all that is left here is the outbound half:
 * `compose()` offers a quotation, and the conversation answers whether its
 * draft was empty enough to take it.
 */
export class WorkspaceModel extends Store {
  readonly scenes = new SceneStore();
  open = false;
  draftRequest = "";
  private timer?: ReturnType<typeof setTimeout>;
  private online = false;
  constructor(
    private navigate: (view: string) => void,
    private toast: (message: unknown) => void,
    private post: (data: unknown) => void,
    private hasFrame: () => boolean,
  ) {
    super();
  }
  start() {
    const reset = () => {
      this.open = false;
      this.draftRequest = "";
      clearTimeout(this.timer);
      this.changed();
    };
    this.scenes.addEventListener("identity-reset", reset);
    this.scenes.addEventListener("change", this.changed);
    return () => {
      clearTimeout(this.timer);
      this.scenes.removeEventListener("identity-reset", reset);
      this.scenes.removeEventListener("change", this.changed);
    };
  }
  toggle(open = !this.open) {
    this.open = open;
    this.changed();
  }
  enter(view: string) {
    this.scenes.enter(view as SceneView);
    if (view === "chat") this.connection(this.online);
    if (view === "portal")
      this.scenes.update({
        status: "ready",
        scope: "本机进程与日志观察；工具可用性待 Heart 确认",
        identity: this.scenes.being,
      });
  }
  connection(online: boolean) {
    this.online = online;
    if (this.scenes.current.view === "chat")
      this.scenes.update({
        status: online ? "ready" : "loading",
        scope: "当前对话；场景元信息尚未传给 Heart",
      });
  }
  snapshot(snapshot: Snapshot) {
    this.scenes.configure(snapshot.settings.being, snapshot.settings.endpoint);
    if (this.scenes.current.view === "portal")
      this.scenes.update({
        status: "ready",
        scope: "本机进程与日志观察；工具可用性待 Heart 确认",
        identity: snapshot.settings.being,
      });
    this.changed();
  }
  clear() {
    this.scenes.reference = null;
    this.scenes.update({ selection: undefined });
    this.scenes.event("清除了讨论对象");
    this.toggle(false);
  }
  returnToSource() {
    const ref = this.scenes.reference;
    if (ref) {
      this.navigate(ref.view);
      this.scenes.event("返回来源页面", ref.title, "引用保留发送前版本");
    }
  }
  receive(message: Record<string, unknown>) {
    if (
      message.type === "beings:scene-draft-result" &&
      message.id === this.draftRequest &&
      this.draftRequest
    ) {
      clearTimeout(this.timer);
      this.draftRequest = "";
      if (message.ok) {
        this.scenes.event(
          "引用已放入对话草稿",
          this.scenes.reference?.title,
          "尚未发送",
        );
        this.navigate("chat");
        this.toggle(false);
      } else {
        this.toast("对话输入框已有草稿，请先处理原草稿，再放入引用。");
      }
      this.changed();
    }
  }
  compose() {
    if (this.draftRequest) return;
    const scene =
      this.scenes.reference ||
      (this.scenes.current.selection
        ? structuredClone(this.scenes.current)
        : null);
    if (!scene?.selection) return;
    if (!this.scenes.being || !this.hasFrame()) {
      this.toast("请先连接对话 Being。");
      return;
    }
    // Explicitly choosing a quotation authorizes placing it in the current
    // chat draft, regardless of Town identity. The user still decides to send.
    this.scenes.reference = structuredClone(scene);
    const resource = scene.selection;
    const text = `一起看看${scene.title}里的这段${resource.author ? `（${resource.author}）` : ""}：\n\n${resource.excerpt
      .split("\n")
      .map((line) => "> " + line)
      .join("\n")}`;
    this.draftRequest = crypto.randomUUID();
    this.changed();
    this.post({
      type: "beings:scene-draft",
      id: this.draftRequest,
      text,
      expiresAt: Date.now() + 2500,
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.draftRequest) {
        this.draftRequest = "";
        this.changed();
        this.toast("对话页面尚未准备好，请稍后重试。");
      }
    }, 3000);
  }
}
