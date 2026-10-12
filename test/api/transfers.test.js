import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshServer, makeAccount, makeTx, balanceOf, txsOf } from '../helpers/server.js';

describe('transfers', () => {
  let s;
  let current;
  let savings;
  let isa;

  before(async () => {
    s = await freshServer();
    current = await makeAccount(s, { name: 'Current', startingBalance: 1000 });
    savings = await makeAccount(s, { name: 'Savings', type: 'savings' });
    isa = await makeAccount(s, { name: 'ISA', type: 'savings' });
  });
  after(async () => { await s.close(); });

  it('creates two linked legs with payees from the account names', async () => {
    const res = await s.post('/api/transfers', { fromAccountId: current.id, toAccountId: savings.id, amount: -250, date: '2026-10-01', description: 'Monthly' });
    assert.equal(res.status, 201);
    const { from, to } = res.data;
    assert.equal(from.amount, -250, 'sign comes from the direction, not the amount sent');
    assert.equal(to.amount, 250);
    assert.equal(from.transferId, to.id);
    assert.equal(to.transferId, from.id);
    assert.equal(from.transferAccountId, savings.id);
    assert.equal(to.transferAccountId, current.id);
    assert.equal(from.payee, 'Transfer to Savings');
    assert.equal(to.payee, 'Transfer from Current');
    assert.equal(from.categoryId, 'cat-transfer');
    assert.equal(to.description, 'Monthly');
    assert.equal(await balanceOf(s, current.id), 750);
    assert.equal(await balanceOf(s, savings.id), 250);
  });

  it('validates transfers', async () => {
    const base = { fromAccountId: current.id, toAccountId: savings.id, amount: 10, date: '2026-10-01' };
    assert.equal((await s.post('/api/transfers', { ...base, toAccountId: current.id })).status, 400);
    assert.equal((await s.post('/api/transfers', { ...base, amount: 0 })).status, 400);
    assert.equal((await s.post('/api/transfers', { ...base, date: 'soon' })).status, 400);
    assert.equal((await s.post('/api/transfers', { ...base, toAccountId: undefined })).status, 400);
    assert.equal((await s.post('/api/transfers', { ...base, toAccountId: 'missingacct' })).status, 404);
  });

  it('editing EITHER leg rewrites both sides', async () => {
    const { from, to } = await s.ok.post('/api/transfers', { fromAccountId: current.id, toAccountId: savings.id, amount: 40, date: '2026-10-02' });
    // Edit from the receiving side
    const edited = await s.ok.put(`/api/accounts/${savings.id}/transactions/${to.id}`, { amount: 55, date: '2026-10-03', notes: 'changed' });
    assert.equal(edited.id, to.id);
    assert.equal(edited.amount, 55);
    let outLeg = (await txsOf(s, current.id)).find(t => t.id === from.id);
    assert.equal(outLeg.amount, -55);
    assert.equal(outLeg.date, '2026-10-03');
    assert.equal(outLeg.notes, 'changed');
    assert.equal(outLeg.transferId, to.id);

    // Edit from the sending side
    await s.ok.put(`/api/accounts/${current.id}/transactions/${from.id}`, { amount: -60, description: 'from side' });
    const inLeg = (await txsOf(s, savings.id)).find(t => t.id === to.id);
    assert.equal(inLeg.amount, 60);
    assert.equal(inLeg.description, 'from side');
    outLeg = (await txsOf(s, current.id)).find(t => t.id === from.id);
    assert.equal(outLeg.amount, -60);
    assert.equal(outLeg.date, '2026-10-03');
  });

  it('changing an account moves the leg to the new account', async () => {
    const { from, to } = await s.ok.post('/api/transfers', { fromAccountId: current.id, toAccountId: savings.id, amount: 10, date: '2026-10-04' });
    const before = { savings: await balanceOf(s, savings.id), isa: await balanceOf(s, isa.id) };
    await s.ok.put(`/api/accounts/${current.id}/transactions/${from.id}`, { toAccountId: isa.id });
    assert.equal((await txsOf(s, savings.id)).some(t => t.id === to.id), false);
    const moved = (await txsOf(s, isa.id)).find(t => t.id === to.id);
    assert.ok(moved, 'incoming leg now lives in the ISA');
    assert.equal(moved.amount, 10);
    assert.equal(moved.transferAccountId, current.id);
    const outLeg = (await txsOf(s, current.id)).find(t => t.id === from.id);
    assert.equal(outLeg.transferAccountId, isa.id);
    assert.equal(outLeg.payee, 'Transfer to ISA');
    assert.equal(await balanceOf(s, savings.id), before.savings - 10);
    assert.equal(await balanceOf(s, isa.id), before.isa + 10);

    // Moving it onto the same account on both sides is refused, and nothing changes
    const res = await s.put(`/api/accounts/${current.id}/transactions/${from.id}`, { toAccountId: current.id });
    assert.equal(res.status, 400);
    assert.ok((await txsOf(s, isa.id)).some(t => t.id === to.id));
  });

  it('transfer payees follow account renames', async () => {
    const { from } = await s.ok.post('/api/transfers', { fromAccountId: current.id, toAccountId: isa.id, amount: 1, date: '2026-10-05' });
    await s.ok.put(`/api/accounts/${isa.id}`, { name: 'Stocks ISA' });
    const outLeg = (await txsOf(s, current.id)).find(t => t.id === from.id);
    assert.equal(outLeg.payee, 'Transfer to Stocks ISA');
    const page = await s.ok.get(`/api/accounts/${current.id}/ledger?q=stocks%20isa`);
    assert.ok(page.items.some(t => t.id === from.id), 'search finds the new name');
  });

  it('deleting one leg deletes both, and undo restores both', async () => {
    const { from, to } = await s.ok.post('/api/transfers', { fromAccountId: current.id, toAccountId: savings.id, amount: 5, date: '2026-10-06' });
    const res = await s.ok.del(`/api/accounts/${savings.id}/transactions/${to.id}`);
    assert.deepEqual(res.removed.map(r => r.transaction.id).sort(), [from.id, to.id].sort());
    assert.equal((await txsOf(s, current.id)).some(t => t.id === from.id), false);
    await s.ok.post('/api/transactions/restore', { items: res.removed });
    assert.equal((await txsOf(s, current.id)).find(t => t.id === from.id).transferId, to.id);
  });
});

