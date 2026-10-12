import http from 'node:http';
import { APP_VERSION, PUBLIC_DIR, loadConfig } from './config.js';
import { clock } from './lib/clock.js';
import { createLogger } from './lib/log.js';
import { newId } from './lib/ids.js';
import { forbidden, notFound, unauthorized, HttpError } from './lib/errors.js';
import { Store } from './store/store.js';
import { defaultCategories, DEFAULT_SETTINGS } from './store/defaults.js';
import { migrate, schemaVersionOf, SCHEMA_VERSION, NewerDataError } from './store/migrations/index.js';
import { sanitizeData } from './store/sanitize.js';
import { readBody, readJSON, send, sendError, sendJSON } from './http/respond.js';
import { createStatic } from './http/static.js';
import { createHostCheck, fromLocalProxy, hostName, refusedMessage } from './http/hosts.js';
import { buildRoutes } from './routes.js';
import { createAccounts } from './services/accounts.js';
import { createCategories } from './services/categories.js';
import { createPayees } from './services/payees.js';
import { createTransactions } from './services/transactions.js';
import { createRecurring } from './services/recurring.js';
import { createSuggestions } from './services/suggestions.js';
import { createMortgage } from './services/mortgage.js';
import { createDashboard } from './services/dashboard.js';
import { createBackups, zipFromData } from './services/backups.js';
import { createIntegrity } from './services/integrity.js';
import { createAuth } from './services/auth.js';
import { createUpdates } from './services/updates.js';
import { createHousekeeping } from './services/housekeeping.js';
import { createSettings, createNotices } from './services/settings.js';

const JSON_LIMIT = 4 * 1024 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function freshData() {
  return {
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, history: [], notices: [] },
    settings: { ...DEFAULT_SETTINGS },
    accounts: [],
    groups: [],
    categories: defaultCategories(),
    payees: [],
    recurring: [],
    dismissed: [],
    transactions: {},
    icons: {},
    auth: null
  };
}

