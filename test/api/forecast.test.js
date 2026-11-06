// Regressions for the dashboard's "now", history and forecast maths: they must agree with each
// other and with the real mortgage accrual.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock } from '../../server/lib/clock.js';
import { addMonths, diffDays } from '../../public/js/shared/dates.js';
import { freshServer, makeAccount, makeTx, balanceOf } from '../helpers/server.js';

const byDate = (points) => Object.fromEntries(points.map(p => [p.date, p.value]));
const seriesFor = (s, ids, range = '1m', forecast = '0') => s.ok.get(`/api/dashboard/series?range=${range}&forecast=${forecast}&accounts=${ids.join(',')}`);

// The amortisation table: each month's interest is on the balance going into its interest day,
// rounded to the penny, so a payment on the interest day itself counts from the next month.
function amortise(owed, rate, payment, interestDates, paymentDates) {
  const steps = [...interestDates.map(date => ({ date, interest: true })), ...paymentDates.map(date => ({ date, interest: false }))]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.interest ? -1 : 1));
  let pence = Math.round(owed * 100);
  for (const step of steps) pence += step.interest ? Math.round(pence * (rate / 100 / 12)) : Math.round(payment * 100);
  return pence / 100;
}
const monthly = (first, count) => Array.from({ length: count }, (_, i) => addMonths(first, i));

describe('dashboard: cards, history and forecast agree on today', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('leaves a future-dated bill out of today and lands it on its own date', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 1000 });
    await makeTx(s, bank.id, { date: '2026-10-20', amount: -600, payee: 'Bill' });

    const summary = await s.ok.get('/api/dashboard/summary');
    assert.equal(summary.cash, 1000);
    assert.equal(summary.netWorth, 1000);

    const { history, forecast } = await seriesFor(s, [bank.id], '1m', '1m');
    assert.equal(history.at(-1).date, '2026-10-12');
    assert.equal(history.at(-1).value, 1000);
    assert.equal(forecast[0].date, '2026-10-12');
    assert.equal(forecast[0].value, 1000, 'the forecast starts where the history ends');
    const at = byDate(forecast);
    assert.equal(at['2026-10-19'], 1000);
    assert.equal(at['2026-10-20'], 400, 'the bill comes off on the 20th, not today');
  });
});

describe('dashboard: forecast keeps overdue payments that are still to be approved', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('counts an overdue occurrence straight after today instead of dropping it', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 1000 });
    await s.ok.post('/api/recurring', { accountId: bank.id, payee: 'Rent', amount: -500, startDate: '2026-10-10' });
    const { history, forecast } = await seriesFor(s, [bank.id], '1w', '1m');
    assert.equal(history.at(-1).value, 1000);
    assert.equal(forecast[0].value, 1000, 'today is still today');
    const at = byDate(forecast);
    assert.equal(at['2026-10-13'], 500, 'the overdue rent is still to go out');
    assert.equal(at['2026-11-09'], 500);
    assert.equal(at['2026-11-10'], 0, 'then next month as normal');
  });

  it("doesn't let a long-overdue daily payment cut a five-year forecast short", async () => {
    const bank = await makeAccount(s, { name: 'Daily', startingBalance: 100000 });
    await s.ok.post('/api/recurring', { accountId: bank.id, payee: 'Paper', amount: -5, startDate: '2025-12-15', frequency: { type: 'days', interval: 1 } });
    const { forecast } = await seriesFor(s, [bank.id], '1w', '5y');
    const end = forecast.at(-1);
    assert.equal(end.date, '2031-10-12');
    const occurrences = diffDays('2025-12-15', '2031-10-12') + 1;
    assert.equal(end.value, 100000 - 5 * occurrences);
  });
});

