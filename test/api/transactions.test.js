import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx, balanceOf, txsOf } from '../helpers/server.js';

describe('transactions: create, update, delete and undo', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current', startingBalance: 100 });
  });
  after(async () => { await s.close(); });

  it('creates a transaction with a category and adds the payee', async () => {
    const tx = await makeTx(s, acc.id, { amount: -12.3456, payee: ' Tesco ', categoryId: 'sub-groceries', description: 'Weekly shop' });
    assert.equal(tx.amount, -12.35);
    assert.equal(tx.payee, 'Tesco');
    assert.equal(tx.accountId, acc.id);
    assert.equal(tx.category, 'Groceries');
    assert.equal(tx.categoryParent, 'Food & Drink');
    assert.equal(tx.transferId, null);
    assert.equal(await balanceOf(s, acc.id), 87.65);
    assert.ok((await s.ok.get('/api/payees')).some(p => p.name === 'Tesco'));
  });

  it('accepts a category name for convenience and defaults to Uncategorized', async () => {
    const byName = await makeTx(s, acc.id, { categoryId: undefined, category: 'dining out' });
    assert.equal(byName.categoryId, 'sub-dining');
    const unknown = await makeTx(s, acc.id, { categoryId: undefined, category: 'No such category' });
    assert.equal(unknown.categoryId, 'cat-uncategorized');
    const none = await makeTx(s, acc.id, { categoryId: undefined });
    assert.equal(none.categoryId, 'cat-uncategorized');
  });

  it('validates input', async () => {
    const base = { date: '2026-10-01', amount: -1, payee: 'X' };
    const bad = [
      { ...base, date: '2026-02-30' },
      { ...base, date: '01/10/2026' },
      { ...base, amount: 'twelve' },
      { ...base, amount: 1e13 },
      { ...base, payee: '' },
      { ...base, categoryId: 'cat-transfer' },
      { ...base, categoryId: 'deleted-category' },
      { ...base, categoryId: '../../x' },
      { ...base, notes: 'x'.repeat(2001) }
    ];
    for (const body of bad) {
      const res = await s.post(`/api/accounts/${acc.id}/transactions`, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal((await s.post('/api/accounts/nope/transactions', base)).status, 404);
  });

  it('updates only the fields sent', async () => {
    const tx = await makeTx(s, acc.id, { payee: 'Before', amount: -1, notes: 'keep me' });
    const updated = await s.ok.put(`/api/accounts/${acc.id}/transactions/${tx.id}`, { payee: 'After', amount: -2 });
    assert.equal(updated.payee, 'After');
    assert.equal(updated.amount, -2);
    assert.equal(updated.notes, 'keep me');
    assert.equal(updated.date, tx.date);
    assert.ok(updated.updatedAt);
    assert.equal((await s.put(`/api/accounts/${acc.id}/transactions/missing`, { payee: 'x' })).status, 404);
  });

  it('a rejected update leaves the transaction exactly as it was', async () => {
    const tx = await makeTx(s, acc.id, { payee: 'Stable', amount: -3, date: '2026-10-03' });
    const res = await s.put(`/api/accounts/${acc.id}/transactions/${tx.id}`, { date: '2026-01-01', payee: 'Changed', amount: 'not a number' });
    assert.equal(res.status, 400);
    const now = (await txsOf(s, acc.id)).find(t => t.id === tx.id);
    assert.equal(now.date, '2026-10-03', 'date must not change when the request is rejected');
    assert.equal(now.payee, 'Stable', 'payee must not change when the request is rejected');
  });

  it('delete returns what was removed, and restore puts it back exactly', async () => {
    const tx = await makeTx(s, acc.id, { payee: 'Undo me', amount: -7.5, notes: 'n', description: 'd' });
    const before = await balanceOf(s, acc.id);
    const res = await s.ok.del(`/api/accounts/${acc.id}/transactions/${tx.id}`);
    assert.equal(res.success, true);
    assert.equal(res.removed.length, 1);
    assert.equal(res.removed[0].accountId, acc.id);
    assert.equal(res.removed[0].transaction.id, tx.id);
    assert.equal(await balanceOf(s, acc.id), before + 7.5);
    assert.equal((await s.del(`/api/accounts/${acc.id}/transactions/${tx.id}`)).status, 404);

    const restored = await s.ok.post('/api/transactions/restore', { items: res.removed });
    assert.equal(restored.restored, 1);
    const back = (await txsOf(s, acc.id)).find(t => t.id === tx.id);
    assert.deepEqual(
      { id: back.id, date: back.date, amount: back.amount, payee: back.payee, categoryId: back.categoryId, notes: back.notes, description: back.description, createdAt: back.createdAt },
      { id: tx.id, date: tx.date, amount: tx.amount, payee: tx.payee, categoryId: tx.categoryId, notes: tx.notes, description: tx.description, createdAt: tx.createdAt }
    );
    assert.equal(await balanceOf(s, acc.id), before);
    // Restoring twice does not duplicate: the earlier version simply replaces the current one
    const count = (await txsOf(s, acc.id)).length;
    await s.ok.post('/api/transactions/restore', { items: res.removed });
    assert.equal((await txsOf(s, acc.id)).length, count);
    assert.equal((await s.post('/api/transactions/restore', { items: 'x' })).status, 400);
  });

  it('restore refuses items for unknown accounts or with unsafe ids, and changes nothing', async () => {
    const before = (await txsOf(s, acc.id)).length;
    for (const items of [
      [{ accountId: 'nosuchaccount', transaction: { id: 'abc', date: '2026-10-01', amount: 1 } }],
      [{ accountId: acc.id, transaction: { id: 'okid1', date: '2026-10-01', amount: 1 } }, { accountId: acc.id, transaction: { id: '../evil', date: '2026-10-01', amount: 1 } }],
      [{ accountId: acc.id, transaction: { id: 'okid2', date: '2026-10-01', amount: 1e400 } }]
    ]) {
      assert.equal((await s.post('/api/transactions/restore', { items })).status, 400);
    }
    assert.equal((await txsOf(s, acc.id)).length, before);
  });
});

