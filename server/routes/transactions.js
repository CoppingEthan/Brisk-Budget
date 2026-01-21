const { accountsFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

const transactions = {
  getTransactions: (req, res, accountId) => {
    const txList = readJSON(getTransactionsFile(accountId)) || [];
    txList.sort((a, b) => {
      const dateCompare = new Date(b.date) - new Date(a.date);
      if (dateCompare !== 0) return dateCompare;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    sendJSON(res, txList);
  },

  createTransaction: async (req, res, accountId) => {
    const body = await parseBody(req);
    const txList = readJSON(getTransactionsFile(accountId)) || [];
    const newTransaction = {
      id: generateId(),
      payee: body.payee,
      amount: parseFloat(body.amount),
      date: body.date,
      category: body.category,
      description: body.description || '',
      notes: body.notes || '',
      createdAt: new Date().toISOString(),
      transferId: body.transferId || null,
      transferAccountId: body.transferAccountId || null
    };
    txList.push(newTransaction);
    writeJSON(getTransactionsFile(accountId), txList);
    sendJSON(res, newTransaction, 201);
  },

  updateTransaction: async (req, res, accountId, transactionId) => {
    const body = await parseBody(req);
    const txList = readJSON(getTransactionsFile(accountId)) || [];
    const index = txList.findIndex(t => t.id === transactionId);
    if (index === -1) {
      sendJSON(res, { error: 'Transaction not found' }, 404);
      return;
    }
    txList[index] = { ...txList[index], ...body };
    writeJSON(getTransactionsFile(accountId), txList);
    sendJSON(res, txList[index]);
  },

  deleteTransaction: (req, res, accountId, transactionId) => {
    let txList = readJSON(getTransactionsFile(accountId)) || [];
    const transaction = txList.find(t => t.id === transactionId);
    if (!transaction) {
      sendJSON(res, { error: 'Transaction not found' }, 404);
      return;
    }

    // If it's a transfer, delete the linked transaction too
    if (transaction.transferId && transaction.transferAccountId) {
      let linkedTransactions = readJSON(getTransactionsFile(transaction.transferAccountId)) || [];
      linkedTransactions = linkedTransactions.filter(t => t.id !== transaction.transferId);
      writeJSON(getTransactionsFile(transaction.transferAccountId), linkedTransactions);
    }

    txList = txList.filter(t => t.id !== transactionId);
    writeJSON(getTransactionsFile(accountId), txList);
    sendJSON(res, { success: true });
  },

  importTransactions: async (req, res, accountId) => {
    const body = await parseBody(req);
    const { transactions: txImportList } = body;

    if (!Array.isArray(txImportList)) {
      sendJSON(res, { error: 'Invalid transactions array' }, 400);
      return;
    }

    const txFile = getTransactionsFile(accountId);
    const existing = readJSON(txFile) || [];

    const imported = [];
    const errors = [];

    for (let i = 0; i < txImportList.length; i++) {
      const tx = txImportList[i];
      try {
        const amount = parseFloat(tx.amount);
        if (isNaN(amount)) throw new Error('Invalid amount');
        if (!tx.date) throw new Error('Missing date');

        const newTx = {
          id: generateId(),
          payee: tx.payee || 'Unknown',
          amount: amount,
          date: tx.date,
          category: tx.category || 'Uncategorized',
          description: tx.description || '',
          notes: tx.notes || '',
          createdAt: new Date().toISOString(),
          transferId: null,
          transferAccountId: null
        };

        existing.push(newTx);
        imported.push(newTx);
      } catch (err) {
        errors.push({ row: i + 1, error: err.message });
      }
    }

    writeJSON(txFile, existing);
    sendJSON(res, {
      success: true,
      imported: imported.length,
      errors
    });
  },

  convertToTransfer: async (req, res, accountId, transactionId) => {
    const body = await parseBody(req);
    const { targetAccountId } = body;

    if (!targetAccountId) {
      sendJSON(res, { error: 'Target account required' }, 400);
      return;
    }

    if (accountId === targetAccountId) {
      sendJSON(res, { error: 'Cannot convert to transfer within same account' }, 400);
      return;
    }

    const txList = readJSON(getTransactionsFile(accountId)) || [];
    const txIndex = txList.findIndex(t => t.id === transactionId);

    if (txIndex === -1) {
      sendJSON(res, { error: 'Transaction not found' }, 404);
      return;
    }

    const transaction = txList[txIndex];

    if (transaction.transferId) {
      sendJSON(res, { error: 'Transaction is already a transfer' }, 400);
      return;
    }

    const accounts = readJSON(accountsFile) || [];
    const fromAccount = accounts.find(a => a.id === accountId);
    const toAccount = accounts.find(a => a.id === targetAccountId);

    const newFromTxId = generateId();
    const newToTxId = generateId();
    const now = new Date().toISOString();

    const isOutgoing = transaction.amount < 0;

    txList[txIndex] = {
      ...transaction,
      id: newFromTxId,
      payee: isOutgoing ? `Transfer to ${toAccount?.name || 'Unknown'}` : `Transfer from ${toAccount?.name || 'Unknown'}`,
      category: 'Transfer',
      transferId: newToTxId,
      transferAccountId: targetAccountId
    };

    const targetTransactions = readJSON(getTransactionsFile(targetAccountId)) || [];
    const linkedTransaction = {
      id: newToTxId,
      payee: isOutgoing ? `Transfer from ${fromAccount?.name || 'Unknown'}` : `Transfer to ${fromAccount?.name || 'Unknown'}`,
      amount: -transaction.amount,
      date: transaction.date,
      category: 'Transfer',
      description: transaction.description || '',
      notes: transaction.notes || '',
      createdAt: now,
      transferId: newFromTxId,
      transferAccountId: accountId
    };

    targetTransactions.push(linkedTransaction);

    writeJSON(getTransactionsFile(accountId), txList);
    writeJSON(getTransactionsFile(targetAccountId), targetTransactions);

    sendJSON(res, {
      success: true,
      originalTransaction: txList[txIndex],
      linkedTransaction: linkedTransaction
    });
  },

  convertToTransaction: async (req, res, accountId, transactionId) => {
    const txList = readJSON(getTransactionsFile(accountId)) || [];
    const txIndex = txList.findIndex(t => t.id === transactionId);

    if (txIndex === -1) {
      sendJSON(res, { error: 'Transaction not found' }, 404);
      return;
    }

    const transaction = txList[txIndex];

    if (!transaction.transferId || !transaction.transferAccountId) {
      sendJSON(res, { error: 'Transaction is not a transfer' }, 400);
      return;
    }

    const linkedAccountId = transaction.transferAccountId;
    let linkedTransactions = readJSON(getTransactionsFile(linkedAccountId)) || [];
    linkedTransactions = linkedTransactions.filter(t => t.id !== transaction.transferId);
    writeJSON(getTransactionsFile(linkedAccountId), linkedTransactions);

    txList[txIndex] = {
      ...transaction,
      payee: transaction.payee.replace(/^Transfer (to|from) /, ''),
      category: 'Uncategorized',
      transferId: null,
      transferAccountId: null
    };

    writeJSON(getTransactionsFile(accountId), txList);

    sendJSON(res, {
      success: true,
      transaction: txList[txIndex]
    });
  }
};

module.exports = transactions;
