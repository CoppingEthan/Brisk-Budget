// Optional password. Off unless someone sets one in Settings. Sessions are signed cookies, so
// they survive restarts; signing out ends that session, and changing or removing the password
// signs everyone out.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest, tooManyRequests, unauthorized } from '../lib/errors.js';
import { requireObject } from '../lib/validate.js';
import { isPrivateAddress } from '../http/network.js';

const COOKIE = 'brisk_session';
const SESSION_DAYS = 30;
// A browser that has signed in here before (see startAttempt)
const DEVICE_COOKIE = 'brisk_device';
const DEVICE_DAYS = 400;
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
// X-Forwarded-For. Earlier entries come from the browser and can be made up, and so can the
// whole header when the request didn't come through a proxy on a private network.
export function clientAddress(req, trustProxy) {
  if (trustProxy && isPrivateAddress(req.socket.remoteAddress)) {
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

  // A signed cookie's contents, or null when it's missing, forged or out of date
  function verify(value) {
    if (!value || !store.data.auth?.secret) return null;
    const [body, mac] = value.split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', store.data.auth.secret).update(body).digest('base64url');
    if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return payload && typeof payload.exp === 'number' && payload.exp > clock.now().getTime() ? payload : null;
    } catch {
      return null;
    }
  }

  // Each session has its own id, so signing out can end just that one
  function sessionCookie(secure) {
    const exp = clock.now().getTime() + SESSION_DAYS * 86400000;
    const value = sign({ exp, sid: crypto.randomBytes(12).toString('base64url') });
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  // Marks a browser that has signed in here before. It signs nobody in; it's only sent to the
  // sign-in pages, and lets that browser keep trying while guessing from elsewhere is held off.
  function deviceCookie(secure) {
    const exp = clock.now().getTime() + DEVICE_DAYS * 86400000;
    return `${DEVICE_COOKIE}=${sign({ device: true, exp })}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

  function isAuthenticated(req) {
    if (!enabled()) return true;
    const payload = verify(parseCookies(req.headers.cookie)[COOKIE]);
    if (!payload || payload.device) return false;
    return !(payload.sid && store.data.auth.ended?.[payload.sid]);
  }

  const knownDevice = (req) => !!verify(parseCookies(req.headers.cookie)[DEVICE_COOKIE])?.device;

  let allFailures = [];

  // Each attempt counts from the moment it starts, so guesses sent all at once can't slip past
  // the limit while their passwords are still being checked; a right password takes its own
  // attempt back. Ten wrong guesses from one address, or 200 from everywhere (guessing spread
  // over many addresses), hold off more for 15 minutes. The overall limit doesn't apply to a
  // browser that has signed in here before, so someone guessing can't lock the owner out.
  function startAttempt(ip, known) {
    const now = Date.now();
    allFailures = allFailures.filter(t => now - t < WINDOW_MS);
    const recent = (failures.get(ip) || []).filter(t => now - t < WINDOW_MS);
    if (recent.length >= MAX_FAILURES || (!known && allFailures.length >= MAX_FAILURES_ALL)) {
      if (recent.length) failures.set(ip, recent);
      throw tooManyRequests('Too many wrong passwords. Try again in 15 minutes.');
    }
    allFailures.push(now);
    failures.delete(ip); // re-added last, so the oldest addresses are the first forgotten
    failures.set(ip, [...recent, now]);
    if (failures.size > MAX_TRACKED) {
      for (const key of failures.keys()) {
        failures.delete(key);
        if (failures.size <= MAX_TRACKED / 2) break;
      }
    }
    return now;
  }

  function attemptSucceeded(ip, started) {
    failures.delete(ip);
    const i = allFailures.lastIndexOf(started);
    if (i !== -1) allFailures.splice(i, 1);
  }

  async function checkPassword(req, password) {
    const ip = clientAddress(req, app.config.trustProxy);
    const started = startAttempt(ip, knownDevice(req));
    const ok = typeof password === 'string' && await verifyPassword(password, store.data.auth.passwordHash);
    if (ok) attemptSucceeded(ip, started);
    return ok;
  }

  function status(req) {
    return { enabled: enabled(), authenticated: isAuthenticated(req) };
  }

  async function login(req, body) {
    requireObject(body);
    if (!enabled()) return { ok: true, cookies: [] };
    if (!await checkPassword(req, body.password)) throw unauthorized('That password is not right');
    return { ok: true, cookies: [sessionCookie(isSecure(req)), deviceCookie(isSecure(req))] };
  }

  // Ends this browser's session on the server too, so a copy of its cookie stops working
  function logout(req) {
    const payload = enabled() ? verify(parseCookies(req.headers.cookie)[COOKIE]) : null;
    if (payload?.sid && !payload.device) {
      const now = clock.now().getTime();
      // Ended sessions are remembered only until they'd have run out anyway
      const ended = Object.fromEntries(Object.entries(store.data.auth.ended || {}).filter(([, exp]) => exp > now));
      ended[payload.sid] = payload.exp;
      store.data.auth.ended = ended;
      store.save('auth');
    }
    return clearCookie();
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
    return { ok: true, cookies: [sessionCookie(isSecure(req)), deviceCookie(isSecure(req))] };
  }

  async function removePassword(req, body) {
    requireObject(body);
    if (!enabled()) return { ok: true };
    await requireCurrent(req, body);
    store.data.auth = null;
    store.save('auth');
    return { ok: true, cookie: clearCookie() };
  }

  return { enabled, isAuthenticated, status, login, logout, setPassword, removePassword, clearCookie };
}
