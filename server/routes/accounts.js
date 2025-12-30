const { accountsFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

const accounts = {
  getAccounts: (req, res) => {
    const accountsList = readJSON(accountsFile) || [];
    const active = accountsList.filter(a => a.active);
    active.sort((a, b) => {
      const orderA = a.sortOrder ?? Infinity;
      const orderB = b.sortOrder ?? Infinity;
      return orderA - orderB;
    });
    sendJSON(res, active);
  },

  getAllAccounts: (req, res) => {
    const accountsList = readJSON(accountsFile) || [];
    sendJSON(res, accountsList);
  },

  createAccount: async (req, res) => {
    const body = await parseBody(req);
    const accountsList = readJSON(accountsFile) || [];
    const maxOrder = accountsList.reduce((max, a) => Math.max(max, a.sortOrder ?? 0), 0);
    const newAccount = {
      id: generateId(),
      name: body.name,
      type: body.type,
      startingBalance: parseFloat(body.startingBalance) || 0,
      assetValue: body.assetValue !== undefined ? parseFloat(body.assetValue) || 0 : null,
      icon: body.icon || null,
      active: true,
      sortOrder: maxOrder + 1,
      createdAt: new Date().toISOString()
    };
    accountsList.push(newAccount);
    writeJSON(accountsFile, accountsList);
    writeJSON(getTransactionsFile(newAccount.id), []);
    sendJSON(res, newAccount, 201);
  },

  updateAccount: async (req, res, accountId) => {
    const body = await parseBody(req);
    const accountsList = readJSON(accountsFile) || [];
    const index = accountsList.findIndex(a => a.id === accountId);
    if (index === -1) {
      sendJSON(res, { error: 'Account not found' }, 404);
      return;
    }
    accountsList[index] = { ...accountsList[index], ...body };
    writeJSON(accountsFile, accountsList);
    sendJSON(res, accountsList[index]);
  },

  deleteAccount: (req, res, accountId) => {
    const accountsList = readJSON(accountsFile) || [];
    const index = accountsList.findIndex(a => a.id === accountId);
    if (index === -1) {
      sendJSON(res, { error: 'Account not found' }, 404);
      return;
    }
    accountsList[index].active = false;
    writeJSON(accountsFile, accountsList);
    sendJSON(res, { success: true });
  },

  reorderAccounts: async (req, res) => {
    const body = await parseBody(req);
    const { accountIds } = body;

    if (!Array.isArray(accountIds)) {
      sendJSON(res, { error: 'accountIds array required' }, 400);
      return;
    }

    const accountsList = readJSON(accountsFile) || [];

    for (let i = 0; i < accountIds.length; i++) {
      const account = accountsList.find(a => a.id === accountIds[i]);
      if (account) {
        account.sortOrder = i;
      }
    }

    writeJSON(accountsFile, accountsList);
    sendJSON(res, { success: true });
  }
};

module.exports = accounts;
