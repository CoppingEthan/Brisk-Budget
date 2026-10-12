import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx, txsOf } from '../helpers/server.js';

describe('categories', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current' });
  });
  after(async () => { await s.close(); });

  it('starts with the default categories, each with a colour, plus the system ones', async () => {
    const cats = await s.ok.get('/api/categories');
    assert.ok(cats.length >= 19);
    for (const c of cats) assert.match(c.color, /^#[0-9a-f]{6}$/i);
    assert.deepEqual(cats.slice(-2).map(c => c.id), ['cat-transfer', 'cat-uncategorized'], 'system categories sort last');
  });

  it('creates categories with unique names', async () => {
    const res = await s.post('/api/categories', { name: 'Hobby Fund', emoji: '🎨', color: '#AABBCC' });
    assert.equal(res.status, 201);
    assert.equal(res.data.color, '#aabbcc');
    assert.equal(res.data.isDefault, false);
    assert.equal((await s.post('/api/categories', { name: 'hobby fund' })).status, 409);
    assert.equal((await s.post('/api/categories', { name: '' })).status, 400);
    assert.equal((await s.post('/api/categories', { name: 'Bad colour', color: 'red' })).status, 400);
    const auto = await s.ok.post('/api/categories', { name: 'Auto colour' });
    assert.match(auto.color, /^#[0-9a-f]{6}$/);
  });

  it('renaming a category or subcategory does not orphan anything', async () => {
    const cat = await s.ok.post('/api/categories', { name: 'Side Projects' });
    const sub = await s.ok.post(`/api/categories/${cat.id}/subcategories`, { name: 'Domains' });
    const t1 = await makeTx(s, acc.id, { categoryId: cat.id });
    const t2 = await makeTx(s, acc.id, { categoryId: sub.id });
    await s.ok.put(`/api/categories/${cat.id}`, { name: 'Projects', emoji: '🛠️', color: '#123456' });
    await s.ok.put(`/api/categories/${cat.id}/subcategories/${sub.id}`, { name: 'Web Domains' });
    const txs = await txsOf(s, acc.id);
    const a = txs.find(t => t.id === t1.id);
    const b = txs.find(t => t.id === t2.id);
    assert.equal(a.categoryId, cat.id);
    assert.equal(a.category, 'Projects');
    assert.equal(a.categoryColor, '#123456');
    assert.equal(b.category, 'Web Domains');
    assert.equal(b.categoryParent, 'Projects');
    const listed = (await s.ok.get('/api/categories')).find(c => c.id === cat.id);
    assert.equal(listed.usage, 1);
    assert.equal(listed.subcategories[0].usage, 1);
    assert.equal((await s.put(`/api/categories/${cat.id}`, { name: 'Food & Drink' })).status, 409, 'cannot take an existing name');
  });

  it('system categories cannot be renamed, deleted or given subcategories', async () => {
    assert.equal((await s.put('/api/categories/cat-transfer', { name: 'Moves' })).status, 400);
    assert.equal((await s.del('/api/categories/cat-uncategorized')).status, 400);
    assert.equal((await s.post('/api/categories/cat-transfer/subcategories', { name: 'x' })).status, 400);
    const recoloured = await s.ok.put('/api/categories/cat-uncategorized', { color: '#000000' });
    assert.equal(recoloured.color, '#000000');
  });

  it('deleting a category in use requires a replacement (409), then moves everything', async () => {
    const cat = await s.ok.post('/api/categories', { name: 'Doomed' });
    const sub = await s.ok.post(`/api/categories/${cat.id}/subcategories`, { name: 'Doomed sub' });
    const t1 = await makeTx(s, acc.id, { categoryId: cat.id });
    const t2 = await makeTx(s, acc.id, { categoryId: sub.id });
    const r = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Doomed payee', amount: -1, categoryId: sub.id, startDate: '2026-11-01' });

    const refused = await s.del(`/api/categories/${cat.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.details.usage, 3);
    assert.ok((await s.ok.get('/api/categories')).some(c => c.id === cat.id), 'still there');

    assert.equal((await s.del(`/api/categories/${cat.id}`, { replacementId: sub.id })).status, 400, 'cannot move into itself');
    assert.equal((await s.del(`/api/categories/${cat.id}`, { replacementId: 'cat-transfer' })).status, 400);
    assert.equal((await s.del(`/api/categories/${cat.id}`, { replacementId: 'nonexistent' })).status, 400);

    await s.ok.del(`/api/categories/${cat.id}`, { replacementId: 'sub-hobbies' });
    const txs = await txsOf(s, acc.id);
    assert.equal(txs.find(t => t.id === t1.id).categoryId, 'sub-hobbies');
    assert.equal(txs.find(t => t.id === t2.id).categoryId, 'sub-hobbies');
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === r.id).categoryId, 'sub-hobbies');
    assert.equal((await s.ok.get('/api/categories')).some(c => c.id === cat.id), false);
  });

  it('an unused category deletes without a replacement', async () => {
    const cat = await s.ok.post('/api/categories', { name: 'Unused' });
    await s.ok.del(`/api/categories/${cat.id}`);
    assert.equal((await s.del(`/api/categories/${cat.id}`)).status, 404);
  });

  it('subcategories: unique among siblings, deleting moves items to the parent by default', async () => {
    const cat = await s.ok.post('/api/categories', { name: 'Parent' });
    const sub = await s.ok.post(`/api/categories/${cat.id}/subcategories`, { name: 'Child' });
    assert.equal((await s.post(`/api/categories/${cat.id}/subcategories`, { name: 'child' })).status, 409);
    const other = await s.ok.post(`/api/categories/${cat.id}/subcategories`, { name: 'Other child' });
    const t = await makeTx(s, acc.id, { categoryId: sub.id });
    await s.ok.del(`/api/categories/${cat.id}/subcategories/${sub.id}`);
    assert.equal((await txsOf(s, acc.id)).find(x => x.id === t.id).categoryId, cat.id);
    const t2 = await makeTx(s, acc.id, { categoryId: other.id });
    await s.ok.del(`/api/categories/${cat.id}/subcategories/${other.id}`, { replacementId: 'sub-fuel' });
    assert.equal((await txsOf(s, acc.id)).find(x => x.id === t2.id).categoryId, 'sub-fuel');
    assert.equal((await s.del(`/api/categories/${cat.id}/subcategories/${other.id}`)).status, 404);
  });

  it('reorders categories and subcategories', async () => {
    const food = (await s.ok.get('/api/categories')).find(c => c.id === 'cat-food');
    const subIds = food.subcategories.map(x => x.id).reverse();
    await s.ok.put('/api/categories/cat-food/subcategories/reorder', { ids: subIds });
    assert.deepEqual((await s.ok.get('/api/categories')).find(c => c.id === 'cat-food').subcategories.map(x => x.id), subIds);
    await s.ok.put('/api/categories/reorder', { ids: ['cat-travel', 'cat-food', 'cat-transfer'] });
    const cats = await s.ok.get('/api/categories');
    assert.equal(cats[0].id, 'cat-travel');
    assert.equal(cats[1].id, 'cat-food');
    assert.equal(cats.find(c => c.id === 'cat-transfer').sortOrder, 98, 'system categories keep their place');
  });

  it('reset restores the defaults and maps unknown ids to Uncategorized', async () => {
    const custom = await s.ok.post('/api/categories', { name: 'Gone after reset' });
    const t = await makeTx(s, acc.id, { categoryId: custom.id });
    const keep = await makeTx(s, acc.id, { categoryId: 'sub-coffee' });
    const other = await makeAccount(s, { name: 'Other' });
    const transfer = await s.ok.post('/api/transfers', { fromAccountId: acc.id, toAccountId: other.id, amount: 3, date: '2026-10-02' });
    const r = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'Reset payee', amount: -2, categoryId: custom.id, startDate: '2026-11-01' });

    const res = await s.ok.post('/api/categories/reset');
    assert.equal(res.categories.some(c => c.id === custom.id), false);
    const txs = await txsOf(s, acc.id);
    assert.equal(txs.find(x => x.id === t.id).categoryId, 'cat-uncategorized');
    assert.equal(txs.find(x => x.id === keep.id).categoryId, 'sub-coffee');
    assert.equal(txs.find(x => x.id === transfer.from.id).categoryId, 'cat-transfer');
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === r.id).categoryId, 'cat-uncategorized');
    const food = res.categories.find(c => c.id === 'cat-food');
    assert.equal(food.subcategories[0].id, 'sub-groceries', 'subcategory order is back to default');
  });

  it('a rejected category update changes nothing', async () => {
    const cat = await s.ok.post('/api/categories', { name: 'Steady' });
    const res = await s.put(`/api/categories/${cat.id}`, { name: 'Wobbly', color: 'not-a-colour' });
    assert.equal(res.status, 400);
    assert.equal((await s.ok.get('/api/categories')).find(c => c.id === cat.id).name, 'Steady');
  });
});
