import { html, render, toElement, uid } from '../core/dom.js';
import { icon } from '../core/icons.js';

const stack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FIELDS = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

// display:none elements (hidden file inputs, collapsed sections) can't take focus
const visible = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0);
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(visible);

export const dialogOpen = () => stack.length > 0;

// Only the top dialog can be reached: the app behind and any lower dialogs are made inert
function syncInert() {
  const app = document.getElementById('app');
  if (app) app.inert = stack.length > 0;
  stack.forEach((d, i) => { d.layer.inert = i < stack.length - 1; });
}

function onKeydown(event) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (event.key === 'Escape' && top.dismissible) {
    if (document.querySelector('.menu')) return; // let an open menu close first
    event.preventDefault();
    top.close(null);
  } else if (event.key === 'Tab') {
    const items = focusables(top.section);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = top.section.contains(document.activeElement);
    if (!inside) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}
document.addEventListener('keydown', onKeydown);

// openDialog({ title, size: 'sm'|'md'|'lg'|'xl', body, footer, flush, dismissible, onClose, initialFocus })
// initialFocus: a selector inside the dialog, or false for the close button. By default the first
// visible, enabled form field gets focus, then the close button.
// Returns a controller: { section, body, footer, close(result), closed (Promise), setError }
export function openDialog({ title, size = 'md', body = '', footer = null, flush = false, dismissible = true, onClose, labelledBy, initialFocus } = {}) {
  const titleId = uid('dialog-title');
  const layer = toElement(html`
    <div class="dialog-layer">
      <div class="dialog-backdrop"></div>
      <section class="dialog ${size}" role="dialog" aria-modal="true" aria-labelledby="${labelledBy || titleId}">
        <header class="dialog-header">
          <h2 id="${titleId}">${title}</h2>
          <button type="button" class="icon-btn" data-dialog-close aria-label="Close">${icon('x')}</button>
        </header>
        <div class="dialog-body ${flush ? 'flush' : ''}"></div>
        <footer class="dialog-footer"></footer>
      </section>
    </div>
  `);
  const section = layer.querySelector('.dialog');
  const bodyEl = layer.querySelector('.dialog-body');
  const footerEl = layer.querySelector('.dialog-footer');
  const closeButton = layer.querySelector('[data-dialog-close]');
  if (body instanceof Node) bodyEl.append(body);
  else render(bodyEl, body);
  if (footer instanceof Node) footerEl.append(footer);
  else if (footer) render(footerEl, footer);
  else footerEl.remove();

  const previous = document.activeElement;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let isClosed = false;
  const openedAt = performance.now();

  const controller = {
    layer,
    section,
    body: bodyEl,
    footer: footerEl,
    dismissible,
    closed,
    close(result = null) {
      if (isClosed) return;
      isClosed = true;
      const i = stack.indexOf(controller);
      if (i >= 0) stack.splice(i, 1);
      layer.classList.remove('open');
      layer.inert = true; // nothing in a closing dialog can be clicked twice
      syncInert();
      const finish = () => {
        layer.remove();
        if (!stack.length) document.body.classList.remove('has-dialog');
        // Hand focus back to whatever opened the dialog, unless something else (a new page,
        // another dialog) has already taken it
        const now = document.activeElement;
        const free = !now || now === document.body || layer.contains(now);
        if (free && previous && document.contains(previous)) previous.focus?.({ preventScroll: true });
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
      else setTimeout(finish, 180);
      onClose?.(result);
      resolveClosed(result);
    },
    setTitle(text) {
      layer.querySelector(`#${titleId}`).textContent = text;
    },
    setError(message) {
      let box = bodyEl.querySelector(':scope > .dialog-error');
      if (!message) { box?.remove(); return; }
      if (!box) {
        box = toElement(html`<div class="alert error dialog-error" role="alert"></div>`);
        bodyEl.prepend(box);
      }
      render(box, html`${icon('alert')}<span>${message}</span>`);
      bodyEl.scrollTop = 0;
    }
  };

  closeButton.addEventListener('click', () => controller.close(null));
  // Close on a backdrop click only when the press started on the backdrop, and not straight
  // after opening: the second click of a double-click on the opening button lands here.
  const backdrop = layer.querySelector('.dialog-backdrop');
  let pressedBackdrop = false;
  backdrop.addEventListener('pointerdown', () => { pressedBackdrop = performance.now() - openedAt > 400; });
  backdrop.addEventListener('click', () => {
    if (pressedBackdrop && controller.dismissible) controller.close(null);
    pressedBackdrop = false;
  });
  layer.addEventListener('click', (event) => {
    if (event.target.closest('[data-dialog-cancel]')) controller.close(null);
  });

  document.getElementById('dialogs').append(layer);
  document.body.classList.add('has-dialog');
  stack.push(controller);
  syncInert();

  const focusTarget = () => {
    if (initialFocus === false) return closeButton;
    const chosen = typeof initialFocus === 'string' ? section.querySelector(initialFocus) : null;
    if (chosen && visible(chosen)) return chosen;
    const auto = section.querySelector('[autofocus]');
    if (auto && visible(auto)) return auto;
    return [...bodyEl.querySelectorAll(FIELDS)].find(visible) || closeButton;
  };
  // Move focus in straight away so keys can't reach the page behind, then again once the
  // dialog has rendered (fields shown by the caller after opening are visible by then)
  closeButton.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (isClosed) return;
    layer.classList.add('open');
    if (section.contains(document.activeElement) && document.activeElement !== closeButton) return;
    focusTarget().focus({ preventScroll: true });
  });
  return controller;
}

export function closeAllDialogs() {
  for (const d of [...stack].reverse()) d.close(null);
}

// Ask a yes/no question. Resolves to true when confirmed. Cancel has focus, so a stray Enter
// never deletes anything.
export function confirmDialog({ title, message, detail, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true }) {
  const dialog = openDialog({
    title,
    size: 'sm',
    initialFocus: '[data-dialog-cancel]',
    body: html`<p>${message}</p>${detail ? html`<p class="muted" style="margin-top:.75rem;font-size:var(--text-sm)">${detail}</p>` : ''}`,
    footer: html`
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>${cancelLabel}</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${confirmLabel}</button>
    `
  });
  dialog.footer.querySelector('[data-confirm]').addEventListener('click', () => dialog.close(true));
  return dialog.closed.then(result => result === true);
}
