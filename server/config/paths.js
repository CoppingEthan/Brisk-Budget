const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TRANSACTIONS_DIR = path.join(DATA_DIR, 'transactions');
const BACKUPS_DIR = path.join(__dirname, '..', '..', 'backups');

const accountsFile = path.join(DATA_DIR, 'accounts.json');
const categoriesFile = path.join(DATA_DIR, 'categories.json');
const payeesFile = path.join(DATA_DIR, 'payees.json');
const recurringFile = path.join(DATA_DIR, 'recurring.json');
const settingsFile = path.join(DATA_DIR, 'settings.json');

const getTransactionsFile = (accountId) => path.join(TRANSACTIONS_DIR, `${accountId}.json`);

module.exports = {
  DATA_DIR,
  TRANSACTIONS_DIR,
  BACKUPS_DIR,
  accountsFile,
  categoriesFile,
  payeesFile,
  recurringFile,
  settingsFile,
  getTransactionsFile
};
