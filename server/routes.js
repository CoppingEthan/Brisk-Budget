// Every API endpoint in one place. Handlers return data (sent as JSON) or a `reply()`.
import { Router } from './http/router.js';
import { badRequest } from './lib/errors.js';
import { APP_VERSION } from './config.js';
import { isISODate } from '../public/js/shared/dates.js';

export const reply = (status, data, headers = {}) => ({ __reply: true, status, data, headers });
export const file = (buffer, headers) => ({ __file: true, buffer, headers });

const MB = 1024 * 1024;

export function buildRoutes(app) {
  const s = app.services;
  const r = new Router();
  const created = (data) => reply(201, data);
  const ids = (value) => (value ? value.split(',').filter(Boolean) : null);

  // ----- Public -----
  r.get('/api/health', () => ({ ok: true, version: APP_VERSION }), { public: true });
  r.get('/api/auth/status', ({ req }) => s.auth.status(req), { public: true });
  // Anyone can reach these two, so they only accept small bodies
  r.post('/api/auth/login', async ({ req, body }) => {
    const result = await s.auth.login(req, body);
    return reply(200, { ok: true }, result.cookie ? { 'Set-Cookie': result.cookie } : {});
  }, { public: true, limit: 16 * 1024 });
  r.post('/api/auth/logout', () => reply(200, { ok: true }, { 'Set-Cookie': s.auth.clearCookie() }), { public: true, limit: 16 * 1024 });

  // ----- App start-up: everything the interface needs in one request -----
  r.get('/api/bootstrap', ({ req }) => {
    s.housekeeping.run();
    return {
      version: APP_VERSION,
      settings: app.store.data.settings,
      accounts: s.accounts.list({ includeArchived: true }),
      groups: s.accounts.listGroups(),
      categories: s.categories.list(),
      payees: s.payees.list(),
      recurring: s.recurring.list(),
      auth: s.auth.status(req),
      update: s.updates.info(),
      notices: app.notices.list()
    };
  });
  r.post('/api/notices/dismiss', ({ body }) => app.notices.dismiss(body?.id));

  // ----- Settings & security -----
  r.get('/api/settings', () => app.store.data.settings);
  r.put('/api/settings', ({ body }) => app.settings.update(body));
  r.put('/api/auth/password', async ({ req, body }) => {
    const result = await s.auth.setPassword(req, body);
    return reply(200, { ok: true }, { 'Set-Cookie': result.cookie });
  });
  r.delete('/api/auth/password', async ({ req, body }) => {
    const result = await s.auth.removePassword(req, body);
    return reply(200, { ok: true }, result.cookie ? { 'Set-Cookie': result.cookie } : {});
  });
  r.get('/api/version', () => s.updates.info());
  r.post('/api/version/check', () => s.updates.check());

  // ----- Accounts & groups -----
  r.get('/api/accounts', ({ query }) => s.accounts.list({ includeArchived: query.get('all') === '1' }));
  r.get('/api/accounts/all', () => s.accounts.list({ includeArchived: true }));
  r.post('/api/accounts', ({ body }) => created(s.accounts.create(body)));
  r.put('/api/accounts/reorder', ({ body }) => s.accounts.reorder(body));
  r.put('/api/accounts/:id', ({ params, body }) => s.accounts.update(params.id, body));
  r.delete('/api/accounts/:id', ({ params }) => s.accounts.archive(params.id));
  r.post('/api/accounts/:id/restore', ({ params }) => s.accounts.restore(params.id));
  r.get('/api/icons/:file', ({ params }) => file(s.accounts.icon(params.file), {
    'Content-Type': params.file.endsWith('.png') ? 'image/png' : params.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
    'Cache-Control': 'private, max-age=31536000, immutable'
  }));

  r.get('/api/account-groups', () => s.accounts.listGroups());
  r.post('/api/account-groups', ({ body }) => created(s.accounts.createGroup(body)));
  r.put('/api/account-groups/reorder', ({ body }) => s.accounts.reorderLayout(body));
  r.put('/api/account-groups/set-account', ({ body }) => s.accounts.setAccountGroup(body));
  r.put('/api/account-groups/:id', ({ params, body }) => s.accounts.updateGroup(params.id, body));
  r.delete('/api/account-groups/:id', ({ params }) => s.accounts.removeGroup(params.id));

  // ----- Transactions -----
  r.get('/api/accounts/:id/transactions', ({ params, query }) => (
    query.has('offset') || query.has('limit')
      ? s.transactions.ledger(params.id, query)
      : s.transactions.listAll(params.id)
  ));
  r.get('/api/accounts/:id/ledger', ({ params, query }) => s.transactions.ledger(params.id, query));
  r.post('/api/accounts/:id/transactions', ({ params, body }) => created(s.transactions.create(params.id, body)));
  r.post('/api/accounts/:id/transactions/bulk', ({ params, body }) => s.transactions.bulk(params.id, body));
  r.post('/api/accounts/:id/transactions/import/preview', ({ params, body }) => s.transactions.importPreview(params.id, body), { limit: 25 * MB });
  r.post('/api/accounts/:id/transactions/import', ({ params, body }) => s.transactions.importRows(params.id, body), { limit: 25 * MB });
  r.put('/api/accounts/:id/transactions/:txId', ({ params, body }) => s.transactions.update(params.id, params.txId, body));
  r.delete('/api/accounts/:id/transactions/:txId', ({ params }) => s.transactions.remove(params.id, params.txId));
  r.get('/api/accounts/:id/transactions/:txId/transfer-candidates', ({ params, query }) =>
    s.transactions.transferCandidates(params.id, params.txId, query.get('targetAccountId')));
  r.post('/api/accounts/:id/transactions/:txId/convert-to-transfer', ({ params, body }) =>
    s.transactions.convertToTransfer(params.id, params.txId, body));
  r.post('/api/accounts/:id/transactions/:txId/convert-to-transaction', ({ params }) =>
    s.transactions.unlinkTransfer(params.id, params.txId));
  r.post('/api/transactions/restore', ({ body }) => s.transactions.restore(body), { limit: 25 * MB });
  r.post('/api/transfers', ({ body }) => created(s.transactions.createTransfer(body)));

  // ----- Categories -----
  r.get('/api/categories', () => s.categories.list());
  r.post('/api/categories', ({ body }) => created(s.categories.create(body)));
  r.put('/api/categories/reorder', ({ body }) => s.categories.reorder(body));
  r.post('/api/categories/reset', () => s.categories.reset());
  r.put('/api/categories/:id', ({ params, body }) => s.categories.update(params.id, body));
  r.delete('/api/categories/:id', ({ params, body }) => s.categories.remove(params.id, body));
  r.post('/api/categories/:id/subcategories', ({ params, body }) => created(s.categories.addSubcategory(params.id, body)));
  r.put('/api/categories/:id/subcategories/reorder', ({ params, body }) => s.categories.reorderSubcategories(params.id, body));
  r.put('/api/categories/:id/subcategories/:subId', ({ params, body }) => s.categories.updateSubcategory(params.id, params.subId, body));
  r.delete('/api/categories/:id/subcategories/:subId', ({ params, body }) => s.categories.removeSubcategory(params.id, params.subId, body));

  // ----- Payees -----
  r.get('/api/payees', () => s.payees.list());
  r.get('/api/payees/last-category', ({ query }) => s.payees.lastCategory(query.get('name') || ''));
  r.get('/api/payees/last-category/:name', ({ params }) => s.payees.lastCategory(params.name));
  r.post('/api/payees', ({ body }) => created(s.payees.create(body)));
  r.put('/api/payees/:id', ({ params, body }) => s.payees.rename(params.id, body));
  r.delete('/api/payees/:id', ({ params, body }) => s.payees.remove(params.id, body));

  // ----- Recurring -----
  r.get('/api/recurring', () => s.recurring.list());
  r.get('/api/recurring/suggestions', () => s.suggestions.list());
  r.post('/api/recurring/suggestions/dismiss', ({ body }) => s.suggestions.dismiss(body));
  r.delete('/api/recurring/suggestions/dismissed', () => s.suggestions.resetDismissed());
  r.post('/api/recurring', ({ body }) => created(s.recurring.create(body)));
  r.put('/api/recurring/:id', ({ params, body }) => s.recurring.update(params.id, body));
  r.delete('/api/recurring/:id', ({ params }) => s.recurring.remove(params.id));
  r.post('/api/recurring/:id/restore', ({ params }) => s.recurring.restore(params.id));
  r.post('/api/recurring/:id/approve', ({ params, body }) => s.recurring.approve(params.id, body));
  r.post('/api/recurring/:id/skip', ({ params, body }) => s.recurring.skip(params.id, body));

  // ----- Dashboard -----
  r.get('/api/dashboard/summary', () => s.dashboard.summary());
  r.get('/api/dashboard/trend', () => s.dashboard.trend());
  r.get('/api/dashboard/series', ({ query }) => s.dashboard.series({
    accountIds: ids(query.get('accounts')),
    range: query.get('range') || '1m',
    forecastRange: query.get('forecast') || '0'
  }));
  r.get('/api/dashboard/flows', ({ query }) => {
    const from = query.get('from');
    const to = query.get('to');
    if (!isISODate(from) || !isISODate(to)) throw badRequest('from and to must be dates');
    return s.dashboard.flows({ from, to });
  });

  // ----- Backups & data -----
  r.get('/api/backup', () => file(s.backups.zip(), {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="brisk-budget-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip"`,
    'Cache-Control': 'no-store'
  }));
  r.post('/api/backup/restore', ({ raw }) => s.backups.restore(raw), { raw: true, limit: 300 * MB });
  r.get('/api/backups', () => s.backups.list());
  r.post('/api/backups', () => created(s.backups.create('manual')));
  r.get('/api/backups/:name', ({ params }) => file(s.backups.read(params.name), {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${params.name}"`,
    'Cache-Control': 'no-store'
  }));
  r.post('/api/backups/:name/restore', ({ params }) => s.backups.restoreSaved(params.name));
  r.delete('/api/backups/:name', ({ params }) => s.backups.remove(params.name));
  r.get('/api/data-check', () => s.integrity.scan());
  r.post('/api/data-check/fix', ({ body }) => s.integrity.fix(body));

  return r;
}
