/** A compact, keyboard-accessible disclosure with reversible opening/closing motion. */
export function mountOptions() {
  const options = document.getElementById('conversation-options') as HTMLDetailsElement;
  const trigger = document.getElementById('options-trigger')!;
  const menu = options.querySelector<HTMLElement>('.options-menu')!;
  const home = document.getElementById('options-home')!;
  const secondary = document.getElementById('options-secondary')!;
  const help = document.getElementById('options-help')!;
  const back = document.getElementById('options-back')!;
  let motion: Animation | undefined;
  let expanded = false;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function page(helpPage: boolean, focus = true) {
    home.hidden = helpPage; secondary.hidden = !helpPage;
    help.setAttribute('aria-expanded', String(helpPage));
    if (focus) (helpPage ? back : help).focus();
  }
  function toggle(open: boolean, restoreFocus = false) {
    if (open === expanded) return;
    expanded = open;
    const from = options.open ? { opacity: getComputedStyle(menu).opacity, transform: getComputedStyle(menu).transform } : { opacity: '0', transform: 'translateY(-5px) scale(.98)' };
    motion?.cancel();
    if (open) { page(false, false); options.open = true; }
    trigger.setAttribute('aria-expanded', String(open));
    menu.inert = !open;
    if (restoreFocus) trigger.focus();
    motion = menu.animate([from, { opacity: open ? '1' : '0', transform: open ? 'translateY(0) scale(1)' : 'translateY(-5px) scale(.98)' }], { duration: reduced() ? 0 : open ? 180 : 120, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    motion.onfinish = () => { options.open = expanded; motion?.cancel(); motion = undefined; };
  }
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', event => { event.preventDefault(); toggle(!expanded); });
  help.addEventListener('click', () => page(true));
  back.addEventListener('click', () => page(false));
  options.addEventListener('click', event => {
    const button = (event.target as Element).closest('button');
    if (button && button !== help && button !== back) toggle(false);
  });
  document.addEventListener('pointerdown', event => { if (!options.contains(event.target as Node)) toggle(false); });
  document.addEventListener('focusin', event => { if (!options.contains(event.target as Node)) toggle(false); });
  // A click inside the isolated chat iframe moves focus off this document.
  window.addEventListener('blur', () => toggle(false));
  options.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!secondary.hidden) page(false); else toggle(false, true);
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); toggle(true);
      const buttons = [...(secondary.hidden ? home : secondary).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : index < 0 ? 0 : -1) + buttons.length) % buttons.length]?.focus();
    }
  });
  const settings = document.getElementById('client-settings-dialog') as HTMLDialogElement;
  const tabs = [...settings.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  function selectTab(tab: HTMLButtonElement) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')!)!.hidden = !selected;
    }
  }
  document.getElementById('client-settings-button')!.addEventListener('click', () => selectTab(tabs[0]));
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!offset && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length];
      selectTab(next); next.focus();
    });
  });
  settings.addEventListener('click', event => {
    if ((event.target as Element).closest('[data-settings-route]')) settings.close();
  }, true);
}
