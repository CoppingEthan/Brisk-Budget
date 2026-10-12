import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write a file's new contents next to it and flush them to disk. Returns the temporary file's
// path; renaming it over the original (see writeFileAtomic) makes the change in one step.
export function prepareFile(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return tmp;
}

export function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// Replace a file in one step: write a temporary file, flush it to disk, then rename it over the
// original. A crash or power cut leaves either the old file or the new one, never half of each.
export function writeFileAtomic(file, data) {
  const tmp = prepareFile(file, data);
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
}

// Windows can briefly lock files (antivirus, indexers), so retry a rename a few times
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      sleepSync(25 * (attempt + 1));
    }
  }
}

export function writeJSONAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

// Transaction lists can be large: one transaction per line is about a third smaller than fully
// indented JSON and quicker to write, while staying readable
export function listJSON(list) {
  if (!Array.isArray(list) || list.length === 0) return '[]';
  return `[\n${list.map(item => JSON.stringify(item)).join(',\n')}\n]`;
}

// Read a JSON file, telling apart "missing", "damaged" (not valid JSON) and "couldn't be read
// just now" (locked, no permission), so a healthy file is never replaced because of a passing
// lock and a damaged file is never mistaken for an empty one.
export function readJSONFile(file) {
  let text;
  for (let attempt = 0; ; attempt++) {
    try {
      text = fs.readFileSync(file, 'utf8');
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      if (err.code === 'EISDIR' || attempt >= 4) return { unreadable: err };
      sleepSync(50 * (attempt + 1));
    }
  }
  try {
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { value: JSON.parse(clean) };
  } catch (err) {
    return { error: err };
  }
}

// Remove leftover temp files from an interrupted write
export function cleanTempFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
    }
  }
}
