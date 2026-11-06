// The bar along the bottom of the screen on phones and small tablets, where the sidebar is a
// drawer: the main places a thumb's reach away, with adding a transaction in the middle.
// "Accounts" opens the drawer, which lists them (and holds sign-out and the version).
import { html, render, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { path } from '../core/router.js';
import { overdueCount } from './sidebar.js';

export function createTabbar(root) {
  render(root, html`
    <a class="tab-item" href="#/" data-tab="dashboard">${icon('layout')}<span>Dashboard</span></a>
    <button type="button" class="tab-item" data-tab="accounts" data-open-nav aria-controls="sidebar" aria-expanded="false">${icon('wallet')}<span>Accounts</span></button>
    <button type="button" class="tab-item tab-add" data-tab="add" data-quick-add aria-label="Add transaction">
      <span class="tab-add-button">${icon('plus')}</span>
    </button>
    <a class="tab-item" href="#/recurring" data-tab="recurring">${icon('repeat')}<span>Recurring</span><span data-due></span></a>
    <button type="button" class="tab-item" data-tab="settings">${icon('settings')}<span>Settings</span></button>
  `);

  function update() {
    const current = path() || '';
    const here = { dashboard: current === '/', accounts: current.startsWith('/accounts/'), recurring: current === '/recurring' };
    for (const [tab, active] of Object.entries(here)) {
      const el = $(`[data-tab="${tab}"]`, root);
      el.classList.toggle('active', active);
      if (el.tagName === 'A') el.setAttribute('aria-current', active ? 'page' : 'false');
    }
    const due = overdueCount();
    render($('[data-due]', root), due ? html`<span class="tab-badge">${due}<span class="sr-only"> due</span></span>` : '');
  }

  return { render: update };
}
