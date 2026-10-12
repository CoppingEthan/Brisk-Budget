// Static files: caching, fingerprinting, compression and path traversal.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createStatic, CSP } from '../../server/http/static.js';
import { freshServer, rawRequest, removeDir } from '../helpers/server.js';

describe('static files from public/', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  it('index.html is never cached and carries the security policy', async () => {
    for (const p of ['/', '/index.html']) {
      const res = await s.raw({ path: p });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.equal(res.headers['content-security-policy'], CSP);
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(res.headers.etag);
      assert.equal(res.body.toString().includes('__ASSET_VERSION__'), false, 'placeholders are filled in');
      assert.equal(res.body.toString().includes('__APP_VERSION__'), false);
    }
    assert.match(CSP, /default-src 'self'/);
    assert.match(CSP, /script-src 'self'(;|$)/);
    assert.match(CSP, /frame-ancestors 'none'/);
  });

  it('fingerprinted files are cached for a year and revalidate with ETag / 304', async () => {
    const res = await s.raw({ path: '/js/shared/dates.js?v=abc123' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    const etag = res.headers.etag;
    assert.match(etag, /^"[0-9a-f]{16}"$/);
    const again = await s.raw({ path: '/js/shared/dates.js?v=abc123', headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers.etag, etag);
    const changed = await s.raw({ path: '/js/shared/dates.js?v=abc123', headers: { 'If-None-Match': '"something-else"' } });
    assert.equal(changed.status, 200);
    const unversioned = await s.raw({ path: '/js/shared/dates.js' });
    assert.equal(unversioned.headers['cache-control'], 'public, max-age=86400');
  });

  it('compresses with gzip or brotli when the browser accepts it', async () => {
    const plain = await s.raw({ path: '/js/shared/csv.js?v=1' });
    const gz = await s.raw({ path: '/js/shared/csv.js?v=1', headers: { 'Accept-Encoding': 'gzip, deflate' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.equal(Number(gz.headers['content-length']), gz.body.length);
    assert.ok(gz.body.length < plain.body.length);
    assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
    const br = await s.raw({ path: '/js/shared/csv.js?v=1', headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
    assert.equal(plain.headers['content-encoding'], undefined);
    const png = await s.raw({ path: '/favicon-96x96.png', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-encoding'], undefined, 'images are not recompressed');
  });

  it('relative JS imports get the app fingerprint appended', async () => {
    const csv = (await s.raw({ path: '/js/shared/csv.js?v=1' })).body.toString();
    const m = csv.match(/from '\.\/dates\.js\?v=([0-9a-f]+)'/);
    assert.ok(m, 'dates.js import is fingerprinted');
    assert.match(csv, new RegExp(`from '\\./money\\.js\\?v=${m[1]}'`));
    const recurrence = (await s.raw({ path: '/js/shared/recurrence.js?v=1' })).body.toString();
    assert.match(recurrence, new RegExp(`from '\\./dates\\.js\\?v=${m[1]}'`), 'every file uses the same fingerprint');
  });

  it('HEAD requests get headers only; other methods are refused', async () => {
    const head = await s.raw({ method: 'HEAD', path: '/js/shared/dates.js' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers['content-length']) > 0);
    const post = await s.raw({ method: 'POST', path: '/index.html' });
    assert.equal(post.status, 405);
  });

  it('never serves anything outside public/ (path traversal)', async () => {
    const attempts = [
      '/..%2f..%2fpackage.json',
      '/..%2fpackage.json',
      '/%2e%2e/server/app.js',
      '/%2e%2e/%2e%2e/package.json',
      '/js/../../server/app.js',
      '/js/../../package.json',
      '/js%2f..%2f..%2fpackage.json',
      '/js%5c..%5c..%5cpackage.json',
      '/js%5c..%5c..%5cserver%5capp.js',
      '/..\\..\\package.json',
      '/.git/config',
      '/.env',
      '/js/.hidden.js',
      '/index.html%00.js',
      '/%E0%A4%A',
      '/js/',
      '/js',
      '/server/app.js',
      '/package.json',
      '/data/accounts.json',
      '/node_modules/adm-zip/package.json'
    ];
    for (const p of attempts) {
      const res = await s.raw({ path: p });
      assert.equal(res.status, 404, `${p} -> ${res.status}`);
      assert.equal(res.body.toString().includes('"name"'), false, `${p} leaked a JSON file`);
    }
  });
});

describe('static fingerprinting (isolated public folder)', () => {
  let dir;
  let server;
  let port;
  let statics;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brisk-public-'));
    fs.mkdirSync(path.join(dir, 'js', 'views'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="/css/app.css?v=__ASSET_VERSION__">\n<!--MODULE_PRELOAD-->\n<script type="module" src="/js/main.js?v=__ASSET_VERSION__"></script><div data-v="__APP_VERSION__"></div>');
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), [
      "import { a } from './a.js';",
      'import {',
      '  b,',
      '  c',
      "} from \"./views/b.js\";",
      "export * from './a.js';",
      "import './side-effect.js';",
      "const lazy = () => import('./views/lazy.js');",
      "import lib from 'some-lib';",
      "const text = 'not an import ./a.js';",
      ''
    ].join('\n'));
    for (const f of ['a.js', 'side-effect.js', 'views/b.js', 'views/lazy.js']) fs.writeFileSync(path.join(dir, 'js', f), "import { a } from '../main.js';\n");
    fs.writeFileSync(path.join(dir, 'css', 'app.css'), 'body { background: url(/images/bg.png); } .x { background: url("data:image/svg+xml,abc"); } .y { background: url(\'/images/y.svg\'); }');
    statics = createStatic({ publicDir: dir, dev: false, version: '9.8.7' });
    server = http.createServer((req, res) => statics.serve(req, res, new URL(req.url, 'http://localhost')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    removeDir(dir);
  });

  it('fills in index.html placeholders and preloads every module', async () => {
    const v = statics.fingerprint();
    assert.match(v, /^[0-9a-f]{10}$/);
    const html = (await rawRequest(port, { path: '/' })).body.toString();
    assert.ok(html.includes(`/css/app.css?v=${v}`));
    assert.ok(html.includes(`/js/main.js?v=${v}`));
    assert.ok(html.includes('data-v="9.8.7"'));
    for (const m of ['/js/a.js', '/js/main.js', '/js/side-effect.js', '/js/views/b.js', '/js/views/lazy.js']) {
      assert.ok(html.includes(`<link rel="modulepreload" href="${m}?v=${v}">`), `preloads ${m}`);
    }
  });

  it('rewrites static, multi-line, re-export, side-effect and dynamic imports, but nothing else', async () => {
    const v = statics.fingerprint();
    const js = (await rawRequest(port, { path: '/js/main.js' })).body.toString();
    assert.ok(js.includes(`import { a } from './a.js?v=${v}';`));
    assert.ok(js.includes(`} from "./views/b.js?v=${v}";`));
    assert.ok(js.includes(`export * from './a.js?v=${v}';`));
    assert.ok(js.includes(`import './side-effect.js?v=${v}';`));
    assert.ok(js.includes(`import('./views/lazy.js?v=${v}')`));
    assert.ok(js.includes("import lib from 'some-lib';"), 'bare specifiers untouched');
    assert.ok(js.includes("'not an import ./a.js'"), 'ordinary strings untouched');
    const nested = (await rawRequest(port, { path: '/js/views/b.js' })).body.toString();
    assert.ok(nested.includes(`from '../main.js?v=${v}'`));
  });

  it('fingerprints absolute CSS urls but not data URLs', async () => {
    const v = statics.fingerprint();
    const css = (await rawRequest(port, { path: '/css/app.css' })).body.toString();
    assert.ok(css.includes(`url(/images/bg.png?v=${v})`));
    assert.ok(css.includes(`url('/images/y.svg?v=${v}')`));
    assert.ok(css.includes('url("data:image/svg+xml,abc")'));
  });

  it('a changed file is re-read (new ETag) while the fingerprint stays fixed for the process', async () => {
    const before = statics.fingerprint();
    const first = await rawRequest(port, { path: '/js/a.js' });
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, 'js', 'a.js'), "export const a = 2; // changed and longer\n");
    // Production caches the fingerprint for the life of the process (an update restarts it),
    // but a file's own content is re-read when its size or time changes.
    const second = await rawRequest(port, { path: '/js/a.js' });
    assert.notEqual(second.headers.etag, first.headers.etag);
    assert.ok(second.body.toString().includes('changed'));
    assert.equal(statics.fingerprint(), before);
  });
});
