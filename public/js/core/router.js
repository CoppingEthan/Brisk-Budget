// Hash routes (#/, #/accounts/:id, #/recurring) so reloading keeps you where you were and the
// browser back button works.
const routes = [];
const listeners = new Set();
let container = null;
let current = null;
let currentPath = null;
let token = 0;
let started = false;

export function route(pattern, factory) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}$`);
  routes.push({ regex, keys, factory });
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) return resolve();
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) resolve();
}

export const onRoute = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const path = () => currentPath;
export const view = () => current;

async function resolve() {
  if (!started) return;
  let hashPath;
  try {
    hashPath = decodeURIComponent(location.hash.slice(1)) || '/';
  } catch {
    hashPath = null; // a malformed %-sequence: treat it like an unknown page
  }
  let match = null;
  for (const r of hashPath === null ? [] : routes) {
    const m = r.regex.exec(hashPath);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      match = { route: r, params };
      break;
    }
  }
  if (!match) {
    navigate('/', { replace: true });
    return;
  }
  const mine = ++token;
  const firstPage = !currentPath;
  current?.destroy?.();
  currentPath = hashPath;
  container.replaceChildren();
  container.scrollTop = 0;
  window.scrollTo(0, 0);
  const instance = match.route.factory(match.params);
  current = instance;
  for (const fn of listeners) fn(hashPath, match.params);
  // Screen readers and keyboard users start from the new page's content. Not on the first
  // page load, where focus is left where the browser puts it.
  if (!firstPage) container.focus({ preventScroll: true });
  await instance.mount(container);
  if (mine !== token) instance.destroy?.();
}

export function start(target) {
  container = target;
  started = true;
  window.addEventListener('hashchange', resolve);
  return resolve();
}

// Stop following the address bar (signed out): the page stays as it is until a reload
export function stop() {
  if (!started) return;
  started = false;
  token++;
  window.removeEventListener('hashchange', resolve);
  current?.destroy?.();
  current = null;
}

export function refresh() {
  return current?.refresh?.();
}
