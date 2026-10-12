// Restoring a backup ZIP made by v0.1.x (uploaded, or found in the backups folder) upgrades it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { clock } from '../../server/lib/clock.js';
import { SCHEMA_VERSION } from '../../server/store/migrations/index.js';
import { makeTempRoot, removeDir, startServer, readJSON, listBackups, makeAccount } from '../helpers/server.js';
import { oldData } from '../helpers/fixtures.js';
import { checkUpgradedData } from '../helpers/upgrade-suite.js';

// v0.1.x backups: every root-level JSON file plus transactions/<id>.json, written by adm-zip
function oldBackupZip(fixture) {
  const zip = new AdmZip();
  for (const [rel, value] of Object.entries(fixture.files)) {
    zip.addFile(rel, Buffer.from(JSON.stringify(value, null, 2)));
  }
  return zip.toBuffer();
}

for (const version of ['0.1.0', '0.1.2', '0.1.4']) {
  describe(`restoring a v${version} backup ZIP through the API`, () => {
    let dirs;
    let server;
    let fixture;
    let result;

    before(async () => {
      dirs = makeTempRoot();
      server = await startServer(dirs);
      await makeAccount(server, { name: 'About to be replaced', startingBalance: 42 });
      fixture = oldData(version);
      const res = await server.post('/api/backup/restore', oldBackupZip(fixture), { contentType: 'application/zip' });
      assert.equal(res.status, 200, res.body.toString());
      result = res.data;
    });

    after(async () => {
      await server?.close();
      clock.set(null);
      removeDir(dirs?.root);
    });

    it('reports the upgrade', () => {
      assert.equal(result.success, true);
      assert.equal(result.upgradedFrom, 0);
      assert.equal(result.accounts, fixture.accounts.length);
      const txCount = Object.values(fixture.transactions).reduce((n, l) => n + l.length, 0);
      assert.equal(result.transactions, txCount);
      assert.deepEqual(result.ignored, []);
    });

    it('saves a safety backup of the data it replaced', () => {
      assert.match(result.safetyBackup, /^safety-pre-restore-/);
      const zip = new AdmZip(path.join(dirs.backupsDir, result.safetyBackup));
      const accounts = JSON.parse(zip.readAsText('accounts.json'));
      assert.deepEqual(accounts.map(a => a.name), ['About to be replaced']);
    });

    it('upgrades the restored data exactly like an upgrade on start-up', async () => {
      assert.equal(readJSON(path.join(dirs.dataDir, 'meta.json')).schemaVersion, SCHEMA_VERSION);
      await checkUpgradedData(server, fixture, dirs);
    });

    it('survives a restart unchanged', async () => {
      await server.close();
      server = await startServer(dirs);
      const accounts = await server.ok.get('/api/accounts?all=1');
      assert.equal(accounts.length, fixture.accounts.length);
      assert.equal(listBackups(dirs.backupsDir, 'safety-pre-upgrade-').length, 0, 'already upgraded: no start-up migration');
      assert.deepEqual(server.log.errors, []);
    });
  });
}

describe('restoring an old automatic backup left in the backups folder', () => {
  let dirs;
  let server;

  before(async () => {
    dirs = makeTempRoot();
    fs.mkdirSync(dirs.backupsDir, { recursive: true });
    // v0.1.x named its hourly backups backup-<timestamp>.zip in the same folder
    fs.writeFileSync(path.join(dirs.backupsDir, 'backup-2026-06-01T10-00-00.zip'), oldBackupZip(oldData('0.1.4')));
    server = await startServer(dirs);
  });

  after(async () => {
    await server?.close();
    clock.set(null);
    removeDir(dirs?.root);
  });

  it('lists it and restores it with an upgrade', async () => {
    const list = await server.ok.get('/api/backups');
    const old = list.find(b => b.name === 'backup-2026-06-01T10-00-00.zip');
    assert.ok(old, 'old backup listed');
    assert.equal(old.kind, 'auto');
    const res = await server.ok.post('/api/backups/backup-2026-06-01T10-00-00.zip/restore');
    assert.equal(res.upgradedFrom, 0);
    await checkUpgradedData(server, oldData('0.1.4'), dirs);
  });
});
