// Regression tests for the recurring-payment, transfer and import fixes found in the October
// 2026 bug hunt. Today is pinned to Monday 12 October 2026.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clock } from '../../server/lib/clock.js';
import { freshServer, makeAccount, makeTx, txsOf, NOW } from '../helpers/server.js';

const monthly = { type: 'months', interval: 1 };

describe('pausing and resuming recurring payments', () => {
  let s;
  let acc;
  let savings;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current' });
    savings = await makeAccount(s, { name: 'Savings', type: 'savings' });
  });
  after(async () => { await s.close(); });
  afterEach(() => { clock.set(NOW); });

  it('resuming does not log (or ask about) the payments that fell while it was paused', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Gym', amount: -20, startDate: '2026-07-01', autoLog: true, paused: true });
    assert.equal(t.logged, 0);
    const resumed = await s.ok.put(`/api/recurring/${t.id}`, { paused: false });
    assert.equal(resumed.logged, 0);
    assert.equal(resumed.nextDueDate, '2026-11-01');
    assert.equal((await txsOf(s, acc.id)).filter(x => x.payee === 'Gym').length, 0);
  });

  it('restoring an archived account months later starts its payments from today', async () => {
    const other = await makeAccount(s, { name: 'Easy Access' });
    const t = await s.ok.post('/api/recurring', { accountId: other.id, payee: 'Saver', amount: 50, startDate: '2026-10-20', autoLog: true });
    await s.ok.del(`/api/accounts/${other.id}`);
    clock.set('2027-01-25T12:00:00Z');
    const restored = await s.ok.post(`/api/accounts/${other.id}/restore`);
    assert.equal(restored.resumedRecurring, 1);
    await s.ok.get('/api/bootstrap'); // runs housekeeping
    assert.equal((await txsOf(s, other.id)).length, 0);
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === t.id).nextDueDate, '2027-02-20');
  });

  it('a transfer between two archived accounts resumes once both are back', async () => {
    const a = await makeAccount(s, { name: 'A' });
    const b = await makeAccount(s, { name: 'B' });
    const t = await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: a.id, toAccountId: b.id, amount: 10, startDate: '2026-11-01' });
    await s.ok.del(`/api/accounts/${a.id}`);
    await s.ok.del(`/api/accounts/${b.id}`);
    assert.equal((await s.ok.post(`/api/accounts/${a.id}/restore`)).resumedRecurring, 0);
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === t.id).paused, true);
    assert.equal((await s.ok.post(`/api/accounts/${b.id}/restore`)).resumedRecurring, 1);
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === t.id).paused, false);
  });

  it('switching on automatic logging says how many overdue payments it logged', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: savings.id, payee: 'Overdue', amount: -5, startDate: '2026-09-01' });
    const res = await s.ok.put(`/api/recurring/${t.id}`, { autoLog: true });
    assert.equal(res.logged, 2);
  });
});

describe('moving one payment keeps the schedule', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s);
  });
  after(async () => { await s.close(); });

  it('a payment on the 31st moved into the next month still leaves one for that month', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Rent', amount: -900, startDate: '2026-10-31' });
    await s.ok.put(`/api/recurring/${t.id}`, { nextDueDate: '2026-11-02' });
    const res = await s.ok.post(`/api/recurring/${t.id}/approve`, { dueDate: '2026-11-02' });
    assert.equal(res.nextDueDate, '2026-11-30');
  });

  it('a payment moved earlier into the month before is not due twice', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Council tax', amount: -150, startDate: '2026-11-01' });
    await s.ok.put(`/api/recurring/${t.id}`, { nextDueDate: '2026-10-28' });
    const res = await s.ok.post(`/api/recurring/${t.id}/approve`);
    assert.equal(res.nextDueDate, '2026-12-01');
  });

  it('a weekly payment moved from Friday to Monday goes back to Fridays', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Cleaner', amount: -40, startDate: '2026-10-16', frequency: { type: 'weeks', interval: 1 } });
    await s.ok.put(`/api/recurring/${t.id}`, { nextDueDate: '2026-10-19' });
    assert.equal((await s.ok.post(`/api/recurring/${t.id}/skip`)).nextDueDate, '2026-10-23');
  });

  it('moving a payment a whole period on never puts two on the same day', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Water', amount: -30, startDate: '2026-11-05' });
    await s.ok.put(`/api/recurring/${t.id}`, { nextDueDate: '2026-12-05' });
    assert.equal((await s.ok.post(`/api/recurring/${t.id}/approve`)).nextDueDate, '2027-01-05');
  });
});

describe('approving from a stale screen', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s);
  });
  after(async () => { await s.close(); });

  it('approving or skipping a payment already handled elsewhere is refused and changes nothing', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Rent', amount: -500, startDate: '2026-10-01' });
    assert.equal((await s.post(`/api/recurring/${t.id}/approve`, { dueDate: '2026-10-01' })).status, 200);
    const again = await s.post(`/api/recurring/${t.id}/approve`, { dueDate: '2026-10-01' });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /already been logged or skipped/);
    assert.equal((await s.post(`/api/recurring/${t.id}/skip`, { dueDate: '2026-10-01' })).status, 409);
    assert.equal((await txsOf(s, acc.id)).filter(x => x.payee === 'Rent').length, 1);
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === t.id).nextDueDate, '2026-11-01');
  });
});