describe('transactions: ledger', () => {
  let s;
  let acc;
  const rows = [
    // date, amount, payee, categoryId, notes
    ['2026-09-01', 2000, 'Employer', 'sub-salary', ''],
    ['2026-09-02', -45.2, 'Tesco', 'sub-groceries', ''],
    ['2026-09-03', -3.1, 'Costa', 'sub-coffee', 'flat white'],
    ['2026-09-05', -60, 'Pizza Express', 'sub-dining', ''],
    ['2026-09-10', 15, 'Tesco', 'sub-groceries', 'refund'],
    ['2026-09-20', -999.99, 'Landlord', 'sub-rent', '']
  ];
  const created = [];

  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Ledger', startingBalance: 100 });
    for (const [date, amount, payee, categoryId, notes] of rows) created.push(await makeTx(s, acc.id, { date, amount, payee, categoryId, notes }));
  });
  after(async () => { await s.close(); });

  it('lists newest first with the balance after each transaction', async () => {
    const page = await s.ok.get(`/api/accounts/${acc.id}/ledger`);
    assert.equal(page.total, 6);
    assert.equal(page.items[0].payee, 'Landlord');
    assert.deepEqual(page.items.map(i => i.runningBalance), [1006.71, 2006.7, 1991.7, 2051.7, 2054.8, 2100]);
    assert.equal(page.balance, 1006.71);
    assert.deepEqual(page.totals, { in: 2015, out: -1108.29 });
  });

  it('pages with offset and limit while running balances stay correct', async () => {
    const page = await s.ok.get(`/api/accounts/${acc.id}/ledger?offset=2&limit=2`);
    assert.equal(page.total, 6);
    assert.equal(page.offset, 2);
    assert.equal(page.limit, 2);
    assert.deepEqual(page.items.map(i => [i.payee, i.runningBalance]), [['Pizza Express', 1991.7], ['Costa', 2051.7]]);
    const legacy = await s.ok.get(`/api/accounts/${acc.id}/transactions?offset=0&limit=1`);
    assert.equal(legacy.items.length, 1);
    const all = await s.ok.get(`/api/accounts/${acc.id}/transactions`);
    assert.ok(Array.isArray(all));
    assert.equal(all.length, 6);
  });

  it('filters by search text, category (including subcategories), dates, direction and size', async () => {
    const q = async (query) => s.ok.get(`/api/accounts/${acc.id}/ledger?${query}`);
    assert.deepEqual((await q('q=tesco')).items.map(i => i.amount), [15, -45.2]);
    assert.deepEqual((await q('q=FLAT%20WHITE')).items.map(i => i.payee), ['Costa']);
    assert.deepEqual((await q('q=groceries')).items.map(i => i.payee), ['Tesco', 'Tesco'], 'search matches category names');
    assert.deepEqual((await q('q=999.99')).items.map(i => i.payee), ['Landlord'], 'search matches amounts');
    assert.equal((await q('categoryId=cat-food')).total, 4, 'parent category includes its subcategories');
    assert.equal((await q('categoryId=sub-coffee')).total, 1);
    assert.deepEqual((await q('from=2026-09-02&to=2026-09-05')).items.map(i => i.payee), ['Pizza Express', 'Costa', 'Tesco']);
    const ins = await q('direction=in');
    assert.deepEqual(ins.items.map(i => i.amount), [15, 2000]);
    assert.deepEqual(ins.totals, { in: 2015, out: 0 });
    assert.equal((await q('direction=out')).total, 4);
    assert.deepEqual((await q('min=50&max=1000')).items.map(i => i.amount), [-999.99, -60]);
    const combined = await q('q=tesco&direction=out');
    assert.equal(combined.total, 1);
    assert.equal(combined.items[0].runningBalance, 2054.8, 'running balance is the real balance, not of the filtered rows');
  });

  it('404s for an unknown account', async () => {
    assert.equal((await s.get('/api/accounts/missing/ledger')).status, 404);
  });
});

