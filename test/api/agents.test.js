// AI agent access: access keys, the agent API (/api/agent) and MCP (/mcp) offering the same tools.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { freshServer, startServer, makeAccount, makeTx, txsOf, rawRequest, createTestLog } from '../helpers/server.js';
import { TOOLS } from '../../server/agent/tools.js';
import { buildRoutes } from '../../server/routes.js';

// Requests with an access key (and no app header or cookie, as an agent would send)
function agentClient(s, key) {
  return async (method, urlPath, body) => {
    const headers = { Authorization: `Bearer ${key}` };
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
    }
    const res = await rawRequest(s.app.server.address().port, { method, path: urlPath, headers, body: payload });
    const text = res.body.toString('utf8');
    return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('AI agent access', () => {
  let s;
  let full;
  let read;
  let agent;
  let reader;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('is off by default: a key is refused and nothing about keys is on disk', async () => {
    const res = await agentClient(s, 'bb_anything')('GET', '/api/accounts');
    assert.equal(res.status, 403);
    assert.match(res.data.error, /turned off/);
    assert.equal((await s.ok.get('/api/agents')).enabled, false);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'agents.json')), false);
  });

  it('a person turns it on and creates keys; only a hash is kept', async () => {
    await s.ok.put('/api/agents', { enabled: true });
    full = await s.ok.post('/api/agents/keys', { name: 'Claude', access: 'full' });
    read = await s.ok.post('/api/agents/keys', { name: 'Reader', access: 'read' });
    assert.match(full.key, /^bb_[A-Za-z0-9_-]{40,}$/);
    agent = agentClient(s, full.key);
    reader = agentClient(s, read.key);
    const status = await s.ok.get('/api/agents');
    assert.deepEqual(status.keys.map(k => k.name), ['Claude', 'Reader']);
    assert.equal(JSON.stringify(status).includes(full.key), false);
    assert.equal(fs.readFileSync(path.join(s.dataDir, 'agents.json'), 'utf8').includes(full.key), false);
    assert.equal((await s.post('/api/agents/keys', { name: 'x', access: 'admin' })).status, 400);
  });

  it('a key works on the plain API without the app header; wrong keys are refused', async () => {
    assert.equal((await agent('GET', '/api/accounts')).status, 200);
    assert.equal((await agent('POST', '/api/payees', { name: 'Made by an agent' })).status, 201);
    const wrong = await agentClient(s, 'bb_wrong')('GET', '/api/accounts');
    assert.equal(wrong.status, 401);
    // A bearer header that isn't a key at all is refused too, never treated as "no key"
    const res = await rawRequest(s.app.server.address().port, { path: '/api/accounts', headers: { Authorization: 'Bearer' } });
    assert.equal(res.status, 401);
  });

  it('read-only keys change nothing; no key can touch the password or AI access', async () => {
    assert.equal((await reader('GET', '/api/accounts')).status, 200);
    assert.equal((await reader('POST', '/api/payees', { name: 'Nope' })).status, 403);
    assert.equal((await reader('POST', '/api/agent/tools/create_account', { name: 'Nope', type: 'bank' })).status, 403);
    assert.equal((await reader('POST', '/api/agent/tools/list_accounts', {})).status, 200);
    for (const [method, p, body] of [
      ['PUT', '/api/auth/password', { newPassword: 'agent takes over' }],
      ['GET', '/api/agents'],
      ['PUT', '/api/agents', { enabled: false }],
      ['POST', '/api/agents/keys', { name: 'escalate' }],
      ['DELETE', `/api/agents/keys/${read.id}`]
    ]) {
      assert.equal((await agent(method, p, body)).status, 403, `${method} ${p}`);
    }
    // Nor through the api_request tool
    const via = await agent('POST', '/api/agent/tools/api_request', { method: 'PUT', path: '/api/agents', body: { enabled: false } });
    assert.equal(via.status, 403);
    assert.equal((await s.ok.get('/api/agents')).enabled, true);
  });

  it('with a password set, a key still works and the password is still needed without one', async () => {
    await s.ok.put('/api/auth/password', { newPassword: 'household secret' });
    assert.equal((await agent('GET', '/api/accounts')).status, 200);
    assert.equal((await s.get('/api/accounts', { cookie: null })).status, 401);
    const session = (await s.post('/api/auth/login', { password: 'household secret' }, { cookie: null })).headers['set-cookie'];
    const cookie = [].concat(session)[0].split(';')[0];
    await s.ok.del('/api/auth/password', { currentPassword: 'household secret' }, { cookie });
  });

  it('a key is accepted from any address, while the app itself still refuses unknown ones', async () => {
    const port = s.app.server.address().port;
    const withKey = await rawRequest(port, { path: '/api/accounts', headers: { Host: 'budget.example.com', Authorization: `Bearer ${full.key}` } });
    assert.equal(withKey.status, 200);
    const without = await rawRequest(port, { path: '/api/accounts', headers: { Host: 'budget.example.com' } });
    assert.equal(without.status, 403);
  });

  it('MCP: initialize, notifications, tools/list and tools/call', async () => {
    const init = await agent('POST', '/mcp', rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    assert.equal(init.status, 200);
    assert.equal(init.data.result.protocolVersion, '2025-06-18');
    assert.equal(init.data.result.serverInfo.name, 'brisk-budget');
    assert.ok(init.data.result.capabilities.tools);
    const older = await agent('POST', '/mcp', rpc(1, 'initialize', { protocolVersion: '1999-01-01' }));
    assert.equal(older.data.result.protocolVersion, '2025-06-18', 'unknown versions get the newest we speak');

    assert.equal((await agent('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.deepEqual((await agent('POST', '/mcp', rpc(2, 'ping'))).data.result, {});

    const list = (await agent('POST', '/mcp', rpc(3, 'tools/list'))).data.result.tools;
    assert.equal(list.length, TOOLS.length);
    for (const tool of list) {
      assert.match(tool.name, /^[a-z_]+$/);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    }
    const readerList = (await reader('POST', '/mcp', rpc(3, 'tools/list'))).data.result.tools;
    assert.ok(readerList.length < list.length && readerList.every(t => t.annotations.readOnlyHint));

    const made = await agent('POST', '/mcp', rpc(4, 'tools/call', { name: 'create_account', arguments: { name: 'MCP Bank', type: 'bank', startingBalance: 250 } }));
    assert.equal(made.data.result.isError, false);
    const account = made.data.result.structuredContent;
    assert.equal(account.name, 'MCP Bank');
    assert.deepEqual(JSON.parse(made.data.result.content[0].text), account);

    const overview = (await agent('POST', '/mcp', rpc(5, 'tools/call', { name: 'get_overview', arguments: {} }))).data.result.structuredContent;
    assert.equal(overview.today, '2026-10-12');
    assert.ok(overview.accounts.some(a => a.id === account.id && a.balance === 250));
  });

  it('MCP: tool errors, unknown tools and methods, batches and the wrong HTTP method', async () => {
    const bad = (await agent('POST', '/mcp', rpc(6, 'tools/call', { name: 'add_transaction', arguments: { accountId: 'nope', date: '2026-10-01', amount: -1, payee: 'x' } }))).data.result;
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /not found/i);
    const unknownArg = (await agent('POST', '/mcp', rpc(7, 'tools/call', { name: 'list_accounts', arguments: { colour: 'blue' } }))).data.result;
    assert.equal(unknownArg.isError, true);
    assert.match(unknownArg.content[0].text, /Unknown argument: colour/);
    assert.equal((await agent('POST', '/mcp', rpc(8, 'tools/call', { name: 'rm_rf' }))).data.error.code, -32602);
    assert.equal((await agent('POST', '/mcp', rpc(9, 'resources/list'))).data.error.code, -32601);
    const batch = (await agent('POST', '/mcp', [rpc(10, 'ping'), { jsonrpc: '2.0', method: 'notifications/cancelled' }, rpc(11, 'ping')])).data;
    assert.deepEqual(batch.map(r => r.id), [10, 11]);
    assert.equal((await agent('GET', '/mcp')).status, 405);
    const noKey = await rawRequest(s.app.server.address().port, { method: 'POST', path: '/mcp', headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(rpc(1, 'ping'))) });
    assert.equal(noKey.status, 401);
  });

  it('the agent API offers the same tools with the same names and results', async () => {
    const catalogue = (await agent('GET', '/api/agent')).data;
    assert.equal(catalogue.mcp, '/mcp');
    assert.deepEqual(catalogue.tools.map(t => t.name), TOOLS.map(t => t.name));

    const acc = await makeAccount(s, { name: 'Statement account' });
    const rows = [{ date: '2026-10-01', amount: -12.5, payee: 'Tesco' }, { date: '2026-10-02', amount: 1500, payee: 'Employer' }];
    const dry = await agent('POST', '/api/agent/tools/import_transactions', { accountId: acc.id, rows, dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.data.rows.length, 2);
    assert.deepEqual(await txsOf(s, acc.id), [], 'a dry run changes nothing');
    const real = await agent('POST', '/mcp', rpc(12, 'tools/call', { name: 'import_transactions', arguments: { accountId: acc.id, rows } }));
    assert.equal(real.data.result.structuredContent.imported, 2);
    const again = await agent('POST', '/api/agent/tools/import_transactions', { accountId: acc.id, rows });
    assert.equal(again.data.skipped, 2, 'importing the same statement twice adds nothing');

    const ledger = (await agent('POST', '/api/agent/tools/list_transactions', { accountId: acc.id })).data;
    assert.equal(ledger.total, 2);
    assert.equal((await agent('POST', '/api/agent/tools/list_accounts', { colour: 'blue' })).status, 400);
    assert.equal((await agent('POST', '/api/agent/tools/no_such_tool', {})).status, 404);

    const undone = await agent('POST', '/api/agent/tools/undo_import', { accountId: acc.id, batch: real.data.result.structuredContent.batch });
    assert.equal(undone.status, 200);
    assert.deepEqual(await txsOf(s, acc.id), []);
  });

  it('api_request reaches any other endpoint', async () => {
    const res = await agent('POST', '/api/agent/tools/api_request', { method: 'GET', path: '/api/dashboard/summary' });
    assert.equal(res.status, 200);
    assert.ok('netWorth' in res.data);
    const endpoints = (await agent('POST', '/api/agent/tools/list_api_endpoints', {})).data.endpoints;
    assert.ok(endpoints.includes('GET /api/accounts'));
    assert.ok(!endpoints.some(e => e.includes('/api/auth/') || e.includes('/api/agents')));
  });

  it('changes are logged; look-ups are not', async () => {
    const activity = (await s.ok.get('/api/agents')).activity;
    const actions = activity.map(a => a.action);
    assert.ok(actions.includes('create_account'));
    assert.ok(actions.includes('import_transactions'));
    assert.ok(actions.includes('POST /api/payees'));
    assert.ok(activity.some(a => a.ok === false && a.action === 'add_transaction'));
    assert.ok(!actions.includes('get_overview') && !actions.includes('list_transactions'));
    assert.ok(!actions.some(a => a.startsWith('api_request GET')));
    assert.equal(activity[0].key, 'Claude', 'newest first, with the key\'s name');
  });

  it('a revoked key stops working at once, and turning access off stops every key', async () => {
    await s.ok.del(`/api/agents/keys/${read.id}`);
    assert.equal((await reader('GET', '/api/accounts')).status, 401);
    await s.ok.put('/api/agents', { enabled: false });
    assert.equal((await agent('GET', '/api/accounts')).status, 403);
    await s.ok.put('/api/agents', { enabled: true });
    assert.equal((await agent('GET', '/api/accounts')).status, 200);
  });

  it('keys are never in backups and survive restoring one', async () => {
    const zip = new AdmZip(Buffer.from((await s.get('/api/backup')).body));
    assert.ok(!zip.getEntries().some(e => e.entryName.includes('agents')));
    assert.ok(!zip.getEntries().some(e => e.getData().toString('utf8').includes(full.key)));
    const saved = await s.ok.post('/api/backups');
    await s.ok.post(`/api/backups/${saved.name}/restore`);
    assert.equal((await agent('GET', '/api/accounts')).status, 200);
  });
});

describe('agent tools map onto real endpoints', () => {
  it('every tool calls an existing route with the right method', async () => {
    const routes = buildRoutes({ services: {}, store: { data: {} } });
    const sample = { accountId: 'a1', transactionId: 't1', otherAccountId: 'a2', groupId: 'g1', categoryId: 'c1', parentId: 'p1', payeeId: 'p1', recurringId: 'r1', name: 'x', batch: 'b1', dueDate: '2026-10-01', from: '2026-10-01', to: '2026-10-31', method: 'GET', path: '/api/accounts', rows: [], undo: [], transactionIds: [] };
    for (const tool of TOOLS) {
      const calls = [];
      const api = async (method, p, opts) => {
        calls.push({ method, path: p });
        return tool.name === 'get_overview' ? (p.includes('bootstrap') ? { accounts: [], groups: [], recurring: [], settings: {} } : {}) : {};
      };
      const args = Object.fromEntries(Object.keys(tool.input.properties).filter(k => k in sample).map(k => [k, sample[k]]));
      await tool.run(args, api, { endpoints: () => [], today: () => '2026-10-12' });
      for (const c of calls) {
        const match = routes.match(c.method, c.path);
        assert.ok(match && !match.methodNotAllowed, `${tool.name} → ${c.method} ${c.path}`);
      }
      if (tool.readOnly) assert.ok(calls.every(c => c.method === 'GET'), `${tool.name} is read-only but changes something`);
    }
  });
});

describe('a damaged agents file', () => {
  it('turns AI access off instead of stopping the app', async () => {
    const s = await freshServer();
    try {
      await s.ok.put('/api/agents', { enabled: true });
      await s.stop();
      fs.writeFileSync(path.join(s.dataDir, 'agents.json'), '{ broken');
      const log = createTestLog();
      const again = await startServer({ dataDir: s.dataDir, backupsDir: s.backupsDir, log });
      try {
        assert.equal((await again.ok.get('/api/agents')).enabled, false);
        assert.ok(log.warnings.some(w => w.includes('agents.json')));
        await makeTx(again, (await makeAccount(again)).id);
      } finally {
        await again.close();
      }
    } finally {
      await s.close();
    }
  });
});

describe('agents can set logos', () => {
  it('update_account and update_group take a logo, and null removes it', async () => {
    const { pngDataUrl } = await import('../helpers/fixtures.js');
    const s = await freshServer();
    try {
      await s.ok.put('/api/agents', { enabled: true });
      const { key } = await s.ok.post('/api/agents/keys', { name: 'Logos' });
      const agent = agentClient(s, key);
      const acc = await makeAccount(s, { name: 'Logo bank' });
      const set = await agent('POST', '/api/agent/tools/update_account', { accountId: acc.id, icon: pngDataUrl() });
      assert.equal(set.status, 200);
      assert.match(set.data.icon, /^\/api\/icons\/account-/);
      const group = (await agent('POST', '/api/agent/tools/create_group', { name: 'With logo', icon: pngDataUrl() })).data;
      assert.match(group.icon, /^\/api\/icons\/group-/);
      const renamed = (await agent('POST', '/api/agent/tools/update_group', { groupId: group.id, icon: null })).data;
      assert.equal(renamed.icon, null);
      assert.equal(renamed.name, 'With logo', 'changing only the logo keeps the name');
      const cleared = (await agent('POST', '/api/agent/tools/update_account', { accountId: acc.id, icon: null })).data;
      assert.equal(cleared.icon, null);
      assert.equal((await agent('POST', '/api/agent/tools/update_account', { accountId: acc.id, icon: 'data:text/plain;base64,aGk=' })).status, 400);
    } finally {
      await s.close();
    }
  });
});
