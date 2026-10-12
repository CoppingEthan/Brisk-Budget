// Talks to the Brisk Budget server. Every change carries the X-Brisk-Request header the server
// requires, and failures come back as ApiError with a message that can be shown as-is.

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const hooks = { unauthorized: null, version: null };
export const onUnauthorized = (fn) => { hooks.unauthorized = fn; };
// fn(version, build): the server's X-Brisk-Version and X-Brisk-Build headers, from every response
export const onServerVersion = (fn) => { hooks.version = fn; };

async function request(method, url, body, { raw = false, signal } = {}) {
  const headers = {};
  let payload;
  if (method !== 'GET') headers['X-Brisk-Request'] = '1';
  if (body !== undefined && method !== 'GET') {
    if (raw) {
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal, credentials: 'same-origin' });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, "Can't reach Brisk Budget. Check the server is running, then try again.");
  }
  const version = res.headers.get('X-Brisk-Version');
  const build = res.headers.get('X-Brisk-Build');
  if ((version || build) && hooks.version) hooks.version(version, build);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = new ApiError(res.status, data?.error || `Something went wrong (${res.status})`, data?.details);
    // The session has ended: the sign-in screen takes over, so callers needn't show this error
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      error.signedOut = true;
      hooks.unauthorized?.();
    }
    throw error;
  }
  return data;
}

export const query = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

const enc = encodeURIComponent;

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body ?? {}, opts),
  put: (url, body) => request('PUT', url, body ?? {}),
  del: (url, body) => request('DELETE', url, body ?? {}),

  bootstrap: () => api.get('/api/bootstrap'),
  dismissNotice: (id) => api.post('/api/notices/dismiss', { id }),

  // Auth
  authStatus: () => api.get('/api/auth/status'),
  login: (password) => api.post('/api/auth/login', { password }),
  logout: () => api.post('/api/auth/logout'),
  setPassword: (body) => api.put('/api/auth/password', body),
  removePassword: (body) => api.del('/api/auth/password', body),

  // Settings & updates
  updateSettings: (body) => api.put('/api/settings', body),
  version: () => api.get('/api/version'),
  checkForUpdate: () => api.post('/api/version/check'),

  // Accounts & groups
  createAccount: (body) => api.post('/api/accounts', body),
  updateAccount: (id, body) => api.put(`/api/accounts/${enc(id)}`, body),
  archiveAccount: (id) => api.del(`/api/accounts/${enc(id)}`),
  restoreAccount: (id) => api.post(`/api/accounts/${enc(id)}/restore`),
  reorderAccounts: (accountIds) => api.put('/api/accounts/reorder', { accountIds }),
  createGroup: (body) => api.post('/api/account-groups', body),
  updateGroup: (id, body) => api.put(`/api/account-groups/${enc(id)}`, body),
  deleteGroup: (id) => api.del(`/api/account-groups/${enc(id)}`),
  reorderLayout: (order) => api.put('/api/account-groups/reorder', { order }),
  setAccountGroup: (accountId, groupId) => api.put('/api/account-groups/set-account', { accountId, groupId }),

  // Transactions
  ledger: (accountId, params, opts) => api.get(`/api/accounts/${enc(accountId)}/ledger${query(params)}`, opts),
  createTransaction: (accountId, body) => api.post(`/api/accounts/${enc(accountId)}/transactions`, body),
  updateTransaction: (accountId, txId, body) => api.put(`/api/accounts/${enc(accountId)}/transactions/${enc(txId)}`, body),
  deleteTransaction: (accountId, txId) => api.del(`/api/accounts/${enc(accountId)}/transactions/${enc(txId)}`),
  bulk: (accountId, body) => api.post(`/api/accounts/${enc(accountId)}/transactions/bulk`, body),
  restoreTransactions: (items) => api.post('/api/transactions/restore', { items }),
  createTransfer: (body) => api.post('/api/transfers', body),
  transferCandidates: (accountId, txId, targetAccountId) =>
    api.get(`/api/accounts/${enc(accountId)}/transactions/${enc(txId)}/transfer-candidates${query({ targetAccountId })}`),
  convertToTransfer: (accountId, txId, body) => api.post(`/api/accounts/${enc(accountId)}/transactions/${enc(txId)}/convert-to-transfer`, body),
  unlinkTransfer: (accountId, txId) => api.post(`/api/accounts/${enc(accountId)}/transactions/${enc(txId)}/convert-to-transaction`),
  importPreview: (accountId, body) => api.post(`/api/accounts/${enc(accountId)}/transactions/import/preview`, body),
  importRows: (accountId, body) => api.post(`/api/accounts/${enc(accountId)}/transactions/import`, body),

  // Categories
  categories: () => api.get('/api/categories'),
  createCategory: (body) => api.post('/api/categories', body),
  updateCategory: (id, body) => api.put(`/api/categories/${enc(id)}`, body),
  deleteCategory: (id, replacementId) => api.del(`/api/categories/${enc(id)}`, { replacementId }),
  reorderCategories: (ids) => api.put('/api/categories/reorder', { ids }),
  resetCategories: () => api.post('/api/categories/reset'),
  addSubcategory: (id, body) => api.post(`/api/categories/${enc(id)}/subcategories`, body),
  updateSubcategory: (id, subId, body) => api.put(`/api/categories/${enc(id)}/subcategories/${enc(subId)}`, body),
  deleteSubcategory: (id, subId, replacementId) => api.del(`/api/categories/${enc(id)}/subcategories/${enc(subId)}`, { replacementId }),
  reorderSubcategories: (id, ids) => api.put(`/api/categories/${enc(id)}/subcategories/reorder`, { ids }),

  // Payees
  createPayee: (body) => api.post('/api/payees', body),
  renamePayee: (id, name) => api.put(`/api/payees/${enc(id)}`, { name }),
  deletePayee: (id, replacementPayee) => api.del(`/api/payees/${enc(id)}`, { replacementPayee }),
  lastCategory: (name) => api.get(`/api/payees/last-category${query({ name })}`),

  // Recurring
  suggestions: () => api.get('/api/recurring/suggestions'),
  dismissSuggestion: (signature) => api.post('/api/recurring/suggestions/dismiss', { signature }),
  resetDismissed: () => api.del('/api/recurring/suggestions/dismissed'),
  createRecurring: (body) => api.post('/api/recurring', body),
  updateRecurring: (id, body) => api.put(`/api/recurring/${enc(id)}`, body),
  deleteRecurring: (id) => api.del(`/api/recurring/${enc(id)}`),
  restoreRecurring: (id) => api.post(`/api/recurring/${enc(id)}/restore`),
  approveRecurring: (id, body) => api.post(`/api/recurring/${enc(id)}/approve`, body),
  skipRecurring: (id, body) => api.post(`/api/recurring/${enc(id)}/skip`, body),

  // Dashboard
  summary: () => api.get('/api/dashboard/summary'),
  trend: () => api.get('/api/dashboard/trend'),
  series: (params, opts) => api.get(`/api/dashboard/series${query(params)}`, opts),
  flows: (params, opts) => api.get(`/api/dashboard/flows${query(params)}`, opts),

  // Backups & data
  backups: () => api.get('/api/backups'),
  createBackup: () => api.post('/api/backups'),
  deleteBackup: (name) => api.del(`/api/backups/${enc(name)}`),
  restoreSavedBackup: (name) => api.post(`/api/backups/${enc(name)}/restore`),
  restoreBackupFile: (file) => request('POST', '/api/backup/restore', file, { raw: true }),
  dataCheck: () => api.get('/api/data-check'),
  fixData: (body) => api.post('/api/data-check/fix', body)
};
