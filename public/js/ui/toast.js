import { html, toElement } from '../core/dom.js';

const MAX_TOASTS = 4;

// toast('Saved', { kind: 'success', action: { label: 'Undo', run: () => ... } })
// duration: 0 keeps the toast until its action is used (e.g. "Reload" after an update).
// The #toasts container is the live region that announces each toast, so toasts carry no role
// of their own (that would make screen readers read them twice).
export function toast(message, { kind = 'info', action = null, duration } = {}) {
  const host = document.getElementById('toasts');
  const wait = duration ?? (action ? 8000 : kind === 'error' ? 7000 : 4000);
  const el = toElement(html`
    <div class="toast ${kind}" data-persistent="${wait > 0 ? 'false' : 'true'}">
      <span class="toast-message">${message}</span>
      ${action ? html`<button type="button" class="btn btn-secondary">${action.label}</button>` : ''}
    </div>
  `);
  let timer;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) {
    el.querySelector('button').addEventListener('click', async () => {
      close();
      try {
        await action.run();
      } catch (err) {
        toastError(err);
      }
    });
  }
  // Pause while the pointer or keyboard focus is on the toast, so its button can be reached
  const arm = () => {
    clearTimeout(timer);
    if (wait > 0 && !el.matches(':hover, :focus-within')) timer = setTimeout(close, wait);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', () => setTimeout(arm, 0));
  host.append(el);
  // Make room by dropping the oldest toasts, but never one that is waiting to be acted on
  const extra = [...host.children].filter(t => !t.classList.contains('leaving'));
  for (const old of extra.filter(t => t.dataset.persistent !== 'true').slice(0, Math.max(0, extra.length - MAX_TOASTS))) old.remove();
  arm();
  return { close };
}

export function toastError(err) {
  console.error(err);
  // Signed out: the sign-in screen is already showing, so there is nothing more to say
  if (err?.signedOut) return { close() {} };
  return toast(err?.message || 'Something went wrong', { kind: 'error' });
}
