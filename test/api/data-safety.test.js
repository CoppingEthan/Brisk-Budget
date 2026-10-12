// What happens to data when the disk misbehaves: a full or read-only disk while saving, a full
// write (upgrade, restore) cut off part-way, files that are locked rather than damaged, and data
// that has to be upgraded a second time.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { createApp } from '../../server/app.js';
import { importedId } from '../../server/store/migrations/002-category-ids.js';
import { makeTempRoot, removeDir, startServer, createTestLog, makeAccount, makeTx, txsOf, readJSON, NOW, listBackups } from '../helpers/server.js';
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

async function boot(dirs) {
  const server = await startServer(dirs);
  cleanups.push(() => server.close());
  return server;
}

// Make every new temporary file fail as if the disk were full, until the returned function runs
function fillDisk() {
  const original = fs.openSync;
  fs.openSync = function (file, ...rest) {
    if (String(file).endsWith('.tmp')) {
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    return original.call(this, file, ...rest);
  };
  return () => { fs.openSync = original; };
}

describe('saving when the disk is full', () => {
  it('a change that could not be saved is not kept in memory or written later', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    const current = await makeAccount(server, { name: 'Current' });
    const savings = await makeAccount(server, { name: 'Savings', type: 'savings' });
    await makeTx(server, current.id, { payee: 'Before' });

    const freeDisk = fillDisk();
    let failed;
    try {
      failed = await server.post(`/api/accounts/${current.id}/transactions`, { date: '2026-10-05', amount: -25, payee: 'Shop' });
      const transfer = await server.post('/api/transfers', { fromAccountId: current.id, toAccountId: savings.id, amount: 100, date: '2026-10-05' });
      assert.equal(transfer.status, 500);
    } finally {
      freeDisk();
    }
    assert.equal(failed.status, 500);
    assert.match(failed.data.error, /disk is full/);
    assert.match(failed.data.error, /wasn't made/);
    assert.deepEqual((await txsOf(server, current.id)).map(t => t.payee), ['Before'], 'nothing half-saved shows');
    assert.deepEqual(await txsOf(server, savings.id), []);

    await makeTx(server, current.id, { payee: 'After' });
    await server.close();
    const again = await boot(dirs);
    assert.deepEqual((await txsOf(again, current.id)).map(t => t.payee).sort(), ['After', 'Before']);
    assert.deepEqual(await txsOf(again, savings.id), []);
  });
});

describe('a full write cut off part-way', () => {
  it('one that finished writing its files is completed at the next start', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    const account = await makeAccount(server, { name: 'Old name' });
    await server.close();

    const staging = path.join(dirs.dataDir, '.staging-1');
    fs.mkdirSync(path.join(staging, 'transactions'), { recursive: true });
    const accounts = readJSON(path.join(dirs.dataDir, 'accounts.json'));
    accounts[0].name = 'New name';
    fs.writeFileSync(path.join(staging, 'accounts.json'), JSON.stringify(accounts));
    fs.writeFileSync(path.join(staging, 'transactions', `${account.id}.json`), JSON.stringify([{ id: 'tx1', date: '2026-10-01', amount: -3, payee: 'Staged', categoryId: 'cat-uncategorized', description: '', notes: '', createdAt: NOW, transferId: null, transferAccountId: null }]));
    fs.writeFileSync(path.join(staging, 'COMMITTED.json'), JSON.stringify({ transactions: [account.id], icons: [] }));

    const again = await boot(dirs);
    assert.equal((await again.ok.get('/api/accounts'))[0].name, 'New name');
    assert.deepEqual((await txsOf(again, account.id)).map(t => t.payee), ['Staged']);
    assert.equal(fs.existsSync(staging), false);
  });

  it('one that never finished writing is thrown away and the old files are kept', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    await makeAccount(server, { name: 'Kept' });
    await server.close();

    const staging = path.join(dirs.dataDir, '.staging-2');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'accounts.json'), '[]');

    const again = await boot(dirs);
    assert.deepEqual((await again.ok.get('/api/accounts')).map(a => a.name), ['Kept']);
    assert.equal(fs.existsSync(staging), false);
  });
});

