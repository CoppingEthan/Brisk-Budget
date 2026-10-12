import { html, $, on, $$ } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, activeAccounts, account as findAccount, changed, UNCATEGORIZED, TRANSFER } from '../core/state.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { bindForm, categoryOptions, refreshAfterSave } from '../ui/forms.js';
import { toast } from '../ui/toast.js';
import { plural } from '../core/format.js';
import { today } from '../shared/dates.js';
import { parseAmount } from '../shared/money.js';

const PRESETS = [
  { id: 'weekly', label: 'Weekly', frequency: { type: 'weeks', interval: 1 } },
  { id: 'fortnightly', label: 'Fortnightly', frequency: { type: 'weeks', interval: 2 } },
  { id: 'four-weekly', label: '4-weekly', frequency: { type: 'weeks', interval: 4 } },
  { id: 'monthly', label: 'Monthly', frequency: { type: 'months', interval: 1 } },
  { id: 'quarterly', label: 'Quarterly', frequency: { type: 'months', interval: 3 } },
  { id: 'yearly', label: 'Yearly', frequency: { type: 'years', interval: 1 } },
  { id: 'custom', label: 'Custom' }
];

function presetFor(frequency) {
  const match = PRESETS.find(p => p.frequency && p.frequency.type === frequency?.type && p.frequency.interval === frequency?.interval);
  return match ? match.id : 'custom';
}

