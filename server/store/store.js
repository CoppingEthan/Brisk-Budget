// All app data lives in memory and is written through to plain JSON files on every change.
// Files keep the same names and layout as every earlier version, so backups stay readable.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, readJSONFile, cleanTempFiles, renameWithRetry, prepareFile, removeQuietly, listJSON } from '../lib/fsutil.js';
import { isSafeId } from '../lib/ids.js';
import { HttpError } from '../lib/errors.js';

export const COLLECTION_FILES = {
  meta: 'meta.json',
  settings: 'settings.json',
  accounts: 'accounts.json',
  groups: 'account-groups.json',
  categories: 'categories.json',
  payees: 'payees.json',
  recurring: 'recurring.json',
  dismissed: 'dismissed.json'
};

export const AUTH_FILE = 'auth.json';
export const TX_FILE_RE = /^([A-Za-z0-9_-]{1,64})\.json$/;
export const ICON_FILE_RE = /^[A-Za-z0-9_-]{1,80}\.(jpg|png|webp)$/;

// Written into a staging folder once everything in it is safely on disk (see writeAll)
const COMMITTED = 'COMMITTED.json';

export class StoreLoadError extends Error {}

const json = (value) => JSON.stringify(value, null, 2);

function writeSynced(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// A failed write, explained in words a person can act on
function saveFailed(err) {
  const reasons = {
    ENOSPC: 'the disk is full',
    EDQUOT: 'the disk quota is used up',
    EROFS: 'the disk is read-only',
    EACCES: "it isn't allowed to write to its data folder",
    EPERM: "it isn't allowed to write to its data folder",
    EBUSY: 'another program is holding the data files open'
  };
  const reason = reasons[err.code] || `of an error (${err.code || err.message})`;
  return new HttpError(500, `Brisk Budget couldn't save that change because ${reason}, so the change wasn't made.`);
}

export class Store {
  constructor({ dataDir, log, recoverFile }) {
    this.dataDir = dataDir;
    this.txDir = path.join(dataDir, 'transactions');
    this.iconsDir = path.join(dataDir, 'icons');
    this.log = log;
    this.recoverFile = recoverFile; // (relativePath, schemaVersion) => { value, source } | null
    this.data = null;
    this.revision = 0;
    this.recovered = [];
    this.quarantined = [];
    this.pendingStaging = null;
  }

  // True when there's no sign of an earlier install in the data folder
  isFresh() {
    if (!fs.existsSync(this.dataDir)) return true;
    const hasCollections = Object.values(COLLECTION_FILES).some(f => fs.existsSync(path.join(this.dataDir, f)));
    const hasTransactions = fs.existsSync(this.txDir) && fs.readdirSync(this.txDir).some(f => TX_FILE_RE.test(f));
    const hasCommitted = this.stagingFolders().some(dir => fs.existsSync(path.join(dir, COMMITTED)));
    return !hasCollections && !hasTransactions && !hasCommitted;
  }

  load() {
    for (const dir of [this.dataDir, this.txDir, this.iconsDir]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of [this.dataDir, this.txDir, this.iconsDir]) cleanTempFiles(dir);
    this.finishInterrupted();

    const data = { transactions: {}, icons: {} };
    const problems = [];
    const unreadable = [];

    for (const [key, file] of Object.entries(COLLECTION_FILES)) {
      const result = readJSONFile(path.join(this.dataDir, file));
      if (result.unreadable) unreadable.push({ rel: file, error: result.unreadable });
      else if (result.error) problems.push({ key, rel: file, error: result.error });
      else if (!result.missing) data[key] = result.value;
    }

    for (const name of fs.readdirSync(this.txDir)) {
      const match = TX_FILE_RE.exec(name);
      if (!match || !isSafeId(match[1])) continue;
      const result = readJSONFile(path.join(this.txDir, name));
      if (result.unreadable) unreadable.push({ rel: `transactions/${name}`, error: result.unreadable });
      else if (result.error) problems.push({ tx: match[1], rel: `transactions/${name}`, error: result.error });
      else if (!result.missing) data.transactions[match[1]] = result.value;
    }

    for (const name of fs.readdirSync(this.iconsDir)) {
      if (ICON_FILE_RE.test(name)) data.icons[name] = fs.readFileSync(path.join(this.iconsDir, name));
    }

    // A file that can't be read just now (locked, no permission) isn't damaged: never replace it
    if (unreadable.length) {
      const list = unreadable.map(p => `${p.rel} (${p.error.code || p.error.message})`).join(', ');
      throw new StoreLoadError(`Brisk Budget couldn't read ${list}. Check it's allowed to read its data folder and that no other program is holding the files open, then restart.`);
    }

    const auth = readJSONFile(path.join(this.dataDir, AUTH_FILE));
    if (auth.unreadable) {
      throw new StoreLoadError(`Brisk Budget couldn't read the password file (${auth.unreadable.code || auth.unreadable.message}). Check its permissions, then restart.`);
    }
    if (auth.error) {
      // Never silently drop a password: refuse to start instead
      throw new StoreLoadError(`The password file (${path.join(this.dataDir, AUTH_FILE)}) is damaged. Delete it to remove the password, then restart.`);
    }
    data.auth = auth.missing ? null : auth.value;

    // Only a backup in the same data format can stand in for a damaged file
    const metaDamaged = problems.some(p => p.key === 'meta');
    const schema = metaDamaged ? null : (Number.isInteger(data.meta?.schemaVersion) ? data.meta.schemaVersion : 0);
    const unrecovered = [];
    // The damaged file is always kept, renamed, so nothing is lost even if the copy is older
    const setAside = (problem) => {
      const target = path.join(this.dataDir, problem.rel);
      const aside = `${target}.damaged-${Date.now()}`;
      try {
        renameWithRetry(target, aside);
      } catch (err) {
        throw new StoreLoadError(`${problem.rel} is damaged and couldn't be moved out of the way (${err.code || err.message}). Move it somewhere safe by hand, then restart.`);
      }
      return { target, aside: path.basename(aside) };
    };
    for (const problem of problems) {
      const found = this.recoverFile ? this.recoverFile(problem.rel, schema) : null;
      if (!found) { unrecovered.push(problem); continue; }
      if (problem.key) data[problem.key] = found.value;
      else data.transactions[problem.tx] = found.value;
      const { target } = setAside(problem);
      writeFileAtomic(target, problem.key ? json(found.value) : listJSON(found.value));
      this.recovered.push({ file: problem.rel, source: found.source });
      this.log?.warn(`Recovered damaged ${problem.rel} from backup ${found.source}`);
    }
    // One account's damaged transactions shouldn't stop the whole app (or every update) from
    // starting: that account starts empty and the damaged file is kept for recovering by hand
    for (const problem of unrecovered.filter(p => p.tx)) {
      const { aside } = setAside(problem);
      data.transactions[problem.tx] = [];
      this.quarantined.push({ file: problem.rel, accountId: problem.tx, aside });
      this.log?.error(`${problem.rel} is damaged and no backup has a copy; it was kept as ${aside}`);
    }
    const fatal = unrecovered.filter(p => p.key);
    if (fatal.length) {
      const list = fatal.map(p => `${p.rel} (${p.error.message})`).join(', ');
      throw new StoreLoadError(`Some data files are damaged and no backup copy could be found: ${list}. Restore a backup or fix the files, then restart.`);
    }

    this.data = data;
    return data;
  }

  collectionPath(key) {
    return path.join(this.dataDir, COLLECTION_FILES[key]);
  }

  touch() {
    this.revision++;
  }

  save(...keys) {
    this.commit(keys.map(key => {
      if (key === 'auth') return { key, file: path.join(this.dataDir, AUTH_FILE), text: this.data.auth ? json(this.data.auth) : null };
      return { key, file: this.collectionPath(key), text: json(this.data[key]) };
    }));
  }

  saveTransactions(...accountIds) {
    const files = [];
    for (const id of new Set(accountIds)) {
      if (!id) continue;
      if (!this.data.transactions[id]) this.data.transactions[id] = [];
      files.push({ tx: id, file: path.join(this.txDir, `${id}.json`), text: listJSON(this.data.transactions[id]) });
    }
    this.commit(files);
  }

  // Write several files so that a failure (a full or read-only disk) changes none of them: each
  // is written to a temporary file and flushed first, and only then are they all moved into
  // place. If anything fails, the change is dropped from memory too, so what the app shows
  // always matches what's on disk. (`text: null` deletes the file.)
  commit(files) {
    const ready = [];
    try {
      for (const f of files) ready.push({ ...f, tmp: f.text === null ? null : prepareFile(f.file, f.text) });
      for (const f of ready) {
        if (f.tmp) renameWithRetry(f.tmp, f.file);
        else if (fs.existsSync(f.file)) fs.unlinkSync(f.file);
      }
    } catch (err) {
      for (const f of ready) if (f.tmp) removeQuietly(f.tmp);
      this.reread(files);
      this.log?.error(`Couldn't save ${files.map(f => path.relative(this.dataDir, f.file)).join(', ')}: ${err.message}`);
      throw saveFailed(err);
    }
    // A newer copy of a file supersedes the one waiting in an unfinished full write
    if (this.pendingStaging) {
      for (const f of files) removeQuietly(path.join(this.pendingStaging, path.relative(this.dataDir, f.file)));
    }
    this.touch();
  }

  // Put memory back to what's on disk after a failed save
  reread(files) {
    for (const f of files) {
      const result = readJSONFile(f.file);
      if (result.error || result.unreadable) continue;
      if (f.key === 'auth') this.data.auth = result.missing ? null : result.value;
      else if (f.key) { if (!result.missing) this.data[f.key] = result.value; }
      else if (f.tx) this.data.transactions[f.tx] = result.missing ? [] : result.value;
    }
  }

  saveIcon(name, buffer) {
    writeFileAtomic(path.join(this.iconsDir, name), buffer);
    this.data.icons[name] = buffer;
    this.touch();
  }

  deleteIcon(name) {
    if (!name) return;
    delete this.data.icons[name];
    try { fs.unlinkSync(path.join(this.iconsDir, name)); } catch { /* already gone */ }
    this.touch();
  }

  stagingFolders() {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs.readdirSync(this.dataDir).filter(name => name.startsWith('.staging-')).sort().map(name => path.join(this.dataDir, name));
  }

  // A full write (upgrade, restore, repair) that was interrupted: finish it if it was complete,
  // otherwise throw it away (the files in use were never touched)
  finishInterrupted() {
    for (const dir of this.stagingFolders()) {
      if (fs.existsSync(path.join(dir, COMMITTED))) {
        this.log?.warn(`Finishing an interrupted save of all data (${path.basename(dir)})`);
        this.moveIntoPlace(dir);
      } else {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* try again next start */ }
      }
    }
  }

  // Move a complete staged dataset into place, then remove files that aren't part of it.
  // meta.json goes last: it records the data format, so it must never claim more than is on disk.
  // Safe to run again after an interruption.
  moveIntoPlace(staging) {
    const manifest = readJSONFile(path.join(staging, COMMITTED)).value || {};
    const stagingTx = path.join(staging, 'transactions');
    const stagingIcons = path.join(staging, 'icons');
    const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    fs.mkdirSync(this.txDir, { recursive: true });
    fs.mkdirSync(this.iconsDir, { recursive: true });
    for (const name of list(stagingTx)) renameWithRetry(path.join(stagingTx, name), path.join(this.txDir, name));
    for (const name of list(stagingIcons)) renameWithRetry(path.join(stagingIcons, name), path.join(this.iconsDir, name));
    for (const file of Object.values(COLLECTION_FILES).filter(f => f !== COLLECTION_FILES.meta)) {
      const from = path.join(staging, file);
      if (fs.existsSync(from)) renameWithRetry(from, path.join(this.dataDir, file));
    }
    const metaFrom = path.join(staging, COLLECTION_FILES.meta);
    if (fs.existsSync(metaFrom)) renameWithRetry(metaFrom, path.join(this.dataDir, COLLECTION_FILES.meta));

    if (Array.isArray(manifest.transactions)) {
      const keep = new Set(manifest.transactions);
      for (const name of list(this.txDir)) {
        const match = TX_FILE_RE.exec(name);
        if (match && !keep.has(match[1])) fs.unlinkSync(path.join(this.txDir, name));
      }
    }
    if (Array.isArray(manifest.icons)) {
      const keep = new Set(manifest.icons);
      for (const name of list(this.iconsDir)) {
        if (ICON_FILE_RE.test(name) && !keep.has(name)) fs.unlinkSync(path.join(this.iconsDir, name));
      }
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      this.log?.warn(`Couldn't remove ${path.basename(staging)}: ${err.message}`);
    }
    if (this.pendingStaging === staging) this.pendingStaging = null;
  }

  // Write the whole dataset. Everything is first written into a staging folder and flushed to
  // disk, then a marker says the set is complete, and only then are the files moved into place.
  // An error or power cut before the marker leaves the old files untouched; one after it is
  // finished at the next start. Either way there's never a mix of old and new files.
  writeAll(data = this.data) {
    const staging = path.join(this.dataDir, `.staging-${Date.now()}`);
    try {
      fs.mkdirSync(path.join(staging, 'transactions'), { recursive: true });
      fs.mkdirSync(path.join(staging, 'icons'), { recursive: true });
      for (const [key, file] of Object.entries(COLLECTION_FILES)) {
        if (data[key] !== undefined) writeSynced(path.join(staging, file), json(data[key]));
      }
      for (const [id, list] of Object.entries(data.transactions)) {
        writeSynced(path.join(staging, 'transactions', `${id}.json`), listJSON(list));
      }
      for (const [name, buffer] of Object.entries(data.icons)) writeSynced(path.join(staging, 'icons', name), buffer);
      writeSynced(path.join(staging, COMMITTED), json({ transactions: Object.keys(data.transactions), icons: Object.keys(data.icons) }));
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* removed at next start */ }
      throw saveFailed(err);
    }
    try {
      this.moveIntoPlace(staging);
    } catch (err) {
      // The new data is complete in the staging folder and is moved into place at the next
      // start. Carry on with it now; later saves replace their staged copies.
      this.pendingStaging = staging;
      this.data = data;
      this.touch();
      this.log?.error(`Couldn't move all of the data files into place: ${err.message}`);
      throw new HttpError(500, "Brisk Budget couldn't move all of its data files into place. Restart it to finish the job; nothing will be lost.");
    }
    this.data = data;
    this.touch();
  }
}
