import { html, render, $, on } from './core/dom.js';
import { icon } from './core/icons.js';
import { api, onUnauthorized, onServerVersion } from './core/api.js';
import { state, load, subscribe } from './core/state.js';
import { route, start, stop as stopRouter, onRoute, refresh as refreshView, view } from './core/router.js';
import { createSidebar } from './shell/sidebar.js';
import { showLogin } from './shell/login.js';
import { toast } from './ui/toast.js';
import { closeAllDialogs, dialogOpen } from './ui/dialog.js';
import { closeMenu, menuOpen } from './ui/menu.js';
import { dashboardView } from './views/dashboard.js';
import { accountView } from './views/account.js';
import { recurringView } from './views/recurring.js';

const app = document.getElementById('app');
// The fingerprint on this page's own files; the server sends its current one with every response
const pageBuild = new URL(import.meta.url).searchParams.get('v');
let sidebar = null;
let versionWarned = false;
let signedOut = false;

// Below this width the sidebar is a drawer that slides over the page
const drawerQuery = matchMedia('(max-width: 1023px)');

function shell() {
  render(app, html`
    <div class="sidebar-overlay" data-close-nav></div>
    <aside class="sidebar" id="sidebar" aria-label="Main navigation"></aside>
    <div class="main">
      <header class="topbar">
        <button type="button" class="icon-btn" data-open-nav aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
        <span class="topbar-title" data-topbar-title>Brisk Budget</span>
      </header>
      <main class="view" id="view" tabindex="-1"></main>
    </div>
  `);
  sidebar = createSidebar($('#sidebar', app));
  on(app, 'click', '[data-open-nav]', () => setNav(true));
  on(app, 'click', '[data-close-nav]', () => setNav(false, { returnFocus: true }));
  on($('#sidebar', app), 'click', 'a[href], [data-open-settings], [data-open-about]', () => setNav(false));
  onRoute(() => {
    setNav(false);
    closeMenu();
    closeAllDialogs(); // a dialog belongs to the page it was opened on (and Back should close it)
  });
  drawerQuery.addEventListener('change', () => setNav(false));
  setNav(false);
}

// Open or close the drawer. While it is closed it is inert, so Tab and screen readers skip it;
// while it is open the page behind is inert instead.
function setNav(open, { returnFocus = false } = {}) {
  const sidebarEl = $('#sidebar', app);
  const button = $('[data-open-nav]', app);
  if (!sidebarEl || !button) return;
  const drawer = drawerQuery.matches;
  const isOpen = drawer && open;
  const wasOpen = app.classList.contains('nav-open');
  app.classList.toggle('nav-open', isOpen);
  button.setAttribute('aria-expanded', String(isOpen));
  sidebarEl.inert = drawer && !isOpen;
  $('.main', app).inert = isOpen;
  if (isOpen && !wasOpen) $('a[href], button', sidebarEl)?.focus({ preventScroll: true });
  if (!isOpen && wasOpen && returnFocus) button.focus({ preventScroll: true });
}

function showNotices() {
  for (const notice of state.notices || []) {
    toast(notice.message, { kind: notice.kind === 'warning' ? 'warning' : 'success', duration: 12000 });
    api.dismissNotice(notice.id).catch(() => {});
  }
  state.notices = [];
}

// Keys typed into a field belong to the field; checkboxes, radios and buttons still let
// shortcuts (and Escape) through
const TYPING_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);
function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !TYPING_INPUTS.has(el.type);
}

function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (signedOut || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (dialogOpen() || menuOpen()) return;
    if (event.key === 'Escape' && app.classList.contains('nav-open')) {
      event.preventDefault();
      setNav(false, { returnFocus: true });
      return;
    }
    if (isTyping(document.activeElement)) return;
    const handled = view()?.shortcut?.(event.key);
    if (handled) event.preventDefault();
  });
}

async function boot() {
  let auth;
  try {
    auth = await api.authStatus();
  } catch (err) {
    render(app, html`<div class="boot"><p class="boot-message">${err.message}</p><button type="button" class="btn btn-secondary" data-retry>Try again</button></div>`);
    $('[data-retry]', app).addEventListener('click', () => location.reload());
    return;
  }
  if (auth.enabled && !auth.authenticated) {
    showLogin(app, () => location.reload());
    return;
  }
  try {
    await load();
  } catch (err) {
    render(app, html`<div class="boot"><p class="boot-message">Brisk Budget couldn't load: ${err.message}</p></div>`);
    return;
  }

  shell();
  route('/', () => dashboardView());
  route('/accounts/:id', ({ id }) => accountView(id));
  route('/recurring', () => recurringView());

  subscribe((reason) => {
    if (reason !== 'changed' || signedOut) return;
    sidebar.render();
    refreshView();
  });

  // The session ended (expired, or signed out elsewhere): stop the app and show sign-in, once
  onUnauthorized(() => {
    if (signedOut) return;
    signedOut = true;
    stopRouter();
    closeMenu();
    closeAllDialogs();
    app.classList.remove('nav-open');
    showLogin(app, () => location.reload());
  });

  // Offer a reload once the server is running a newer version, or the same version with
  // different files (an update that kept the version number)
  onServerVersion((version, build) => {
    if (versionWarned || signedOut) return;
    const newVersion = version && state.version && version !== state.version;
    const newBuild = build && pageBuild && build !== pageBuild;
    if (!newVersion && !newBuild) return;
    versionWarned = true;
    const message = newVersion ? `Brisk Budget has been updated to v${version}.` : 'Brisk Budget has been updated.';
    toast(message, { action: { label: 'Reload', run: () => location.reload() }, duration: 0 });
  });

  bindShortcuts();
  try {
    await start($('#view', app));
  } catch (err) {
    console.error(err);
  }
  sidebar.render();
  showNotices();
}

boot();
