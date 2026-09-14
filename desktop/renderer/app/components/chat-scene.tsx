import { useState } from "react";
import type { ChatScene } from "../../../shared/types";
import { Dialog } from "../../shared/components/dialog";

export function ChatSceneIndicator({ scene, connected, onCopy }: {
  scene?: ChatScene;
  connected: boolean;
  onCopy: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = scene?.scene_meta.scene_label || "场景标记不可用";
  return (
    <>
      <button
        id="chat-scene-indicator"
        className="chat-scene-indicator"
        type="button"
        aria-label={`当前场景：${label}，查看详情`}
        aria-haspopup="dialog"
        aria-controls="chat-scene-dialog"
        aria-expanded={open}
        title={`当前场景：${label}`}
        onClick={() => setOpen(true)}
      >
        <svg className="chat-scene-icon" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3" y="3.5" width="14" height="10" rx="2" />
          <path d="M10 13.5v3M7 16.5h6" />
        </svg>
        <span className="chat-scene-label">{scene ? "桌面" : "场景不可用"}</span>
      </button>
      <Dialog
        id="chat-scene-dialog"
        className="utility-dialog"
        aria-labelledby="chat-scene-heading"
        open={open}
        onClose={() => setOpen(false)}
        dismissOnBackdrop
      >
        <div className="dialog-heading">
          <h2 id="chat-scene-heading">当前场景</h2>
          <button className="close" type="button" aria-label="关闭场景详情" onClick={() => setOpen(false)} />
        </div>
        <p className="chat-scene-name">{label}</p>
        <p className="utility-subtitle">
          {scene
            ? connected
              ? "从这里发送的对话会带上这个场景。"
              : "连接 Being 后，发送的对话会带上这个场景。"
            : "本次聊天未附带场景信息，请查看客户端的启动提示。"}
        </p>
        {scene && <>
          <dl className="chat-scene-details">
            <dt>场景 ID</dt>
            <dd><code id="chat-scene-id">{scene.scene_id}</code></dd>
            <dt>客户端</dt>
            <dd>{scene.scene_meta.client}</dd>
          </dl>
          <div className="files-footer">
            <button id="copy-chat-scene" type="button" onClick={() => onCopy(scene.scene_id)}>复制场景 ID</button>
          </div>
        </>}
      </Dialog>
    </>
  );
}
