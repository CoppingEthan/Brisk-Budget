// Charts of the past around buying and selling what a loan or mortgage paid for. A car or house
// value counts only while it was owned, an account only from the day it opened until it closed,
// and the debt card's chart is what's owed. The clock is pinned to 2026-10-12.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx } from '../helpers/server.js';

const byDate = (points) => Object.fromEntries(points.map(p => [p.date, p.value]));
const card = async (s, name, range = '1m') => byDate((await s.ok.get(`/api/dashboard/series?card=${name}&range=${range}`)).history);
const allAccounts = async (s, range = '1m') => byDate((await s.ok.get(`/api/dashboard/series?range=${range}`)).history);

describe('history: buying a car on a loan', () => {
  let s;
  let bank;
  let loan;
  before(async () => {
    s = await freshServer();
    bank = await makeAccount(s, { name: 'Current', startingBalance: 5000 });
    // A loan taken out on 20 Sept (its £2,000 of interest owed from the start), paying for a
    // £20,000 car bought on 25 Sept
    loan = await makeAccount(s, { name: 'Car loan', type: 'loan', startingBalance: -2000, assetValue: 20000, openedOn: '2026-09-20', valueFrom: '2026-09-25' });
    await s.ok.post('/api/transfers', { fromAccountId: loan.id, toAccountId: bank.id, amount: 15000, date: '2026-09-20' });
    await makeTx(s, bank.id, { date: '2026-09-25', amount: -19500, payee: 'Car dealer' });
  });
  after(async () => { await s.close(); });

  it("doesn't count the loan before it was taken out, or the car before it was bought", async () => {
    const at = await allAccounts(s);
    assert.equal(at['2026-09-19'], 5000, 'before the loan: just the bank');
    assert.equal(at['2026-09-20'], 3000, 'borrowing moves money; only the interest owed lowers net worth');
    assert.equal(at['2026-09-24'], 3000, 'the borrowed money sits in the bank until the car is bought');
    assert.equal(at['2026-09-25'], 3500, 'buying the car swaps £19,500 of cash for a £20,000 car');
    assert.equal(at['2026-10-12'], (await s.ok.get('/api/dashboard/summary')).netWorth);
  });

  it("draws the debt card as what's owed", async () => {
    const at = await card(s, 'debt');
    assert.equal(at['2026-09-19'], 0);
    assert.equal(at['2026-09-20'], 17000);
    assert.equal(at['2026-10-12'], (await s.ok.get('/api/dashboard/summary')).debt);
    const trend = await s.ok.get('/api/dashboard/trend');
    assert.equal(trend.debt[trend.dates.indexOf('2026-09-20')], 17000, 'the card trend uses the same sum');
    assert.equal(trend.netWorth[trend.dates.indexOf('2026-09-24')], 3000);
  });

  it("gives a loan's own balance without its value when asked", async () => {
    const { history } = await s.ok.get(`/api/dashboard/series?accounts=${loan.id}&range=1m&measure=balance`);
    const at = byDate(history);
    assert.equal(at['2026-09-19'], 0, 'not opened yet');
    assert.equal(at['2026-09-25'], -17000, 'the balance owed, with no car value added');
  });
});

describe('history: selling a car and closing its loan', () => {
  let s;
  let bank;
  let loan;
  before(async () => {
    s = await freshServer();
    bank = await makeAccount(s, { name: 'Current', startingBalance: 1000 });
    loan = await makeAccount(s, { name: 'Old car loan', type: 'loan', startingBalance: -5000, assetValue: 8000 });
    // Sold for £8,200 on 15 Sept, the loan paid off (£100 too much, refunded on 30 Sept)
    await makeTx(s, bank.id, { date: '2026-09-15', amount: 8200, payee: 'Car buyer', categoryId: 'sub-side-income' });
    await s.ok.post('/api/transfers', { fromAccountId: bank.id, toAccountId: loan.id, amount: 5100, date: '2026-09-15' });
    await s.ok.post('/api/transfers', { fromAccountId: loan.id, toAccountId: bank.id, amount: 100, date: '2026-09-30' });
    // Tidied away today, but it closed the day the car was sold
    const archived = await s.ok.del(`/api/accounts/${loan.id}`, { closedOn: '2026-09-15' });
    assert.equal(archived.success, true);
  });
  after(async () => { await s.close(); });

  it('drops the car on the day it was sold, not the day the account was archived', async () => {
    const at = await allAccounts(s);
    assert.equal(at['2026-09-14'], 4000, '£1,000 in the bank plus £3,000 equity in the car');
    assert.equal(at['2026-09-15'], 4200, 'sold for £200 more than it was valued at');
    assert.equal(at['2026-09-30'], 4200, 'the refund of the overpayment moves money, it adds none');
    assert.equal(at['2026-10-11'], 4200);
    assert.equal(at['2026-10-12'], 4200, 'no drop on the day it was archived');
    assert.equal(at['2026-10-12'], (await s.ok.get('/api/dashboard/summary')).netWorth);
  });

  it('keeps the closed loan in the debt chart until it was paid off', async () => {
    const at = await card(s, 'debt');
    assert.equal(at['2026-09-14'], 5000);
    assert.equal(at['2026-09-15'], 0);
  });

  it('shows and changes the closing date of an archived account', async () => {
    const listed = (await s.ok.get('/api/accounts?all=1')).find(a => a.id === loan.id);
    assert.equal(listed.closedOn, '2026-09-15');
    await s.ok.put(`/api/accounts/${loan.id}`, { closedOn: '2026-10-01' });
    const at = await allAccounts(s);
    assert.equal(at['2026-09-30'], 12200, 'with the later date the £8,000 car still counts on the 30th');
    assert.equal(at['2026-10-01'], 4200);
    await s.ok.put(`/api/accounts/${loan.id}`, { closedOn: '2026-09-15' });
  });

  it('forgets the closing date when the account is restored', async () => {
    const restored = await s.ok.post(`/api/accounts/${loan.id}/restore`);
    assert.equal(restored.closedOn, undefined);
    await s.ok.del(`/api/accounts/${loan.id}`, { closedOn: '2026-09-15' });
  });
});

