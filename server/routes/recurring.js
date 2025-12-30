const { accountsFile, recurringFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

function calculateNextDueDate(template) {
  const current = new Date(template.nextDueDate);
  const { type, interval } = template.frequency;

  switch (type) {
    case 'days':
      current.setDate(current.getDate() + interval);
      break;
    case 'weeks':
      current.setDate(current.getDate() + (interval * 7));
      break;
    case 'months':
      current.setMonth(current.getMonth() + interval);
      break;
    case 'years':
      current.setFullYear(current.getFullYear() + interval);
      break;
  }
  return current.toISOString().split('T')[0];
}

const recurring = {
  getRecurring: (req, res) => {
    const recurringList = readJSON(recurringFile) || [];
    sendJSON(res, recurringList.filter(r => r.active !== false));
  },

  createRecurring: async (req, res) => {
    const body = await parseBody(req);
    const recurringList = readJSON(recurringFile) || [];
    const newRecurring = {
      id: generateId(),
      type: body.type || 'transaction',
      accountId: body.accountId || null,
      fromAccountId: body.fromAccountId || null,
      toAccountId: body.toAccountId || null,
      payee: body.payee || '',
      amount: parseFloat(body.amount) || 0,
      category: body.category || 'Uncategorized',
      description: body.description || '',
      notes: body.notes || '',
      frequency: body.frequency || { type: 'months', interval: 1 },
      startDate: body.startDate || new Date().toISOString().split('T')[0],
      nextDueDate: body.startDate || new Date().toISOString().split('T')[0],
      endCondition: body.endCondition || { type: 'never', value: null },
      occurrencesCompleted: 0,
      active: true,
      createdAt: new Date().toISOString()
    };
    recurringList.push(newRecurring);
    writeJSON(recurringFile, recurringList);
    sendJSON(res, newRecurring, 201);
  },

  updateRecurring: async (req, res, recurringId) => {
    const body = await parseBody(req);
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }
    recurringList[index] = { ...recurringList[index], ...body };
    writeJSON(recurringFile, recurringList);
    sendJSON(res, recurringList[index]);
  },

  deleteRecurring: (req, res, recurringId) => {
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }
    recurringList[index].active = false;
    writeJSON(recurringFile, recurringList);
    sendJSON(res, { success: true });
  },

  approveRecurring: async (req, res, recurringId) => {
    const body = await parseBody(req);
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }

    const template = recurringList[index];
    const approvedDate = body.date || template.nextDueDate;
    const approvedAmount = body.amount !== undefined ? parseFloat(body.amount) : template.amount;

    if (template.type === 'transfer') {
      const transferId1 = generateId();
      const transferId2 = generateId();
      const now = new Date().toISOString();

      const accounts = readJSON(accountsFile) || [];
      const fromAccount = accounts.find(a => a.id === template.fromAccountId);
      const toAccount = accounts.find(a => a.id === template.toAccountId);

      const fromTransaction = {
        id: transferId1,
        payee: `Transfer to ${toAccount?.name || 'Unknown'}`,
        amount: -Math.abs(approvedAmount),
        date: approvedDate,
        category: 'Transfer',
        description: template.description || '',
        notes: template.notes || '',
        createdAt: now,
        transferId: transferId2,
        transferAccountId: template.toAccountId
      };

      const toTransaction = {
        id: transferId2,
        payee: `Transfer from ${fromAccount?.name || 'Unknown'}`,
        amount: Math.abs(approvedAmount),
        date: approvedDate,
        category: 'Transfer',
        description: template.description || '',
        notes: template.notes || '',
        createdAt: now,
        transferId: transferId1,
        transferAccountId: template.fromAccountId
      };

      const fromTransactions = readJSON(getTransactionsFile(template.fromAccountId)) || [];
      const toTransactions = readJSON(getTransactionsFile(template.toAccountId)) || [];
      fromTransactions.push(fromTransaction);
      toTransactions.push(toTransaction);
      writeJSON(getTransactionsFile(template.fromAccountId), fromTransactions);
      writeJSON(getTransactionsFile(template.toAccountId), toTransactions);
    } else {
      const transactions = readJSON(getTransactionsFile(template.accountId)) || [];
      const newTransaction = {
        id: generateId(),
        payee: template.payee,
        amount: approvedAmount,
        date: approvedDate,
        category: template.category,
        description: template.description || '',
        notes: template.notes || '',
        createdAt: new Date().toISOString(),
        transferId: null,
        transferAccountId: null
      };
      transactions.push(newTransaction);
      writeJSON(getTransactionsFile(template.accountId), transactions);
    }

    template.occurrencesCompleted += 1;
    template.nextDueDate = calculateNextDueDate(template);
    writeJSON(recurringFile, recurringList);

    sendJSON(res, { success: true, nextDueDate: template.nextDueDate });
  },

  skipRecurring: async (req, res, recurringId) => {
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }

    const template = recurringList[index];
    template.nextDueDate = calculateNextDueDate(template);
    writeJSON(recurringFile, recurringList);

    sendJSON(res, { success: true, nextDueDate: template.nextDueDate });
  }
};

module.exports = recurring;
