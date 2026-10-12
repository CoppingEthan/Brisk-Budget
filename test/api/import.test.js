import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx, txsOf, balanceOf } from '../helpers/server.js';

describe('import', () => {
  let s;
  let acc;
  let other;
  let rows;

  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current', startingBalance: 100 });
    other = await makeAccount(s, { name: 'Savings' });
    await makeTx(s, acc.id, { date: '2026-10-01', amount: -12.5, payee: 'Tesco' });
    await makeTx(s, acc.id, { date: '2026-10-02', amount: -3, payee: 'Costa' });
    await s.ok.post('/api/transfers', { fromAccountId: acc.id, toAccountId: other.id, amount: 200, date: '2026-10-04' });
    rows = [
      { date: '2026-10-01', amount: -12.5, payee: 'TESCO' }, // already there
      { date: '2026-10-01', amount: -12.5, payee: 'tesco' }, // a second identical coffee-style purchase: new
      { date: '2026-10-02', amount: -3, payee: '  costa  ' }, // already there (spacing/case ignored)
      { date: '2026-10-03', amount: -20, payee: 'Aldi', category: 'Groceries' },
      { date: '2026-10-03', amount: -7, payee: 'Hobbycraft', category: 'Mystery Cat' },
      { date: '2026-10-03', amount: -8, payee: 'Hobbycraft', category: 'Mystery Cat' },
      { date: '2026-10-04', amount: -200, payee: 'TFR TO SAVINGS' }, // the bank's copy of a transfer already entered
      { date: '2026-10-05', amount: -1, payee: 'Sneaky', category: 'Transfer' }
    ];
  });
  after(async () => { await s.close(); });

  it('preview marks duplicates by count and lists unmatched categories', async () => {
    const preview = await s.ok.post(`/api/accounts/${acc.id}/transactions/import/preview`, { rows });
    assert.deepEqual(preview.rows.map(r => r.duplicate), [true, false, true, false, false, false, true, false]);
    assert.equal(preview.duplicates, 3);
    // "Transfer" can't be used for imported rows, so it is offered for mapping like an unknown name
    assert.deepEqual(preview.unmatchedCategories, [{ name: 'Mystery Cat', count: 2 }, { name: 'Transfer', count: 1 }]);
    assert.equal(preview.rows[3].categoryId, 'sub-groceries');
    assert.equal(preview.rows[3].categoryName, 'Groceries');
    assert.equal(preview.rows[4].categoryId, 'cat-uncategorized');
    assert.equal(preview.rows[7].categoryId, 'cat-uncategorized', 'imports never land in Transfer');
    assert.equal((await txsOf(s, acc.id)).length, 3, 'preview saves nothing');
  });

  it('a categoryMap sends unknown names to chosen categories', async () => {
    const preview = await s.ok.post(`/api/accounts/${acc.id}/transactions/import/preview`, { rows, categoryMap: { 'Mystery Cat': 'sub-hobbies', Groceries: 'not-a-category' } });
    assert.equal(preview.rows[4].categoryId, 'sub-hobbies');
    assert.equal(preview.rows[3].categoryId, 'sub-groceries', 'an invalid mapping falls back to the name');
    assert.deepEqual(preview.unmatchedCategories.map(u => u.name), ['Transfer']);
  });

  it('imports new rows only, tagged with a batch, and remembers the import profile', async () => {
    const before = await balanceOf(s, acc.id);
    const profile = { dateFormat: 'DD/MM/YYYY', mapping: { date: 0, amount: 1 } };
    const res = await s.ok.post(`/api/accounts/${acc.id}/transactions/import`, { rows, categoryMap: { 'Mystery Cat': 'sub-hobbies' }, profile });
    assert.equal(res.imported, 5);
    assert.equal(res.skipped, 3);
    assert.match(res.batch, /^[A-Za-z0-9_-]+$/);
    const imported = (await txsOf(s, acc.id)).filter(t => t.importBatch === res.batch);
    assert.equal(imported.length, 5);
    assert.deepEqual(imported.map(t => t.payee).sort(), ['Aldi', 'Hobbycraft', 'Hobbycraft', 'Sneaky', 'tesco']);
    assert.ok(imported.filter(t => t.payee === 'Hobbycraft').every(t => t.categoryId === 'sub-hobbies'));
    assert.equal(await balanceOf(s, acc.id), before - 12.5 - 20 - 7 - 8 - 1);
    const account = (await s.ok.get('/api/accounts')).find(a => a.id === acc.id);
    assert.equal(account.hasImportProfile, true);
    assert.deepEqual(account.importProfile, profile);
    assert.ok((await s.ok.get('/api/payees')).some(p => p.name === 'Hobbycraft'));

    // Importing the same file again finds everything already there
    const again = await s.ok.post(`/api/accounts/${acc.id}/transactions/import`, { rows });
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, rows.length);
  });

  it('a whole import can be undone by its batch id, and the undo undone', async () => {
    const res = await s.ok.post(`/api/accounts/${other.id}/transactions/import`, {
      rows: [{ date: '2026-10-06', amount: 5, payee: 'Interest' }, { date: '2026-10-07', amount: 6, payee: 'Interest' }]
    });
    const keep = await makeTx(s, other.id, { payee: 'Keep me', amount: 1 });
    const before = (await txsOf(s, other.id)).length;
    const undo = await s.ok.post(`/api/accounts/${other.id}/transactions/bulk`, { action: 'delete', importBatch: res.batch });
    assert.equal(undo.removed.length, 2);
    const left = await txsOf(s, other.id);
    assert.equal(left.length, before - 2);
    assert.ok(left.some(t => t.id === keep.id));
    assert.equal(left.some(t => t.importBatch === res.batch), false);
    await s.ok.post('/api/transactions/restore', { items: undo.removed });
    const back = (await txsOf(s, other.id)).filter(t => t.importBatch === res.batch);
    assert.equal(back.length, 2, 'restored rows keep their batch id');
  });

  it('can import duplicates on purpose', async () => {
    const res = await s.ok.post(`/api/accounts/${acc.id}/transactions/import`, { rows: rows.slice(0, 1), skipDuplicates: false });
    assert.equal(res.imported, 1);
    assert.equal(res.skipped, 0);
  });

  it('rejects bad rows with the row number, and archived accounts', async () => {
    const before = (await txsOf(s, acc.id)).length;
    const bad = await s.post(`/api/accounts/${acc.id}/transactions/import`, { rows: [rows[3], { date: '31/10/2026', amount: -1, payee: 'x' }] });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Row 2/);
    assert.equal((await s.post(`/api/accounts/${acc.id}/transactions/import`, { rows: [{ date: '2026-10-01', amount: 'abc' }] })).status, 400);
    assert.equal((await s.post(`/api/accounts/${acc.id}/transactions/import`, { rows: 'nope' })).status, 400);
    assert.equal((await txsOf(s, acc.id)).length, before, 'nothing imported from a rejected file');

    const closed = await makeAccount(s, { name: 'Closed' });
    await s.ok.del(`/api/accounts/${closed.id}`);
    assert.equal((await s.post(`/api/accounts/${closed.id}/transactions/import`, { rows: [rows[3]] })).status, 400);
  });

  it('rejects files over 20,000 rows', async () => {
    const many = Array.from({ length: 20001 }, () => ({ date: '2026-10-01', amount: -1, payee: 'x' }));
    const res = await s.post(`/api/accounts/${acc.id}/transactions/import/preview`, { rows: many });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /20,000/);
  });
});
