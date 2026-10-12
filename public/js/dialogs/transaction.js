import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, activeAccounts, account as findAccount, changed, UNCATEGORIZED } from '../core/state.js';
import { openDialog } from '../ui/dialog.js';
import { bindForm, busy, categoryOptions, refreshAfterSave } from '../ui/forms.js';
import { toast, toastError } from '../ui/toast.js';
import { today } from '../shared/dates.js';
import { parseAmount } from '../shared/money.js';

function payeeList(id) {
  return html`<datalist id="${id}">${state.payees.map(p => html`<option value="${p.name}"></option>`)}</datalist>`;
}

// On a phone, opening a transaction to look at it shouldn't pop the keyboard up
const touchScreen = () => matchMedia('(hover: none), (pointer: coarse)').matches;

async function deleteTransaction(dialog, accountId, tx, button) {
  let result;
  await busy(button, async () => {
    try {
      result = await api.deleteTransaction(accountId, tx.id);
    } catch (err) {
      dialog.setError(err.message);
    }
  });
  if (!result) return;
  dialog.close(true);
  try {
    await changed();
  } catch (err) {
    toastError(err);
  }
  toast(`Deleted "${tx.payee}"`, {
    action: { label: 'Undo', run: async () => { await api.restoreTransactions(result.undo); await changed(); toast('Restored', { kind: 'success' }); } }
  });
}

// Add or edit a normal transaction. Transfers open the transfer editor instead.
export function openTransactionDialog({ accountId, transaction = null } = {}) {
  if (transaction?.transferId) return openTransferDialog({ transfer: transaction, accountId });
  const editing = !!transaction;
  const amount = transaction ? Math.abs(transaction.amount) : '';
  const direction = transaction && transaction.amount > 0 ? 'in' : 'out';
  const listId = `payees-${Date.now()}`;

  const dialog = openDialog({
    title: editing ? 'Edit transaction' : 'Add transaction',
    initialFocus: editing && touchScreen() ? false : undefined,
    body: html`
      <form class="form-stack" id="tx-form" novalidate>
        <div class="field-row">
          <label class="field">
            <span class="field-label">Payee</span>
            <input class="input" name="payee" list="${listId}" value="${transaction?.payee || ''}" required maxlength="200" autocomplete="off" placeholder="Who was it with?">
            ${payeeList(listId)}
          </label>
          <div class="field">
            <label class="field-label" for="tx-amount">Amount</label>
            <div class="input-group">
              <button type="button" class="direction-toggle" data-direction="${direction}" aria-label="Money ${direction === 'in' ? 'in' : 'out'}, click to switch">${direction === 'in' ? 'IN' : 'OUT'}</button>
              <input class="input tabular" id="tx-amount" name="amount" type="text" inputmode="decimal" value="${amount === '' ? '' : amount.toFixed(2)}" required placeholder="0.00" autocomplete="off">
            </div>
          </div>
        </div>
        <div class="field-row">
          <label class="field">
            <span class="field-label">Date</span>
            <input class="input" type="date" name="date" value="${transaction?.date || today()}" required>
          </label>
          <label class="field">
            <span class="field-label">Category</span>
            <select class="select" name="categoryId">${categoryOptions(state.categories, transaction?.categoryId || UNCATEGORIZED)}</select>
          </label>
        </div>
        <label class="field">
          <span class="field-label">Description</span>
          <input class="input" name="description" value="${transaction?.description || ''}" maxlength="500" placeholder="Optional">
        </label>
        <label class="field">
          <span class="field-label">Notes</span>
          <textarea class="textarea" name="notes" rows="2" maxlength="2000" placeholder="Optional">${transaction?.notes || ''}</textarea>
        </label>
        ${transaction?.autoInterest ? html`<div class="alert info">${icon('info')}<span>Brisk Budget added this mortgage interest automatically.</span></div>` : ''}
      </form>
    `,
    footer: html`
      ${editing ? html`<button type="button" class="btn btn-danger-ghost" data-delete>${icon('trash')}Delete</button>` : ''}
      <span class="spacer"></span>
      ${editing ? '' : html`<button type="button" form="tx-form" class="btn btn-secondary" data-submit data-again>Save &amp; add another</button>`}
      <button type="submit" form="tx-form" class="btn btn-primary">Save</button>
    `
  });

  const form = $('#tx-form', dialog.body);
  const toggle = $('.direction-toggle', form);
  let categoryTouched = editing;

  function setDirection(next) {
    toggle.dataset.direction = next;
    toggle.textContent = next.toUpperCase();
    toggle.setAttribute('aria-label', `Money ${next}, click to switch`);
  }
  toggle.addEventListener('click', () => setDirection(toggle.dataset.direction === 'in' ? 'out' : 'in'));
  // Typing a minus (or plus) sets the direction instead, so "-20" can't quietly save as money in
  form.amount.addEventListener('input', () => {
    const input = form.amount;
    if (!/[-−–+]/.test(input.value)) return;
    setDirection(/[-−–]/.test(input.value) ? 'out' : 'in');
    const caret = input.selectionStart ?? input.value.length;
    const removed = input.value.slice(0, caret).replace(/[^-−–+]/g, '').length;
    input.value = input.value.replace(/[-−–+]/g, '');
    input.setSelectionRange?.(caret - removed, caret - removed);
  });
  form.categoryId.addEventListener('change', () => { categoryTouched = true; });
  // Pick the category this payee had last time
  form.payee.addEventListener('change', async () => {
    if (categoryTouched || !form.payee.value.trim()) return;
    try {
      const { categoryId } = await api.lastCategory(form.payee.value.trim());
      if (categoryId && !categoryTouched && state.categories.length) form.categoryId.value = categoryId;
    } catch { /* not important */ }
  });
  on(dialog.footer, 'click', '[data-delete]', (event, button) => deleteTransaction(dialog, accountId, transaction, button));

  // Enter means Save; "Save & add another" is a plain button that submits through bindForm
  const submit = bindForm(dialog, form, async (values, submitter) => {
    const addAnother = !!submitter?.hasAttribute('data-again');
    const value = parseAmount(values.amount);
    if (!Number.isFinite(value)) throw new Error("That amount doesn't look right");
    if (value === 0) throw new Error('Enter an amount more than zero');
    // A negative amount, e.g. "(20.00)", is money out whatever the toggle says
    const signed = value > 0 && toggle.dataset.direction === 'in' ? value : -Math.abs(value);
    const body = { payee: values.payee, amount: signed, date: values.date, categoryId: values.categoryId, description: values.description, notes: values.notes };
    if (editing) await api.updateTransaction(accountId, transaction.id, body);
    else await api.createTransaction(accountId, body);
    await refreshAfterSave();
    if (addAnother) {
      toast(`Added "${values.payee}"`, { kind: 'success' });
      // reset() also clears the red "required" outlines the emptied fields would get; keep the date
      const date = form.date.value;
      form.reset();
      form.date.value = date;
      categoryTouched = false;
      form.payee.focus();
      return;
    }
    dialog.close(true);
  });
  on(dialog.footer, 'click', '[data-again]', (event, button) => submit(button));
  return dialog.closed;
}

