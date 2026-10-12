import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { freshServer, makeAccount, makeTx, txsOf, readJSON, NOW } from '../helpers/server.js';

const monthly = { type: 'months', interval: 1 };

describe('recurring payments', () => {
  let s;
  let acc;
  let savings;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current', startingBalance: 2000 });
    savings = await makeAccount(s, { name: 'Savings', type: 'savings' });
  });
  after(async () => { await s.close(); });

  it('creates a template that starts on its start date', async () => {
    const res = await s.post('/api/recurring', {
      accountId: acc.id, payee: 'Landlord', amount: -950, categoryId: 'sub-rent', frequency: monthly, startDate: '2026-10-31'
    });
    assert.equal(res.status, 201);
    const t = res.data;
    assert.equal(t.nextDueDate, '2026-10-31');
    assert.equal(t.anchorDay, 31);
    assert.equal(t.status, 'active');
    assert.equal(t.monthlyAmount, -950);
    assert.equal(t.category, 'Rent');
    assert.equal(t.logged, 0);
    assert.ok((await s.ok.get('/api/payees')).some(p => p.name === 'Landlord'));
  });

  it('validates templates', async () => {
    const base = { accountId: acc.id, payee: 'X', amount: -1, startDate: '2026-11-01' };
    assert.equal((await s.post('/api/recurring', { ...base, amount: 0 })).status, 400);
    assert.equal((await s.post('/api/recurring', { ...base, payee: '' })).status, 400);
    assert.equal((await s.post('/api/recurring', { ...base, startDate: '2026-11-31' })).status, 400);
    assert.equal((await s.post('/api/recurring', { ...base, frequency: { type: 'fortnights' } })).status, 400);
    assert.equal((await s.post('/api/recurring', { ...base, frequency: { type: 'weeks', interval: 0 } })).status, 400);
    assert.equal((await s.post('/api/recurring', { ...base, endCondition: { type: 'after_occurrences', value: 0 } })).status, 400);
    assert.equal((await s.post('/api/recurring', { ...base, accountId: 'nosuchaccount' })).status, 404);
    assert.equal((await s.post('/api/recurring', { type: 'transfer', fromAccountId: acc.id, toAccountId: acc.id, amount: 5, startDate: '2026-11-01' })).status, 400);
  });

  it('approve posts the payment and moves to the next date, keeping the 31st', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Phone', amount: -20, categoryId: 'sub-mobile', startDate: '2026-08-31' });
    const first = await s.ok.post(`/api/recurring/${t.id}/approve`);
    assert.equal(first.nextDueDate, '2026-09-30');
    assert.equal(first.created.date, '2026-08-31');
    assert.equal(first.created.amount, -20);
    assert.equal(first.created.recurringId, t.id);
    assert.equal(first.created.categoryId, 'sub-mobile');
    // Adjusted amount and date for one occurrence
    const second = await s.ok.post(`/api/recurring/${t.id}/approve`, { date: '2026-10-02', amount: -22.5 });
    assert.equal(second.nextDueDate, '2026-10-31', 'still the last day of the month');
    assert.equal(second.created.date, '2026-10-02');
    assert.equal(second.created.amount, -22.5);
    const posted = (await txsOf(s, acc.id)).filter(x => x.recurringId === t.id);
    assert.equal(posted.length, 2);
    const listed = (await s.ok.get('/api/recurring')).find(x => x.id === t.id);
    assert.equal(listed.occurrencesCompleted, 2);
  });

  it('skip moves on without posting anything', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Skipper', amount: -5, startDate: '2026-10-05' });
    const res = await s.ok.post(`/api/recurring/${t.id}/skip`);
    assert.equal(res.nextDueDate, '2026-11-05');
    assert.equal((await txsOf(s, acc.id)).some(x => x.recurringId === t.id), false);
  });

  it('approving is refused (409) once "after N payments" is reached', async () => {
    const t = await s.ok.post('/api/recurring', {
      accountId: acc.id, payee: 'Loan instalment', amount: -100, startDate: '2026-08-01', endCondition: { type: 'after_occurrences', value: 2 }
    });
    await s.ok.post(`/api/recurring/${t.id}/approve`);
    const last = await s.ok.post(`/api/recurring/${t.id}/approve`);
    assert.equal(last.status, 'ended');
    const refused = await s.post(`/api/recurring/${t.id}/approve`);
    assert.equal(refused.status, 409);
    assert.equal((await s.post(`/api/recurring/${t.id}/skip`)).status, 409);
    assert.equal((await txsOf(s, acc.id)).filter(x => x.recurringId === t.id).length, 2);
  });

  it('an end date applies to each occurrence', async () => {
    const t = await s.ok.post('/api/recurring', {
      accountId: acc.id, payee: 'Short contract', amount: -15, startDate: '2026-08-15', endCondition: { type: 'on_date', value: '2026-10-20' }
    });
    for (const expected of ['2026-08-15', '2026-09-15', '2026-10-15']) {
      const res = await s.ok.post(`/api/recurring/${t.id}/approve`);
      assert.equal(res.created.date, expected);
    }
    const listed = (await s.ok.get('/api/recurring')).find(x => x.id === t.id);
    assert.equal(listed.nextDueDate, '2026-11-15');
    assert.equal(listed.status, 'ended');
    assert.equal((await s.post(`/api/recurring/${t.id}/approve`)).status, 409);
  });

  it('changing the start date or frequency recomputes the next due date', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Reschedule', amount: -9, startDate: '2026-10-01' });
    await s.ok.post(`/api/recurring/${t.id}/approve`);
    // Weekly from Thursday 1 October: first one on or after today (Monday 12th) is Thursday 15th
    const weekly = await s.ok.put(`/api/recurring/${t.id}`, { frequency: { type: 'weeks', interval: 1 } });
    assert.equal(weekly.nextDueDate, '2026-10-15');
    assert.equal(weekly.anchorDay, null);
    const later = await s.ok.put(`/api/recurring/${t.id}`, { startDate: '2026-12-05', frequency: monthly });
    assert.equal(later.nextDueDate, '2026-12-05');
    assert.equal(later.anchorDay, 5);
    const renamed = await s.ok.put(`/api/recurring/${t.id}`, { payee: 'Renamed only' });
    assert.equal(renamed.nextDueDate, '2026-12-05', 'other edits leave the schedule alone');
    const manual = await s.ok.put(`/api/recurring/${t.id}`, { nextDueDate: '2026-12-24' });
    assert.equal(manual.nextDueDate, '2026-12-24');
  });

  it('a rejected update leaves the template exactly as it was', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Unchanged', amount: -12, startDate: '2026-11-01' });
    const res = await s.put(`/api/recurring/${t.id}`, { payee: 'Half applied', amount: 0 });
    assert.equal(res.status, 400);
    const now = (await s.ok.get('/api/recurring')).find(x => x.id === t.id);
    assert.equal(now.payee, 'Unchanged');
    const onDisk = readJSON(path.join(s.dataDir, 'recurring.json')).find(x => x.id === t.id);
    assert.equal(onDisk.payee, 'Unchanged');
  });

  it('recurring transfers post both legs', async () => {
    const t = await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: acc.id, toAccountId: savings.id, amount: -200, startDate: '2026-10-10' });
    assert.equal(t.amount, 200);
    assert.equal(t.categoryId, 'cat-transfer');
    assert.equal(t.payee, '');
    const res = await s.ok.post(`/api/recurring/${t.id}/approve`);
    assert.equal(res.created.from.amount, -200);
    assert.equal(res.created.to.amount, 200);
    const leg = (await txsOf(s, savings.id)).find(x => x.recurringId === t.id);
    assert.ok(leg);
    assert.equal(leg.transferId, res.created.from.id);
  });

  it('delete hides a template and restore brings it back', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Bin me', amount: -1, startDate: '2026-11-01' });
    await s.ok.del(`/api/recurring/${t.id}`);
    assert.equal((await s.ok.get('/api/recurring')).some(x => x.id === t.id), false);
    assert.equal((await s.post(`/api/recurring/${t.id}/approve`)).status, 404);
    await s.ok.post(`/api/recurring/${t.id}/restore`);
    assert.ok((await s.ok.get('/api/recurring')).some(x => x.id === t.id));
  });

  it('approving a payment for an archived account is refused', async () => {
    const gone = await makeAccount(s, { name: 'Closing' });
    const t = await s.ok.post('/api/recurring', { accountId: gone.id, payee: 'Old DD', amount: -1, startDate: '2026-10-01' });
    await s.ok.del(`/api/accounts/${gone.id}`);
    assert.equal((await s.post(`/api/recurring/${t.id}/approve`)).status, 400);
    const after = (await s.ok.get('/api/recurring')).find(x => x.id === t.id);
    assert.equal(after.occurrencesCompleted, 0);
    assert.equal(after.nextDueDate, '2026-10-01');
  });
});

