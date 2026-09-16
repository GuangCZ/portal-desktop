import type { ChatItem } from "./chat";

export interface MessageScene {
  sceneId?: string;
  sceneLabel?: string;
}
export type HistoryScope = "current" | "all";

export function messageScene(value: unknown): MessageScene {
  if (!value || typeof value !== "object") return {};
  const data = value as Record<string, unknown>;
  const meta = data.scene_meta as Record<string, unknown> | undefined;
  const id = typeof data.scene_id === "string" ? data.scene_id : "";
  const label = data.scene_label || meta?.scene_label;
  return id ? {
    sceneId: id,
    sceneLabel: typeof label === "string" ? label.trim().slice(0, 128) || undefined : undefined,
  } : {};
}

export function sceneName(scene: MessageScene, current: MessageScene): string {
  return scene.sceneLabel || (scene.sceneId && scene.sceneId === current.sceneId ? current.sceneLabel || "当前场景" : scene.sceneId) || "未标记场景";
}

export function sceneItems(items: ChatItem[], scope: HistoryScope, current: MessageScene): ChatItem[] {
  return scope === "current" && current.sceneId
    ? items.filter(item => inCurrentScene(item, current))
    : items;
}

// Loom treats unaddressed legacy messages and autonomous breaths as shared history.
export function inCurrentScene(scene: MessageScene, current: MessageScene): boolean {
  return !current.sceneId || !scene.sceneId || scene.sceneId === current.sceneId;
}
