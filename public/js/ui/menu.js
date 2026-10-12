import { html, toElement } from '../core/dom.js';
import { icon } from '../core/icons.js';

let openMenuState = null;

export const menuOpen = () => !!openMenuState;

export function closeMenu() {
  if (!openMenuState) return;
  const { el, anchor, cleanup } = openMenuState;
  openMenuState = null;
  cleanup();
  el.remove();
  anchor.setAttribute('aria-expanded', 'false');
}

// openMenu(button, [{ label, icon, run, danger, disabled } | 'separator'])
export function openMenu(anchor, items, { align = 'end' } = {}) {
  if (openMenuState?.anchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  const el = toElement(html`
    <div class="menu" role="menu">
      ${items.map((item, i) => item === 'separator'
        ? html`<div class="menu-separator" role="separator"></div>`
        : html`<button type="button" class="menu-item ${item.danger ? 'danger' : ''}" role="menuitem" data-index="${i}" ${item.disabled ? 'disabled' : ''}>
            ${item.icon ? icon(item.icon) : ''}<span>${item.label}</span>
          </button>`)}
    </div>
  `);
  document.body.append(el);

  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = align === 'end' ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const buttons = [...el.querySelectorAll('.menu-item:not(:disabled)')];
  const onClick = (event) => {
    const button = event.target.closest('.menu-item');
    if (button && el.contains(button)) {
      const item = items[Number(button.dataset.index)];
      closeMenu();
      // Back on the button first, so a dialog the item opens returns focus there when it closes
      anchor.focus({ preventScroll: true });
      item.run?.();
      return;
    }
    if (!el.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      closeMenu();
      anchor.focus();
    }
  };
  const onScroll = (event) => { if (!el.contains(event.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('click', onClick), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', onScroll, true);
  openMenuState = {
    el,
    anchor,
    cleanup: () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', onScroll, true);
    }
  };
  buttons[0]?.focus({ preventScroll: true });
}
