// Idempotent clean-up of current-format data. Runs on every start-up and every restore, so a
// hand-edited file or a hostile backup can't put shapes into the data that would break the app.
// Valid data passes through untouched; returns how many things it had to repair.
import { isISODate } from '../../public/js/shared/dates.js';
import { round2 } from '../../public/js/shared/money.js';
import { normaliseFrequency } from '../../public/js/shared/recurrence.js';
import { ACCOUNT_TYPES, DEFAULT_SETTINGS, TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID, systemCategory } from './defaults.js';
import { ICON_FILE_RE } from './store.js';
import { isSafeId, newId } from '../lib/ids.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string';

export function sanitizeData(data, { today, nowIso }) {
  let fixes = 0;
  const fix = () => { fixes++; };
  const setIf = (obj, key, ok, value) => { if (!ok) { obj[key] = value; fix(); } };
  const cleanList = (list, keep) => {
    const out = list.filter(keep);
    if (out.length !== list.length) fix();
    return out;
  };

  // Top-level shapes
  if (!isObject(data.settings)) { data.settings = {}; fix(); }
  for (const key of ['accounts', 'groups', 'categories', 'payees', 'recurring', 'dismissed']) {
    if (!Array.isArray(data[key])) { data[key] = []; fix(); }
  }
  if (!isObject(data.transactions)) { data.transactions = {}; fix(); }
  if (!isObject(data.icons)) { data.icons = {}; fix(); }
  if (isObject(data.meta) && data.meta.notices !== undefined) {
    const notices = Array.isArray(data.meta.notices) ? data.meta.notices : [];
    const ok = notices.filter(n => isObject(n) && isText(n.id) && isText(n.message));
    if (!Array.isArray(data.meta.notices) || ok.length !== notices.length) { data.meta.notices = ok; fix(); }
  }

  // Settings
  const s = data.settings;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof s[key] !== typeof value) { s[key] = value; fix(); }
  }
  setIf(s, 'currencySymbol', s.currencySymbol.trim() && s.currencySymbol.length <= 4, '£');
  setIf(s, 'name', s.name.length <= 60, s.name.slice(0, 60));

  // Only structural problems are repaired here. Things that are merely inconsistent (a missing
  // category, a group that no longer exists, a duplicate id, a broken transfer) are left for
  // Settings › Data check, which explains them and lets the person choose to fix them.

  // Categories
  const seenIds = new Set();
  const uniqueSafe = (id) => isSafeId(id) && !seenIds.has(id);
  data.categories = cleanList(data.categories, c => isObject(c));
  for (const c of data.categories) {
    if (!uniqueSafe(c.id)) { c.id = newId(); fix(); }
    seenIds.add(c.id);
    setIf(c, 'name', isText(c.name) && c.name.trim(), 'Category');
    setIf(c, 'emoji', isText(c.emoji) && c.emoji, '📁');
    setIf(c, 'sortOrder', Number.isFinite(c.sortOrder), 0);
    setIf(c, 'subcategories', Array.isArray(c.subcategories), []);
    c.subcategories = cleanList(c.subcategories, sub => isObject(sub) && isText(sub.name) && sub.name.trim());
    for (const sub of c.subcategories) {
      if (!uniqueSafe(sub.id)) { sub.id = newId(); fix(); }
      seenIds.add(sub.id);
      setIf(sub, 'sortOrder', Number.isFinite(sub.sortOrder), 0);
    }
  }
  for (const systemId of [TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID]) {
    if (!seenIds.has(systemId)) { data.categories.push(systemCategory(systemId)); seenIds.add(systemId); fix(); }
  }
  const categoryShapeOk = (id) => isSafeId(id);

  // Icons and the things that point at them
  for (const name of Object.keys(data.icons)) {
    if (!ICON_FILE_RE.test(name) || !Buffer.isBuffer(data.icons[name])) { delete data.icons[name]; fix(); }
  }
  const iconOk = (icon) => icon === null || (isObject(icon) && ICON_FILE_RE.test(icon.file || '') && Object.hasOwn(data.icons, icon.file));

  // Groups
  const groupIds = new Set();
  data.groups = cleanList(data.groups, g => isObject(g) && isSafeId(g.id) && !groupIds.has(g.id) && groupIds.add(g.id));
  for (const g of data.groups) {
    setIf(g, 'name', isText(g.name) && g.name.trim(), 'Group');
    setIf(g, 'sortOrder', Number.isFinite(g.sortOrder), 0);
    setIf(g, 'icon', iconOk(g.icon ?? null), null);
  }

  // Accounts
  const accountIds = new Set();
  data.accounts = cleanList(data.accounts, a => isObject(a) && isSafeId(a.id) && !accountIds.has(a.id) && accountIds.add(a.id));
  for (const a of data.accounts) {
    setIf(a, 'name', isText(a.name) && a.name.trim(), 'Account');
    setIf(a, 'type', ACCOUNT_TYPES.includes(a.type), 'bank');
    setIf(a, 'startingBalance', Number.isFinite(a.startingBalance), round2(Number(a.startingBalance) || 0));
    setIf(a, 'assetValue', a.assetValue === null || a.assetValue === undefined || Number.isFinite(a.assetValue), null);
    setIf(a, 'interestRate', a.interestRate === null || a.interestRate === undefined || Number.isFinite(a.interestRate), null);
    setIf(a, 'sortOrder', Number.isFinite(a.sortOrder), 0);
    setIf(a, 'active', typeof a.active === 'boolean', a.active !== false);
    setIf(a, 'icon', iconOk(a.icon ?? null), null);
    setIf(a, 'groupId', a.groupId === null || a.groupId === undefined || isSafeId(a.groupId), null);
    if (a.type === 'mortgage') setIf(a, 'lastInterestAccrual', isISODate(a.lastInterestAccrual), today);
    if (!Array.isArray(data.transactions[a.id])) { data.transactions[a.id] = []; fix(); }
  }

  // Transactions
  for (const accountId of Object.keys(data.transactions)) {
    if (!isSafeId(accountId)) { delete data.transactions[accountId]; fix(); continue; }
    if (!Array.isArray(data.transactions[accountId])) { data.transactions[accountId] = []; fix(); continue; }
    data.transactions[accountId] = cleanList(data.transactions[accountId], tx => isObject(tx));
    for (const tx of data.transactions[accountId]) {
      if (!isSafeId(tx.id)) { tx.id = newId(); fix(); }
      setIf(tx, 'date', isISODate(tx.date), today);
      setIf(tx, 'amount', Number.isFinite(tx.amount), round2(Number(tx.amount) || 0));
      setIf(tx, 'payee', isText(tx.payee), tx.payee === null || tx.payee === undefined ? '' : String(tx.payee));
      setIf(tx, 'description', isText(tx.description), '');
      setIf(tx, 'notes', isText(tx.notes), '');
      setIf(tx, 'createdAt', isText(tx.createdAt), nowIso);
      const linked = isSafeId(tx.transferId) && isSafeId(tx.transferAccountId);
      if (!linked && (tx.transferId || tx.transferAccountId)) { tx.transferId = null; tx.transferAccountId = null; fix(); }
      if (tx.transferId === undefined) tx.transferId = null;
      if (tx.transferAccountId === undefined) tx.transferAccountId = null;
      setIf(tx, 'categoryId', categoryShapeOk(tx.categoryId), linked ? TRANSFER_CATEGORY_ID : UNCATEGORIZED_ID);
    }
  }

  // Recurring
  const recurringIds = new Set();
  data.recurring = cleanList(data.recurring, r => isObject(r) && isSafeId(r.id) && !recurringIds.has(r.id) && recurringIds.add(r.id));
  for (const r of data.recurring) {
    setIf(r, 'type', r.type === 'transfer' || r.type === 'transaction', 'transaction');
    const freq = normaliseFrequency(r.frequency);
    if (!isObject(r.frequency) || r.frequency.type !== freq.type || r.frequency.interval !== freq.interval) { r.frequency = freq; fix(); }
    setIf(r, 'startDate', isISODate(r.startDate), isISODate(r.nextDueDate) ? r.nextDueDate : today);
    setIf(r, 'nextDueDate', isISODate(r.nextDueDate), r.startDate);
    setIf(r, 'amount', Number.isFinite(r.amount), round2(Number(r.amount) || 0));
    setIf(r, 'payee', isText(r.payee), '');
    setIf(r, 'description', isText(r.description), '');
    setIf(r, 'notes', isText(r.notes), '');
    setIf(r, 'occurrencesCompleted', Number.isInteger(r.occurrencesCompleted) && r.occurrencesCompleted >= 0, 0);
    const end = r.endCondition;
    const endOk = isObject(end) && (end.type === 'never'
      || (end.type === 'after_occurrences' && Number.isInteger(end.value) && end.value > 0)
      || (end.type === 'on_date' && isISODate(end.value)));
    setIf(r, 'endCondition', endOk, { type: 'never', value: null });
    setIf(r, 'categoryId', categoryShapeOk(r.categoryId), r.type === 'transfer' ? TRANSFER_CATEGORY_ID : UNCATEGORIZED_ID);
    for (const key of ['accountId', 'fromAccountId', 'toAccountId']) {
      setIf(r, key, r[key] === null || r[key] === undefined || isSafeId(r[key]), null);
    }
  }

  // Payees and dismissed suggestions
  const payeeNames = new Set();
  data.payees = cleanList(data.payees, p => {
    if (!isObject(p) || !isText(p.name) || !p.name.trim()) return false;
    const key = p.name.trim().toLowerCase();
    if (payeeNames.has(key)) return false;
    payeeNames.add(key);
    return true;
  });
  for (const p of data.payees) if (!isSafeId(p.id)) { p.id = newId(); fix(); }
  data.dismissed = cleanList(data.dismissed, d => isText(d));

  return fixes;
}
