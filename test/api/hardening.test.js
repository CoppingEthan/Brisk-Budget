// Protections added after the security review: zip bombs, DNS rebinding, sign-in limits behind
// proxies, small bodies on public routes, and ids that can't be file names everywhere.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION } from '../../server/store/migrations/index.js';
import { dataFromZip } from '../../server/services/backups.js';
import { createHostCheck } from '../../server/http/hosts.js';
import { isSafeId } from '../../server/lib/ids.js';
import { freshServer, rawRequest } from '../helpers/server.js';
import { buildStoreZip } from '../helpers/zip.js';

const META = { name: 'meta.json', data: { schemaVersion: SCHEMA_VERSION, appVersion: '0.4.0', history: [] } };
const PASSWORD = 'correct horse battery';

describe('backup ZIPs are unpacked with a hard size limit', () => {
  it('an entry that claims to be 0 bytes is still limited by what actually comes out', () => {
    const bomb = buildStoreZip([META, { name: 'accounts.json', data: Buffer.alloc(5 * 1024 * 1024, 0x20), deflate: true, declaredSize: 0 }]);
    assert.ok(bomb.length < 100 * 1024, 'the test archive is small');
    assert.throws(() => dataFromZip(bomb, { limit: 1024 * 1024 }), /too large/);
  });

  it('honest compressed backups still restore, whatever size they claim', () => {
    const zip = buildStoreZip([META, { name: 'accounts.json', data: [{ id: 'a1', name: 'Current', type: 'bank' }], deflate: true, declaredSize: 0 }]);
    const { data } = dataFromZip(zip);
    assert.equal(data.accounts[0].name, 'Current');
  });

  it('a backup whose account ids differ only in capitals is refused', () => {
    const zip = buildStoreZip([META,
      { name: 'accounts.json', data: [{ id: 'Acc1', name: 'Upper', type: 'bank' }, { id: 'acc1', name: 'Lower', type: 'bank' }] },
      { name: 'transactions/Acc1.json', data: [] },
      { name: 'transactions/acc1.json', data: [] }
    ]);
    assert.throws(() => dataFromZip(zip), /capital letters/);
  });

  it('names Windows keeps for devices are never ids', () => {
    for (const id of ['nul', 'CON', 'com1', 'Lpt9', 'aux', 'prn']) assert.equal(isSafeId(id), false, id);
    for (const id of ['null', 'console', 'com10x', 'nul-1']) assert.equal(isSafeId(id), true, id);
  });
});

describe('addresses the server answers to without a password (DNS rebinding)', () => {
  it('names nobody can buy on the internet are always fine', () => {
    const allowed = createHostCheck();
    for (const host of ['localhost:3000', '127.0.0.1:3000', '192.168.1.20', '[::1]:3000', '[fe80::1]', 'raspberrypi', 'raspberrypi:3000',
      'budget.local', 'nas.lan', 'pi.home', 'pi.home.arpa', 'box.internal', 'pi.fritz.box', 'budget.tail1234.ts.net', 'app.localhost', '']) {
      assert.equal(allowed(host), true, host);
    }
    for (const host of ['attacker.example', 'budget.example.com:3000', '192.168.1.20.nip.io', 'evil.com.']) {
      assert.equal(allowed(host), false, host);
    }
  });

  it('BRISK_ALLOWED_HOSTS adds exact names and *.wildcards, and * allows anything', () => {
    const allowed = createHostCheck({ allowedHosts: 'budget.example.com, *.home.example.org' });
    assert.equal(allowed('budget.example.com'), true);
    assert.equal(allowed('BUDGET.example.com:443'), true);
    assert.equal(allowed('a.home.example.org'), true);
    assert.equal(allowed('home.example.org'), false);
    assert.equal(allowed('other.example.com'), false);
    assert.equal(createHostCheck({ allowedHosts: '*' })('anything.example'), true);
  });

  describe('on a running server', () => {
    let s;
    before(async () => { s = await freshServer(); });
    after(async () => { await s.close(); });

    const get = (path, headers) => rawRequest(s.app.server.address().port, { path, headers });

    it('refuses pages and API calls for an unknown name, with a message that says what to do', async () => {
      const api = await get('/api/bootstrap', { Host: 'attacker.example' });
      assert.equal(api.status, 403);
      assert.match(JSON.parse(api.body).error, /BRISK_ALLOWED_HOSTS=attacker\.example/);
      const page = await get('/', { Host: 'attacker.example:3000' });
      assert.equal(page.status, 403);
      assert.match(page.body.toString(), /set a password/);
      assert.ok(s.log.warnings.some(l => /attacker\.example/.test(l)), 'the refusal is logged');
    });

    it('answers to its IP address and local names', async () => {
      for (const host of ['127.0.0.1', 'localhost:3000', 'raspberrypi.local']) {
        assert.equal((await get('/api/health', { Host: host })).status, 200, host);
      }
    });

    it('answers to any name passed on by a reverse proxy on the same machine', async () => {
      const res = await get('/api/health', { Host: 'budget.example.com', 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(res.status, 200);
    });

    it('once a password is set any name works, because the sign-in cookie never goes to another name', async () => {
      await s.ok.put('/api/auth/password', { newPassword: PASSWORD });
      assert.equal((await get('/api/bootstrap', { Host: 'attacker.example' })).status, 401);
      assert.equal((await get('/api/health', { Host: 'attacker.example' })).status, 200);
    });
  });
});

describe('sign-in limits', () => {
  let s;
  before(async () => {
    s = await freshServer({ trustProxy: true });
    await s.ok.put('/api/auth/password', { newPassword: PASSWORD });
  });
  after(async () => { await s.close(); });

  it('behind a proxy, made-up addresses at the start of X-Forwarded-For do not reset the limit', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await s.post('/api/auth/login', { password: `wrong-${i}` }, { cookie: null, headers: { 'X-Forwarded-For': `10.0.0.${i}, 198.51.100.7` } });
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await s.post('/api/auth/login', { password: PASSWORD }, { cookie: null, headers: { 'X-Forwarded-For': '10.9.9.9, 198.51.100.7' } });
    assert.equal(blocked.status, 429);
    const other = await s.post('/api/auth/login', { password: PASSWORD }, { cookie: null, headers: { 'X-Forwarded-For': '198.51.100.8' } });
    assert.equal(other.status, 200, 'someone else can still sign in');
  });

  it('wrong current passwords count towards the limit too', async () => {
    const headers = { 'X-Forwarded-For': '198.51.100.20' };
    const login = await s.post('/api/auth/login', { password: PASSWORD }, { cookie: null, headers });
    const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0];
    for (let i = 0; i < 10; i++) {
      const res = await s.put('/api/auth/password', { currentPassword: `wrong-${i}`, newPassword: 'another password' }, { cookie, headers });
      assert.equal(res.status, 400, `attempt ${i + 1}`);
    }
    const blocked = await s.put('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another password' }, { cookie, headers });
    assert.equal(blocked.status, 429);
  });

  it('the public sign-in routes only take small bodies', async () => {
    const big = { password: 'x'.repeat(64 * 1024) };
    assert.equal((await s.post('/api/auth/login', big, { cookie: null })).status, 413);
    assert.equal((await s.post('/api/auth/logout', big, { cookie: null })).status, 413);
    assert.equal((await s.get('/api/health')).status, 200);
  });
});
