// A v0.1.4 mortgage that hasn't had interest posted for two months gets it posted on the
// first start of the new version, on the remaining balance each month.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { makeTempRoot, removeDir, startServer, readJSON } from '../helpers/server.js';
import { oldDefaultCategories, writeDataFolder } from '../helpers/fixtures.js';

describe('upgrade: mortgage interest catches up after months have passed', () => {
  let dirs;
  let server;

  before(async () => {
    dirs = makeTempRoot();
    const created = '2026-08-12T09:00:00.000Z';
    writeDataFolder(dirs.dataDir, {
      'settings.json': { currencySymbol: '£' },
      'categories.json': oldDefaultCategories(),
      'payees.json': [],
      'recurring.json': [],
      'dismissed.json': [],
      'account-groups.json': [],
      'accounts.json': [
        { id: 'accbank', name: 'Bank', type: 'bank', startingBalance: 5000, assetValue: null, interestRate: null, lastInterestAccrual: null, icon: null, active: true, sortOrder: 1, createdAt: created },
        { id: 'accmortgage', name: 'Home Loan', type: 'mortgage', startingBalance: -200000, assetValue: 320000, interestRate: 4.8, lastInterestAccrual: '2026-08-12', icon: null, active: true, sortOrder: 2, createdAt: created }
      ],
      'transactions/accbank.json': [
        { id: 'b1', payee: 'Transfer to Home Loan', amount: -1000, date: '2026-09-20', category: 'Transfer', description: '', notes: '', createdAt: created, transferId: 'm1', transferAccountId: 'accmortgage' }
      ],
      'transactions/accmortgage.json': [
        { id: 'm1', payee: 'Transfer from Bank', amount: 1000, date: '2026-09-20', category: 'Transfer', description: '', notes: '', createdAt: created, transferId: 'b1', transferAccountId: 'accbank' }
      ]
    });
    server = await startServer({ ...dirs, now: '2026-10-12T12:00:00Z' });
  });

  after(async () => {
    await server?.close();
    clock.set(null);
    removeDir(dirs?.root);
  });

  it('posts one interest charge per month on the balance owed at that date', async () => {
    const txs = await server.ok.get('/api/accounts/accmortgage/transactions');
    const interest = txs.filter(t => t.autoInterest).sort((a, b) => a.date.localeCompare(b.date));
    assert.deepEqual(interest.map(t => [t.date, t.amount]), [
      ['2026-09-12', -800], // 4.8% / 12 of £200,000
      ['2026-10-12', -799.2] // on £199,800 after the September payment and interest
    ]);
    for (const t of interest) {
      assert.equal(t.categoryId, 'sub-mortgage');
      assert.equal(t.payee, 'Interest');
      assert.match(t.description, /4\.8%/);
    }
  });

  it('moves lastInterestAccrual forward and updates the balance', async () => {
    const accounts = await server.ok.get('/api/accounts');
    const mortgage = accounts.find(a => a.id === 'accmortgage');
    assert.equal(mortgage.lastInterestAccrual, '2026-10-12');
    assert.equal(mortgage.balance, -200599.2);
    const onDisk = readJSON(path.join(dirs.dataDir, 'accounts.json')).find(a => a.id === 'accmortgage');
    assert.equal(onDisk.lastInterestAccrual, '2026-10-12');
    assert.equal(readJSON(path.join(dirs.dataDir, 'transactions', 'accmortgage.json')).length, 3);
  });

  it('does not post the same interest twice (bootstrap and restart are idempotent)', async () => {
    await server.ok.get('/api/bootstrap');
    await server.close();
    server = await startServer({ ...dirs, now: '2026-10-12T18:00:00Z' });
    await server.ok.get('/api/bootstrap');
    const txs = await server.ok.get('/api/accounts/accmortgage/transactions');
    assert.equal(txs.filter(t => t.autoInterest).length, 2);
  });

  it('posts the next month when the clock reaches it (housekeeping on bootstrap)', async () => {
    clock.set('2026-11-12T08:00:00Z');
    await server.ok.get('/api/bootstrap');
    const txs = await server.ok.get('/api/accounts/accmortgage/transactions');
    const interest = txs.filter(t => t.autoInterest).sort((a, b) => a.date.localeCompare(b.date));
    assert.equal(interest.length, 3);
    // £200,599.20 owed x 0.4% = £802.3968 -> £802.40
    assert.deepEqual([interest[2].date, interest[2].amount], ['2026-11-12', -802.4]);
  });
});