describe('converting transactions to transfers', () => {
  let s;
  let bank;
  let card;

  before(async () => {
    s = await freshServer();
    bank = await makeAccount(s, { name: 'Bank', startingBalance: 500 });
    card = await makeAccount(s, { name: 'Card', type: 'credit', startingBalance: -300 });
  });
  after(async () => { await s.close(); });

  it('finds matching candidates in the other account', async () => {
    const payment = await makeTx(s, bank.id, { amount: -75, payee: 'CARD PAYMENT', date: '2026-10-01' });
    const match = await makeTx(s, card.id, { amount: 75, payee: 'PAYMENT RECEIVED', date: '2026-10-03' });
    await makeTx(s, card.id, { amount: 75, payee: 'Too late', date: '2026-10-10' });
    await makeTx(s, card.id, { amount: 70, payee: 'Wrong amount', date: '2026-10-01' });
    await makeTx(s, card.id, { amount: -75, payee: 'Wrong direction', date: '2026-10-01' });
    const candidates = await s.ok.get(`/api/accounts/${bank.id}/transactions/${payment.id}/transfer-candidates?targetAccountId=${card.id}`);
    assert.deepEqual(candidates.map(c => c.id), [match.id]);
  });

  it('links two existing transactions, and unlinking keeps both', async () => {
    const payment = await makeTx(s, bank.id, { amount: -120, payee: 'Card repayment', date: '2026-10-05', categoryId: 'sub-credit-card-fees' });
    const received = await makeTx(s, card.id, { amount: 120, payee: 'Thank you', date: '2026-10-06' });
    const before = { bank: await balanceOf(s, bank.id), card: await balanceOf(s, card.id) };

    const res = await s.ok.post(`/api/accounts/${bank.id}/transactions/${payment.id}/convert-to-transfer`, { targetAccountId: card.id, linkTransactionId: received.id });
    assert.equal(res.transaction.transferId, received.id);
    assert.equal(res.linkedTransaction.id, received.id);
    assert.equal(res.linkedTransaction.transferId, payment.id);
    assert.equal(res.transaction.categoryId, 'cat-transfer');
    assert.equal((await txsOf(s, card.id)).filter(t => t.transferId === payment.id).length, 1, 'no extra row created');
    assert.deepEqual({ bank: await balanceOf(s, bank.id), card: await balanceOf(s, card.id) }, before, 'linking does not change balances');

    const unlink = await s.ok.post(`/api/accounts/${card.id}/transactions/${received.id}/convert-to-transaction`);
    assert.deepEqual(unlink.removed, [], 'both real transactions are kept');
    const bankTx = (await txsOf(s, bank.id)).find(t => t.id === payment.id);
    const cardTx = (await txsOf(s, card.id)).find(t => t.id === received.id);
    assert.equal(bankTx.transferId, null);
    assert.equal(cardTx.transferId, null);
    assert.equal(bankTx.payee, 'Card repayment');
    assert.equal(cardTx.payee, 'Thank you');
    assert.deepEqual({ bank: await balanceOf(s, bank.id), card: await balanceOf(s, card.id) }, before);
  });

  it('refuses links that do not match', async () => {
    const a = await makeTx(s, bank.id, { amount: -10, date: '2026-10-07' });
    const wrong = await makeTx(s, card.id, { amount: 11, date: '2026-10-07' });
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions/${a.id}/convert-to-transfer`, { targetAccountId: card.id, linkTransactionId: wrong.id })).status, 400);
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions/${a.id}/convert-to-transfer`, { targetAccountId: card.id, linkTransactionId: 'missing' })).status, 404);
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions/${a.id}/convert-to-transfer`, { targetAccountId: bank.id })).status, 400);
    const after = (await txsOf(s, bank.id)).find(t => t.id === a.id);
    assert.equal(after.transferId, null, 'failed conversions change nothing');
  });

  it('converting without a match creates the other side; unlinking removes it again', async () => {
    const t = await makeTx(s, bank.id, { amount: -33, payee: 'Moved money', date: '2026-10-08' });
    const res = await s.ok.post(`/api/accounts/${bank.id}/transactions/${t.id}/convert-to-transfer`, { targetAccountId: card.id });
    const created = res.linkedTransaction;
    assert.equal(created.amount, 33);
    assert.equal(created.payee, 'Transfer from Bank');
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions/${t.id}/convert-to-transfer`, { targetAccountId: card.id })).status, 409);

    const unlink = await s.ok.post(`/api/accounts/${bank.id}/transactions/${t.id}/convert-to-transaction`);
    assert.deepEqual(unlink.removed.map(r => r.transaction.id), [created.id]);
    assert.equal((await txsOf(s, card.id)).some(x => x.id === created.id), false);
    const back = (await txsOf(s, bank.id)).find(x => x.id === t.id);
    assert.equal(back.payee, 'Moved money');
    assert.equal(back.categoryId, 'sub-groceries', 'unlinking gives back the category it had before');
    assert.equal((await s.post(`/api/accounts/${bank.id}/transactions/${t.id}/convert-to-transaction`)).status, 409);
  });
});