describe('changing the schedule after payments were logged', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s);
  });
  after(async () => { await s.close(); });

  it('moving a payday later in the month does not add a second payment this month', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Salary', amount: 2000, startDate: '2026-09-12', autoLog: true });
    assert.equal(t.logged, 2);
    assert.equal((await s.ok.put(`/api/recurring/${t.id}`, { startDate: '2026-09-15' })).nextDueDate, '2026-11-15');
    assert.equal((await s.ok.put(`/api/recurring/${t.id}`, { startDate: '2026-09-10' })).nextDueDate, '2026-11-10');
  });

  it('switching to quarterly never lands on a payment already logged', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Insurance', amount: -60, startDate: '2026-07-15' });
    for (let i = 0; i < 4; i++) await s.ok.post(`/api/recurring/${t.id}/approve`);
    const quarterly = await s.ok.put(`/api/recurring/${t.id}`, { frequency: { type: 'months', interval: 3 } });
    assert.equal(quarterly.nextDueDate, '2027-01-15');
  });
});

describe('suggestions', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s);
    const add = (payee, date, amount) => makeTx(s, acc.id, { payee, date, amount });
    for (const date of ['2026-04-30', '2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30']) await add('Acme Ltd', date, 2400);
    const aldi = [['2026-06-01', -63], ['2026-07-01', -88], ['2026-07-11', -103], ['2026-08-17', -71], ['2026-08-24', -95], ['2026-09-24', -79]];
    for (const [date, amount] of aldi) await add('Aldi', date, amount);
    for (const date of ['2026-05-08', '2026-06-05', '2026-07-03', '2026-08-28', '2026-09-25']) await add('Four weekly', date, 1500);
  });
  after(async () => { await s.close(); });

  it('pay on the last day of the month is suggested for the 31st, and keeps it', async () => {
    const suggestion = (await s.ok.get('/api/recurring/suggestions')).find(x => x.payee === 'Acme Ltd');
    assert.equal(suggestion.anchorDay, 31);
    assert.equal(suggestion.nextDueDate, '2026-10-31');
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Acme Ltd', amount: 2400, startDate: '2026-11-30', anchorDay: 31 });
    assert.equal(t.anchorDay, 31);
    assert.equal((await s.ok.post(`/api/recurring/${t.id}/skip`)).nextDueDate, '2026-12-31');
    assert.equal((await s.post('/api/recurring', { accountId: acc.id, payee: 'Bad', amount: 1, startDate: '2026-11-15', anchorDay: 31 })).status, 400);
  });

  it('shopping trips that average a month apart are not suggested as a bill', async () => {
    assert.equal((await s.ok.get('/api/recurring/suggestions')).some(x => x.payee === 'Aldi'), false);
  });

  it('4-weekly pay with one missed cycle is still 4-weekly', async () => {
    const suggestion = (await s.ok.get('/api/recurring/suggestions')).find(x => x.payee === 'Four weekly');
    assert.deepEqual(suggestion.frequency, { type: 'weeks', interval: 4 });
    assert.equal(suggestion.anchorDay, null);
  });
});

