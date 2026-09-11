import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { sceneExcerpt, type SceneResource } from './scene-store';

type Entry = Record<string, unknown>;
export interface FeedFilters { relation: string; order: string; days: string; author: string }
export interface FeedReply { id: string | number; author: string; preview: string }
export const newFeedFilters = (): FeedFilters => ({ relation: 'all', order: 'newest', days: 'all', author: '' });
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const record = (value: unknown): Entry => value && typeof value === 'object' && !Array.isArray(value) ? value as Entry : {};
const identity = (value: unknown): string => text(record(value).being_id || record(value).id || value).toLowerCase();
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = '') {
  const result = document.createElement(tag); result.className = className; result.textContent = content; return result;
}
function bodyMarkdown(content: string) {
  const body = el('div', 'reading-text social-body');
  body.innerHTML = DOMPurify.sanitize(marked.parse(content, { async: false }), { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del'], ALLOWED_ATTR: ['href', 'title'] });
  for (const link of body.querySelectorAll('a')) {
    if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noreferrer noopener'; }
  }
  return body;
}

export function renderTownFeed(holder: HTMLElement, entries: Entry[], options: {
  me: string; mail?: 'inbox' | 'sent'; search: string; filters: FeedFilters; limit: number;
  private?: boolean; onSelect?: (resource: SceneResource) => void;
  onReply?: (reply: FeedReply) => void;
  onFilters?: (filters: Record<string, string>, count: number) => void;
}) {
  holder.replaceChildren(); holder.classList.add('social-feed');
  const me = options.me.toLowerCase();
  const messages = entries.map((entry, index) => {
    const authorId = identity(options.mail ? entry.sender_being_id || entry.sender : entry.being_id || entry.being);
    const author = text(entry.sender_name || entry.speaker_name || record(entry.being).display_name || entry.display_name) || authorId || '未知';
    const recipientId = identity(entry.recipient_being_id || entry.recipient);
    const recipient = text(entry.recipient_name) || recipientId;
    const content = text(entry.message || entry.content);
    const mentionedIds = Array.isArray(entry.mentions) ? entry.mentions.map(identity) : [];
    // Exact @identifier tokens avoid matching e.g. alice in @alice_work.
    const textMentions = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(match => match[1].toLowerCase());
    const mentioned = Boolean(me && (mentionedIds.includes(me) || textMentions.includes(me)));
    const mine = Boolean(me && authorId === me);
    const received = Boolean(options.mail === 'inbox' || (me && recipientId === me));
    const sent = Boolean(options.mail === 'sent' || mine);
    const rawDate = text(entry.at || entry.created_at);
    const time = Date.parse(rawDate);
    return { entry, index, authorId, author, recipient, content, mentioned, mine: sent, received, related: mentioned || sent || received, rawDate, time };
  });
  const filters = options.filters;
  const toolbar = el('div', 'feed-controls');
  const relations = el('div', 'feed-relations'); relations.setAttribute('aria-label', '消息关系筛选');
  const list = el('div', 'social-messages');
  const summary = el('div', 'feed-summary'); summary.setAttribute('role', 'status');
  const selectors = el('div', 'feed-selectors');
  const more = el('details', 'feed-options'), moreLabel = el('summary', '', '筛选'); more.append(moreLabel, selectors);
  more.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); more.open = false; moreLabel.focus(); } });
  const relationOptions = [['all', '全部'], ['about', '关于我']];
  for (const [value, label] of relationOptions) {
    const button = el('button', '', label); button.type = 'button'; button.dataset.relation = value;
    button.disabled = !me && !options.mail && value !== 'all';
    button.addEventListener('click', () => { filters.relation = value; draw(); }); relations.append(button);
  }
  if (!me && (!options.mail || filters.relation === 'mentions')) filters.relation = 'all';
  function select(label: string, values: [string, string][], key: 'order' | 'days' | 'author') {
    const field = el('label', 'feed-select', label), control = el('select'); control.setAttribute('aria-label', label);
    for (const [value, caption] of values) { const option = el('option', '', caption); option.value = value; control.append(option); }
    if (!values.some(([value]) => value === filters[key])) filters[key] = values[0][0];
    control.value = filters[key]; control.addEventListener('change', () => { filters[key] = control.value; draw(); });
    field.append(control); selectors.append(field);
  }
  select('排序', [['newest', '最新在前'], ['oldest', '最早在前']], 'order');
  select('时间', [['all', '全部时间'], ['1', '最近 24 小时'], ['7', '最近 7 天'], ['30', '最近 30 天']], 'days');
  const authors = [...new Map(messages.map(message => [message.authorId || message.author, message.author])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  select('作者', [['', '全部作者'], ...authors], 'author');
  toolbar.append(relations, more); holder.append(toolbar, summary, list);
  function draw() {
    relations.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      const active = button.dataset.relation === filters.relation; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
    });
    const changed = filters.order !== 'newest' || filters.days !== 'all' || Boolean(filters.author);
    moreLabel.textContent = changed ? '筛选 · 已设置' : '筛选';
    const query = options.search.trim().toLowerCase();
    const cutoff = filters.days === 'all' ? -Infinity : Date.now() - Number(filters.days) * 86400000;
    const filtered = messages.filter(message =>
      (filters.relation === 'all' || filters.relation === 'about' && message.related || filters.relation === 'mentions' && message.mentioned || filters.relation === 'mine' && message.mine) &&
      (!filters.author || (message.authorId || message.author) === filters.author) &&
      (cutoff === -Infinity || Number.isFinite(message.time) && message.time >= cutoff) &&
      (!query || [message.author, message.authorId, message.recipient, message.content].join(' ').toLowerCase().includes(query))
    ).sort((a, b) => {
      const delta = (Number.isFinite(a.time) ? a.time : 0) - (Number.isFinite(b.time) ? b.time : 0);
      const tie = Number(a.entry.seq || 0) - Number(b.entry.seq || 0) || a.index - b.index;
      return (delta || tie) * (filters.order === 'newest' ? -1 : 1);
    });
    summary.textContent = `${filtered.length} / ${messages.length} 条 · 最近 ${options.limit} 条内筛选${me ? ' · 当前身份 ' + me : ' · 配对后可识别 @我和我的发言'}`;
    options.onFilters?.({ ...filters, search: options.search }, filtered.length);
    list.replaceChildren();
    for (const message of filtered) {
      const card = el('article', 'social-message');
      const avatar = el('span', 'social-avatar', message.author.slice(0, 1)); avatar.setAttribute('aria-hidden', 'true');
      const content = el('div', 'social-content'), header = el('div', 'social-meta');
      const author = el('strong', 'social-author', message.author); author.title = message.authorId; header.append(author);
      if (message.authorId && message.authorId !== message.author.toLowerCase()) header.append(el('span', 'social-author-id', '@' + message.authorId));
      const via = text(message.entry.via);
      if (via.startsWith('client:')) {
        const source = el('span', 'relation-tag via-tag', '借 ' + (via.slice(7) || '客户端'));
        source.title = '人类伙伴通过客户端，以此 Being 的身份发言';
        header.append(source);
      }
      if (message.mine) header.append(el('span', 'relation-tag', '本 Being 发送'));
      if (message.received) header.append(el('span', 'relation-tag', '发给我'));
      if (message.mentioned) { header.append(el('span', 'relation-tag mention-tag', '@我')); card.classList.add('mentions-me'); }
      if (options.mail && message.recipient) header.append(el('span', 'social-recipient', '→ ' + message.recipient));
      const time = el('time', '', Number.isFinite(message.time) ? new Date(message.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : message.rawDate);
      if (Number.isFinite(message.time)) time.dateTime = new Date(message.time).toISOString(); header.append(time);
      content.append(header);
      if (message.entry.reply_to !== undefined && message.entry.reply_to !== null) {
        const quote = el('blockquote', 'feed-reply-preview');
        quote.append(el('strong', '', '回复 ' + text(message.entry.reply_to_being || message.entry.reply_to_sender || '#' + text(message.entry.reply_to))), el('span', '', text(message.entry.reply_to_preview).slice(0, 500) || '原消息预览不可用'));
        content.append(quote);
      }
      const body = bodyMarkdown(message.content);
      if (message.content.length > 480 || message.content.split('\n').length > 8) {
        const details = el('details', 'social-expand'); const preview = el('summary');
        preview.append(el('span', 'social-preview', (body.textContent || message.content).replace(/\s+/g, ' ').trim().slice(0, 240)), el('span', 'expand-label', '展开全文'));
        const close = el('button', 'text-button', '收起全文'); close.type = 'button';
        close.addEventListener('click', () => { details.open = false; preview.focus(); });
        details.append(preview, body, close); content.append(details);
      } else content.append(body);
      const footer = el('div', 'social-foot');
      if (options.mail) {
        const state = text(message.entry.delivery_status);
        const labels: Record<string, string> = { delivered: '已送达', pending: '待送达', failed: '送达失败', read: '已读' };
        footer.textContent = labels[state] || state;
      } else footer.textContent = `#${text(message.entry.seq)}${message.entry.revised_at ? ' · 已编辑' : ''}`;
      const replyId = Number(message.entry.seq);
      const validReply = !options.mail && Number.isSafeInteger(replyId) && replyId > 0;
      if (options.onReply && validReply) {
        const reply = el('button', 'scene-select', '回复'); reply.type = 'button';
        reply.onclick = () => options.onReply!({ id: replyId, author: message.author, preview: message.content.slice(0, 500) });
        footer.append(reply);
      }
      if (options.onSelect) {
        const choose = el('button', 'scene-select', '一起看'); choose.type = 'button';
        choose.addEventListener('click', () => {
          list.querySelectorAll('.scene-selected').forEach(item => item.classList.remove('scene-selected'));
          card.classList.add('scene-selected');
          options.onSelect!({ id: 'message:' + text(message.entry.id || message.entry.seq || `${message.authorId}:${message.rawDate}:${message.index}`), title: `${message.author} 的发言`, author: message.authorId || message.author, revision: text(message.entry.revised_at || message.rawDate), excerpt: sceneExcerpt(message.content), private: Boolean(options.private || options.mail) });
        });
        footer.append(choose);
      }
      content.append(footer); card.append(avatar, content); list.append(card);
    }
    if (!filtered.length) {
      const empty = el('div', 'feed-empty'); empty.append(el('strong', '', messages.length ? '没有符合条件的消息' : '暂无消息'), el('p', '', messages.length ? '试试其他筛选条件，或清空搜索关键词。' : '刷新后，新消息会显示在这里。'));
      if (messages.length) { const reset = el('button', 'secondary', '重置筛选'); reset.addEventListener('click', () => { Object.assign(filters, newFeedFilters()); renderTownFeed(holder, entries, options); }); empty.append(reset); }
      list.append(empty);
    }
  }
  draw();
}
