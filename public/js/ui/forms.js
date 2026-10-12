import { html, render } from '../core/dom.js';
import { changed } from '../core/state.js';
import { toast } from './toast.js';

// Thrown by refreshAfterSave(): the save itself worked, only reloading the page's data failed
class SavedButNotRefreshed extends Error {}

// Call after a dialog's save has gone through. If only the follow-up reload fails, bindForm
// closes the dialog (rather than leaving it open, inviting a duplicate) and says so.
export async function refreshAfterSave() {
  try {
    await changed();
  } catch (err) {
    console.error(err);
    throw new SavedButNotRefreshed(err.message);
  }
}

// Run an async action with the button disabled and a spinner showing, so a double-click can
// never submit twice.
export async function busy(button, fn) {
  if (!button) return fn();
  if (button.getAttribute('aria-busy') === 'true') return undefined;
  const original = button.innerHTML;
  const width = button.offsetWidth;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  button.style.minWidth = `${width}px`;
  render(button, html`<span class="spinner" aria-hidden="true"></span>`);
  try {
    return await fn();
  } finally {
    if (button.isConnected) {
      button.innerHTML = original;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.style.minWidth = '';
    }
  }
}

// Wire a dialog form: native validation first, then `handler(values, button)`, where `button` is
// the one that submitted. Errors from the server appear at the top of the dialog; the dialog
// stays open so nothing typed is lost. Only one submit runs at a time, with every submit button
// disabled meanwhile, so Enter plus a click can't save twice.
// Returns submit(button), for a <button type="button" data-submit form="…"> that should submit
// too without being what Enter presses.
export function bindForm(dialog, form, handler) {
  let running = false;
  let closed = false;
  dialog.closed?.then(() => { closed = true; });
  // Footer buttons belong to the form through their form="" attribute
  const buttons = () => [...document.querySelectorAll('button[type="submit"], button[data-submit]')].filter(b => b.form === form);

  async function submit(button) {
    if (running || closed || !form.reportValidity()) return;
    running = true;
    const submitter = button || buttons()[0] || null;
    const others = buttons().filter(b => b !== submitter && !b.disabled);
    others.forEach(b => { b.disabled = true; });
    dialog.setError(null);
    try {
      await busy(submitter, () => handler(values(form), submitter));
    } catch (err) {
      if (err instanceof SavedButNotRefreshed) {
        dialog.close(true);
        toast("Saved, but the page couldn't refresh. Reload the page to see the change.", { kind: 'warning' });
        return;
      }
      console.error(err);
      dialog.setError(err.message || 'Something went wrong');
    } finally {
      running = false;
      others.forEach(b => { if (b.isConnected) b.disabled = false; });
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(event.submitter);
  });
  return submit;
}

export function values(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

// Read a picked image, crop it square and shrink it to a 256px JPEG data URL
export function readIcon(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That image couldn't be read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be read"));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const size = Math.min(img.width, img.height);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(0, 0, 256, 256);
        ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 256, 256);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Category <option>s: each top-level category followed by its subcategories, indented
export function categoryOptions(categories, selectedId, { includeTransfer = false, includeSystem = true, placeholder } = {}) {
  const out = [];
  if (placeholder) out.push(html`<option value="">${placeholder}</option>`);
  for (const c of categories) {
    if (c.id === 'cat-transfer' && !includeTransfer) continue;
    if (c.isSystem && !includeSystem && c.id !== 'cat-uncategorized') continue;
    out.push(html`<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.emoji} ${c.name}</option>`);
    for (const s of c.subcategories || []) {
      out.push(html`<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>     ${s.name}</option>`);
    }
  }
  return out;
}
