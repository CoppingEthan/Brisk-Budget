const { accountsFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

const transfers = {
  createTransfer: async (req, res) => {
    const body = await parseBody(req);
    const { fromAccountId, toAccountId, amount, date, description, notes } = body;

    const transferId1 = generateId();
    const transferId2 = generateId();
    const now = new Date().toISOString();

    const accounts = readJSON(accountsFile) || [];
    const fromAccount = accounts.find(a => a.id === fromAccountId);
    const toAccount = accounts.find(a => a.id === toAccountId);

    const fromTransaction = {
      id: transferId1,
      payee: `Transfer to ${toAccount?.name || 'Unknown'}`,
      amount: -Math.abs(parseFloat(amount)),
      date,
      category: 'Transfer',
      description: description || '',
      notes: notes || '',
      createdAt: now,
      transferId: transferId2,
      transferAccountId: toAccountId
    };

    const toTransaction = {
      id: transferId2,
      payee: `Transfer from ${fromAccount?.name || 'Unknown'}`,
      amount: Math.abs(parseFloat(amount)),
      date,
      category: 'Transfer',
      description: description || '',
      notes: notes || '',
      createdAt: now,
      transferId: transferId1,
      transferAccountId: fromAccountId
    };

    const fromTransactions = readJSON(getTransactionsFile(fromAccountId)) || [];
    const toTransactions = readJSON(getTransactionsFile(toAccountId)) || [];

    fromTransactions.push(fromTransaction);
    toTransactions.push(toTransaction);

    writeJSON(getTransactionsFile(fromAccountId), fromTransactions);
    writeJSON(getTransactionsFile(toAccountId), toTransactions);

    sendJSON(res, { from: fromTransaction, to: toTransaction }, 201);
  }
};

module.exports = transfers;