// Build the whole app. Tests call this with their own folders; server/index.js uses the defaults.
export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const log = overrides.log || createLogger({ quiet: config.quiet });
  const app = { config, log, clock, services: {} };

  const backupsForRecovery = { findFile: () => null };
  const store = new Store({ dataDir: config.dataDir, log, recoverFile: (rel, schema) => backupsForRecovery.findFile(rel, schema) });
  app.store = store;

  const services = app.services;
  services.categories = createCategories(app);
  services.payees = createPayees(app);
  services.accounts = createAccounts(app);
  services.transactions = createTransactions(app);
  services.recurring = createRecurring(app);
  services.suggestions = createSuggestions(app);
  services.mortgage = createMortgage(app);
  services.dashboard = createDashboard(app);
  services.backups = createBackups(app);
  services.integrity = createIntegrity(app);
  services.auth = createAuth(app);
  services.updates = createUpdates(app);
  services.housekeeping = createHousekeeping(app);
  app.settings = createSettings(app);
  app.notices = createNotices(app);
  backupsForRecovery.findFile = (rel, schema) => services.backups.findFile(rel, schema);

  // ----- Load data, upgrading anything written by an older version -----
  if (store.isFresh()) {
    store.load();
    store.writeAll({ ...freshData(), auth: store.data.auth });
    log.info('Started with a fresh data folder');
  } else {
    store.load();
    const from = schemaVersionOf(store.data);
    if (from > SCHEMA_VERSION) {
      throw new NewerDataError(`The data folder was written by a newer version of Brisk Budget (data format ${from}, this version understands ${SCHEMA_VERSION}). Update Brisk Budget or restore an older backup.`);
    }
    if (from < SCHEMA_VERSION) {
      const previous = store.data.meta?.appVersion || 'v0.1.x';
      const safety = services.backups.createFromDisk(`pre-upgrade-${previous}`);
      const result = migrate(store.data, { appVersion: APP_VERSION, today: clock.today(), nowIso: clock.now().toISOString(), newId });
      sanitizeData(store.data, { today: clock.today(), nowIso: clock.now().toISOString() });
      store.writeAll();
      log.info(`Upgraded data from format ${from} to ${SCHEMA_VERSION} (${result.applied.join('; ')}). Backup first: ${safety}`);
      for (const note of result.notes) log.info(`  ${note}`);
      app.notices.add(`Brisk Budget was updated to v${APP_VERSION}. Your data was upgraded automatically, and a backup of the previous version was saved first (${safety}).`, 'upgrade');
    } else {
      const repaired = sanitizeData(store.data, { today: clock.today(), nowIso: clock.now().toISOString() });
      if (repaired) {
        const safety = services.backups.createFromDisk('pre-repair');
        store.writeAll();
        log.warn(`Repaired ${repaired} problem${repaired === 1 ? '' : 's'} in the data files (backup first: ${safety})`);
      }
      if (store.data.meta.appVersion !== APP_VERSION) {
        const previous = store.data.meta.appVersion;
        store.data.meta.appVersion = APP_VERSION;
        store.save('meta');
        if (previous) app.notices.add(`Brisk Budget was updated from v${previous} to v${APP_VERSION}.`, 'upgrade');
      }
    }
  }
  for (const q of store.quarantined) {
    const name = store.data.accounts.find(a => a.id === q.accountId)?.name || 'an account';
    app.notices.add(`The transactions for ${name} couldn't be read and no backup had a copy, so that account starts empty. The damaged file was kept as transactions/${q.aside} in the data folder.`, 'warning');
  }
  for (const r of store.recovered) {
    app.notices.add(`The data file ${r.file} was damaged, so it was recovered from the backup ${r.source}. Recent changes to it may be missing.`, 'warning');
  }
  services.housekeeping.run();

  const routes = buildRoutes(app);
  const statics = createStatic({ publicDir: PUBLIC_DIR, dev: config.dev, version: APP_VERSION });
  const hostAllowed = createHostCheck({ allowedHosts: config.allowedHosts });
  const refusedHosts = new Set();

  function refuseHost(req, res, url) {
    const message = refusedMessage(req.headers.host);
    const name = hostName(req.headers.host);
    if (!refusedHosts.has(name) && refusedHosts.size < 50) {
      refusedHosts.add(name);
      log.warn(`Refused requests for the unrecognised address "${name}". Set a password or add it to BRISK_ALLOWED_HOSTS if it's yours.`);
    }
    if (url.pathname.startsWith('/api/')) sendJSON(req, res, 403, { error: message });
    else send(req, res, 403, message, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (!req.complete) req.resume();
  }

  async function handleApi(req, res, url) {
    res.setHeader('X-Brisk-Version', APP_VERSION);
    // Changes with every update, even one that keeps the version number, so open tabs know to reload
    res.setHeader('X-Brisk-Build', statics.fingerprint());
    const match = routes.match(req.method, url.pathname);
    if (!match) throw notFound('No such API endpoint');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = match;
    // A custom header can't be sent by another website without permission, which stops pages
    // elsewhere on the internet from changing data behind your back.
    if (MUTATING.has(req.method) && req.headers['x-brisk-request'] !== '1') throw forbidden('Missing request header');
    if (!route.options.public && !services.auth.isAuthenticated(req)) throw unauthorized();

    const limit = route.options.limit || JSON_LIMIT;
    let body = {};
    let raw = null;
    if (MUTATING.has(req.method)) {
      if (route.options.raw) raw = await readBody(req, limit);
      else body = (await readJSON(req, limit)) ?? {};
    }
    const result = await route.handler({ req, res, params, query: url.searchParams, body, raw });
    if (result && result.__file) {
      send(req, res, 200, result.buffer, result.headers);
    } else if (result && result.__reply) {
      sendJSON(req, res, result.status, result.data, result.headers);
    } else {
      sendJSON(req, res, 200, result ?? { success: true });
    }
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      send(req, res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
      return;
    }
    if (!services.auth.enabled() && !hostAllowed(req.headers.host) && !fromLocalProxy(req)) {
      refuseHost(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url);
      } catch (err) {
        if (!res.headersSent) sendError(req, res, err, log);
        else res.end();
        if (!req.complete) req.resume();
      }
      return;
    }
    try {
      statics.serve(req, res, url);
    } catch (err) {
      log.error('Static file error:', err.message);
      if (!res.headersSent) send(req, res, 500, 'Server error', { 'Content-Type': 'text/plain' });
    }
  }

  const server = http.createServer(handler);
  server.keepAliveTimeout = 30000;

  app.server = server;
  app.listen = (port = config.port, host = config.host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      if (config.autoBackup) services.backups.startSchedule();
      services.updates.start();
      services.housekeeping.start();
      resolve(server.address());
    });
  });
  app.close = () => new Promise(resolve => {
    services.backups.stop();
    services.updates.stop();
    services.housekeeping.stop();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  app.zip = () => zipFromData(store.data);
  return app;
}
