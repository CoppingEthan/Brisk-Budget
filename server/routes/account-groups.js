const { accountGroupsFile, accountsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

const accountGroups = {
  getAccountGroups: (req, res) => {
    const groups = readJSON(accountGroupsFile) || [];
    groups.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    sendJSON(res, groups);
  },

  createAccountGroup: async (req, res) => {
    const body = await parseBody(req);
    const groups = readJSON(accountGroupsFile) || [];
    const maxOrder = groups.reduce((max, g) => Math.max(max, g.sortOrder ?? 0), 0);
    const newGroup = {
      id: generateId(),
      name: body.name,
      icon: body.icon || null,
      sortOrder: maxOrder + 1,
      collapsed: false,
      createdAt: new Date().toISOString()
    };
    groups.push(newGroup);
    writeJSON(accountGroupsFile, groups);
    sendJSON(res, newGroup, 201);
  },

  updateAccountGroup: async (req, res, groupId) => {
    const body = await parseBody(req);
    const groups = readJSON(accountGroupsFile) || [];
    const index = groups.findIndex(g => g.id === groupId);
    if (index === -1) {
      sendJSON(res, { error: 'Group not found' }, 404);
      return;
    }
    if (body.name !== undefined) groups[index].name = body.name;
    if (body.icon !== undefined) groups[index].icon = body.icon || null;
    if (body.collapsed !== undefined) groups[index].collapsed = body.collapsed;
    if (body.sortOrder !== undefined) groups[index].sortOrder = body.sortOrder;
    writeJSON(accountGroupsFile, groups);
    sendJSON(res, groups[index]);
  },

  deleteAccountGroup: (req, res, groupId) => {
    let groups = readJSON(accountGroupsFile) || [];
    const index = groups.findIndex(g => g.id === groupId);
    if (index === -1) {
      sendJSON(res, { error: 'Group not found' }, 404);
      return;
    }

    // Ungroup all accounts in this group
    const accounts = readJSON(accountsFile) || [];
    let modified = false;
    for (const account of accounts) {
      if (account.groupId === groupId) {
        account.groupId = null;
        modified = true;
      }
    }
    if (modified) {
      writeJSON(accountsFile, accounts);
    }

    groups = groups.filter(g => g.id !== groupId);
    writeJSON(accountGroupsFile, groups);
    sendJSON(res, { success: true });
  },

  reorderAccountGroups: async (req, res) => {
    const body = await parseBody(req);
    const { order } = body;

    if (!Array.isArray(order)) {
      sendJSON(res, { error: 'order array required' }, 400);
      return;
    }

    const groups = readJSON(accountGroupsFile) || [];
    const accounts = readJSON(accountsFile) || [];

    for (let i = 0; i < order.length; i++) {
      const item = order[i];
      if (item.type === 'group') {
        const group = groups.find(g => g.id === item.id);
        if (group) group.sortOrder = i;
      } else {
        const account = accounts.find(a => a.id === item.id);
        if (account) account.sortOrder = i;
      }
    }

    writeJSON(accountGroupsFile, groups);
    writeJSON(accountsFile, accounts);
    sendJSON(res, { success: true });
  },

  setAccountGroup: async (req, res) => {
    const body = await parseBody(req);
    const { accountId, groupId } = body;

    if (!accountId) {
      sendJSON(res, { error: 'accountId required' }, 400);
      return;
    }

    const accounts = readJSON(accountsFile) || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      sendJSON(res, { error: 'Account not found' }, 404);
      return;
    }

    // Validate group exists if setting a groupId
    if (groupId) {
      const groups = readJSON(accountGroupsFile) || [];
      const group = groups.find(g => g.id === groupId);
      if (!group) {
        sendJSON(res, { error: 'Group not found' }, 404);
        return;
      }
    }

    account.groupId = groupId || null;
    writeJSON(accountsFile, accounts);
    sendJSON(res, { success: true, account });
  }
};

module.exports = accountGroups;
