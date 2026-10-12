import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx, txsOf } from '../helpers/server.js';

describe('payees', () => {
  let s;
  let acc;
  let other;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current' });
    other = await makeAccount(s, { name: 'Savings' });
  });
  after(async () => { await s.close(); });

  const payeeByName = async (name) => (await s.ok.get('/api/payees')).find(p => p.name === name);

  it('creates payees, refusing case-insensitive duplicates', async () => {
    const p = await s.ok.post('/api/payees', { name: 'Netflix' });
    assert.equal(p.name, 'Netflix');
    assert.equal((await s.post('/api/payees', { name: 'NETFLIX' })).status, 409);
    assert.equal((await s.post('/api/payees', { name: ' ' })).status, 400);
  });

  it('lists payees alphabetically with usage counts (transfers ignored)', async () => {
    await makeTx(s, acc.id, { payee: 'Zebra Shop' });
    await makeTx(s, acc.id, { payee: 'apple store' });
    await makeTx(s, other.id, { payee: 'Apple Store' });
    await s.ok.post('/api/transfers', { fromAccountId: acc.id, toAccountId: other.id, amount: 1, date: '2026-10-01' });
    const list = await s.ok.get('/api/payees');
    const names = list.map(p => p.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en-GB', { sensitivity: 'base' })));
    assert.equal(list.find(p => p.name.toLowerCase() === 'apple store').usage, 2);
    assert.equal(list.some(p => /^Transfer/.test(p.name)), false);
  });

  it('renaming cascades to transactions and recurring payments (any capitalisation)', async () => {
    const t1 = await makeTx(s, acc.id, { payee: 'Tesco Extra' });
    const t2 = await makeTx(s, other.id, { payee: 'TESCO EXTRA' });
    const r = await s.ok.post('/api/recurring', { accountId: acc.id, payee: 'tesco extra', amount: -5, startDate: '2026-11-01' });
    const p = await payeeByName('Tesco Extra');
    const renamed = await s.ok.put(`/api/payees/${p.id}`, { name: 'Tesco' });
    assert.equal(renamed.name, 'Tesco');
    assert.equal((await txsOf(s, acc.id)).find(t => t.id === t1.id).payee, 'Tesco');
    assert.equal((await txsOf(s, other.id)).find(t => t.id === t2.id).payee, 'Tesco');
    assert.equal((await s.ok.get('/api/recurring')).find(x => x.id === r.id).payee, 'Tesco');
  });

  it('renaming onto an existing payee merges the two', async () => {
    const t1 = await makeTx(s, acc.id, { payee: 'Sainsburys Local' });
    await makeTx(s, acc.id, { payee: 'Sainsburys' });
    const from = await payeeByName('Sainsburys Local');
    const into = await payeeByName('Sainsburys');
    const res = await s.ok.put(`/api/payees/${from.id}`, { name: 'sainsburys' });
    assert.equal(res.merged, true);
    assert.equal(res.id, into.id);
    assert.equal((await txsOf(s, acc.id)).find(t => t.id === t1.id).payee, 'Sainsburys');
    const list = await s.ok.get('/api/payees');
    assert.equal(list.some(p => p.id === from.id), false);
    assert.equal(list.find(p => p.id === into.id).usage, 2);
  });

  it('deleting without a replacement keeps the transactions as they are', async () => {
    const t = await makeTx(s, acc.id, { payee: 'Corner Shop' });
    const p = await payeeByName('Corner Shop');
    await s.ok.del(`/api/payees/${p.id}`);
    assert.equal(await payeeByName('Corner Shop'), undefined);
    assert.equal((await txsOf(s, acc.id)).find(x => x.id === t.id).payee, 'Corner Shop');
    assert.equal((await s.del(`/api/payees/${p.id}`)).status, 404);
  });

  it('deleting with a replacement renames everywhere and adds the replacement', async () => {
    const t = await makeTx(s, acc.id, { payee: 'Amzn Mktp' });
    const p = await payeeByName('Amzn Mktp');
    await s.ok.del(`/api/payees/${p.id}`, { replacementPayee: 'Amazon' });
    assert.equal((await txsOf(s, acc.id)).find(x => x.id === t.id).payee, 'Amazon');
    assert.ok(await payeeByName('Amazon'));
    assert.equal(await payeeByName('Amzn Mktp'), undefined);
  });

  it('last-category returns the most recent non-Uncategorized category for a payee', async () => {
    await makeTx(s, acc.id, { payee: 'Shell', categoryId: 'sub-fuel', date: '2026-09-01' });
    await makeTx(s, acc.id, { payee: 'shell', categoryId: 'sub-coffee', date: '2026-09-15' });
    await makeTx(s, acc.id, { payee: 'Shell', categoryId: 'cat-uncategorized', date: '2026-09-20' });
    assert.deepEqual(await s.ok.get('/api/payees/last-category?name=SHELL'), { categoryId: 'sub-coffee' });
    assert.deepEqual(await s.ok.get('/api/payees/last-category/Shell'), { categoryId: 'sub-coffee' });
    assert.deepEqual(await s.ok.get('/api/payees/last-category?name=Nobody'), { categoryId: null });
    assert.deepEqual(await s.ok.get(`/api/payees/last-category/${encodeURIComponent('Fish & Chips / Co')}`), { categoryId: null });
  });
});
