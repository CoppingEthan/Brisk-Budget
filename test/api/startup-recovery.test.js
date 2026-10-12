// Damaged data files at start-up: recovered from the newest backup that has a readable copy,
// or a clear refusal to start when there is none.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { createApp } from '../../server/app.js';
import { makeTempRoot, removeDir, startServer, createTestLog, makeAccount, makeTx, NOW, listBackups } from '../helpers/server.js';
import { oldData, writeDataFolder } from '../helpers/fixtures.js';
import { allCategoryIds } from '../helpers/upgrade-suite.js';

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

async function boot(dirs) {
  const server = await startServer(dirs);
  cleanups.push(() => server.close());
  return server;
}

// A normal install with one account, two transactions and a manual backup
async function installWithBackup(dirs) {
  const server = await boot(dirs);
  const account = await makeAccount(server, { name: 'Everyday', startingBalance: 100 });
  await makeTx(server, account.id, { amount: -10, payee: 'Cafe' });
  await makeTx(server, account.id, { amount: -5, payee: 'Bakery', date: '2026-10-02' });
  await server.ok.post('/api/backups');
  await server.close();
  return account;
}

describe('start-up recovery of damaged files', () => {
  it('recovers a damaged accounts.json from the newest backup and warns about it', async () => {
    const dirs = tempDirs();
    const account = await installWithBackup(dirs);
    fs.writeFileSync(path.join(dirs.dataDir, 'accounts.json'), '{"this is": not json');

    const server = await boot(dirs);
    const accounts = await server.ok.get('/api/accounts');
    assert.deepEqual(accounts.map(a => a.id), [account.id]);
    assert.equal(accounts[0].balance, 85);
    const { notices } = await server.ok.get('/api/bootstrap');
    const warning = notices.find(n => n.kind === 'warning');
    assert.ok(warning, 'a warning notice is shown');
    assert.match(warning.message, /accounts\.json/);
    const kept = fs.readdirSync(dirs.dataDir).filter(n => n.startsWith('accounts.json.damaged-'));
    assert.equal(kept.length, 1, 'the damaged file is kept aside for inspection');
  });

  it('a recovered accounts.json is written back, so the next restart still has it', async () => {
    const dirs = tempDirs();
    const account = await installWithBackup(dirs);
    fs.writeFileSync(path.join(dirs.dataDir, 'accounts.json'), '{"this is": not json');

    const first = await boot(dirs);
    assert.equal((await first.ok.get('/api/accounts')).length, 1);
    await first.close();

    assert.ok(fs.existsSync(path.join(dirs.dataDir, 'accounts.json')), 'accounts.json should exist on disk after recovery');
    const second = await boot(dirs);
    const res = await second.get('/api/accounts');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.map(a => a.id), [account.id], 'the account must survive a second restart');
  });

  it('a recovered transactions file is written back, so the next restart still has it', async () => {
    const dirs = tempDirs();
    const account = await installWithBackup(dirs);
    const txFile = path.join(dirs.dataDir, 'transactions', `${account.id}.json`);
    fs.writeFileSync(txFile, '[{"id": "half-writ');

    const first = await boot(dirs);
    assert.equal((await first.ok.get(`/api/accounts/${account.id}/transactions`)).length, 2);
    await first.close();

    const second = await boot(dirs);
    const txs = await second.ok.get(`/api/accounts/${account.id}/transactions`);
    assert.equal(txs.length, 2, 'recovered transactions must not vanish on the next restart');
    assert.equal((await second.ok.get('/api/accounts'))[0].balance, 85);
  });

  it('refuses to start with a clear message when no backup has a readable copy', () => {
    const dirs = tempDirs();
    writeDataFolder(dirs.dataDir, { 'accounts.json': [], 'settings.json': { currencySymbol: '£' } });
    fs.writeFileSync(path.join(dirs.dataDir, 'categories.json'), '[{ broken');
    clock.set(NOW);
    assert.throws(
      () => createApp({ ...dirs, autoBackup: false, updateCheck: false, quiet: true, log: createTestLog() }),
      err => /categories\.json/.test(err.message) && /damaged/i.test(err.message) && /backup/i.test(err.message)
    );
    assert.equal(fs.readFileSync(path.join(dirs.dataDir, 'categories.json'), 'utf8'), '[{ broken', 'damaged file left in place');
  });

  it('refuses to start when the password file is damaged (never silently drops a password)', () => {
    const dirs = tempDirs();
    writeDataFolder(dirs.dataDir, { 'accounts.json': [] });
    fs.writeFileSync(path.join(dirs.dataDir, 'auth.json'), '{nope');
    clock.set(NOW);
    assert.throws(
      () => createApp({ ...dirs, autoBackup: false, updateCheck: false, quiet: true, log: createTestLog() }),
      /password file/i
    );
  });

  it('cleans up temp files and half-finished staging folders left by a crash', async () => {
    const dirs = tempDirs();
    await installWithBackup(dirs);
    fs.writeFileSync(path.join(dirs.dataDir, '.accounts.json.1234.abcd.tmp'), 'partial');
    fs.writeFileSync(path.join(dirs.dataDir, 'transactions', '.x.json.1.2.tmp'), 'partial');
    fs.mkdirSync(path.join(dirs.dataDir, '.staging-123', 'transactions'), { recursive: true });
    const server = await boot(dirs);
    assert.equal((await server.ok.get('/api/accounts')).length, 1);
    const leftovers = [
      ...fs.readdirSync(dirs.dataDir),
      ...fs.readdirSync(path.join(dirs.dataDir, 'transactions'))
    ].filter(n => n.endsWith('.tmp') || n.startsWith('.staging-'));
    assert.deepEqual(leftovers, []);
  });

  it('data recovered from an old-format (pre-upgrade) backup is upgraded before use', async () => {
    // Upgrade a v0.1.4 folder: the only backup is the pre-upgrade copy in the OLD format
    const dirs = tempDirs();
    writeDataFolder(dirs.dataDir, oldData('0.1.4').files);
    const first = await boot(dirs);
    await first.close();
    assert.equal(listBackups(dirs.backupsDir).length, 1);

    fs.writeFileSync(path.join(dirs.dataDir, 'transactions', 'acc0credit.json'), '[{"broken"');
    const server = await boot(dirs);
    const valid = allCategoryIds(await server.ok.get('/api/categories'));
    const txs = await server.ok.get('/api/accounts/acc0credit/transactions');
    assert.equal(txs.length, 2, 'transactions recovered');
    for (const t of txs) {
      assert.ok(valid.has(t.categoryId), `recovered tx ${t.id} should have a valid categoryId, got ${t.categoryId}`);
    }
    assert.equal(txs.find(t => t.id === 't21').categoryId, 'sub-dining');
  });
});