describe('dashboard: mortgage interest in the forecast matches the real accrual', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('charges interest before a payment made on the interest day, even after time offline', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 50000 });
    const home = await makeAccount(s, { name: 'Home', type: 'mortgage', startingBalance: -200000, interestRate: 4.5 });
    await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: bank.id, toAccountId: home.id, amount: 1111.66, startDate: '2026-11-12', autoLog: true });

    const expected = amortise(-200000, 4.5, 1111.66, monthly('2026-11-12', 12), monthly('2026-11-12', 12));
    const { forecast } = await seriesFor(s, [home.id], '1w', '1y');
    assert.equal(forecast.at(-1).date, '2027-10-12');
    assert.equal(forecast.at(-1).value, expected, 'forecast matches the amortisation table');

    // The server was off for a year: on start-up the payments are logged before the interest
    clock.set('2027-10-12T12:00:00Z');
    await s.ok.get('/api/bootstrap');
    assert.equal(await balanceOf(s, home.id), expected, 'real accrual matches it too');
  });

  it('keeps a five-year forecast (five-day steps) on the interest dates', async () => {
    // Payments two days after the interest day often share a five-day step with it
    clock.set('2026-10-12T12:00:00Z');
    const bank = await makeAccount(s, { name: 'Bank 2', startingBalance: 500000 });
    const home = await makeAccount(s, { name: 'Home 2', type: 'mortgage', startingBalance: -200000, interestRate: 4.5 });
    await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: bank.id, toAccountId: home.id, amount: 1111.66, startDate: '2026-11-14' });

    const { forecast } = await seriesFor(s, [home.id], '1w', '5y');
    assert.ok(forecast.length < 400, 'thinned out');
    assert.equal(forecast.at(-1).date, '2031-10-12');
    assert.equal(forecast.at(-1).value, amortise(-200000, 4.5, 1111.66, monthly('2026-11-12', 60), monthly('2026-11-14', 59)));
  });
});

describe('dashboard: net-worth history across an archived account', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it("doesn't jump when money moved out of an account that was then archived", async () => {
    const current = await makeAccount(s, { name: 'Current', startingBalance: 1000 });
    const old = await makeAccount(s, { name: 'Old saver', type: 'savings', startingBalance: 5000 });
    await s.ok.post('/api/transfers', { fromAccountId: old.id, toAccountId: current.id, amount: 5000, date: '2026-10-01' });
    const leftover = await makeAccount(s, { name: 'Leftover', startingBalance: 300 });
    await s.ok.del(`/api/accounts/${old.id}`);
    await s.ok.del(`/api/accounts/${leftover.id}`);

    const { history } = await seriesFor(s, [current.id], '1m');
    const at = byDate(history);
    assert.equal(at['2026-09-30'], 6300, 'archived accounts count until they were archived');
    assert.equal(at['2026-10-01'], 6300, 'the transfer moves money, it adds none');
    assert.equal(at['2026-10-12'], 6000, 'archived today, so not part of today');
    const summary = await s.ok.get('/api/dashboard/summary');
    assert.equal(history.at(-1).value, summary.netWorth);
  });
});

describe('dashboard: everyday-spending drift', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('averages a new account over the days it has existed', async () => {
    clock.set('2026-10-02T09:00:00Z');
    const fresh = await makeAccount(s, { name: 'New', startingBalance: 5000 });
    for (let d = 2; d <= 11; d++) await makeTx(s, fresh.id, { date: `2026-10-${String(d).padStart(2, '0')}`, amount: -100, payee: `Shop ${d}` });
    clock.set('2026-10-12T12:00:00Z');
    const { forecast } = await seriesFor(s, [fresh.id], '1w', '1m');
    assert.equal(forecast[0].value, 4000);
    assert.equal(forecast.at(-1).value, 4000 - 31 * 100, '£100 a day over the 10 days, not over three months');
  });

  it("only treats a template's payee as scheduled on that template's account", async () => {
    const joint = await makeAccount(s, { name: 'Joint', startingBalance: 0 });
    const card = await makeAccount(s, { name: 'Card', type: 'credit', startingBalance: 0 });
    await s.ok.post('/api/recurring', { accountId: joint.id, payee: 'Tesco', amount: -10, startDate: '2026-10-16', frequency: { type: 'weeks', interval: 1 } });
    await makeTx(s, card.id, { date: '2026-05-01', amount: -1, payee: 'Older' });
    for (const date of ['2026-07-20', '2026-08-20', '2026-09-20']) await makeTx(s, card.id, { date, amount: -150, payee: 'TESCO' });
    const { forecast } = await seriesFor(s, [card.id], '1w', '3m');
    assert.ok(forecast.at(-1).value < forecast[0].value - 200, 'card spending at Tesco still drifts the card down');
  });
});

describe('dashboard: unknown ranges', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('rejects names that only exist on Object.prototype', async () => {
    for (const q of ['range=constructor', 'range=__proto__', 'range=toString', 'range=1m&forecast=constructor', 'range=1m&forecast=hasOwnProperty']) {
      assert.equal((await s.get(`/api/dashboard/series?${q}`)).status, 400, q);
    }
    assert.equal((await s.get('/api/dashboard/series?range=1m&forecast=1w')).status, 200);
  });
});

