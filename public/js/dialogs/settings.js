import { html, render, on, $, $$ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, changed, archivedAccounts, accountTypeLabel } from '../core/state.js';
import { money, plural, bytes, dateTime, accountBalanceView } from '../core/format.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { bindForm, busy, categoryOptions, refreshAfterSave } from '../ui/forms.js';
import { toast, toastError } from '../ui/toast.js';
import { emojiPicker, colourPicker, bindPickers } from '../ui/pickers.js';
import { accountAvatar } from '../shell/sidebar.js';

const TABS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'categories', label: 'Categories', icon: 'tag' },
  { id: 'payees', label: 'Payees', icon: 'users' },
  { id: 'accounts', label: 'Accounts', icon: 'archive' },
  { id: 'backups', label: 'Backups', icon: 'database' },
  { id: 'data', label: 'Data check', icon: 'activity' },
  { id: 'security', label: 'Security', icon: 'lock' },
  { id: 'about', label: 'About & updates', icon: 'info' }
];

const UPDATE_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/CoppingEthan/Brisk-Budget/main/deploy.sh | sudo bash';
const AUTO_UPDATE_COMMAND = `${UPDATE_COMMAND} -s -- --auto-update`;

export function openSettings(initialTab = 'general') {
  let current = initialTab;
  const dialog = openDialog({
    title: 'Settings',
    size: 'xl',
    flush: true,
    body: html`
      <div class="settings">
        <nav class="settings-nav" aria-label="Settings sections">
          <div class="tabs" role="tablist" aria-orientation="vertical">
            ${TABS.map(t => html`<button type="button" class="tab" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="settings-panel" aria-selected="${String(t.id === current)}" tabindex="${t.id === current ? '0' : '-1'}">${icon(t.icon)}${t.label}</button>`)}
          </div>
        </nav>
        <section class="settings-panel" id="settings-panel" role="tabpanel" tabindex="-1"></section>
      </div>
    `
  });
  const panel = $('#settings-panel', dialog.body);

  const show = async (tab) => {
    current = tab;
    // One tab stop for the whole list; the arrow keys move between tabs
    $$('[data-tab]', dialog.body).forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
      b.tabIndex = b.dataset.tab === tab ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `tab-${tab}`);
    panel.scrollTop = 0;
    try {
      await PANELS[tab](panel, { show, dialog });
    } catch (err) {
      render(panel, html`<div class="alert error">${icon('alert')}<span>${err.message}</span></div>`);
    }
  };
  on(dialog.body, 'click', '[data-tab]', (event, el) => show(el.dataset.tab));
  on(dialog.body, 'keydown', '[role="tab"]', (event, el) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[role="tab"]', dialog.body);
    const i = tabs.indexOf(el);
    const next = tabs[(i + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    show(next.dataset.tab);
  });
  show(current);
  return dialog.closed;
}

// Why update checks are off, or null when they're on
function offReason(u) {
  if (u.checkEnabled !== false) return null;
  if (u.checkDisabledReason === 'env') return 'Update checks are turned off on the server (BRISK_UPDATE_CHECK=0).';
  return 'Update checks are off. Turn on "Check for updates" under General.';
}

// A drag handle that also moves its row with the arrow keys. It's a focusable span rather than a
// <button> because some browsers won't start a drag from a button inside the dragged row.
const moveHandle = (name) => html`<span class="grab" role="button" tabindex="0" data-move aria-label="Move ${name}" aria-keyshortcuts="ArrowUp ArrowDown" title="Drag, or use the up and down arrow keys">${icon('grip')}</span>`;

// Each render gets a new container so event listeners from the previous render go with it
function fresh(section) {
  const host = document.createElement('div');
  section.replaceChildren(host);
  return host;
}

