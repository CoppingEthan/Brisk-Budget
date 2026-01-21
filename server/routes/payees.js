const fs = require('fs');
const { accountsFile, payeesFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

const payees = {
  getPayees: (req, res) => {
    const payeeList = readJSON(payeesFile) || [];
    sendJSON(res, payeeList);
  },

  createPayee: async (req, res) => {
    const body = await parseBody(req);
    const payeeList = readJSON(payeesFile) || [];
    const newPayee = {
      id: generateId(),
      name: body.name
    };
    payeeList.push(newPayee);
    writeJSON(payeesFile, payeeList);
    sendJSON(res, newPayee, 201);
  },

  updatePayee: async (req, res, payeeId) => {
    const body = await parseBody(req);
    const payeeList = readJSON(payeesFile) || [];
    const index = payeeList.findIndex(p => p.id === payeeId);
    if (index === -1) {
      sendJSON(res, { error: 'Payee not found' }, 404);
      return;
    }
    const oldName = payeeList[index].name;
    const newName = body.name;
    payeeList[index] = { ...payeeList[index], name: newName };
    writeJSON(payeesFile, payeeList);

    const accounts = readJSON(accountsFile) || [];
    for (const account of accounts) {
      const txFile = getTransactionsFile(account.id);
      if (fs.existsSync(txFile)) {
        let transactions = readJSON(txFile) || [];
        let modified = false;
        for (const tx of transactions) {
          if (tx.payee === oldName) {
            tx.payee = newName;
            modified = true;
          }
        }
        if (modified) {
          writeJSON(txFile, transactions);
        }
      }
    }

    sendJSON(res, payeeList[index]);
  },

  getPayeeLastCategory: (req, res, payeeName) => {
    const decodedPayee = decodeURIComponent(payeeName);
    const accounts = readJSON(accountsFile) || [];

    let allTransactions = [];
    for (const account of accounts) {
      const txFile = getTransactionsFile(account.id);
      if (fs.existsSync(txFile)) {
        const transactions = readJSON(txFile) || [];
        const matching = transactions.filter(tx =>
          tx.payee && tx.payee.toLowerCase() === decodedPayee.toLowerCase() &&
          tx.category && tx.category !== 'Transfer' && tx.category !== 'Uncategorized'
        );
        allTransactions.push(...matching);
      }
    }

    if (allTransactions.length === 0) {
      sendJSON(res, { category: null });
      return;
    }

    allTransactions.sort((a, b) => {
      const dateCompare = b.date.localeCompare(a.date);
      if (dateCompare !== 0) return dateCompare;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    sendJSON(res, { category: allTransactions[0].category });
  },

  deletePayee: async (req, res, payeeId) => {
    const body = await parseBody(req);
    const replacementPayee = body.replacementPayee;

    let payeeList = readJSON(payeesFile) || [];
    const payee = payeeList.find(p => p.id === payeeId);
    if (!payee) {
      sendJSON(res, { error: 'Payee not found' }, 404);
      return;
    }
    if (!replacementPayee) {
      sendJSON(res, { error: 'Replacement payee required' }, 400);
      return;
    }

    const accounts = readJSON(accountsFile) || [];
    for (const account of accounts) {
      const txFile = getTransactionsFile(account.id);
      if (fs.existsSync(txFile)) {
        let transactions = readJSON(txFile) || [];
        let modified = false;
        for (const tx of transactions) {
          if (tx.payee === payee.name) {
            tx.payee = replacementPayee;
            modified = true;
          }
        }
        if (modified) {
          writeJSON(txFile, transactions);
        }
      }
    }

    payeeList = payeeList.filter(p => p.id !== payeeId);
    writeJSON(payeesFile, payeeList);
    sendJSON(res, { success: true });
  }
};

module.exports = payees;
