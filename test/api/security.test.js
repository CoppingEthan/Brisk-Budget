// Hostile or broken requests: the server answers with a clean 4xx and keeps working.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { SCHEMA_VERSION } from '../../server/store/migrations/index.js';
import { freshServer, makeAccount, makeTx, txsOf } from '../helpers/server.js';
import { buildStoreZip, crc32 } from '../helpers/zip.js';

describe('request handling', () => {
  let s;
  let acc;
  before(async () => {
    s = await freshServer();
    acc = await makeAccount(s, { name: 'Current' });
  });
  after(async () => { await s.close(); });

  it('malformed JSON is a 400 and the server keeps answering', async () => {
    for (const body of ['{"name": ', '{name: "x"}', '\u0000\u0001', '{"a":1}}']) {
      const res = await s.post('/api/accounts', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.data.error, /not valid JSON/);
    }
    assert.equal((await s.get('/api/health')).status, 200);
    assert.equal((await s.post('/api/accounts', { name: 'Still works' })).status, 201);
  });

  it('JSON that is not an object never causes a server error', async () => {
    const cat = await s.ok.post('/api/categories', { name: 'Null body target' });
    const payee = await s.ok.post('/api/payees', { name: 'Null body payee' });
    const tx = await makeTx(s, acc.id);
    const attempts = [
      ['PUT', '/api/settings'], ['POST', '/api/accounts'], ['PUT', `/api/accounts/${acc.id}`],
      ['POST', `/api/accounts/${acc.id}/transactions`], ['PUT', `/api/accounts/${acc.id}/transactions/${tx.id}`],
      ['DELETE', `/api/categories/${cat.id}`], ['DELETE', `/api/payees/${payee.id}`], ['POST', '/api/recurring'],
      ['POST', '/api/transfers'], ['POST', '/api/data-check/fix'], ['POST', '/api/transactions/restore'],
      ['POST', '/api/notices/dismiss'], ['PUT', '/api/accounts/reorder'], ['PUT', '/api/categories/reorder']
    ];
    const failures = [];
    for (const [method, url] of attempts) {
      for (const body of ['null', '[]', '"text"', '42']) {
        const res = await s.request(method, url, body);
        if (res.status >= 500) failures.push(`${method} ${url} with ${body} -> ${res.status}`);
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(s.log.errors, [], 'no unexpected server errors were logged');
  });

  it('changes need the X-Brisk-Request header (blocks cross-site form posts)', async () => {
    const attempts = [
      ['POST', '/api/accounts', { name: 'CSRF' }],
      ['PUT', `/api/accounts/${acc.id}`, { name: 'CSRF' }],
      ['DELETE', `/api/accounts/${acc.id}`, undefined],
      ['POST', '/api/backup/restore', Buffer.from('zip')],
      ['POST', '/api/auth/login', { password: 'x' }]
    ];
    for (const [method, url, body] of attempts) {
      assert.equal((await s.request(method, url, body, { csrf: false })).status, 403, `${method} ${url} without header`);
      assert.equal((await s.request(method, url, body, { headers: { 'X-Brisk-Request': '0' } })).status, 403, `${method} ${url} with wrong header`);
    }
    // A form post with a urlencoded body is refused as well
    const form = await s.request('POST', '/api/accounts', 'name=CSRF', { csrf: false, contentType: 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 403);
    assert.equal((await s.ok.get('/api/accounts')).some(a => a.name === 'CSRF'), false);
    assert.equal((await s.get('/api/accounts', { csrf: false })).status, 200, 'reading needs no header');
  });

  it('bodies over the limit are refused with 413 and the server keeps answering', async () => {
    // Browsers keep connections alive, so test the way they send uploads
    const agent = new http.Agent({ keepAlive: true });
    const errorsBefore = s.log.errors.length;
    try {
      const big = Buffer.alloc(5 * 1024 * 1024, 0x20);
      const declared = await s.raw({
        method: 'POST', path: '/api/accounts', body: big, agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': big.length, 'X-Brisk-Request': '1' }
      });
      assert.equal(declared.status, 413);
      assert.match(JSON.parse(declared.body.toString()).error, /too large/);
      const chunked = await s.raw({
        method: 'POST', path: '/api/accounts', body: big, agent,
        headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', 'X-Brisk-Request': '1' }
      });
      assert.equal(chunked.status, 413);
      const viaFetch = await fetch(`http://127.0.0.1:${s.port}/api/accounts`, {
        method: 'POST', body: big, headers: { 'Content-Type': 'application/json', 'X-Brisk-Request': '1' }
      });
      assert.equal(viaFetch.status, 413);
      await viaFetch.arrayBuffer();
      // Bigger limits apply where large uploads are expected (import: 25 MB)
      const rows = JSON.stringify({ rows: Array.from({ length: 20001 }, () => ({ date: '2026-10-01', amount: -1, payee: 'x'.repeat(200) })) });
      assert.ok(rows.length > 4 * 1024 * 1024);
      const importRes = await s.post(`/api/accounts/${acc.id}/transactions/import/preview`, rows);
      assert.equal(importRes.status, 400, 'read in full and rejected for the row count, not the size');
      assert.equal((await s.get('/api/health')).status, 200);
      assert.deepEqual(s.log.errors.slice(errorsBefore), []);
    } finally {
      agent.destroy();
    }
  });

  it('unknown API paths are JSON 404s and wrong methods are 405s', async () => {
    const res = await s.get('/api/nope');
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.ok(res.data.error);
    assert.equal((await s.post('/api/accounts/does/not/exist', {})).status, 404);
    const wrong = await s.request('PATCH', '/api/accounts', {});
    assert.equal(wrong.status, 405);
    assert.equal((await s.get('/api/accounts/reorder')).status, 405);
    assert.equal((await s.get(`/api/accounts/${encodeURIComponent('%E0%A4%A')}/ledger`)).status, 404);
  });

  it('API responses carry security headers and are never cached', async () => {
    const res = await s.get('/api/accounts');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('large API responses are compressed when the browser accepts it', async () => {
    const res = await s.raw({ path: '/api/categories', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers.vary, 'Accept-Encoding');
    assert.ok(Array.isArray(JSON.parse(zlib.gunzipSync(res.body).toString('utf8'))));
    const small = await s.raw({ path: '/api/health', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(small.headers['content-encoding'], undefined, 'tiny responses are sent as they are');
  });
});

describe('backup restore cannot write outside the data folder (zip slip)', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('the hand-made ZIP writer produces valid CRCs', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('ignores entries that climb out of the folder, and writes nothing outside it', async () => {
    const before = await makeAccount(s, { name: 'Before restore' });
    await s.ok.post('/api/backups'); // the backups folder exists from here on
    const rootBefore = fs.readdirSync(s.root).sort();
    const parentBefore = fs.readdirSync(path.dirname(s.root)).filter(n => /^(escaped|x|evil|abs|icon-escape)/.test(n));
    const zip = buildStoreZip([
      { name: 'meta.json', data: { schemaVersion: SCHEMA_VERSION, appVersion: '0.4.0', history: [] } },
      { name: 'accounts.json', data: [{ id: 'safe1', name: 'Restored', type: 'bank', startingBalance: 1, active: true, icon: { file: '../../../evil.png', hash: 'x' } }] },
      { name: 'transactions/safe1.json', data: [] },
      { name: '../escaped.json', data: { pwned: true } },
      { name: 'transactions/../../x.json', data: [] },
      { name: '..\\evil.json', data: [] },
      { name: '/abs.json', data: [] },
      { name: 'icons/../../icon-escape.png', data: Buffer.from('x') },
      { name: 'transactions/../accounts.json', data: [{ id: 'sneaky', name: 'Sneaky' }] },
      { name: 'transactions/..json', data: [] }
    ]);
    const res = await s.post('/api/backup/restore', zip, { contentType: 'application/zip' });
    assert.ok(res.status === 200 || res.status === 400, `restore answered ${res.status}`);
    if (res.status === 200) {
      assert.equal(res.data.ignored.length, 7);
      const accounts = await s.ok.get('/api/accounts');
      assert.deepEqual(accounts.map(a => a.name), ['Restored']);
      assert.equal(accounts[0].icon, null, 'icon pointing outside the icons folder is dropped');
    } else {
      assert.ok((await s.ok.get('/api/accounts')).some(a => a.id === before.id));
    }
    assert.deepEqual(fs.readdirSync(s.root).sort(), rootBefore, 'nothing new next to the data folder');
    assert.deepEqual(
      fs.readdirSync(path.dirname(s.root)).filter(n => /^(escaped|x|evil|abs|icon-escape)/.test(n)),
      parentBefore,
      'nothing new in the temp folder above'
    );
    const dataFiles = fs.readdirSync(s.dataDir).filter(n => !n.startsWith('.'));
    for (const name of dataFiles) {
      assert.ok(/^(meta|settings|accounts|account-groups|categories|payees|recurring|dismissed)\.json$|^(transactions|icons)$/.test(name), `unexpected file ${name} in the data folder`);
    }
    assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'transactions')).sort(), res.status === 200 ? ['safe1.json'] : [`${before.id}.json`]);
  });
});

describe('restore of a backup whose accounts point at odd ids', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('drops accounts with unsafe ids instead of using them as file names', async () => {
    const zip = buildStoreZip([
      { name: 'meta.json', data: { schemaVersion: SCHEMA_VERSION, appVersion: '0.4.0', history: [] } },
      { name: 'accounts.json', data: [{ id: '../../../pwn', name: 'Evil', type: 'bank' }, { id: 'goodid', name: 'Good', type: 'bank', startingBalance: 0, active: true }] }
    ]);
    const res = await s.ok.post('/api/backup/restore', zip, { contentType: 'application/zip' });
    assert.equal(res.accounts, 1);
    assert.deepEqual((await s.ok.get('/api/accounts')).map(a => a.name), ['Good']);
    assert.deepEqual(await txsOf(s, 'goodid'), []);
    assert.equal(fs.existsSync(path.join(s.root, 'pwn.json')), false);
  });
});