const PANELS = {
  // ---------- General ----------
  async general(section) {
    const panel = fresh(section);
    const s = state.settings;
    render(panel, html`
      <h3>General</h3>
      <p class="panel-hint">How Brisk Budget greets you and shows money.</p>
      <form class="form-stack" data-form style="max-width:520px">
        <label class="field">
          <span class="field-label">Your name</span>
          <input class="input" name="name" value="${s.name || ''}" maxlength="60" placeholder="Shown on the dashboard">
        </label>
        <label class="field">
          <span class="field-label">Currency symbol</span>
          <input class="input" name="currencySymbol" value="${s.currencySymbol}" maxlength="4" required style="max-width:120px">
        </label>
        <label class="switch">
          <input type="checkbox" name="groupChartToggles" ${s.groupChartToggles !== false ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text">Group accounts in the dashboard chart<small>Use your sidebar groups as one-click chart filters</small></span>
        </label>
        <label class="switch">
          <input type="checkbox" name="checkForUpdates" ${s.checkForUpdates !== false ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text">Check for updates<small>Asks GitHub twice a day whether a new version is out. Nothing about your data is sent.</small></span>
        </label>
        <div><button type="submit" class="btn btn-primary">Save</button></div>
      </form>
    `);
    const form = $('[data-form]', panel);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      await busy(event.submitter, async () => {
        try {
          await api.updateSettings({
            name: form.name.value,
            currencySymbol: form.currencySymbol.value,
            groupChartToggles: form.groupChartToggles.checked,
            checkForUpdates: form.checkForUpdates.checked
          });
          await changed();
          toast('Settings saved', { kind: 'success' });
        } catch (err) {
          toastError(err);
        }
      });
    });
  },

  // ---------- Categories ----------
  async categories(section) {
    const panel = fresh(section);
    const categories = await api.categories();
    render(panel, html`
      <h3>Categories</h3>
      <p class="panel-hint">Drag to reorder, or move a handle with the arrow keys. Renaming a category keeps everything filed under it.</p>
      <div class="settings-toolbar">
        <button type="button" class="btn btn-primary btn-sm" data-add-category>${icon('plus')}Add category</button>
        <button type="button" class="btn btn-ghost btn-sm" data-reset>${icon('refresh')}Reset to defaults</button>
      </div>
      <div class="category-tree" data-tree>
        ${categories.map(c => html`
          <div class="cat-node ${c.isSystem ? 'system' : ''}" data-category="${c.id}" draggable="${c.isSystem ? 'false' : 'true'}">
            <div class="cat-node-header">
              ${c.isSystem ? html`<span class="grab-space"></span>` : moveHandle(c.name)}
              <span class="emoji" style="background:${c.color}22">${c.emoji}</span>
              <span class="name">${c.name}${c.isSystem ? html` <span class="pill" style="padding:0 .45rem;font-size:.625rem">System</span>` : ''}</span>
              <span class="usage">${c.usage ? plural(c.usage, 'use') : ''}</span>
              ${c.isSystem ? '' : html`
                <span class="node-actions">
                  <button type="button" class="icon-btn sm" data-add-sub aria-label="Add subcategory to ${c.name}">${icon('plus')}</button>
                  <button type="button" class="icon-btn sm" data-edit-category aria-label="Edit ${c.name}">${icon('pencil')}</button>
                  <button type="button" class="icon-btn sm danger" data-delete-category aria-label="Delete ${c.name}">${icon('trash')}</button>
                </span>`}
            </div>
            ${c.subcategories.length ? html`
              <div class="sub-list">
                ${c.subcategories.map(sub => html`
                  <div class="sub-node" data-sub="${sub.id}" draggable="true">
                    ${moveHandle(sub.name)}
                    <span class="name">${sub.name}</span>
                    <span class="usage">${sub.usage ? plural(sub.usage, 'use') : ''}</span>
                    <span class="node-actions">
                      <button type="button" class="icon-btn sm" data-edit-sub aria-label="Rename ${sub.name}">${icon('pencil')}</button>
                      <button type="button" class="icon-btn sm danger" data-delete-sub aria-label="Delete ${sub.name}">${icon('trash')}</button>
                    </span>
                  </div>`)}
              </div>` : ''}
          </div>`)}
      </div>
    `);
    const again = () => PANELS.categories(section);
    const find = (el) => categories.find(c => c.id === el.closest('[data-category]').dataset.category);
    const findSub = (el) => find(el).subcategories.find(s => s.id === el.closest('[data-sub]').dataset.sub);

    $('[data-add-category]', panel).addEventListener('click', () => categoryDialog(null).then(ok => ok && again()));
    $('[data-reset]', panel).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Reset categories',
        message: 'Go back to the default UK household categories?',
        detail: 'Your own categories are removed, and anything filed under them becomes Uncategorized.',
        confirmLabel: 'Reset'
      });
      if (!ok) return;
      try { await api.resetCategories(); await changed(); again(); } catch (err) { toastError(err); }
    });
    on(panel, 'click', '[data-edit-category]', (e, el) => categoryDialog(find(el)).then(ok => ok && again()));
    on(panel, 'click', '[data-add-sub]', (e, el) => subcategoryDialog(find(el), null).then(ok => ok && again()));
    on(panel, 'click', '[data-edit-sub]', (e, el) => subcategoryDialog(find(el), findSub(el)).then(ok => ok && again()));
    on(panel, 'click', '[data-delete-category]', (e, el) => deleteCategoryDialog(categories, find(el)).then(ok => ok && again()));
    on(panel, 'click', '[data-delete-sub]', (e, el) => deleteCategoryDialog(categories, find(el), findSub(el)).then(ok => ok && again()));

    const tree = $('[data-tree]', panel);
    const saveOrder = async (item) => {
      try {
        if (item.hasAttribute('data-sub')) {
          const parent = item.closest('[data-category]').dataset.category;
          await api.reorderSubcategories(parent, $$('[data-sub]', item.parentElement).map(x => x.dataset.sub));
        } else {
          await api.reorderCategories($$('[data-category]:not(.system)', tree).map(x => x.dataset.category));
        }
        await changed();
      } catch (err) {
        toastError(err);
        again();
      }
    };

    // Drag to reorder: categories among categories, subcategories within their parent. Dropping on
    // the lower half of a row puts it after that row, so anything can be moved to the end.
    let dragging = null;
    let drop = null;
    const clearMarks = () => $$('.drop-before, .drop-after', tree).forEach(x => x.classList.remove('drop-before', 'drop-after'));
    on(tree, 'dragstart', '[data-sub], [data-category]', (e, el) => {
      e.stopPropagation();
      dragging = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });
    on(tree, 'dragend', '[data-sub], [data-category]', () => {
      dragging?.classList.remove('dragging');
      dragging = null;
      drop = null;
      clearMarks();
    });
    on(tree, 'dragover', '[data-sub], [data-category]', (e) => {
      if (!dragging) return;
      const isSub = dragging.hasAttribute('data-sub');
      const target = isSub ? e.target.closest('[data-sub]') : e.target.closest('[data-category]');
      if (!target || target === dragging || target.classList.contains('system')) return;
      if (isSub && target.parentElement !== dragging.parentElement) return;
      e.preventDefault();
      const box = target.getBoundingClientRect();
      drop = { target, after: e.clientY > box.top + box.height / 2 };
      clearMarks();
      target.classList.add(drop.after ? 'drop-after' : 'drop-before');
    });
    on(tree, 'drop', '[data-sub], [data-category]', async (e) => {
      if (!dragging || !drop) return;
      e.preventDefault();
      const item = dragging;
      if (drop.after) drop.target.after(item);
      else drop.target.before(item);
      clearMarks();
      await saveOrder(item);
    });

    // The same by keyboard: arrow keys on a row's handle move it up or down one place
    on(tree, 'keydown', '[data-move]', async (e, handle) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const item = handle.closest('[data-sub], [data-category]');
      const peers = [...item.parentElement.children].filter(x => x.matches(item.hasAttribute('data-sub') ? '[data-sub]' : '[data-category]:not(.system)'));
      const i = peers.indexOf(item);
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= peers.length) return;
      if (j < i) peers[j].before(item);
      else peers[j].after(item);
      handle.focus();
      await saveOrder(item);
    });
  },

  // ---------- Payees ----------
  async payees(section, { filter: initialFilter = '' } = {}) {
    const panel = fresh(section);
    const payees = await api.get('/api/payees');
    render(panel, html`
      <h3>Payees</h3>
      <p class="panel-hint">Renaming a payee updates every transaction. Renaming it to an existing payee merges the two.</p>
      <div class="settings-toolbar">
        <div class="input-icon" style="flex:1;min-width:200px">${icon('search')}<input class="input input-sm" type="search" placeholder="Search payees" data-search aria-label="Search payees" value="${initialFilter}"></div>
        <button type="button" class="btn btn-primary btn-sm" data-add>${icon('plus')}Add payee</button>
      </div>
      <div class="list" data-list></div>
    `);
    const list = $('[data-list]', panel);
    const draw = (filter = '') => {
      const shown = payees.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()));
      render(list, shown.length ? html`${shown.map(p => html`
        <div class="list-row" data-payee="${p.id}">
          <span class="avatar sm">${p.name[0]}</span>
          <div class="list-row-main"><span class="list-row-title">${p.name}</span><span class="list-row-meta">${p.usage ? plural(p.usage, 'transaction') : 'Not used yet'}</span></div>
          <button type="button" class="icon-btn sm" data-rename aria-label="Rename ${p.name}">${icon('pencil')}</button>
          <button type="button" class="icon-btn sm danger" data-delete aria-label="Delete ${p.name}">${icon('trash')}</button>
        </div>`)}` : html`<div class="empty compact"><p>${filter ? 'No payees match.' : 'No payees yet. They are added as you enter transactions.'}</p></div>`);
    };
    const search = $('[data-search]', panel);
    draw(initialFilter);
    search.addEventListener('input', () => draw(search.value));
    // Keep the search after a rename or delete, so a long list doesn't have to be searched again
    const again = () => PANELS.payees(section, { filter: search.value });
    const find = (el) => payees.find(p => p.id === el.closest('[data-payee]').dataset.payee);
    $('[data-add]', panel).addEventListener('click', () => payeeDialog(null).then(ok => ok && again()));
    on(list, 'click', '[data-rename]', (e, el) => payeeDialog(find(el)).then(ok => ok && again()));
    on(list, 'click', '[data-delete]', (e, el) => deletePayeeDialog(payees, find(el)).then(ok => ok && again()));
  },

  // ---------- Archived accounts ----------
  async accounts(section) {
    const panel = fresh(section);
    const archived = archivedAccounts();
    render(panel, html`
      <h3>Archived accounts</h3>
      <p class="panel-hint">Archived accounts are hidden from the sidebar and charts. Their transactions are kept, so you can bring them back any time.</p>
      ${archived.length ? html`<div class="list">${archived.map(a => {
        const view = accountBalanceView(a);
        return html`
          <div class="list-row" data-account="${a.id}">
            ${accountAvatar(a)}
            <div class="list-row-main"><span class="list-row-title">${a.name}</span><span class="list-row-meta">${accountTypeLabel(a.type)} · ${view.label.toLowerCase()} ${view.text}</span></div>
            <button type="button" class="btn btn-secondary btn-sm" data-restore>${icon('undo')}Restore</button>
          </div>`;
      })}</div>` : html`<div class="empty compact">${icon('archive')}<p>No archived accounts.</p></div>`}
    `);
    on(panel, 'click', '[data-restore]', async (e, el) => {
      const id = el.closest('[data-account]').dataset.account;
      await busy(el, async () => {
        try {
          await api.restoreAccount(id);
          await changed();
          toast('Account restored', { kind: 'success' });
          PANELS.accounts(section);
        } catch (err) {
          toastError(err);
        }
      });
    });
  },

  // ---------- Backups ----------
  async backups(section) {
    const panel = fresh(section);
    const backups = await api.backups();
    const label = { auto: 'Automatic', safety: 'Safety copy', manual: 'Saved by you' };
    render(panel, html`
      <h3>Backups</h3>
      <p class="panel-hint">Brisk Budget saves a backup every hour when something has changed, keeping the last 24. It also keeps a safety copy before every upgrade or restore.</p>
      <div class="settings-section">
        <h4>Make a backup</h4>
        <p>Download a ZIP of all your data to keep somewhere safe, or save one on the server.</p>
        <div class="settings-toolbar">
          <a class="btn btn-primary" href="/api/backup" download>${icon('download')}Download backup</a>
          <button type="button" class="btn btn-secondary" data-create>${icon('database')}Save a backup on the server</button>
        </div>
      </div>
      <div class="settings-section">
        <h4>Restore from a file</h4>
        <p>Replace everything with a backup ZIP. Backups from older versions of Brisk Budget are upgraded automatically, and your current data is saved first.</p>
        <label class="btn btn-secondary file-btn">${icon('upload')}Choose backup file…<input type="file" accept=".zip,application/zip" class="sr-only" data-restore-file></label>
      </div>
      <div class="settings-section">
        <h4>Saved on the server</h4>
        ${backups.length ? html`<div class="list">${backups.map(b => html`
          <div class="list-row" data-backup="${b.name}">
            <span class="avatar sm">${icon(b.kind === 'safety' ? 'shield' : b.kind === 'auto' ? 'clock' : 'database', { size: 14 })}</span>
            <div class="list-row-main"><span class="list-row-title">${dateTime(b.createdAt)}</span><span class="list-row-meta">${label[b.kind]} · ${bytes(b.size)}</span></div>
            <a class="icon-btn sm" href="/api/backups/${encodeURIComponent(b.name)}" download aria-label="Download backup from ${dateTime(b.createdAt)}">${icon('download')}</a>
            <button type="button" class="btn btn-ghost btn-sm" data-restore-saved>Restore</button>
            <button type="button" class="icon-btn sm danger" data-delete-backup aria-label="Delete backup from ${dateTime(b.createdAt)}">${icon('trash')}</button>
          </div>`)}</div>` : html`<p class="muted">None yet. The first automatic backup is made an hour after something changes.</p>`}
      </div>
    `);
    const again = () => PANELS.backups(section);
    const afterRestore = (result) => {
      toast(`Restored ${plural(result.accounts, 'account')} and ${plural(result.transactions, 'transaction')}${result.upgraded ? ', upgraded from an older version' : ''}.`, { kind: 'success', duration: 8000 });
      setTimeout(() => location.reload(), 1200);
    };
    $('[data-create]', panel).addEventListener('click', async (e) => {
      await busy(e.currentTarget, async () => {
        try { await api.createBackup(); toast('Backup saved on the server', { kind: 'success' }); again(); } catch (err) { toastError(err); }
      });
    });
    $('[data-restore-file]', panel).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const ok = await confirmDialog({
        title: 'Restore backup',
        message: `Replace all your data with "${file.name}"?`,
        detail: 'A safety copy of your current data is saved first, so this can be undone from the list below.',
        confirmLabel: 'Restore'
      });
      if (!ok) return;
      try {
        afterRestore(await api.restoreBackupFile(file));
      } catch (err) {
        toastError(err);
      }
    });
    on(panel, 'click', '[data-restore-saved]', async (e, el) => {
      const name = el.closest('[data-backup]').dataset.backup;
      const ok = await confirmDialog({ title: 'Restore backup', message: 'Replace all your data with this backup?', detail: 'A safety copy of your current data is saved first.', confirmLabel: 'Restore' });
      if (!ok) return;
      await busy(el, async () => {
        try { afterRestore(await api.restoreSavedBackup(name)); } catch (err) { toastError(err); }
      });
    });
    on(panel, 'click', '[data-delete-backup]', async (e, el) => {
      const name = el.closest('[data-backup]').dataset.backup;
      const ok = await confirmDialog({ title: 'Delete backup', message: 'Delete this backup from the server?' });
      if (!ok) return;
      try { await api.deleteBackup(name); again(); } catch (err) { toastError(err); }
    });
  },

  // ---------- Data check ----------
  async data(section) {
    const panel = fresh(section);
    render(panel, html`<h3>Data check</h3><p class="panel-hint">Looks for problems in your data, such as transfers missing their other side, and offers safe fixes.</p><div class="skeleton" style="height:80px"></div>`);
    const result = await api.dataCheck();
    const draw = (res) => {
      render(panel, html`
        <h3>Data check</h3>
        <p class="panel-hint">Looks for problems in your data, such as transfers missing their other side, and offers safe fixes.</p>
        ${res.issues.length ? html`
          <div class="settings-toolbar"><button type="button" class="btn btn-primary btn-sm" data-fix-all>${icon('check')}Fix all ${res.issues.length}</button><button type="button" class="btn btn-ghost btn-sm" data-rescan>${icon('refresh')}Check again</button></div>
          <div class="list">${res.issues.map(i => html`
            <div class="list-row" data-issue="${i.id}">
              <span class="avatar sm" style="color:var(--warning-text)">${icon('alert', { size: 14 })}</span>
              <div class="list-row-main"><span class="list-row-title">${i.message}</span><span class="list-row-meta">Fix: ${i.fix}</span></div>
              ${i.fixable ? html`<button type="button" class="btn btn-secondary btn-sm" data-fix>Fix</button>` : ''}
            </div>`)}</div>`
          : html`<div class="alert success">${icon('check')}<span>Everything looks healthy. Checked ${dateTime(res.checkedAt)}.</span></div>
            <div class="settings-toolbar" style="margin-top:var(--space-3)"><button type="button" class="btn btn-ghost btn-sm" data-rescan>${icon('refresh')}Check again</button></div>`}
      `);
    };
    draw(result);
    on(panel, 'click', '[data-rescan]', async () => draw(await api.dataCheck()));
    on(panel, 'click', '[data-fix-all]', async (e, el) => busy(el, async () => {
      try { const res = await api.fixData({ all: true }); await changed(); draw(res); toast(`Fixed ${plural(res.fixed, 'problem')}`, { kind: 'success' }); } catch (err) { toastError(err); }
    }));
    on(panel, 'click', '[data-fix]', async (e, el) => busy(el, async () => {
      try { const res = await api.fixData({ ids: [el.closest('[data-issue]').dataset.issue] }); await changed(); draw(res); } catch (err) { toastError(err); }
    }));
  },

  // ---------- Security ----------
  async security(section) {
    const panel = fresh(section);
    const enabled = state.auth?.enabled;
    render(panel, html`
      <h3>Security</h3>
      <p class="panel-hint">Brisk Budget is open to anyone who can reach it on your network unless you set a password.</p>
      <div class="alert ${enabled ? 'success' : 'warning'}" style="margin-bottom:var(--space-5)">${icon(enabled ? 'shield' : 'alert')}<span>${enabled ? 'A password is set. Everyone must sign in.' : 'No password is set.'}</span></div>
      <form class="form-stack" data-form style="max-width:420px" novalidate>
        ${enabled ? html`<label class="field"><span class="field-label">Current password</span><input class="input" type="password" name="currentPassword" autocomplete="current-password" required></label>` : ''}
        <label class="field"><span class="field-label">${enabled ? 'New password' : 'Password'}</span><input class="input" type="password" name="newPassword" autocomplete="new-password" minlength="8" required><span class="field-help">At least 8 characters.</span></label>
        <label class="field"><span class="field-label">Type it again</span><input class="input" type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>
        <div class="settings-toolbar">
          <button type="submit" class="btn btn-primary">${enabled ? 'Change password' : 'Set password'}</button>
          ${enabled ? html`<button type="button" class="btn btn-danger-ghost" data-remove>Remove password</button>` : ''}
        </div>
        <p class="field-help">Forgotten it? Delete <code>data/auth.json</code> on the server and restart Brisk Budget.</p>
      </form>
    `);
    const form = $('[data-form]', panel);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (form.newPassword.value !== form.confirm.value) { toast("The two passwords don't match", { kind: 'error' }); return; }
      await busy(event.submitter, async () => {
        try {
          await api.setPassword({ currentPassword: form.currentPassword?.value, newPassword: form.newPassword.value });
          await changed();
          toast(enabled ? 'Password changed' : 'Password set. You stay signed in on this device.', { kind: 'success' });
          PANELS.security(section);
        } catch (err) {
          toastError(err);
        }
      });
    });
    $('[data-remove]', panel)?.addEventListener('click', async (e) => {
      if (!form.currentPassword.value) { form.currentPassword.focus(); toast('Enter your current password first', { kind: 'warning' }); return; }
      await busy(e.currentTarget, async () => {
        try {
          await api.removePassword({ currentPassword: form.currentPassword.value });
          await changed();
          toast('Password removed');
          PANELS.security(section);
        } catch (err) {
          toastError(err);
        }
      });
    });
  },

  // ---------- About & updates ----------
  async about(section, { show }) {
    const panel = fresh(section);
    const info = state.update || await api.version();
    const draw = (u) => {
      const off = offReason(u);
      // null: not a Linux install with systemd, so there's no way to tell
      const autoKnown = typeof u.autoUpdate === 'boolean';
      render(panel, html`
        <h3>About Brisk Budget</h3>
        <p class="panel-hint">A lightweight, self-hosted personal finance tracker. Your data stays on your server as plain JSON files.</p>
        <div class="settings-section">
          <h4>Version</h4>
          <div class="list">
            <div class="list-row"><div class="list-row-main"><span class="list-row-title">Installed</span></div><strong>v${u.current}</strong></div>
            <div class="list-row"><div class="list-row-main"><span class="list-row-title">Latest release</span><span class="list-row-meta" id="update-status">${off || (u.checkError ? `The last check failed${u.checkedAt ? ` (${dateTime(u.checkedAt)})` : ''}` : u.checkedAt ? `Checked ${dateTime(u.checkedAt)}` : 'Not checked yet')}</span></div>
              <strong>${u.latest ? `v${u.latest}` : '—'}</strong></div>
          </div>
          ${u.updateAvailable ? html`<div class="alert info" style="margin-top:var(--space-3)">${icon('arrowUpCircle')}<span>Version ${u.latest} is available.${u.releaseUrl ? html` <a href="${u.releaseUrl}" target="_blank" rel="noopener">See what's new</a>.` : ''}</span></div>` : ''}
          <div class="settings-toolbar" style="margin-top:var(--space-3)">
            <button type="button" class="btn btn-secondary btn-sm" data-check aria-describedby="update-status" ${off ? 'disabled' : ''}>${icon('refresh')}Check now</button>
            ${off && u.checkDisabledReason !== 'env' ? html`<button type="button" class="btn btn-ghost btn-sm" data-goto-general>Turn checks on in General</button>` : ''}
          </div>
        </div>
        <div class="settings-section">
          <h4>Updating</h4>
          ${autoKnown ? html`
            <p>Run the install command again on your server. Your data is backed up first and upgraded automatically. If the new version fails to start, the previous one is put back.</p>
            <code style="display:block;padding:var(--space-3);white-space:pre-wrap;word-break:break-all">${UPDATE_COMMAND}</code>
            <p style="margin-top:var(--space-4)">Automatic updates are <strong>${u.autoUpdate ? 'on' : 'off'}</strong>. ${u.autoUpdate ? 'Brisk Budget checks for a new release each night and installs it.' : 'To have Brisk Budget update itself each night, run:'}</p>
            ${u.autoUpdate ? '' : html`<code style="display:block;padding:var(--space-3);white-space:pre-wrap;word-break:break-all">${AUTO_UPDATE_COMMAND}</code>`}`
            : html`<p>Update Brisk Budget the same way it was installed here. Your data is backed up first and upgraded automatically when the new version starts.</p>
            <p style="margin-top:var(--space-3)">Brisk Budget can't tell whether automatic updates are set up on this system. The install command's nightly updates are for Linux servers.</p>`}
        </div>
        <div class="settings-section">
          <h4>Keyboard shortcuts</h4>
          <div class="list">
            <div class="list-row"><span class="list-row-main">New transaction (in an account) or recurring payment</span><kbd>N</kbd></div>
            <div class="list-row"><span class="list-row-main">New transfer (in an account)</span><kbd>T</kbd></div>
            <div class="list-row"><span class="list-row-main">Search transactions</span><kbd>/</kbd></div>
            <div class="list-row"><span class="list-row-main">Close a dialog or clear a selection</span><kbd>Esc</kbd></div>
            <div class="list-row"><span class="list-row-main">Move the selected account or group in the sidebar</span><span><kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd></span></div>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-toolbar">
            <a class="btn btn-secondary btn-sm" href="https://github.com/CoppingEthan/Brisk-Budget" target="_blank" rel="noopener">${icon('github')}GitHub</a>
            <a class="btn btn-secondary btn-sm" href="https://briskbudget.app" target="_blank" rel="noopener">${icon('info')}briskbudget.app</a>
          </div>
          <p class="faint" style="margin-top:var(--space-3)">Made by Ethan Copping. MIT licence.</p>
        </div>
      `);
      $('[data-goto-general]', panel)?.addEventListener('click', () => {
        show('general');
        $('#tab-general')?.focus();
      });
      $('[data-check]', panel).addEventListener('click', async (e) => {
        await busy(e.currentTarget, async () => {
          try {
            const fresh = await api.checkForUpdate();
            state.update = fresh;
            draw(fresh);
            $('[data-check]', panel)?.focus();
            if (offReason(fresh)) toast(offReason(fresh), { kind: 'warning' });
            else if (fresh.checkError || !fresh.latest) toast("Couldn't reach GitHub just now. Try again later.", { kind: 'error' });
            else if (fresh.updateAvailable) toast(`Version ${fresh.latest} is available`, { kind: 'info' });
            else toast("You're up to date", { kind: 'success' });
          } catch (err) {
            toastError(err);
          }
        });
      });
    };
    draw(info);
  }
};

