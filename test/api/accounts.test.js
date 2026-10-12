import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { freshServer, makeAccount, makeTx, readJSON, NOW } from '../helpers/server.js';
import { PNG_BYTES, JPEG_BYTES, pngDataUrl, jpegDataUrl } from '../helpers/fixtures.js';

describe('accounts', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('creates an account with a balance and defaults', async () => {
    const res = await s.post('/api/accounts', { name: '  Current  ', type: 'bank', startingBalance: '1,000' });
    assert.equal(res.status, 400, 'a formatted string is not silently accepted as a number');
    const account = await makeAccount(s, { name: '  Current  ', startingBalance: 1000.456 });
    assert.equal(account.name, 'Current');
    assert.equal(account.startingBalance, 1000.46);
    assert.equal(account.balance, 1000.46);
    assert.equal(account.active, true);
    assert.equal(account.icon, null);
    assert.equal(account.interestRate, null);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'transactions', `${account.id}.json`)), 'transactions file created');
  });

  it('validates new accounts', async () => {
    assert.equal((await s.post('/api/accounts', {})).status, 400);
    assert.equal((await s.post('/api/accounts', { name: '   ' })).status, 400);
    assert.equal((await s.post('/api/accounts', { name: 'X', type: 'piggybank' })).status, 400);
    assert.equal((await s.post('/api/accounts', { name: 'X', groupId: 'nope' })).status, 400);
    assert.equal((await s.post('/api/accounts', { name: 'x'.repeat(101) })).status, 400);
    assert.equal((await s.post('/api/accounts', [1, 2])).status, 400);
  });

  it('mortgage accounts keep a rate and start accruing from today; other types drop it', async () => {
    const mortgage = await makeAccount(s, { name: 'Home', type: 'mortgage', startingBalance: -150000, interestRate: 4.5, assetValue: 250000 });
    assert.equal(mortgage.interestRate, 4.5);
    assert.equal(mortgage.lastInterestAccrual, '2026-10-12');
    assert.equal(mortgage.assetValue, 250000);
    const bank = await makeAccount(s, { name: 'Plain', type: 'bank', interestRate: 3, assetValue: 99 });
    assert.equal(bank.interestRate, null);
    assert.equal(bank.assetValue, null);
    assert.equal((await s.post('/api/accounts', { name: 'Bad', type: 'mortgage', interestRate: 101 })).status, 400);
  });

  it('switching an account back to a mortgage does not backdate interest', async () => {
    clock.set('2026-03-01T12:00:00Z');
    try {
      const m = await makeAccount(s, { name: 'Oops', type: 'mortgage', startingBalance: -100000, interestRate: 6 });
      await s.ok.put(`/api/accounts/${m.id}`, { type: 'loan' }); // picked the wrong type at first
      clock.set('2026-10-12T12:00:00Z');
      const again = await s.ok.put(`/api/accounts/${m.id}`, { type: 'mortgage', interestRate: 6 });
      await s.ok.get('/api/bootstrap'); // housekeeping
      const interest = (await s.ok.get(`/api/accounts/${m.id}/transactions`)).filter(t => t.autoInterest);
      assert.deepEqual(interest.map(t => t.date), [], 'no interest for the months it was not a mortgage');
      assert.equal(again.lastInterestAccrual, '2026-10-12');
    } finally {
      clock.set(NOW);
    }
  });

  it('updates fields and recalculates the balance from transactions', async () => {
    const a = await makeAccount(s, { name: 'Upd', startingBalance: 10 });
    await makeTx(s, a.id, { amount: -2.5 });
    const updated = await s.ok.put(`/api/accounts/${a.id}`, { name: 'Updated', startingBalance: 20 });
    assert.equal(updated.name, 'Updated');
    assert.equal(updated.balance, 17.5);
    assert.equal((await s.put('/api/accounts/doesnotexist', { name: 'x' })).status, 404);
  });

  it('a rejected update leaves the account exactly as it was', async () => {
    const a = await makeAccount(s, { name: 'Untouched', startingBalance: 5 });
    const res = await s.put(`/api/accounts/${a.id}`, { name: 'Half applied', type: 'not-a-type' });
    assert.equal(res.status, 400);
    const after = (await s.ok.get('/api/accounts')).find(x => x.id === a.id);
    assert.equal(after.name, 'Untouched', 'validation failed, so nothing should have changed');
  });

  it('archiving hides the account, keeps its data and pauses its recurring payments', async () => {
    const a = await makeAccount(s, { name: 'To archive', startingBalance: 50 });
    const b = await makeAccount(s, { name: 'Other' });
    await makeTx(s, a.id, { amount: -5 });
    const r1 = await s.ok.post('/api/recurring', { accountId: a.id, payee: 'Gym', amount: -30, startDate: '2026-11-01' });
    const r2 = await s.ok.post('/api/recurring', { type: 'transfer', fromAccountId: b.id, toAccountId: a.id, amount: 100, startDate: '2026-11-01' });
    const r3 = await s.ok.post('/api/recurring', { accountId: b.id, payee: 'Unrelated', amount: -1, startDate: '2026-11-01' });

    const res = await s.ok.del(`/api/accounts/${a.id}`);
    assert.equal(res.pausedRecurring, 2);
    assert.equal((await s.ok.get('/api/accounts')).some(x => x.id === a.id), false);
    const all = await s.ok.get('/api/accounts?all=1');
    const archived = all.find(x => x.id === a.id);
    assert.equal(archived.active, false);
    assert.equal(archived.balance, 45);
    assert.ok((await s.ok.get('/api/accounts/all')).some(x => x.id === a.id));

    const recurring = Object.fromEntries((await s.ok.get('/api/recurring')).map(r => [r.id, r]));
    assert.equal(recurring[r1.id].paused, true);
    assert.equal(recurring[r1.id].status, 'paused');
    assert.equal(recurring[r2.id].paused, true);
    assert.equal(recurring[r3.id].paused, false);

    assert.equal((await s.post(`/api/accounts/${a.id}/transactions`, { date: '2026-10-01', amount: -1, payee: 'x' })).status, 400,
      'no new transactions in an archived account');

    const restored = await s.ok.post(`/api/accounts/${a.id}/restore`);
    assert.equal(restored.active, true);
    assert.equal(restored.archivedAt, undefined);
    assert.ok((await s.ok.get('/api/accounts')).some(x => x.id === a.id));
  });

  it('reorders accounts', async () => {
    const before = await s.ok.get('/api/accounts');
    const ids = before.map(a => a.id).reverse();
    await s.ok.put('/api/accounts/reorder', { accountIds: ids });
    assert.deepEqual((await s.ok.get('/api/accounts')).map(a => a.id), ids);
    assert.equal((await s.put('/api/accounts/reorder', { accountIds: 'nope' })).status, 400);
    assert.equal((await s.put('/api/accounts/reorder', { accountIds: ['../../etc'] })).status, 400);
  });
});

