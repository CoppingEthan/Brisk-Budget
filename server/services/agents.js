// AI agent access: off unless the owner turns it on in Settings › AI agents. An agent (Claude,
// ChatGPT, a script…) signs in with an access key, sent as "Authorization: Bearer <key>", and
// can then use the MCP endpoint (/mcp), the agent API (/api/agent) or any other API endpoint.
// Only a hash of each key is kept, so a key can be shown once and never again.
import crypto from 'node:crypto';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { requireObject, str, oneOf, bool, has } from '../lib/validate.js';
import { newId } from '../lib/ids.js';

const KEY_PREFIX = 'bb_';
const MAX_KEYS = 20;
const ACTIVITY_KEPT = 200;
const ACCESS = ['full', 'read'];

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

// The Authorization header's key, or null when there isn't one
export function bearerKey(req) {
  const header = String(req.headers?.authorization || '');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : header ? '' : null;
}

export function createAgents(app) {
  const { store, clock } = app;
  let lastUsedSaved = 0;

  function data() {
    const current = store.data.agents;
    if (current && typeof current === 'object') {
      if (!Array.isArray(current.keys)) current.keys = [];
      if (!Array.isArray(current.activity)) current.activity = [];
      return current;
    }
    store.data.agents = { enabled: false, keys: [], activity: [] };
    return store.data.agents;
  }

  const enabled = () => store.data.agents?.enabled === true;
  const nowIso = () => clock.now().toISOString();
  const publicKey = (k) => ({ id: k.id, name: k.name, access: k.access, hint: k.hint, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null });

  function status() {
    const d = data();
    return { enabled: d.enabled === true, keys: d.keys.map(publicKey), activity: d.activity.slice(-50).reverse() };
  }

  function setEnabled(body) {
    requireObject(body);
    if (!has(body, 'enabled')) throw badRequest('enabled is required');
    const d = data();
    d.enabled = bool(body.enabled, 'enabled');
    store.save('agents');
    return status();
  }

  // A new key is returned once, in full; afterwards only its name and last few characters show
  function createKey(body) {
    requireObject(body);
    const d = data();
    if (d.keys.length >= MAX_KEYS) throw badRequest(`You can have up to ${MAX_KEYS} access keys. Revoke one you no longer use first.`);
    const name = str(body.name, 'Name', { required: true, max: 60 });
    const access = oneOf(body.access, 'Access', ACCESS, { fallback: 'full' });
    const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const record = { id: newId(), name, access, hint: key.slice(-4), hash: hash(key), createdAt: nowIso(), lastUsedAt: null };
    d.keys.push(record);
    store.save('agents');
    return { ...publicKey(record), key };
  }

  function revokeKey(id) {
    const d = data();
    const index = d.keys.findIndex(k => k.id === id);
    if (index < 0) throw notFound('Access key not found');
    d.keys.splice(index, 1);
    store.save('agents');
    return { success: true };
  }

  // Who a request with an access key is. Throws when the key is wrong or access is off, so a
  // request that brings a key is never treated as anything else.
  function authenticate(req) {
    const key = bearerKey(req);
    if (key === null) return null;
    if (!enabled()) throw forbidden('AI agent access is turned off. Turn it on in Brisk Budget under Settings › AI agents.');
    const wanted = Buffer.from(hash(key || '-'), 'hex');
    const found = data().keys.find(k => {
      const stored = Buffer.from(k.hash, 'hex');
      return stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted);
    });
    if (!found) throw unauthorized('That access key is not valid. It may have been revoked.');
    found.lastUsedAt = nowIso();
    // Keep "last used" fresh without writing the file on every request
    if (Date.now() - lastUsedSaved > 60000) {
      lastUsedSaved = Date.now();
      store.save('agents');
    }
    return { id: found.id, name: found.name, access: found.access };
  }

  // A record of what agents changed (and tried to), shown in Settings › AI agents
  function record(agent, entry) {
    const d = data();
    d.activity.push({ at: nowIso(), key: agent.name, ...entry });
    if (d.activity.length > ACTIVITY_KEPT) d.activity.splice(0, d.activity.length - ACTIVITY_KEPT);
    try {
      store.save('agents');
    } catch {
      // The change itself was saved; losing a log line isn't worth failing the request for
    }
  }

  function clearActivity() {
    data().activity = [];
    store.save('agents');
    return status();
  }

  return { enabled, status, setEnabled, createKey, revokeKey, authenticate, record, clearActivity };
}