// ----- Small dialogs used by the panels -----

function categoryDialog(category) {
  const dialog = openDialog({
    title: category ? 'Edit category' : 'Add category',
    body: html`
      <form class="form-stack" id="category-form" novalidate>
        <label class="field"><span class="field-label">Name</span><input class="input" name="name" value="${category?.name || ''}" required maxlength="60"></label>
        ${emojiPicker('emoji', category?.emoji || '📁')}
        ${colourPicker('color', category?.color)}
      </form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="category-form" class="btn btn-primary">Save</button>`
  });
  const form = $('#category-form', dialog.body);
  bindPickers(form);
  bindForm(dialog, form, async (values) => {
    const body = { name: values.name, emoji: values.emoji, color: values.color };
    if (category) await api.updateCategory(category.id, body);
    else await api.createCategory(body);
    await refreshAfterSave();
    dialog.close(true);
  });
  return dialog.closed.then(r => r === true);
}

function subcategoryDialog(parent, sub) {
  const dialog = openDialog({
    title: sub ? 'Rename subcategory' : `Add to ${parent.name}`,
    size: 'sm',
    body: html`<form class="form-stack" id="sub-form" novalidate><label class="field"><span class="field-label">Name</span><input class="input" name="name" value="${sub?.name || ''}" required maxlength="60"></label></form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="sub-form" class="btn btn-primary">Save</button>`
  });
  bindForm(dialog, $('#sub-form', dialog.body), async (values) => {
    if (sub) await api.updateSubcategory(parent.id, sub.id, { name: values.name });
    else await api.addSubcategory(parent.id, { name: values.name });
    await refreshAfterSave();
    dialog.close(true);
  });
  return dialog.closed.then(r => r === true);
}

