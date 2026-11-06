import { html, render, $, on } from './core/dom.js';
import { api, onUnauthorized, onServerVersion } from './core/api.js';
import { state, load, subscribe, changed, account } from './core/state.js';
import { route, start as startRouter, stop as stopRouter, onRoute, refresh as refreshView, view, navigate, path } from './core/router.js';
import { pageBuild, startServiceWorker, checkForAppUpdate, offerInstallOnce, install } from './core/pwa.js';
import { createSidebar } from './shell/sidebar.js';
import { createTabbar } from './shell/tabbar.js';
import { showLogin } from './shell/login.js';
import { toast } from './ui/toast.js';
import { busy } from './ui/forms.js';
import { openLayer } from './ui/back.js';
import { closeAllDialogs, dialogOpen } from './ui/dialog.js';
import { closeMenu, menuOpen } from './ui/menu.js';
import { openTransactionDialog } from './dialogs/transaction.js';
import { openSettings } from './dialogs/settings.js';
import { dashboardView } from './views/dashboard.js';
import { accountView } from './views/account.js';
import { recurringView } from './views/recurring.js';

const app = document.getElementById('app');
let sidebar = null;
let tabbar = null;
let navLayer = null;
let updateOffered = false;
let signedOut = false;

// How long to wait for the server to answer at start-up before saying it can't be reached
const BOOT_WAIT = 10000;
// Back in the app after this long away (a phone resuming it), fetch the latest figures
const STALE_AFTER = 5 * 60 * 1000;

// Below this width the sidebar is a drawer that slides over the page
const drawerQuery = matchMedia('(max-width: 1023px)');

function shell() {
  render(app, html`
    <div class="sidebar-overlay" data-close-nav></div>
    <aside class="sidebar" id="sidebar" aria-label="Main navigation"></aside>
    <div class="main">
      <header class="topbar">
        <img src="/images/brisk-budget-icon.svg" alt="" width="22" height="22" class="topbar-logo">
        <span class="topbar-title" data-topbar-title>Brisk Budget</span>
      </header>
      <main class="view" id="view" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Main"></nav>
  `);
  sidebar = createSidebar($('#sidebar', app));
  tabbar = createTabbar($('.tabbar', app));
  on(app, 'click', '[data-open-nav]', () => setNav(true));
  on(app, 'click', '[data-close-nav]', () => setNav(false, { returnFocus: true }));
  on(app, 'click', '[data-quick-add]', () => quickAdd());
  on(app, 'click', '[data-tab="settings"]', () => openSettings());
  on($('#sidebar', app), 'click', 'a[href], [data-open-settings], [data-open-about]', (event, el) => {
    const href = el.getAttribute('href');
    const plain = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
    // From the open drawer, follow the link once the drawer's history entry is gone, or the Back
    // that removes it would undo the move
    if (navLayer && plain && href?.startsWith('#/')) {
      event.preventDefault();
      setNav(false);
      if (location.hash !== href) navigate(href.slice(1));
      return;
    }
    setNav(false);
  });
  onRoute(() => {
    setNav(false);
    closeMenu();
    closeAllDialogs(); // a dialog belongs to the page it was opened on
    tabbar.render();
  });
  drawerQuery.addEventListener('change', () => setNav(false));
  setNav(false);
}

// Open or close the drawer. While it is closed it is inert, so Tab and screen readers skip it;
// while it is open the page behind is inert instead, and Back closes it.
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
  $('.tabbar', app).inert = isOpen;
  if (isOpen && !navLayer) navLayer = openLayer(() => setNav(false, { returnFocus: true }));
  if (!isOpen && navLayer) {
    const drop = navLayer;
    navLayer = null;
    drop();
  }
  if (isOpen && !wasOpen) $('a[href], button', sidebarEl)?.focus({ preventScroll: true });
  if (!isOpen && wasOpen && returnFocus) button.focus({ preventScroll: true });
}

// The tab bar's Add button: into the account on screen, otherwise the dialog asks which
function quickAdd() {
  const current = path() || '';
  const open = current.startsWith('/accounts/') ? account(current.split('/')[2]) : null;
  return openTransactionDialog({ accountId: open && open.active !== false ? open.id : null });
}

