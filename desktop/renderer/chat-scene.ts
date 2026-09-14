import { mountChatPlaces } from './chat-places';
import { mountChatLinks } from './chat-links';
(() => {
  const revision = new URLSearchParams(location.search).get('revision');
  const send = (data: Record<string, unknown>) => parent.postMessage({ ...data, revision }, '*');
  const sbs = window as unknown as { toggleSbs: () => Promise<void>; loadSbsState: () => Promise<boolean | undefined> };
  let sbsRequest = 0;
  window.addEventListener('loom:sbs-state', event => {
    const enabled: unknown = (event as CustomEvent).detail;
    if (typeof enabled !== 'boolean') return;
    ++sbsRequest;
    send({ type: 'beings:sbs-state', enabled });
  });
  const refreshSbs = async () => {
    const request = ++sbsRequest;
    let enabled: boolean | undefined;
    try { enabled = await sbs.loadSbsState(); } catch { /* Report unknown, never a default or cached value. */ }
    if (request !== sbsRequest) return;
    send(typeof enabled === 'boolean' ? { type: 'beings:sbs-state', enabled } : { type: 'beings:sbs-state', known: false });
  };
  const updatePlaces = mountChatPlaces(send);
  mountChatLinks(send);
  const composer = document.getElementById('input') as HTMLTextAreaElement | null;
  if (composer) composer.placeholder = '说点什么…';
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); send({ type: 'beings:open-settings' }); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); send({ type: 'beings:chat-search' });
    }
  });
  let draftPrefix = '';
  const waiting = new Map<string, () => void>();
  // A topic can grow out of either participant's words, without a permanent toolbar.
  const focusButton = document.createElement('button');
  focusButton.id = 'scene-selection-action'; focusButton.textContent = '一起看这段 ↗';
  focusButton.type = 'button'; focusButton.hidden = true; document.body.append(focusButton);
  let selection: { id: string; text: string; role: 'user' | 'being' } | null = null;
  document.addEventListener('selectionchange', () => {
    const selected = window.getSelection();
    const anchor = selected?.anchorNode;
    const content = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('#messages .message .content');
    const message = content?.closest('.message');
    if (!selected || selected.isCollapsed || !content || !selected.focusNode || !content.contains(selected.focusNode) ||
        !message || (!message.classList.contains('user') && !message.classList.contains('being')) || !selected.toString().trim()) {
      selection = null; focusButton.hidden = true; return;
    }
    const element = message as HTMLElement;
    element.dataset.sceneId ||= crypto.randomUUID();
    const text = selected.toString().trim();
    selection = { id: element.dataset.sceneId, text: text.length > 2000 ? text.slice(0, 2000) + '\n[引用已截取]' : text,
      role: message.classList.contains('user') ? 'user' : 'being' };
    const rect = selected.getRangeAt(0).getBoundingClientRect();
    focusButton.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 140))}px`;
    focusButton.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - 44))}px`;
    focusButton.hidden = false;
  });
  focusButton.addEventListener('mousedown', event => event.preventDefault());
  focusButton.addEventListener('click', () => {
    if (selection) send({ type: 'beings:scene-select', ...selection });
    focusButton.hidden = true; window.getSelection()?.removeAllRanges();
  });
  document.addEventListener('scroll', () => { focusButton.hidden = true; }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') focusButton.hidden = true; });
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data?.type === 'beings:sbs-toggle') {
      void (async () => {
        try { await sbs.toggleSbs(); } finally { await refreshSbs(); }
      })().catch(() => {});
      return;
    }
    if (data?.type === 'beings:sbs-request') {
      void refreshSbs();
      return;
    }
    if (data?.type === 'beings:reading' && Number.isInteger(data.size) && data.size >= 13 && data.size <= 21) {
      document.documentElement.style.setProperty('--reading-size', data.size + 'px'); return;
    }
    if (data?.type === 'beings:town-activity' && Array.isArray(data.channels)) { updatePlaces?.(data.channels.filter((v: unknown) => ['bonfire', 'mail', 'firesides'].includes(String(v)))); return; }
    if (data?.type === 'beings:chat-action') {
      const ui = window as unknown as { toggleSettings: () => void; toggleSoulCard: () => void; togglePrivacy: () => void };
      if (data.action === 'model') ui.toggleSettings();
      if (data.action === 'being') ui.toggleSoulCard();
      if (data.action === 'privacy') ui.togglePrivacy();
      return;
    }
    if (data?.type === 'beings:scene-captured' && typeof data.id === 'string') waiting.get(data.id)?.();
    if (data?.type !== 'beings:scene-draft' || typeof data.id !== 'string' || typeof data.text !== 'string' || data.text.length > 16000) return;
    if (typeof data.expiresAt !== 'number' || Date.now() > data.expiresAt) return;
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input || input.value.trim() || document.querySelector('#pending-files .pending-file')) {
      send({ type: 'beings:scene-draft-result', id: data.id, ok: false }); return;
    }
    input.value = data.text; draftPrefix = data.text.split('以下是引用内容：')[0];
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    send({ type: 'beings:scene-draft-result', id: data.id, ok: true });
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || url.pathname !== '/api/chat/stream' || init?.method !== 'POST' || typeof init.body !== 'string') return originalFetch(input, init);
    let text = '';
    try { text = JSON.parse(init.body).message || ''; } catch { return originalFetch(input, init); }
    const id = crypto.randomUUID();
    const hasSceneDraft = Boolean(draftPrefix && typeof text === 'string' && text.startsWith(draftPrefix));
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); waiting.delete(id); resolve(); };
      const timer = setTimeout(finish, 250);
      waiting.set(id, finish); send({ type: 'beings:scene-capture', id, hasSceneDraft });
    });
    try {
      const response = await originalFetch(input, init);
      send({ type: 'beings:scene-result', id, hasSceneDraft, ok: response.ok });
      if (hasSceneDraft && response.ok) draftPrefix = '';
      return response;
    } catch (error) { send({ type: 'beings:scene-result', id, hasSceneDraft, ok: false }); throw error; }
  };
})();
