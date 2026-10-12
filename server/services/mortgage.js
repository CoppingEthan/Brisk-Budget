// Mortgage interest auto-accrual.
// Posts a monthly interest charge calculated on the *remaining* balance, so a mortgage
// amortises realistically (mostly interest early on, shrinking over time) instead of dropping
// by the full payment each month.
//
// Idempotent: each mortgage account stores `lastInterestAccrual` (a YYYY-MM-DD date). We only
// ever accrue forward from there, and never backfill before the account existed, so the
// opening balance is taken as the real amount owed.
import { addMonths } from '../../public/js/shared/dates.js';
import { toPence, fromPence } from '../../public/js/shared/money.js';
import { UNCATEGORIZED_ID } from '../store/defaults.js';

export function createMortgage(app) {
  const { store, clock } = app;
  const svc = () => app.services;

  function interestCategoryId() {
    const cats = store.data.categories;
    if (svc().categories.exists('sub-mortgage')) return 'sub-mortgage';
    for (const c of cats) {
      const sub = (c.subcategories || []).find(s => s.name.toLowerCase() === 'mortgage');
      if (sub) return sub.id;
      if (c.name.toLowerCase() === 'mortgage') return c.id;
    }
    return svc().categories.exists('cat-housing') ? 'cat-housing' : UNCATEGORIZED_ID;
  }

  // Bring one mortgage up to date. Returns true if anything changed.
  function accrueOne(account) {
    if (!account || account.type !== 'mortgage' || account.active === false) return false;
    const today = clock.today();
    if (!account.lastInterestAccrual) {
      account.lastInterestAccrual = today;
      return true;
    }
    // Interest stays on the day of the month the mortgage started (31st stays 31st)
    const day = account.interestDay || undefined;
    let next = addMonths(account.lastInterestAccrual, 1, day);
    if (next > today) return false;

    const rate = Number(account.interestRate) || 0;
    const monthlyRate = rate / 100 / 12;
    const txs = svc().transactions.listFor(account.id);
    let posted = false;
    let guard = 0;
    while (next <= today && guard++ < 600) {
      if (monthlyRate > 0) {
        // Interest is on the balance going into the interest day, so a payment made that day
        // counts from the next month (the same whichever order they were posted in)
        let owedPence = toPence(account.startingBalance);
        for (const t of txs) if (t.date < next) owedPence += toPence(t.amount);
        if (owedPence < 0) {
          const interest = fromPence(Math.round(owedPence * monthlyRate));
          if (interest !== 0) {
            txs.push(svc().transactions.newTransaction({
              date: next,
              amount: interest,
              payee: 'Interest',
              categoryId: interestCategoryId(),
              description: `Interest @ ${rate}% p.a.`,
              autoInterest: true
            }));
            posted = true;
          }
        }
      }
      account.lastInterestAccrual = next;
      next = addMonths(next, 1, day);
    }
    if (posted) store.saveTransactions(account.id);
    return true;
  }

  function accrueAll() {
    let changed = false;
    for (const account of store.data.accounts) {
      if (account.type === 'mortgage' && account.active !== false) changed = accrueOne(account) || changed;
    }
    if (changed) store.save('accounts');
    return changed;
  }

  return { accrueAll, accrueOne };
}
