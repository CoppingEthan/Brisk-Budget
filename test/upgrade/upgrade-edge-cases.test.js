// Odd data folders the upgrade has to cope with.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { createApp } from '../../server/app.js';
import { SCHEMA_VERSION } from '../../server/store/migrations/index.js';
import { makeTempRoot, removeDir, startServer, readJSON, listBackups, createTestLog, NOW } from '../helpers/server.js';
import { oldData, writeDataFolder } from '../helpers/fixtures.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
  clock.set(null);
});

function tempDirs() {
  const dirs = makeTempRoot();
  cleanups.push(() => removeDir(dirs.root));
  return dirs;
}

async function boot(dirs, options) {
  const server = await startServer({ ...dirs, ...options });
  cleanups.push(() => server.close());
  return server;
}

describe('upgrade edge cases', () => {
  it('refuses to start on data written by a newer version, without touching it', () => {
    const dirs = tempDirs();
    const fixture = oldData('0.1.4');
    writeDataFolder(dirs.dataDir, { ...fixture.files, 'meta.json': { schemaVersion: SCHEMA_VERSION + 5, appVersion: '9.9.9', history: [] } });
    const before = fs.readFileSync(path.join(dirs.dataDir, 'transactions', 'acc0current.json'), 'utf8');
    clock.set(NOW);
    assert.throws(
      () => createApp({ ...dirs, autoBackup: false, updateCheck: false, quiet: true, log: createTestLog() }),
      /newer version/i
    );
    assert.equal(fs.readFileSync(path.join(dirs.dataDir, 'transactions', 'acc0current.json'), 'utf8'), before);
    assert.deepEqual(listBackups(dirs.backupsDir), []);
  });

  it('a data folder with only accounts.json and transactions (other files missing) still upgrades', async () => {
    const dirs = tempDirs();
    writeDataFolder(dirs.dataDir, {
      'accounts.json': [{ id: 'onlyacc', name: 'Only', type: 'bank', startingBalance: 1, icon: null, active: true, createdAt: '2025-01-01T00:00:00Z' }],
      'transactions/onlyacc.json': [{ id: 'x1', payee: 'A', amount: 2, date: '2025-01-02', category: 'Salary', createdAt: '2025-01-02T00:00:00Z' }]
    });
    const server = await boot(dirs);
    const accounts = await server.ok.get('/api/accounts');
    assert.equal(accounts[0].balance, 3);
    const categories = await server.ok.get('/api/categories');
    assert.ok(categories.length > 10, 'default categories created when categories.json is missing');
    const txs = await server.ok.get('/api/accounts/onlyacc/transactions');
    assert.equal(txs[0].categoryId, 'sub-salary');
    assert.equal(readJSON(path.join(dirs.dataDir, 'meta.json')).schemaVersion, SCHEMA_VERSION);
  });

  it('drops transactions that are not objects, gives duplicate ids new ones and tolerates missing fields', async () => {
    const dirs = tempDirs();
    writeDataFolder(dirs.dataDir, {
      'accounts.json': [{ id: 'a1', name: 'A', type: 'weird-type', startingBalance: 'abc', active: true }],
      'transactions/a1.json': [
        null,
        'junk',
        { id: 'dup', payee: 'One', amount: '1.10', date: '2025-02-03', category: 'Groceries' },
        { id: 'dup', payee: 'Two', amount: 2.2, date: '2025-02-04', category: 'Groceries' },
        { payee: 'No id', amount: 3, createdAt: '2025-02-05T10:00:00Z' }
      ]
    });
    const server = await boot(dirs);
    const accounts = await server.ok.get('/api/accounts');
    assert.equal(accounts[0].type, 'bank');
    assert.equal(accounts[0].startingBalance, 0);
    assert.equal(accounts[0].balance, 6.3);
    const txs = await server.ok.get('/api/accounts/a1/transactions');
    assert.equal(txs.length, 3);
    assert.equal(new Set(txs.map(t => t.id)).size, 3, 'ids are unique');
    assert.equal(txs.find(t => t.payee === 'No id').date, '2025-02-05', 'date taken from createdAt');
  });

  it('an existing current-format folder with an older appVersion only gets a version notice', async () => {
    const dirs = tempDirs();
    const first = await boot(dirs);
    await first.ok.post('/api/accounts', { name: 'Kept', type: 'bank' });
    await first.close();
    const metaFile = path.join(dirs.dataDir, 'meta.json');
    const meta = readJSON(metaFile);
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, appVersion: '0.2.0', notices: [] }));
    const server = await boot(dirs);
    const boot2 = await server.ok.get('/api/bootstrap');
    assert.equal(boot2.notices.length, 1);
    assert.match(boot2.notices[0].message, /from v0\.2\.0/);
    assert.deepEqual(listBackups(dirs.backupsDir), [], 'no migration, so no safety backup');
    assert.equal(boot2.accounts[0].name, 'Kept');
  });

  it('a current data folder that lost meta.json is not damaged by re-running the upgrade', async () => {
    // meta.json is the only thing that says "already upgraded". If it goes missing (deleted,
    // or not copied when moving the data folder), the upgrade runs again over new-format data.
    const dirs = tempDirs();
    const first = await boot(dirs);
    const acc = await first.ok.post('/api/accounts', { name: 'Everyday', type: 'bank' });
    const tx = await first.ok.post(`/api/accounts/${acc.id}/transactions`, { date: '2026-10-01', amount: -4, payee: 'Cafe', categoryId: 'sub-coffee' });
    const imported = await first.ok.post(`/api/accounts/${acc.id}/transactions/import`, { rows: [{ date: '2026-10-02', amount: -9, payee: 'Shop', category: 'Groceries' }] });
    const rec = await first.ok.post('/api/recurring', { accountId: acc.id, payee: 'Gym', amount: -30, categoryId: 'sub-gym', startDate: '2026-11-01', autoLog: true });
    await first.close();
    fs.unlinkSync(path.join(dirs.dataDir, 'meta.json'));

    const server = await boot(dirs);
    const txs = await server.ok.get(`/api/accounts/${acc.id}/transactions`);
    assert.equal(txs.find(t => t.id === tx.id).categoryId, 'sub-coffee', 'category must survive');
    const batchRow = txs.find(t => t.payee === 'Shop');
    assert.equal(batchRow.categoryId, 'sub-groceries');
    assert.equal(batchRow.importBatch, imported.batch, 'import batch must survive');
    const template = (await server.ok.get('/api/recurring')).find(r => r.id === rec.id);
    assert.equal(template.categoryId, 'sub-gym');
    assert.equal(template.autoLog, true, 'auto-log setting must survive');
  });

  it('notices can be dismissed one at a time', async () => {
    const dirs = tempDirs();
    writeDataFolder(dirs.dataDir, oldData('0.1.2').files);
    const server = await boot(dirs);
    const { notices } = await server.ok.get('/api/bootstrap');
    assert.equal(notices.length, 1);
    await server.ok.post('/api/notices/dismiss', { id: notices[0].id });
    assert.deepEqual((await server.ok.get('/api/bootstrap')).notices, []);
  });
});
