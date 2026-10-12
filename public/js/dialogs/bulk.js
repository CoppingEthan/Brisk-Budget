import { html, $, render, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, activeAccounts, changed, UNCATEGORIZED } from '../core/state.js';
import { money, date as formatDate, plural } from '../core/format.js';
import { openDialog } from '../ui/dialog.js';
import { bindForm, categoryOptions } from '../ui/forms.js';
import { toast } from '../ui/toast.js';

export function openCategorizeDialog(accountId, ids) {
  const dialog = openDialog({
    title: `Categorise ${plural(ids.length, 'transaction')}`,
    size: 'sm',
    body: html`
      <form class="form-stack" id="cat-form">
        <label class="field">
          <span class="field-label">Category</span>
          <select class="select" name="categoryId" autofocus>${categoryOptions(state.categories, UNCATEGORIZED)}</select>
        </label>
        <p class="field-help">Transfers in the selection are left as they are.</p>
      </form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="cat-form" class="btn btn-primary">Apply</button>`
  });
  bindForm(dialog, $('#cat-form', dialog.body), async (values) => {
    const result = await api.bulk(accountId, { action: 'categorize', ids, categoryId: values.categoryId });
    dialog.close(true);
    toast(`Updated ${plural(result.updated, 'transaction')}`, { kind: 'success' });
  });
  return dialog.closed.then(r => r === true);
}

export function openConvertDialog(accountId, transactions) {
  const others = activeAccounts().filter(a => a.id !== accountId);
  if (!others.length) {
    toast('You need another account to make a transfer', { kind: 'warning' });
    return Promise.resolve(false);
  }
  const single = transactions.length === 1 ? transactions[0] : null;
  const allIn = transactions.every(t => t.amount > 0);
  const allOut = transactions.every(t => t.amount < 0);
  const dialog = openDialog({
    title: 'Make into a transfer',
    body: html`
      <form class="form-stack" id="convert-form">
        <p class="muted">${single
          ? html`Link <strong>${single.payee}</strong> (${money(single.amount)} on ${formatDate(single.date)}) to another account.`
          : html`Link ${plural(transactions.length, 'transaction')} to another account. A matching transaction is created on the other side of each.`}</p>
        <label class="field">
          <span class="field-label">${allIn ? 'Money came from' : allOut ? 'Money went to' : 'Other account'}</span>
          <select class="select" name="targetAccountId" autofocus>${others.map(a => html`<option value="${a.id}">${a.name}</option>`)}</select>
        </label>
        <div data-candidates></div>
      </form>`,
    footer: html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button><button type="submit" form="convert-form" class="btn btn-primary">Make transfer</button>`
  });
  const form = $('#convert-form', dialog.body);
  const box = $('[data-candidates]', form);

  // Changing the account quickly can bring answers back out of order: only the latest counts
  let latest = 0;
  async function loadCandidates() {
    if (!single) return;
    const mine = ++latest;
    render(box, html`<div class="skeleton" style="height:48px"></div>`);
    try {
      const candidates = await api.transferCandidates(accountId, single.id, form.targetAccountId.value);
      if (mine !== latest) return;
      render(box, candidates.length ? html`
        <div class="alert info">${icon('link')}<span>This looks like it's already recorded in the other account. Link to it instead of creating a duplicate?</span></div>
        <div class="list" style="margin-top:var(--space-2)">
          ${candidates.map((c, i) => html`
            <label class="list-row check">
              <input type="radio" name="link" value="${c.id}" ${i === 0 ? 'checked' : ''}>
              <span class="list-row-main"><span class="list-row-title">${c.payee}</span><span class="list-row-meta">${formatDate(c.date)} · ${c.category}</span></span>
              <span class="tabular">${money(c.amount)}</span>
            </label>`)}
          <label class="list-row check">
            <input type="radio" name="link" value="">
            <span class="list-row-main"><span class="list-row-title">Create a new matching transaction</span></span>
          </label>
        </div>` : '');
    } catch {
      if (mine === latest) render(box, '');
    }
  }
  on(form, 'change', '[name="targetAccountId"]', loadCandidates);
  loadCandidates();

  bindForm(dialog, form, async (values) => {
    const targetAccountId = values.targetAccountId;
    const linkTransactionId = values.link || undefined;
    const result = single
      ? await api.convertToTransfer(accountId, single.id, { targetAccountId, linkTransactionId })
      : await api.bulk(accountId, { action: 'convertToTransfer', ids: transactions.map(t => t.id), targetAccountId });
    dialog.close(true);
    const made = single ? 1 : result.done ?? transactions.length;
    toast(single ? 'Made into a transfer' : `Made ${plural(made, 'transfer')}`, {
      kind: 'success',
      action: result?.undo?.length ? { label: 'Undo', run: () => undoChanges(result.undo) } : null
    });
  });
  return dialog.closed.then(r => r === true);
}

// Put transactions back exactly as they were, from a server `undo` list
export async function undoChanges(items) {
  await api.restoreTransactions(items);
  await changed();
  toast('Restored', { kind: 'success' });
}
