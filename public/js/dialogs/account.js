import { html, $, on, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, groups, changed, ACCOUNT_TYPES, LIABILITY_TYPES, ASSET_VALUE_TYPES } from '../core/state.js';
import { navigate } from '../core/router.js';
import { openDialog } from '../ui/dialog.js';
import { bindForm, readIcon, refreshAfterSave } from '../ui/forms.js';
import { toast, toastError } from '../ui/toast.js';
import { parseAmount } from '../shared/money.js';
import { today } from '../shared/dates.js';

// Types whose value is for something bought: a car, a house
const BOUGHT_TYPES = ['loan', 'mortgage', 'asset'];

export function iconField(current) {
  return html`
    <div class="field">
      <span class="field-label">Icon <span class="faint">(optional)</span></span>
      <div class="icon-upload">
        <button type="button" class="icon-preview ${current ? 'has-icon' : ''}" data-icon-preview aria-label="Choose an icon image">
          ${current ? html`<img src="${current}" alt="">` : icon('image')}
        </button>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
          <button type="button" class="btn btn-secondary btn-sm" data-icon-pick>${icon('upload')}Upload image</button>
          <button type="button" class="btn btn-ghost btn-sm ${current ? '' : 'hidden'}" data-icon-remove>Remove</button>
        </div>
        <input type="file" accept="image/*" class="hidden" data-icon-input>
      </div>
    </div>`;
}

// Hooks up an iconField(); returns a getter for the value to send (undefined = unchanged)
export function bindIconField(root, current) {
  let value;
  const preview = $('[data-icon-preview]', root);
  const input = $('[data-icon-input]', root);
  const remove = $('[data-icon-remove]', root);
  const show = (src) => {
    preview.classList.toggle('has-icon', !!src);
    render(preview, src ? html`<img src="${src}" alt="">` : icon('image'));
    remove.classList.toggle('hidden', !src);
  };
  on(root, 'click', '[data-icon-pick], [data-icon-preview]', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      value = await readIcon(file);
      show(value);
    } catch (err) {
      toastError(err);
    }
  });
  remove.addEventListener('click', () => { value = null; show(null); });
  show(current);
  return () => value;
}

