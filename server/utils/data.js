const fs = require('fs');
const path = require('path');
const { DATA_DIR, TRANSACTIONS_DIR, accountsFile, categoriesFile, payeesFile, recurringFile, settingsFile } = require('../config/paths');
const { defaultCategories } = require('../config/defaults');

const initDataFile = (filename, defaultData) => {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify(defaultData, null, 2));
  }
};

const ensureTransactionFiles = () => {
  try {
    const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    for (const account of accounts) {
      const txFile = path.join(TRANSACTIONS_DIR, `${account.id}.json`);
      if (!fs.existsSync(txFile)) {
        fs.writeFileSync(txFile, JSON.stringify([], null, 2));
        console.log(`Created missing transaction file for account: ${account.name}`);
      }
    }
  } catch (e) {
    // Accounts file doesn't exist or is invalid, skip
  }
};

const initializeData = () => {
  // Ensure data directories exist
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(TRANSACTIONS_DIR)) fs.mkdirSync(TRANSACTIONS_DIR);

  // Initialize data files if they don't exist
  initDataFile('accounts.json', []);
  initDataFile('categories.json', defaultCategories);
  initDataFile('payees.json', []);
  initDataFile('recurring.json', []);
  initDataFile('settings.json', { currencySymbol: '£' });

  // Ensure transaction files exist for all accounts
  ensureTransactionFiles();
};

module.exports = { initializeData };
