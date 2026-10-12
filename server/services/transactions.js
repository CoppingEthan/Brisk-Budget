import { badRequest, conflict, notFound } from '../lib/errors.js';
import { has, requireObject, str, money, date as dateField, num, id as idField, idList, bool, oneOf } from '../lib/validate.js';
import { newId, isSafeId } from '../lib/ids.js';
import { toPence, fromPence, round2 } from '../../public/js/shared/money.js';
import { diffDays, isISODate } from '../../public/js/shared/dates.js';
import { cleanPayee, unguard } from '../../public/js/shared/csv.js';
import { TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../store/defaults.js';

export const ledgerOrder = (a, b) =>
  a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id);

const normalisePayee = (name) => (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Import tidies bank payees (Excel's leading apostrophe, Barclays' date suffix), so rows saved
// before that are compared tidied too
const duplicateKey = (name) => normalisePayee(cleanPayee(unguard(name)));

export function createTransactions(app) {
  const { store, clock } = app;
  const svc = () => app.services;
  const nowIso = () => clock.now().toISOString();

  function listFor(accountId) {
    if (!store.data.transactions[accountId]) store.data.transactions[accountId] = [];
    return store.data.transactions[accountId];
  }

  function transferPayee(tx) {
    const other = store.data.accounts.find(a => a.id === tx.transferAccountId);
    const name = other ? other.name : 'a deleted account';
    return tx.amount < 0 ? `Transfer to ${name}` : `Transfer from ${name}`;
  }

  function serialize(tx, accountId) {
    const cat = svc().categories.info(tx.categoryId);
    return {
      ...tx,
      accountId,
      payee: tx.transferId ? transferPayee(tx) : tx.payee,
      category: cat.name,
      categoryParent: cat.isSub ? cat.parentName : null,
      categoryEmoji: cat.emoji,
      categoryColor: cat.color
    };
  }

  function find(accountId, txId) {
    svc().accounts.get(accountId);
    const tx = listFor(accountId).find(t => t.id === txId);
    if (!tx) throw notFound('Transaction not found');
    return tx;
  }

  // ----- Reading -----

  function listAll(accountId) {
    svc().accounts.get(accountId);
    return [...listFor(accountId)].sort(ledgerOrder).reverse().map(tx => serialize(tx, accountId));
  }

  // One page of an account's transactions, newest first, each with the account balance just
  // after it. Filters: q (search), categoryId, from, to, direction (in/out), min, max.
  function ledger(accountId, params) {
    const account = svc().accounts.get(accountId);
    const sorted = [...listFor(accountId)].sort(ledgerOrder);
    let running = toPence(account.startingBalance);
    const rows = sorted.map(tx => {
      running += toPence(tx.amount);
      return { tx, balance: fromPence(running) };
    });

    const q = (params.get('q') || '').trim().toLowerCase();
    // Amounts typed the way the app shows them ("£1,100.00", "-48.34") still find the transaction
    const digits = q.replace(/[£,\s+−-]/g, '');
    const qAmount = /^(\d+\.?\d*|\.\d+)$/.test(digits) ? digits : null;
    const categoryId = params.get('categoryId');
    const from = params.get('from');
    const to = params.get('to');
    const direction = params.get('direction');
    const min = params.get('min') ? Math.abs(Number(params.get('min'))) : null;
    const max = params.get('max') ? Math.abs(Number(params.get('max'))) : null;
    const categoryIds = categoryId ? new Set([categoryId, ...childIds(categoryId)]) : null;

    const filtered = rows.filter(({ tx }) => {
      if (from && isISODate(from) && tx.date < from) return false;
      if (to && isISODate(to) && tx.date > to) return false;
      if (direction === 'in' && tx.amount <= 0) return false;
      if (direction === 'out' && tx.amount >= 0) return false;
      if (min !== null && Number.isFinite(min) && Math.abs(tx.amount) < min) return false;
      if (max !== null && Number.isFinite(max) && Math.abs(tx.amount) > max) return false;
      if (categoryIds && !categoryIds.has(tx.categoryId)) return false;
      if (q) {
        const cat = svc().categories.info(tx.categoryId);
        const amount = Math.abs(tx.amount).toFixed(2);
        const haystack = [
          tx.transferId ? transferPayee(tx) : tx.payee, tx.description, tx.notes, cat.name, cat.parentName, amount
        ].join('\n').toLowerCase();
        if (!haystack.includes(q) && !(qAmount && amount.includes(qAmount))) return false;
      }
      return true;
    }).reverse();

    let inPence = 0;
    let outPence = 0;
    for (const { tx } of filtered) {
      if (tx.amount > 0) inPence += toPence(tx.amount);
      else outPence += toPence(tx.amount);
    }
    const offset = Math.max(0, Math.floor(Number(params.get('offset')) || 0));
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(params.get('limit')) || 100)));
    return {
      items: filtered.slice(offset, offset + limit).map(({ tx, balance }) => ({ ...serialize(tx, accountId), runningBalance: balance })),
      total: filtered.length,
      offset,
      limit,
      balance: svc().accounts.balance(account),
      totals: { in: fromPence(inPence), out: fromPence(outPence) }
    };
  }

  function childIds(categoryId) {
    const category = store.data.categories.find(c => c.id === categoryId);
    return category ? (category.subcategories || []).map(s => s.id) : [];
  }

  // ----- Writing -----

  function readFields(body, tx, { partial }) {
    if (!partial || has(body, 'date')) tx.date = dateField(body.date, 'Date', { required: true });
    if (!partial || has(body, 'amount')) {
      const before = tx.amount;
      tx.amount = money(body.amount, 'Amount', { required: true });
      // Older versions allowed £0, so one already saved can still be edited
      if (tx.amount === 0 && !(partial && before === 0)) throw badRequest("Enter an amount (it can't be zero)");
    }
    if (!partial || has(body, 'payee')) tx.payee = str(body.payee, 'Payee', { required: true, max: 200 });
    if (has(body, 'categoryId') || has(body, 'category')) tx.categoryId = svc().categories.pick(body) || UNCATEGORIZED_ID;
    if (!partial || has(body, 'description')) tx.description = str(body.description, 'Description', { max: 500 });
    if (!partial || has(body, 'notes')) tx.notes = str(body.notes, 'Notes', { max: 2000 });
  }

  function newTransaction(fields) {
    return {
      id: newId(),
      date: clock.today(),
      amount: 0,
      payee: '',
      categoryId: UNCATEGORIZED_ID,
      description: '',
      notes: '',
      createdAt: nowIso(),
      transferId: null,
      transferAccountId: null,
      ...fields
    };
  }

  function create(accountId, body) {
    requireObject(body);
    svc().accounts.getActive(accountId);
    const tx = newTransaction({});
    readFields(body, tx, { partial: false });
    listFor(accountId).push(tx);
    const addedPayee = svc().payees.ensure(tx.payee, { save: false });
    store.saveTransactions(accountId);
    if (addedPayee) store.save('payees');
    return serialize(tx, accountId);
  }

  function update(accountId, txId, body) {
    requireObject(body);
    const tx = find(accountId, txId);
    if (tx.transferId) return updateTransfer(accountId, tx, body);
    // Validate on a copy so a rejected edit changes nothing
    const draft = { ...tx };
    readFields(body, draft, { partial: true });
    // Remember the name it had, so importing the same bank row again is still spotted
    if (draft.payee !== tx.payee && tx.payee && draft.importPayee === undefined) draft.importPayee = tx.payee;
    Object.assign(tx, draft, { updatedAt: nowIso() });
    const addedPayee = svc().payees.ensure(tx.payee, { save: false });
    store.saveTransactions(accountId);
    if (addedPayee) store.save('payees');
    return serialize(tx, accountId);
  }

  // ----- Transfer sides -----
  // A transfer has two sides. A side Brisk Budget made up is marked `generated`. A side that
  // started life as a real transaction (from the bank, or typed in) remembers the category it
  // had in `originalCategoryId`. Two real transactions linked together are both `linked`.
  // Real transactions are never deleted as a side effect of something else.

  const snapshot = (accountId, tx) => ({ accountId, transaction: { ...tx } });
  const isReal = (leg) => leg.linked === true || (leg.originalCategoryId !== undefined && leg.originalCategoryId !== null);

  function restoreLeg(leg) {
    const stored = (leg.payee || '').replace(/^Transfer (to|from) /, '').trim();
    leg.payee = stored || 'Transfer';
    leg.categoryId = svc().categories.exists(leg.originalCategoryId) && leg.originalCategoryId !== TRANSFER_CATEGORY_ID
      ? leg.originalCategoryId
      : UNCATEGORIZED_ID;
    leg.transferId = null;
    leg.transferAccountId = null;
    leg.updatedAt = nowIso();
    delete leg.linked;
    delete leg.generated;
    delete leg.originalCategoryId;
  }

  function partnerOf(tx) {
    const list = store.data.transactions[tx.transferAccountId];
    return list ? list.find(t => t.id === tx.transferId) || null : null;
  }

  function removeFrom(accountId, txId) {
    store.data.transactions[accountId] = listFor(accountId).filter(t => t.id !== txId);
  }

  // Take transactions out. Returns what was removed and an `undo` list that puts everything
  // back exactly as it was (including the other side of a transfer).
  function takeOut(accountId, ids, { touched = new Set(), save = true } = {}) {
    const wanted = new Set(ids);
    const removed = [];
    const undo = [];
    for (const tx of listFor(accountId).filter(t => wanted.has(t.id))) {
      removed.push(snapshot(accountId, tx));
      undo.push(snapshot(accountId, tx));
      touched.add(accountId);
      const partner = tx.transferId ? partnerOf(tx) : null;
      if (!partner || (tx.transferAccountId === accountId && wanted.has(partner.id))) continue;
      undo.push(snapshot(tx.transferAccountId, partner));
      touched.add(tx.transferAccountId);
      if (isReal(partner) && !(isReal(tx) && !partner.linked)) {
        // The other side is a real transaction of its own: keep it, as a normal transaction
        restoreLeg(partner);
      } else {
        removed.push(snapshot(tx.transferAccountId, partner));
        removeFrom(tx.transferAccountId, partner.id);
      }
    }
    store.data.transactions[accountId] = listFor(accountId).filter(t => !wanted.has(t.id));
    if (save && touched.size) store.saveTransactions(...touched);
    return { removed, undo };
  }

  function remove(accountId, txId) {
    find(accountId, txId);
    return { success: true, ...takeOut(accountId, [txId]) };
  }

  function cleanSnapshot(item, i) {
    const label = `Item ${i + 1}`;
    const accountId = idField(item?.accountId, `${label} account`, { required: true });
    if (!store.data.accounts.some(a => a.id === accountId)) throw badRequest('That account no longer exists');
    const t = item.transaction;
    if (!t || typeof t !== 'object') throw badRequest(`${label} is missing its transaction`);
    const tx = {
      id: idField(t.id, `${label} id`, { required: true }),
      date: dateField(t.date, `${label} date`, { required: true }),
      amount: money(t.amount, `${label} amount`, { required: true }),
      payee: str(t.payee, `${label} payee`, { max: 200 }),
      categoryId: svc().categories.exists(t.categoryId) ? t.categoryId : UNCATEGORIZED_ID,
      description: str(t.description, `${label} description`, { max: 500 }),
      notes: str(t.notes, `${label} notes`, { max: 2000 }),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt.slice(0, 40) : nowIso(),
      transferId: isSafeId(t.transferId) ? t.transferId : null,
      transferAccountId: isSafeId(t.transferAccountId) ? t.transferAccountId : null
    };
    for (const flag of ['autoInterest', 'linked', 'generated']) if (t[flag] === true) tx[flag] = true;
    for (const field of ['recurringId', 'importBatch', 'originalCategoryId']) if (isSafeId(t[field])) tx[field] = t[field];
    if (typeof t.importPayee === 'string') tx.importPayee = t.importPayee.slice(0, 200);
    if (typeof t.updatedAt === 'string') tx.updatedAt = t.updatedAt.slice(0, 40);
    return { accountId, tx };
  }

  // Put back transactions returned by a delete or unlink (Undo). Everything is checked before
  // anything changes; a record that already exists is replaced by its earlier version.
  function restore(body) {
    const items = requireObject(body).items;
    if (!Array.isArray(items) || items.length > 20000) throw badRequest('items must be a list');
    // Most items are earlier versions of transactions; `remove` items take away one made since
    const removals = [];
    const prepared = [];
    items.forEach((item, i) => {
      if (item?.remove === true) {
        const accountId = idField(item.accountId, `Item ${i + 1} account`, { required: true });
        removals.push({ accountId, id: idField(item.transactionId, `Item ${i + 1} id`, { required: true }) });
      } else {
        prepared.push(cleanSnapshot(item, i));
      }
    });
    const removing = new Set(removals.map(r => `${r.accountId}|${r.id}`));
    const inBatch = new Set(prepared.map(p => `${p.accountId}|${p.tx.id}`));
    for (const { tx } of prepared) {
      if (!tx.transferId) continue;
      const key = `${tx.transferAccountId}|${tx.transferId}`;
      const partnerThere = inBatch.has(key)
        || (!removing.has(key) && (store.data.transactions[tx.transferAccountId] || []).some(t => t.id === tx.transferId));
      if (!partnerThere) {
        tx.transferId = null;
        tx.transferAccountId = null;
        if (tx.categoryId === TRANSFER_CATEGORY_ID) tx.categoryId = UNCATEGORIZED_ID;
      }
    }
    const touched = new Set();
    for (const { accountId, id } of removals) {
      const list = store.data.transactions[accountId];
      const index = list ? list.findIndex(x => x.id === id) : -1;
      if (index < 0 || inBatch.has(`${accountId}|${id}`)) continue;
      list.splice(index, 1);
      touched.add(accountId);
    }
    for (const { accountId, tx } of prepared) {
      const list = listFor(accountId);
      const index = list.findIndex(x => x.id === tx.id);
      if (index >= 0) list[index] = tx;
      else list.push(tx);
      touched.add(accountId);
    }
    if (touched.size) store.saveTransactions(...touched);
    return { success: true, restored: prepared.length + removals.length };
  }

  // ----- Transfers -----

  function makeLegs({ fromAccountId, toAccountId, amount, date, description, notes, extra = {} }) {
    const outId = newId();
    const inId = newId();
    const created = nowIso();
    const value = Math.abs(amount);
    const base = { date, description: description || '', notes: notes || '', categoryId: TRANSFER_CATEGORY_ID, createdAt: created, payee: '', generated: true, ...extra };
    return {
      out: { id: outId, ...base, amount: -value, transferId: inId, transferAccountId: toAccountId },
      in: { id: inId, ...base, amount: value, transferId: outId, transferAccountId: fromAccountId }
    };
  }

  function readTransferAccounts(fromAccountId, toAccountId) {
    if (!fromAccountId || !toAccountId) throw badRequest('Choose both accounts');
    if (fromAccountId === toAccountId) throw badRequest("You can't transfer to the same account");
    svc().accounts.getActive(fromAccountId);
    svc().accounts.getActive(toAccountId);
  }

  function createTransfer(body, extra = {}) {
    requireObject(body);
    const fromAccountId = idField(body.fromAccountId, 'From account', { required: true });
    const toAccountId = idField(body.toAccountId, 'To account', { required: true });
    readTransferAccounts(fromAccountId, toAccountId);
    const amount = money(body.amount, 'Amount', { required: true });
    if (!amount) throw badRequest('Amount must be more than zero');
    const legs = makeLegs({
      fromAccountId,
      toAccountId,
      amount,
      date: dateField(body.date, 'Date', { required: true }),
      description: str(body.description, 'Description', { max: 500 }),
      notes: str(body.notes, 'Notes', { max: 2000 }),
      extra
    });
    listFor(fromAccountId).push(legs.out);
    listFor(toAccountId).push(legs.in);
    store.saveTransactions(fromAccountId, toAccountId);
    return { from: serialize(legs.out, fromAccountId), to: serialize(legs.in, toAccountId) };
  }

  // Editing either side of a transfer updates both sides. The amount always mirrors. For two
  // linked real transactions each keeps its own date and text, because they're separate bank
  // records; otherwise both sides share them. Each account keeps its own side (same id).
  function updateTransfer(accountId, leg, body) {
    const partner = partnerOf(leg);
    if (!partner) {
      // The other side is missing (an old bug could cause this): edit this side alone
      if ((has(body, 'fromAccountId') || has(body, 'toAccountId'))) {
        const current = leg.amount < 0 ? accountId : null;
        if (body.fromAccountId !== (current || body.fromAccountId) || (has(body, 'toAccountId') && body.toAccountId !== leg.transferAccountId && leg.amount < 0) || (has(body, 'fromAccountId') && leg.amount > 0 && body.fromAccountId !== leg.transferAccountId)) {
          throw conflict('The other side of this transfer is missing, so it can\'t be moved. Fix it in Settings › Data check first.');
        }
      }
      const draft = { ...leg };
      if (has(body, 'date')) draft.date = dateField(body.date, 'Date', { required: true });
      if (has(body, 'amount')) {
        const value = Math.abs(money(body.amount, 'Amount', { required: true }));
        if (!value) throw badRequest('Amount must be more than zero');
        draft.amount = Math.sign(leg.amount || -1) * value;
      }
      if (has(body, 'description')) draft.description = str(body.description, 'Description', { max: 500 });
      if (has(body, 'notes')) draft.notes = str(body.notes, 'Notes', { max: 2000 });
      Object.assign(leg, draft, { updatedAt: nowIso() });
      store.saveTransactions(accountId);
      return serialize(leg, accountId);
    }
    const outgoing = leg.amount < 0 ? { tx: leg, accountId } : { tx: partner, accountId: leg.transferAccountId };
    const incoming = leg.amount < 0 ? { tx: partner, accountId: leg.transferAccountId } : { tx: leg, accountId };

    const fromAccountId = has(body, 'fromAccountId') ? idField(body.fromAccountId, 'From account', { required: true }) : outgoing.accountId;
    const toAccountId = has(body, 'toAccountId') ? idField(body.toAccountId, 'To account', { required: true }) : incoming.accountId;
    if (fromAccountId !== outgoing.accountId || toAccountId !== incoming.accountId) readTransferAccounts(fromAccountId, toAccountId);
    const amount = has(body, 'amount') ? Math.abs(money(body.amount, 'Amount', { required: true })) : Math.abs(outgoing.tx.amount);
    if (!amount) throw badRequest('Amount must be more than zero');
    const date = has(body, 'date') ? dateField(body.date, 'Date', { required: true }) : leg.date;
    const description = has(body, 'description') ? str(body.description, 'Description', { max: 500 }) : leg.description;
    const notes = has(body, 'notes') ? str(body.notes, 'Notes', { max: 2000 }) : leg.notes;

    const old = [outgoing, incoming];
    const sideIn = (id) => old.find(o => o.accountId === id)?.tx || null;
    let oldOut = sideIn(fromAccountId);
    let oldIn = sideIn(toAccountId);
    // A side Brisk Budget made can move to the new account and keep its id; a real transaction
    // stays in its own account
    const spare = old.map(o => o.tx).filter(t => t !== oldOut && t !== oldIn && !isReal(t));
    const moved = (t) => {
      const copy = { ...t };
      delete copy.importBatch;
      delete copy.importPayee;
      return copy;
    };
    if (!oldOut && spare.length) oldOut = moved(spare.shift());
    if (!oldIn && spare.length) oldIn = moved(spare.shift());
    const fresh = () => ({ id: newId(), createdAt: nowIso(), payee: '', generated: true, description, notes, date });
    const outLeg = { ...(oldOut || fresh()) };
    const inLeg = { ...(oldIn || fresh()) };
    const now = nowIso();
    Object.assign(outLeg, { amount: -amount, transferId: inLeg.id, transferAccountId: toAccountId, categoryId: TRANSFER_CATEGORY_ID, updatedAt: now });
    Object.assign(inLeg, { amount, transferId: outLeg.id, transferAccountId: fromAccountId, categoryId: TRANSFER_CATEGORY_ID, updatedAt: now });

    const bothReal = isReal(outLeg) && isReal(inLeg);
    const edited = [outLeg, inLeg].find(l => l.id === leg.id) || outLeg;
    for (const l of [outLeg, inLeg]) {
      if (bothReal && l !== edited) continue; // a linked bank record keeps its own date and text
      l.date = date;
      l.description = description;
      l.notes = notes;
    }
    for (const l of [outLeg, inLeg]) {
      if (bothReal) l.linked = true;
      else delete l.linked;
    }

    for (const o of old) removeFrom(o.accountId, o.tx.id);
    listFor(fromAccountId).push(outLeg);
    listFor(toAccountId).push(inLeg);
    // A real transaction left behind by moving the transfer to another account stays, unlinked
    for (const o of old) {
      if (o.tx.id === oldOut?.id || o.tx.id === oldIn?.id || !isReal(o.tx)) continue;
      const kept = { ...o.tx };
      restoreLeg(kept);
      listFor(o.accountId).push(kept);
    }
    store.saveTransactions(outgoing.accountId, incoming.accountId, fromAccountId, toAccountId);

    if (fromAccountId === accountId) return serialize(outLeg, fromAccountId);
    if (toAccountId === accountId) return serialize(inLeg, toAccountId);
    return serialize(outLeg, fromAccountId);
  }

  // Transactions in the target account that look like the other side of `txId`
  function transferCandidates(accountId, txId, targetAccountId) {
    const tx = find(accountId, txId);
    svc().accounts.get(idField(targetAccountId, 'Account', { required: true }));
    const wanted = -toPence(tx.amount);
    return listFor(targetAccountId)
      .filter(t => !t.transferId && toPence(t.amount) === wanted && Math.abs(diffDays(tx.date, t.date)) <= 4)
      .sort((a, b) => Math.abs(diffDays(tx.date, a.date)) - Math.abs(diffDays(tx.date, b.date)))
      .slice(0, 10)
      .map(t => serialize(t, targetAccountId));
  }

  function convertToTransfer(accountId, txId, body, { touched = null } = {}) {
    requireObject(body);
    const tx = find(accountId, txId);
    if (tx.transferId) throw conflict('That is already a transfer');
    if (!tx.amount) throw conflict("A transaction of zero can't be a transfer");
    const targetAccountId = idField(body.targetAccountId, 'Account to link to', { required: true });
    readTransferAccounts(accountId, targetAccountId);
    const linkId = idField(body.linkTransactionId, 'linkTransactionId');
    // Undo puts both sides back as they were, and removes a side made up here
    const undo = [snapshot(accountId, tx)];
    let partner;
    if (linkId) {
      partner = listFor(targetAccountId).find(t => t.id === linkId);
      if (!partner) throw notFound('The matching transaction no longer exists');
      if (partner.transferId) throw conflict('The matching transaction is already part of a transfer');
      if (toPence(partner.amount) !== -toPence(tx.amount)) throw badRequest('The matching transaction must be for the same amount in the other direction');
      undo.push(snapshot(targetAccountId, partner));
      partner.originalCategoryId = partner.categoryId;
      partner.transferId = tx.id;
      partner.transferAccountId = accountId;
      partner.categoryId = TRANSFER_CATEGORY_ID;
      partner.linked = true;
      tx.linked = true;
    } else {
      partner = newTransaction({
        date: tx.date,
        amount: round2(-tx.amount),
        description: tx.description,
        notes: tx.notes,
        categoryId: TRANSFER_CATEGORY_ID,
        transferId: tx.id,
        transferAccountId: accountId,
        generated: true
      });
      listFor(targetAccountId).push(partner);
      undo.push({ accountId: targetAccountId, transactionId: partner.id, remove: true });
    }
    tx.originalCategoryId = tx.categoryId;
    tx.transferId = partner.id;
    tx.transferAccountId = targetAccountId;
    tx.categoryId = TRANSFER_CATEGORY_ID;
    tx.updatedAt = nowIso();
    if (touched) touched.add(accountId).add(targetAccountId);
    else store.saveTransactions(accountId, targetAccountId);
    return { success: true, transaction: serialize(tx, accountId), linkedTransaction: serialize(partner, targetAccountId), undo };
  }

  // Turn a transfer back into normal transactions. A side Brisk Budget made up is removed;
  // real transactions are always kept, with the category they had before.
  function unlinkTransfer(accountId, txId, { touched = null } = {}) {
    const tx = find(accountId, txId);
    if (!tx.transferId) throw conflict('That is not a transfer');
    const partner = partnerOf(tx);
    const partnerAccountId = tx.transferAccountId;
    const undo = [snapshot(accountId, tx)];
    const removed = [];
    let kept = tx;
    let keptAccount = accountId;
    if (!partner) {
      restoreLeg(tx);
    } else {
      undo.push(snapshot(partnerAccountId, partner));
      const realTx = isReal(tx);
      const realPartner = isReal(partner);
      if (realTx && realPartner) {
        restoreLeg(tx);
        restoreLeg(partner);
      } else if (realPartner && !realTx) {
        removed.push(snapshot(accountId, tx));
        removeFrom(accountId, tx.id);
        restoreLeg(partner);
        kept = partner;
        keptAccount = partnerAccountId;
      } else {
        removed.push(snapshot(partnerAccountId, partner));
        removeFrom(partnerAccountId, partner.id);
        restoreLeg(tx);
      }
    }
    if (touched) touched.add(accountId).add(partnerAccountId);
    else store.saveTransactions(accountId, partnerAccountId);
    return { success: true, transaction: serialize(kept, keptAccount), removed, undo };
  }

  // ----- Bulk actions -----

  function bulk(accountId, body) {
    requireObject(body);
    svc().accounts.get(accountId);
    const action = oneOf(body.action, 'action', ['delete', 'categorize', 'convertToTransfer', 'unlinkTransfer'], { required: true });
    // An import can be undone as a whole by its batch id
    const ids = body.importBatch
      ? listFor(accountId).filter(t => t.importBatch === idField(body.importBatch, 'importBatch')).map(t => t.id)
      : idList(body.ids, 'ids');
    const present = new Set(listFor(accountId).map(t => t.id));
    const targets = ids.filter(i => present.has(i));
    if (action === 'delete') return { success: true, ...takeOut(accountId, targets) };
    if (action === 'categorize') {
      const categoryId = svc().categories.pick(body) || UNCATEGORIZED_ID;
      let updated = 0;
      const wanted = new Set(targets);
      for (const tx of listFor(accountId)) {
        if (wanted.has(tx.id) && !tx.transferId) { tx.categoryId = categoryId; tx.updatedAt = nowIso(); updated++; }
      }
      store.saveTransactions(accountId);
      return { success: true, updated };
    }
    if (action === 'convertToTransfer') {
      // Check the target once, so a bad account is a clear error rather than a pile of skips
      readTransferAccounts(accountId, idField(body.targetAccountId, 'Account to link to', { required: true }));
    }
    const touched = new Set();
    const results = { success: true, done: 0, skipped: 0, removed: [], undo: [] };
    try {
      for (const txId of targets) {
        try {
          if (action === 'convertToTransfer') {
            const result = convertToTransfer(accountId, txId, { targetAccountId: body.targetAccountId }, { touched });
            results.undo.push(...result.undo);
          } else {
            const result = unlinkTransfer(accountId, txId, { touched });
            results.removed.push(...result.removed);
            results.undo.push(...result.undo);
          }
          results.done++;
        } catch (err) {
          if (err.status === 409) results.skipped++;
          else throw err;
        }
      }
    } finally {
      if (touched.size) store.saveTransactions(...touched);
    }
    return results;
  }

  // ----- Import -----

  function cleanImportRows(rows) {
    if (!Array.isArray(rows)) throw badRequest('rows must be a list');
    if (rows.length > 20000) throw badRequest('That file has too many rows (the limit is 20,000)');
    // Bank files can have very long descriptions: shorten them rather than refuse the file
    const cut = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : value);
    return rows.map((row, i) => {
      const where = Number.isInteger(row?.line) && row.line > 0 ? `Line ${row.line} of the file:` : `Row ${i + 1}`;
      return {
        date: dateField(row?.date, `${where} date`, { required: true }),
        amount: money(row?.amount, `${where} amount`, { required: true }),
        payee: str(cut(row?.payee, 200), `${where} payee`, { max: 200 }) || 'Unknown',
        category: str(cut(row?.category, 100), `${where} category`, { max: 100 }),
        description: str(cut(row?.description, 500), `${where} description`, { max: 500 }),
        notes: str(cut(row?.notes, 2000), `${where} notes`, { max: 2000 })
      };
    });
  }

  // Mark rows that are already in the account. Counts matter: two identical coffees in the file
  // against one already saved means one is new. Imported rows are matched on the payee text the
  // bank used (kept even after the payee is renamed). Exact matches are used up first; a row
  // left over can then match a transfer of the same amount within a few days, because banks
  // describe transfers in their own way and date them a little differently.
  function markDuplicates(accountId, rows) {
    // Each saved transaction can stand for one row, matched on the bank's payee text or on the
    // name it has now
    const slots = new Map();
    const transfers = [];
    for (const tx of listFor(accountId)) {
      const pence = toPence(tx.amount);
      if (tx.transferId && !tx.importPayee) {
        transfers.push({ date: tx.date, pence, used: false });
        continue;
      }
      const key = `${tx.date}|${pence}`;
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push({ names: new Set([tx.importPayee, tx.payee].filter(Boolean).map(duplicateKey)), used: false });
    }
    const result = rows.map(row => ({ ...row, duplicate: false }));
    for (const row of result) {
      const name = duplicateKey(row.payee);
      const slot = (slots.get(`${row.date}|${toPence(row.amount)}`) || []).find(s => !s.used && s.names.has(name));
      if (slot) {
        slot.used = true;
        row.duplicate = true;
      }
    }
    for (const row of result) {
      if (row.duplicate) continue;
      const pence = toPence(row.amount);
      let best = null;
      for (const t of transfers) {
        if (t.used || t.pence !== pence) continue;
        const gap = Math.abs(diffDays(row.date, t.date));
        if (gap <= 3 && (!best || gap < best.gap)) best = { t, gap };
      }
      if (best) {
        best.t.used = true;
        row.duplicate = true;
      }
    }
    return result;
  }

  function resolveImportCategory(name, categoryMap) {
    const mapped = name && categoryMap && typeof categoryMap === 'object' && Object.hasOwn(categoryMap, name) ? categoryMap[name] : null;
    if (isSafeId(mapped) && svc().categories.exists(mapped) && mapped !== TRANSFER_CATEGORY_ID) return mapped;
    const found = name ? svc().categories.resolveName(name) : null;
    return found && found !== TRANSFER_CATEGORY_ID ? found : UNCATEGORIZED_ID;
  }

  function importPreview(accountId, body) {
    requireObject(body);
    svc().accounts.get(accountId);
    const rows = markDuplicates(accountId, cleanImportRows(body.rows));
    const unmatched = new Map();
    const out = rows.map(row => {
      const categoryId = resolveImportCategory(row.category, body.categoryMap);
      if (row.category && categoryId === UNCATEGORIZED_ID && row.category.toLowerCase() !== 'uncategorized') {
        unmatched.set(row.category, (unmatched.get(row.category) || 0) + 1);
      }
      return { ...row, categoryId, categoryName: svc().categories.info(categoryId).name };
    });
    return {
      rows: out,
      duplicates: out.filter(r => r.duplicate).length,
      unmatchedCategories: [...unmatched.entries()].map(([name, count]) => ({ name, count }))
    };
  }

  function importRows(accountId, body) {
    requireObject(body);
    const account = svc().accounts.getActive(accountId);
    const skipDuplicates = has(body, 'skipDuplicates') ? bool(body.skipDuplicates, 'skipDuplicates') : true;
    const rows = markDuplicates(accountId, cleanImportRows(body.rows));
    const batch = newId();
    // Rows on the same day keep the order they had in the file (oldest first in the ledger)
    const newestFirst = rows.length > 1 && rows[0].date > rows[rows.length - 1].date;
    const base = clock.now().getTime();
    let imported = 0;
    let skipped = 0;
    const list = listFor(accountId);
    rows.forEach((row, i) => {
      if (row.duplicate && skipDuplicates) { skipped++; return; }
      const order = newestFirst ? rows.length - 1 - i : i;
      list.push(newTransaction({
        date: row.date,
        amount: row.amount,
        payee: row.payee,
        importPayee: row.payee,
        categoryId: resolveImportCategory(row.category, body.categoryMap),
        description: row.description,
        notes: row.notes,
        createdAt: new Date(base + order).toISOString(),
        importBatch: batch
      }));
      imported++;
    });
    const payeesAdded = svc().payees.ensureMany(rows.filter(r => !(r.duplicate && skipDuplicates)).map(r => r.payee));
    if (has(body, 'profile') && body.profile && typeof body.profile === 'object' && JSON.stringify(body.profile).length < 4000) {
      account.importProfile = body.profile;
      store.save('accounts');
    }
    store.saveTransactions(accountId);
    if (payeesAdded) store.save('payees');
    return { success: true, imported, skipped, batch };
  }

  return {
    listFor, serialize, find, listAll, ledger, create, update, remove, restore, bulk,
    createTransfer, updateTransfer, transferCandidates, convertToTransfer, unlinkTransfer,
    importPreview, importRows, newTransaction, makeLegs, partnerOf, transferPayee, takeOut, isReal
  };
}