// Add or edit a recurring payment. `prefill` comes from a suggestion.
export function openRecurringDialog(item = null, prefill = null) {
  const source = item || prefill || {};
  const editing = !!item;
  const mode = source.type === 'transfer' ? 'transfer' : (source.amount ?? -1) >= 0 && source.amount !== undefined ? 'income' : 'expense';
  const accounts = activeAccounts();
  // Every recurring payment belongs to an account, so say so before anything is typed
  if (!editing && !accounts.length) {
    toast('Add an account first. Recurring payments are paid into or out of one.', {
      kind: 'warning',
      action: { label: 'Add account', run: async () => (await import('./account.js')).openAccountDialog() }
    });
    return Promise.resolve(null);
  }
  const accountOptions = (selected) => {
    const list = [...accounts];
    const current = findAccount(selected);
    if (current && current.active === false) list.push(current);
    return list.map(a => html`<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${a.name}${a.active === false ? ' (archived)' : ''}</option>`);
  };
  const frequency = source.frequency || { type: 'months', interval: 1 };
  const preset = presetFor(frequency);
  const end = source.endCondition || { type: 'never', value: null };
  const fromId = source.fromAccountId || accounts[0]?.id;
  const toId = source.toAccountId || accounts.find(a => a.id !== fromId)?.id;

  const dialog = openDialog({
    title: editing ? 'Edit recurring payment' : 'Add recurring payment',
    size: 'lg',
    body: html`
      <form class="form-stack" id="recurring-form" novalidate>
        ${item?.status === 'ended' ? html`<div class="alert info">${icon('info')}<span>This schedule has finished. Change the end condition below to start it again.</span></div>` : ''}
        <div class="field">
          <span class="field-label">Type</span>
          <div class="segmented lg" role="radiogroup" aria-label="Type">
            <label class="seg-income"><input type="radio" name="mode" value="income" ${mode === 'income' ? 'checked' : ''}>Income</label>
            <label class="seg-expense"><input type="radio" name="mode" value="expense" ${mode === 'expense' ? 'checked' : ''}>Expense</label>
            <label><input type="radio" name="mode" value="transfer" ${mode === 'transfer' ? 'checked' : ''}>Transfer</label>
          </div>
        </div>

        <div class="form-stack" data-mode-fields="transaction">
          <div class="field-row">
            <label class="field">
              <span class="field-label">Account</span>
              <select class="select" name="accountId">${accountOptions(source.accountId || accounts[0]?.id)}</select>
            </label>
            <label class="field">
              <span class="field-label">Payee</span>
              <input class="input" name="payee" list="recurring-payees" value="${source.payee || ''}" maxlength="200" autocomplete="off" placeholder="e.g. Netflix">
              <datalist id="recurring-payees">${state.payees.map(p => html`<option value="${p.name}"></option>`)}</datalist>
            </label>
          </div>
          <label class="field">
            <span class="field-label">Category</span>
            <select class="select" name="categoryId">${categoryOptions(state.categories, source.categoryId && source.categoryId !== TRANSFER ? source.categoryId : UNCATEGORIZED)}</select>
          </label>
        </div>

        <div class="field-row" data-mode-fields="transfer">
          <label class="field">
            <span class="field-label">From</span>
            <select class="select" name="fromAccountId">${accountOptions(fromId)}</select>
          </label>
          <label class="field">
            <span class="field-label">To</span>
            <select class="select" name="toAccountId">${accountOptions(toId)}</select>
          </label>
        </div>

        <div class="field-row">
          <label class="field">
            <span class="field-label">Amount</span>
            <div class="input-group">
              <span class="input-prefix">${state.settings.currencySymbol}</span>
              <input class="input tabular" name="amount" type="text" inputmode="decimal" required value="${source.amount !== undefined ? Math.abs(source.amount).toFixed(2) : ''}" placeholder="0.00" autocomplete="off">
            </div>
          </label>
          <label class="field">
            <span class="field-label">${editing ? 'First payment (schedule starts)' : 'First payment'}</span>
            <input class="input" type="date" name="startDate" required value="${source.startDate || today()}">
          </label>
        </div>

        <div class="field">
          <span class="field-label">How often</span>
          <div class="segmented" role="radiogroup" aria-label="How often" style="flex-wrap:wrap">
            ${PRESETS.map(p => html`<label><input type="radio" name="preset" value="${p.id}" ${p.id === preset ? 'checked' : ''}>${p.label}</label>`)}
          </div>
          <div class="input-group ${preset === 'custom' ? '' : 'hidden'}" data-custom style="max-width:320px;margin-top:var(--space-2)">
            <span class="input-prefix">Every</span>
            <input class="input tabular" name="interval" type="number" min="1" max="1000" value="${frequency.interval}" style="max-width:90px;border-radius:0">
            <select class="select" name="frequencyType" style="border-top-left-radius:0;border-bottom-left-radius:0">
              ${['days', 'weeks', 'months', 'years'].map(t => html`<option value="${t}" ${t === frequency.type ? 'selected' : ''}>${t}</option>`)}
            </select>
          </div>
        </div>

        <div class="field">
          <span class="field-label">Ends</span>
          <div class="segmented" role="radiogroup" aria-label="Ends">
            <label><input type="radio" name="endType" value="never" ${end.type === 'never' ? 'checked' : ''}>Never</label>
            <label><input type="radio" name="endType" value="after_occurrences" ${end.type === 'after_occurrences' ? 'checked' : ''}>After a number of payments</label>
            <label><input type="radio" name="endType" value="on_date" ${end.type === 'on_date' ? 'checked' : ''}>On a date</label>
          </div>
          <div class="input-group ${end.type === 'after_occurrences' ? '' : 'hidden'}" data-end="after_occurrences" style="max-width:260px;margin-top:var(--space-2)">
            <input class="input tabular" name="endCount" type="number" min="1" max="10000" value="${end.type === 'after_occurrences' ? end.value : 12}">
            <span class="input-prefix" style="border-radius:0 var(--radius) var(--radius) 0">payments${editing ? ` (${item.occurrencesCompleted || 0} done)` : ''}</span>
          </div>
          <input class="input ${end.type === 'on_date' ? '' : 'hidden'}" data-end="on_date" type="date" name="endDate" value="${end.type === 'on_date' ? end.value : ''}" style="max-width:220px;margin-top:var(--space-2)">
        </div>

        ${editing ? html`
          <label class="field">
            <span class="field-label">Next payment due</span>
            <input class="input" type="date" name="nextDueDate" value="${item.nextDueDate}" style="max-width:220px">
            <span class="field-help">Move this if a payment came early or late. Changing the first payment or frequency recalculates it.</span>
          </label>` : ''}

        <label class="field">
          <span class="field-label">Description</span>
          <input class="input" name="description" maxlength="500" value="${source.description || ''}" placeholder="Optional">
        </label>

        <label class="field">
          <span class="field-label">Notes</span>
          <textarea class="textarea" name="notes" rows="2" maxlength="2000" placeholder="Optional. Copied onto each payment logged">${source.notes || ''}</textarea>
        </label>

        <label class="switch">
          <input type="checkbox" name="autoLog" ${source.autoLog ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span class="switch-text">Log automatically on the due date<small>Good for fixed direct debits and salary. Otherwise you approve each one from the account.</small></span>
        </label>
      </form>
    `,
    footer: html`
      ${editing ? html`<button type="button" class="btn btn-danger-ghost" data-delete>${icon('trash')}Delete</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
      <button type="submit" form="recurring-form" class="btn btn-primary">${editing ? 'Save' : 'Add'}</button>
    `
  });
  const form = $('#recurring-form', dialog.body);

  const currentMode = () => form.querySelector('[name="mode"]:checked').value;
  function syncMode() {
    const isTransfer = currentMode() === 'transfer';
    $('[data-mode-fields="transaction"]', form).classList.toggle('hidden', isTransfer);
    $('[data-mode-fields="transfer"]', form).classList.toggle('hidden', !isTransfer);
    form.payee.required = !isTransfer;
  }
  on(form, 'change', '[name="mode"]', syncMode);
  on(form, 'change', '[name="preset"]', () => {
    $('[data-custom]', form).classList.toggle('hidden', form.querySelector('[name="preset"]:checked').value !== 'custom');
  });
  on(form, 'change', '[name="endType"]', () => {
    const type = form.querySelector('[name="endType"]:checked').value;
    $$('[data-end]', form).forEach(el => el.classList.toggle('hidden', el.dataset.end !== type));
  });
  syncMode();

  on(dialog.footer, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({ title: 'Delete recurring payment', message: 'Stop this recurring payment?', detail: 'Transactions already logged are kept.' });
    if (!ok) return;
    const name = item.type === 'transfer' ? 'Recurring transfer' : item.payee || 'Recurring payment';
    try {
      await api.deleteRecurring(item.id);
      dialog.close(true);
      await changed();
      toast(`Deleted ${name}`, {
        kind: 'success',
        action: {
          label: 'Undo',
          run: async () => {
            await api.restoreRecurring(item.id);
            await changed();
            toast(`Restored ${name}`, { kind: 'success' });
          }
        }
      });
    } catch (err) {
      dialog.setError(err.message);
    }
  });

  bindForm(dialog, form, async (values) => {
    const amount = parseAmount(values.amount);
    if (!Number.isFinite(amount) || amount === 0) throw new Error('Enter an amount more than zero');
    const presetId = values.preset;
    const chosen = PRESETS.find(p => p.id === presetId);
    const freq = chosen?.frequency || { type: values.frequencyType, interval: Math.max(1, parseInt(values.interval, 10) || 1) };
    let endCondition = { type: 'never', value: null };
    if (values.endType === 'after_occurrences') endCondition = { type: 'after_occurrences', value: Math.max(1, parseInt(values.endCount, 10) || 1) };
    if (values.endType === 'on_date') {
      if (!values.endDate) throw new Error('Pick the date it ends');
      endCondition = { type: 'on_date', value: values.endDate };
    }
    const mode = values.mode;
    const body = { frequency: freq, startDate: values.startDate, endCondition, description: values.description, notes: values.notes, autoLog: values.autoLog };
    // A suggestion knows the day of the month it's really paid (the 31st, say), which its next
    // date alone can't show in a shorter month. Keep it while the schedule is the suggested one.
    if (!editing && prefill?.anchorDay && values.startDate === prefill.startDate
      && freq.type === prefill.frequency?.type && freq.interval === prefill.frequency?.interval) {
      body.anchorDay = prefill.anchorDay;
    }
    if (mode === 'transfer') {
      if (values.fromAccountId === values.toAccountId) throw new Error('Pick two different accounts');
      Object.assign(body, { type: 'transfer', fromAccountId: values.fromAccountId, toAccountId: values.toAccountId, amount: Math.abs(amount) });
    } else {
      Object.assign(body, { type: 'transaction', accountId: values.accountId, payee: values.payee, categoryId: values.categoryId, amount: mode === 'income' ? Math.abs(amount) : -Math.abs(amount) });
    }
    if (editing && values.nextDueDate && values.nextDueDate !== item.nextDueDate
      && values.startDate === item.startDate && JSON.stringify(freq) === JSON.stringify(item.frequency)) {
      body.nextDueDate = values.nextDueDate;
    }
    const saved = editing ? await api.updateRecurring(item.id, body) : await api.createRecurring(body);
    await refreshAfterSave();
    dialog.close(true);
    // Payments already due are logged straight away when "Log automatically" is on
    const logged = saved?.logged > 0 ? `Logged ${plural(saved.logged, 'payment')} that ${saved.logged === 1 ? 'was' : 'were'} due.` : '';
    if (!editing) toast(`Recurring payment added. ${logged}`.trim(), { kind: 'success' });
    else if (logged) toast(`Saved. ${logged}`, { kind: 'success' });
  });
  return dialog.closed;
}
