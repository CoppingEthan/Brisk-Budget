// Behaviour added while fixing the first round of bugs, pinned down so it stays fixed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freshServer, startServer, makeTempRoot, removeDir, makeAccount, makeTx, txsOf } from '../helpers/server.js';
import { writeDataFolder, oldData } from '../helpers/fixtures.js';
import { clock } from '../../server/lib/clock.js';
import { round2, toPence, sum } from '../../public/js/shared/money.js';

describe('archiving and restoring an account', () => {
  let server;
  before(async () => { server = await freshServer(); });
  after(async () => { await server.close(); });

  it('restoring resumes only the recurring payments that archiving paused', async () => {
    const bank = await makeAccount(server, { name: 'Bank' });
    const other = await makeAccount(server, { name: 'Other' });
    const auto = await server.ok.post('/api/recurring', {
      type: 'transaction', accountId: bank.id, payee: 'Gym', amount: -30, frequency: { type: 'months', interval: 1 }, startDate: '2026-11-01'
    });
    const manual = await server.ok.post('/api/recurring', {
      type: 'transaction', accountId: bank.id, payee: 'Paused by me', amount: -5, frequency: { type: 'months', interval: 1 }, startDate: '2026-11-01'
    });
    await server.ok.put(`/api/recurring/${manual.id}`, { paused: true });
    const unrelated = await server.ok.post('/api/recurring', {
      type: 'transaction', accountId: other.id, payee: 'Elsewhere', amount: -5, frequency: { type: 'months', interval: 1 }, startDate: '2026-11-01'
    });

    const archived = await server.ok.del(`/api/accounts/${bank.id}`);
    assert.equal(archived.pausedRecurring, 1);
    const restored = await server.ok.post(`/api/accounts/${bank.id}/restore`);
    assert.equal(restored.resumedRecurring, 1);

    const list = await server.ok.get('/api/recurring');
    const byId = Object.fromEntries(list.map(r => [r.id, r]));
    assert.equal(byId[auto.id].paused, false);
    assert.equal(byId[manual.id].paused, true, 'something the person paused stays paused');
    assert.equal(byId[unrelated.id].paused, false);
  });
});

describe('payee renames', () => {
  let server;
  before(async () => { server = await freshServer(); });
  after(async () => { await server.close(); });

  it('keep a dismissed suggestion dismissed under the new name', async () => {
    const bank = await makeAccount(server);
    for (const date of ['2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03']) {
      await makeTx(server, bank.id, { payee: 'Netflix', amount: -10.99, date });
    }
    const [suggestion] = await server.ok.get('/api/recurring/suggestions');
    assert.equal(suggestion.payee, 'Netflix');
    await server.ok.post('/api/recurring/suggestions/dismiss', { signature: suggestion.signature });
    const payee = (await server.ok.get('/api/payees')).find(p => p.name === 'Netflix');
    await server.ok.put(`/api/payees/${payee.id}`, { name: 'Netflix UK' });
    assert.deepEqual(await server.ok.get('/api/recurring/suggestions'), []);
  });
});

describe('upgrading odd v0.1.x data', () => {
  let dirs;
  let server;
  before(async () => {
    dirs = makeTempRoot();
    const { files } = oldData('0.1.4');
    const accounts = files['accounts.json'];
    const accountId = accounts[0].id;
    // A plain transaction someone filed under the "Transfer" category by hand
    files[`transactions/${accountId}.json`].push({ id: 'manualtransfer', payee: 'Cash to jar', amount: -20, date: '2026-09-01', category: 'Transfer', description: '', notes: '', createdAt: '2026-09-01T10:00:00.000Z', transferId: null, transferAccountId: null });
    // A mortgage opened on the 31st whose interest had drifted to the 28th
    accounts.push({ id: 'mortgage31', name: 'Drifted mortgage', type: 'mortgage', startingBalance: -100000, assetValue: null, interestRate: 3, lastInterestAccrual: '2026-09-28', icon: null, active: true, sortOrder: 99, createdAt: '2026-01-31T09:00:00.000Z' });
    files['transactions/mortgage31.json'] = [];
    writeDataFolder(dirs.dataDir, files);
    server = await startServer({ ...dirs, now: '2026-10-12T12:00:00Z' });
  });
  after(async () => {
    await server?.close();
    clock.set(null);
    removeDir(dirs?.root);
  });

  it('keeps a non-transfer filed as "Transfer" findable instead of breaking it', async () => {
    const accountId = (await server.ok.get('/api/accounts'))[0].id;
    const tx = (await txsOf(server, accountId)).find(t => t.id === 'manualtransfer');
    assert.equal(tx.category, 'Transfers (not linked)');
    assert.equal(tx.categoryParent, 'Imported');
    // and it can still be edited without being refused
    await server.ok.put(`/api/accounts/${accountId}/transactions/manualtransfer`, { notes: 'edited' });
  });

  it('puts drifted mortgage interest back on its day of the month', async () => {
    const accounts = await server.ok.get('/api/accounts');
    const mortgage = accounts.find(a => a.id === 'mortgage31');
    assert.equal(mortgage.interestDay, 31);
    assert.equal(mortgage.lastInterestAccrual, '2026-09-28', 'the September charge already happened');
    assert.deepEqual((await txsOf(server, 'mortgage31')).filter(t => t.autoInterest), []);
    // A restart in November charges October's interest on the 31st, not the 28th
    await server.close();
    server = await startServer({ ...dirs, now: '2026-11-01T12:00:00Z' });
    const interest = (await txsOf(server, 'mortgage31')).filter(t => t.autoInterest);
    assert.deepEqual(interest.map(t => t.date), ['2026-10-31']);
  });
});

describe('money rounding', () => {
  it('rounds halves away from zero, ignoring floating point noise', () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(-12.345), -12.35);
    assert.equal(round2(2.675), 2.68);
    assert.equal(toPence(0.1 + 0.2), 30);
    assert.equal(sum([0.1, 0.2, 0.3]), 0.6);
    assert.equal(Object.is(round2(-0.001), -0), false, 'no negative zero');
  });
});
