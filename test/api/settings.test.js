import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshServer, readJSON, startServer } from '../helpers/server.js';

describe('settings', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('starts with sensible defaults', async () => {
    assert.deepEqual(await s.ok.get('/api/settings'), { currencySymbol: '£', name: '', groupChartToggles: true, checkForUpdates: true });
  });

  it('updates and saves settings, ignoring unknown keys', async () => {
    const res = await s.ok.put('/api/settings', { currencySymbol: '€', name: '  Ethan ', groupChartToggles: false, checkForUpdates: false, isAdmin: true });
    assert.deepEqual(res, { currencySymbol: '€', name: 'Ethan', groupChartToggles: false, checkForUpdates: false });
    assert.deepEqual(readJSON(path.join(s.dataDir, 'settings.json')), res);
    const boot = await s.ok.get('/api/bootstrap');
    assert.equal(boot.settings.currencySymbol, '€');
  });

  it('validates settings', async () => {
    for (const body of [
      { currencySymbol: '' },
      { currencySymbol: 'EURO$' },
      { currencySymbol: '<b>' },
      { name: 'x'.repeat(61) },
      { groupChartToggles: 'yes' },
      { checkForUpdates: 1 }
    ]) {
      assert.equal((await s.put('/api/settings', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await s.ok.get('/api/settings')).currencySymbol, '€');
  });

  it('survive a restart', async () => {
    await s.stop();
    const again = await startServer({ dataDir: s.dataDir, backupsDir: s.backupsDir });
    try {
      assert.equal((await again.ok.get('/api/settings')).name, 'Ethan');
    } finally {
      await again.close();
    }
  });
});

describe('bootstrap', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('returns everything the interface needs in one request', async () => {
    const acc = await s.ok.post('/api/accounts', { name: 'Visible' });
    const archived = await s.ok.post('/api/accounts', { name: 'Archived' });
    await s.ok.del(`/api/accounts/${archived.id}`);
    const boot = await s.ok.get('/api/bootstrap');
    for (const key of ['version', 'settings', 'accounts', 'groups', 'categories', 'payees', 'recurring', 'auth', 'update', 'notices']) {
      assert.ok(key in boot, `bootstrap has ${key}`);
    }
    assert.deepEqual(boot.accounts.map(a => a.id).sort(), [acc.id, archived.id].sort(), 'archived accounts included for history');
    assert.deepEqual(boot.auth, { enabled: false, authenticated: true });
    assert.deepEqual(boot.notices, [], 'a fresh install has no notices');
    assert.equal(boot.update.checkEnabled, false);
  });
});

describe('version information', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('reports the running version and does not call out when update checks are off', async () => {
    const pkg = readJSON(fileURLToPath(new URL('../../package.json', import.meta.url)));
    const info = await s.ok.get('/api/version');
    assert.equal(info.current, pkg.version);
    assert.equal(info.checkEnabled, false);
    assert.equal(info.updateAvailable, false);
    const checked = await s.ok.post('/api/version/check');
    assert.equal(checked.checkedAt, null, 'no network request made');
    const health = await s.ok.get('/api/health');
    assert.deepEqual(health, { ok: true, version: pkg.version });
  });
});