// Create a transfer, or edit one (changes always apply to both sides)
export function openTransferDialog({ fromAccountId = null, toAccountId = null, transfer = null, accountId = null } = {}) {
  const accounts = activeAccounts();
  if (!transfer && accounts.length < 2) {
    toast('You need at least two accounts to make a transfer', { kind: 'warning' });
    return Promise.resolve(false);
  }
  let from = fromAccountId;
  let to = toAccountId;
  if (transfer) {
    from = transfer.amount < 0 ? accountId : transfer.transferAccountId;
    to = transfer.amount < 0 ? transfer.transferAccountId : accountId;
  }
  if (!to) to = accounts.find(a => a.id !== from)?.id;
  const options = (selected) => {
    const list = [...accounts];
    // Keep archived accounts selectable when editing an old transfer that uses them
    for (const id of [from, to]) {
      const a = findAccount(id);
      if (a && a.active === false && !list.includes(a)) list.push(a);
    }
    return list.map(a => html`<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${a.name}${a.active === false ? ' (archived)' : ''}</option>`);
  };

  const dialog = openDialog({
    title: transfer ? 'Edit transfer' : 'Transfer between accounts',
    initialFocus: transfer && touchScreen() ? false : undefined,
    body: html`
      <form class="form-stack" id="transfer-form" novalidate>
        ${transfer ? html`<div class="alert info">${icon('info')}<span>Changes apply to both sides of the transfer.</span></div>` : ''}
        <div class="field-row">
          <label class="field">
            <span class="field-label">From</span>
            <select class="select" name="fromAccountId" required>${options(from)}</select>
          </label>
          <label class="field">
            <span class="field-label">To</span>
            <select class="select" name="toAccountId" required>${options(to)}</select>
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span class="field-label">Amount</span>
            <div class="input-group">
              <span class="input-prefix">${state.settings.currencySymbol}</span>
              <input class="input tabular" name="amount" type="text" inputmode="decimal" required placeholder="0.00" value="${transfer ? Math.abs(transfer.amount).toFixed(2) : ''}" autocomplete="off">
            </div>
          </label>
          <label class="field">
            <span class="field-label">Date</span>
            <input class="input" type="date" name="date" value="${transfer?.date || today()}" required>
          </label>
        </div>
        <label class="field">
          <span class="field-label">Description</span>
          <input class="input" name="description" maxlength="500" value="${transfer?.description || ''}" placeholder="Optional">
        </label>
        <label class="field">
          <span class="field-label">Notes</span>
          <textarea class="textarea" name="notes" rows="2" maxlength="2000" placeholder="Optional">${transfer?.notes || ''}</textarea>
        </label>
      </form>
    `,
    footer: html`
      ${transfer ? html`<button type="button" class="btn btn-danger-ghost" data-delete>${icon('trash')}Delete</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
      <button type="submit" form="transfer-form" class="btn btn-primary">${transfer ? 'Save' : 'Transfer'}</button>
    `
  });
  const form = $('#transfer-form', dialog.body);
  if (transfer) on(dialog.footer, 'click', '[data-delete]', (event, button) => deleteTransaction(dialog, accountId, transfer, button));

  bindForm(dialog, form, async (values) => {
    if (values.fromAccountId === values.toAccountId) throw new Error("Pick two different accounts");
    const amount = parseAmount(values.amount);
    if (!Number.isFinite(amount) || amount === 0) throw new Error('Enter an amount more than zero');
    const body = { fromAccountId: values.fromAccountId, toAccountId: values.toAccountId, amount: Math.abs(amount), date: values.date, description: values.description, notes: values.notes };
    if (transfer) await api.updateTransaction(accountId, transfer.id, body);
    else await api.createTransfer(body);
    await refreshAfterSave();
    dialog.close(true);
    if (!transfer) toast('Transfer added', { kind: 'success' });
  });
  return dialog.closed;
}
