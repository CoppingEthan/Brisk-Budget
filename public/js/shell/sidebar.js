import { html, render, on, storage, store, $ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { state, sidebarLayout, changed } from '../core/state.js';
import { api } from '../core/api.js';
import { accountBalanceView, initial, money, tone } from '../core/format.js';
import { navigate, path, onRoute } from '../core/router.js';
import { openAccountDialog } from '../dialogs/account.js';
import { openGroupDialog } from '../dialogs/group.js';
import { openSettings } from '../dialogs/settings.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { upcoming } from '../shared/recurrence.js';
import { today } from '../shared/dates.js';
import { toPence, fromPence } from '../shared/money.js';

const COLLAPSED_KEY = 'briskBudget_collapsedGroups';
const WIDTH_KEY = 'briskBudget_sidebarWidth';

export function accountAvatar(account, cls = '') {
  return account.icon
    ? html`<span class="avatar square ${cls}"><img src="${account.icon}" alt="" loading="lazy"></span>`
    : html`<span class="avatar square ${cls}">${initial(account.name)}</span>`;
}

// How many recurring payments are due today or earlier
export function overdueCount() {
  const now = today();
  let count = 0;
  for (const t of state.recurring) {
    if (t.paused || t.status === 'ended') continue;
    if (upcoming(t, now).length) count++;
  }
  return count;
}

// The group an account is shown in, or null when it sits at the top level
const groupOf = (account) => (account?.groupId && state.groups.some(g => g.id === account.groupId) ? account.groupId : null);
const topOrder = (layout = sidebarLayout()) => layout.map(({ type, id }) => ({ type, id }));

// Move an account or group one place up (delta -1) or down (+1) among its neighbours: an
// account within its group, anything else at the top level. Resolves to false when it is
// already at that end. The keyboard and touch alternative to dragging.
export async function moveInSidebar(type, id, delta) {
  const layout = sidebarLayout();
  const group = type === 'account' ? groupOf(state.accounts.find(a => a.id === id)) : null;
  if (group) {
    const ids = layout.find(i => i.type === 'group' && i.id === group).children.map(a => a.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return false;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await api.reorderAccounts(ids);
  } else {
    const order = topOrder(layout);
    const from = order.findIndex(i => i.type === type && i.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return false;
    order.splice(to, 0, order.splice(from, 1)[0]);
    await api.reorderLayout(order);
  }
  await changed();
  return true;
}

export function createSidebar(root) {
  let drag = null;

  function balanceText(account) {
    const view = accountBalanceView(account);
    return html`<span class="account-item-balance ${view.tone}">${view.text}</span>`;
  }

  function accountItem(account, current) {
    return html`
      <a class="account-item ${current === account.id ? 'active' : ''}" href="#/accounts/${account.id}" draggable="true"
         data-account="${account.id}" aria-current="${current === account.id ? 'page' : 'false'}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
        <span class="drag-grip" aria-hidden="true">${icon('grip')}</span>
        ${accountAvatar(account)}
        <span class="account-item-name">${account.name}</span>
        ${balanceText(account)}
      </a>
    `;
  }

  function renderAccounts() {
    const list = $('[data-accounts]', root);
    const layout = sidebarLayout();
    const current = (path() || '').startsWith('/accounts/') ? path().split('/')[2] : null;
    const collapsed = storage(COLLAPSED_KEY, {});
    if (!layout.length) {
      render(list, html`<p class="sidebar-empty">No accounts yet. Add one with the + button.</p>`);
      return;
    }

    // The group header's toggle is a real button (so its Edit and Delete buttons can sit beside
    // it), but pointer presses go to the header itself, which is what gets dragged.
    render(list, html`${layout.map(item => {
      if (item.type === 'account') return accountItem(item.account, current);
      const g = item.group;
      const total = fromPence(item.children.reduce((s, a) => s + toPence(a.balance), 0));
      const isCollapsed = !!collapsed[g.id];
      return html`
        <div class="account-group ${isCollapsed ? 'collapsed' : ''}" data-group="${g.id}">
          <div class="group-header" draggable="true" data-group-header="${g.id}">
            <span class="drag-grip" aria-hidden="true">${icon('grip')}</span>
            <button type="button" class="group-toggle" data-group-toggle="${g.id}" aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">
              <span class="chevron" aria-hidden="true">${icon('chevronDown')}</span>
              ${g.icon ? html`<span class="avatar square"><img src="${g.icon}" alt=""></span>` : ''}
              <span class="group-name">${g.name}</span>
              <span class="group-balance ${tone(total)}">${money(total)}</span>
            </button>
            <span class="group-actions">
              <button type="button" class="icon-btn sm" data-edit-group="${g.id}" aria-label="Edit group ${g.name}">${icon('pencil')}</button>
              <button type="button" class="icon-btn sm danger" data-delete-group="${g.id}" aria-label="Delete group ${g.name}">${icon('trash')}</button>
            </span>
          </div>
          <div class="group-children" data-group-children="${g.id}">
            ${item.children.length ? item.children.map(a => accountItem(a, current)) : html`<div class="group-empty">Drag accounts here</div>`}
          </div>
        </div>
      `;
    })}`);
  }

  function renderFooter() {
    const footer = $('[data-footer]', root);
    const due = overdueCount();
    const current = path();
    const update = state.update;
    render(footer, html`
      ${update?.updateAvailable ? html`
        <button type="button" class="update-pill" data-open-about>${icon('arrowUpCircle')}<span>Update available: v${update.latest}</span></button>
      ` : ''}
      <a class="nav-item ${current === '/recurring' ? 'active' : ''}" href="#/recurring" aria-current="${current === '/recurring' ? 'page' : 'false'}">
        ${icon('repeat', { size: 17 })}<span>Recurring</span>
        ${due ? html`<span class="badge warning" title="${due} due">${due}<span class="sr-only"> due</span></span>` : ''}
      </a>
      <button type="button" class="nav-item" data-open-settings>${icon('settings', { size: 17 })}<span>Settings</span></button>
      ${state.auth?.enabled ? html`<button type="button" class="nav-item" data-logout>${icon('logout', { size: 17 })}<span>Sign out</span></button>` : ''}
      <div class="sidebar-version">Brisk Budget v${state.version}</div>
    `);
  }

  function renderNav() {
    const dash = $('[data-nav-dashboard]', root);
    dash.classList.toggle('active', path() === '/');
    dash.setAttribute('aria-current', path() === '/' ? 'page' : 'false');
  }

  function renderAll() {
    renderNav();
    renderAccounts();
    renderFooter();
  }

  render(root, html`
    <div class="sidebar-scroll">
      <a class="nav-item" href="#/" data-nav-dashboard>
        <img src="/images/brisk-budget-icon.svg" alt="" width="20" height="20"><span>Dashboard</span>
      </a>
      <div class="sidebar-section-header">
        <h2>Accounts</h2>
        <div class="sidebar-section-actions">
          <button type="button" class="icon-btn sm" data-add-group aria-label="Create group" title="Create group">${icon('folderPlus')}</button>
          <button type="button" class="icon-btn sm" data-add-account aria-label="Add account" title="Add account">${icon('plus')}</button>
        </div>
      </div>
      <nav class="accounts-list" data-accounts aria-label="Accounts"></nav>
    </div>
    <div class="sidebar-footer" data-footer></div>
    <div class="sidebar-resize" data-resize title="Drag to resize"></div>
  `);

  // ----- Clicks -----
  on(root, 'click', '[data-add-account]', () => openAccountDialog());
  on(root, 'click', '[data-add-group]', () => openGroupDialog());
  on(root, 'click', '[data-open-settings]', () => openSettings());
  on(root, 'click', '[data-open-about]', () => openSettings('about'));
  on(root, 'click', '[data-logout]', async () => {
    await api.logout().catch(() => {});
    location.reload();
  });
  on(root, 'click', '[data-edit-group]', (event, el) => {
    event.stopPropagation();
    const group = state.groups.find(g => g.id === el.dataset.editGroup);
    if (group) openGroupDialog(group);
  });
  on(root, 'click', '[data-delete-group]', async (event, el) => {
    event.stopPropagation();
    const group = state.groups.find(g => g.id === el.dataset.deleteGroup);
    if (!group) return;
    const ok = await confirmDialog({ title: 'Delete group', message: `Delete the group "${group.name}"?`, detail: 'The accounts in it are kept and become ungrouped.' });
    if (!ok) return;
    try {
      await api.deleteGroup(group.id);
      await changed();
      toast(`Deleted "${group.name}"`);
    } catch (err) {
      toastError(err);
    }
  });
  const toggleGroup = (header) => {
    const id = header.dataset.groupHeader;
    const collapsed = storage(COLLAPSED_KEY, {});
    collapsed[id] = !collapsed[id];
    store(COLLAPSED_KEY, collapsed);
    header.closest('.account-group').classList.toggle('collapsed', collapsed[id]);
    $('[data-group-toggle]', header).setAttribute('aria-expanded', String(!collapsed[id]));
  };
  on(root, 'click', '[data-group-header]', (event, header) => {
    if (event.target.closest('.group-actions')) return;
    toggleGroup(header);
  });

  // Show the full name on hover when it doesn't fit
  on(root, 'mouseover', '.account-item, .group-header', (event, el) => {
    const name = $('.account-item-name, .group-name', el);
    if (!name) return;
    if (name.scrollWidth > name.clientWidth) el.title = name.textContent;
    else el.removeAttribute('title');
  });

  // ----- Keyboard: Alt+Up / Alt+Down move the focused account or group -----
  on(root, 'keydown', '[data-account], [data-group-toggle]', async (event, el) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const type = el.dataset.account ? 'account' : 'group';
    const id = el.dataset.account || el.dataset.groupToggle;
    try {
      const moved = await moveInSidebar(type, id, event.key === 'ArrowUp' ? -1 : 1);
      if (moved) $(type === 'account' ? `[data-account="${CSS.escape(id)}"]` : `[data-group-toggle="${CSS.escape(id)}"]`, root)?.focus();
    } catch (err) {
      toastError(err);
    }
  });

  // ----- Drag & drop: reorder accounts and groups, move accounts in/out of groups -----
  const clearMarks = () => root.querySelectorAll('.drop-before, .drop-after, .drop-into, .dragging').forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging'));
  const endDrag = () => { drag = null; clearMarks(); };

  on(root, 'dragstart', '[data-account], [data-group-header]', (event, el) => {
    if (el.dataset.account) drag = { type: 'account', id: el.dataset.account };
    else drag = { type: 'group', id: el.dataset.groupHeader };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', drag.id);
    (drag.type === 'group' ? el.closest('.account-group') : el).classList.add('dragging');
    // On the element itself: if the sidebar re-renders mid-drag the element is detached, and its
    // dragend would never bubble up, leaving a stale drag waiting to be dropped
    el.addEventListener('dragend', endDrag, { once: true });
  });
  document.addEventListener('dragend', endDrag);
  document.addEventListener('drop', endDrag);

  // Where a drop would land: { kind: 'account'|'into'|'top'|'end', ..., el (to mark), mark }
  function dropTarget(event) {
    if (!drag) return null;
    const list = $('[data-accounts]', root);
    const y = event.clientY;
    const lowerHalf = (el) => { const r = el.getBoundingClientRect(); return y > r.top + r.height / 2; };
    if (drag.type === 'account') {
      const accountEl = event.target.closest('[data-account]');
      if (accountEl) {
        if (accountEl.dataset.account === drag.id) return null;
        const after = lowerHalf(accountEl);
        return { kind: 'account', accountId: accountEl.dataset.account, after, el: accountEl, mark: after ? 'drop-after' : 'drop-before' };
      }
      const groupEl = event.target.closest('.account-group');
      if (groupEl) {
        const header = $('[data-group-header]', groupEl);
        const r = header.getBoundingClientRect();
        // The top edge of a group's header puts the account above the group; the rest drops it in
        if (header.contains(event.target) && y < r.top + r.height * 0.3) {
          return { kind: 'top', ref: { type: 'group', id: groupEl.dataset.group }, after: false, el: groupEl, mark: 'drop-before' };
        }
        return { kind: 'into', groupId: groupEl.dataset.group, el: header, mark: 'drop-into' };
      }
    } else {
      const top = event.target.closest('.accounts-list > .account-group, .accounts-list > .account-item');
      if (top) {
        if (top.dataset.group === drag.id) return null; // over itself
        const ref = top.dataset.group ? { type: 'group', id: top.dataset.group } : { type: 'account', id: top.dataset.account };
        const after = lowerHalf(top);
        return { kind: 'top', ref, after, el: top, mark: after ? 'drop-after' : 'drop-before' };
      }
    }
    // The space below the last item is the end of the list (and takes an account out of its group)
    const last = list.lastElementChild;
    if (last && list.contains(event.target) && y > last.getBoundingClientRect().bottom) return { kind: 'end', el: last, mark: 'drop-after' };
    return null;
  }

  on(root, 'dragover', '[data-accounts]', (event) => {
    const target = dropTarget(event);
    root.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.el?.classList.add(target.mark);
  });

  on(root, 'drop', '[data-accounts]', async (event) => {
    const target = dropTarget(event);
    const dragged = drag;
    endDrag();
    if (!target || !dragged) return;
    event.preventDefault();
    try {
      await applyDrop(dragged, target);
      await changed();
    } catch (err) {
      toastError(err);
    }
  });

  // Put a top-level item before or after another one (ref null: at the end)
  async function placeTop(item, ref, after, layout) {
    const order = topOrder(layout).filter(i => !(i.type === item.type && i.id === item.id));
    const at = ref ? order.findIndex(i => i.type === ref.type && i.id === ref.id) : -1;
    order.splice(at < 0 ? order.length : at + (after ? 1 : 0), 0, item);
    const before = topOrder(layout);
    const unchanged = before.length === order.length && before.every((i, n) => order[n].type === i.type && order[n].id === i.id);
    if (!unchanged) await api.reorderLayout(order);
  }

  async function applyDrop(dragged, target) {
    const layout = sidebarLayout();
    if (dragged.type === 'group') {
      await placeTop({ type: 'group', id: dragged.id }, target.kind === 'top' ? target.ref : null, target.after, layout);
      return;
    }
    const account = state.accounts.find(a => a.id === dragged.id);
    if (!account) return;
    const from = groupOf(account);
    if (target.kind === 'into') {
      if (from !== target.groupId) await api.setAccountGroup(account.id, target.groupId);
      return;
    }
    if (target.kind === 'account') {
      const other = state.accounts.find(a => a.id === target.accountId);
      const group = groupOf(other);
      if (group) {
        if (from !== group) await api.setAccountGroup(account.id, group);
        const ids = layout.find(i => i.type === 'group' && i.id === group).children.map(a => a.id).filter(id => id !== account.id);
        ids.splice(ids.indexOf(other.id) + (target.after ? 1 : 0), 0, account.id);
        await api.reorderAccounts(ids);
        return;
      }
      if (from) await api.setAccountGroup(account.id, null);
      await placeTop({ type: 'account', id: account.id }, { type: 'account', id: other.id }, target.after, layout);
      return;
    }
    // 'top' (above a group) or 'end'
    if (from) await api.setAccountGroup(account.id, null);
    await placeTop({ type: 'account', id: account.id }, target.kind === 'top' ? target.ref : null, target.after, layout);
  }

  // ----- Resize (desktop) -----
  const legacyCookie = document.cookie.split('; ').find(c => c.startsWith('sidebarWidth='));
  const savedWidth = storage(WIDTH_KEY, legacyCookie ? Number(legacyCookie.split('=')[1]) : null);
  if (savedWidth >= 220 && savedWidth <= 420) root.style.width = `${savedWidth}px`;
  const handle = $('[data-resize]', root);
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    const startX = event.clientX;
    const startWidth = root.offsetWidth;
    const move = (e) => { root.style.width = `${Math.max(220, Math.min(420, startWidth + e.clientX - startX))}px`; };
    // A cancelled or lost pointer ends the resize too, so the handle never stays stuck
    const end = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.removeEventListener(type, end);
      store(WIDTH_KEY, root.offsetWidth);
    };
    handle.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, end);
  });

  onRoute(() => renderAll());
  return { render: renderAll };
}

export function goToAccount(id) {
  navigate(`/accounts/${id}`);
}
