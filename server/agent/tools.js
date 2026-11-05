// The tools an AI agent can use. One list serves both doors: MCP (/mcp, "tools/call") and the
// agent API (POST /api/agent/tools/<name>), with the same names, arguments and results. Each tool
// is a thin, well-described wrapper around a normal API endpoint, so an agent gets exactly the
// same checks and behaviour as the app itself. `api_request` reaches every other endpoint.

const TYPES = ['bank', 'savings', 'credit', 'loan', 'mortgage', 'investment', 'asset'];
const FREQUENCIES = ['days', 'weeks', 'months', 'years'];
const RANGES = ['1w', '1m', '3m', '6m', '1y', '5y'];

// Schema helpers
const s = (description) => ({ type: 'string', description });
const n = (description) => ({ type: 'number', description });
const b = (description) => ({ type: 'boolean', description });
const date = (description) => ({ type: 'string', format: 'date', description: `${description} (YYYY-MM-DD)` });
const ids = (description) => ({ type: 'array', items: { type: 'string' }, description });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const ACCOUNT_ID = s('Account id (from list_accounts)');
const ICON = { type: ['string', 'null'], description: 'Optional logo: a data URL of a PNG, JPEG or WebP image under 1 MB (square, about 256px, looks best), or null to remove it' };
const MONEY_NOTE = 'Amounts are in pounds. Money out of an account is negative, money in is positive.';

const accountFields = {
  name: s('Account name, e.g. "HSBC Current Account"'),
  type: { type: 'string', enum: TYPES, description: 'bank, savings, credit (card), loan, mortgage, investment or asset' },
  startingBalance: n('Balance before the first transaction. For credit cards, loans and mortgages, money owed is negative (owe £500 → -500).'),
  assetValue: n('Optional. Investments/assets: what it is worth today (replaces the balance in net worth). Loans/mortgages: value of what the loan paid for (property value), used for equity.'),
  interestRate: n('Mortgages only: yearly interest rate in percent, e.g. 4.29. Interest is then added monthly.'),
  groupId: s('Optional group id (from list_accounts) to put the account in'),
  icon: ICON
};

const transactionFields = {
  date: date('Date of the transaction'),
  amount: n(`Amount. ${MONEY_NOTE}`),
  payee: s('Who the money went to or came from'),
  categoryId: s('Category or subcategory id (from list_categories). Use this or `category`.'),
  category: s('Category name instead of an id; matched to an existing category or subcategory'),
  description: s('Optional description'),
  notes: s('Optional notes')
};

const recurringFields = {
  type: { type: 'string', enum: ['transaction', 'transfer'], description: 'A normal payment or income, or a transfer between two accounts' },
  accountId: s('Account it is paid from or into (not for transfers)'),
  payee: s('Payee (not for transfers)'),
  amount: n(`Amount each time. ${MONEY_NOTE} For transfers, a positive amount.`),
  categoryId: s('Category id (not for transfers)'),
  fromAccountId: s('Transfers: account the money leaves'),
  toAccountId: s('Transfers: account the money goes to'),
  frequency: object({
    type: { type: 'string', enum: FREQUENCIES },
    interval: { type: 'integer', minimum: 1, description: 'Every N days/weeks/months/years' }
  }, ['type']),
  startDate: date('Date of the first payment'),
  endCondition: object({
    type: { type: 'string', enum: ['never', 'after_occurrences', 'on_date'] },
    value: { description: 'Number of payments, or the end date' }
  }, ['type']),
  nextDueDate: date('Move only the next payment to this date (update only)'),
  autoLog: b('Log it automatically on the due date'),
  paused: b('Pause (true) or resume (false)'),
  description: s('Optional description'),
  notes: s('Optional notes')
};

// Copy the given keys that are present in args
const pick = (args, keys) => Object.fromEntries(keys.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
const without = (args, keys) => Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)));
const enc = encodeURIComponent;

