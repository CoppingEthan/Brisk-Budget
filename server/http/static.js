// Serves the app's files from public/. Every page load asks for index.html fresh; everything it
// references carries a fingerprint (?v=...) of the whole app, so after an update browsers fetch
// the new files once and otherwise load straight from cache. Files are compressed once and kept
// in memory. The service worker (sw.js) gets the same fingerprint and the list of files it keeps
// for opening the app offline, so its copy always matches the page's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { compress, pickEncoding, send, SECURITY_HEADERS } from './respond.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.txt', '.ico']);

export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

// Always checked with the server rather than kept for a day: the page, the service worker (so an
// update is noticed straight away) and the manifest (which describes the installed app)
const ALWAYS_CHECK = new Set(['index.html', 'sw.js', 'site.webmanifest']);

// Files the service worker doesn't keep: the page itself (kept separately), the worker, and the
// pictures only used when installing the app or launching it on an iPhone
const NOT_IN_SHELL = /^(index\.html$|sw\.js$|screenshots\/|splash\/)/;

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

export function createStatic({ publicDir, dev, version }) {
  const cache = new Map();
  let fingerprint = null;
  let modules = null;

  // One short hash of every file's size and date: changes whenever the app is updated
  function getFingerprint() {
    if (fingerprint && !dev) return fingerprint;
    const hash = crypto.createHash('sha1').update(version);
    for (const rel of listFiles(publicDir)) {
      const stat = fs.statSync(path.join(publicDir, rel));
      hash.update(`${rel}:${stat.size}:${stat.mtimeMs}`);
    }
    fingerprint = hash.digest('hex').slice(0, 10);
    return fingerprint;
  }

  function moduleList() {
    if (modules && !dev) return modules;
    modules = listFiles(path.join(publicDir, 'js')).filter(f => f.endsWith('.js')).map(f => `/js/${f}`);
    return modules;
  }

  // Everything the app needs to open, for the service worker to keep (paths without ?v=)
  function shellFiles() {
    return listFiles(publicDir).filter(f => !NOT_IN_SHELL.test(f)).map(f => `/${f}`);
  }

  // Fingerprint the app's own references so cached copies are replaced after an update
  function transform(rel, buffer) {
    const v = getFingerprint();
    if (rel === 'sw.js') {
      return Buffer.from(buffer.toString('utf8')
        .replace(/__ASSET_VERSION__/g, v)
        .replace('__SHELL_FILES__', () => JSON.stringify(shellFiles())));
    }
    if (rel === 'index.html') {
      const preload = moduleList().map(m => `<link rel="modulepreload" href="${m}?v=${v}">`).join('\n  ');
      return Buffer.from(buffer.toString('utf8')
        .replace(/__ASSET_VERSION__/g, v)
        .replace(/__APP_VERSION__/g, version)
        .replace('<!--MODULE_PRELOAD-->', preload));
    }
    if (rel.endsWith('.js')) {
      return Buffer.from(buffer.toString('utf8').replace(
        /((?:import|export)\s[^'"]*?from\s*|import\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g,
        (_, prefix, quote, spec) => `${prefix}${quote}${spec}?v=${v}${quote}`
      ));
    }
    if (rel.endsWith('.css')) {
      return Buffer.from(buffer.toString('utf8').replace(/url\((['"]?)(\/[^'")?]+)\1\)/g, (_, q, url) => `url(${q}${url}?v=${v}${q})`));
    }
    return buffer;
  }

  function load(rel) {
    const full = path.join(publicDir, rel);
    const stat = fs.statSync(full);
    const key = `${rel}:${stat.mtimeMs}:${stat.size}:${getFingerprint()}`;
    const hit = cache.get(rel);
    if (hit && hit.key === key) return hit;
    const ext = path.extname(rel).toLowerCase();
    const body = transform(rel, fs.readFileSync(full));
    const entry = {
      key,
      body,
      type: MIME[ext] || 'application/octet-stream',
      etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
      compressible: COMPRESSIBLE.has(ext) && body.length > 512,
      encoded: {}
    };
    cache.set(rel, entry);
    return entry;
  }

  // The app's files by their exact names. Only these are served, so on a disk that ignores case
  // (Windows, macOS) /INDEX.HTML or an alternative name for a file isn't a second way in.
  let files = null;
  const known = () => (files && !dev ? files : (files = new Set(listFiles(publicDir))));

  function resolve(pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    rel = path.posix.normalize(rel).replace(/^\/+/, '');
    if (!rel || rel.startsWith('..') || rel.includes('\0') || rel.split('/').some(p => p.startsWith('.'))) return null;
    if (!known().has(rel)) return null;
    const full = path.join(publicDir, rel);
    if (!full.startsWith(publicDir + path.sep)) return null;
    try {
      if (!fs.statSync(full).isFile()) return null;
    } catch {
      return null;
    }
    return rel;
  }

  function serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(req, res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return;
    }
    const rel = resolve(url.pathname);
    if (!rel) {
      send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const entry = load(rel);
    const versioned = url.searchParams.has('v') && !dev;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': entry.type,
      ETag: entry.etag,
      'Cache-Control': ALWAYS_CHECK.has(rel) || dev ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'
    };
    // Any page gets the content rules, not just the app's own, and so does the service worker,
    // which runs under the rules sent with its own script
    if (entry.type.startsWith('text/html') || rel === 'sw.js') headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let body = entry.body;
    const encoding = entry.compressible ? pickEncoding(req) : null;
    if (encoding) {
      entry.encoded[encoding] ||= compress(entry.body, encoding, { level: 'best' });
      body = entry.encoded[encoding];
      headers['Content-Encoding'] = encoding;
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return { serve, fingerprint: getFingerprint };
}
