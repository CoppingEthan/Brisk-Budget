// The installable app: the service worker, the manifest, and the icons and pictures it names.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CSP } from '../../server/http/static.js';
import { freshServer } from '../helpers/server.js';

// Width and height of a PNG or WebP image, read from its header
function imageSize(buffer) {
  if (buffer.subarray(1, 4).toString('latin1') === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buffer.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  throw new Error('Not a PNG or WebP image');
}

describe('installable app', () => {
  let s;
  before(async () => { s = await freshServer(); });
  after(async () => { await s.close(); });

  async function worker() {
    const res = await s.raw({ path: '/sw.js' });
    const body = res.body.toString();
    return {
      res,
      body,
      build: body.match(/const BUILD = '([^']*)';/)?.[1],
      files: JSON.parse(body.match(/const FILES = new Set\((\[.*?\])\);/)[1])
    };
  }

  it('serves the service worker from the root, always checked with the server', async () => {
    const { res, body } = await worker();
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['content-security-policy'], CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['service-worker-allowed'], undefined, 'at the root it needs no wider scope');
    assert.equal(body.includes('__ASSET_VERSION__'), false, 'placeholders are filled in');
    assert.equal(body.includes('__SHELL_FILES__'), false);
    // Not even a fingerprinted request for it is kept for a year
    assert.equal((await s.raw({ path: '/sw.js?v=abc' })).headers['cache-control'], 'no-cache');
    assert.match(CSP, /worker-src 'self'/);
  });

  it("carries the same version as the page and the API, so its saved copy matches what's served", async () => {
    const { build } = await worker();
    assert.match(build, /^[0-9a-f]{10}$/);
    const page = (await s.raw({ path: '/' })).body.toString();
    assert.ok(page.includes(`/js/main.js?v=${build}`));
    assert.ok(page.includes(`/css/base.css?v=${build}`));
    const api = await s.get('/api/health');
    assert.equal(api.headers['x-brisk-build'], build);
  });

  it("keeps the app's own files: nothing from the API, and not the install pictures", async () => {
    const { files, build } = await worker();
    for (const f of ['/css/base.css', '/js/main.js', '/js/core/pwa.js', '/js/ui/back.js', '/js/shell/tabbar.js', '/site.webmanifest', '/icons/icon-192.png', '/images/brisk-budget-logo.svg']) {
      assert.ok(files.includes(f), `keeps ${f}`);
    }
    for (const f of files) {
      assert.equal(/^\/(api\/|mcp|sw\.js|index\.html|screenshots\/|splash\/)/.test(f), false, `doesn't keep ${f}`);
      // Everything it fetches when installing is there to fetch
      assert.equal((await s.raw({ path: `${f}?v=${build}` })).status, 200, f);
    }
  });

  it('the page links the manifest and sets up the iPhone home-screen app', async () => {
    const page = (await s.raw({ path: '/' })).body.toString();
    assert.ok(page.includes('<link rel="manifest" href="/site.webmanifest">'));
    assert.match(page, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon.png">/);
    assert.match(page, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
    assert.match(page, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
    assert.match(page, /<meta name="theme-color" content="#[0-9a-f]{6}">/);

    // A launch screen for each iPhone size it names, so opening the app doesn't flash white
    const launches = [...page.matchAll(/<link rel="apple-touch-startup-image" media="\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: portrait\)" href="([^"]+)">/g)];
    assert.ok(launches.length >= 8);
    for (const [, w, h, ratio, href] of launches) {
      const img = await s.raw({ path: href });
      assert.equal(img.status, 200, href);
      assert.equal(img.headers['content-type'], 'image/png', href);
      assert.deepEqual(imageSize(img.body), { width: w * ratio, height: h * ratio }, href);
    }
  });

  it('serves a manifest browsers can install from, with the richer install screen', async () => {
    const res = await s.raw({ path: '/site.webmanifest' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/manifest+json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    const m = JSON.parse(res.body.toString());
    assert.equal(m.id, '/');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    assert.equal(m.display, 'standalone');
    assert.ok(m.name && m.short_name && m.description);
    assert.ok(m.categories.includes('finance'));
    assert.match(m.theme_color, /^#[0-9a-f]{6}$/);
    assert.match(m.background_color, /^#[0-9a-f]{6}$/);

    // Icons for every use: plain ("any") and maskable (shaped by the phone), small and large
    for (const purpose of ['any', 'maskable']) {
      for (const sizes of ['192x192', '512x512']) assert.ok(m.icons.some(i => i.purpose === purpose && i.sizes === sizes), `${purpose} ${sizes}`);
    }
    // Shortcuts on a long press of the app's icon, within the app's scope
    assert.ok(m.shortcuts.some(sc => sc.url === '/?action=add'), 'Add transaction');
    assert.ok(m.shortcuts.some(sc => sc.url === '/#/recurring'), 'Recurring');
    for (const sc of m.shortcuts) assert.ok(sc.name && sc.url.startsWith('/'), sc.name);

    // Chrome shows screenshots when there are narrow (phone) and wide (computer) ones: each side
    // 320 to 3840 pixels, the long side at most 2.3 times the short, one shape per form factor
    for (const factor of ['narrow', 'wide']) {
      const shots = m.screenshots.filter(x => x.form_factor === factor);
      assert.ok(shots.length, factor);
      assert.equal(new Set(shots.map(x => x.sizes)).size, 1, `${factor} screenshots share a shape`);
    }
    for (const shot of m.screenshots) {
      const [w, h] = shot.sizes.split('x').map(Number);
      assert.ok(Math.min(w, h) >= 320 && Math.max(w, h) <= 3840, shot.src);
      assert.ok(Math.max(w, h) / Math.min(w, h) <= 2.3, shot.src);
      assert.equal(w < h, shot.form_factor === 'narrow', shot.src);
      assert.ok(shot.label, shot.src);
    }

    // Every picture it names is served, with the type and size it claims
    for (const image of [...m.icons, ...m.shortcuts.flatMap(sc => sc.icons || []), ...m.screenshots]) {
      const img = await s.raw({ path: image.src });
      assert.equal(img.status, 200, image.src);
      assert.equal(img.headers['content-type'], image.type, image.src);
      const { width, height } = imageSize(img.body);
      assert.equal(`${width}x${height}`, image.sizes, image.src);
    }
  });
});
