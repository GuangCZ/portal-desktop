// Navigation is independent of composing or sending a message.
export function mountChatPlaces(send: (message: Record<string, unknown>) => void) {
  const tools = document.getElementById('desktop-composer-tools');
  if (!tools) return;
  const wrapper = document.createElement('div'); wrapper.id = 'chat-places';
  const trigger = document.createElement('button'); trigger.type = 'button';
  trigger.id = 'chat-places-trigger'; trigger.setAttribute('aria-controls', 'chat-places-menu');
  trigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
  const popup = document.createElement('div'); popup.id = 'chat-places-popup';
  const menu = document.createElement('nav'); menu.id = 'chat-places-menu';
  menu.setAttribute('aria-label', '小镇入口');
  const places = [
    ['bonfire', '篝火', '<path d="M12 3c1 4-4 5-4 9 0 1 .5 2 1 2 0-3 3-3 4-6 4 3 6 6 5 9a6.5 6.5 0 0 1-12-1c-1-5 3-8 6-13Z"/>'],
    ['firesides', '围炉', '<circle cx="8" cy="7" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 4 5v3"/>'],
    ['mail', '私信', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'],
    ['seeds', '花园', '<path d="M12 21V11M12 15C5 15 3 11 3 6c6 0 9 3 9 9ZM12 11c0-6 3-9 9-9 0 6-3 9-9 9Z"/>'],
    ['embers', '书架', '<path d="M12 5v16M12 5C9 3 6 3 3 4v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-3-1-6-1-9 1Z"/>'],
    ['scrolls', '卷轴', '<path d="M7 3h12a2 2 0 0 1 2 2v3h-4V5a2 2 0 0 1 4 0M7 3a2 2 0 0 0-2 2v14a2 2 0 0 1-4 0v-3h12v3a2 2 0 0 0 4 0V7M3 21h12M8 8h5M8 12h5"/>'],
  ];
  let hasActivity = false;
  const labelTrigger = () => {
    const label = (popup.hidden ? '展开小镇入口' : '收起小镇入口') + (hasActivity ? ' · 有新动态' : '');
    trigger.setAttribute('aria-label', label); trigger.title = label;
  };
  const setOpen = (open: boolean) => {
    popup.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); labelTrigger();
  };
  const items = places.map(([view, label, icon]) => {
    const item = document.createElement('button'); item.type = 'button'; item.dataset.place = view;
    item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>`;
    item.addEventListener('click', () => send({ type: 'beings:open-place', view }));
    menu.append(item); return item;
  });
  popup.append(menu); wrapper.append(trigger, popup); tools.prepend(wrapper); setOpen(true);
  // Loom focuses the composer on document clicks; navigation keeps its own focus.
  wrapper.addEventListener('click', event => event.stopPropagation());
  trigger.addEventListener('click', () => setOpen(popup.hidden));
  wrapper.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus(); return; }
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); setOpen(true);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      current < 0 ? (backwards ? items.length - 1 : 0) : (current + (backwards ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  });
  return (channels: string[]) => {
    hasActivity = channels.length > 0;
    trigger.classList.toggle('has-town-activity', channels.length > 0);
    labelTrigger();
    for (const item of items) {
      const active = channels.includes(item.dataset.place!);
      item.classList.toggle('has-town-activity', active);
      item.setAttribute('aria-label', item.textContent + (active ? ' · 有新动态' : ''));
    }
  };

}
