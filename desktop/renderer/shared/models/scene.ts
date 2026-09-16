export type SceneView = 'chat' | 'town' | 'bonfire' | 'firesides' | 'mail' | 'seeds' | 'embers' | 'scrolls' | 'kits' | 'portal';
export const sceneExcerpt = (text: string) => text.length > 2000 ? text.slice(0, 2000) + '\n[仅引用前 2000 字符，完整内容见来源]' : text;
export interface SceneResource { id: string; title: string; author?: string; revision?: string; excerpt: string; private: boolean }
export interface SceneObservation {
  sceneId: string; view: SceneView; title: string; identity: string; revision: number; observedAt: string;
  status: 'loading' | 'ready' | 'error'; count?: number; scope: string; filters: Record<string, string>;
  selection?: SceneResource;
}
export interface SceneEvent { id: string; at: string; label: string; scene: string; state?: string }
const titles: Record<SceneView, string> = { chat: '与你的 Being 交谈', town: '小镇广场', bonfire: '篝火', firesides: '围炉', mail: '私信', seeds: '种子花园', embers: '书架', scrolls: '卷轴', kits: '工具间', portal: 'Portal 设置' };
export class SceneStore extends EventTarget {
  readonly instanceId = crypto.randomUUID();
  current: SceneObservation = { sceneId: 'desktop:chat:unconnected', view: 'chat', title: titles.chat, identity: '', revision: 1, observedAt: new Date().toISOString(), status: 'loading', scope: '尚未连接', filters: {} };
  history: SceneEvent[] = [];
  visits = new Map<string, { title: string; view: SceneView; at: string }>();
  reference: SceneObservation | null = null;
  being = '';
  endpoint = '';
  private versions = new Map<string, number>();
  private notify() { this.dispatchEvent(new Event('change')); }
  event(label: string, scene = this.current.title, state?: string) {
    this.history = [{ id: crypto.randomUUID(), at: new Date().toISOString(), label, scene, state }, ...this.history].slice(0, 50); this.notify();
  }
  configure(being: string, endpoint: string) {
    if (this.being === being && this.endpoint === endpoint) return;
    const switched = Boolean((this.endpoint || this.being) && (this.endpoint !== endpoint || this.being !== being));
    this.being = being; this.endpoint = endpoint;
    if (switched) this.resetIdentity();
    if (this.current.view === 'chat') this.enter('chat');
    this.notify();
  }
  resetIdentity() {
    this.reference = null; this.history = []; this.visits.clear(); this.versions.clear();
    this.current = { ...this.current, identity: '', selection: undefined, count: undefined, filters: {}, status: 'loading' };
    this.dispatchEvent(new Event('identity-reset')); this.notify();
  }
  enter(view: SceneView) {
    const id = view === 'chat' ? `conversation:${this.endpoint || 'unconnected'}` : view === 'portal' ? `desktop:${this.instanceId}:portal` : `town:https://beings.town:${view}`;
    if (this.current.view === view && this.current.sceneId === id) return;
    this.update({ sceneId: id, view, title: titles[view], identity: view === 'chat' ? this.being : '', scope: '尚未读取', status: 'loading', filters: {}, selection: undefined, count: undefined });
    this.event('进入场景');
  }
  update(patch: Partial<SceneObservation>) {
    const next = { ...this.current, ...patch };
    // A page refresh does not imply that all loaded content was visible or read.
    const id = next.sceneId; next.revision = (this.versions.get(id) || 0) + 1; this.versions.set(id, next.revision);
    next.observedAt = new Date().toISOString(); this.current = next;
    this.visits.delete(id); this.visits.set(id, { title: next.title, view: next.view, at: next.observedAt });
    if (this.visits.size > 20) this.visits.delete(this.visits.keys().next().value!);
    this.notify();
  }
  select(resource: SceneResource) {
    this.reference = null; this.dispatchEvent(new Event('selection-changed'));
    this.update({ selection: structuredClone(resource) });
    this.event('选择了一个讨论对象');
  }
  pin() {
    if (!this.current.selection) return;
    this.reference = structuredClone(this.current); this.event('保留了带出处的引用');
  }
}