describe('files that cannot be read right now', () => {
  it('a locked file stops start-up with a clear message and is never replaced by a backup', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    await makeAccount(server, { name: 'Current' });
    await server.ok.post('/api/backups');
    await makeAccount(server, { name: 'Added after the backup' });
    await server.close();

    const file = path.join(dirs.dataDir, 'accounts.json');
    const before = fs.readFileSync(file, 'utf8');
    const original = fs.readFileSync;
    fs.readFileSync = function (target, ...rest) {
      if (String(target) === file) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return original.call(this, target, ...rest);
    };
    try {
      clock.set(NOW);
      assert.throws(
        () => createApp({ ...dirs, autoBackup: false, updateCheck: false, quiet: true, log: createTestLog() }),
        err => /couldn't read accounts\.json \(EBUSY\)/.test(err.message)
      );
    } finally {
      fs.readFileSync = original;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dirs.dataDir).filter(n => n.includes('.damaged-')), []);
  });

  it("one account's damaged transactions don't stop the app: the account starts empty and the file is kept", async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    const broken = await makeAccount(server, { name: 'Broken' });
    const fine = await makeAccount(server, { name: 'Fine' });
    await makeTx(server, fine.id, { payee: 'Still here' });
    await server.close();
    fs.writeFileSync(path.join(dirs.dataDir, 'transactions', `${broken.id}.json`), '[{ nope');

    const again = await boot(dirs);
    assert.deepEqual(await txsOf(again, broken.id), []);
    assert.deepEqual((await txsOf(again, fine.id)).map(t => t.payee), ['Still here']);
    const kept = fs.readdirSync(path.join(dirs.dataDir, 'transactions')).filter(n => n.startsWith(`${broken.id}.json.damaged-`));
    assert.equal(kept.length, 1);
    const notices = (await again.ok.get('/api/bootstrap')).notices;
    assert.ok(notices.some(n => /Broken/.test(n.message) && n.message.includes(kept[0])));
  });
});

describe('upgrading data a second time', () => {
  it('re-running the upgrade (lost meta.json) keeps categories that share a name, and moved due dates', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    const account = await makeAccount(server);
    const food = await server.ok.post('/api/categories/cat-food/subcategories', { name: 'Other' });
    const bills = await server.ok.post('/api/categories/cat-bills/subcategories', { name: 'Other' });
    const gifts = await server.ok.post('/api/categories', { name: 'Gifts' });
    await makeTx(server, account.id, { payee: 'Food other', categoryId: food.id });
    await makeTx(server, account.id, { payee: 'Bills other', categoryId: bills.id });
    await makeTx(server, account.id, { payee: 'Custom gifts', categoryId: gifts.id });
    await makeTx(server, account.id, { payee: 'Shop gifts', categoryId: 'sub-gifts' });
    const t = await server.ok.post('/api/recurring', { accountId: account.id, payee: 'Rent', amount: -500, startDate: '2026-11-15' });
    await server.ok.put(`/api/recurring/${t.id}`, { nextDueDate: '2026-11-17' });
    await server.close();
    fs.unlinkSync(path.join(dirs.dataDir, 'meta.json'));

    const again = await boot(dirs);
    const byPayee = Object.fromEntries((await txsOf(again, account.id)).map(x => [x.payee, x.categoryId]));
    assert.deepEqual(byPayee, { 'Food other': food.id, 'Bills other': bills.id, 'Custom gifts': gifts.id, 'Shop gifts': 'sub-gifts' });
    assert.equal((await again.ok.get('/api/recurring')).find(x => x.id === t.id).nextDueDate, '2026-11-17');
  });

  it('old files copied over a newer install are upgraded properly, after a backup', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    await server.close();
    const fixture = oldData('0.1.4');
    writeDataFolder(dirs.dataDir, fixture.files);

    const again = await boot(dirs);
    for (const [txId, categoryId] of Object.entries(fixture.expectedCategory)) {
      const found = Object.values(again.app.store.data.transactions).flat().find(x => x.id === txId);
      assert.ok(found, txId);
      assert.equal(found.categoryId, categoryId.startsWith('IMPORTED:') ? importedId(categoryId.slice(9)) : categoryId, txId);
    }
    assert.ok(again.app.store.data.accounts.every(a => a.icon === null || typeof a.icon === 'object'), 'inline icons became files');
    assert.ok(listBackups(dirs.backupsDir, 'safety-pre-upgrade').length >= 1);
  });

  it('categories kept under Imported get the same id every time', () => {
    assert.equal(importedId('Holiday Fund'), importedId('holiday fund'));
    assert.match(importedId('Holiday Fund'), /^imp-[0-9a-f]{12}$/);
    assert.notEqual(importedId('Holiday Fund'), importedId('Holiday Funds'));
  });

  it('a repair at start-up takes a backup first', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    await makeAccount(server, { name: 'Current' });
    await server.close();
    const file = path.join(dirs.dataDir, 'payees.json');
    fs.writeFileSync(file, JSON.stringify({ not: 'a list' }));

    await boot(dirs);
    assert.equal(listBackups(dirs.backupsDir, 'safety-pre-repair').length, 1);
  });
});

describe('transaction files', () => {
  it('are written one transaction per line', async () => {
    const dirs = tempDirs();
    const server = await boot(dirs);
    const account = await makeAccount(server);
    await makeTx(server, account.id, { payee: 'One' });
    await makeTx(server, account.id, { payee: 'Two' });
    const text = fs.readFileSync(path.join(dirs.dataDir, 'transactions', `${account.id}.json`), 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(text).length, 2);
  });
});
