import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { badRequest, notFound } from '../lib/errors.js';
import { COLLECTION_FILES, TX_FILE_RE, ICON_FILE_RE } from '../store/store.js';
import { migrate, NewerDataError, SCHEMA_VERSION } from '../store/migrations/index.js';
import { newId, isSafeId } from '../lib/ids.js';
import { writeFileAtomic, cleanTempFiles } from '../lib/fsutil.js';
import { APP_VERSION } from '../config.js';
import { sanitizeData } from '../store/sanitize.js';

const KEEP = { auto: 24, safety: 10, manual: 30 };
const NAME_RE = /^(backup|safety|manual)-[A-Za-z0-9_.-]+\.zip$/;
const MAX_ENTRIES = 50000;
const MAX_UNCOMPRESSED = 300 * 1024 * 1024; // guards against zip bombs

const FILE_TO_KEY = Object.fromEntries(Object.entries(COLLECTION_FILES).map(([key, file]) => [file, key]));
const stamp = (date) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Build a backup ZIP from a dataset (same layout every version has used)
export function zipFromData(data) {
  const zip = new AdmZip();
  for (const [key, file] of Object.entries(COLLECTION_FILES)) {
    if (data[key] !== undefined && data[key] !== null) zip.addFile(file, Buffer.from(JSON.stringify(data[key], null, 2)));
  }
  for (const [id, list] of Object.entries(data.transactions || {})) {
    zip.addFile(`transactions/${id}.json`, Buffer.from(JSON.stringify(list, null, 2)));
  }
  for (const [name, buffer] of Object.entries(data.icons || {})) zip.addFile(`icons/${name}`, buffer);
  return zip.toBuffer();
}

// Read a backup ZIP into a dataset, accepting only the files Brisk Budget itself writes.
// Anything else (including paths that try to climb out of the data folder) is ignored.
export function dataFromZip(buffer, { limit = MAX_UNCOMPRESSED } = {}) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw badRequest("That file isn't a valid backup ZIP");
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw badRequest('That backup has too many files');

  // Unpack each file ourselves with a hard limit on what comes out. The sizes a ZIP claims can't
  // be trusted: one that says "0 bytes" would otherwise unpack without any limit at all.
  let left = limit;
  const contents = (entry) => {
    const h = entry.header;
    if (h.encrypted) throw badRequest(`The backup file ${entry.entryName} is password-protected`);
    const raw = entry.getCompressedData();
    let out;
    if (h.method === 0) {
      out = raw;
    } else if (h.method === 8) {
      try {
        out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, left) });
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw badRequest('That backup is too large to restore');
        throw badRequest(`The backup file ${entry.entryName} is damaged`);
      }
    } else {
      throw badRequest(`The backup file ${entry.entryName} uses a kind of compression Brisk Budget can't read`);
    }
    left -= out.length;
    if (left < 0) throw badRequest('That backup is too large to restore');
    return out;
  };

  const data = { transactions: {}, icons: {} };
  const ignored = [];
  const parse = (entry) => {
    const buffer = contents(entry);
    try {
      const text = buffer.toString('utf8');
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      throw badRequest(`The backup file ${entry.entryName} is damaged`);
    }
  };

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    const parts = name.split('/');
    if (parts.length === 1 && Object.hasOwn(FILE_TO_KEY, name)) {
      data[FILE_TO_KEY[name]] = parse(entry);
    } else if (parts.length === 2 && parts[0] === 'transactions' && TX_FILE_RE.test(parts[1]) && isSafeId(TX_FILE_RE.exec(parts[1])[1])) {
      data.transactions[TX_FILE_RE.exec(parts[1])[1]] = parse(entry);
    } else if (parts.length === 2 && parts[0] === 'icons' && ICON_FILE_RE.test(parts[1])) {
      data.icons[parts[1]] = contents(entry);
    } else {
      ignored.push(name);
    }
  }
  if (data.accounts === undefined) throw badRequest("That doesn't look like a Brisk Budget backup (accounts.json is missing)");
  if (!Array.isArray(data.accounts)) throw badRequest('The backup has a damaged accounts.json');
  // Ids become file names, and Windows and macOS treat "Acc1" and "acc1" as the same file
  const clash = (ids) => {
    const distinct = [...new Set(ids.filter(id => typeof id === 'string'))];
    return new Set(distinct.map(id => id.toLowerCase())).size !== distinct.length;
  };
  if (clash(data.accounts.map(a => a?.id)) || clash(Object.keys(data.transactions))) {
    throw badRequest("That backup has accounts whose ids differ only in capital letters, which this system can't store");
  }
  return { data, ignored };
}

// Restored data may be hand-edited or hostile: make sure nothing in it can reach a file path
// or break the shapes the app relies on.
export function sanitizeRestored(data, ctx) {
  return sanitizeData(data, ctx);
}

