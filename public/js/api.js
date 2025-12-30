// API Client
const API = {
  // Accounts
  async getAccounts() {
    const res = await fetch('/api/accounts');
    return res.json();
  },

  async createAccount(data) {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateAccount(id, data) {
    const res = await fetch(`/api/accounts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deleteAccount(id) {
    const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async reorderAccounts(accountIds) {
    const res = await fetch('/api/accounts/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds })
    });
    return res.json();
  },

  // Transactions
  async getTransactions(accountId) {
    const res = await fetch(`/api/accounts/${accountId}/transactions`);
    return res.json();
  },

  async createTransaction(accountId, data) {
    const res = await fetch(`/api/accounts/${accountId}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateTransaction(accountId, transactionId, data) {
    const res = await fetch(`/api/accounts/${accountId}/transactions/${transactionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deleteTransaction(accountId, transactionId) {
    const res = await fetch(`/api/accounts/${accountId}/transactions/${transactionId}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  async importTransactions(accountId, transactions) {
    const res = await fetch(`/api/accounts/${accountId}/transactions/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions })
    });
    return res.json();
  },

  async convertToTransfer(accountId, transactionId, targetAccountId) {
    const res = await fetch(`/api/accounts/${accountId}/transactions/${transactionId}/convert-to-transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAccountId })
    });
    return res.json();
  },

  async convertToTransaction(accountId, transactionId) {
    const res = await fetch(`/api/accounts/${accountId}/transactions/${transactionId}/convert-to-transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.json();
  },

  // Transfers
  async createTransfer(data) {
    const res = await fetch('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  // Categories
  async getCategories() {
    const res = await fetch('/api/categories');
    return res.json();
  },

  async createCategory(data) {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateCategory(id, data) {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deleteCategory(id, replacementCategory) {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replacementCategory })
    });
    return res.json();
  },

  async reorderCategories(categoryIds) {
    const res = await fetch('/api/categories/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryIds })
    });
    return res.json();
  },

  async resetCategories() {
    const res = await fetch('/api/categories/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.json();
  },

  async addSubcategory(categoryId, data) {
    const res = await fetch(`/api/categories/${categoryId}/subcategories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateSubcategory(categoryId, subcategoryId, data) {
    const res = await fetch(`/api/categories/${categoryId}/subcategories/${subcategoryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deleteSubcategory(categoryId, subcategoryId, replacementCategory) {
    const res = await fetch(`/api/categories/${categoryId}/subcategories/${subcategoryId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replacementCategory })
    });
    return res.json();
  },

  async reorderSubcategories(categoryId, subcategoryIds) {
    const res = await fetch(`/api/categories/${categoryId}/subcategories/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subcategoryIds })
    });
    return res.json();
  },

  // Payees
  async getPayees() {
    const res = await fetch('/api/payees');
    return res.json();
  },

  async createPayee(data) {
    const res = await fetch('/api/payees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updatePayee(id, data) {
    const res = await fetch(`/api/payees/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deletePayee(id, data) {
    const res = await fetch(`/api/payees/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async getPayeeLastCategory(payeeName) {
    const res = await fetch(`/api/payees/last-category/${encodeURIComponent(payeeName)}`);
    return res.json();
  },

  // Settings
  async getSettings() {
    const res = await fetch('/api/settings');
    return res.json();
  },

  async updateSettings(data) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  // Recurring
  async getRecurring() {
    const res = await fetch('/api/recurring');
    return res.json();
  },

  async createRecurring(data) {
    const res = await fetch('/api/recurring', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateRecurring(id, data) {
    const res = await fetch(`/api/recurring/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deleteRecurring(id) {
    const res = await fetch(`/api/recurring/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async approveRecurring(id, data) {
    const res = await fetch(`/api/recurring/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async skipRecurring(id) {
    const res = await fetch(`/api/recurring/${id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.json();
  },

  // Backup
  downloadBackup() {
    window.location.href = '/api/backup';
  },

  async restoreBackup(file) {
    const res = await fetch('/api/backup/restore', {
      method: 'POST',
      body: file
    });
    return res.json();
  }
};
