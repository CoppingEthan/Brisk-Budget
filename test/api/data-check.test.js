// "Data check": problems are planted directly in the data folder (as old bugs or hand edits
// would leave them) before the app starts, then found and fixed through the API.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clock } from '../../server/lib/clock.js';
import { makeTempRoot, removeDir, startServer, makeAccount, makeTx, readJSON, writeJSON, txsOf } from '../helpers/server.js';

describe('data check', () => {
  let dirs;
  let s;
  let A;
  let B;
  let C;
  let recurringId;

  const leg = (fields) => ({
    date: '2026-10-01', payee: '', categoryId: 'cat-transfer', description: '', notes: '',
    createdAt: '2026-10-01T09:00:00.000Z', transferId: null, transferAccountId: null, ...fields
  });

  before(async () => {
    dirs = makeTempRoot();
    const setup = await startServer(dirs);
    A = await makeAccount(setup, { name: 'Alpha', startingBalance: 100 });
    B = await makeAccount(setup, { name: 'Beta' });
    C = await makeAccount(setup, { name: 'Gamma' });
    await makeTx(setup, A.id, { payee: 'Normal', amount: -1 });
    recurringId = (await setup.ok.post('/api/recurring', { accountId: B.id, payee: 'Gym', amount: -30, startDate: '2026-11-01' })).id;
    await setup.close();

    const tx = (id) => path.join(dirs.dataDir, 'transactions', `${id}.json`);
    const aTxs = readJSON(tx(A.id));
    aTxs.push(
      leg({ id: 'brk1', amount: -20, payee: 'Transfer to Beta', transferId: 'lostleg', transferAccountId: B.id }),
      leg({ id: 'mm1', amount: -50, transferId: 'mm2', transferAccountId: B.id }),
      leg({ id: 'dupid', amount: -2, payee: 'First', categoryId: 'sub-coffee' }),
      leg({ id: 'dupid', amount: -3, payee: 'Second', categoryId: 'sub-coffee' }),
      leg({ id: 'nocat', amount: -4, payee: 'Lost category', categoryId: 'cat-deleted-long-ago' })
    );
    writeJSON(tx(A.id), aTxs);
    writeJSON(tx(B.id), [leg({ id: 'mm2', amount: 45, date: '2026-10-02', transferId: 'mm1', transferAccountId: A.id })]);
    writeJSON(tx('orphanacct'), [
      leg({ id: 'o1', amount: 12, payee: 'Orphan 1', categoryId: 'sub-salary' }),
      leg({ id: 'o2', amount: -2, payee: 'Orphan 2', categoryId: 'sub-coffee' })
    ]);
    const accountsFile = path.join(dirs.dataDir, 'accounts.json');
    writeJSON(accountsFile, readJSON(accountsFile).map(a => (a.id === C.id ? { ...a, groupId: 'ghostgroup' } : a)));
    const recurringFile = path.join(dirs.dataDir, 'recurring.json');
    writeJSON(recurringFile, readJSON(recurringFile).map(r => ({ ...r, accountId: 'ghostaccount' })));

    s = await startServer(dirs);
  });

  after(async () => {
    await s?.close();
    clock.set(null);
    removeDir(dirs?.root);
  });

  it('finds every planted problem', async () => {
    const { issues, checkedAt } = await s.ok.get('/api/data-check');
    assert.ok(checkedAt);
    const kinds = issues.map(i => i.kind).sort();
    assert.deepEqual(kinds, ['broken-transfer', 'duplicate-id', 'missing-category', 'missing-group', 'orphan-file', 'recurring-account', 'transfer-mismatch']);
    assert.ok(issues.every(i => i.fixable && i.message && i.fix && i.id));
    const mismatch = issues.find(i => i.kind === 'transfer-mismatch');
    assert.match(mismatch.message, /50\.00 out vs 2026-10-02: 45\.00 in/);
  });

  it('fixes only the issues asked for', async () => {
    const { issues } = await s.ok.get('/api/data-check');
    const group = issues.find(i => i.kind === 'missing-group');
    const res = await s.ok.post('/api/data-check/fix', { ids: [group.id] });
    assert.equal(res.fixed, 1);
    assert.equal(res.issues.length, issues.length - 1);
    assert.equal((await s.ok.get('/api/accounts')).find(a => a.id === C.id).groupId, null);
    assert.equal((await s.post('/api/data-check/fix', { ids: ['no-such-issue'] })).status, 400);
    assert.equal((await s.post('/api/data-check/fix', {})).status, 400);
  });

  it('fixes everything else in one go', async () => {
    const res = await s.ok.post('/api/data-check/fix', { all: true });
    assert.deepEqual(res.issues, []);
    assert.deepEqual((await s.ok.get('/api/data-check')).issues, []);
  });

  it('the fixes did the right things', async () => {
    const aTxs = await txsOf(s, A.id);
    const broken = aTxs.find(t => t.id === 'brk1');
    assert.equal(broken.transferId, null);
    assert.equal(broken.payee, 'Beta');
    assert.equal(broken.categoryId, 'cat-uncategorized');
    assert.equal(broken.amount, -20, 'amount kept');

    const inLeg = (await txsOf(s, B.id)).find(t => t.id === 'mm2');
    assert.equal(inLeg.amount, 50, 'the receiving side now matches the sending side');
    assert.equal(inLeg.date, '2026-10-01');

    const dupes = aTxs.filter(t => t.payee === 'First' || t.payee === 'Second');
    assert.equal(dupes.length, 2);
    assert.notEqual(dupes[0].id, dupes[1].id);

    assert.equal(aTxs.find(t => t.id === 'nocat').categoryId, 'cat-uncategorized');

    const recovered = (await s.ok.get('/api/accounts?all=1')).find(a => a.id === 'orphanacct');
    assert.ok(recovered, 'orphaned transactions recovered into an account');
    assert.equal(recovered.name, 'Recovered account');
    assert.equal(recovered.active, false);
    assert.equal(recovered.balance, 10);

    const r = readJSON(path.join(dirs.dataDir, 'recurring.json')).find(x => x.id === recurringId);
    assert.equal(r.paused, true);
  });

  it('the fixes are saved to disk', async () => {
    await s.close();
    s = await startServer(dirs);
    assert.deepEqual((await s.ok.get('/api/data-check')).issues, []);
  });
});
