// Fixes from the v0.4.4 security audit: each test is an attack that used to work.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { freshServer, makeAccount, rawRequest } from '../helpers/server.js';
import { buildStoreZip } from '../helpers/zip.js';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

function agentClient(s, key) {
  return async (method, urlPath, body, extraHeaders = {}) => {
    const headers = { Authorization: `Bearer ${key}`, ...extraHeaders };
    let payload;
    if (Buffer.isBuffer(body)) {
      payload = body;
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
    }
    const res = await rawRequest(s.app.server.address().port, { method, path: urlPath, headers, body: payload });
    const text = res.body.toString('utf8');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
}

describe('security audit: AI agent access', () => {
  let s;
  let agent;
  let reader;
  before(async () => {
    s = await freshServer();
    await s.ok.put('/api/agents', { enabled: true });
    agent = agentClient(s, (await s.ok.post('/api/agents/keys', { name: 'Full', access: 'full' })).key);
    reader = agentClient(s, (await s.ok.post('/api/agents/keys', { name: 'Reader', access: 'read' })).key);
    await makeAccount(s, { name: 'Current', startingBalance: 100 });
  });
  after(async () => { await s.close(); });

  it("treats a reverse proxy's Basic sign-in as the person's browser, not as a bad agent key", async () => {
    const res = await s.get('/api/bootstrap', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });
    assert.equal(res.status, 200);
  });

  it('caps MCP batches and answers them one at a time', async () => {
    const tooMany = await reader('POST', '/mcp', Array.from({ length: 21 }, (_, i) => rpc(i + 1, 'tools/list')));
    assert.equal(tooMany.status, 200);
    assert.equal(tooMany.data.error.code, -32600);
    const fine = await reader('POST', '/mcp', Array.from({ length: 20 }, (_, i) => rpc(i + 1, 'tools/list')));
    assert.equal(fine.data.length, 20);
  });

  it('copes with null params', async () => {
    const res = await reader('POST', '/mcp', rpc(1, 'tools/call', null));
    assert.notEqual(res.status, 500);
  });

  it('checks arguments that have a fixed set of choices, and keeps log entries short', async () => {
    const bad = await agent('POST', '/api/agent/tools/api_request', { method: 'BREW', path: '/api/accounts' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /method must be one of/);
    await agent('POST', '/api/agent/tools/api_request', { method: 'post', path: `/api/${'x'.repeat(100000)}` });
    const { activity } = await s.ok.get('/api/agents');
    assert.ok(activity.every(a => a.action.length <= 200), 'actions are cut short');
  });

  it("can't push its changes out of the activity log with failed attempts", async () => {
    await agent('POST', '/api/agent/tools/create_category', { name: 'Logged change' });
    for (let batch = 0; batch < 4; batch++) {
      await agent('POST', '/mcp', Array.from({ length: 20 }, (_, i) => rpc(i + 1, 'tools/call', { name: 'delete_transactions', arguments: { accountId: 'nope', transactionIds: ['x'] } })));
    }
    const { activity } = await s.ok.get('/api/agents');
    assert.ok(activity.some(a => a.ok && a.action === 'create_category'), 'the change is still shown');
  });

  it("can't delete backups or upload one to restore, but can still restore a saved one", async () => {
    const saved = await s.ok.post('/api/backups');
    const name = saved.name || saved.backup?.name;
    assert.ok(name, JSON.stringify(saved));
    assert.equal((await agent('DELETE', `/api/backups/${name}`)).status, 403);
    const viaTool = await agent('POST', '/api/agent/tools/api_request', { method: 'DELETE', path: `/api/backups/${name}` });
    assert.equal(viaTool.status, 403);
    const zip = (await s.get('/api/backup')).body;
    assert.equal((await agent('POST', '/api/backup/restore', zip, { 'Content-Type': 'application/zip' })).status, 403);
    const listed = await s.ok.get('/api/backups');
    const names = (Array.isArray(listed) ? listed : listed.backups).map(b => b.name);
    assert.ok(names.includes(name), 'the backup is still there');
  });
});

describe('security audit: restoring hostile backups', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  const restore = (zip) => s.post('/api/backup/restore', zip, { contentType: 'application/zip' });
  const accounts = { name: 'accounts.json', data: [] };

  it('refuses names thousands of folders deep before reading the file', async () => {
    const res = await restore(buildStoreZip([accounts, { name: `${'a/'.repeat(100)}x.json`, data: {} }]));
    assert.equal(res.status, 400);
  });

  it('refuses a backup with an enormous number of files', async () => {
    const entries = [accounts, ...Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.txt`, data: '' }))];
    const res = await restore(buildStoreZip(entries));
    assert.equal(res.status, 400);
    assert.match(res.data.error, /too many files/);
  });

  it('refuses JSON built to use up memory, and a file that unpacks thousands of times over', async () => {
    const zip = new AdmZip();
    zip.addFile('accounts.json', Buffer.from('[]'));
    zip.addFile('categories.json', Buffer.from(`[${'{},'.repeat(2500000)}{}]`));
    const res = await restore(zip.toBuffer());
    assert.equal(res.status, 400);
  });

  it('says a damaged file is not a valid backup instead of failing on the server', async () => {
    for (const body of [Buffer.from('not a zip at all'), buildStoreZip([accounts]).subarray(0, 40), Buffer.alloc(0)]) {
      const res = await restore(body);
      assert.equal(res.status, 400, body.length + ' bytes');
    }
  });

  it('keeps only real colours and safe currency symbols from a backup', async () => {
    const backup = (await s.get('/api/backup')).body;
    const zip = new AdmZip(backup);
    const categories = JSON.parse(zip.readAsText('categories.json'));
    categories[0].color = 'red;background:url(/x)';
    zip.updateFile('categories.json', Buffer.from(JSON.stringify(categories)));
    const settings = JSON.parse(zip.readAsText('settings.json'));
    settings.currencySymbol = '<b>';
    zip.updateFile('settings.json', Buffer.from(JSON.stringify(settings)));
    assert.equal((await restore(zip.toBuffer())).status, 200);
    const boot = await s.ok.get('/api/bootstrap');
    const restored = boot.categories.find(c => c.id === categories[0].id);
    assert.match(restored.color, /^#[0-9a-f]{6}$/i);
    assert.equal(boot.settings.currencySymbol, '£');
  });
});

describe('security audit: static files', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it("serves the app's files only by their exact names", async () => {
    assert.equal((await s.get('/index.html')).status, 200);
    for (const p of ['/INDEX.HTML', '/Index.html', '/JS/app.js']) assert.equal((await s.get(p)).status, 404, p);
  });
});