describe('transactions: bulk actions', () => {
  let s;
  let a;
  let b;
  before(async () => {
    s = await freshServer();
    a = await makeAccount(s, { name: 'A' });
    b = await makeAccount(s, { name: 'B' });
  });
  after(async () => { await s.close(); });

  it('bulk delete removes transfer partners too and can be undone', async () => {
    const t1 = await makeTx(s, a.id, { amount: -1 });
    const t2 = await makeTx(s, a.id, { amount: -2 });
    const transfer = await s.ok.post('/api/transfers', { fromAccountId: a.id, toAccountId: b.id, amount: 50, date: '2026-10-05' });
    const res = await s.ok.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'delete', ids: [t1.id, transfer.from.id, 'not-here'] });
    assert.equal(res.removed.length, 3, 'two rows plus the other side of the transfer');
    assert.deepEqual((await txsOf(s, a.id)).map(t => t.id), [t2.id]);
    assert.deepEqual(await txsOf(s, b.id), []);
    await s.ok.post('/api/transactions/restore', { items: res.removed });
    assert.equal((await txsOf(s, a.id)).length, 3);
    const back = (await txsOf(s, b.id))[0];
    assert.equal(back.transferId, transfer.from.id, 'transfer link restored');
    assert.equal(await balanceOf(s, b.id), 50);
  });

  it('bulk categorize skips transfers', async () => {
    const t = await makeTx(s, a.id, { amount: -4, categoryId: 'cat-uncategorized' });
    const transfer = await s.ok.post('/api/transfers', { fromAccountId: a.id, toAccountId: b.id, amount: 1, date: '2026-10-06' });
    const res = await s.ok.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'categorize', ids: [t.id, transfer.from.id], categoryId: 'sub-fuel' });
    assert.equal(res.updated, 1);
    const txs = await txsOf(s, a.id);
    assert.equal(txs.find(x => x.id === t.id).categoryId, 'sub-fuel');
    assert.equal(txs.find(x => x.id === transfer.from.id).categoryId, 'cat-transfer');
    assert.equal((await s.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'categorize', ids: [t.id], categoryId: 'cat-transfer' })).status, 400);
  });

  it('bulk convert to transfer and back', async () => {
    const t1 = await makeTx(s, a.id, { amount: -20, payee: 'Move 1', date: '2026-10-07' });
    const t2 = await makeTx(s, a.id, { amount: 30, payee: 'Move 2', date: '2026-10-07' });
    const conv = await s.ok.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'convertToTransfer', ids: [t1.id, t2.id], targetAccountId: b.id });
    assert.equal(conv.done, 2);
    const inB = (await txsOf(s, b.id)).filter(t => [t1.id, t2.id].includes(t.transferId));
    assert.deepEqual(inB.map(t => t.amount).sort((x, y) => x - y), [-30, 20]);
    const again = await s.ok.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'convertToTransfer', ids: [t1.id], targetAccountId: b.id });
    assert.equal(again.skipped, 1, 'already a transfer');

    const unlink = await s.ok.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'unlinkTransfer', ids: [t1.id, t2.id] });
    assert.equal(unlink.done, 2);
    assert.equal(unlink.removed.length, 2, 'the sides the app created are removed');
    const txs = await txsOf(s, a.id);
    assert.equal(txs.find(t => t.id === t1.id).payee, 'Move 1');
    assert.equal(txs.find(t => t.id === t1.id).transferId, null);
  });

  it('rejects unknown actions and bad id lists', async () => {
    assert.equal((await s.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'explode', ids: [] })).status, 400);
    assert.equal((await s.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'delete', ids: 'abc' })).status, 400);
    assert.equal((await s.post(`/api/accounts/${a.id}/transactions/bulk`, { action: 'delete', ids: ['a/b'] })).status, 400);
  });
});
