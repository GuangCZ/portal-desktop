import { sceneExcerpt, type SceneStore, type SceneResource } from './scene-store';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { newFeedFilters, renderTownFeed, type FeedFilters, type FeedReply } from './town-feed';
import type { DesktopAPI, KitLibrary, LocalKit, TownChannel, TownLiveState, TownPost, TownKind, TownQuery } from '../shared';

type Data = Record<string, unknown>;
type SendTarget = { kind: TownPost['kind']; firesideId?: string; generation: number; beingId: string; reply?: FeedReply };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const str = (value: unknown, fallback = '') => typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
const list = (data: Data, key: string): Data[] => {
  if (!Array.isArray(data[key])) throw new Error('Town 返回的列表格式不正确，请稍后刷新。');
  return (data[key] as unknown[]).map(record);
};
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function button(label: string, handler: () => void, className = 'secondary') {
  const element = node('button', className, label); element.addEventListener('click', handler); return element;
}
function markdown(text: string) {
  const element = node('div', 'reading-text');
  element.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }), { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del'], ALLOWED_ATTR: ['href', 'title'] });
  for (const link of element.querySelectorAll('a')) {
    if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noreferrer noopener'; }
  }
  return element;
}
const date = (value: unknown) => {
  const parsed = new Date(str(value));
  return Number.isNaN(parsed.getTime()) ? str(value) : parsed.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const scrollLabels: Record<string, Record<string, string>> = {
  kind: { note: '笔记', procedure: '操作流程', lesson: '经验教训', pattern: '方法模式', guide: '指南', skill: '技能', ember: '故事' },
  visibility: { private: '私有', shared: '通过链接分享', public: '公开' },
  lifecycle: { seed: '初稿', verified: '已验证', mature: '成熟', stale: '待更新', superseded: '已被替代' },
};
const scrollLabel = (field: string, value: unknown) => scrollLabels[field][str(value)] || str(value, '未标注');
const definitions: Record<string, { title: string; eyebrow: string; description: string; tabs: [string, string][] }> = {
  town: { title: '小镇广场', eyebrow: 'BEINGS TOWN', description: '浏览小镇服务，了解最近更新。', tabs: [['services', '服务目录'], ['updates', '最近更新']] },
  bonfire: { title: '篝火', eyebrow: 'AROUND THE BONFIRE', description: '听听 Being 们在聊什么。在这里，声音会被彼此听见。', tabs: [] },
  firesides: { title: '围炉', eyebrow: 'FIRESIDE', description: '查看你的 Being 创建或加入的围炉，选择一个围炉阅读消息。', tabs: [] },
  mail: { title: '私信', eyebrow: 'DIRECT MESSAGES', description: '直接查看发给我的消息和已发送私信。', tabs: [['inbox', '收件箱'], ['sent', '已发送']] },
  embers: { title: '书架', eyebrow: 'EMBERS', description: 'Being 与人类伙伴共同经历的故事。由 Being 选择讲述，任何人都能阅读。', tabs: [] },
  scrolls: { title: '卷轴', eyebrow: 'SCROLLS', description: 'Being 的笔记本：记录想法、保存文档、整理知识。默认私有，由作者选择是否分享。', tabs: [['scrolls', '公开卷轴'], ['my-scrolls', '我的卷轴']] },
  kits: { title: 'Kit 工具库', eyebrow: 'TOOLS FOR YOUR BEING', description: '从 Grove 发现工具，通过本机 Portal 连接到 Being。', tabs: [['grove', 'Grove 市集'], ['local', '本机 Kits']] },
};

export class TownViews {
  private view = '';
  private tab = '';
  private tabs: Record<string, string> = {};
  private offset = 0;
  private request = 0;
  private detailRequest = 0;
  private data: Data | null = null;
  private library: KitLibrary | null = null;
  private authBusy = false;
  private me = '';
  private feedFilters: Record<string, FeedFilters> = {};
  private selectedRing = '';
  private ringSearch = '';
  private ringData: { id: string; data: Data } | null = null;
  private directId: string | undefined;
  private live?: TownLiveState;
  private seen = { bonfire: 0, mail: 0, firesides: 0 };
  private changed = new Set<TownChannel>();
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private reconciling = false;
  private sendBusy = false;
  private sendTarget?: SendTarget;
  private drafts = new Map<string, { content: string; recipient: string }>();

  constructor(private api: DesktopAPI, private toast: (error: unknown) => void, private navigate: (view: string) => void, private scenes: SceneStore, private showCompanion: () => void) {
    api.onTownLive(state => this.receiveLive(state));
    void api.townLive().then(state => this.receiveLive(state)).catch(() => {});
    $('chat-frame').addEventListener('load', () => this.updateLive());
    $('town-updates').addEventListener('click', () => void this.load());
    $('town-live-retry').addEventListener('click', () => { void api.reconnectTown().catch(this.toast); });
    $('town-write').addEventListener('click', () => this.compose());
    $('town-send-close').addEventListener('click', () => { if (!this.sendBusy) $<HTMLDialogElement>('town-send-dialog').close(); });
    $('town-send-dialog').addEventListener('cancel', event => { if (this.sendBusy) event.preventDefault(); });
    $('town-send-form').addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    $('town-send-content').addEventListener('input', () => this.updateComposer());
    $('town-send-content').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!$<HTMLButtonElement>('town-send-submit').disabled) $<HTMLFormElement>('town-send-form').requestSubmit(); } });
    $('town-reply-clear').addEventListener('click', () => { if (this.sendTarget && !this.sendBusy) { this.sendTarget.reply = undefined; $('town-send-reply').hidden = true; $<HTMLInputElement>('town-recipient').readOnly = false; } });
    $('scroll-kind').addEventListener('change', () => { this.offset = 0; void this.load(); });
    $('town-refresh').addEventListener('click', () => void this.load());
    $('town-search').addEventListener('input', () => this.render());
    document.addEventListener('click', event => { for (const more of document.querySelectorAll<HTMLDetailsElement>('.feed-options[open]')) if (!more.contains(event.target as Node)) more.open = false; });
    $('town-auth-button').addEventListener('click', () => void this.auth());
    $('close-town-auth').addEventListener('click', () => $<HTMLDialogElement>('town-auth-dialog').close());
    $('town-auth-form').addEventListener('submit', event => { event.preventDefault(); void this.saveToken(false, true); });
    $('save-town-token').addEventListener('click', () => void this.saveToken(false));
    $('clear-town-token').addEventListener('click', () => void this.saveToken(true));
    $('town-auth-dialog').addEventListener('cancel', event => { if (this.authBusy) event.preventDefault(); });
    $('town-auth-dialog').addEventListener('close', () => {
      $<HTMLInputElement>('town-pair-code').value = ''; $<HTMLInputElement>('town-token').value = '';
    });
  }
  private channel(): TownChannel | undefined { return ['bonfire', 'mail', 'firesides'].includes(this.view) ? this.view as TownChannel : undefined; }
  private updateLive() {
    const live = this.live, channel = this.channel();
    const unread = (name: TownChannel) => this.changed.has(name) || (live?.versions[name] || 0) > this.seen[name];
    $('town-live-status').textContent = live?.message || '正在读取 Town 连接状态';
    $('town-live-status').dataset.phase = live?.phase || 'connecting';
    $('town-live-retry').hidden = !live || !['reconnecting', 'auth-error'].includes(live.phase);
    $('town-updates').hidden = !channel || !unread(channel);
    $('town-write').hidden = !channel;
    $<HTMLButtonElement>('town-write').disabled = live?.phase !== 'connected' || this.view === 'firesides' && !(this.directId || this.selectedRing);
    $('town-write').textContent = this.view === 'mail' ? '写私信' : '写一句';
    this.updateComposer();
    const channels = (['bonfire', 'mail', 'firesides'] as TownChannel[]).filter(unread);
    const frame = $<HTMLIFrameElement>('chat-frame');
    if (frame.getAttribute('src')) frame.contentWindow?.postMessage({ type: 'beings:town-activity', channels }, 'beings://chat');
  }
  private receiveLive(state: TownLiveState) {
    if (this.live && state.revision <= this.live.revision) return;
    const previous = this.live;
    this.live = state;
    const identityChanged = previous && (previous.generation !== state.generation || previous.beingId && previous.beingId !== state.beingId);
    const rejected = state.phase === 'auth-error' && previous?.phase !== 'auth-error';
    if (identityChanged || rejected) {
      clearTimeout(this.reconcileTimer);
      this.seen = { bonfire: 0, mail: 0, firesides: 0 }; this.changed.clear();
      this.request++; this.detailRequest++; this.data = null; this.ringData = null; this.me = ''; this.selectedRing = ''; this.feedFilters = {};
      this.scenes.resetIdentity();
      this.drafts.clear(); this.sendTarget = undefined; $<HTMLTextAreaElement>('town-send-content').value = ''; $<HTMLInputElement>('town-recipient').value = '';
      $<HTMLDialogElement>('town-send-dialog').close();
      $('town-body').replaceChildren();
      if (definitions[this.view]) {
        if (rejected) this.error(state.message, true);
        else void this.load();
      }
    }
    if (state.phase === 'connected') {
      if (this.me !== state.beingId) {
        this.me = state.beingId || '';
        if (definitions[this.view]) void this.load();
      } else if (state.sync !== previous?.sync || this.channel() && state.versions[this.channel()!] !== previous?.versions[this.channel()!]) this.scheduleReconcile();
    }
    this.updateLive();
  }
  private scheduleReconcile() {
    clearTimeout(this.reconcileTimer);
    if (!this.channel()) return;
    this.reconcileTimer = setTimeout(() => { void this.reconcile(); }, 700);
  }
  private async reconcile() {
    if (this.reconciling) { this.scheduleReconcile(); return; }
    const channel = this.channel(), generation = this.request, identity = this.live?.generation;
    if (!channel || this.live?.phase !== 'connected') return;
    this.reconciling = true;
    try {
      const id = this.directId || this.selectedRing;
      const query: TownQuery = channel === 'firesides' && id ? { kind: 'fireside', id } : this.query();
      const before = query.kind === 'fireside' ? this.ringData?.data : this.data;
      if (!before) return;
      const result = await this.api.town(query);
      if (generation !== this.request || identity !== this.live?.generation || !result.ok) return;
      // Reconcile a recent REST window after reconnect. Never replace the text being read.
      if (JSON.stringify(result.data.messages) !== JSON.stringify(before.messages)) this.changed.add(channel);
      this.updateLive();
    } catch { /* Existing content remains available while a later reconnect retries. */ }
    finally { this.reconciling = false; }
  }
  private acknowledge(channel: TownChannel | undefined, start: TownLiveState | undefined) {
    if (!channel || !start || start.generation !== this.live?.generation) return;
    this.seen[channel] = start.versions[channel]; this.changed.delete(channel); this.updateLive();
  }
  private updateComposer() {
    const count = [...$<HTMLTextAreaElement>('town-send-content').value].length;
    const limit = this.sendTarget?.kind === 'bonfire' ? 4000 : 32000;
    $('town-send-count').textContent = `${count.toLocaleString()} / ${limit.toLocaleString()} 字`;
    $('town-send-count').classList.toggle('over-limit', count > limit);
    $<HTMLButtonElement>('town-send-submit').disabled = this.sendBusy || this.live?.phase !== 'connected' || !$<HTMLTextAreaElement>('town-send-content').value.trim() || count > limit;
  }
  private compose(reply?: FeedReply) {
    const live = this.live;
    if (live?.phase !== 'connected' || !live.beingId || !this.channel()) return;
    const kind = this.view === 'mail' ? 'dm' : this.view === 'firesides' ? 'fireside' : 'bonfire';
    if (kind === 'dm') reply = undefined;
    const firesideId = this.directId || this.selectedRing;
    if (kind === 'fireside' && !firesideId) return;
    const next = { kind, firesideId: kind === 'fireside' ? firesideId : undefined, generation: live.generation, beingId: live.beingId, ...(reply ? { reply } : {}) } as SendTarget;
    if (this.sendTarget) this.drafts.set(JSON.stringify(this.sendTarget), { content: $<HTMLTextAreaElement>('town-send-content').value, recipient: $<HTMLInputElement>('town-recipient').value });
    while (this.drafts.size > 20) this.drafts.delete(this.drafts.keys().next().value!);
    const draft = this.drafts.get(JSON.stringify(next));
    $<HTMLTextAreaElement>('town-send-content').value = draft?.content || '';
    $<HTMLInputElement>('town-recipient').value = draft?.recipient || '';
    $<HTMLInputElement>('town-recipient').readOnly = false;
    $('town-send-reply').hidden = !reply;
    $('town-reply-preview').textContent = reply ? `${reply.author}：${reply.preview}` : '';
    this.sendTarget = next;
    $('town-send-title').textContent = kind === 'dm' ? '写私信' : kind === 'fireside' ? '在围炉说一句' : '在篝火说一句';
    $('town-send-context').textContent = `你将以 @${live.beingId} 的身份代发 · ${kind === 'dm' ? '仅收件 Being 可见' : kind === 'fireside' ? '围炉 #' + firesideId + ' · 成员可见' : '公开发布到篝火'}`;
    $('town-recipient-label').hidden = kind !== 'dm'; $('town-recipient').hidden = kind !== 'dm';
    $<HTMLInputElement>('town-recipient').required = kind === 'dm';
    $<HTMLTextAreaElement>('town-send-content').maxLength = kind === 'bonfire' ? 8000 : 64000;
    $('town-send-error').textContent = ''; this.updateComposer();
    $<HTMLDialogElement>('town-send-dialog').showModal();
    (kind === 'dm' ? $('town-recipient') : $('town-send-content')).focus();
  }
  private async send() {
    const target = this.sendTarget;
    if (this.sendBusy || !target || this.live?.phase !== 'connected') return;
    if (target.generation !== this.live.generation || target.beingId !== this.live.beingId) { $('town-send-error').textContent = 'Town 身份已改变，请重新打开发送窗口。'; return; }
    const content = $<HTMLTextAreaElement>('town-send-content').value;
    const input: TownPost = target.kind === 'dm' ? { kind: 'dm', content, recipient: $<HTMLInputElement>('town-recipient').value } : target.kind === 'fireside' ? { kind: 'fireside', content, firesideId: target.firesideId! } : { kind: 'bonfire', content };
    if (target.reply && input.kind !== 'dm') input.replyTo = Number(target.reply.id);
    this.sendBusy = true; this.updateLive(); $('town-send-error').textContent = '';
    $<HTMLButtonElement>('town-reply-clear').disabled = true;
    $<HTMLButtonElement>('town-send-close').disabled = true;
    $<HTMLTextAreaElement>('town-send-content').disabled = true; $<HTMLInputElement>('town-recipient').disabled = true;
    try {
      const result = await this.api.sendTown(input);
      if (target !== this.sendTarget) return;
      if (!result.ok) { $('town-send-error').textContent = result.message; return; }
      this.drafts.delete(JSON.stringify(target));
      $<HTMLTextAreaElement>('town-send-content').value = '';
      $<HTMLDialogElement>('town-send-dialog').close();
      if (target.kind === 'dm') { this.tab = 'sent'; this.tabs.mail = 'sent'; }
      await this.load();
    } catch (error) { if (target === this.sendTarget) $('town-send-error').textContent = String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''); }
    finally { this.sendBusy = false; $<HTMLButtonElement>('town-reply-clear').disabled = false; $<HTMLButtonElement>('town-send-close').disabled = false; $<HTMLTextAreaElement>('town-send-content').disabled = false; $<HTMLInputElement>('town-recipient').disabled = false; this.updateLive(); }
  }
  show(view: string, resourceId?: string) {
    this.view = view; this.request++; this.detailRequest++;
    this.directId = resourceId; clearTimeout(this.reconcileTimer); this.updateLive();
    if (!definitions[view]) return;
    this.tab = this.tabs[view] || definitions[view].tabs[0]?.[0] || view;
    this.offset = 0; $<HTMLInputElement>('town-search').value = '';
    const definition = definitions[view];
    const social = ['bonfire', 'firesides', 'mail'].includes(view);
    $('town-view').classList.toggle('social-view', social);
    $('town-view').classList.toggle('bookshelf-view', view === 'embers');
    $('scroll-kind').hidden = view !== 'scrolls';
    $('town-search').hidden = Boolean(resourceId);
    if (resourceId) $('scroll-kind').hidden = true;
    $<HTMLInputElement>('town-search').placeholder = social ? '搜索消息、作者…' : '筛选当前列表…';
    $('town-search').setAttribute('aria-label', social ? '搜索已加载的消息与作者' : '筛选当前列表');
    $('town-title').textContent = definition.title; $('town-eyebrow').textContent = definition.eyebrow;
    $('town-description').textContent = definition.description;
    void this.load();
  }
  private async auth() {
    $<HTMLInputElement>('town-token').value = ''; $('town-auth-error').textContent = '';
    $<HTMLInputElement>('town-pair-code').value = '';
    $<HTMLDialogElement>('town-auth-dialog').showModal();
    try {
      const state = await this.api.townAuth();
      $<HTMLInputElement>('town-being').value = state.beingId || state.suggestedBeingId || '';
      $('town-auth-state').textContent = state.warning || (state.configured ? (this.live?.message || '已保存 Town 凭据，等待身份确认。') : '尚未配对。');
      $<HTMLButtonElement>('clear-town-token').disabled = !state.configured;
    } catch (error) { $('town-auth-error').textContent = String(error); }
  }
  private async saveToken(clear: boolean, pair = false) {
    if (this.authBusy) return;
    this.authBusy = true; $('town-auth-error').textContent = '';
    const buttons = $('town-auth-form').querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
    try {
      const token = $<HTMLInputElement>('town-token').value.trim();
      if (pair) {
        await this.api.pairTown({ beingId: $<HTMLInputElement>('town-being').value.trim(), code: $<HTMLInputElement>('town-pair-code').value.trim() });
      } else {
        if (!clear && !token) throw new Error('请输入 Town 凭据。');
        await this.api.saveTownToken(clear ? '' : token);
      }
      // Invalidate private content and pending detail reads when the identity changes.
      this.scenes.resetIdentity();
      this.request++; this.detailRequest++; this.data = null; this.me = ''; this.ringData = null; this.selectedRing = ''; this.feedFilters = {};
      $('town-body').replaceChildren();
      $('town-auth-button').textContent = clear ? '配对 Being' : 'Town 连接';
      $<HTMLInputElement>('town-token').value = ''; $<HTMLDialogElement>('town-auth-dialog').close();
      if (definitions[this.view]) await this.load();
    } catch (error) { $('town-auth-error').textContent = String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''); }
    finally { this.authBusy = false; buttons.forEach(b => { b.disabled = false; }); }
  }
  private query(): TownQuery { return { kind: (this.view === 'town' ? 'home' : this.tab) as TownKind, offset: this.offset, ...(this.view === 'scrolls' ? { scrollKind: $<HTMLSelectElement>('scroll-kind').value } : {}) }; }
  private drawTabs() {
    const holder = $('town-tabs'); holder.replaceChildren();
    holder.hidden = Boolean(this.directId);
    if (this.directId) return;
    for (const [value, label] of definitions[this.view].tabs) {
      const tab = button(label, () => {
        this.tab = value; this.tabs[this.view] = value; this.offset = 0; $<HTMLInputElement>('town-search').value = ''; void this.load();
      }, value === this.tab ? 'selected' : '');
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(value === this.tab)); holder.append(tab);
    }
  }
  private async load() {
    if (!definitions[this.view]) return;
    $('town-view').classList.toggle('kit-catalog', this.view === 'kits' && this.tab === 'grove' && !this.directId);
    const generation = ++this.request; ++this.detailRequest;
    const liveAtStart = this.live, channel = this.channel();
    this.scenes.update({ sceneId: `town:https://beings.town:${this.view}:${this.tab}`, title: definitions[this.view].title, status: 'loading', selection: undefined, count: undefined, scope: '正在读取当前页', filters: { tab: this.tab, offset: String(this.offset) } });
    this.data = null; this.library = null; this.ringData = null;
    this.drawTabs(); $('town-body').replaceChildren(node('div', 'loading-block', '正在读取…'));
    $('town-pagination').replaceChildren(); $('town-status').textContent = '';
    $('town-body').setAttribute('aria-busy', 'true');
    try {
      if (this.directId) {
        const id = this.directId;
        const auth = await this.api.townAuth().catch(() => ({ configured: false, beingId: '' }));
        if (generation !== this.request) return;
        this.me = auth.configured ? auth.beingId || '' : '';
        $('town-auth-button').textContent = this.me ? '@' + this.me : '配对 Being';
        this.scenes.update({ identity: this.me });
        const detail = node('div', 'direct-reading');
        $('town-body').replaceChildren(detail);
        $('town-status').textContent = '来自对话中的内容链接';
        if (this.view === 'firesides') await this.loadFireside(id, `围炉 #${id}`, detail);
        else await this.loadDetail({ kind: this.view === 'kits' ? 'kit' : this.view === 'embers' ? 'ember' : 'scroll', id }, detail);
        return;
      }
      if (this.tab === 'local') {
        const library = await this.api.localKits(); if (generation !== this.request) return;
        this.library = library;
        $('town-status').textContent = `${library.kits.length} 个本机 Kit · ${library.enabled ? 'Portal 已启用 Kits' : 'Portal 尚未启用 Kits'} · 清单来自磁盘，加载情况请查看 Portal 日志`;
      } else {
        const [result, auth] = await Promise.all([this.api.town(this.query()), this.api.townAuth().catch(() => ({ configured: false, beingId: '' }))]);
        if (generation !== this.request) return;
        this.me = auth.configured ? auth.beingId || '' : '';
        $('town-auth-button').textContent = this.me ? '@' + this.me : auth.configured ? 'Town 连接' : '配对 Being';
        if (!result.ok) {
          this.error(result.message, result.code === 'auth'); return;
        }
        this.data = result.data;
        if (channel !== 'firesides' && this.tab !== 'sent') this.acknowledge(channel, liveAtStart);
        const limits = this.view === 'bonfire' ? ' · 最近 100 条' : this.view === 'mail' ? ' · 最近 100 封' : '';
        $('town-status').textContent = `来自 beings.town · ${date(result.fetchedAt)} 已刷新${limits}`;
      }
      this.scenes.update({ identity: this.library ? this.scenes.being : this.me, status: 'ready', scope: this.library ? '本机 Kit 清单；不代表工具已可调用' : '已加载当前页；不代表全部内容或已阅读' });
      this.render();
    } catch (error) { if (generation === this.request) this.error(String(error)); }
    finally { if (generation === this.request) $('town-body').removeAttribute('aria-busy'); }
  }
  private error(message: string, auth = false) {
    this.scenes.update({ status: 'error', selection: undefined, scope: auth ? '尚未获得 Town 授权' : '当前页读取失败' });
    $('town-status').textContent = auth ? '需要 Town 授权' : '读取失败';
    const empty = node('div', 'empty-state');
    empty.append(node('div', 'empty-symbol', auth ? '⌑' : '↻'), node('h2', '', auth ? '连接 Town，继续阅读' : '暂时未能读取内容'), node('p', '', message));
    empty.append(button(auth ? '配置 Town 连接' : '重试', () => { if (auth) void this.auth(); else void this.load(); }, 'primary'));
    if (auth) empty.append(button('阅读已公开的书架', () => this.navigate('embers'), 'text-button'));
    $('town-body').replaceChildren(empty);
  }
  private matches(...values: unknown[]) {
    const query = $<HTMLInputElement>('town-search').value.toLocaleLowerCase().trim();
    return !query || values.map(v => str(v)).join(' ').toLocaleLowerCase().includes(query);
  }
  private render() {
    if (!this.data && !this.library) return;
    this.scenes.update({ filters: { tab: this.tab, offset: String(this.offset), search: $<HTMLInputElement>('town-search').value, kind: this.view === 'scrolls' ? $<HTMLSelectElement>('scroll-kind').value : '' }, selection: undefined });
    ++this.detailRequest; $('town-body').replaceChildren(); $('town-pagination').replaceChildren();
    try {
      if (this.library) { this.renderLocal(this.library); return; }
      if (this.view === 'town') { this.renderHome(this.data!); return; }
      if (this.view === 'bonfire' || this.view === 'mail') { this.renderMessages(this.data!); return; }
      if (this.view === 'firesides') { this.renderFiresides(this.data!); return; }
      this.renderCatalog(this.data!);
    } catch (error) { this.error((error as Error).message); }
  }
  private renderHome(data: Data) {
    const services = Object.entries(record(data.services))
      .map(([name, raw]) => ({ name, key: name.trim().split(/\s+/).at(-1)!, service: record(raw) }))
      .filter(({ key }) => key !== 'beings');
    const summary = node('div', 'town-summary');
    summary.append(node('span', '', `${services.length} 项服务`), node('span', '', `Town ${str(data.version)}`));
    $('town-body').append(summary);
    const grid = node('div', 'service-grid');
    grid.classList.toggle('service-directory', this.tab === 'services');
    $('town-body').append(grid);
    if (this.tab === 'services') {
      const routes: Record<string, [string, string, string]> = {
        grove: ['◇', 'Grove 工具市集', 'kits'], bonfire: ['♧', '篝火', 'bonfire'], fireside: ['◎', '围炉', 'firesides'], messages: ['✉', '私信', 'mail'],
        ember: ['▤', '书架', 'embers'], scroll: ['≡', '卷轴', 'scrolls'], portal: ['⌘', 'Portal 设置', 'portal'],
      };
      for (const { name, key, service } of services) {
        const known = routes[key];
        const labels: Record<string, string> = { browse: '浏览器', fireside: '围炉', workspace: '云端工作目录', channel: '消息渠道', search: '网络搜索' };
        const title = known?.[1] || labels[key] || name;
        if (!this.matches(title, name, service.what)) continue;
        const card = node('article', 'service-card');
        const icon = node('span', 'service-icon'); icon.setAttribute('aria-hidden', 'true');
        const view = ({ grove: 'kits', bonfire: 'bonfire', messages: 'mail', ember: 'embers', scroll: 'scrolls', portal: 'portal', workspace: 'portal' } as Record<string, string>)[key];
        const template = document.querySelector(`nav [data-view="${view || 'town'}"] svg`);
        if (template) icon.append(template.cloneNode(true)); else icon.textContent = known?.[0] || '◦';
        card.append(icon, node('h2', '', title), node('p', '', str(service.what)));
        const help = str(service.help).replace(/^GET /, '');
        const open = () => {
          if (known) this.navigate(known[2]);
          else if (/^\/api\/[a-z]+\/help$/.test(help)) void this.run(() => this.api.openTownLink(help));
        };
        card.append(button(known ? '打开' : '说明 ↗', open, 'card-link')); grid.append(card);
      }
    } else {
      for (const update of list(data, 'whats_new')) {
        if (!this.matches(update.service, update.change)) continue;
        const card = node('article', 'service-card');
        card.append(node('small', 'card-meta', str(update.date)), node('h2', '', str(update.service)), node('p', '', str(update.change))); grid.append(card);
      }
    }
    if (!grid.childElementCount) grid.append(node('p', 'empty-inline', '没有符合筛选条件的内容。'));
  }
  private choose(resource: SceneResource) { this.scenes.select(resource); this.scenes.pin(); this.showCompanion(); }
  private drawFeed(holder: HTMLElement, data: Data, key: string) {
    const filters = this.feedFilters[key] ||= newFeedFilters();
    renderTownFeed(holder, list(data, 'messages'), {
      me: this.me || (typeof data.being === 'string' ? data.being : ''),
      mail: this.view === 'mail' ? this.tab as 'inbox' | 'sent' : undefined,
      search: $<HTMLInputElement>('town-search').value, filters, limit: this.view === 'firesides' ? 50 : 100,
      private: this.view === 'firesides', onSelect: resource => this.choose(resource),
      onReply: this.view === 'firesides' && this.live?.phase === 'connected' ? reply => this.compose(reply) : undefined,
      onFilters: (values, count) => this.scenes.update({ count, filters: { tab: this.tab, ...values }, scope: `${count} 条符合筛选 · 最近 ${this.view === 'firesides' ? 50 : 100} 条内筛选；未确认阅读` }),
    });
  }
  private renderMessages(data: Data) {
    const feed = node('div'); $('town-body').append(feed);
    this.drawFeed(feed, data, this.view === 'mail' ? this.tab : this.view);
  }
  private split() {
    const split = node('div', 'catalog-split'), items = node('div', 'catalog-list'), detail = node('div', 'catalog-detail');
    detail.append(node('div', 'detail-placeholder', '选择一项，查看内容与详情。'));
    split.append(items, detail); $('town-body').append(split); return { items, detail };
  }
  private renderFiresides(data: Data) {
    const owned = list(data, 'owned'), joined = list(data, 'joined');
    const entries = [...new Map([...owned, ...joined].map(entry => [str(entry.id), entry])).values()];
    const ownedIds = new Set(owned.map(entry => str(entry.id)));
    if (!entries.length) {
      this.selectedRing = ''; this.updateLive();
      $('town-body').append(node('div', 'feed-empty', '尚未加入围炉。你的 Being 创建或加入围炉后，会显示在这里。')); return;
    }
    if (!entries.some(entry => str(entry.id) === this.selectedRing)) this.selectedRing = str(entries[0].id);
    const layout = node('div', 'fireside-layout'), rooms = node('aside', 'fireside-rooms'), detail = node('section', 'fireside-thread');
    rooms.setAttribute('aria-label', '围炉列表'); detail.setAttribute('aria-label', '围炉消息');
    const search = node('input'); search.type = 'search'; search.placeholder = '查找围炉…'; search.setAttribute('aria-label', '查找围炉'); search.value = this.ringSearch;
    rooms.append(node('h2', '', `我的围炉 · ${entries.length}`), search);
    const roomList = node('div', 'fireside-room-list'); rooms.append(roomList);
    entries.sort((a, b) => str(a.name).localeCompare(str(b.name), 'zh-CN'));
    for (const entry of entries) {
      const id = str(entry.id), title = str(entry.name, `围炉 #${id}`);
      const card = button('', () => {
        this.selectedRing = id;
        roomList.querySelectorAll<HTMLButtonElement>('button').forEach(button => { const selected = button.dataset.id === id; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
        void this.loadFireside(id, title, detail);
      }, 'fireside-room');
      card.dataset.id = id; card.dataset.search = (title + ' ' + str(entry.description)).toLowerCase();
      card.classList.toggle('selected', id === this.selectedRing); card.setAttribute('aria-pressed', String(id === this.selectedRing));
      card.append(node('strong', '', title), node('span', '', `${ownedIds.has(id) ? '我创建的' : '已加入'}${entry.member_count !== undefined ? ' · ' + str(entry.member_count) + ' 位成员' : ''}`));
      roomList.append(card);
    }
    const noRooms = node('p', 'empty-inline', '没有匹配的围炉'); rooms.append(noRooms);
    const filterRooms = () => {
      this.ringSearch = search.value;
      let visible = 0;
      roomList.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.hidden = !button.dataset.search!.includes(search.value.trim().toLowerCase()); if (!button.hidden) visible++; });
      noRooms.hidden = visible > 0;
    };
    search.addEventListener('input', filterRooms); filterRooms();
    layout.append(rooms, detail); $('town-body').append(layout);
    const entry = entries.find(entry => str(entry.id) === this.selectedRing)!;
    void this.loadFireside(this.selectedRing, str(entry.name, `围炉 #${this.selectedRing}`), detail);
  }
  private async loadFireside(id: string, title: string, detail: HTMLElement, refresh = false) {
    const generation = ++this.detailRequest;
    const liveAtStart = this.live; this.updateLive();
    this.scenes.update({ sceneId: `town:https://beings.town:fireside:${id}`, title: `围炉 · ${title}`, identity: this.me, status: 'loading', selection: undefined, count: undefined, scope: '正在读取围炉消息' });
    detail.replaceChildren(node('p', 'empty-inline', '正在读取围炉消息…'));
    try {
      let data: Data;
      if (!refresh && this.ringData?.id === id) data = this.ringData.data;
      else {
        const result = await this.api.town({ kind: 'fireside', id });
        if (generation !== this.detailRequest) return;
        if (!result.ok) {
          this.scenes.update({ status: 'error', scope: '围炉消息读取失败' });
          detail.replaceChildren(node('p', 'inline-error', result.message), button(result.code === 'auth' ? '重新配对' : '重试', () => {
            if (result.code === 'auth') void this.auth(); else void this.loadFireside(id, title, detail, true);
          })); return;
        }
        data = result.data; this.ringData = { id, data };
        this.acknowledge('firesides', liveAtStart);
      }
      this.scenes.update({ status: 'ready' });
      const heading = node('div', 'fireside-thread-heading');
      heading.append(node('h2', '', title), button('刷新消息', () => void this.loadFireside(id, title, detail, true), 'secondary'));
      const feed = node('div'); detail.replaceChildren(heading, feed);
      this.drawFeed(feed, data, 'firesides');
    } catch { if (generation === this.detailRequest) { this.scenes.update({ status: 'error', scope: '围炉消息读取失败' }); detail.replaceChildren(node('p', 'inline-error', '未能读取围炉消息。'), button('重试', () => void this.loadFireside(id, title, detail, true))); } }
  }
  private renderCatalog(data: Data) {
    const kit = this.tab === 'grove'; const book = this.view === 'embers'; const entries = list(data, kit ? 'kits' : 'scrolls');
    const { items, detail } = this.split();
    for (const entry of entries) {
      if (!this.matches(entry.name, entry.title, entry.description, entry.display_name, entry.being_id, ...(Array.isArray(entry.tags) ? entry.tags : []))) continue;
      const card = button('', () => {
        items.querySelectorAll('button').forEach(b => b.classList.remove('selected')); card.classList.add('selected');
        void this.loadDetail({ kind: kit ? 'kit' : this.tab === 'embers' ? 'ember' : 'scroll', id: str(entry.id) }, detail);
      }, 'catalog-item');
      card.append(node('span', 'catalog-title', str(entry.name, str(entry.title))));
      card.append(node('span', 'card-meta', `${str(entry.display_name, str(entry.being_id))} · ${kit ? 'v' + str(entry.version) : date(entry.updated_at)}`));
      if (kit) card.append(node('p', '', str(entry.description)), node('span', 'mini-tag', entry.status === 'grown' ? '已成长' : '萌芽中'));
      else if (book) card.append(node('span', 'mini-tag', '公开故事'));
      else card.append(node('span', 'mini-tag', `${scrollLabel('kind', entry.kind)} · ${scrollLabel('visibility', entry.visibility)}`), node('span', 'card-meta', scrollLabel('lifecycle', entry.lifecycle)));
      if (!kit && Array.isArray(entry.tags) && entry.tags.length) card.append(node('span', 'card-meta', entry.tags.map(tag => '#' + str(tag)).join(' ')));
      items.append(card);
    }
    if (!items.childElementCount) items.append(node('p', 'empty-inline', '当前页没有符合条件的内容。'));
    const total = Number(data.total ?? data.count ?? entries.length);
    this.paginate(entries.length, total);
  }
  private paginate(count: number, total: number) {
    const holder = $('town-pagination');
    const previous = button('← 上一页', () => { this.offset = Math.max(0, this.offset - 24); void this.load(); }); previous.disabled = this.offset === 0;
    const next = button('下一页 →', () => { this.offset += 24; void this.load(); }); next.disabled = count < 24 || this.offset + count >= total;
    holder.append(previous, node('span', '', `第 ${Math.floor(this.offset / 24) + 1} 页 · 共 ${total} 项`), next);
  }
  private async loadDetail(query: TownQuery, detail: HTMLElement, append = false) {
    const generation = ++this.detailRequest;
    this.scenes.update({ sceneId: `town:https://beings.town:${query.kind}:${query.id}`, status: 'loading', selection: undefined, scope: '正在读取详情' });
    if (!append) detail.replaceChildren(node('p', 'empty-inline', '正在读取详情…'));
    try {
      const result = await this.api.town(query); if (generation !== this.detailRequest) return;
      if (!result.ok) { this.scenes.update({ status: 'error', scope: '详情读取失败' }); if (!append) detail.replaceChildren(); detail.append(node('p', 'inline-error', result.message), button('重试', () => void this.loadDetail(query, detail, append))); return; }
      this.scenes.update({ title: str(result.data.title, str(result.data.name, definitions[this.view].title)), status: 'ready', scope: '已加载的详情片段；不代表已阅读' });
      if (query.kind === 'kit') { this.renderKitDetail({ ...result.data, id: query.id }, detail); return; }
      const data = result.data;
      if (!append) {
        detail.replaceChildren(node('div', 'eyebrow', query.kind === 'ember' ? '公开故事 · Embers' : '知识记录 · Scrolls'), node('h2', 'reading-title', str(data.title)), node('p', 'card-meta', `${str(data.display_name, str(data.being_id))} · ${date(data.updated_at)}`));
      }
      if (!append && query.kind === 'scroll') {
        detail.append(node('p', 'scroll-metadata', `${scrollLabel('kind', data.kind)} · ${scrollLabel('visibility', data.visibility)} · ${scrollLabel('lifecycle', data.lifecycle)}`));
        for (const [field, label] of [['trigger_context', '何时适用'], ['outcome', '可以获得什么']]) {
          if (data[field]) detail.append(node('h3', '', label), node('p', '', str(data[field])));
        }
      }
      detail.querySelector('.read-more')?.remove();
      const fragment = node('section', 'reading-fragment');
      fragment.append(button(append ? '一起看这一段' : '一起看', () => this.choose({ id: `${query.kind}:${query.id}`, title: str(data.title, this.scenes.current.title), author: str(data.being_id), revision: str(data.updated_at), excerpt: sceneExcerpt(str(data.content)), private: query.kind !== 'ember' && data.visibility !== 'public' }), 'scene-select'), markdown(str(data.content)));
      detail.append(fragment);
      if (data.has_more === true) {
        const offset = Number(data.offset || 0) + [...str(data.content)].length;
        detail.append(button('继续阅读 ↓', () => void this.loadDetail({ ...query, offset }, detail, true), 'secondary read-more'));
      }
    } catch (error) { if (generation === this.detailRequest) { this.scenes.update({ status: 'error', scope: '详情读取失败' }); detail.replaceChildren(node('p', 'inline-error', String(error))); } }
  }
  private renderKitDetail(data: Data, detail: HTMLElement) {
    const manifest = record(data.manifest); const tools = Array.isArray(manifest.tools) ? manifest.tools.map(record) : [];
    detail.classList.add('kit-detail');
    const summary = node('div', 'kit-summary');
    summary.append(node('h2', 'reading-title', str(data.name)), node('p', 'card-meta', `${str(data.display_name, str(data.being_id))} · v${str(data.version)} · ${tools.length} 个声明工具`), node('p', 'kit-description', str(data.description)));
    const actions = node('div', 'kit-actions');
    if (data.has_bundle === true || str(data.source_url)) {
      const install = button('安装到本机', () => void this.run(async () => {
        install.disabled = true; install.textContent = '正在下载并检查…';
        try { const plan = await this.api.prepareKit(str(data.id)); this.installDialog(plan); }
        finally { install.disabled = false; install.textContent = '安装到本机'; }
      }), 'primary'); actions.append(install);
    }
    actions.append(button('一起看', () => this.choose({ id: 'kit:' + str(data.id), title: str(data.name), author: str(data.being_id), revision: str(data.version), excerpt: sceneExcerpt(str(data.description)), private: false }), 'secondary scene-select'));
    detail.replaceChildren(summary, actions);
    if (data.has_bundle === true || str(data.source_url)) detail.append(node('p', 'field-help', '在客户端完成下载、解压、依赖安装和工具检查。需要的凭据将在安装时填写。'));
    const provision = record(manifest.provision);
    if (manifest.command) { detail.append(node('h3', '', '启动命令'), node('pre', 'schema-block', JSON.stringify(manifest.command, null, 2))); }
    const requirements = [
      ...(Array.isArray(provision.deps) ? provision.deps : []).map(raw => { const d = record(raw); return `${str(d.name)} — ${str(d.install_hint, str(d.description))}`; }),
      ...(Array.isArray(provision.env) ? provision.env : []).map(raw => { const d = record(raw); return `${str(d.name)} — ${str(d.description, '需配置凭据')}`; }),
    ];
    if (requirements.length) { detail.append(node('h3', '', '依赖与配置')); const ul = node('ul', 'requirements'); requirements.forEach(text => ul.append(node('li', '', text))); detail.append(ul); }
    this.tools(tools, detail);
    detail.scrollTop = 0;
  }
  private tools(tools: Data[], detail: HTMLElement) {
    detail.append(node('h3', '', `工具列表 · ${tools.length}`));
    if (!tools.length) detail.append(node('p', 'field-help', '此 manifest 没有声明工具。实际可用工具以 Portal 加载后的注册结果为准。'));
    for (const tool of tools) {
      const item = node('details', 'tool-item'); const summary = node('summary'); summary.append(node('strong', '', str(tool.name)), node('span', '', str(tool.description)));
      item.append(summary, node('pre', 'schema-block', tool.params || tool.inputSchema ? JSON.stringify(tool.params ?? tool.inputSchema, null, 2) : '此工具未提供参数结构。')); detail.append(item);
    }
  }
  private installDialog(plan: import('../shared').KitInstallPlan) {
    const dialog = node('dialog'); const form = node('form', 'kit-install-form'); const heading = node('div', 'dialog-heading');
    const close = button('', () => dialog.close(), 'close'); close.type = 'button'; close.setAttribute('aria-label', '取消 Kit 安装');
    heading.append(node('h2', '', `安装 ${plan.name}`), close);
    form.append(heading, node('p', '', plan.description), node('p', 'card-meta', `v${plan.version} · ${plan.tools} 个声明工具`));
    form.append(node('p', 'field-help', plan.dependency === 'npm' ? '将安装 npm 依赖（包括包内安装脚本），再交给 Portal 管理。' : plan.dependency === 'python' ? '将创建 Kit 专用 Python 环境并安装 requirements.txt，再交给 Portal 管理。' : '安装完成后由 Portal 自动发现并按需启动。'));
    if (plan.notes) form.append(node('p', 'field-help', plan.notes));
    const inputs = new Map<string, HTMLInputElement>();
    for (const field of plan.environment) {
      const id = 'kit-env-' + field.name; const label = node('label', '', field.name + (field.required ? ' *' : '（可选）')); label.htmlFor = id;
      const input = node('input'); input.id = id; input.type = 'password'; input.autocomplete = 'off'; input.required = field.required;
      form.append(label, input, node('p', 'field-help', field.description)); inputs.set(field.name, input);
    }
    if (inputs.size) form.append(node('p', 'field-help', '配置写入 Kit 本地 .env，由 Portal 按清单注入。'));
    const error = node('p', 'form-error'); error.setAttribute('role', 'alert');
    const submit = node('button', 'primary', '安装到本机'); submit.type = 'submit';
    const footer = node('div', 'dialog-footer'); footer.append(node('span', '', 'Portal 会自动刷新 Kit 清单'), submit);
    form.append(error, footer); dialog.append(form); document.body.append(dialog);
    let busy = false, installed = false;
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { inputs.forEach(input => { input.value = ''; }); dialog.remove(); if (!installed) void this.api.discardKit(plan.ticket).catch(() => {}); });
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy) return; busy = true; close.disabled = true; submit.disabled = true; submit.textContent = '正在安装…'; error.textContent = '';
      void (async () => {
        try {
          const result = await this.api.installKit({ ticket: plan.ticket, environment: Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])) });
          installed = true; dialog.close(); this.toast(`${result.name}：${result.message}`);
          this.tab = 'local'; this.tabs.kits = 'local'; $<HTMLInputElement>('town-search').value = ''; await this.load();
        } catch (err) { error.textContent = String(err).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''); }
        finally { busy = false; close.disabled = false; submit.disabled = false; submit.textContent = '重试安装'; }
      })();
    });
    dialog.showModal();
  }
  private renderLocal(library: KitLibrary) {
    const bar = node('div', 'local-kit-bar'); const path = node('div');
    path.append(node('small', 'card-meta', '沿用 Portal 的 Kit 目录'), node('code', '', library.directory));
    bar.append(path, button('打开目录 ↗', () => void this.run(() => this.api.openKits())), button('导入本地 Kit', () => void this.run(async () => {
      const result = await this.api.importKit(); if (result.installed) { this.toast(`${result.name} 已导入。Portal 将自动刷新清单。`); if (this.tab === 'local') await this.load(); }
    }), 'primary')); $('town-body').append(bar);
    const hint = node('p', 'local-kit-hint', library.enabled ? 'Portal 约每 5 秒自动刷新 Kit 清单，并在 Being 首次调用工具时启动对应 Kit。' : '当前 Portal 配置关闭了 Kits。启用后重启 Portal 才能调用这些工具。'); $('town-body').append(hint);
    if (!library.kits.length) {
      const empty = node('div', 'empty-state'); empty.append(node('div', 'empty-symbol', '◇'), node('h2', '', '给 Being 添一件工具'), node('p', '', '尚未发现本机 Kit。去 Grove 查看工具，或导入你已有的 Kit 目录。'), button('浏览 Grove →', () => { this.tab = 'grove'; this.tabs.kits = 'grove'; void this.load(); }, 'primary')); $('town-body').append(empty); return;
    }
    const { items, detail } = this.split();
    for (const kit of library.kits) {
      if (!this.matches(kit.name, kit.description, ...kit.tools.map(t => t.name))) continue;
      const card = button('', () => { items.querySelectorAll('button').forEach(b => b.classList.remove('selected')); card.classList.add('selected'); this.localDetail(kit, detail); }, 'catalog-item');
      card.append(node('strong', 'catalog-title', kit.name), node('p', '', kit.description), node('span', 'card-meta', kit.problem ? '清单异常' : `${kit.version} · ${kit.tools.length} 个工具 · ${kit.compatible ? '系统兼容' : '系统不兼容'}`)); items.append(card);
    }
    if (!items.childElementCount) items.append(node('p', 'empty-inline', '没有符合筛选条件的 Kit。'));
  }
  private localDetail(kit: LocalKit, detail: HTMLElement) {
    detail.replaceChildren(node('div', 'eyebrow', 'LOCAL KIT'), node('h2', 'reading-title', kit.name), node('p', '', kit.description), node('code', 'local-path', kit.directory));
    this.scenes.update({ sceneId: `desktop:${this.scenes.instanceId}:kit:${kit.name}`, title: `工具间 · ${kit.name}`, status: 'ready', scope: '本机 manifest；未确认工具运行能力', selection: undefined });
    detail.append(button('一起看', () => this.choose({ id: 'local-kit:' + kit.name, title: kit.name, revision: kit.version, excerpt: sceneExcerpt(kit.description), private: true }), 'scene-select'));
    if (kit.problem) { detail.append(node('p', 'inline-error', kit.problem)); return; }
    detail.append(node('p', 'card-meta', kit.eager ? 'Portal 启动时预加载' : 'Being 调用时启动'), node('pre', 'schema-block', JSON.stringify(kit.command, null, 2)));
    this.tools(kit.tools.map(t => ({ ...t })), detail);
  }
  private async run(operation: () => Promise<unknown>) { try { await operation(); } catch (error) { this.toast(error); } }
}
