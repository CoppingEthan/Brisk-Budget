import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx } from '../helpers/server.js';

describe('dashboard: summary', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('adds up cash, savings, debt and net worth', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 100 });
    await makeTx(s, bank.id, { amount: -100 }); // a £0 balance must count as £0, not the starting balance
    await makeAccount(s, { name: 'Savings', type: 'savings', startingBalance: 500 });
    const card = await makeAccount(s, { name: 'Card', type: 'credit', startingBalance: 0 });
    await makeTx(s, card.id, { amount: -250 });
    await makeAccount(s, { name: 'Overpaid card', type: 'credit', startingBalance: 20 });
    await makeAccount(s, { name: 'Home', type: 'mortgage', startingBalance: -150000, assetValue: 250000 });
    await makeAccount(s, { name: 'Car', type: 'asset', startingBalance: 0, assetValue: 8000 });
    const closed = await makeAccount(s, { name: 'Closed', startingBalance: 999 });
    await s.ok.del(`/api/accounts/${closed.id}`);

    const summary = await s.ok.get('/api/dashboard/summary');
    assert.deepEqual(summary, {
      cash: 0,
      savings: 500,
      debt: 150250, // only money actually owed: the overpaid card is not negative debt
      netWorth: 108270 // 0 + 500 - 250 + 20 + (250000 - 150000) + 8000
    });
  });
});

describe('dashboard: balance history', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'History', startingBalance: 100 });
    await makeTx(s, acc.id, { date: '2026-09-01', amount: 50 }); // before the range: counted from the start
    await makeTx(s, acc.id, { date: '2026-09-20', amount: -30 });
    await makeTx(s, acc.id, { date: '2026-10-12', amount: -10 });
    await makeTx(s, acc.id, { date: '2026-10-15', amount: 999 }); // future-dated: not history yet
  });
  after(async () => { await s.close(); });

  it('gives the end-of-day balance for every day in the range', async () => {
    const { history, forecast } = await s.ok.get(`/api/dashboard/series?range=1m&accounts=${acc.id}`);
    assert.deepEqual(forecast, []);
    assert.equal(history.length, 31);
    assert.equal(history[0].date, '2026-09-12');
    assert.equal(history.at(-1).date, '2026-10-12');
    const at = Object.fromEntries(history.map(p => [p.date, p.value]));
    assert.equal(at['2026-09-12'], 150);
    assert.equal(at['2026-09-19'], 150);
    assert.equal(at['2026-09-20'], 120);
    assert.equal(at['2026-10-11'], 120);
    assert.equal(at['2026-10-12'], 110);
  });

  it('thins out long ranges but always ends on today', async () => {
    const { history } = await s.ok.get(`/api/dashboard/series?range=5y&accounts=${acc.id}`);
    assert.ok(history.length <= 371, `${history.length} points`);
    assert.equal(history[0].date, '2021-10-12');
    assert.equal(history.at(-1).date, '2026-10-12');
    assert.equal(history.at(-1).value, 110);
    assert.equal(history[0].value, 100);
  });

  it('includes asset values and rejects unknown ranges', async () => {
    const house = await makeAccount(s, { name: 'House', type: 'asset', assetValue: 200000 });
    const { history } = await s.ok.get(`/api/dashboard/series?range=1w&accounts=${acc.id},${house.id}`);
    assert.equal(history.length, 8);
    assert.equal(history.at(-1).value, 200110);
    assert.equal((await s.get('/api/dashboard/series?range=2d')).status, 400);
    assert.equal((await s.get('/api/dashboard/series?range=1m&forecast=10y')).status, 400);
  });
});

describe('dashboard: forecast', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('includes recurring payments and mortgage interest on the remaining balance', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 1000 });
    const mortgage = await makeAccount(s, { name: 'Mortgage', type: 'mortgage', startingBalance: -100000, interestRate: 6 });
    await s.ok.post('/api/recurring', { accountId: bank.id, payee: 'Rent', amount: -100, startDate: '2026-10-20' });
    const paused = await s.ok.post('/api/recurring', { accountId: bank.id, payee: 'Paused', amount: -5000, startDate: '2026-10-20' });
    await s.ok.put(`/api/recurring/${paused.id}`, { paused: true });

    const { forecast } = await s.ok.get(`/api/dashboard/series?range=1w&forecast=3m&accounts=${bank.id},${mortgage.id}`);
    const at = Object.fromEntries(forecast.map(p => [p.date, p]));
    assert.equal(forecast[0].date, '2026-10-12');
    assert.equal(forecast.at(-1).date, '2027-01-12');
    assert.equal(at['2026-10-12'].value, -99000);
    assert.equal(at['2026-10-19'].value, -99000);
    assert.equal(at['2026-10-20'].value, -99100, 'rent leaves the bank on the 20th');
    assert.equal(at['2026-11-12'].value, -99600, '0.5% interest on £100,000');
    assert.equal(at['2026-11-20'].value, -99700);
    assert.equal(at['2026-12-12'].value, -100202.5, '0.5% of £100,500');
    assert.equal(at['2027-01-12'].value, -100807.51, '0.5% of £101,002.50, rounded to the penny');
    for (const p of forecast) {
      assert.equal(p.lower, p.value, 'no everyday spending, so no uncertainty band');
      assert.equal(p.upper, p.value);
    }
  });

  it('projects everyday spending as a drift with a widening band', async () => {
    const spender = await makeAccount(s, { name: 'Spender', startingBalance: 5050 });
    // History from before the three-month window, so the whole window counts
    await makeTx(s, spender.id, { date: '2026-05-01', amount: -50, payee: 'Long ago' });
    await makeTx(s, spender.id, { date: '2026-07-20', amount: -100, payee: 'Shop A' });
    await makeTx(s, spender.id, { date: '2026-08-20', amount: -200, payee: 'Shop B' });
    await makeTx(s, spender.id, { date: '2026-09-20', amount: -600, payee: 'Shop C' });
    const { forecast } = await s.ok.get(`/api/dashboard/series?range=1w&forecast=1m&accounts=${spender.id}`);
    assert.equal(forecast[0].value, 4100);
    const last = forecast.at(-1);
    assert.equal(last.date, '2026-11-12');
    assert.equal(last.value, 3796.74); // £900 over the last 92 days, projected 31 days
    assert.ok(last.lower < last.value && last.value < last.upper);
    assert.ok(Math.abs((last.upper - last.value) - (last.value - last.lower)) < 0.02, 'band is symmetric');
    const mid = forecast[10];
    assert.ok(mid.upper - mid.lower < last.upper - last.lower, 'band widens over time');
  });
});

