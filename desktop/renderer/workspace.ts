import './workspace.css';
import { SceneStore, sceneExcerpt, type SceneView } from './scene-store';
import type { Snapshot } from '../shared';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const time = (raw: string) => new Date(raw).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
export class Workspace {
  readonly scenes = new SceneStore();
  private draftRequest = '';
  private draftTimer?: ReturnType<typeof setTimeout>;
  private chatOnline = false;
  private pendingDraft: ReturnType<SceneStore['capture']>['environment'] | null = null;
  private draftFrozen: ReturnType<SceneStore['capture']>['environment'] | null = null;
  constructor(private frame: HTMLIFrameElement, private navigate: (view: string) => void, private toast: (message: string) => void) {
    this.toggle(false);
    this.scenes.addEventListener('identity-reset', () => { this.toggle(false); this.draftFrozen = null; this.pendingDraft = null; this.draftRequest = ''; clearTimeout(this.draftTimer); });
    this.scenes.addEventListener('change', () => this.render());
    $('toggle-companion').addEventListener('click', () => this.toggle());
    $('close-companion').addEventListener('click', () => this.toggle(false));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]') && document.body.classList.contains('companion-open')) { this.toggle(false); } });
    $('scene-clear').addEventListener('click', () => { this.scenes.reference = null; this.scenes.update({ selection: undefined }); this.scenes.event('清除了讨论对象'); this.toggle(false); });
    $('scene-compose').addEventListener('click', () => this.compose());
    $('scene-return').addEventListener('click', () => {
      const ref = this.scenes.reference; if (ref) { this.navigate(ref.view); this.scenes.event('返回来源页面', ref.title, '引用保留发送前版本'); }
    });
    window.addEventListener('message', event => {
      if (event.origin !== 'beings://chat' || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || message.revision !== new URL(frame.src).searchParams.get('revision')) return;
      if (message.type === 'beings:scene-select' && this.scenes.current.view === 'chat' &&
          typeof message.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(message.id) &&
          typeof message.text === 'string' && message.text.trim() && message.text.length <= 2100 &&
          (message.role === 'user' || message.role === 'being')) {
        const excerpt = sceneExcerpt(message.text.trim());
        this.scenes.select({ id: `chat:${message.id}`, title: excerpt.split('\n')[0].slice(0, 60),
          author: message.role === 'user' ? '你' : this.scenes.being, excerpt, private: true });
        this.scenes.pin(); this.toggle(true);
      }
      if (message.type === 'beings:scene-capture' && typeof message.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(message.id)) {
        // Freeze before yielding. Navigating later cannot rewrite this message's birthplace.
        const old = this.scenes.reference;
        this.scenes.reference = message.hasSceneDraft && this.draftFrozen ? this.draftFrozen : null;
        this.scenes.capture(message.id); this.scenes.reference = old; this.render();
        frame.contentWindow?.postMessage({ type: 'beings:scene-captured', id: message.id }, 'beings://chat');
      }
      if (message.type === 'beings:scene-result' && typeof message.id === 'string') {
        const envelope = this.scenes.envelopes.find(item => item.messageId === message.id);
        if (!envelope) return;
        this.scenes.event(message.ok === true ? '对话请求已被接受' : '对话请求未确认', envelope.environment.title, message.ok === true ? 'Heart 尚未接收环境元信息' : '请查看对话中的请求结果');
        if (message.ok === true && message.hasSceneDraft) this.draftFrozen = null;
      }
      if (message.type === 'beings:scene-draft-result' && message.id === this.draftRequest) {
        clearTimeout(this.draftTimer); this.draftRequest = ''; this.render();
        if (message.ok) { this.draftFrozen = this.pendingDraft; this.pendingDraft = null; this.scenes.event('引用已放入对话草稿', this.scenes.reference?.title, '尚未发送'); this.navigate('chat'); this.toggle(false); }
        else { this.pendingDraft = null; this.toast('对话输入框已有草稿，请先处理原草稿，再放入引用。'); }
      }
    });
    frame.addEventListener('load', () => { this.draftFrozen = null; });
    this.render();
  }
  enter(view: string) {
    this.scenes.enter(view as SceneView);
    if (view === 'chat') this.connection(this.chatOnline);
    if (view === 'portal') this.scenes.update({ status: 'ready', scope: '本机进程与日志观察；工具可用性待 Heart 确认', identity: this.scenes.being });
  }
  connection(online: boolean) {
    this.chatOnline = online;
    if (this.scenes.current.view === 'chat') this.scenes.update({ status: online ? 'ready' : 'loading', scope: '当前对话；场景元信息尚未传给 Heart' });
  }
  toggle(open = !document.body.classList.contains('companion-open')) {
    if (!open && $('companion-panel').contains(document.activeElement)) {
      ($('toggle-companion').hidden ? $('options-trigger') : $('toggle-companion')).focus();
    }
    document.body.classList.toggle('companion-open', open); $('companion-panel').hidden = !open;
    $('toggle-companion').setAttribute('aria-expanded', String(open));
  }
  snapshot(snapshot: Snapshot) {
    this.scenes.configure(snapshot.settings.being, snapshot.settings.endpoint);
    if (this.scenes.current.view === 'portal') this.scenes.update({ status: 'ready', scope: '本机进程与日志观察；工具可用性待 Heart 确认', identity: snapshot.settings.being });
    this.render();
  }
  private compose() {
    if (this.draftRequest) return;
    const scene = this.scenes.reference || (this.scenes.current.selection ? structuredClone(this.scenes.current) : null);
    if (!scene?.selection) return;
    if (!this.scenes.being || !this.frame.getAttribute('src')) { this.toast('请先连接对话 Being。'); return; }
    if (scene.selection.private && (!scene.identity || scene.identity !== this.scenes.being)) { this.toast('该内容的 Town 身份与对话 Being 不一致，不能跨身份放入草稿。'); return; }
    this.scenes.reference = structuredClone(scene);
    const resource = scene.selection;
    const draft = `一起看看${scene.title}里的这段${resource.author ? `（${resource.author}）` : ''}：\n\n${resource.excerpt.split('\n').map(line => '> ' + line).join('\n')}`;
    this.pendingDraft = structuredClone(scene); this.draftRequest = crypto.randomUUID(); this.render();
    this.frame.contentWindow?.postMessage({ type: 'beings:scene-draft', id: this.draftRequest, text: draft, expiresAt: Date.now() + 2500 }, 'beings://chat');
    clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => { if (this.draftRequest) { this.draftRequest = ''; this.pendingDraft = null; this.render(); this.toast('对话页面尚未准备好，请稍后重试。'); } }, 3000);
  }
  private render() {
    const scene = this.scenes.current, ref = this.scenes.reference || scene;
    const selected = Boolean(ref.selection);
    const discussing = scene.view === 'chat' && selected;
    document.body.classList.toggle('has-topic', selected);
    $('scene-caption').textContent = discussing ? (ref.view === 'chat' ? '从这段对话继续' : `话题来自 · ${ref.title}`) : '此刻，你在这里';
    $('scene-location').textContent = discussing ? ref.selection!.title : scene.title;
    $('scene-invitation').hidden = selected || ['chat', 'portal'].includes(scene.view);
    $('toggle-companion').hidden = !selected;
    $('scene-object-title').textContent = ref.selection?.title || '';
    $('scene-object-text').textContent = ref.selection?.excerpt || '';
    $('scene-object-source').textContent = ref.selection ? `${ref.title} · ${ref.selection.author || ref.identity || '公开内容'} · ${time(ref.observedAt)}` : '';
    $<HTMLButtonElement>('scene-compose').disabled = !selected || !this.scenes.being || Boolean(this.draftRequest);
    $('scene-return').hidden = !this.scenes.reference;
  }
}
