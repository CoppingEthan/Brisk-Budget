// Shared test helpers: temp folders, starting the app on a random port and a small HTTP
// client. This file must never register tests (node --test also runs files under test/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../../server/app.js';
import { clock } from '../../server/lib/clock.js';

export const TODAY = '2026-10-12';
export const NOW = `${TODAY}T12:00:00Z`;

// A fresh temp root with data/ and backups/ inside (neither created yet)
export function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brisk-'));
  return { root, dataDir: path.join(root, 'data'), backupsDir: path.join(root, 'backups') };
}

export function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* Windows can hold a handle briefly; the OS temp folder gets cleaned anyway */ }
}

// Logger that keeps quiet but remembers errors, so tests can assert "no server errors"
export function createTestLog() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    info() {},
    warn: (...args) => { warnings.push(args.join(' ')); },
    error: (...args) => { errors.push(args.join(' ')); }
  };
}

// Raw HTTP request (no URL normalisation, no automatic decompression)
export function rawRequest(port, { method = 'GET', path: urlPath = '/', headers = {}, body, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    let response = null;
    const chunks = [];
    const finish = () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), uploadInterrupted: !!response.uploadInterrupted });
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent }, res => {
      response = res;
      res.on('data', c => chunks.push(c));
      res.on('end', finish);
      res.on('error', err => (response ? finish() : reject(err)));
    });
    // A server may answer (e.g. 413) and close before a large upload finishes. Like a browser,
    // keep the answer that already arrived instead of reporting only the broken upload.
    req.on('error', err => {
      if (response) {
        response.uploadInterrupted = true;
        if (response.complete) finish();
        else response.once('close', finish);
      } else reject(err);
    });
    if (body !== undefined && body !== null) req.end(body);
    else req.end();
  });
}

export function createClient(port) {
  const state = { cookie: null };

  async function request(method, urlPath, body, { headers = {}, csrf = true, cookie, contentType } = {}) {
    const h = { ...headers };
    if (csrf && method !== 'GET' && method !== 'HEAD' && h['X-Brisk-Request'] === undefined) h['X-Brisk-Request'] = '1';
    let payload;
    if (Buffer.isBuffer(body)) {
      payload = body;
      h['Content-Type'] = contentType || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      h['Content-Type'] = contentType || 'application/json';
    }
    if (payload) h['Content-Length'] = payload.length;
    const useCookie = cookie === undefined ? state.cookie : cookie;
    if (useCookie) h.Cookie = useCookie;
    const res = await rawRequest(port, { method, path: urlPath, headers: h, body: payload });
    let data = null;
    if (String(res.headers['content-type'] || '').includes('application/json') && res.body.length) {
      data = JSON.parse(res.body.toString('utf8'));
    }
    return { status: res.status, headers: res.headers, data, body: res.body };
  }

  const client = {
    port,
    state,
    request,
    get: (p, opts) => request('GET', p, undefined, opts),
    post: (p, body, opts) => request('POST', p, body, opts),
    put: (p, body, opts) => request('PUT', p, body, opts),
    del: (p, body, opts) => request('DELETE', p, body, opts),
    raw: (opts) => rawRequest(port, opts)
  };

  // The same calls, but asserting a 2xx answer and returning the JSON body
  const must = (method) => async (p, body, opts) => {
    const res = await request(method, p, body, opts);
    if (res.status < 200 || res.status > 299) {
      throw new Error(`${method} ${p} -> ${res.status}: ${res.body.toString('utf8').slice(0, 500)}`);
    }
    return res.data;
  };
  client.ok = {
    get: (p, opts) => must('GET')(p, undefined, opts),
    post: must('POST'),
    put: must('PUT'),
    del: must('DELETE')
  };
  return client;
}

// Start the whole app against the given folders with the clock pinned. Returns the client
// plus the app and folders; call close() when done.
export async function startServer({ dataDir, backupsDir, now = NOW, log, ...overrides } = {}) {
  if (now !== null) clock.set(now);
  const testLog = log || createTestLog();
  const app = createApp({ dataDir, backupsDir, autoBackup: false, updateCheck: false, quiet: true, dev: false, log: testLog, ...overrides });
  const addr = await app.listen(0, '127.0.0.1');
  const client = createClient(addr.port);
  let closed = false;
  return {
    ...client,
    app,
    log: testLog,
    dataDir,
    backupsDir,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
    }
  };
}

// Temp folders + a running server, for the common "fresh install" case
export async function freshServer(options = {}) {
  const dirs = makeTempRoot();
  const server = await startServer({ ...dirs, ...options });
  return {
    ...server,
    root: dirs.root,
    async close() {
      await server.close();
      clock.set(null);
      removeDir(dirs.root);
    },
    async stop() {
      await server.close();
    }
  };
}

export function readJSON(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function listBackups(backupsDir, prefix = '') {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter(n => n.endsWith('.zip') && n.startsWith(prefix)).sort();
}

// ----- Small builders for API tests -----

export async function makeAccount(server, fields = {}) {
  return server.ok.post('/api/accounts', { name: 'Current', type: 'bank', startingBalance: 0, ...fields });
}

export async function makeTx(server, accountId, fields = {}) {
  return server.ok.post(`/api/accounts/${accountId}/transactions`, {
    date: '2026-10-01', amount: -10, payee: 'Shop', categoryId: 'sub-groceries', ...fields
  });
}

export async function balanceOf(server, accountId) {
  const all = await server.ok.get('/api/accounts?all=1');
  const account = all.find(a => a.id === accountId);
  if (!account) throw new Error(`No account ${accountId}`);
  return account.balance;
}

export async function txsOf(server, accountId) {
  return server.ok.get(`/api/accounts/${accountId}/transactions`);
}

// Pence-exact sum, so expectations don't suffer from float error
export function sumPence(values) {
  return values.reduce((s, v) => s + Math.round(Number(v) * 100), 0);
}
