import { placeFromURL, placeNames, type PlaceTarget, type PlaceView } from './place-target';

export function mountChatLinks(send: (message: Record<string, unknown>) => void) {
  const messages = document.getElementById('messages');
  if (!messages) return;
  const terms: Record<string, PlaceView> = { 篝火: 'bonfire', 围炉: 'firesides', 私信: 'mail', 邮局: 'mail', 收件箱: 'mail',
    书架: 'embers', 卷轴: 'scrolls', 工具库: 'kits', 本机连接: 'portal', bonfire: 'bonfire', fireside: 'firesides',
    种子花园: 'seeds', 'seed garden': 'seeds', seeds: 'seeds',
    embers: 'embers', scrolls: 'scrolls', kit: 'kits', kits: 'kits', portal: 'portal' };
  const pattern = /篝火|围炉|私信|邮局|收件箱|书架|卷轴|工具库|本机连接|种子花园|\b(?:seed garden|seeds|bonfire|fireside|embers|scrolls|kits?|portal)\b/gi;
  const targets = new WeakMap<Element, PlaceTarget>();
  const pending = new Set<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const contentOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.message.user > .content, .message.being > .content');
  function decorate(content: HTMLElement) {
    // Loom owns streaming HTML; decorate after it finalizes the current message.
    if (!content.isConnected || content.classList.contains('stream-cursor')) return;
    const linked = new Set<PlaceView>();
    for (const code of content.querySelectorAll('code')) {
      // A standalone URL is still a link when the Being formats it as code.
      // Read across syntax-highlighting spans and retain the original copyable text.
      if (code.closest('a,button') || code.querySelector('a,button')) continue;
      const value = code.textContent?.trim() || '';
      if (!/^https?:\/\/[^\s<>"'`]+$/i.test(value)) continue;
      let url: URL;
      try { url = new URL(value); } catch { continue; }
      if (url.username || url.password) continue;
      const link = document.createElement('a');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.className = 'chat-code-link'; link.title = '在内置浏览器打开';
      while (code.firstChild) link.append(code.firstChild);
      code.append(link);
    }
    for (const link of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const target = placeFromURL(link.getAttribute('href')!);
      if (target) { targets.set(link, target); link.classList.add('chat-place-link'); link.title = `在这里打开${placeNames[target.view]}${target.id ? '详情' : ''}`; linked.add(target.view); }
    }
    for (const button of content.querySelectorAll('.chat-place-link')) {
      const target = targets.get(button); if (target) linked.add(target.view);
    }
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('a,button,pre,code,svg,textarea,[contenteditable]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      const value = text.data; pattern.lastIndex = 0;
      let match: RegExpExecArray | null, end = 0;
      const fragment = document.createDocumentFragment();
      while ((match = pattern.exec(value))) {
        const view = terms[match[0].toLowerCase()];
        if (linked.has(view)) continue;
        linked.add(view);
        fragment.append(document.createTextNode(value.slice(end, match.index)));
        const button = document.createElement('button'); button.type = 'button'; button.className = 'chat-place-link';
        button.textContent = match[0]; button.title = `打开${placeNames[view]}`; button.setAttribute('aria-label', `打开${placeNames[view]}`);
        targets.set(button, { view }); fragment.append(button); end = match.index + match[0].length;
      }
      if (end) { fragment.append(document.createTextNode(value.slice(end))); text.replaceWith(fragment); }
    }
  }
  function queue(node: Node) {
    const content = contentOf(node); if (content) pending.add(content);
    if (node instanceof Element && !content) node.querySelectorAll<HTMLElement>('.message.user > .content, .message.being > .content').forEach(item => pending.add(item));
    if (pending.size && !timer) timer = setTimeout(flush, 100);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.target !== messages) queue(record.target);
      for (const node of record.addedNodes) queue(node);
    }
  });
  function observe() { observer.observe(messages!, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] }); }
  function flush() {
    timer = undefined; observer.disconnect();
    try { for (const content of pending) decorate(content); }
    finally { pending.clear(); observe(); }
  }
  messages.addEventListener('click', event => {
    const element = (event.target as Element).closest('.chat-place-link');
    const target = element && targets.get(element);
    if (!target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || window.getSelection()?.toString()) return;
    event.preventDefault(); event.stopPropagation(); send({ type: 'beings:open-place', ...target });
  });
  queue(messages); observe();
}
