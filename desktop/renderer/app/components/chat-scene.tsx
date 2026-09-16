import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatScene } from "../../../shared/types";
import type { HistoryScope } from "../../chat/models/scenes";
import { Dialog } from "../../shared/components/dialog";

export function ChatSceneIndicator({ scene, connected, scope, scopeReady, onScope, onCopy }: {
  scene?: ChatScene;
  connected: boolean;
  scope: HistoryScope;
  scopeReady: boolean;
  onScope: (scope: HistoryScope) => void;
  onCopy: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const label = scene?.scene_meta.scene_label || "场景标记不可用";
  const closeMenu = () => { setMenuOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (menuOpen) (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') || menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  }, [menuOpen]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (!control.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const blur = () => setMenuOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const select = (value: HistoryScope) => { onScope(value); closeMenu(); };
  return (
    <>
      <div className="chat-scene-control" ref={control}>
        <button
          ref={trigger}
          id="chat-scene-indicator"
          className="chat-scene-indicator"
          type="button"
          aria-label={`对话场景：${scope === "all" ? "全部场景" : label}`}
          aria-haspopup="menu"
          aria-controls="chat-scene-menu"
          aria-expanded={menuOpen}
          title={`查看范围：${scope === "all" ? "全部场景" : label}`}
          onClick={() => setMenuOpen(value => !value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenuOpen(true); }
          }}
        >
          <svg className="chat-scene-icon" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="3" y="3.5" width="14" height="10" rx="2" />
            <path d="M10 13.5v3M7 16.5h6" />
          </svg>
          <span className="chat-scene-label">{scope === "all" ? "全部场景" : scene ? "桌面" : "场景不可用"}</span>
          <svg className="chat-scene-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
        </button>
        {menuOpen && <div id="chat-scene-menu" className="chat-scene-menu" ref={menu} role="menu" aria-label="对话场景"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
            const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            const next = event.key === "ArrowDown" ? (index + 1) % buttons.length
              : event.key === "ArrowUp" ? (index + buttons.length - 1) % buttons.length
              : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
          }}>
          <button type="button" role="menuitemradio" aria-label="当前场景" aria-checked={scope === "current"} disabled={!scopeReady || !scene} onClick={() => select("current")}>
            <span className="chat-scene-option"><span>当前场景</span><small>{label}</small></span>
            {scope === "current" && <span aria-hidden="true">✓</span>}
          </button>
          <button type="button" role="menuitemradio" aria-label="全部场景" aria-checked={scope === "all"} disabled={!scopeReady} onClick={() => select("all")}>
            <span className="chat-scene-option"><span>全部场景</span><small>查看各个场景的对话</small></span>
            {scope === "all" && <span aria-hidden="true">✓</span>}
          </button>
          <div className="chat-scene-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => { closeMenu(); setOpen(true); }}>场景详情<span aria-hidden="true">↗</span></button>
          {scene && <p className="chat-scene-menu-hint">消息发送到当前桌面场景</p>}
        </div>}
      </div>
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
            : "客户端场景不可用，暂时无法发送消息。请查看客户端的启动提示。"}
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