describe('account icons', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('uploads an icon as a data URL, serves it as a cacheable file and removes it', async () => {
    const a = await makeAccount(s, { name: 'Iconic', icon: pngDataUrl() });
    assert.match(a.icon, new RegExp(`^/api/icons/account-${a.id}\\.png\\?v=[0-9a-f]+$`));
    const file = path.join(s.dataDir, 'icons', `account-${a.id}.png`);
    assert.deepEqual(fs.readFileSync(file), PNG_BYTES);
    const onDisk = readJSON(path.join(s.dataDir, 'accounts.json')).find(x => x.id === a.id);
    assert.equal(JSON.stringify(onDisk).includes('base64'), false);

    const res = await s.get(a.icon);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.match(res.headers['cache-control'], /immutable/);
    assert.deepEqual(res.body, PNG_BYTES);

    // Sending the URL back (as the edit form does) keeps the icon
    const kept = await s.ok.put(`/api/accounts/${a.id}`, { name: 'Iconic 2', icon: a.icon });
    assert.equal(kept.icon, a.icon);

    // Replacing with a JPEG swaps the file and the cache-busting hash
    const replaced = await s.ok.put(`/api/accounts/${a.id}`, { icon: jpegDataUrl() });
    assert.match(replaced.icon, /\.jpg\?v=/);
    assert.equal(fs.existsSync(file), false, 'old PNG removed');
    assert.deepEqual((await s.get(replaced.icon)).body, JPEG_BYTES);

    const removed = await s.ok.put(`/api/accounts/${a.id}`, { icon: null });
    assert.equal(removed.icon, null);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'icons', `account-${a.id}.jpg`)), false);
    assert.equal((await s.get(replaced.icon)).status, 404);
  });

  it('rejects icons that are not images or are too large', async () => {
    assert.equal((await s.post('/api/accounts', { name: 'Bad', icon: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400);
    assert.equal((await s.post('/api/accounts', { name: 'Bad', icon: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
    assert.equal((await s.post('/api/accounts', { name: 'Bad', icon: 'https://example.com/x.png' })).status, 400);
    const big = `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 10, 1).toString('base64')}`;
    assert.equal((await s.post('/api/accounts', { name: 'Big', icon: big })).status, 413);
    const names = (await s.ok.get('/api/accounts?all=1')).map(a => a.name);
    assert.equal(names.includes('Bad') || names.includes('Big'), false, 'nothing half-created');
  });

  it('unknown icon names are a plain 404', async () => {
    assert.equal((await s.get('/api/icons/account-nope.png')).status, 404);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const res = await s.get(`/api/icons/${name}`);
      assert.equal(res.status, 404, `/api/icons/${name} should be 404, got ${res.status}`);
    }
  });
});

describe('account groups', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('creates, renames, gives an icon to and deletes groups', async () => {
    const g = await s.ok.post('/api/account-groups', { name: 'Everyday', icon: pngDataUrl() });
    assert.equal(g.name, 'Everyday');
    assert.match(g.icon, /^\/api\/icons\/group-/);
    const renamed = await s.ok.put(`/api/account-groups/${g.id}`, { name: 'Daily' });
    assert.equal(renamed.name, 'Daily');
    assert.equal(renamed.icon, g.icon);
    assert.equal((await s.post('/api/account-groups', { name: '' })).status, 400);

    const a = await makeAccount(s, { name: 'In group', groupId: g.id });
    assert.equal(a.groupId, g.id);
    await s.ok.del(`/api/account-groups/${g.id}`);
    assert.deepEqual(await s.ok.get('/api/account-groups'), []);
    const after = (await s.ok.get('/api/accounts')).find(x => x.id === a.id);
    assert.equal(after.groupId, null, 'accounts leave a deleted group');
    assert.equal(fs.existsSync(path.join(s.dataDir, 'icons', `group-${g.id}.png`)), false, 'group icon removed');
    assert.equal((await s.del(`/api/account-groups/${g.id}`)).status, 404);
  });

  it('moves accounts in and out of groups and orders the sidebar', async () => {
    const g = await s.ok.post('/api/account-groups', { name: 'Savings pots' });
    const a = await makeAccount(s, { name: 'Pot A', type: 'savings' });
    const b = await makeAccount(s, { name: 'Pot B', type: 'savings' });
    const res = await s.ok.put('/api/account-groups/set-account', { accountId: a.id, groupId: g.id });
    assert.equal(res.account.groupId, g.id);
    await s.ok.put('/api/account-groups/set-account', { accountId: b.id, groupId: g.id });
    const inGroup = (await s.ok.get('/api/accounts')).filter(x => x.groupId === g.id);
    assert.ok(inGroup.find(x => x.id === b.id).sortOrder > inGroup.find(x => x.id === a.id).sortOrder, 'appended at the end of the group');

    assert.equal((await s.put('/api/account-groups/set-account', { accountId: a.id, groupId: 'missinggroup' })).status, 404);
    const out = await s.ok.put('/api/account-groups/set-account', { accountId: a.id, groupId: null });
    assert.equal(out.account.groupId, null);

    await s.ok.put('/api/account-groups/reorder', { order: [{ type: 'account', id: a.id }, { type: 'group', id: g.id }] });
    const groups = await s.ok.get('/api/account-groups');
    const accounts = await s.ok.get('/api/accounts');
    assert.equal(accounts.find(x => x.id === a.id).sortOrder, 0);
    assert.equal(groups.find(x => x.id === g.id).sortOrder, 1);
    assert.equal((await s.put('/api/account-groups/reorder', { order: 'x' })).status, 400);
  });
});