function deleteCategoryDialog(categories, category, sub = null) {
  const target = sub || category;
  const usage = sub ? sub.usage : category.usage + category.subcategories.reduce((s, x) => s + x.usage, 0);
  const excluded = new Set(sub ? [sub.id] : [category.id, ...category.subcategories.map(s => s.id)]);
  const filtered = categories
    .filter(c => !excluded.has(c.id))
    .map(c => ({ ...c, subcategories: c.subcategories.filter(s => !excluded.has(s.id)) }));
  const dialog = openDialog({
    title: `Delete ${target.name}`,
    size: 'sm',
    body: html`
      <form class="form-stack" id="delete-cat-form">
        <p>${usage ? html`<strong>${target.name}</strong> is used by ${plural(usage, 'transaction or payment', 'transactions and payments')}${sub ? '' : ' (including its subcategories)'}. Where should they go?` : html`Delete <strong>${target.name}</strong>? Nothing uses it.`}</p>
        ${usage ? html`<label class="field"><span class="field-label">Move them to</span><select class="select" name="replacementId">${categoryOptions(filtered, sub ? category.id : 'cat-uncategorized')}</select></label>` : ''}
      </form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="delete-cat-form" class="btn btn-danger">Delete</button>`
  });
  bindForm(dialog, $('#delete-cat-form', dialog.body), async (values) => {
    if (sub) await api.deleteSubcategory(category.id, sub.id, values.replacementId);
    else await api.deleteCategory(category.id, values.replacementId);
    await refreshAfterSave();
    dialog.close(true);
  });
  return dialog.closed.then(r => r === true);
}

