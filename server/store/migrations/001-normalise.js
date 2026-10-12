// Bring data written by any v0.1.x release into one consistent shape: fill in files that older
// versions didn't create, turn stray strings into numbers, and repair missing fields.
import { isISODate } from '../../../public/js/shared/dates.js';
import { round2 } from '../../../public/js/shared/money.js';
import { normaliseFrequency } from '../../../public/js/shared/recurrence.js';
import { ACCOUNT_TYPES, DEFAULT_SETTINGS, defaultCategories, systemCategory, TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../defaults.js';
import { isSafeId } from '../../lib/ids.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 500) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)).slice(0, max);
const numberOr = (v, fallback) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

// Accept slightly malformed dates like 2024-1-5 that older imports could produce
function cleanDate(value) {
  if (isISODate(value)) return value;
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
    if (m) {
      const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      if (isISODate(iso)) return iso;
    }
  }
  return null;
}

export default {
  version: 1,
  name: 'Tidy data from earlier versions',
  up(data, ctx) {
    // Settings
    const settings = isObject(data.settings) ? data.settings : {};
    data.settings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      currencySymbol: text(settings.currencySymbol || DEFAULT_SETTINGS.currencySymbol, 4) || '£',
      name: text(settings.name, 60),
      groupChartToggles: settings.groupChartToggles !== false
    };

    // Groups (not created before v0.1.1)
    const groups = (Array.isArray(data.groups) ? data.groups : []).filter(g => isObject(g) && isSafeId(g.id));
    data.groups = groups.map((g, i) => ({
      ...g,
      id: g.id,
      name: text(g.name, 100) || 'Group',
      icon: g.icon ?? null,
      sortOrder: numberOr(g.sortOrder, i),
      createdAt: text(g.createdAt) || ctx.nowIso
    }));
    const groupIds = new Set(data.groups.map(g => g.id));

    // Accounts
    const seenAccounts = new Set();
    data.accounts = (Array.isArray(data.accounts) ? data.accounts : [])
      .filter(a => isObject(a) && isSafeId(a.id) && !seenAccounts.has(a.id) && seenAccounts.add(a.id))
      .map((a, i) => {
        const type = ACCOUNT_TYPES.includes(a.type) ? a.type : 'bank';
        const assetValue = a.assetValue === null || a.assetValue === undefined ? null : numberOr(a.assetValue, null);
        const interestRate = a.interestRate === null || a.interestRate === undefined ? null : numberOr(a.interestRate, null);
        return {
          ...a,
          id: a.id,
          name: text(a.name, 100) || 'Account',
          type,
          startingBalance: round2(numberOr(a.startingBalance, 0)),
          assetValue: assetValue === null ? null : round2(assetValue),
          interestRate,
          lastInterestAccrual: cleanDate(a.lastInterestAccrual) || (type === 'mortgage' ? ctx.today : null),
          icon: a.icon ?? null,
          groupId: a.groupId && groupIds.has(a.groupId) ? a.groupId : null,
          sortOrder: numberOr(a.sortOrder, i),
          active: a.active !== false,
          createdAt: text(a.createdAt) || ctx.nowIso
        };
      });

    // Transactions: one list per account file
    const transactions = isObject(data.transactions) ? data.transactions : {};
    for (const account of data.accounts) {
      if (!Array.isArray(transactions[account.id])) transactions[account.id] = [];
    }
    for (const [accountId, list] of Object.entries(transactions)) {
      const seen = new Set();
      transactions[accountId] = (Array.isArray(list) ? list : []).filter(isObject).map(tx => {
        let id = isSafeId(tx.id) ? tx.id : ctx.newId();
        if (seen.has(id)) id = ctx.newId();
        seen.add(id);
        const date = cleanDate(tx.date) || cleanDate(text(tx.createdAt).slice(0, 10)) || ctx.today;
        const out = {
          ...tx,
          id,
          date,
          amount: round2(numberOr(tx.amount, 0)),
          payee: text(tx.payee, 200),
          category: text(tx.category, 100),
          description: text(tx.description, 500),
          notes: text(tx.notes, 2000),
          createdAt: text(tx.createdAt) || ctx.nowIso,
          transferId: isSafeId(tx.transferId) ? tx.transferId : null,
          transferAccountId: isSafeId(tx.transferAccountId) ? tx.transferAccountId : null
        };
        if (!out.transferId || !out.transferAccountId) {
          out.transferId = null;
          out.transferAccountId = null;
        }
        return out;
      });
    }
    data.transactions = transactions;

    // Recurring templates
    data.recurring = (Array.isArray(data.recurring) ? data.recurring : [])
      .filter(r => isObject(r) && isSafeId(r.id))
      .map(r => {
        const startDate = cleanDate(r.startDate) || cleanDate(r.nextDueDate) || ctx.today;
        const end = isObject(r.endCondition) ? r.endCondition : { type: 'never', value: null };
        let endCondition = { type: 'never', value: null };
        if (end.type === 'after_occurrences' && numberOr(end.value, 0) > 0) endCondition = { type: 'after_occurrences', value: Math.floor(numberOr(end.value, 1)) };
        else if (end.type === 'on_date' && cleanDate(end.value)) endCondition = { type: 'on_date', value: cleanDate(end.value) };
        return {
          ...r,
          id: r.id,
          type: r.type === 'transfer' ? 'transfer' : 'transaction',
          accountId: isSafeId(r.accountId) ? r.accountId : null,
          fromAccountId: isSafeId(r.fromAccountId) ? r.fromAccountId : null,
          toAccountId: isSafeId(r.toAccountId) ? r.toAccountId : null,
          payee: text(r.payee, 200),
          amount: round2(numberOr(r.amount, 0)),
          category: text(r.category, 100),
          description: text(r.description, 500),
          notes: text(r.notes, 2000),
          frequency: normaliseFrequency(r.frequency),
          startDate,
          nextDueDate: cleanDate(r.nextDueDate) || startDate,
          endCondition,
          occurrencesCompleted: Math.max(0, Math.floor(numberOr(r.occurrencesCompleted, 0))),
          active: r.active !== false,
          paused: r.paused === true,
          createdAt: text(r.createdAt) || ctx.nowIso
        };
      });

    // Payees: drop blanks and case-insensitive duplicates
    const seenPayees = new Set();
    data.payees = (Array.isArray(data.payees) ? data.payees : [])
      .filter(p => isObject(p) && typeof p.name === 'string' && p.name.trim())
      .filter(p => {
        const key = p.name.trim().toLowerCase();
        if (seenPayees.has(key)) return false;
        seenPayees.add(key);
        return true;
      })
      .map(p => ({ id: isSafeId(p.id) ? p.id : ctx.newId(), name: p.name.trim().slice(0, 200) }));

    data.dismissed = (Array.isArray(data.dismissed) ? data.dismissed : []).filter(s => typeof s === 'string');

    // Categories: valid ids, unique, system categories always present
    let categories = Array.isArray(data.categories) ? data.categories.filter(isObject) : null;
    if (!categories || categories.length === 0) categories = defaultCategories();
    const usedIds = new Set();
    const uniqueId = (candidate) => {
      let id = isSafeId(candidate) ? candidate : ctx.newId();
      while (usedIds.has(id)) id = ctx.newId();
      usedIds.add(id);
      return id;
    };
    data.categories = categories.map((c, i) => {
      const category = {
        id: uniqueId(c.id),
        name: text(c.name, 100) || 'Category',
        emoji: text(c.emoji, 16) || '📁',
        isDefault: c.isDefault === true,
        sortOrder: numberOr(c.sortOrder, i),
        subcategories: (Array.isArray(c.subcategories) ? c.subcategories : [])
          .filter(s => isObject(s) && typeof s.name === 'string' && s.name.trim())
          .map((s, j) => ({ id: uniqueId(s.id), name: s.name.trim().slice(0, 100), sortOrder: numberOr(s.sortOrder, j) }))
      };
      if (c.color) category.color = c.color;
      if (c.isSystem) category.isSystem = true;
      return category;
    });
    for (const systemId of [TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID]) {
      if (!data.categories.some(c => c.id === systemId)) data.categories.push(systemCategory(systemId));
    }
  }
};