describe('recurring payments that log themselves', () => {
  let s;
  let acc;
  let savings;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current' });
    savings = await makeAccount(s, { name: 'Savings', type: 'savings' });
  });
  after(async () => { await s.close(); });

  it('logs every occurrence already due when created', async () => {
    const t = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Council Tax', amount: -150, startDate: '2026-07-31', autoLog: true });
    assert.equal(t.logged, 3);
    const posted = (await txsOf(s, acc.id)).filter(x => x.recurringId === t.id).map(x => x.date).sort();
    assert.deepEqual(posted, ['2026-07-31', '2026-08-31', '2026-09-30']);
    const listed = (await s.ok.get('/api/recurring')).find(x => x.id === t.id);
    assert.equal(listed.nextDueDate, '2026-10-31');
    assert.equal(listed.occurrencesCompleted, 3);
  });

  it('stops at an end date', async () => {
    const t = await s.ok.post('/api/recurring', {
      accountId: acc.id, payee: 'Ended DD', amount: -10, startDate: '2026-01-31', autoLog: true, endCondition: { type: 'on_date', value: '2026-04-30' }
    });
    assert.equal(t.logged, 4);
    const posted = (await txsOf(s, acc.id)).filter(x => x.recurringId === t.id).map(x => x.date).sort();
    assert.deepEqual(posted, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === t.id).status, 'ended');
  });

  it('logs transfers, and nothing while paused', async () => {
    const tr = await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: acc.id, toAccountId: savings.id, amount: 50, startDate: '2026-09-15', autoLog: true });
    assert.equal(tr.logged, 1, '15 September is due; 15 October is still to come');
    const legs = (await txsOf(s, savings.id)).filter(x => x.recurringId === tr.id);
    assert.deepEqual(legs.map(x => [x.date, x.amount]), [['2026-09-15', 50]]);
    assert.equal((await txsOf(s, acc.id)).filter(x => x.recurringId === tr.id)[0].amount, -50);
    const paused = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Paused DD', amount: -1, startDate: '2026-09-01', autoLog: true, paused: true });
    assert.equal(paused.logged, 0);
    assert.equal((await txsOf(s, acc.id)).some(x => x.recurringId === paused.id), false);
  });

  it('logs newly due occurrences when the app is opened (bootstrap housekeeping)', async () => {
    const before = (await txsOf(s, acc.id)).length;
    clock.set('2026-11-01T09:00:00Z');
    try {
      await s.ok.get('/api/bootstrap');
      const after = await txsOf(s, acc.id);
      const councilTax = after.filter(x => x.payee === 'Council Tax').map(x => x.date).sort();
      assert.equal(councilTax.at(-1), '2026-10-31');
      assert.ok(after.length > before);
      // Running it again the same day changes nothing
      await s.ok.get('/api/bootstrap');
      assert.equal((await txsOf(s, acc.id)).length, after.length);
    } finally {
      clock.set(NOW);
    }
  });
});

