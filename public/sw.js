// Brisk Budget's service worker. It keeps one copy of the app's own files (the page, styles,
// scripts and icons) so the app opens quickly and still opens when the server can't be reached,
// where it says so plainly instead of showing the browser's error page.
//
// It never stores anything from /api/: your money stays on your server, and signing out leaves
// nothing of it behind on the device. Nothing is added to the cache after install either; it
// holds exactly the files listed below, for one version of the app.
//
// The server fills in the placeholders. Every update of the app changes them, which makes this
// a new worker: the browser installs it, it fetches that version's files into a fresh cache,
// takes over and deletes the old cache. Open pages are told, so they can offer a reload.
const BUILD = '__ASSET_VERSION__';
const FILES = new Set(__SHELL_FILES__);
const CACHE = `brisk-shell-${BUILD}`;
const PAGE = '/index.html';
// How long to wait for the server to send the page before opening the saved copy
const PAGE_WAIT = 4000;

// Shown only if there's no saved copy of the app at all (the browser cleared it)
const UNREACHABLE = `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0c2733"><title>Brisk Budget</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:#0b2430;color:#f1f5f9;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:#cbd5e1}a{color:#a5b4fc}</style></head>
<body><main><h1>Can't reach your Brisk Budget server</h1>
<p>Check that this device is online and can reach your server, then try again.</p>
<p><a href="/">Try again</a></p></main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await Promise.all([...FILES].map(async (file) => {
        const res = await fetch(`${file}?v=${BUILD}`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${file} answered ${res.status}`);
        await cache.put(file, res);
      }));
      // The page last, and only if it belongs to this version. If the server was updated while
      // this worker was being fetched, give up: the next update check brings the newer worker.
      const page = await fetch('/', { cache: 'no-cache' });
      if (!page.ok || !(await page.clone().text()).includes(`?v=${BUILD}`)) throw new Error('The server has moved on to a newer version');
      await cache.put(PAGE, page);
    } catch (err) {
      await caches.delete(CACHE);
      throw err;
    }
    // Take over straight away rather than waiting for every tab to close, so nobody is left on
    // old files. Pages that are already open keep running; they are offered a reload instead.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('brisk-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'activated', build: BUILD });
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Your data (and anything from another site) always comes straight from the network
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;
  if (request.mode === 'navigate') {
    if (url.pathname === '/' || url.pathname === PAGE) event.respondWith(openPage(request));
    return;
  }
  // A file from another version of the app (a page that was open across an update) goes to the server
  const v = url.searchParams.get('v');
  if ((v !== null && v !== BUILD) || !FILES.has(url.pathname)) return;
  event.respondWith(saved(url.pathname).then(hit => hit || fetch(request)));
});

const saved = (path) => caches.open(CACHE).then(cache => cache.match(path, { ignoreVary: true }));

// The page comes from the server whenever it answers, so an update shows straight away. When it
// doesn't answer in time, or a proxy in front of it reports it's down, the saved copy opens
// instead and tells you it can't reach the server.
async function openPage(request) {
  const network = fetch(request);
  network.catch(() => {}); // still running after a timeout; its failure isn't news then
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, PAGE_WAIT, null); });
  try {
    const res = await Promise.race([network, timeout]);
    if (res && res.status < 500) return res;
  } catch {
    // offline, or the server refused the connection
  } finally {
    clearTimeout(timer);
  }
  const copy = await saved(PAGE);
  if (copy) return copy;
  try {
    return await network;
  } catch {
    return new Response(UNREACHABLE, {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
      }
    });
  }
}