// Offer a reload once the server is running a newer version, or the same version with different
// files (an update that kept the version number). The reload also brings the copy of the app
// saved on the device up to date.
function offerReload(version) {
  if (updateOffered || signedOut) return;
  updateOffered = true;
  const message = version ? `Update ready: Brisk Budget v${version}.` : 'An update to Brisk Budget is ready.';
  toast(message, { action: { label: 'Reload', run: () => location.reload() }, duration: 0 });
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

// The server didn't answer: this device is offline, or away from the network the server is on.
// The app itself opened (from the copy saved on the device), so say plainly what's wrong, and
// try again by itself when the connection comes back or the app is brought back to the front.
let unreachable = false;
function showUnreachable() {
  unreachable = true;
  if ($('.unreachable', app)) return; // still can't: leave the message (and focus) where it is
  render(app, html`
    <div class="boot unreachable" role="alert">
      <div class="unreachable-card">
        <img src="/images/brisk-budget-icon.svg" alt="" width="48" height="48">
        <h1>Can't reach your Brisk Budget server</h1>
        <p class="boot-message">Check that this device is online and can reach your server (on the same network or VPN, for example), then try again.</p>
        <button type="button" class="btn btn-primary" data-retry>Try again</button>
      </div>
    </div>
  `);
  const button = $('[data-retry]', app);
  button.addEventListener('click', () => busy(button, boot));
}
const retryIfUnreachable = () => { if (unreachable && !document.hidden) boot(); };
window.addEventListener('online', retryIfUnreachable);
document.addEventListener('visibilitychange', retryIfUnreachable);

// One start-up at a time (a retry while the last one is still waiting joins it)
let booting = null;
function boot() {
  booting ||= startApp().finally(() => { booting = null; });
  return booting;
}

async function startApp() {
  let auth;
  try {
    auth = await api.authStatus({ signal: AbortSignal.timeout?.(BOOT_WAIT) });
  } catch (err) {
    if (err.status === 0) {
      showUnreachable();
      return;
    }
    render(app, html`<div class="boot"><p class="boot-message">${err.message}</p><button type="button" class="btn btn-secondary" data-retry>Try again</button></div>`);
    $('[data-retry]', app).addEventListener('click', () => location.reload());
    return;
  }
  unreachable = false;
  if (auth.enabled && !auth.authenticated) {
    showLogin(app, () => location.reload());
    return;
  }
  try {
    await load();
  } catch (err) {
    if (err.status === 0) showUnreachable();
    else render(app, html`<div class="boot"><p class="boot-message">Brisk Budget couldn't load: ${err.message}</p></div>`);
    return;
  }

  shell();
  route('/', () => dashboardView());
  route('/accounts/:id', ({ id }) => accountView(id));
  route('/recurring', () => recurringView());

  subscribe((reason) => {
    if (reason !== 'changed' || signedOut) return;
    sidebar.render();
    tabbar.render();
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

  onServerVersion((version, build) => {
    if (updateOffered || signedOut) return;
    const newVersion = version && state.version && version !== state.version;
    const newBuild = build && pageBuild && build !== pageBuild;
    if (!newVersion && !newBuild) return;
    checkForAppUpdate();
    offerReload(newVersion ? version : null);
  });

  // An installed app on a phone is usually brought back rather than reopened, sometimes days
  // later. Back after a while away, fetch the latest figures, so changes made on another device
  // show up (and a new version of the app is noticed).
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away < STALE_AFTER || signedOut || dialogOpen()) return;
    changed().catch(() => {}); // can't reach the server just now: the figures stay as they were
  });

  bindShortcuts();
  try {
    await startRouter($('#view', app));
  } catch (err) {
    console.error(err);
  }
  sidebar.render();
  tabbar.render();
  showNotices();

  // The installed app's "Add transaction" shortcut (a long press on its icon) opens straight into it
  if (new URLSearchParams(location.search).get('action') === 'add') {
    history.replaceState(history.state, '', `/${location.hash}`);
    quickAdd();
  }

  offerInstallOnce((kind) => {
    if (kind === 'ios') toast('Add Brisk Budget to your Home Screen to open it like an app: tap Share, then "Add to Home Screen".', { duration: 15000, action: { label: 'OK', run: () => {} } });
    else toast('Install Brisk Budget on this device to open it like an app.', { duration: 15000, action: { label: 'Install', run: () => install() } });
  });
}

startServiceWorker({ onUpdate: () => offerReload(null) });
boot();
