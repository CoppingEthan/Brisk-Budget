import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { SCHEMA_VERSION } from '../../server/store/migrations/index.js';
import { freshServer, makeAccount, makeTx, txsOf, listBackups } from '../helpers/server.js';
import { pngDataUrl, PNG_BYTES } from '../helpers/fixtures.js';
import { buildStoreZip } from '../helpers/zip.js';

describe('backups', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current', startingBalance: 10, icon: pngDataUrl() });
    await makeTx(s, acc.id, { amount: -1, payee: 'Before backup' });
  });
  after(async () => { await s.close(); });

  it('downloads the whole dataset as a ZIP', async () => {
    const res = await s.get('/api/backup');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /^attachment; filename="brisk-budget-backup-.*\.zip"$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const zip = new AdmZip(res.body);
    const names = zip.getEntries().map(e => e.entryName).sort();
    for (const want of ['meta.json', 'accounts.json', 'categories.json', 'settings.json', 'payees.json', 'recurring.json', 'dismissed.json', 'account-groups.json', `transactions/${acc.id}.json`, `icons/account-${acc.id}.png`]) {
      assert.ok(names.includes(want), `zip has ${want}`);
    }
    assert.equal(JSON.parse(zip.readAsText('meta.json')).schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(zip.readFile(`icons/account-${acc.id}.png`), PNG_BYTES);
    assert.equal(JSON.parse(zip.readAsText(`transactions/${acc.id}.json`))[0].payee, 'Before backup');
  });

  it('creates, lists, downloads and deletes saved backups', async () => {
    const created = await s.post('/api/backups');
    assert.equal(created.status, 201);
    assert.match(created.data.name, /^manual-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-[0-9a-f]{4})?\.zip$/);
    assert.equal(created.data.kind, 'manual');
    const second = await s.ok.post('/api/backups');
    assert.notEqual(second.name, created.data.name, 'two backups in the same second get different names');

    const list = await s.ok.get('/api/backups');
    assert.ok(list.some(b => b.name === created.data.name));
    assert.ok(list.every(b => typeof b.size === 'number' && b.createdAt));

    const download = await s.get(`/api/backups/${created.data.name}`);
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, fs.readFileSync(path.join(s.backupsDir, created.data.name)));

    await s.ok.del(`/api/backups/${second.name}`);
    assert.equal(fs.existsSync(path.join(s.backupsDir, second.name)), false);
    assert.equal((await s.del(`/api/backups/${second.name}`)).status, 404);
  });

  it('only serves files that are backups', async () => {
    fs.writeFileSync(path.join(s.root, 'secret.zip'), 'secret');
    for (const name of ['secret.zip', '..%2Fsecret.zip', 'manual-..%2F..%2Fsecret.zip', 'notes.txt', '%2E%2E']) {
      assert.equal((await s.get(`/api/backups/${name}`)).status, 404, name);
      assert.equal((await s.post(`/api/backups/${name}/restore`)).status, 404, name);
    }
  });

  it('restoring a saved backup puts the data back and keeps a safety copy first', async () => {
    const snapshot = await s.ok.post('/api/backups');
    const extra = await makeTx(s, acc.id, { amount: -50, payee: 'After backup' });
    const newAccount = await makeAccount(s, { name: 'Created later' });

    const res = await s.ok.post(`/api/backups/${snapshot.name}/restore`);
    assert.equal(res.success, true);
    assert.equal(res.upgradedFrom, SCHEMA_VERSION);
    assert.match(res.safetyBackup, /^safety-pre-restore-/);

    const txs = await txsOf(s, acc.id);
    assert.equal(txs.some(t => t.id === extra.id), false);
    assert.equal((await s.ok.get('/api/accounts')).some(a => a.id === newAccount.id), false);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'transactions', `${newAccount.id}.json`)), false, 'files of accounts not in the backup are removed');

    // The safety copy holds what was replaced, so the restore can itself be undone
    const safety = new AdmZip(path.join(s.backupsDir, res.safetyBackup));
    assert.ok(JSON.parse(safety.readAsText('accounts.json')).some(a => a.id === newAccount.id));
    const undo = await s.ok.post(`/api/backups/${res.safetyBackup}/restore`);
    assert.equal(undo.success, true);
    assert.ok((await txsOf(s, acc.id)).some(t => t.id === extra.id));
  });

  it('uploading a backup ZIP restores it', async () => {
    const zip = (await s.get('/api/backup')).body;
    await makeTx(s, acc.id, { amount: -2, payee: 'Will vanish' });
    const res = await s.post('/api/backup/restore', zip, { contentType: 'application/zip' });
    assert.equal(res.status, 200);
    assert.equal((await txsOf(s, acc.id)).some(t => t.payee === 'Will vanish'), false);
    assert.equal(listBackups(s.backupsDir, 'safety-pre-restore-').length >= 2, true);
  });

  it('refuses files that are not Brisk Budget backups, leaving data untouched', async () => {
    const before = await txsOf(s, acc.id);
    const cases = [
      Buffer.from('this is not a zip file'),
      buildStoreZip([{ name: 'readme.txt', data: 'hello' }]),
      buildStoreZip([{ name: 'accounts.json', data: '{"not": "a list"}' }]),
      buildStoreZip([{ name: 'accounts.json', data: '[]' }, { name: 'categories.json', data: '[{broken' }]),
      buildStoreZip([{ name: 'accounts.json', data: '[]' }, { name: 'meta.json', data: { schemaVersion: SCHEMA_VERSION + 1 } }])
    ];
    for (const body of cases) {
      const res = await s.post('/api/backup/restore', body, { contentType: 'application/zip' });
      assert.equal(res.status, 400, res.body.toString());
      assert.ok(res.data.error);
    }
    assert.deepEqual(await txsOf(s, acc.id), before);
  });

  it('a hand-edited backup with malformed rows cannot break the app', async () => {
    const zip = buildStoreZip([
      { name: 'meta.json', data: { schemaVersion: SCHEMA_VERSION, appVersion: '0.4.0', history: [] } },
      { name: 'accounts.json', data: [{ id: 'hand1', name: 'Hand edited', type: 'bank', startingBalance: 5, active: true }] },
      {
        name: 'transactions/hand1.json',
        data: [
          null,
          { id: 'ok1', date: '2026-10-01', amount: -1, payee: 'Fine', categoryId: 'sub-coffee' },
          { id: 'bad1', amount: 'lots', payee: 7 }
        ]
      }
    ]);
    const res = await s.post('/api/backup/restore', zip, { contentType: 'application/zip' });
    assert.ok(res.status === 200 || res.status === 400, `restore answered ${res.status}`);
    const broken = [];
    for (const url of ['/api/bootstrap', '/api/accounts', '/api/dashboard/summary', '/api/data-check', '/api/accounts/hand1/ledger', '/api/payees']) {
      const r = await s.get(url);
      if (r.status >= 500) broken.push(`${url} -> ${r.status}`);
    }
    assert.deepEqual(broken, [], 'endpoints broken after restoring a malformed backup');
  });
});
