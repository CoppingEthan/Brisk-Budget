// The checks every old-version upgrade must pass. Exported as a function so this file
// registers nothing by itself; test/upgrade/*.test.js call it once per old version.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { clock } from '../../server/lib/clock.js';
import { SCHEMA_VERSION } from '../../server/store/migrations/index.js';
import { makeTempRoot, removeDir, startServer, readJSON, listBackups } from './server.js';
import { oldData, writeDataFolder, expectedBalancesPence, JPEG_BYTES, PNG_BYTES } from './fixtures.js';

export function readTxFiles(dataDir) {
  const dir = path.join(dataDir, 'transactions');
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) out[name.slice(0, -5)] = readJSON(path.join(dir, name));
  }
  return out;
}

export function allCategoryIds(categories) {
  const ids = new Set();
  for (const c of categories) {
    ids.add(c.id);
    for (const s of c.subcategories || []) ids.add(s.id);
  }
  return ids;
}

export function importedSubId(categories, name) {
  const imported = categories.find(c => c.id === 'cat-imported');
  assert.ok(imported, 'an "Imported" category should exist');
  const sub = imported.subcategories.find(s => s.name === name);
  assert.ok(sub, `"${name}" should be kept under Imported`);
  return sub.id;
}

// Checks that only depend on the upgraded data (shared with "restore an old backup")
export async function checkUpgradedData(server, fixture, { dataDir }) {
  const categories = await server.ok.get('/api/categories');
  const validIds = allCategoryIds(categories);

  // Every transaction has a valid categoryId, both through the API and on disk
  const onDisk = readTxFiles(dataDir);
  for (const [accountId, list] of Object.entries(onDisk)) {
    for (const t of list) {
      assert.ok(validIds.has(t.categoryId), `tx ${t.id} in ${accountId} has unknown categoryId ${t.categoryId}`);
      assert.equal('category' in t, false, `tx ${t.id} still stores a category name`);
    }
  }
  const accounts = await server.ok.get('/api/accounts?all=1');
  for (const account of accounts) {
    for (const t of await server.ok.get(`/api/accounts/${account.id}/transactions`)) {
      assert.ok(validIds.has(t.categoryId), `API tx ${t.id} has unknown categoryId ${t.categoryId}`);
    }
  }

  // Name -> id mapping rules
  const byId = new Map(Object.values(onDisk).flat().map(t => [t.id, t]));
  for (const [txId, expected] of Object.entries(fixture.expectedCategory)) {
    const t = byId.get(txId);
    if (!t) continue; // not part of this version's fixture
    const want = expected.startsWith('IMPORTED:') ? importedSubId(categories, expected.slice(9)) : expected;
    assert.equal(t.categoryId, want, `tx ${txId}`);
  }
  const imported = categories.find(c => c.id === 'cat-imported');
  assert.deepEqual(imported.subcategories.map(s => s.name), ['Holiday Fund'], 'unknown names are kept once each');

  // Every transaction kept, none added
  for (const [accountId, list] of Object.entries(fixture.transactions)) {
    assert.deepEqual((onDisk[accountId] || []).map(t => t.id).sort(), list.map(t => t.id).sort(), `transactions of ${accountId}`);
  }

  // Balances identical to before
  const expected = expectedBalancesPence(fixture);
  for (const account of accounts) {
    assert.equal(Math.round(account.balance * 100), expected[account.id], `balance of ${account.name}`);
  }
  assert.equal(accounts.length, fixture.accounts.length);

  // String amounts and short dates cleaned
  assert.equal(byId.get('t07').amount, -12.5);
  assert.equal(typeof byId.get('t07').amount, 'number');
  assert.equal(byId.get('t08').date, '2024-01-05');
  const accountsOnDisk = readJSON(path.join(dataDir, 'accounts.json'));
  assert.equal(accountsOnDisk.find(a => a.id === 'acc0savings').startingBalance, 250.5);

  // Icons moved out of accounts.json into files, and served
  assert.equal(JSON.stringify(accountsOnDisk).includes('data:image'), false, 'accounts.json still contains base64 icons');
  const iconFile = path.join(dataDir, 'icons', 'account-acc0current.jpg');
  assert.ok(fs.existsSync(iconFile), 'account icon file written');
  assert.deepEqual(fs.readFileSync(iconFile), JPEG_BYTES);
  const current = accounts.find(a => a.id === 'acc0current');
  assert.match(current.icon, /^\/api\/icons\/account-acc0current\.jpg\?v=[0-9a-f]+$/);
  const iconRes = await server.get(current.icon);
  assert.equal(iconRes.status, 200);
  assert.equal(iconRes.headers['content-type'], 'image/jpeg');
  assert.deepEqual(iconRes.body, JPEG_BYTES);
  for (const a of accounts.filter(x => x.id !== 'acc0current')) assert.equal(a.icon, null);

  // Recurring templates: categories, drift repair, anchor days
  const recurring = readJSON(path.join(dataDir, 'recurring.json'));
  const rec = Object.fromEntries(recurring.map(r => [r.id, r]));
  assert.equal(rec.rec0rent.nextDueDate, '2026-10-31', 'start 31 Jan, slipped to the 3rd: pulled back to the 31st');
  assert.equal(rec.rec0rent.anchorDay, 31);
  assert.equal(rec.rec0council.nextDueDate, '2026-05-16', 'slipped back a day by a clock change: repaired');
  assert.equal(rec.rec0council.anchorDay, 16);
  assert.equal(rec.rec0gym.nextDueDate, '2026-11-10', 'on schedule: untouched');
  assert.equal(rec.rec0save.nextDueDate, '2026-10-28', 'on schedule: untouched');
  assert.equal(rec.rec0rent.categoryId, 'sub-rent');
  assert.equal(rec.rec0council.categoryId, 'sub-council-tax');
  assert.equal(rec.rec0gym.categoryId, 'sub-gym');
  assert.equal(rec.rec0save.categoryId, 'cat-transfer');
  assert.equal(rec.rec0deleted.categoryId, 'sub-streaming');
  assert.equal(rec.rec0deleted.active, false);
  for (const r of recurring) {
    assert.equal('category' in r, false);
    assert.equal(r.autoLog, false);
    assert.equal(typeof r.paused, 'boolean');
  }
  assert.equal(rec.rec0rent.occurrencesCompleted, 9);
  const apiRecurring = await server.ok.get('/api/recurring');
  assert.equal(apiRecurring.some(r => r.id === 'rec0deleted'), false, 'deleted templates stay deleted');

  // Categories: colours everywhere, system categories present
  for (const c of categories) assert.match(c.color, /^#[0-9a-fA-F]{6}$/, `colour of ${c.name}`);
  assert.ok(categories.some(c => c.id === 'cat-transfer'));
  assert.ok(categories.some(c => c.id === 'cat-uncategorized'));
  const gifts = categories.find(c => c.id === 'lx1custgifts');
  assert.equal(gifts.name, 'Gifts');
  assert.deepEqual(gifts.subcategories.map(s => s.id), ['lx1subbday']);

  // Payees: blanks and case duplicates removed
  const payees = await server.ok.get('/api/payees');
  assert.deepEqual(payees.map(p => p.name), ['Costa', 'Tesco']);

  // Transfers still linked; payee text comes from the current account name
  const currentTxs = await server.ok.get('/api/accounts/acc0current/transactions');
  const out = currentTxs.find(t => t.id === 't03');
  assert.equal(out.transferId, 't11');
  assert.equal(out.transferAccountId, 'acc0savings');
  assert.equal(out.payee, 'Transfer to Savings');
  assert.equal(out.categoryId, 'cat-transfer');
  const savingsTxs = await server.ok.get('/api/accounts/acc0savings/transactions');
  assert.equal(savingsTxs.find(t => t.id === 't11').payee, 'Transfer from Current Account');

  // Archived accounts stay archived
  assert.equal(accounts.find(a => a.id === 'acc0archived').active, false);
  const visible = await server.ok.get('/api/accounts');
  assert.equal(visible.some(a => a.id === 'acc0archived'), false);
}

export function upgradeSuite(version) {
  describe(`upgrading a v${version} data folder`, () => {
    let dirs;
    let fixture;
    let server;
    let originalAccounts;
    let originalTx;

    before(async () => {
      dirs = makeTempRoot();
      fixture = oldData(version);
      writeDataFolder(dirs.dataDir, fixture.files);
      originalAccounts = fs.readFileSync(path.join(dirs.dataDir, 'accounts.json'), 'utf8');
      originalTx = fs.readFileSync(path.join(dirs.dataDir, 'transactions', 'acc0current.json'), 'utf8');
      server = await startServer(dirs);
    });

    after(async () => {
      await server?.close();
      clock.set(null);
      removeDir(dirs?.root);
    });

    it('records the latest data format in meta.json', () => {
      const meta = readJSON(path.join(dirs.dataDir, 'meta.json'));
      assert.equal(meta.schemaVersion, SCHEMA_VERSION);
      assert.equal(meta.history.length, 1);
      assert.equal(meta.history[0].from, 0);
      assert.equal(meta.history[0].to, SCHEMA_VERSION);
    });

    it('took a safety backup of the untouched old files before changing anything', () => {
      const safety = listBackups(dirs.backupsDir, 'safety-pre-upgrade-');
      assert.equal(safety.length, 1, `expected one safety-pre-upgrade backup, found ${safety.join(', ')}`);
      const zip = new AdmZip(path.join(dirs.backupsDir, safety[0]));
      assert.equal(zip.readAsText('accounts.json'), originalAccounts, 'backup holds the original accounts.json');
      assert.equal(zip.readAsText('transactions/acc0current.json'), originalTx, 'backup holds the original transactions');
      for (const file of Object.keys(fixture.files)) assert.ok(zip.getEntry(file), `backup includes ${file}`);
    });

    it('converts all data to the new format without losing or changing anything', async () => {
      await checkUpgradedData(server, fixture, dirs);
    });

    it('shows an upgrade notice that names the safety backup', async () => {
      const boot = await server.ok.get('/api/bootstrap');
      const notice = boot.notices.find(n => n.kind === 'upgrade');
      assert.ok(notice, 'upgrade notice present');
      const safety = listBackups(dirs.backupsDir, 'safety-pre-upgrade-')[0];
      assert.ok(notice.message.includes(safety), notice.message);
    });

    it('keeps the version-specific fields', async () => {
      const accounts = await server.ok.get('/api/accounts?all=1');
      const groups = await server.ok.get('/api/account-groups');
      const byId = Object.fromEntries(accounts.map(a => [a.id, a]));
      const settings = await server.ok.get('/api/settings');
      assert.equal(settings.currencySymbol, '£');
      assert.equal(settings.checkForUpdates, true);
      const recurring = readJSON(path.join(dirs.dataDir, 'recurring.json'));
      const dismissed = readJSON(path.join(dirs.dataDir, 'dismissed.json'));

      if (version === '0.1.0') {
        assert.deepEqual(groups, []);
        assert.ok(accounts.every(a => a.groupId === null));
        assert.ok(recurring.every(r => r.paused === false));
        assert.deepEqual(dismissed, []);
        assert.ok(fs.existsSync(path.join(dirs.dataDir, 'account-groups.json')), 'account-groups.json created');
      } else {
        assert.equal(groups.length, 1);
        assert.equal(groups[0].name, 'Everyday');
        assert.match(groups[0].icon, /^\/api\/icons\/group-grp0everyday\.png\?v=/);
        const icon = await server.get(groups[0].icon);
        assert.equal(icon.status, 200);
        assert.equal(icon.headers['content-type'], 'image/png');
        assert.deepEqual(icon.body, PNG_BYTES);
        assert.equal(byId.acc0current.groupId, 'grp0everyday');
        assert.equal(byId.acc0savings.groupId, null, 'group that no longer exists is cleared');
        const groupsOnDisk = readJSON(path.join(dirs.dataDir, 'account-groups.json'));
        assert.equal(JSON.stringify(groupsOnDisk).includes('data:image'), false);
      }

      if (version === '0.1.4') {
        assert.deepEqual(dismissed, ['acc0current|tesco']);
        assert.equal(recurring.find(r => r.id === 'rec0paused').paused, true);
        assert.equal(recurring.find(r => r.id === 'rec0paused').categoryId, 'sub-music');
        assert.equal(settings.groupChartToggles, false);
        const mortgage = byId.acc0mortgage;
        assert.equal(mortgage.type, 'mortgage');
        assert.equal(mortgage.interestRate, 4.8);
        assert.equal(mortgage.lastInterestAccrual, '2026-09-20');
        assert.equal(mortgage.assetValue, 300000);
        const mtx = await server.ok.get('/api/accounts/acc0mortgage/transactions');
        assert.equal(mtx.length, 2, 'no interest due yet, so nothing new posted');
        const interest = mtx.find(t => t.id === 't32');
        assert.equal(interest.autoInterest, true);
        assert.equal(interest.categoryId, 'sub-mortgage');
      } else {
        assert.equal(byId.acc0current.interestRate, null);
        assert.equal(byId.acc0current.lastInterestAccrual, null);
      }
    });

    it('does not migrate again or take another backup on the next start', async () => {
      const before = readTxFiles(dirs.dataDir);
      const beforeRecurring = fs.readFileSync(path.join(dirs.dataDir, 'recurring.json'), 'utf8');
      const backupsBefore = listBackups(dirs.backupsDir);
      await server.close();
      server = await startServer(dirs);
      assert.deepEqual(listBackups(dirs.backupsDir), backupsBefore, 'no new backups');
      const meta = readJSON(path.join(dirs.dataDir, 'meta.json'));
      assert.equal(meta.history.length, 1, 'no second migration recorded');
      assert.deepEqual(readTxFiles(dirs.dataDir), before);
      assert.equal(fs.readFileSync(path.join(dirs.dataDir, 'recurring.json'), 'utf8'), beforeRecurring);
      const boot = await server.ok.get('/api/bootstrap');
      assert.equal(boot.notices.filter(n => n.kind === 'upgrade').length, 1, 'still exactly one upgrade notice');
      assert.deepEqual(server.log.errors, []);
    });
  });
}