export function createBackups(app) {
  const { store, clock, config, log } = app;
  const dir = config.backupsDir;
  cleanTempFiles(dir); // left by a backup that was being written when the server stopped
  let lastAutoRevision = null;
  let timers = [];

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function kindOf(name) {
    if (name.startsWith('backup-')) return 'auto';
    if (name.startsWith('safety-')) return 'safety';
    return 'manual';
  }

  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => NAME_RE.test(name))
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, kind: kindOf(name), size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function prune() {
    // Copies taken before an upgrade are the only record of the previous version's data, so
    // they're kept separately from the copies taken before restores
    const all = list().map(b => ({ ...b, group: b.name.includes('pre-upgrade') ? 'upgrade' : b.kind }));
    const keep = { ...KEEP, upgrade: 20 };
    for (const group of Object.keys(keep)) {
      for (const old of all.filter(b => b.group === group).slice(keep[group])) {
        try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* ignore */ }
      }
    }
  }

  function write(kind, buffer, label = '') {
    ensureDir();
    const prefix = kind === 'auto' ? 'backup' : kind;
    const safeLabel = label ? `${label.replace(/[^A-Za-z0-9.-]/g, '')}-` : '';
    let name = `${prefix}-${safeLabel}${stamp(clock.now())}.zip`;
    if (fs.existsSync(path.join(dir, name))) name = name.replace('.zip', `-${newId().slice(-4)}.zip`);
    writeFileAtomic(path.join(dir, name), buffer);
    prune();
    return name;
  }

  function create(kind = 'manual', label = '') {
    const name = write(kind, zipFromData(store.data), label);
    if (kind === 'auto') lastAutoRevision = store.revision;
    return list().find(b => b.name === name);
  }

  // Back up the files exactly as they are on disk (used before upgrading old data)
  function createFromDisk(label) {
    const zip = new AdmZip();
    const dataDir = store.dataDir;
    for (const file of Object.values(COLLECTION_FILES)) {
      const full = path.join(dataDir, file);
      if (fs.existsSync(full)) zip.addLocalFile(full);
    }
    for (const sub of ['transactions', 'icons']) {
      const full = path.join(dataDir, sub);
      if (!fs.existsSync(full)) continue;
      for (const name of fs.readdirSync(full)) {
        if (TX_FILE_RE.test(name) || ICON_FILE_RE.test(name)) zip.addLocalFile(path.join(full, name), sub);
      }
    }
    return write('safety', zip.toBuffer(), label);
  }

  function filePath(name) {
    if (!NAME_RE.test(name || '')) throw notFound('Backup not found');
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) throw notFound('Backup not found');
    return full;
  }

  function read(name) {
    return fs.readFileSync(filePath(name));
  }

  function remove(name) {
    fs.unlinkSync(filePath(name));
    return { success: true };
  }

  // Replace all data with a backup. Older backups are upgraded on the way in, and a safety
  // backup of the current data is taken first so a restore can always be undone.
  function restore(buffer) {
    const { data, ignored } = dataFromZip(buffer);
    let result;
    try {
      result = migrate(data, { appVersion: APP_VERSION, today: clock.today(), nowIso: clock.now().toISOString(), newId });
    } catch (err) {
      if (err instanceof NewerDataError) throw badRequest(err.message);
      throw badRequest(`That backup couldn't be read: ${err.message}`);
    }
    sanitizeRestored(data, { today: clock.today(), nowIso: clock.now().toISOString() });
    data.auth = store.data.auth; // the password belongs to this server, not to the backup
    const safety = create('safety', 'pre-restore').name;
    store.writeAll(data);
    app.services.housekeeping.run();
    const transactions = Object.values(data.transactions).reduce((n, list) => n + list.length, 0);
    log.info(`Restored backup: ${data.accounts.length} accounts, ${transactions} transactions (safety copy ${safety})`);
    return { success: true, accounts: data.accounts.length, transactions, upgradedFrom: result.from, upgraded: result.applied.length > 0, ignored, safetyBackup: safety };
  }

  function restoreSaved(name) {
    return restore(read(name));
  }

  // Look through backups (newest first) for a readable copy of one data file. A copy from an
  // older data format is upgraded first, by upgrading that whole backup, so formats never mix.
  function findFile(relPath, schemaVersion = null) {
    for (const backup of list()) {
      try {
        const zip = new AdmZip(path.join(dir, backup.name));
        if (schemaVersion !== null) {
          const metaEntry = zip.getEntry('meta.json');
          const meta = metaEntry ? JSON.parse(metaEntry.getData().toString('utf8')) : null;
          const backupSchema = Number.isInteger(meta?.schemaVersion) ? meta.schemaVersion : 0;
          if (backupSchema > schemaVersion) continue;
          if (backupSchema < schemaVersion) {
            const value = fileFromUpgradedBackup(zip, relPath, schemaVersion);
            if (value !== undefined) return { value, source: backup.name };
            continue;
          }
        }
        const entry = zip.getEntry(relPath);
        if (!entry) continue;
        const value = JSON.parse(entry.getData().toString('utf8'));
        return { value, source: backup.name };
      } catch { /* try the next one */ }
    }
    return null;
  }

  // Upgrade a whole old-format backup in memory, then pick one file out of it
  function fileFromUpgradedBackup(zip, relPath, schemaVersion) {
    if (schemaVersion !== SCHEMA_VERSION) return undefined;
    const { data } = dataFromZip(zip.toBuffer());
    migrate(data, { appVersion: APP_VERSION, today: clock.today(), nowIso: clock.now().toISOString(), newId });
    sanitizeData(data, { today: clock.today(), nowIso: clock.now().toISOString() });
    const tx = /^transactions\/([A-Za-z0-9_-]+)\.json$/.exec(relPath);
    if (tx) return Object.hasOwn(data.transactions, tx[1]) ? data.transactions[tx[1]] : undefined;
    const key = Object.entries(COLLECTION_FILES).find(([, file]) => file === relPath)?.[0];
    return key && data[key] !== undefined ? data[key] : undefined;
  }

  function startSchedule() {
    const hourly = () => {
      if (store.revision === lastAutoRevision) return;
      try {
        create('auto');
      } catch (err) {
        log.error('Automatic backup failed:', err.message);
      }
    };
    lastAutoRevision = null;
    timers.push(setTimeout(hourly, 60 * 1000));
    timers.push(setInterval(hourly, 60 * 60 * 1000));
    for (const t of timers) t.unref?.();
  }

  function stop() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
  }

  return { list, create, createFromDisk, read, remove, restore, restoreSaved, findFile, startSchedule, stop, zip: () => zipFromData(store.data) };
}