export function openAccountDialog(account = null) {
  const editing = !!account;
  const type = account?.type || 'bank';
  const liability = LIABILITY_TYPES.includes(type);
  const opening = account ? (liability ? -account.startingBalance : account.startingBalance) : '';
  // Only a group that still exists counts (the sidebar shows the account ungrouped otherwise)
  const currentGroup = account?.groupId && state.groups.some(g => g.id === account.groupId) ? account.groupId : '';

  const dialog = openDialog({
    title: editing ? 'Edit account' : 'Add account',
    body: html`
      <form class="form-stack" id="account-form" novalidate>
        ${iconField(account?.icon)}
        <label class="field">
          <span class="field-label">Account name</span>
          <input class="input" name="name" value="${account?.name || ''}" required maxlength="100" placeholder="e.g. Current account">
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field-label">Type</span>
            <select class="select" name="type">${ACCOUNT_TYPES.map(t => html`<option value="${t.id}" ${t.id === type ? 'selected' : ''}>${t.label}</option>`)}</select>
          </label>
          ${state.groups.length ? html`
            <label class="field">
              <span class="field-label">Group</span>
              <select class="select" name="groupId"><option value="">No group</option>${groups().map(g => html`<option value="${g.id}" ${g.id === currentGroup ? 'selected' : ''}>${g.name}</option>`)}</select>
            </label>` : ''}
        </div>
        <label class="field">
          <span class="field-label" data-opening-label></span>
          <div class="input-group">
            <span class="input-prefix">${state.settings.currencySymbol}</span>
            <input class="input tabular" name="opening" type="text" inputmode="decimal" value="${opening === '' ? '' : Number(opening).toFixed(2)}" placeholder="0.00" autocomplete="off">
          </div>
          <span class="field-help" data-opening-help></span>
        </label>
        <label class="field" data-asset-field>
          <span class="field-label" data-asset-label>Asset value</span>
          <div class="input-group">
            <span class="input-prefix">${state.settings.currencySymbol}</span>
            <input class="input tabular" name="assetValue" type="text" inputmode="decimal" value="${account?.assetValue ? Number(account.assetValue).toFixed(2) : ''}" placeholder="Optional" autocomplete="off">
          </div>
          <span class="field-help" data-asset-help></span>
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field-label">Opened on <span class="faint">(optional)</span></span>
            <input class="input" name="openedOn" type="date" value="${account?.openedOn || ''}" max="${today()}">
            <span class="field-help" data-opened-help></span>
          </label>
          <label class="field" data-bought-field>
            <span class="field-label">Bought on <span class="faint">(optional)</span></span>
            <input class="input" name="valueFrom" type="date" value="${account?.valueFrom || ''}" max="${today()}">
            <span class="field-help" data-bought-help></span>
          </label>
        </div>
        <label class="field" data-rate-field>
          <span class="field-label">Interest rate</span>
          <div class="input-group">
            <input class="input tabular" name="interestRate" type="text" inputmode="decimal" value="${account?.interestRate ?? ''}" placeholder="e.g. 4.5" autocomplete="off">
            <span class="input-prefix" style="border-radius:0 var(--radius) var(--radius) 0">% a year</span>
          </div>
          <span class="field-help">Interest is added automatically each month on the amount still owed.</span>
        </label>
      </form>
    `,
    footer: html`
      ${editing ? html`<button type="button" class="btn btn-danger-ghost" data-archive>${icon('archive')}Archive</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
      <button type="submit" form="account-form" class="btn btn-primary">${editing ? 'Save' : 'Add account'}</button>
    `
  });
  const form = $('#account-form', dialog.body);
  const getIcon = bindIconField(form, account?.icon || null);

  function updateFields() {
    const t = form.type.value;
    const isLiability = LIABILITY_TYPES.includes(t);
    $('[data-opening-label]', form).textContent = isLiability
      ? (editing ? 'Amount owed at the start' : 'Amount owed now')
      : (editing ? 'Opening balance' : 'Current balance');
    $('[data-opening-help]', form).textContent = isLiability
      ? 'Enter what you owe as a positive number. Use a minus sign if the account is in credit.'
      : editing ? 'The balance before the first transaction recorded here.' : 'Leave empty to start from zero.';
    $('[data-asset-field]', form).classList.toggle('hidden', !ASSET_VALUE_TYPES.includes(t));
    $('[data-rate-field]', form).classList.toggle('hidden', t !== 'mortgage');
    $('[data-bought-field]', form).classList.toggle('hidden', !BOUGHT_TYPES.includes(t));
    $('[data-opened-help]', form).textContent = t === 'loan' || t === 'mortgage'
      ? 'The day you took it out. Charts count it from this day.'
      : "Leave empty if you've had it a while. Charts count it from this day.";
    $('[data-bought-help]', form).textContent = t === 'mortgage'
      ? 'When you bought the property. Net worth counts its value from this day.'
      : t === 'loan' ? 'When you bought what the loan paid for. Net worth counts its value from this day.' : 'Net worth counts its value from this day.';
    $('[data-asset-label]', form).textContent = t === 'mortgage' ? 'Property value' : t === 'loan' ? 'Value of what the loan paid for' : 'Current value';
    $('[data-asset-help]', form).textContent = t === 'mortgage'
      ? 'What the property is worth. Used to show your equity and include the property in net worth.'
      : t === 'loan'
        ? 'Optional, e.g. what the car is worth now. Used to show your equity and counted in your net worth.'
        : 'Optional. What the account is worth today. When set, it is used instead of the balance in your net worth.';
  }
  let lastType = type;
  form.type.addEventListener('change', () => {
    // Keep the meaning of the number when switching between owed and balance
    const wasLiability = LIABILITY_TYPES.includes(lastType);
    const isLiability = LIABILITY_TYPES.includes(form.type.value);
    const current = parseAmount(form.opening.value);
    if (wasLiability !== isLiability && Number.isFinite(current)) form.opening.value = (-current).toFixed(2);
    lastType = form.type.value;
    updateFields();
  });
  updateFields();

  on(dialog.footer, 'click', '[data-archive]', async () => {
    if (!(await archiveAccountDialog(account))) return;
    dialog.close(true);
    navigate('/');
    try {
      await changed();
    } catch (err) {
      toastError(err);
    }
    toast(`Archived "${account.name}"`, { action: { label: 'Undo', run: async () => { await api.restoreAccount(account.id); await changed(); } } });
  });

  bindForm(dialog, form, async (values) => {
    const t = values.type;
    const opening = values.opening.trim() ? parseAmount(values.opening) : 0;
    if (!Number.isFinite(opening)) throw new Error("The balance doesn't look like a number");
    const assetValue = values.assetValue?.trim() ? parseAmount(values.assetValue) : null;
    if (assetValue !== null && !Number.isFinite(assetValue)) throw new Error("The value doesn't look like a number");
    const rate = values.interestRate?.trim() ? Number(values.interestRate.replace('%', '')) : 0;
    if (t === 'mortgage' && (!Number.isFinite(rate) || rate < 0 || rate > 100)) throw new Error('Enter an interest rate between 0 and 100');
    const body = {
      name: values.name,
      type: t,
      startingBalance: LIABILITY_TYPES.includes(t) ? -opening : opening,
      assetValue: ASSET_VALUE_TYPES.includes(t) ? assetValue : null,
      interestRate: t === 'mortgage' ? rate : null,
      openedOn: values.openedOn || null,
      valueFrom: BOUGHT_TYPES.includes(t) ? values.valueFrom || null : null
    };
    const iconValue = getIcon();
    if (iconValue !== undefined) body.icon = iconValue;
    if (!editing && values.groupId) body.groupId = values.groupId;
    const saved = editing ? await api.updateAccount(account.id, body) : await api.createAccount(body);
    // Moving an existing account between groups (the keyboard and touch way to do it)
    if (editing && values.groupId !== undefined && values.groupId !== currentGroup) await api.setAccountGroup(account.id, values.groupId || null);
    await refreshAfterSave();
    dialog.close(saved);
    if (!editing) {
      navigate(`/accounts/${saved.id}`);
      toast(`Added "${saved.name}"`, { kind: 'success' });
    }
  });
  return dialog.closed;
}

// The date field shared by archiving and changing an archived account's closing date. A car loan
// is often settled when the car is sold, so that's the day to give: from then the car no longer
// counts towards net worth, and the history doesn't drop on the day the account was tidied away.
function closedOnField(account, value) {
  const valued = BOUGHT_TYPES.includes(account.type) && account.assetValue;
  return html`
    <label class="field">
      <span class="field-label">Closed on</span>
      <input class="input" name="closedOn" type="date" value="${value}" max="${today()}" required>
      <span class="field-help">${valued
        ? 'If you sold what it paid for, use the day you sold it. Its value stops counting towards your net worth from then.'
        : 'Your charts count it up to this day.'}</span>
    </label>`;
}

// Ask before archiving, and when the account closed. Resolves to true once it's archived.
export async function archiveAccountDialog(account) {
  const dialog = openDialog({
    title: 'Archive account',
    size: 'sm',
    // Cancel has focus, so a stray Enter never archives anything
    initialFocus: '[data-dialog-cancel]',
    body: html`
      <form class="form-stack" id="archive-account-form" novalidate>
        <p>Archive "${account.name}"?</p>
        <p class="muted" style="font-size:var(--text-sm)">It disappears from the sidebar, but every transaction is kept and its recurring payments are paused. You can restore it any time from Settings › Accounts.</p>
        ${closedOnField(account, today())}
      </form>`,
    footer: html`
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
      <button type="submit" form="archive-account-form" class="btn btn-danger">${icon('archive')}Archive</button>`
  });
  bindForm(dialog, $('#archive-account-form', dialog.body), async (values) => {
    await api.archiveAccount(account.id, { closedOn: values.closedOn });
    dialog.close(true);
  });
  return (await dialog.closed) === true;
}

// Change when an archived account closed. Resolves to true once it's saved.
export async function closedOnDialog(account) {
  const current = account.closedOn || (account.archivedAt ? today(new Date(account.archivedAt)) : today());
  const dialog = openDialog({
    title: 'Closing date',
    size: 'sm',
    body: html`
      <form class="form-stack" id="closed-on-form" novalidate>
        <p>When did "${account.name}" close?</p>
        ${closedOnField(account, current)}
      </form>`,
    footer: html`
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
      <button type="submit" form="closed-on-form" class="btn btn-primary">Save</button>`
  });
  bindForm(dialog, $('#closed-on-form', dialog.body), async (values) => {
    await api.updateAccount(account.id, { closedOn: values.closedOn });
    await refreshAfterSave();
    dialog.close(true);
  });
  return (await dialog.closed) === true;
}