describe('dashboard: money in and out (flows)', () => {
  let s;
  before(async () => {
    s = await freshServer();
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 0 });
    const other = await makeAccount(s, { name: 'Other' });
    const add = (fields) => makeTx(s, bank.id, { date: '2026-09-15', ...fields });
    await add({ amount: 2000, payee: 'Employer', categoryId: 'sub-salary' });
    await add({ amount: 15, payee: 'Cashback', categoryId: 'cat-income' });
    await add({ amount: -100, payee: 'Tesco', categoryId: 'sub-groceries' });
    await add({ amount: 30, payee: 'Tesco refund', categoryId: 'sub-groceries' });
    await add({ amount: -20, payee: 'Shirt', categoryId: 'sub-clothing' });
    await add({ amount: 50, payee: 'Bigger refund', categoryId: 'cat-shopping' });
    await add({ amount: 10, payee: 'Mystery money', categoryId: 'cat-uncategorized' });
    await add({ amount: -5, payee: 'Mystery spend', categoryId: 'cat-uncategorized' });
    await add({ amount: -999, payee: 'Out of range', categoryId: 'sub-rent', date: '2026-08-31' });
    await s.ok.post('/api/transfers', { fromAccountId: bank.id, toAccountId: other.id, amount: 400, date: '2026-09-15' });
    const archived = await makeAccount(s, { name: 'Archived' });
    await makeTx(s, archived.id, { amount: -777, date: '2026-09-15', categoryId: 'sub-fuel' });
    await s.ok.del(`/api/accounts/${archived.id}`);
  });
  after(async () => { await s.close(); });

  it('groups income by Income subcategory and spending by top-level category, netting refunds', async () => {
    const flows = await s.ok.get('/api/dashboard/flows?from=2026-09-01&to=2026-09-30');
    const income = Object.fromEntries(flows.income.map(r => [r.name, r.amount]));
    const expenses = Object.fromEntries(flows.expenses.map(r => [r.name, r.amount]));
    assert.deepEqual(income, {
      Salary: 2000,
      'Shopping (refunds)': 30,
      'Other income': 15,
      'Uncategorised income': 10
    });
    assert.deepEqual(expenses, { 'Food & Drink': 70, Uncategorized: 5 });
    assert.equal(flows.totalIncome, 2055);
    assert.equal(flows.totalExpenses, 75);
    assert.equal(flows.net, 1980);
    assert.deepEqual(flows.income.map(r => r.amount), [...flows.income.map(r => r.amount)].sort((a, b) => b - a), 'largest first');
  });

  it('needs valid dates', async () => {
    assert.equal((await s.get('/api/dashboard/flows?from=2026-09-01')).status, 400);
    assert.equal((await s.get('/api/dashboard/flows?from=yesterday&to=2026-09-30')).status, 400);
    const empty = await s.ok.get('/api/dashboard/flows?from=2020-01-01&to=2020-12-31');
    assert.deepEqual(empty, { income: [], expenses: [], totalIncome: 0, totalExpenses: 0, net: 0 });
  });
});

describe('dashboard: trend for the summary cards', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('gives 91 daily points whose last values match the summary', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 500 });
    const card = await makeAccount(s, { name: 'Card', type: 'credit', startingBalance: 0 });
    await makeTx(s, bank.id, { date: '2026-09-01', amount: 200 });
    await makeTx(s, card.id, { date: '2026-10-01', amount: -80 });
    const trend = await s.ok.get('/api/dashboard/trend');
    const summary = await s.ok.get('/api/dashboard/summary');
    assert.equal(trend.dates.length, 91);
    assert.equal(trend.dates.at(-1), '2026-10-12');
    for (const key of ['netWorth', 'cash', 'savings', 'debt']) assert.equal(trend[key].at(-1), summary[key], key);
    assert.equal(trend.cash[0], 500);
    assert.equal(trend.debt[trend.dates.indexOf('2026-09-30')], 0);
    assert.equal(trend.debt[trend.dates.indexOf('2026-10-01')], 80);
  });
});
