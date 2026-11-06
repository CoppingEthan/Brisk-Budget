// Dashboard numbers, worked out on the server so the browser only receives what it draws.
import { addDays, addMonths, dateSteps, diffDays, isISODate, maxDate, minDate, today as localDate } from '../../public/js/shared/dates.js';
import { upcoming } from '../../public/js/shared/recurrence.js';
import { typicalMonth, historyStart, likelyRange, MONTH_DAYS } from './forecast-model.js';
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
const DEBT_TYPES = ['credit', 'loan', 'mortgage'];
// Types whose value is for something bought (a car, a house) rather than an investment's worth
const BOUGHT_TYPES = ['loan', 'mortgage', 'asset'];

// What a chart line adds up: 'worth' (balances plus any value, as in net worth), 'balance' (the
// balances alone) or 'debt' (money actually owed on cards, loans and mortgages, as a positive amount)
const MEASURES = ['worth', 'balance', 'debt'];

// The dashboard cards. A card's chart uses the same accounts and sums as the card, and also counts
// archived accounts of those types up to the day they closed, so closing one isn't drawn as a jump.
const CARDS = {
  netWorth: { types: null, measure: 'worth' },
  cash: { types: ['bank'], measure: 'balance' },
  savings: { types: ['savings', 'investment'], measure: 'worth' },
  debt: { types: DEBT_TYPES, measure: 'debt' }
};

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

  // The days an account counts in charts of the past.
  // - Its balance counts from the day it was opened (from the start when no date is set) until
  //   it closed. An account always counts on days it has transactions, so a transfer to or from
  //   it moves money rather than making it appear or vanish.
  // - A car or house value counts only while it was owned: from the day it was bought (or the
  //   account opened; with neither set and no opening balance, its first transaction) until the
  //   day the account closed, which is also the day to give when what it paid for was sold.
  // Dates are the first day something counts (`from`) and the first day it no longer does (`until`).
  function lifetime(account, txs) {
    const first = txs.length ? txs[0].date : null;
    const last = txs.length ? txs[txs.length - 1].date : null;
    const from = account.openedOn ? (first ? minDate(account.openedOn, first) : account.openedOn) : null;
    const valueFrom = account.valueFrom || account.openedOn || (toPence(account.startingBalance) === 0 ? first : null);
    if (account.active !== false) return { from, valueFrom, until: null, valueUntil: null };
    // Accounts archived before either date was recorded stop the day after their last transaction
    const closed = account.closedOn || dayOf(account.archivedAt)
      || addDays(maxDate(dayOf(account.createdAt) || '1900-01-01', last || '1900-01-01'), 1);
    return { from, valueFrom, until: last ? maxDate(closed, addDays(last, 1)) : closed, valueUntil: closed };
  }

  // An account's three figures (in pence) at the end of each of `dates`: what it's worth (its
  // balance plus any value it was owned for that day), its balance, and the money owed on it.
  // All three are 0 on days the account doesn't count.
  function figures(account, dates, today) {
    const txs = [...txsOf(account)].sort((a, b) => a.date.localeCompare(b.date));
    const life = lifetime(account, txs);
    const offset = valueOffset(account, balanceOn(account, today));
    const isDebt = DEBT_TYPES.includes(account.type);
    const out = { worth: new Array(dates.length).fill(0), balance: new Array(dates.length).fill(0), debt: new Array(dates.length).fill(0) };
    let running = toPence(account.startingBalance);
    let i = 0;
    for (let d = 0; d < dates.length; d++) {
      const date = dates[d];
      while (i < txs.length && txs[i].date <= date) running += toPence(txs[i++].amount);
      if (life.until && date >= life.until) break;
      if (life.from && date < life.from) continue;
      const owned = offset && (!life.valueFrom || date >= life.valueFrom) && (!life.valueUntil || date < life.valueUntil);
      out.balance[d] = running;
      out.worth[d] = running + (owned ? offset : 0);
      if (isDebt && running < 0) out.debt[d] = -running;
    }
    return out;
  }

  // Everything is as of today, the same as the chart's "now": transactions dated later show up
  // in the forecast on their own dates instead.
  function summary() {
    const today = clock.today();
    let cash = 0, savings = 0, debt = 0, netWorth = 0;
    for (const account of activeAccounts()) {
      const f = figures(account, [today], today);
      if (account.type === 'bank') cash += f.balance[0];
      else if (account.type === 'savings' || account.type === 'investment') savings += f.worth[0];
      // Only money actually owed counts as debt. Other assets (a house, a car) count towards net worth only.
      debt += f.debt[0];
      netWorth += f.worth[0];
    }
    return { netWorth: fromPence(netWorth), cash: fromPence(cash), savings: fromPence(savings), debt: fromPence(debt) };
  }

  // Which accounts a card adds up, and which sum: archived ones count up to the day they closed
  const cardAccounts = (card, { archived = false } = {}) =>
    store.data.accounts.filter(a => (archived || a.active !== false) && (!CARDS[card].types || CARDS[card].types.includes(a.type)));

  // The four summary figures for each of the last `days` days, for the cards' small charts and
  // their change over the last month. The same sums as the cards' big charts, so each one ends on
  // its card's figure today.
  function trend({ days = 90 } = {}) {
    const today = clock.today();
    const dates = dateSteps(addDays(today, -days), today, 1);
    const series = {};
    for (const card of Object.keys(CARDS)) {
      const values = new Array(dates.length).fill(0);
      for (const account of cardAccounts(card, { archived: true })) {
        const f = figures(account, dates, today)[CARDS[card].measure];
        for (let d = 0; d < dates.length; d++) values[d] += f[d];
      }
      series[card] = values.map(fromPence);
    }
    return { dates, ...series };
  }

  function selected(accountIds) {
    const all = activeAccounts();
    if (!accountIds) return all;
    const wanted = new Set(accountIds);
    return all.filter(a => wanted.has(a.id));
  }

  // The chosen accounts' combined figure (a MEASURES name) at the end of each day in [from, to]
  function history(accounts, from, to, today, measure = 'worth') {
    const totalDays = diffDays(from, to);
    const step = Math.max(1, Math.ceil(totalDays / MAX_POINTS));
    const dates = dateSteps(from, to, step);
    const values = new Array(dates.length).fill(0);
    for (const account of accounts) {
      const f = figures(account, dates, today)[measure];
      for (let d = 0; d < dates.length; d++) values[d] += f[d];
    }
    return dates.map((date, d) => ({ date, value: fromPence(values[d]) }));
  }

  // Money that comes and goes without a schedule (everyday spending, irregular income, money
  // moved to accounts outside the chart) for the chosen accounts: a typical month and how much a
  // month usually differs from it, in pence (see forecast-model.js).
  // - Only money crossing the edge of the chosen accounts counts. A transfer between two chosen
  //   accounts just moves money; a card repayment from a bank account that isn't chosen pays the
  //   card off.
  // - Scheduled money is left out, as the forecast adds it on its own dates: recurring payments
  //   (and their payee's other payments on that account), transfers between the two accounts of a
  //   recurring transfer, and the charges on a mortgage whose interest Brisk adds.
  // - Transfers to or from an archived account that isn't part of the chart are left out: that
  //   arrangement has ended. Archived accounts that are part of it (the net worth line counts them
  //   up to the day they closed) count like the rest.
  // - An opening balance counts on the day the account opened, and for a line that includes values
  //   (net worth), a car or house value counts on the day it was bought and goes on the day it was
  //   sold. Buying a car swaps money for a car, so that month isn't a huge spending month, and
  //   selling one doesn't look like a windfall.
  // - For what's owed, borrowing isn't everyday money: a loan or mortgage's opening balance, and
  //   money drawn from one, are left out (repayments come from the recurring transfers).
  // `accounts` are the chosen accounts; `past` adds the archived accounts the net worth line counts.
  function unscheduled(accounts, today, measure = 'worth', past = accounts) {
    const owed = measure === 'debt';
    const chosen = new Set(past.map(a => a.id));
    const live = new Set(activeAccounts().map(a => a.id));
    const templates = store.data.recurring.filter(r => r.active !== false);
    // A template's payee only counts as scheduled on that template's own account, so a weekly
    // Tesco shop on the joint account doesn't hide every Tesco spend on the card
    const templated = new Set(templates.filter(r => r.type !== 'transfer' && r.payee).map(r => `${r.accountId}|${normalisePayee(r.payee)}`));
    const pairs = new Set(templates.filter(r => r.type === 'transfer').flatMap(r => [`${r.fromAccountId}|${r.toAccountId}`, `${r.toAccountId}|${r.fromAccountId}`]));
    const flows = [];
    const dates = [];
    for (const account of past) {
      const accrues = account.type === 'mortgage' && Number(account.interestRate) > 0;
      const txs = [...txsOf(account)].sort((a, b) => a.date.localeCompare(b.date));
      const life = lifetime(account, txs);
      const borrowed = owed && (account.type === 'loan' || account.type === 'mortgage');
      if (account.openedOn && account.openedOn <= today && !borrowed) flows.push({ date: account.openedOn, pence: toPence(account.startingBalance) });
      const offset = measure === 'worth' && BOUGHT_TYPES.includes(account.type) ? valueOffset(account, balanceOn(account, today)) : 0;
      if (offset && life.valueFrom && life.valueFrom <= today) flows.push({ date: life.valueFrom, pence: offset });
      if (offset && life.valueUntil && life.valueUntil <= today) flows.push({ date: life.valueUntil, pence: -offset });
      for (const tx of txs) {
        if (tx.date > today) continue;
        dates.push(tx.date);
        if (tx.autoInterest || tx.recurringId) continue;
        if (tx.transferId) {
          const other = tx.transferAccountId;
          if (chosen.has(other) || !live.has(other) || pairs.has(`${account.id}|${other}`)) continue;
          if (borrowed && tx.amount < 0) continue;
        } else if (tx.categoryId === TRANSFER_CATEGORY_ID || accrues || templated.has(`${account.id}|${normalisePayee(tx.payee)}`)) {
          continue;
        }
        flows.push({ date: tx.date, pence: toPence(tx.amount) });
      }
    }
    return typicalMonth(flows, today, historyStart(dates));
  }

  // The chosen accounts' figure (a MEASURES name) from today to `months` ahead, with a likely range.
  // Every open account is played forward, so a loan that one of them pays off is known to end:
  // - transactions already entered with a later date, on their dates
  // - recurring payments and transfers (paused or finished ones are left out). A transfer into a
  //   loan, mortgage or card stops once it's paid off.
  // - mortgage interest on what's still owed, on its interest day
  // - plus the chosen accounts' typical unscheduled month, spread evenly over the days, with a likely
  //   range that holds about 80% of outcomes (see forecast-model.js)
  function forecast(accounts, today, months, measure = 'worth', past = accounts) {
    const end = addMonths(today, months);
    const open = activeAccounts();
    const typeOf = new Map(open.map(a => [a.id, a.type]));
    const balances = new Map(open.map(a => [a.id, balanceOn(a, today)]));
    const chosenDebt = accounts.filter(a => DEBT_TYPES.includes(a.type)).map(a => a.id);
    // Values owned today stay as they are
    let offsets = 0;
    for (const account of accounts) {
      const f = figures(account, [today], today);
      offsets += f.worth[0] - f.balance[0];
    }

    const events = [];
    for (const account of open) {
      for (const tx of txsOf(account)) {
        if (tx.date > today && tx.date <= end) events.push({ date: tx.date, to: account.id, pence: toPence(tx.amount) });
      }
    }
    // Overdue occurrences that haven't been logged are still to come, so they count from the next point
    for (const t of store.data.recurring) {
      if (t.active === false || t.paused) continue;
      for (const { date } of upcoming(t, end, { countFrom: today })) {
        if (t.type === 'transfer') events.push({ date, from: t.fromAccountId, to: t.toAccountId, pence: toPence(Math.abs(t.amount)), transfer: true });
        else events.push({ date, to: t.accountId, pence: toPence(t.amount) });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date));

    const mortgages = open
      .filter(a => a.type === 'mortgage' && Number(a.interestRate) > 0)
      .map(a => ({ id: a.id, monthlyRate: Number(a.interestRate) / 100 / 12, day: a.interestDay || undefined, next: addMonths(a.lastInterestAccrual || today, 1, a.interestDay || undefined) }));

    const move = (id, pence) => { if (balances.has(id)) balances.set(id, balances.get(id) + pence); };
    function apply(ev) {
      if (!ev.transfer) return move(ev.to, ev.pence);
      let pence = ev.pence;
      // Paying into a debt stops once nothing is owed
      if (balances.has(ev.to) && DEBT_TYPES.includes(typeOf.get(ev.to))) pence = Math.max(0, Math.min(pence, -balances.get(ev.to)));
      move(ev.from, -pence);
      move(ev.to, pence);
    }

    // Closed accounts only matter to net worth, where a car sold and its value going cancel out;
    // their old repayments won't happen again
    const everyday = unscheduled(accounts, today, measure, measure === 'worth' ? past : accounts);
    const daily = everyday.monthly / MONTH_DAYS;
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
          apply(ev);
          e++;
        }
      }
      let scheduled = measure === 'worth' ? offsets : 0;
      if (measure === 'debt') {
        for (const id of chosenDebt) scheduled += Math.max(0, -balances.get(id));
      } else {
        for (const account of accounts) scheduled += balances.get(account.id);
      }
      const elapsed = diffDays(today, date);
      // Unscheduled spending on a card adds to what's owed
      let value = scheduled + (measure === 'debt' ? -1 : 1) * daily * elapsed;
      if (measure === 'debt') value = Math.max(0, value);
      const band = likelyRange(everyday, elapsed);
      const lower = measure === 'debt' ? Math.max(0, value - band) : value - band;
      points.push({ date, value: round2(value / 100), lower: round2(lower / 100), upper: round2((value + band) / 100) });
    }
    return points;
  }

  // A chart line. With `card` it's that dashboard card's sum (see CARDS); otherwise the chosen
  // accounts' `measure` (worth by default). Choosing every account is the net worth card.
  function series({ accountIds, card = null, measure = null, range = '1m', forecastRange = '0' }) {
    const r = rangeOf(range);
    if (!r) throw badRequest('Unknown range');
    let forecastMonths = 0;
    if (forecastRange && forecastRange !== '0') {
      const f = rangeOf(forecastRange);
      if (!f) throw badRequest('Unknown forecast range');
      forecastMonths = Math.max(1, f.months || 0);
    }
    if (card && !Object.hasOwn(CARDS, card)) throw badRequest('Unknown card');
    if (measure && !MEASURES.includes(measure)) throw badRequest('Unknown measure');
    let accounts = selected(accountIds);
    if (!card && !measure && accounts.length > 0 && accounts.length === activeAccounts().length) card = 'netWorth';
    let pastAccounts = accounts;
    if (card) {
      accounts = cardAccounts(card);
      pastAccounts = cardAccounts(card, { archived: true });
      measure = CARDS[card].measure;
    }
    measure = measure || 'worth';
    const today = clock.today();
    const from = r.days ? addDays(today, -r.days) : addMonths(today, -r.months);
    const result = { history: history(pastAccounts, from, today, today, measure), forecast: [] };
    if (forecastMonths) result.forecast = forecast(accounts, today, forecastMonths, measure, pastAccounts);
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