describe('transfers, categories and imports', () => {
  let s;
  let bank;
  let card;
  before(async () => {
    s = await freshServer();
    bank = await makeAccount(s, { name: 'Bank' });
    card = await makeAccount(s, { name: 'Card', type: 'credit' });
  });
  after(async () => { await s.close(); });

  it('two bank rows linked as a transfer keep their own dates, and the data check is happy', async () => {
    const out = await makeTx(s, bank.id, { date: '2026-10-02', amount: -300, payee: 'CARD PAYMENT' });
    const back = await makeTx(s, card.id, { date: '2026-10-05', amount: 300, payee: 'PAYMENT RECEIVED' });
    await s.ok.post(`/api/accounts/${bank.id}/transactions/${out.id}/convert-to-transfer`, { targetAccountId: card.id, linkTransactionId: back.id });
    const { issues } = await s.ok.get('/api/data-check');
    assert.equal(issues.filter(i => i.kind === 'transfer-mismatch').length, 0);
    await s.ok.put(`/api/accounts/${bank.id}/transactions/${out.id}`, { notes: 'Paid off' });
    assert.equal((await txsOf(s, card.id)).find(x => x.id === back.id).date, '2026-10-05');
  });

  it('saving a category under the name it already has works even if old data has a twin', async () => {
    const a = await s.ok.post('/api/categories', { name: 'Gifts and more' });
    const b = await s.ok.post('/api/categories', { name: 'Presents' });
    s.app.store.data.categories.find(c => c.id === b.id).name = 'Gifts and more';
    assert.equal((await s.put(`/api/categories/${b.id}`, { name: 'Gifts and more', emoji: '🎁' })).status, 200);
  });

  it('search finds amounts typed the way the app shows them', async () => {
    await makeTx(s, bank.id, { amount: -1100, payee: 'Big bill' });
    await makeTx(s, bank.id, { amount: -48.34, payee: 'Small bill' });
    const search = async (q) => (await s.ok.get(`/api/accounts/${bank.id}/transactions?q=${encodeURIComponent(q)}&offset=0&limit=50`)).items.map(x => x.payee);
    assert.deepEqual(await search('£1,100.00'), ['Big bill']);
    assert.deepEqual(await search('-48.34'), ['Small bill']);
    assert.deepEqual(await search('−£48.34'), ['Small bill']);
  });

  it('import errors name the line in the file, and over-long text is shortened rather than refused', async () => {
    const long = 'X'.repeat(300);
    const ok = await s.ok.post(`/api/accounts/${bank.id}/transactions/import`, { rows: [{ line: 5, date: '2026-09-01', amount: -1, payee: long, description: long.repeat(2) }] });
    assert.equal(ok.imported, 1);
    const bad = await s.post(`/api/accounts/${bank.id}/transactions/import`, { rows: [{ line: 2, date: '2026-09-01', amount: -1 }, { line: 7, date: 'yesterday', amount: -1 }] });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /^Line 7 of the file: date/);
  });

  it('a £0 transaction from an older version can still be edited, but new ones need an amount', async () => {
    const tx = await makeTx(s, bank.id, { amount: -1, payee: 'Was zero' });
    s.app.store.data.transactions[bank.id].find(x => x.id === tx.id).amount = 0;
    assert.equal((await s.put(`/api/accounts/${bank.id}/transactions/${tx.id}`, { amount: 0, notes: 'kept' })).status, 200);
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions`, { date: '2026-10-01', amount: 0, payee: 'Nothing' })).status, 400);
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions`, { date: '2026-10-01', amount: '  ', payee: 'Blank' })).status, 400);
  });
});

describe('undoing "make into a transfer"', () => {
  let s;
  let bank;
  let card;
  before(async () => {
    s = await freshServer();
    bank = await makeAccount(s, { name: 'Bank' });
    card = await makeAccount(s, { name: 'Card', type: 'credit' });
  });
  after(async () => { await s.close(); });

  it('puts the transaction back and removes the side that was made up', async () => {
    const tx = await makeTx(s, bank.id, { amount: -80, payee: 'CARD PAYMENT', categoryId: 'sub-groceries' });
    const res = await s.ok.post(`/api/accounts/${bank.id}/transactions/${tx.id}/convert-to-transfer`, { targetAccountId: card.id });
    assert.equal((await txsOf(s, card.id)).length, 1);
    await s.ok.post('/api/transactions/restore', { items: res.undo });
    assert.deepEqual(await txsOf(s, card.id), []);
    const back = (await txsOf(s, bank.id)).find(x => x.id === tx.id);
    assert.equal(back.transferId, null);
    assert.equal(back.categoryId, 'sub-groceries');
  });

  it('in bulk, and when two real transactions were linked', async () => {
    const out = await makeTx(s, bank.id, { amount: -40, payee: 'TO CARD', date: '2026-10-03' });
    const back = await makeTx(s, card.id, { amount: 40, payee: 'FROM BANK', date: '2026-10-04', categoryId: 'sub-dining' });
    const linked = await s.ok.post(`/api/accounts/${bank.id}/transactions/${out.id}/convert-to-transfer`, { targetAccountId: card.id, linkTransactionId: back.id });
    await s.ok.post('/api/transactions/restore', { items: linked.undo });
    const cardNow = await txsOf(s, card.id);
    assert.equal(cardNow.find(x => x.id === back.id).categoryId, 'sub-dining');
    assert.equal(cardNow.find(x => x.id === back.id).transferId, null);

    const a = await makeTx(s, bank.id, { amount: -5, payee: 'A' });
    const b = await makeTx(s, bank.id, { amount: -6, payee: 'B' });
    const before = (await txsOf(s, card.id)).length;
    const bulk = await s.ok.post(`/api/accounts/${bank.id}/transactions/bulk`, { action: 'convertToTransfer', ids: [a.id, b.id], targetAccountId: card.id });
    assert.equal((await txsOf(s, card.id)).length, before + 2);
    await s.ok.post('/api/transactions/restore', { items: bulk.undo });
    assert.equal((await txsOf(s, card.id)).length, before);
    assert.ok((await txsOf(s, bank.id)).filter(x => [a.id, b.id].includes(x.id)).every(x => !x.transferId));
  });

  it('rows imported before payees were tidied are still spotted as duplicates', async () => {
    const old = await makeTx(s, bank.id, { date: '2026-09-02', amount: -64, payee: "'OCTOPUS ENERGY" });
    s.app.store.data.transactions[bank.id].find(x => x.id === old.id).importBatch = 'oldbatch';
    const preview = await s.ok.post(`/api/accounts/${bank.id}/transactions/import/preview`, { rows: [{ date: '2026-09-02', amount: -64, payee: 'OCTOPUS ENERGY' }] });
    assert.equal(preview.rows[0].duplicate, true);
  });
});