describe('history: a mortgage taken out to buy a house', () => {
  let s;
  before(async () => {
    s = await freshServer();
    const bank = await makeAccount(s, { name: 'Current', startingBalance: 30000 });
    // No opening balance: the house counts from the mortgage's first transaction
    const mortgage = await makeAccount(s, { name: 'Mortgage', type: 'mortgage', startingBalance: 0, assetValue: 200000, interestRate: 0 });
    await makeTx(s, mortgage.id, { date: '2026-09-20', amount: -180000, payee: 'Mortgage advance', categoryId: 'cat-uncategorized' });
    await makeTx(s, bank.id, { date: '2026-09-20', amount: -20000, payee: 'House deposit', categoryId: 'cat-uncategorized' });
  });
  after(async () => { await s.close(); });

  it('counts the house from the day the mortgage started', async () => {
    const at = await allAccounts(s);
    assert.equal(at['2026-09-19'], 30000, 'no house before it was bought');
    assert.equal(at['2026-09-20'], 30000, 'a £20,000 deposit and a £180,000 mortgage for a £200,000 house');
  });
});

describe('history: checking the dates', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('rejects dates in the future or in the wrong order', async () => {
    assert.equal((await s.post('/api/accounts', { name: 'A', type: 'loan', openedOn: '2026-10-13' })).status, 400);
    assert.equal((await s.post('/api/accounts', { name: 'A', type: 'loan', valueFrom: '2026-02-30' })).status, 400);
    const loan = await makeAccount(s, { name: 'Loan', type: 'loan', openedOn: '2026-09-01', valueFrom: '2026-09-02' });
    assert.equal(loan.openedOn, '2026-09-01');
    assert.equal(loan.valueFrom, '2026-09-02');
    assert.equal((await s.put(`/api/accounts/${loan.id}`, { closedOn: '2026-10-01' })).status, 400, 'an open account has no closing date');
    assert.equal((await s.del(`/api/accounts/${loan.id}`, { closedOn: '2026-08-31' })).status, 400, 'closed before it opened');
    assert.equal((await s.del(`/api/accounts/${loan.id}`, { closedOn: '2026-10-13' })).status, 400, 'closed in the future');
    const done = await s.ok.del(`/api/accounts/${loan.id}`);
    assert.equal(done.success, true);
    const listed = (await s.ok.get('/api/accounts?all=1')).find(a => a.id === loan.id);
    assert.equal(listed.closedOn, '2026-10-12', 'archived without a date: closed today');
  });

  it("drops a bought-on date for accounts whose value isn't for something bought", async () => {
    const fund = await makeAccount(s, { name: 'Fund', type: 'investment', assetValue: 1200, valueFrom: '2026-09-01' });
    assert.equal(fund.valueFrom, null);
    const bank = await makeAccount(s, { name: 'Bank', valueFrom: '2026-09-01' });
    assert.equal(bank.valueFrom, null);
  });

  it('rejects unknown cards and measures', async () => {
    for (const q of ['card=constructor', 'card=assets', 'measure=toString', 'measure=value']) {
      assert.equal((await s.get(`/api/dashboard/series?range=1m&${q}`)).status, 400, q);
    }
  });
});
