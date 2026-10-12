// HTML templating with escaping by default. Anything interpolated into html`` is escaped
// unless it is itself html`` (or raw()), so user-entered names can never inject markup.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

class SafeHTML {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

export const raw = (value) => new SafeHTML(String(value ?? ''));

function part(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHTML) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  return escapeHTML(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHTML(out);
}

export function render(target, content) {
  target.innerHTML = content instanceof SafeHTML ? content.value : escapeHTML(content);
  return target;
}

// Turn a template into a single element
export function toElement(content) {
  const template = document.createElement('template');
  template.innerHTML = (content instanceof SafeHTML ? content.value : escapeHTML(content)).trim();
  return template.content.firstElementChild;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Delegated events: on(list, 'click', '[data-action]', (event, el) => ...)
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target.closest?.(selector);
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const cx = (...names) => names.filter(Boolean).join(' ');

let idCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${++idCounter}`;

export function storage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or storage full: preferences just won't persist
  }
}