export const TOOLS = [
  // ----- Reading -----
  {
    name: 'get_overview',
    title: 'Overview',
    description: 'Start here. Net worth, cash, savings and debt as of today, every account with its balance, groups, how many recurring payments are waiting to be logged, and settings.',
    readOnly: true,
    input: object({}),
    async run(args, api, ctx) {
      const [summary, boot] = await Promise.all([api('GET', '/api/dashboard/summary'), api('GET', '/api/bootstrap')]);
      const today = ctx.today();
      return {
        today,
        summary,
        accounts: boot.accounts.map(a => ({ id: a.id, name: a.name, type: a.type, balance: a.balance, active: a.active !== false, groupId: a.groupId || null, assetValue: a.assetValue ?? null, interestRate: a.interestRate ?? null })),
        groups: boot.groups,
        recurring: { total: boot.recurring.length, waitingToBeLogged: boot.recurring.filter(r => !r.paused && r.status !== 'ended' && r.nextDueDate < today).length },
        settings: boot.settings,
        version: boot.version
      };
    }
  },
  {
    name: 'list_accounts',
    title: 'List accounts',
    description: 'Every account with id, type, balance, group and settings. Archived (closed) accounts are included only when asked.',
    readOnly: true,
    input: object({ includeArchived: b('Include archived accounts') }),
    run: (args, api) => api('GET', '/api/accounts', { query: args.includeArchived ? { all: '1' } : {} })
  },
  {
    name: 'list_transactions',
    title: 'List transactions',
    description: 'Transactions in one account, newest first, with the running balance after each. Filter by text, dates, category or direction. Returns `items`, `total` (matches) and `totals` (money in/out of the matches). Page with offset/limit (limit up to 1000).',
    readOnly: true,
    input: object({
      accountId: ACCOUNT_ID,
      q: s('Search payee, description, notes, category or amount'),
      from: date('Earliest date'),
      to: date('Latest date'),
      categoryId: s('Only this category (and its subcategories)'),
      direction: { type: 'string', enum: ['in', 'out'], description: 'Only money in or only money out' },
      min: n('Smallest amount (ignoring sign)'),
      max: n('Largest amount (ignoring sign)'),
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 100' }
    }, ['accountId']),
    run: (args, api) => api('GET', `/api/accounts/${enc(args.accountId)}/ledger`, { query: { limit: 100, ...without(args, ['accountId']) } })
  },
  {
    name: 'list_categories',
    title: 'List categories',
    description: 'All categories with their subcategories, ids, colours and emoji.',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/categories')
  },
  {
    name: 'list_payees',
    title: 'List payees',
    description: 'Every saved payee name with its id.',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/payees')
  },
  {
    name: 'list_recurring',
    title: 'List recurring payments',
    description: 'Every recurring payment, income and transfer: amount, frequency, next due date, status (active, paused, ended) and monthly equivalent. A nextDueDate before today means it is waiting to be logged.',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/recurring')
  },
  {
    name: 'get_recurring_suggestions',
    title: 'Recurring suggestions',
    description: 'Regular payments Brisk Budget has spotted in the transactions that are not set up as recurring yet.',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/recurring/suggestions')
  },
  {
    name: 'get_balance_history',
    title: 'Balance history',
    description: 'Combined balance of some accounts over time, optionally with a forecast from recurring payments.',
    readOnly: true,
    input: object({
      accountIds: ids('Accounts to include (all when left out)'),
      range: { type: 'string', enum: RANGES, description: 'How far back (default 1m)' },
      forecast: { type: 'string', enum: ['0', ...RANGES], description: 'How far ahead to forecast (default none)' }
    }),
    run: (args, api) => api('GET', '/api/dashboard/series', {
      query: { ...(args.accountIds?.length ? { accounts: args.accountIds.join(',') } : {}), range: args.range || '1m', forecast: args.forecast || '0' }
    })
  },
  {
    name: 'get_money_flow',
    title: 'Money flow',
    description: 'Income by source and spending by category between two dates (transfers between accounts are left out).',
    readOnly: true,
    input: object({ from: date('Start date'), to: date('End date') }, ['from', 'to']),
    run: (args, api) => api('GET', '/api/dashboard/flows', { query: pick(args, ['from', 'to']) })
  },
  {
    name: 'run_data_check',
    title: 'Data check',
    description: 'Look for problems such as one-sided transfers, transactions in deleted categories or duplicate ids. Fix them with fix_data_issues.',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/data-check')
  },
  {
    name: 'list_backups',
    title: 'List backups',
    description: 'Backups saved on the server (automatic, safety and manual).',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/backups')
  },
  {
    name: 'get_settings',
    title: 'Settings',
    description: 'General settings: name, currency symbol and chart options.',
    readOnly: true,
    input: object({}),
    run: (args, api) => api('GET', '/api/settings')
  },
  {
    name: 'list_api_endpoints',
    title: 'List API endpoints',
    description: 'Every API endpoint (method and path), for use with api_request when no other tool fits.',
    readOnly: true,
    input: object({}),
    run: (args, api, ctx) => ({ endpoints: ctx.endpoints() })
  },

  // ----- Accounts and groups -----
  {
    name: 'create_account',
    title: 'Create account',
    description: 'Add an account. For a credit card, loan or mortgage, startingBalance is the amount owed as a negative number.',
    input: object(accountFields, ['name', 'type']),
    run: (args, api) => api('POST', '/api/accounts', { body: args })
  },
  {
    name: 'update_account',
    title: 'Update account',
    description: 'Change an account\'s name, type, starting balance, current value, interest rate, group or logo. Only the fields given change.',
    input: object({ accountId: ACCOUNT_ID, ...accountFields }, ['accountId']),
    run: (args, api) => api('PUT', `/api/accounts/${enc(args.accountId)}`, { body: without(args, ['accountId']) })
  },
  {
    name: 'archive_account',
    title: 'Archive account',
    description: 'Archive (close) an account. Its transactions are kept and it can be restored; its recurring payments are paused.',
    destructive: true,
    input: object({ accountId: ACCOUNT_ID }, ['accountId']),
    run: (args, api) => api('DELETE', `/api/accounts/${enc(args.accountId)}`)
  },
  {
    name: 'restore_account',
    title: 'Restore account',
    description: 'Bring an archived account back.',
    input: object({ accountId: ACCOUNT_ID }, ['accountId']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/restore`)
  },
  {
    name: 'create_group',
    title: 'Create account group',
    description: 'Add a group for accounts in the sidebar (e.g. "Everyday", "Savings").',
    input: object({ name: s('Group name'), icon: ICON }, ['name']),
    run: (args, api) => api('POST', '/api/account-groups', { body: args })
  },
  {
    name: 'update_group',
    title: 'Update account group',
    description: 'Rename a group or change its logo.',
    input: object({ groupId: s('Group id'), name: s('New name'), icon: ICON }, ['groupId']),
    run: (args, api) => api('PUT', `/api/account-groups/${enc(args.groupId)}`, { body: without(args, ['groupId']) })
  },
  {
    name: 'delete_group',
    title: 'Delete account group',
    description: 'Delete a group. Its accounts are kept and moved out of it.',
    destructive: true,
    input: object({ groupId: s('Group id') }, ['groupId']),
    run: (args, api) => api('DELETE', `/api/account-groups/${enc(args.groupId)}`)
  },
  {
    name: 'move_account_to_group',
    title: 'Move account to group',
    description: 'Put an account in a group, or take it out of its group (groupId null).',
    input: object({ accountId: ACCOUNT_ID, groupId: { type: ['string', 'null'], description: 'Group id, or null for no group' } }, ['accountId', 'groupId']),
    run: (args, api) => api('PUT', '/api/account-groups/set-account', { body: { accountId: args.accountId, groupId: args.groupId } })
  },

  // ----- Transactions -----
  {
    name: 'add_transaction',
    title: 'Add transaction',
    description: `Add one transaction to an account. ${MONEY_NOTE} For money moving between two of the user's accounts use create_transfer instead. To add many at once (e.g. a bank statement) use import_transactions.`,
    input: object({ accountId: ACCOUNT_ID, ...transactionFields }, ['accountId', 'date', 'amount', 'payee']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions`, { body: without(args, ['accountId']) })
  },
  {
    name: 'update_transaction',
    title: 'Update transaction',
    description: 'Change a transaction. Only the fields given change. Editing either side of a transfer updates both sides.',
    input: object({ accountId: ACCOUNT_ID, transactionId: s('Transaction id'), ...transactionFields }, ['accountId', 'transactionId']),
    run: (args, api) => api('PUT', `/api/accounts/${enc(args.accountId)}/transactions/${enc(args.transactionId)}`, { body: without(args, ['accountId', 'transactionId']) })
  },
  {
    name: 'delete_transactions',
    title: 'Delete transactions',
    description: 'Delete transactions from one account (deleting a transfer removes its other side too). Returns `undo`: pass it to restore_transactions to put everything back.',
    destructive: true,
    input: object({ accountId: ACCOUNT_ID, transactionIds: ids('Transaction ids') }, ['accountId', 'transactionIds']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions/bulk`, { body: { action: 'delete', ids: args.transactionIds } })
  },
  {
    name: 'categorize_transactions',
    title: 'Categorise transactions',
    description: 'Put several transactions in one account into a category.',
    input: object({ accountId: ACCOUNT_ID, transactionIds: ids('Transaction ids'), categoryId: s('Category or subcategory id') }, ['accountId', 'transactionIds', 'categoryId']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions/bulk`, { body: { action: 'categorize', ids: args.transactionIds, categoryId: args.categoryId } })
  },
  {
    name: 'restore_transactions',
    title: 'Undo a delete',
    description: 'Put back transactions using the `undo` list returned by delete_transactions, make_transfer or unlink_transfer.',
    input: object({ undo: { type: 'array', items: { type: 'object' }, description: 'The undo list exactly as it was returned' } }, ['undo']),
    run: (args, api) => api('POST', '/api/transactions/restore', { body: { items: args.undo } })
  },
  {
    name: 'create_transfer',
    title: 'Create transfer',
    description: 'Move money between two of the user\'s accounts: adds the money-out side and the money-in side together, linked.',
    input: object({
      fromAccountId: s('Account the money leaves'),
      toAccountId: s('Account the money goes to'),
      amount: n('Amount, positive'),
      date: date('Date'),
      description: s('Optional description'),
      notes: s('Optional notes')
    }, ['fromAccountId', 'toAccountId', 'amount', 'date']),
    run: (args, api) => api('POST', '/api/transfers', { body: args })
  },
  {
    name: 'find_transfer_matches',
    title: 'Find the other side of a transfer',
    description: 'For a transaction in one account, list transactions in another account that could be its other side (same amount the other way, a few days apart). Use one with make_transfer.',
    readOnly: true,
    input: object({ accountId: ACCOUNT_ID, transactionId: s('Transaction id'), otherAccountId: s('The other account') }, ['accountId', 'transactionId', 'otherAccountId']),
    run: (args, api) => api('GET', `/api/accounts/${enc(args.accountId)}/transactions/${enc(args.transactionId)}/transfer-candidates`, { query: { targetAccountId: args.otherAccountId } })
  },
  {
    name: 'make_transfer',
    title: 'Turn a transaction into a transfer',
    description: 'Mark an existing transaction as a transfer to or from another account. With matchTransactionId (from find_transfer_matches), the two existing transactions are linked; without it, the other side is created. Use this after importing statements from both accounts so nothing is counted twice.',
    input: object({
      accountId: ACCOUNT_ID,
      transactionId: s('Transaction id'),
      otherAccountId: s('The other account'),
      matchTransactionId: s('Optional: the existing transaction in the other account to link with')
    }, ['accountId', 'transactionId', 'otherAccountId']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions/${enc(args.transactionId)}/convert-to-transfer`, {
      body: { targetAccountId: args.otherAccountId, ...(args.matchTransactionId ? { linkTransactionId: args.matchTransactionId } : {}) }
    })
  },
  {
    name: 'unlink_transfer',
    title: 'Unlink a transfer',
    description: 'Turn a transfer back into ordinary transactions. A side Brisk Budget created is removed; real transactions are kept with their old categories.',
    input: object({ accountId: ACCOUNT_ID, transactionId: s('Transaction id (either side)') }, ['accountId', 'transactionId']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions/${enc(args.transactionId)}/convert-to-transaction`)
  },
  {
    name: 'import_transactions',
    title: 'Import transactions',
    description: `Add many transactions to one account, such as a bank statement, skipping any already there (same date, amount and payee, or a transfer of the same amount within 3 days). Nothing existing is changed. Run with dryRun first: it reports which rows are duplicates and which category names are unknown. A real import returns a batch id; undo_import removes the whole batch. ${MONEY_NOTE}`,
    input: object({
      accountId: ACCOUNT_ID,
      rows: {
        type: 'array',
        description: 'Up to 20,000 rows',
        items: object({
          date: date('Date'),
          amount: n('Amount'),
          payee: s('Payee as the bank shows it'),
          category: s('Optional category name'),
          description: s('Optional'),
          notes: s('Optional')
        }, ['date', 'amount', 'payee'])
      },
      dryRun: b('Only check the rows; change nothing'),
      skipDuplicates: b('Skip rows that are already in the account (default true)'),
      categoryMap: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional: category name in the rows → category id' }
    }, ['accountId', 'rows']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions/${args.dryRun ? 'import/preview' : 'import'}`, {
      body: pick(args, ['rows', 'skipDuplicates', 'categoryMap'])
    })
  },
  {
    name: 'undo_import',
    title: 'Undo an import',
    description: 'Remove every transaction added by one import (its batch id). Returns `undo` in case it was a mistake.',
    destructive: true,
    input: object({ accountId: ACCOUNT_ID, batch: s('The batch id import_transactions returned') }, ['accountId', 'batch']),
    run: (args, api) => api('POST', `/api/accounts/${enc(args.accountId)}/transactions/bulk`, { body: { action: 'delete', importBatch: args.batch } })
  },

  // ----- Categories and payees -----
  {
    name: 'create_category',
    title: 'Create category',
    description: 'Add a category, or a subcategory when parentId is given.',
    input: object({ name: s('Name'), parentId: s('Optional: parent category id to add a subcategory'), emoji: s('Emoji (top-level only)'), color: s('Colour like #22c55e (top-level only)') }, ['name']),
    run: (args, api) => (args.parentId
      ? api('POST', `/api/categories/${enc(args.parentId)}/subcategories`, { body: { name: args.name } })
      : api('POST', '/api/categories', { body: pick(args, ['name', 'emoji', 'color']) }))
  },
  {
    name: 'update_category',
    title: 'Update category',
    description: 'Rename a category or subcategory, or change a category\'s emoji or colour. Renaming keeps every transaction in it.',
    input: object({ categoryId: s('Category id, or the subcategory id when parentId is given'), parentId: s('Parent id when changing a subcategory'), name: s('New name'), emoji: s('Emoji'), color: s('Colour like #22c55e') }, ['categoryId']),
    run: (args, api) => (args.parentId
      ? api('PUT', `/api/categories/${enc(args.parentId)}/subcategories/${enc(args.categoryId)}`, { body: pick(args, ['name']) })
      : api('PUT', `/api/categories/${enc(args.categoryId)}`, { body: pick(args, ['name', 'emoji', 'color']) }))
  },
  {
    name: 'delete_category',
    title: 'Delete category',
    description: 'Delete a category or subcategory. Transactions in it move to replacementId (or Uncategorized).',
    destructive: true,
    input: object({ categoryId: s('Category id, or subcategory id with parentId'), parentId: s('Parent id when deleting a subcategory'), replacementId: s('Category to move its transactions to') }, ['categoryId']),
    run: (args, api) => (args.parentId
      ? api('DELETE', `/api/categories/${enc(args.parentId)}/subcategories/${enc(args.categoryId)}`, { body: pick(args, ['replacementId']) })
      : api('DELETE', `/api/categories/${enc(args.categoryId)}`, { body: pick(args, ['replacementId']) }))
  },
  {
    name: 'rename_payee',
    title: 'Rename payee',
    description: 'Rename a payee everywhere it is used. Renaming to an existing payee merges the two.',
    input: object({ payeeId: s('Payee id'), name: s('New name') }, ['payeeId', 'name']),
    run: (args, api) => api('PUT', `/api/payees/${enc(args.payeeId)}`, { body: { name: args.name } })
  },
  {
    name: 'delete_payee',
    title: 'Delete payee',
    description: 'Remove a payee from the list, optionally renaming its transactions to another payee.',
    destructive: true,
    input: object({ payeeId: s('Payee id'), replacementPayee: s('Optional: name to give its transactions') }, ['payeeId']),
    run: (args, api) => api('DELETE', `/api/payees/${enc(args.payeeId)}`, { body: pick(args, ['replacementPayee']) })
  },

  // ----- Recurring -----
  {
    name: 'create_recurring',
    title: 'Create recurring payment',
    description: 'Set up a recurring payment, income or transfer. Payments already due are logged straight away only if autoLog is true.',
    input: object(recurringFields, ['amount', 'frequency', 'startDate']),
    run: (args, api) => api('POST', '/api/recurring', { body: args })
  },
  {
    name: 'update_recurring',
    title: 'Update recurring payment',
    description: 'Change a recurring payment. Only the fields given change. Set paused true/false to pause or resume (resuming skips payments missed while paused).',
    input: object({ recurringId: s('Recurring payment id'), ...recurringFields }, ['recurringId']),
    run: (args, api) => api('PUT', `/api/recurring/${enc(args.recurringId)}`, { body: without(args, ['recurringId']) })
  },
  {
    name: 'delete_recurring',
    title: 'Delete recurring payment',
    description: 'Stop and remove a recurring payment. Transactions it already logged are kept.',
    destructive: true,
    input: object({ recurringId: s('Recurring payment id') }, ['recurringId']),
    run: (args, api) => api('DELETE', `/api/recurring/${enc(args.recurringId)}`)
  },
  {
    name: 'log_recurring_payment',
    title: 'Log a recurring payment',
    description: 'Record the next due payment as a real transaction and move the schedule on. dueDate must be the payment\'s current nextDueDate (protects against logging twice). Only log payments that are NOT already in the account from an imported statement; use skip_recurring_payment for those.',
    input: object({ recurringId: s('Recurring payment id'), dueDate: date('Its current nextDueDate'), date: date('Date to record it on (default the due date)'), amount: n('Amount if different this time') }, ['recurringId', 'dueDate']),
    run: (args, api) => api('POST', `/api/recurring/${enc(args.recurringId)}/approve`, { body: { dueDate: args.dueDate, date: args.date || args.dueDate, ...pick(args, ['amount']) } })
  },
  {
    name: 'skip_recurring_payment',
    title: 'Skip a recurring payment',
    description: 'Move the schedule on without recording anything, e.g. when the payment is already in the account from an imported statement. dueDate must be its current nextDueDate.',
    input: object({ recurringId: s('Recurring payment id'), dueDate: date('Its current nextDueDate') }, ['recurringId', 'dueDate']),
    run: (args, api) => api('POST', `/api/recurring/${enc(args.recurringId)}/skip`, { body: { dueDate: args.dueDate } })
  },
  {
    name: 'dismiss_suggestion',
    title: 'Dismiss a suggestion',
    description: 'Hide a recurring suggestion (by its signature).',
    input: object({ signature: s('The suggestion\'s signature') }, ['signature']),
    run: (args, api) => api('POST', '/api/recurring/suggestions/dismiss', { body: { signature: args.signature } })
  },

  // ----- Settings, data and backups -----
  {
    name: 'update_settings',
    title: 'Update settings',
    description: 'Change general settings.',
    input: object({ name: s('Household name shown in the greeting'), currencySymbol: s('Currency symbol, e.g. £'), groupChartToggles: b('Group accounts in the dashboard chart'), checkForUpdates: b('Check GitHub for new versions') }),
    run: (args, api) => api('PUT', '/api/settings', { body: args })
  },
  {
    name: 'fix_data_issues',
    title: 'Fix data issues',
    description: 'Fix problems found by run_data_check: the given issue ids, or all of them.',
    input: object({ issueIds: ids('Issue ids from run_data_check'), all: b('Fix everything found') }),
    run: (args, api) => api('POST', '/api/data-check/fix', { body: args.all ? { all: true } : { ids: args.issueIds || [] } })
  },
  {
    name: 'create_backup',
    title: 'Create backup',
    description: 'Save a backup of all data on the server now. Worth doing before large changes.',
    input: object({}),
    run: (args, api) => api('POST', '/api/backups')
  },
  {
    name: 'restore_backup',
    title: 'Restore backup',
    description: 'Replace ALL data with a backup saved on the server (from list_backups). A safety backup of the current data is taken first.',
    destructive: true,
    input: object({ name: s('Backup file name') }, ['name']),
    run: (args, api) => api('POST', `/api/backups/${enc(args.name)}/restore`)
  },
  {
    name: 'api_request',
    title: 'Call any API endpoint',
    description: 'Call any Brisk Budget API endpoint directly (see list_api_endpoints), for anything the other tools do not cover. Signing in and AI access settings can only be changed by a person in the app.',
    destructive: true,
    input: object({
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      path: s('Path starting with /api/, e.g. /api/accounts'),
      query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Optional query parameters' },
      body: { type: 'object', description: 'Optional JSON body' }
    }, ['method', 'path']),
    run: (args, api) => api(args.method, args.path, { query: args.query, body: args.body })
  }
];

export const toolByName = new Map(TOOLS.map(t => [t.name, t]));

// How a tool is described to agents (the same shape over MCP and the agent API)
export function describeTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input,
    annotations: { title: tool.title, readOnlyHint: !!tool.readOnly, destructiveHint: !!tool.destructive, openWorldHint: false }
  };
}
