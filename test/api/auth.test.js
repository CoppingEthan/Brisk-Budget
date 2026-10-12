import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { clock } from '../../server/lib/clock.js';
import { freshServer, NOW } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';

// "brisk_session=abc; Path=/; ..." -> "brisk_session=abc"
function sessionFrom(res) {
  const header = [].concat(res.headers['set-cookie'] || []).find(c => c.startsWith('brisk_session='));
  assert.ok(header, 'a session cookie is set');
  return header.split(';')[0];
}

describe('password protection', () => {
  let s;
  let cookie;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('is off by default', async () => {
    assert.deepEqual(await s.ok.get('/api/auth/status'), { enabled: false, authenticated: true });
    assert.equal((await s.get('/api/accounts')).status, 200);
    const login = await s.ok.post('/api/auth/login', { password: 'anything' });
    assert.deepEqual(login, { ok: true });
  });

  it('turning it on needs a reasonable password and signs this browser in', async () => {
    assert.equal((await s.put('/api/auth/password', { newPassword: 'short' })).status, 400);
    assert.equal((await s.put('/api/auth/password', { newPassword: 12345678 })).status, 400);
    const res = await s.put('/api/auth/password', { newPassword: PASSWORD });
    assert.equal(res.status, 200);
    const header = [].concat(res.headers['set-cookie']).join(';');
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Path=\//);
    assert.doesNotMatch(header, /Secure/, 'plain http: no Secure flag');
    cookie = sessionFrom(res);
    const stored = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8'));
    assert.match(stored.passwordHash, /^scrypt\$/);
    assert.equal(JSON.stringify(stored).includes(PASSWORD), false, 'password never stored in plain text');
  });

  it('without a session everything but health, status and login is refused', async () => {
    assert.equal((await s.get('/api/accounts', { cookie: null })).status, 401);
    assert.equal((await s.get('/api/bootstrap', { cookie: null })).status, 401);
    assert.equal((await s.post('/api/accounts', { name: 'x' }, { cookie: null })).status, 401);
    assert.equal((await s.get('/api/backup', { cookie: null })).status, 401);
    assert.equal((await s.get('/api/health', { cookie: null })).status, 200);
    assert.deepEqual((await s.get('/api/auth/status', { cookie: null })).data, { enabled: true, authenticated: false });
    const page = await s.get('/', { cookie: null });
    assert.equal(page.status, 200, 'the page itself loads so the sign-in screen can show');
  });

  it('a valid session cookie gets in; tampered or expired ones do not', async () => {
    assert.equal((await s.get('/api/accounts', { cookie })).status, 200);
    assert.deepEqual((await s.get('/api/auth/status', { cookie })).data, { enabled: true, authenticated: true });
    const [name, value] = cookie.split('=');
    const [body, mac] = value.split('.');
    const forged = `${name}=${Buffer.from(JSON.stringify({ exp: Date.parse(NOW) + 1e12 })).toString('base64url')}.${mac}`;
    assert.equal((await s.get('/api/accounts', { cookie: forged })).status, 401);
    assert.equal((await s.get('/api/accounts', { cookie: `${name}=${body}` })).status, 401);
    assert.equal((await s.get('/api/accounts', { cookie: `${name}=garbage` })).status, 401);
    clock.set('2026-11-20T12:00:00Z'); // 39 days later: the 30-day session has expired
    try {
      assert.equal((await s.get('/api/accounts', { cookie })).status, 401);
    } finally {
      clock.set(NOW);
    }
  });

  it('cookies set by other apps on the same host do not break sign-in', async () => {
    // Cookies are shared between ports on a host, and other apps can set values that are not
    // valid percent-encoding. That must not turn every request into a server error.
    const mixed = `other_app=100%; ${cookie}; theme=dark`;
    const status = await s.get('/api/auth/status', { cookie: mixed });
    assert.equal(status.status, 200, `status answered ${status.status}`);
    assert.equal(status.data.authenticated, true);
    assert.equal((await s.get('/api/accounts', { cookie: mixed })).status, 200);
    assert.equal((await s.get('/api/accounts', { cookie: 'brisk_session=%E0%A4%A' })).status, 401);
  });

  it('no response ever includes the password hash or the session secret', async () => {
    const stored = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'auth.json'), 'utf8'));
    for (const url of ['/api/bootstrap', '/api/settings', '/api/auth/status', '/api/version']) {
      const text = (await s.get(url, { cookie })).body.toString();
      assert.equal(text.includes(stored.secret), false, `${url} leaks the secret`);
      assert.equal(text.includes('scrypt$'), false, `${url} leaks the hash`);
    }
  });

  it('logging in with the right password works, the wrong one does not', async () => {
    const wrong = await s.post('/api/auth/login', { password: 'nope nope' }, { cookie: null });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);
    assert.equal((await s.post('/api/auth/login', {}, { cookie: null })).status, 401);
    const right = await s.post('/api/auth/login', { password: PASSWORD }, { cookie: null });
    assert.equal(right.status, 200);
    const fresh = sessionFrom(right);
    assert.equal((await s.get('/api/accounts', { cookie: fresh })).status, 200);
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const res = await s.post('/api/auth/login', { password: PASSWORD }, { cookie: null, headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match([].concat(res.headers['set-cookie']).join(';'), /Secure/);
  });

  it('logout clears the cookie', async () => {
    const res = await s.post('/api/auth/logout', {}, { cookie });
    assert.equal(res.status, 200);
    assert.match([].concat(res.headers['set-cookie']).join(';'), /brisk_session=;.*Max-Age=0/);
  });

  it('the password is never part of a backup, and survives restoring one', async () => {
    const zipRes = await s.get('/api/backup', { cookie });
    const zip = new AdmZip(zipRes.body);
    assert.equal(zip.getEntries().some(e => /auth/i.test(e.entryName)), false);
    const restore = await s.post('/api/backup/restore', zipRes.body, { cookie, contentType: 'application/zip' });
    assert.equal(restore.status, 200);
    assert.equal((await s.get('/api/accounts', { cookie: null })).status, 401, 'still protected after a restore');
    assert.equal((await s.get('/api/accounts', { cookie })).status, 200, 'and the session still works');
  });

  it('changing the password needs the current one and signs out other sessions', async () => {
    assert.equal((await s.put('/api/auth/password', { currentPassword: 'wrong', newPassword: 'another long one' }, { cookie })).status, 400);
    assert.equal((await s.put('/api/auth/password', { newPassword: 'another long one' }, { cookie })).status, 400);
    const res = await s.put('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another long one' }, { cookie });
    assert.equal(res.status, 200);
    const newCookie = sessionFrom(res);
    assert.equal((await s.get('/api/accounts', { cookie })).status, 401, 'old sessions are signed out');
    assert.equal((await s.get('/api/accounts', { cookie: newCookie })).status, 200);
    cookie = newCookie;
  });

  it('removing the password needs the current one', async () => {
    assert.equal((await s.del('/api/auth/password', { currentPassword: PASSWORD }, { cookie })).status, 400);
    assert.equal((await s.del('/api/auth/password', {}, { cookie })).status, 400);
    const res = await s.del('/api/auth/password', { currentPassword: 'another long one' }, { cookie });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'auth.json')), false);
    assert.equal((await s.get('/api/accounts', { cookie: null })).status, 200);
    assert.deepEqual((await s.get('/api/auth/status', { cookie: null })).data, { enabled: false, authenticated: true });
  });
});

describe('password protection: brute force limit', () => {
  let s;
  before(async () => {
    s = await freshServer();
    await s.ok.put('/api/auth/password', { newPassword: PASSWORD });
  });
  after(async () => { await s.close(); });

  it('after 10 wrong passwords even the right one is refused for a while (429)', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await s.post('/api/auth/login', { password: `wrong-${i}` })).status, 401, `attempt ${i + 1}`);
    }
    const blocked = await s.post('/api/auth/login', { password: PASSWORD });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /15 minutes/);
  });
});
