// "Data check": finds things that can go wrong in the data (mostly left behind by bugs in
// earlier versions) and offers safe one-click fixes.
import { badRequest } from '../lib/errors.js';
import { requireObject } from '../lib/validate.js';
import { newId } from '../lib/ids.js';
import { toPence } from '../../public/js/shared/money.js';
import { TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../store/defaults.js';

export function createIntegrity(app) {
  const { store, clock } = app;
  const svc = () => app.services;
  const categoryExists = (id) => typeof id === 'string' && id !== TRANSFER_CATEGORY_ID && svc().categories.exists(id);
  // Two transactions that each came from a bank and were linked as a transfer can be a few days apart
  const sidesKeepOwnDates = (a, b) => a.linked === true || b.linked === true;

  function scan() {
    const issues = [];
    const accounts = new Map(store.data.accounts.map(a => [a.id, a]));
    const groups = new Set(store.data.groups.map(g => g.id));
    const name = (id) => accounts.get(id)?.name || 'an unknown account';

    for (const [accountId, txs] of Object.entries(store.data.transactions)) {
      if (!accounts.has(accountId)) {
        issues.push({ id: `orphan-file:${accountId}`, kind: 'orphan-file', fixable: true, accountId,
          message: `${txs.length} transaction${txs.length === 1 ? '' : 's'} belong to an account that no longer exists`,
          fix: 'Recover them into an archived account called "Recovered account"' });
        continue;
      }
      const seen = new Set();
      for (const tx of txs) {
        if (seen.has(tx.id)) {
          issues.push({ id: `duplicate-id:${accountId}:${tx.id}`, kind: 'duplicate-id', fixable: true, accountId, transactionId: tx.id,
            message: `Two transactions in ${name(accountId)} share the same id`, fix: 'Give one of them a new id' });
        }
        seen.add(tx.id);
        if (!svc().categories.exists(tx.categoryId)) {
          issues.push({ id: `category:${accountId}:${tx.id}`, kind: 'missing-category', fixable: true, accountId, transactionId: tx.id,
            message: `A transaction in ${name(accountId)} on ${tx.date} uses a category that no longer exists`, fix: 'Move it to Uncategorized' });
        }
        if (!tx.transferId) continue;
        const partner = (store.data.transactions[tx.transferAccountId] || []).find(t => t.id === tx.transferId);
        if (!partner) {
          issues.push({ id: `broken-transfer:${accountId}:${tx.id}`, kind: 'broken-transfer', fixable: true, accountId, transactionId: tx.id,
            message: `A transfer in ${name(accountId)} on ${tx.date} has lost its other side in ${name(tx.transferAccountId)}`,
            fix: 'Turn it back into a normal transaction' });
        } else if (tx.amount < 0 && (toPence(partner.amount) !== -toPence(tx.amount) || (partner.date !== tx.date && !sidesKeepOwnDates(tx, partner)))) {
          issues.push({ id: `mismatch:${accountId}:${tx.id}`, kind: 'transfer-mismatch', fixable: true, accountId, transactionId: tx.id,
            message: `A transfer from ${name(accountId)} to ${name(tx.transferAccountId)} doesn't match on both sides (${tx.date}: ${Math.abs(tx.amount).toFixed(2)} out vs ${partner.date}: ${Math.abs(partner.amount).toFixed(2)} in)`,
            fix: `Make the ${name(tx.transferAccountId)} side match ${name(accountId)}` });
        }
      }
    }

    for (const account of store.data.accounts) {
      if (account.groupId && !groups.has(account.groupId)) {
        issues.push({ id: `group:${account.id}`, kind: 'missing-group', fixable: true, accountId: account.id,
          message: `${account.name} is in a group that no longer exists`, fix: 'Take it out of the group' });
      }
    }

    for (const r of store.data.recurring) {
      if (r.active === false || r.paused) continue;
      const ids = r.type === 'transfer' ? [r.fromAccountId, r.toAccountId] : [r.accountId];
      const missing = ids.filter(id => !accounts.has(id) || accounts.get(id).active === false);
      if (missing.length) {
        issues.push({ id: `recurring:${r.id}`, kind: 'recurring-account', fixable: true, recurringId: r.id,
          message: `The recurring payment "${r.payee || 'transfer'}" uses an archived or deleted account`, fix: 'Pause it' });
      }
    }
    return { issues, checkedAt: clock.now().toISOString() };
  }

  function fixOne(issue, touched) {
    const txs = (id) => store.data.transactions[id] || [];
    switch (issue.kind) {
      case 'orphan-file': {
        store.data.accounts.push({
          id: issue.accountId, name: 'Recovered account', type: 'bank', startingBalance: 0, assetValue: null, interestRate: null,
          lastInterestAccrual: null, icon: null, groupId: null, sortOrder: 9999, active: false,
          archivedAt: clock.now().toISOString(), createdAt: clock.now().toISOString()
        });
        touched.accounts = true;
        break;
      }
      case 'duplicate-id': {
        const list = txs(issue.accountId);
        const dupes = list.filter(t => t.id === issue.transactionId);
        for (const tx of dupes.slice(1)) {
          tx.id = newId();
          if (tx.transferId) { tx.transferId = null; tx.transferAccountId = null; tx.categoryId = UNCATEGORIZED_ID; }
        }
        touched.tx.add(issue.accountId);
        break;
      }
      case 'missing-category': {
        const tx = txs(issue.accountId).find(t => t.id === issue.transactionId);
        if (tx) { tx.categoryId = tx.transferId ? TRANSFER_CATEGORY_ID : UNCATEGORIZED_ID; touched.tx.add(issue.accountId); }
        break;
      }
      case 'broken-transfer': {
        const tx = txs(issue.accountId).find(t => t.id === issue.transactionId);
        if (tx) {
          tx.payee = (tx.payee || '').replace(/^Transfer (to|from) /, '') || 'Transfer';
          tx.transferId = null;
          tx.transferAccountId = null;
          // Give back the category it had before it became a transfer, if that still exists
          tx.categoryId = categoryExists(tx.originalCategoryId) ? tx.originalCategoryId : UNCATEGORIZED_ID;
          delete tx.originalCategoryId;
          delete tx.linked;
          delete tx.generated;
          touched.tx.add(issue.accountId);
        }
        break;
      }
      case 'transfer-mismatch': {
        const tx = txs(issue.accountId).find(t => t.id === issue.transactionId);
        const partner = tx && txs(tx.transferAccountId).find(t => t.id === tx.transferId);
        if (tx && partner) {
          partner.amount = -tx.amount;
          // Two real bank rows keep the dates the banks gave them
          if (!sidesKeepOwnDates(tx, partner)) partner.date = tx.date;
          touched.tx.add(tx.transferAccountId);
        }
        break;
      }
      case 'missing-group': {
        const account = store.data.accounts.find(a => a.id === issue.accountId);
        if (account) { account.groupId = null; touched.accounts = true; }
        break;
      }
      case 'recurring-account': {
        const r = store.data.recurring.find(x => x.id === issue.recurringId);
        if (r) { r.paused = true; touched.recurring = true; }
        break;
      }
    }
  }

  function fix(body) {
    requireObject(body);
    const { issues } = scan();
    const wanted = body.all === true ? issues : issues.filter(i => Array.isArray(body.ids) && body.ids.includes(i.id));
    if (!wanted.length && body.all !== true) throw badRequest('Nothing to fix');
    const touched = { tx: new Set(), accounts: false, recurring: false };
    for (const issue of wanted.filter(i => i.fixable)) fixOne(issue, touched);
    if (touched.accounts) store.save('accounts');
    if (touched.recurring) store.save('recurring');
    if (touched.tx.size) store.saveTransactions(...touched.tx);
    return { fixed: wanted.length, ...scan() };
  }

  return { scan, fix };
}