describe('recurring suggestions', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current' });
    for (const date of ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05']) {
      await makeTx(s, acc.id, { payee: 'Netflix', amount: -10.99, date, categoryId: 'sub-streaming' });
    }
    for (const date of ['2026-08-07', '2026-08-14', '2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25', '2026-10-02', '2026-10-09']) {
      await makeTx(s, acc.id, { payee: 'Window Cleaner', amount: -12, date });
    }
    // Mixed in and out: refunds, not a schedule
    for (const [date, amount] of [['2026-07-01', -20], ['2026-08-01', 20], ['2026-09-01', -20]]) {
      await makeTx(s, acc.id, { payee: 'Amazon', amount, date });
    }
    // Stopped long ago
    for (const date of ['2025-01-03', '2025-02-03', '2025-03-03']) await makeTx(s, acc.id, { payee: 'Old Gym', amount: -30, date });
    // Already has a template
    for (const date of ['2026-07-20', '2026-08-20', '2026-09-20']) await makeTx(s, acc.id, { payee: 'Spotify', amount: -11.99, date });
    await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'spotify', amount: -11.99, startDate: '2026-10-20' });
  });
  after(async () => { await s.close(); });

  it('suggests regular payments with the right cadence and next date', async () => {
    const list = await s.ok.get('/api/recurring/suggestions');
    const names = list.map(x => x.payee).sort();
    assert.deepEqual(names, ['Netflix', 'Window Cleaner']);
    const netflix = list.find(x => x.payee === 'Netflix');
    assert.deepEqual(netflix.frequency, { type: 'months', interval: 1 });
    assert.equal(netflix.amount, -10.99);
    assert.equal(netflix.nextDueDate, '2026-11-05');
    assert.equal(netflix.categoryId, 'sub-streaming');
    assert.equal(netflix.occurrences, 4);
    assert.equal(netflix.signature, `${acc.id}|netflix`);
    const cleaner = list.find(x => x.payee === 'Window Cleaner');
    assert.deepEqual(cleaner.frequency, { type: 'weeks', interval: 1 });
    assert.equal(cleaner.nextDueDate, '2026-10-16');
    assert.equal(list[0].payee, 'Window Cleaner', 'most occurrences first');
  });

  it('dismissing hides a suggestion until dismissals are reset', async () => {
    await s.ok.post('/api/recurring/suggestions/dismiss', { signature: `${acc.id}|netflix` });
    await s.ok.post('/api/recurring/suggestions/dismiss', { signature: `${acc.id}|netflix` });
    assert.equal((await s.ok.get('/api/recurring/suggestions')).some(x => x.payee === 'Netflix'), false);
    assert.deepEqual(readJSON(path.join(s.dataDir, 'dismissed.json')), [`${acc.id}|netflix`]);
    await s.ok.del('/api/recurring/suggestions/dismissed');
    assert.ok((await s.ok.get('/api/recurring/suggestions')).some(x => x.payee === 'Netflix'));
    assert.equal((await s.post('/api/recurring/suggestions/dismiss', {})).status, 400);
  });

  it('creating a template from a suggestion removes it', async () => {
    const netflix = (await s.ok.get('/api/recurring/suggestions')).find(x => x.payee === 'Netflix');
    await s.ok.post('/api/recurring', { accountId: netflix.accountId, payee: netflix.payee, amount: netflix.amount, categoryId: netflix.categoryId, frequency: netflix.frequency, startDate: netflix.nextDueDate });
    assert.equal((await s.ok.get('/api/recurring/suggestions')).some(x => x.payee === 'Netflix'), false);
  });
});