describe('dashboard: account values', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it("uses an investment's current value instead of its balance, and keeps equity for mortgages", async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 2000 });
    const isa = await makeAccount(s, { name: 'ISA', type: 'investment', startingBalance: 15750, assetValue: 17550 });
    const home = await makeAccount(s, { name: 'Home', type: 'mortgage', startingBalance: -150000, assetValue: 250000 });
    const car = await makeAccount(s, { name: 'Car', type: 'asset', startingBalance: 400, assetValue: 8000 });
    await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: bank.id, toAccountId: isa.id, amount: 250, startDate: '2026-10-20' });

    const summary = await s.ok.get('/api/dashboard/summary');
    assert.deepEqual(summary, {
      cash: 2000, // other assets are not cash
      savings: 17550,
      debt: 150000,
      netWorth: 2000 + 17550 + (250000 - 150000) + 8000
    });

    const ids = [bank.id, isa.id, home.id, car.id];
    const { history, forecast } = await seriesFor(s, ids, '1m', '1m');
    assert.equal(history.at(-1).value, summary.netWorth, "the chart's latest point is the Net worth card");
    assert.equal(forecast[0].value, summary.netWorth);
    assert.equal(byDate(forecast)['2026-10-20'], summary.netWorth, 'paying into the ISA moves money, it adds none');

    const isaOnly = await seriesFor(s, [isa.id], '1w', '1m');
    assert.equal(isaOnly.history.at(-1).value, 17550);
    assert.equal(byDate(isaOnly.forecast)['2026-10-20'], 17800, 'contributions add to the value');
  });
});

describe('dashboard: money flow labels', () => {
  let s;
  before(async () => {
    s = await freshServer();
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 0 });
    const earnings = await s.ok.post('/api/categories', { name: 'Earnings' });
    const add = (fields) => makeTx(s, bank.id, { date: '2026-09-15', ...fields });
    await add({ amount: 2000, payee: 'Employer', categoryId: 'sub-salary' });
    await add({ amount: -300, payee: 'Employer overpayment', categoryId: 'sub-salary' });
    await add({ amount: 500, payee: 'Contractor', categoryId: earnings.id });
    await add({ amount: 40, payee: 'Dividend', categoryId: 'sub-investments' });
    await add({ amount: -50, payee: 'Benefit repaid', categoryId: 'sub-benefits' });
  });
  after(async () => { await s.close(); });

  it('nets income paid back and names money in outside Income plainly', async () => {
    const flows = await s.ok.get('/api/dashboard/flows?from=2026-09-01&to=2026-09-30');
    assert.deepEqual(Object.fromEntries(flows.income.map(r => [r.name, r.amount])), {
      Salary: 1700,
      Earnings: 500,
      'Savings & Investments': 40
    });
    assert.deepEqual(Object.fromEntries(flows.expenses.map(r => [r.name, r.amount])), { 'Benefits (paid back)': 50 });
    assert.ok(flows.income.every(r => r.color === '#34d399'));
    assert.equal(flows.net, 2190);
  });
});

describe('dashboard: what the forecast counts as everyday money', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it("doesn't grow a card's debt forever when it's paid off from a bank account each month", async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 5000 });
    const card = await makeAccount(s, { name: 'Card', type: 'credit', startingBalance: 0 });
    for (const month of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      await makeTx(s, card.id, { date: `${month}-10`, amount: -500, payee: `Shop ${month}` });
      await s.ok.post('/api/transfers', { fromAccountId: bank.id, toAccountId: card.id, amount: 500, date: `${month}-25` });
    }
    await makeTx(s, card.id, { date: '2026-10-10', amount: -500, payee: 'Shop 2026-10' });
    const debt = byDate((await s.ok.get(`/api/dashboard/series?range=1w&forecast=1y&accounts=${card.id}&measure=debt`)).forecast);
    assert.equal(debt['2026-10-12'], 500);
    assert.ok(Math.abs(debt['2027-10-12'] - 500) < 50, `repayments keep the card level, not £6,500 owed (${debt['2027-10-12']})`);
    // With both chosen, the repayments move money and the spending is what's left
    const both = byDate((await seriesFor(s, [bank.id, card.id], '1w', '3m')).forecast);
    const fall = both['2026-10-12'] - both['2027-01-12'];
    assert.ok(fall > 1350 && fall < 1650, `£500 a month of spending (fell £${fall})`);
  });
});

