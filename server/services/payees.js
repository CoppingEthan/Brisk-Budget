import { conflict, notFound } from '../lib/errors.js';
import { requireObject, str } from '../lib/validate.js';
import { newId } from '../lib/ids.js';
import { UNCATEGORIZED_ID } from '../store/defaults.js';

export function createPayees(app) {
  const { store } = app;
  const payees = () => store.data.payees;
  const key = (name) => (name || '').trim().toLowerCase();

  function findByName(name) {
    return payees().find(p => key(p.name) === key(name)) || null;
  }

  function list() {
    const counts = new Map();
    for (const txs of Object.values(store.data.transactions)) {
      for (const tx of txs) if (!tx.transferId) counts.set(key(tx.payee), (counts.get(key(tx.payee)) || 0) + 1);
    }
    return [...payees()]
      .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }))
      .map(p => ({ ...p, usage: counts.get(key(p.name)) || 0 }));
  }

  // Add a payee to the autocomplete list if it isn't there yet. Returns true if added.
  function ensure(name, { save = true } = {}) {
    const clean = (name || '').trim().slice(0, 200);
    if (!clean || findByName(clean)) return false;
    payees().push({ id: newId(), name: clean });
    if (save) store.save('payees');
    return true;
  }

  // Add many names at once (imports): one pass over the list instead of one per row
  function ensureMany(names) {
    const known = new Set(payees().map(p => key(p.name)));
    let added = false;
    for (const name of names) {
      const clean = (name || '').trim().slice(0, 200);
      if (!clean || known.has(key(clean))) continue;
      known.add(key(clean));
      payees().push({ id: newId(), name: clean });
      added = true;
    }
    return added;
  }

  function create(body) {
    requireObject(body);
    const name = str(body.name, 'Payee name', { required: true, max: 200 });
    if (findByName(name)) throw conflict(`"${name}" is already in your payees`);
    const payee = { id: newId(), name };
    payees().push(payee);
    store.save('payees');
    return payee;
  }

  // Swap a payee name on every transaction and recurring payment that uses it
  function renameEverywhere(oldName, newName) {
    const touched = [];
    // Transfer sides keep the payee they had before linking, so it comes back on unlink
    for (const [accountId, txs] of Object.entries(store.data.transactions)) {
      let changed = false;
      for (const tx of txs) {
        if (tx.payee && key(tx.payee) === key(oldName)) {
          // Remember the name it had, so importing the same bank row again is still spotted
          if (tx.importPayee === undefined && tx.payee !== newName) tx.importPayee = tx.payee;
          tx.payee = newName;
          changed = true;
        }
      }
      if (changed) touched.push(accountId);
    }
    let recurringChanged = false;
    for (const r of store.data.recurring) {
      if (r.type !== 'transfer' && key(r.payee) === key(oldName)) { r.payee = newName; recurringChanged = true; }
    }
    // Keep dismissed suggestions dismissed under the new name ("accountId|payee")
    const oldKey = key(oldName).replace(/\s+/g, ' ');
    const newKey = key(newName).replace(/\s+/g, ' ');
    let dismissedChanged = false;
    store.data.dismissed = store.data.dismissed.map(signature => {
      const split = signature.indexOf('|');
      const accountId = signature.slice(0, split);
      const payee = signature.slice(split + 1);
      if (payee !== oldKey) return signature;
      dismissedChanged = true;
      return `${accountId}|${newKey}`;
    });
    if (touched.length) store.saveTransactions(...touched);
    if (recurringChanged) store.save('recurring');
    if (dismissedChanged) store.save('dismissed');
  }

  function rename(id, body) {
    requireObject(body);
    const payee = payees().find(p => p.id === id);
    if (!payee) throw notFound('Payee not found');
    const name = str(body.name, 'Payee name', { required: true, max: 200 });
    const existing = findByName(name);
    renameEverywhere(payee.name, existing && existing.id !== id ? existing.name : name);
    if (existing && existing.id !== id) {
      // Renaming onto another payee merges the two
      store.data.payees = payees().filter(p => p.id !== id);
      store.save('payees');
      return { ...existing, merged: true };
    }
    payee.name = name;
    store.save('payees');
    return payee;
  }

  function remove(id, body = {}) {
    const payee = payees().find(p => p.id === id);
    if (!payee) throw notFound('Payee not found');
    const replacement = str(body.replacementPayee ?? body.replacement, 'Replacement payee', { max: 200 });
    // "Replacing" a payee with itself in different capitals is really a rename
    if (replacement && key(replacement) === key(payee.name)) return rename(id, { name: replacement });
    if (replacement) {
      ensure(replacement, { save: false });
      renameEverywhere(payee.name, findByName(replacement)?.name || replacement);
    }
    store.data.payees = payees().filter(p => p.id !== id);
    store.save('payees');
    return { success: true };
  }

  // The category last used with this payee, to pre-fill new transactions
  function lastCategory(name) {
    let best = null;
    for (const txs of Object.values(store.data.transactions)) {
      for (const tx of txs) {
        if (tx.transferId || key(tx.payee) !== key(name) || tx.categoryId === UNCATEGORIZED_ID) continue;
        if (!best || tx.date > best.date || (tx.date === best.date && (tx.createdAt || '') > (best.createdAt || ''))) best = tx;
      }
    }
    return { categoryId: best ? best.categoryId : null };
  }

  return { list, ensure, ensureMany, create, rename, remove, lastCategory, findByName };
}
