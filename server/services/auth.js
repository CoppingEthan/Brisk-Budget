// Optional password. Off unless someone sets one in Settings. Sessions are signed cookies, so
// they survive restarts; changing or removing the password signs everyone out.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest, tooManyRequests, unauthorized } from '../lib/errors.js';
import { requireObject } from '../lib/validate.js';

const COOKIE = 'brisk_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10; // per address
const MAX_FAILURES_ALL = 200; // from everywhere at once, which stops guessing spread over many addresses
const MAX_TRACKED = 5000;

// Hashing runs off the main thread, so a flood of sign-in attempts can't stall everything else
const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const value = part.slice(i + 1).trim();
    // Other apps on the same host can set cookies that aren't valid URI encoding
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(value);
    } catch {
      out[part.slice(0, i).trim()] = value;
    }
  }
  return out;
}

// Who is signing in. Behind a reverse proxy every request comes from the proxy, so when
// BRISK_TRUST_PROXY=1 the address the proxy saw is used instead: the last one in
// X-Forwarded-For. Earlier entries come from the browser and can be made up.
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean).pop();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createAuth(app) {
  const { store, clock } = app;
  const failures = new Map(); // ip -> [timestamps]

  const enabled = () => !!store.data.auth?.passwordHash;

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', store.data.auth.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function sessionCookie(secure) {
    const exp = clock.now().getTime() + SESSION_DAYS * 86400000;
    const value = sign({ exp });
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

  function isAuthenticated(req) {
    if (!enabled()) return true;
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value) return false;
    const [body, mac] = value.split('.');
    if (!body || !mac) return false;
    const expected = crypto.createHmac('sha256', store.data.auth.secret).update(body).digest('base64url');
    if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return typeof payload.exp === 'number' && payload.exp > clock.now().getTime();
    } catch {
      return false;
    }
  }

  let allFailures = [];

  function checkRate(ip) {
    const now = Date.now();
    allFailures = allFailures.filter(t => now - t < WINDOW_MS);
    const recent = (failures.get(ip) || []).filter(t => now - t < WINDOW_MS);
    if (recent.length) failures.set(ip, recent);
    else failures.delete(ip);
    if (recent.length >= MAX_FAILURES || allFailures.length >= MAX_FAILURES_ALL) {
      throw tooManyRequests('Too many wrong passwords. Try again in 15 minutes.');
    }
  }

  function recordFailure(ip) {
    const now = Date.now();
    allFailures.push(now);
    failures.set(ip, [...(failures.get(ip) || []), now]);
    // Forget the oldest addresses rather than growing without limit
    if (failures.size > MAX_TRACKED) {
      for (const key of failures.keys()) {
        failures.delete(key);
        if (failures.size <= MAX_TRACKED / 2) break;
      }
    }
  }

  async function checkPassword(req, password) {
    const ip = clientAddress(req, app.config.trustProxy);
    checkRate(ip);
    const ok = typeof password === 'string' && await verifyPassword(password, store.data.auth.passwordHash);
    if (ok) failures.delete(ip);
    else recordFailure(ip);
    return ok;
  }

  function status(req) {
    return { enabled: enabled(), authenticated: isAuthenticated(req) };
  }

  async function login(req, body) {
    requireObject(body);
    if (!enabled()) return { ok: true, cookie: null };
    if (!await checkPassword(req, body.password)) throw unauthorized('That password is not right');
    return { ok: true, cookie: sessionCookie(isSecure(req)) };
  }

  function isSecure(req) {
    return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  }

  function checkNewPassword(password) {
    if (typeof password !== 'string' || password.length < 8) throw badRequest('Use a password of at least 8 characters');
    if (password.length > 200) throw badRequest('That password is too long');
  }

  async function requireCurrent(req, body) {
    if (enabled() && !await checkPassword(req, body.currentPassword)) {
      throw badRequest('Your current password is not right');
    }
  }

  // Turn the password on, or change it. Returns a fresh cookie for whoever changed it.
  async function setPassword(req, body) {
    requireObject(body);
    await requireCurrent(req, body);
    checkNewPassword(body.newPassword);
    store.data.auth = { passwordHash: await hashPassword(body.newPassword), secret: crypto.randomBytes(32).toString('hex'), updatedAt: clock.now().toISOString() };
    store.save('auth');
    return { ok: true, cookie: sessionCookie(isSecure(req)) };
  }

  async function removePassword(req, body) {
    requireObject(body);
    if (!enabled()) return { ok: true };
    await requireCurrent(req, body);
    store.data.auth = null;
    store.save('auth');
    return { ok: true, cookie: clearCookie() };
  }

  return { enabled, isAuthenticated, status, login, setPassword, removePassword, clearCookie };
}