function payeeDialog(payee) {
  const dialog = openDialog({
    title: payee ? 'Rename payee' : 'Add payee',
    size: 'sm',
    body: html`<form class="form-stack" id="payee-form" novalidate><label class="field"><span class="field-label">Name</span><input class="input" name="name" value="${payee?.name || ''}" required maxlength="200"></label></form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="payee-form" class="btn btn-primary">Save</button>`
  });
  bindForm(dialog, $('#payee-form', dialog.body), async (values) => {
    if (payee) {
      const result = await api.renamePayee(payee.id, values.name);
      if (result.merged) toast(`Merged into "${result.name}"`, { kind: 'success' });
    } else {
      await api.createPayee({ name: values.name });
    }
    await refreshAfterSave();
    dialog.close(true);
  });
  return dialog.closed.then(r => r === true);
}

function deletePayeeDialog(payees, payee) {
  const others = payees.filter(p => p.id !== payee.id);
  const dialog = openDialog({
    title: `Delete ${payee.name}`,
    size: 'sm',
    body: html`
      <form class="form-stack" id="delete-payee-form">
        <p>${payee.usage ? html`<strong>${payee.name}</strong> is on ${plural(payee.usage, 'transaction')}.` : html`Remove <strong>${payee.name}</strong> from your payees?`}</p>
        ${payee.usage ? html`
          <label class="field"><span class="field-label">Change those transactions to</span>
            <select class="select" name="replacement"><option value="">Leave them as they are</option>${others.map(p => html`<option value="${p.name}">${p.name}</option>`)}</select>
          </label>` : ''}
      </form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="delete-payee-form" class="btn btn-danger">Delete</button>`
  });
  bindForm(dialog, $('#delete-payee-form', dialog.body), async (values) => {
    await api.deletePayee(payee.id, values.replacement || undefined);
    await refreshAfterSave();
    dialog.close(true);
  });
  return dialog.closed.then(r => r === true);
}
