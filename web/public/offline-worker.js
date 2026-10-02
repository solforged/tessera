const PREFIX = 'tessera-assets-v1:';
const version = new URL(self.location.href).searchParams.get('version');
const entry = new URL(self.location.href).searchParams.get('entry');
const CACHE = `${PREFIX}${version}`;
const COMPLETE = '/.tessera-assets-complete';
const assetExtension = /\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)$/i;

// Read only generated asset URLs, never notebook requests or authored text.
function assetUrls(text, base, html = false) {
  const pattern = html
    ? /(?:src|href)\s*=\s*["']([^"']+)["']/gi
    : /["'`]((?:\.{0,2}\/|assets\/)[^"'`\s]+\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|ico)(?:\?[^"'`\s]*)?)["'`]|url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
  const urls = [];
  for (const match of text.matchAll(pattern)) {
    const path = match[1] ?? match[2];
    if (path.includes('${')) continue;
    const url = new URL(path, base);
    if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/') || !assetExtension.test(url.pathname)) continue;
    url.hash = '';
    urls.push(url.href);
  }
  return urls;
}

self.addEventListener('install', event => event.waitUntil((async () => {
  if (!/^[a-f0-9]{64}$/.test(version ?? '') || !entry?.startsWith('/assets/') || !entry.endsWith('.js')) throw new Error('Missing production asset version');
  const cache = await caches.open(CACHE);
  if (await cache.match(COMPLETE)) return;
  try {
    const shell = await fetch('/index.html', { cache: 'no-cache' });
    if (!shell.ok) throw new Error('Application shell is unavailable');
    const html = await shell.clone().text();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)));
    const installedVersion = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    const urls = assetUrls(html, shell.url, true);
    if (installedVersion !== version || !urls.includes(new URL(entry, self.location.origin).href)) throw new Error('Application changed during asset installation');
    const seen = new Set();
    let pending = urls;
    while (pending.length) {
      const wave = pending.filter(url => !seen.has(url));
      wave.forEach(url => seen.add(url));
      pending = (await Promise.all(wave.map(async url => {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok || response.headers.get('Content-Type')?.includes('text/html')) throw new Error(`Application asset is unavailable: ${url}`);
        await cache.put(url, response.clone());
        return /\.(?:js|css)$/.test(new URL(url).pathname) ? assetUrls(await response.text(), url) : [];
      }))).flat();
    }
    await cache.put('/index.html', shell.clone());
    await cache.put('/', shell);
    // The incumbent worker never serves this version until its entire graph exists.
    await cache.put(COMPLETE, new Response(JSON.stringify({ installedAt: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const current = await caches.open(CACHE);
  const complete = await current.match(COMPLETE);
  if (!complete) throw new Error('Incomplete application asset set');
  const installedAt = (await complete.json()).installedAt;
  for (const name of await caches.keys()) {
    if (name === CACHE || !name.startsWith(PREFIX)) continue;
    const previous = await (await caches.open(name)).match(COMPLETE);
    if (previous && (await previous.json()).installedAt < installedAt) await caches.delete(name);
  }
  // First installation can control a warm reload. Updates wait for existing clients.
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch { /* A complete production shell is available for a warm offline visit. */ }
      const shell = await (await caches.open(CACHE)).match('/index.html');
      if (shell) return shell;
      return fetch(request);
    })());
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(request)) ?? fetch(request))());
  }
});
