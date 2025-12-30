const fs = require('fs');
const path = require('path');
const { mimeTypes, sendJSON } = require('./utils/helpers');

// Import route handlers
const accounts = require('./routes/accounts');
const transactions = require('./routes/transactions');
const transfers = require('./routes/transfers');
const categories = require('./routes/categories');
const payees = require('./routes/payees');
const settings = require('./routes/settings');
const recurring = require('./routes/recurring');
const backup = require('./routes/backup');

const router = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // API routes
  if (pathname.startsWith('/api/')) {
    const parts = pathname.split('/').filter(Boolean);

    // /api/accounts
    if (parts[1] === 'accounts') {
      if (parts.length === 2) {
        if (method === 'GET') return accounts.getAccounts(req, res);
        if (method === 'POST') return accounts.createAccount(req, res);
      }
      if (parts.length === 3 && parts[2] === 'all') {
        if (method === 'GET') return accounts.getAllAccounts(req, res);
      }
      if (parts.length === 3 && parts[2] === 'reorder') {
        if (method === 'PUT') return accounts.reorderAccounts(req, res);
      }
      if (parts.length === 3) {
        const accountId = parts[2];
        if (method === 'PUT') return accounts.updateAccount(req, res, accountId);
        if (method === 'DELETE') return accounts.deleteAccount(req, res, accountId);
      }
      // /api/accounts/:id/transactions
      if (parts.length === 4 && parts[3] === 'transactions') {
        const accountId = parts[2];
        if (method === 'GET') return transactions.getTransactions(req, res, accountId);
        if (method === 'POST') return transactions.createTransaction(req, res, accountId);
      }
      // /api/accounts/:id/transactions/import
      if (parts.length === 5 && parts[3] === 'transactions' && parts[4] === 'import') {
        const accountId = parts[2];
        if (method === 'POST') return transactions.importTransactions(req, res, accountId);
      }
      // /api/accounts/:id/transactions/:txId
      if (parts.length === 5 && parts[3] === 'transactions') {
        const accountId = parts[2];
        const transactionId = parts[4];
        if (method === 'PUT') return transactions.updateTransaction(req, res, accountId, transactionId);
        if (method === 'DELETE') return transactions.deleteTransaction(req, res, accountId, transactionId);
      }
      // /api/accounts/:id/transactions/:txId/convert-to-transfer
      if (parts.length === 6 && parts[3] === 'transactions' && parts[5] === 'convert-to-transfer') {
        const accountId = parts[2];
        const transactionId = parts[4];
        if (method === 'POST') return transactions.convertToTransfer(req, res, accountId, transactionId);
      }
      // /api/accounts/:id/transactions/:txId/convert-to-transaction
      if (parts.length === 6 && parts[3] === 'transactions' && parts[5] === 'convert-to-transaction') {
        const accountId = parts[2];
        const transactionId = parts[4];
        if (method === 'POST') return transactions.convertToTransaction(req, res, accountId, transactionId);
      }
    }

    // /api/transfers
    if (parts[1] === 'transfers' && method === 'POST') {
      return transfers.createTransfer(req, res);
    }

    // /api/categories
    if (parts[1] === 'categories') {
      if (parts.length === 2) {
        if (method === 'GET') return categories.getCategories(req, res);
        if (method === 'POST') return categories.createCategory(req, res);
      }
      if (parts.length === 3 && parts[2] === 'reorder') {
        if (method === 'PUT') return categories.reorderCategories(req, res);
      }
      if (parts.length === 3 && parts[2] === 'reset') {
        if (method === 'POST') return categories.resetCategories(req, res);
      }
      if (parts.length === 3) {
        const categoryId = parts[2];
        if (method === 'PUT') return categories.updateCategory(req, res, categoryId);
        if (method === 'DELETE') return categories.deleteCategory(req, res, categoryId);
      }
      // /api/categories/:id/subcategories
      if (parts.length === 4 && parts[3] === 'subcategories') {
        const categoryId = parts[2];
        if (method === 'POST') return categories.addSubcategory(req, res, categoryId);
      }
      // /api/categories/:id/subcategories/reorder
      if (parts.length === 5 && parts[3] === 'subcategories' && parts[4] === 'reorder') {
        const categoryId = parts[2];
        if (method === 'PUT') return categories.reorderSubcategories(req, res, categoryId);
      }
      // /api/categories/:id/subcategories/:subId
      if (parts.length === 5 && parts[3] === 'subcategories') {
        const categoryId = parts[2];
        const subcategoryId = parts[4];
        if (method === 'PUT') return categories.updateSubcategory(req, res, categoryId, subcategoryId);
        if (method === 'DELETE') return categories.deleteSubcategory(req, res, categoryId, subcategoryId);
      }
    }

    // /api/payees
    if (parts[1] === 'payees') {
      if (parts.length === 2) {
        if (method === 'GET') return payees.getPayees(req, res);
        if (method === 'POST') return payees.createPayee(req, res);
      }
      // /api/payees/last-category/:payeeName
      if (parts.length === 4 && parts[2] === 'last-category') {
        const payeeName = parts[3];
        if (method === 'GET') return payees.getPayeeLastCategory(req, res, payeeName);
      }
      if (parts.length === 3) {
        const payeeId = parts[2];
        if (method === 'PUT') return payees.updatePayee(req, res, payeeId);
        if (method === 'DELETE') return payees.deletePayee(req, res, payeeId);
      }
    }

    // /api/settings
    if (parts[1] === 'settings') {
      if (method === 'GET') return settings.getSettings(req, res);
      if (method === 'PUT') return settings.updateSettings(req, res);
    }

    // /api/recurring
    if (parts[1] === 'recurring') {
      if (parts.length === 2) {
        if (method === 'GET') return recurring.getRecurring(req, res);
        if (method === 'POST') return recurring.createRecurring(req, res);
      }
      if (parts.length === 3) {
        const recurringId = parts[2];
        if (method === 'PUT') return recurring.updateRecurring(req, res, recurringId);
        if (method === 'DELETE') return recurring.deleteRecurring(req, res, recurringId);
      }
      if (parts.length === 4 && parts[3] === 'approve') {
        const recurringId = parts[2];
        if (method === 'POST') return recurring.approveRecurring(req, res, recurringId);
      }
      if (parts.length === 4 && parts[3] === 'skip') {
        const recurringId = parts[2];
        if (method === 'POST') return recurring.skipRecurring(req, res, recurringId);
      }
    }

    // /api/backup
    if (parts[1] === 'backup') {
      if (parts.length === 2 && method === 'GET') {
        return backup.downloadBackup(req, res);
      }
      if (parts.length === 3 && parts[2] === 'restore' && method === 'POST') {
        return backup.restoreBackup(req, res);
      }
    }

    sendJSON(res, { error: 'Not found' }, 404);
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, '..', 'public', filePath);

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
};

module.exports = router;
