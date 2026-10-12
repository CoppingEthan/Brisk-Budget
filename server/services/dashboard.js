// Dashboard numbers, worked out on the server so the browser only receives what it draws.
import { addDays, addMonths, dateSteps, diffDays, isISODate, maxDate, today as localDate } from '../../public/js/shared/dates.js';
import { upcoming } from '../../public/js/shared/recurrence.js';
import { toPence, fromPence, round2 } from '../../public/js/shared/money.js';
import { INCOME_CATEGORY_ID, TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../store/defaults.js';
import { badRequest } from '../lib/errors.js';

const RANGES = { '1w': { days: 7 }, '1m': { months: 1 }, '3m': { months: 3 }, '6m': { months: 6 }, '1y': { months: 12 }, '5y': { months: 60 } };
const MAX_POINTS = 370;
const INCOME_GREEN = '#34d399';

// A set "Current value" on an investment or other asset is what it's worth, so it replaces the
// balance. On a mortgage or loan it's what the debt paid for, so value + balance owed = equity.
const VALUE_REPLACES_BALANCE = ['investment', 'asset'];
const VALUE_ADDS_TO_BALANCE = ['loan', 'mortgage'];

// Own keys only, so '?range=constructor' is an unknown range rather than Object.prototype
const rangeOf = (range) => (typeof range === 'string' && Object.hasOwn(RANGES, range) ? RANGES[range] : null);

const normalisePayee = (name) => (name || '').toLowerCase().trim().replace(/\s+/g, ' ');

// The calendar day an ISO timestamp falls on, in the server's time zone (like clock.today())
const dayOf = (timestamp) => {
  const when = typeof timestamp === 'string' ? new Date(timestamp) : null;
  return when && !Number.isNaN(when.getTime()) ? localDate(when) : null;
};

export function createDashboard(app) {
  const { store, clock } = app;
  const svc = () => app.services;
  const activeAccounts = () => store.data.accounts.filter(a => a.active !== false);
  const txsOf = (account) => store.data.transactions[account.id] || [];

  // Balance at the end of `date`: transactions dated later haven't happened yet
  function balanceOn(account, date) {
    let pence = toPence(account.startingBalance);
    for (const t of txsOf(account)) if (t.date <= date) pence += toPence(t.amount);
    return pence;
  }

  // What an account adds to net worth on top of its balance (`balanceToday`, in pence)
  function valueOffset(account, balanceToday) {
    const value = account.assetValue ? toPence(account.assetValue) : 0;
    if (!value) return 0;
    if (VALUE_REPLACES_BALANCE.includes(account.type)) return value - balanceToday;
    if (VALUE_ADDS_TO_BALANCE.includes(account.type)) return value;
    return 0;
  }

  // Everything is as of today, the same as the chart's "now": transactions dated later show up
  // in the forecast on their own dates instead.
  function summary() {
    const today = clock.today();
    let cash = 0, savings = 0, debt = 0, netWorth = 0;
    for (const account of activeAccounts()) {
      const balance = balanceOn(account, today);
      const worth = balance + valueOffset(account, balance);
      switch (account.type) {
        case 'bank':
          cash += balance;
          break;
        case 'savings':
        case 'investment':
          savings += worth;
          break;
        case 'credit':
        case 'loan':
        case 'mortgage':
          if (balance < 0) debt -= balance; // only money actually owed
          break;
        // Other assets (a house, a car) count towards net worth only
      }
      netWorth += worth;
    }
    return { netWorth: fromPence(netWorth), cash: fromPence(cash), savings: fromPence(savings), debt: fromPence(debt) };
  }

  // The four summary figures for each of the last `days` days, for the cards' small charts and
  // their change over the last month. Same rules as summary(); archived accounts are left out.
  function trend({ days = 90 } = {}) {
    const today = clock.today();
    const dates = dateSteps(addDays(today, -days), today, 1);
    const series = { netWorth: [], cash: [], savings: [], debt: [] };
    for (const key of Object.keys(series)) series[key] = new Array(dates.length).fill(0);
    for (const account of activeAccounts()) {
      const txs = [...txsOf(account)].sort((a, b) => a.date.localeCompare(b.date));
      const offset = valueOffset(account, balanceOn(account, today));
      let running = toPence(account.startingBalance);
      let i = 0;
      for (let d = 0; d < dates.length; d++) {
        while (i < txs.length && txs[i].date <= dates[d]) running += toPence(txs[i++].amount);
        const worth = running + offset;
        series.netWorth[d] += worth;
        if (account.type === 'bank') series.cash[d] += running;
        else if (account.type === 'savings' || account.type === 'investment') series.savings[d] += worth;
        else if (['credit', 'loan', 'mortgage'].includes(account.type) && running < 0) series.debt[d] -= running;
      }
    }
    for (const key of Object.keys(series)) series[key] = series[key].map(fromPence);
    return { dates, ...series };
  }

  function selected(accountIds) {
    const all = activeAccounts();
    if (!accountIds) return all;
    const wanted = new Set(accountIds);
    return all.filter(a => wanted.has(a.id));
  }

  // First day an archived account no longer counts: the day it was archived, or for accounts
  // archived before that was recorded, the day after its last transaction
  function archivedFrom(account) {
    const archived = dayOf(account.archivedAt);
    if (archived) return archived;
    let last = dayOf(account.createdAt) || '1900-01-01';
    for (const t of txsOf(account)) last = maxDate(last, t.date);
    return addDays(last, 1);
  }

  // Combined worth of the chosen accounts at the end of each day in [from, to]
  function history(accounts, from, to, today) {
    const totalDays = diffDays(from, to);
    const step = Math.max(1, Math.ceil(totalDays / MAX_POINTS));
    const dates = dateSteps(from, to, step);
    const values = new Array(dates.length).fill(0);
    for (const account of accounts) {
      const txs = [...txsOf(account)].sort((a, b) => a.date.localeCompare(b.date));
      const offset = valueOffset(account, balanceOn(account, today));
      const stop = account.active === false ? archivedFrom(account) : null;
      let running = toPence(account.startingBalance);
      let i = 0;
      for (let d = 0; d < dates.length; d++) {
        if (stop && dates[d] >= stop) break;
        while (i < txs.length && txs[i].date <= dates[d]) running += toPence(txs[i++].amount);
        values[d] += running + offset;
      }
    }
    return dates.map((date, d) => ({ date, value: fromPence(values[d]) }));
  }

  // Everyday spending that isn't on a schedule: an average daily drift plus how much it swings
  // (for the confidence band). Each account looks back three months, or only as far as its
  // history goes, so a new account isn't averaged over months it didn't exist.
  function variableSpend(accounts, today) {
    // A template's payee only counts as scheduled on that template's own account, so a weekly
    // Tesco shop on the joint account doesn't hide every Tesco spend on the card
    const templated = new Set(store.data.recurring
      .filter(r => r.active !== false && r.type !== 'transfer' && r.payee)
      .map(r => `${r.accountId}|${normalisePayee(r.payee)}`));
    let dailyDrift = 0;
    let variance = 0;
    for (const account of accounts) {
      const past = txsOf(account).filter(tx => tx.date < today);
      let earliest = dayOf(account.createdAt) || today;
      for (const tx of past) if (tx.date < earliest) earliest = tx.date;
      const start = maxDate(addMonths(today, -3), earliest);
      const days = diffDays(start, today);
      if (days < 1) continue;
      const buckets = [0, 0, 0];
      let total = 0;
      for (const tx of past) {
        if (tx.date < start) continue;
        if (tx.transferId || tx.categoryId === TRANSFER_CATEGORY_ID || tx.autoInterest || tx.recurringId) continue;
        if (templated.has(`${account.id}|${normalisePayee(tx.payee)}`)) continue;
        const idx = Math.min(2, Math.floor((diffDays(start, tx.date) / days) * 3));
        const pence = toPence(tx.amount);
        buckets[idx] += pence;
        total += pence;
      }
      dailyDrift += total / days;
      const mean = total / 3;
      // Swings grow with the square root of time, so scale each third of the window to a month
      variance += (buckets.reduce((s, v) => s + (v - mean) ** 2, 0) / 3) * (30.44 / (days / 3));
    }
    return { dailyDrift, sigma: Math.sqrt(variance) };
  }

  function forecast(accounts, today, months) {
    const end = addMonths(today, months);
    const ids = new Set(accounts.map(a => a.id));
    const balances = new Map();
    const events = [];
    let offsets = 0;
    for (const account of accounts) {
      const now = balanceOn(account, today);
      balances.set(account.id, now);
      offsets += valueOffset(account, now);
      // Transactions already entered with a later date land on their own dates
      for (const tx of txsOf(account)) {
        if (tx.date > today && tx.date <= end) events.push({ date: tx.date, accountId: account.id, pence: toPence(tx.amount) });
      }
    }

    // Scheduled payments from recurring templates (paused or finished ones are left out).
    // Overdue ones that haven't been approved are still to come, so they count from the next point.
    for (const t of store.data.recurring) {
      if (t.active === false || t.paused) continue;
      for (const { date } of upcoming(t, end, { countFrom: today })) {
        if (t.type === 'transfer') {
          const value = toPence(Math.abs(t.amount));
          if (ids.has(t.fromAccountId)) events.push({ date, accountId: t.fromAccountId, pence: -value });
          if (ids.has(t.toAccountId)) events.push({ date, accountId: t.toAccountId, pence: value });
        } else if (ids.has(t.accountId)) {
          events.push({ date, accountId: t.accountId, pence: toPence(t.amount) });
        }
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date));

    const mortgages = accounts
      .filter(a => a.type === 'mortgage' && Number(a.interestRate) > 0)
      .map(a => ({ id: a.id, monthlyRate: Number(a.interestRate) / 100 / 12, day: a.interestDay || undefined, next: addMonths(a.lastInterestAccrual || today, 1, a.interestDay || undefined) }));

    const { dailyDrift, sigma } = variableSpend(accounts, today);
    const totalDays = diffDays(today, end);
    const step = Math.max(1, Math.ceil(totalDays / MAX_POINTS));
    const points = [];
    let e = 0;
    for (const date of dateSteps(today, end, step)) {
      // The first point is where things stand today; what's due (or overdue) moves it from the
      // next point on. Interest and payments go in date order, interest first on a shared day, so
      // each month's interest is on the balance going into its interest day, as the real accrual is.
      while (date > today) {
        const ev = e < events.length && events[e].date <= date ? events[e] : null;
        let m = null;
        for (const x of mortgages) if (x.next <= date && (!m || x.next < m.next)) m = x;
        if (!ev && !m) break;
        if (m && (!ev || m.next <= ev.date)) {
          const owed = balances.get(m.id);
          if (owed < 0) balances.set(m.id, owed + Math.round(owed * m.monthlyRate));
          m.next = addMonths(m.next, 1, m.day);
        } else {
          balances.set(ev.accountId, balances.get(ev.accountId) + ev.pence);
          e++;
        }
      }
      let scheduled = offsets;
      for (const v of balances.values()) scheduled += v;
      const elapsed = diffDays(today, date);
      const value = scheduled + dailyDrift * elapsed;
      const band = 1.28 * sigma * Math.sqrt(elapsed / 30.44);
      points.push({ date, value: round2(value / 100), lower: round2((value - band) / 100), upper: round2((value + band) / 100) });
    }
    return points;
  }

  function series({ accountIds, range = '1m', forecastRange = '0' }) {
    const r = rangeOf(range);
    if (!r) throw badRequest('Unknown range');
    let forecastMonths = 0;
    if (forecastRange && forecastRange !== '0') {
      const f = rangeOf(forecastRange);
      if (!f) throw badRequest('Unknown forecast range');
      forecastMonths = Math.max(1, f.months || 0);
    }
    const accounts = selected(accountIds);
    const today = clock.today();
    const from = r.days ? addDays(today, -r.days) : addMonths(today, -r.months);
    // Net worth (every account) also counts archived accounts up to the day they were archived,
    // so moving the money out of an account before closing it isn't drawn as a jump
    const everything = accounts.length > 0 && accounts.length === activeAccounts().length;
    const pastAccounts = everything ? [...accounts, ...store.data.accounts.filter(a => a.active === false)] : accounts;
    const result = { history: history(pastAccounts, from, today, today), forecast: [] };
    if (forecastMonths) result.forecast = forecast(accounts, today, forecastMonths);
    return result;
  }

  // Money in by Income subcategory and money out by top-level category, for a date range.
  // Refunds reduce the category they came back to; anything left over counts as money in.
  function flows({ from, to }) {
    if (!isISODate(from) || !isISODate(to)) throw badRequest('from and to must be dates');
    const cats = svc().categories;
    const income = new Map(); // can go below zero when income is paid back
    const spending = new Map();
    const moneyIn = new Map(); // money in under a spending category: refunds, dividends…
    const add = (map, key, pence) => map.set(key, (map.get(key) || 0) + pence);

    for (const account of activeAccounts()) {
      for (const tx of txsOf(account)) {
        if (tx.date < from || tx.date > to) continue;
        if (tx.transferId || tx.categoryId === TRANSFER_CATEGORY_ID) continue;
        const info = cats.info(tx.categoryId);
        const pence = toPence(tx.amount);
        // A salary reclaim reduces that income rather than counting as spending
        if (info.parentId === INCOME_CATEGORY_ID) add(income, info.isSub ? info.id : `${info.id}:other`, pence);
        else if (pence > 0) add(info.parentId === UNCATEGORIZED_ID ? income : moneyIn, info.parentId, pence);
        else if (pence < 0) add(spending, info.parentId, -pence);
      }
    }
    for (const [parentId, pence] of moneyIn) {
      const spent = spending.get(parentId) || 0;
      if (pence <= spent) spending.set(parentId, spent - pence);
      else {
        spending.delete(parentId);
        // Only call it refunds when there was spending there to refund
        add(income, `${parentId}:${spent > 0 ? 'refund' : 'in'}`, pence - spent);
      }
    }

    const incomeColour = (cats.exists(INCOME_CATEGORY_ID) && cats.info(INCOME_CATEGORY_ID).color) || INCOME_GREEN;
    const incomeName = (key) => {
      const [catId, kind] = key.split(':');
      const info = cats.info(catId);
      if (catId === UNCATEGORIZED_ID) return 'Uncategorised income';
      if (kind === 'other') return info.id === INCOME_CATEGORY_ID ? 'Other income' : info.name;
      if (kind === 'refund') return `${info.name} (refunds)`;
      return info.name;
    };

    const incomeRows = [...income.entries()].filter(([, p]) => p > 0)
      .map(([key, pence]) => ({ id: key, name: incomeName(key), amount: fromPence(pence), color: incomeColour }))
      .sort((a, b) => b.amount - a.amount);

    const expenseRows = [...spending.entries()].filter(([, p]) => p > 0).map(([id, pence]) => {
      const info = cats.info(id);
      return { id, name: info.name, emoji: info.emoji, amount: fromPence(pence), color: info.color };
    });
    // More paid back than came in over the period
    for (const [key, pence] of income) {
      if (pence < 0) expenseRows.push({ id: `${key}:paid-back`, name: `${incomeName(key)} (paid back)`, amount: fromPence(-pence), color: incomeColour });
    }
    expenseRows.sort((a, b) => b.amount - a.amount);

    const totalIncome = incomeRows.reduce((s, r) => s + toPence(r.amount), 0);
    const totalExpenses = expenseRows.reduce((s, r) => s + toPence(r.amount), 0);
    return {
      income: incomeRows,
      expenses: expenseRows,
      totalIncome: fromPence(totalIncome),
      totalExpenses: fromPence(totalExpenses),
      net: fromPence(totalIncome - totalExpenses)
    };
  }

  return { summary, trend, series, flows };
}