describe('dashboard: loans, mortgages and closed accounts in the forecast', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('stops paying a loan once it is cleared', async () => {
    const bank = await makeAccount(s, { name: 'Bank', startingBalance: 2000 });
    const loan = await makeAccount(s, { name: 'Loan', type: 'loan', startingBalance: -500 });
    await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: bank.id, toAccountId: loan.id, amount: 200, startDate: '2026-10-20' });
    const cash = byDate((await seriesFor(s, [bank.id], '1w', '6m')).forecast);
    assert.equal(cash['2027-04-12'], 1500, '£200, £200 and then the last £100: £500 in all');
    const owed = byDate((await s.ok.get(`/api/dashboard/series?range=1w&forecast=6m&accounts=${loan.id}&measure=debt`)).forecast);
    assert.equal(owed['2026-10-20'], 300);
    assert.equal(owed['2026-11-20'], 100);
    assert.equal(owed['2026-12-20'], 0, 'the third payment is only the £100 left');
  });

  it("counts a mortgage's interest once, not again from interest entered by hand", async () => {
    const mortgage = await makeAccount(s, { name: 'Mortgage', type: 'mortgage', startingBalance: -120000, interestRate: 6 });
    for (const date of ['2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']) {
      await makeTx(s, mortgage.id, { date, amount: -600, payee: 'Interest', categoryId: 'sub-rent' });
    }
    const { forecast } = await seriesFor(s, [mortgage.id], '1w', '3m');
    const owed = -forecast.at(-1).value;
    const start = -forecast[0].value;
    // Three months of 0.5% on about £122,400: about £1,840, not £3,640 with the hand-entered interest too
    assert.ok(owed - start > 1700 && owed - start < 2000, String(owed - start));
  });

  it('leaves out payments to an account that has since closed', async () => {
    const bank = await makeAccount(s, { name: 'Current', startingBalance: 3000 });
    const old = await makeAccount(s, { name: 'Old loan', type: 'loan', startingBalance: -1000 });
    for (const date of ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']) {
      await s.ok.post('/api/transfers', { fromAccountId: bank.id, toAccountId: old.id, amount: 200, date });
    }
    await s.ok.del(`/api/accounts/${old.id}`, { closedOn: '2026-10-01' });
    const { forecast } = await seriesFor(s, [bank.id], '1w', '6m');
    assert.equal(forecast.at(-1).value, forecast[0].value, 'the loan is paid off, so its £200 a month has stopped');
  });
});

describe('dashboard: buying a car on a loan, in the forecast', () => {
  let s;
  let bank;
  let loan;
  before(async () => {
    s = await freshServer();
    bank = await makeAccount(s, { name: 'Bank', startingBalance: 30000 });
    // Half a year of steady spending, about £1,000 a month
    for (const month of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
      await makeTx(s, bank.id, { date: `${month}-15`, amount: -1000, payee: `Shops ${month}` });
    }
    // Then a £20,000 car: £15,000 borrowed (with £2,000 interest owed on top) and £5,000 paid from the bank
    loan = await makeAccount(s, { name: 'Car loan', type: 'loan', startingBalance: -2000, assetValue: 20000, openedOn: '2026-09-28', valueFrom: '2026-10-01' });
    await s.ok.post('/api/transfers', { fromAccountId: loan.id, toAccountId: bank.id, amount: 15000, date: '2026-09-28' });
    await makeTx(s, bank.id, { date: '2026-10-01', amount: -20000, payee: 'Car dealer' });
    await makeTx(s, bank.id, { date: '2026-10-05', amount: -1000, payee: 'Shops 2026-10' });
  });
  after(async () => { await s.close(); });

  it("treats buying the car as swapping money for a car, not as a month's spending", async () => {
    const { forecast } = await s.ok.get('/api/dashboard/series?card=netWorth&range=1w&forecast=6m');
    const fall = forecast[0].value - forecast.at(-1).value;
    assert.ok(fall > 5000 && fall < 7500, `about £1,000 a month, not thousands more (fell £${fall})`);
    const last = forecast.at(-1);
    assert.ok(last.upper - last.lower < 20000, `a likely range from ordinary months, not tens of thousands either side (${last.upper - last.lower})`);
  });

  it("doesn't treat taking out the loan as a habit of borrowing", async () => {
    const { forecast } = await s.ok.get('/api/dashboard/series?card=debt&range=1w&forecast=6m');
    assert.equal(forecast[0].value, 17000);
    assert.equal(forecast.at(-1).value, 17000, 'no repayments set up and no everyday borrowing: the debt stays put');
  });
});
