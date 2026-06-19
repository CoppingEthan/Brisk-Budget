// Mortgage interest auto-accrual.
// Posts a monthly interest charge calculated on the *remaining* balance, so a
// mortgage amortises realistically (mostly interest early on, shrinking over time)
// instead of dropping by the full payment each month.
//
// Idempotent: each mortgage account stores `lastInterestAccrual` (a YYYY-MM-DD date).
// We only ever accrue forward from there, and we never backfill before the account
// existed (the anchor starts at creation), so the opening balance is taken as the
// real current amount owed.
const { accountsFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId } = require('./helpers');

const todayStr = () => new Date().toISOString().split('T')[0];

const addOneMonth = (dateStr) => {
  // Work entirely in UTC so daylight-saving changes can't shift the day
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // Guard month-length rollover (e.g. 31 Jan + 1mo would land in March): clamp to last day
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString().split('T')[0];
};

// Accrue interest for a single mortgage account object (mutates it).
// Returns true if the account object changed (so the caller can persist accounts).
const accrueOne = (account) => {
  if (!account || account.type !== 'mortgage' || account.active === false) return false;

  // Missing anchor -> start from today (no historical backfill), persist and stop.
  if (!account.lastInterestAccrual) {
    account.lastInterestAccrual = todayStr();
    return true;
  }

  const today = todayStr();
  let next = addOneMonth(account.lastInterestAccrual);
  if (next > today) return false; // nothing due yet

  const rate = parseFloat(account.interestRate) || 0;
  const monthlyRate = rate / 100 / 12;
  const txFile = getTransactionsFile(account.id);
  const txs = readJSON(txFile) || [];
  let changed = false;
  let guard = 0;

  while (next <= today && guard < 600) {
    if (monthlyRate > 0) {
      // Outstanding owed as of the accrual date (negative while in debt)
      const owed = (parseFloat(account.startingBalance) || 0)
        + txs.reduce((sum, t) => sum + (t.date <= next ? t.amount : 0), 0);
      const interest = owed < 0 ? Math.round(owed * monthlyRate * 100) / 100 : 0; // increases debt; skipped once paid off
      if (interest !== 0) {
        txs.push({
          id: generateId(),
          payee: 'Interest',
          amount: interest,
          date: next,
          category: 'Mortgage',
          description: `Interest @ ${rate}% p.a.`,
          notes: '',
          createdAt: new Date().toISOString(),
          transferId: null,
          transferAccountId: null,
          autoInterest: true
        });
        changed = true;
      }
    }
    account.lastInterestAccrual = next;
    next = addOneMonth(next);
    guard++;
  }

  if (changed) writeJSON(txFile, txs);
  return true; // lastInterestAccrual advanced
};

// Accrue interest for every active mortgage; persists accounts file if anything moved.
const accrueAll = () => {
  const accountsList = readJSON(accountsFile) || [];
  let accountsChanged = false;
  for (const account of accountsList) {
    if (account.type === 'mortgage' && account.active !== false) {
      const before = account.lastInterestAccrual;
      accrueOne(account);
      if (account.lastInterestAccrual !== before) accountsChanged = true;
    }
  }
  if (accountsChanged) writeJSON(accountsFile, accountsList);
};

module.exports = { accrueAll, accrueOne };
